//! CAN logs from the Screenmate CAN Bridge as they arrive (server/canLogs.js):
//! names, resumable chunked uploads kept only once their SHA-256 matches,
//! which files are here, and the catalogue of every finished log the Nerd
//! panel lists.
//!
//!   <DATA>/can/<vehicleKey>/<name>.log.xz    a finished log
//!   <DATA>/can/<vehicleKey>/<name>.json      its sidecar
//!   <DATA>/can/<vehicleKey>/<name>.part      a log still arriving
//!   <DATA>/can/<vehicleKey>/<name>.part.json what that upload promised
//!
//! A `.part` next to a finished file of the same name is a new copy replacing one whose
//! check failed (the bridge's "Resend all"): the old copy stays until the new one is all here.
//!
//! A log deleted here on purpose (the owner, "Keeping logs", "Also delete its CAN data")
//! leaves a tombstone in its car's trust.json (see CanTrust::bury): `status` answers it as
//! delivered while its time is older than the car's oldest footage kept, else as missing.

use super::json::{self, n};
use super::trust::{CanTrust, Half};
use super::tz;
use super::util::{self, mtime_ms};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

pub const MAX_CHUNK: u64 = 16 * 1024 * 1024;
pub const MAX_FILE: u64 = 1024 * 1024 * 1024;
pub const MAX_SIDECAR: u64 = 1024 * 1024;
pub const MAX_LOGS_PER_CAR: usize = 200_000;
/// Unfinished uploads one car may have at once (`429 too_many_partial` past it).
pub const MAX_PARTIAL: usize = 16;
/// `ping`'s `maxParallel`: uploads a bridge should send at once. Half of `MAX_PARTIAL`, so
/// up to 8 uploads cut off earlier (still `.part` until resumed) never make a new one
/// `429 too_many_partial`; with `status` and `ping` beside them it stays far under the 32
/// connections one address may hold with a token (and under 6 + headroom per server).
pub const MAX_PARALLEL: usize = 8;
const RESCAN_MS: f64 = 10.0 * 60_000.0;

/// What `plan` found a chunk's checks leave to do.
enum Plan {
    /// the same file is all here: this answer
    Already(Value),
    /// write the chunk (`replacing`: a new copy of a finished file whose check failed)
    Write { replacing: bool },
    /// (before the body) a finished file of this name is here: whether this is the same file
    /// (`already`) or another copy (`exists_different`, or a replacement) needs its hash, which
    /// waits for the body
    Wait,
}

/// The oldest footage a car still keeps (on the share, in the Recycle Bin or protected), for
/// the logs deleted here: see `CanLogs::set_footage`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kept {
    /// no footage at all (or no car for the key): every deleted log is older
    Nothing,
    /// the start of its oldest clip (UTC ms)
    Since(f64),
    /// not known now (the share unreachable, a scan running or failed, a setting unreadable)
    Unknown,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Name {
    pub vehicle_key: String,
    pub started_at: i64,
    pub seq: i64,
    pub sidecar: bool,
}

fn key_ok(k: &str) -> bool {
    !k.is_empty() && k.len() <= 64 && k.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}
pub fn valid_key(k: &str) -> bool {
    key_ok(k)
}

/// parseName: what a file name says, or None.
pub fn parse_name(name: &str) -> Option<Name> {
    let (sidecar, base) = if let Some(b) = name.strip_suffix(".log.xz.json") {
        (true, b)
    } else if let Some(b) = name.strip_suffix(".log.xz") {
        (false, b)
    } else {
        return None;
    };
    let mut parts = base.rsplitn(3, '_');
    let seq = parts.next()?;
    let t = parts.next()?;
    let key = parts.next()?;
    if !key_ok(key) || seq.is_empty() || seq.len() > 6 || !seq.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let tb = t.as_bytes();
    if tb.len() != 16 || tb[8] != b'T' || tb[15] != b'Z' || !tb[..8].iter().chain(&tb[9..15]).all(|c| c.is_ascii_digit()) {
        return None;
    }
    let num = |a: usize, b: usize| t[a..b].parse::<i64>().unwrap();
    let (y, mo, d, h, mi, s) = (num(0, 4), num(4, 6), num(6, 8), num(9, 11), num(11, 13), num(13, 15));
    // Date.parse of an ISO string: out-of-range fields are no date
    if !(1..=12).contains(&mo) || d < 1 || d > 31 || h > 24 || mi > 59 || s > 59 || (h == 24 && (mi > 0 || s > 0)) {
        return None;
    }
    Some(Name { vehicle_key: key.to_string(), started_at: tz::utc_ms(y, mo, d, h, mi, s), seq: seq.parse().unwrap(), sidecar })
}

#[derive(Debug, Clone)]
pub struct CanError {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub received: Option<f64>,
}

pub fn can_error(status: u16, code: &str, message: impl Into<String>) -> CanError {
    CanError { status, code: code.into(), message: message.into(), received: None }
}
fn with_received(mut e: CanError, r: f64) -> CanError {
    e.received = Some(r);
    e
}

/// sideFacts: what the Nerd panel shows of a sidecar.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SideFacts {
    pub frames: Option<f64>,
    pub dropped: Option<f64>,
    pub app_version: Option<String>,
    pub format: Option<String>,
    pub closed_because: Option<String>,
}

