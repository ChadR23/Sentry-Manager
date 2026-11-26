//! src/main/converter/jobStore.js: the job files (`<root>/<id>/job.json`,
//! the `job.journal` of changes since, `summary.json`), validated on every
//! read and write exactly as Node validates them, so this store reads and
//! continues jobs the Node server wrote in the same data folder and the Node
//! server reads and continues jobs this one wrote.
//!
//! A clip (`Item`) only exists normalized: the store makes every one, and a
//! later change that hands one back unchanged (the same `Arc`) is not checked
//! again (Node: its frozen, trusted items).

pub mod normalize;
pub mod states;
#[cfg(test)]
mod tests;

use super::error::CError;
use super::recovery::{self, Facts};
use normalize::{assert_safe_job_id, is_safe_id, is_sensitive_field, is_windows_reserved, se, Budget, TOP_FIELDS};
use states::{ItemState, JobState, ReplacementPhase};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

type R<T> = Result<T, CError>;

pub const MANIFEST_NAME: &str = "job.json";
pub const TEMPORARY_MANIFEST_NAME: &str = "job.json.tmp";
pub const JOURNAL_NAME: &str = "job.journal";
pub const SUMMARY_NAME: &str = "summary.json";
pub const JOURNAL_LIMIT_RECORDS: u64 = 1000;
pub const JOURNAL_LIMIT_BYTES: u64 = 16 * 1024 * 1024;
const DIRECTORY_SYNC_UNSUPPORTED: [&str; 6] = ["EISDIR", "EINVAL", "EPERM", "EACCES", "ENOSYS", "ENOTSUP"];

/// One clip of a job, normalized by this store.
#[derive(Debug, PartialEq)]
pub struct Item {
    value: Value,
    budget: Budget,
}

impl Item {
    fn normalize(raw: &Value) -> R<Arc<Item>> {
        let scope = format!("items.{}", normalize::field_name(raw.get("id").and_then(Value::as_str).unwrap_or("unknown")));
        let value = normalize::normalize_item(raw).map_err(|e| normalize::at(&scope, e))?;
        let budget = normalize::preflight(&value).map_err(|e| normalize::at(&scope, e))?;
        Ok(Arc::new(Item { value, budget }))
    }
    pub fn value(&self) -> &Value {
        &self.value
    }
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.value.get(key)
    }
    pub fn id(&self) -> &str {
        self.value["id"].as_str().unwrap_or("")
    }
    /// Its state, as the store validated it.
    pub fn state(&self) -> ItemState {
        ItemState::parse(self.value["state"].as_str().unwrap_or(""))
    }
    pub fn str(&self, key: &str) -> Option<&str> {
        self.value.get(key).and_then(Value::as_str)
    }
    /// A copy to change (and hand back as `ItemIn::Raw`).
    pub fn to_map(&self) -> Map<String, Value> {
        self.value.as_object().cloned().unwrap_or_default()
    }
}

/// A clip handed to the store: one it made (unchanged), or new content.
#[derive(Debug, Clone)]
pub enum ItemIn {
    Trusted(Arc<Item>),
    Raw(Value),
}

impl From<Arc<Item>> for ItemIn {
    fn from(i: Arc<Item>) -> ItemIn {
        ItemIn::Trusted(i)
    }
}
impl From<Value> for ItemIn {
    fn from(v: Value) -> ItemIn {
        ItemIn::Raw(v)
    }
}
impl From<Map<String, Value>> for ItemIn {
    fn from(v: Map<String, Value>) -> ItemIn {
        ItemIn::Raw(Value::Object(v))
    }
}

impl ItemIn {
    fn id_value(&self) -> Option<&Value> {
        match self {
            ItemIn::Trusted(i) => i.value.get("id"),
            ItemIn::Raw(v) => v.get("id"),
        }
    }
    fn resolve(&self) -> R<Arc<Item>> {
        match self {
            ItemIn::Trusted(i) => Ok(i.clone()),
            ItemIn::Raw(v) => Item::normalize(v),
        }
    }
}

/// A validated job: its fields (normalized, in Node's order) and its clips.
#[derive(Debug, Clone)]
pub struct Manifest {
    pub top: Map<String, Value>,
    pub items: Vec<Arc<Item>>,
}

impl Manifest {
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.top.get(key)
    }
    pub fn str(&self, key: &str) -> Option<&str> {
        self.top.get(key).and_then(Value::as_str)
    }
    pub fn id(&self) -> &str {
        self.str("id").unwrap_or("")
    }
    /// Its state, as the store validated it.
    pub fn state(&self) -> JobState {
        JobState::parse(self.str("state").unwrap_or(""))
    }
    pub fn replacement_phase(&self) -> Option<ReplacementPhase> {
        self.str("replacementPhase").map(ReplacementPhase::parse)
    }
    pub fn revision(&self) -> i64 {
        self.top.get("revision").and_then(Value::as_i64).unwrap_or(0)
    }
    pub fn config(&self) -> &Value {
        self.top.get("config").unwrap_or(&Value::Null)
    }
    pub fn item(&self, id: &str) -> Option<&Arc<Item>> {
        self.items.iter().find(|i| i.id() == id)
    }
    pub fn active_item(&self) -> Option<&Arc<Item>> {
        self.str("activeItemId").and_then(|a| self.item(a))
    }
    /// JSON.stringify(manifest)
    pub fn to_json(&self) -> String {
        let mut out = String::from("{");
        let mut first = true;
        let mut push = |out: &mut String, k: &str, v: &str| {
            if !std::mem::take(&mut first) {
                out.push(',');
            }
            out.push_str(&serde_json::to_string(k).unwrap());
            out.push(':');
            out.push_str(v);
        };
        let mut items_written = false;
        for (k, v) in &self.top {
            if k == "items" {
                continue;
            }
            push(&mut out, k, &serde_json::to_string(v).unwrap());
            if k == "config" {
                push(&mut out, "items", &items_json(&self.items));
                items_written = true;
            }
        }
        if !items_written {
            push(&mut out, "items", &items_json(&self.items));
        }
        out.push('}');
        out
    }
    /// The whole manifest as one value (a copy).
    pub fn to_value(&self) -> Value {
        serde_json::from_str(&self.to_json()).unwrap()
    }
}

fn items_json(items: &[Arc<Item>]) -> String {
    let mut s = String::from("[");
    for (i, it) in items.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&serde_json::to_string(&it.value).unwrap());
    }
    s.push(']');
    s
}

fn report_refusal(id: &str, operation: &str, e: &CError) {
    super::service::log_line(format!("[CONVERTER] Job {} manifest {operation} refused: {} at {}: {}",
        normalize::field_name(id), e.code, e.path.as_deref().unwrap_or("manifest"), e.message));
}

fn diagnosed<T>(id: &str, operation: &str, result: R<T>) -> R<T> {
    if let Err(e) = &result { report_refusal(id, operation, e); }
    result
}

/// A change of a job (store.transition's patch): top-level fields, and the
/// whole clip list when it changes. `Value::Null` clears a field where Node's
/// `null` does.
#[derive(Debug, Clone, Default)]
pub struct Patch {
    pub top: Map<String, Value>,
    pub items: Option<Vec<ItemIn>>,
}

