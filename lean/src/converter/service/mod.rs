//! src/main/converter/jobService.js: the conversion pipeline over the job
//! store and the staging area, with Node's rules for what is written when,
//! which clip owns the job-level fields (the lead, the save slot holder),
//! and how a stop, a pause, a cancel, an outage and a restart end.
//!
//! Threads instead of promises: each job runs on its own thread with one
//! worker thread per conversion at once; every job-file write goes through
//! one lock per job (Node's persistChain). Ported for this server's jobs:
//! encoding on this server (lanes are kept in the job and run as its plain
//! number at once, as Node does when none of a job's GPUs is found; helper
//! servers are not ported yet).

mod encode;
pub mod lanes;
mod recover;
pub mod tools;
mod work;
#[cfg(test)]
mod tests;
#[cfg(test)]
pub mod lanes_tests;
#[cfg(test)]
mod node_tests;
#[cfg(test)]
mod refusal_tests;

pub use encode::{parse_progress_line, Progress};

use super::contracts;
use super::error::CError;
use super::jobstore::states::{ItemState, JobState, ReplacementPhase};
use super::jobstore::{ItemIn, JobStore, Manifest, Patch};
use super::staging::{self, Tx};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use tools::Tools;

// (ACTIVE_STATES, TERMINAL_STATES, IDLE_JOB_STATES: JobState::is_active, is_terminal, is_idle)
pub const OWNED_KEYS: [&str; 6] = ["stagedSource", "encodedCandidate", "publicationSnapshot", "destinationPartial", "replacementCandidate", "replacementBackup"];
const PRIVATE_SNAPSHOT_KEYS: [&str; 3] = ["ownedPaths", "ownedArtifacts", "publicationArtifact"];
pub const MAX_RECORDED_ATTEMPTS: i64 = 3;
pub const UNDER_SOURCE_SHARES: [f64; 2] = [0.85, 0.6];
pub const QUICK_RETRY_LIMIT: u32 = 2;
pub const SOURCE_READS_AT_ONCE: usize = 2;

/// An error as the service sees it: a code, and what Node attaches to one.
#[derive(Debug, Clone, Default)]
pub struct Fail {
    pub code: Option<String>,
    pub retryable: bool,
    pub path: Option<String>,
    pub network_probe_path: Option<String>,
    pub path_role: Option<String>,
    pub valid_final: Option<staging::Saved>,
    pub rolled_back: bool,
    pub replacement_record_stale: bool,
    pub cleanup_pending: Option<Vec<String>>,
    /// unsafe-owned-path only: which check refused and what did not match
    /// (staging::TxError::detail)
    pub detail: Option<String>,
}

impl Fail {
    pub fn code(code: &str) -> Fail {
        Fail { code: Some(code.into()), ..Default::default() }
    }
    pub fn is(&self, code: &str) -> bool {
        self.code.as_deref() == Some(code)
    }
}

impl From<CError> for Fail {
    fn from(e: CError) -> Fail {
        Fail { code: if e.code.is_empty() { None } else { Some(e.code) }, ..Default::default() }
    }
}

impl From<staging::TxError> for Fail {
    fn from(e: staging::TxError) -> Fail {
        Fail {
            code: Some(e.code.clone()),
            valid_final: e.valid_final.map(|b| *b),
            rolled_back: e.rolled_back.is_some(),
            cleanup_pending: e.cleanup_pending,
            detail: e.detail,
            ..Default::default()
        }
    }
}

// ---- refusal details -------------------------------------------------------------

/// Why a clip's unsafe-owned-path or source-changed refusal fired, by (job
/// id, item id). Kept in memory only and shown as `failure.detail` in the job
/// snapshot of a clip whose failure is one of those: the job file keeps Node's format
/// (its failure record allows only code and retryable), so the stored job,
/// and every snapshot compared with Node's, are unchanged.
static FAILURE_DETAILS: Mutex<Option<HashMap<(String, String), String>>> = Mutex::new(None);
const MAX_FAILURE_DETAILS: usize = 4096;
pub const UNSAFE_OWNED_PATH_RESULT: &str = "unsafe-owned-path";
pub const SOURCE_CHANGED_RESULT: &str = "source-changed";
/// The failure codes whose refusal says why (logged with the clip's name,
/// failure.detail in the snapshot), and the name each is logged under.
pub fn detailed_failure(code: &str) -> Option<&'static str> {
    match code {
        UNSAFE_OWNED_PATH_RESULT => Some("UNSAFE_OWNED_PATH"),
        SOURCE_CHANGED_RESULT => Some("SOURCE_CHANGED"),
        _ => None,
    }
}
/// The detail of a stored unsafe-owned-path or source-changed failure whose reason this
/// process never saw (the details are kept in memory only).
pub const DETAIL_NOT_KNOWN: &str = "not known: this clip failed before the server last restarted; run it again (Retry failed, or a new job if Retry failed is refused) to see why";
/// The detail of a refusal that named no check (no such refusal is known).
pub const DETAIL_NOT_RECORDED: &str = "not recorded: the refusal named no check";

/// One line on the app's stderr (the container log). Tests see the lines.
pub(crate) fn log_line(line: String) {
    eprintln!("{line}");
    #[cfg(test)]
    LOGGED.lock().unwrap_or_else(|p| p.into_inner()).push(line);
}
#[cfg(test)]
pub(crate) static LOGGED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// A clip that ends with unsafe-owned-path or source-changed: one log line
/// naming the clip (its relative path), the check and the values that did
/// not match, and the detail kept for the job snapshot. Returns the detail
/// recorded.
pub fn note_clip_refusal(job: &str, item: &str, relative_path: &str, e: &Fail) -> String {
    let detail = e.detail.clone().filter(|d| !d.is_empty()).unwrap_or_else(|| DETAIL_NOT_RECORDED.to_string());
    let label = detailed_failure(&stable_failure(e, "operation-failed")).unwrap_or("UNSAFE_OWNED_PATH");
    log_line(format!("[CONVERTER] {label} clip {relative_path:?} ({job} {item}) failed: {detail}"));
    set_failure_detail(job, item, Some(&detail));
    detail
}

/// Record (or, with None, forget) the refusal detail of a clip's failure.
pub fn set_failure_detail(job: &str, item: &str, detail: Option<&str>) {
    let mut g = FAILURE_DETAILS.lock().unwrap_or_else(|p| p.into_inner());
    let map = g.get_or_insert_with(HashMap::new);
    let key = (job.to_string(), item.to_string());
    match detail {
        Some(d) => {
            if map.len() >= MAX_FAILURE_DETAILS && !map.contains_key(&key) {
                // (one forgotten, not all: a forgotten one shows DETAIL_NOT_KNOWN)
                if let Some(k) = map.keys().next().cloned() {
                    map.remove(&k);
                }
            }
            map.insert(key, d.to_string());
        }
        None => {
            map.remove(&key);
        }
    }
}

pub fn failure_detail(job: &str, item: &str) -> Option<String> {
    let g = FAILURE_DETAILS.lock().unwrap_or_else(|p| p.into_inner());
    g.as_ref().and_then(|m| m.get(&(job.to_string(), item.to_string())).cloned())
}

/// A failed clip's snapshot with its refusal detail; one this process never
/// saw (the clip failed before a restart) says so.
fn with_failure_detail(job: &str, v: &Value) -> Option<Value> {
    detailed_failure(v.get("failure").and_then(|f| f.get("code")).and_then(Value::as_str)?)?;
    let d = failure_detail(job, v.get("id")?.as_str()?).unwrap_or_else(|| DETAIL_NOT_KNOWN.to_string());
    let mut c = v.clone();
    c["failure"]["detail"] = Value::String(d);
    Some(c)
}

// ---- leftover BACKUP- names ---------------------------------------------------------

/// What a replace job's discovery did with leftover BACKUP- names (leftovers.rs), by job
/// id. In memory only, as FAILURE_DETAILS: the snapshot shows it as `backupCleanup`; the
/// job file and its journal keep their format.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BackupCleanup {
    pub removed: u64,
    pub restored: u64,
    pub binned: u64,
    pub kept: u64,
    /// of the kept: originals beside a converted copy that is not proven good
    pub unverified: u64,
    pub kept_why: Vec<(String, String)>,
}
static BACKUP_CLEANUP: Mutex<Option<HashMap<String, BackupCleanup>>> = Mutex::new(None);
const MAX_BACKUP_CLEANUP_JOBS: usize = 256;
pub const MAX_KEPT_WHY: usize = 20;

/// Count one name's outcome for the job, with its log line.
pub fn note_backup_cleanup(job: &str, rel_dir: &str, name: &str, o: &super::leftovers::Outcome) {
    use super::leftovers::Outcome;
    log_line(super::leftovers::log_line(rel_dir, name, o));
    let mut g = BACKUP_CLEANUP.lock().unwrap_or_else(|p| p.into_inner());
    let map = g.get_or_insert_with(HashMap::new);
    if map.len() >= MAX_BACKUP_CLEANUP_JOBS && !map.contains_key(job) {
        if let Some(k) = map.keys().next().cloned() {
            map.remove(&k);
        }
    }
    let c = map.entry(job.to_string()).or_default();
    match o {
        Outcome::Removed | Outcome::RemovedCopy(_) | Outcome::RemovedExtra(_) => c.removed += 1,
        Outcome::Restored => c.restored += 1,
        Outcome::Binned { .. } => c.binned += 1,
        Outcome::Kept(why) => {
            c.kept += 1;
            if why.starts_with(super::leftovers::UNVERIFIED) {
                c.unverified += 1;
            }
            if c.kept_why.len() < MAX_KEPT_WHY {
                let rel = if rel_dir.is_empty() { name.to_string() } else { format!("{rel_dir}/{name}") };
                c.kept_why.push((rel, why.clone()));
            }
        }
    }
}

