//! filesystems.js: space and answer time of the footage shares and the data
//! folder. A share that hangs never holds up the server: checks run on their
//! own thread, one at a time per share, at most every 10 s. A check that has
//! not answered after 2 s shows as slow, after 15 s as unreachable. A
//! network share that is not mounted shows as not connected, never with the
//! space of the disk under it. Each share also tells when it was last
//! checked and when it last answered (kept with the stats history).

use super::util::*;
use crate::ops::js::num as jnum;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

const CHECK_EVERY_MS: i64 = 10000;
const UNREACHABLE_MS: i64 = 15000;
const MOUNTS_EVERY_MS: i64 = 60000;

/// What statfs says (in its own block unit).
#[derive(Clone, Copy, Debug)]
pub struct Statfs {
    pub bsize: f64,
    pub blocks: f64,
    pub bfree: f64,
    pub bavail: f64,
}

/// How a share is checked (the real file system in the server; a fake in tests).
pub trait ShareFs: Send + Sync {
    /// Start a stat of `path` (fs.promises.stat): the answer arrives on the receiver
    /// (Err: it failed). A share that hangs never answers.
    fn stat(&self, path: &str) -> mpsc::Receiver<Result<(), String>>;
    /// statfs, on the check's own thread.
    fn statfs(&self, path: &str) -> Option<Statfs>;
    /// fsSpace.js fragmentSize: the unit statfs counts blocks in (None: use bsize).
    fn fragment_size(&self, _path: &str) -> Option<f64> {
        None
    }
}

/// The real file system: stat on a thread of its own, statvfs (f_frsize as the fragment).
pub struct RealFs;

fn statvfs(path: &str) -> Option<libc::statvfs> {
    let c = std::ffi::CString::new(path).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    (unsafe { libc::statvfs(c.as_ptr(), &mut s) } == 0).then_some(s)
}

impl ShareFs for RealFs {
    fn stat(&self, path: &str) -> mpsc::Receiver<Result<(), String>> {
        let (tx, rx) = mpsc::channel();
        let p = path.to_string();
        std::thread::spawn(move || {
            let _ = tx.send(std::fs::metadata(&p).map(|_| ()).map_err(|e| crate::ops::sys::errno_code(&e)));
        });
        rx
    }
    fn statfs(&self, path: &str) -> Option<Statfs> {
        let s = statvfs(path)?;
        Some(Statfs { bsize: s.f_bsize as f64, blocks: s.f_blocks as f64, bfree: s.f_bfree as f64, bavail: s.f_bavail as f64 })
    }
    fn fragment_size(&self, path: &str) -> Option<f64> {
        statvfs(path).map(|s| s.f_frsize as f64).filter(|f| *f > 0.0)
    }
}