impl Patch {
    pub fn new() -> Patch {
        Patch::default()
    }
    pub fn set(mut self, k: &str, v: Value) -> Patch {
        self.top.insert(k.to_string(), v);
        self
    }
    /// The job's next state.
    pub fn state(self, s: JobState) -> Patch {
        self.set("state", s.into())
    }
    pub fn items(mut self, items: Vec<ItemIn>) -> Patch {
        self.items = Some(items);
        self
    }
    /// The patch as a value (for kill-point hooks in tests): items as given.
    pub fn to_value(&self) -> Value {
        let mut m = self.top.clone();
        if let Some(items) = &self.items {
            m.insert(
                "items".into(),
                Value::Array(
                    items
                        .iter()
                        .map(|i| match i {
                            ItemIn::Trusted(t) => t.value.clone(),
                            ItemIn::Raw(v) => v.clone(),
                        })
                        .collect(),
                ),
            );
        }
        Value::Object(m)
    }
}

/// normalizeManifest(value) for a whole value (read from a file, or given to
/// create/save).
pub fn normalize_manifest(value: &Value) -> R<Manifest> {
    normalize::preflight(value)?;
    let Some(m) = value.as_object() else { return Err(normalize::refused("manifest", "expected object")) };
    let (top, items) = normalize::normalize_top(m, || {
        let Some(list) = m.get("items").and_then(Value::as_array) else { return Err(normalize::refused("items", "expected array")) };
        normalize::limit("LIMIT_ITEMS", list.len() as u64, normalize::LIMIT_ITEMS as u64)?;
        list.iter().map(Item::normalize).collect()
    })?;
    Ok(Manifest { top, items })
}

/// normalizeManifest of a merged change: `top` with `items`, where items the
/// store made are trusted (their measured budget is added, not walked).
fn normalize_parts(top: &Map<String, Value>, items: &[ItemIn]) -> R<Manifest> {
    // preflightManifest of { ...top, items }
    let mut b = Budget { nodes: 1, string_units: 0, estimated: 0 };
    let keys = top.len() + if top.contains_key("items") { 0 } else { 1 };
    b.estimated += keys as u64 + 2;
    // a key costs its string, not a node
    let key_cost = |k: &str| -> R<Budget> {
        let mut x = Budget::default();
        x.walk(&Value::String(k.to_string()), 0)?;
        x.nodes = 0;
        Ok(x)
    };
    if !top.contains_key("items") {
        b.add(&key_cost("items")?)?;
    }
    for (k, v) in top {
        b.add(&key_cost(k)?)?;
        if k == "items" {
            continue;
        }
        let mut x = Budget::default();
        x.walk(v, 1)?;
        b.add(&x)?;
    }
    normalize::limit("LIMIT_ITEMS", items.len() as u64, normalize::LIMIT_ITEMS as u64)?;
    b.add(&Budget { nodes: 1, string_units: 0, estimated: items.len() as u64 + 2 })?;
    for it in items {
        match it {
            ItemIn::Trusted(t) => b.add(&t.budget)?,
            ItemIn::Raw(v) => {
                let mut x = Budget::default();
                x.walk(v, 2)?;
                b.add(&x)?;
            }
        }
    }
    let (top, items) = normalize::normalize_top(top, || items.iter().map(ItemIn::resolve).collect())?;
    Ok(Manifest { top, items })
}

/// The moves a change makes (`JobState::to`, `ItemState::to`): the job's
/// state, each clip it changes, and each clip it adds (queued, or skipped
/// when it is converted already). A clip handed back unchanged is not
/// looked at again. The refused clip's id is in `path`.
fn check_moves(current: &Manifest, next: &Manifest) -> R<()> {
    current.state().to(next.state())?;
    let mut by_id: Option<HashMap<&str, &Arc<Item>>> = None;
    for (i, item) in next.items.iter().enumerate() {
        let at = current.items.get(i).filter(|c| c.id() == item.id());
        if at.is_some_and(|c| Arc::ptr_eq(c, item)) {
            continue;
        }
        let before = match at {
            Some(c) => Some(c),
            None => by_id.get_or_insert_with(|| current.items.iter().map(|c| (c.id(), c)).collect()).get(item.id()).copied(),
        };
        let to = item.state();
        let refusal = match before {
            Some(b) if b.state()==ItemState::Skipped && b.str("resultCode")==Some("folder-not-writable") && to==ItemState::Queued => None,
            Some(b) => b.state().to(to).err(),
            None if to.is_initial() => None,
            None => Some(CError::new(states::INVALID_STATE_TRANSITION, format!("A clip cannot be added as {to}."))),
        };
        if let Some(mut e) = refusal {
            e.path = Some(item.id().to_string());
            return Err(e);
        }
    }
    Ok(())
}

// ---- files -------------------------------------------------------------------

fn code_of(e: &io::Error) -> &'static str {
    super::owned::errno_code(e)
}