fn word_ok(s: &str, max: usize, extra: &[u8]) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || extra.contains(&c))
}

pub fn side_facts(side: &Value) -> SideFacts {
    let fin = |k: &str| side.get(k).and_then(json::finite);
    SideFacts {
        frames: fin("frames"),
        dropped: fin("dropped_chunks").or_else(|| fin("dropped")),
        app_version: ["app_version", "appVersion"].iter().find_map(|k| side.get(*k).and_then(|v| v.as_str())).map(|s| util::utf16_slice(s, 40)),
        format: side.get("format").and_then(|v| v.as_str()).filter(|s| word_ok(s, 64, b"./-")).map(String::from),
        closed_because: side.get("closed_because").and_then(|v| v.as_str()).filter(|s| word_ok(s, 20, b"-")).map(String::from),
    }
}

#[derive(Debug, Clone)]
pub struct Row {
    pub name: String,
    pub vehicle_key: String,
    pub started_at_ms: i64,
    pub seq: i64,
    pub bytes: u64,
    pub mtime_ms: f64,
    pub side_bytes: u64,
    pub side_mtime: Option<f64>,
    pub side: Option<SideFacts>,
}

struct Cat {
    rows: HashMap<String, Row>,
    order: Vec<String>,
    orphan_bytes: u64,
    dir_mtime: Option<f64>,
    at: f64,
}

impl Cat {
    fn set(&mut self, r: Row) {
        if !self.rows.contains_key(&r.name) {
            self.order.push(r.name.clone());
        }
        self.rows.insert(r.name.clone(), r);
    }
    fn delete(&mut self, name: &str) {
        if self.rows.remove(name).is_some() {
            self.order.retain(|x| x != name);
        }
    }
    fn list(&self) -> Vec<&Row> {
        self.order.iter().filter_map(|n| self.rows.get(n)).collect()
    }
}

pub struct CanLogs {
    pub dir: PathBuf,
    free_bytes: Box<dyn Fn() -> f64 + Send + Sync>,
    now: Box<dyn Fn() -> f64 + Send + Sync>,
    max_files_per_car: usize,
    min_free: f64,
    busy: Mutex<HashSet<PathBuf>>,
    cats: Mutex<HashMap<String, Cat>>,
    loading: Mutex<()>,
    /// the checks (set once): status answers `check`, and a failed log may be replaced
    trust: OnceLock<Arc<CanTrust>>,
    /// (tests) run as a new copy is about to take a failed one's place
    before_swap: OnceLock<Box<dyn Fn() + Send + Sync>>,
    /// the oldest footage each car key's car keeps (set once; without it: `Kept::Nothing`)
    footage: OnceLock<Box<dyn Fn(&str) -> Kept + Send + Sync>>,
}

fn stat(p: &Path) -> Option<fs::Metadata> {
    fs::metadata(p).ok()
}

impl CanLogs {
    pub fn new(dir: PathBuf, free_bytes: Box<dyn Fn() -> f64 + Send + Sync>, now: Box<dyn Fn() -> f64 + Send + Sync>) -> Arc<CanLogs> {
        Arc::new(CanLogs { dir, free_bytes, now, max_files_per_car: MAX_LOGS_PER_CAR, min_free: 2.0 * 1024f64.powi(3), busy: Mutex::new(HashSet::new()), cats: Mutex::new(HashMap::new()), loading: Mutex::new(()), trust: OnceLock::new(), before_swap: OnceLock::new(), footage: OnceLock::new() })
    }
    pub fn with_limits(dir: PathBuf, max_files_per_car: usize, min_free: f64, free_bytes: Box<dyn Fn() -> f64 + Send + Sync>, now: Box<dyn Fn() -> f64 + Send + Sync>) -> Arc<CanLogs> {
        Arc::new(CanLogs { dir, free_bytes, now, max_files_per_car, min_free, busy: Mutex::new(HashSet::new()), cats: Mutex::new(HashMap::new()), loading: Mutex::new(()), trust: OnceLock::new(), before_swap: OnceLock::new(), footage: OnceLock::new() })
    }

    /// The checks the status answers and replacements go by.
    pub fn set_trust(&self, trust: Arc<CanTrust>) {
        let _ = self.trust.set(trust);
    }

    /// How old the footage each car key's car still keeps is (`status` and the checks of
    /// re-uploaded deleted logs go by it).
    pub fn set_footage(&self, f: Box<dyn Fn(&str) -> Kept + Send + Sync>) {
        let _ = self.footage.set(f);
    }

    /// The oldest footage `key`'s car keeps.
    pub fn kept(&self, key: &str) -> Kept {
        self.footage.get().map_or(Kept::Nothing, |f| f(key))
    }

    /// Whether a deleted log that ended at `end` is older than all the footage its car keeps:
    /// None while that is not known.
    pub fn older_than_footage(kept: Kept, end: f64) -> Option<bool> {
        match kept {
            Kept::Nothing => Some(true),
            Kept::Since(t) => Some(end <= t),
            Kept::Unknown => None,
        }
    }

