//! procs.js: one pass over /proc/<pid>/stat per sample: every visible
//! process with its parent, CPU ticks and memory, and which of them are this
//! app and its children (ffmpeg). CPU % comes from tick deltas between
//! passes, keyed by pid and start time so a reused pid never borrows another
//! process's ticks.

use super::util::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// USER_HZ: the unit of /proc tick counters on every Linux architecture
pub const HZ: f64 = 100.0;

#[derive(Clone, Debug, PartialEq)]
pub struct Proc {
    pub pid: i64,
    pub comm: String,
    pub state: String,
    pub ppid: i64,
    pub ticks: f64,
    pub child_ticks: f64,
    pub start: f64,
    pub rss_pages: f64,
    pub cpu: Option<f64>,
    pub mem_b: f64,
}

/// Fields of /proc/<pid>/stat; the name sits in parentheses and may hold spaces or ')'.
pub fn parse_stat(text: Option<&str>) -> Option<Proc> {
    let text = text.filter(|t| !t.is_empty())?;
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    if open < 1 || close < open {
        return None;
    }
    let pid = crate::ops::js::number_str(text[..open].trim());
    let rest_s = text.get(close + 2..).unwrap_or("").trim();
    let rest: Vec<&str> = if rest_s.is_empty() { vec![""] } else { rest_s.split_whitespace().collect() };
    if !(pid.is_finite() && pid.fract() == 0.0) || rest.len() < 22 {
        return None;
    }
    let n = |i: usize| crate::ops::js::number_str(rest[i]);
    let (ppid, utime, stime, start) = (n(1), n(11), n(12), n(19));
    let child = n(13) + n(14);
    let rss = n(21);
    if ![ppid, utime, stime, start].iter().all(|x| x.is_finite()) {
        return None;
    }
    Some(Proc {
        pid: pid as i64,
        comm: text[open + 1..close].to_string(),
        state: rest[0].to_string(),
        ppid: ppid as i64,
        ticks: utime + stime,
        child_ticks: if child.is_finite() { child } else { 0.0 },
        start,
        rss_pages: if rss.is_finite() { rss } else { 0.0 },
        cpu: None,
        mem_b: 0.0,
    })
}