/// A share to watch: { label, path, vehicle, network }.
#[derive(Clone, Debug, Default)]
pub struct ShareSpec {
    pub label: String,
    pub path: String,
    pub vehicle: bool,
    pub network: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Mount {
    pub majmin: String,
    pub mount_point: String,
    pub fs_type: String,
    pub source: String,
    pub super_opts: String,
}

fn unescape(p: &str) -> String {
    let b = p.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && b.get(i + 1..i + 4).is_some_and(|d| d.iter().all(|c| (b'0'..=b'7').contains(c))) {
            out.push(u8::from_str_radix(&p[i + 1..i + 4], 8).unwrap_or(b'?'));
            i += 4;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// /proc/<pid>/mountinfo lines.
pub fn parse_mountinfo(text: Option<&str>) -> Vec<Mount> {
    let mut out = Vec::new();
    for line in text.unwrap_or("").split('\n') {
        let Some(sep) = line.find(" - ") else { continue };
        let left: Vec<&str> = line[..sep].split(' ').collect();
        let right: Vec<&str> = line[sep + 3..].split(' ').collect();
        if left.len() < 5 || right.len() < 2 {
            continue;
        }
        out.push(Mount { majmin: left[2].into(), mount_point: unescape(left[4]), fs_type: right[0].into(), source: unescape(right[1]), super_opts: right.get(2).unwrap_or(&"").to_string() });
    }
    out
}

/// The mount a path lives on: the deepest mount point above it (the last one wins when stacked).
pub fn mount_for<'a>(mounts: &'a [Mount], p: &str) -> Option<&'a Mount> {
    let mut best: Option<&Mount> = None;
    for m in mounts {
        let mp = &m.mount_point;
        let prefix = if mp.ends_with('/') { mp.clone() } else { format!("{mp}/") };
        let inside = p == mp || mp == "/" || p.starts_with(&prefix);
        if inside && best.is_none_or(|b| mp.len() >= b.mount_point.len()) {
            best = Some(m);
        }
    }
    best
}

#[derive(Clone, Debug, Default)]
struct Share {
    path: String,
    label: String,
    vehicle: bool,
    network: bool,
    total_b: Option<f64>,
    used_b: Option<f64>,
    free_b: Option<f64>,
    latency_ms: Option<f64>,
    reachable: Option<bool>,
    pending_since: Option<i64>,
    last_check: Option<i64>,
    checked_at: Option<i64>,
    answered_at: Option<i64>,
    fs_type: Option<String>,
    source: Option<String>,
    disk: Option<String>,
    smb_version: Option<String>,
    mounted: Option<bool>,
}

struct State {
    shares: Vec<Share>,
    answered: Vec<(String, i64)>,
    in_flight: usize,
}

pub type ReadShares = Arc<dyn Fn() -> Vec<ShareSpec> + Send + Sync>;

pub struct FilesystemsProvider {
    proc_root: PathBuf,
    sys_root: PathBuf,
    app_pid: i64,
    read_shares: ReadShares,
    fs: Arc<dyn ShareFs>,
    now: Clock,
    state: Arc<(Mutex<State>, std::sync::Condvar)>,
    listed_at: Option<i64>,
    mounts_at: Option<i64>,
}

/// Map.set: a key that is there keeps its place.
fn set_answered(list: &mut Vec<(String, i64)>, p: &str, at: i64) {
    match list.iter_mut().find(|x| x.0 == p) {
        Some(e) => e.1 = at,
        None => list.push((p.to_string(), at)),
    }
}

/// path.isAbsolute and path.resolve for the share paths.
fn resolve(p: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for s in p.split('/') {
        match s {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            x => parts.push(x),
        }
    }
    format!("/{}", parts.join("/"))
}

fn trunc(s: &str, n: usize) -> String {
    crate::ops::power::js_slice(s, n)
}

impl FilesystemsProvider {
    pub fn new(proc_root: &Path, sys_root: &Path, app_pid: i64, read_shares: ReadShares, fs: Arc<dyn ShareFs>, now: Clock) -> FilesystemsProvider {
        FilesystemsProvider {
            proc_root: proc_root.into(),
            sys_root: sys_root.into(),
            app_pid,
            read_shares,
            fs,
            now,
            state: Arc::new((Mutex::new(State { shares: Vec::new(), answered: Vec::new(), in_flight: 0 }), std::sync::Condvar::new())),
            listed_at: None,
            mounts_at: None,
        }
    }

    /// The whole disk behind a block device number ("259:2" -> "nvme0n1").
    fn disk_of(&self, majmin: &str) -> Option<String> {
        if majmin.is_empty() || majmin.starts_with("0:") {
            return None;
        }
        let real = real_path(self.sys_root.join("dev/block").join(majmin))?;
        Some(if exists(Path::new(&real).join("partition")) { basename(&dirname(&real)) } else { basename(&real) })
    }

