//! The CAN index (server/canIndex.js): each usable log decoded once in the
//! background into per-minute files of signals and raw payloads, the VIN a
//! car key sends, what the Viewer, the search and the downloads read back,
//! and the repacking of older minute files. The files are the Node server's,
//! byte for byte in layout:
//!
//!   <DATA>/can-index/<key>/<yyyyMMddTHHmm>.json.gz      signals and frame counts
//!   <DATA>/can-index/<key>/<yyyyMMddTHHmm>.raw.json.gz  raw payload changes
//!   <DATA>/can-index/<key>/signals.json                 every signal seen
//!   <DATA>/can-index/<key>/ids-<yyyyMMdd>.json          every id of a day
//!   <DATA>/can-index/<key>/car.json                     the car's VIN
//!   <DATA>/can-index/done.json, packed.json

use super::dbc::{self, decode_frame, Dbc, Message, DEFAULT_PROFILE};
use super::format::{self, write_atomic, Minute, Raw, RawMinute, Signals};
use super::json::{self, n};
use super::logs::parse_name;
use super::models::{decode_vin, Vin, VinCollector};
use super::reader::{self, LogError};
use super::tz;
use super::util::{self, mtime_ms};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

const STEP_MS: f64 = 50.0;
pub const RAW_PER_SEC: u32 = 10;
pub const FORMAT: &str = "r5";
pub const CAR_FORMAT: &str = "r2";
const DEFAULT_RIGHT: [&str; 4] = ["r5", "r4", "r3", "r2"];
pub const INTERNAL_YIELD_MS: f64 = 2500.0;
const KEEP_MS: f64 = 1000.0;
const ID_DAY: &str = "v1";
const MINUTE_CACHE: usize = 4;
pub const CLIP_STEP_MS: f64 = 250.0;

pub fn profile_stamp(profile: &str) -> String {
    if profile.is_empty() || profile == DEFAULT_PROFILE { String::new() } else { format!("/{}", profile) }
}
pub fn part_format(profile: &str) -> String {
    format!("{}{}", FORMAT, profile_stamp(profile))
}
pub fn still_right(f: Option<&str>, profile: &str) -> bool {
    if !profile_stamp(profile).is_empty() {
        f == Some(part_format(profile).as_str())
    } else {
        f.is_some_and(|f| DEFAULT_RIGHT.contains(&f))
    }
}

/// The internal bus's messages decoded there (by id), and their only signals.
fn internal_only(id: u32) -> Option<&'static [&'static str]> {
    (id == 0x04F).then_some(&["GPSLatitude04F", "GPSLongitude04F", "GPSAccuracy04F"][..])
}

pub fn iface_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 16 && b[0].is_ascii_alphabetic() && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}
fn good_id(id_key: &str) -> bool {
    iface_ok(id_key.split(':').next().unwrap_or(""))
}

/// minuteKey: "yyyyMMddTHHmm" of the minute of a UTC time.
pub fn minute_key(ms: f64) -> String {
    let m = (ms / 60000.0).floor() * 60000.0;
    let iso = tz::iso(m as i64);
    let s: String = iso[..16].chars().filter(|c| *c != '-' && *c != ':').collect();
    s
}

pub fn minute_of_file(f: &str) -> Option<f64> {
    let b = f.as_bytes();
    if b.len() != 21 || &f[13..] != ".json.gz" || b[8] != b'T' || !b[..8].iter().chain(&b[9..13]).all(|c| c.is_ascii_digit()) {
        return None;
    }
    let num = |a: usize, z: usize| f[a..z].parse::<i64>().unwrap();
    Some(tz::utc_ms(num(0, 4), num(4, 6), num(6, 8), num(9, 11), num(11, 13), 0) as f64)
}
fn raw_minute_of_file(f: &str) -> Option<&str> {
    let b = f.as_bytes();
    (b.len() == 25 && &f[13..] == ".raw.json.gz" && b[8] == b'T' && b[..8].iter().chain(&b[9..13]).all(|c| c.is_ascii_digit())).then(|| &f[..13])
}

fn trust_rank(t: &str) -> i32 {
    match t {
        "override" => 0,
        "unsigned" => 1,
        "verified" => 2,
        _ => 1,
    }
}
pub fn worse_trust(a: Option<String>, b: Option<String>) -> Option<String> {
    match (a, b) {
        (None, b) => b,
        (a, None) => a,
        (Some(a), Some(b)) => Some(if trust_rank(&a) <= trust_rank(&b) { a } else { b }),
    }
}

fn side_entries(side: &Value) -> Vec<(String, String)> {
    let map = ["bus", "busMap", "buses"].iter().find_map(|k| side.get(*k).filter(|v| json::truthy(Some(v))));
    let Some(Value::Object(m)) = map else { return Vec::new() };
    json::ordered_keys(m)
        .into_iter()
        .map(|iface| {
            let v = &m[iface];
            let s = match v {
                Value::Object(_) => {
                    let pick = ["dbcBus", "name"].iter().find_map(|k| v.get(*k).filter(|x| json::truthy(Some(x)))).cloned();
                    pick.map(|p| super::logs::js_string(&p)).unwrap_or_default()
                }
                other => super::logs::js_string(other),
            };
            (iface.clone(), s.to_lowercase())
        })
        .collect()
}
fn internal_word(s: &str) -> bool {
    s.contains("internal") || s.contains("screenmate")
}

/// busMapOf: which DBC bus each interface is (the sidecar's bus map over the set's defaults).
pub fn bus_map_of(side: &Value, defaults: &[(String, String)]) -> IndexMap<String, String> {
    let mut bus: IndexMap<String, String> = defaults.iter().cloned().collect();
    for (iface, s) in side_entries(side) {
        if internal_word(&s) {
            bus.shift_remove(&iface);
        } else if s.contains("vehicle") {
            bus.insert(iface, "VehicleBus".into());
        } else if s.contains("chassis") {
            bus.insert(iface, "ChassisBus".into());
        } else if s.contains("powertrain") {
            bus.insert(iface, "PowertrainBus".into());
        } else if s.contains("party") {
            bus.insert(iface, "PartyBus".into());
        }
    }
    bus
}
pub fn internal_buses_of(side: &Value) -> Vec<String> {
    let mut v: Vec<String> = side_entries(side).into_iter().filter(|(i, s)| internal_word(s) && iface_ok(i)).map(|x| x.0).collect();
    v.sort();
    v
}
fn decoded_on(msg: Option<&Message>, id: u32, iface: &str, bus_of: &IndexMap<String, String>, internal: &[String]) -> bool {
    let Some(msg) = msg.filter(|m| !m.signals.is_empty()) else { return false };
    if let Some(b) = bus_of.get(iface) {
        return &msg.bus == b;
    }
    internal_only(id).is_some() && internal.iter().any(|x| x == iface)
}

fn bus_map_value(b: &IndexMap<String, String>) -> Value {
    Value::Object(b.iter().map(|(k, v)| (k.clone(), Value::String(v.clone()))).collect())
}

/// A span [a, b] of a part, when it has one.
fn span_of(part: Option<&Value>) -> Option<(f64, f64)> {
    let s = part?.get("span")?.as_array()?;
    Some((s.first().and_then(|x| x.as_f64()).unwrap_or(f64::NAN), s.get(1).and_then(|x| x.as_f64()).unwrap_or(f64::NAN)))
}

/// withoutPart: a minute without one log's part (its points in its span, its frame counts).
fn without_part<V: Clone>(signals: &IndexMap<String, Vec<(f64, V)>>, ids: &IndexMap<String, f64>, old: Option<&Value>) -> (IndexMap<String, Vec<(f64, V)>>, IndexMap<String, f64>) {
    let Some((a, b)) = old.and_then(|o| o.get("span").filter(|s| s.is_array()).map(|_| span_of(Some(o)).unwrap())) else {
        return (signals.clone(), ids.clone());
    };
    let mut out = IndexMap::new();
    for (nm, pts) in signals {
        let keep: Vec<(f64, V)> = pts.iter().filter(|p| p.0 < a || p.0 > b).cloned().collect();
        if !keep.is_empty() {
            out.insert(nm.clone(), keep);
        }
    }
    let mut out_ids = ids.clone();
    if let Some(Value::Object(m)) = old.and_then(|o| o.get("ids")) {
        for id in json::ordered_keys(m) {
            let left = out_ids.get(id).copied().unwrap_or(0.0) - m[id].as_f64().unwrap_or(f64::NAN);
            if left > 0.0 {
                out_ids.insert(id.clone(), left);
            } else {
                out_ids.shift_remove(id);
            }
        }
    }
    (out, out_ids)
}

