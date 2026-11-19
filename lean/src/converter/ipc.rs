//! src/main/converter/ipc.js (the 22 channels, their checks and answers,
//! the live updates) behind server/converterBridge.js (verification never
//! Off from the server, every folder through the footage guard):
//!
//!   POST /api/converter/invoke/:name   body = the payload (or empty)
//!        -> `Bridge::invoke(name, payload, client)`, answer as JSON, always 200
//!   GET  /api/converter/events?client= -> `Bridge::attach_events(client, sink)`:
//!        the sink gets the SSE text (`event: converter:progress\ndata: ...\n\n`,
//!        and `: ping\n\n` every 15 s); it returns false once the client is gone.

use super::contracts;
use super::ctx::ConverterCtx;
use super::service::{Fail, Listener, SResult, Service};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

pub const CHANNELS: [&str; 22] = [
    "converter:chooseFolder", "converter:start", "converter:getCurrent", "converter:pause", "converter:setConcurrency", "converter:resume", "converter:cancel", "converter:discard", "converter:retryFailed", "converter:dismissSummary",
    "converter:getCapabilities", "converter:subscribeProgress", "converter:unsubscribeProgress", "converter:runBenchmark", "converter:cancelBenchmark", "converter:getAuto", "converter:setAuto", "converter:checkAutoNow",
    "converter:saveVehicle", "converter:forgetVehicle", "converter:devices", "converter:setLanes",
];
const GROUPS: [&str; 3] = ["RecentClips", "SavedClips", "SentryClips"];
const ACTIVE_STATES: [&str; 10] = ["discovering", "waiting", "staging", "encoding", "writing-telemetry", "verifying", "copying", "replacing", "paused", "paused_network"];
const PROFILE_IDS: [&str; 6] = ["conservative", "balanced", "aggressive", "custom", "quality", "smallest"];
const ITEM_STATE_KEYS: [&str; 4] = ["queued", "completed", "skipped", "failed"];
const PRIVATE_WORDS: [&str; 12] = ["telemetry", "sei", "nal", "payload", "owned", "publication", "stdout", "stderr", "stack", "exception", "process", "runner"];
pub const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
pub const MAX_SNAPSHOT_BYTES: usize = 512 * 1024;
const PATH_KEYS: [&str; 3] = ["sourceRoot", "destinationRoot", "defaultPath"];

/// An IPC error: its code and, for this module's own, details.
#[derive(Debug, Clone)]
pub struct IpcError {
    pub code: String,
    pub retryable: bool,
    pub details: Option<Value>,
    own: bool,
}

fn fail<T>(code: &str) -> Result<T, IpcError> {
    Err(IpcError { code: code.into(), retryable: false, details: None, own: true })
}

fn fail_with<T>(code: &str, details: Value) -> Result<T, IpcError> {
    Err(IpcError { code: code.into(), retryable: false, details: Some(details), own: true })
}

/// an error from automatic conversion or the benchmark (a plain code)
fn code_err(code: String) -> IpcError {
    IpcError { code, retryable: false, details: None, own: false }
}

impl From<Fail> for IpcError {
    fn from(f: Fail) -> IpcError {
        IpcError { code: f.code.unwrap_or_default(), retryable: f.retryable, details: None, own: false }
    }
}

type R<T> = Result<T, IpcError>;

/// What the channels call (the job service; tests stand in their own).
pub trait ServiceApi: Send + Sync {
    fn start(&self, config: &Value) -> SResult<String>;
    fn get(&self, id: &str) -> SResult<Value>;
    fn list(&self) -> SResult<Vec<Value>>;
    fn list_summaries(&self) -> SResult<Vec<Value>>;
    fn pause(&self, id: &str) -> SResult<Value>;
    fn resume(&self, id: &str) -> SResult<Value>;
    fn cancel(&self, id: &str) -> SResult<Value>;
    fn discard(&self, id: &str) -> SResult<Value>;
    fn retry_failed(&self, id: &str) -> SResult<Value>;
    fn dismiss_summary(&self, id: &str) -> SResult<Value>;
    fn set_concurrency(&self, id: &str, value: &Value) -> SResult<Value>;
    /// (Node answers OPERATION_FAILED for a service without setLanes)
    fn set_lanes(&self, _id: &str, _lanes: &Value) -> SResult<Value> {
        Err(Fail::code("OPERATION_FAILED"))
    }
    fn subscribe(&self, l: Listener) -> u64;
}

/// runtime.runBenchmark / cancelBenchmark, as the channels call them
pub trait BenchmarkApi: Send + Sync {
    fn run(&self, req: &super::runtime::BenchRequest, on_progress: &(dyn Fn(Value) + Sync)) -> Result<Value, String>;
    fn cancel(&self);
}

impl BenchmarkApi for super::runtime::Converter {
    fn run(&self, req: &super::runtime::BenchRequest, on_progress: &(dyn Fn(Value) + Sync)) -> Result<Value, String> {
        self.run_benchmark(req, on_progress)
    }
    fn cancel(&self) {
        self.cancel_benchmark()
    }
}

/// What the channels use besides the job service (set once by the integrator).
#[derive(Default, Clone)]
pub struct Extras {
    pub devices: Option<Arc<dyn Fn() -> Value + Send + Sync>>,
    pub auto: Option<Arc<super::auto_convert::Auto>>,
    pub benchmark: Option<Arc<dyn BenchmarkApi>>,
}

impl ServiceApi for Service {
    fn start(&self, c: &Value) -> SResult<String> {
        Service::start(self, c)
    }
    fn get(&self, id: &str) -> SResult<Value> {
        Service::get(self, id)
    }
    fn list(&self) -> SResult<Vec<Value>> {
        Service::list(self)
    }
    fn list_summaries(&self) -> SResult<Vec<Value>> {
        Service::list_summaries(self)
    }
    fn pause(&self, id: &str) -> SResult<Value> {
        Service::pause(self, id)
    }
    fn resume(&self, id: &str) -> SResult<Value> {
        Service::resume(self, id)
    }
    fn cancel(&self, id: &str) -> SResult<Value> {
        Service::cancel(self, id)
    }
    fn discard(&self, id: &str) -> SResult<Value> {
        Service::discard(self, id)
    }
    fn retry_failed(&self, id: &str) -> SResult<Value> {
        Service::retry_failed(self, id)
    }
    fn dismiss_summary(&self, id: &str) -> SResult<Value> {
        Service::dismiss_summary(self, id)
    }
    fn set_concurrency(&self, id: &str, v: &Value) -> SResult<Value> {
        Service::set_concurrency(self, id, v)
    }
    fn set_lanes(&self, id: &str, l: &Value) -> SResult<Value> {
        Service::set_lanes(self, id, l)
    }
    fn subscribe(&self, l: Listener) -> u64 {
        Service::subscribe(self, l)
    }
}

// ---- payload checks ------------------------------------------------------------

