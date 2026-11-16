//! server/originalChecksums.js: the share's checksum record for Sentry USB
//! (docs/sentry-usb.md), the same file Node writes:
//!
//!   <share root>/.sentrymanager/original-checksums.sha256
//!     "<64 lowercase hex>  <relpath>\n" per clip, only appended, fsynced
//!   <share root>/.sentrymanager/original-checksums.marks.json
//!     {"v":1,"marks":[{"day":"YYYY-MM-DD","offset":N}]}: the record's size
//!     when each UTC day's first line was appended (for pruning after 45 days)
//!
//! The share root is the folder above the clip's RecentClips / SentryClips /
//! SavedClips / TeslaTrackMode folder. The converter's before-replace hook
//! and the arrival hasher both write through `Recorder::record`.

use super::js;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const DIR: &str = ".sentrymanager";
pub const FILE: &str = "original-checksums.sha256";
pub const MARKS: &str = "original-checksums.marks.json";
pub const KEEP_DAYS: i64 = 45;
/// prune once the oldest kept day is this much older still
pub const PRUNE_SLACK_DAYS: i64 = 7;

/// The share root and the clip's relpath from there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Located {
    pub root: String,
    pub rel: String,
}

/// locate(source, fallbackRoot): the folder above the nearest group folder
/// above the clip, else the clip under `fallback_root`; None when it is not
/// inside that tree in a usable way.
pub fn locate(source: &str, fallback_root: Option<&str>) -> Option<Located> {
    let abs = js::resolve(source);
    let parts: Vec<&str> = abs.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() >= 2 {
        for i in (0..=parts.len() - 2).rev() {
            if !js::is_group(parts[i]) {
                continue;
            }
            if i == 0 {
                break;
            }
            return Some(Located { root: format!("/{}", parts[..i].join("/")), rel: parts[i..].join("/") });
        }
    }
    match fallback_root {
        Some(f) if !f.is_empty() => under(&abs, f),
        _ => None,
    }
}

fn under(abs: &str, fallback_root: &str) -> Option<Located> {
    let base = js::resolve(fallback_root);
    let rel = js::relative(&base, abs);
    if rel.is_empty() || rel.starts_with("..") || rel.starts_with('/') {
        return None;
    }
    Some(Located { root: base, rel })
}

fn is_sha(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// lineFor: one record line, or Err for a hash that is not one or a path
/// sha256sum would have to escape.
pub fn line_for(sha256: &str, rel: &str) -> Result<String, RecordError> {
    let hash = sha256.to_lowercase();
    if !is_sha(&hash) {
        return Err(RecordError::msg("Not a SHA-256"));
    }
    if rel.is_empty() || rel.contains(['\n', '\r', '\\', '\0']) || rel.starts_with("./") || rel.starts_with('/') {
        return Err(RecordError::msg("Unusable relpath"));
    }
    Ok(format!("{hash}  {rel}\n"))
}

/// parseRecord: the record's lines as (sha256, rel), in order.
pub fn parse_record(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.split('\n') {
        // (line.length counts UTF-16 units; the first 66 are ASCII when it matches)
        let b = line.as_bytes();
        if b.len() > 66 && line.is_char_boundary(64) && is_sha(&line[..64]) && &b[64..66] == b"  " {
            out.push((line[..64].to_string(), line[66..].to_string()));
        }
    }
    out
}

/// An error as Node's: its code (EROFS, ...) when the system gave one, and its message.
#[derive(Clone, Debug)]
pub struct RecordError {
    pub code: Option<String>,
    pub message: String,
}

impl RecordError {
    pub fn msg(m: &str) -> RecordError {
        RecordError { code: None, message: m.to_string() }
    }
    fn io(e: &io::Error, syscall: &str, path: &Path) -> RecordError {
        let code = crate::converter::owned::errno_code(e).to_string();
        RecordError { message: format!("{code}: {}, {syscall} '{}'", describe(e), path.display()), code: Some(code) }
    }
}

impl std::fmt::Display for RecordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// libuv's text for an errno, lower case as Node's messages have it.
fn describe(e: &io::Error) -> String {
    let s = e.to_string();
    let s = s.split(" (os error").next().unwrap_or(&s).to_string();
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_lowercase().collect::<String>() + c.as_str(),
        None => s,
    }
}