    /// (tests) f runs as a new copy is about to take a failed one's place, after the copy is
    /// all here and its SHA-256 matched: where an owner's "trust key" may come in.
    #[doc(hidden)]
    pub fn set_before_swap(&self, f: Box<dyn Fn() + Send + Sync>) {
        let _ = self.before_swap.set(f);
    }

    /// The size of a finished log here (the one a sidecar is for), or None.
    fn log_size(&self, key: &str, log_name: &str) -> Option<f64> {
        stat(&self.dir.join(key).join(log_name)).filter(|s| s.is_file()).map(|s| s.len() as f64)
    }

    fn file_of(&self, name: &str) -> Result<PathBuf, CanError> {
        let n = parse_name(name).ok_or_else(|| can_error(400, "bad_name", "That is not a CAN Bridge log name."))?;
        Ok(self.dir.join(&n.vehicle_key).join(name))
    }

    /// Where a file stands: complete, partial or missing: (state, received, length).
    /// A new copy arriving in place of a failed one answers `partial` (the bridge resumes it).
    pub fn state_of(&self, name: &str) -> Result<(String, f64, Option<f64>), CanError> {
        let file = self.file_of(name)?;
        let part = PathBuf::from(format!("{}.part", file.display()));
        if let Some(st) = stat(&part) {
            let meta = util::read_json(Path::new(&format!("{}.part.json", file.display())));
            let length = meta.as_ref().and_then(|m| m.get("length")).and_then(|l| l.as_f64());
            return Ok(("partial".into(), st.len() as f64, length));
        }
        if let Some(st) = stat(&file) {
            return Ok(("complete".into(), st.len() as f64, Some(st.len() as f64)));
        }
        Ok(("missing".into(), 0.0, None))
    }

    /// One status entry. `size`: the whole file's size once known (its `length`), the bytes
    /// received so far while an upload's length is not known, 0 for a file not here.
    fn state_json(s: &(String, f64, Option<f64>)) -> Value {
        let size = match s.0.as_str() {
            "complete" => s.1,
            "partial" => s.2.unwrap_or(s.1),
            _ => 0.0,
        };
        json!({ "state": s.0, "received": n(s.1), "length": s.2.map(n), "size": n(size) })
    }

    /// status(names, { key }): many at once; only `key`'s names are answered.
    pub fn status(&self, names: Option<&Value>, key: Option<&str>) -> Result<Value, CanError> {
        let list = match names {
            Some(Value::Array(a)) if a.len() <= 2000 => a,
            _ => return Err(can_error(400, "bad_request", "Send { \"names\": [...] } with up to 2000 names.")),
        };
        let mut files = Map::new();
        let mut asked: Vec<(String, String, String)> = Vec::new();
        // names not here whose log was deleted here on purpose: (car key, log, asked as)
        let mut buried: Vec<(String, String, String)> = Vec::new();
        for v in list {
            let name = js_string(v);
            let parsed = parse_name(&name);
            if let (Some(p), Some(k)) = (&parsed, key) {
                if p.vehicle_key != k {
                    files.insert(name, json!({ "state": "forbidden", "received": 0, "length": null, "size": 0 }));
                    continue;
                }
            }
            let st = match self.state_of(&name) {
                Ok(s) => Self::state_json(&s),
                Err(_) => json!({ "state": "invalid", "received": 0, "length": null, "size": 0 }),
            };
            if st["state"] == "complete" || st["state"] == "missing" {
                if let Some(nm) = parsed.filter(|_| self.trust.get().is_some()) {
                    let log = if nm.sidecar { name[..name.len() - 5].to_string() } else { name.clone() };
                    // (a sidecar's log may be here while the sidecar is not: then it is missing)
                    let gone = st["state"] == "missing" && self.log_size(&nm.vehicle_key, &log).is_none();
                    if st["state"] == "complete" {
                        asked.push((nm.vehicle_key, log, name.clone()));
                    } else if gone {
                        buried.push((nm.vehicle_key, log, name.clone()));
                    }
                }
            }
            files.insert(name, st);
        }
        if let (Some(trust), false) = (self.trust.get(), buried.is_empty()) {
            let mut by_key: HashMap<String, Vec<(String, String)>> = HashMap::new();
            for (key, log, asked_as) in buried {
                by_key.entry(key).or_default().push((log, asked_as));
            }
            for (key, list) in by_key {
                let logs: Vec<String> = list.iter().map(|x| x.0.clone()).collect();
                let tombs = trust.tombs(&key, &logs);
                if tombs.iter().all(|t| t.is_none()) {
                    continue;
                }
                // (worked out once per car key, and only when one of its names was deleted here)
                let kept = self.kept(&key);
                for (tomb, (_, asked_as)) in tombs.into_iter().zip(list) {
                    let Some(tomb) = tomb else { continue };
                    if let Some(e) = Self::buried_json(&tomb, asked_as.ends_with(".json"), kept) {
                        files.insert(asked_as, e);
                    }
                }
            }
        }
        // every complete log's check, read from its stored record (one lock per car key)
        if let Some(trust) = self.trust.get() {
            let mut by_key: HashMap<String, Vec<(String, f64, String)>> = HashMap::new();
            for (key, log, asked_as) in asked {
                let size = stat(&self.dir.join(&key).join(&log)).filter(|s| s.is_file()).map(|s| s.len() as f64);
                match size {
                    Some(sz) => by_key.entry(key).or_default().push((log, sz, asked_as)),
                    // a sidecar whose log is not here (yet): nothing to check
                    None => {
                        if let Some(e) = files.get_mut(&asked_as).and_then(|e| e.as_object_mut()) {
                            e.insert("check".into(), json!("pending"));
                        }
                    }
                }
            }
            for (key, list) in by_key {
                let ask: Vec<(String, f64)> = list.iter().map(|x| (x.0.clone(), x.1)).collect();
                for ((check, reason), (_, _, asked_as)) in trust.checks(&key, &ask).into_iter().zip(list) {
                    if let Some(e) = files.get_mut(&asked_as).and_then(|e| e.as_object_mut()) {
                        e.insert("check".into(), json!(check));
                        if let Some(r) = reason {
                            e.insert("check_reason".into(), json!(r));
                        }
                    }
                }
            }
        }
        Ok(json!({ "files": files }))
    }

