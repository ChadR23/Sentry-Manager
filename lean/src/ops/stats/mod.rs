//! Server monitor ("nerd stats", server/stats/*). Samples the machine every
//! 2 s while a page is watching (touch) or something needs it (a conversion
//! or a benchmark: is_busy / mark_job), and runs no timers at all otherwise.
//! The app's once-a-minute housekeeping calls tick(), which reads the network
//! counters once a day. Everything comes from this machine's /proc and /sys
//! (plus nvidia-smi on an NVIDIA host); nothing leaves the server.
//!
//! What exists is probed once (and again every 10 minutes while sampling);
//! a sample is then a few dozen small reads. Reads that ask a device (disk
//! and GPU sensors) and the shares' answer times run in the background, so a
//! slow disk or a hung NAS never holds up the server. snapshot() is the
//! GET /api/stats body, built at sample time; it never touches the disk.

pub mod alerts;
pub mod cpu;
pub mod disks;
pub mod energy;
pub mod filesystems;
pub mod gpu;
pub mod history;
pub mod host;
pub mod network;
pub mod power;
pub mod procs;
pub mod sensors;
pub mod traffic;
pub mod util;

pub use history::{csv_name, js_round, round, History, SERIES};

use crate::ops::js::num as jnum;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::Duration;
use util::Clock;

pub const WATCH_MS: i64 = 15000;
const FIRST_FOLLOW_UP_MS: i64 = 500;
const MIN_GAP_MS: i64 = 250;
const SAVE_EVERY_MS: i64 = 5 * 60 * 1000;
const REPROBE_MS: i64 = 10 * 60 * 1000;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const TOP_PROCESSES: usize = 40;

/// "Shown only when the server provides it": what one optional compose line adds.
pub fn unlock(key: &str) -> Value {
    match key {
        "cpu-power" => json!({ "key": "cpu-power", "adds": "CPU power in watts and kWh (a read-only energy counter)", "compose": "- /sys/devices/virtual/powercap:/host/powercap:ro" }),
        _ => json!({ "key": "host-view", "adds": "Processes and network of the whole server, not only this container. It also lets this container see and signal the server's processes, so use it only with a PUID/PGID of its own (not your login user)", "compose": "pid: host" }),
    }
}

/// A log line: (level "info" | "warn" | "error", message).
pub type LogFn = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// A program the engine started (nvidia-smi); kill sends it SIGTERM.
pub trait Child: Send {
    fn kill(&mut self);
}

/// How the engine starts programs (std::process in the server, a fake in tests).
pub trait Launcher: Send + Sync {
    /// Starts `cmd args`: every stdout line goes to `on_line`, and `on_exit` is
    /// called once when it ends (Some(code) when it could not run: "ENOENT").
    /// Err(code): it could not be started. The callbacks run on another thread.
    fn spawn_lines(&self, cmd: &str, args: &[String], on_line: Box<dyn Fn(&str) + Send + Sync>, on_exit: Box<dyn FnOnce(Option<String>) + Send>) -> Result<Box<dyn Child>, String>;
    /// Runs a program to its end and answers what it printed (None: it failed or timed out).
    fn output(&self, cmd: &str, args: &[&str], timeout: Duration) -> Option<String>;
}

/// setTimeout / clearTimeout.
pub trait Timers: Send + Sync {
    fn set_timeout(&self, ms: i64, f: Box<dyn FnOnce() + Send>) -> u64;
    fn clear_timeout(&self, id: u64);
}

/// Real timers: a thread per timer, woken at once when it is cleared.
#[derive(Default)]
pub struct RealTimers {
    live: Arc<(Mutex<HashSet<u64>>, Condvar)>,
    next: AtomicU64,
}

impl Timers for RealTimers {
    fn set_timeout(&self, ms: i64, f: Box<dyn FnOnce() + Send>) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.live.0.lock().unwrap().insert(id);
        let live = self.live.clone();
        std::thread::spawn(move || {
            let (lock, cv) = &*live;
            let deadline = std::time::Instant::now() + Duration::from_millis(ms.max(0) as u64);
            let mut set = lock.lock().unwrap();
            loop {
                if !set.contains(&id) {
                    return;
                }
                let now = std::time::Instant::now();
                if now >= deadline {
                    break;
                }
                set = cv.wait_timeout(set, deadline - now).unwrap().0;
            }
            set.remove(&id);
            drop(set);
            f();
        });
        id
    }
    fn clear_timeout(&self, id: u64) {
        let (lock, cv) = &*self.live;
        lock.lock().unwrap().remove(&id);
        cv.notify_all();
    }
}

/// Programs started with std::process; kill sends SIGTERM to that child only.
pub struct RealLauncher;

