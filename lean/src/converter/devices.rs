//! src/main/converter/encodeDevices.js: the devices a conversion can encode
//! on: every Intel/AMD render node, every NVIDIA GPU nvidia-smi lists, and
//! the CPU (always last). A device is named by its PCI slot, never by its
//! node (the compose remap trick and a reboot change node names, the slot
//! stays). Only ids from this list are ever used.

use super::planner::Device;
use super::process::{RunOptions, Runner};
use serde_json::{json, Map, Value};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub const NVIDIA_TIMEOUT_MS: u64 = 10_000;
pub const NVIDIA_DEADLINE_MS: u64 = NVIDIA_TIMEOUT_MS + 2_000;

/// CPU_DEVICE
pub fn cpu_device() -> Value {
    json!({ "id": "cpu", "kind": "cpu", "vendor": null, "name": "CPU (software encoder)", "node": null, "index": null, "pci": null })
}

fn is_pci_slot(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 12 {
        return false;
    }
    let hex = |r: std::ops::Range<usize>| b[r].iter().all(|c| c.is_ascii_hexdigit());
    hex(0..4) && b[4] == b':' && hex(5..7) && b[7] == b':' && hex(8..10) && b[10] == b'.' && (b'0'..=b'7').contains(&b[11])
}

/// normalizePciSlot: "00000000:01:00.0" (nvidia-smi) -> "0000:01:00.0"
pub fn normalize_pci_slot(v: &str) -> Option<String> {
    let t = v.trim().to_lowercase();
    let chars: Vec<char> = t.chars().collect();
    let slot: String = chars[chars.len().saturating_sub(12)..].iter().collect();
    if is_pci_slot(&slot) {
        Some(slot)
    } else {
        None
    }
}

fn fallback_name(vendor: &str, pci: &str) -> String {
    let label = match vendor {
        "intel" => "Intel",
        "amd" => "AMD",
        "nvidia" => "NVIDIA",
        _ => "Unknown",
    };
    format!("{label} GPU ({pci})")
}

/// What nameOf is told about a render node's GPU.
#[derive(Debug, Clone, PartialEq)]
pub struct NameInfo {
    pub pci: String,
    pub vendor: String,
    pub vendor_id: Option<String>,
    pub device_id: Option<String>,
    pub driver: Option<String>,
    pub sys_device: String,
}

pub enum Rdev {
    /// st_rdev of the node
    Stat,
    /// by name in /sys/class/drm only
    None,
    Fn(Arc<dyn Fn(&Path) -> Result<Option<(u64, u64)>, String> + Send + Sync>),
}

pub struct Discovery {
    pub platform: String,
    pub dev_root: PathBuf,
    pub sys_root: PathBuf,
    pub run: Option<Arc<dyn Runner>>,
    pub rdev: Rdev,
    pub name_of: Option<Arc<dyn Fn(&NameInfo) -> Option<String> + Send + Sync>>,
    pub nvidia_deadline_ms: u64,
    /// an nvidia-smi still stuck past its deadline: no other one is started
    stuck: Arc<AtomicBool>,
}

/// createDeviceNameOf (server/converterHost.js): the stats engine's GPU names
pub fn stats_name_of() -> Arc<dyn Fn(&NameInfo) -> Option<String> + Send + Sync> {
    let files: Vec<PathBuf> = crate::ops::stats::gpu::PCI_IDS.iter().map(PathBuf::from).collect();
    let cache = std::sync::Mutex::new(std::collections::HashMap::<String, String>::new());
    Arc::new(move |i: &NameInfo| {
        let key = format!("{:?}:{:?}:{:?}:{}", i.vendor_id, i.device_id, i.driver, i.sys_device);
        let mut c = cache.lock().unwrap();
        if let Some(n) = c.get(&key) {
            return Some(n.clone());
        }
        if c.len() > 64 {
            c.clear();
        }
        let n = crate::ops::stats::gpu::gpu_display_name(Some(&i.sys_device), i.driver.as_deref(), Some(&i.vendor), Some(&i.vendor), i.vendor_id.as_deref(), i.device_id.as_deref(), &files);
        c.insert(key, n.clone());
        Some(n)
    })
}