pub fn backup_cleanup(job: &str) -> Option<BackupCleanup> {
    let g = BACKUP_CLEANUP.lock().unwrap_or_else(|p| p.into_inner());
    g.as_ref().and_then(|m| m.get(job).cloned())
}

fn backup_cleanup_json(job: &str) -> Option<Value> {
    let c = backup_cleanup(job)?;
    if c == BackupCleanup::default() {
        return None;
    }
    let why: Vec<Value> = c.kept_why.iter().map(|(p, w)| json!({ "path": p, "why": w })).collect();
    Some(json!({ "removed": c.removed, "restored": c.restored, "binned": c.binned, "kept": c.kept, "unverified": c.unverified, "keptWhy": why }))
}

impl std::fmt::Display for Fail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.code.as_deref().unwrap_or("ERROR"))
    }
}

pub type SResult<T> = Result<T, Fail>;

/// stableFailure(error, fallback)
pub fn stable_failure(e: &Fail, fallback: &str) -> String {
    let raw = match &e.code {
        Some(c) => c.to_lowercase().replace('_', "-"),
        None => fallback.to_string(),
    };
    let ok = !raw.is_empty() && raw.len() <= 64 && raw.as_bytes()[0].is_ascii_alphanumeric() && raw.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
    if ok {
        raw
    } else {
        fallback.to_string()
    }
}

// ---- ownership -----------------------------------------------------------------

/// A clip's files: { ownedPaths, ownedArtifacts, publicationArtifact? }
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Own {
    pub paths: Map<String, Value>,
    pub arts: Map<String, Value>,
    pub publication: Option<Value>,
}

impl Own {
    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("ownedPaths".into(), Value::Object(self.paths.clone()));
        m.insert("ownedArtifacts".into(), Value::Object(self.arts.clone()));
        if let Some(p) = &self.publication {
            m.insert("publicationArtifact".into(), p.clone());
        }
        Value::Object(m)
    }
    pub fn paths_typed(&self) -> staging::Paths {
        self.paths.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect()
    }
    pub fn arts_typed(&self) -> staging::Artifacts {
        self.arts.iter().filter_map(|(k, v)| serde_json::from_value(v.clone()).ok().map(|m| (k.clone(), m))).collect()
    }
    pub fn artifact(&self) -> Option<super::snapshot::Artifact> {
        self.publication.as_ref().and_then(|v| serde_json::from_value(v.clone()).ok())
    }
    pub fn from_typed(paths: &staging::Paths, arts: &staging::Artifacts) -> Own {
        Own {
            paths: paths.iter().map(|(k, v)| (k.clone(), Value::from(v.clone()))).collect(),
            arts: arts.iter().map(|(k, v)| (k.clone(), serde_json::to_value(v).unwrap())).collect(),
            publication: None,
        }
    }
}

fn obj(v: Option<&Value>) -> Map<String, Value> {
    v.and_then(Value::as_object).cloned().unwrap_or_default()
}

/// composeOwnership(base, incoming, clearKeys)
pub fn compose(base: &Own, incoming: &Value, clear: &[String]) -> Own {
    let mut paths = base.paths.clone();
    let mut arts = base.arts.clone();
    let incoming_clears: Vec<String> = incoming.get("clearOwnedKeys").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
    for k in clear.iter().chain(incoming_clears.iter()) {
        if !OWNED_KEYS.contains(&k.as_str()) {
            continue;
        }
        paths.shift_remove(k);
        arts.shift_remove(k);
    }
    for (k, v) in obj(incoming.get("ownedPaths")) {
        if OWNED_KEYS.contains(&k.as_str()) {
            paths.insert(k, v);
        }
    }
    for (k, v) in obj(incoming.get("ownedArtifacts")) {
        if OWNED_KEYS.contains(&k.as_str()) {
            arts.insert(k, v);
        }
    }
    let mut publication = None;
    if let Some(p) = incoming.get("publicationArtifact") {
        if super::jobstore::normalize::truthy(p) {
            publication = Some(p.clone());
        }
    } else if let Some(p) = &base.publication {
        publication = Some(p.clone());
    }
    if incoming.get("clearPublicationArtifact") == Some(&Value::Bool(true)) {
        publication = None;
    }
    Own { paths, arts, publication }
}

/// ownershipOf(value)
pub fn ownership_of(v: &Value) -> Own {
    compose(&Own::default(), v, &[])
}