/// First number of /proc/uptime, in seconds.
pub fn read_uptime(proc_root: &Path) -> Option<f64> {
    let line = read_line(proc_root.join("uptime")).unwrap_or_default();
    let first = line.split(char::is_whitespace).next().unwrap_or("");
    let n = if first.is_empty() { 0.0 } else { crate::ops::js::number_str(first) };
    (n.is_finite() && n > 0.0).then_some(n)
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Reaped {
    pub ticks: f64,
    pub ffmpeg_ticks: f64,
    pub cpu: Option<f64>,
    pub ffmpeg_cpu: Option<f64>,
}

pub struct ProcessTable {
    proc_root: PathBuf,
    pub app_pid: i64,
    prev: HashMap<String, f64>,
    prev_uptime: Option<f64>,
    page_size: Option<f64>,
    pub scope: &'static str,
    pub list: Vec<Proc>,
    pub by_pid: HashMap<i64, usize>,
    pub app: Vec<i64>,
    pub app_set: HashSet<i64>,
    pub reaped: Reaped,
    prev_kids: Option<HashMap<String, (f64, f64, bool)>>,
    prev_app_child_ticks: Option<f64>,
    pub uptime: Option<f64>,
}

fn is_ffmpeg(comm: &str) -> bool {
    comm.starts_with("ffmpeg")
}

impl ProcessTable {
    pub fn new(proc_root: &Path, app_pid: i64) -> ProcessTable {
        ProcessTable {
            proc_root: proc_root.into(),
            app_pid,
            prev: HashMap::new(),
            prev_uptime: None,
            page_size: None,
            scope: "container",
            list: Vec::new(),
            by_pid: HashMap::new(),
            app: Vec::new(),
            app_set: HashSet::new(),
            reaped: Reaped::default(),
            prev_kids: None,
            prev_app_child_ticks: None,
            uptime: None,
        }
    }

    pub fn get(&self, pid: i64) -> Option<&Proc> {
        self.by_pid.get(&pid).map(|i| &self.list[*i])
    }

    pub fn probe(&mut self) {
        // With `pid: host` the first process is the host's init, in another cgroup than the app
        let a = read_text(self.proc_root.join("1/cgroup"));
        let b = read_text(self.proc_root.join(format!("{}/cgroup", self.app_pid)));
        self.scope = match (a, b) {
            (Some(a), Some(b)) if a.trim() != b.trim() => "host",
            _ => "container",
        };
        self.page_size = Some(self.detect_page_size());
    }

    // stat counts memory in pages; status says kB. The app's own two answers give the page size.
    fn detect_page_size(&self) -> f64 {
        let st = parse_stat(read_text(self.proc_root.join(format!("{}/stat", self.app_pid))).as_deref());
        let kb = parse_key_values(read_text(self.proc_root.join(format!("{}/status", self.app_pid))).as_deref()).get("VmRSS").copied();
        if let (Some(st), Some(kb)) = (st, kb) {
            if st.rss_pages > 0.0 && kb > 0.0 {
                let ratio = kb * 1024.0 / st.rss_pages;
                for size in [4096.0, 16384.0, 65536.0] {
                    if ((ratio - size) / size).abs() < 0.25 {
                        return size;
                    }
                }
            }
        }
        4096.0
    }

    /// Read every process. `total_ticks` is the whole server's CPU time over the same interval.
    pub fn sample(&mut self, total_ticks: Option<f64>) {
        let uptime = read_uptime(&self.proc_root);
        let mut list = Vec::new();
        for name in list_dir(&self.proc_root, 100000) {
            if name.is_empty() || !name.bytes().all(|c| c.is_ascii_digit()) {
                continue;
            }
            if let Some(p) = parse_stat(read_text(self.proc_root.join(&name).join("stat")).as_deref()) {
                list.push(p);
            }
        }
        // (readdir order is the kernel's: by pid)
        let mut next = HashMap::new();
        let born_after = self.prev_uptime.map_or(f64::INFINITY, |u| u * HZ);
        let tt = total_ticks.unwrap_or(f64::NAN);
        for p in &mut list {
            let key = format!("{}:{}", p.pid, p.start);
            next.insert(key.clone(), p.ticks);
            let delta = match self.prev.get(&key) {
                Some(b) => Some((p.ticks - b).max(0.0)),
                None if p.start >= born_after => Some(p.ticks),
                None => None,
            };
            p.cpu = delta.filter(|_| tt > 0.0).map(|d| d / tt * 100.0);
            p.mem_b = p.rss_pages * self.page_size.unwrap_or(4096.0);
        }
        self.prev = next;
        self.prev_uptime = uptime;
        self.uptime = uptime;
        self.by_pid = list.iter().enumerate().map(|(i, p)| (p.pid, i)).collect();
        self.list = list;
        // the app and everything below it (ffmpeg, ffprobe, helpers)
        let mut children: HashMap<i64, Vec<i64>> = HashMap::new();
        for p in &self.list {
            children.entry(p.ppid).or_default().push(p.pid);
        }
        let mut app = Vec::new();
        let mut set = HashSet::new();
        if self.by_pid.contains_key(&self.app_pid) {
            let mut stack = vec![self.app_pid];
            while let Some(pid) = stack.pop() {
                if !set.insert(pid) {
                    continue;
                }
                app.push(pid);
                for c in children.get(&pid).into_iter().flatten() {
                    stack.push(*c);
                }
            }
        }
        self.app = app;
        self.app_set = set;
        self.count_reaped(total_ticks);
        // status has the exact resident size in kB, whatever the page size
        for pid in self.app.clone() {
            if let Some(kb) = parse_key_values(read_text(self.proc_root.join(format!("{pid}/status"))).as_deref()).get("VmRSS").copied().filter(|x| x.is_finite()) {
                if let Some(i) = self.by_pid.get(&pid) {
                    self.list[*i].mem_b = kb * 1024.0;
                }
            }
        }
    }

    /// A child that ended since the last pass is gone from /proc; the kernel
    /// adds its whole time to the app's cutime/cstime when it is reaped.
    fn count_reaped(&mut self, total_ticks: Option<f64>) {
        let app_p = self.get(self.app_pid).cloned();
        let mut kids = HashMap::new();
        for p in &self.list {
            if p.ppid == self.app_pid {
                kids.insert(format!("{}:{}", p.pid, p.start), (p.ticks, p.child_ticks, is_ffmpeg(&p.comm)));
            }
        }
        let (mut ticks, mut ff) = (0.0, 0.0);
        if let (Some(app_p), Some(prev_kids), Some(prev_child)) = (&app_p, &self.prev_kids, self.prev_app_child_ticks) {
            let added = app_p.child_ticks - prev_child;
            let (mut seen, mut gone_ff, mut gone) = (0.0, 0.0, 0.0);
            for (key, k) in prev_kids {
                if kids.contains_key(key) {
                    continue;
                }
                gone += 1.0;
                seen += k.0 + k.1;
                if k.2 {
                    gone_ff += 1.0;
                }
            }
            if gone > 0.0 && added > seen {
                ticks = added - seen;
                ff = if gone == gone_ff { ticks } else { 0.0 };
                if gone_ff > 0.0 && gone != gone_ff {
                    ff = js_round(ticks * gone_ff / gone);
                }
            }
        }
        self.prev_kids = Some(kids);
        self.prev_app_child_ticks = app_p.map(|p| p.child_ticks);
        let pct = |t: f64| total_ticks.filter(|tt| *tt > 0.0).map(|tt| t / tt * 100.0);
        self.reaped = Reaped { ticks, ffmpeg_ticks: ff, cpu: pct(ticks), ffmpeg_cpu: pct(ff) };
    }

    /// The app's descendants (not the app itself): the processes that may hold a GPU.
    pub fn descendants(&self) -> Vec<Proc> {
        self.app.iter().filter(|p| **p != self.app_pid).filter_map(|p| self.get(*p).cloned()).collect()
    }

    /// When the app started, in seconds since boot (for its uptime).
    pub fn app_start_s(&self) -> Option<f64> {
        self.get(self.app_pid).map(|p| p.start / HZ)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn stat_line(pid: i64, comm: &str, ppid: i64, utime: i64, stime: i64, cutime: i64, start: i64, rss: i64) -> String {
        let mut f: Vec<String> = vec![pid.to_string(), format!("({comm})"), "S".into(), ppid.to_string(), pid.to_string(), pid.to_string(), "0".into(), "-1".into(), "4194560".into(), "100".into(), "0".into(), "0".into(), "0".into(), utime.to_string(), stime.to_string(), cutime.to_string(), "0".into(), "20".into(), "0".into(), "1".into(), "0".into(), start.to_string(), "123456789".into(), rss.to_string(), "18446744073709551615".into()];
        while f.len() < 52 {
            f.push("0".into());
        }
        format!("{}\n", f.join(" "))
    }

    #[test]
    fn stat_names_with_brackets_and_spaces() {
        let p = parse_stat(Some(&stat_line(7, "weird ) name", 1, 5, 6, 0, 99, 12))).unwrap();
        assert_eq!((p.pid, p.comm.as_str(), p.state.as_str(), p.ppid, p.ticks, p.child_ticks, p.start, p.rss_pages), (7, "weird ) name", "S", 1, 11.0, 0.0, 99.0, 12.0));
        assert_eq!(parse_stat(Some("garbage")), None);
        assert_eq!(parse_stat(Some("12 (x) S 1")), None);
    }

    // test/stats.test.js "an ffmpeg that ended between two samples still counts"
    #[test]
    fn an_ffmpeg_that_ended_still_counts() {
        let root = std::env::temp_dir().join(format!("lean-reaped-{}", std::process::id()));
        let put = |procs: &[(i64, &str, i64, i64, i64, i64)]| {
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(root.join("uptime"), "500.00 100.00\n").unwrap();
            for (pid, comm, ppid, utime, cutime, start) in procs {
                std::fs::create_dir_all(root.join(pid.to_string())).unwrap();
                std::fs::write(root.join(pid.to_string()).join("stat"), stat_line(*pid, comm, *ppid, *utime, 0, *cutime, *start, 1000)).unwrap();
            }
        };
        let mut table = ProcessTable::new(&root, 10);
        put(&[(10, "node", 1, 100, 0, 50), (11, "ffmpeg", 10, 1000, 0, 60)]);
        table.sample(Some(200.0));
        put(&[(10, "node", 1, 100, 1150, 50), (12, "ffmpeg", 10, 30, 0, 49990)]);
        table.sample(Some(200.0));
        assert_eq!(table.reaped.ticks, 150.0);
        assert_eq!(table.reaped.ffmpeg_ticks, 150.0);
        assert_eq!(table.reaped.ffmpeg_cpu.unwrap().round(), 75.0);
        put(&[(10, "node", 1, 100, 1150, 50), (12, "ffmpeg", 10, 60, 0, 49990)]);
        table.sample(Some(200.0));
        assert_eq!(table.reaped.ticks, 0.0);
        let _ = std::fs::remove_dir_all(&root);
    }
}