fn private_key(k: &str) -> bool {
    let l = k.to_lowercase();
    PRIVATE_WORDS.iter().any(|w| l.contains(w))
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// boundedJsonValue(value, byteLimit, { stripPrivate, finiteNumbers })
pub fn bounded(value: &Value, limit: usize, strip: bool, finite: bool) -> R<Value> {
    let mut nodes = 0usize;
    let mut units = 0usize;
    fn visit(v: &Value, key: &str, limit: usize, strip: bool, finite: bool, nodes: &mut usize, units: &mut usize) -> R<Option<Value>> {
        *nodes += 1;
        if *nodes > 20_000 {
            return fail("PAYLOAD_TOO_LARGE");
        }
        if strip && private_key(key) {
            return Ok(None);
        }
        Ok(Some(match v {
            Value::Null | Value::Bool(_) => v.clone(),
            Value::Number(n) => {
                let ok = if finite { true } else { super::jobstore::normalize::safe_int_of(v).is_some() || n.as_f64().is_none() };
                if !ok {
                    return fail("INVALID_REQUEST");
                }
                v.clone()
            }
            Value::String(s) => {
                let l = js_len(s);
                *units += l;
                if l > 32_768 || *units > limit {
                    return fail("PAYLOAD_TOO_LARGE");
                }
                v.clone()
            }
            Value::Array(a) => {
                if a.len() > 10_000 {
                    return fail("PAYLOAD_TOO_LARGE");
                }
                let mut out = Vec::with_capacity(a.len());
                for x in a {
                    // (an array element is never stripped: its key is '')
                    out.push(visit(x, "", limit, strip, finite, nodes, units)?.unwrap_or(Value::Null));
                }
                Value::Array(out)
            }
            Value::Object(m) => {
                if m.len() > 128 {
                    return fail("PAYLOAD_TOO_LARGE");
                }
                let mut out = Map::new();
                for (k, x) in m {
                    if js_len(k) > 128 {
                        return fail("INVALID_REQUEST");
                    }
                    if let Some(s) = visit(x, k, limit, strip, finite, nodes, units)? {
                        out.insert(k.clone(), s);
                    }
                }
                Value::Object(out)
            }
        }))
    }
    let out = visit(value, "", limit, strip, finite, &mut nodes, &mut units)?.unwrap_or(Value::Null);
    if serde_json::to_string(&out).map(|s| s.len()).unwrap_or(usize::MAX) > limit {
        return fail("PAYLOAD_TOO_LARGE");
    }
    Ok(out)
}

/// sanitizeSnapshot(snapshot)
pub fn sanitize_snapshot(snapshot: &Value) -> R<Value> {
    let Some(m) = snapshot.as_object() else { return fail("INVALID_SNAPSHOT") };
    let items = m.get("items").and_then(Value::as_array);
    let Some(items) = items.filter(|i| i.len() > 256) else { return bounded(snapshot, MAX_SNAPSHOT_BYTES, true, true) };
    let count = items.len();
    let mut state_counts = Map::new();
    for k in ITEM_STATE_KEYS {
        state_counts.insert(k.into(), json!(items.iter().filter(|i| i["state"] == k).count()));
    }
    state_counts.insert("active".into(), json!(items.iter().filter(|i| i["state"] == "processing").count()));
    let cleanup_pending = items.iter().filter(|i| i.get("resultCode").and_then(Value::as_str).unwrap_or("").contains("cleanup-pending")).count();
    let active_index = items.iter().position(|i| i.get("id").is_some() && i.get("id") == m.get("activeItemId"));
    let failed: Vec<usize> = items.iter().enumerate().filter(|(_, i)| i["state"] == "failed").map(|(n, _)| n).collect();
    let mut limit = 256usize;
    loop {
        let mut selected: Vec<usize> = Vec::new();
        let add = |n: usize, sel: &mut Vec<usize>| {
            if !sel.contains(&n) {
                sel.push(n);
            }
        };
        if let Some(a) = active_index {
            add(a, &mut selected);
        }
        for &f in failed.iter().rev() {
            if selected.len() >= limit {
                break;
            }
            add(f, &mut selected);
        }
        let mut i = count;
        while i > 0 && selected.len() < limit {
            i -= 1;
            add(i, &mut selected);
        }
        selected.sort_unstable();
        let mut prepared = m.clone();
        prepared.insert("items".into(), Value::Array(selected.iter().map(|n| items[*n].clone()).collect()));
        prepared.insert("itemCount".into(), json!(count));
        prepared.insert("itemStateCounts".into(), Value::Object(state_counts.clone()));
        prepared.insert("cleanupPendingCount".into(), json!(cleanup_pending));
        prepared.insert("itemsTruncated".into(), json!(true));
        match bounded(&Value::Object(prepared), MAX_SNAPSHOT_BYTES, true, true) {
            Ok(v) => return Ok(v),
            Err(e) if e.code == "PAYLOAD_TOO_LARGE" && limit > 1 => limit = (limit / 2).max(1),
            Err(e) => return Err(e),
        }
    }
}

/// sanitizeLiveProgress(progress)
pub fn sanitize_live_progress(p: &Value) -> R<Value> {
    let Some(m) = p.as_object() else { return fail("INVALID_PROGRESS") };
    let phase = m.get("phase").and_then(Value::as_str).filter(|ph| *ph == "continue" || *ph == "end");
    let Some(phase) = phase else { return fail("INVALID_PROGRESS") };
    let mut out = Map::new();
    out.insert("phase".into(), json!(phase));
    if let Some(v) = m.get("outTimeUs") {
        match super::jobstore::normalize::safe_int_of(v) {
            Some(n) if n >= 0 && v.is_number() => {
                out.insert("outTimeUs".into(), json!(n));
            }
            _ => return fail("INVALID_PROGRESS"),
        }
    }
    if let Some(v) = m.get("fps") {
        match v.as_f64() {
            Some(f) if f.is_finite() && (0.0..=1_000_000.0).contains(&f) => {
                out.insert("fps".into(), super::jobstore::normalize::num(contracts::js_round(f * 10.0) / 10.0));
            }
            _ => return fail("INVALID_PROGRESS"),
        }
    }
    for k in ["waitingOnNode", "encodingNow"] {
        if let Some(v) = m.get(k) {
            match super::jobstore::normalize::safe_int_of(v) {
                Some(n) if (0..=10_000).contains(&n) => {
                    out.insert(k.into(), json!(n));
                }
                _ => return fail("INVALID_PROGRESS"),
            }
        }
    }
    Ok(Value::Object(out))
}

/// responseError(error)
pub fn response_error(e: &IpcError) -> Value {
    let raw = e.code.to_uppercase().replace('-', "_");
    let ok = !raw.is_empty() && raw.len() <= 64 && raw.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
    let mut err = Map::new();
    err.insert("code".into(), json!(if ok { raw } else { "OPERATION_FAILED".into() }));
    err.insert("retryable".into(), json!(e.retryable));
    if e.own {
        if let Some(d) = e.details.as_ref().filter(|d| d.is_object()) {
            if let Ok(b) = bounded(d, 4096, false, false) {
                err.insert("details".into(), b);
            }
        }
    }
    json!({ "ok": false, "error": Value::Object(err) })
}

fn safe_job_id(v: Option<&Value>) -> R<String> {
    match v.and_then(Value::as_str) {
        Some(s) if super::jobstore::normalize::is_safe_id(s) && !super::jobstore::normalize::is_windows_reserved(s) => Ok(s.into()),
        _ => fail("INVALID_JOB_ID"),
    }
}

fn job_id(p: Option<&Value>) -> R<String> {
    match p.and_then(Value::as_object) {
        Some(m) if m.len() == 1 => safe_job_id(m.get("jobId")),
        _ => fail("INVALID_JOB_ID"),
    }
}

fn no_payload(p: Option<&Value>) -> R<()> {
    if p.is_some() {
        return fail("INVALID_REQUEST");
    }
    Ok(())
}

fn absolute(v: Option<&Value>) -> R<String> {
    match v.and_then(Value::as_str) {
        Some(s) if !s.is_empty() && js_len(s) <= 32_768 && !s.contains('\0') && super::jobstore::normalize::any_absolute(s) => Ok(super::owned::resolve(Path::new(s)).to_string_lossy().to_string()),
        _ => fail("INVALID_PATH"),
    }
}

fn canonical_directory(v: Option<&Value>) -> R<(String, String)> {
    let abs = absolute(v)?;
    let (st, real) = match (std::fs::symlink_metadata(&abs), std::fs::canonicalize(&abs)) {
        (Ok(st), Ok(real)) => (st, real),
        _ => return fail("PATH_UNAVAILABLE"),
    };
    if !st.is_dir() {
        return fail("INVALID_PATH");
    }
    Ok((abs, real.to_string_lossy().to_string()))
}

fn canonical_future_directory(v: Option<&Value>) -> R<(String, String)> {
    let abs = absolute(v)?;
    let mut cursor = std::path::PathBuf::from(&abs);
    let mut suffix: Vec<std::ffi::OsString> = vec![];
    loop {
        match std::fs::symlink_metadata(&cursor) {
            Ok(st) => {
                if !st.is_dir() {
                    return fail("INVALID_PATH");
                }
                let Ok(mut real) = std::fs::canonicalize(&cursor) else { return fail("PATH_UNAVAILABLE") };
                for s in &suffix {
                    real.push(s);
                }
                return Ok((abs, real.to_string_lossy().to_string()));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let Some(parent) = cursor.parent().map(Path::to_path_buf) else { return fail("PATH_UNAVAILABLE") };
                suffix.insert(0, cursor.file_name().unwrap_or_default().to_os_string());
                cursor = parent;
            }
            Err(_) => return fail("PATH_UNAVAILABLE"),
        }
    }
}

fn overlaps(a: &str, b: &str) -> bool {
    let (x, y) = (super::owned::resolve(Path::new(a)), super::owned::resolve(Path::new(b)));
    x.starts_with(&y) || y.starts_with(&x)
}

fn group_list_ok(v: Option<&Value>, exact: bool) -> bool {
    let Some(a) = v.and_then(Value::as_array) else { return false };
    if a.is_empty() || (exact && a.len() != 3) {
        return false;
    }
    let mut seen = std::collections::HashSet::new();
    a.iter().all(|g| g.as_str().is_some_and(|s| GROUPS.contains(&s) && seen.insert(s.to_string())))
}

/// validateStartConfig(payload)
pub fn validate_start_config(p: Option<&Value>, replacement: &str) -> R<Value> {
    let Some(m) = p.and_then(Value::as_object) else { return fail("INVALID_REQUEST") };
    let has = |k: &str| m.contains_key(k);
    let mut expected: Vec<&str> = vec!["sourceRoot", "destinationRoot", "codec", "profileId", "networkMode", "outputMode", "includedGroups", "replacementConfirmed"];
    for k in ["groupOrder", "concurrency", "bitrateKbps", "qualityLevel", "verifyMode", "lanes", "keepOffTarget", "keepLarger"] {
        if has(k) {
            expected.push(k);
        }
    }
    if m.len() != expected.len() || !expected.iter().all(|k| m.contains_key(*k)) {
        return fail("INVALID_REQUEST");
    }
    let profile = m.get("profileId").and_then(Value::as_str).unwrap_or("");
    let bitrate_ok = m.get("bitrateKbps").and_then(super::jobstore::normalize::safe_int_of).is_some_and(|b| (contracts::CUSTOM_BITRATE_KBPS_MIN..=contracts::CUSTOM_BITRATE_KBPS_MAX).contains(&b));
    if if profile == "custom" { !bitrate_ok } else { has("bitrateKbps") } {
        return fail("INVALID_BITRATE");
    }
    let quality_ok = m.get("qualityLevel").and_then(Value::as_str).is_some_and(|q| contracts::QUALITY_LEVELS.contains(&q));
    if if profile == "quality" { !quality_ok } else { has("qualityLevel") } {
        return fail("INVALID_QUALITY");
    }
    if has("concurrency") && !contracts::is_valid_concurrency(&m["concurrency"]) {
        return fail("INVALID_CONCURRENCY");
    }
    let no_target = profile == "custom" || profile == "quality" || profile == contracts::SMALLEST_PROFILE_ID;
    if has("keepOffTarget") && (!m["keepOffTarget"].is_boolean() || (m["keepOffTarget"] == true && no_target)) {
        return fail("INVALID_KEEP_OFF_TARGET");
    }
    if has("keepLarger") && (!m["keepLarger"].is_boolean() || (m["keepLarger"] == true && !no_target)) {
        return fail("INVALID_KEEP_LARGER");
    }
    let mut lanes = None;
    if has("lanes") {
        match contracts::normalize_lanes(&m["lanes"]) {
            Ok(l) => lanes = l,
            Err(_) => return fail("INVALID_LANES"),
        }
    }
    if has("verifyMode") && !m["verifyMode"].as_str().is_some_and(contracts::is_valid_verify_mode) {
        return fail("INVALID_VERIFY_MODE");
    }
    if !m["codec"].as_str().is_some_and(|c| c == "h265" || c == "av1") {
        return fail("INVALID_CODEC");
    }
    if !PROFILE_IDS.contains(&profile) || !m["profileId"].is_string() {
        return fail("INVALID_PROFILE");
    }
    // Smallest (CPU only) is an x265 setting: H.265 only
    if profile == contracts::SMALLEST_PROFILE_ID && m["codec"] != "h265" {
        return fail("INVALID_CODEC");
    }
    if !m["networkMode"].as_str().is_some_and(|c| ["auto", "staging", "direct"].contains(&c)) {
        return fail("INVALID_NETWORK_MODE");
    }
    let output = m["outputMode"].as_str().unwrap_or("");
    if !["separate", "replace"].contains(&output) {
        return fail("INVALID_OUTPUT_MODE");
    }
    if !group_list_ok(m.get("includedGroups"), false) {
        return fail("INVALID_GROUP_SELECTION");
    }
    if has("groupOrder") && !group_list_ok(m.get("groupOrder"), true) {
        return fail("INVALID_GROUP_ORDER");
    }
    let (source_abs, source_real) = canonical_directory(m.get("sourceRoot"))?;
    let mut out = m.clone();
    // Smallest (CPU only) runs on this server's CPU: its lanes become their total
    let cpu_only = profile == contracts::SMALLEST_PROFILE_ID;
    let with_lanes = |mut o: Map<String, Value>| -> Value {
        match &lanes {
            Some(l) => {
                if cpu_only {
                    o.shift_remove("lanes");
                } else {
                    o.insert("lanes".into(), l.clone());
                }
                o.insert("concurrency".into(), json!(contracts::lanes_total(l)));
            }
            None => {
                o.shift_remove("lanes");
            }
        }
        Value::Object(o)
    };
    if output == "replace" {
        if !m["destinationRoot"].is_null() {
            return fail("INVALID_PATH");
        }
        if m["replacementConfirmed"] != true {
            return fail("REPLACEMENT_CONFIRMATION_REQUIRED");
        }
        if replacement != "available" {
            return fail("REPLACEMENT_UNAVAILABLE");
        }
        if has("verifyMode") && m["verifyMode"] == "off" {
            out.insert("verifyMode".into(), json!("quick"));
        }
        out.insert("sourceRoot".into(), json!(source_real));
        return Ok(with_lanes(out));
    }
    if m["replacementConfirmed"] != false {
        return fail("INVALID_REPLACEMENT_CONFIRMATION");
    }
    let (dest_abs, dest_real) = canonical_future_directory(m.get("destinationRoot"))?;
    for s in [&source_abs, &source_real] {
        for d in [&dest_abs, &dest_real] {
            if overlaps(s, d) {
                return fail("PATH_OVERLAP");
            }
        }
    }
    out.insert("sourceRoot".into(), json!(source_real));
    out.insert("destinationRoot".into(), json!(dest_real));
    Ok(with_lanes(out))
}

/// chooseCurrent(snapshots)
fn choose_current(snaps: &[Value]) -> R<Option<Value>> {
    let candidates: Vec<&Value> = snaps.iter().filter(|s| s.is_object()).collect();
    let active: Vec<&Value> = candidates.iter().copied().filter(|s| ACTIVE_STATES.contains(&s["state"].as_str().unwrap_or("\0"))).collect();
    let mut visible: Vec<&Value> = if !active.is_empty() { active } else { candidates.into_iter().filter(|s| s.get("summaryDismissed") != Some(&json!(true))).collect() };
    let n = |v: &Value, k: &str| v.get(k).and_then(Value::as_f64).filter(|x| *x != 0.0).unwrap_or(0.0);
    visible.sort_by(|a, b| {
        let d = n(b, "updatedAt") - n(a, "updatedAt");
        let d = if d != 0.0 { d } else { n(b, "revision") - n(a, "revision") };
        d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    match visible.first() {
        Some(v) => sanitize_snapshot(v).map(Some),
        None => Ok(None),
    }
}

// ---- the bridge -------------------------------------------------------------------

pub type Sink = Box<dyn Fn(&str) -> bool + Send + Sync>;

struct Sender {
    sink: Arc<Sink>,
    alive: Arc<std::sync::atomic::AtomicBool>,
    count: usize,
}

pub struct Bridge {
    service: Arc<dyn ServiceApi>,
    ctx: Arc<dyn ConverterCtx>,
    capabilities: Value,
    clients: Mutex<HashMap<String, (Arc<Sink>, Arc<std::sync::atomic::AtomicBool>)>>,
    senders: Arc<Mutex<HashMap<String, Sender>>>,
    vetted: Mutex<HashMap<String, usize>>,
    extras: Mutex<Extras>,
}

/// validateCapabilities(staging.capabilities + destinationContainment)
pub fn capabilities(staging: &Value) -> Value {
    let pick = |k: &str, choices: &[&str]| -> Value {
        let v = staging.get(k).and_then(Value::as_str).unwrap_or("unavailable");
        json!(if choices.contains(&v) { v } else { "unavailable" })
    };
    json!({
        "separatePublication": pick("separatePublication", &["hardlink-cleanup-pending", "native-atomic", "unavailable"]),
        "ownershipCleanup": pick("ownershipCleanup", &["atomic-expected-ownership", "unavailable"]),
        "replacement": pick("replacement", &["available", "unavailable"]),
        "destinationContainment": "pathname-revalidated-non-atomic",
    })
}

impl Bridge {
    pub fn new(service: Arc<dyn ServiceApi>, ctx: Arc<dyn ConverterCtx>, capabilities: Value) -> Arc<Bridge> {
        let b = Arc::new(Bridge { service: service.clone(), ctx: ctx.clone(), capabilities, clients: Mutex::new(HashMap::new()), senders: Arc::new(Mutex::new(HashMap::new())), vetted: Mutex::new(HashMap::new()), extras: Mutex::new(Extras::default()) });
        let senders = b.senders.clone();
        let dropped_logged = Arc::new(std::sync::atomic::AtomicBool::new(false));
        service.subscribe(Arc::new(move |event: &Value| {
            let kind = event["type"].as_str().unwrap_or("");
            if kind == "item_timing" {
                if let Some(p) = event.get("outputPath").and_then(Value::as_str) {
                    ctx.clip_converted(p);
                }
            }
            if kind != "snapshot" && kind != "progress" {
                return;
            }
            if senders.lock().unwrap().is_empty() {
                return;
            }
            let id = event["jobId"].as_str().unwrap_or("");
            let rev = super::jobstore::normalize::safe_int_of(&event["revision"]);
            let (Some(rev), true) = (rev.filter(|r| *r >= 0), super::jobstore::normalize::is_safe_id(id) && !super::jobstore::normalize::is_windows_reserved(id)) else { return };
            let snapshot = if kind == "snapshot" { sanitize_snapshot(&event["snapshot"]) } else { sanitize_live_progress(&event["progress"]).map(|p| json!({ "id": id, "revision": rev, "progress": p })) };
            let snapshot = match snapshot {
                Ok(s) => s,
                Err(e) => {
                    if !dropped_logged.swap(true, std::sync::atomic::Ordering::SeqCst) {
                        eprintln!("[CONVERTER] A live update could not be sent to the window: {}", e.code);
                    }
                    return;
                }
            };
            let text = format!("event: converter:progress\ndata: {}\n\n", json!({ "jobId": id, "revision": rev, "snapshot": snapshot }));
            let list: Vec<(String, Arc<Sink>, Arc<std::sync::atomic::AtomicBool>)> = senders.lock().unwrap().iter().map(|(k, s)| (k.clone(), s.sink.clone(), s.alive.clone())).collect();
            for (k, sink, alive) in list {
                if !alive.load(std::sync::atomic::Ordering::SeqCst) || !sink(&text) {
                    senders.lock().unwrap().remove(&k);
                }
            }
        }));
        b
    }

    /// The devices, automatic conversion and the benchmark (each channel
    /// answers DEVICES_UNAVAILABLE / AUTO_UNAVAILABLE / BENCHMARK_UNAVAILABLE without its own).
    pub fn set_extras(&self, e: Extras) {
        *self.extras.lock().unwrap() = e;
    }

    /// set_extras from a runtime: its devices, its automatic conversion, its benchmark
    pub fn mount_runtime(&self, conv: &Arc<super::runtime::Converter>) {
        let c = conv.clone();
        self.set_extras(Extras { devices: Some(Arc::new(move || c.devices_answer())), auto: Some(conv.auto.clone()), benchmark: Some(conv.clone()) });
    }

    fn extras(&self) -> Extras {
        self.extras.lock().unwrap().clone()
    }

    pub fn channels(&self) -> Vec<&'static str> {
        CHANNELS.to_vec()
    }

    /// attachEvents(clientId, res): `sink` writes SSE text and answers false once the client is gone.
    pub fn attach_events(self: &Arc<Bridge>, client: &str, sink: Sink) {
        let sink = Arc::new(sink);
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        self.clients.lock().unwrap().insert(client.to_string(), (sink.clone(), alive.clone()));
        let me = self.clone();
        let client = client.to_string();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(15));
            if !alive.load(std::sync::atomic::Ordering::SeqCst) || !sink(": ping\n\n") {
                alive.store(false, std::sync::atomic::Ordering::SeqCst);
                me.detach(&client);
                return;
            }
        });
    }

    /// the client's SSE stream closed
    pub fn detach(&self, client: &str) {
        let mut clients = self.clients.lock().unwrap();
        if let Some((_, alive)) = clients.get(client) {
            alive.store(false, std::sync::atomic::Ordering::SeqCst);
        }
        clients.remove(client);
        self.senders.lock().unwrap().remove(client);
    }

    fn check_paths(&self, payload: &mut Option<Value>, added: &mut Vec<String>) -> Result<(), ()> {
        let Some(Value::Object(m)) = payload.as_mut() else { return Ok(()) };
        self.check_map(m, added)?;
        if let Some(Value::Object(c)) = m.get_mut("config") {
            self.check_map(c, added)?;
        }
        Ok(())
    }

    fn check_map(&self, m: &mut Map<String, Value>, added: &mut Vec<String>) -> Result<(), ()> {
        for k in PATH_KEYS {
            let Some(Value::String(s)) = m.get(k) else { continue };
            let Some(real) = self.ctx.resolve_path(s, k != "destinationRoot") else { return Err(()) };
            m.insert(k.into(), json!(real));
            *self.vetted.lock().unwrap().entry(real.clone()).or_insert(0) += 1;
            added.push(real);
        }
        Ok(())
    }

    fn release(&self, added: &[String]) {
        let mut v = self.vetted.lock().unwrap();
        for p in added {
            let n = v.get(p).copied().unwrap_or(1).saturating_sub(1);
            if n > 0 {
                v.insert(p.clone(), n);
            } else {
                v.remove(p);
            }
        }
    }

    /// invoke(name, payload, clientId): always the IPC envelope
    pub fn invoke(&self, name: &str, payload: Option<Value>, client: Option<&str>) -> Value {
        let channel = format!("converter:{name}");
        if !CHANNELS.contains(&channel.as_str()) {
            return json!({ "ok": false, "error": { "code": "UNKNOWN_CHANNEL" } });
        }
        let mut payload = payload;
        if matches!(name, "start" | "setAuto" | "saveVehicle") {
            if let Some(p) = payload.as_mut() {
                clamp_verify(p);
                if let Some(c) = p.get_mut("config") {
                    clamp_verify(c);
                }
            }
        }
        let mut added = vec![];
        if self.check_paths(&mut payload, &mut added).is_err() {
            self.release(&added);
            return json!({ "ok": false, "error": { "code": "PATH_NOT_ALLOWED" } });
        }
        let out = match payload.as_ref().map(|p| bounded(p, MAX_PAYLOAD_BYTES, false, false)).transpose() {
            Err(e) => response_error(&e),
            Ok(p) => match self.handle(name, p.as_ref(), client) {
                Ok(v) => json!({ "ok": true, "value": v }),
                Err(e) => response_error(&e),
            },
        };
        self.release(&added);
        out
    }

    fn current_job(&self) -> R<Value> {
        let summaries = self.service.list_summaries()?;
        let Some(chosen) = choose_current(&summaries)? else { return Ok(Value::Null) };
        match self.service.get(chosen["id"].as_str().unwrap_or("")) {
            Ok(s) => sanitize_snapshot(&s),
            Err(_) => Ok(choose_current(&self.service.list()?)?.unwrap_or(Value::Null)),
        }
    }

    fn handle(&self, name: &str, p: Option<&Value>, client: Option<&str>) -> R<Value> {
        let replacement = self.capabilities["replacement"].as_str().unwrap_or("unavailable").to_string();
        match name {
            "chooseFolder" => {
                let Some(m) = p.and_then(Value::as_object) else { return fail("INVALID_REQUEST") };
                if !m.get("purpose").and_then(Value::as_str).is_some_and(|x| x == "source" || x == "destination") || m.keys().any(|k| k != "purpose" && k != "defaultPath") {
                    return fail("INVALID_REQUEST");
                }
                let default = if m.contains_key("defaultPath") { Some(absolute(m.get("defaultPath"))?) } else { None };
                // the browser picked the folder: it is the one the guard checked
                let picked = default.filter(|d| self.vetted.lock().unwrap().contains_key(d));
                match picked {
                    None => Ok(Value::Null),
                    Some(d) => Ok(json!(canonical_directory(Some(&json!(d)))?.1)),
                }
            }
            "start" => {
                let config = validate_start_config(p, &replacement)?;
                self.check_lane_encoders(&config)?;
                Ok(json!({ "jobId": safe_job_id(Some(&json!(self.service.start(&config)?)))? }))
            }
            "getCurrent" => {
                no_payload(p)?;
                self.current_job()
            }
            "pause" => sanitize_snapshot(&self.service.pause(&job_id(p)?)?),
            "setConcurrency" => {
                let m = p.and_then(Value::as_object);
                if !m.is_some_and(|m| m.len() == 2 && m.get("concurrency").is_some_and(contracts::is_valid_concurrency)) {
                    return fail("INVALID_CONCURRENCY");
                }
                let m = m.unwrap();
                let id = safe_job_id(m.get("jobId"))?;
                let snap = self.service.set_concurrency(&id, &m["concurrency"])?;
                // an automatic job's saved settings follow
                if snap["config"]["autoConvert"] == true {
                    if let Some(auto) = self.extras().auto {
                        let root = snap["config"]["sourceRoot"].as_str();
                        let lanes = snap["config"]["lanes"].as_array().filter(|a| !a.is_empty()).map(|_| snap["config"]["lanes"].clone());
                        let _ = match lanes {
                            Some(l) => auto.set_lanes(&l, root),
                            None => auto.set_concurrency(&m["concurrency"], root),
                        };
                    }
                }
                sanitize_snapshot(&snap)
            }
            "setLanes" => {
                let Some(m) = p.and_then(Value::as_object).filter(|m| m.len() == 2 && m.contains_key("jobId") && m.contains_key("lanes")) else { return fail("INVALID_REQUEST") };
                let lanes = match contracts::normalize_lanes(&m["lanes"]) {
                    Ok(Some(l)) => l,
                    _ => return fail("INVALID_LANES"),
                };
                let snap = self.service.set_lanes(&safe_job_id(m.get("jobId"))?, &lanes)?;
                if snap["config"]["autoConvert"] == true {
                    if let Some(auto) = self.extras().auto {
                        let _ = auto.set_lanes(&lanes, snap["config"]["sourceRoot"].as_str());
                    }
                }
                sanitize_snapshot(&snap)
            }
            "devices" => {
                no_payload(p)?;
                let Some(d) = self.extras().devices else { return fail("DEVICES_UNAVAILABLE") };
                bounded(&d(), MAX_PAYLOAD_BYTES, false, true)
            }
            "resume" => {
                let id = job_id(p)?;
                let snap = self.service.resume(&id)?;
                // resumed by the owner: "pause my own conversions" leaves it alone now
                if let Some(auto) = self.extras().auto {
                    auto.owner_resumed(&id);
                }
                sanitize_snapshot(&snap)
            }
            "cancel" => sanitize_snapshot(&self.service.cancel(&job_id(p)?)?),
            "discard" => {
                self.service.discard(&job_id(p)?)?;
                self.current_job()
            }
            "retryFailed" => sanitize_snapshot(&self.service.retry_failed(&job_id(p)?)?),
            "dismissSummary" => sanitize_snapshot(&self.service.dismiss_summary(&job_id(p)?)?),
            "getCapabilities" => {
                no_payload(p)?;
                Ok(self.capabilities.clone())
            }
            "subscribeProgress" => {
                no_payload(p)?;
                let entry = client.and_then(|c| self.clients.lock().unwrap().get(c).cloned().map(|s| (c.to_string(), s)));
                let Some((c, (sink, alive))) = entry.filter(|(_, (_, a))| a.load(std::sync::atomic::Ordering::SeqCst)) else { return fail("INVALID_SENDER") };
                let mut s = self.senders.lock().unwrap();
                s.entry(c).and_modify(|e| e.count += 1).or_insert(Sender { sink, alive, count: 1 });
                Ok(Value::Null)
            }
            "unsubscribeProgress" => {
                no_payload(p)?;
                if let Some(c) = client {
                    let mut s = self.senders.lock().unwrap();
                    if let Some(e) = s.get_mut(c) {
                        if e.count > 1 {
                            e.count -= 1;
                        } else {
                            s.remove(c);
                        }
                    }
                }
                Ok(Value::Null)
            }
            "runBenchmark" => self.run_benchmark(p, client),
            "cancelBenchmark" => {
                no_payload(p)?;
                if let Some(b) = self.extras().benchmark {
                    b.cancel();
                }
                Ok(Value::Null)
            }
            "getAuto" => {
                no_payload(p)?;
                let Some(auto) = self.extras().auto else { return fail("AUTO_UNAVAILABLE") };
                bounded(&auto.get_state(), MAX_PAYLOAD_BYTES, false, true)
            }
            "setAuto" => self.set_auto(p, &replacement),
            "saveVehicle" => {
                let Some(auto) = self.extras().auto else { return fail("AUTO_UNAVAILABLE") };
                let Some(m) = p.and_then(Value::as_object).filter(|m| m.len() == 1 && m.contains_key("config")) else { return fail("INVALID_REQUEST") };
                let config = validate_start_config(m.get("config"), &replacement)?;
                bounded(&auto.save_vehicle(&config).map_err(code_err)?, MAX_PAYLOAD_BYTES, false, true)
            }
            "forgetVehicle" => {
                let Some(auto) = self.extras().auto else { return fail("AUTO_UNAVAILABLE") };
                let Some(m) = p.and_then(Value::as_object).filter(|m| m.len() == 1) else { return fail("INVALID_REQUEST") };
                let Some(root) = m.get("forgetSource").and_then(Value::as_str).filter(|r| !r.is_empty() && js_len(r) <= 4096) else { return fail("INVALID_REQUEST") };
                bounded(&auto.forget_vehicle(root), MAX_PAYLOAD_BYTES, false, true)
            }
            "checkAutoNow" => {
                no_payload(p)?;
                let Some(auto) = self.extras().auto else { return fail("AUTO_UNAVAILABLE") };
                bounded(&auto.check_now(), MAX_PAYLOAD_BYTES, false, true)
            }
            _ => fail("UNKNOWN_CHANNEL"),
        }
    }
}