struct RealChild(u32);

impl Child for RealChild {
    fn kill(&mut self) {
        // our own child, by its pid
        unsafe {
            libc::kill(self.0 as i32, libc::SIGTERM);
        }
    }
}

impl Launcher for RealLauncher {
    fn spawn_lines(&self, cmd: &str, args: &[String], on_line: Box<dyn Fn(&str) + Send + Sync>, on_exit: Box<dyn FnOnce(Option<String>) + Send>) -> Result<Box<dyn Child>, String> {
        let mut child = std::process::Command::new(cmd)
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "ENOENT".to_string() } else { crate::ops::sys::errno_code(&e) })?;
        let pid = child.id();
        let out = child.stdout.take();
        std::thread::spawn(move || {
            if let Some(out) = out {
                let mut r = std::io::BufReader::new(out);
                let mut buf = Vec::new();
                loop {
                    buf.clear();
                    match r.read_until(b'\n', &mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            if buf.len() <= 65536 && buf.ends_with(b"\n") {
                                on_line(String::from_utf8_lossy(&buf[..buf.len() - 1]).as_ref());
                            }
                        }
                    }
                }
            }
            let _ = child.wait();
            on_exit(None);
        });
        Ok(Box::new(RealChild(pid)))
    }

    fn output(&self, cmd: &str, args: &[&str], timeout: Duration) -> Option<String> {
        use std::io::Read;
        let mut child = std::process::Command::new(cmd).args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).spawn().ok()?;
        let mut out = child.stdout.take()?;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = out.by_ref().take(1 << 20).read_to_end(&mut b);
            let _ = tx.send(b);
        });
        match rx.recv_timeout(timeout) {
            Ok(b) => {
                let _ = child.wait();
                Some(String::from_utf8_lossy(&b).into_owned())
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                None
            }
        }
    }
}

/// One ffmpeg the converter runs (to name processes and GPU clients).
#[derive(Clone, Debug)]
pub struct ActiveEncode {
    pub pid: i64,
    pub encoder: Option<String>,
}

/// What the engine needs to know and to say (index.js createStats options).
pub struct StatsOptions {
    pub proc_root: PathBuf,
    pub sys_root: PathBuf,
    pub dev_root: PathBuf,
    pub data_dir: Option<PathBuf>,
    pub app_pid: i64,
    pub now: Clock,
    pub interval_ms: i64,
    /// a conversion or benchmark runs (keeps sampling without a page)
    pub is_busy: Arc<dyn Fn() -> bool + Send + Sync>,
    pub launcher: Arc<dyn Launcher>,
    pub timers: Arc<dyn Timers>,
    pub read_shares: filesystems::ReadShares,
    pub share_fs: Arc<dyn filesystems::ShareFs>,
    pub active_encodes: Arc<dyn Fn() -> Vec<ActiveEncode> + Send + Sync>,
    /// the price per kWh in force at t
    pub price_at: Arc<dyn Fn(i64) -> Option<f64> + Send + Sync>,
    /// where a conversion job stands ({ clips, savedB }), asked at each sample while its energy is counted
    pub job_progress: Arc<dyn Fn(&str) -> Option<(f64, f64)> + Send + Sync>,
    pub log: LogFn,
    /// (key, level, message)
    pub on_alert: Option<alerts::OnAlert>,
    pub on_alert_clear: Option<alerts::OnClear>,
    pub on_sampling: Option<Arc<dyn Fn(bool) + Send + Sync>>,
    pub version: Value,
    /// Some: ffmpeg's version is known (tests), so it is not asked
    pub ffmpeg_version: Option<Option<String>>,
    pub ffmpeg_path: String,
    pub pci_ids_files: Vec<PathBuf>,
    pub find_bin: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    /// how background reads read a file
    pub read_file: Option<util::ReadFile>,
}

impl StatsOptions {
    /// The server's engine: this machine's /proc, /sys and /dev, real programs and timers.
    pub fn server(data_dir: Option<PathBuf>, version: Value) -> StatsOptions {
        StatsOptions {
            proc_root: "/proc".into(),
            sys_root: "/sys".into(),
            dev_root: "/dev".into(),
            data_dir,
            app_pid: std::process::id() as i64,
            now: util::system_clock(),
            interval_ms: 2000,
            is_busy: Arc::new(|| false),
            launcher: Arc::new(RealLauncher),
            timers: Arc::new(RealTimers::default()),
            read_shares: Arc::new(Vec::new),
            share_fs: Arc::new(filesystems::RealFs),
            active_encodes: Arc::new(Vec::new),
            price_at: Arc::new(|_| None),
            job_progress: Arc::new(|_| None),
            log: Arc::new(|level, m| eprintln!("{} [stats] {m}", if level == "info" { "INFO " } else if level == "error" { "ERROR" } else { "WARN " })),
            on_alert: None,
            on_alert_clear: None,
            on_sampling: None,
            version,
            ffmpeg_version: None,
            ffmpeg_path: std::env::var("FFMPEG_PATH").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "ffmpeg".into()),
            pci_ids_files: gpu::PCI_IDS.iter().map(PathBuf::from).collect(),
            find_bin: Arc::new(gpu::on_path),
            read_file: None,
        }
    }
}