fn sleep_ms(ms: u64) {
    std::thread::sleep(std::time::Duration::from_millis(ms));
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Number.prototype.toString(36)
pub fn base36(mut n: u64) -> String {
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(digits[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

/// crypto.randomUUID()
pub fn random_uuid() -> R<String> {
    use rand_core::RngCore;
    let mut b = [0u8; 16];
    rand_core::OsRng.try_fill_bytes(&mut b).map_err(|_| CError::new("RANDOM_FAILED", "no random bytes"))?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = super::tesla_sei::hex(&b);
    Ok(format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32]))
}

/// String.prototype.localeCompare (ICU root collation) for job folder names,
/// which only hold [a-z0-9_-]: '_' < '-' < digits < letters.
pub fn locale_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let key = |c: char| -> u32 {
        match c {
            '_' => 0,
            '-' => 1,
            '0'..='9' => 10 + (c as u32 - '0' as u32),
            'a'..='z' => 100 + (c as u32 - 'a' as u32),
            other => 1000 + other as u32,
        }
    };
    a.chars().map(key).cmp(b.chars().map(key))
}

#[derive(Debug, Clone, PartialEq)]
struct Identity {
    dev: u64,
    ino: u64,
    size: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}

fn identity_of(m: &fs::Metadata) -> Identity {
    Identity { dev: m.dev(), ino: m.ino(), size: m.len(), mtime: (m.mtime(), m.mtime_nsec()), ctime: (m.ctime(), m.ctime_nsec()) }
}

fn same_identity(a: &Identity, b: &Identity) -> bool {
    a.dev == b.dev && a.ino == b.ino && a.size == b.size && a.mtime == b.mtime
}

/// fs.Stats mtimeMs, as Node computes it
pub fn mtime_ms(m: &fs::Metadata) -> f64 {
    m.mtime() as f64 * 1e3 + m.mtime_nsec() as f64 / 1e6
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct JournalState {
    records: u64,
    bytes: u64,
}

struct Cached {
    manifest: Manifest,
    identity: Identity,
    journal: JournalState,
}

/// list_strict(): the jobs read in full, and those whose record does not replay.
#[derive(Default)]
pub struct Strict {
    pub manifests: Vec<Manifest>,
    pub damaged: Vec<Damaged>,
}

/// A job whose record does not replay: its job file and the journal lines that are JSON.
pub struct Damaged {
    pub id: String,
    pub parts: Vec<Value>,
}

struct Paths {
    directory: PathBuf,
    manifest: PathBuf,
    temporary: PathBuf,
    journal: PathBuf,
}

enum ReadOutcome {
    Missing,
    Changed,
    Oversized,
    Bytes(Vec<u8>),
}

/// Kill points for the crash tests (crashPoints.js wraps the store the same
/// way): called around each transition.
pub trait StoreHooks: Send + Sync {
    fn before_write(&self, _patch: &Patch, _current: &Manifest) {}
    fn after_write(&self, _next: &Manifest, _previous: Option<&Manifest>) {}
}

pub type Unreadable = Box<dyn Fn(&str, &CError) + Send + Sync>;

pub struct JobStore {
    root: PathBuf,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    last_written: Mutex<HashMap<String, Cached>>,
    quarantine_seq: AtomicU64,
    summary_cache: Mutex<HashMap<String, (String, Arc<Value>)>>,
    on_unreadable: Unreadable,
    hooks: Option<Arc<dyn StoreHooks>>,
    last_seen: Mutex<HashMap<String, Manifest>>,
}

impl JobStore {
    /// createJobStore({ rootDir })
    pub fn new(root: &Path) -> R<JobStore> {
        if !root.is_absolute() {
            return Err(CError::type_error("rootDir must be an absolute path"));
        }
        Ok(JobStore {
            root: super::owned::resolve(root),
            locks: Mutex::new(HashMap::new()),
            last_written: Mutex::new(HashMap::new()),
            quarantine_seq: AtomicU64::new(0),
            summary_cache: Mutex::new(HashMap::new()),
            on_unreadable: Box::new(|id, e| eprintln!("[CONVERTER] Skipped job {} that could not be read: {}", id, e.code_or(&e.message))),
            hooks: None,
            last_seen: Mutex::new(HashMap::new()),
        })
    }
    pub fn with_unreadable(mut self, f: Unreadable) -> JobStore {
        self.on_unreadable = f;
        self
    }
    pub fn with_hooks(mut self, h: Arc<dyn StoreHooks>) -> JobStore {
        self.hooks = Some(h);
        self
    }
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn exclusive<T>(&self, id: &str, f: impl FnOnce() -> R<T>) -> R<T> {
        assert_safe_job_id(id)?;
        let lock = self.locks.lock().unwrap().entry(id.to_string()).or_default().clone();
        let _g = lock.lock().unwrap_or_else(|p| p.into_inner());
        f()
    }

    fn job_paths(&self, id: &str) -> R<Paths> {
        assert_safe_job_id(id)?;
        let directory = self.root.join(id);
        if directory.parent() != Some(self.root.as_path()) {
            return Err(se("UNSAFE_JOB_PATH"));
        }
        Ok(Paths { manifest: directory.join(MANIFEST_NAME), temporary: directory.join(TEMPORARY_MANIFEST_NAME), journal: directory.join(JOURNAL_NAME), directory })
    }

    fn ensure_root(&self) -> R<PathBuf> {
        fs::create_dir_all(&self.root)?;
        let st = fs::symlink_metadata(&self.root)?;
        if !st.is_dir() || st.file_type().is_symlink() {
            return Err(se("UNSAFE_JOB_PATH"));
        }
        Ok(fs::canonicalize(&self.root)?)
    }

    fn assert_contained(&self, directory: &Path, canonical_root: &Path) -> R<()> {
        let st = fs::symlink_metadata(directory)?;
        if !st.is_dir() || st.file_type().is_symlink() {
            return Err(se("UNSAFE_JOB_PATH"));
        }
        let canonical = fs::canonicalize(directory)?;
        match canonical.strip_prefix(canonical_root) {
            Ok(rel) if !rel.as_os_str().is_empty() && !rel.to_string_lossy().starts_with("..") => Ok(()),
            _ => Err(se("UNSAFE_JOB_PATH")),
        }
    }

    fn ensure_job_directory(&self, id: &str) -> R<Paths> {
        let paths = self.job_paths(id)?;
        let root = self.ensure_root()?;
        if let Err(e) = fs::create_dir(&paths.directory) {
            if code_of(&e) != "EEXIST" {
                return Err(e.into());
            }
        }
        self.assert_contained(&paths.directory, &root)?;
        Ok(paths)
    }

    fn open_existing_job_directory(&self, id: &str) -> R<Option<Paths>> {
        let paths = self.job_paths(id)?;
        let root = self.ensure_root()?;
        match self.assert_contained(&paths.directory, &root) {
            Ok(()) => Ok(Some(paths)),
            Err(e) if e.code == "ENOENT" => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn sync_directory(dir: &Path) -> io::Result<()> {
        let r = File::open(dir).and_then(|f| f.sync_all());
        match r {
            Err(e) if !DIRECTORY_SYNC_UNSUPPORTED.contains(&code_of(&e)) => Err(e),
            _ => Ok(()),
        }
    }

    fn open_temporary(temporary: &Path) -> io::Result<File> {
        let open = || OpenOptions::new().write(true).create_new(true).mode(0o600).open(temporary);
        match open() {
            Ok(f) => return Ok(f),
            Err(e) if code_of(&e) != "EEXIST" => return Err(e),
            Err(_) => {}
        }
        let st = fs::symlink_metadata(temporary)?;
        if !st.is_file() || st.file_type().is_symlink() {
            return Err(io::Error::from_raw_os_error(libc::EPERM));
        }
        fs::remove_file(temporary)?;
        open()
    }

    fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
        let mut attempt = 0;
        loop {
            match fs::rename(from, to) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    if !["EACCES", "EBUSY", "EPERM", "ENOTEMPTY"].contains(&code_of(&e)) || attempt == 3 {
                        return Err(e);
                    }
                    sleep_ms(50 * (attempt + 1));
                    attempt += 1;
                }
            }
        }
    }

    fn atomic_write(paths: &Paths, manifest: &Manifest) -> R<()> {
        let serialized = format!("{}\n", manifest.to_json());
        normalize::limit("LIMIT_BYTES (serialized)", serialized.len() as u64, normalize::LIMIT_BYTES)?;
        let result = (|| -> io::Result<()> {
            let mut f = Self::open_temporary(&paths.temporary)?;
            f.write_all(serialized.as_bytes())?;
            f.sync_all()?;
            drop(f);
            Self::rename_with_retry(&paths.temporary, &paths.manifest)?;
            Self::sync_directory(&paths.directory)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&paths.temporary);
            return Err(se("MANIFEST_WRITE_FAILED"));
        }
        Ok(())
    }

    /// true when no journal remains
    fn remove_journal(paths: &Paths) -> bool {
        for attempt in 0..4u64 {
            match fs::remove_file(&paths.journal) {
                Ok(()) => {
                    let _ = Self::sync_directory(&paths.directory);
                    return true;
                }
                Err(e) if code_of(&e) == "ENOENT" => return true,
                Err(e) => {
                    if !["EACCES", "EBUSY", "EPERM"].contains(&code_of(&e)) || attempt == 3 {
                        return false;
                    }
                    sleep_ms(50 * (attempt + 1));
                }
            }
        }
        false
    }

    fn write_full(paths: &Paths, manifest: &Manifest) -> R<bool> {
        Self::atomic_write(paths, manifest)?;
        Ok(Self::remove_journal(paths))
    }

    fn append_journal(paths: &Paths, line: &str, existing: u64) -> R<()> {
        let r = (|| -> io::Result<()> {
            let mut f = if existing > 0 {
                let st = fs::symlink_metadata(&paths.journal)?;
                if !st.is_file() || st.file_type().is_symlink() || st.len() != existing {
                    return Err(io::Error::from_raw_os_error(libc::EIO));
                }
                OpenOptions::new().append(true).open(&paths.journal)?
            } else {
                OpenOptions::new().write(true).create_new(true).mode(0o600).open(&paths.journal)?
            };
            f.write_all(line.as_bytes())?;
            f.sync_all()?;
            drop(f);
            if existing == 0 {
                Self::sync_directory(&paths.directory)?;
            }
            Ok(())
        })();
        r.map_err(|_| se("MANIFEST_WRITE_FAILED"))
    }

    fn read_journal(paths: &Paths) -> R<Option<Vec<u8>>> {
        let st = match fs::symlink_metadata(&paths.journal) {
            Ok(s) => s,
            Err(e) if code_of(&e) == "ENOENT" => return Ok(None),
            Err(_) => return Err(se("MANIFEST_READ_FAILED")),
        };
        if !st.is_file() || st.file_type().is_symlink() || st.len() > normalize::LIMIT_BYTES {
            return Err(se("MANIFEST_READ_FAILED"));
        }
        fs::read(&paths.journal).map(Some).map_err(|_| se("MANIFEST_READ_FAILED"))
    }

    /// Replay committed journal records on top of the base manifest. Only the
    /// final line may be incomplete; it is ignored.
    fn replay_journal(base: &Manifest, bytes: &[u8]) -> R<Manifest> {
        let text = String::from_utf8_lossy(bytes);
        let mut lines: Vec<&str> = text.split('\n').collect();
        lines.pop();
        let mut top = base.top.clone();
        let mut revision = base.revision();
        let mut items: Vec<ItemIn> = base.items.iter().cloned().map(ItemIn::Trusted).collect();
        let mut replayed = false;
        for (line_index, line) in lines.into_iter().enumerate() {
            let bad = |rule| normalize::refused(&format!("journal.line{}", line_index + 1), rule);
            let record: Value = serde_json::from_str(line).map_err(|_| bad("invalid JSON"))?;
            let Some(rm) = record.as_object() else { return Err(bad("expected object")) };
            let Some(r) = rm.get("r").and_then(normalize::safe_int_of) else { return Err(bad("r: expected safe integer revision")) };
            let Some(rtop) = rm.get("top").and_then(Value::as_object) else { return Err(bad("top: expected object")) };
            let Some(set) = rm.get("set").and_then(Value::as_array) else { return Err(bad("set: expected array")) };
            if rtop.get("revision").and_then(Value::as_f64) != Some(r as f64) || rtop.contains_key("items") {
                return Err(bad("top.revision must equal r; top must not contain items"));
            }
            if r <= revision {
                continue;
            }
            if r != revision + 1 {
                return Err(bad("r: revisions must be consecutive"));
            }
            let mut next = items.clone();
            for entry in set {
                let Some(pair) = entry.as_array() else { return Err(bad("set entry: expected array")) };
                if pair.len() != 2 {
                    return Err(bad("set entry: expected index and item pair"));
                }
                let Some(index) = normalize::safe_int_of(&pair[0]).filter(|i| *i >= 0 && (*i as usize) < next.len()) else { return Err(bad("set index: outside item array")) };
                let index = index as usize;
                let incoming_id = pair[1].as_object().and_then(|o| o.get("id"));
                if next[index].id_value() != incoming_id || incoming_id.is_none() {
                    return Err(bad("set item.id must match the item at its index"));
                }
                next[index] = ItemIn::Raw(pair[1].clone());
            }
            if let Some(add) = rm.get("add") {
                match add.as_array() {
                    Some(a) if !a.is_empty() => next.extend(a.iter().cloned().map(ItemIn::Raw)),
                    _ => return Err(bad("add: expected nonempty item array")),
                }
            }
            items = next;
            top = rtop.clone();
            revision = r;
            replayed = true;
        }
        if !replayed {
            return Ok(base.clone());
        }
        normalize_parts(&top, &items)
    }

    fn bounded_read(path: &Path) -> R<(ReadOutcome, Option<Identity>)> {
        let first = match fs::symlink_metadata(path) {
            Ok(s) => s,
            Err(e) if code_of(&e) == "ENOENT" => return Ok((ReadOutcome::Missing, None)),
            Err(_) => return Err(se("MANIFEST_READ_FAILED")),
        };
        if !first.is_file() || first.file_type().is_symlink() {
            return Err(se("MANIFEST_READ_FAILED"));
        }
        let fid = identity_of(&first);
        if fid.size > normalize::LIMIT_BYTES {
            return Ok((ReadOutcome::Oversized, Some(fid)));
        }
        let r = (|| -> io::Result<(ReadOutcome, Option<Identity>)> {
            let mut f = File::open(path)?;
            let opened = identity_of(&f.metadata()?);
            if !same_identity(&fid, &opened) || opened.size > normalize::LIMIT_BYTES {
                return Ok((ReadOutcome::Changed, Some(opened)));
            }
            let mut buf = Vec::with_capacity(opened.size as usize + 1);
            (&mut f).take(opened.size + 1).read_to_end(&mut buf)?;
            let closed = identity_of(&f.metadata()?);
            if !same_identity(&opened, &closed) || buf.len() as u64 != opened.size {
                return Ok((ReadOutcome::Changed, Some(closed)));
            }
            Ok((ReadOutcome::Bytes(buf), Some(opened)))
        })();
        r.map_err(|_| se("MANIFEST_READ_FAILED"))
    }

    fn quarantine(&self, paths: &Paths, bytes: &[u8]) -> R<bool> {
        let mut created: Option<PathBuf> = None;
        let r = (|| -> io::Result<()> {
            let mut file = None;
            for _ in 0..1000 {
                let seq = self.quarantine_seq.fetch_add(1, Ordering::SeqCst) + 1;
                let p = paths.directory.join(format!("{}.corrupt-{}-{}-{}", MANIFEST_NAME, base36(now_ms()), std::process::id(), seq));
                match OpenOptions::new().write(true).create_new(true).mode(0o600).open(&p) {
                    Ok(f) => {
                        created = Some(p);
                        file = Some(f);
                        break;
                    }
                    Err(e) if code_of(&e) == "EEXIST" => continue,
                    Err(e) => return Err(e),
                }
            }
            let Some(mut f) = file else { return Err(io::Error::from_raw_os_error(libc::EEXIST)) };
            f.write_all(bytes)?;
            f.sync_all()?;
            drop(f);
            Self::sync_directory(&paths.directory)
        })();
        match r {
            Ok(()) => Ok(true),
            Err(_) => {
                if let Some(p) = created {
                    let _ = fs::remove_file(p);
                }
                Err(se("MANIFEST_QUARANTINE_FAILED"))
            }
        }
    }

    fn read_manifest(&self, id: &str) -> R<Option<Manifest>> {
        let Some(paths) = self.open_existing_job_directory(id)? else { return Ok(None) };
        for _ in 0..2 {
            let (read, identity) = Self::bounded_read(&paths.manifest)?;
            let bytes = match read {
                ReadOutcome::Missing => return Ok(None),
                ReadOutcome::Changed => continue,
                ReadOutcome::Oversized => {
                    let e = normalize::refused("LIMIT_BYTES (file)", format!("value {} exceeds limit {}", identity.map(|i| i.size).unwrap_or(0), normalize::LIMIT_BYTES));
                    report_refusal(id, "read", &e);
                    return Err(se("MANIFEST_READ_FAILED"));
                }
                ReadOutcome::Bytes(b) => b,
            };
            let base = serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes))
                .map_err(|e| normalize::refused("manifest", format!("invalid JSON at line {} column {}", e.line(), e.column())))
                .and_then(|v| normalize_manifest(&v))
                .and_then(|m| if m.id() == id { Ok(m) } else { Err(normalize::refused("id", "must match job directory")) });
            if let Ok(base) = diagnosed(id, "read", base) {
                let journal = Self::read_journal(&paths)?;
                let Some(journal) = journal.filter(|j| !j.is_empty()) else { return Ok(Some(base)) };
                let replay = Self::replay_journal(&base, &journal)
                    .and_then(|m| if m.id() == id { Ok(m) } else { Err(normalize::refused("journal.top.id", "must match job directory")) });
                if let Ok(m) = diagnosed(id, "replay", replay) {
                    return Ok(Some(m));
                }
                if self.quarantine(&paths, &journal)? {
                    return Err(se("CORRUPT_MANIFEST"));
                }
                continue;
            }
            if self.quarantine(&paths, &bytes)? {
                return Err(se("CORRUPT_MANIFEST"));
            }
        }
        Err(se("MANIFEST_READ_FAILED"))
    }

    /// create(initial): `initial` holds top-level fields and `items` (raw).
    pub fn create(&self, initial: &Map<String, Value>) -> R<Manifest> {
        diagnosed(initial.get("id").and_then(Value::as_str).unwrap_or("new"), "create", self.create_inner(initial))
    }

    fn create_inner(&self, initial: &Map<String, Value>) -> R<Manifest> {
        for k in initial.keys() {
            if !TOP_FIELDS.contains(&k.as_str()) {
                let mut e = se(if is_sensitive_field(k) { "SENSITIVE_MANIFEST_DATA" } else { "INVALID_MANIFEST" });
                e.path = Some(normalize::field_name(k));
                e.message = "field is not allowed".into();
                return Err(e);
            }
        }
        let id = match initial.get("id") {
            None => random_uuid()?,
            Some(Value::String(s)) => s.clone(),
            Some(_) => return Err(se("INVALID_JOB_ID")),
        };
        assert_safe_job_id(&id)?;
        if initial.get("schemaVersion").is_some_and(|v| v.as_f64() != Some(normalize::MANIFEST_VERSION as f64)) {
            return Err(se("UNSUPPORTED_MANIFEST_VERSION"));
        }
        let mut draft = Map::new();
        draft.insert("schemaVersion".into(), Value::from(normalize::MANIFEST_VERSION));
        draft.insert("id".into(), Value::String(id.clone()));
        draft.insert("state".into(), initial.get("state").cloned().unwrap_or_else(|| Value::from("discovering")));
        draft.insert("revision".into(), initial.get("revision").cloned().unwrap_or_else(|| Value::from(0)));
        if let Some(c) = initial.get("config") {
            draft.insert("config".into(), c.clone());
        }
        draft.insert("items".into(), initial.get("items").cloned().unwrap_or_else(|| Value::Array(vec![])));
        draft.insert("counters".into(), initial.get("counters").cloned().unwrap_or_else(super::contracts::create_empty_counters));
        draft.insert("summary".into(), initial.get("summary").cloned().unwrap_or(Value::Null));
        draft.insert("summaryDismissed".into(), Value::Bool(initial.get("summaryDismissed") == Some(&Value::Bool(true))));
        for k in TOP_FIELDS {
            if !draft.contains_key(k) {
                if let Some(v) = initial.get(k) {
                    draft.insert(k.into(), v.clone());
                }
            }
        }
        let safe = normalize_manifest(&Value::Object(draft))?;
        self.exclusive(&id, || {
            let paths = self.job_paths(&id)?;
            self.ensure_root()?;
            if let Err(e) = fs::create_dir(&paths.directory) {
                if code_of(&e) == "EEXIST" {
                    return Err(se("JOB_EXISTS"));
                }
                return Err(e.into());
            }
            let root = fs::canonicalize(&self.root)?;
            self.assert_contained(&paths.directory, &root)?;
            self.last_written.lock().unwrap().remove(&id);
            Self::atomic_write(&paths, &safe)?;
            Ok(safe.clone())
        })
    }

    /// save(manifest): a whole job (newer revision only).
    pub fn save(&self, manifest: &Value) -> R<Manifest> {
        diagnosed(manifest.get("id").and_then(Value::as_str).unwrap_or("unknown"), "save", self.save_inner(manifest))
    }

    fn save_inner(&self, manifest: &Value) -> R<Manifest> {
        let safe = normalize_manifest(manifest)?;
        let id = safe.id().to_string();
        self.exclusive(&id, || {
            if let Some(existing) = self.read_manifest(&id)? {
                if existing.to_json() == safe.to_json() {
                    return Ok(existing);
                }
                if safe.revision() <= existing.revision() {
                    return Err(se("STALE_MANIFEST_REVISION"));
                }
            }
            let paths = self.ensure_job_directory(&id)?;
            self.last_written.lock().unwrap().remove(&id);
            Self::write_full(&paths, &safe)?;
            Ok(safe.clone())
        })
    }

    pub fn load(&self, id: &str) -> R<Option<Manifest>> {
        assert_safe_job_id(id)?;
        diagnosed(id, "load", self.exclusive(id, || self.read_manifest(id)))
    }

    fn job_folders(&self) -> R<Vec<String>> {
        self.ensure_root()?;
        let entries = fs::read_dir(&self.root).map_err(|_| se("MANIFEST_READ_FAILED"))?;
        let mut names = Vec::new();
        for e in entries {
            let e = e.map_err(|_| se("MANIFEST_READ_FAILED"))?;
            let Ok(t) = e.file_type() else { continue };
            let name = e.file_name().to_string_lossy().to_string();
            names.push((name, t.is_dir() && !t.is_symlink()));
        }
        names.sort_by(|a, b| locale_cmp(&a.0, &b.0));
        Ok(names.into_iter().filter(|(n, dir)| *dir && is_safe_id(n) && !is_windows_reserved(n)).map(|(n, _)| n).collect())
    }

    /// list(): every job that can be read (one that cannot does not stop the rest).
    pub fn list(&self) -> R<Vec<Manifest>> {
        let mut out = Vec::new();
        for name in self.job_folders()? {
            match self.exclusive(&name, || self.read_manifest(&name)) {
                Ok(Some(m)) => out.push(m),
                Ok(None) => {}
                Err(e) => {
                    if e.code != "CORRUPT_MANIFEST" {
                        (self.on_unreadable)(&name, &e);
                    }
                }
            }
        }
        Ok(out)
    }

    /// list(), refusing instead of skipping: every job folder's record must be read (one
    /// that cannot be, or that has a journal or a half-written record but no job file, is
    /// an error naming it). A corrupt record is set aside as list() does; while its job
    /// file or journal is still there, what can be read of them is returned as damaged.
    /// For the leftover-backup tidy, which touches a file only when no job can own it.
    pub fn list_strict(&self) -> Result<Strict, String> {
        let mut out = Strict::default();
        let names = self.job_folders().map_err(|e| format!("the job folders could not be listed ({})", e.code))?;
        for name in names {
            match self.exclusive(&name, || self.read_manifest(&name)) {
                Ok(Some(m)) => out.manifests.push(m),
                Ok(None) => {
                    let Ok(paths) = self.job_paths(&name) else { return Err(format!("job {name} could not be read")) };
                    let left = [&paths.journal, &paths.temporary].into_iter().find(|p| fs::symlink_metadata(p).is_ok());
                    if let Some(p) = left {
                        return Err(format!("job {name} has {} but no readable job file", p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()));
                    }
                }
                Err(e) if e.code == "CORRUPT_MANIFEST" => {
                    // (set aside as list() does, but its job file and journal are still there:
                    // what can be read of them is kept as the job's, see Damaged)
                    if let Some(d) = self.exclusive(&name, || Ok(self.damaged(&name))).map_err(|e| format!("job {name} could not be read ({})", e.code))? {
                        out.damaged.push(d?);
                    }
                }
                Err(e) => return Err(format!("job {name} could not be read ({})", e.code)),
            }
        }
        Ok(out)
    }

    /// A job folder whose record does not replay: None once neither its job file nor its
    /// journal is there; the job file and each journal line that is JSON; Err when the job
    /// file is there but cannot be read as JSON.
    fn damaged(&self, id: &str) -> Option<Result<Damaged, String>> {
        let paths = self.job_paths(id).ok()?;
        let present = |p: &Path| fs::symlink_metadata(p).is_ok();
        if !present(&paths.manifest) && !present(&paths.journal) {
            return None;
        }
        let read = |p: &Path| -> Result<Option<Vec<u8>>, String> {
            match Self::bounded_read(p) {
                Ok((ReadOutcome::Bytes(b), _)) => Ok(Some(b)),
                Ok((ReadOutcome::Missing, _)) => Ok(None),
                _ => Err(format!("job {id}'s record is damaged and could not be read")),
            }
        };
        let mut parts = Vec::new();
        let r = (|| {
            match read(&paths.manifest)? {
                Some(b) => parts.push(serde_json::from_slice::<Value>(&b).map_err(|_| format!("job {id}'s record is damaged (its job file is not readable)"))?),
                None => return Err(format!("job {id}'s record is damaged (a journal but no job file)")),
            }
            if let Some(b) = read(&paths.journal)? {
                parts.extend(b.split(|c| *c == b'\n').filter_map(|l| serde_json::from_slice::<Value>(l).ok()));
            }
            Ok(())
        })();
        Some(r.map(|()| Damaged { id: id.to_string(), parts }))
    }

    fn stamp_of(&self, id: &str) -> R<String> {
        let paths = self.job_paths(id)?;
        let part = |p: &Path| match fs::metadata(p) {
            Ok(st) => format!("{}:{}", st.len(), super::contracts::js_round(mtime_ms(&st) * 1000.0) as i64),
            Err(_) => "-".into(),
        };
        Ok(format!("{}|{}", part(&paths.manifest), part(&paths.journal)))
    }

    fn saved_summary(&self, id: &str, stamp: &str) -> Option<Value> {
        let dir = self.job_paths(id).ok()?.directory;
        let saved: Value = serde_json::from_slice(&fs::read(dir.join(SUMMARY_NAME)).ok()?).ok()?;
        if saved.get("v") != Some(&Value::from(1)) || saved.get("stamp").and_then(Value::as_str) != Some(stamp) {
            return None;
        }
        let summary = saved.get("summary")?;
        if summary.get("id").and_then(Value::as_str) != Some(id) || !summary.get("items").is_some_and(Value::is_array) {
            return None;
        }
        Some(summary.clone())
    }

    fn save_summary(&self, id: &str, stamp: &str, summary: &Value) {
        if !JobState::parse(summary["state"].as_str().unwrap_or("")).is_terminal() {
            return;
        }
        let Ok(paths) = self.job_paths(id) else { return };
        let temporary = paths.directory.join(format!("{}.{}.tmp", SUMMARY_NAME, std::process::id()));
        let body = serde_json::json!({ "v": 1, "stamp": stamp, "summary": summary });
        let ok = fs::write(&temporary, serde_json::to_string(&body).unwrap()).and_then(|_| fs::rename(&temporary, paths.directory.join(SUMMARY_NAME)));
        if ok.is_err() {
            let _ = fs::remove_file(&temporary);
        }
    }

    /// summaries(): every job without its clip list, the clip results counted.
    pub fn summaries(&self) -> R<Vec<Arc<Value>>> {
        self.summaries_with_live(&HashMap::new())
    }

    /// The service already has live jobs' accepted state. Do not parse their full
    /// manifests and replay journals on a polling thread just to discard the answer.
    /// Inactive jobs keep the normal disk validation and summary cache, in folder order.
    pub fn summaries_with_live(&self, live: &HashMap<String, Value>) -> R<Vec<Arc<Value>>> {
        let names = self.job_folders()?;
        let mut out = Vec::new();
        for name in &names {
            if let Some(summary) = live.get(name) {
                out.push(Arc::new(summary.clone()));
                continue;
            }
            let r = (|| -> R<Option<Arc<Value>>> {
                let stamp = self.stamp_of(name)?;
                if let Some((s, v)) = self.summary_cache.lock().unwrap().get(name) {
                    if *s == stamp {
                        return Ok(Some(v.clone()));
                    }
                }
                if let Some(saved) = self.saved_summary(name, &stamp) {
                    let v = Arc::new(saved);
                    self.summary_cache.lock().unwrap().insert(name.clone(), (stamp, v.clone()));
                    return Ok(Some(v));
                }
                let Some(m) = self.exclusive(name, || self.read_manifest(name))? else {
                    self.summary_cache.lock().unwrap().remove(name);
                    return Ok(None);
                };
                let summary = summarize(&m);
                self.save_summary(name, &stamp, &summary);
                let v = Arc::new(summary);
                self.summary_cache.lock().unwrap().insert(name.clone(), (stamp, v.clone()));
                Ok(Some(v))
            })();
            match r {
                Ok(Some(v)) => out.push(v),
                Ok(None) => {}
                Err(e) => {
                    self.summary_cache.lock().unwrap().remove(name);
                    if e.code != "CORRUPT_MANIFEST" {
                        (self.on_unreadable)(name, &e);
                    }
                }
            }
        }
        self.summary_cache.lock().unwrap().retain(|k, _| names.contains(k));
        Ok(out)
    }

    /// discard(id): the job file is set aside (renamed, never deleted).
    pub fn discard(&self, id: &str) -> R<bool> {
        assert_safe_job_id(id)?;
        self.exclusive(id, || {
            let Some(paths) = self.open_existing_job_directory(id)? else { return Ok(false) };
            self.last_written.lock().unwrap().remove(id);
            let aside = paths.directory.join(format!("{}.set-aside-{}", MANIFEST_NAME, base36(now_ms())));
            if let Err(e) = fs::rename(&paths.manifest, &aside) {
                if code_of(&e) != "ENOENT" {
                    return Err(se("MANIFEST_WRITE_FAILED"));
                }
            }
            let _ = fs::remove_file(&paths.journal);
            let _ = fs::remove_file(&paths.temporary);
            let _ = Self::sync_directory(&paths.directory);
            Ok(true)
        })
    }

    fn remember_written(&self, id: &str, paths: &Paths, manifest: &Manifest, journal: JournalState) {
        let mut lw = self.last_written.lock().unwrap();
        match fs::symlink_metadata(&paths.manifest) {
            Ok(st) if st.is_file() && !st.file_type().is_symlink() => {
                lw.insert(id.to_string(), Cached { manifest: manifest.clone(), identity: identity_of(&st), journal });
            }
            _ => {
                lw.remove(id);
            }
        }
    }

    fn journal_bytes_on_disk(paths: &Paths) -> i64 {
        match fs::symlink_metadata(&paths.journal) {
            Ok(st) if st.is_file() && !st.file_type().is_symlink() => st.len() as i64,
            Ok(_) => -1,
            Err(e) if code_of(&e) == "ENOENT" => 0,
            Err(_) => -1,
        }
    }

    fn current_manifest(&self, id: &str) -> R<(Option<Manifest>, Option<JournalState>)> {
        let cached = self.last_written.lock().unwrap().remove(id);
        if let Some(c) = cached {
            if let Ok(paths) = self.job_paths(id) {
                if let Ok(st) = fs::symlink_metadata(&paths.manifest) {
                    let idn = identity_of(&st);
                    if st.is_file() && !st.file_type().is_symlink() && same_identity(&idn, &c.identity) && idn.ctime == c.identity.ctime && Self::journal_bytes_on_disk(&paths) == c.journal.bytes as i64 {
                        return Ok((Some(c.manifest), Some(c.journal)));
                    }
                }
            }
        }
        Ok((self.read_manifest(id)?, None))
    }

    fn journal_record(current: &Manifest, next: &Manifest) -> Option<String> {
        if next.items.len() < current.items.len() {
            return None;
        }
        let mut set = String::from("[");
        let mut n = 0;
        for (i, cur) in current.items.iter().enumerate() {
            let nx = &next.items[i];
            if Arc::ptr_eq(nx, cur) {
                continue;
            }
            if nx.id() != cur.id() {
                return None;
            }
            if n > 0 {
                set.push(',');
            }
            n += 1;
            set.push_str(&format!("[{},{}]", i, serde_json::to_string(&nx.value).unwrap()));
        }
        set.push(']');
        let add = &next.items[current.items.len()..];
        let mut line = format!("{{\"r\":{},\"top\":{},\"set\":{}", next.revision(), serde_json::to_string(&next.top).unwrap(), set);
        if !add.is_empty() {
            line.push_str(",\"add\":");
            line.push_str(&items_json(add));
        }
        line.push_str("}\n");
        Some(line)
    }

    /// transition(id, patch): the job with these changes, one revision on.
    pub fn transition(&self, id: &str, patch: Patch) -> R<Manifest> {
        diagnosed(id, "transition", self.transition_inner(id, patch))
    }

    fn transition_inner(&self, id: &str, patch: Patch) -> R<Manifest> {
        assert_safe_job_id(id)?;
        for k in patch.top.keys() {
            if ["id", "schemaVersion", "revision", "items"].contains(&k.as_str()) {
                return Err(normalize::refused(&normalize::field_name(k), "field cannot be changed by a transition"));
            }
            if !TOP_FIELDS.contains(&k.as_str()) {
                let mut e = normalize::refused(&normalize::field_name(k), "field is not allowed");
                if is_sensitive_field(k) { e.code = "SENSITIVE_MANIFEST_DATA".into(); }
                return Err(e);
            }
        }
        let previous = self.hooks.as_ref().and_then(|_| self.last_seen.lock().unwrap().get(id).cloned());
        if let (Some(h), Some(prev)) = (&self.hooks, &previous) {
            h.before_write(&patch, prev);
        }
        let next = self.exclusive(id, || {
            let (current, journal) = self.current_manifest(id)?;
            let Some(current) = current else { return Err(se("JOB_NOT_FOUND")) };
            let mut top = current.top.clone();
            for (k, v) in &patch.top {
                top.insert(k.clone(), v.clone());
            }
            top.insert("revision".into(), Value::from(current.revision() + 1));
            let items: Vec<ItemIn> = match &patch.items {
                Some(i) => i.clone(),
                None => current.items.iter().cloned().map(ItemIn::Trusted).collect(),
            };
            let next = normalize_parts(&top, &items)?;
            check_moves(&current, &next)?;
            let paths = self.ensure_job_directory(id)?;
            let line = journal.filter(|j| j.records < JOURNAL_LIMIT_RECORDS).and_then(|_| Self::journal_record(&current, &next));
            let written = match (&line, journal) {
                (Some(l), Some(j)) if j.bytes + l.len() as u64 <= JOURNAL_LIMIT_BYTES => {
                    Self::append_journal(&paths, l, j.bytes)?;
                    Some(JournalState { records: j.records + 1, bytes: j.bytes + l.len() as u64 })
                }
                _ => {
                    if Self::write_full(&paths, &next)? {
                        Some(JournalState { records: 0, bytes: 0 })
                    } else {
                        None
                    }
                }
            };
            match written {
                Some(w) if !next.state().is_terminal() => self.remember_written(id, &paths, &next, w),
                _ => {
                    self.last_written.lock().unwrap().remove(id);
                }
            }
            Ok(next)
        })?;
        if let Some(h) = &self.hooks {
            h.after_write(&next, previous.as_ref());
            self.last_seen.lock().unwrap().insert(id.to_string(), next.clone());
        }
        Ok(next)
    }

    fn recovery_action(current: &Manifest, facts: &Facts) -> &'static str {
        use JobState::*;
        match current.state() {
            Staging | Encoding | WritingTelemetry | Verifying => {
                if facts.backup_exists || facts.final_valid {
                    return "manual-intervention";
                }
                let item = current.active_item();
                let nonempty = |v: Option<&Value>| v.and_then(Value::as_object).is_some_and(|o| !o.is_empty());
                let owns = nonempty(current.get("ownedPaths")) || nonempty(item.and_then(|i| i.get("ownedPaths")));
                if facts.candidate_exists || facts.partial_exists || owns { "cleanup-and-restart-encoding" } else { "restart-encoding" }
            }
            Waiting => {
                if current.get("discoveryComplete") == Some(&Value::Bool(false)) { "resume-discovery" } else { "resume-queue" }
            }
            Discovering => "resume-discovery",
            Copying => {
                if facts.candidate_exists || facts.source_exists || facts.backup_exists {
                    return "manual-intervention";
                }
                if facts.partial_exists && facts.final_exists && facts.final_valid && facts.partial_final_same_identity {
                    return "finalize-copy";
                }
                match (facts.partial_exists, facts.final_exists, facts.final_valid) {
                    (false, false, false) => "restart-copy",
                    (false, true, true) => "finalize-copy",
                    (true, false, false) => "resume-copy",
                    _ => "manual-intervention",
                }
            }
            Replacing => {
                let has_expected = current.active_item().is_some_and(|i| i.get("expectedSource").is_some_and(normalize::truthy));
                recovery::replacement_action(current.replacement_phase().as_ref(), Some(facts), has_expected)
            }
            Completed | Skipped | Failed | Paused | PausedNetwork | Cancelled | Unknown(_) => "manual-intervention",
        }
    }

    /// recover(id, inspectPaths, { reinspectReplacement })
    pub fn recover(&self, id: &str, inspect: &mut dyn FnMut(&Manifest) -> R<Facts>, reinspect_replacement: bool) -> R<Manifest> {
        assert_safe_job_id(id)?;
        let out = self.exclusive(id, || {
            let Some(stored) = self.read_manifest(id)? else { return Err(se("JOB_NOT_FOUND")) };
            let recovery_v = stored.get("recovery").cloned();
            let recorded = |k: &str| recovery_v.as_ref().and_then(|r| r.get(k)).and_then(Value::as_str);
            let phase = stored.replacement_phase().or_else(|| recorded("phase").map(ReplacementPhase::parse));
            let state = stored.state();
            let has_recovery = recovery_v.as_ref().is_some_and(normalize::truthy);
            let reinspect = reinspect_replacement
                && state == JobState::Paused
                && recorded("fromState").map(JobState::parse) == Some(JobState::Replacing)
                && stored.str("activeItemId").is_some()
                && phase.as_ref().is_some_and(ReplacementPhase::is_known);
            if !reinspect && (state.is_terminal() || (state.is_paused() && has_recovery)) {
                return Ok(stored);
            }
            let nonempty = |v: Option<&Value>| v.and_then(Value::as_object).is_some_and(|o| !o.is_empty());
            let owns_files = |i: &Arc<Item>| i.state().is_in_flight() && nonempty(i.get("ownedPaths"));
            let job_owns = stored.str("activeItemId").is_some() && nonempty(stored.get("ownedPaths"));
            if !reinspect && state == JobState::Paused && !has_recovery && !job_owns && !stored.items.iter().any(owns_files) {
                return Ok(stored);
            }
            let mut current = stored.clone();
            if reinspect {
                current.top.insert("state".into(), JobState::Replacing.into());
                current.top.insert("replacementPhase".into(), phase.clone().unwrap().into());
                current.top.insert("recovery".into(), Value::Null);
            } else if (state == JobState::Paused && !has_recovery) || (state == JobState::Copying && current.config()["outputMode"] == "replace") {
                current.top.insert("state".into(), JobState::Encoding.into());
            }
            let facts = match inspect(&current) {
                Ok(f) => f,
                Err(e) => {
                    eprintln!("[CONVERTER] The interrupted clip's files could not be checked: {} {}", e.code_or("ERROR"), e.message.chars().take(300).collect::<String>());
                    return Err(se("INSPECTION_FAILED"));
                }
            };
            let cstate = current.state();
            let mut rec = Map::new();
            rec.insert("fromState".into(), Value::from(if cstate.is_encoding_step() { JobState::Encoding } else { cstate.clone() }));
            if cstate == JobState::Replacing {
                rec.insert("phase".into(), current.get("replacementPhase").cloned().unwrap_or(Value::Null));
            }
            rec.insert("action".into(), Value::from(Self::recovery_action(&current, &facts)));
            let mut top = stored.top.clone();
            top.insert("state".into(), state.to(JobState::Paused)?.into());
            top.insert("revision".into(), Value::from(stored.revision() + 1));
            top.insert("recovery".into(), Value::Object(rec));
            if reinspect {
                top.insert("replacementPhase".into(), phase.unwrap().into());
            }
            let items: Vec<ItemIn> = stored.items.iter().cloned().map(ItemIn::Trusted).collect();
            let recovered = normalize_parts(&top, &items)?;
            let paths = self.ensure_job_directory(id)?;
            self.last_written.lock().unwrap().remove(id);
            Self::write_full(&paths, &recovered)?;
            Ok(recovered)
        })?;
        if self.hooks.is_some() {
            self.last_seen.lock().unwrap().insert(id.to_string(), out.clone());
        }
        Ok(out)
    }
}