/// A change of a clip's fields: Some sets, None removes (mergeItem).
pub type Changes = Vec<(&'static str, Option<Value>)>;

/// mergeItem(item, changes)
pub fn merge(item: &Value, changes: &Changes) -> Value {
    let mut m = obj(Some(item));
    for (k, v) in changes {
        match v {
            Some(v) => {
                m.insert(k.to_string(), v.clone());
            }
            None => {
                m.shift_remove(*k);
            }
        }
    }
    Value::Object(m)
}

/// the item list with one clip replaced
pub fn with_item(current: &Manifest, id: &str, f: impl FnOnce(&Value) -> Value) -> Vec<ItemIn> {
    let mut f = Some(f);
    current.items.iter().map(|it| if it.id() == id { ItemIn::Raw((f.take().unwrap())(it.value())) } else { ItemIn::Trusted(it.clone()) }).collect()
}

/// The state a paused job's recovery record was taken in (recovery.fromState).
pub fn recorded_from(m: &Manifest) -> Option<JobState> {
    m.get("recovery").and_then(|r| r.get("fromState")).and_then(Value::as_str).map(JobState::parse)
}

/// A clip's state, from a copy of the clip (`RtState::item`) or one being built.
pub fn item_state(item: &Value) -> ItemState {
    ItemState::parse(item["state"].as_str().unwrap_or(""))
}

fn carries_private(item: &Value, key: &str) -> bool {
    match item.get(key) {
        None | Some(Value::Null) => false,
        Some(Value::Object(o)) => !o.is_empty(),
        Some(Value::Array(a)) => !a.is_empty() || true,
        Some(_) => true,
    }
}

/// publicSnapshot(manifest)
pub fn public_snapshot(m: &Manifest) -> Value {
    let mut out = Map::new();
    for (k, v) in &m.top {
        if k == "items" || PRIVATE_SNAPSHOT_KEYS.contains(&k.as_str()) {
            continue;
        }
        out.insert(k.clone(), v.clone());
    }
    let items: Vec<Value> = m
        .items
        .iter()
        .map(|it| {
            let detailed = with_failure_detail(m.id(), it.value());
            let v = detailed.as_ref().unwrap_or_else(|| it.value());
            if !PRIVATE_SNAPSHOT_KEYS.iter().any(|k| carries_private(v, k)) {
                return v.clone();
            }
            let mut c = obj(Some(v));
            for k in PRIVATE_SNAPSHOT_KEYS {
                c.shift_remove(k);
            }
            Value::Object(c)
        })
        .collect();
    // (only when this process tidied something for the job: every other snapshot is as before)
    if let Some(c) = backup_cleanup_json(m.id()) {
        out.insert("backupCleanup".into(), c);
    }
    out.insert("items".into(), Value::Array(items));
    Value::Object(out)
}

/// summaryOf(manifest): the snapshot without clips, the clip results counted
pub fn summary_of(m: &Manifest) -> Value {
    let mut snap = public_snapshot(&Manifest { top: m.top.clone(), items: vec![] });
    let s = super::jobstore::summarize(m);
    for k in ["itemCounts", "progressClips", "itemTotal"] {
        snap[k] = s[k].clone();
    }
    snap
}

/// outputPath(config, item)
pub fn output_path(config: &Value, item: &Value) -> String {
    if config["outputMode"] == "replace" {
        return item["sourcePath"].as_str().unwrap_or("").to_string();
    }
    let mut p = super::owned::resolve(Path::new(config["destinationRoot"].as_str().unwrap_or("/")));
    for part in item["relativePath"].as_str().unwrap_or("").split('/') {
        p.push(part);
    }
    super::owned::resolve(&p).to_string_lossy().to_string()
}

// ---- the service -------------------------------------------------------------

#[derive(Clone)]
pub struct Options {
    pub store: Arc<JobStore>,
    pub staging: Arc<Tx>,
    pub tools: Arc<dyn Tools>,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub backoff_initial_ms: u64,
    pub backoff_max_ms: u64,
    pub encode_stall_ms: u64,
    pub snapshot_interval_ms: u64,
    pub job_clip_limit: usize,
    pub discovery_batch_size: usize,
    pub discovery_flush_ms: i64,
    /// skipDiscovered(config, discovered): clips the host holds back
    pub skip_discovered: Option<Arc<dyn Fn(&Value, &Value) -> bool + Send + Sync>>,
    /// for tests: called with each encode's arguments before it starts
    pub on_spawn: Option<Arc<dyn Fn(&[String]) + Send + Sync>>,
    /// convertedIndex.js: clips known to be converted (only the real service has one)
    pub converted_index: Option<Arc<super::converted_index::ConvertedIndex>>,
    /// how long one MP4 header check may take before the clip takes the normal path
    pub header_check_timeout_ms: u64,
    /// resolveDevice(id): a lane's device from the devices the container has
    /// now (devices.rs, plus the helper servers' when they are ported)
    pub resolve_device: Option<Arc<dyn Fn(&str) -> Option<Value> + Send + Sync>>,
    /// defaultDevice(codec): the device a job without lanes encodes on
    pub default_device: Option<Arc<dyn Fn(&str) -> Option<String> + Send + Sync>>,
    /// setNodeSlots(nodeKey, slots): a helper server told how many it converts at once
    pub set_node_slots: Option<Arc<dyn Fn(&str, &Value) -> Result<(), String> + Send + Sync>>,
    /// the helper servers (index.js remoteNodes): a node lane's clip is encoded there
    pub remote_nodes: Option<Arc<dyn lanes::NodeLanes>>,
    /// comparePicture(source, candidate, cancel, durationSeconds): a node's
    /// encode shows the original's pictures (nodes::picture::compare_pictures)
    pub compare_picture: Option<Arc<dyn Fn(&str, &str, &Arc<AtomicBool>, Option<f64>) -> Value + Send + Sync>>,
    /// decodeAccel(encoder, zeroCopy, device): GPU decode arguments (None: CPU decode)
    pub decode_accel: Option<Arc<dyn Fn(&str, bool, Option<&super::planner::Device>) -> Option<Vec<String>> + Send + Sync>>,
    /// the Recycle Bin for an original left beside its converted copy (leftovers.rs)
    pub originals_bin: Option<Arc<dyn super::leftovers::OriginalsBin>>,
}

impl Options {
    pub fn new(store: Arc<JobStore>, staging: Arc<Tx>, tools: Arc<dyn Tools>) -> Options {
        Options {
            store,
            staging,
            tools,
            now: Arc::new(|| super::jobstore::now_ms() as i64),
            backoff_initial_ms: 1_000,
            backoff_max_ms: 30_000,
            encode_stall_ms: 10 * 60_000,
            snapshot_interval_ms: 250,
            job_clip_limit: 40_000,
            // (runtime.js: 200 at a time, every 250 ms while workers wait)
            discovery_batch_size: 200,
            discovery_flush_ms: 250,
            skip_discovered: None,
            on_spawn: None,
            converted_index: None,
            header_check_timeout_ms: 20_000,
            resolve_device: None,
            default_device: None,
            set_node_slots: None,
            decode_accel: None,
            remote_nodes: None,
            compare_picture: None,
            originals_bin: None,
        }
    }
}

pub type Listener = Arc<dyn Fn(&Value) + Send + Sync>;

/// One running ffmpeg (activeEncodes)
#[derive(Clone)]
pub struct ChildEntry {
    pub pid: i32,
    pub termination_requested: bool,
    /// a helper server's encode (no process here)
    pub remote: Option<Arc<dyn Fn(&str) + Send + Sync>>,
    /// taken back from a node's queue (its row set lower)
    pub withdrawn: bool,
}

/// The runtime of one job (runtimeFor).
pub struct RtState {
    pub manifest: Manifest,
    pub queue: VecDeque<String>,
    pub queue_closed: bool,
    pub producer_done: bool,
    pub pause_requested: bool,
    pub cancel_requested: bool,
    pub stop_requested: bool,
    pub halted: bool,
    pub recovery_required: bool,
    pub recovery_item_id: Option<String>,
    pub pause_generation: u64,
    pub parked_workers: usize,
    pub live_workers: usize,
    pub retiring: usize,
    pub pause_persisted: bool,
    pub children: HashMap<String, ChildEntry>,
    pub encode_fps: HashMap<String, f64>,
    pub encodes: Vec<(String, Value)>,
    pub ownerships: HashMap<String, Own>,
    pub in_flight: Vec<String>,
    pub lead_item_id: Option<String>,
    pub commit_holder: Option<String>,
    pub running: bool,
    pub run_kind: Option<&'static str>,
    /// the step a stop interrupted (the job's state, or the one its pause recorded)
    pub stop_phase: Option<JobState>,
    pub stop_item_id: Option<String>,
    pub stop_while_paused: bool,
    pub item_sequence: usize,
    pub network_pause_owner: Option<u64>,
    pub last_progress: Option<Value>,
    pub suppress_launch: bool,
    pub snapshot_pending: bool,
    pub workers: Vec<std::thread::JoinHandle<SResult<()>>>,
    pub release_recovery: Option<bool>,
    /// workers per lane (None: the default lane of a job without lanes): (live, retiring)
    pub lane_counters: HashMap<Option<String>, (usize, usize)>,
    /// the lanes whose GPUs were found, while the job runs with lanes
    pub lane_plan: Option<lanes::LanePlan>,
    /// the device a job without lanes encodes on, once a switch needed it (None: not looked up)
    pub default_lane: Option<Option<String>>,
    /// consume() runs (Node: runtime.addWorker is set)
    pub consuming: bool,
    /// a node's clips being checked here, per node (takeCheckSlot)
    pub node_checks: HashMap<String, usize>,
}

pub struct Runtime {
    pub st: Mutex<RtState>,
    pub cv: Condvar,
    pub persist: Mutex<()>,
    pub abort: Mutex<Arc<AtomicBool>>,
}

impl Runtime {
    fn new(manifest: Manifest) -> Arc<Runtime> {
        let n = manifest.items.len();
        Arc::new(Runtime {
            st: Mutex::new(RtState {
                manifest,
                queue: VecDeque::new(),
                queue_closed: false,
                producer_done: false,
                pause_requested: false,
                cancel_requested: false,
                stop_requested: false,
                halted: false,
                recovery_required: false,
                recovery_item_id: None,
                pause_generation: 0,
                parked_workers: 0,
                live_workers: 0,
                retiring: 0,
                pause_persisted: false,
                children: HashMap::new(),
                encode_fps: HashMap::new(),
                encodes: vec![],
                ownerships: HashMap::new(),
                in_flight: vec![],
                lead_item_id: None,
                commit_holder: None,
                running: false,
                run_kind: None,
                stop_phase: None,
                stop_item_id: None,
                stop_while_paused: false,
                item_sequence: n,
                network_pause_owner: None,
                last_progress: None,
                suppress_launch: false,
                snapshot_pending: false,
                workers: vec![],
                release_recovery: None,
                lane_counters: HashMap::new(),
                lane_plan: None,
                default_lane: None,
                consuming: false,
                node_checks: HashMap::new(),
            }),
            cv: Condvar::new(),
            persist: Mutex::new(()),
            abort: Mutex::new(Arc::new(AtomicBool::new(false))),
        })
    }
    pub fn lock(&self) -> MutexGuard<'_, RtState> {
        self.st.lock().unwrap_or_else(|p| p.into_inner())
    }
    pub fn manifest(&self) -> Manifest {
        self.lock().manifest.clone()
    }
    pub fn signal(&self) -> Arc<AtomicBool> {
        self.abort.lock().unwrap().clone()
    }
    pub fn aborted(&self) -> bool {
        self.signal().load(Ordering::SeqCst)
    }
    pub fn do_abort(&self) {
        self.signal().store(true, Ordering::SeqCst);
        self.cv.notify_all();
    }
}

impl RtState {
    /// isLead(runtime, itemId)
    pub fn is_lead(&self, item: &str) -> bool {
        if self.recovery_required {
            return self.recovery_item_id.as_deref() == Some(item);
        }
        if let Some(h) = &self.commit_holder {
            return h == item;
        }
        if self.in_flight.len() <= 1 {
            return true;
        }
        self.lead_item_id.as_deref() == Some(item)
    }
    pub fn lead_item_id(&self) -> Option<String> {
        self.commit_holder.clone().or_else(|| self.lead_item_id.clone())
    }
    pub fn item(&self, id: &str) -> Option<Value> {
        self.manifest.item(id).map(|i| i.value().clone())
    }
    pub fn concurrency(&self) -> usize {
        let c = self.manifest.config().get("concurrency").cloned().unwrap_or(Value::Null);
        if contracts::is_valid_concurrency(&c) {
            c.as_i64().unwrap() as usize
        } else {
            contracts::CONCURRENCY_FALLBACK as usize
        }
    }
    pub fn stopped(&self) -> bool {
        self.cancel_requested || self.stop_requested
    }
}

