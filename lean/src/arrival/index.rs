//! What was recorded, per car (arrivalChecksums.js index / save): the same
//! files Node keeps under `<DATA>/arrival-checksums/`:
//!
//!   <vehicle id>.json  {"v":2,"dirs":{"<folder>":{"<name>":[size,mtimeMs,ino,at,kind]}}}
//!   <vehicle id>.log   one JSON array a line: ["<rel>",size,mtimeMs,ino,at,kind] or ["<rel>"]
//!
//! kind: 'h' hashed (a line written), 'c' our conversion's output, 's'
//! skipped (encoded, not ours). A v1 snapshot ({"v":1,"files":{rel:[...]}})
//! is read and rewritten as v2; a torn journal line is skipped and the next
//! save rewrites the snapshot.

use super::js::{self, num};
use indexmap::IndexMap;
use serde_json::{Map, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// [size, mtimeMs, ino, at, kind]
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub size: f64,
    pub mtime_ms: f64,
    /// any JSON value in a file read back (validEntry does not look at it)
    pub ino: Value,
    pub at: f64,
    pub kind: String,
}

impl Entry {
    pub fn new(size: u64, mtime_ms: f64, ino: u64, at: f64, kind: &str) -> Entry {
        Entry { size: size as f64, mtime_ms, ino: num(ino as f64), at, kind: kind.into() }
    }
    /// sameId(e, st)
    pub fn same_id(&self, size: u64, mtime_ms: f64, ino: u64) -> bool {
        self.size == size as f64 && self.mtime_ms == mtime_ms && self.ino.as_f64() == Some(ino as f64)
    }
    pub fn to_values(&self) -> Vec<Value> {
        vec![num(self.size), num(self.mtime_ms), self.ino.clone(), num(self.at), Value::String(self.kind.clone())]
    }
    /// validEntry(e): length 5, numbers at 0, 1 and 3, a string at 4
    pub fn from_values(e: &[Value]) -> Option<Entry> {
        if e.len() != 5 {
            return None;
        }
        let ino = match &e[2] {
            Value::Number(n) => num(n.as_f64()?),
            v => v.clone(),
        };
        Some(Entry { size: e[0].as_f64()?, mtime_ms: e[1].as_f64()?, ino, at: e[3].as_f64()?, kind: e[4].as_str()?.to_string() })
    }
}

/// One journal line (an op): an entry set, or a path gone.
#[derive(Clone, Debug)]
pub enum Op {
    Set(String, Entry),
    Gone(String),
}

impl Op {
    pub fn line(&self) -> String {
        let v = match self {
            Op::Set(rel, e) => {
                let mut a = vec![Value::String(rel.clone())];
                a.extend(e.to_values());
                Value::Array(a)
            }
            Op::Gone(rel) => Value::Array(vec![Value::String(rel.clone())]),
        };
        v.to_string()
    }
}

/// A car's index in memory: rel -> entry (in Map order), the journal's
/// lines on disk, and whether the next save must rewrite the snapshot.
#[derive(Debug, Default)]
pub struct Index {
    pub files: IndexMap<String, Entry>,
    pub journal: usize,
    pub compact: bool,
}

/// toSnapshot
pub fn to_snapshot(files: &IndexMap<String, Entry>) -> Value {
    let mut dirs: IndexMap<String, Map<String, Value>> = IndexMap::new();
    for (rel, e) in files {
        let (d, n) = match rel.rfind('/') {
            Some(i) => (&rel[..i], &rel[i + 1..]),
            None => ("", rel.as_str()),
        };
        dirs.entry(d.to_string()).or_default().insert(n.to_string(), Value::Array(e.to_values()));
    }
    let mut out = Map::new();
    for (d, names) in dirs {
        out.insert(d, Value::Object(js::js_ordered(names)));
    }
    let mut top = Map::new();
    top.insert("v".into(), serde_json::json!(2));
    top.insert("dirs".into(), Value::Object(js::js_ordered(out)));
    Value::Object(top)
}

/// fromSnapshot: the entries of a v1 or v2 snapshot, or None.
pub fn from_snapshot(raw: &Value) -> Option<IndexMap<String, Entry>> {
    let mut files = IndexMap::new();
    let v = raw.get("v").and_then(Value::as_f64);
    if v == Some(2.0) {
        if let Some(dirs) = raw.get("dirs").filter(|d| d.is_object() || d.is_array()) {
            for (d, names) in js_entries(dirs) {
                if !(names.is_object() || names.is_array()) {
                    continue;
                }
                for (n, e) in js_entries(&names) {
                    if let Some(e) = e.as_array().and_then(|a| Entry::from_values(a)) {
                        files.insert(if d.is_empty() { n } else { format!("{d}/{n}") }, e);
                    }
                }
            }
            return Some(files);
        }
    }
    if v == Some(1.0) {
        if let Some(fl) = raw.get("files").filter(|d| d.is_object() || d.is_array()) {
            for (rel, e) in js_entries(fl) {
                if let Some(e) = e.as_array().and_then(|a| Entry::from_values(a)) {
                    files.insert(rel, e);
                }
            }
            return Some(files);
        }
    }
    None
}