impl Discovery {
    pub fn new(run: Option<Arc<dyn Runner>>) -> Discovery {
        Discovery { platform: std::env::consts::OS.into(), dev_root: "/dev".into(), sys_root: "/sys".into(), run, rdev: Rdev::Stat, name_of: None, nvidia_deadline_ms: NVIDIA_DEADLINE_MS, stuck: Arc::new(AtomicBool::new(false)) }
    }

    fn read_line(p: &Path) -> Option<String> {
        std::fs::read_to_string(p).ok().map(|s| s.trim().to_string())
    }

    fn sys_device_of(&self, node: &Path, name: &str) -> Option<PathBuf> {
        let numbers = match &self.rdev {
            Rdev::None => None,
            Rdev::Stat => std::fs::metadata(node).ok().map(|m| m.rdev()).filter(|r| *r > 0).map(|r| ((r >> 8) & 0xfff, (r & 0xff) | ((r >> 12) & 0xfff00))),
            Rdev::Fn(f) => f(node).ok().flatten(),
        };
        if let Some((major, minor)) = numbers {
            if let Ok(p) = std::fs::canonicalize(self.sys_root.join("dev/char").join(format!("{major}:{minor}")).join("device")) {
                return Some(p);
            }
        }
        std::fs::canonicalize(self.sys_root.join("class/drm").join(name).join("device")).ok()
    }