pub struct Inner {
    pub o: Options,
    pub jobs: Mutex<HashMap<String, Arc<Runtime>>>,
    pub listeners: Mutex<Vec<(u64, Listener)>>,
    pub listener_seq: AtomicU64,
    pub shutting_down: AtomicBool,
    pub command: Mutex<()>,
    pub owner_seq: AtomicU64,
    pub reads: Arc<(Mutex<usize>, Condvar)>,
    /// clips a node gave back, encoded here at once (NODE_FALLBACK_AT_ONCE, every job)
    pub fallbacks: Arc<(Mutex<usize>, Condvar)>,
    /// decode tiers found broken per GPU and encoder (encodeDecodeBroken)
    pub decode_broken: Mutex<std::collections::HashSet<String>>,
    /// verify decodes that fell back to the CPU, per GPU and encoder
    pub verify_fallbacks: Mutex<HashMap<String, u32>>,
}

/// createConverterJobService
#[derive(Clone)]
pub struct Service(pub Arc<Inner>);

pub fn service_error(code: &str) -> Fail {
    Fail::code(code)
}

impl Service {
    pub fn new(o: Options) -> Service {
        Service(Arc::new(Inner {
            o,
            jobs: Mutex::new(HashMap::new()),
            listeners: Mutex::new(vec![]),
            listener_seq: AtomicU64::new(0),
            shutting_down: AtomicBool::new(false),
            command: Mutex::new(()),
            owner_seq: AtomicU64::new(1),
            reads: Arc::new((Mutex::new(0), Condvar::new())),
            fallbacks: Arc::new((Mutex::new(0), Condvar::new())),
            decode_broken: Mutex::new(Default::default()),
            verify_fallbacks: Mutex::new(HashMap::new()),
        }))
    }

    pub fn store(&self) -> &Arc<JobStore> {
        &self.0.o.store
    }

    // ---- events

    /// subscribe(listener): returns its id for unsubscribe
    pub fn subscribe(&self, l: Listener) -> u64 {
        let id = self.0.listener_seq.fetch_add(1, Ordering::SeqCst);
        self.0.listeners.lock().unwrap().push((id, l));
        id
    }
    pub fn unsubscribe(&self, id: u64) {
        self.0.listeners.lock().unwrap().retain(|(i, _)| *i != id);
    }
    fn has_listeners(&self) -> bool {
        !self.0.listeners.lock().unwrap().is_empty()
    }

