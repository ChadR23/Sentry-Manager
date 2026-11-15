//! Walk a footage root (a port of server/scanner.js): directory listings
//! and one stat per file, never opening a video. Network shares make every
//! call a round trip, so folders and batches of stats run on a few threads.
//!
//! A light rescan gets the previous scan's files and folder times: a folder
//! whose modified time is unchanged keeps what it knew of its files (except
//! files changed in the last two hours: one still being copied grows
//! without touching its folder), so a quiet share costs one listing per
//! folder instead of a stat per file.
//!
//! The files come back in the order the Node server sees them, which decides
//! the order of recordings that start at the same time and which clip
//! stands for an event without a front camera. Node lists each folder
//! sorted by name (libuv's scandir sorts with strcmp), queues one folder
//! read and one stat per entry in that order, and keeps each file when its
//! stat answers: a breadth-first walk, with files kept from the last scan
//! taken the moment their folder is listed. Its stats run in parallel, so
//! now and then an answer comes early; this is the order it gives when
//! they answer in turn, which is what it gives most of the time.

use crate::footage::{self, Class};
use std::collections::{HashMap, VecDeque};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::{Condvar, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const RECENT_MS: f64 = 2.0 * 3600.0 * 1000.0;
const STAT_BATCH: usize = 64;

#[derive(Debug, Clone)]
pub struct FileEntry {
    pub rel: String,
    pub size: u64,
    pub mtime_ms: f64,
    pub ctime_ms: f64,
    /// when it reached the share (statx birth time; 0 where the file system has none)
    pub birthtime_ms: f64,
    pub kind: footage::Kind,
    pub typ: &'static str,
    pub day: String,
    pub camera: Option<String>,
    pub event_id: Option<String>,
}

#[derive(Default)]
pub struct Previous {
    pub files: HashMap<String, FileEntry>,
    pub dirs: HashMap<String, f64>,
    /// when the scan these come from started (scanner.js previous.startedMs)
    pub started_ms: Option<f64>,
}

pub struct ScanResult {
    pub files: Vec<FileEntry>,
    pub dirs: HashMap<String, f64>,
    pub errors: Vec<(String, String)>,
    pub reused: usize,
    pub started_at: f64,
    pub scanned_at: f64,
    pub duration_ms: f64,
}

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// Node's stat time in ms: seconds * 1000 + nanoseconds / 1e6, in doubles.
pub fn ms_of(sec: i64, nsec: i64) -> f64 {
    sec as f64 * 1000.0 + nsec as f64 / 1e6
}

enum Task {
    Dir(String),
    Stat(Vec<(String, Class)>),
}

struct Queue {
    tasks: VecDeque<Task>,
    busy: usize,
}

/// A folder's entries that take part in the scan, in Node's order.
enum Child {
    Dir(String),
    Stat(String),
    Kept(String),
}

#[derive(Default)]
struct Out {
    files: Vec<FileEntry>,
    tree: HashMap<String, Vec<Child>>,
    dirs: HashMap<String, f64>,
    errors: Vec<(String, String)>,
    reused: usize,
}

fn entry(rel: String, md: &std::fs::Metadata, c: Class) -> FileEntry {
    let mtime_ms = ms_of(md.mtime(), md.mtime_nsec());
    let day = c.day.unwrap_or_else(|| footage::local_day(mtime_ms));
    FileEntry { rel, size: md.size(), mtime_ms, ctime_ms: ms_of(md.ctime(), md.ctime_nsec()), birthtime_ms: birth_ms(md), kind: c.kind, typ: c.typ, day, camera: c.camera, event_id: c.event_id }
}

/// Node's birthtimeMs: the statx birth time, 0 without one.
fn birth_ms(md: &std::fs::Metadata) -> f64 {
    md.created().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0.0, |d| ms_of(d.as_secs() as i64, d.subsec_nanos() as i64))
}