struct Engine {
    reads: Arc<util::BackgroundReads>,
    procs: procs::ProcessTable,
    cpu: cpu::CpuProvider,
    sensors: sensors::SensorsProvider,
    disks: disks::DisksProvider,
    network: network::NetworkProvider,
    gpu: gpu::GpuProvider,
    power: power::PowerProvider,
    filesystems: filesystems::FilesystemsProvider,
    host: host::HostInfo,
    history: History,
    energy: energy::Energy,
    traffic: traffic::Traffic,
    alerts: alerts::Alerts,
    sampling: bool,
    stopped: bool,
    timer: Option<u64>,
    watch_until: Option<i64>,
    sampling_since: Option<i64>,
    probed_at: Option<i64>,
    last_save: i64,
    dirty: bool,
    ticked_day: Option<String>,
    ffmpeg: Value,
    ffmpeg_asked: bool,
    warned: HashSet<String>,
    last_sample_at: Option<i64>,
}

/// The stats engine (one per server).
pub struct Stats {
    o: StatsOptions,
    file: Option<PathBuf>,
    e: Mutex<Engine>,
    body: Mutex<Value>,
    me: Weak<Stats>,
}

fn skeleton(interval_ms: i64, version: &Value, ffmpeg: &Value) -> Value {
    json!({
        "at": null, "intervalMs": interval_ms,
        "host": { "hostname": null, "os": null, "kernel": null, "arch": null, "uptimeS": null, "appUptimeS": null, "version": version, "node": null, "ffmpeg": ffmpeg },
        "cpu": { "model": null, "cores": null, "threads": null, "usage": null, "perCore": [], "freqMHz": null, "tempC": null, "load": null, "app": { "usage": null, "ffmpegUsage": null, "ffmpegCount": null }, "throttling": false, "sockets": 1, "perSocket": null },
        "memory": { "totalB": null, "usedB": null, "availableB": null, "cacheB": null, "swapTotalB": null, "swapUsedB": null, "appB": null },
        "gpus": [],
        "power": { "totalW": null, "cpuW": null, "gpuW": null, "chipW": null, "discreteW": null, "todayWh": null, "weekWh": null, "todayCost": null, "weekCost": null, "priceNow": null, "cpuSource": null, "gpuSource": null, "cpuUnavailable": null, "peakW": null },
        "disks": [],
        "filesystems": [],
        "network": { "scope": "container", "interfaces": [], "today": null, "week": null, "month": null },
        "sensors": [],
        "processes": { "scope": "container", "top": [] },
        "alerts": [],
        "unlock": [],
        "sparks": { "cpu": [], "gpuVideo": [], "gpuBusy": [], "rxBps": [], "txBps": [] }
    })
}

fn n(x: Option<f64>) -> Value {
    x.map_or(Value::Null, jnum)
}