const FSYNC_TOLERATED: [&str; 7] = ["EINVAL", "EISDIR", "ENOTSUP", "EOPNOTSUPP", "EBADF", "EPERM", "EACCES"];

/// fsyncPath: a file or folder; a folder some filesystems (SMB, FUSE) cannot fsync is let be.
fn fsync_path(p: &Path) -> Result<(), RecordError> {
    let r = File::open(p).and_then(|f| f.sync_all());
    match r {
        Ok(()) => Ok(()),
        Err(e) => {
            let code = crate::converter::owned::errno_code(&e);
            if FSYNC_TOLERATED.contains(&code) {
                Ok(())
            } else {
                Err(RecordError::io(&e, "fsync", p))
            }
        }
    }
}

fn random_hex(bytes: usize) -> String {
    use rand_core::RngCore;
    let mut b = vec![0u8; bytes];
    rand_core::OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// writeAtomic: a dot-named temporary file, fsynced, renamed over `name`, the folder fsynced.
fn write_atomic(dir: &Path, name: &str, data: &[u8]) -> Result<(), RecordError> {
    let tmp = dir.join(format!(".{name}.tmp-{}", random_hex(6)));
    let mut f = OpenOptions::new().write(true).create_new(true).mode(0o644).open(&tmp).map_err(|e| RecordError::io(&e, "open", &tmp))?;
    let w = f.write_all(data).and_then(|_| f.sync_all());
    drop(f);
    w.map_err(|e| RecordError::io(&e, "write", &tmp))?;
    let target = dir.join(name);
    if let Err(e) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(RecordError::io(&e, "rename", &tmp));
    }
    fsync_path(dir)
}

fn is_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// Date.parse(`${day}T00:00:00Z`) in days, None where Node's is NaN.
fn day_number(day: &str) -> Option<i64> {
    chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").ok().filter(|_| is_day(day)).map(|d| d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp() / 86_400)
}

/// daysBetween(a, b); None stands for NaN (no comparison holds).
fn days_between(a: &str, b: &str) -> Option<i64> {
    Some(day_number(b)? - day_number(a)?)
}

/// One mark as the sidecar holds it: the object itself (written back as it was) and its day and offset.
#[derive(Clone, Debug)]
struct Mark {
    raw: Value,
    day: String,
    offset: u64,
}

fn read_marks(dir: &Path) -> Option<Vec<Mark>> {
    let text = fs::read(dir.join(MARKS)).ok()?;
    let raw: Value = serde_json::from_str(&String::from_utf8_lossy(&text)).ok()?;
    if raw.get("v") != Some(&json!(1)) {
        return None;
    }
    let list = raw.get("marks")?.as_array()?;
    let mut marks: Vec<Mark> = list
        .iter()
        .filter_map(|m| {
            let day = m.get("day")?.as_str()?;
            let off = m.get("offset")?.as_f64()?;
            // Number.isSafeInteger(offset) && offset >= 0
            if !is_day(day) || off.fract() != 0.0 || !(0.0..=9_007_199_254_740_991.0).contains(&off) {
                return None;
            }
            Some(Mark { raw: m.clone(), day: day.to_string(), offset: off as u64 })
        })
        .collect();
    marks.sort_by_key(|m| m.offset);
    Some(marks)
}

fn marks_json(marks: &[Mark]) -> String {
    let list: Vec<Value> = marks.iter().map(|m| m.raw.clone()).collect();
    let mut o = Map::new();
    o.insert("v".into(), json!(1));
    o.insert("marks".into(), Value::Array(list));
    Value::Object(o).to_string()
}

pub type Log = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// createOriginalChecksums
pub struct Recorder {
    now: Box<dyn Fn() -> f64 + Send + Sync>,
    allowed_root: Box<dyn Fn(&str) -> bool + Send + Sync>,
    /// (level, line): 'info' / 'warn' lines of the 'converter' log scope
    log: Option<Log>,
    chains: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
}