/// onlyInSpans: the points inside one of the parts' spans.
fn only_in_spans(signals: &Signals, parts: &[&Value]) -> Signals {
    let spans: Vec<(f64, f64)> = parts.iter().filter(|p| p.get("span").is_some_and(|s| s.is_array())).map(|p| span_of(Some(p)).unwrap()).collect();
    let mut out = IndexMap::new();
    for (nm, pts) in signals {
        let keep: Vec<(f64, f64)> = pts.iter().filter(|p| spans.iter().any(|(a, b)| p.0 >= *a && p.0 <= *b)).cloned().collect();
        if !keep.is_empty() {
            out.insert(nm.clone(), keep);
        }
    }
    out
}

fn sidecar_stamp(file: &Path) -> String {
    match std::fs::metadata(format!("{}.json", file.display())) {
        Ok(st) => format!("/{}-{}", st.len(), json::num_str(json::round(mtime_ms(&st)))),
        Err(_) => String::new(),
    }
}

#[derive(Debug, Clone, Default)]
pub struct Status {
    pub running: bool,
    pub current: Option<String>,
    pub indexed: u64,
    pub pending: i64,
    pub last_error: Option<String>,
    pub last_at: Option<f64>,
}

impl Status {
    pub fn to_json(&self) -> Value {
        json!({ "running": self.running, "current": self.current, "indexed": self.indexed, "pending": self.pending, "lastError": self.last_error, "lastAt": self.last_at.map(n) })
    }
}

#[derive(Debug, Clone)]
pub struct Job {
    pub key: String,
    pub name: String,
    pub stamp: String,
    pub started_at: i64,
    pub raw_only: bool,
    pub trust: Option<String>,
    pub profile: String,
}

#[derive(Debug, Clone, Default)]
pub struct Indexed {
    pub frames: u64,
    pub minutes: u64,
    pub from: Option<f64>,
    pub to: Option<f64>,
    pub profile: String,
    pub car_changed: bool,
    pub truncated: Option<String>,
}

pub type ProfileOf = Box<dyn Fn(&CanIndex, &str) -> String + Send + Sync>;

/// logs that started this recently are indexed at once, even while the converter runs
pub const FRESH_MS: f64 = 15.0 * 60_000.0;

pub struct CanIndex {
    pub can_dir: PathBuf,
    pub dir: PathBuf,
    pub xz: String,
    pub max_unpacked: u64,
    pub auto_repack: bool,
    pub idle: Box<dyn Fn() -> bool + Send + Sync>,
    pub profile_of: ProfileOf,
    pub usable: Box<dyn Fn(&str, &str) -> (bool, Option<&'static str>) + Send + Sync>,
    pub on_indexed: Box<dyn Fn(&str, Option<f64>, Option<f64>) + Send + Sync>,
    pub on_progress: Box<dyn Fn(&Status) + Send + Sync>,
    pub log: Box<dyn Fn(&str, &str) + Send + Sync>,
    pub now: Box<dyn Fn() -> f64 + Send + Sync>,
    cars: Mutex<HashMap<String, Option<Value>>>,
    done: Mutex<Option<Map<String, Value>>>,
    status: Mutex<Status>,
    minute_cache: Mutex<Vec<(String, Arc<Option<Minute>>)>>,
    raw_cache: Mutex<Vec<(String, Arc<Option<RawMinute>>)>>,
    generation: AtomicU64,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    day_gen: Mutex<HashMap<String, u64>>,
    running: Mutex<bool>,
    running_cv: Condvar,
    again: AtomicBool,
}

impl CanIndex {
    pub fn new(can_dir: PathBuf, dir: PathBuf) -> CanIndex {
        CanIndex {
            can_dir,
            dir,
            xz: "xz".into(),
            max_unpacked: reader::MAX_UNPACKED,
            auto_repack: true,
            idle: Box::new(|| true),
            profile_of: Box::new(|_, _| DEFAULT_PROFILE.to_string()),
            usable: Box::new(|_, _| (true, Some("unsigned"))),
            on_indexed: Box::new(|_, _, _| {}),
            on_progress: Box::new(|_| {}),
            log: Box::new(|_, _| {}),
            now: Box::new(util::now_ms),
            cars: Mutex::new(HashMap::new()),
            done: Mutex::new(None),
            status: Mutex::new(Status::default()),
            minute_cache: Mutex::new(Vec::new()),
            raw_cache: Mutex::new(Vec::new()),
            generation: AtomicU64::new(0),
            locks: Mutex::new(HashMap::new()),
            day_gen: Mutex::new(HashMap::new()),
            running: Mutex::new(false),
            running_cv: Condvar::new(),
            again: AtomicBool::new(false),
        }
    }