pub fn scan(root: &Path, previous: Option<&Previous>, concurrency: usize) -> ScanResult {
    let started = now_ms();
    // "the last two hours" reach back from when the previous scan started (the first after a restart)
    let recent_from = started.min(previous.and_then(|p| p.started_ms).unwrap_or(started)) - RECENT_MS;
    let queue = Mutex::new(Queue { tasks: VecDeque::from([Task::Dir(String::new())]), busy: 0 });
    let wake = Condvar::new();
    let out = Mutex::new(Out::default());

    let visit_dir = |rel: String, more: &mut Vec<Task>| {
        let abs = root.join(&rel);
        let mtime = std::fs::metadata(&abs).ok().map(|m| ms_of(m.mtime(), m.mtime_nsec()));
        let list = match std::fs::read_dir(&abs) {
            Ok(l) => l,
            Err(e) => {
                out.lock().unwrap().errors.push((if rel.is_empty() { ".".into() } else { rel }, e.to_string()));
                return;
            }
        };
        if let Some(m) = mtime {
            out.lock().unwrap().dirs.insert(rel.clone(), m);
        }
        let unchanged = previous.filter(|p| mtime.is_some() && p.dirs.get(&rel) == mtime.as_ref());
        let mut batch = Vec::new();
        let mut kept = Vec::new();
        let mut children = Vec::new();
        let mut list: Vec<(String, std::fs::DirEntry)> = list.flatten().filter_map(|e| e.file_name().into_string().ok().map(|n| (n, e))).collect();
        // (libuv: strcmp, the bytes of the names)
        list.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        for (name, ent) in list {
            let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let Ok(ft) = ent.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if !footage::should_skip_dir(&name) {
                    children.push(Child::Dir(child.clone()));
                    more.push(Task::Dir(child));
                }
                continue;
            }
            if !ft.is_file() || footage::is_converter_artifact(&name) {
                continue;
            }
            let Some(class) = footage::classify(&child) else { continue };
            if let Some(known) = unchanged.and_then(|p| p.files.get(&child)) {
                if known.mtime_ms < recent_from {
                    children.push(Child::Kept(child));
                    kept.push(known.clone());
                    continue;
                }
            }
            children.push(Child::Stat(child.clone()));
            batch.push((child, class));
            if batch.len() == STAT_BATCH {
                more.push(Task::Stat(std::mem::take(&mut batch)));
            }
        }
        if !batch.is_empty() {
            more.push(Task::Stat(batch));
        }
        let mut o = out.lock().unwrap();
        o.tree.insert(rel, children);
        if !kept.is_empty() {
            o.reused += kept.len();
            o.files.extend(kept);
        }
    };
    let stat_files = |batch: Vec<(String, Class)>| {
        let mut done = Vec::with_capacity(batch.len());
        let mut errors = Vec::new();
        for (rel, class) in batch {
            match std::fs::metadata(root.join(&rel)) {
                Ok(md) => done.push(entry(rel, &md, class)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => errors.push((rel, e.to_string())),
            }
        }
        let mut o = out.lock().unwrap();
        o.files.extend(done);
        o.errors.extend(errors);
    };

    std::thread::scope(|s| {
        for _ in 0..concurrency.max(1) {
            s.spawn(|| loop {
                let task = {
                    let mut q = queue.lock().unwrap();
                    loop {
                        if let Some(t) = q.tasks.pop_front() {
                            q.busy += 1;
                            break Some(t);
                        }
                        if q.busy == 0 {
                            break None;
                        }
                        q = wake.wait(q).unwrap();
                    }
                };
                let Some(task) = task else {
                    wake.notify_all();
                    return;
                };
                let mut more = Vec::new();
                match task {
                    Task::Dir(rel) => visit_dir(rel, &mut more),
                    Task::Stat(b) => stat_files(b),
                }
                let mut q = queue.lock().unwrap();
                q.tasks.extend(more);
                q.busy -= 1;
                wake.notify_all();
            });
        }
    });

    let mut o = out.into_inner().unwrap();
    let files = node_order(o.files, &mut o.tree);
    ScanResult { files, dirs: o.dirs, errors: o.errors, reused: o.reused, started_at: started, scanned_at: now_ms(), duration_ms: now_ms() - started }
}

/// The files in the order the Node server's scan sees them (see the top of this file).
fn node_order(mut files: Vec<FileEntry>, tree: &mut HashMap<String, Vec<Child>>) -> Vec<FileEntry> {
    let mut seq: HashMap<String, usize> = HashMap::with_capacity(files.len());
    let seen = |rel: String, seq: &mut HashMap<String, usize>| {
        let n = seq.len();
        seq.entry(rel).or_insert(n);
    };
    let mut queue: VecDeque<Child> = VecDeque::from([Child::Dir(String::new())]);
    while let Some(item) = queue.pop_front() {
        match item {
            Child::Dir(rel) => {
                for c in tree.remove(&rel).unwrap_or_default() {
                    match c {
                        Child::Kept(r) => seen(r, &mut seq),
                        other => queue.push_back(other),
                    }
                }
            }
            Child::Stat(r) | Child::Kept(r) => seen(r, &mut seq),
        }
    }
    files.sort_by_key(|f| seq.get(&f.rel).copied().unwrap_or(usize::MAX));
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_come_in_node_order() {
        let root = std::env::temp_dir().join(format!("lean-scan-order-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        // made in another order than the names
        for rel in [
            "T/SentryClips/2025-01-01_10-09-00/2025-01-01_10-00-00-front.mp4",
            "T/RecentClips/2025-01-02_10-00-00-front.mp4",
            "T/RecentClips/2025-01-02/2025-01-02_10-00-00-front.mp4",
            "T/SentryClips/2025-01-01_10-01-00/2025-01-01_10-00-00-back.mp4",
            "T/SentryClips/2025-01-01_10-01-00/2025-01-01_10-00-00-front.mp4",
            "T/Other/2025-01-02_10-00-00-front.mp4",
        ] {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"x").unwrap();
        }
        let order = |res: &ScanResult| res.files.iter().map(|f| f.rel.as_str()).collect::<Vec<_>>().join(" ");
        // folder by folder, each in name order: a folder's own files before those of its subfolders
        let want = "T/Other/2025-01-02_10-00-00-front.mp4 T/RecentClips/2025-01-02_10-00-00-front.mp4 \
            T/RecentClips/2025-01-02/2025-01-02_10-00-00-front.mp4 T/SentryClips/2025-01-01_10-01-00/2025-01-01_10-00-00-back.mp4 \
            T/SentryClips/2025-01-01_10-01-00/2025-01-01_10-00-00-front.mp4 T/SentryClips/2025-01-01_10-09-00/2025-01-01_10-00-00-front.mp4";
        let first = scan(&root, None, 4);
        assert_eq!(order(&first), want);
        // a light rescan: files kept from the last scan come when their folder is listed
        let prev = Previous {
            files: first.files.iter().map(|f| (f.rel.clone(), FileEntry { mtime_ms: 0.0, ..f.clone() })).collect(),
            dirs: first.dirs.clone(),
            started_ms: None,
        };
        let again = scan(&root, Some(&prev), 4);
        assert_eq!(again.reused, 6);
        assert_eq!(order(&again), want);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