impl Stats {
    pub fn new(o: StatsOptions) -> Arc<Stats> {
        let now = (o.now)();
        let reads = util::BackgroundReads::new(o.now.clone(), o.read_file.clone(), 4);
        let jp = o.job_progress.clone();
        let nvidia = gpu::NvidiaSmi::new(o.launcher.clone(), o.timers.clone(), o.now.clone(), o.interval_ms.max(100), o.log.clone());
        let interval_ms = o.interval_ms.max(100);
        let alerts = alerts::Alerts::new(None, None);
        let ffmpeg = o.ffmpeg_version.clone().map_or(Value::Null, |v| json!(v));
        let e = Engine {
            procs: procs::ProcessTable::new(&o.proc_root, o.app_pid),
            cpu: cpu::CpuProvider::new(&o.proc_root, &o.sys_root, o.now.clone()),
            sensors: sensors::SensorsProvider::new(&o.sys_root, reads.clone()),
            disks: disks::DisksProvider::new(&o.proc_root, &o.sys_root, o.now.clone()),
            network: network::NetworkProvider::new(&o.proc_root, &o.sys_root, o.now.clone()),
            gpu: gpu::GpuProvider::new(gpu::GpuOptions { proc_root: o.proc_root.clone(), sys_root: o.sys_root.clone(), dev_root: o.dev_root.clone(), pci_ids_files: o.pci_ids_files.clone(), find_bin: o.find_bin.clone() }, reads.clone(), nvidia),
            power: power::PowerProvider::new(&o.sys_root, interval_ms),
            filesystems: filesystems::FilesystemsProvider::new(&o.proc_root, &o.sys_root, o.app_pid, o.read_shares.clone(), o.share_fs.clone(), o.now.clone()),
            host: host::HostInfo::new(&o.proc_root, o.version.clone()),
            history: History::new(interval_ms),
            energy: energy::Energy::new(interval_ms, Some(Box::new(move |id| jp(id)))),
            traffic: traffic::Traffic::new(),
            alerts,
            reads,
            sampling: false,
            stopped: false,
            timer: None,
            watch_until: None,
            sampling_since: None,
            probed_at: None,
            last_save: now,
            dirty: false,
            ticked_day: None,
            ffmpeg_asked: o.ffmpeg_version.is_some(),
            ffmpeg: ffmpeg.clone(),
            warned: HashSet::new(),
            last_sample_at: None,
        };
        let mut o = o;
        o.interval_ms = interval_ms;
        let on_alert = o.on_alert.take();
        let on_clear = o.on_alert_clear.take();
        let file = o.data_dir.as_ref().map(|d| d.join("stats-history.json"));
        let body = skeleton(interval_ms, &o.version, &ffmpeg);
        let s = Arc::new_cyclic(|me| Stats { o, file, e: Mutex::new(e), body: Mutex::new(body), me: me.clone() });
        {
            let mut e = s.e.lock().unwrap();
            e.alerts = alerts::Alerts::new(on_alert, on_clear);
            s.load(&mut e);
        }
        s
    }

    fn warn_once(&self, e: &mut Engine, key: &str, message: &str) {
        if e.warned.insert(key.to_string()) {
            (self.o.log)("warn", message);
        }
    }

    fn now(&self) -> i64 {
        (self.o.now)()
    }

    // ---- saved history (graphs, energy and data used survive a restart)
    fn load(&self, e: &mut Engine) {
        let Some(file) = &self.file else { return };
        let r: Result<Option<Value>, String> = (|| {
            let m = std::fs::metadata(file).map_err(|err| if err.kind() == std::io::ErrorKind::NotFound { String::new() } else { err.to_string() })?;
            if m.len() > MAX_FILE_BYTES {
                return Err("file too large".into());
            }
            let text = std::fs::read_to_string(file).map_err(|err| err.to_string())?;
            serde_json::from_str::<Value>(&text).map(Some).map_err(|err| err.to_string())
        })();
        match r {
            Ok(Some(d)) if d.get("v") == Some(&json!(1)) => {
                let t = self.now();
                e.history.load(&d["history"], t);
                e.energy.load(&d["energy"]);
                e.traffic.load(&d["traffic"]);
                e.filesystems.load(&d["shares"]);
            }
            Ok(_) => {}
            Err(m) if m.is_empty() => {}
            Err(m) => self.warn_once(e, "load", &format!("Server stats: could not read {} ({m}); starting a new history.", file.display())),
        }
    }

    fn save(&self, e: &mut Engine) {
        let Some(file) = &self.file else { return };
        let tmp = PathBuf::from(format!("{}.{}.tmp", file.display(), std::process::id()));
        let body = json!({ "v": 1, "savedAt": self.now(), "history": e.history.to_json(), "energy": e.energy.to_json(), "traffic": e.traffic.to_json(), "shares": e.filesystems.to_json() });
        let r = (|| -> std::io::Result<()> {
            if let Some(d) = file.parent() {
                std::fs::create_dir_all(d)?;
            }
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
            f.write_all(body.to_string().as_bytes())?;
            std::fs::rename(&tmp, file)
        })();
        match r {
            Ok(()) => e.dirty = false,
            Err(err) => {
                let _ = std::fs::remove_file(&tmp);
                self.warn_once(e, "save", &format!("Server stats: could not save {}: {err}", file.display()));
            }
        }
        e.last_save = self.now();
    }

    // ---- sampling
    fn probe(&self, e: &mut Engine, t: i64) {
        // sensors first: disks and GPUs look up their own sensor chips
        e.sensors.probe();
        e.cpu.probe();
        e.procs.probe();
        e.disks.probe();
        e.network.probe();
        let Engine { gpu, sensors, .. } = e;
        gpu.probe(sensors);
        e.power.probe();
        e.host.probe();
        if let Some(p) = e.probed_at {
            e.reads.prune(p);
        }
        e.probed_at = Some(t);
    }