    pub fn profile_for(&self, key: &str) -> String {
        let p = (self.profile_of)(self, key);
        if p.is_empty() { DEFAULT_PROFILE.to_string() } else { p }
    }
    fn dbc_of(profile: &str) -> Arc<Dbc> {
        dbc::dbc_for(if profile.is_empty() { DEFAULT_PROFILE } else { profile })
    }
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }
    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }
    fn progress(&self) {
        let s = self.status();
        (self.on_progress)(&s);
    }

    // ---- the car's own VIN
    pub fn car_of(&self, key: &str) -> Option<Value> {
        let mut c = self.cars.lock().unwrap();
        if !c.contains_key(key) {
            let v = util::read_json(&self.dir.join(key).join("car.json")).filter(|v| json::truthy(Some(v)));
            c.insert(key.to_string(), v);
        }
        c.get(key).cloned().flatten()
    }
    fn note_car(&self, key: &str, found: &Vin) -> bool {
        let had = self.car_of(key);
        if had.as_ref().and_then(|h| h.get("vin")).and_then(|v| v.as_str()) == Some(found.vin.as_str()) && had.as_ref().and_then(|h| h.get("via")).and_then(|v| v.as_str()) == found.via.as_deref() {
            return false;
        }
        let c = json!({ "vin": found.vin, "model": found.model, "year": found.year, "plant": found.plant, "via": found.via, "seenAt": n((self.now)()) });
        let _ = std::fs::create_dir_all(self.dir.join(key));
        if write_atomic(&self.dir.join(key).join("car.json"), json::stringify(&c).as_bytes()).is_err() {
            return false;
        }
        self.cars.lock().unwrap().insert(key.to_string(), Some(c));
        (self.log)("info", &format!("CAN index: car {} is a {}{} (its VIN, {})", key, found.model.as_ref().map(|m| format!("Model {}", m)).unwrap_or_else(|| "car".into()), found.year.map(|y| format!(" of {}", y)).unwrap_or_default(), found.via.clone().unwrap_or_default()));
        true
    }

    // ---- done.json
    fn with_done<T>(&self, f: impl FnOnce(&mut Map<String, Value>) -> T) -> T {
        let mut d = self.done.lock().unwrap();
        if d.is_none() {
            *d = Some(util::read_json(&self.dir.join("done.json")).and_then(|v| v.as_object().cloned()).unwrap_or_default());
        }
        f(d.as_mut().unwrap())
    }
    fn save_done(&self) {
        let text = self.with_done(|d| json::stringify(&Value::Object(d.clone())));
        let _ = std::fs::create_dir_all(&self.dir);
        let _ = write_atomic(&self.dir.join("done.json"), text.as_bytes());
    }

    fn lock_of(&self, key: &str) -> Arc<Mutex<()>> {
        self.locks.lock().unwrap().entry(key.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))).clone()
    }

    fn changed(&self, key: &str, minute: &str) {
        let k = format!("{}/{}", key, minute);
        self.minute_cache.lock().unwrap().retain(|x| x.0 != k);
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    fn minute_file(&self, key: &str, minute: &str) -> PathBuf {
        self.dir.join(key).join(format!("{}.json.gz", minute))
    }
    fn raw_file(&self, key: &str, minute: &str) -> PathBuf {
        self.dir.join(key).join(format!("{}.raw.json.gz", minute))
    }

    /// A minute's signals, from a small cache (`cache`: the Viewer's reads) or read now.
    pub fn read_minute(&self, key: &str, minute: &str, cache: bool) -> Arc<Option<Minute>> {
        if !cache {
            return Arc::new(format::read_minute_file(&self.minute_file(key, minute)));
        }
        let k = format!("{}/{}", key, minute);
        {
            let mut c = self.minute_cache.lock().unwrap();
            if let Some(i) = c.iter().position(|x| x.0 == k) {
                let e = c.remove(i);
                let v = e.1.clone();
                c.push(e);
                return v;
            }
        }
        let v = Arc::new(format::read_minute_file(&self.minute_file(key, minute)));
        let mut c = self.minute_cache.lock().unwrap();
        c.push((k, v.clone()));
        while c.len() > MINUTE_CACHE {
            c.remove(0);
        }
        v
    }
    fn read_raw(&self, key: &str, minute: &str) -> Arc<Option<RawMinute>> {
        let k = format!("{}/{}", key, minute);
        {
            let c = self.raw_cache.lock().unwrap();
            if let Some(x) = c.iter().find(|x| x.0 == k) {
                return x.1.clone();
            }
        }
        let v = Arc::new(format::read_raw_file(&self.raw_file(key, minute)));
        let mut c = self.raw_cache.lock().unwrap();
        c.push((k, v.clone()));
        if c.len() > 6 {
            c.remove(0);
        }
        v
    }
    fn raw_drop(&self, key: &str, minute: &str) {
        let k = format!("{}/{}", key, minute);
        self.raw_cache.lock().unwrap().retain(|x| x.0 != k);
    }
    fn raw_now(&self, key: &str, minute: &str) -> Option<RawMinute> {
        self.raw_drop(key, minute);
        format::read_raw_file(&self.raw_file(key, minute))
    }

    fn day_changed(&self, key: &str, minute: &str) {
        let day = &minute[..8.min(minute.len())];
        *self.day_gen.lock().unwrap().entry(format!("{}/{}", key, day)).or_insert(0) += 1;
        let _ = std::fs::remove_file(self.dir.join(key).join(format!("ids-{}.json", day)));
    }

    #[allow(clippy::too_many_arguments)]
    fn write_minute(&self, key: &str, minute: &str, mut signals: Signals, data_ids: IndexMap<String, f64>, name: &str, part: Value, before: Option<&Value>) -> std::io::Result<()> {
        let had = format::read_minute_file(&self.minute_file(key, minute));
        let mut logs = Map::new();
        let mut ids = data_ids.clone();
        if let Some(h) = had.as_ref().filter(|h| h.logs.as_ref().is_some_and(|l| !l.contains_key(""))) {
            let hl = h.logs.as_ref().unwrap();
            for (k, v) in hl {
                logs.insert(k.clone(), v.clone());
            }
            let old = hl.get(name).filter(|v| json::truthy(Some(v))).or(before);
            let empty = IndexMap::new();
            let (rest_signals, rest_ids) = without_part(&h.signals, h.ids.as_ref().unwrap_or(&empty), old);
            let others: Vec<&Value> = json::ordered_keys(hl).into_iter().filter(|k| k.as_str() != name).map(|k| &hl[k]).collect();
            let rest_signals = only_in_spans(&rest_signals, &others);
            for (nm, pts) in rest_signals {
                match signals.get_mut(&nm) {
                    Some(mine) => {
                        let mut all: Vec<(f64, f64)> = pts.into_iter().chain(mine.drain(..)).collect();
                        all.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
                        let mut out: Vec<(f64, f64)> = Vec::with_capacity(all.len());
                        for p in all {
                            if out.last().is_none_or(|l: &(f64, f64)| l.0 != p.0) {
                                out.push(p);
                            }
                        }
                        *mine = out;
                    }
                    None => {
                        signals.insert(nm, pts);
                    }
                }
            }
            ids = rest_ids;
            for (id, c) in &data_ids {
                *ids.entry(id.clone()).or_insert(0.0) += c;
            }
        }
        logs.insert(name.to_string(), part);
        let mut trust: Option<String> = None;
        for p in logs.values() {
            trust = worse_trust(trust, p.get("trust").and_then(|t| t.as_str()).map(String::from));
        }
        let body = format::gzip(&Minute::encode(&Value::String(minute.into()), trust.as_deref(), &logs, &signals, &ids));
        std::fs::create_dir_all(self.dir.join(key))?;
        self.day_changed(key, minute);
        write_atomic(&self.minute_file(key, minute), &body)?;
        self.changed(key, minute);
        Ok(())
    }

    fn write_raw(&self, key: &str, minute: &str, mut data: RawMinute, name: &str, had: Option<&RawMinute>) -> std::io::Result<()> {
        if let Some(h) = had {
            let empty = IndexMap::new();
            let old = h.logs.as_ref().and_then(|l| l.get(name));
            let (rest, _) = without_part(&h.raw, &empty, old);
            for (id, pts) in rest {
                match data.raw.get_mut(&id) {
                    Some(mine) => {
                        let mut all: Vec<(f64, String)> = pts.into_iter().chain(mine.drain(..)).collect();
                        all.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
                        let mut out: Vec<(f64, String)> = Vec::with_capacity(all.len());
                        for p in all {
                            if out.last().is_none_or(|l: &(f64, String)| l.0 != p.0 || l.1 != p.1) {
                                out.push(p);
                            }
                        }
                        *mine = out;
                    }
                    None => {
                        data.raw.insert(id, pts);
                    }
                }
            }
            let mut logs = h.logs.clone().unwrap_or_default();
            for (k, v) in data.logs.take().unwrap_or_default() {
                logs.insert(k, v);
            }
            data.logs = Some(logs);
        }
        std::fs::create_dir_all(self.dir.join(key))?;
        write_atomic(&self.raw_file(key, minute), &format::gzip(&data.encode()))?;
        self.raw_drop(key, minute);
        self.generation.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn merge_signals(&self, key: &str, seen: &IndexMap<String, Value>, profile: &str) -> std::io::Result<()> {
        let file = self.dir.join(key).join("signals.json");
        let mut all = util::read_json(&file).and_then(|v| v.as_object().cloned()).unwrap_or_default();
        let now = part_format(profile);
        let names: Vec<String> = all.keys().cloned().collect();
        for name in names {
            let f = all[&name].get("fmt").and_then(|f| f.as_str()).map(String::from);
            if !still_right(f.as_deref(), profile) {
                all.shift_remove(&name);
            } else if f.as_deref() != Some(now.as_str()) {
                if let Some(o) = all.get_mut(&name).and_then(|v| v.as_object_mut()) {
                    o.insert("fmt".into(), Value::String(now.clone()));
                }
            }
        }
        for (name, meta) in seen {
            all.insert(name.clone(), meta.clone());
        }
        std::fs::create_dir_all(self.dir.join(key))?;
        write_atomic(&file, json::stringify(&Value::Object(all)).as_bytes())
    }

    /// indexLog: decode every frame of one log and write its minutes.
    pub fn index_log(&self, key: &str, name: &str, raw_only: bool, trust: Option<&str>, profile: Option<&str>) -> Result<Indexed, LogError> {
        let profile = profile.map(String::from).unwrap_or_else(|| self.profile_for(key));
        let fmt_now = part_format(&profile);
        let file = self.can_dir.join(key).join(name);
        let side = util::read_json(Path::new(&format!("{}.json", file.display()))).filter(|v| json::truthy(Some(v))).unwrap_or_else(|| json!({}));
        let dbc = Self::dbc_of(&profile);
        let bus_of = bus_map_of(&side, &dbc.buses);
        let internal = internal_buses_of(&side);
        let mut b = Builder::new(name, &fmt_now, trust, bus_of, internal, &dbc, raw_only);
        let mut found = reader::Found::default();
        let mut write_err: Option<std::io::Error> = None;
        let mut bad_time = false;
        let opts = reader::Opts { xz: self.xz.clone(), max_unpacked: self.max_unpacked, ..Default::default() };
        reader::read_lines(&file, &opts, &mut found, reader::MAX_LINE, |line| {
            match b.line(line) {
                Step::Ok => {}
                Step::BadTime => {
                    bad_time = true;
                    return false;
                }
            }
            while b.writes.len() >= 2 {
                let w = b.writes.remove(0);
                if let Err(e) = self.write_out(key, name, raw_only, w) {
                    write_err = Some(e);
                    return false;
                }
            }
            true
        })?;
        if bad_time {
            return Err(LogError { message: "Invalid time value".into(), retry: false, busy: false, refused: false });
        }
        if let Some(e) = write_err {
            return Err(LogError { message: e.to_string(), retry: false, busy: false, refused: false });
        }
        b.close_minute();
        if let Some(why) = &found.truncated {
            if b.frames == 0 {
                return Err(LogError { message: format!("xz could not read {}: {}", name, why), retry: false, busy: false, refused: false });
            }
        }
        for w in std::mem::take(&mut b.writes) {
            self.write_out(key, name, raw_only, w).map_err(|e| LogError { message: e.to_string(), retry: false, busy: false, refused: false })?;
        }
        if !raw_only {
            self.merge_signals(key, &b.seen, &profile).map_err(|e| LogError { message: e.to_string(), retry: false, busy: false, refused: false })?;
        }
        let side_vin = side.get("vin").and_then(|v| v.as_str()).or_else(|| side.get("car").and_then(|c| c.get("vin")).and_then(|v| v.as_str()));
        let from_side = side_vin.and_then(decode_vin).map(|mut d| {
            d.via = Some("sidecar".into());
            d
        });
        let found_vin = b.vin.found.clone().or(from_side);
        let car_changed = found_vin.as_ref().is_some_and(|f| self.note_car(key, f));
        let minutes = b.written + if b.minute.is_some() { 1 } else { 0 };
        Ok(Indexed { frames: b.frames, minutes, from: b.first, to: b.last_t, profile, car_changed, truncated: found.truncated.map(|w| format!("xz stopped early: {}", w)) })
    }

    fn write_out(&self, key: &str, name: &str, raw_only: bool, w: Write) -> std::io::Result<()> {
        let lock = self.lock_of(key);
        let _g = lock.lock().unwrap();
        let had_raw = self.raw_now(key, &w.minute);
        if !raw_only {
            let before = had_raw.as_ref().and_then(|h| h.logs.as_ref()).and_then(|l| l.get(name)).filter(|v| json::truthy(Some(v))).cloned();
            self.write_minute(key, &w.minute, w.signals, w.ids, name, w.part, before.as_ref())?;
        }
        self.write_raw(key, &w.minute, w.raw, name, had_raw.as_ref())
    }

    /// pendingLogs: every complete log not indexed yet, oldest first.
    pub fn pending_logs(&self) -> Vec<Job> {
        let mut out = Vec::new();
        for key in util::subdirs(&self.can_dir) {
            let Some(names) = util::names(&self.can_dir.join(&key)) else { continue };
            let profile = self.profile_for(&key);
            for name in names {
                let Some(nm) = parse_name(&name) else { continue };
                if nm.sidecar {
                    continue;
                }
                let path = self.can_dir.join(&key).join(&name);
                let Ok(st) = std::fs::metadata(&path) else { continue };
                let stamp = format!("{}/{}/{}{}{}", st.len(), json::num_str(json::round(mtime_ms(&st))), FORMAT, profile_stamp(&profile), sidecar_stamp(&path));
                let had = self.with_done(|d| d.get(&format!("{}/{}", key, name)).and_then(|v| v.as_str()).map(String::from));
                if had.as_deref() == Some(stamp.as_str()) {
                    continue;
                }
                let (ok, trust) = (self.usable)(&key, &name);
                if !ok {
                    continue;
                }
                out.push(Job { key: key.clone(), name, stamp, started_at: nm.started_at, raw_only: false, trust: trust.map(String::from), profile: profile.clone() });
            }
        }
        out.sort_by_key(|j| j.started_at);
        out
    }

    /// kick: index what is new, in the background (once more when asked while running).
    pub fn kick(self: &Arc<Self>) {
        {
            let mut r = self.running.lock().unwrap();
            if *r {
                self.again.store(true, Ordering::SeqCst);
                return;
            }
            *r = true;
        }
        let me = self.clone();
        std::thread::spawn(move || {
            me.run_pass();
            *me.running.lock().unwrap() = false;
            me.running_cv.notify_all();
        });
    }

    /// Wait until no pass runs (for tests and the shutdown).
    pub fn settled(&self) {
        let mut r = self.running.lock().unwrap();
        while *r {
            r = self.running_cv.wait(r).unwrap();
        }
    }

    /// kick() and wait for it.
    pub fn kick_and_wait(self: &Arc<Self>) {
        self.kick();
        self.settled();
    }

    fn run_pass(&self) {
        let before = self.status().indexed;
        self.status.lock().unwrap().running = true;
        loop {
            self.again.store(false, Ordering::SeqCst);
            // the newest logs first, and those without waiting for the converter: they are the car
            // now (the Stream Deck's live stats, the Nerd panel's live view), and one is a minute's
            // work; the older ones (a catch-up) wait for an idle moment, oldest first
            let now = (self.now)();
            let fresh = |j: &Job| now - (j.started_at as f64) < FRESH_MS;
            let (mut todo, older): (Vec<Job>, Vec<Job>) = self.pending_logs().into_iter().partition(|j| fresh(j));
            todo.sort_by(|a, b| b.started_at.cmp(&a.started_at));
            todo.extend(older);
            self.status.lock().unwrap().pending = todo.len() as i64;
            if !todo.is_empty() {
                self.progress();
            }
            for job in todo {
                while !fresh(&job) && !(self.idle)() {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                }
                self.status.lock().unwrap().current = Some(job.name.clone());
                self.progress();
                match self.index_log(&job.key, &job.name, job.raw_only, job.trust.as_deref(), Some(&job.profile)) {
                    Ok(r) => {
                        if r.car_changed && self.profile_for(&job.key) != job.profile {
                            self.again.store(true, Ordering::SeqCst);
                        }
                        self.with_done(|d| d.insert(format!("{}/{}", job.key, job.name), Value::String(job.stamp.clone())));
                        self.save_done();
                        self.status.lock().unwrap().indexed += 1;
                        (self.log)("info", &format!("CAN index: {}: {} frames, {} minute(s)", job.name, r.frames, r.minutes));
                        if let Some(t) = &r.truncated {
                            let e = format!("{}: {} (what was read before is indexed)", job.name, t);
                            (self.log)("warn", &format!("CAN index: {}", e));
                            self.status.lock().unwrap().last_error = Some(e);
                        }
                        (self.on_indexed)(&job.key, r.from, r.to);
                    }
                    Err(err) => {
                        let e = format!("{}: {}", job.name, err.message);
                        (self.log)("warn", &format!("CAN index: {}", e));
                        self.status.lock().unwrap().last_error = Some(e);
                        if !err.retry {
                            self.with_done(|d| d.insert(format!("{}/{}", job.key, job.name), Value::String(job.stamp.clone())));
                            self.save_done();
                        }
                    }
                }
                self.status.lock().unwrap().pending -= 1;
            }
            if !self.again.load(Ordering::SeqCst) && self.auto_repack {
                self.repack(&|| self.again.load(Ordering::SeqCst));
            }
            if !self.again.load(Ordering::SeqCst) {
                break;
            }
        }
        let worked;
        {
            let mut s = self.status.lock().unwrap();
            s.running = false;
            s.current = None;
            s.last_at = Some((self.now)());
            worked = s.indexed != before || s.last_error.is_some();
        }
        if worked {
            self.progress();
        }
    }

    // ---- reading back
    /// clipData: the signals of these cars between two times (the value before `from` too), and the worst trust.
    pub fn clip_data(&self, keys: &[String], from: f64, to: f64, names: Option<&HashSet<String>>, step: f64, drop_repeats: bool, changing: Option<&mut Vec<String>>) -> (IndexMap<String, Vec<(f64, f64)>>, Option<String>) {
        let mut out: IndexMap<String, Vec<(f64, f64)>> = IndexMap::new();
        let mut trust: Option<String> = None;
        for key in keys {
            let mut t = (from / 60000.0).floor() * 60000.0 - 60000.0;
            while t <= to {
                let data = self.read_minute(key, &minute_key(t), true);
                if let Some(d) = data.as_ref() {
                    if t + 60000.0 > from {
                        trust = worse_trust(trust, Some(d.trust.clone().unwrap_or_else(|| "unsigned".into())));
                    }
                    for (name, pts) in &d.signals {
                        if names.is_some_and(|w| !w.contains(name)) {
                            continue;
                        }
                        let list = out.entry(name.clone()).or_default();
                        for (ms, v) in pts {
                            list.push((t + ms, *v));
                        }
                    }
                }
                t += 60000.0;
            }
        }
        let mut changing = changing;
        let names_now: Vec<String> = out.keys().cloned().collect();
        for name in names_now {
            let pts = out.get_mut(&name).unwrap();
            let unsorted = pts.windows(2).any(|w| w[1].0 < w[0].0);
            if keys.len() > 1 || unsorted {
                pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            }
            let mut i = 0;
            while i + 1 < pts.len() && pts[i + 1].0 <= from {
                i += 1;
            }
            let mut end = i;
            while end < pts.len() && pts[end].0 <= to {
                end += 1;
            }
            if end == i {
                out.shift_remove(&name);
                continue;
            }
            let mut kept: Vec<(f64, f64)> = pts[i..end].to_vec();
            if let Some(ch) = changing.as_deref_mut() {
                if kept.iter().any(|p| p.1 != kept[0].1) && !ch.contains(&name) {
                    ch.push(name.clone());
                }
            }
            if step > 0.0 {
                kept = thin(&kept, from, step, drop_repeats);
            }
            *out.get_mut(&name).unwrap() = kept;
        }
        (out, trust)
    }

    pub fn series(&self, keys: &[String], from: f64, to: f64, names: Option<&HashSet<String>>) -> IndexMap<String, Vec<(f64, f64)>> {
        self.clip_data(keys, from, to, names, 0.0, false, None).0
    }

    /// raw: every CAN id of these cars between two times, for the Viewer's raw view.
    pub fn raw(&self, keys: &[String], from: f64, to: f64) -> Vec<Value> {
        struct E {
            key: String,
            pts: Vec<(f64, String)>,
            frames: f64,
            ms: f64,
            bus: Option<String>,
            internal: bool,
            dbc: Arc<Dbc>,
        }
        let mut out: IndexMap<String, E> = IndexMap::new();
        for key in keys {
            let dbc = Self::dbc_of(&self.profile_for(key));
            let mut t = (from / 60000.0).floor() * 60000.0 - 60000.0;
            while t <= to {
                let data = self.read_raw(key, &minute_key(t));
                if let Some(d) = data.as_ref() {
                    let entry = |out: &mut IndexMap<String, E>, id: &str| {
                        if !out.contains_key(id) {
                            out.insert(id.to_string(), E { key: id.to_string(), pts: Vec::new(), frames: 0.0, ms: 0.0, bus: None, internal: false, dbc: dbc.clone() });
                        }
                    };
                    for (id, pts) in &d.raw {
                        entry(&mut out, id);
                        let e = out.get_mut(id).unwrap();
                        for (ms, hex) in pts {
                            e.pts.push((t + ms, hex.clone()));
                        }
                    }
                    let inside = t + 60000.0 > from;
                    if let Some(logs) = &d.logs {
                        for k in json::ordered_keys(logs) {
                            let lg = &logs[k];
                            let sp = lg.get("span").and_then(|s| s.as_array());
                            let s1 = sp.and_then(|s| s.get(1)).and_then(|x| x.as_f64()).unwrap_or(0.0);
                            let s0 = sp.and_then(|s| s.first()).and_then(|x| x.as_f64()).unwrap_or(0.0);
                            let span = (s1 - s0).max(1000.0);
                            let Some(Value::Object(ids)) = lg.get("ids") else { continue };
                            for id in json::ordered_keys(ids) {
                                entry(&mut out, id);
                                let e = out.get_mut(id).unwrap();
                                let iface = id.split(':').next().unwrap_or("");
                                if e.bus.is_none() {
                                    e.bus = lg.get("buses").and_then(|b| b.get(iface)).and_then(|b| b.as_str()).filter(|s| !s.is_empty()).map(String::from);
                                }
                                if !e.internal {
                                    e.internal = lg.get("internal").and_then(|i| i.as_array()).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(iface)));
                                }
                                if inside {
                                    e.frames += ids[id].as_f64().unwrap_or(f64::NAN);
                                    e.ms += span;
                                }
                            }
                        }
                    }
                }
                t += 60000.0;
            }
        }
        let mut list: Vec<(u64, String, Value)> = Vec::new();
        for e in out.values_mut() {
            e.pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            let mut i = 0;
            while i + 1 < e.pts.len() && e.pts[i + 1].0 <= from {
                i += 1;
            }
            let mut changes: Vec<(f64, String)> = Vec::new();
            let mut k = i;
            while k < e.pts.len() && e.pts[k].0 <= to {
                if changes.last().is_none_or(|c| c.1 != e.pts[k].1) {
                    changes.push(e.pts[k].clone());
                }
                k += 1;
            }
            if changes.is_empty() {
                continue;
            }
            let (iface, hex_id) = e.key.split_once(':').unwrap_or((&e.key, ""));
            let id = u32::from_str_radix(hex_id, 16).ok();
            let msg = id.and_then(|i| e.dbc.messages.get(&i));
            let bus_of: IndexMap<String, String> = e.bus.iter().map(|b| (iface.to_string(), b.clone())).collect();
            let internal: Vec<String> = if e.internal { vec![iface.to_string()] } else { Vec::new() };
            let known = id.is_some_and(|i| decoded_on(msg, i, iface, &bus_of, &internal));
            let hz = if e.ms != 0.0 { json::round((e.frames / e.ms) * 10000.0) / 10.0 } else { 0.0 };
            list.push((
                id.map_or(u64::MAX, |x| x as u64),
                iface.to_string(),
                json!({ "key": e.key, "bus": iface, "id": hex_id, "name": if known { Value::String(msg.unwrap().name.clone()) } else { Value::Null }, "hz": n(hz), "changes": changes.iter().map(|c| json!([n(c.0), c.1])).collect::<Vec<_>>() }),
            ));
        }
        list.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| util::locale_cmp(&a.1, &b.1)));
        list.into_iter().map(|x| x.2).collect()
    }

    /// signals(keys): every signal seen for these cars.
    pub fn signals(&self, keys: &[String]) -> Map<String, Value> {
        let mut all = Map::new();
        for key in keys {
            if let Some(Value::Object(m)) = util::read_json(&self.dir.join(key).join("signals.json")) {
                for k in json::ordered_keys(&m) {
                    all.insert(k.clone(), m[k].clone());
                }
            }
        }
        all
    }

    pub fn forget(&self, key: &str, name: &str) {
        self.with_done(|d| d.shift_remove(&format!("{}/{}", key, name)));
        self.save_done();
    }

    /// removeLog: one log's data taken out of the index.
    pub fn remove_log(&self, key: &str, name: &str) -> usize {
        let Some(nm) = parse_name(name) else { return 0 };
        let mut count = 0;
        let mut t = nm.started_at - 2 * 60_000;
        while t <= nm.started_at + 30 * 60_000 {
            let lock = self.lock_of(key);
            let _g = lock.lock().unwrap();
            if self.remove_from_minute(key, &minute_key(t as f64), name) {
                count += 1;
            }
            t += 60_000;
        }
        self.forget(key, name);
        count
    }

    fn remove_from_minute(&self, key: &str, minute: &str, name: &str) -> bool {
        let mut removed = false;
        if let Some(had) = format::read_minute_file(&self.minute_file(key, minute)) {
            if let Some(part) = had.logs.as_ref().and_then(|l| l.get(name)).filter(|v| json::truthy(Some(v))) {
                let empty = IndexMap::new();
                let (signals, ids) = without_part(&had.signals, had.ids.as_ref().unwrap_or(&empty), Some(part));
                let mut logs = had.logs.clone().unwrap();
                logs.shift_remove(name);
                let file = self.minute_file(key, minute);
                self.day_changed(key, minute);
                if logs.is_empty() {
                    let _ = std::fs::remove_file(&file);
                } else {
                    let mut trust = None;
                    for p in logs.values() {
                        trust = worse_trust(trust, p.get("trust").and_then(|t| t.as_str()).map(String::from));
                    }
                    let _ = write_atomic(&file, &format::gzip(&Minute::encode(&had.minute.clone().unwrap_or(Value::Null), trust.as_deref(), &logs, &signals, &ids)));
                }
                self.changed(key, minute);
                removed = true;
            }
        }
        if let Some(raw) = self.raw_now(key, minute) {
            if let Some(part) = raw.logs.as_ref().and_then(|l| l.get(name)).filter(|v| json::truthy(Some(v))) {
                let empty = IndexMap::new();
                let (rest, _) = without_part(&raw.raw, &empty, Some(part));
                let mut logs = raw.logs.clone().unwrap();
                logs.shift_remove(name);
                let file = self.raw_file(key, minute);
                if logs.is_empty() {
                    let _ = std::fs::remove_file(&file);
                } else {
                    let r = RawMinute { minute: raw.minute.clone(), raw: rest, logs: Some(logs), rest: raw.rest.clone() };
                    let _ = write_atomic(&file, &format::gzip(&r.encode()));
                }
                self.raw_drop(key, minute);
                self.generation.fetch_add(1, Ordering::SeqCst);
            }
        }
        removed
    }

    /// minuteTimes: one car key's minute times between two times, oldest first.
    pub fn minute_times(&self, key: &str, from: f64, to: f64) -> Vec<f64> {
        let Some(names) = util::names(&self.dir.join(key)) else { return Vec::new() };
        let mut v: Vec<f64> = names.iter().filter_map(|f| minute_of_file(f)).filter(|t| t + 60_000.0 > from && *t <= to).collect();
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v
    }

    pub fn head_of(&self, key: &str, t: f64) -> Option<Map<String, Value>> {
        format::read_head(&self.minute_file(key, &minute_key(t)))
    }

    /// messageName: the DBC message of an id on a bus map, or None.
    pub fn message_name(&self, id_key: &str, bus_of: Option<&IndexMap<String, String>>, internal: &[String], profile: &str) -> Option<String> {
        let (iface, hex_id) = id_key.split_once(':').unwrap_or((id_key, ""));
        let id = parse_int_hex(hex_id)?;
        let dbc = Self::dbc_of(profile);
        let msg = dbc.messages.get(&id);
        let def: IndexMap<String, String>;
        let b = match bus_of {
            Some(b) => b,
            None => {
                def = [("can0".to_string(), "VehicleBus".to_string()), ("can1".to_string(), "ChassisBus".to_string())].into_iter().collect();
                &def
            }
        };
        decoded_on(msg, id, iface, b, internal).then(|| msg.unwrap().name.clone())
    }

    /// idSummary: every CAN id of one car key between two times, from the frame counts.
    pub fn id_summary(&self, key: &str, from: f64, to: f64, stop: &dyn Fn() -> bool) -> Vec<IdSum> {
        struct E {
            bus: String,
            id: String,
            name: Option<String>,
            frames: f64,
            ms: f64,
            first: f64,
            last: f64,
            minutes: HashSet<i64>,
        }
        let profile = self.profile_for(key);
        let dbc = Self::dbc_of(&profile);
        let mut buses: HashMap<String, (IndexMap<String, String>, Vec<String>)> = HashMap::new();
        let mut out: IndexMap<String, E> = IndexMap::new();
        for t in self.minute_times(key, from, to) {
            if stop() {
                break;
            }
            let Some(data) = self.head_of(key, t) else { continue };
            let Some(Value::Object(logs)) = data.get("logs") else { continue };
            for name in json::ordered_keys(logs) {
                let part = &logs[name];
                let Some(Value::Object(ids)) = part.get("ids").filter(|v| json::truthy(Some(v))) else { continue };
                let (a, b) = if part.get("span").is_some_and(|s| s.is_array()) { span_of(Some(part)).unwrap() } else { (0.0, 59_999.0) };
                let ms = (b - a).max(1000.0);
                if !buses.contains_key(name) {
                    let side = if parse_name(name).is_some() { util::read_json(&self.can_dir.join(key).join(format!("{}.json", name))).filter(|v| json::truthy(Some(v))).unwrap_or(json!({})) } else { json!({}) };
                    buses.insert(name.clone(), (bus_map_of(&side, &dbc.buses), internal_buses_of(&side)));
                }
                let (bus_of, internal) = buses.get(name).unwrap().clone();
                for id_key in json::ordered_keys(ids) {
                    if !good_id(id_key) {
                        continue;
                    }
                    let c = ids[id_key].as_f64().unwrap_or(f64::NAN);
                    if !out.contains_key(id_key) {
                        let (iface, hex) = id_key.split_once(':').unwrap_or((id_key, ""));
                        out.insert(id_key.clone(), E { bus: iface.into(), id: hex.into(), name: self.message_name(id_key, Some(&bus_of), &internal, &profile), frames: 0.0, ms: 0.0, first: t + a, last: t + b, minutes: HashSet::new() });
                    }
                    let e = out.get_mut(id_key).unwrap();
                    e.frames += c;
                    e.ms += ms;
                    e.first = e.first.min(t + a);
                    e.last = e.last.max(t + b);
                    e.minutes.insert(t as i64);
                }
            }
        }
        let mut v: Vec<IdSum> = out
            .into_iter()
            .map(|(k, e)| IdSum { key: k, bus: e.bus, hz: json::round((e.frames / e.ms) * 10000.0) / 10.0, id: e.id, name: e.name, frames: e.frames, first_seen: e.first, last_seen: e.last, minutes: e.minutes.len() })
            .collect();
        v.sort_by(|x, y| parse_int_hex(&x.id).map_or(f64::NAN, |a| a as f64).partial_cmp(&parse_int_hex(&y.id).map_or(f64::NAN, |a| a as f64)).unwrap_or(std::cmp::Ordering::Equal).then_with(|| util::locale_cmp(&x.bus, &y.bus)));
        v
    }

    fn id_day(&self, key: &str, day: &str, times: &[f64]) -> IndexMap<String, (f64, f64, f64)> {
        let file = self.dir.join(key).join(format!("ids-{}.json", day));
        if let Some(saved) = util::read_json(&file) {
            if saved.get("v").and_then(|v| v.as_str()) == Some(ID_DAY) {
                if let Some(Value::Object(ids)) = saved.get("ids").filter(|v| json::truthy(Some(v))) {
                    let mut out = IndexMap::new();
                    for k in json::ordered_keys(ids) {
                        let a = ids[k].as_array();
                        let g = |i: usize| a.and_then(|a| a.get(i)).and_then(|x| x.as_f64()).unwrap_or(f64::NAN);
                        out.insert(k.clone(), (g(0), g(1), g(2)));
                    }
                    return out;
                }
            }
        }
        let dk = format!("{}/{}", key, day);
        let gen = *self.day_gen.lock().unwrap().get(&dk).unwrap_or(&0);
        let mut ids: IndexMap<String, (f64, f64, f64)> = IndexMap::new();
        for &t in times {
            let head = self.head_of(key, t);
            let here = format::ids_of_head(head.as_ref()).or_else(|| self.read_minute(key, &minute_key(t), false).as_ref().as_ref().and_then(|m| m.ids.clone()));
            let Some(here) = here else { continue };
            for k in here.keys() {
                if !good_id(k) {
                    continue;
                }
                match ids.get_mut(k) {
                    None => {
                        ids.insert(k.clone(), (t, t, 1.0));
                    }
                    Some(e) => {
                        e.0 = e.0.min(t);
                        e.1 = e.1.max(t);
                        e.2 += 1.0;
                    }
                }
            }
        }
        if *self.day_gen.lock().unwrap().get(&dk).unwrap_or(&0) == gen {
            let v = json!({ "v": ID_DAY, "ids": ids.iter().map(|(k, e)| (k.clone(), json!([n(e.0), n(e.1), n(e.2)]))).collect::<Map<String, Value>>() });
            let _ = write_atomic(&file, json::stringify(&v).as_bytes());
        }
        ids
    }

    /// newIds: CAN ids first seen in the minute of `since` or later.
    pub fn new_ids(&self, key: &str, since: f64, limit: usize, stop: &dyn Fn() -> bool) -> Result<Value, (u16, String)> {
        let mut by_day: IndexMap<String, Vec<f64>> = IndexMap::new();
        for t in self.minute_times(key, f64::NEG_INFINITY, f64::INFINITY) {
            by_day.entry(minute_key(t)[..8].to_string()).or_default().push(t);
        }
        let mut all: IndexMap<String, (f64, f64, f64)> = IndexMap::new();
        for (day, times) in &by_day {
            if stop() {
                return Err((409, "The search was stopped.".into()));
            }
            for (k, (a, b, c)) in self.id_day(key, day, times) {
                match all.get_mut(&k) {
                    None => {
                        all.insert(k, (a, b, c));
                    }
                    Some(e) => {
                        e.0 = e.0.min(a);
                        e.1 = e.1.max(b);
                        e.2 += c;
                    }
                }
            }
        }
        let from = (since / 60_000.0).floor() * 60_000.0;
        let mut appeared: Vec<(String, f64, f64, f64)> = all.iter().filter(|(_, e)| e.0 >= from).map(|(id, e)| (id.clone(), e.0, e.1 + 59_999.0, e.2)).collect();
        appeared.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal).then_with(|| util::locale_cmp(&a.0, &b.0)));
        let total: usize = by_day.values().map(|t| t.len()).sum();
        Ok(json!({
            "appeared": appeared.iter().take(limit).map(|a| json!({ "id": a.0, "at": n(a.1), "lastSeen": n(a.2), "seenMinutes": n(a.3) })).collect::<Vec<_>>(),
            "appearedCount": appeared.len(), "idCount": all.len(), "totalMinutes": total, "scannedMinutes": total, "complete": true
        }))
    }

    // ---- repacking
    fn enc_of(file: &Path) -> Option<Option<String>> {
        use std::io::Read;
        let mut f = std::fs::File::open(file).ok()?;
        let mut buf = vec![0u8; 512];
        let k = f.read(&mut buf).ok()?;
        let mut d = flate2::read::GzDecoder::new(&buf[..k]);
        let mut text = Vec::new();
        let mut tmp = [0u8; 512];
        loop {
            match d.read(&mut tmp) {
                Ok(0) => break,
                Ok(m) => text.extend_from_slice(&tmp[..m]),
                Err(_) => {
                    if text.is_empty() {
                        return None;
                    }
                    break;
                }
            }
        }
        let head: String = String::from_utf8_lossy(&text[..text.len().min(200)]).into_owned();
        let at = head.find("\"enc\":\"")?;
        let rest = &head[at + 7..];
        let end = rest.find('"').unwrap_or(rest.len());
        let w = &rest[..end];
        Some((!w.is_empty() && w.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') && rest.len() > end).then(|| w.to_string()))
    }
    fn decoded_now(logs: Option<&Value>, profile: &str) -> bool {
        let Some(Value::Object(l)) = logs else { return false };
        !l.contains_key("") && l.values().all(|p| still_right(p.get("fmt").and_then(|f| f.as_str()), profile))
    }
    fn minute_state(file: &Path, profile: &str) -> Option<&'static str> {
        let head = format::read_head(file)?;
        if !Self::decoded_now(head.get("logs"), profile) {
            return Some("stale");
        }
        Some(if Self::enc_of(file).flatten().as_deref() == Some(format::ENC) { "ok" } else { "layout" })
    }

    /// repack: older minute files written again (columns, without an older decoding's signals).
    pub fn repack(&self, should_stop: &dyn Fn() -> bool) -> usize {
        let pack_file = self.dir.join("packed.json");
        let mut packed = util::read_json(&pack_file).and_then(|v| v.as_object().cloned()).unwrap_or_default();
        let mut count = 0;
        let mut stripped = 0;
        for key in util::subdirs(&self.dir) {
            let profile = self.profile_for(&key);
            let stamp = format!("{}/{}{}", format::ENC, FORMAT, profile_stamp(&profile));
            if packed.get(&key).and_then(|v| v.as_str()) == Some(stamp.as_str()) {
                continue;
            }
            let Some(mut names) = util::names(&self.dir.join(&key)) else { continue };
            let mut finished = true;
            let (mut from, mut to) = (f64::INFINITY, f64::NEG_INFINITY);
            names.sort();
            names.reverse();
            for name in names {
                let is_minute = minute_of_file(&name).is_some();
                let raw_minute = raw_minute_of_file(&name).map(String::from);
                if !is_minute && raw_minute.is_none() {
                    continue;
                }
                if should_stop() {
                    finished = false;
                    break;
                }
                while !(self.idle)() && !should_stop() {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                }
                let file = self.dir.join(&key).join(&name);
                if is_minute {
                    let was = Self::minute_state(&file, &profile);
                    if was != Some("layout") && was != Some("stale") {
                        continue;
                    }
                } else if Self::enc_of(&file).map(|e| e.is_some()).unwrap_or(true) {
                    // (current, or unreadable)
                    if Self::enc_of(&file).is_some() {
                        continue;
                    }
                }
                let lock = self.lock_of(&key);
                let _g = lock.lock().unwrap();
                if is_minute {
                    let state = Self::minute_state(&file, &profile);
                    if state != Some("layout") && state != Some("stale") {
                        continue;
                    }
                    let minute = &name[..13];
                    let Some(data) = format::read_minute_file(&file) else { continue };
                    let mut logs = data.logs.clone();
                    let mut signals = data.signals.clone();
                    if state == Some("stale") {
                        match logs.as_mut() {
                            Some(l) if !l.contains_key("") => {
                                let right: Vec<&Value> = l.values().filter(|p| still_right(p.get("fmt").and_then(|f| f.as_str()), &profile)).collect();
                                signals = only_in_spans(&signals, &right);
                                let pf = part_format(&profile);
                                for (_, part) in l.iter_mut() {
                                    if !still_right(part.get("fmt").and_then(|f| f.as_str()), &profile) {
                                        if let Some(o) = part.as_object_mut() {
                                            o.insert("fmt".into(), Value::String(pf.clone()));
                                        }
                                    }
                                }
                            }
                            _ => signals = IndexMap::new(),
                        }
                        let t = minute_of_file(&name).unwrap();
                        from = from.min(t);
                        to = to.max(t + 59_999.0);
                        stripped += 1;
                    }
                    self.day_changed(&key, minute);
                    let m = data.minute.clone().filter(|v| !v.is_null()).unwrap_or(Value::String(minute.into()));
                    let text = encode_any(&m, data.trust.as_deref(), logs.as_ref(), &signals, data.ids.as_ref());
                    let _ = write_atomic(&file, &format::gzip(&text));
                    self.changed(&key, minute);
                } else {
                    let rm = raw_minute.unwrap();
                    if Self::enc_of(&file).is_some_and(|e| e.is_some()) {
                        continue;
                    }
                    let Some(data) = self.raw_now(&key, &rm) else { continue };
                    let _ = write_atomic(&file, &format::gzip(&data.encode()));
                    self.raw_drop(&key, &rm);
                }
                count += 1;
            }
            if from <= to {
                (self.on_indexed)(&key, Some(from), Some(to));
            }
            if finished {
                packed.insert(key.clone(), Value::String(stamp));
                let _ = std::fs::create_dir_all(&self.dir);
                let _ = write_atomic(&pack_file, json::stringify(&Value::Object(packed.clone())).as_bytes());
            } else {
                break;
            }
        }
        if count > 0 {
            (self.log)("info", &format!("CAN index: {} older minute file(s) written again{}", count, if stripped > 0 { format!(" ({} without what an older decoding wrote)", stripped) } else { String::new() }));
        }
        count
    }
}