/// Object.entries of an object (or an array) in JS order.
fn js_entries(v: &Value) -> Vec<(String, Value)> {
    match v {
        Value::Object(m) => js::js_ordered(m.clone()).into_iter().collect(),
        Value::Array(a) => a.iter().enumerate().map(|(i, x)| (i.to_string(), x.clone())).collect(),
        _ => Vec::new(),
    }
}

pub struct Files {
    pub dir: PathBuf,
}

impl Files {
    fn base(&self, vid: &str) -> PathBuf {
        self.dir.join(js::file_base(vid))
    }
    pub fn snapshot(&self, vid: &str) -> PathBuf {
        PathBuf::from(format!("{}.json", self.base(vid).display()))
    }
    pub fn journal(&self, vid: &str) -> PathBuf {
        PathBuf::from(format!("{}.log", self.base(vid).display()))
    }

    /// index(vid): the snapshot, then the journal's changes.
    pub fn load(&self, vid: &str) -> Index {
        let mut files = None;
        let mut compact = false;
        if let Ok(bytes) = fs::read(self.snapshot(vid)) {
            if let Ok(raw) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)) {
                files = from_snapshot(&raw);
                compact = files.is_some() && raw.get("v").and_then(Value::as_f64) != Some(2.0);
            }
        }
        let mut files = files.unwrap_or_default();
        let mut journal = 0;
        if let Ok(bytes) = fs::read(self.journal(vid)) {
            let text = String::from_utf8_lossy(&bytes);
            if !text.is_empty() && !text.ends_with('\n') {
                compact = true; // torn: rewrite before appending again
            }
            for line in text.split('\n') {
                if line.is_empty() {
                    continue;
                }
                let Ok(op) = serde_json::from_str::<Value>(line) else {
                    compact = true;
                    continue;
                };
                let Some(a) = op.as_array() else { continue };
                let Some(rel) = a.first().and_then(Value::as_str) else { continue };
                journal += 1;
                if a.len() == 1 {
                    files.shift_remove(rel);
                } else if let Some(e) = Entry::from_values(&a[1..]) {
                    files.insert(rel.to_string(), e);
                }
            }
        }
        Index { files, journal, compact }
    }

    /// writeSnapshot: a temporary file renamed over the snapshot; the journal before it is spent.
    pub fn write_snapshot(&self, vid: &str, idx: &mut Index) -> std::io::Result<()> {
        let target = self.snapshot(vid);
        let tmp = PathBuf::from(format!("{}.tmp-{}", target.display(), random_hex(4)));
        let r = fs::write(&tmp, to_snapshot(&idx.files).to_string()).and_then(|_| fs::rename(&tmp, &target));
        if let Err(e) = r {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
        let _ = fs::remove_file(self.journal(vid));
        idx.journal = 0;
        idx.compact = false;
        Ok(())
    }

    pub fn append(&self, vid: &str, ops: &[Op]) -> std::io::Result<()> {
        let text = ops.iter().map(Op::line).collect::<Vec<_>>().join("\n") + "\n";
        let mut f = fs::OpenOptions::new().append(true).create(true).open(self.journal(vid))?;
        f.write_all(text.as_bytes())
    }

    pub fn exists(&self, vid: &str) -> bool {
        Path::new(&self.snapshot(vid)).exists()
    }
}

fn random_hex(bytes: usize) -> String {
    use rand_core::RngCore;
    let mut b = vec![0u8; bytes];
    rand_core::OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snapshot_by_folder_in_js_key_order() {
        let mut files = IndexMap::new();
        files.insert("RecentClips/2026-11-08/b.mp4".to_string(), Entry::new(10, 1762646400123.4567, 77, 1762646400000.0, "h"));
        files.insert("top.mp4".to_string(), Entry::new(1, 2.0, 3, 4.0, "s"));
        files.insert("RecentClips/2026-11-08/a.mp4".to_string(), Entry::new(11, 5.5, 78, 6.0, "c"));
        files.insert("7/1".to_string(), Entry::new(1, 1.0, 1, 1.0, "h"));
        let s = to_snapshot(&files).to_string();
        assert_eq!(
            s,
            r#"{"v":2,"dirs":{"7":{"1":[1,1,1,1,"h"]},"RecentClips/2026-11-08":{"b.mp4":[10,1762646400123.4568,77,1762646400000,"h"],"a.mp4":[11,5.5,78,6,"c"]},"":{"top.mp4":[1,2,3,4,"s"]}}}"#
        );
        let back = from_snapshot(&serde_json::from_str(&s).unwrap()).unwrap();
        assert_eq!(back.len(), 4);
        assert_eq!(back["RecentClips/2026-11-08/b.mp4"].mtime_ms, 1762646400123.4567);
        let v1 = from_snapshot(&json!({ "v": 1, "files": { "x.mp4": [1, 2, 3, 4, "h"], "bad": [1, 2] } })).unwrap();
        assert_eq!(v1.len(), 1);
        assert!(from_snapshot(&json!({ "v": 3 })).is_none());
        assert_eq!(Op::Gone("a\"b".into()).line(), r#"["a\"b"]"#);
    }
}