    fn refresh_list(&mut self, t: i64) {
        let list = (self.read_shares)();
        let mut st = self.state.0.lock().unwrap();
        let mut next: Vec<Share> = Vec::new();
        for s in list.into_iter().take(32) {
            if !s.path.starts_with('/') {
                continue;
            }
            let p = resolve(&s.path);
            let label = trunc(if s.label.is_empty() { &p } else { &s.label }, 100);
            let mut share = st.shares.iter().find(|x| x.path == p).cloned().unwrap_or_else(|| Share { path: p.clone(), answered_at: st.answered.iter().find(|a| a.0 == p).map(|a| a.1), ..Default::default() });
            share.label = label;
            share.vehicle = s.vehicle;
            share.network = s.network;
            if let Some(e) = next.iter_mut().find(|x| x.path == p) {
                *e = share;
            } else {
                next.push(share);
            }
        }
        let keys = |v: &[Share]| v.iter().map(|s| s.path.clone()).collect::<Vec<_>>().join("\n");
        let changed = keys(&next) != keys(&st.shares);
        st.shares = next;
        self.listed_at = Some(t);
        let every = if st.shares.iter().any(|s| s.network) { CHECK_EVERY_MS } else { MOUNTS_EVERY_MS };
        if changed || self.mounts_at.is_none_or(|m| t - m >= every) {
            let mounts = parse_mountinfo(read_text(self.proc_root.join(format!("{}/mountinfo", self.app_pid))).as_deref());
            self.mounts_at = Some(t);
            let disks: Vec<Option<String>> = st.shares.iter().map(|s| mount_for(&mounts, &s.path).and_then(|m| self.disk_of(&m.majmin))).collect();
            for (s, disk) in st.shares.iter_mut().zip(disks) {
                let m = mount_for(&mounts, &s.path);
                s.fs_type = m.map(|m| m.fs_type.clone()).filter(|x| !x.is_empty());
                s.source = m.filter(|m| m.source != "none").map(|m| m.source.clone());
                s.disk = disk;
                let smb = m.is_some_and(|m| m.fs_type == "cifs" || m.fs_type == "smb3");
                s.smb_version = if smb { re!(r"(?:^|,)vers=([\d.]+)").group(&m.unwrap().super_opts, 1) } else { None };
                let mounted = if s.network { Some(smb) } else { None };
                // not mounted (any more): nothing measured so far is the share's
                if mounted == Some(false) && s.mounted != Some(false) {
                    s.total_b = None;
                    s.used_b = None;
                    s.free_b = None;
                    s.latency_ms = None;
                    s.reachable = Some(false);
                }
                s.mounted = mounted;
            }
        }
    }

    fn check(&self, st: &mut State, i: usize) {
        let now = (self.now)();
        let s = &mut st.shares[i];
        s.checked_at = Some(now);
        if s.mounted == Some(false) {
            s.last_check = Some(now);
            return;
        }
        s.pending_since = Some(now);
        let target = s.path.clone();
        let t0 = (self.now)();
        let rx = self.fs.stat(&target);
        st.in_flight += 1;
        let (fs, clock, state) = (self.fs.clone(), self.now.clone(), self.state.clone());
        std::thread::spawn(move || {
            let answer = rx.recv().unwrap_or(Err("gone".into()));
            let result = answer.map(|_| {
                let latency = clock() - t0;
                let sfs = fs.statfs(&target);
                let frag = sfs.and_then(|_| fs.fragment_size(&target));
                (latency, sfs, frag)
            });
            let (lock, cv) = &*state;
            let mut st = lock.lock().unwrap();
            let at = clock();
            let mut answered = None;
            if let Some(s) = st.shares.iter_mut().find(|s| s.path == target) {
                match result {
                    Ok(_) if s.mounted == Some(false) => {}
                    Ok((latency, sfs, frag)) => {
                        s.reachable = Some(true);
                        s.answered_at = Some(at);
                        answered = Some(at);
                        s.latency_ms = Some(js_round(latency.max(0) as f64));
                        if let Some(sfs) = sfs {
                            let bs = frag.unwrap_or(sfs.bsize);
                            if bs > 0.0 && sfs.blocks > 0.0 {
                                s.total_b = Some(sfs.blocks * bs);
                                s.used_b = Some((sfs.blocks - sfs.bfree).max(0.0) * bs);
                                s.free_b = Some(sfs.bavail * bs);
                            }
                        }
                    }
                    Err(_) => {
                        s.reachable = Some(false);
                        s.latency_ms = None;
                    }
                }
                s.pending_since = None;
                s.last_check = Some(at);
            }
            if let Some(a) = answered {
                set_answered(&mut st.answered, &target, a);
            }
            st.in_flight -= 1;
            cv.notify_all();
        });
    }