    fn dri_devices(&self) -> Vec<Value> {
        let Ok(rd) = std::fs::read_dir(self.dev_root.join("dri")) else { return vec![] };
        let mut renders: Vec<String> = rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n.len() > 7 && n.starts_with("renderD") && n[7..].bytes().all(|b| b.is_ascii_digit())).collect();
        renders.sort_by(|a, b| a[7..].parse::<f64>().unwrap_or(0.0).partial_cmp(&b[7..].parse::<f64>().unwrap_or(0.0)).unwrap());
        let mut out: Vec<Value> = vec![];
        for name in renders {
            let node = self.dev_root.join("dri").join(&name);
            let Some(sys) = self.sys_device_of(&node, &name) else { continue };
            let slot = sys.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if !is_pci_slot(&slot) {
                continue;
            }
            let pci = slot.to_lowercase();
            let vendor_id = Self::read_line(&sys.join("vendor")).map(|s| s.to_lowercase()).filter(|s| !s.is_empty());
            let vendor = match vendor_id.as_deref() {
                Some("0x8086") => "intel",
                Some("0x1002") => "amd",
                _ => continue,
            };
            let driver = std::fs::read_link(sys.join("driver")).ok().and_then(|p| p.file_name().map(|s| s.to_string_lossy().to_string()));
            if driver.as_deref() == Some("nvidia") {
                continue;
            }
            if out.iter().any(|d| d["pci"] == pci.as_str()) {
                continue;
            }
            let device_id = Self::read_line(&sys.join("device")).map(|s| s.to_lowercase()).filter(|s| !s.is_empty());
            let info = NameInfo { pci: pci.clone(), vendor: vendor.into(), vendor_id, device_id, driver, sys_device: sys.to_string_lossy().to_string() };
            let shown = self.name_of.as_ref().and_then(|f| f(&info)).map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).map(|n| n.chars().take(128).collect()).unwrap_or_else(|| fallback_name(vendor, &pci));
            out.push(json!({ "id": format!("pci:{pci}"), "kind": "dri", "vendor": vendor, "name": shown, "node": node.to_string_lossy(), "index": null, "pci": pci }));
        }
        out
    }

    fn nvidia_devices(&self) -> Vec<Value> {
        let Some(run) = self.run.clone() else { return vec![] };
        if self.stuck.load(Ordering::SeqCst) {
            return vec![];
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let stuck = self.stuck.clone();
        let late = Arc::new(AtomicBool::new(false));
        let late2 = late.clone();
        std::thread::spawn(move || {
            let args: Vec<String> = vec!["--query-gpu=index,pci.bus_id,name".into(), "--format=csv,noheader".into()];
            let r = run.run("nvidia-smi", &args, &RunOptions { timeout_ms: Some(NVIDIA_TIMEOUT_MS), ..Default::default() });
            if late2.load(Ordering::SeqCst) {
                stuck.store(false, Ordering::SeqCst);
            }
            let _ = tx.send(r);
        });
        let r = match rx.recv_timeout(Duration::from_millis(self.nvidia_deadline_ms)) {
            Ok(r) => r,
            Err(_) => {
                self.stuck.store(true, Ordering::SeqCst);
                late.store(true, Ordering::SeqCst);
                return vec![];
            }
        };
        let Ok(r) = r else { return vec![] };
        if r.status != Some(0) || r.error.is_some() || r.timed_out {
            return vec![];
        }
        let mut out: Vec<Value> = vec![];
        for line in r.stdout.split('\n') {
            let line = line.strip_suffix('\r').unwrap_or(line);
            let parts: Vec<&str> = line.split(',').map(str::trim).collect();
            if parts.len() < 3 || parts[0].is_empty() || !parts[0].bytes().all(|b| b.is_ascii_digit()) {
                continue;
            }
            let Ok(index) = parts[0].parse::<i64>() else { continue };
            let Some(pci) = normalize_pci_slot(parts[1]) else { continue };
            if out.iter().any(|d| d["pci"] == pci.as_str()) {
                continue;
            }
            let joined: String = parts[2..].join(", ").chars().take(128).collect();
            let name = if joined.is_empty() { fallback_name("nvidia", &pci) } else { joined };
            out.push(json!({ "id": format!("pci:{pci}"), "kind": "nvidia", "vendor": "nvidia", "name": name, "node": null, "index": index, "pci": pci }));
        }
        out.sort_by_key(|d| d["index"].as_i64().unwrap_or(0));
        out
    }

    /// list(): DRI GPUs, NVIDIA GPUs (those not already listed), the CPU
    pub fn list(&self) -> Vec<Value> {
        if self.platform != "linux" {
            return vec![cpu_device()];
        }
        let dri = self.dri_devices();
        let nvidia: Vec<Value> = self.nvidia_devices().into_iter().filter(|d| !dri.iter().any(|o| o["id"] == d["id"])).collect();
        let mut all = dri;
        all.extend(nvidia);
        all.push(cpu_device());
        all
    }
}

/// A listed device as the planner takes it.
pub fn device_of(v: &Value) -> Device {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let encoders = v.get("encoders").and_then(Value::as_object).map(|m| m.iter().filter_map(|(k, x)| x.as_str().map(|e| (k.clone(), e.to_string()))).collect()).unwrap_or_default();
    Device { id: s("id").unwrap_or_default(), kind: s("kind").unwrap_or_default(), vendor: s("vendor"), node: s("node"), index: v.get("index").and_then(Value::as_i64), name: s("name"), encoders }
}

/// What the device list asks the encoder planner (encoderPlanner.js).
pub trait Encoders: Send + Sync {
    fn select(&self, family: &str, probe: bool) -> Result<Option<super::planner::Selected>, String>;
    fn select_for(&self, family: &str, d: &Device, probe: bool) -> Result<Option<super::planner::Selected>, String>;
    fn select_cpu_fallback(&self, family: &str) -> Result<super::planner::Selected, String>;
}

impl<R: Runner> Encoders for super::planner::Planner<R> {
    fn select(&self, family: &str, probe: bool) -> Result<Option<super::planner::Selected>, String> {
        super::planner::Planner::select(self, family, probe)
    }
    fn select_for(&self, family: &str, d: &Device, probe: bool) -> Result<Option<super::planner::Selected>, String> {
        super::planner::Planner::select_for(self, family, d, probe)
    }
    fn select_cpu_fallback(&self, family: &str) -> Result<super::planner::Selected, String> {
        super::planner::Planner::select_cpu_fallback(self, family)
    }
}