    /// emit(runtime, type, fields)
    pub fn emit(&self, rt: &Runtime, kind: &str, fields: Vec<(&str, Value)>) {
        if !self.has_listeners() {
            return;
        }
        let (id, revision) = {
            let s = rt.lock();
            (s.manifest.id().to_string(), s.manifest.revision())
        };
        self.emit_raw(kind, &id, Some(revision), fields);
    }
    fn emit_raw(&self, kind: &str, id: &str, revision: Option<i64>, fields: Vec<(&str, Value)>) {
        let mut m = Map::new();
        m.insert("type".into(), json!(kind));
        m.insert("jobId".into(), json!(id));
        if let Some(r) = revision {
            m.insert("revision".into(), json!(r));
        }
        for (k, v) in fields {
            m.insert(k.into(), v);
        }
        let event = Value::Object(m);
        let ls: Vec<Listener> = self.0.listeners.lock().unwrap().iter().map(|(_, l)| l.clone()).collect();
        for l in ls {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| l(&event)));
        }
    }

    fn snapshot_urgent(previous: &Manifest, next: &Manifest) -> bool {
        let (ps, ns) = (previous.state(), next.state());
        if ps != ns && (ps.is_idle() || ns.is_idle()) {
            return true;
        }
        let same = |k: &str| previous.get(k).unwrap_or(&Value::Null) == next.get(k).unwrap_or(&Value::Null);
        !same("recovery") || !same("failure") || !same("summary") || previous.get("summaryDismissed") != next.get("summaryDismissed")
    }

    fn queue_snapshot(&self, rt: &Arc<Runtime>, urgent: bool) {
        if !self.has_listeners() {
            return;
        }
        if urgent || self.0.o.snapshot_interval_ms == 0 {
            let snap = public_snapshot(&rt.manifest());
            self.emit(rt, "snapshot", vec![("snapshot", snap)]);
            return;
        }
        {
            let mut s = rt.lock();
            if s.snapshot_pending {
                return;
            }
            s.snapshot_pending = true;
        }
        let me = self.clone();
        let rt = rt.clone();
        let ms = self.0.o.snapshot_interval_ms;
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(ms));
            rt.lock().snapshot_pending = false;
            if me.has_listeners() {
                let snap = public_snapshot(&rt.manifest());
                me.emit(&rt, "snapshot", vec![("snapshot", snap)]);
            }
        });
    }

    // ---- writes

    /// update(runtime, buildPatch): one job-file write at a time per job.
    pub fn update(&self, rt: &Arc<Runtime>, build: impl FnOnce(&RtState) -> Option<Patch>) -> SResult<Manifest> {
        let _chain = rt.persist.lock().unwrap_or_else(|p| p.into_inner());
        let (patch, previous) = {
            let s = rt.lock();
            (build(&s), s.manifest.clone())
        };
        let Some(mut patch) = patch else { return Ok(previous) };
        let new_state = patch.top.get("state").and_then(Value::as_str).map(JobState::parse);
        if let Some(ns) = &new_state {
            if !ns.is_paused() && !patch.top.contains_key("recovery") && recorded_from(&previous) == Some(JobState::PausedNetwork) {
                patch.top.insert("recovery".into(), Value::Null);
            }
            if *ns != previous.state() && !patch.top.contains_key("updatedAt") {
                let at = (self.0.o.now)();
                patch.top.insert("updatedAt".into(), json!(at));
                if previous.state().is_idle() {
                    if let Some(prev_at) = previous.get("updatedAt").and_then(Value::as_i64) {
                        if at > prev_at {
                            let paused = previous.get("pausedMs").and_then(Value::as_i64).unwrap_or(0);
                            patch.top.insert("pausedMs".into(), json!(paused + (at - prev_at)));
                        }
                    }
                }
            }
        }
        let next = self.0.o.store.transition(previous.id(), patch).map_err(Fail::from)?;
        rt.lock().manifest = next.clone();
        self.queue_snapshot(rt, Self::snapshot_urgent(&previous, &next));
        Ok(next)
    }

    /// itemPatch(runtime, itemId, changes, jobChanges)
    pub fn item_patch(&self, rt: &Arc<Runtime>, item_id: &str, changes: Changes, job: Vec<(&'static str, Value)>) -> SResult<Manifest> {
        self.update(rt, |s| {
            let lead = s.is_lead(item_id);
            if !lead && changes.is_empty() {
                return None;
            }
            let mut p = Patch::new();
            if lead {
                for (k, v) in job {
                    p = p.set(k, v);
                }
            }
            Some(p.items(with_item(&s.manifest, item_id, |it| merge(it, &changes))))
        })
    }

    /// transactionPersistence(runtime, itemId, { scope }) as the staging area's persist callback
    pub fn persistence(&self, rt: &Arc<Runtime>, item_id: &str, item_scope: bool) -> impl Fn(&Value) -> Result<(), String> + Sync + Send {
        let me = self.clone();
        let rt = rt.clone();
        let item_id = item_id.to_string();
        move |snapshot: &Value| -> Result<(), String> {
            let clear: Vec<String> = snapshot.get("clearOwnedKeys").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
            let phase = snapshot.get("phase").and_then(Value::as_str).and_then(ReplacementPhase::known);
            let combined: Arc<Mutex<Option<Own>>> = Arc::new(Mutex::new(None));
            let c2 = combined.clone();
            me.update(&rt, |s| {
                let item = s.manifest.item(&item_id).map(|i| i.value().clone());
                let base = match &item {
                    Some(i) => ownership_of(i),
                    None => ownership_of(&Value::Object(s.manifest.top.clone())),
                };
                let comb = compose(&base, snapshot, &clear);
                let mut changes: Changes = vec![("ownedPaths", Some(Value::Object(comb.paths.clone()))), ("ownedArtifacts", Some(Value::Object(comb.arts.clone())))];
                changes.push(("publicationArtifact", comb.publication.clone()));
                if let Some(p) = &phase {
                    changes.push(("replacementPhase", Some(p.clone().into())));
                }
                if let Some(e) = snapshot.get("itemFields").and_then(|f| f.get("expectedSource")) {
                    if super::jobstore::normalize::truthy(e) {
                        changes.push(("expectedSource", Some(e.clone())));
                    }
                }
                let items = match &item {
                    Some(_) => with_item(&s.manifest, &item_id, |it| merge(it, &changes)),
                    None => s.manifest.items.iter().cloned().map(ItemIn::Trusted).collect(),
                };
                *c2.lock().unwrap() = Some(comb.clone());
                if phase.is_none() && (item_scope || !s.is_lead(&item_id)) {
                    return Some(Patch::new().items(items));
                }
                let mut p = Patch::new();
                if let Some(ph) = &phase {
                    p = p.set("replacementPhase", ph.clone().into()).state(JobState::Replacing).set("activeItemId", json!(item_id));
                }
                Some(p.set("ownedPaths", Value::Object(comb.paths.clone())).set("ownedArtifacts", Value::Object(comb.arts.clone())).set("publicationArtifact", comb.publication.clone().unwrap_or(Value::Null)).items(items))
            })
            .map_err(|e| e.to_string())?;
            if let Some(c) = combined.lock().unwrap().take() {
                rt.lock().ownerships.insert(item_id.clone(), c);
            }
            Ok(())
        }
    }

    pub fn ownership_for(rt: &Runtime, id: &str) -> Option<Own> {
        rt.lock().ownerships.get(id).cloned()
    }
    pub fn set_ownership(rt: &Runtime, id: &str, v: Option<Own>) {
        let mut s = rt.lock();
        match v {
            Some(o) => {
                s.ownerships.insert(id.to_string(), o);
            }
            None => {
                s.ownerships.remove(id);
            }
        }
    }

    // ---- jobs

    fn runtime_of(&self, id: &str) -> Option<Arc<Runtime>> {
        self.0.jobs.lock().unwrap().get(id).cloned()
    }

    /// ensureRuntime(id)
    pub fn ensure_runtime(&self, id: &str) -> SResult<Arc<Runtime>> {
        if let Some(rt) = self.runtime_of(id) {
            return Ok(rt);
        }
        let m = self.0.o.store.load(id).map_err(Fail::from)?.ok_or_else(|| service_error("JOB_NOT_FOUND"))?;
        let rt = Runtime::new(m);
        self.0.jobs.lock().unwrap().insert(id.to_string(), rt.clone());
        Ok(rt)
    }

    /// liveRuntime(id): a spent runtime is replaced by a fresh one
    fn live_runtime(&self, id: &str) -> SResult<Arc<Runtime>> {
        let rt = self.ensure_runtime(id)?;
        let spent = {
            let s = rt.lock();
            if s.running || self.0.shutting_down.load(Ordering::SeqCst) {
                return Ok(rt.clone());
            }
            rt.aborted() || s.recovery_required || s.cancel_requested || s.halted
        };
        if !spent {
            return Ok(rt);
        }
        let fresh = Runtime::new(rt.manifest());
        self.0.jobs.lock().unwrap().insert(id.to_string(), fresh.clone());
        Ok(fresh)
    }

    fn forget_finished(&self, rt: &Arc<Runtime>) {
        let s = rt.lock();
        let id = s.manifest.id().to_string();
        if s.running || self.0.shutting_down.load(Ordering::SeqCst) || !s.manifest.state().is_terminal() || s.recovery_required {
            return;
        }
        drop(s);
        let mut jobs = self.0.jobs.lock().unwrap();
        if jobs.get(&id).is_some_and(|r| Arc::ptr_eq(r, rt)) {
            jobs.remove(&id);
        }
    }

    fn mutate<T>(&self, f: impl FnOnce() -> T) -> T {
        let _g = self.0.command.lock().unwrap_or_else(|p| p.into_inner());
        f()
    }

    /// Whether two source folders are one inside the other by what they are, not by how they
    /// are spelled (a bind mount or a second mount of the share): either one, or a folder
    /// above it, is the other (staging::folder_identity). A folder that does not resolve now
    /// may be either, so it overlaps. Also by place (mount_place): when only a folder below
    /// one of them is bind-mounted inside the other, the folders above each split at the
    /// mount point and identity alone does not see it.
    fn overlap_by_identity(x: &Path, y: &Path) -> bool {
        use super::staging::folder_identity;
        let (Some(ix), Some(iy)) = (folder_identity(x, None), folder_identity(y, None)) else { return true };
        let above = |p: &Path, k: &PathBuf| p.ancestors().any(|a| folder_identity(a, None).as_ref() == Some(k));
        above(x, &iy) || above(y, &ix) || super::mount_place::folders_overlap(x, y)
    }

    fn may_run_alongside(config: &Value, others: &[Value]) -> bool {
        let devices = |c: &Value| c.get("lanes").and_then(Value::as_array).map(|a| a.iter().filter_map(|l| l["device"].as_str().map(str::to_string)).collect::<Vec<_>>());
        let Some(mine) = devices(config).filter(|d| !d.is_empty()) else { return false };
        if config.get("autoConvert") != Some(&Value::Bool(true)) {
            return false;
        }
        let overlaps = |a: Option<&str>, b: Option<&str>| match (a, b) {
            (Some(a), Some(b)) => {
                let (x, y) = (super::owned::resolve(Path::new(a)), super::owned::resolve(Path::new(b)));
                x == y || x.starts_with(&y) || y.starts_with(&x) || Self::overlap_by_identity(&x, &y)
            }
            _ => true,
        };
        let mut taken = std::collections::HashSet::new();
        for other in others {
            let oc = &other["config"];
            let Some(theirs) = devices(oc).filter(|d| !d.is_empty()) else { return false };
            if oc.get("autoConvert") != Some(&Value::Bool(true)) || overlaps(oc["sourceRoot"].as_str(), config["sourceRoot"].as_str()) {
                return false;
            }
            if JobState::parse(other["state"].as_str().unwrap_or("")) == JobState::Paused {
                continue;
            }
            taken.extend(theirs);
        }
        mine.iter().all(|d| !taken.contains(d))
    }

    /// start(config): the new job's id
    pub fn start(&self, config: &Value) -> SResult<String> {
        self.mutate(|| {
            if self.0.shutting_down.load(Ordering::SeqCst) {
                return Err(service_error("SERVICE_SHUTDOWN"));
            }
            let mut active: Vec<(String, Value)> = Vec::new();
            for s in self.0.o.store.summaries().map_err(Fail::from)? {
                if JobState::parse(s["state"].as_str().unwrap_or("")).is_active() {
                    active.push((s["id"].as_str().unwrap_or("").to_string(), (*s).clone()));
                }
            }
            for rt in self.0.jobs.lock().unwrap().values() {
                let m = rt.manifest();
                if m.state().is_active() {
                    active.retain(|(id, _)| id != m.id());
                    active.push((m.id().to_string(), json!({ "state": m.state(), "config": m.config() })));
                }
            }
            if !active.is_empty() && !Self::may_run_alongside(config, &active.iter().map(|(_, v)| v.clone()).collect::<Vec<_>>()) {
                return Err(service_error("JOB_ACTIVE"));
            }
            let now = (self.0.o.now)();
            let mut initial = Map::new();
            initial.insert("config".into(), config.clone());
            initial.insert("state".into(), JobState::Discovering.into());
            initial.insert("createdAt".into(), json!(now));
            initial.insert("updatedAt".into(), json!(now));
            initial.insert("items".into(), json!([]));
            initial.insert("counters".into(), contracts::create_empty_counters());
            initial.insert("summary".into(), Value::Null);
            initial.insert("summaryDismissed".into(), json!(false));
            initial.insert("discoveryComplete".into(), json!(false));
            let created = self.0.o.store.create(&initial).map_err(Fail::from)?;
            let rt = Runtime::new(created.clone());
            self.0.jobs.lock().unwrap().insert(created.id().to_string(), rt.clone());
            self.emit(&rt, "started", vec![("snapshot", public_snapshot(&created))]);
            self.launch(&rt, true, vec![]);
            Ok(created.id().to_string())
        })
    }

    /// get(id)
    pub fn get(&self, id: &str) -> SResult<Value> {
        let m = match self.runtime_of(id) {
            Some(rt) => rt.manifest(),
            None => self.0.o.store.load(id).map_err(Fail::from)?.ok_or_else(|| service_error("JOB_NOT_FOUND"))?,
        };
        Ok(public_snapshot(&m))
    }

    /// list()
    pub fn list(&self) -> SResult<Vec<Value>> {
        Ok(self.0.o.store.list().map_err(Fail::from)?.iter().map(public_snapshot).collect())
    }

    /// listSummaries()
    pub fn list_summaries(&self) -> SResult<Vec<Value>> {
        let mut live: Vec<(String, Value)> = self.0.jobs.lock().unwrap().values().map(|rt| {
            let m = rt.manifest();
            (m.id().to_string(), summary_of(&m))
        }).collect();
        let mut out = Vec::new();
        for s in self.0.o.store.summaries().map_err(Fail::from)? {
            let id = s["id"].as_str().unwrap_or("").to_string();
            if let Some(i) = live.iter().position(|(l, _)| *l == id) {
                out.push(live.remove(i).1);
            } else {
                let mut v = (*s).clone();
                if let Some(m) = v.as_object_mut() {
                    for k in PRIVATE_SNAPSHOT_KEYS {
                        m.shift_remove(k);
                    }
                    // (publicSnapshot puts items last)
                    if let Some(items) = m.shift_remove("items") {
                        m.insert("items".into(), items);
                    }
                }
                out.push(v);
            }
        }
        out.extend(live.into_iter().map(|(_, v)| v));
        Ok(out)
    }

    /// liveJobs()
    pub fn live_jobs(&self) -> Vec<Value> {
        self.0.jobs.lock().unwrap().values().map(|rt| {
            let m = rt.manifest();
            json!({ "id": m.id(), "state": m.state(), "autoConvert": m.config().get("autoConvert") == Some(&Value::Bool(true)) })
        }).collect()
    }

    /// pause(id)
    pub fn pause(&self, id: &str) -> SResult<Value> {
        self.mutate(|| {
            let rt = self.ensure_runtime(id)?;
            if rt.manifest().state().is_terminal() {
                return Ok(public_snapshot(&rt.manifest()));
            }
            rt.lock().pause_requested = true;
            self.emit(&rt, "pause_requested", vec![]);
            Ok(public_snapshot(&rt.manifest()))
        })
    }

    fn wake_paused(rt: &Runtime) {
        let mut s = rt.lock();
        s.pause_generation += 1;
        drop(s);
        rt.cv.notify_all();
    }

    /// resume(id)
    pub fn resume(&self, id: &str) -> SResult<Value> {
        self.mutate(|| {
            let rt = self.live_runtime(id)?;
            let (state, pause_requested, running, from) = {
                let s = rt.lock();
                (s.manifest.state(), s.pause_requested, s.running, recorded_from(&s.manifest))
            };
            if state != JobState::Paused && !pause_requested {
                return Err(service_error("JOB_NOT_PAUSED"));
            }
            if from == Some(JobState::Replacing) && !running {
                self.resolve_replacement_before_cancel(&rt, id, true)?;
                self.emit(&rt, "resumed", vec![]);
                return Ok(public_snapshot(&rt.manifest()));
            }
            if state != JobState::Paused && running {
                {
                    let mut s = rt.lock();
                    s.pause_requested = false;
                    s.pause_persisted = false;
                }
                Self::wake_paused(&rt);
                self.emit(&rt, "resumed", vec![]);
                return Ok(public_snapshot(&rt.manifest()));
            }
            self.release_interrupted_save(&rt, false)?;
            let m = rt.manifest();
            if m.str("activeItemId").is_some() && m.get("recovery").is_some_and(super::jobstore::normalize::truthy) {
                return Err(service_error("RECOVERY_REQUIRED"));
            }
            {
                let mut s = rt.lock();
                s.pause_requested = false;
                s.pause_persisted = false;
            }
            self.update(&rt, |_| Some(Patch::new().state(JobState::Waiting).set("recovery", Value::Null)))?;
            Self::wake_paused(&rt);
            if !rt.lock().running {
                self.relaunch_async(&rt);
            }
            self.emit(&rt, "resumed", vec![]);
            Ok(public_snapshot(&rt.manifest()))
        })
    }

    fn queued_ids(m: &Manifest) -> Vec<String> {
        m.items.iter().filter(|i| i.state() == ItemState::Queued).map(|i| i.id().to_string()).collect()
    }

    /// relaunch without waiting for the run
    fn relaunch_async(&self, rt: &Arc<Runtime>) {
        let m = rt.manifest();
        {
            let mut s = rt.lock();
            s.queue.clear();
            s.queue_closed = false;
            s.producer_done = false;
        }
        self.launch(rt, m.get("discoveryComplete") == Some(&Value::Bool(false)), Self::queued_ids(&m));
    }

    /// cancel(id)
    pub fn cancel(&self, id: &str) -> SResult<Value> {
        self.mutate(|| {
            let rt = self.live_runtime(id)?;
            if recorded_from(&rt.manifest()) == Some(JobState::Replacing) {
                self.resolve_replacement_before_cancel(&rt, id, false)?;
            }
            self.release_interrupted_save(&rt, false)?;
            let m = rt.manifest();
            if m.get("recovery").and_then(|r| r.get("action")) == Some(&json!("manual-intervention")) && !rt.lock().running {
                return Err(service_error("RECOVERY_REQUIRED"));
            }
            if m.state() == JobState::Cancelled {
                return Ok(public_snapshot(&m));
            }
            {
                let mut s = rt.lock();
                s.cancel_requested = true;
                s.queue_closed = true;
            }
            rt.do_abort();
            Self::wake_paused(&rt);
            self.terminate_children(&rt);
            if rt.lock().running {
                self.wait_idle(&rt);
            } else {
                self.finalize(&rt)?;
            }
            Ok(public_snapshot(&rt.manifest()))
        })
    }

    /// discard(id)
    pub fn discard(&self, id: &str) -> SResult<Value> {
        self.mutate(|| {
            if let Some(rt) = self.runtime_of(id) {
                {
                    let mut s = rt.lock();
                    s.cancel_requested = true;
                    s.queue_closed = true;
                }
                rt.do_abort();
                Self::wake_paused(&rt);
                self.terminate_children(&rt);
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
                let mut s = rt.lock();
                while s.running && std::time::Instant::now() < deadline {
                    s = rt.cv.wait_timeout(s, std::time::Duration::from_millis(100)).unwrap().0;
                }
                drop(s);
                self.0.jobs.lock().unwrap().remove(id);
            }
            self.0.o.store.discard(id).map_err(Fail::from)?;
            self.emit_raw("discarded", id, None, vec![]);
            Ok(json!({ "jobId": id, "discarded": true }))
        })
    }

    /// retryFailed(id)
    pub fn retry_failed(&self, id: &str) -> SResult<Value> {
        self.mutate(|| {
            let rt = self.live_runtime(id)?;
            let m = rt.manifest();
            if recorded_from(&m) == Some(JobState::Replacing) {
                return Err(service_error("RECOVERY_REQUIRED"));
            }
            if rt.lock().running {
                return Err(service_error("JOB_ACTIVE"));
            }
            if !matches!(m.state(), JobState::Completed | JobState::Failed) {
                return Err(service_error("JOB_NOT_RETRYABLE"));
            }
            if !m.items.iter().any(|i| i.state() == ItemState::Failed) {
                return Err(service_error("NO_FAILED_ITEMS"));
            }
            for item in m.items.iter().filter(|i| i.state() == ItemState::Failed) {
                if !self.reconcile_item_ownership(&rt, item.id(), Some(ownership_of(item.value())), false)? {
                    log_line(format!("[CONVERTER] Retry failed refused: the files clip {:?} ({id} {}) kept from its failed run could not be cleaned up, so no clip ran again", item.str("relativePath").unwrap_or(""), item.id()));
                    return Err(service_error("RECOVERY_REQUIRED"));
                }
            }
            self.update(&rt, |s| {
                let items = s.manifest.items.iter().map(|i| if i.state() == ItemState::Failed {
                    ItemIn::Raw(merge(i.value(), &vec![("state", Some(ItemState::Queued.into())), ("attempts", Some(json!(0))), ("failure", None), ("resultCode", None)]))
                } else {
                    ItemIn::Trusted(i.clone())
                }).collect();
                Some(Patch::new().state(JobState::Waiting).set("summary", Value::Null).set("summaryDismissed", json!(false)).set("failure", Value::Null).items(items))
            })?;
            {
                let mut s = rt.lock();
                s.queue.clear();
                s.queue_closed = false;
                s.producer_done = false;
            }
            let ids = Self::queued_ids(&rt.manifest());
            self.launch(&rt, false, ids);
            Ok(public_snapshot(&rt.manifest()))
        })
    }

    /// dismissSummary(id)
    pub fn dismiss_summary(&self, id: &str) -> SResult<Value> {
        let rt = self.ensure_runtime(id)?;
        if rt.manifest().state() != JobState::Completed {
            return Err(service_error("JOB_NOT_COMPLETED"));
        }
        self.update(&rt, |_| Some(Patch::new().set("summary", Value::Null).set("summaryDismissed", json!(true))))?;
        self.emit(&rt, "summary_dismissed", vec![]);
        Ok(public_snapshot(&rt.manifest()))
    }

    /// setConcurrency(id, value): a job with lanes gives the number to its
    /// one GPU still here, else carries on without lanes
    pub fn set_concurrency(&self, id: &str, value: &Value) -> SResult<Value> {
        self.mutate(|| {
            if !contracts::is_valid_concurrency(value) {
                return Err(service_error("INVALID_CONCURRENCY"));
            }
            let rt = self.ensure_runtime(id)?;
            if rt.manifest().state().is_terminal() {
                return Err(service_error("JOB_NOT_ACTIVE"));
            }
            let n = value.as_i64().unwrap();
            if let Some(lanes) = lanes::lanes_of(&rt.manifest()) {
                let kept: Vec<String> = match &rt.lock().lane_plan {
                    Some(p) if p.fallback => vec![],
                    Some(p) => p.devices.keys().cloned().collect(),
                    None => lanes.as_array().unwrap().iter().filter_map(|l| l["device"].as_str().map(str::to_string)).collect(),
                };
                if kept.len() == 1 {
                    return self.set_lanes_now(&rt, &json!([{ "device": kept[0], "concurrency": n }]));
                }
                return self.drop_lanes(&rt, n);
            }
            if rt.lock().concurrency() as i64 == n {
                return Ok(public_snapshot(&rt.manifest()));
            }
            self.update(&rt, |s| {
                let mut c = s.manifest.config().clone();
                c["concurrency"] = json!(n);
                Some(Patch::new().set("config", c))
            })?;
            self.start_missing_workers(&rt);
            Ok(public_snapshot(&rt.manifest()))
        })
    }

    /// setLanes(id, lanes): conversions at once per GPU changed while the job runs
    pub fn set_lanes(&self, id: &str, value: &Value) -> SResult<Value> {
        self.mutate(|| {
            let lanes = match contracts::normalize_lanes(value) {
                Ok(Some(l)) => l,
                _ => return Err(service_error("INVALID_LANES")),
            };
            let rt = self.ensure_runtime(id)?;
            if rt.manifest().state().is_terminal() {
                return Err(service_error("JOB_NOT_ACTIVE"));
            }
            // Smallest (CPU only) has no lanes (its number at once is set_concurrency's)
            if rt.manifest().config()["profileId"] == contracts::SMALLEST_PROFILE_ID {
                return Err(service_error("INVALID_LANES"));
            }
            self.set_lanes_now(&rt, &lanes)
        })
    }

    pub fn terminate_children(&self, rt: &Runtime) {
        let mut s = rt.lock();
        for c in s.children.values_mut() {
            if c.termination_requested {
                continue;
            }
            c.termination_requested = true;
            if let Some(k) = &c.remote {
                k("SIGTERM");
                continue;
            }
            // SAFETY: a signal to the ffmpeg this job started
            unsafe {
                libc::kill(c.pid, libc::SIGTERM);
            }
        }
    }

    fn wait_idle(&self, rt: &Runtime) {
        let mut s = rt.lock();
        while s.running {
            s = rt.cv.wait(s).unwrap_or_else(|p| p.into_inner());
        }
    }

    /// whenIdle(id)
    pub fn when_idle(&self, id: &str) -> SResult<Value> {
        let rt = self.ensure_runtime(id)?;
        self.wait_idle(&rt);
        Ok(public_snapshot(&rt.manifest()))
    }

    /// activeEncodes()
    pub fn active_encodes(&self) -> Vec<Value> {
        let jobs: Vec<Arc<Runtime>> = self.0.jobs.lock().unwrap().values().cloned().collect();
        jobs.iter().flat_map(|rt| rt.lock().encodes.iter().map(|(_, v)| v.clone()).collect::<Vec<_>>()).collect()
    }

    /// slotsOf(id)
    pub fn slots_of(&self, id: &str) -> Option<usize> {
        self.runtime_of(id).map(|rt| {
            let s = rt.lock();
            match &s.lane_plan {
                Some(p) if !p.fallback => p.base.values().sum(),
                _ => s.concurrency(),
            }
        })
    }

    /// shutdown()
    pub fn shutdown(&self) {
        self.mutate(|| {
            if self.0.shutting_down.swap(true, Ordering::SeqCst) {
                let jobs: Vec<Arc<Runtime>> = self.0.jobs.lock().unwrap().values().cloned().collect();
                for rt in jobs {
                    self.wait_idle(&rt);
                }
                return;
            }
            let jobs: Vec<Arc<Runtime>> = self.0.jobs.lock().unwrap().values().cloned().collect();
            let handles: Vec<_> = jobs
                .into_iter()
                .map(|rt| {
                    let me = self.clone();
                    std::thread::spawn(move || {
                        let m = rt.manifest();
                        if m.state().is_terminal() {
                            return;
                        }
                        let rec = |k: &str| m.get("recovery").and_then(|r| r.get(k)).and_then(Value::as_str).map(JobState::parse);
                        let running;
                        {
                            let mut s = rt.lock();
                            s.stop_phase = match m.state() {
                                JobState::PausedNetwork => rec("resumeState"),
                                JobState::Paused => rec("fromState"),
                                other => Some(other),
                            };
                            s.stop_item_id = m.str("activeItemId").map(str::to_string).or_else(|| s.lead_item_id());
                            s.stop_while_paused = s.pause_requested || (m.state() == JobState::Paused && !m.get("recovery").is_some_and(super::jobstore::normalize::truthy));
                            s.stop_requested = true;
                            s.queue_closed = true;
                            running = s.running;
                        }
                        rt.do_abort();
                        Self::wake_paused(&rt);
                        me.terminate_children(&rt);
                        if running {
                            me.wait_idle(&rt);
                        } else {
                            let _ = me.finalize(&rt);
                        }
                    })
                })
                .collect();
            for h in handles {
                let _ = h.join();
            }
        })
    }
}