    pub fn sample(&mut self, t: i64) -> Vec<Value> {
        if self.listed_at.is_none_or(|l| t - l >= CHECK_EVERY_MS) {
            self.refresh_list(t);
        }
        let state = self.state.clone();
        let mut st = state.0.lock().unwrap();
        let mut out = Vec::new();
        for i in 0..st.shares.len() {
            let due = st.shares[i].pending_since.is_none() && st.shares[i].last_check.is_none_or(|l| t - l >= CHECK_EVERY_MS);
            if due {
                self.check(&mut st, i);
            }
            let s = &st.shares[i];
            let (mut latency, mut reachable) = (s.latency_ms, s.reachable);
            if let Some(p) = s.pending_since {
                let waited = t - p;
                if waited > 2000 {
                    latency = Some(latency.unwrap_or(0.0).max(waited as f64));
                }
                if waited > UNREACHABLE_MS {
                    reachable = Some(false);
                }
            }
            let n = |x: Option<f64>| x.map_or(Value::Null, jnum);
            out.push(json!({
                "label": s.label, "path": s.path, "vehicle": s.vehicle, "totalB": n(s.total_b), "usedB": n(s.used_b), "freeB": n(s.free_b),
                "latencyMs": n(latency), "reachable": reachable, "fsType": s.fs_type, "source": s.source, "disk": s.disk, "smbVersion": s.smb_version,
                "mounted": s.mounted, "checkedAt": s.checked_at, "checkEveryMs": CHECK_EVERY_MS, "answeredAt": s.answered_at
            }));
        }
        out
    }

    /// Waits (at most `most`) for the checks in flight (tests).
    pub fn wait_idle(&self, most: std::time::Duration) {
        let (lock, cv) = &*self.state;
        let st = lock.lock().unwrap();
        let _ = cv.wait_timeout_while(st, most, |s| s.in_flight > 0);
    }

    /// When each share last answered, for the saved history.
    pub fn to_json(&self) -> Value {
        let st = self.state.0.lock().unwrap();
        let skip = st.answered.len().saturating_sub(32);
        Value::Object(st.answered[skip..].iter().map(|(p, at)| (p.clone(), json!(at))).collect::<Map<_, _>>())
    }

