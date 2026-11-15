//! stats/gpu.js: live GPU numbers (ops::gpu says what hardware exists; this
//! says what it is doing).
//!
//! - AMD (amdgpu): gpu_busy_percent, VRAM, current shader clock, hwmon power
//!   and temperature.
//! - Intel (i915, xe): current clock, hwmon energy (discrete Arc) -> W.
//! - Intel and AMD per process: the DRM fdinfo of the app's children
//!   (ffmpeg): busy % = engine time over the wall time between two samples.
//! - NVIDIA: one long-running nvidia-smi that prints a line per GPU every
//!   interval, started only while sampling and killed when it stops.
//! - Anything else (Raspberry Pi's V3D, ...): its name and temperature.

use super::procs::ProcessTable;
use super::sensors::{Chip, SensorsProvider};
use super::util::*;
use super::{Launcher, Timers};
use crate::ops::js::num as jnum;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const NVIDIA_QUERY: &str = "index,name,driver_version,utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total,temperature.gpu,power.draw,clocks.gr";
pub const PCI_IDS: [&str; 3] = ["/usr/share/misc/pci.ids", "/usr/share/hwdata/pci.ids", "/usr/share/pci.ids"];

fn vendor_of_id(id: &str) -> Option<&'static str> {
    match id {
        "0x8086" => Some("intel"),
        "0x1002" => Some("amd"),
        "0x10de" => Some("nvidia"),
        _ => None,
    }
}

fn vendor_name(v: &str) -> Option<&'static str> {
    match v {
        "intel" => Some("Intel"),
        "amd" => Some("AMD"),
        "nvidia" => Some("NVIDIA"),
        _ => None,
    }
}

fn known(key: &str) -> Option<&'static str> {
    Some(match key {
        "0x8086:0x56a0" => "Intel Arc A770",
        "0x8086:0x56a1" => "Intel Arc A750",
        "0x8086:0x56a2" => "Intel Arc A580",
        "0x8086:0x56a5" => "Intel Arc A380",
        "0x8086:0x56a6" => "Intel Arc A310",
        "0x8086:0xe20b" => "Intel Arc B580",
        "0x8086:0xe20c" => "Intel Arc B570",
        _ => return None,
    })
}

fn other_name(driver: &str) -> Option<&'static str> {
    Some(match driver {
        "v3d" => "Broadcom V3D",
        "vc4" | "vc4-drm" => "Broadcom VideoCore",
        "panfrost" => "Arm Mali (Panfrost)",
        "panthor" => "Arm Mali (Panthor)",
        "lima" => "Arm Mali (Lima)",
        "msm" => "Qualcomm Adreno",
        "etnaviv" => "Vivante GPU",
        "nouveau" => "NVIDIA (nouveau)",
        _ => return None,
    })
}

fn render_engine(n: &str) -> bool {
    re!(r"^(render|rcs|gfx|3d)$").is(n)
}

pub fn video_engine(n: &str) -> bool {
    re!(r"^(video|video-enhance|vcs\d*|vecs\d*|enc(_\d+)?|dec(_\d+)?|vcn.*)$").is(n)
}

/// A device's name from pci.ids: "DG2 [Arc A380]" -> "Intel Arc A380".
pub fn lookup_pci_ids(text: Option<&str>, vendor_id: Option<&str>, device_id: Option<&str>, vendor: &str) -> Option<String> {
    let (text, vid, did) = (text.filter(|t| !t.is_empty())?, vendor_id.filter(|v| !v.is_empty())?, device_id.filter(|d| !d.is_empty())?);
    let v = vid.strip_prefix("0x").unwrap_or(vid).to_lowercase();
    let d = did.strip_prefix("0x").unwrap_or(did).to_lowercase();
    let start = text.find(&format!("\n{v}  "))?;
    let mut end = (start + 400000).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let chunk = &text[start + 1..end.max(start + 1)];
    for (i, line) in chunk.split('\n').enumerate() {
        if i == 0 {
            continue;
        }
        if !line.is_empty() && !line.starts_with('\t') && !line.starts_with('#') {
            break;
        }
        if let Some(c) = re!(r"^\t([0-9a-f]{4})\s+(.+)$").caps(line) {
            if c[1].as_deref() == Some(d.as_str()) {
                let rest = c[2].clone().unwrap_or_default();
                let bracket = re!(r"\[([^\]]+)\]").group(&rest, 1);
                let short = vendor_name(vendor).unwrap_or("");
                let base = bracket.unwrap_or(rest).trim().to_string();
                return Some(if !short.is_empty() && !base.starts_with(short) { format!("{short} {base}") } else { base });
            }
        }
    }
    None
}