#[cfg(test)]
mod failure_detail_tests {
    //! An unsafe-owned-path refusal's detail reaches the clip in the job
    //! snapshot, and only there: the stored job keeps Node's format.
    use super::*;
    use crate::converter::jobstore::{random_uuid, ItemIn, JobStore, Patch};

    #[test]
    fn a_refusal_detail_shows_on_the_failed_clip_and_is_never_stored() {
        let root = std::env::temp_dir().join(format!("lean-failure-detail-{}-{}", std::process::id(), random_uuid().unwrap()));
        std::fs::create_dir_all(&root).unwrap();
        let store = JobStore::new(&root).unwrap();
        let job = format!("job-{}", random_uuid().unwrap());
        let clip = |n: usize| {
            let ts = format!("2026-10-0{n}_07-00-00");
            let rel = format!("SentryClips/{ts}/{ts}-front.mp4");
            json!({ "id": format!("item-{n:06}"), "state": "queued", "kind": "video", "group": "SentryClips", "eventId": ts, "relativePath": rel, "sourcePath": format!("/footage/TeslaCam/{rel}"), "sourceBytes": 40_000_000, "mtimeMs": 1760000000000.0, "timestampKey": ts, "camera": "front", "attempts": 0 })
        };
        let mut initial = Map::new();
        initial.insert("id".into(), json!(job));
        initial.insert("state".into(), json!("waiting"));
        initial.insert("config".into(), json!({ "sourceRoot": "/footage/TeslaCam", "destinationRoot": null, "codec": "h265", "profileId": "balanced", "networkMode": "auto", "outputMode": "replace", "includedGroups": ["SentryClips"], "replacementConfirmed": true, "concurrency": 2, "verifyMode": "quick" }));
        initial.insert("items".into(), json!([clip(1), clip(2)]));
        initial.insert("discoveryComplete".into(), json!(true));
        store.create(&initial).unwrap();
        let failed = |code: &str| json!({ "state": "failed", "failure": { "code": code, "retryable": false }, "resultCode": code });
        let items = vec![
            ItemIn::Raw(Value::Object(merge_value(&clip(1), &failed("unsafe-owned-path")))),
            ItemIn::Raw(Value::Object(merge_value(&clip(2), &failed("decode-failed")))),
        ];
        let m = store.transition(&job, Patch::new().items(items)).unwrap();

        // what fail_item records: the refusal's detail, carried from the staging error
        let tx = staging::unsafe_path("remove-exact-owned", "/footage/TeslaCam/SentryClips/BACKUP-1-front.mp4", "nlink 2 != 1 (state owned)");
        let fail = Fail::from(tx);
        assert_eq!(stable_failure(&fail, "operation-failed"), UNSAFE_OWNED_PATH_RESULT);
        set_failure_detail(&job, "item-000001", fail.detail.as_deref());
        set_failure_detail(&job, "item-000002", Some("not shown: another code"));

        let snap = public_snapshot(&m);
        let items = snap["items"].as_array().unwrap();
        assert_eq!(items[0]["failure"], json!({ "code": "unsafe-owned-path", "retryable": false, "detail": "remove-exact-owned: nlink 2 != 1 (state owned)" }));
        assert_eq!(items[0]["resultCode"], "unsafe-owned-path", "the result code is unchanged");
        assert_eq!(items[1]["failure"], json!({ "code": "decode-failed", "retryable": false }), "only unsafe-owned-path and source-changed show a detail");
        // the stored job and the manifest itself carry no detail
        assert!(m.items[0].value()["failure"].get("detail").is_none());
        let stored = std::fs::read_to_string(root.join(&job).join("job.json")).unwrap_or_default() + &std::fs::read_to_string(root.join(&job).join("job.journal")).unwrap_or_default();
        assert!(stored.contains("unsafe-owned-path") && !stored.contains("nlink"), "{stored}");
        // forgotten (a restart): the snapshot says the reason is not known
        set_failure_detail(&job, "item-000001", None);
        assert_eq!(public_snapshot(&m)["items"][0]["failure"]["detail"], DETAIL_NOT_KNOWN);
        let _ = std::fs::remove_dir_all(&root);
    }