    pub fn load(&mut self, data: &Value) {
        let Some(o) = data.as_object() else { return };
        let t = (self.now)();
        let mut st = self.state.0.lock().unwrap();
        for (p, at) in o.iter().take(32) {
            let Some(at) = at.as_f64().filter(|a| a.is_finite() && *a > 0.0 && *a <= t as f64) else { continue };
            if !p.starts_with('/') {
                continue;
            }
            let at = at as i64;
            set_answered(&mut st.answered, p, at);
            if let Some(s) = st.shares.iter_mut().find(|s| &s.path == p) {
                if s.answered_at.is_none_or(|a| a < at) {
                    s.answered_at = Some(at);
                }
            }
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};

    /// A share that answers stat at once and statfs with fixed numbers.
    pub struct FakeFs {
        pub statfs: Statfs,
        pub hung: Mutex<Vec<mpsc::Sender<Result<(), String>>>>,
        pub hang: Vec<String>,
    }

    impl ShareFs for FakeFs {
        fn stat(&self, p: &str) -> mpsc::Receiver<Result<(), String>> {
            let (tx, rx) = mpsc::channel();
            if self.hang.iter().any(|h| h == p) {
                self.hung.lock().unwrap().push(tx);
            } else {
                let _ = tx.send(Ok(()));
            }
            rx
        }
        fn statfs(&self, _p: &str) -> Option<Statfs> {
            Some(self.statfs)
        }
    }

    const ROOT: &str = "1 0 259:2 / / rw,relatime - ext4 /dev/nvme0n1p2 rw";
    const SHARE: &str = "40 1 0:52 / /footage/bingbong rw,nosuid - cifs //nas/teslacam rw,vers=3.1.1";

    // test/statsShares.test.js
    #[test]
    fn a_network_share_that_is_not_mounted_shows_as_not_connected() {
        let proc_root = std::env::temp_dir().join(format!("lean-shares-{}", std::process::id()));
        std::fs::create_dir_all(proc_root.join("7")).unwrap();
        let mountinfo = |lines: &[&str]| std::fs::write(proc_root.join("7/mountinfo"), format!("{}\n", lines.join("\n"))).unwrap();
        let t = Arc::new(AtomicI64::new(100000));
        let tc = t.clone();
        let clock: Clock = Arc::new(move || tc.load(Ordering::SeqCst));
        let fs: Arc<dyn ShareFs> = Arc::new(FakeFs { statfs: Statfs { bsize: 4096.0, blocks: 1.8e12 / 4096.0, bfree: 1.1e12 / 4096.0, bavail: 1.1e12 / 4096.0 }, hung: Mutex::new(Vec::new()), hang: Vec::new() });
        let both: ReadShares = Arc::new(|| vec![ShareSpec { label: "Data volume".into(), path: "/data".into(), ..Default::default() }, ShareSpec { label: "BingBong".into(), path: "/footage/bingbong".into(), vehicle: true, network: true }]);
        let mut p = FilesystemsProvider::new(&proc_root, Path::new("/nonexistent"), 7, both, fs.clone(), clock.clone());
        let settle = |p: &FilesystemsProvider| p.wait_idle(std::time::Duration::from_secs(2));
        mountinfo(&[ROOT]);
        let now = || t.load(Ordering::SeqCst);
        p.sample(now());
        settle(&p);
        let out = p.sample(now());
        let (data, car) = (&out[0], &out[1]);
        assert_eq!(data["reachable"], true);
        assert_eq!((data["checkedAt"].clone(), data["checkEveryMs"].clone(), data["answeredAt"].clone()), (json!(now()), json!(10000), json!(now())));
        assert_eq!(data["totalB"].as_f64(), Some(1.8e12));
        assert_eq!(data["mounted"], Value::Null);
        assert_eq!((car["mounted"].clone(), car["reachable"].clone(), car["totalB"].clone(), car["latencyMs"].clone()), (json!(false), json!(false), Value::Null, Value::Null));
        assert_eq!((car["checkedAt"].clone(), car["answeredAt"].clone()), (json!(now()), Value::Null));
        // the share comes back: within one check
        mountinfo(&[ROOT, SHARE]);
        t.fetch_add(10000, Ordering::SeqCst);
        p.sample(now());
        settle(&p);
        let car = p.sample(now())[1].clone();
        assert_eq!((car["mounted"].clone(), car["reachable"].clone(), car["fsType"].clone(), car["smbVersion"].clone()), (json!(true), json!(true), json!("cifs"), json!("3.1.1")));
        let answered = now();
        assert_eq!(car["answeredAt"], json!(answered));
        // and goes away again
        mountinfo(&[ROOT]);
        t.fetch_add(10000, Ordering::SeqCst);
        let car = p.sample(now())[1].clone();
        assert_eq!((car["mounted"].clone(), car["reachable"].clone(), car["totalB"].clone(), car["latencyMs"].clone()), (json!(false), json!(false), Value::Null, Value::Null));
        assert_eq!((car["checkedAt"].clone(), car["answeredAt"].clone()), (json!(now()), json!(answered)));
        // after a restart, the last answer comes back with the saved history
        settle(&p);
        let saved = p.to_json();
        let one: ReadShares = Arc::new(|| vec![ShareSpec { label: "BingBong".into(), path: "/footage/bingbong".into(), vehicle: true, network: true }]);
        let mut after = FilesystemsProvider::new(&proc_root, Path::new("/nonexistent"), 7, one, fs, clock);
        after.load(&saved);
        after.load(&json!({ "/footage/x": now() + 60000, "relative": 1, "/footage/y": "soon" }));
        // (the data folder's check of this round answered too: Node's test reads it before that answer lands)
        assert_eq!(after.to_json(), json!({ "/data": now(), "/footage/bingbong": answered }));
        let car = after.sample(now())[0].clone();
        assert_eq!((car["mounted"].clone(), car["answeredAt"].clone()), (json!(false), json!(answered)));
        let _ = std::fs::remove_dir_all(&proc_root);
    }

    #[test]
    fn mounts() {
        let m = parse_mountinfo(Some("40 1 0:52 / /footage/my\\040car rw - cifs //nas/tesla\\040cam rw,vers=3.0\nbad"));
        assert_eq!(m[0].mount_point, "/footage/my car");
        assert_eq!(m[0].source, "//nas/tesla cam");
        let all = parse_mountinfo(Some(&format!("{ROOT}\n{SHARE}")));
        assert_eq!(mount_for(&all, "/footage/bingbong/x").unwrap().fs_type, "cifs");
        assert_eq!(mount_for(&all, "/footage/bing").unwrap().fs_type, "ext4");
    }
}
