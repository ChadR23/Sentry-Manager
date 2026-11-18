//! src/main/converter/convertedIndex.js: which clips are H.265 / AV1
//! already, so discovery skips them without opening them. An entry counts
//! only while the file has the size, modification time (and inode, when
//! both sides know it) it had when recorded. Losing the file costs speed,
//! never correctness: a damaged one starts over. The file is Node's
//! (`<data>/converter-index/converted-clips.json`, the same JSON).

use super::jobstore::normalize::num;
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

pub const VERSION: i64 = 1;
const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
pub const KEEP_UNSEEN_DAYS: i64 = 30;
pub const MAX_ENTRIES: usize = 250_000;
pub const FLUSH_DELAY_MS: u64 = 5_000;

fn is_codec(c: &str) -> bool {
    c == "h265" || c == "av1"
}

/// inodeOf(value): a positive inode as its decimal text
pub fn inode_of(v: &Value) -> Option<String> {
    match v {
        Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                if u == 0 {
                    return None;
                }
                // (a JS number past 2^53 prints as its nearest double)
                if u > 9_007_199_254_740_991 {
                    return Some(super::super::ops::js::num_text(u as f64));
                }
                return Some(u.to_string());
            }
            let f = n.as_f64()?;
            if f.is_finite() && f > 0.0 {
                Some(super::super::ops::js::num_text(f))
            } else {
                None
            }
        }
        Value::String(s) => {
            if !s.is_empty() && s.len() <= 32 && s.bytes().all(|b| b.is_ascii_digit()) && !s.bytes().all(|b| b == b'0') {
                Some(s.clone())
            } else {
                None
            }
        }
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq)]
struct Entry {
    size: i64,
    mtime_ms: f64,
    ino: Option<String>,
    codec: String,
    seen: i64,
}

struct Inner {
    entries: IndexMap<String, Entry>,
    dirty: bool,
    scheduled: bool,
    last_write_ms: u64,
    closed: bool,
    writing: bool,
}

pub struct Options {
    pub file: PathBuf,
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
    pub flush_delay_ms: u64,
    pub keep_unseen_days: i64,
    pub max_entries: usize,
    /// for tests: the rename step (a failure keeps the changes for the next flush)
    pub rename: Option<Arc<dyn Fn(&Path, &Path) -> std::io::Result<()> + Send + Sync>>,
}

impl Options {
    pub fn new(file: PathBuf) -> Options {
        Options { file, now: Arc::new(|| super::jobstore::now_ms() as f64), flush_delay_ms: FLUSH_DELAY_MS, keep_unseen_days: KEEP_UNSEEN_DAYS, max_entries: MAX_ENTRIES, rename: None }
    }
}

pub struct ConvertedIndex {
    o: Options,
    st: Mutex<Inner>,
    cv: Condvar,
    writes: std::sync::atomic::AtomicU64,
}

/// A discovered clip as the index reads it: { sourcePath, sourceBytes, mtimeMs, ino? }
pub fn key_of(item: &Value) -> Option<String> {
    let p = item.get("sourcePath").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    Some(super::owned::resolve(Path::new(p)).to_string_lossy().to_string())
}