/// encodeMinute for a minute whose logs may be missing (JSON.stringify leaves an undefined key out).
fn encode_any(minute: &Value, trust: Option<&str>, logs: Option<&Map<String, Value>>, signals: &Signals, ids: Option<&IndexMap<String, f64>>) -> String {
    let mut o = Map::new();
    o.insert("minute".into(), minute.clone());
    o.insert("enc".into(), Value::String(format::ENC.into()));
    o.insert("act".into(), Value::String(format::act_letter(format::classify(signals)).into()));
    if let Some(t) = trust {
        o.insert("trust".into(), Value::String(t.into()));
    }
    if let Some(l) = logs {
        o.insert("logs".into(), Value::Object(l.clone()));
    }
    o.insert("signals".into(), format::signals_to_columns(signals));
    o.insert("ids".into(), format::ids_value(ids.unwrap_or(&IndexMap::new())));
    json::stringify(&Value::Object(o))
}

pub fn parse_int_hex(s: &str) -> Option<u32> {
    // parseInt(s, 16): the leading hex digits
    let digits: String = s.trim_start().chars().take_while(|c| c.is_ascii_hexdigit()).collect();
    if digits.is_empty() {
        return None;
    }
    u64::from_str_radix(&digits[..digits.len().min(15)], 16).ok().map(|v| v as u32)
}