    fn app_usage(e: &Engine) -> Value {
        let p = &e.procs;
        if p.get(p.app_pid).is_none() {
            return json!({ "usage": null, "ffmpegUsage": null, "ffmpegCount": null });
        }
        let members: Vec<&procs::Proc> = p.app.iter().filter_map(|pid| p.get(*pid)).collect();
        let ff: Vec<&&procs::Proc> = members.iter().filter(|m| m.comm.starts_with("ffmpeg")).collect();
        let known = members.iter().any(|m| m.cpu.is_some());
        let r = &p.reaped;
        json!({
            "usage": if known { n(round(Some(util::sum_of(members.iter().map(|m| m.cpu)).unwrap_or(0.0) + r.cpu.unwrap_or(0.0)), 1)) } else { Value::Null },
            "ffmpegUsage": if known { n(round(Some(util::sum_of(ff.iter().map(|m| m.cpu)).unwrap_or(0.0) + r.ffmpeg_cpu.unwrap_or(0.0)), 1)) } else { Value::Null },
            "ffmpegCount": ff.len()
        })
    }

    fn top_processes(e: &Engine, encoders: &HashMap<i64, ActiveEncode>) -> Vec<Value> {
        let p = &e.procs;
        let mut shown: Vec<&procs::Proc> = p.list.iter().filter(|x| x.state != "Z" && x.pid != 2 && x.ppid != 2 && (x.rss_pages > 0.0 || p.app_set.contains(&x.pid))).collect();
        shown.sort_by(|a, b| {
            let c = b.cpu.unwrap_or(0.0) - a.cpu.unwrap_or(0.0);
            let c = if c == 0.0 { b.mem_b - a.mem_b } else { c };
            c.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
        });
        shown
            .into_iter()
            .take(TOP_PROCESSES)
            .map(|x| {
                let name = if x.pid == p.app_pid {
                    "sentry-six-manager".to_string()
                } else if let Some(enc) = encoders.get(&x.pid).and_then(|e| e.encoder.clone()).filter(|s| !s.is_empty()) {
                    format!("{} · {enc}", x.comm)
                } else {
                    x.comm.clone()
                };
                json!({ "pid": x.pid, "name": name, "cpu": n(round(x.cpu, 1)), "memB": jnum(x.mem_b), "gpuVideo": if p.app_set.contains(&x.pid) { n(e.gpu.video_of(x.pid)) } else { Value::Null } })
            })
            .collect()
    }

    /// Two or more sockets: each one's use, with its own temperature and package power.
    fn per_socket(e: &Engine, list: Option<&Vec<cpu::SocketUse>>) -> Value {
        let Some(list) = list.filter(|l| l.len() >= 2) else { return Value::Null };
        let ids: Vec<i64> = list.iter().map(|s| s.socket).collect();
        let temps = e.sensors.socket_temps(&ids);
        let watts = e.power.socket_watts();
        json!(list
            .iter()
            .enumerate()
            .map(|(i, s)| json!({ "socket": s.socket, "cores": s.cores, "threads": s.threads, "usage": n(s.usage), "tempC": n(temps.get(i).copied().flatten()), "powerW": n(round(watts.get(&s.socket).copied(), 1)) }))
            .collect::<Vec<_>>())
    }

    fn unlock_hints(&self, e: &Engine, t: i64, cpu_w: Option<f64>) -> Vec<Value> {
        let mut out = Vec::new();
        let wsl = e.host.static_.as_ref().is_some_and(|s| s.wsl);
        // give the supervisor a few seconds to send its first RAPL reading; a VM has no counters to bind
        if e.cpu.info.x86 && !e.cpu.info.virtual_ && !wsl && cpu_w.is_none() && !e.power.has_rapl(t) && e.sampling_since.is_some_and(|s| t - s >= 3 * self.o.interval_ms) {
            out.push(unlock("cpu-power"));
        }
        if e.procs.scope != "host" {
            out.push(unlock("host-view"));
        }
        out
    }

