//! src/main/converter/autoConvert.js: automatic conversion. On a schedule,
//! each automatic source folder (one per vehicle) is checked for clips no
//! earlier automatic run has handled, and just those are converted with that
//! folder's saved settings, one job at a time (or one per vehicle on its own
//! devices, with lanes). An optional time window pauses an automatic job
//! outside the chosen hours and resumes it inside them. The files in
//! `<data>/converter-auto` are Node's (the same JSON).
//!
//! Promises become one state lock held briefly (service calls, scans and
//! file writes happen outside it) and one tick at a time.

use super::contracts::{lanes_total, node_key_of, normalize_lanes};
use super::service::SResult;
use indexmap::IndexMap;
pub mod speed;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

pub const INTERVAL_MINUTES: [i64; 7] = [15, 30, 60, 180, 360, 720, 1440];
const SETTINGS_FILE: &str = "settings.json";
const STATE_FILE: &str = "state.json";
const SAVED_FILE: &str = "vehicles.json";
const MAX_FAILED_SWEEPS: i64 = 3;
/// Raised whenever encoding or verification changes in a way that could let
/// given-up clips convert now (see autoConvert.js).
pub const CONVERTER_REVISION: i64 = 8;
const INDEX_VERSION: i64 = 2;
const TERMINAL: [&str; 3] = ["completed", "failed", "cancelled"];
const MAX_SOURCES: usize = 64;

fn terminal(state: &Value) -> bool {
    state.as_str().is_some_and(|s| TERMINAL.contains(&s))
}

fn default_settings() -> Value {
    json!({ "enabled": false, "intervalMinutes": 60, "window": null, "holdManual": false, "keepRunning": false, "openAtLogin": false, "configs": [] })
}

fn is_hour(v: &Value) -> bool {
    v.as_i64().is_some_and(|h| (0..=23).contains(&h)) && v.as_f64().is_some_and(|f| f.fract() == 0.0)
}

fn is_node_device(id: &str) -> bool {
    id.starts_with("node:")
}

/// withValidLanes(config)
pub fn with_valid_lanes(config: &Value) -> Value {
    let Some(m) = config.as_object() else { return config.clone() };
    if !m.contains_key("lanes") {
        return config.clone();
    }
    let lanes = normalize_lanes(&m["lanes"]).ok().flatten();
    let mut r = m.clone();
    if let Some(off) = r.get("nodesOff").cloned() {
        let mut keys: Vec<String> = vec![];
        if let Some(a) = off.as_array() {
            for id in a.iter().filter_map(Value::as_str).filter(|s| is_node_device(s)) {
                if let Some(k) = node_key_of(id) {
                    if !keys.iter().any(|x| x == k) {
                        keys.push(k.to_string());
                    }
                }
            }
        }
        keys.truncate(32);
        if keys.is_empty() {
            r.shift_remove("nodesOff");
        } else {
            r.insert("nodesOff".into(), json!(keys));
        }
    }
    match lanes {
        Some(l) => {
            r.insert("concurrency".into(), json!(lanes_total(&l)));
            r.insert("lanes".into(), l);
        }
        None => {
            r.shift_remove("lanes");
        }
    }
    Value::Object(r)
}

/// A sent config without `keepRecent` inherits the stored one for the same folder; `null` removes it
/// (Original's page doesn't know the keep window, the guided page turns it off with null).
fn inherit_keep_recent(sent: &mut serde_json::Map<String, Value>, stored: Option<&Value>) {
    match sent.get("keepRecent") {
        Some(Value::Null) => {
            sent.shift_remove("keepRecent");
        }
        Some(_) => {}
        None => {
            if let Some(k) = stored.and_then(|c| c.get("keepRecent")) {
                sent.insert("keepRecent".into(), k.clone());
            }
        }
    }
}

fn is_config(c: &Value) -> bool {
    c.as_object().is_some_and(|m| m.get("sourceRoot").is_some_and(Value::is_string))
}

/// normalizeConfigs(value): one per source folder, the last one given wins
pub fn normalize_configs(value: &Value) -> Vec<Value> {
    let list: Vec<Value> = match value.get("configs") {
        Some(Value::Array(a)) => a.clone(),
        _ if value.get("enabled") == Some(&json!(true)) && value.get("config").is_some_and(is_config) => vec![value["config"].clone()],
        _ => vec![],
    };
    let mut by: IndexMap<String, Value> = IndexMap::new();
    for c in list {
        if !is_config(&c) {
            continue;
        }
        let mut copy = c.as_object().unwrap().clone();
        copy.shift_remove("deviceSettingsSource");
        if copy.get("keepOffTarget") != Some(&json!(true)) {
            copy.shift_remove("keepOffTarget");
        }
        if copy.get("keepLarger") != Some(&json!(true)) {
            copy.shift_remove("keepLarger");
        }
        let root = c["sourceRoot"].as_str().unwrap().to_string();
        // (a Map keeps the first position of a key set again)
        by.insert(root, with_valid_lanes(&Value::Object(copy)));
    }
    by.into_values().take(MAX_SOURCES).collect()
}

/// normalizeSettings(value)
pub fn normalize_settings(value: &Value) -> Result<Value, String> {
    if !value.is_object() {
        return Err("INVALID_AUTO_SETTINGS".into());
    }
    let configs = normalize_configs(value);
    let schedule = match value.get("schedule") {
        None | Some(Value::Null) => Value::Null,
        Some(v) => super::schedule::normalize(v)?,
    };
    // (while a calendar schedule is set, Original's dropdown reads "every 24 hours")
    let interval = if schedule.is_null() { interval_of(value) } else { 1440 };
    let mut s = json!({
        "enabled": !configs.is_empty(), "intervalMinutes": interval, "window": normalize_window(value)?,
        "holdManual": value.get("holdManual") == Some(&json!(true)), "keepRunning": value.get("keepRunning") == Some(&json!(true)),
        "openAtLogin": value.get("openAtLogin") == Some(&json!(true)), "configs": configs
    });
    // `catchUp` means the same with a calendar schedule and with an interval: on, a vehicle's
    // catch-up run (see `more_eligible`) ignores the window, and the schedule, until nothing
    // eligible is left; off, its work follows both from the start. So a saved value carries
    // over when an Original save clears the calendar. A calendar always stores it (a missing
    // one reads as on). In interval mode only a value sent is stored: Node's settings have
    // neither key, and a setup saved without one keeps Node's behaviour (no catch-up runs).
    let catch_up = value.get("catchUp") != Some(&json!(false));
    if !schedule.is_null() {
        s["schedule"] = schedule;
        s["catchUp"] = json!(catch_up);
    } else if value.get("catchUp").is_some_and(Value::is_boolean) {
        s["catchUp"] = json!(catch_up);
    }
    Ok(s)
}

fn interval_of(value: &Value) -> i64 {
    value.get("intervalMinutes").and_then(Value::as_f64).filter(|f| INTERVAL_MINUTES.iter().any(|i| *i as f64 == *f)).map(|f| f as i64).unwrap_or(60)
}

fn normalize_window(value: &Value) -> Result<Value, String> {
    let w = value.get("window").unwrap_or(&Value::Null);
    if w.get("follow") == Some(&json!("off-peak")) {
        return Ok(json!({ "follow": "off-peak" }));
    }
    if w.is_null() {
        return Ok(Value::Null);
    }
    let (a, b) = (w.get("startHour").unwrap_or(&Value::Null), w.get("endHour").unwrap_or(&Value::Null));
    if !is_hour(a) || !is_hour(b) || a.as_i64() == b.as_i64() {
        return Err("INVALID_AUTO_WINDOW".into());
    }
    Ok(json!({ "startHour": a.as_i64(), "endHour": b.as_i64() }))
}

/// The calendar schedule of normalized settings, or None (interval mode).
fn calendar_of(settings: &Value) -> Option<Value> {
    settings.get("schedule").filter(|s| !s.is_null()).cloned()
}

/// Normalized settings with the catch-up switch on (see `normalize_settings`).
fn catch_up_on(settings: &Value) -> bool {
    settings.get("catchUp") == Some(&json!(true))
}

/// A vehicle's saved config `old` (None: a vehicle new to automatic shrinking) becoming `new`
/// makes footage eligible that wasn't: a shorter keep window (none keeps nothing), a group
/// switched on, or another space level. Each of these starts a catch-up run.
fn more_eligible(old: Option<&Value>, new: &Value) -> bool {
    let Some(old) = old else { return true };
    let days = |c: &Value| c.get("keepRecent").filter(|k| super::keep_recent::valid(k)).and_then(|k| k["days"].as_i64()).unwrap_or(0);
    let groups = |c: &Value| -> Vec<&'static str> {
        match c.get("includedGroups") {
            Some(Value::Array(a)) => a.iter().filter_map(|g| g.as_str().and_then(super::scanner::canonical_group)).collect(),
            _ => super::scanner::GROUPS.to_vec(),
        }
    };
    let had = groups(old);
    days(new) < days(old) || groups(new).iter().any(|g| !had.contains(g)) || old.get("profileId") != new.get("profileId")
}

/// inWindow(window, hour): inside [start, end), wrapping past midnight
pub fn in_window(window: &Value, hour: i64) -> bool {
    if window.is_null() {
        return true;
    }
    let (s, e) = (window["startHour"].as_i64().unwrap_or(0), window["endHour"].as_i64().unwrap_or(0));
    if s < e {
        hour >= s && hour < e
    } else {
        hour >= s || hour < e
    }
}

/// setupKey(config)
pub fn setup_key(config: &Value) -> String {
    let pick = |k: &str| config.get(k).cloned().unwrap_or(Value::Null);
    let text = Value::Array(vec![pick("sourceRoot"), pick("destinationRoot"), pick("codec"), pick("outputMode")]).to_string();
    super::tesla_sei::hex(&Sha256::digest(text.as_bytes()))[..24].to_string()
}

