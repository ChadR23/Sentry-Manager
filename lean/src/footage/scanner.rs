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
use std::collections::{HashMap, HashSet, VecDeque};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
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

/// A scan's files with an index by rel (open addressing over their positions), so they are
/// looked up by rel without a second copy. One file per rel, the last listed, as a map built
/// from the list keeps.
#[derive(Default)]
pub struct FileList {
    files: Vec<FileEntry>,
    slots: Vec<u32>,
}

const EMPTY: u32 = u32::MAX;

fn hash_rel(rel: &str) -> usize {
    let mut h: u64 = 0;
    let (chunks, rest) = rel.as_bytes().as_chunks::<8>();
    for c in chunks {
        h = (h.rotate_left(5) ^ u64::from_le_bytes(*c)).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
    for &b in rest {
        h = (h.rotate_left(5) ^ b as u64).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
    (h ^ (h >> 29)) as usize
}

impl From<Vec<FileEntry>> for FileList {
    fn from(mut files: Vec<FileEntry>) -> FileList {
        files.shrink_to_fit();
        let mask = (files.len() * 2).next_power_of_two().max(2) - 1;
        let mut slots = vec![EMPTY; mask + 1];
        let mut repeated = false;
        'files: for (i, f) in files.iter().enumerate() {
            let mut at = hash_rel(&f.rel) & mask;
            while slots[at] != EMPTY {
                if files[slots[at] as usize].rel == f.rel {
                    repeated = true;
                    break 'files;
                }
                at = (at + 1) & mask;
            }
            slots[at] = i as u32;
        }
        if repeated {
            return FileList::from(once_each(files));
        }
        FileList { files, slots }
    }
}

/// a rel listed again takes the place of the first (as a map's set does)
fn once_each(files: Vec<FileEntry>) -> Vec<FileEntry> {
    let mut at: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<FileEntry> = Vec::with_capacity(files.len());
    for f in files {
        match at.get(&f.rel) {
            Some(&i) => out[i] = f,
            None => {
                at.insert(f.rel.clone(), out.len());
                out.push(f);
            }
        }
    }
    out
}

/// keyed entries in the order given, the key being the rel (as tests build them)
impl FromIterator<(String, FileEntry)> for FileList {
    fn from_iter<I: IntoIterator<Item = (String, FileEntry)>>(it: I) -> FileList {
        FileList::from(it.into_iter().map(|(rel, f)| FileEntry { rel, ..f }).collect::<Vec<_>>())
    }
}

impl std::ops::Deref for FileList {
    type Target = [FileEntry];
    fn deref(&self) -> &[FileEntry] {
        &self.files
    }
}

impl std::fmt::Debug for FileList {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "FileList({} files)", self.files.len())
    }
}

impl FileList {
    pub fn position(&self, rel: &str) -> Option<usize> {
        if self.files.is_empty() {
            return None;
        }
        let mask = self.slots.len() - 1;
        let mut at = hash_rel(rel) & mask;
        loop {
            match self.slots[at] {
                EMPTY => return None,
                i if self.files[i as usize].rel == rel => return Some(i as usize),
                _ => at = (at + 1) & mask,
            }
        }
    }

    pub fn get(&self, rel: &str) -> Option<&FileEntry> {
        self.position(rel).map(|i| &self.files[i])
    }

    pub fn contains_key(&self, rel: &str) -> bool {
        self.position(rel).is_some()
    }

    /// in list order
    pub fn values(&self) -> std::slice::Iter<'_, FileEntry> {
        self.files.iter()
    }
}

#[derive(Default)]
pub struct Previous {
    pub files: Arc<FileList>,
    pub dirs: HashMap<String, f64>,
    /// when the scan these come from started (scanner.js previous.startedMs)
    pub started_ms: Option<f64>,
}

pub struct ScanResult {
    pub files: Vec<FileEntry>,
    pub dirs: HashMap<String, f64>,
    pub errors: Vec<(String, String)>,
    pub unread: Unread,
    /// the folders listed whole
    listed: HashSet<String>,
    /// files listed whose stat found them gone
    gone: HashSet<String>,
    pub reused: usize,
    pub started_at: f64,
    pub scanned_at: f64,
    pub duration_ms: f64,
}

/// What a walk could not read: folders it could not list, or not list whole, and files it
/// could not stat ("" is the root).
#[derive(Default, Debug)]
pub struct Unread {
    pub dirs: HashSet<String>,
    pub files: HashSet<String>,
    /// the root itself could not be listed: the walk saw nothing
    pub root: bool,
}