    fn sample_once(&self, e: &mut Engine) -> Value {
        let t = self.now();
        // two samples a moment apart would turn rounding noise into numbers
        if let Some(last) = e.last_sample_at {
            if t >= last && t - last < MIN_GAP_MS {
                return self.body.lock().unwrap().clone();
            }
        }
        e.last_sample_at = Some(t);
        // (the background reads answer between samples, never in the middle of one)
        let reads = e.reads.clone();
        let _gate = reads.hold();
        if e.probed_at.is_none_or(|p| t - p >= REPROBE_MS) {
            self.probe(e, t);
        }
        let c = e.cpu.sample();
        e.procs.sample(c.total_ticks);
        let encoders: HashMap<i64, ActiveEncode> = (self.o.active_encodes)().into_iter().map(|x| (x.pid, x)).collect();
        // the whole server's memory, and the resident size of the app and its children
        let mut memory = host::read_memory(&self.o.proc_root);
        memory.app_b = util::sum_of(e.procs.app.iter().map(|pid| e.procs.get(*pid).map(|p| p.mem_b)));
        let Engine { gpu, procs, .. } = e;
        let mut gpus = gpu.sample(t, Some(procs));
        let gp: Vec<power::GpuPower> = gpus.iter().map(|g| power::GpuPower { power_w: g["powerW"].as_f64(), integrated: g["integrated"].as_bool() == Some(true), source: g["powerSource"].as_str().map(str::to_string) }).collect();
        let pw = e.power.sample(t, &gp);
        // costs are summed at the price of each moment (time-of-use plans)
        let price_now = (self.o.price_at)(t).filter(|p| p.is_finite() && *p >= 0.0);
        e.energy.add(t, pw.total_w, price_now);
        let es = e.energy.summary(t);
        let Engine { disks, sensors, .. } = e;
        let disk_list = disks.sample(sensors);
        let (scope, interfaces, rx_sum, tx_sum) = e.network.sample();
        // data used: the same counters, per day
        let where_ = e.network.where_();
        let counters = e.network.counters.clone();
        let read_at = e.network.read_at;
        {
            let Engine { traffic, network, .. } = e;
            traffic.add(read_at, counters.as_deref(), &where_, &|name| network.ifindex(name));
        }
        let (today, week, month) = e.traffic.summary(t);
        let fs_list = e.filesystems.sample(t);
        let (sensor_list, cpu_temp) = e.sensors.sample();
        let wsl = e.host.static_.as_ref().is_some_and(|s| s.wsl);
        let host_v = e.host.info(e.procs.uptime, e.procs.app_start_s(), &e.ffmpeg);
        for g in &mut gpus {
            if let Some(o) = g.as_object_mut() {
                o.remove("powerSource");
            }
        }
        let mut power_v = Map::new();
        for (k, v) in pw.fields() {
            power_v.insert(k.into(), v);
        }
        power_v.insert("cpuUnavailable".into(), json!(power::cpu_unavailable(pw.cpu_w, wsl, e.cpu.info.virtual_)));
        for k in ["todayWh", "weekWh", "todayCost", "weekCost"] {
            power_v.insert(k.into(), es[k].clone());
        }
        power_v.insert("priceNow".into(), n(price_now));
        power_v.insert("peakW".into(), es["peakW"].clone());
        let mut next = json!({
            "at": t, "intervalMs": self.o.interval_ms,
            "host": host_v,
            "cpu": {
                "model": c.model.clone().or_else(|| e.cpu.info.model.clone()), "cores": c.cores, "threads": c.threads,
                "usage": n(c.usage), "perCore": c.per_core.iter().map(|x| n(*x)).collect::<Vec<_>>(), "freqMHz": n(c.freq_mhz), "tempC": n(cpu_temp),
                "load": c.load.as_ref().map(|l| l.iter().map(|x| jnum(*x)).collect::<Vec<_>>()), "app": Self::app_usage(e), "throttling": c.throttling,
                "sockets": c.sockets, "perSocket": Self::per_socket(e, c.per_socket.as_ref())
            },
            "memory": memory.to_json(),
            "gpus": gpus,
            "power": power_v,
            "disks": disk_list,
            "filesystems": fs_list,
            "network": { "scope": scope, "interfaces": interfaces, "today": today, "week": week, "month": month },
            "sensors": sensor_list,
            "processes": { "scope": e.procs.scope, "top": Self::top_processes(e, &encoders) },
            "alerts": [],
            "unlock": [],
            "sparks": { "cpu": [], "gpuVideo": [], "gpuBusy": [], "rxBps": [], "txBps": [] }
        });
        let mem_pct = match (memory.total_b, memory.used_b) {
            (Some(tot), Some(u)) if tot != 0.0 => Some(u / tot * 100.0),
            _ => None,
        };
        let g = next["gpus"].as_array().cloned().unwrap_or_default();
        let f = |v: &Value, k: &str| v[k].as_f64();
        let values = [
            c.usage,
            mem_pct,
            util::max_of(g.iter().map(|x| f(x, "busy"))),
            util::max_of(g.iter().map(|x| f(x, "video"))),
            pw.total_w,
            rx_sum,
            tx_sum,
            util::max_of(std::iter::once(cpu_temp).chain(g.iter().map(|x| f(x, "tempC"))).chain(next["disks"].as_array().into_iter().flatten().map(|d| f(d, "tempC")))),
        ];
        e.history.add(t, &values);
        let alerts = e.alerts.evaluate(t, &next);
        next["alerts"] = json!(alerts);
        next["unlock"] = json!(self.unlock_hints(e, t, pw.cpu_w));
        next["sparks"] = e.history.sparks(t);
        *self.body.lock().unwrap() = next.clone();
        e.dirty = true;
        if t - e.last_save >= SAVE_EVERY_MS {
            self.save(e);
        }
        next
    }