impl ConvertedIndex {
    pub fn new(o: Options) -> Arc<ConvertedIndex> {
        Arc::new(ConvertedIndex { o, st: Mutex::new(Inner { entries: IndexMap::new(), dirty: false, scheduled: false, last_write_ms: 0, closed: false, writing: false }), cv: Condvar::new(), writes: Default::default() })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.st.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn today(&self) -> i64 {
        ((self.o.now)() / DAY_MS).floor() as i64
    }

    /// how many writes reached the disk (tests)
    pub fn writes(&self) -> u64 {
        self.writes.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn load(&self) -> usize {
        let mut s = self.lock();
        s.entries.clear();
        let Ok(text) = std::fs::read_to_string(&self.o.file) else { return 0 };
        let Ok(stored) = serde_json::from_str::<Value>(&text) else { return 0 };
        if stored.get("v").and_then(Value::as_f64) != Some(VERSION as f64) {
            return 0;
        }
        let Some(entries) = stored.get("entries").and_then(Value::as_object) else { return 0 };
        for (key, value) in entries {
            let Some(a) = value.as_array().filter(|a| a.len() == 5) else { continue };
            let size = super::jobstore::normalize::safe_int_of(&a[0]);
            let mtime = a[1].as_f64();
            let codec = a[3].as_str();
            let seen = super::jobstore::normalize::safe_int_of(&a[4]);
            let (Some(size), Some(mtime), Some(codec), Some(seen)) = (size.filter(|s| *s >= 0), mtime.filter(|m| m.is_finite()), codec.filter(|c| is_codec(c)), seen) else { continue };
            if !Path::new(key).is_absolute() {
                continue;
            }
            s.entries.insert(key.clone(), Entry { size, mtime_ms: mtime, ino: inode_of(&a[2]), codec: codec.into(), seen });
        }
        s.entries.len()
    }

    /// 'h265' / 'av1' when the clip is recorded as converted and unchanged
    pub fn has(&self, item: &Value) -> Option<String> {
        let key = key_of(item)?;
        let day = self.today();
        let mut s = self.lock();
        let entry = s.entries.get(&key)?.clone();
        let ino = item.get("ino").and_then(inode_of);
        let size = item.get("sourceBytes").and_then(Value::as_f64);
        let mtime = item.get("mtimeMs").and_then(Value::as_f64);
        if Some(entry.size as f64) != size || Some(entry.mtime_ms) != mtime || matches!((&entry.ino, &ino), (Some(a), Some(b)) if a != b) {
            s.entries.shift_remove(&key);
            s.dirty = true;
            return None;
        }
        if entry.seen != day {
            s.entries.get_mut(&key).unwrap().seen = day;
            s.dirty = true;
        }
        Some(entry.codec)
    }

    pub fn add(self: &Arc<Self>, item: &Value, codec: &str) -> bool {
        let Some(key) = key_of(item) else { return false };
        let size = item.get("sourceBytes").and_then(|v| super::jobstore::normalize::safe_int_of(v));
        let mtime = item.get("mtimeMs").and_then(Value::as_f64).filter(|m| m.is_finite());
        let (Some(size), Some(mtime), true) = (size.filter(|s| *s >= 0), mtime, is_codec(codec)) else { return false };
        let entry = Entry { size, mtime_ms: mtime, ino: item.get("ino").and_then(inode_of), codec: codec.into(), seen: self.today() };
        {
            let mut s = self.lock();
            s.entries.insert(key, entry);
            s.dirty = true;
        }
        self.schedule();
        true
    }

    /// batched: a run that records thousands of clips writes every few seconds
    fn schedule(self: &Arc<Self>) {
        let delay = {
            let mut s = self.lock();
            if s.scheduled || s.closed {
                return;
            }
            s.scheduled = true;
            self.o.flush_delay_ms.max(s.last_write_ms * 10)
        };
        let me = Arc::downgrade(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(delay));
            if let Some(me) = me.upgrade() {
                let scheduled = std::mem::replace(&mut me.lock().scheduled, false);
                if scheduled {
                    me.flush();
                }
            }
        });
    }

    fn snapshot(&self, s: &mut Inner) -> Value {
        let oldest = self.today() - self.o.keep_unseen_days;
        let mut kept: Vec<(String, Entry)> = s.entries.iter().filter(|(_, e)| e.seen >= oldest).map(|(k, e)| (k.clone(), e.clone())).collect();
        if kept.len() > self.o.max_entries {
            // (Array.prototype.sort is stable)
            kept.sort_by(|a, b| b.1.seen.cmp(&a.1.seen));
            kept.truncate(self.o.max_entries);
        }
        if kept.len() != s.entries.len() {
            let keep: std::collections::HashSet<&String> = kept.iter().map(|(k, _)| k).collect();
            s.entries.retain(|k, _| keep.contains(k));
        }
        let mut out = Map::new();
        for (k, e) in kept {
            out.insert(k, json!([e.size, num(e.mtime_ms), e.ino.map(Value::from).unwrap_or(Value::Null), e.codec, e.seen]));
        }
        json!({ "v": VERSION, "entries": Value::Object(out) })
    }