impl Unread {
    pub fn is_empty(&self) -> bool {
        self.dirs.is_empty() && self.files.is_empty()
    }
}

impl ScanResult {
    /// What an earlier scan saw where this one could not look comes back: the files below a
    /// folder it could not list whole, and the files it could not stat. A file whose nearest
    /// folder this walk listed whole, and did not find, is gone and stays out, as is a file its
    /// stat found gone. The files that come back go at the end, in their earlier order; their
    /// folders' times do not (the next walk lists those folders and stats the files again). How
    /// many came back.
    pub fn keep_unread(&mut self, last: &Previous) -> usize {
        if self.unread.is_empty() {
            return 0;
        }
        let back: Vec<FileEntry> = {
            let have: HashSet<&str> = self.files.iter().map(|f| f.rel.as_str()).collect();
            last.files
                .values()
                .filter(|f| !have.contains(f.rel.as_str()) && !self.gone.contains(&f.rel) && (self.unread.files.contains(&f.rel) || self.below_unread(parent(&f.rel))))
                .cloned()
                .collect()
        };
        let n = back.len();
        self.files.extend(back);
        n
    }

    /// The first error, by path (the walk's threads finish in no set order).
    pub fn first_error(&self) -> &str {
        self.errors.iter().min_by(|a, b| a.0.cmp(&b.0)).map_or("", |(_, e)| e.as_str())
    }

    /// The nearest folder at or above `dir` this walk reached is one it could not list whole.
    fn below_unread(&self, mut dir: &str) -> bool {
        loop {
            if self.unread.dirs.contains(dir) {
                return true;
            }
            if self.listed.contains(dir) || dir.is_empty() {
                return false;
            }
            dir = parent(dir);
        }
    }
}