    fn merge_value(a: &Value, b: &Value) -> Map<String, Value> {
        let mut m = a.as_object().unwrap().clone();
        for (k, v) in b.as_object().unwrap() {
            m.insert(k.clone(), v.clone());
        }
        m
    }
}

#[cfg(test)]
mod state_tests {
    //! A move the service never makes, tried anyway: the store refuses it,
    //! the caller gets INVALID_STATE_TRANSITION, and neither the runtime's
    //! copy of the job nor its file changes.
    use super::lanes_tests::{Harness, HarnessOptions};
    use super::*;

    #[test]
    fn a_refused_move_reaches_the_caller_and_the_job_stays_as_it_was() {
        if !std::process::Command::new("ffmpeg").arg("-version").output().is_ok_and(|o| o.status.success()) {
            return;
        }
        let h = Harness::new(HarnessOptions { clips: 2, ..Default::default() });
        let svc = h.service();
        let id = svc.start(&h.config(json!({}))).unwrap();
        assert_eq!(h.finish_job(&id)["state"], "completed");
        let rt = svc.ensure_runtime(&id).unwrap();
        let before = rt.manifest().to_json();
        // (a finished job reopened as paused: a valid job file, a move never made)
        let e = svc.update(&rt, |_| Some(Patch::new().state(JobState::Paused).set("summary", Value::Null))).unwrap_err();
        assert_eq!(e.code.as_deref(), Some("INVALID_STATE_TRANSITION"));
        assert_eq!(rt.manifest().to_json(), before, "the runtime's copy");
        assert_eq!(svc.store().load(&id).unwrap().unwrap().to_json(), before, "the job file");
        // the moves a finished job does make still work: Cancel, and a cancelled job stays cancelled
        assert_eq!(svc.cancel(&id).unwrap()["state"], "cancelled");
        let rt = svc.ensure_runtime(&id).unwrap();
        let e = svc.update(&rt, |_| Some(Patch::new().state(JobState::Waiting))).unwrap_err();
        assert_eq!(e.code.as_deref(), Some("INVALID_STATE_TRANSITION"));
        assert_eq!(svc.get(&id).unwrap()["state"], "cancelled");
    }
}