/// The encoding devices are looked up again at most this often while a job
/// finds its lanes' GPUs.
pub const DEVICE_LIST_TTL_MS: u64 = 2_000;

/// runtime.js listDevices / recentDevices / resolveDevice / defaultDeviceOf
/// / devices(): this server's own devices (and the helper servers', through
/// `remote_nodes`), one lookup at a time, an answer reused for 2 s.
pub struct Registry {
    pub discovery: Discovery,
    pub encoders: Arc<dyn Encoders>,
    /// helper servers' devices ({ kind: 'node', id: 'node:<id>@<device>', ... }); the nodes port sets it
    pub remote_nodes: Option<Arc<dyn Fn() -> Vec<Value> + Send + Sync>>,
    /// something converts here right now (a GPU is then not test-encoded)
    pub encoding_now: std::sync::Mutex<Option<Arc<dyn Fn() -> bool + Send + Sync>>>,
    cache: std::sync::Mutex<(Option<std::time::Instant>, Option<Vec<Value>>, u64)>,
    lookup: std::sync::Mutex<()>,
    /// lookups made (tests)
    pub lookups: std::sync::atomic::AtomicUsize,
}

impl Registry {
    pub fn new(discovery: Discovery, encoders: Arc<dyn Encoders>) -> Registry {
        Registry { discovery, encoders, remote_nodes: None, encoding_now: std::sync::Mutex::new(None), cache: std::sync::Mutex::new((None, None, 0)), lookup: std::sync::Mutex::new(()), lookups: Default::default() }
    }

    /// localDevices(): this server's GPUs and CPU (never the nodes)
    pub fn local_devices(&self) -> Vec<Value> {
        let l = self.discovery.list();
        if l.is_empty() {
            vec![cpu_device()]
        } else {
            l
        }
    }

    fn list_devices(&self) -> Vec<Value> {
        let mut l = self.local_devices();
        if let Some(r) = &self.remote_nodes {
            l.extend(r().into_iter().filter(|d| d["kind"] == "node" && d["id"].as_str().is_some_and(super::contracts::is_device_id)));
        }
        l
    }

    /// lookUpDevices(): a fresh list; callers while one runs share it
    pub fn look_up(&self) -> Vec<Value> {
        let gen = self.cache.lock().unwrap().2;
        let _one = self.lookup.lock().unwrap();
        {
            let c = self.cache.lock().unwrap();
            if c.2 != gen {
                return c.1.clone().unwrap_or_default();
            }
        }
        self.lookups.fetch_add(1, Ordering::SeqCst);
        let l = self.list_devices();
        let mut c = self.cache.lock().unwrap();
        *c = (Some(std::time::Instant::now()), Some(l.clone()), gen + 1);
        l
    }

    /// recentDevices(): the last list while it is at most 2 s old
    pub fn recent(&self) -> Vec<Value> {
        {
            let c = self.cache.lock().unwrap();
            if let (Some(at), Some(l)) = (c.0, &c.1) {
                if at.elapsed() <= Duration::from_millis(DEVICE_LIST_TTL_MS) {
                    return l.clone();
                }
            }
        }
        self.look_up()
    }

    /// resolveDevice(id): a lane's device id looked up only in this list
    pub fn resolve_device(&self, id: &str) -> Option<Value> {
        if !super::contracts::is_device_id(id) {
            return None;
        }
        let list = self.recent();
        if let Some(d) = list.iter().find(|d| d["id"] == id) {
            return Some(d.clone());
        }
        if super::contracts::node_key_of(id) != Some(id) {
            return None;
        }
        list.into_iter().find(|d| d["kind"] == "node" && d["isDefault"] == true && d["id"].as_str().and_then(super::contracts::node_key_of) == Some(id))
    }