fn parent(rel: &str) -> &str {
    rel.rfind('/').map_or("", |i| &rel[..i])
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
    unread: Unread,
    listed: HashSet<String>,
    gone: HashSet<String>,
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
                let mut o = out.lock().unwrap();
                o.errors.push((if rel.is_empty() { ".".into() } else { rel.clone() }, e.to_string()));
                o.unread.root |= rel.is_empty();
                o.unread.dirs.insert(rel);
                return;
            }
        };
        let unchanged = previous.filter(|p| mtime.is_some() && p.dirs.get(&rel) == mtime.as_ref());
        let mut batch = Vec::new();
        let mut kept = Vec::new();
        let mut children = Vec::new();
        // (a listing that breaks off, or an entry it cannot tell the type of, reads the folder in part)
        let mut broke: Option<String> = None;
        let mut entries = Vec::new();
        for e in list {
            match e {
                Ok(e) => entries.push(e),
                Err(e) => {
                    broke.get_or_insert(e.to_string());
                }
            }
        }
        let mut list: Vec<(String, std::fs::DirEntry)> = entries.into_iter().filter_map(|e| e.file_name().into_string().ok().map(|n| (n, e))).collect();
        // (libuv: strcmp, the bytes of the names)
        list.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        for (name, ent) in list {
            let child = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let ft = match ent.file_type() {
                Ok(ft) => ft,
                Err(e) => {
                    broke.get_or_insert(e.to_string());
                    continue;
                }
            };
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
        match broke {
            None => {
                if let Some(m) = mtime {
                    o.dirs.insert(rel.clone(), m);
                }
                o.listed.insert(rel.clone());
            }
            Some(e) => {
                o.errors.push((if rel.is_empty() { ".".into() } else { rel.clone() }, e));
                o.unread.dirs.insert(rel.clone());
            }
        }
        o.tree.insert(rel, children);
        if !kept.is_empty() {
            o.reused += kept.len();
            o.files.extend(kept);
        }
    };
    let stat_files = |batch: Vec<(String, Class)>| {
        let mut done = Vec::with_capacity(batch.len());
        let mut errors = Vec::new();
        let mut gone = Vec::new();
        for (rel, class) in batch {
            match std::fs::metadata(root.join(&rel)) {
                Ok(md) => done.push(entry(rel, &md, class)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => gone.push(rel),
                Err(e) => errors.push((rel, e.to_string())),
            }
        }
        let mut o = out.lock().unwrap();
        o.files.extend(done);
        o.gone.extend(gone);
        o.unread.files.extend(errors.iter().map(|(r, _)| r.clone()));
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
    // a folder holding a file whose stat failed is listed and the file stat'ed again next time:
    // its time is not kept for a light scan to trust
    for rel in &o.unread.files {
        o.dirs.remove(parent(rel));
    }
    let files = node_order(o.files, &mut o.tree);
    ScanResult {
        files,
        dirs: o.dirs,
        errors: o.errors,
        unread: o.unread,
        listed: o.listed,
        gone: o.gone,
        reused: o.reused,
        started_at: started,
        scanned_at: now_ms(),
        duration_ms: now_ms() - started,
    }
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

    fn file(rel: &str, size: u64) -> FileEntry {
        FileEntry { rel: rel.into(), size, mtime_ms: 1.0, ctime_ms: 1.0, birthtime_ms: 0.0, kind: footage::Kind::Clip, typ: "RecentClips", day: "2026-11-16".into(), camera: None, event_id: None }
    }

    #[test]
    fn a_file_list_answers_as_a_map_of_it_does() {
        let list = vec![file("b/2.mp4", 2), file("a/1.mp4", 1), file("c/3.mp4", 3), file("a/1.mp4", 4), file("B/0.mp4", 5)];
        let fl = FileList::from(list.clone());
        assert_eq!(fl.iter().map(|f| (f.rel.as_str(), f.size)).collect::<Vec<_>>(), [("b/2.mp4", 2), ("a/1.mp4", 4), ("c/3.mp4", 3), ("B/0.mp4", 5)], "a rel listed again: its last entry, at its first place (a JS Map's set)");
        assert_eq!(fl.values().count(), fl.len());
        for (i, f) in fl.iter().enumerate() {
            assert_eq!(fl.position(&f.rel), Some(i));
            assert!(fl.contains_key(&f.rel) && fl.get(&f.rel).is_some_and(|x| x.size == f.size));
        }
        let many: Vec<FileEntry> = (0..5000).map(|i| file(&format!("RecentClips/2026-11-{:02}/2026-11-{:02}_10-{:02}-{:02}-front.mp4", i % 28 + 1, i % 28 + 1, i / 60 % 60, i % 60), i)).collect();
        let big = FileList::from(many.clone());
        assert!(many.iter().enumerate().all(|(i, f)| big.position(&f.rel) == Some(i)));
        assert!(big.get("RecentClips/2026-11-01/nope.mp4").is_none());
        assert!(fl.get("a/0.mp4").is_none() && !fl.contains_key("z") && fl.get("").is_none());
        let from: FileList = list.iter().map(|f| (f.rel.clone(), f.clone())).collect();
        assert_eq!(from.iter().map(|f| f.size).collect::<Vec<_>>(), [2, 4, 3, 5], "pairs keep the order given");
        assert!(FileList::default().is_empty());
    }

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
            files: Arc::new(first.files.iter().map(|f| FileEntry { mtime_ms: 0.0, ..f.clone() }).collect::<Vec<_>>().into()),
            dirs: first.dirs.clone(),
            started_ms: None,
        };
        let again = scan(&root, Some(&prev), 4);
        assert_eq!(again.reused, 6);
        assert_eq!(order(&again), want);
        std::fs::remove_dir_all(&root).unwrap();
    }

    fn walked(files: &[&str], listed: &[&str], unread_dirs: &[&str], unread_files: &[&str]) -> ScanResult {
        ScanResult {
            files: files.iter().map(|r| file(r, 1)).collect(),
            dirs: listed.iter().map(|d| (d.to_string(), 9.0)).collect(),
            errors: Vec::new(),
            unread: Unread { dirs: unread_dirs.iter().map(|d| d.to_string()).collect(), files: unread_files.iter().map(|f| f.to_string()).collect(), root: false },
            listed: listed.iter().map(|d| d.to_string()).collect(),
            gone: HashSet::new(),
            reused: 0,
            started_at: 0.0,
            scanned_at: 0.0,
            duration_ms: 0.0,
        }
    }

    #[test]
    fn what_a_scan_could_not_read_comes_back_as_the_last_scan_saw_it_and_what_went_stays_gone() {
        let last = Previous {
            files: Arc::new(
                ["R/a.mp4", "R/gone.mp4", "S/E1/front.mp4", "S/E1/sub/x.mp4", "S/E2/front.mp4", "S/E3/front.mp4", "V/S1/back.mp4", "V/S1/left.mp4"]
                    .iter()
                    .map(|r| file(r, 2))
                    .collect::<Vec<_>>()
                    .into(),
            ),
            dirs: [("", 1.0), ("R", 1.0), ("S", 1.0), ("S/E1", 2.0), ("S/E1/sub", 3.0), ("S/E2", 4.0), ("S/E3", 1.0), ("V", 1.0), ("V/S1", 1.0)].iter().map(|(d, m)| (d.to_string(), *m)).collect(),
            started_ms: None,
        };
        // S/E1 could not be listed, V/S1/back.mp4 not stat'ed, S/E2 is gone from S, R/gone.mp4 and V/S1/left.mp4 from theirs
        let mut res = walked(&["R/a.mp4", "S/E3/front.mp4"], &["", "R", "S", "S/E3", "V", "V/S1"], &["S/E1"], &["V/S1/back.mp4"]);
        assert_eq!(res.keep_unread(&last), 3);
        let rels: Vec<&str> = res.files.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(rels, ["R/a.mp4", "S/E3/front.mp4", "S/E1/front.mp4", "S/E1/sub/x.mp4", "V/S1/back.mp4"], "after what this scan found, in their earlier order");
        assert_eq!(res.files[0].size, 1, "what this scan read stays as it read it");
        assert!(["S/E1", "S/E1/sub", "S/E2"].iter().all(|d| !res.dirs.contains_key(*d)), "no earlier folder times: the next walk lists those folders again");
        let mut whole = walked(&["R/a.mp4"], &["", "R"], &[], &[]);
        assert_eq!(whole.keep_unread(&last), 0, "a walk that read everything keeps nothing back");
        assert_eq!((whole.files.len(), whole.dirs.len()), (1, 2));
        let mut blind = walked(&[], &[], &[""], &[]);
        assert_eq!(blind.keep_unread(&last), 8, "a root not listed keeps everything");
        assert!(blind.dirs.is_empty());
        // a file its stat found gone stays gone, even in a folder listed in part
        let mut part = walked(&[], &["", "R", "S", "V", "V/S1"], &["S/E1"], &[]);
        part.gone.insert("S/E1/front.mp4".into());
        assert_eq!(part.keep_unread(&last), 1);
        assert_eq!(part.files.iter().map(|f| f.rel.as_str()).collect::<Vec<_>>(), ["S/E1/sub/x.mp4"]);
        let mut err = walked(&[], &[""], &["b", "a"], &[]);
        err.errors = vec![("b".into(), "second".into()), ("a".into(), "first".into())];
        assert_eq!(err.first_error(), "first", "the first error by path, whatever order the threads finished in");
    }

    #[test]
    fn a_folder_or_file_it_cannot_read_an_unreadable_root_and_an_empty_one_are_told_apart() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &Path, m: u32| std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();
        let root = std::env::temp_dir().join(format!("lean-scan-unread-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let empty = scan(&root, None, 2);
        assert!(empty.unread.is_empty() && !empty.unread.root && empty.files.is_empty());
        let shut = root.join("TeslaCam/SentryClips/2026-11-10_07-00-00");
        let blind = root.join("TeslaCam/SavedClips/2026-11-10_09-00-00");
        for (dir, name) in [(&shut, "2026-11-10_06-59-00-front.mp4"), (&blind, "2026-11-10_08-59-00-front.mp4"), (&root.join("TeslaCam/RecentClips"), "2026-11-10_06-00-00-front.mp4")] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        mode(&shut, 0o000);
        // (listed but not searchable: its file's stat fails)
        mode(&blind, 0o444);
        if std::fs::read_dir(&shut).is_ok() {
            // (permissions do not stop root)
            mode(&shut, 0o755);
            mode(&blind, 0o755);
            std::fs::remove_dir_all(&root).unwrap();
            return;
        }
        let res = scan(&root, None, 2);
        assert!(!res.unread.root);
        assert_eq!(res.unread.dirs.iter().collect::<Vec<_>>(), ["TeslaCam/SentryClips/2026-11-10_07-00-00"]);
        assert_eq!(res.unread.files.iter().collect::<Vec<_>>(), ["TeslaCam/SavedClips/2026-11-10_09-00-00/2026-11-10_08-59-00-front.mp4"]);
        assert_eq!(res.files.iter().map(|f| f.rel.as_str()).collect::<Vec<_>>(), ["TeslaCam/RecentClips/2026-11-10_06-00-00-front.mp4"]);
        assert!(!res.dirs.contains_key("TeslaCam/SentryClips/2026-11-10_07-00-00") && res.dirs.contains_key("TeslaCam/SentryClips"));
        assert!(!res.dirs.contains_key("TeslaCam/SavedClips/2026-11-10_09-00-00"), "a folder with a file not stat'ed is not trusted by its time next scan");
        assert_eq!(res.errors.len(), 2);
        mode(&shut, 0o755);
        mode(&blind, 0o755);
        mode(&root, 0o000);
        let res = scan(&root, None, 2);
        mode(&root, 0o755);
        assert!(res.unread.root && res.files.is_empty() && res.dirs.is_empty());
        assert_eq!(scan(&root, None, 2).files.len(), 3);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