#[cfg(test)]
mod alongside_tests {
    use super::Service;
    use serde_json::json;
    use std::fs;
    use std::path::Path;

    fn cfg(root: &Path, device: &str) -> serde_json::Value {
        json!({ "sourceRoot": root, "autoConvert": true, "lanes": [{ "device": device }] })
    }

    #[test]
    fn jobs_of_one_folder_through_two_mount_points_never_run_alongside() {
        let tmp = crate::converter::testutil::tempdir().unwrap();
        let a = tmp.path().join("share/TeslaCam");
        fs::create_dir_all(a.join("SentryClips")).unwrap();
        let other = tmp.path().join("other/TeslaCam");
        fs::create_dir_all(&other).unwrap();
        let running = |root: &Path| json!({ "config": cfg(root, "gpu0"), "state": "running" });
        assert!(Service::may_run_alongside(&cfg(&other, "cpu"), &[running(&a)]), "two unrelated folders");
        assert!(!Service::may_run_alongside(&cfg(&a.join("SentryClips"), "cpu"), &[running(&a)]), "one inside the other");
        assert!(!Service::may_run_alongside(&cfg(&tmp.path().join("gone"), "cpu"), &[running(&a)]), "a folder that cannot be reached may be either");
        // a bind mount of the share (needs root)
        let at = tmp.path().join("bind");
        fs::create_dir_all(&at).unwrap();
        let ok = std::process::Command::new("mount").arg("--bind").arg(tmp.path().join("share")).arg(&at).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success());
        if !ok {
            eprintln!("skipped: a bind mount needs root");
            return;
        }
        let r1 = Service::may_run_alongside(&cfg(&at.join("TeslaCam"), "cpu"), &[running(&a)]);
        let r2 = Service::may_run_alongside(&cfg(&a, "cpu"), &[running(&at.join("TeslaCam/SentryClips"))]);
        let _ = std::process::Command::new("umount").arg(&at).status();
        assert!(!r1, "the same folder through a bind mount");
        assert!(!r2, "a folder inside it through a bind mount");
    }

    #[test]
    fn a_job_above_a_bind_mount_point_overlaps() {
        let tmp = crate::converter::testutil::tempdir().unwrap();
        let a = tmp.path().join("share/TeslaCam");
        fs::create_dir_all(a.join("SentryClips")).unwrap();
        let other = tmp.path().join("other/TeslaCam");
        fs::create_dir_all(&other).unwrap();
        // only SentryClips is bind-mounted, under another folder "view" (needs root)
        let view = tmp.path().join("view");
        let at = view.join("SentryClips");
        fs::create_dir_all(&at).unwrap();
        let ok = std::process::Command::new("mount").arg("--bind").arg(a.join("SentryClips")).arg(&at).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success());
        if !ok {
            eprintln!("skipped: a bind mount needs root");
            return;
        }
        let running = |root: &Path| json!({ "config": cfg(root, "gpu0"), "state": "running" });
        let r1 = Service::may_run_alongside(&cfg(&view, "cpu"), &[running(&a)]);
        let r2 = Service::may_run_alongside(&cfg(&a, "cpu"), &[running(&view)]);
        let r3 = Service::may_run_alongside(&cfg(&at, "cpu"), &[running(&a)]);
        let r4 = Service::may_run_alongside(&cfg(&a.join("SentryClips"), "cpu"), &[running(&view)]);
        let r5 = Service::may_run_alongside(&cfg(&other, "cpu"), &[running(&view)]);
        let _ = std::process::Command::new("umount").arg(&at).status();
        assert!(!r1, "a folder above the bind mount point and the real folder");
        assert!(!r2, "the real folder and a folder above the bind mount point");
        assert!(!r3, "the bind spelling inside the real folder");
        assert!(!r4, "the real subfolder inside the folder above the bind mount point");
        assert!(r5, "an unrelated folder still runs alongside");
    }
    #[test]
    fn by_parent_chain_jobs_of_one_folder_through_two_mount_points_never_run_alongside() {
        crate::converter::mount_place::with_parent_chain(jobs_of_one_folder_through_two_mount_points_never_run_alongside);
    }

    #[test]
    fn by_parent_chain_a_job_above_a_bind_mount_point_overlaps() {
        crate::converter::mount_place::with_parent_chain(a_job_above_a_bind_mount_point_overlaps);
    }
}

#[cfg(test)]
mod rc3_alongside_tests {
    use super::Service;
    use serde_json::json;
    use std::ffi::OsStr;
    use std::fs;
    use std::path::Path;

    fn cfg(root: &Path, device: &str) -> serde_json::Value {
        json!({ "sourceRoot": root, "autoConvert": true, "lanes": [{ "device": device }] })
    }
    fn mnt(args: &[&OsStr]) -> bool {
        std::process::Command::new("mount").args(args).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success())
    }
    fn um(p: &Path) {
        let _ = std::process::Command::new("umount").arg(p).status();
    }

    #[test]
    fn rc3_a_job_through_a_hidden_mount_point_overlaps_a_job_above_the_bind_point() {
        let tmp = crate::converter::testutil::tempdir().unwrap();
        let real = tmp.path().join("real/TeslaCam");
        fs::create_dir_all(real.join("SentryClips/evt")).unwrap();
        let share = tmp.path().join("share/TeslaCam");
        fs::create_dir_all(share.join("SentryClips")).unwrap();
        let view = tmp.path().join("view");
        fs::create_dir_all(view.join("SentryClips")).unwrap();
        if !mnt(&[OsStr::new("-t"), OsStr::new("tmpfs"), OsStr::new("t"), share.join("SentryClips").as_os_str()]) {
            eprintln!("skipped: needs root");
            return;
        }
        assert!(mnt(&[OsStr::new("--bind"), real.as_os_str(), share.as_os_str()]));
        assert!(mnt(&[OsStr::new("--bind"), real.join("SentryClips").as_os_str(), view.join("SentryClips").as_os_str()]));
        let seen = share.join("SentryClips/evt").exists();
        let running = |root: &Path| json!({ "config": cfg(root, "gpu0"), "state": "running" });
        // share/TeslaCam/SentryClips is real/TeslaCam/SentryClips, which view/SentryClips also is
        let r1 = Service::may_run_alongside(&cfg(&share.join("SentryClips"), "cpu"), &[running(&view)]);
        let r2 = Service::may_run_alongside(&cfg(&view, "cpu"), &[running(&share.join("SentryClips"))]);
        um(&view.join("SentryClips"));
        um(&share);
        um(&share.join("SentryClips"));
        assert!(seen);
        assert!(!r1 && !r2, "two jobs over the same clips: r1={r1} r2={r2}");
    }

    #[test]
    fn rc3_probe_overlayfs_lower_and_merged() {
        let tmp = crate::converter::testutil::tempdir().unwrap();
        let lower = tmp.path().join("lower/TeslaCam");
        fs::create_dir_all(lower.join("SentryClips/evt")).unwrap();
        let (up, work, merged) = (tmp.path().join("up"), tmp.path().join("work"), tmp.path().join("merged"));
        for d in [&up, &work, &merged] {
            fs::create_dir_all(d).unwrap();
        }
        let o = format!("lowerdir={},upperdir={},workdir={}", tmp.path().join("lower").display(), up.display(), work.display());
        if !mnt(&[OsStr::new("-t"), OsStr::new("overlay"), OsStr::new("ov"), OsStr::new("-o"), OsStr::new(&o), merged.as_os_str()]) {
            eprintln!("skipped: no overlay");
            return;
        }
        let running = |root: &Path| json!({ "config": cfg(root, "gpu0"), "state": "running" });
        let r = Service::may_run_alongside(&cfg(&merged.join("TeslaCam"), "cpu"), &[running(&lower)]);
        let r2 = Service::may_run_alongside(&cfg(&lower.join("SentryClips"), "cpu"), &[running(&merged.join("TeslaCam"))]);
        um(&merged);
        assert!(!r && !r2, "an overlay and its lower folder are one set of files: {r} {r2}");
    }

    #[test]
    fn by_parent_chain_a_job_through_a_hidden_mount_point_overlaps_a_job_above_the_bind_point() {
        crate::converter::mount_place::with_parent_chain(rc3_a_job_through_a_hidden_mount_point_overlaps_a_job_above_the_bind_point);
    }

    #[test]
    fn by_parent_chain_an_overlay_and_its_lower_folder_overlap() {
        crate::converter::mount_place::with_parent_chain(rc3_probe_overlayfs_lower_and_merged);
    }
}