    /// Writes pending changes (temp file + rename); true when nothing is left to write.
    pub fn flush(&self) -> bool {
        let mut s = self.lock();
        while s.writing {
            s = self.cv.wait(s).unwrap_or_else(|p| p.into_inner());
        }
        s.scheduled = false;
        if !s.dirty {
            return true;
        }
        s.dirty = false;
        s.writing = true;
        let text = self.snapshot(&mut s).to_string();
        drop(s);
        let started = (self.o.now)();
        let temporary = PathBuf::from(format!("{}.tmp", self.o.file.to_string_lossy()));
        let r = (|| -> std::io::Result<()> {
            if let Some(parent) = self.o.file.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&temporary, &text)?;
            match &self.o.rename {
                Some(f) => f(&temporary, &self.o.file),
                None => std::fs::rename(&temporary, &self.o.file),
            }
        })();
        let mut s = self.lock();
        s.writing = false;
        let ok = r.is_ok();
        if ok {
            s.last_write_ms = ((self.o.now)() - started).max(0.0) as u64;
            self.writes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        } else {
            s.dirty = true;
        }
        self.cv.notify_all();
        ok
    }

    pub fn close(&self) {
        self.lock().closed = true;
        self.flush();
    }

    pub fn size(&self) -> usize {
        self.lock().entries.len()
    }
}

#[cfg(test)]
mod tests {
    //! test/convertedIndex.test.js
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    const DAY: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

    fn clip(name: &str, extra: Value) -> Value {
        let mut v = json!({ "sourcePath": format!("/footage/TeslaCam/SentryClips/2026-10-20_07-44-14/{name}"), "sourceBytes": 1234567, "mtimeMs": 1760946254123.4567 });
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    }

    fn idx(file: &Path, now: Option<Arc<AtomicU64>>, delay: u64, max: usize) -> Arc<ConvertedIndex> {
        let mut o = Options::new(file.to_path_buf());
        o.flush_delay_ms = delay;
        o.max_entries = max;
        if let Some(n) = now {
            o.now = Arc::new(move || n.load(Ordering::SeqCst) as f64);
        }
        ConvertedIndex::new(o)
    }

    #[test]
    fn round_trip_and_changed_files() {
        let d = crate::converter::testutil::tempdir().unwrap();
        let file = d.path().join("converter-index/converted-clips.json");
        let index = idx(&file, None, 60_000, MAX_ENTRIES);
        assert_eq!(index.load(), 0);
        assert!(index.add(&clip("a-front.mp4", json!({ "ino": 42 })), "h265"));
        assert!(index.add(&clip("a-back.mp4", json!({})), "av1"));
        assert!(!index.add(&clip("a-left.mp4", json!({})), "h264"));
        assert!(index.flush());
        let names: Vec<String> = std::fs::read_dir(file.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names, vec!["converted-clips.json"]);
        let re = idx(&file, None, 60_000, MAX_ENTRIES);
        assert_eq!(re.load(), 2);
        assert_eq!(re.has(&clip("a-front.mp4", json!({ "ino": 42 }))).as_deref(), Some("h265"));
        assert_eq!(re.has(&clip("a-back.mp4", json!({}))).as_deref(), Some("av1"));
        assert_eq!(re.has(&clip("a-left.mp4", json!({}))), None);
        assert_eq!(re.has(&json!({})), None);

        let index = idx(&file, None, 60_000, MAX_ENTRIES);
        index.load();
        for n in ["size.mp4", "time.mp4", "inode.mp4", "same.mp4", "no-inode.mp4"] {
            index.add(&clip(n, json!({ "ino": 7 })), "h265");
        }
        assert_eq!(index.has(&clip("size.mp4", json!({ "ino": 7, "sourceBytes": 1234568 }))), None);
        assert_eq!(index.has(&clip("time.mp4", json!({ "ino": 7, "mtimeMs": 1760946254124.4567 }))), None);
        assert_eq!(index.has(&clip("inode.mp4", json!({ "ino": 8 }))), None);
        assert_eq!(index.has(&clip("same.mp4", json!({ "ino": 7 }))).as_deref(), Some("h265"));
        assert_eq!(index.has(&clip("no-inode.mp4", json!({}))).as_deref(), Some("h265"));
        assert_eq!(index.has(&clip("size.mp4", json!({ "ino": 7 }))), None);
        index.flush();
        let re = idx(&file, None, 60_000, MAX_ENTRIES);
        assert_eq!(re.load(), 4, "a-front and a-back from before, same and no-inode");
        assert_eq!(re.has(&clip("time.mp4", json!({ "ino": 7 }))), None);

        // large inodes as text
        let index = idx(&file, None, 60_000, MAX_ENTRIES);
        index.load();
        index.add(&clip("big.mp4", json!({ "ino": "18446744073709551000" })), "h265");
        index.flush();
        let re = idx(&file, None, 60_000, MAX_ENTRIES);
        re.load();
        assert_eq!(re.has(&clip("big.mp4", json!({ "ino": "18446744073709551000" }))).as_deref(), Some("h265"));
        assert_eq!(re.has(&clip("big.mp4", json!({ "ino": "18446744073709551001" }))), None);
    }