    /// The status entry of a name not here whose log was deleted here on purpose (None:
    /// `missing`, send it). A log older than all the footage its car keeps counts as delivered:
    /// `complete` with the size it had and the check it had (or its re-upload got, see
    /// `CanTrust::rebury`). Its sidecar answers the same with the sidecar's size, when known.
    /// While the footage is not known it is `complete` and `pending` (ask again later). A check
    /// that was never made (`pending`) answers `missing`: the bridge sends it again, and that
    /// copy is checked and dropped again (see `Can::judge`).
    fn buried_json(tomb: &Value, sidecar: bool, kept: Kept) -> Option<Value> {
        let end = tomb.get("end").and_then(|x| x.as_f64()).unwrap_or(f64::INFINITY);
        let older = Self::older_than_footage(kept, end);
        if older == Some(false) {
            return None;
        }
        let size = if sidecar { tomb.get("side").and_then(|x| x.as_f64())? } else { tomb.get("size").and_then(|x| x.as_f64())? };
        let mut e = json!({ "state": "complete", "received": n(size), "length": n(size), "size": n(size) });
        let check = tomb.get("check").and_then(|x| x.as_str()).unwrap_or("pending");
        if older.is_none() {
            e["check"] = json!("pending");
            return Some(e);
        }
        if !matches!(check, "verified" | "failed") {
            return None;
        }
        e["check"] = json!(check);
        if check == "failed" {
            if let Some(r) = tomb.get("checkReason").and_then(|x| x.as_str()) {
                e["check_reason"] = json!(r);
            }
        }
        Some(e)
    }

    /// cleanStale: half-finished uploads older than `max_age_ms` are dropped.
    pub fn clean_stale(&self, max_age_ms: f64) -> usize {
        let mut n = 0;
        for key in util::subdirs(&self.dir) {
            let kdir = self.dir.join(&key);
            for f in util::names(&kdir).unwrap_or_default().into_iter().filter(|x| x.ends_with(".part")) {
                let p = kdir.join(&f);
                if let Some(st) = stat(&p) {
                    if (self.now)() - mtime_ms(&st) > max_age_ms {
                        let _ = fs::remove_file(&p);
                        let _ = fs::remove_file(kdir.join(format!("{}.json", f)));
                        self.own_change(&key);
                        n += 1;
                    }
                }
            }
        }
        n
    }

    /// One chunk of a file (receive): { received, length, complete[, already] }.
    pub fn receive(&self, name: &str, body: &[u8], offset: f64, length: f64, sha256: &str) -> Result<Value, CanError> {
        let (nm, file) = self.head(name, offset, length, sha256)?;
        {
            let mut b = self.busy.lock().unwrap();
            if b.contains(&file) {
                drop(b);
                return Err(self.busy_error(name));
            }
            b.insert(file.clone());
        }
        let r = self.receive_locked(&nm, name, &file, body, offset, length, sha256);
        self.busy.lock().unwrap().remove(&file);
        r
    }

    /// What a chunk's headers decide before its body is read (an upload sent with `Expect:
    /// 100-continue`): Err, the answer `receive` would give whatever the body; Ok(Some), the
    /// same file is all here (`201` `already`); Ok(None), send the body. `body_len`: the body's
    /// Content-Length, when it has one. Nothing is written.
    pub fn precheck(&self, name: &str, body_len: Option<u64>, offset: f64, length: f64, sha256: &str) -> Result<Option<Value>, CanError> {
        let (nm, file) = self.head(name, offset, length, sha256)?;
        if self.busy.lock().unwrap().contains(&file) {
            return Err(self.busy_error(name));
        }
        match self.plan(&nm, name, &file, body_len, offset, length, sha256, false)? {
            Plan::Already(v) => Ok(Some(v)),
            Plan::Write { .. } | Plan::Wait => Ok(None),
        }
    }