impl Bridge {
    /// checkLaneEncoders(config, devices): a lane on a GPU that cannot encode the codec is refused
    fn check_lane_encoders(&self, config: &Value) -> R<()> {
        let Some(lanes) = config["lanes"].as_array() else { return Ok(()) };
        let Some(devices) = self.extras().devices else { return Ok(()) };
        let known = devices();
        let list = known["devices"].as_array().cloned().unwrap_or_default();
        for lane in lanes {
            let Some(d) = list.iter().find(|d| d["id"] == lane["device"]) else { continue };
            let codec = config["codec"].as_str().unwrap_or("");
            if lane["concurrency"].as_i64().unwrap_or(0) > 0 && d["encoders"].get(codec).is_some_and(Value::is_null) {
                let name: String = d["name"].as_str().filter(|n| !n.is_empty()).or(d["id"].as_str()).unwrap_or("").chars().take(128).collect();
                return fail_with("DEVICE_UNSUPPORTED", json!({ "device": name, "codec": codec }));
            }
        }
        Ok(())
    }

    fn run_benchmark(&self, p: Option<&Value>, client: Option<&str>) -> R<Value> {
        let Some(bench) = self.extras().benchmark else { return fail("BENCHMARK_UNAVAILABLE") };
        let Some(m) = p.and_then(Value::as_object).filter(|m| m.keys().all(|k| ["codec", "codecs", "sourceRoot", "profileId", "bitrateKbps", "qualityLevel", "verifyMode"].contains(&k.as_str()))) else { return fail("INVALID_REQUEST") };
        if let Some(v) = m.get("verifyMode") {
            if !v.as_str().is_some_and(contracts::is_valid_verify_mode) {
                return fail("INVALID_VERIFY_MODE");
            }
        }
        let codecs = match m.get("codecs") {
            None => vec![m.get("codec").cloned().unwrap_or(Value::Null)],
            Some(Value::Array(a)) => a.clone(),
            Some(_) => return fail("INVALID_CODEC"),
        };
        let mut uniq = std::collections::HashSet::new();
        if codecs.is_empty() || codecs.len() > 2 || !codecs.iter().all(|c| c.as_str().is_some_and(|c| (c == "h265" || c == "av1") && uniq.insert(c.to_string()))) {
            return fail("INVALID_CODEC");
        }
        let profile = match m.get("profileId") {
            None | Some(Value::Null) => "balanced".to_string(),
            Some(v) => v.as_str().filter(|x| PROFILE_IDS.contains(x)).map(str::to_string).map_or_else(|| fail("INVALID_PROFILE"), Ok)?,
        };
        if profile == contracts::SMALLEST_PROFILE_ID && codecs.iter().any(|c| c != "h265") {
            return fail("INVALID_CODEC");
        }
        let bitrate_ok = m.get("bitrateKbps").and_then(super::jobstore::normalize::safe_int_of).is_some_and(|b| (contracts::CUSTOM_BITRATE_KBPS_MIN..=contracts::CUSTOM_BITRATE_KBPS_MAX).contains(&b));
        if if profile == "custom" { !bitrate_ok } else { m.contains_key("bitrateKbps") } {
            return fail("INVALID_BITRATE");
        }
        let quality_ok = m.get("qualityLevel").and_then(Value::as_str).is_some_and(|q| contracts::QUALITY_LEVELS.contains(&q));
        if if profile == "quality" { !quality_ok } else { m.contains_key("qualityLevel") } {
            return fail("INVALID_QUALITY");
        }
        let source_root = match m.get("sourceRoot") {
            None | Some(Value::Null) => None,
            v => Some(canonical_directory(v)?.1),
        };
        let req = super::runtime::BenchRequest {
            codecs: codecs.iter().filter_map(|c| c.as_str().map(str::to_string)).collect(),
            profile_id: profile.clone(),
            bitrate_kbps: if profile == "custom" { m.get("bitrateKbps").cloned() } else { None },
            quality_level: if profile == "quality" { m.get("qualityLevel").cloned() } else { None },
            verify_mode: m.get("verifyMode").and_then(Value::as_str).unwrap_or("quick").to_string(),
            source_root,
        };
        // converter:benchmarkProgress to the window that asked (best effort)
        let sink = client.and_then(|c| self.clients.lock().unwrap().get(c).cloned());
        let progress = move |v: Value| {
            if let Some((sink, alive)) = &sink {
                if alive.load(std::sync::atomic::Ordering::SeqCst) {
                    if let Ok(b) = bounded(&v, MAX_PAYLOAD_BYTES, false, true) {
                        sink(&format!("event: converter:benchmarkProgress\ndata: {b}\n\n"));
                    }
                }
            }
        };
        bench.run(&req, &progress).map_err(code_err)
    }