/// planLanes({ cars, wanting, localHolder, devices, priorities }): which
/// devices each vehicle's automatic job gets, as lanes
pub fn plan_lanes(cars: &[Value], wanting: &[String], local_holder: Option<&str>, devices: &[Value], priorities: &Value) -> IndexMap<String, Vec<Value>> {
    let by_root: IndexMap<String, &Value> = cars.iter().filter(|c| c["lanes"].is_array()).map(|c| (c["sourceRoot"].as_str().unwrap_or("").to_string(), c)).collect();
    let mut plan: IndexMap<String, Vec<Value>> = by_root.keys().filter(|r| wanting.contains(r)).map(|r| (r.clone(), vec![])).collect();
    let present: std::collections::HashSet<String> = devices.iter().filter(|d| d.is_object() && d["online"] != false).filter_map(|d| d["id"].as_str().map(str::to_string)).collect();
    let lanes_of = |root: &str| by_root.get(root).and_then(|c| c["lanes"].as_array().cloned()).unwrap_or_default();
    if let Some(h) = local_holder.filter(|h| plan.contains_key(*h)) {
        for lane in lanes_of(h) {
            let d = lane["device"].as_str().unwrap_or("");
            if !is_node_device(d) && present.contains(d) {
                plan.get_mut(h).unwrap().push(json!({ "device": d, "concurrency": lane["concurrency"] }));
            }
        }
    }
    let mut nodes: IndexMap<String, Vec<&Value>> = IndexMap::new();
    for d in devices {
        let Some(id) = d.get("id").and_then(Value::as_str) else { continue };
        if !is_node_device(id) || !present.contains(id) {
            continue;
        }
        nodes.entry(node_key_of(id).unwrap_or(id).to_string()).or_default().push(d);
    }
    let lanes_on = |root: &str, key: &str, group: &[&Value]| -> Vec<Value> {
        let mut out: Vec<Value> = vec![];
        for lane in lanes_of(root) {
            let ld = lane["device"].as_str().unwrap_or("");
            if node_key_of(ld) != Some(key) {
                continue;
            }
            let mut id = ld.to_string();
            if !group.iter().any(|d| d["id"] == id.as_str()) {
                if id != key {
                    continue;
                }
                match group.iter().find(|d| d["isDefault"] == true).and_then(|d| d["id"].as_str()) {
                    Some(x) => id = x.to_string(),
                    None => continue,
                }
            }
            if !out.iter().any(|e| e["device"] == id.as_str()) {
                out.push(json!({ "device": id, "concurrency": lane["concurrency"] }));
            }
        }
        out
    };
    for (key, group) in &nodes {
        let allows = |root: &str| !by_root.get(root).and_then(|c| c["nodesOff"].as_array()).is_some_and(|a| a.iter().any(|x| x == key.as_str()));
        let listed = priorities.get(key).and_then(Value::as_array).and_then(|a| a.iter().filter_map(Value::as_str).find(|r| plan.contains_key(*r) && allows(r)).map(str::to_string));
        let helps = listed
            .or_else(|| local_holder.filter(|h| plan.contains_key(*h) && allows(h) && !lanes_on(h, key, group).is_empty()).map(str::to_string))
            .or_else(|| plan.keys().find(|r| !lanes_on(r, key, group).is_empty() && allows(r)).cloned());
        let Some(helps) = helps else { continue };
        let mut lanes = lanes_on(&helps, key, group);
        if lanes.is_empty() {
            let d = group.iter().find(|d| d["isDefault"] == true).copied().unwrap_or(group[0]);
            let slots = d["slots"].as_i64().filter(|s| *s > 0).map(|s| s.min(8)).unwrap_or(1);
            lanes = vec![json!({ "device": d["id"], "concurrency": slots })];
        }
        plan.get_mut(&helps).unwrap().extend(lanes);
    }
    plan
}

/// What automatic conversion asks the job service.
pub trait AutoService: Send + Sync {
    fn start(&self, config: &Value) -> SResult<String>;
    fn get(&self, id: &str) -> SResult<Value>;
    fn list(&self) -> SResult<Vec<Value>>;
    fn list_summaries(&self) -> SResult<Vec<Value>> {
        self.list()
    }
    fn live_jobs(&self) -> Option<Vec<Value>> {
        None
    }
    fn pause(&self, id: &str) -> SResult<Value>;
    fn resume(&self, id: &str) -> SResult<Value>;
    fn set_lanes(&self, id: &str, lanes: &Value) -> SResult<Value>;
}

impl AutoService for super::service::Service {
    fn start(&self, c: &Value) -> SResult<String> {
        super::service::Service::start(self, c)
    }
    fn get(&self, id: &str) -> SResult<Value> {
        super::service::Service::get(self, id)
    }
    fn list(&self) -> SResult<Vec<Value>> {
        super::service::Service::list(self)
    }
    fn list_summaries(&self) -> SResult<Vec<Value>> {
        super::service::Service::list_summaries(self)
    }
    fn live_jobs(&self) -> Option<Vec<Value>> {
        Some(super::service::Service::live_jobs(self))
    }
    fn pause(&self, id: &str) -> SResult<Value> {
        super::service::Service::pause(self, id)
    }
    fn resume(&self, id: &str) -> SResult<Value> {
        super::service::Service::resume(self, id)
    }
    fn set_lanes(&self, id: &str, l: &Value) -> SResult<Value> {
        super::service::Service::set_lanes(self, id, l)
    }
}

/// scanner(config, { signal }): each discovered clip to `out` (false stops); an error code
pub type Scanner = dyn Fn(&Value, &AtomicBool, &mut dyn FnMut(Value) -> bool) -> Result<(), String> + Send + Sync;

/// The real scanner (scanner.rs) as automatic conversion uses it.
pub fn real_scanner() -> Arc<Scanner> {
    Arc::new(|config: &Value, cancel: &AtomicBool, out: &mut dyn FnMut(Value) -> bool| {
        super::scanner::scan(config, Some(cancel), None, &mut |d| out(d.value)).map_err(|e| if e.code.is_empty() { "AUTO_CHECK_FAILED".to_string() } else { e.code })
    })
}

pub struct AutoOptions {
    pub service: Arc<dyn AutoService>,
    pub scanner: Arc<Scanner>,
    pub directory: PathBuf,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub hour_of: Arc<dyn Fn(i64) -> i64 + Send + Sync>,
    pub is_busy: Arc<dyn Fn() -> bool + Send + Sync>,
    pub tick_ms: u64,
    /// false: no ticks of its own (tests call tick; configure ticks before it answers)
    pub timer: bool,
    pub on_change: Option<Arc<dyn Fn(&Value) + Send + Sync>>,
    /// true while the cheapest electricity rate is in force, None without a plan
    pub is_cheap_now: Option<Arc<dyn Fn(i64) -> Option<bool> + Send + Sync>>,
    pub hold_discovered: Option<Arc<dyn Fn(&Value, &Value) -> bool + Send + Sync>>,
    /// the devices automatic jobs are given; Err: could not be listed
    pub devices: Option<Arc<dyn Fn() -> Result<Vec<Value>, String> + Send + Sync>>,
    /// which vehicles each helper server takes first ({ 'node:<id>': [sourceRoot] })
    pub node_priorities: Option<Arc<dyn Fn() -> Value + Send + Sync>>,
    pub folder_check: Option<Arc<dyn Fn(&Value)->super::folder_access::Report + Send + Sync>>,
}

impl AutoOptions {
    pub fn new(service: Arc<dyn AutoService>, scanner: Arc<Scanner>, directory: PathBuf) -> AutoOptions {
        AutoOptions {
            service,
            scanner,
            directory,
            now: Arc::new(|| super::jobstore::now_ms() as i64),
            hour_of: Arc::new(|ms| {
                use chrono::{Local, TimeZone, Timelike};
                Local.timestamp_millis_opt(ms).single().map(|t| t.hour() as i64).unwrap_or(0)
            }),
            is_busy: Arc::new(|| false),
            tick_ms: 30_000,
            timer: true,
            on_change: None,
            is_cheap_now: None,
            hold_discovered: None,
            devices: None,
            node_priorities: None,
            folder_check: None,
        }
    }
}

#[derive(Default, Clone)]
struct Index {
    files: IndexMap<String, Value>,
    gave_up: IndexMap<String, Value>,
    failures: IndexMap<String, Value>,
    dirty: bool,
}

struct Inner {
    settings: Value,
    saved: Vec<Value>,
    status: Value,
    indexes: std::collections::HashMap<String, Index>,
    timer: Option<Arc<AtomicBool>>,
    /// A calendar schedule's check times as saved in state.json: [lastCheckAt, nextCheckAt].
    /// While a round is under way the saved nextCheckAt is a time already passed, so a
    /// restart before every vehicle has its job checks again at once.
    calendar: [Value; 2],
    /// A calendar round (or a job's next part) is still under way: some vehicle waits for
    /// its job, or a job is still running and may have a next part
    round_open: bool,
    /// When the scheduled or asked-for check now under way began
    round_at: Option<i64>,
    /// Catch-up failures: [next retry at, the wait after the last failure].
    catch_up_retry: std::collections::HashMap<String, [i64; 2]>,
}

pub struct Auto {
    o: AutoOptions,
    st: Mutex<Inner>,
    ticking: Mutex<()>,
    sweep_abort: Mutex<Option<Arc<AtomicBool>>>,
    speed_backend: Mutex<Option<Arc<dyn speed::Backend>>>,
    speed_write: Mutex<()>,
    settings_edit: Mutex<()>,
}

