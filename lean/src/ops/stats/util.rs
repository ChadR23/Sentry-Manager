//! util.js: small readers shared by the stats providers. Every read answers
//! None (or an empty list) instead of failing: a file that is missing,
//! unreadable or odd on this machine only means that number is not shown.
//! Also the background reads (sensors that ask a device) and the clock.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

pub use super::history::{js_round, round};

/// The engine's clock in ms (Date.now, or a test's hand-moved clock).
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(crate::ops::store::now_ms)
}

/// A JavaScript regular expression (fancy-regex: lookaheads included).
pub struct Re(fancy_regex::Regex);

impl Re {
    pub fn new(p: &str) -> Re {
        Re(fancy_regex::Regex::new(p).expect("a valid pattern"))
    }
    pub fn is(&self, s: &str) -> bool {
        self.0.is_match(s).unwrap_or(false)
    }
    /// The groups of the first match (0 is the whole match).
    pub fn caps(&self, s: &str) -> Option<Vec<Option<String>>> {
        let c = self.0.captures(s).ok()??;
        Some((0..c.len()).map(|i| c.get(i).map(|m| m.as_str().to_string())).collect())
    }
    /// Group `i` of the first match.
    pub fn group(&self, s: &str, i: usize) -> Option<String> {
        self.caps(s)?.get(i).cloned().flatten()
    }
    /// String.prototype.split by this pattern.
    pub fn split<'a>(&self, s: &'a str) -> Vec<&'a str> {
        let mut out = Vec::new();
        let mut last = 0;
        for m in self.0.find_iter(s).filter_map(|m| m.ok()) {
            if m.end() == m.start() {
                continue;
            }
            out.push(&s[last..m.start()]);
            last = m.end();
        }
        out.push(&s[last..]);
        out
    }
    pub fn replace(&self, s: &str, to: &str) -> String {
        self.0.replace(s, to).into_owned()
    }
    pub fn replace_all(&self, s: &str, to: &str) -> String {
        self.0.replace_all(s, to).into_owned()
    }
}

/// A regular expression compiled once.
#[macro_export]
macro_rules! js_re {
    ($p:expr) => {{
        static R: std::sync::OnceLock<$crate::ops::stats::util::Re> = std::sync::OnceLock::new();
        R.get_or_init(|| $crate::ops::stats::util::Re::new($p))
    }};
}
pub use js_re as re;

pub fn join(a: impl AsRef<Path>, b: &str) -> PathBuf {
    a.as_ref().join(b)
}

pub fn read_text(p: impl AsRef<Path>) -> Option<String> {
    fs::read(p).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// First line, trimmed (sysfs attributes are one line).
pub fn read_line(p: impl AsRef<Path>) -> Option<String> {
    let t = read_text(p)?;
    let l = t.split('\n').next().unwrap_or("").trim().to_string();
    (!l.is_empty()).then_some(l)
}

/// toNum: Number(text) when it is a finite number, else None.
pub fn to_num(text: Option<&str>) -> Option<f64> {
    let s = text?.trim();
    if s.is_empty() {
        return None;
    }
    let n = crate::ops::js::number_str(s);
    n.is_finite().then_some(n)
}

pub fn read_num(p: impl AsRef<Path>) -> Option<f64> {
    to_num(read_line(p).as_deref())
}

/// num(): the first line of a text as a number.
pub fn num(text: Option<&str>) -> Option<f64> {
    to_num(text.map(|t| t.split('\n').next().unwrap_or("")))
}

/// readdirSync (libuv sorts the names), at most `max` of them.
pub fn list_dir(dir: impl AsRef<Path>, max: usize) -> Vec<String> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut names: Vec<String> = rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names.truncate(max);
    names
}

pub fn read_link(p: impl AsRef<Path>) -> Option<String> {
    fs::read_link(p).ok().map(|x| x.to_string_lossy().into_owned())
}

pub fn real_path(p: impl AsRef<Path>) -> Option<String> {
    fs::canonicalize(p).ok().map(|x| x.to_string_lossy().into_owned())
}

pub fn exists(p: impl AsRef<Path>) -> bool {
    p.as_ref().exists()
}

/// path.basename
pub fn basename(p: &str) -> String {
    p.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string()
}