/// A GPU's display name: amdgpu's product name, else pci.ids, else the
/// known cards, else "Intel graphics" / "AMD graphics" (SoC GPUs by their driver).
pub fn gpu_display_name(dev: Option<&str>, driver: Option<&str>, kind: Option<&str>, vendor: Option<&str>, vendor_id: Option<&str>, device_id: Option<&str>, pci_ids_files: &[PathBuf]) -> String {
    let family = kind.unwrap_or(match driver {
        Some("amdgpu") => "amd",
        Some("i915") | Some("xe") => "intel",
        _ => "other",
    });
    let maker = if family != "other" { family } else { vendor.or_else(|| vendor_id.and_then(vendor_of_id)).unwrap_or("other") };
    let mut name = None;
    if family == "amd" {
        if let Some(d) = dev {
            name = read_line(Path::new(d).join("product_name"));
        }
    }
    if name.is_none() && vendor_id.is_some() && device_id.is_some() && vendor_id.and_then(vendor_of_id).is_some() {
        for f in pci_ids_files {
            name = lookup_pci_ids(read_text(f).as_deref(), vendor_id, device_id, maker);
            if name.is_some() {
                break;
            }
        }
    }
    let key = format!("{}:{}", vendor_id.unwrap_or("null"), device_id.unwrap_or("null"));
    name.or_else(|| known(&key).map(str::to_string)).unwrap_or_else(|| {
        if family == "other" {
            driver.and_then(other_name).map(str::to_string).or_else(|| driver.filter(|d| !d.is_empty()).map(str::to_string)).unwrap_or_else(|| "GPU".into())
        } else {
            format!("{} graphics", vendor_name(maker).unwrap_or("Unknown"))
        }
    })
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Engine {
    pub ns: Option<f64>,
    pub total: Option<f64>,
    pub cycles: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Fdinfo {
    pub driver: Option<String>,
    pub pdev: Option<String>,
    pub client_id: Option<String>,
    pub engines: BTreeMap<String, Engine>,
    pub capacity: HashMap<String, f64>,
}

/// parseFloat: the leading number of a text.
fn parse_float(s: &str) -> Option<f64> {
    let m = re!(r"^[+-]?(Infinity|\d+\.?\d*(e[+-]?\d+)?|\.\d+(e[+-]?\d+)?)").group(s.trim_start(), 0)?;
    m.parse::<f64>().ok().or(if m.ends_with("Infinity") { Some(if m.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY }) } else { None })
}

/// One fdinfo file of a DRM client.
pub fn parse_fdinfo(text: Option<&str>) -> Option<Fdinfo> {
    let text = text.filter(|t| !t.is_empty())?;
    let mut out = Fdinfo::default();
    for line in text.split('\n') {
        let Some(i) = line.find(':') else { continue };
        let key = line[..i].trim();
        let val = line[i + 1..].trim();
        if key == "drm-driver" {
            out.driver = Some(val.to_string());
        } else if key == "drm-pdev" {
            out.pdev = Some(val.to_string());
        } else if key == "drm-client-id" {
            out.client_id = Some(val.to_string());
        } else if let Some(name) = key.strip_prefix("drm-engine-capacity-") {
            let n = re!(r"^\s*[+-]?\d+").group(val, 0).and_then(|x| x.trim().parse::<f64>().ok()).filter(|n| *n != 0.0).unwrap_or(1.0);
            out.capacity.insert(name.to_string(), n.max(1.0));
        } else if let Some(name) = key.strip_prefix("drm-engine-") {
            if let Some(n) = parse_float(val).filter(|n| n.is_finite()) {
                out.engines.entry(name.to_string()).or_default().ns = Some(n);
            }
        } else if let Some(name) = key.strip_prefix("drm-total-cycles-") {
            if let Some(n) = parse_float(val).filter(|n| n.is_finite()) {
                out.engines.entry(name.to_string()).or_default().total = Some(n);
            }
        } else if let Some(name) = key.strip_prefix("drm-cycles-") {
            if let Some(n) = parse_float(val).filter(|n| n.is_finite()) {
                out.engines.entry(name.to_string()).or_default().cycles = Some(n);
            }
        }
    }
    (out.driver.as_deref().is_some_and(|d| !d.is_empty()) || out.client_id.is_some()).then_some(out)
}

/// Busy share (0..1) of each engine for one client between two fdinfo reads.
pub fn engine_use(before: &Fdinfo, after: &Fdinfo, wall_ms: f64) -> BTreeMap<String, f64> {
    let mut out = BTreeMap::new();
    for (name, cur) in &after.engines {
        let Some(prev) = before.engines.get(name) else { continue };
        let mut u = None;
        if let (Some(c), Some(pc), Some(t), Some(pt)) = (cur.cycles, prev.cycles, cur.total, prev.total) {
            let total = t - pt;
            if total > 0.0 {
                u = Some((c - pc) / total);
            }
        } else if let (Some(n), Some(pn)) = (cur.ns, prev.ns) {
            if wall_ms > 0.0 {
                u = Some((n - pn) / (wall_ms * 1e6));
            }
        }
        let Some(u) = u.filter(|u| u.is_finite() && *u >= 0.0) else { continue };
        out.insert(name.clone(), (u / after.capacity.get(name).copied().unwrap_or(1.0)).min(1.0));
    }
    out
}

fn group_max(engines: &BTreeMap<String, f64>, test: fn(&str) -> bool) -> Option<f64> {
    let mut best: Option<f64> = None;
    for (name, u) in engines {
        if test(name) && best.is_none_or(|b| *u > b) {
            best = Some(*u);
        }
    }
    best
}

/// "0: 500Mhz\n1: 2321Mhz *" -> 2321
pub fn current_clock(text: Option<&str>) -> Option<f64> {
    re!(r"(?i)(\d+)\s*Mhz\s*\*").group(text.unwrap_or(""), 1).and_then(|n| n.parse().ok())
}

/// Whether a program is on PATH (or in WSL's driver folder).
pub fn on_path(name: &str) -> bool {
    let path = std::env::var("PATH").unwrap_or_default();
    let found = path.split(':').chain(["/usr/lib/wsl/lib"]).any(|d| !d.is_empty() && exists(Path::new(d).join(name)));
    found
}

#[derive(Clone, Debug, PartialEq)]
pub struct NvidiaLine {
    pub index: i64,
    pub name: Option<String>,
    pub driver_version: Option<String>,
    pub busy: Option<f64>,
    pub encoder: Option<f64>,
    pub decoder: Option<f64>,
    pub vram_used_b: Option<f64>,
    pub vram_total_b: Option<f64>,
    pub temp_c: Option<f64>,
    pub power_w: Option<f64>,
    pub clock_mhz: Option<f64>,
}

/// One CSV line of the nvidia-smi query; [N/A] and friends become None.
pub fn parse_nvidia_line(line: &str) -> Option<NvidiaLine> {
    let parts: Vec<&str> = line.split(',').map(str::trim).collect();
    if parts.len() < 11 {
        return None;
    }
    let index = crate::ops::js::number_str(parts[0]);
    if !(index.fract() == 0.0 && index >= 0.0 && index.is_finite()) {
        return None;
    }
    let tail = &parts[parts.len() - 9..];
    let name = parts[1..parts.len() - 9].join(", ");
    let n = |s: &str| -> Option<f64> {
        if s.is_empty() || re!(r"^\[.*\]$").is(s) || s.eq_ignore_ascii_case("N/A") {
            return None;
        }
        parse_float(s).filter(|v| v.is_finite())
    };
    let mib = |s: &str| n(s).map(|v| js_round(v * 1_048_576.0));
    let driver = tail[0];
    Some(NvidiaLine {
        index: index as i64,
        name: (!name.is_empty()).then_some(name),
        driver_version: (!driver.is_empty() && !re!(r"^\[.*\]$").is(driver)).then(|| driver.to_string()),
        busy: n(tail[1]),
        encoder: n(tail[2]),
        decoder: n(tail[3]),
        vram_used_b: mib(tail[4]),
        vram_total_b: mib(tail[5]),
        temp_c: n(tail[6]),
        power_w: n(tail[7]),
        clock_mhz: n(tail[8]),
    })
}

struct SmiState {
    wanted: bool,
    child: Option<(u64, Box<dyn super::Child>)>,
    timer: Option<u64>,
    backoff: i64,
    gpus: Vec<(i64, NvidiaLine, i64)>,
    missing_logged: bool,
    generation: u64,
}

/// The long-running nvidia-smi: started while sampling, restarted with backoff, killed on stop.
pub struct NvidiaSmi {
    launcher: Arc<dyn Launcher>,
    timers: Arc<dyn Timers>,
    now: Clock,
    interval_ms: i64,
    log: super::LogFn,
    state: Mutex<SmiState>,
}

impl NvidiaSmi {
    pub fn new(launcher: Arc<dyn Launcher>, timers: Arc<dyn Timers>, now: Clock, interval_ms: i64, log: super::LogFn) -> Arc<NvidiaSmi> {
        Arc::new(NvidiaSmi { launcher, timers, now, interval_ms, log, state: Mutex::new(SmiState { wanted: false, child: None, timer: None, backoff: 2000, gpus: Vec::new(), missing_logged: false, generation: 0 }) })
    }

    pub fn start(self: &Arc<Self>) {
        let go = {
            let mut s = self.state.lock().unwrap();
            s.wanted = true;
            s.child.is_none() && s.timer.is_none()
        };
        if go {
            self.launch();
        }
    }

    pub fn stop(&self) {
        let child = {
            let mut s = self.state.lock().unwrap();
            s.wanted = false;
            if let Some(t) = s.timer.take() {
                self.timers.clear_timeout(t);
            }
            s.child.take()
        };
        if let Some((_, mut c)) = child {
            c.kill();
        }
    }

    fn launch(self: &Arc<Self>) {
        let generation = {
            let mut s = self.state.lock().unwrap();
            s.timer = None;
            if !s.wanted {
                return;
            }
            s.generation += 1;
            s.generation
        };
        let started_at = (self.now)();
        let args = vec![format!("--query-gpu={NVIDIA_QUERY}"), "--format=csv,noheader,nounits".to_string(), "-lms".to_string(), self.interval_ms.to_string()];
        let me = Arc::downgrade(self);
        let on_line: Box<dyn Fn(&str) + Send + Sync> = Box::new(move |line: &str| {
            let Some(me) = me.upgrade() else { return };
            if let Some(g) = parse_nvidia_line(line) {
                let at = (me.now)();
                let mut s = me.state.lock().unwrap();
                match s.gpus.iter_mut().find(|e| e.0 == g.index) {
                    Some(e) => {
                        e.1 = g;
                        e.2 = at;
                    }
                    None => s.gpus.push((g.index, g, at)),
                }
                if s.gpus.len() > 16 {
                    s.gpus.remove(0);
                }
            }
        });
        let me = Arc::downgrade(self);
        let on_exit: Box<dyn FnOnce(Option<String>) + Send> = Box::new(move |err: Option<String>| {
            let Some(me) = me.upgrade() else { return };
            {
                let mut s = me.state.lock().unwrap();
                // a child stopped or replaced meanwhile must not start another one
                if s.child.as_ref().map(|c| c.0) != Some(generation) {
                    return;
                }
                s.child = None;
            }
            me.ended(err, started_at);
        });
        // (the lock is held while it starts: its first line or its end waits for the handle to be kept)
        let mut s = self.state.lock().unwrap();
        match self.launcher.spawn_lines("nvidia-smi", &args, on_line, on_exit) {
            Ok(child) => {
                if s.wanted && s.generation == generation {
                    s.child = Some((generation, child));
                } else {
                    drop(s);
                    let mut c = child;
                    c.kill();
                }
            }
            Err(code) => {
                drop(s);
                self.ended(Some(code), started_at);
            }
        }
    }

    fn ended(self: &Arc<Self>, err: Option<String>, started_at: i64) {
        let delay = {
            let mut s = self.state.lock().unwrap();
            if !s.wanted {
                return;
            }
            if err.as_deref() == Some("ENOENT") {
                // the device is there but the toolkit did not bring nvidia-smi in
                if !s.missing_logged {
                    (self.log)("warn", "An NVIDIA GPU is present but nvidia-smi is not available in the container; NVIDIA numbers are not shown.");
                }
                s.missing_logged = true;
                10 * 60 * 1000
            } else {
                if (self.now)() - started_at > 60000 {
                    s.backoff = 2000;
                }
                let d = s.backoff;
                s.backoff = (s.backoff * 2).min(5 * 60 * 1000);
                d
            }
        };
        let me = Arc::downgrade(self);
        let mut s = self.state.lock().unwrap();
        let id = self.timers.set_timeout(
            delay,
            Box::new(move || {
                if let Some(me) = me.upgrade() {
                    me.launch();
                }
            }),
        );
        s.timer = Some(id);
    }

    pub fn running(&self) -> bool {
        self.state.lock().unwrap().child.is_some()
    }

    pub fn read(&self) -> Vec<Value> {
        let t = (self.now)();
        let fresh = (3 * self.interval_ms).max(6000);
        let mut gpus = self.state.lock().unwrap().gpus.clone();
        gpus.sort_by_key(|g| g.0);
        gpus.into_iter()
            .map(|(_, g, at)| {
                let ok = t - at <= fresh;
                let pick = |v: Option<f64>| if ok { v.map_or(Value::Null, jnum) } else { Value::Null };
                json!({
                    "id": format!("nvidia{}", g.index), "name": g.name, "vendor": "nvidia", "driver": "nvidia", "driverVersion": g.driver_version, "node": format!("nvidia{}", g.index),
                    "busy": pick(g.busy), "video": pick(max_of([g.encoder, g.decoder])), "vramUsedB": pick(g.vram_used_b), "vramTotalB": g.vram_total_b.map_or(Value::Null, jnum),
                    "clockMHz": pick(g.clock_mhz), "tempC": pick(g.temp_c), "powerW": pick(round(g.power_w, 1)), "clients": null, "powerSource": "nvidia-smi"
                })
            })
            .collect()
    }
}

#[derive(Clone, Debug, Default)]
struct Held {
    video: Option<(f64, i64)>,
    busy: Option<(f64, i64)>,
}

#[derive(Clone, Debug)]
struct Card {
    id: String,
    dev: String,
    pdev: String,
    driver: Option<String>,
    kind: &'static str,
    vendor: String,
    node: String,
    name: String,
    runtime: PathBuf,
    fdinfo_seen: bool,
    vram_total_b: Option<f64>,
    busy_file: Option<PathBuf>,
    vram_used_file: Option<PathBuf>,
    sclk_file: Option<PathBuf>,
    power_file: Option<PathBuf>,
    integrated: bool,
    freq_file: Option<PathBuf>,
    energy_file: Option<PathBuf>,
    temp_file: Option<PathBuf>,
    held: Held,
}

#[derive(Default)]
struct GpuUse {
    engines: BTreeMap<String, f64>,
    pids: HashSet<i64>,
    measured: bool,
}

pub struct GpuProvider {
    proc_root: PathBuf,
    sys_root: PathBuf,
    dev_root: PathBuf,
    reads: Arc<BackgroundReads>,
    pci_ids_files: Vec<PathBuf>,
    cards: Vec<Card>,
    names: HashMap<String, String>,
    fd_cache: HashMap<String, (f64, Vec<String>)>,
    prev_clients: HashMap<String, (i64, Fdinfo)>,
    per_pid: HashMap<i64, Option<f64>>,
    drm_open: bool,
    pub has_nvidia: bool,
    find_bin: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    pub nvidia: Arc<NvidiaSmi>,
}

pub struct GpuOptions {
    pub proc_root: PathBuf,
    pub sys_root: PathBuf,
    pub dev_root: PathBuf,
    pub pci_ids_files: Vec<PathBuf>,
    pub find_bin: Arc<dyn Fn(&str) -> bool + Send + Sync>,
}

impl GpuProvider {
    pub fn new(o: GpuOptions, reads: Arc<BackgroundReads>, nvidia: Arc<NvidiaSmi>) -> GpuProvider {
        GpuProvider {
            proc_root: o.proc_root,
            sys_root: o.sys_root,
            dev_root: o.dev_root,
            reads,
            pci_ids_files: o.pci_ids_files,
            cards: Vec::new(),
            names: HashMap::new(),
            fd_cache: HashMap::new(),
            prev_clients: HashMap::new(),
            per_pid: HashMap::new(),
            drm_open: true,
            has_nvidia: false,
            find_bin: o.find_bin,
            nvidia,
        }
    }

    pub fn probe(&mut self, sensors: &mut SensorsProvider) {
        // Docker Desktop on Windows (WSL 2): no /dev/nvidia0, the card comes through /dev/dxg
        let wsl = exists(self.dev_root.join("dxg"));
        self.has_nvidia = exists(self.dev_root.join("nvidia0")) || exists(self.proc_root.join("driver/nvidia/version")) || (wsl && (self.find_bin)("nvidia-smi"));
        let drm = self.sys_root.join("class/drm");
        let names = list_dir(&drm, 4096);
        let renders: Vec<(String, Option<String>)> = names.iter().filter(|n| re!(r"^renderD\d+$").is(n)).map(|r| (r.clone(), real_path(drm.join(r).join("device")))).collect();
        let mut card_names: Vec<&String> = names.iter().filter(|n| re!(r"^card\d+$").is(n)).collect();
        card_names.sort_by_key(|n| n[4..].parse::<u64>().unwrap_or(0));
        let mut cards: Vec<Card> = Vec::new();
        for card in card_names {
            let dir = drm.join(card);
            let Some(dev) = real_path(dir.join("device")) else { continue };
            if cards.iter().any(|c| c.dev == dev) {
                continue;
            }
            let uevent = parse_uevent(read_text(dir.join("device/uevent")).as_deref());
            let link = read_link(dir.join("device/driver"));
            let driver = link.map(|l| basename(&l)).filter(|s| !s.is_empty()).or_else(|| uevent.get("DRIVER").filter(|s| !s.is_empty()).cloned());
            if driver.as_deref() == Some("nvidia") {
                continue; // reported by nvidia-smi
            }
            // WSL's stand-in display device (faux_driver, d3d12): not a real GPU
            if wsl && (driver.as_deref() == Some("faux_driver") || re!(r"(?i)d3d12").is(driver.as_deref().unwrap_or(""))) {
                continue;
            }
            // display-only devices (server BMC graphics, simpledrm) have no render node
            let Some(render) = renders.iter().find(|x| x.1.as_deref() == Some(dev.as_str())) else { continue };
            let vendor_id = read_line(dir.join("device/vendor"));
            let device_id = read_line(dir.join("device/device"));
            let kind = match driver.as_deref() {
                Some("amdgpu") => "amd",
                Some("i915") | Some("xe") => "intel",
                _ => "other",
            };
            let vendor = if kind != "other" { kind.to_string() } else { vendor_id.as_deref().and_then(vendor_of_id).unwrap_or("other").to_string() };
            let chip: Option<Chip> = sensors.chip_of(Some(&dev));
            let name = self.name_of(&dev, driver.as_deref(), kind, &vendor, vendor_id.as_deref(), device_id.as_deref());
            let devp = PathBuf::from(&dev);
            let mut c = Card {
                id: card.clone(),
                pdev: basename(&dev),
                driver: driver.clone(),
                kind,
                vendor,
                node: render.0.clone(),
                name,
                runtime: devp.join("power/runtime_status"),
                fdinfo_seen: false,
                vram_total_b: None,
                busy_file: None,
                vram_used_file: None,
                sclk_file: None,
                power_file: None,
                integrated: false,
                freq_file: None,
                energy_file: None,
                temp_file: None,
                held: Held::default(),
                dev: dev.clone(),
            };
            if kind == "amd" {
                c.busy_file = Some(devp.join("gpu_busy_percent"));
                c.vram_used_file = Some(devp.join("mem_info_vram_used"));
                c.vram_total_b = num(read_line(devp.join("mem_info_vram_total")).as_deref());
                c.sclk_file = Some(devp.join("pp_dpm_sclk"));
                let p = chip.as_ref().and_then(|ch| if ch.files.contains("power1_average") { Some("power1_average") } else if ch.files.contains("power1_input") { Some("power1_input") } else { None });
                c.power_file = p.map(|p| chip.as_ref().unwrap().dir.join(p));
                // amdgpu shows no fans on APUs; their power reading is the whole chip, CPU included
                c.integrated = chip.as_ref().is_some_and(|ch| !ch.files.contains("fan1_input"));
            } else if kind == "intel" {
                c.freq_file = [dir.join("gt_act_freq_mhz"), dir.join("gt/gt0/rps_act_freq_mhz"), dir.join("device/tile0/gt0/freq0/act_freq")].into_iter().find(|p| exists(p));
                if let Some(ch) = &chip {
                    let mut energy: Vec<&String> = ch.files.iter().filter(|f| re!(r"^energy\d+_input$").is(f)).collect();
                    energy.sort();
                    let card_e = energy.iter().find(|f| read_line(ch.dir.join(f.replace("_input", "_label"))).as_deref() == Some("card"));
                    c.energy_file = card_e.or(energy.first()).map(|f| ch.dir.join(f));
                }
            }
            if let Some(ch) = chip.as_ref().filter(|ch| !ch.temps.is_empty()) {
                let t = ch.temps.iter().find(|x| matches!(x.label.as_deref(), Some("edge") | Some("pkg"))).unwrap_or(&ch.temps[0]);
                c.temp_file = Some(t.file.clone());
            }
            cards.push(c);
        }
        // keep what was learned from fdinfo across a re-probe
        for c in &mut cards {
            c.fdinfo_seen = self.cards.iter().find(|o| o.dev == c.dev).is_some_and(|o| o.fdinfo_seen);
        }
        self.cards = cards;
        let devs: Vec<String> = self.cards.iter().map(|c| c.dev.clone()).collect();
        sensors.mark_gpu_chips(&devs);
    }

    fn name_of(&mut self, dev: &str, driver: Option<&str>, kind: &str, vendor: &str, vendor_id: Option<&str>, device_id: Option<&str>) -> String {
        let key = format!("{}:{}:{}", vendor_id.unwrap_or("null"), device_id.unwrap_or("null"), driver.unwrap_or("null"));
        if let Some(n) = self.names.get(&key) {
            return n.clone();
        }
        let name = gpu_display_name(Some(dev), driver, Some(kind), Some(vendor), vendor_id, device_id, &self.pci_ids_files);
        self.names.insert(key, name.clone());
        name
    }

    /// DRM fd numbers of a process (its open /dev/dri files).
    fn scan_fds(&self, pid: i64) -> Vec<String> {
        let dir = self.proc_root.join(pid.to_string()).join("fd");
        list_dir(&dir, 1024).into_iter().filter(|fd| read_link(dir.join(fd)).is_some_and(|t| t.starts_with("/dev/dri/"))).collect()
    }

    /// Engine use per GPU (and per process) from the fdinfo of the app's children.
    fn clients(&mut self, t: i64, procs: Option<&ProcessTable>) -> HashMap<String, GpuUse> {
        let mut by_gpu: HashMap<String, GpuUse> = HashMap::new();
        let mut per_pid: HashMap<i64, BTreeMap<String, f64>> = HashMap::new();
        let mut seen = HashSet::new();
        let mut next = HashMap::new();
        let mut alive = HashSet::new();
        let mut drm_open = procs.is_none();
        for p in procs.map(|p| p.descendants()).unwrap_or_default() {
            let key = format!("{}:{}", p.pid, p.start);
            alive.insert(key.clone());
            let stale = self.fd_cache.get(&key).is_none_or(|c| t as f64 - c.0 > 10000.0);
            if stale {
                let fds = self.scan_fds(p.pid);
                self.fd_cache.insert(key.clone(), (t as f64, fds));
            }
            let fds = self.fd_cache[&key].1.clone();
            if !fds.is_empty() {
                drm_open = true;
            }
            for fd in fds {
                let text = read_text(self.proc_root.join(p.pid.to_string()).join("fdinfo").join(&fd));
                if text.is_none() {
                    // the fd was closed: look again next time
                    if let Some(c) = self.fd_cache.get_mut(&key) {
                        c.0 = f64::NEG_INFINITY;
                    }
                    continue;
                }
                let Some(info) = parse_fdinfo(text.as_deref()) else { continue };
                let Some(client_id) = info.client_id.clone() else { continue };
                let gpu_key = info.pdev.clone().filter(|p| !p.is_empty()).unwrap_or_else(|| format!("driver:{}", info.driver.clone().unwrap_or_else(|| "null".into())));
                let client = format!("{gpu_key}|{client_id}");
                if !seen.insert(client.clone()) {
                    continue;
                }
                next.insert(client.clone(), (t, info.clone()));
                let g = by_gpu.entry(gpu_key).or_default();
                g.pids.insert(p.pid);
                let Some(before) = self.prev_clients.get(&client) else { continue };
                g.measured = true;
                for (name, u) in engine_use(&before.1, &info, (t - before.0) as f64) {
                    *g.engines.entry(name.clone()).or_insert(0.0) += u;
                    *per_pid.entry(p.pid).or_default().entry(name).or_insert(0.0) += u;
                }
            }
            if self.fd_cache.len() > 4096 {
                self.fd_cache.clear();
            }
        }
        self.fd_cache.retain(|k, _| alive.contains(k));
        self.prev_clients = next;
        self.drm_open = drm_open;
        self.per_pid = per_pid.into_iter().map(|(pid, e)| (pid, group_max(&e, video_engine))).collect();
        by_gpu
    }

    /// Video engine % of one of the app's children (for the process list).
    pub fn video_of(&self, pid: i64) -> Option<f64> {
        self.per_pid.get(&pid).copied().flatten().and_then(|u| round(clamp_pct(Some(u * 100.0)), 0))
    }

    fn watts(&self, file: &Path) -> Option<f64> {
        let e = self.reads.get(file, 0);
        let (a, b) = (num(e.prev_text.as_deref())?, num(e.text.as_deref())?);
        let (at, prev_at) = (e.at?, e.prev_at?);
        if at <= prev_at {
            return None;
        }
        let w = (b - a) / 1e6 / ((at - prev_at) as f64 / 1000.0);
        (w >= 0.0 && w < 2000.0).then_some(w)
    }

    /// The GPUs now, each with its `powerSource` (the engine leaves that out of the answer).
    pub fn sample(&mut self, t: i64, procs: Option<&ProcessTable>) -> Vec<Value> {
        let usage = self.clients(t, procs);
        let pct = |u: Option<f64>| u.and_then(|u| round(clamp_pct(Some(u * 100.0)), 0));
        let mut out = Vec::new();
        let drm_open = self.drm_open;
        let reads = self.reads.clone();
        let mut cards = std::mem::take(&mut self.cards);
        for c in &mut cards {
            let g = usage.get(&c.pdev).or_else(|| usage.get(&format!("driver:{}", c.driver.as_deref().unwrap_or("null"))));
            if g.is_some() {
                c.fdinfo_seen = true;
            }
            let (mut busy, mut video, mut clients): (Option<f64>, Option<f64>, Option<f64>) = (None, None, None);
            if c.fdinfo_seen || (!drm_open && (c.kind == "amd" || c.kind == "intel")) {
                let known = g.is_none_or(|g| g.measured);
                video = if known { Some(g.map_or(0.0, |g| pct(group_max(&g.engines, video_engine)).unwrap_or(0.0))) } else { None };
                if c.kind != "amd" {
                    busy = if known { Some(g.map_or(0.0, |g| pct(group_max(&g.engines, render_engine)).unwrap_or(0.0))) } else { None };
                }
                clients = Some(g.map_or(0.0, |g| g.pids.len() as f64));
            }
            // the last known numbers stand in for up to 10 s, so the tiles do not blink at each clip
            for (slot, held) in [(&mut video, &mut c.held.video), (&mut busy, &mut c.held.busy)] {
                match (*slot, *held) {
                    (None, Some((v, at))) if t - at < 10000 => *slot = Some(v),
                    (Some(v), _) => *held = Some((v, t)),
                    _ => {}
                }
            }
            let mut entry = Map::new();
            let mut vram_used = None;
            let mut clock = None;
            let mut temp = None;
            let mut power = None;
            // asking a sleeping GPU anything wakes it up (and costs power)
            let suspended = read_line(&c.runtime).as_deref() == Some("suspended");
            if suspended {
                if c.kind != "other" {
                    busy = Some(0.0);
                    video = Some(video.unwrap_or(0.0));
                }
            } else {
                if c.kind == "amd" {
                    busy = num(reads.text(c.busy_file.as_ref().unwrap(), 0, 10000).as_deref());
                    vram_used = num(reads.text(c.vram_used_file.as_ref().unwrap(), 0, 10000).as_deref());
                    clock = current_clock(reads.text(c.sclk_file.as_ref().unwrap(), 0, 10000).as_deref());
                    if let Some(uw) = c.power_file.as_ref().and_then(|f| num(reads.text(f, 0, 10000).as_deref())).filter(|uw| *uw >= 0.0) {
                        power = round(Some(uw / 1e6), 1);
                    }
                } else if c.kind == "intel" {
                    if let Some(f) = &c.freq_file {
                        clock = num(reads.text(f, 0, 10000).as_deref());
                    }
                    if let Some(f) = c.energy_file.clone() {
                        power = round(self.watts(&f), 1);
                    }
                }
                if let Some(f) = &c.temp_file {
                    temp = num(reads.text(f, 0, 10000).as_deref()).filter(|mc| *mc > -30000.0 && *mc < 150000.0).and_then(|mc| round(Some(mc / 1000.0), 1));
                }
            }
            let n = |x: Option<f64>| x.map_or(Value::Null, jnum);
            entry.insert("id".into(), json!(c.id));
            entry.insert("name".into(), json!(c.name));
            entry.insert("vendor".into(), json!(c.vendor));
            entry.insert("driver".into(), json!(c.driver));
            entry.insert("node".into(), json!(c.node));
            entry.insert("busy".into(), n(busy));
            entry.insert("video".into(), n(video));
            entry.insert("vramUsedB".into(), n(vram_used));
            entry.insert("vramTotalB".into(), n(c.vram_total_b));
            entry.insert("clockMHz".into(), n(clock));
            entry.insert("tempC".into(), n(temp));
            entry.insert("powerW".into(), n(power));
            entry.insert("clients".into(), n(clients));
            entry.insert("integrated".into(), json!(c.integrated));
            entry.insert("powerSource".into(), if power.is_some() { json!("hwmon") } else { Value::Null });
            out.push(Value::Object(entry));
        }
        self.cards = cards;
        if self.has_nvidia {
            out.extend(self.nvidia.read());
        }
        out
    }

    pub fn start_streams(&self) {
        if self.has_nvidia {
            self.nvidia.start();
        }
    }

    pub fn stop_streams(&self) {
        self.nvidia.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // test/statsGpu.test.js "small parsers: nvidia-smi lines, pci.ids, the current shader clock"
    #[test]
    fn small_parsers() {
        let g = parse_nvidia_line("0, NVIDIA GeForce RTX 3060, 550.54.14, 23, 61, 12, 1650, 12288, 54, 41.27, 1777").unwrap();
        assert_eq!(g.name.as_deref(), Some("NVIDIA GeForce RTX 3060"));
        assert_eq!((g.busy, g.encoder, g.decoder, g.vram_used_b, g.temp_c, g.power_w, g.clock_mhz), (Some(23.0), Some(61.0), Some(12.0), Some(1650.0 * 1_048_576.0), Some(54.0), Some(41.27), Some(1777.0)));
        let t4 = parse_nvidia_line("1, Tesla T4, 550.54.14, 0, [N/A], [N/A], 3, 15360, 33, [N/A], [Not Supported]").unwrap();
        assert_eq!((t4.encoder, t4.power_w, t4.clock_mhz), (None, None, None));
        let comma = parse_nvidia_line("2, Quadro, Max-Q, 550.54.14, 1, 2, 3, 4, 5, 6, 7, 8").unwrap();
        assert_eq!(comma.name.as_deref(), Some("Quadro, Max-Q"));
        assert_eq!(parse_nvidia_line("x, a, b"), None);
        assert_eq!(parse_nvidia_line("-1, a, 1, 1, 1, 1, 1, 1, 1, 1, 1"), None);
        let ids = "# x\n8086  Intel Corporation\n\t4680  AlderLake-S GT1\n\t56a5  DG2 [Arc A380]\n\t\t8086 1020  Arc A380 reference\n1002  Advanced Micro Devices, Inc. [AMD/ATI]\n\t73ff  Navi 23 [Radeon RX 6600/6600 XT/6600M]\n";
        assert_eq!(lookup_pci_ids(Some(ids), Some("0x8086"), Some("0x56a5"), "intel").as_deref(), Some("Intel Arc A380"));
        assert_eq!(lookup_pci_ids(Some(ids), Some("0x8086"), Some("0x4680"), "intel").as_deref(), Some("Intel AlderLake-S GT1"));
        assert_eq!(lookup_pci_ids(Some(ids), Some("0x1002"), Some("0x73ff"), "amd").as_deref(), Some("AMD Radeon RX 6600/6600 XT/6600M"));
        assert_eq!(lookup_pci_ids(Some(ids), Some("0x1002"), Some("0x9999"), "amd"), None);
        assert_eq!(current_clock(Some("0: 500Mhz\n1: 2321Mhz *\n")), Some(2321.0));
        assert_eq!(current_clock(Some("0: 500Mhz\n")), None);
    }

    // "fdinfo: i915 and amdgpu count nanoseconds, xe counts cycles; capacity divides"
    #[test]
    fn fdinfo_use() {
        let a = parse_fdinfo(Some("drm-driver:\ti915\ndrm-pdev:\t0000:00:02.0\ndrm-client-id:\t7\ndrm-engine-render:\t1000000 ns\ndrm-engine-video:\t0 ns\ndrm-engine-capacity-video:\t2\n")).unwrap();
        let b = parse_fdinfo(Some("drm-driver:\ti915\ndrm-pdev:\t0000:00:02.0\ndrm-client-id:\t7\ndrm-engine-render:\t501000000 ns\ndrm-engine-video:\t1600000000 ns\ndrm-engine-capacity-video:\t2\n")).unwrap();
        let u = engine_use(&a, &b, 2000.0);
        assert_eq!(u["render"], 0.25);
        assert_eq!(u["video"], 0.4);
        let x1 = parse_fdinfo(Some("drm-driver: xe\ndrm-client-id: 3\ndrm-cycles-rcs: 100\ndrm-total-cycles-rcs: 1000\ndrm-cycles-vcs: 0\ndrm-total-cycles-vcs: 1000\n")).unwrap();
        let x2 = parse_fdinfo(Some("drm-driver: xe\ndrm-client-id: 3\ndrm-cycles-rcs: 220\ndrm-total-cycles-rcs: 2000\ndrm-cycles-vcs: 940\ndrm-total-cycles-vcs: 2000\n")).unwrap();
        let u = engine_use(&x1, &x2, 2000.0);
        assert_eq!(u["rcs"], 0.12);
        assert_eq!(u["vcs"], 0.94);
        assert_eq!(parse_fdinfo(Some("pos: 0\nflags: 02\n")), None);
        assert_eq!(parse_fdinfo(Some("")), None);
    }
}
