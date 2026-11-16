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

pub use encode::{parse_progress_line, Progress};

use super::contracts;
use super::error::CError;
use super::jobstore::{ItemIn, JobStore, Manifest, Patch};
use super::staging::{self, Tx};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use tools::Tools;

pub const ACTIVE_STATES: [&str; 10] = ["discovering", "waiting", "staging", "encoding", "writing-telemetry", "verifying", "copying", "replacing", "paused", "paused_network"];
pub const TERMINAL_STATES: [&str; 4] = ["completed", "failed", "cancelled", "skipped"];
const IDLE_JOB_STATES: [&str; 6] = ["paused", "paused_network", "completed", "skipped", "failed", "cancelled"];
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
            ..Default::default()
        }
    }
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
            let v = it.value();
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
    /// decodeAccel(encoder, zeroCopy, device): GPU decode arguments (None: CPU decode)
    pub decode_accel: Option<Arc<dyn Fn(&str, bool, Option<&super::planner::Device>) -> Option<Vec<String>> + Send + Sync>>,
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
        }
    }
}

pub type Listener = Arc<dyn Fn(&Value) + Send + Sync>;

/// One running ffmpeg (activeEncodes)
#[derive(Debug, Clone)]
pub struct ChildEntry {
    pub pid: i32,
    pub termination_requested: bool,
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
    pub stop_phase: Option<String>,
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
        if ps != ns && (IDLE_JOB_STATES.contains(&ps) || IDLE_JOB_STATES.contains(&ns)) {
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
        let new_state = patch.top.get("state").and_then(Value::as_str).map(str::to_string);
        if let Some(ns) = &new_state {
            if ns != "paused" && ns != "paused_network" && !patch.top.contains_key("recovery") && previous.get("recovery").and_then(|r| r.get("fromState")).and_then(Value::as_str) == Some("paused_network") {
                patch.top.insert("recovery".into(), Value::Null);
            }
            if ns != previous.state() && !patch.top.contains_key("updatedAt") {
                let at = (self.0.o.now)();
                patch.top.insert("updatedAt".into(), json!(at));
                if IDLE_JOB_STATES.contains(&previous.state()) {
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
            let phase = snapshot.get("phase").and_then(Value::as_str).filter(|p| super::jobstore::normalize::REPLACEMENT_PHASES.contains(p)).map(str::to_string);
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
                    changes.push(("replacementPhase", Some(json!(p))));
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
                    p = p.set("replacementPhase", json!(ph)).set("state", json!("replacing")).set("activeItemId", json!(item_id));
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
        if s.running || self.0.shutting_down.load(Ordering::SeqCst) || !TERMINAL_STATES.contains(&s.manifest.state()) || s.recovery_required {
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

    fn may_run_alongside(config: &Value, others: &[Value]) -> bool {
        let devices = |c: &Value| c.get("lanes").and_then(Value::as_array).map(|a| a.iter().filter_map(|l| l["device"].as_str().map(str::to_string)).collect::<Vec<_>>());
        let Some(mine) = devices(config).filter(|d| !d.is_empty()) else { return false };
        if config.get("autoConvert") != Some(&Value::Bool(true)) {
            return false;
        }
        let overlaps = |a: Option<&str>, b: Option<&str>| match (a, b) {
            (Some(a), Some(b)) => {
                let (x, y) = (super::owned::resolve(Path::new(a)), super::owned::resolve(Path::new(b)));
                x == y || x.starts_with(&y) || y.starts_with(&x)
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
            if other["state"] == "paused" {
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
                if ACTIVE_STATES.contains(&s["state"].as_str().unwrap_or("")) {
                    active.push((s["id"].as_str().unwrap_or("").to_string(), (*s).clone()));
                }
            }
            for rt in self.0.jobs.lock().unwrap().values() {
                let m = rt.manifest();
                if ACTIVE_STATES.contains(&m.state()) {
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
            initial.insert("state".into(), json!("discovering"));
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
            if TERMINAL_STATES.contains(&rt.manifest().state()) {
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
                (s.manifest.state().to_string(), s.pause_requested, s.running, s.manifest.get("recovery").and_then(|r| r.get("fromState")).and_then(Value::as_str).map(str::to_string))
            };
            if state != "paused" && !pause_requested {
                return Err(service_error("JOB_NOT_PAUSED"));
            }
            if from.as_deref() == Some("replacing") && !running {
                self.resolve_replacement_before_cancel(&rt, id, true)?;
                self.emit(&rt, "resumed", vec![]);
                return Ok(public_snapshot(&rt.manifest()));
            }
            if state != "paused" && running {
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
            self.update(&rt, |_| Some(Patch::new().set("state", json!("waiting")).set("recovery", Value::Null)))?;
            Self::wake_paused(&rt);
            if !rt.lock().running {
                self.relaunch_async(&rt);
            }
            self.emit(&rt, "resumed", vec![]);
            Ok(public_snapshot(&rt.manifest()))
        })
    }

    fn queued_ids(m: &Manifest) -> Vec<String> {
        m.items.iter().filter(|i| i.state() == "queued").map(|i| i.id().to_string()).collect()
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
            if rt.manifest().get("recovery").and_then(|r| r.get("fromState")) == Some(&json!("replacing")) {
                self.resolve_replacement_before_cancel(&rt, id, false)?;
            }
            self.release_interrupted_save(&rt, false)?;
            let m = rt.manifest();
            if m.get("recovery").and_then(|r| r.get("action")) == Some(&json!("manual-intervention")) && !rt.lock().running {
                return Err(service_error("RECOVERY_REQUIRED"));
            }
            if m.state() == "cancelled" {
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
            if m.get("recovery").and_then(|r| r.get("fromState")) == Some(&json!("replacing")) {
                return Err(service_error("RECOVERY_REQUIRED"));
            }
            if rt.lock().running {
                return Err(service_error("JOB_ACTIVE"));
            }
            if !["completed", "failed"].contains(&m.state()) {
                return Err(service_error("JOB_NOT_RETRYABLE"));
            }
            if !m.items.iter().any(|i| i.state() == "failed") {
                return Err(service_error("NO_FAILED_ITEMS"));
            }
            for item in m.items.iter().filter(|i| i.state() == "failed") {
                if !self.reconcile_item_ownership(&rt, item.id(), Some(ownership_of(item.value())), false)? {
                    return Err(service_error("RECOVERY_REQUIRED"));
                }
            }
            self.update(&rt, |s| {
                let items = s.manifest.items.iter().map(|i| if i.state() == "failed" {
                    ItemIn::Raw(merge(i.value(), &vec![("state", Some(json!("queued"))), ("attempts", Some(json!(0))), ("failure", None), ("resultCode", None)]))
                } else {
                    ItemIn::Trusted(i.clone())
                }).collect();
                Some(Patch::new().set("state", json!("waiting")).set("summary", Value::Null).set("summaryDismissed", json!(false)).set("failure", Value::Null).items(items))
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
        if rt.manifest().state() != "completed" {
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
            if TERMINAL_STATES.contains(&rt.manifest().state()) {
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
            if TERMINAL_STATES.contains(&rt.manifest().state()) {
                return Err(service_error("JOB_NOT_ACTIVE"));
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
                        if TERMINAL_STATES.contains(&m.state()) {
                            return;
                        }
                        let rec = |k: &str| m.get("recovery").and_then(|r| r.get(k)).and_then(Value::as_str).map(str::to_string);
                        let running;
                        {
                            let mut s = rt.lock();
                            s.stop_phase = match m.state() {
                                "paused_network" => rec("resumeState"),
                                "paused" => rec("fromState"),
                                other => Some(other.to_string()),
                            };
                            s.stop_item_id = m.str("activeItemId").map(str::to_string).or_else(|| s.lead_item_id());
                            s.stop_while_paused = s.pause_requested || (m.state() == "paused" && !m.get("recovery").is_some_and(super::jobstore::normalize::truthy));
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