    /// defaultDeviceOf(list, family, { able, probe })
    pub fn default_device_of(&self, list: &[Value], family: &str, able: &dyn Fn(&Value) -> bool, probe: bool) -> Option<String> {
        let selected = self.encoders.select(family, probe).ok().flatten()?;
        if !selected.hardware {
            return Some("cpu".into());
        }
        if selected.codec.ends_with("_nvenc") {
            let nvidia: Vec<&Value> = list.iter().filter(|d| d["kind"] == "nvidia" && able(d)).collect();
            return if nvidia.len() == 1 { nvidia[0]["id"].as_str().map(str::to_string) } else { None };
        }
        list.iter().find(|d| d["kind"] == "dri" && d["node"].as_str().and_then(|n| Path::new(n).file_name()).is_some_and(|n| n == "renderD128")).and_then(|d| d["id"].as_str().map(str::to_string))
    }

    /// the device a job without lanes encodes a codec on (serviceDeps.defaultDevice)
    pub fn default_device(&self, family: &str) -> Option<String> {
        let list = self.recent();
        self.default_device_of(&list, family, &|_| true, true)
    }

    /// devices(): each device with the encoder it proved per codec, and the
    /// device a job without lanes uses
    pub fn devices(&self) -> Value {
        let list = self.look_up();
        if list.iter().filter(|d| d["kind"] != "cpu").count() < 2 && !list.iter().any(|d| d["kind"] == "node") {
            let devices: Vec<Value> = list
                .into_iter()
                .map(|mut d| {
                    d["encoders"] = Value::Null;
                    d
                })
                .collect();
            return json!({ "devices": devices, "defaultDevice": null, "defaultDevices": null });
        }
        let busy = self.encoding_now.lock().unwrap().clone();
        let probe = !busy.is_some_and(|f| f());
        let encoder_for = |family: &str, d: &Value| -> Option<Value> {
            match self.encoders.select_for(family, &device_of(d), probe) {
                Ok(Some(c)) if !c.timed_out => Some(if c.hardware || d["kind"] == "cpu" { json!(c.codec) } else { Value::Null }),
                Ok(_) => None,
                Err(_) => Some(Value::Null),
            }
        };
        let devices: Vec<Value> = std::thread::scope(|s| {
            let hs: Vec<_> = list
                .iter()
                .map(|d| {
                    let encoder_for = &encoder_for;
                    s.spawn(move || {
                        let mut out = d.clone();
                        let mut enc = Map::new();
                        if let Some(v) = encoder_for("h265", d) {
                            enc.insert("h265".into(), v);
                        }
                        if let Some(v) = encoder_for("av1", d) {
                            enc.insert("av1".into(), v);
                        }
                        out["encoders"] = Value::Object(enc);
                        out
                    })
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let default_for = |family: &str| {
            let able = |d: &Value| devices.iter().find(|e| e["id"] == d["id"]).map_or(true, |e| !e["encoders"].get(family).is_some_and(Value::is_null));
            self.default_device_of(&list, family, &able, probe)
        };
        let h265 = default_for("h265");
        let av1 = default_for("av1");
        json!({ "devices": devices, "defaultDevice": h265, "defaultDevices": { "h265": h265, "av1": av1 } })
    }
}

#[cfg(test)]
mod tests {
    //! test/encodeDevices.test.js
    use super::*;
    use crate::converter::process::ProcResult;
    use std::os::unix::fs::symlink;
    use std::sync::Mutex;

    struct Machine {
        _d: crate::converter::testutil::TempDir,
        dev: PathBuf,
        sys: PathBuf,
    }

    fn machine() -> Machine {
        let d = crate::converter::testutil::tempdir().unwrap();
        let dev = d.path().join("dev");
        let sys = d.path().join("sys");
        std::fs::create_dir_all(dev.join("dri")).unwrap();
        let pci = |slot: &str, vendor: &str, device: &str, driver: &str| {
            let dir = sys.join("devices/pci0000:00").join(slot);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("vendor"), format!("{vendor}\n")).unwrap();
            std::fs::write(dir.join("device"), format!("{device}\n")).unwrap();
            let drv = sys.join("bus/pci/drivers").join(driver);
            std::fs::create_dir_all(&drv).unwrap();
            symlink(&drv, dir.join("driver")).unwrap();
            dir
        };
        let uhd = pci("0000:00:02.0", "0x8086", "0x4680", "i915");
        let arc = pci("0000:03:00.0", "0x8086", "0x56a5", "i915");
        let nv = pci("0000:01:00.0", "0x10de", "0x1fb2", "nvidia");
        let v3d = sys.join("devices/platform/fec00000.v3d");
        std::fs::create_dir_all(&v3d).unwrap();
        for (name, t) in [("renderD128", &uhd), ("renderD129", &arc), ("renderD130", &v3d), ("renderD131", &nv)] {
            std::fs::create_dir_all(sys.join("class/drm").join(name)).unwrap();
            symlink(t, sys.join("class/drm").join(name).join("device")).unwrap();
        }
        for (n, t) in [("226:128", &uhd), ("226:129", &arc), ("226:130", &v3d), ("226:131", &nv)] {
            std::fs::create_dir_all(sys.join("dev/char").join(n)).unwrap();
            symlink(t, sys.join("dev/char").join(n).join("device")).unwrap();
        }
        Machine { _d: d, dev, sys }
    }

    struct Fake(Box<dyn Fn(&str, &[String], &RunOptions) -> Result<ProcResult, String> + Send + Sync>);
    impl Runner for Fake {
        fn run(&self, c: &str, a: &[String], o: &RunOptions) -> Result<ProcResult, String> {
            (self.0)(c, a, o)
        }
    }
    fn no_nvidia() -> Option<Arc<dyn Runner>> {
        Some(Arc::new(Fake(Box::new(|_, _, _| Ok(ProcResult { status: None, error: Some("PROCESS_START_FAILED".into()), ..Default::default() })))))
    }
    fn disc(m: &Machine, run: Option<Arc<dyn Runner>>, rdev: Rdev) -> Discovery {
        let mut d = Discovery::new(run);
        d.platform = "linux".into();
        d.dev_root = m.dev.clone();
        d.sys_root = m.sys.clone();
        d.rdev = rdev;
        d
    }
    fn ids(l: &[Value]) -> Vec<String> {
        l.iter().map(|d| d["id"].as_str().unwrap().to_string()).collect()
    }
    fn base(p: &Value) -> Value {
        p.as_str().map(|s| json!(Path::new(s).file_name().unwrap().to_string_lossy())).unwrap_or(Value::Null)
    }

    #[test]
    fn render_nodes_by_pci_slot_the_cpu_last_and_the_remap_trick() {
        let m = machine();
        for n in ["renderD128", "renderD129"] {
            std::fs::write(m.dev.join("dri").join(n), "").unwrap();
        }
        let list = disc(&m, no_nvidia(), Rdev::Fn(Arc::new(|p: &Path| Ok(Some((226, if p.ends_with("renderD128") { 128 } else { 129 })))))).list();
        let got: Vec<Value> = list.iter().map(|d| json!([d["id"], d["kind"], d["vendor"], base(&d["node"]), d["index"]])).collect();
        assert_eq!(got, vec![json!(["pci:0000:00:02.0", "dri", "intel", "renderD128", null]), json!(["pci:0000:03:00.0", "dri", "intel", "renderD129", null]), json!(["cpu", "cpu", null, null, null])]);
        assert_eq!(list[0]["name"], "Intel GPU (0000:00:02.0)");
        assert_eq!(list[2]["name"], "CPU (software encoder)");
        assert_eq!(list[1]["node"], m.dev.join("dri/renderD129").to_string_lossy().as_ref());
        // the remap trick: inside, renderD128 is the Arc
        std::fs::remove_file(m.dev.join("dri/renderD129")).unwrap();
        let list = disc(&m, no_nvidia(), Rdev::Fn(Arc::new(|_: &Path| Ok(Some((226, 129)))))).list();
        assert_eq!(list.iter().map(|d| json!([d["id"], base(&d["node"])])).collect::<Vec<_>>(), vec![json!(["pci:0000:03:00.0", "renderD128"]), json!(["cpu", null])]);
        for rdev in [Rdev::None, Rdev::Fn(Arc::new(|_: &Path| Err("EACCES".into())))] {
            assert_eq!(disc(&m, no_nvidia(), rdev).list()[0]["id"], "pci:0000:00:02.0");
        }
    }

    #[test]
    fn a_soc_gpu_and_nvidia_render_nodes_are_left_out_and_names_come_from_name_of() {
        let m = machine();
        for n in ["renderD128", "renderD130", "renderD131"] {
            std::fs::write(m.dev.join("dri").join(n), "").unwrap();
        }
        let seen = Arc::new(Mutex::new(vec![]));
        let s2 = seen.clone();
        let mut d = disc(&m, no_nvidia(), Rdev::None);
        d.name_of = Some(Arc::new(move |i: &NameInfo| {
            s2.lock().unwrap().push(i.clone());
            if i.device_id.as_deref() == Some("0x4680") {
                Some("Intel UHD Graphics 770".into())
            } else {
                None
            }
        }));
        let list = d.list();
        assert_eq!(ids(&list), vec!["pci:0000:00:02.0", "cpu"]);
        assert_eq!(list[0]["name"], "Intel UHD Graphics 770");
        let s = seen.lock().unwrap();
        assert_eq!((s[0].pci.as_str(), s[0].vendor.as_str(), s[0].vendor_id.as_deref(), s[0].driver.as_deref()), ("0000:00:02.0", "intel", Some("0x8086"), Some("i915")));
    }

    #[test]
    fn nvidia_from_nvidia_smi_ordered_by_index_and_a_failing_one_lists_none() {
        let m = machine();
        std::fs::write(m.dev.join("dri/renderD129"), "").unwrap();
        let calls = Arc::new(Mutex::new(vec![]));
        let c2 = calls.clone();
        let run: Arc<dyn Runner> = Arc::new(Fake(Box::new(move |c, a, o| {
            c2.lock().unwrap().push((c.to_string(), a.to_vec(), o.timeout_ms));
            Ok(ProcResult { status: Some(0), stdout: "1, 00000000:02:00.0, NVIDIA GeForce RTX 3060\n0, 00000000:01:00.0, NVIDIA T400\nbad line\n".into(), ..Default::default() })
        })));
        let list = disc(&m, Some(run), Rdev::None).list();
        assert_eq!(list.iter().map(|d| json!([d["id"], d["kind"], d["index"], d["name"]])).collect::<Vec<_>>(), vec![
            json!(["pci:0000:03:00.0", "dri", null, "Intel GPU (0000:03:00.0)"]),
            json!(["pci:0000:01:00.0", "nvidia", 0, "NVIDIA T400"]),
            json!(["pci:0000:02:00.0", "nvidia", 1, "NVIDIA GeForce RTX 3060"]),
            json!(["cpu", "cpu", null, "CPU (software encoder)"]),
        ]);
        let c = calls.lock().unwrap();
        assert_eq!(c[0].0, "nvidia-smi");
        assert_eq!(c[0].1, vec!["--query-gpu=index,pci.bus_id,name", "--format=csv,noheader"]);
        assert_eq!(c[0].2, Some(10_000));
        assert_eq!(normalize_pci_slot("00000000:0A:00.0").as_deref(), Some("0000:0a:00.0"));
        assert_eq!(normalize_pci_slot("nonsense"), None);
        let failing: Arc<dyn Runner> = Arc::new(Fake(Box::new(|_, _, _| Ok(ProcResult { status: Some(9), stdout: "0, 00000000:01:00.0, NVIDIA T400\n".into(), stderr: "NVML".into(), ..Default::default() }))));
        assert_eq!(ids(&disc(&m, Some(failing), Rdev::None).list()), vec!["pci:0000:03:00.0", "cpu"]);
    }

    #[test]
    fn a_wedged_nvidia_smi_does_not_hold_the_list_and_no_second_one_starts() {
        let m = machine();
        std::fs::write(m.dev.join("dri/renderD129"), "").unwrap();
        let started = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let gate = Arc::new((Mutex::new(0usize), std::sync::Condvar::new()));
        let (s2, g2) = (started.clone(), gate.clone());
        let run: Arc<dyn Runner> = Arc::new(Fake(Box::new(move |_, _, _| {
            let n = s2.fetch_add(1, Ordering::SeqCst) + 1;
            let (lock, cv) = &*g2;
            let mut opened = lock.lock().unwrap();
            while *opened < n {
                opened = cv.wait(opened).unwrap();
            }
            Ok(if n == 1 { ProcResult { status: None, timed_out: true, ..Default::default() } } else { ProcResult { status: Some(0), stdout: "0, 00000000:01:00.0, NVIDIA T400\n".into(), ..Default::default() } })
        })));
        let mut d = disc(&m, Some(run), Rdev::None);
        d.nvidia_deadline_ms = 50;
        let begun = std::time::Instant::now();
        assert_eq!(ids(&d.list()), vec!["pci:0000:03:00.0", "cpu"]);
        assert!(begun.elapsed() < Duration::from_secs(2));
        assert_eq!(ids(&d.list()), vec!["pci:0000:03:00.0", "cpu"]);
        assert_eq!(started.load(Ordering::SeqCst), 1);
        // once it has gone, nvidia-smi is asked again
        {
            *gate.0.lock().unwrap() = 1;
            gate.1.notify_all();
        }
        while d.stuck.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(5));
        }
        {
            *gate.0.lock().unwrap() = 2;
            gate.1.notify_all();
        }
        d.nvidia_deadline_ms = 5_000;
        assert_eq!(ids(&d.list()), vec!["pci:0000:03:00.0", "pci:0000:01:00.0", "cpu"]);
        assert_eq!(started.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn other_systems_and_no_gpus_have_only_the_cpu() {
        let m = machine();
        let asked = Arc::new(AtomicBool::new(false));
        for platform in ["windows", "macos"] {
            let a2 = asked.clone();
            let mut d = Discovery::new(Some(Arc::new(Fake(Box::new(move |_, _, _| {
                a2.store(true, Ordering::SeqCst);
                Ok(ProcResult { status: Some(0), ..Default::default() })
            })))));
            d.platform = platform.into();
            assert_eq!(ids(&d.list()), vec!["cpu"]);
        }
        assert!(!asked.load(Ordering::SeqCst));
        let mut d = disc(&m, no_nvidia(), Rdev::Stat);
        d.dev_root = m.dev.join("nothing");
        assert_eq!(ids(&d.list()), vec!["cpu"]);
    }

    #[test]
    fn the_server_names_devices_as_its_stats_do() {
        let d = crate::converter::testutil::tempdir().unwrap();
        let amd = d.path().join("0000:0c:00.0");
        std::fs::create_dir_all(&amd).unwrap();
        std::fs::write(amd.join("product_name"), "AMD Radeon RX 7600\n").unwrap();
        let name_of = stats_name_of();
        let info = |vendor: &str, vid: &str, did: &str, drv: &str, sys: &Path| NameInfo { pci: "x".into(), vendor: vendor.into(), vendor_id: Some(vid.into()), device_id: Some(did.into()), driver: Some(drv.into()), sys_device: sys.to_string_lossy().to_string() };
        assert_eq!(name_of(&info("amd", "0x1002", "0x7480", "amdgpu", &amd)).as_deref(), Some("AMD Radeon RX 7600"));
    }
}