    fn busy(&self) -> bool {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.o.is_busy)())).unwrap_or(false)
    }

    fn wanted(&self, e: &Engine, t: i64) -> bool {
        e.watch_until.is_some_and(|w| t < w) || self.busy() || e.energy.active()
    }

    fn schedule(&self, e: &mut Engine, ms: i64) {
        let me = self.me.clone();
        e.timer = Some(self.o.timers.set_timeout(
            ms,
            Box::new(move || {
                if let Some(me) = me.upgrade() {
                    me.tick_sample();
                }
            }),
        ));
    }

    fn tick_sample(&self) {
        let mut e = self.e.lock().unwrap();
        e.timer = None;
        if !e.sampling {
            return;
        }
        if !self.wanted(&e, self.now()) {
            self.go_idle(&mut e);
            return;
        }
        // keep a steady cadence: the time a sample takes comes off the wait
        let began = self.now();
        self.sample_once(&mut e);
        let took = self.now() - began;
        let iv = self.o.interval_ms;
        let wait = if took > 0 { (js_round(iv as f64 / 2.0) as i64).max(iv - took) } else { iv };
        self.schedule(&mut e, wait);
    }

    fn ask_ffmpeg(&self, e: &mut Engine) {
        if e.ffmpeg_asked {
            return;
        }
        e.ffmpeg_asked = true;
        let (launcher, path, me) = (self.o.launcher.clone(), self.o.ffmpeg_path.clone(), self.me.clone());
        std::thread::spawn(move || {
            let v = launcher.output(&path, &["-hide_banner", "-version"], Duration::from_secs(10)).and_then(|out| host::parse_ffmpeg_version(&out.chars().take(4096).collect::<String>()));
            if let Some(me) = me.upgrade() {
                me.e.lock().unwrap().ffmpeg = json!(v);
                let mut b = me.body.lock().unwrap();
                if b["host"].is_object() {
                    b["host"]["ffmpeg"] = json!(v);
                }
            }
        });
    }

    fn start(&self, e: &mut Engine) {
        if e.stopped || e.sampling {
            return;
        }
        e.sampling = true;
        let t = self.now();
        e.sampling_since = Some(t);
        if e.probed_at.is_none() {
            self.probe(e, t);
        }
        if let Some(f) = &self.o.on_sampling {
            f(true);
        }
        e.gpu.start_streams();
        self.ask_ffmpeg(e);
        self.sample_once(e);
        if e.sampling {
            self.schedule(e, FIRST_FOLLOW_UP_MS.min(self.o.interval_ms));
        }
    }

    fn go_idle(&self, e: &mut Engine) {
        e.sampling = false;
        e.sampling_since = None;
        if let Some(id) = e.timer.take() {
            self.o.timers.clear_timeout(id);
        }
        e.gpu.stop_streams();
        // a sample after a long idle stretch is a fresh start, not a stall
        e.disks.reset_baseline();
        if e.dirty {
            self.save(e);
        }
        if let Some(f) = &self.o.on_sampling {
            f(false);
        }
    }

    /// The GET /api/stats body (from the last sample; never waits for I/O).
    pub fn snapshot(&self) -> Value {
        self.body.lock().unwrap().clone()
    }

    /// A page is watching: sample for the next 15 s (or hold_ms, up to 2 minutes).
    pub fn touch(&self, hold_ms: Option<i64>) {
        let mut e = self.e.lock().unwrap();
        if e.stopped {
            return;
        }
        let hold = hold_ms.filter(|h| *h != 0).unwrap_or(WATCH_MS).clamp(WATCH_MS, 120_000);
        e.watch_until = Some(e.watch_until.unwrap_or(0).max(self.now() + hold));
        self.start(&mut e);
    }

    /// A node's total W read at t while `encoding`: its share of the running job's energy.
    pub fn node_power(&self, node: &str, t: i64, w: Option<f64>, encoding: bool) {
        let price = (self.o.price_at)(t).filter(|p| p.is_finite() && *p >= 0.0);
        let mut e = self.e.lock().unwrap();
        e.energy.add_node(node, t, w, encoding, price);
        e.dirty = true;
    }

    /// The highest W seen for 'all' or 'node:<id>', after noting w (the reading now) for it.
    pub fn peak(&self, key: &str, w: Option<f64>) -> Option<f64> {
        let t = self.now();
        let mut e = self.e.lock().unwrap();
        let before = e.energy.peak(key);
        e.energy.note_peak(key, w, t as f64);
        let after = e.energy.peak(key);
        if after != before {
            e.dirty = true;
        }
        after
    }

    pub fn history(&self, day: bool) -> Value {
        self.e.lock().unwrap().history.range(day, self.now())
    }

    pub fn csv(&self, day: bool) -> String {
        self.e.lock().unwrap().history.csv(day, self.now())
    }

    /// { todayWh, weekWh, todayCost, weekCost, byJob, peakW }
    pub fn energy(&self) -> Value {
        self.e.lock().unwrap().energy.summary(self.now())
    }

    /// Data used: { today, week, month }.
    pub fn traffic(&self) -> Value {
        let (a, b, c) = self.e.lock().unwrap().traffic.summary(self.now());
        json!({ "today": a, "week": b, "month": c })
    }

    /// Called once a minute by the app's housekeeping: on the first call of a
    /// day, while nothing samples, the network counters are read once and saved.
    pub fn tick(&self) {
        let mut e = self.e.lock().unwrap();
        if e.stopped || e.sampling {
            return;
        }
        let t = self.now();
        let day = energy::day_key(t);
        if e.ticked_day.as_deref() == Some(day.as_str()) {
            return;
        }
        e.ticked_day = Some(day.clone());
        // a sample read them today already
        if e.network.read_at.is_some_and(|r| energy::day_key(r) == day) {
            return;
        }
        if e.probed_at.is_none() {
            e.network.probe();
        }
        e.network.read();
        let Some(counters) = e.network.counters.clone() else { return };
        let where_ = e.network.where_();
        let read_at = e.network.read_at;
        {
            let Engine { traffic, network, .. } = &mut *e;
            traffic.add(read_at, Some(&counters), &where_, &|name| network.ifindex(name));
        }
        e.dirty = true;
        self.save(&mut e);
    }

    /// Energy from now on also counts for this job (None: no job). A job keeps sampling running.
    pub fn mark_job(&self, job: Option<&str>) {
        let mut e = self.e.lock().unwrap();
        e.energy.mark_job(job);
        e.dirty = true;
        if job.is_some() {
            self.start(&mut e);
        }
    }

    /// The supervisor's RAPL reading (`rapl-reading`): { at, packages: [{ name, energyUj, maxEnergyUj }] }.
    pub fn set_rapl(&self, reading: &Value) {
        self.e.lock().unwrap().power.set_rapl(reading);
    }

    pub fn sampling(&self) -> bool {
        self.e.lock().unwrap().sampling
    }

    /// Take one sample now (tests; probes first if needed).
    pub fn sample_now(&self) -> Value {
        let mut e = self.e.lock().unwrap();
        if e.probed_at.is_none() {
            let t = self.now();
            self.probe(&mut e, t);
        }
        self.sample_once(&mut e)
    }

    /// Returns when no background read or share check is in flight (tests; at most 2 s).
    pub fn settle(&self) {
        let reads = self.e.lock().unwrap().reads.clone();
        reads.wait_idle(Duration::from_secs(2));
        let e = self.e.lock().unwrap();
        e.filesystems.wait_idle(Duration::from_millis(200));
    }

    pub fn stop(&self) {
        let mut e = self.e.lock().unwrap();
        e.stopped = true;
        if e.sampling {
            self.go_idle(&mut e);
        } else {
            e.gpu.stop_streams();
            if e.dirty {
                self.save(&mut e);
            }
        }
    }

    /// Whether nvidia-smi runs now (tests).
    pub fn nvidia_running(&self) -> bool {
        self.e.lock().unwrap().gpu.nvidia.running()
    }
}

/// Where the stats engine finds this server's own data folder's path (for the
/// "Data volume" share) and the vehicles' shares, as index.js readShares.
pub fn shares_of(data: &Path, vehicles: &[crate::ops::ctx::VehicleInfo]) -> Vec<filesystems::ShareSpec> {
    let mut out = vec![filesystems::ShareSpec { label: "Data volume".into(), path: data.to_string_lossy().into_owned(), vehicle: false, network: false }];
    for v in vehicles {
        out.push(filesystems::ShareSpec { label: v.name.clone(), path: v.roots.first().cloned().unwrap_or_default(), vehicle: true, network: v.source_type.as_deref() == Some("smb") });
    }
    out
}

#[cfg(test)]
mod tests;