    #[test]
    fn unseen_entries_go_and_the_cap_holds() {
        let d = crate::converter::testutil::tempdir().unwrap();
        let file = d.path().join("i.json");
        let now = Arc::new(AtomicU64::new(1_759_276_800_000)); // 2026-10-01
        let index = idx(&file, Some(now.clone()), 5_000, MAX_ENTRIES);
        index.load();
        index.add(&clip("old.mp4", json!({})), "h265");
        index.add(&clip("kept.mp4", json!({})), "h265");
        index.flush();
        now.fetch_add((20.0 * DAY) as u64, Ordering::SeqCst);
        assert_eq!(index.has(&clip("kept.mp4", json!({}))).as_deref(), Some("h265"));
        now.fetch_add((15.0 * DAY) as u64, Ordering::SeqCst);
        index.add(&clip("new.mp4", json!({})), "av1");
        index.flush();
        assert_eq!(index.size(), 2);
        let re = idx(&file, Some(now.clone()), 5_000, MAX_ENTRIES);
        re.load();
        assert_eq!(re.has(&clip("old.mp4", json!({}))), None);
        assert_eq!(re.has(&clip("kept.mp4", json!({}))).as_deref(), Some("h265"));

        let file = d.path().join("cap.json");
        let index = idx(&file, Some(now.clone()), 60_000, 3);
        index.load();
        for n in 0..5 {
            index.add(&clip(&format!("{n}.mp4"), json!({})), "h265");
            now.fetch_add(DAY as u64, Ordering::SeqCst);
        }
        index.flush();
        let re = idx(&file, Some(now.clone()), 60_000, MAX_ENTRIES);
        assert_eq!(re.load(), 3);
        let got: Vec<Option<String>> = (0..5).map(|n| re.has(&clip(&format!("{n}.mp4"), json!({})))).collect();
        assert_eq!(got, vec![None, None, Some("h265".into()), Some("h265".into()), Some("h265".into())]);
    }

    #[test]
    fn one_write_for_many_damaged_files_start_over_and_failed_writes_retry() {
        let d = crate::converter::testutil::tempdir().unwrap();
        let file = d.path().join("i.json");
        let index = idx(&file, None, 60_000, MAX_ENTRIES);
        index.load();
        for n in 0..5000 {
            index.add(&clip(&format!("{n}.mp4"), json!({})), "h265");
        }
        index.flush();
        index.flush();
        assert_eq!(index.writes(), 1);
        for damaged in ["{\"v\":1,\"entries\":", "null", "{\"v\":99,\"entries\":{}}", "{\"v\":1,\"entries\":{\"relative.mp4\":[1,2,null,\"h265\",1]}}"] {
            std::fs::write(&file, damaged).unwrap();
            let re = idx(&file, None, 60_000, MAX_ENTRIES);
            assert_eq!(re.load(), 0, "{damaged}");
        }
        let file = d.path().join("flaky.json");
        let fail = Arc::new(AtomicBool::new(true));
        let mut o = Options::new(file.clone());
        o.flush_delay_ms = 20;
        let f2 = fail.clone();
        o.rename = Some(Arc::new(move |a, b| if f2.load(Ordering::SeqCst) { Err(std::io::Error::from_raw_os_error(libc::ENOSPC)) } else { std::fs::rename(a, b) }));
        let index = ConvertedIndex::new(o);
        index.load();
        index.add(&clip("a.mp4", json!({})), "h265");
        assert!(!index.flush());
        assert!(!file.exists());
        fail.store(false, Ordering::SeqCst);
        index.add(&clip("b.mp4", json!({})), "h265");
        for _ in 0..100 {
            if file.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let re = idx(&file, None, 60_000, MAX_ENTRIES);
        assert_eq!(re.load(), 2);
    }
}