/// path.dirname
pub fn dirname(p: &str) -> String {
    let t = p.trim_end_matches('/');
    match t.rfind('/') {
        Some(0) => "/".into(),
        Some(i) => t[..i].to_string(),
        None => ".".into(),
    }
}

/// `Key: 123 kB` lines (/proc/meminfo, /proc/<pid>/status) as numbers in their own unit.
pub fn parse_key_values(text: Option<&str>) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    for line in text.unwrap_or("").split('\n') {
        if let Some(c) = re!(r"^([\w()]+):\s*(-?\d+)").caps(line) {
            if let (Some(k), Some(v)) = (&c[1], &c[2]) {
                out.insert(k.clone(), v.parse::<f64>().unwrap_or(f64::NAN));
            }
        }
    }
    out
}

/// `key=value` lines (uevent).
pub fn parse_uevent(text: Option<&str>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in text.unwrap_or("").split('\n') {
        if let Some(i) = line.find('=').filter(|i| *i > 0) {
            out.insert(line[..i].trim().to_string(), line[i + 1..].trim().to_string());
        }
    }
    out
}

pub fn clamp_pct(n: Option<f64>) -> Option<f64> {
    n.filter(|x| x.is_finite()).map(|x| x.clamp(0.0, 100.0))
}

pub fn max_of(values: impl IntoIterator<Item = Option<f64>>) -> Option<f64> {
    let mut best: Option<f64> = None;
    for v in values.into_iter().flatten() {
        if v.is_finite() && best.is_none_or(|b| v > b) {
            best = Some(v);
        }
    }
    best
}

pub fn sum_of(values: impl IntoIterator<Item = Option<f64>>) -> Option<f64> {
    let mut total: Option<f64> = None;
    for v in values.into_iter().flatten() {
        if v.is_finite() {
            total = Some(total.unwrap_or(0.0) + v);
        }
    }
    total
}

/// One file's last answer.
#[derive(Clone, Debug, Default)]
pub struct Entry {
    pub text: Option<String>,
    pub at: Option<i64>,
    pub prev_text: Option<String>,
    pub prev_at: Option<i64>,
    busy: bool,
    started_at: Option<i64>,
    wanted_at: i64,
}

/// How a background read reads a file (fs::read in the server; tests hang some).
pub type ReadFile = Arc<dyn Fn(&Path) -> Option<String> + Send + Sync>;

struct ReadsState {
    entries: HashMap<PathBuf, Entry>,
    queue: VecDeque<PathBuf>,
    running: usize,
}

/// util.js BackgroundReads: reads that may be slow because they ask a device
/// (a disk's or GPU's sensor, an ACPI thermal zone) run off the sampling
/// thread, at most one at a time per file and at most `limit` at once, and a
/// sample uses the last answer. A hung sensor only makes its own number
/// late, and even several hold at most `limit` threads.
pub struct BackgroundReads {
    now: Clock,
    read_file: ReadFile,
    limit: usize,
    state: Mutex<ReadsState>,
    idle: Condvar,
}

impl BackgroundReads {
    pub fn new(now: Clock, read_file: Option<ReadFile>, limit: usize) -> Arc<BackgroundReads> {
        Arc::new(BackgroundReads {
            now,
            read_file: read_file.unwrap_or_else(|| Arc::new(|p: &Path| read_text(p))),
            limit,
            state: Mutex::new(ReadsState { entries: HashMap::new(), queue: VecDeque::new(), running: 0 }),
            idle: Condvar::new(),
        })
    }

    /// The last answer for `file`, refreshed in the background when it is
    /// older than `every_ms`. `at` is when the read started, so counters
    /// (energy) are divided by the right interval.
    pub fn get(self: &Arc<Self>, file: &Path, every_ms: i64) -> Entry {
        let t = (self.now)();
        let mut s = self.state.lock().unwrap();
        let e = s.entries.entry(file.to_path_buf()).or_default();
        e.wanted_at = t;
        if !e.busy && e.at.is_none_or(|at| t - at >= every_ms) {
            e.busy = true;
            s.queue.push_back(file.to_path_buf());
            self.pump(&mut s);
        }
        s.entries.get(file).cloned().unwrap_or_default()
    }