#[derive(Debug, Clone)]
pub struct IdSum {
    pub key: String,
    pub bus: String,
    pub id: String,
    pub name: Option<String>,
    pub frames: f64,
    pub hz: f64,
    pub first_seen: f64,
    pub last_seen: f64,
    pub minutes: usize,
}

/// thin: the last value of each step (from `from`); dropRepeats leaves out a value the same as the one kept before.
fn thin(pts: &[(f64, f64)], from: f64, step: f64, drop_repeats: bool) -> Vec<(f64, f64)> {
    let mut out = vec![pts[0]];
    for k in 1..pts.len() {
        let p = pts[k];
        if let Some(next) = pts.get(k + 1) {
            if ((next.0 - from) / step).floor() == ((p.0 - from) / step).floor() {
                continue;
            }
        }
        if !drop_repeats || p.1 != out.last().unwrap().1 {
            out.push(p);
        }
    }
    out
}

// ---- decoding one log
struct Write {
    minute: String,
    signals: Signals,
    ids: IndexMap<String, f64>,
    raw: RawMinute,
    part: Value,
}

struct Last {
    pt: f64,
    v: Option<f64>,
    pending: Option<(f64, f64)>,
}
struct RawLast {
    v: Option<String>,
    sec: f64,
    n: u32,
    pending: Option<(f64, String)>,
}