    fn set_auto(&self, p: Option<&Value>, replacement: &str) -> R<Value> {
        let Some(auto) = self.extras().auto else { return fail("AUTO_UNAVAILABLE") };
        let Some(m) = p.and_then(Value::as_object).filter(|m| m.keys().all(|k| ["enabled", "intervalMinutes", "window", "holdManual", "keepRunning", "openAtLogin", "config", "removeSource"].contains(&k.as_str()))) else { return fail("INVALID_REQUEST") };
        let interval_ok = m.get("intervalMinutes").and_then(Value::as_f64).is_some_and(|i| super::auto_convert::INTERVAL_MINUTES.iter().any(|x| *x as f64 == i));
        if !m.get("enabled").is_some_and(Value::is_boolean) || !interval_ok || !m.get("keepRunning").is_some_and(Value::is_boolean) || !m.get("openAtLogin").is_some_and(Value::is_boolean) {
            return fail("INVALID_REQUEST");
        }
        if m.get("holdManual").is_some_and(|h| !h.is_boolean()) {
            return fail("INVALID_REQUEST");
        }
        if let Some(r) = m.get("removeSource") {
            if !r.as_str().is_some_and(|r| js_len(r) <= 4096) {
                return fail("INVALID_REQUEST");
            }
        }
        let w = m.get("window").cloned().unwrap_or(Value::Null);
        let window = if w.as_object().is_some_and(|o| o.len() == 1 && o.get("follow") == Some(&json!("off-peak"))) {
            json!({ "follow": "off-peak" })
        } else if !w.is_null() {
            let hour = |k: &str| w.get(k).and_then(super::jobstore::normalize::safe_int_of).filter(|h| (0..=23).contains(h));
            match (hour("startHour"), hour("endHour")) {
                (Some(a), Some(b)) if a != b => json!({ "startHour": a, "endHour": b }),
                _ => return fail("INVALID_AUTO_WINDOW"),
            }
        } else {
            Value::Null
        };
        let enabled = m["enabled"] == true;
        let config = if !enabled || m.get("config").map_or(true, Value::is_null) { Value::Null } else { validate_start_config(m.get("config"), replacement)? };
        if enabled && config.is_null() && !m.contains_key("removeSource") {
            return fail("AUTO_CONFIG_REQUIRED");
        }
        let mut next = json!({ "enabled": enabled, "intervalMinutes": m["intervalMinutes"], "window": window, "holdManual": m.get("holdManual") == Some(&json!(true)), "keepRunning": m["keepRunning"], "openAtLogin": m["openAtLogin"], "config": config });
        if let Some(r) = m.get("removeSource") {
            next["removeSource"] = r.clone();
        }
        bounded(&auto.configure(&next).map_err(code_err)?, MAX_PAYLOAD_BYTES, false, true)
    }
}