    /// Text of the last answer, or None when there is none younger than `max_age_ms`.
    pub fn text(self: &Arc<Self>, file: &Path, every_ms: i64, max_age_ms: i64) -> Option<String> {
        let e = self.get(file, every_ms);
        e.at.filter(|at| (self.now)() - at <= max_age_ms).and(e.text)
    }

    fn pump(self: &Arc<Self>, s: &mut ReadsState) {
        while s.running < self.limit {
            let Some(file) = s.queue.pop_front() else { break };
            s.running += 1;
            if let Some(e) = s.entries.get_mut(&file) {
                e.started_at = Some((self.now)());
            }
            let me = Arc::clone(self);
            std::thread::spawn(move || {
                let text = (me.read_file)(&file);
                let mut s = me.state.lock().unwrap();
                if let Some(e) = s.entries.get_mut(&file) {
                    e.prev_text = e.text.take();
                    e.prev_at = e.at;
                    e.text = text;
                    e.at = e.started_at;
                    e.busy = false;
                }
                s.running -= 1;
                me.pump(&mut s);
                if s.running == 0 && s.queue.is_empty() {
                    me.idle.notify_all();
                }
            });
        }
    }

    /// Returns once no read is queued or in flight (or after `most`).
    pub fn wait_idle(&self, most: Duration) {
        let s = self.state.lock().unwrap();
        let _ = self.idle.wait_timeout_while(s, most, |s| s.running > 0 || !s.queue.is_empty());
    }

    /// Forget files nobody asked for since `before` (a GPU or disk that went away).
    pub fn prune(&self, before: i64) {
        self.state.lock().unwrap().entries.retain(|_, e| e.busy || e.wanted_at >= before);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

    // test/stats.test.js "background reads: a hung sensor holds at most a few threads and never the others"
    #[test]
    fn a_hung_sensor_holds_at_most_a_few_threads() {
        let t = Arc::new(AtomicI64::new(0));
        let tc = t.clone();
        let in_flight = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        let (f, m) = (in_flight.clone(), most.clone());
        let tr = t.clone();
        let read: ReadFile = Arc::new(move |p: &Path| {
            let n = f.fetch_add(1, Ordering::SeqCst) + 1;
            m.fetch_max(n, Ordering::SeqCst);
            if p.starts_with("/hwmon") {
                loop {
                    std::thread::sleep(Duration::from_secs(3600));
                }
            }
            f.fetch_sub(1, Ordering::SeqCst);
            Some(format!("{}:{}", p.display(), tr.load(Ordering::SeqCst)))
        });
        let r = BackgroundReads::new(Arc::new(move || tc.load(Ordering::SeqCst)), Some(read), 4);
        for f in ["/hwmon/a", "/hwmon/b", "/hwmon/c", "/cpu/temp", "/gpu/busy"] {
            r.get(Path::new(f), 0);
        }
        for _ in 0..200 {
            if r.get(Path::new("/gpu/busy"), 0).text.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(r.get(Path::new("/cpu/temp"), 0).text.as_deref(), Some("/cpu/temp:0"), "one slot is left for the rest");
        assert_eq!(r.get(Path::new("/gpu/busy"), 0).text.as_deref(), Some("/gpu/busy:0"));
        t.store(2000, Ordering::SeqCst);
        for _ in 0..5 {
            r.get(Path::new("/hwmon/a"), 0);
        }
        assert!(most.load(Ordering::SeqCst) <= 4, "at most 4 reads at once");
        assert_eq!(r.text(Path::new("/hwmon/a"), 0, 60000), None, "a hung sensor shows nothing rather than an old value forever");
    }

    #[test]
    fn readers() {
        assert_eq!(to_num(Some(" 12 ")), Some(12.0));
        assert_eq!(to_num(Some("")), None);
        assert_eq!(to_num(Some("NaN")), None);
        assert_eq!(num(Some("5\n6")), Some(5.0));
        let kv = parse_key_values(Some("MemTotal:  100 kB\nVmRSS:\t-5 kB\nbad\n"));
        assert_eq!(kv["MemTotal"], 100.0);
        assert_eq!(kv["VmRSS"], -5.0);
        assert_eq!(max_of([None, Some(3.0), Some(f64::NAN), Some(1.0)]), Some(3.0));
        assert_eq!(sum_of([None, None]), None);
        assert_eq!(basename("/a/b/"), "b");
        assert_eq!(dirname("/a/b"), "/a");
    }
}