/// What record() wrote: the record's path and the line.
#[derive(Clone, Debug)]
pub struct Recorded {
    pub file: PathBuf,
    pub line: String,
}

impl Recorder {
    /// allowed_root(dir): whether a record may be written in `dir` (index.js:
    /// inside a vehicle's folder, `Boolean(vehicles.vehicleForPath(dir))`).
    pub fn new(allowed_root: impl Fn(&str) -> bool + Send + Sync + 'static) -> Recorder {
        Recorder { now: Box::new(js::now_ms), allowed_root: Box::new(allowed_root), log: None, chains: Mutex::new(HashMap::new()) }
    }
    pub fn with_clock(mut self, now: impl Fn() -> f64 + Send + Sync + 'static) -> Recorder {
        self.now = Box::new(now);
        self
    }
    pub fn with_log(mut self, log: Log) -> Recorder {
        self.log = Some(log);
        self
    }

    fn lock_for(&self, file: &Path) -> Arc<Mutex<()>> {
        self.chains.lock().unwrap().entry(file.to_path_buf()).or_default().clone()
    }

    /// record({ source, sourceRoot, sha256 }): append the clip's line and
    /// fsync it. Err when the line could not be written (the converter then
    /// keeps the original).
    pub fn record(&self, source: &str, source_root: Option<&str>, sha256: &str) -> Result<Recorded, RecordError> {
        let mut where_ = locate(source, source_root);
        // (a group folder above the vehicle's own folder: the job's folder then)
        if where_.as_ref().is_some_and(|w| !(self.allowed_root)(&w.root)) {
            where_ = match source_root {
                Some(r) if !r.is_empty() => under(&js::resolve(source), r),
                _ => None,
            };
        }
        if where_.as_ref().is_some_and(|w| !(self.allowed_root)(&w.root)) {
            where_ = None;
        }
        let Some(w) = where_ else {
            return Err(RecordError::msg(&format!("No share root for {source}")));
        };
        let line = line_for(sha256, &w.rel)?;
        let dir = PathBuf::from(&w.root).join(DIR);
        let file = dir.join(FILE);
        let lock = self.lock_for(&file);
        let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
        self.append(&w.root, &dir, &file, &line)?;
        Ok(Recorded { file, line })
    }

    fn append(&self, root: &str, dir: &Path, file: &Path, line: &str) -> Result<(), RecordError> {
        let created_dir = match fs::DirBuilder::new().mode(0o755).create(dir) {
            Ok(()) => true,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => false,
            Err(e) => return Err(RecordError::io(&e, "mkdir", dir)),
        };
        if created_dir {
            fsync_path(Path::new(root))?;
        }
        let mut fh = OpenOptions::new().append(true).create(true).mode(0o644).open(file).map_err(|e| RecordError::io(&e, "open", file))?;
        let mut size = fh.metadata().map_err(|e| RecordError::io(&e, "fstat", file))?.len();
        let created = size == 0;
        let mut data = line.as_bytes().to_vec();
        if size > 0 {
            // a torn last line (never ours, but): start on a line of its own
            let mut last = [0u8; 1];
            let mut r = File::open(file).map_err(|e| RecordError::io(&e, "open", file))?;
            r.seek(SeekFrom::Start(size - 1)).and_then(|_| r.read(&mut last)).map_err(|e| RecordError::io(&e, "read", file))?;
            if last[0] != b'\n' {
                data.insert(0, b'\n');
            }
        }
        fh.write_all(&data).map_err(|e| RecordError::io(&e, "write", file))?;
        fh.sync_all().map_err(|e| RecordError::io(&e, "fsync", file))?;
        if data.len() != line.len() {
            size += 1;
        }
        drop(fh);
        if created {
            fsync_path(dir)?;
        }
        // the day's first line: note where it starts (for pruning)
        if let Err(e) = self.mark(dir, file, size) {
            self.say("warn", &format!("Checksum record {}: {}", file.display(), e.message));
        }
        Ok(())
    }

    fn say(&self, level: &str, line: &str) {
        if let Some(l) = &self.log {
            l(level, line);
        }
    }