/// clampVerify: a real conversion from the server never runs with verification Off
pub fn clamp_verify(v: &mut Value) {
    if let Some(m) = v.as_object_mut() {
        if m.get("verifyMode") == Some(&json!("off")) {
            m.insert("verifyMode".into(), json!("quick"));
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// The stand-in job service of lean/parity/converterBridge.js.
    #[derive(Default)]
    struct Fake(Mutex<(usize, Vec<(String, Value)>)>);

    impl Fake {
        fn get_(&self, id: &str) -> SResult<Value> {
            self.0.lock().unwrap().1.iter().find(|(i, _)| i == id).map(|(_, v)| v.clone()).ok_or_else(|| Fail::code("JOB_NOT_FOUND"))
        }
    }

    impl ServiceApi for Fake {
        fn start(&self, config: &Value) -> SResult<String> {
            let mut g = self.0.lock().unwrap();
            g.0 += 1;
            let n = g.0;
            let id = format!("job-{n}");
            g.1.push((id.clone(), json!({ "id": id, "state": if n % 2 == 1 { "waiting" } else { "completed" }, "revision": n, "updatedAt": 1000 + n, "config": config, "summary": null, "items": [] })));
            Ok(id)
        }
        fn get(&self, id: &str) -> SResult<Value> {
            self.get_(id)
        }
        fn list(&self) -> SResult<Vec<Value>> {
            Ok(self.0.lock().unwrap().1.iter().map(|(_, v)| v.clone()).collect())
        }
        fn list_summaries(&self) -> SResult<Vec<Value>> {
            self.list()
        }
        fn pause(&self, id: &str) -> SResult<Value> {
            self.get_(id)
        }
        fn resume(&self, id: &str) -> SResult<Value> {
            self.get_(id)
        }
        fn cancel(&self, id: &str) -> SResult<Value> {
            self.get_(id)
        }
        fn retry_failed(&self, id: &str) -> SResult<Value> {
            self.get_(id)
        }
        fn dismiss_summary(&self, id: &str) -> SResult<Value> {
            self.get_(id)
        }
        fn discard(&self, id: &str) -> SResult<Value> {
            self.get_(id)?;
            self.0.lock().unwrap().1.retain(|(i, _)| i != id);
            Ok(json!({ "jobId": id, "discarded": true }))
        }
        fn set_concurrency(&self, id: &str, c: &Value) -> SResult<Value> {
            let mut g = self.0.lock().unwrap();
            let j = g.1.iter_mut().find(|(i, _)| i == id).ok_or_else(|| Fail::code("JOB_NOT_FOUND"))?;
            j.1["config"]["concurrency"] = c.clone();
            Ok(j.1.clone())
        }
        fn subscribe(&self, _l: Listener) -> u64 {
            0
        }
    }

    struct Guard(std::path::PathBuf);

    impl ConverterCtx for Guard {
        fn data_path(&self) -> std::path::PathBuf {
            self.0.clone()
        }
        fn temp_path(&self) -> std::path::PathBuf {
            self.0.clone()
        }
        fn resolve_path(&self, p: &str, must_exist: bool) -> Option<String> {
            let allowed = std::fs::canonicalize(self.0.join("allowed")).ok()?;
            if !p.starts_with('/') {
                return None;
            }
            let mut cursor = super::super::owned::resolve(Path::new(p));
            let mut suffix: Vec<std::ffi::OsString> = vec![];
            loop {
                if let Ok(mut real) = std::fs::canonicalize(&cursor) {
                    for s in &suffix {
                        real.push(s);
                    }
                    if must_exist && !suffix.is_empty() {
                        return None;
                    }
                    return if real.starts_with(&allowed) { Some(real.to_string_lossy().to_string()) } else { None };
                }
                let parent = cursor.parent()?.to_path_buf();
                suffix.insert(0, cursor.file_name()?.to_os_string());
                cursor = parent;
            }
        }
    }

    /// Every request of lean/parity/converterBridge.js's corpus answers as
    /// server/converterBridge.js (over src/main/converter/ipc.js) answered
    /// it: tests/fixtures/node-reference/converter-bridge.json.
    #[test]
    fn channels_answer_as_node_answers() {
        let base = std::env::temp_dir().join(format!("lean-bridge-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        for d in ["allowed/TeslaCam/SentryClips", "allowed/out", "outside"] {
            std::fs::create_dir_all(base.join(d)).unwrap();
        }
        std::fs::write(base.join("allowed/file.txt"), b"x").unwrap();
        std::os::unix::fs::symlink(base.join("outside"), base.join("allowed/link")).unwrap();
        let places = [("{BASE}", base.to_string_lossy().into_owned())];
        if crate::record::recording() {
            let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("parity/converterBridge.js");
            let corpus = Command::new("node").arg(&script).arg("corpus").arg(&base).output().unwrap();
            assert!(corpus.status.success(), "{}", String::from_utf8_lossy(&corpus.stderr));
            let file = base.join("corpus.json");
            std::fs::write(&file, &corpus.stdout).unwrap();
            let theirs = Command::new("node").arg(&script).arg("run").arg(&base).arg(&file).output().unwrap();
            assert!(theirs.status.success(), "{}", String::from_utf8_lossy(&theirs.stderr));
            let theirs: Value = serde_json::from_slice(&theirs.stdout).unwrap();
            let requests: Value = serde_json::from_slice(&corpus.stdout).unwrap();
            crate::record::record("converter-bridge", "server/converterBridge.js by lean/parity/converterBridge.js corpus/run <base>, 2026-11-19", &places, &json!("corpus"), &json!({ "requests": requests, "answers": theirs }));
        }
        let frozen = crate::reference::answer("converter-bridge", &places, &json!("corpus"));
        let (requests, theirs) = (frozen["requests"].clone(), frozen["answers"].clone());
        assert!(requests.as_array().unwrap().len() > 100);
        let caps = capabilities(&json!({ "separatePublication": "native-atomic", "ownershipCleanup": "atomic-expected-ownership", "replacement": "available" }));
        let bridge = Bridge::new(Arc::new(Fake::default()), Arc::new(Guard(base.clone())), caps);
        // (the DEVICES of converterBridge.js: a GPU that cannot encode H.265)
        bridge.set_extras(Extras { devices: Some(Arc::new(|| json!({ "devices": [{ "id": "pci:0000:01:00.0", "kind": "dri", "name": "Old GPU", "encoders": { "h265": null, "av1": null } }] }))), auto: None, benchmark: None });
        let mut differences = vec![];
        for (n, r) in requests.as_array().unwrap().iter().enumerate() {
            let mine = bridge.invoke(r["name"].as_str().unwrap(), r.get("payload").cloned(), None);
            if mine != theirs[n] {
                differences.push(format!("{n} {} {}: node {} rust {}", r["name"], r.get("payload").map(|p| p.to_string()).unwrap_or_default().chars().take(160).collect::<String>(), theirs[n], mine));
            }
        }
        assert!(differences.is_empty(), "{} of {} differ:\n{}", differences.len(), requests.as_array().unwrap().len(), differences.join("\n"));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn smallest_keeps_only_the_total_of_its_lanes() {
        let base = std::env::temp_dir().join(format!("lean-smallest-lanes-{}", std::process::id()));
        std::fs::create_dir_all(base.join("src")).unwrap();
        let lanes = json!([{ "device": "pci:0000:01:00.0", "concurrency": 1 }, { "device": "cpu", "concurrency": 2 }]);
        let config = |profile: &str| json!({
            "sourceRoot": base.join("src"), "destinationRoot": null, "codec": "h265", "profileId": profile, "networkMode": "direct",
            "outputMode": "replace", "includedGroups": ["RecentClips"], "replacementConfirmed": true, "lanes": lanes
        });
        let smallest = validate_start_config(Some(&config("smallest")), "available").unwrap();
        assert_eq!((smallest.get("lanes"), &smallest["concurrency"]), (None, &json!(3)));
        let balanced = validate_start_config(Some(&config("balanced")), "available").unwrap();
        assert_eq!((&balanced["lanes"], &balanced["concurrency"]), (&lanes, &json!(3)));
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn large_snapshots_are_cut_as_node_cuts_them() {
        let items: Vec<Value> = (0..600).map(|i| json!({ "id": format!("item-{i:06}"), "state": if i % 50 == 0 { "failed" } else if i == 7 { "processing" } else { "queued" }, "resultCode": if i == 3 { json!("cleanup-pending") } else { Value::Null }, "ownedPaths": {} })).collect();
        let snap = json!({ "id": "job-1", "activeItemId": "item-000007", "state": "encoding", "items": items, "ownedArtifacts": {} });
        let s = sanitize_snapshot(&snap).unwrap();
        assert_eq!(s["itemCount"], 600);
        assert_eq!(s["itemsTruncated"], true);
        assert_eq!(s["items"].as_array().unwrap().len(), 256);
        assert_eq!(s["itemStateCounts"], json!({ "queued": 587, "completed": 0, "skipped": 0, "failed": 12, "active": 1 }));
        assert_eq!(s["cleanupPendingCount"], 1);
        assert!(s.get("ownedArtifacts").is_none() && s["items"][0].get("ownedPaths").is_none());
        assert_eq!(s["items"][0]["id"], "item-000000");
        assert!(s["items"].as_array().unwrap().iter().any(|i| i["id"] == "item-000007"));
    }
}