fn own_all(holder: &Map<String, Value>, owned: &mut Map<String, Value>) {
    let mut own = |v: Option<&Value>| {
        if let Some(Value::String(s)) = v {
            owned.insert(format!("p{}", owned.len()), Value::String(s.clone()));
        }
    };
    if let Some(Value::Object(p)) = holder.get("ownedPaths") {
        for v in p.values() {
            own(Some(v));
        }
    }
    if let Some(Value::Object(a)) = holder.get("ownedArtifacts") {
        for v in a.values() {
            own(v.get("path"));
        }
    }
    if let Some(p) = holder.get("publicationArtifact") {
        own(p.get("path"));
    }
}

/// summarize(manifest): all of it but its clip list, the clip results counted.
pub fn summarize(m: &Manifest) -> Value {
    let mut out = Map::new();
    for (k, v) in &m.top {
        if k != "items" {
            out.insert(k.clone(), v.clone());
        }
    }
    out.insert("items".into(), Value::Array(vec![]));
    let mut owned = Map::new();
    own_all(&m.top, &mut owned);
    let (mut converted, mut skipped, mut failed, mut progress) = (0, 0, 0, 0);
    for item in &m.items {
        if let Some(o) = item.value.as_object() {
            own_all(o, &mut owned);
        }
        if item.str("kind") != Some("video") {
            continue;
        }
        match item.state() {
            ItemState::Completed if item.get("eligibleVideo") != Some(&Value::Bool(false)) => {
                converted += 1;
                progress += 1;
            }
            ItemState::Skipped => skipped += 1,
            ItemState::Failed => failed += 1,
            _ => {}
        }
    }
    out.insert("ownedPaths".into(), Value::Object(owned));
    out.insert("itemCounts".into(), serde_json::json!({ "converted": converted, "skipped": skipped, "failed": failed }));
    out.insert("progressClips".into(), Value::from(progress));
    out.insert("itemTotal".into(), Value::from(m.items.len()));
    Value::Object(out)
}