    /// The checks of a chunk's own headers: its name, offset, length and hash, and the whole
    /// file's size limit.
    fn head(&self, name: &str, offset: f64, length: f64, sha256: &str) -> Result<(Name, PathBuf), CanError> {
        let nm = parse_name(name).ok_or_else(|| can_error(400, "bad_name", "That is not a CAN Bridge log name."))?;
        let safe = |x: f64| x.is_finite() && x.fract() == 0.0 && x.abs() <= 9_007_199_254_740_991.0;
        if !safe(offset) || offset < 0.0 {
            return Err(can_error(400, "bad_offset", "Upload-Offset must be a whole number of bytes."));
        }
        if !safe(length) || length <= 0.0 {
            return Err(can_error(400, "bad_length", "Upload-Length must be the whole file's size in bytes."));
        }
        if sha256.len() != 64 || !sha256.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
            return Err(can_error(400, "bad_sha256", "Upload-SHA256 must be the whole file's SHA-256 in hex."));
        }
        let limit = if nm.sidecar { MAX_SIDECAR } else { MAX_FILE };
        if length > limit as f64 {
            return Err(can_error(413, "too_large", format!("A {} can be at most {} bytes.", if nm.sidecar { "sidecar" } else { "log" }, limit)));
        }
        let file = self.file_of(name)?;
        Ok((nm, file))
    }

    /// 409 busy: another request is on this file.
    fn busy_error(&self, name: &str) -> CanError {
        let r = self.state_of(name).map(|s| s.1).unwrap_or(0.0);
        with_received(can_error(409, "busy", "This file is being uploaded by another request."), r)
    }

    /// A different copy of a finished file that may not take its place: `409 busy` (send it
    /// again later, from offset 0) while the stored record waits to be judged again after its
    /// new copy could not be read, else `409 exists_different`.
    fn not_replaceable(&self, key: &str, log_name: &str) -> CanError {
        if self.trust.get().is_some_and(|t| t.rereading(key, log_name)) {
            return with_received(can_error(409, "busy", "This log is being checked again; send it again in a minute."), 0.0);
        }
        can_error(409, "exists_different", "A different file with this name is already here.")
    }

    /// Every check of a chunk that its headers and the files here decide (`body_len`: its
    /// size, when known; the size checks wait for it otherwise), in `receive`'s order.
    /// `hash`: false before the body is read (`precheck`): nothing is hashed then, so the
    /// bridge's `100 Continue` never waits on the disk; a finished file of this name answers
    /// `Plan::Wait` (whether it is the same file needs its hash).
    #[allow(clippy::too_many_arguments)]
    fn plan(&self, nm: &Name, name: &str, file: &Path, body_len: Option<u64>, offset: f64, length: f64, sha256: &str, hash: bool) -> Result<Plan, CanError> {
        let log_name = if nm.sidecar { &name[..name.len() - 5] } else { name };
        let half = if nm.sidecar { Half::Sidecar } else { Half::Log };
        // a new copy may take the stored one's place only while its stored record says so (see
        // CanTrust::replaceable): never without the checks
        let replaceable = || match (self.trust.get(), self.log_size(&nm.vehicle_key, log_name)) {
            (Some(t), Some(size)) => t.replaceable_now(&nm.vehicle_key, log_name, size, half),
            _ => false,
        };
        let mut had = self.state_of(name)?;
        // a new copy for a finished one: only in place of a log whose stored check failed
        let replacing = stat(file).is_some();
        if had.0 == "complete" {
            if !hash {
                return Ok(Plan::Wait);
            }
            if had.2 == Some(length) && util::hash_file(file).map(|h| h.0).ok().as_deref() == Some(sha256) {
                return Ok(Plan::Already(json!({ "received": n(length), "length": n(length), "complete": true, "already": true })));
            }
            if !replaceable() {
                return Err(self.not_replaceable(&nm.vehicle_key, log_name));
            }
            had = ("missing".into(), 0.0, None);
        }
        if had.0 == "partial" && had.2.is_some() && had.2 != Some(length) {
            return Err(with_received(can_error(409, "length_changed", "Upload-Length differs from the upload already started; start again at offset 0 with a new name or the same length."), had.1));
        }
        if offset != had.1 {
            return Err(with_received(can_error(409, "offset_mismatch", format!("Expected Upload-Offset {}.", json::num_str(had.1))), had.1));
        }
        if let Some(len) = body_len {
            if offset + len as f64 > length {
                return Err(with_received(can_error(400, "past_end", "The chunk goes past Upload-Length."), had.1));
            }
            if len > MAX_CHUNK {
                return Err(with_received(can_error(413, "chunk_too_large", format!("A chunk can be at most {} bytes.", MAX_CHUNK)), had.1));
            }
        }
        if offset == 0.0 && (self.free_bytes)() < length * 2.0 + self.min_free {
            return Err(can_error(507, "no_space", "There is not enough free space for this file."));
        }
        if offset == 0.0 {
            let count = if nm.sidecar || replacing { 0 } else { self.rows_of(&nm.vehicle_key).len() };
            if count >= self.max_files_per_car {
                return Err(with_received(can_error(507, "car_full", format!("This car has {} CAN logs already: the owner can delete old ones in the Nerd settings.", self.max_files_per_car)), 0.0));
            }
            let parts = util::names(file.parent().unwrap()).unwrap_or_default().into_iter().filter(|x| x.ends_with(".part")).count();
            if parts >= MAX_PARTIAL {
                return Err(with_received(can_error(429, "too_many_partial", "Too many unfinished uploads for this car; finish or wait for them."), 0.0));
            }
        }
        Ok(Plan::Write { replacing })
    }

    #[allow(clippy::too_many_arguments)]
    fn receive_locked(&self, nm: &Name, name: &str, file: &Path, body: &[u8], offset: f64, length: f64, sha256: &str) -> Result<Value, CanError> {
        let log_name = if nm.sidecar { &name[..name.len() - 5] } else { name };
        let half = if nm.sidecar { Half::Sidecar } else { Half::Log };
        let replacing = match self.plan(nm, name, file, Some(body.len() as u64), offset, length, sha256, true)? {
            Plan::Already(v) => return Ok(v),
            Plan::Write { replacing } => replacing,
            Plan::Wait => unreachable!("hashed"),
        };
        let io = |e: std::io::Error| can_error(500, "server_error", e.to_string());
        fs::create_dir_all(file.parent().unwrap()).map_err(io)?;
        let part = PathBuf::from(format!("{}.part", file.display()));
        let part_json = PathBuf::from(format!("{}.part.json", file.display()));
        if offset == 0.0 {
            let meta = json!({ "length": n(length), "sha256": sha256, "startedAt": n((self.now)()) });
            fs::write(&part_json, json::stringify(&meta)).map_err(io)?;
        }
        {
            use std::io::Write;
            let mut f = fs::OpenOptions::new().create(true).append(true).open(&part).map_err(io)?;
            f.write_all(body).map_err(io)?;
        }
        if offset == 0.0 {
            self.own_change(&nm.vehicle_key);
        }
        let received = offset + body.len() as f64;
        if received < length {
            return Ok(json!({ "received": n(received), "length": n(length), "complete": false }));
        }
        let got = util::hash_file(&part).map(|h| h.0).unwrap_or_default();
        if got != sha256 {
            let _ = fs::remove_file(&part);
            let _ = fs::remove_file(&part_json);
            return Err(with_received(can_error(422, "sha256_mismatch", "The file arrived different from its SHA-256; it was discarded. Upload it again from offset 0."), 0.0));
        }
        if nm.sidecar {
            let ok = fs::read_to_string(&part).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).is_some();
            if !ok {
                let _ = fs::remove_file(&part);
                let _ = fs::remove_file(&part_json);
                return Err(with_received(can_error(422, "bad_sidecar", "The sidecar is not JSON; it was discarded."), 0.0));
            }
        }
        if replacing {
            if let Some(f) = self.before_swap.get() {
                f();
            }
            // checked again and swapped under the one lock on the car's records: the old copy may
            // have been verified meanwhile (e.g. its key trusted), and then it stays
            let swapped = match (self.trust.get(), self.log_size(&nm.vehicle_key, log_name)) {
                (Some(t), Some(size)) => t.replace_if_failed(&nm.vehicle_key, log_name, size, half, || fs::rename(&part, file)).map_err(io)?,
                _ => false,
            };
            if !swapped {
                // the new copy is dropped, as when the first look refused it
                let _ = fs::remove_file(&part);
                let _ = fs::remove_file(&part_json);
                return Err(self.not_replaceable(&nm.vehicle_key, log_name));
            }
        } else {
            fs::rename(&part, file).map_err(io)?;
        }
        let _ = fs::remove_file(&part_json);
        self.note_changed(&nm.vehicle_key, log_name);
        if replacing {
            return Ok(json!({ "received": n(received), "length": n(length), "complete": true, "replaced": true }));
        }
        Ok(json!({ "received": n(received), "length": n(length), "complete": true }))
    }

    fn row_of(&self, kdir: &Path, key: &str, name: &str, st: &fs::Metadata, old: Option<&Row>) -> Row {
        let nm = parse_name(name).unwrap();
        let mut row = Row { name: name.to_string(), vehicle_key: key.to_string(), started_at_ms: nm.started_at, seq: nm.seq, bytes: st.len(), mtime_ms: mtime_ms(st), side_bytes: 0, side_mtime: None, side: None };
        let sp = kdir.join(format!("{}.json", name));
        if let Some(ss) = stat(&sp).filter(|s| s.is_file()) {
            row.side_bytes = ss.len();
            row.side_mtime = Some(mtime_ms(&ss));
            match old {
                Some(w) if w.side_bytes == ss.len() && w.side_mtime == row.side_mtime => row.side = w.side.clone(),
                _ => row.side = util::read_json(&sp).map(|v| side_facts(&v)),
            }
        }
        row
    }

    fn read_folder(&self, key: &str, old: Option<&Cat>) -> Cat {
        let kdir = self.dir.join(key);
        let st0 = stat(&kdir);
        let names = util::names(&kdir).unwrap_or_default();
        let have: HashSet<&String> = names.iter().collect();
        let mut cat = Cat { rows: HashMap::new(), order: Vec::new(), orphan_bytes: 0, dir_mtime: st0.as_ref().map(mtime_ms), at: (self.now)() };
        for name in &names {
            let Some(nm) = parse_name(name) else { continue };
            if nm.vehicle_key != key {
                continue;
            }
            let Some(st) = stat(&kdir.join(name)).filter(|s| s.is_file()) else { continue };
            if nm.sidecar {
                if !have.contains(&name[..name.len() - 5].to_string()) {
                    cat.orphan_bytes += st.len();
                }
                continue;
            }
            let row = self.row_of(&kdir, key, name, &st, old.and_then(|o| o.rows.get(name)));
            cat.set(row);
        }
        cat
    }

    /// Run f on the catalogue of a key, read again when its folder changed or it is old.
    fn with_cat<T>(&self, key: &str, f: impl FnOnce(&Cat) -> T) -> T {
        let _l = self.loading.lock().unwrap();
        let kdir = self.dir.join(key);
        let fresh_needed = {
            let cats = self.cats.lock().unwrap();
            match cats.get(key) {
                Some(c) => {
                    let st = stat(&kdir).map(|s| mtime_ms(&s));
                    !(st == c.dir_mtime && (self.now)() - c.at < RESCAN_MS)
                }
                None => true,
            }
        };
        if fresh_needed {
            let old = self.cats.lock().unwrap().remove(key);
            let fresh = self.read_folder(key, old.as_ref());
            self.cats.lock().unwrap().insert(key.to_string(), fresh);
        }
        let cats = self.cats.lock().unwrap();
        f(cats.get(key).unwrap())
    }

    /// noteChanged: a log (or its sidecar) was finished or deleted here.
    fn note_changed(&self, key: &str, log_name: &str) {
        let _l = self.loading.lock().unwrap();
        let mut cats = self.cats.lock().unwrap();
        let Some(c) = cats.get_mut(key) else { return };
        let kdir = self.dir.join(key);
        match stat(&kdir.join(log_name)).filter(|s| s.is_file()) {
            None => c.delete(log_name),
            Some(st) => {
                let mut row = self.row_of(&kdir, key, log_name, &st, None);
                if row.side_mtime.is_some() {
                    row.side = util::read_json(&kdir.join(format!("{}.json", log_name))).map(|v| side_facts(&v));
                }
                c.set(row);
            }
        }
        if c.orphan_bytes > 0 {
            cats.remove(key);
            return;
        }
        c.dir_mtime = stat(&kdir).map(|s| mtime_ms(&s));
    }

    fn own_change(&self, key: &str) {
        let mut cats = self.cats.lock().unwrap();
        if let Some(c) = cats.get_mut(key) {
            c.dir_mtime = stat(&self.dir.join(key)).map(|s| mtime_ms(&s));
        }
    }

    pub fn car_keys(&self) -> Vec<String> {
        util::subdirs(&self.dir)
    }

    /// summary(): { bytes, count, keys } without listing them.
    pub fn summary(&self) -> (f64, usize, Vec<String>) {
        let mut bytes = 0f64;
        let mut count = 0;
        let mut keys = Vec::new();
        for key in self.car_keys() {
            self.with_cat(&key, |c| {
                if c.rows.is_empty() && c.orphan_bytes == 0 {
                    return;
                }
                keys.push(key.clone());
                count += c.rows.len();
                bytes += c.orphan_bytes as f64;
                for r in c.rows.values() {
                    bytes += (r.bytes + r.side_bytes) as f64;
                }
            });
        }
        (bytes, count, keys)
    }

    /// list({ limit }): every finished log, newest first.
    pub fn list(&self, limit: f64) -> Value {
        let mut all: Vec<Row> = Vec::new();
        let mut bytes = 0f64;
        for key in self.car_keys() {
            self.with_cat(&key, |c| {
                bytes += c.orphan_bytes as f64;
                for r in c.list() {
                    bytes += (r.bytes + r.side_bytes) as f64;
                    all.push(r.clone());
                }
            });
        }
        all.sort_by(|a, b| b.started_at_ms.cmp(&a.started_at_ms).then(b.seq.cmp(&a.seq)));
        let take = limit.min(2000.0).max(1.0);
        let take = if take.is_nan() { 1 } else { take.ceil() as usize };
        let logs: Vec<Value> = all.iter().take(take).map(|r| {
            let s = r.side.as_ref();
            json!({
                "name": r.name, "vehicleKey": r.vehicle_key, "startedAt": tz::iso(r.started_at_ms), "seq": r.seq, "bytes": r.bytes,
                "receivedAt": tz::iso(r.mtime_ms.floor() as i64), "sidecar": s.is_some(),
                "frames": s.and_then(|x| x.frames).map(n), "dropped": s.and_then(|x| x.dropped).map(n), "appVersion": s.and_then(|x| x.app_version.clone()),
                "format": s.and_then(|x| x.format.clone()), "closedBecause": s.and_then(|x| x.closed_because.clone())
            })
        }).collect();
        json!({ "logs": logs, "bytes": n(bytes), "count": all.len() })
    }

    /// rowsOf(key): every finished log of one car key.
    pub fn rows_of(&self, key: &str) -> Vec<Row> {
        if !key_ok(key) {
            return Vec::new();
        }
        self.with_cat(key, |c| c.list().into_iter().cloned().collect())
    }

    /// delete_log(name, why): a log deleted on purpose (the owner in the Nerd settings,
    /// "Keeping logs", "Also delete its CAN data"): what it was is worked out (its size, its
    /// SHA-256, its sidecar's size, its check, its end), then its files are deleted, then its
    /// tombstone is kept (CanTrust::bury). A log not judged yet is judged first, so its
    /// tombstone carries a check. Only after the files are gone: a crash in between leaves no
    /// tombstone (the log is then missing, and may be sent again), never a tombstone for a log
    /// still here.
    pub fn delete_log(&self, name: &str, why: &str) -> Result<(), CanError> {
        let nm = parse_name(name).filter(|n| !n.sidecar).ok_or_else(|| can_error(400, "bad_name", "That is not a CAN Bridge log name."))?;
        let key = nm.vehicle_key.clone();
        let Some(trust) = self.trust.get() else { return self.remove(name) };
        let Some(size) = self.log_size(&key, name) else { return Err(can_error(404, "not_found", "No such log.")) };
        let kdir = self.dir.join(&key);
        let side_path = kdir.join(format!("{}.json", name));
        let side_size = stat(&side_path).filter(|s| s.is_file()).map(|s| s.len() as f64);
        let fresh = |r: &Option<Value>| r.as_ref().is_some_and(|r| r.get("length").and_then(|l| l.as_f64()) == Some(size) && r.get("status").and_then(|s| s.as_str()) != Some("waiting") && !json::truthy(r.get("deleted")));
        if !fresh(&trust.record(&key, name)) {
            trust.check(&key, name);
        }
        let rec = trust.record(&key, name);
        let sha = match rec.as_ref().filter(|_| fresh(&rec)).and_then(|r| r.get("sha256")).and_then(|s| s.as_str()) {
            Some(s) => Some(s.to_string()),
            None => util::hash_file(&kdir.join(name)).ok().map(|h| h.0),
        };
        let (check, reason) = trust.checks(&key, &[(name.to_string(), size)]).into_iter().next().unwrap_or(("pending", None));
        let end = util::read_json(&side_path).as_ref().map(log_end).unwrap_or(None).unwrap_or(nm.started_at as f64 + 60_000.0);
        self.remove(name)?;
        trust.bury(&key, name, json!({ "size": n(size), "sha256": sha, "side": side_size.map(n), "check": check, "checkReason": reason, "at": n((self.now)()), "why": why, "end": n(end) }));
        Ok(())
    }

    /// discard(name): a copy of a log deleted here before, sent again and checked, deleted
    /// again (its tombstone stays, see Can::judge); either half may be all that is here.
    pub fn discard(&self, name: &str) {
        let Ok(file) = self.file_of(name) else { return };
        let f = file.display().to_string();
        for p in [f.clone(), format!("{}.json", f)] {
            let _ = fs::remove_file(p);
        }
        if let Some(nm) = parse_name(name) {
            self.note_changed(&nm.vehicle_key, name);
        }
    }

    /// The size of a finished file here (a log or a sidecar), or None.
    pub fn size_of(&self, name: &str) -> Option<f64> {
        self.file_of(name).ok().and_then(|f| stat(&f)).filter(|s| s.is_file()).map(|s| s.len() as f64)
    }

    /// Whether an upload of this name (or of its sidecar) is still arriving.
    pub fn arriving(&self, log_name: &str) -> bool {
        let Ok(file) = self.file_of(log_name) else { return false };
        let f = file.display().to_string();
        stat(Path::new(&format!("{}.part", f))).is_some() || stat(Path::new(&format!("{}.json.part", f))).is_some()
    }

    /// remove(name): delete one log and its sidecar.
    pub fn remove(&self, name: &str) -> Result<(), CanError> {
        let nm = parse_name(name).filter(|n| !n.sidecar).ok_or_else(|| can_error(400, "bad_name", "That is not a CAN Bridge log name."))?;
        let file = self.file_of(name)?;
        if stat(&file).is_none() {
            return Err(can_error(404, "not_found", "No such log."));
        }
        let f = file.display().to_string();
        for p in [f.clone(), format!("{}.json", f), format!("{}.part", f), format!("{}.part.json", f)] {
            let _ = fs::remove_file(p);
        }
        self.note_changed(&nm.vehicle_key, name);
        Ok(())
    }
}