enum Step {
    Ok,
    BadTime,
}

struct Builder<'a> {
    name: String,
    fmt_now: String,
    trust: Option<String>,
    bus_of: IndexMap<String, String>,
    internal: Vec<String>,
    dbc: &'a Dbc,
    raw_only: bool,
    car_sent: HashMap<u32, f64>,
    vin: VinCollector,
    seen: IndexMap<String, Value>,
    minute: Option<String>,
    minute_start: f64,
    minute_no: Option<f64>,
    signals: Option<Signals>,
    ids: IndexMap<String, f64>,
    last: IndexMap<String, Last>,
    raw_last: IndexMap<String, RawLast>,
    raw: Raw,
    span: (f64, f64),
    raw_ids: IndexMap<String, f64>,
    writes: Vec<Write>,
    frames: u64,
    written: u64,
    first: Option<f64>,
    last_t: Option<f64>,
    decoded: Vec<(&'a dbc::Signal, f64)>,
}

fn ws(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | 0x0b | 0x0c | b'\r' | b'\n' | 0xa0)
}

/// LINE: (sec.frac) iface id#hex, the parts as found, or None.
fn parse_line(l: &[u8]) -> Option<(&str, &str, &str, &str, &str)> {
    if l.first() != Some(&b'(') {
        return None;
    }
    let mut i = 1;
    let s0 = i;
    while i < l.len() && l[i].is_ascii_digit() {
        i += 1;
    }
    if i == s0 || l.get(i) != Some(&b'.') {
        return None;
    }
    let sec = &l[s0..i];
    i += 1;
    let f0 = i;
    while i < l.len() && l[i].is_ascii_digit() {
        i += 1;
    }
    if i == f0 || l.get(i) != Some(&b')') {
        return None;
    }
    let frac = &l[f0..i];
    i += 1;
    let w0 = i;
    while i < l.len() && ws(l[i]) {
        i += 1;
    }
    if i == w0 {
        return None;
    }
    let a0 = i;
    if !l.get(i).is_some_and(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    i += 1;
    while i < l.len() && (l[i].is_ascii_alphanumeric() || l[i] == b'_') {
        i += 1;
    }
    if i - a0 > 16 {
        return None;
    }
    let iface = &l[a0..i];
    let w1 = i;
    while i < l.len() && ws(l[i]) {
        i += 1;
    }
    if i == w1 {
        return None;
    }
    let d0 = i;
    while i < l.len() && l[i].is_ascii_hexdigit() {
        i += 1;
    }
    if i == d0 || i - d0 > 8 || l.get(i) != Some(&b'#') {
        return None;
    }
    let id = &l[d0..i];
    i += 1;
    let h0 = i;
    while i < l.len() && l[i].is_ascii_hexdigit() {
        i += 1;
    }
    let hex = &l[h0..i];
    while i < l.len() && ws(l[i]) {
        i += 1;
    }
    if i != l.len() {
        return None;
    }
    fn s(b: &[u8]) -> &str {
        std::str::from_utf8(b).unwrap()
    }
    Some((s(sec), s(frac), s(iface), s(id), s(hex)))
}

fn hex_bytes(h: &str) -> Vec<u8> {
    let b = h.as_bytes();
    (0..b.len() / 2).map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap_or(0)).collect()
}