    fn mark(&self, dir: &Path, file: &Path, size: u64) -> Result<(), RecordError> {
        let today = js::utc_day((self.now)());
        // (no sidecar: the lines before this one count as older than it)
        let mut marks = read_marks(dir).unwrap_or_default();
        if !marks.iter().any(|m| m.day == today) {
            marks.push(Mark { raw: json!({ "day": today, "offset": size }), day: today.clone(), offset: size });
            marks = self.prune(dir, file, marks, &today)?;
            write_atomic(dir, MARKS, marks_json(&marks).as_bytes())?;
        }
        Ok(())
    }

    /// Drop the lines from before the oldest day kept (rewrite + rename).
    fn prune(&self, dir: &Path, file: &Path, marks: Vec<Mark>, today: &str) -> Result<Vec<Mark>, RecordError> {
        let keep: Vec<&Mark> = marks.iter().filter(|m| days_between(&m.day, today).is_some_and(|d| d < KEEP_DAYS)).collect();
        let dropped: Vec<&Mark> = marks.iter().filter(|m| days_between(&m.day, today).is_some_and(|d| d >= KEEP_DAYS)).collect();
        let Some(oldest) = dropped.first() else { return Ok(marks) };
        if days_between(&oldest.day, today).is_some_and(|d| d < KEEP_DAYS + PRUNE_SLACK_DAYS) {
            return Ok(marks);
        }
        let data = fs::read(file).map_err(|e| RecordError::io(&e, "open", file))?;
        // everything before the first day kept was written more than KEEP_DAYS ago
        let cut = keep.first().map_or(data.len() as u64, |m| m.offset);
        if cut == 0 || cut > data.len() as u64 || (cut < data.len() as u64 && data[cut as usize - 1] != b'\n') {
            return Ok(marks); // not a line start: leave it
        }
        write_atomic(dir, FILE, &data[cut as usize..])?;
        let next: Vec<Mark> = keep
            .iter()
            .map(|m| {
                let mut o = Map::new();
                o.insert("day".into(), m.raw.get("day").cloned().unwrap_or(Value::Null));
                o.insert("offset".into(), json!(m.offset - cut));
                Mark { raw: Value::Object(o), day: m.day.clone(), offset: m.offset - cut }
            })
            .collect();
        write_atomic(dir, MARKS, marks_json(&next).as_bytes())?;
        self.say("info", &format!("Checksum record {}: dropped {cut} bytes of lines older than {KEEP_DAYS} days", file.display()));
        Ok(next)
    }
}

/// Where the arrival hasher writes its lines (Node: `record` passed to
/// createArrivalChecksums, the same originalChecksums.record).
pub trait RecordSink: Send + Sync {
    fn record(&self, source: &str, source_root: &str, sha256: &str) -> Result<(), RecordError>;
}

impl RecordSink for Recorder {
    fn record(&self, source: &str, source_root: &str, sha256: &str) -> Result<(), RecordError> {
        Recorder::record(self, source, Some(source_root), sha256).map(|_| ())
    }
}

/// The converter's before-replace hook (index.js beforeReplaceOriginal): the
/// original's SHA-256 into the share's record, fsynced, before the original
/// is touched. An Err keeps the original (staging answers
/// CHECKSUM_RECORD_FAILED); the error line goes to `log_error` as Node's
/// converter log has it.
pub fn before_replace_original(recorder: &Recorder, source: &str, source_root: &str, sha256: &str, log_error: &dyn Fn(&str)) -> Result<(), String> {
    match recorder.record(source, Some(source_root), sha256) {
        Ok(_) => Ok(()),
        Err(e) => {
            let what = e.code.clone().unwrap_or_else(|| e.message.clone());
            log_error(&format!("Could not record the original's checksum for Sentry USB, so it was kept: {}: {what}", js::basename(source)));
            Err(e.message)
        }
    }
}

/// The hook as the converter's `RuntimeOptions.before_replace_original` takes it.
pub fn before_replace_fn(recorder: Arc<Recorder>, log_error: Arc<dyn Fn(&str) + Send + Sync>) -> crate::converter::staging::BeforeReplaceFn {
    Box::new(move |r| before_replace_original(&recorder, r.source, r.source_root, r.sha256, &*log_error))
}