/// When a log ended, from its sidecar's `end_wall_ms` (None without a usable one).
pub fn log_end(side: &Value) -> Option<f64> {
    side.get("end_wall_ms").and_then(json::finite).filter(|x| *x > 0.0)
}

/// String(v) as JS turns a JSON value into a name.
pub fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(x) => json::num_str(x.as_f64().unwrap_or(f64::NAN)),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        let n = parse_name("MY-car_20261108T143000Z_1.log.xz").unwrap();
        assert_eq!(n.vehicle_key, "MY-car");
        assert_eq!(n.started_at, tz::utc_ms(2026, 11, 8, 14, 30, 0));
        assert!(!n.sidecar);
        assert!(parse_name("MY-car_20261108T143000Z_1.log.xz.json").unwrap().sidecar);
        assert!(parse_name("MY_car_20261108T143000Z_1.log.xz").is_none());
        assert!(parse_name("K_20261308T143000Z_1.log.xz").is_none());
        // (V8 reads Feb 30 as Mar 2)
        assert_eq!(parse_name("K_20260230T100000Z_1.log.xz").unwrap().started_at, 1772445600000);
        assert!(parse_name("K_20261108T143000Z_1234567.log.xz").is_none());
        assert!(parse_name("../K_20261108T143000Z_1.log.xz").is_none());
    }
}