impl<'a> Builder<'a> {
    fn new(name: &str, fmt_now: &str, trust: Option<&str>, bus_of: IndexMap<String, String>, internal: Vec<String>, dbc: &'a Dbc, raw_only: bool) -> Self {
        Builder {
            name: name.into(),
            fmt_now: fmt_now.into(),
            trust: trust.map(String::from),
            bus_of,
            internal,
            dbc,
            raw_only,
            car_sent: HashMap::new(),
            vin: VinCollector::default(),
            seen: IndexMap::new(),
            minute: None,
            minute_start: 0.0,
            minute_no: None,
            signals: None,
            ids: IndexMap::new(),
            last: IndexMap::new(),
            raw_last: IndexMap::new(),
            raw: IndexMap::new(),
            span: (0.0, 0.0),
            raw_ids: IndexMap::new(),
            writes: Vec::new(),
            frames: 0,
            written: 0,
            first: None,
            last_t: None,
            decoded: Vec::new(),
        }
    }

    fn keep_raw(raw: &mut Raw, id_key: &str, t: f64, start: f64, hex: &str) {
        let v = raw.entry(id_key.to_string()).or_default();
        v.push((json::round(t - start), hex.to_uppercase()));
    }

    fn flush(&mut self) {
        let Some(bucket) = self.signals.as_mut() else { return };
        for (nm, s) in self.last.iter_mut() {
            if let Some(p) = s.pending.take() {
                bucket.entry(nm.clone()).or_default().push((p.0 - self.minute_start, p.1));
                s.pt = p.0;
            }
        }
        for (id, s) in self.raw_last.iter_mut() {
            if let Some(p) = s.pending.take() {
                Self::keep_raw(&mut self.raw, id, p.0, self.minute_start, &p.1);
            }
        }
    }

