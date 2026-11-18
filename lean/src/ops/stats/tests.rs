//! The engine on fake machines. `testdata/*.json` are recorded from the Node
//! engine by lean/parity/opsStats.js (test/fixtures/stats/machines.js: an
//! Intel desktop with an Arc, an AMD desktop, NVIDIA, a Raspberry Pi, a
//! locked-down container, a dual Xeon, a VM, WSL, Unraid's bridge, a NAS that
//! hangs, a share that comes back, RAPL from the supervisor with a price and
//! a job): the same trees, phase by phase, on the same clock, must give the
//! same GET /api/stats body, field for field. Also ports of
//! test/statsLifecycle.test.js, test/stats.test.js (garbage, this machine)
//! and test/statsTraffic.test.js (tick).

use super::filesystems::{ShareFs, ShareSpec, Statfs};
use super::*;
use std::sync::atomic::{AtomicI64, AtomicUsize};
use std::sync::mpsc;

pub struct FakeClock(pub Arc<AtomicI64>);

impl FakeClock {
    pub fn new(t: i64) -> FakeClock {
        FakeClock(Arc::new(AtomicI64::new(t)))
    }
    pub fn clock(&self) -> Clock {
        let c = self.0.clone();
        Arc::new(move || c.load(Ordering::SeqCst))
    }
    pub fn t(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
    pub fn set(&self, t: i64) {
        self.0.store(t, Ordering::SeqCst)
    }
    pub fn advance(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

/// helpers.js fakeFs: a share answers stat after `delayMs` on the test clock, fails, or never answers.
pub struct FakeShares {
    pub shares: Mutex<Value>,
    pub clock: Arc<AtomicI64>,
    pub hung: Mutex<Vec<mpsc::Sender<Result<(), String>>>>,
    pub stat_calls: Mutex<Vec<String>>,
}

impl ShareFs for FakeShares {
    fn stat(&self, p: &str) -> mpsc::Receiver<Result<(), String>> {
        self.stat_calls.lock().unwrap().push(p.to_string());
        let (tx, rx) = mpsc::channel();
        let s = self.shares.lock().unwrap()[p].clone();
        if s.is_null() {
            let _ = tx.send(Err("ENOENT".into()));
        } else if s["hung"] == json!(true) {
            self.hung.lock().unwrap().push(tx);
        } else if let Some(e) = s["error"].as_str() {
            let _ = tx.send(Err(e.to_string()));
        } else {
            self.clock.fetch_add(s["delayMs"].as_i64().unwrap_or(0), Ordering::SeqCst);
            let _ = tx.send(Ok(()));
        }
        rx
    }
    fn statfs(&self, p: &str) -> Option<Statfs> {
        let s = self.shares.lock().unwrap()[p].clone();
        let f = |k: &str| s[k].as_f64().unwrap_or(f64::NAN);
        Some(Statfs { bsize: 4096.0, blocks: f("blocks"), bfree: f("bfree"), bavail: s["bavail"].as_f64().unwrap_or(f("bfree")) })
    }
}

/// helpers.js fakeSpawn: nvidia-smi prints its lines once per start; every start is recorded.
#[derive(Default)]
pub struct FakeLauncher {
    pub lines: Vec<String>,
    pub calls: Mutex<Vec<(String, Vec<String>)>>,
    pub killed: Arc<Mutex<Vec<bool>>>,
    /// nvidia-smi ends after printing (with this many starts failing as missing)
    pub exit_after_lines: bool,
    pub missing: bool,
    /// what a start prints waits for print(), instead of coming from a thread a moment later
    pub held: bool,
    unprinted: Mutex<Vec<Unprinted>>,
}

type Unprinted = (Vec<String>, Box<dyn Fn(&str) + Send + Sync>, Option<Box<dyn FnOnce(Option<String>) + Send>>);

impl FakeLauncher {
    /// Every held start prints its lines (and ends) now, on this thread.
    pub fn print(&self) {
        let unprinted = std::mem::take(&mut *self.unprinted.lock().unwrap());
        for (lines, on_line, on_exit) in unprinted {
            for l in &lines {
                on_line(l);
            }
            if let Some(f) = on_exit {
                f(None);
            }
        }
    }
}

struct FakeChild(usize, Arc<Mutex<Vec<bool>>>);

impl Child for FakeChild {
    fn kill(&mut self) {
        self.1.lock().unwrap()[self.0] = true;
    }
}

impl Launcher for FakeLauncher {
    fn spawn_lines(&self, cmd: &str, args: &[String], on_line: Box<dyn Fn(&str) + Send + Sync>, on_exit: Box<dyn FnOnce(Option<String>) + Send>) -> Result<Box<dyn Child>, String> {
        self.calls.lock().unwrap().push((cmd.to_string(), args.to_vec()));
        if self.missing || cmd != "nvidia-smi" {
            return Err("ENOENT".into());
        }
        let n = {
            let mut k = self.killed.lock().unwrap();
            k.push(false);
            k.len() - 1
        };
        let (lines, exit) = (self.lines.clone(), self.exit_after_lines);
        if self.held {
            self.unprinted.lock().unwrap().push((lines, on_line, exit.then_some(on_exit)));
            return Ok(Box::new(FakeChild(n, self.killed.clone())));
        }
        std::thread::spawn(move || {
            // (a moment later, as setImmediate; on a busy machine maybe still inside the
            // sample that started it, or after the next: held where that matters)
            std::thread::sleep(Duration::from_millis(15));
            for l in lines {
                on_line(&l);
            }
            if exit {
                on_exit(None);
            }
        });
        Ok(Box::new(FakeChild(n, self.killed.clone())))
    }
    fn output(&self, _cmd: &str, _args: &[&str], _t: Duration) -> Option<String> {
        Some("ffmpeg version 7.1.1-Jellyfin Copyright (c) 2000-2025 the FFmpeg developers\n".into())
    }
}

/// Timers that never fire (the test drives every sample), counted.
#[derive(Default)]
pub struct HeldTimers {
    pub set: Mutex<Vec<i64>>,
    pub live: Mutex<HashSet<u64>>,
    next: AtomicU64,
}

impl Timers for HeldTimers {
    fn set_timeout(&self, ms: i64, _f: Box<dyn FnOnce() + Send>) -> u64 {
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        self.set.lock().unwrap().push(ms);
        self.live.lock().unwrap().insert(id);
        id
    }
    fn clear_timeout(&self, id: u64) {
        self.live.lock().unwrap().remove(&id);
    }
}

/// Real timers, with the live ones counted (helpers.js trackedTimers).
#[derive(Default)]
pub struct TrackedTimers {
    real: RealTimers,
    pub live: Arc<Mutex<HashSet<u64>>>,
}

impl Timers for TrackedTimers {
    fn set_timeout(&self, ms: i64, f: Box<dyn FnOnce() + Send>) -> u64 {
        let live = self.live.clone();
        let slot = Arc::new(AtomicU64::new(0));
        let s2 = slot.clone();
        let id = self.real.set_timeout(
            ms,
            Box::new(move || {
                live.lock().unwrap().remove(&s2.load(Ordering::SeqCst));
                f();
            }),
        );
        slot.store(id, Ordering::SeqCst);
        self.live.lock().unwrap().insert(id);
        id
    }
    fn clear_timeout(&self, id: u64) {
        self.live.lock().unwrap().remove(&id);
        self.real.clear_timeout(id);
    }
}

/// A machine's tree in a temp folder (machines.js build): files written,
/// links made once, folders made.
pub struct Tree(pub PathBuf);

impl Tree {
    pub fn new() -> Tree {
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!("lean-stats-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Tree(p)
    }
    pub fn write(&self, files: &Value) {
        for (rel, v) in files.as_object().into_iter().flatten() {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            if let Some(target) = v["link"].as_str() {
                if std::fs::symlink_metadata(&p).is_err() {
                    std::os::unix::fs::symlink(target, &p).unwrap();
                }
            } else if v["dir"] == json!(true) {
                std::fs::create_dir_all(&p).unwrap();
            } else {
                std::fs::write(&p, v.as_str().unwrap_or("")).unwrap();
            }
        }
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub struct Rig {
    pub tree: Tree,
    pub clock: FakeClock,
    pub stats: Arc<Stats>,
    pub launcher: Arc<FakeLauncher>,
    pub shares: Arc<FakeShares>,
    pub phase: Arc<AtomicI64>,
    pub timers: Arc<dyn Timers>,
}

pub struct RigOptions {
    pub app_pid: i64,
    pub start: i64,
    pub lines: Vec<String>,
    pub pci_ids: bool,
    pub read_shares: Vec<ShareSpec>,
    pub encodes: Vec<ActiveEncode>,
    pub price: Option<f64>,
    pub progress: bool,
    pub timers: Option<Arc<dyn Timers>>,
    pub interval_ms: i64,
    pub data_dir: Option<PathBuf>,
    pub is_busy: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

impl Default for RigOptions {
    fn default() -> Self {
        // the fake clock's start: new Date(2026, 9, 23, 10, 0, 0) in UTC
        RigOptions { app_pid: 100, start: 1_792_749_600_000, lines: Vec::new(), pci_ids: false, read_shares: Vec::new(), encodes: Vec::new(), price: None, progress: false, timers: None, interval_ms: 2000, data_dir: None, is_busy: None }
    }
}

pub fn rig(first: &Value, o: RigOptions) -> Rig {
    let tree = Tree::new();
    tree.write(first);
    let clock = FakeClock::new(o.start);
    // (nvidia-smi prints when the test says: launcher.print())
    let launcher = Arc::new(FakeLauncher { lines: o.lines.clone(), held: true, ..Default::default() });
    let shares = Arc::new(FakeShares { shares: Mutex::new(json!({})), clock: clock.0.clone(), hung: Mutex::new(Vec::new()), stat_calls: Mutex::new(Vec::new()) });
    let phase = Arc::new(AtomicI64::new(0));
    let timers: Arc<dyn Timers> = o.timers.clone().unwrap_or_else(|| Arc::new(HeldTimers::default()));
    let mut so = StatsOptions::server(o.data_dir.clone(), json!("test"));
    so.proc_root = tree.0.join("proc");
    so.sys_root = tree.0.join("sys");
    so.dev_root = tree.0.join("dev");
    so.app_pid = o.app_pid;
    so.now = clock.clock();
    so.interval_ms = o.interval_ms;
    so.launcher = launcher.clone();
    so.timers = timers.clone();
    so.share_fs = shares.clone();
    let rs = o.read_shares.clone();
    so.read_shares = Arc::new(move || rs.clone());
    let enc = o.encodes.clone();
    so.active_encodes = Arc::new(move || enc.clone());
    let price = o.price;
    so.price_at = Arc::new(move |_| price);
    let ph = phase.clone();
    let progress = o.progress;
    so.job_progress = Arc::new(move |_| progress.then(|| (ph.load(Ordering::SeqCst) as f64, ph.load(Ordering::SeqCst) as f64 * 1000.0)));
    so.ffmpeg_version = Some(Some("7.1.1-Jellyfin".into()));
    so.pci_ids_files = vec![if o.pci_ids { tree.0.join("pci.ids") } else { PathBuf::from("/nonexistent/pci.ids") }];
    so.find_bin = Arc::new(|_| false);
    so.log = Arc::new(|_, _| {});
    if let Some(b) = o.is_busy {
        so.is_busy = b;
    }
    let stats = Stats::new(so);
    Rig { tree, clock, stats, launcher, shares, phase, timers }
}

/// Numbers alike to the last few bits; everything else equal. Differences as "path: node vs lean".
fn diff(path: &str, want: &Value, got: &Value, out: &mut Vec<String>) {
    match (want, got) {
        (Value::Number(a), Value::Number(b)) => {
            let (a, b) = (a.as_f64().unwrap(), b.as_f64().unwrap());
            if (a - b).abs() > 1e-9 * a.abs().max(1.0) {
                out.push(format!("{path}: {a} vs {b}"));
            }
        }
        (Value::Object(a), Value::Object(b)) => {
            let ka: Vec<&String> = a.keys().collect();
            let kb: Vec<&String> = b.keys().collect();
            if ka != kb {
                out.push(format!("{path}: keys {ka:?} vs {kb:?}"));
            }
            for (k, v) in a {
                diff(&format!("{path}.{k}"), v, b.get(k).unwrap_or(&Value::Null), out);
            }
        }
        (Value::Array(a), Value::Array(b)) => {
            if a.len() != b.len() {
                out.push(format!("{path}: {} items vs {}: {want} vs {got}", a.len(), b.len()));
                return;
            }
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                diff(&format!("{path}[{i}]"), x, y, out);
            }
        }
        _ => {
            if want != got {
                out.push(format!("{path}: {want} vs {got}"));
            }
        }
    }
}

/// Replays one recorded scenario; the differences, if any.
fn replay(file: &Path) -> Vec<String> {
    let rec = load(file);
    let phases = rec["phases"].as_array().unwrap();
    let o = RigOptions {
        app_pid: rec["appPid"].as_i64().unwrap(),
        start: rec["start"].as_i64().unwrap(),
        lines: rec["nvidia"].as_array().unwrap().iter().map(|l| l.as_str().unwrap().to_string()).collect(),
        pci_ids: rec["pciIds"] == json!(true),
        read_shares: rec["readShares"].as_array().unwrap().iter().map(|s| ShareSpec { label: s["label"].as_str().unwrap_or("").into(), path: s["path"].as_str().unwrap().into(), vehicle: s["vehicle"] == json!(true), network: s["network"] == json!(true) }).collect(),
        encodes: rec["encodes"].as_array().unwrap().iter().map(|e| ActiveEncode { pid: e["pid"].as_i64().unwrap(), encoder: e["encoder"].as_str().map(str::to_string) }).collect(),
        price: rec["price"].as_f64(),
        progress: rec["progress"] == json!(true),
        ..Default::default()
    };
    let r = rig(&phases[0]["files"], o);
    let name = rec["name"].as_str().unwrap();
    let mut out = Vec::new();
    if rec["touch"] == json!(true) {
        r.stats.touch(None);
    }
    for (p, ph) in phases.iter().enumerate() {
        r.phase.store(p as i64, Ordering::SeqCst);
        if p > 0 {
            r.tree.write(&ph["files"]);
        }
        r.clock.set(ph["at"].as_i64().unwrap());
        if ph["shares"].is_object() {
            *r.shares.shares.lock().unwrap() = ph["shares"].clone();
        }
        for e in ph["events"].as_array().into_iter().flatten() {
            if let Some(job) = e.get("markJob") {
                r.stats.mark_job(job.as_str());
            }
            if let Some(reading) = e.get("rapl") {
                r.stats.set_rapl(reading);
            }
        }
        r.stats.sample_now();
        r.stats.settle();
        // nvidia-smi's lines come a moment after it started (setImmediate in Node):
        // never inside the sample that started it, always before the next one
        r.launcher.print();
        let Some(want) = rec["snapshots"].get(p).filter(|s| !s.is_null()) else { continue };
        let mut want = want.clone();
        // (process.version: this server has no Node)
        want["host"]["node"] = Value::Null;
        // (os.hostname() and os.machine() for a fake machine without those files: the one that recorded it; replayed here, this one)
        for (k, here) in [("hostname", super::host::os_hostname()), ("arch", super::host::machine())] {
            if !r.tree.0.join("proc/sys/kernel").join(k).exists() && want["host"][k].is_string() {
                want["host"][k] = json!(here);
            }
        }
        diff(&format!("{name}#{p}"), &want, &r.stats.snapshot(), &mut out);
    }
    let spawned: Vec<Value> = r.launcher.calls.lock().unwrap().iter().map(|(c, a)| json!({ "cmd": c, "args": a })).collect();
    if json!(spawned) != rec["spawned"] {
        out.push(format!("{name}: started {spawned:?} vs {}", rec["spawned"]));
    }
    r.stats.stop();
    out
}

#[test]
fn the_same_answers_as_node_on_every_fake_machine() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/ops/stats/testdata");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "gz")).collect();
    files.sort();
    assert!(files.len() >= 10, "the recorded scenarios (node lean/parity/opsStats.js)");
    let mut all = Vec::new();
    for f in &files {
        all.extend(replay(f));
    }
    assert!(all.is_empty(), "{} differences:\n{}", all.len(), all.iter().take(200).cloned().collect::<Vec<_>>().join("\n"));
}

/// A recorded scenario (gzip-compressed JSON).
fn load(file: &Path) -> Value {
    use std::io::Read;
    let mut text = String::new();
    flate2::read::GzDecoder::new(std::fs::File::open(file).unwrap()).read_to_string(&mut text).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn machine(name: &str) -> Value {
    load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src/ops/stats/testdata").join(format!("{name}.json.gz")))["phases"].clone()
}

fn wait_until(f: impl Fn() -> bool, ms: u64) -> bool {
    let end = std::time::Instant::now() + Duration::from_millis(ms);
    while std::time::Instant::now() < end {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    f()
}

// test/statsLifecycle.test.js "nothing runs until a page watches; sampling stops 15 s after the last touch, with no timer left"
#[test]
fn sampling_only_while_watched_and_no_timer_left() {
    let phases = machine("intel-arc");
    let timers = Arc::new(TrackedTimers::default());
    let r = rig(&phases[0]["files"], RigOptions { timers: Some(timers.clone()), interval_ms: 100, ..Default::default() });
    assert!(!r.stats.sampling());
    assert_eq!(timers.live.lock().unwrap().len(), 0, "creating the engine starts nothing");
    assert_eq!(r.stats.snapshot()["at"], Value::Null);
    r.stats.touch(None);
    assert!(r.stats.sampling());
    assert_ne!(r.stats.snapshot()["at"], Value::Null, "the first sample is taken at once");
    assert_eq!(timers.live.lock().unwrap().len(), 1, "one timer for the next sample, nothing more");
    r.clock.advance(1000);
    std::thread::sleep(Duration::from_millis(250));
    assert!(r.stats.sampling(), "still watched");
    r.clock.advance(15000);
    assert!(wait_until(|| !r.stats.sampling(), 3000));
    assert!(wait_until(|| timers.live.lock().unwrap().is_empty(), 1000), "no timer left once idle");
    r.stats.touch(None);
    assert!(r.stats.sampling());
    r.clock.advance(16000);
    assert!(wait_until(|| !r.stats.sampling(), 3000));
    r.stats.stop();
    assert!(wait_until(|| timers.live.lock().unwrap().is_empty(), 1000));
}

// "a running conversion (isBusy) keeps sampling without any page; a marked job does too"
#[test]
fn a_conversion_or_a_job_keeps_sampling() {
    let phases = machine("amd");
    let busy = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let b = busy.clone();
    let r = rig(&phases[0]["files"], RigOptions { app_pid: 8, timers: Some(Arc::new(TrackedTimers::default())), interval_ms: 100, is_busy: Some(Arc::new(move || b.load(Ordering::SeqCst))), ..Default::default() });
    r.stats.mark_job(Some("job-1"));
    assert!(r.stats.sampling());
    r.clock.advance(60000);
    std::thread::sleep(Duration::from_millis(250));
    assert!(r.stats.sampling(), "busy and a job: keeps going without a page");
    busy.store(false, Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(250));
    assert!(r.stats.sampling(), "the job is still marked");
    r.stats.mark_job(None);
    assert!(wait_until(|| !r.stats.sampling(), 3000));
    busy.store(true, Ordering::SeqCst);
    r.stats.touch(None);
    r.clock.advance(20000);
    std::thread::sleep(Duration::from_millis(250));
    assert!(r.stats.sampling());
    busy.store(false, Ordering::SeqCst);
    assert!(wait_until(|| !r.stats.sampling(), 3000));
    r.stats.stop();
}

// "nvidia-smi runs only while sampling: killed when the page goes away, started again on the next visit"
#[test]
fn nvidia_smi_only_while_sampling() {
    let phases = machine("nvidia");
    let r = rig(&phases[0]["files"], RigOptions { app_pid: 10, timers: Some(Arc::new(TrackedTimers::default())), interval_ms: 100, lines: vec!["0, NVIDIA GeForce RTX 3060, 550.54.14, 23, 61, 12, 1650, 12288, 54, 41.27, 1777".into()], ..Default::default() });
    let smi = || r.launcher.calls.lock().unwrap().iter().filter(|c| c.0 == "nvidia-smi").count();
    assert_eq!(smi(), 0, "nothing started before anyone looks");
    r.stats.touch(None);
    assert_eq!(smi(), 1);
    assert_eq!(r.launcher.calls.lock().unwrap()[0].1, vec![format!("--query-gpu={}", gpu::NVIDIA_QUERY), "--format=csv,noheader,nounits".into(), "-lms".into(), "100".into()]);
    r.clock.advance(16000);
    assert!(wait_until(|| !r.stats.sampling(), 3000));
    assert!(r.launcher.killed.lock().unwrap()[0], "killed (SIGTERM)");
    std::thread::sleep(Duration::from_millis(30));
    assert_eq!(smi(), 1, "not restarted after it was stopped");
    r.stats.touch(None);
    assert_eq!(smi(), 2);
    assert!(!r.launcher.killed.lock().unwrap()[1]);
    r.stats.stop();
    assert!(r.launcher.killed.lock().unwrap()[1], "stopping the stats kills a running nvidia-smi");
}

// test/statsGpu.test.js "nvidia-smi: restarted with growing backoff, once a minute is healthy, never after stop"
#[test]
fn nvidia_smi_backoff() {
    let clock = FakeClock::new(1_000_000);
    let timers = Arc::new(HeldTimers::default());
    let launcher = Arc::new(FakeLauncher { exit_after_lines: true, ..Default::default() });
    let n = gpu::NvidiaSmi::new(launcher.clone(), timers.clone(), clock.clock(), 2000, Arc::new(|_, _| {}));
    n.start();
    assert!(wait_until(|| timers.set.lock().unwrap().len() == 1, 1000));
    // the timers never fire here: each restart is driven by hand through start-after-exit
    let delays = || timers.set.lock().unwrap().clone();
    assert_eq!(delays(), vec![2000]);
    n.stop();
    assert!(timers.live.lock().unwrap().is_empty(), "no restart timer after stop");
    // missing nvidia-smi: one warning, a retry in 10 minutes
    let warned = Arc::new(Mutex::new(Vec::new()));
    let w = warned.clone();
    let t2 = Arc::new(HeldTimers::default());
    let n2 = gpu::NvidiaSmi::new(Arc::new(FakeLauncher { missing: true, ..Default::default() }), t2.clone(), clock.clock(), 2000, Arc::new(move |_, m| w.lock().unwrap().push(m.to_string())));
    n2.start();
    assert_eq!(t2.set.lock().unwrap().clone(), vec![600_000]);
    assert_eq!(warned.lock().unwrap().len(), 1);
    n2.stop();
}

// test/stats.test.js "garbage in every file of a full machine never throws"
#[test]
fn garbage_in_every_file_never_breaks_a_sample() {
    let phases = machine("intel-arc");
    let r = rig(&phases[0]["files"], RigOptions { read_shares: vec![ShareSpec { label: "Data volume".into(), path: "/data".into(), ..Default::default() }], ..Default::default() });
    r.stats.sample_now();
    r.stats.settle();
    let junk = ["", "\u{0}\u{0}", "NaN", "-1", "99999999999999999999999", "cpu  1 2 3", "(((", "a: b: c", ")) S", "[N/A]"];
    let mut k = 0;
    fn walk(dir: &Path, f: &mut dyn FnMut(&Path)) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let t = e.file_type().unwrap();
            if t.is_symlink() {
                continue;
            }
            if t.is_dir() {
                walk(&e.path(), f);
            } else {
                f(&e.path());
            }
        }
    }
    walk(&r.tree.0, &mut |p| {
        std::fs::write(p, junk[k % junk.len()]).unwrap();
        k += 1;
    });
    for _ in 0..3 {
        r.clock.advance(2000);
        r.stats.sample_now();
        r.stats.settle();
    }
    let _ = std::fs::remove_dir_all(&r.tree.0);
    r.clock.advance(2000);
    r.stats.sample_now();
    r.stats.settle();
    assert!(r.stats.snapshot().is_object());
    r.stats.stop();
}

// test/stats.test.js "this machine: a sample of the real /proc and /sys (no GPU here)"
#[test]
fn this_machine() {
    let mut o = StatsOptions::server(None, json!(null));
    let launcher = Arc::new(FakeLauncher::default());
    o.launcher = launcher.clone();
    o.timers = Arc::new(HeldTimers::default());
    o.ffmpeg_version = Some(None);
    let tmp = std::env::temp_dir().to_string_lossy().into_owned();
    o.read_shares = Arc::new(move || vec![ShareSpec { label: "Temp".into(), path: tmp.clone(), ..Default::default() }]);
    let s = Stats::new(o);
    s.sample_now();
    s.settle();
    std::thread::sleep(Duration::from_millis(300));
    let snap = s.sample_now();
    s.settle();
    assert!(snap["cpu"]["threads"].as_f64().unwrap() >= 1.0);
    let u = &snap["cpu"]["usage"];
    assert!(u.is_null() || (0.0..=100.0).contains(&u.as_f64().unwrap()));
    assert!(snap["memory"]["totalB"].as_f64().unwrap() > 0.0);
    assert!(snap["memory"]["appB"].as_f64().unwrap() > 0.0, "this test process is the app");
    assert!(snap["host"]["kernel"].is_string());
    assert!(snap["processes"]["top"].as_array().unwrap().len() <= 40);
    let me = std::process::id() as i64;
    assert!(snap["processes"]["top"].as_array().unwrap().iter().all(|p| p["pid"] != json!(me) || p["name"] == "sentry-six-manager"));
    assert_eq!(s.snapshot()["filesystems"][0]["label"], "Temp");
    if !Path::new("/dev/nvidia0").exists() && !Path::new("/proc/driver/nvidia/version").exists() {
        assert!(!launcher.calls.lock().unwrap().iter().any(|c| c.0 == "nvidia-smi"), "no NVIDIA device, no nvidia-smi");
    }
    s.stop();
}

// "stop(): idle at once, history saved, later touches ignored" and the history file read back
#[test]
fn stop_saves_and_a_restart_reads_it_back() {
    let phases = machine("pi");
    let dir = Tree::new();
    let timers = Arc::new(HeldTimers::default());
    let r = rig(&phases[0]["files"], RigOptions { app_pid: 20, timers: Some(timers.clone()), data_dir: Some(dir.0.clone()), ..Default::default() });
    r.stats.touch(None);
    r.stats.stop();
    assert!(!r.stats.sampling());
    assert!(timers.live.lock().unwrap().is_empty());
    assert!(dir.0.join("stats-history.json").exists());
    r.stats.touch(None);
    r.stats.mark_job(Some("x"));
    assert!(!r.stats.sampling());
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(dir.0.join("stats-history.json")).unwrap()).unwrap();
    assert_eq!(saved["v"], 1);
    for k in ["history", "energy", "traffic", "shares"] {
        assert!(saved.get(k).is_some(), "{k}");
    }
    let again = rig(&phases[0]["files"], RigOptions { app_pid: 20, data_dir: Some(dir.0.clone()), ..Default::default() });
    assert!(again.stats.history(false)["series"]["memory"].as_array().unwrap().iter().any(|v| !v.is_null()), "the history survives a restart");
}

// test/statsTraffic.test.js "tick(): one reading a day with no page open, so each day holds its own bytes; no timer, no sampling"
#[test]
fn tick_reads_the_counters_once_a_day() {
    let phases = machine("amd");
    let dir = Tree::new();
    let timers = Arc::new(HeldTimers::default());
    let r = rig(&phases[0]["files"], RigOptions { app_pid: 8, timers: Some(timers.clone()), data_dir: Some(dir.0.clone()), ..Default::default() });
    r.stats.tick();
    assert!(!r.stats.sampling());
    assert!(timers.set.lock().unwrap().is_empty(), "no timer");
    assert!(dir.0.join("stats-history.json").exists(), "saved");
    assert_eq!(r.stats.traffic()["today"], Value::Null, "the very first call starts the count");
    // the same day again: nothing read
    r.tree.write(&phases[1]["files"]);
    r.clock.advance(60_000);
    r.stats.tick();
    assert_eq!(r.stats.traffic()["today"], Value::Null);
    // the next day: one reading, the bytes since
    r.tree.write(&phases[2]["files"]);
    r.clock.advance(86_400_000);
    r.stats.tick();
    assert!(r.stats.traffic()["week"].is_object());
}

// the engine's own energy: a job's energy counted while marked, its baseline from job progress
#[test]
fn energy_per_job_from_the_engine() {
    let phases = machine("amd");
    let r = rig(&phases[0]["files"], RigOptions { app_pid: 8, progress: true, price: Some(0.3), ..Default::default() });
    r.stats.mark_job(Some("j1"));
    r.stats.settle();
    for p in 1..=3 {
        r.phase.store(p, Ordering::SeqCst);
        r.tree.write(&phases[(p as usize).min(2)]["files"]);
        r.clock.advance(2000);
        r.stats.sample_now();
        r.stats.settle();
    }
    let e = r.stats.energy();
    let j = &e["byJob"]["j1"];
    assert!(j["wh"].as_f64().unwrap() > 0.0);
    assert_eq!(j["base"]["clips"], 2, "measuring began with the second power reading (the GPU sensor answers from the second sample)");
    assert!(j["cost"].as_f64().unwrap() > 0.0);
    assert_eq!(r.stats.peak("all", Some(300.0)), Some(300.0));
    assert_eq!(r.stats.peak("all", Some(100.0)), Some(300.0));
    r.stats.stop();
}