fn num_eq(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

fn code_of(e: &super::service::Fail) -> String {
    e.code.clone().unwrap_or_else(|| "AUTO_CHECK_FAILED".into())
}

impl Auto {
    pub fn new(o: AutoOptions) -> Arc<Auto> {
        let status = json!({
            "lastCheckAt": null, "nextCheckAt": null, "lastNewFiles": null, "lastJobId": null,
            "activeJobId": null, "pausedForWindow": false, "checking": false, "error": null,
            "activeSource": null, "round": [], "sources": {}, "pending": {}, "active": {},
            "heldManual": [], "handledManual": []
        });
        Arc::new(Auto { o, st: Mutex::new(Inner { settings: default_settings(), saved: vec![], status, indexes: Default::default(), timer: None, calendar: [Value::Null, Value::Null], round_open: false, round_at: None, catch_up_retry: Default::default() }), ticking: Mutex::new(()), sweep_abort: Mutex::new(None), speed_backend: Mutex::new(None), speed_write: Mutex::new(()), settings_edit: Mutex::new(()) })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.st.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn write_json(&self, name: &str, value: &Value) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.o.directory)?;
        let target = self.o.directory.join(name);
        let tmp = self.o.directory.join(format!("{name}.tmp"));
        std::fs::write(&tmp, value.to_string())?;
        std::fs::rename(&tmp, &target)
    }

    fn read_json(&self, name: &str) -> Option<Value> {
        serde_json::from_str(&std::fs::read_to_string(self.o.directory.join(name)).ok()?).ok()
    }

    fn load_index(&self, config: &Value) {
        let key = setup_key(config);
        if self.lock().indexes.contains_key(&key) {
            return;
        }
        let mut stored = self.read_json(&format!("index-{key}.json"));
        let fresh = stored.as_ref().is_some_and(|s| s.get("v").and_then(Value::as_f64) != Some(INDEX_VERSION as f64));
        if fresh {
            stored = None;
        }
        let mut ix = Index { dirty: fresh, ..Default::default() };
        if let Some(s) = &stored {
            for (k, e) in s.get("files").and_then(Value::as_object).into_iter().flatten() {
                if e.as_array().is_some_and(|a| a.len() == 2) {
                    ix.files.insert(k.clone(), e.clone());
                }
            }
            for (k, e) in s.get("gaveUp").and_then(Value::as_object).into_iter().flatten() {
                if e.as_array().is_some_and(|a| a.len() == 3 || a.len() == 4) {
                    ix.gave_up.insert(k.clone(), e.clone());
                }
            }
            for (k, c) in s.get("failures").and_then(Value::as_object).into_iter().flatten() {
                if super::jobstore::normalize::safe_int_of(c).is_some() {
                    ix.failures.insert(k.clone(), c.clone());
                }
            }
        }
        self.lock().indexes.entry(key).or_insert(ix);
    }

    fn save_index(&self, key: &str) {
        let body = {
            let mut s = self.lock();
            let Some(ix) = s.indexes.get_mut(key).filter(|i| i.dirty) else { return };
            ix.dirty = false;
            json!({ "v": INDEX_VERSION, "files": Value::Object(ix.files.clone().into_iter().collect()), "gaveUp": Value::Object(ix.gave_up.clone().into_iter().collect()), "failures": Value::Object(ix.failures.clone().into_iter().collect()) })
        };
        if self.write_json(&format!("index-{key}.json"), &body).is_err() {
            if let Some(ix) = self.lock().indexes.get_mut(key) {
                ix.dirty = true;
            }
        }
    }

    fn remember(ix: &mut Index, rel: &str, size: Value, mtime: Value) {
        ix.files.insert(rel.into(), json!([size, mtime]));
        ix.gave_up.shift_remove(rel);
        ix.failures.shift_remove(rel);
        ix.dirty = true;
    }

    fn give_up(ix: &mut Index, rel: &str, size: Value, mtime: Value, why: Option<&str>) {
        let e = match why {
            Some(w) => json!([size, mtime, CONVERTER_REVISION, w]),
            None => json!([size, mtime, CONVERTER_REVISION]),
        };
        ix.gave_up.insert(rel.into(), e);
        ix.files.shift_remove(rel);
        ix.failures.shift_remove(rel);
        ix.dirty = true;
    }

    fn known_in(ix: &Index, d: &Value, config: Option<&Value>) -> bool {
        let rel = d["relativePath"].as_str().unwrap_or("");
        if let Some(e) = ix.files.get(rel) {
            return num_eq(&e[0], &d["sourceBytes"]) && num_eq(&e[1], &d["mtimeMs"]);
        }
        let Some(g) = ix.gave_up.get(rel) else { return false };
        if g.get(3) == Some(&json!("no-savings")) && config.is_some_and(|c| c.get("keepLarger") == Some(&json!(true))) {
            return false;
        }
        num_eq(&g[0], &d["sourceBytes"]) && num_eq(&g[1], &d["mtimeMs"]) && g[2].as_f64() == Some(CONVERTER_REVISION as f64)
    }

    /// isKnown(config, discovered): used by the job service while an automatic job discovers files
    pub fn is_known(&self, config: &Value, d: &Value) -> bool {
        if config.get("autoConvert") != Some(&json!(true)) {
            return false;
        }
        let s = self.lock();
        // A catch-up job can outlive several setup edits. Its unstarted clips
        // must respect the vehicle's current keep window and included groups.
        let current = Self::config_for(&s, config["sourceRoot"].as_str().unwrap_or(""));
        let eligibility = current.as_ref().unwrap_or(config);
        if super::keep_recent::is_young(eligibility, d, (self.o.now)())
            || d["group"].as_str().is_some_and(|group| eligibility["includedGroups"].as_array().is_some_and(|groups| !groups.iter().any(|g| g == group))) {
            return true;
        }
        s.indexes.get(&setup_key(config)).is_some_and(|ix| Self::known_in(ix, d, Some(config)))
    }

    fn destination_exists(config: &Value, d: &Value) -> bool {
        if config["outputMode"] != "separate" || !super::jobstore::normalize::truthy(&config["destinationRoot"]) {
            return false;
        }
        let mut p = super::owned::resolve(Path::new(config["destinationRoot"].as_str().unwrap_or("")));
        for part in d["relativePath"].as_str().unwrap_or("").split('/') {
            p.push(part);
        }
        std::fs::metadata(super::owned::resolve(&p)).is_ok_and(|m| m.is_file() && m.len() > 0)
    }

    fn sweep(&self, config: &Value) -> Result<i64, String> {
        self.load_index(config);
        let key = setup_key(config);
        let abort = Arc::new(AtomicBool::new(false));
        *self.sweep_abort.lock().unwrap() = Some(abort.clone());
        let mut new_files = 0;
        let r = (self.o.scanner)(config, &abort, &mut |d: Value| {
            if super::keep_recent::is_young(config, &d, (self.o.now)()) {
                return true;
            }
            let known = self.lock().indexes.get(&key).is_some_and(|ix| Self::known_in(ix, &d, Some(config)));
            if known {
                return true;
            }
            if self.o.hold_discovered.as_ref().is_some_and(|h| h(config, &d)) {
                return true;
            }
            if Self::destination_exists(config, &d) {
                if let Some(ix) = self.lock().indexes.get_mut(&key) {
                    Self::remember(ix, d["relativePath"].as_str().unwrap_or(""), d["sourceBytes"].clone(), d["mtimeMs"].clone());
                }
                return true;
            }
            new_files += 1;
            // A check only needs enough work for the next manifest. The job's
            // discovery and moreAfter handle subsequent batches.
            new_files < super::service::DEFAULT_JOB_CLIP_LIMIT as i64
        });
        {
            let mut a = self.sweep_abort.lock().unwrap();
            if a.as_ref().is_some_and(|x| Arc::ptr_eq(x, &abort)) {
                *a = None;
            }
        }
        r?;
        self.save_index(&key);
        Ok(new_files)
    }

    fn record_finished_job(&self, job: &Value) {
        let config = &job["config"];
        self.load_index(config);
        let key = setup_key(config);
        let replace = config["outputMode"] == "replace";
        for item in job["items"].as_array().into_iter().flatten() {
            let rel = item["relativePath"].as_str().unwrap_or("").to_string();
            let (state, code) = (item["state"].as_str().unwrap_or(""), item["resultCode"].as_str().unwrap_or(""));
            // Deferred eligibility is temporary, not a handled or failed clip.
            if (state == "skipped" && ["auto-deferred", "folder-not-writable"].contains(&code)) || code == "publication-artifact-changed" {
                continue;
            }
            // (the stat outside the lock)
            let stat = if replace && state == "completed" {
                Some(item["sourcePath"].as_str().and_then(|p| std::fs::metadata(p).ok()))
            } else {
                None
            };
            let mut s = self.lock();
            let Some(ix) = s.indexes.get_mut(&key) else { continue };
            if state == "skipped" && code == "no-savings" {
                Self::give_up(ix, &rel, item["sourceBytes"].clone(), item["mtimeMs"].clone(), Some("no-savings"));
            } else if state == "completed" || state == "skipped" {
                match stat {
                    Some(Some(m)) => Self::remember(ix, &rel, json!(m.len()), super::jobstore::normalize::num(super::jobstore::mtime_ms(&m))),
                    Some(None) => {}
                    None => Self::remember(ix, &rel, item["sourceBytes"].clone(), item["mtimeMs"].clone()),
                }
            } else if state == "failed" {
                let count = ix.failures.get(&rel).and_then(Value::as_i64).unwrap_or(0) + 1;
                if count >= MAX_FAILED_SWEEPS {
                    Self::give_up(ix, &rel, item["sourceBytes"].clone(), item["mtimeMs"].clone(), None);
                } else {
                    ix.failures.insert(rel.clone(), json!(count));
                    ix.dirty = true;
                }
            }
        }
        self.save_index(&key);
    }

    fn state_of(s: &Inner) -> Value {
        let mut settings = s.settings.clone();
        for c in settings["configs"].as_array_mut().into_iter().flatten() { Self::with_speed_source(s, c); }
        let mut saved = s.saved.clone();
        for c in &mut saved { Self::with_speed_source(s, c); }
        json!({ "settings": settings, "status": s.status, "saved": saved })
    }

    /// getState()
    pub fn get_state(&self) -> Value {
        Self::state_of(&self.lock())
    }

    fn changed(&self) {
        let state = {
            let mut s = self.lock();
            let first = s.status["active"].as_object().and_then(|m| m.iter().next().map(|(k, v)| (k.clone(), v["jobId"].clone())));
            s.status["activeJobId"] = first.as_ref().map(|f| f.1.clone()).unwrap_or(Value::Null);
            if s.status["checking"] != true {
                s.status["activeSource"] = first.map(|f| json!(f.0)).unwrap_or(Value::Null);
            }
            let paused = s.status["active"].as_object().is_some_and(|m| m.values().any(|e| e["pausedForWindow"] == true));
            s.status["pausedForWindow"] = json!(paused);
            Self::state_of(&s)
        };
        if let Some(f) = &self.o.on_change {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&state)));
        }
    }

    fn save_state(&self) {
        let body = {
            let s = self.lock();
            let active = s.status["active"].as_object().cloned().unwrap_or_default();
            let pick = |k: &str| active.values().filter(|e| e[k] == true).map(|e| e["jobId"].clone()).collect::<Vec<_>>();
            let mut body = json!({ "pausedForWindowJobIds": pick("pausedForWindow"), "pausedForDevicesJobIds": pick("pausedForDevices"), "heldManual": s.status["heldManual"], "handledManual": s.status["handledManual"] });
            // (Node's file has no check times: only a calendar schedule adds them)
            if let Some(cal) = calendar_of(&s.settings) {
                body["lastCheckAt"] = s.calendar[0].clone();
                body["nextCheckAt"] = s.calendar[1].clone();
                // (the times belong to this schedule: a later one ignores them)
                body["schedule"] = cal;
            }
            // (only while some vehicle is catching up, so Node's file stays as it was)
            if let Some(c) = s.status.get("catchUp") {
                body["catchUp"] = c.clone();
            }
            body
        };
        let _ = self.write_json(STATE_FILE, &body);
    }

    /// The vehicles in their catch-up run: status `catchUp`, `{ "<sourceRoot>": { "since": ms } }`,
    /// present only while one is.
    fn catching(s: &Inner) -> Vec<String> {
        s.status.get("catchUp").and_then(Value::as_object).map(|m| m.keys().cloned().collect()).unwrap_or_default()
    }

    fn start_catch_up(s: &mut Inner, root: &str, now: i64) {
        if s.status.get("catchUp").is_none() {
            s.status["catchUp"] = json!({});
        }
        // (a run already going keeps its start: more eligible footage makes it longer)
        if s.status["catchUp"].get(root).is_none() {
            s.status["catchUp"][root] = json!({ "since": now });
        }
    }

    fn in_catch_up(s: &Inner, root: &str) -> bool {
        s.status.get("catchUp").and_then(|m| m.get(root)).is_some()
    }

    /// Ends `root`'s catch-up run; true when it had one.
    fn end_catch_up(s: &mut Inner, root: &str) -> bool {
        s.catch_up_retry.remove(root);
        let Some(m) = s.status.get_mut("catchUp").and_then(Value::as_object_mut) else { return false };
        let had = m.shift_remove(root).is_some();
        if m.is_empty() {
            s.status.as_object_mut().unwrap().shift_remove("catchUp");
        }
        had
    }

    /// Queues each vehicle catching up that has no job, for a check now.
    fn queue_catch_up(s: &mut Inner) {
        for root in Self::catching(s) {
            if s.status["active"].get(&root).is_none() && !s.status["round"].as_array().unwrap().iter().any(|r| r == root.as_str()) {
                s.status["round"].as_array_mut().unwrap().push(json!(root));
            }
        }
    }

    fn resume_job(&self, id: &str) -> Result<(), String> {
        match self.o.service.resume(id) {
            Ok(_) => Ok(()),
            Err(e) if e.is("JOB_NOT_PAUSED") => Ok(()),
            Err(e) => Err(code_of(&e)),
        }
    }

    fn follow_active_jobs(&self, inside: bool) -> Result<(), String> {
        let (entries, catching) = {
            let s = self.lock();
            (s.status["active"].as_object().cloned().unwrap_or_default().into_iter().collect::<Vec<(String, Value)>>(), Self::catching(&s))
        };
        for (root, entry) in entries {
            let id = entry["jobId"].as_str().unwrap_or("").to_string();
            let job = self.o.service.get(&id).ok().filter(|j| !j.is_null());
            if job.as_ref().map_or(true, |j| terminal(&j["state"])) {
                if let Some(j) = &job {
                    self.record_finished_job(j);
                }
                {
                    let mut s = self.lock();
                    s.status["active"].as_object_mut().unwrap().shift_remove(&root);
                    let more = job.as_ref().is_some_and(|j| j["state"] == "completed" && super::jobstore::normalize::truthy(&j["moreAfter"]));
                    // A catch-up run ends once its job is done with nothing left after it, or
                    // the user cancelled it. A failed job's run is retried (`retry_stranded`).
                    // A job started before the vehicle's settings made more footage eligible
                    // proves nothing about that footage: the vehicle is checked again instead.
                    let state = job.as_ref().map(|j| j["state"].clone()).unwrap_or(Value::Null);
                    let stale = Self::in_catch_up(&s, &root) && job.as_ref().zip(Self::config_for(&s, &root)).is_some_and(|(j, c)| more_eligible(Some(&j["config"]), &c));
                    if state == "completed" {
                        s.catch_up_retry.remove(&root);
                    }
                    if (state == "completed" && !more && !stale) || state == "cancelled" {
                        Self::end_catch_up(&mut s, &root);
                    } else if state != "completed" {
                        self.defer_catch_up(&mut s, &root);
                    }
                    let more = more || (state == "completed" && stale);
                    if more && s.settings["enabled"] == true && !s.status["round"].as_array().unwrap().iter().any(|r| r == root.as_str()) {
                        s.status["round"].as_array_mut().unwrap().push(json!(root));
                        // (a restart before the next part starts checks again, not at the next scheduled time)
                        if calendar_of(&s.settings).is_some() {
                            let now = (self.o.now)();
                            Self::open_round(&mut s, now);
                        }
                    }
                }
                self.save_state();
                self.changed();
                continue;
            }
            let job = job.unwrap();
            if self.lock().settings["enabled"] != true {
                continue;
            }
            let inside = inside || catching.contains(&root);
            if job["state"]=="paused" && job.get("permissionBlock").is_some_and(|v|!v.is_null()) {
                if !inside || entry["pausedForDevices"] == true {continue;}
                match self.o.service.resume(&id) {
                    Ok(_)=>Self::note_source(&mut self.lock(),&root,json!({"blocked":false,"folderAccess":null,"error":null})),
                    Err(e) if e.is("FOLDERS_NOT_WRITABLE") || e.is("JOB_ACTIVE") || e.is("SPEED_TEST_RUNNING")=>{},
                    Err(e)=>return Err(code_of(&e)),
                }
                continue;
            }
            let paused_window = entry["pausedForWindow"] == true;
            // (a catch-up run ignores the window; a job the user paused stays paused either way)
            if !inside && !paused_window && job["state"] != "paused" {
                self.o.service.pause(job["id"].as_str().unwrap_or("")).map_err(|e| code_of(&e))?;
                self.set_entry(&root, "pausedForWindow", true);
                self.save_state();
                self.changed();
            } else if inside && paused_window {
                if entry["pausedForDevices"] != true {
                    match self.resume_job(&id) {
                        Ok(()) => {},
                        Err(e) if e == "JOB_ACTIVE" => continue,
                        Err(e) => return Err(e),
                    }
                }
                self.set_entry(&root, "pausedForWindow", false);
                self.save_state();
                self.changed();
            }
        }
        Ok(())
    }

    fn set_entry(&self, root: &str, k: &str, v: impl Into<Value>) {
        let mut s = self.lock();
        if let Some(e) = s.status["active"].get_mut(root) {
            e[k] = v.into();
        }
    }

    fn inside_window_at(&self, t: i64) -> bool {
        let w = self.lock().settings["window"].clone();
        if w.get("follow") == Some(&json!("off-peak")) {
            let cheap = self.o.is_cheap_now.as_ref().and_then(|f| std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(t))).ok().flatten());
            return cheap != Some(false);
        }
        in_window(&w, (self.o.hour_of)(t))
    }

    fn hold_manual_jobs(&self, inside: bool) {
        let (active, held, handled) = {
            let s = self.lock();
            (!s.settings["window"].is_null() && s.settings["holdManual"] == true, s.status["heldManual"].clone(), s.status["handledManual"].clone())
        };
        let ids = |v: &Value| v.as_array().cloned().unwrap_or_default().into_iter().filter_map(|x| x.as_str().map(str::to_string)).collect::<Vec<_>>();
        let (held, handled) = (ids(&held), ids(&handled));
        if inside || !active {
            if held.is_empty() && handled.is_empty() {
                return;
            }
            let still_held: Vec<_> = held.into_iter().filter(|id| self.resume_job(id).is_err()).collect();
            {
                let mut s = self.lock();
                s.status["heldManual"] = json!(still_held);
                s.status["handledManual"] = json!([]);
            }
            self.save_state();
            self.changed();
            return;
        }
        let jobs = match self.o.service.live_jobs() {
            Some(j) => j,
            None => match self.o.service.list() {
                Ok(j) => j,
                Err(_) => return,
            },
        };
        let mut changed = false;
        let running: Vec<String> = jobs.iter().filter(|j| j["state"] != "paused" && !terminal(&j["state"])).filter_map(|j| j["id"].as_str().map(str::to_string)).collect();
        let mut held: Vec<String> = held;
        let still: Vec<String> = held.iter().filter(|id| !running.contains(id)).cloned().collect();
        if still.len() != held.len() {
            held = still;
            changed = true;
        }
        let mut handled = handled;
        for job in &jobs {
            let automatic = job["autoConvert"] == true || job["config"]["autoConvert"] == true;
            let st = job["state"].as_str().unwrap_or("");
            if automatic || terminal(&job["state"]) || st == "paused" || st == "paused_network" {
                continue;
            }
            let id = job["id"].as_str().unwrap_or("").to_string();
            if handled.contains(&id) {
                continue;
            }
            if self.o.service.pause(&id).is_ok() {
                held.push(id.clone());
                handled.push(id);
                changed = true;
            }
        }
        if changed {
            {
                let mut s = self.lock();
                s.status["heldManual"] = json!(held);
                s.status["handledManual"] = json!(handled);
            }
            self.save_state();
            self.changed();
        }
    }

    fn config_for(s: &Inner, root: &str) -> Option<Value> {
        s.settings["configs"].as_array().and_then(|a| a.iter().find(|c| c["sourceRoot"] == root).cloned())
    }

    /// the folder whose automatic job is running (or the only one)
    fn active_config(s: &Inner, root: Option<&str>) -> Option<Value> {
        let root = root.map(str::to_string).or_else(|| s.status["activeSource"].as_str().map(str::to_string));
        if let Some(c) = root.and_then(|r| Self::config_for(s, &r)) {
            return Some(c);
        }
        let configs = s.settings["configs"].as_array()?;
        if configs.len() == 1 {
            Some(configs[0].clone())
        } else {
            None
        }
    }

    fn uses_own_devices(lanes: &Value) -> bool {
        lanes.as_array().is_some_and(|a| a.iter().any(|l| !l["device"].as_str().is_some_and(is_node_device)))
    }

    /// nodesOffFor(lanes): None when the devices could not be listed
    fn nodes_off_for(&self, lanes: &Value) -> Option<Vec<String>> {
        let Some(l) = lanes.as_array() else { return Some(vec![]) };
        let devices = match &self.o.devices {
            None => return None,
            Some(f) => match f() {
                Ok(d) => d,
                Err(_) => return None,
            },
        };
        if devices.is_empty() {
            return None;
        }
        let used: Vec<String> = l.iter().filter_map(|x| x["device"].as_str().and_then(node_key_of).map(str::to_string)).collect();
        let mut out: Vec<String> = vec![];
        for d in &devices {
            let Some(id) = d["id"].as_str().filter(|i| is_node_device(i)) else { continue };
            let Some(k) = node_key_of(id) else { continue };
            if !used.iter().any(|u| u == k) && !out.iter().any(|o| o == k) {
                out.push(k.to_string());
            }
        }
        Some(out)
    }

    fn note_source(s: &mut Inner, root: &str, fields: Value) {
        let mut cur = s.status["sources"].get(root).cloned().unwrap_or(json!({}));
        if fields.get("error") == Some(&Value::Null) { cur.as_object_mut().unwrap().shift_remove("errorDetail"); }
        for (k, v) in fields.as_object().unwrap() {
            cur[k] = v.clone();
        }
        s.status["sources"][root] = cur;
    }

    /// Checks the vehicles in the round, in order; with `only`, just those (the rest stay queued).
    fn sweep_round(&self, only: Option<&[String]>) {
        {
            let mut s = self.lock();
            s.status["checking"] = json!(true);
            s.status["error"] = Value::Null;
        }
        self.changed();
        loop {
            let next = {
                let mut s = self.lock();
                let at = s.status["round"].as_array().unwrap().iter().position(|r| only.is_none_or(|o| o.iter().any(|x| r == x.as_str())));
                match at {
                    Some(i) if s.settings["enabled"] == true => {
                        let r = s.status["round"].as_array_mut().unwrap().remove(i);
                        Some(r.as_str().unwrap_or("").to_string())
                    }
                    _ => None,
                }
            };
            let Some(root) = next else { break };
            let config = {
                let s = self.lock();
                let c = Self::config_for(&s, &root);
                if c.is_none() || s.status["active"].get(&root).is_some() {
                    continue;
                }
                c.unwrap()
            };
            if let Some(check)=&self.o.folder_check {
                let report=check(&config);
                Self::note_source(&mut self.lock(),&root,json!({"folderAccess":report,"blocked":report.blocked(),"error":null}));
                if report.blocked() {
                    let mut s=self.lock();s.status["pending"].as_object_mut().unwrap().shift_remove(&root);
                    self.defer_catch_up(&mut s,&root);continue;
                }
            }
            self.lock().status["activeSource"] = json!(root);
            self.changed();
            let (new_files, error) = match self.sweep(&config) {
                Ok(n) => (Some(n), None),
                Err(e) => (None, Some(e)),
            };
            let now = (self.o.now)();
            let mut s = self.lock();
            s.status["lastCheckAt"] = json!(now);
            s.status["lastNewFiles"] = json!(new_files);
            if let Some(e) = &error {
                s.status["error"] = json!(e);
            }
            Self::note_source(&mut s, &root, json!({ "lastCheckAt": now, "lastNewFiles": new_files, "error": error }));
            if error.is_some() {
                self.defer_catch_up(&mut s, &root);
            }
            if new_files.unwrap_or(0) > 0 {
                s.status["pending"][&root] = json!(new_files);
            } else {
                s.status["pending"].as_object_mut().unwrap().shift_remove(&root);
            }
            // nothing eligible left: a catch-up run is over (a check that failed tries again later)
            let ended = new_files == Some(0) && Self::end_catch_up(&mut s, &root);
            drop(s);
            if ended {
                self.save_state();
            }
        }
        self.lock().status["checking"] = json!(false);
        self.changed();
    }

    fn start_job(&self, root: &str, config: &Value) -> bool {
        let mut job_config = config.as_object().cloned().unwrap_or_default();
        job_config.shift_remove("nodesOff");
        job_config.shift_remove("deviceSettingsSource");
        job_config.insert("autoConvert".into(), json!(true));
        match self.o.service.start(&Value::Object(job_config)) {
            Ok(id) => {
                {
                    let mut s = self.lock();
                    s.status["active"][root] = json!({ "jobId": id, "lanes": config.get("lanes").cloned().unwrap_or(Value::Null), "pausedForWindow": false, "pausedForDevices": false });
                    s.status["lastJobId"] = json!(id);
                    s.status["pending"].as_object_mut().unwrap().shift_remove(root);
                }
                self.changed();
                true
            }
            Err(e) if e.is("FOLDERS_NOT_WRITABLE") => {
                let report=super::folder_access::cached(config);
                let mut s=self.lock();Self::note_source(&mut s,root,json!({"blocked":true,"folderAccess":report,"error":null}));
                s.status["pending"].as_object_mut().unwrap().shift_remove(root);self.defer_catch_up(&mut s,root);false
            }
            Err(e) if e.is("JOB_ACTIVE") => false,
            Err(e) => {
                let detail = e.detail.as_deref().unwrap_or("reason not recorded").to_string();
                super::service::log_line(format!("[CONVERTER] Automatic source {root:?} job creation refused: {}: {detail}", code_of(&e)));
                {
                    let mut s = self.lock();
                    let code = code_of(&e);
                    s.status["error"] = json!(code);
                    Self::note_source(&mut s, root, json!({ "error": code, "errorDetail": detail }));
                    s.status["pending"].as_object_mut().unwrap().shift_remove(root);
                    self.defer_catch_up(&mut s, root);
                }
                self.changed();
                false
            }
        }
    }

    /// Starts jobs for the vehicles with clips waiting; with `only`, just those.
    fn allocate(&self, only: Option<&[String]>) -> Result<(), String> {
        let (active_roots, waiting, configs) = {
            let s = self.lock();
            let active: Vec<String> = s.status["active"].as_object().unwrap().keys().cloned().collect();
            if active.iter().any(|r| !s.status["active"][r]["lanes"].is_array()) {
                return Ok(());
            }
            let configs = s.settings["configs"].as_array().cloned().unwrap_or_default();
            let waiting: Vec<String> = configs
                .iter()
                .filter_map(|c| c["sourceRoot"].as_str().map(str::to_string))
                .filter(|r| s.status["pending"][r].as_f64().unwrap_or(0.0) > 0.0 && s.status["active"].get(r).is_none() && only.is_none_or(|o| o.contains(r)))
                .collect();
            (active, waiting, configs)
        };
        if active_roots.is_empty() && waiting.is_empty() {
            return Ok(());
        }
        if active_roots.is_empty() {
            let first = Self::config_for(&self.lock(), &waiting[0]).unwrap();
            if !first["lanes"].is_array() {
                self.start_job(&waiting[0], &first);
                return Ok(());
            }
        }
        let devices = self.o.devices.as_ref().and_then(|f| f().ok()).unwrap_or_default();
        let priorities = self.o.node_priorities.as_ref().map(|f| f()).filter(Value::is_object).unwrap_or(json!({}));
        let local = {
            let mut s = self.lock();
            let mut holder = active_roots.iter().find(|r| Self::uses_own_devices(&s.status["active"][r.as_str()]["lanes"])).cloned();
            if holder.is_none() {
                let order: Vec<String> = configs.iter().filter_map(|c| c["sourceRoot"].as_str().map(str::to_string)).collect();
                let last = s.status["lastLocal"].as_str().and_then(|l| order.iter().position(|o| o == l)).map(|i| i as i64).unwrap_or(-1);
                let candidates: Vec<String> = waiting.iter().filter(|r| Self::config_for(&s, r).is_some_and(|c| Self::uses_own_devices(&c["lanes"]))).cloned().collect();
                holder = candidates.iter().find(|r| order.iter().position(|o| o == *r).map(|i| i as i64).unwrap_or(-1) > last).cloned().or_else(|| candidates.first().cloned());
            }
            if let Some(h) = &holder {
                s.status["lastLocal"] = json!(h);
            }
            holder
        };
        let wanting: Vec<String> = active_roots.iter().chain(waiting.iter()).cloned().collect();
        let plan = plan_lanes(&configs, &wanting, local.as_deref(), &devices, &priorities);
        for root in &active_roots {
            let entry = self.lock().status["active"][root.as_str()].clone();
            let id = entry["jobId"].as_str().unwrap_or("").to_string();
            let lanes = plan.get(root).cloned().unwrap_or_default();
            if lanes.is_empty() {
                // (a catch-up job the user paused stays theirs: a device hold would resume it
                // once the device came back, and its run would carry on unasked)
                let user_paused = || entry["pausedForWindow"] != true && Self::in_catch_up(&self.lock(), root) && self.o.service.get(&id).is_ok_and(|j| j["state"] == "paused");
                if entry["pausedForDevices"] != true && !user_paused() {
                    if self.o.service.pause(&id).is_ok() {
                        self.set_entry(root, "pausedForDevices", true);
                    }
                    self.save_state();
                    self.changed();
                }
                continue;
            }
            let lanes = Value::Array(lanes);
            if entry["lanes"].to_string() != lanes.to_string() {
                if self.o.service.set_lanes(&id, &lanes).is_ok() {
                    self.set_entry(root, "lanes", lanes.clone());
                }
                self.changed();
            }
            let entry = self.lock().status["active"][root.as_str()].clone();
            if entry["pausedForDevices"] == true {
                self.set_entry(root, "pausedForDevices", false);
                if entry["pausedForWindow"] != true {
                    let _ = self.resume_job(&id);
                }
                self.save_state();
                self.changed();
            }
        }
        for root in &waiting {
            let Some(lanes) = plan.get(root).filter(|l| !l.is_empty()) else { continue };
            let (enabled, config) = {
                let s = self.lock();
                (s.settings["enabled"] == true, Self::config_for(&s, root))
            };
            if !enabled {
                continue;
            }
            let mut c = config.unwrap_or(json!({}));
            let lanes = Value::Array(lanes.clone());
            c["concurrency"] = json!(lanes_total(&lanes));
            c["lanes"] = lanes;
            self.start_job(root, &c);
        }
        Ok(())
    }

    fn tick_once(&self) -> Result<(), String> {
        let speed_waiting = self.speed_tick();
        let time = (self.o.now)();
        let inside = self.inside_window_at(time);
        self.hold_manual_jobs(inside);
        self.follow_active_jobs(inside)?;
        if speed_waiting { return Ok(()); }
        if self.lock().settings["enabled"] != true {
            return Ok(());
        }
        self.retry_stranded(time);
        if !inside {
            return self.catch_up_outside();
        }
        if (self.o.is_busy)() {
            return Ok(());
        }
        let mut opened = false;
        let round_left = {
            let mut s = self.lock();
            let catching = Self::catching(&s);
            let known: Vec<String> = s.settings["configs"].as_array().cloned().unwrap_or_default().iter().filter_map(|c| c["sourceRoot"].as_str().map(str::to_string)).collect();
            let round: Vec<Value> = s.status["round"].as_array().unwrap().iter().filter(|r| r.as_str().is_some_and(|x| known.iter().any(|k| k == x))).cloned().collect();
            s.status["round"] = Value::Array(round);
            let stale: Vec<String> = s.status["pending"].as_object().unwrap().keys().filter(|r| !known.contains(r)).cloned().collect();
            for r in stale {
                s.status["pending"].as_object_mut().unwrap().shift_remove(&r);
            }
            let due = s.status["nextCheckAt"].as_i64().map_or(true, |n| time >= n);
            match calendar_of(&s.settings) {
                // a calendar check is due even while a job's next part waits in the round
                Some(cal) if due => {
                    let mut round = s.status["round"].as_array().cloned().unwrap_or_default();
                    for r in &known {
                        if !round.iter().any(|x| x == r.as_str()) {
                            round.push(json!(r));
                        }
                    }
                    s.status["round"] = Value::Array(round);
                    s.status["nextCheckAt"] = json!(super::schedule::next_after(&cal, time));
                    s.status["lastCheckAt"] = json!(time);
                    s.round_at = Some(time);
                    Self::open_round(&mut s, time);
                    opened = true;
                }
                Some(_) => {}
                // (vehicles queued for their catch-up run don't hold up a due check of the rest)
                None if s.status["round"].as_array().unwrap().iter().all(|r| catching.iter().any(|c| r == c.as_str())) && due => {
                    s.status["round"] = json!(known);
                    s.status["nextCheckAt"] = json!(time + s.settings["intervalMinutes"].as_i64().unwrap_or(60) * 60_000);
                }
                None => {}
            }
            !s.status["round"].as_array().unwrap().is_empty()
        };
        if opened {
            self.save_state();
        }
        if round_left {
            self.sweep_round(None);
        }
        {
            let mut s = self.lock();
            if s.status["nextCheckAt"].is_null() {
                let now = (self.o.now)();
                let n = match calendar_of(&s.settings) {
                    Some(cal) => super::schedule::next_after(&cal, now),
                    None => now + s.settings["intervalMinutes"].as_i64().unwrap_or(60) * 60_000,
                };
                s.status["nextCheckAt"] = json!(n);
            }
        }
        let allocated = self.allocate(None);
        self.note_round_done();
        allocated
    }

    /// Back off from the time a check, job or start fails, not from its dispatch: a long job
    /// may fail after the previous retry deadline. A completed batch or the run's end resets it.
    fn defer_catch_up(&self, s: &mut Inner, root: &str) {
        const FIRST: i64 = 15 * 60_000;
        const MOST: i64 = 6 * 60 * 60_000;
        if !Self::in_catch_up(s, root) {
            return;
        }
        let wait = s.catch_up_retry.get(root).map_or(FIRST, |[_, wait]| (*wait * 2).min(MOST));
        s.catch_up_retry.insert(root.to_string(), [(self.o.now)() + wait, wait]);
    }

    /// Retry failed catch-up work independently of the window or schedule. Active jobs
    /// (including user pauses), queued checks and pending starts already have work to follow.
    fn retry_stranded(&self, now: i64) {
        let mut s = self.lock();
        let catching = Self::catching(&s);
        s.catch_up_retry.retain(|r, _| catching.contains(r));
        for root in catching {
            let stranded = s.status["active"].get(&root).is_none()
                && !s.status["round"].as_array().unwrap().iter().any(|r| r == root.as_str())
                && s.status["pending"][&root].as_f64().unwrap_or(0.0) <= 0.0;
            if stranded && s.catch_up_retry.get(&root).is_some_and(|[at, _]| now >= *at) {
                s.status["round"].as_array_mut().unwrap().push(json!(root));
            }
        }
    }

    /// Outside the window only the vehicles in their catch-up run are checked and given jobs;
    /// the rest of the round waits for the window, and no scheduled check starts.
    fn catch_up_outside(&self) -> Result<(), String> {
        let catching = Self::catching(&self.lock());
        if catching.is_empty() || (self.o.is_busy)() {
            return Ok(());
        }
        let queued = self.lock().status["round"].as_array().unwrap().iter().any(|r| catching.iter().any(|c| r == c.as_str()));
        if queued {
            self.sweep_round(Some(&catching));
        }
        let allocated = self.allocate(Some(&catching));
        self.note_round_done();
        allocated
    }

    /// A calendar round has begun (a check, or a job's next part): until its jobs are done
    /// the saved nextCheckAt is `at`, already passed.
    fn under_way(s: &Inner) -> bool {
        ["round", "pending", "active"].iter().any(|k| s.status[*k].as_array().map_or_else(|| !s.status[*k].as_object().unwrap().is_empty(), |a| !a.is_empty()))
    }

    fn open_round(s: &mut Inner, at: i64) {
        s.round_open = true;
        s.calendar[1] = json!(at);
    }

    /// A calendar round is over once every vehicle it found clips for has had its jobs,
    /// next parts included: its check times are saved then. (A restart before that
    /// checks again at once; the index makes that cheap.)
    fn note_round_done(&self) {
        {
            let mut s = self.lock();
            let waiting = Self::under_way(&s);
            if !s.round_open || waiting || calendar_of(&s.settings).is_none() {
                return;
            }
            s.round_open = false;
            if let Some(at) = s.round_at.take() {
                s.calendar[0] = json!(at);
            }
            s.calendar[1] = s.status["nextCheckAt"].clone();
        }
        self.save_state();
    }

    /// tick(): one at a time; a caller while one runs waits for it
    pub fn tick(&self) {
        let guard = match self.ticking.try_lock() {
            Ok(g) => g,
            Err(_) => {
                let _wait = self.ticking.lock();
                return;
            }
        };
        if let Err(e) = self.tick_once() {
            self.lock().status["error"] = json!(e);
        }
        drop(guard);
    }

    fn tick_soon(self: &Arc<Self>) {
        // (without its own timer, as in tests: at once)
        if !self.o.timer {
            self.tick();
            return;
        }
        let me = self.clone();
        std::thread::spawn(move || me.tick());
    }

    fn write_saved(&self, list: Vec<Value>) {
        let next = {
            let s = self.lock();
            let automatic: Vec<String> = s.settings["configs"].as_array().cloned().unwrap_or_default().iter().filter_map(|c| c["sourceRoot"].as_str().map(str::to_string)).collect();
            let next: Vec<Value> = normalize_configs(&json!({ "configs": list })).into_iter().filter(|c| !automatic.iter().any(|a| c["sourceRoot"] == a.as_str())).collect();
            if Value::Array(next.clone()).to_string() == Value::Array(s.saved.clone()).to_string() {
                return;
            }
            next
        };
        self.lock().saved = next.clone();
        let _ = self.write_json(SAVED_FILE, &Value::Array(next));
    }

    /// start(): the saved settings, the automatic jobs still running when the app closed, the ticks
    pub fn start(self: &Arc<Self>) -> Value {
        self.load_speed();
        if let Some(stored) = self.read_json(SETTINGS_FILE) {
            let stored = self.repair_legacy_device_settings(SETTINGS_FILE, stored);
            let n = normalize_settings(&stored).unwrap_or_else(|_| default_settings());
            self.lock().settings = n;
        }
        let saved = self.read_json(SAVED_FILE).map(|v| self.repair_legacy_device_settings(SAVED_FILE, v)).and_then(|v| v.as_array().map(|_| normalize_configs(&json!({ "configs": v })))).unwrap_or_default();
        for c in &saved { self.note_speed_settings(c, false); }
        self.lock().saved = saved;
        let configs = self.lock().settings["configs"].as_array().cloned().unwrap_or_default();
        for c in &configs {
            self.note_speed_settings(c, false);
            self.load_index(c);
        }
        if let Ok(jobs) = self.o.service.list_summaries() {
            let st = self.read_json(STATE_FILE).unwrap_or(Value::Null);
            let mut paused: Vec<Value> = st["pausedForWindowJobIds"].as_array().cloned().unwrap_or_default();
            if super::jobstore::normalize::truthy(&st["pausedForWindowJobId"]) {
                paused.push(st["pausedForWindowJobId"].clone());
            }
            let for_devices = st["pausedForDevicesJobIds"].as_array().cloned().unwrap_or_default();
            for running in jobs {
                if running["config"]["autoConvert"] != true || terminal(&running["state"]) || !running["config"]["sourceRoot"].is_string() {
                    continue;
                }
                self.load_index(&running["config"]);
                let is_paused = running["state"] == "paused";
                let root = running["config"]["sourceRoot"].as_str().unwrap().to_string();
                self.lock().status["active"][&root] = json!({
                    "jobId": running["id"], "lanes": running["config"].get("lanes").cloned().unwrap_or(Value::Null),
                    "pausedForWindow": is_paused && paused.contains(&running["id"]),
                    "pausedForDevices": is_paused && for_devices.contains(&running["id"])
                });
            }
            self.changed();
        }
        let st = self.read_json(STATE_FILE).unwrap_or(Value::Null);
        let ids = |v: &Value| v.as_array().cloned().unwrap_or_default().into_iter().filter(Value::is_string).take(64).collect::<Vec<_>>();
        {
            let mut s = self.lock();
            for k in ["heldManual", "handledManual"] {
                let mut list: Vec<Value> = s.status[k].as_array().cloned().unwrap_or_default();
                for id in ids(&st[k]) {
                    if !list.contains(&id) {
                        list.push(id);
                    }
                }
                s.status[k] = Value::Array(list);
            }
            // catch-up runs go on where they were: a vehicle without its job is checked at once
            if catch_up_on(&s.settings) && s.settings["enabled"] == true {
                let known: Vec<String> = s.settings["configs"].as_array().cloned().unwrap_or_default().iter().filter_map(|c| c["sourceRoot"].as_str().map(str::to_string)).collect();
                for (root, e) in st["catchUp"].as_object().into_iter().flatten() {
                    if let Some(since) = e["since"].as_i64().filter(|_| known.contains(root)) {
                        Self::start_catch_up(&mut s, root, since);
                    }
                }
                Self::queue_catch_up(&mut s);
            }
            // (turned off, nothing is due: turning it back on waits for the next scheduled time)
            if let Some(cal) = calendar_of(&s.settings).filter(|_| s.settings["enabled"] == true) {
                let now = (self.o.now)();
                // times saved for another schedule (a save whose state.json write failed) don't count
                let ours = st.get("schedule").is_none_or(|x| *x == cal);
                let time = |k: &str| st[k].as_i64().filter(|_| ours);
                let (last, next) = (time("lastCheckAt"), time("nextCheckAt"));
                // one check for whatever was missed while the server was off, never one per missed time
                let missed = match (next, last) {
                    (Some(n), _) => n <= now,
                    (None, Some(l)) => super::schedule::missed(&cal, l, now),
                    (None, None) => false,
                };
                let upcoming = match next {
                    Some(n) if n > now => n,
                    _ => super::schedule::next_after(&cal, now),
                };
                // (a missed check stays saved as due until its round's jobs are done)
                let saved_next = if missed { next.map(Value::from).unwrap_or(Value::Null) } else { json!(upcoming) };
                s.calendar = [last.map(Value::from).unwrap_or(Value::Null), saved_next];
                s.status["lastCheckAt"] = s.calendar[0].clone();
                s.status["nextCheckAt"] = json!(if missed { now } else { upcoming });
                s.round_open = missed;
            }
        }
        if self.o.timer && self.lock().timer.is_none() {
            let stop = Arc::new(AtomicBool::new(false));
            self.lock().timer = Some(stop.clone());
            let me = Arc::downgrade(self);
            let every = Duration::from_millis(self.o.tick_ms);
            std::thread::spawn(move || loop {
                std::thread::sleep(every);
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                match me.upgrade() {
                    Some(a) => a.tick(),
                    None => return,
                }
            });
        }
        self.tick_soon();
        self.get_state()
    }

    /// configure(next): the shared schedule and window, plus one vehicle's folder
    pub fn configure(self: &Arc<Self>, next: &Value) -> Result<Value, String> {
        let edit = self.settings_edit.lock().unwrap();
        let mut configs: Vec<Value> = self.lock().settings["configs"].as_array().cloned().unwrap_or_default();
        let mut keep: Option<Value> = None;
        if let Some(a) = next.get("configs").and_then(Value::as_array) {
            configs = a.clone();
        } else if next.get("enabled") == Some(&json!(true)) && next.get("config").is_some_and(is_config) {
            let mut sent = next["config"].as_object().unwrap().clone();
            sent.shift_remove("nodesOff");
            let root = sent["sourceRoot"].clone();
            let off = self.nodes_off_for(&with_valid_lanes(&Value::Object(sent.clone()))["lanes"]).unwrap_or_else(|| {
                configs.iter().find(|c| c["sourceRoot"] == root).and_then(|c| c["nodesOff"].as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
            });
            inherit_keep_recent(&mut sent, configs.iter().find(|c| c["sourceRoot"] == root));
            configs.retain(|c| c["sourceRoot"] != root);
            if !off.is_empty() {
                sent.insert("nodesOff".into(), json!(off));
            }
            configs.push(Value::Object(sent));
        } else if let Some(r) = next.get("removeSource").and_then(Value::as_str) {
            keep = configs.iter().find(|c| c["sourceRoot"] == r).cloned();
            configs.retain(|c| c["sourceRoot"] != r);
        }
        if configs.len() > MAX_SOURCES {
            return Err("TOO_MANY_AUTO_SOURCES".into());
        }
        let mut input = next.as_object().cloned().unwrap_or_default();
        input.insert("configs".into(), Value::Array(configs));
        let stored = self.lock().settings.clone();
        Self::inherit_calendar(&mut input, &stored)?;
        let mut normalized = normalize_settings(&Value::Object(input))?;
        for c in normalized["configs"].as_array_mut().unwrap() {
            self.note_speed_settings(c, false);
        }
        let (was, calendar) = (calendar_of(&stored), calendar_of(&normalized));
        for c in normalized["configs"].as_array().unwrap() {
            self.load_index(c);
        }
        let (added, entering): (Vec<String>, Vec<String>) = {
            let s = self.lock();
            let before: IndexMap<String, Value> = s.settings["configs"].as_array().cloned().unwrap_or_default().into_iter().map(|c| (c["sourceRoot"].as_str().unwrap_or("").to_string(), c)).collect();
            let root_of = |c: &Value| c["sourceRoot"].as_str().unwrap_or("").to_string();
            let after = normalized["configs"].as_array().unwrap();
            let added = after.iter().filter(|c| before.get(&root_of(c)).map(Value::to_string) != Some(c.to_string())).map(root_of).collect();
            let entering = if catch_up_on(&normalized) { after.iter().filter(|c| more_eligible(before.get(&root_of(c)), c)).map(root_of).collect() } else { vec![] };
            (added, entering)
        };
        // (the schedule and its next check change together: a timer tick in between would
        // otherwise check at once)
        let (new_calendar, catch_up_changed) = {
            let mut s = self.lock();
            s.settings = normalized.clone();
            let now = (self.o.now)();
            let next = Self::follow_calendar(&mut s, was.as_ref(), calendar.as_ref(), now);
            // a vehicle removed, or the switch turned off, ends its run; one re-added starts another
            let had = s.status.get("catchUp").cloned();
            let on = catch_up_on(&s.settings) && s.settings["enabled"] == true;
            for root in Self::catching(&s) {
                if !on || Self::config_for(&s, &root).is_none() {
                    Self::end_catch_up(&mut s, &root);
                }
            }
            for root in &entering {
                Self::start_catch_up(&mut s, root, now);
            }
            (next, s.status.get("catchUp").cloned() != had)
        };
        if new_calendar || catch_up_changed {
            self.save_state();
        }
        self.write_json(SETTINGS_FILE, &normalized).map_err(|e| super::owned::code_of(&e).to_string())?;
        let saved = self.lock().saved.clone();
        let list = match keep {
            Some(k) => {
                let mut l: Vec<Value> = saved.into_iter().filter(|c| c["sourceRoot"] != k["sourceRoot"]).collect();
                l.push(k);
                l
            }
            None => saved,
        };
        self.write_saved(list);
        // With a calendar schedule a save starts no work by itself: changed vehicles wait for
        // the next scheduled check, except those in their catch-up run, which start now.
        let queued: Vec<String> = if calendar.is_some() {
            let catching = Self::catching(&self.lock());
            added.into_iter().filter(|r| catching.contains(r)).collect()
        } else {
            added
        };
        {
            let mut s = self.lock();
            for r in &queued {
                if !s.status["round"].as_array().unwrap().iter().any(|x| x == r.as_str()) {
                    s.status["round"].as_array_mut().unwrap().push(json!(r));
                }
            }
            if s.settings["enabled"] != true {
                s.status["round"] = json!([]);
                s.status["nextCheckAt"] = Value::Null;
            }
        }
        self.changed();
        drop(edit);
        if calendar.is_none() || !queued.is_empty() {
            self.tick_soon();
        }
        Ok(self.get_state())
    }

    /// The next check after a save: a new calendar schedule (or one turned back on) waits for
    /// its next time; going back to an interval checks on this save's tick. True: the saved
    /// check times changed.
    fn follow_calendar(s: &mut Inner, was: Option<&Value>, calendar: Option<&Value>, now: i64) -> bool {
        if s.settings["enabled"] != true || (was.is_some() && calendar.is_none()) {
            s.round_open = false;
            s.round_at = None;
        }
        if s.settings["enabled"] != true {
            return false;
        }
        let Some(cal) = calendar else {
            if was.is_some() {
                s.status["nextCheckAt"] = Value::Null;
            }
            return false;
        };
        // (work an interval check left under way is the calendar's to finish)
        if was.is_none() && Self::under_way(s) {
            Self::open_round(s, now);
        }
        if was == Some(cal) && !s.status["nextCheckAt"].is_null() {
            return false;
        }
        // (a round still owed, say one waiting for the window after a restart, stays due:
        // it takes the new schedule's next time when it runs)
        if s.round_open && s.status["nextCheckAt"].as_i64().is_some_and(|n| n <= now) {
            return true;
        }
        let n = super::schedule::next_after(cal, now);
        s.status["nextCheckAt"] = json!(n);
        // (a round still waiting for jobs keeps its passed time saved until it has them)
        if !s.round_open {
            s.calendar[1] = json!(n);
        }
        true
    }

    /// Original's page knows neither `schedule` nor `catchUp`. A save without `catchUp` keeps the
    /// stored one. A save without `schedule` keeps the stored calendar schedule when it sends the
    /// interval and window that schedule stores (1440 and its window); otherwise it goes back to
    /// the interval sent. `schedule: null` always clears it.
    fn inherit_calendar(input: &mut Map<String, Value>, stored: &Value) -> Result<(), String> {
        if !input.contains_key("catchUp") {
            if let Some(c) = stored.get("catchUp") {
                input.insert("catchUp".into(), c.clone());
            }
        }
        if input.contains_key("schedule") {
            return Ok(());
        }
        let Some(cal) = calendar_of(stored) else { return Ok(()) };
        let sent = Value::Object(input.clone());
        if interval_of(&sent) == 1440 && normalize_window(&sent)? == stored["window"] {
            input.insert("schedule".into(), cal);
        }
        Ok(())
    }

    /// ownerResumed(jobId)
    pub fn owner_resumed(&self, id: &str) {
        let held = {
            let mut s = self.lock();
            let list = s.status["heldManual"].as_array().cloned().unwrap_or_default();
            if !list.iter().any(|x| x == id) {
                return;
            }
            s.status["heldManual"] = Value::Array(list.into_iter().filter(|x| x != id).collect());
            true
        };
        if held {
            self.save_state();
            self.changed();
        }
    }

    fn replace_config(&self, current: &Value, next: Value) -> Result<(), String> {
        let settings = {
            let mut s = self.lock();
            let configs: Vec<Value> = s.settings["configs"].as_array().cloned().unwrap_or_default().into_iter().map(|c| if &c == current { next.clone() } else { c }).collect();
            s.settings["configs"] = Value::Array(configs);
            s.settings.clone()
        };
        self.write_json(SETTINGS_FILE, &settings).map_err(|e| super::owned::code_of(&e).to_string())?;
        self.changed();
        Ok(())
    }

    /// setConcurrency(value, sourceRoot): later automatic jobs for that folder use the same number
    pub fn set_concurrency(&self, value: &Value, root: Option<&str>) -> Result<Value, String> {
        let _edit = self.settings_edit.lock().unwrap();
        let current = Self::active_config(&self.lock(), root);
        let Some(current) = current else { return Ok(self.get_state()) };
        if current.get("concurrency") == Some(value) && current.get("lanes").is_none() {
            return Ok(self.get_state());
        }
        let mut c = current.as_object().unwrap().clone();
        c.shift_remove("lanes");
        c.insert("concurrency".into(), value.clone());
        c.shift_remove("deviceSettingsSource");
        self.note_speed_settings(&Value::Object(c.clone()), true);
        self.replace_config(&current, Value::Object(c))?;
        Ok(self.get_state())
    }

    /// setLanes(value, sourceRoot)
    pub fn set_lanes(&self, value: &Value, root: Option<&str>) -> Result<Value, String> {
        let _edit = self.settings_edit.lock().unwrap();
        let lanes = normalize_lanes(value).map_err(|e| e.code)?;
        let current = Self::active_config(&self.lock(), root);
        let (Some(current), Some(lanes)) = (current, lanes) else { return Ok(self.get_state()) };
        let off = self.nodes_off_for(&lanes).unwrap_or_else(|| current["nodesOff"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default());
        let current_off = current.get("nodesOff").cloned().unwrap_or(json!([]));
        if current.get("lanes").unwrap_or(&Value::Null).to_string() == lanes.to_string() && current_off.to_string() == json!(off).to_string() {
            return Ok(self.get_state());
        }
        let mut c = current.as_object().unwrap().clone();
        c.shift_remove("nodesOff");
        c.insert("concurrency".into(), json!(lanes_total(&lanes)));
        c.insert("lanes".into(), lanes);
        // ({ ...rest, lanes, concurrency }: a key already there keeps its place)
        let mut ordered = Map::new();
        for k in current.as_object().unwrap().keys() {
            if k != "nodesOff" {
                ordered.insert(k.clone(), c[k].clone());
            }
        }
        for k in ["lanes", "concurrency"] {
            if !ordered.contains_key(k) {
                ordered.insert(k.into(), c[k].clone());
            }
        }
        if !off.is_empty() {
            ordered.insert("nodesOff".into(), json!(off));
        }
        ordered.shift_remove("deviceSettingsSource");
        self.note_speed_settings(&Value::Object(ordered.clone()), true);
        self.replace_config(&current, Value::Object(ordered))?;
        Ok(self.get_state())
    }

    /// saveVehicle(config): one vehicle's settings saved without automatic conversion
    pub fn save_vehicle(self: &Arc<Self>, config: &Value) -> Result<Value, String> {
        if !is_config(config) {
            return Err("INVALID_AUTO_SETTINGS".into());
        }
        let (automatic, schedule, saved) = {
            let s = self.lock();
            let automatic = s.settings["configs"].as_array().is_some_and(|a| a.iter().any(|c| c["sourceRoot"] == config["sourceRoot"]));
            let mut sched = s.settings.as_object().unwrap().clone();
            sched.shift_remove("configs");
            (automatic, sched, s.saved.clone())
        };
        if automatic {
            let mut next = schedule;
            next.insert("enabled".into(), json!(true));
            next.insert("config".into(), config.clone());
            return self.configure(&Value::Object(next));
        }
        let _edit = self.settings_edit.lock().unwrap();
        self.note_speed_settings(config, false);
        if !saved.iter().any(|c| c["sourceRoot"] == config["sourceRoot"]) && saved.len() >= MAX_SOURCES {
            return Err("TOO_MANY_AUTO_SOURCES".into());
        }
        let mut sent = config.as_object().unwrap().clone();
        sent.shift_remove("nodesOff");
        inherit_keep_recent(&mut sent, saved.iter().find(|c| c["sourceRoot"] == config["sourceRoot"]));
        let mut list: Vec<Value> = saved.into_iter().filter(|c| c["sourceRoot"] != config["sourceRoot"]).collect();
        sent.shift_remove("deviceSettingsSource");
        let sent = Value::Object(sent);
        list.push(sent);
        self.write_saved(list);
        self.changed();
        Ok(self.get_state())
    }

    /// forgetVehicle(sourceRoot)
    pub fn forget_vehicle(&self, root: &str) -> Value {
        let list: Vec<Value> = self.lock().saved.iter().filter(|c| c["sourceRoot"] != root).cloned().collect();
        self.write_saved(list);
        self.changed();
        self.get_state()
    }

    /// checkNow()
    pub fn check_now(&self) -> Value {
        {
            let mut s = self.lock();
            s.status["nextCheckAt"] = Value::Null;
            s.status["round"] = json!([]);
            // (outside the window a check now still checks the vehicles catching up)
            Self::queue_catch_up(&mut s);
        }
        self.tick();
        self.get_state()
    }

    pub fn stop(&self) {
        if let Some(t) = self.lock().timer.take() {
            t.store(true, Ordering::SeqCst);
        }
        if let Some(a) = self.sweep_abort.lock().unwrap().as_ref() {
            a.store(true, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests;