    fn close_minute(&mut self) {
        if self.signals.is_none() {
            return;
        }
        self.flush();
        let ids_v = format::ids_value(&self.raw_ids);
        let mut part = Map::new();
        part.insert("span".into(), json!([n(self.span.0), n(self.span.1)]));
        part.insert("ids".into(), ids_v.clone());
        if let Some(t) = &self.trust {
            part.insert("trust".into(), Value::String(t.clone()));
        }
        part.insert("fmt".into(), Value::String(self.fmt_now.clone()));
        let mut raw_log = Map::new();
        raw_log.insert("span".into(), json!([n(self.span.0), n(self.span.1)]));
        raw_log.insert("buses".into(), bus_map_value(&self.bus_of));
        if !self.internal.is_empty() {
            raw_log.insert("internal".into(), json!(self.internal));
        }
        raw_log.insert("ids".into(), ids_v);
        let mut logs = Map::new();
        logs.insert(self.name.clone(), Value::Object(raw_log));
        let minute = self.minute.clone().unwrap();
        self.writes.push(Write {
            minute: minute.clone(),
            signals: self.signals.take().unwrap(),
            ids: std::mem::take(&mut self.ids),
            raw: RawMinute { minute: Some(Value::String(minute)), raw: std::mem::take(&mut self.raw), logs: Some(logs), rest: Map::new() },
            part: Value::Object(part),
        });
        self.raw_ids = IndexMap::new();
    }

    fn line(&mut self, l: &[u8]) -> Step {
        let Some((sec, frac, iface, idh, hex)) = parse_line(l) else { return Step::Ok };
        let t = sec.parse::<f64>().unwrap_or(f64::INFINITY) * 1000.0 + format!("0.{}", frac).parse::<f64>().unwrap_or(0.0) * 1000.0;
        let no = (t / 60000.0).floor();
        if self.minute_no != Some(no) {
            if self.minute.is_some() {
                self.written += 1;
            }
            self.close_minute();
            self.minute_no = Some(no);
            self.minute_start = no * 60000.0;
            if !self.minute_start.is_finite() || self.minute_start.abs() > 8.64e15 {
                return Step::BadTime;
            }
            let mk = minute_key(self.minute_start);
            self.minute = Some(mk);
            self.signals = Some(IndexMap::new());
            self.ids = IndexMap::new();
            let r = json::round(t - self.minute_start);
            self.span = (r, r);
            self.raw = IndexMap::new();
            self.raw_ids = IndexMap::new();
            for s in self.last.values_mut() {
                s.pt = f64::NEG_INFINITY;
            }
            for s in self.raw_last.values_mut() {
                s.v = None;
            }
        }
        self.frames += 1;
        if self.first.is_none() {
            self.first = Some(t);
        }
        self.last_t = Some(t);
        let id_key = format!("{}:{}", iface, idh.to_uppercase());
        *self.ids.entry(id_key.clone()).or_insert(0.0) += 1.0;
        *self.raw_ids.entry(id_key.clone()).or_insert(0.0) += 1.0;
        self.span.1 = json::round(t - self.minute_start);
        {
            let start = self.minute_start;
            let r = self.raw_last.entry(id_key.clone()).or_insert(RawLast { v: None, sec: -1.0, n: 0, pending: None });
            if r.v.as_deref() != Some(hex) {
                r.v = Some(hex.to_string());
                let s = (t / 1000.0).floor();
                if s != r.sec {
                    if let Some(p) = r.pending.take() {
                        Self::keep_raw(&mut self.raw, &id_key, p.0, start, &p.1);
                    }
                    r.sec = s;
                    r.n = 0;
                }
                if r.n < RAW_PER_SEC {
                    Self::keep_raw(&mut self.raw, &id_key, t, start, hex);
                    r.n += 1;
                    r.pending = None;
                } else {
                    r.pending = Some((t, hex.to_string()));
                }
            }
        }
        if self.vin.found.is_none() && (idh == "405" || idh == "508") {
            self.vin.add(u32::from_str_radix(idh, 16).unwrap(), &hex_bytes(hex));
        }
        if self.raw_only {
            return Step::Ok;
        }
        let Some(id) = parse_int_hex(idh) else { return Step::Ok };
        let Some(msg) = self.dbc.messages.get(&id) else { return Step::Ok };
        let mut only: Option<&[&str]> = None;
        match self.bus_of.get(iface) {
            Some(want) => {
                if &msg.bus != want {
                    return Step::Ok;
                }
                if internal_only(id).is_some() {
                    self.car_sent.insert(id, t);
                }
            }
            None => {
                only = internal_only(id);
                if only.is_none() || !self.internal.iter().any(|x| x == iface) {
                    return Step::Ok;
                }
                if let Some(car) = self.car_sent.get(&id) {
                    if (t - car).abs() < INTERNAL_YIELD_MS {
                        return Step::Ok;
                    }
                }
            }
        }
        let bytes = hex_bytes(hex);
        let mut decoded = std::mem::take(&mut self.decoded);
        decode_frame(msg, &bytes, &mut decoded);
        let bucket = self.signals.as_mut().unwrap();
        for (sig, v) in decoded.iter() {
            let nm = &sig.series;
            if only.is_some_and(|o| !o.contains(&nm.as_str())) {
                continue;
            }
            if !self.seen.contains_key(nm) {
                let label = sig.comment.clone().filter(|c| !c.is_empty()).unwrap_or_else(|| sig.name.clone());
                self.seen.insert(
                    nm.clone(),
                    json!({
                        "label": label, "signal": sig.name, "unit": sig.unit, "min": num_or_null(sig.min), "max": num_or_null(sig.max),
                        "factor": num_or_null(sig.factor), "offset": num_or_null(sig.offset), "values": sig.values.clone().map(Value::Object).unwrap_or(Value::Null),
                        "bus": sig.bus, "message": sig.message, "id": sig.message_id, "fmt": self.fmt_now
                    }),
                );
            }
            let s = match self.last.get_mut(nm) {
                Some(s) => s,
                None => {
                    self.last.insert(nm.clone(), Last { pt: f64::NEG_INFINITY, v: None, pending: None });
                    self.last.get_mut(nm).unwrap()
                }
            };
            let value = json::round(v * 1e6) / 1e6;
            if Some(value) == s.v && t - s.pt < KEEP_MS {
                if let Some(p) = s.pending {
                    if t - s.pt >= STEP_MS {
                        bucket.entry(nm.clone()).or_default().push((p.0 - self.minute_start, p.1));
                        s.pt = p.0;
                        s.pending = None;
                    }
                }
                continue;
            }
            s.v = Some(value);
            if t - s.pt >= STEP_MS {
                bucket.entry(nm.clone()).or_default().push((json::round(t - self.minute_start), value));
                s.pt = t;
                s.pending = None;
            } else {
                s.pending = Some((json::round(t), value));
            }
        }
        self.decoded = decoded;
        Step::Ok
    }
}

fn num_or_null(x: f64) -> Value {
    if x.is_finite() { n(x) } else { Value::Null }
}
