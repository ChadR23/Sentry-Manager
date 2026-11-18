//! CAN logs live and die with their footage (server/canPrune.js): a log is
//! paired with the footage of its car that covers its minute; logs whose
//! footage was deleted for good, logs older than all of the car's footage,
//! and logs no footage covers after N days are deleted, never while the
//! car's footage cannot be trusted. "Also delete its CAN data" deletes the
//! logs of footage moved to the Recycle Bin at once.
//!
//!   db 'can-keep'         { withFootage, deleteUnlinked, unlinkedDays }
//!   db 'can-prune:<vid>'  { gone: [[from, to, at], ...], last: { at, removed, ... } }

use super::ctx::{Car, CanCtx};
use super::json::{self, n};
use super::logs::{CanLogs, Row};
use super::trust::CanTrust;
use super::tz;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

pub const CLIP_MS: f64 = 62_000.0;
const LOG_MIN_MS: f64 = 60_000.0;
const LOG_MAX_MS: f64 = 10.0 * 60_000.0;
pub const MARGIN_MS: f64 = 3_600_000.0;
pub const BATCH: usize = 500;
pub const UNLINKED_DAYS: f64 = 7.0;
const DAY_MS: f64 = 86_400_000.0;
const FRESH_MS: f64 = 30.0 * 60_000.0;
const GONE_KEEP_MS: f64 = 7.0 * 86_400_000.0;

fn lower_bound(arr: &[f64], x: f64) -> usize {
    arr.partition_point(|&v| v < x)
}
/// Whether a clip starting in `starts` (sorted) overlaps [from, to).
pub fn overlaps(starts: &[f64], from: f64, to: f64) -> bool {
    let i = lower_bound(starts, from - CLIP_MS + 1.0);
    i < starts.len() && starts[i] < to
}

pub struct Span {
    pub row: Row,
    pub from: f64,
    pub to: f64,
}

/// Each log's [from, to): its start, to the next log of its key (one to ten minutes).
pub fn spans(rows: &[Row]) -> Vec<Span> {
    let mut sorted: Vec<Row> = rows.to_vec();
    sorted.sort_by(|a, b| a.started_at_ms.cmp(&b.started_at_ms).then(a.seq.cmp(&b.seq)));
    let mut out = Vec::with_capacity(sorted.len());
    for i in 0..sorted.len() {
        let r = &sorted[i];
        let next = sorted[i + 1..].iter().find(|x| x.started_at_ms > r.started_at_ms);
        let len = match next {
            Some(nx) => LOG_MAX_MS.min(LOG_MIN_MS.max((nx.started_at_ms - r.started_at_ms) as f64)),
            None => LOG_MIN_MS,
        };
        out.push(Span { row: r.clone(), from: r.started_at_ms as f64, to: r.started_at_ms as f64 + len });
    }
    out
}

/// A clip name's start in UTC ms in the car's zone (canStartOf), or None.
pub fn start_of(v: &Car, name: &str) -> Option<f64> {
    let ts = super::search::ts_from(name)?;
    let num = |a: usize, z: usize| ts[a..z].parse::<i64>().unwrap();
    let zone = if v.timezone.is_empty() { "UTC" } else { v.timezone.as_str() };
    Some(tz::zoned_to_utc(num(0, 4), num(5, 7), num(8, 10), num(11, 13), num(14, 16), num(17, 19), zone) as f64)
}
fn clip_start(v: &Car, rel: &str) -> Option<f64> {
    start_of(v, rel.rsplit('/').next().unwrap_or(rel))
}
fn is_mp4(rel: &str) -> bool {
    rel.to_ascii_lowercase().ends_with(".mp4")
}

#[derive(Debug, Clone, Copy)]
pub struct Keep {
    pub with_footage: bool,
    pub delete_unlinked: bool,
    pub unlinked_days: f64,
}

pub struct Plan {
    todo: Vec<(String, String, f64, f64, &'static str)>,
    pending: usize,
    held: Vec<(f64, f64)>,
    oldest: f64,
}

pub struct CanPrune {
    pub ctx: Arc<dyn CanCtx>,
    pub logs: Arc<CanLogs>,
    pub trust: Arc<CanTrust>,
    /// the log's data taken out of the index (and the sync told)
    pub drop: Box<dyn Fn(&str, &str) + Send + Sync>,
    pub on_change: Box<dyn Fn(&str) + Send + Sync>,
    pub now: Box<dyn Fn() -> f64 + Send + Sync>,
    pub batch: usize,
    pub fresh_ms: f64,
    pub soon_ms: f64,
    running: Mutex<HashMap<String, bool>>,
    timers: Mutex<HashMap<String, f64>>,
    covers: Mutex<HashMap<String, (String, Arc<Vec<f64>>)>>,
}

impl CanPrune {
    pub fn new(ctx: Arc<dyn CanCtx>, logs: Arc<CanLogs>, trust: Arc<CanTrust>, drop: Box<dyn Fn(&str, &str) + Send + Sync>, on_change: Box<dyn Fn(&str) + Send + Sync>) -> CanPrune {
        CanPrune { ctx, logs, trust, drop, on_change, now: Box::new(super::util::now_ms), batch: BATCH, fresh_ms: FRESH_MS, soon_ms: 30_000.0, running: Mutex::new(HashMap::new()), timers: Mutex::new(HashMap::new()), covers: Mutex::new(HashMap::new()) }
    }

    /// The keys mapped to a car in the Nerd settings (keysOf).
    pub fn keys_of(&self, vid: &str) -> Vec<String> {
        let map = self.ctx.setting("can-vehicles").filter(|v| json::truthy(Some(v))).unwrap_or(json!({}));
        let Value::Object(m) = map else { return Vec::new() };
        json::ordered_keys(&m).into_iter().filter(|k| m[*k].as_str() == Some(vid)).cloned().collect()
    }

    pub fn settings(&self) -> Keep {
        let mut k = Keep { with_footage: true, delete_unlinked: true, unlinked_days: UNLINKED_DAYS };
        if let Some(Value::Object(m)) = self.ctx.setting("can-keep").filter(|v| json::truthy(Some(v))) {
            if let Some(v) = m.get("withFootage") {
                k.with_footage = json::truthy(Some(v));
            }
            if let Some(v) = m.get("deleteUnlinked") {
                k.delete_unlinked = json::truthy(Some(v));
            }
            if let Some(v) = m.get("unlinkedDays") {
                k.unlinked_days = v.as_f64().unwrap_or(f64::NAN);
            }
        }
        k
    }
    fn settings_json(&self) -> Map<String, Value> {
        let mut o = Map::new();
        o.insert("withFootage".into(), json!(true));
        o.insert("deleteUnlinked".into(), json!(true));
        o.insert("unlinkedDays".into(), json!(7));
        if let Some(Value::Object(m)) = self.ctx.setting("can-keep").filter(|v| json::truthy(Some(v))) {
            for (k, v) in m {
                o.insert(k, v);
            }
        }
        o
    }
    fn any_on(c: &Keep) -> bool {
        c.with_footage || c.delete_unlinked
    }
    fn load_state(&self, vid: &str) -> Map<String, Value> {
        let mut o = Map::new();
        o.insert("gone".into(), json!([]));
        o.insert("last".into(), Value::Null);
        if let Some(Value::Object(m)) = self.ctx.setting(&format!("can-prune:{}", vid)).filter(|v| json::truthy(Some(v))) {
            for (k, v) in m {
                o.insert(k, v);
            }
        }
        o
    }
    fn gone_of(st: &Map<String, Value>) -> Vec<(f64, f64, f64)> {
        st.get("gone").and_then(|g| g.as_array()).map(|a| a.iter().filter_map(|g| g.as_array().map(|x| (x.first().and_then(|v| v.as_f64()).unwrap_or(f64::NAN), x.get(1).and_then(|v| v.as_f64()).unwrap_or(f64::NAN), x.get(2).and_then(|v| v.as_f64()).unwrap_or(f64::NAN)))).collect()).unwrap_or_default()
    }
    fn gone_value(g: &[(f64, f64, f64)]) -> Value {
        Value::Array(g.iter().map(|x| json!([n(x.0), n(x.1), n(x.2)])).collect())
    }

    fn footage_of(&self, v: &Car) -> Vec<f64> {
        let mut set: HashSet<i64> = HashSet::new();
        let mut add = |rel: &str| {
            if let Some(t) = clip_start(v, rel) {
                set.insert(t as i64);
            }
        };
        if let Some(s) = self.ctx.scan_of(&v.id) {
            for f in s.files.iter().filter(|f| f.kind == "clip") {
                add(&f.rel);
            }
        }
        for rel in self.ctx.bin_rels(&v.id).iter().filter(|r| is_mp4(r)) {
            add(rel);
        }
        for rel in self.ctx.protected_rels(&v.id).iter().filter(|r| is_mp4(r)) {
            add(rel);
        }
        let mut out: Vec<f64> = set.into_iter().map(|x| x as f64).collect();
        out.sort_by(|a, b| a.partial_cmp(b).unwrap());
        out
    }

    fn starts_of(&self, v: &Car) -> Arc<Vec<f64>> {
        let s = self.ctx.scan_of(&v.id);
        let bin = self.ctx.bin_rels(&v.id);
        let sig = format!("{:?}|{}|{}|{}|{}|{}", s.as_ref().and_then(|x| x.scanned_at), s.as_ref().map_or(0, |x| x.files.len()), s.as_ref().map_or(0, |x| x.generation), bin.len(), self.ctx.protected_rels(&v.id).len(), v.timezone);
        if let Some((sg, starts)) = self.covers.lock().unwrap().get(&v.id) {
            if *sg == sig {
                return starts.clone();
            }
        }
        let starts = Arc::new(self.footage_of(v));
        self.covers.lock().unwrap().insert(v.id.clone(), (sig, starts.clone()));
        starts
    }

    /// Why this car's footage cannot be trusted right now (None: it can).
    fn untrusted(&self, v: &Car) -> Option<String> {
        if !self.ctx.share_healthy(&v.id) {
            return Some("the share is not reachable".into());
        }
        let Some(s) = self.ctx.scan_of(&v.id).filter(|s| s.scanned) else { return Some("the footage has not been scanned yet".into()) };
        if s.scanning {
            return Some("a scan is running".into());
        }
        if let Some(e) = s.last_error.filter(|e| !e.is_empty()) {
            return Some(format!("the last scan failed ({})", super::util::utf16_slice(&e, 120)));
        }
        if s.error_count > 0 {
            return Some(format!("{} folder(s) or file(s) could not be read in the last scan", s.error_count));
        }
        None
    }

    fn car_of_key(&self, key: &str) -> Option<Car> {
        self.ctx.vehicles().into_iter().find(|v| self.keys_of(&v.id).iter().any(|k| k == key))
    }

    /// pairing(key): name -> 'paired' | 'none' for one key's logs, or None (not mapped).
    pub fn pairing(&self, key: &str) -> Option<HashMap<String, &'static str>> {
        let v = self.car_of_key(key)?;
        if !self.ctx.scan_of(&v.id).is_some_and(|s| s.scanned) {
            return None;
        }
        let starts = self.starts_of(&v);
        Some(spans(&self.logs.rows_of(key)).into_iter().map(|s| (s.row.name.clone(), if overlaps(&starts, s.from, s.to) { "paired" } else { "none" })).collect())
    }

    fn pending_log(&self, key: &str, name: &str) -> bool {
        let rec = self.trust.record(key, name);
        let side = self.logs.state_of(&format!("{}.json", name)).map(|s| s.0).unwrap_or_else(|_| "partial".into());
        rec.is_none() || rec.as_ref().and_then(|r| r.get("status")).and_then(|s| s.as_str()) == Some("waiting") || side == "partial"
    }

    /// deleteWith: "Also delete its CAN data" (dryRun: only counted).
    pub fn delete_with(&self, vid: &str, rels: &[String], until: Option<f64>, by: &str, dry_run: bool) -> Value {
        let Some(v) = self.ctx.vehicle(vid) else { return json!({ "removed": 0, "kept": 0, "pending": 0, "skip": "no such car" }) };
        let keys = self.keys_of(vid);
        if keys.is_empty() {
            return json!({ "removed": 0, "kept": 0, "pending": 0, "skip": "no CAN Bridge key is mapped to this car" });
        }
        let limit = until.filter(|x| x.is_finite());
        let going: HashSet<&String> = rels.iter().collect();
        let mut asked: Vec<f64> = rels.iter().filter_map(|r| clip_start(&v, r)).map(|t| t as i64).collect::<HashSet<_>>().into_iter().map(|t| t as f64).collect();
        asked.sort_by(|a, b| a.partial_cmp(b).unwrap());
        if asked.is_empty() && limit.is_none() {
            return if dry_run { json!({ "logs": 0, "kept": 0 }) } else { json!({ "removed": 0, "kept": 0, "pending": 0 }) };
        }
        let mut result = Value::Null;
        self.ctx.with_bin_lock(vid, &mut || {
            if let Some(why) = self.untrusted(&v) {
                if !dry_run {
                    self.ctx.log("warn", &format!("CAN logs of {} not deleted with its footage: {}", v.name, why));
                }
                result = if dry_run { json!({ "logs": 0, "kept": 0, "skip": why }) } else { json!({ "removed": 0, "kept": 0, "pending": 0, "skip": why }) };
                return;
            }
            let mut stay: HashSet<i64> = HashSet::new();
            if let Some(s) = self.ctx.scan_of(vid) {
                for f in s.files.iter().filter(|f| f.kind == "clip" && !going.contains(&f.rel)) {
                    if let Some(t) = clip_start(&v, &f.rel) {
                        stay.insert(t as i64);
                    }
                }
            }
            for rel in self.ctx.protected_rels(vid).iter().filter(|r| is_mp4(r)) {
                if let Some(t) = clip_start(&v, rel) {
                    stay.insert(t as i64);
                }
            }
            let mut stays: Vec<f64> = stay.into_iter().map(|x| x as f64).collect();
            stays.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let (mut removed, mut kept, mut pending, mut logs) = (0, 0, 0, 0);
            let mut names: Vec<String> = Vec::new();
            for key in &keys {
                for s in spans(&self.logs.rows_of(key)) {
                    let wanted = limit.is_some_and(|l| s.to <= l) || overlaps(&asked, s.from, s.to);
                    if !wanted {
                        continue;
                    }
                    if overlaps(&stays, s.from, s.to) {
                        kept += 1;
                        continue;
                    }
                    if dry_run {
                        logs += 1;
                        continue;
                    }
                    if self.pending_log(key, &s.row.name) {
                        pending += 1;
                        continue;
                    }
                    if let Err(e) = self.logs.remove(&s.row.name) {
                        if e.status != 404 {
                            self.ctx.log("warn", &format!("CAN log {}: not deleted: {}", s.row.name, e.message));
                            continue;
                        }
                    }
                    (self.drop)(key, &s.row.name);
                    self.trust.deleted(key, &s.row.name);
                    removed += 1;
                    names.push(s.row.name.clone());
                }
            }
            if dry_run {
                result = json!({ "logs": logs, "kept": kept });
                return;
            }
            if removed > 0 {
                self.ctx.log("info", &format!("CAN logs: removed {} with footage moved to the Recycle Bin (car {})", removed, v.name));
                self.ctx.audit(
                    "info",
                    &format!(
                        "CAN logs deleted with footage moved to the Recycle Bin (car {}): {}, {}{}{}{}",
                        v.name,
                        removed,
                        names[0],
                        if removed > 1 { format!(" to {}", names[names.len() - 1]) } else { String::new() },
                        limit.map(|l| format!(", every log through {}", tz::iso(l as i64 - 1))).unwrap_or_default(),
                        if by.is_empty() { String::new() } else { format!(": {}", by) }
                    ),
                );
                (self.on_change)(vid);
            }
            result = json!({ "removed": removed, "kept": kept, "pending": pending });
        });
        result
    }

    /// footageGone: footage deleted for good; its minutes are remembered and the car looked at soon.
    pub fn footage_gone(&self, vid: &str, rels: &[String]) {
        let Some(v) = self.ctx.vehicle(vid) else { return };
        let mut st = self.load_state(vid);
        let at = (self.now)();
        let mut starts: Vec<f64> = rels.iter().filter_map(|r| clip_start(&v, r)).map(|t| t as i64).collect::<HashSet<_>>().into_iter().map(|t| t as f64).collect();
        starts.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mut gone = Self::gone_of(&st);
        for t in starts {
            match gone.last_mut() {
                Some(last) if last.2 == at && t <= last.1 => last.1 = last.1.max(t + CLIP_MS),
                _ => gone.push((t, t + CLIP_MS, at)),
            }
        }
        if gone.len() > 50_000 {
            gone = gone[gone.len() - 50_000..].to_vec();
        }
        st.insert("gone".into(), Self::gone_value(&gone));
        self.ctx.set_setting(&format!("can-prune:{}", vid), Value::Object(st));
        self.soon(vid, self.soon_ms);
    }

    /// soon(vid, ms): a run of this car after ms (a later call moves it).
    pub fn soon(&self, vid: &str, ms: f64) {
        self.timers.lock().unwrap().insert(vid.to_string(), (self.now)() + ms);
    }

    /// The timers that are due run now (called every second by the area's ticker).
    pub fn tick(&self) {
        let now = (self.now)();
        let due: Vec<String> = {
            let mut t = self.timers.lock().unwrap();
            let d: Vec<String> = t.iter().filter(|(_, at)| **at <= now).map(|(k, _)| k.clone()).collect();
            for k in &d {
                t.remove(k);
            }
            d
        };
        for vid in due {
            self.check(&vid);
        }
    }

    fn plan(&self, v: &Car, gone_in: &[(f64, f64, f64)], cfg: &Keep) -> Result<Plan, String> {
        let keys = self.keys_of(&v.id);
        if keys.is_empty() {
            return Err("no CAN Bridge key is mapped to this car".into());
        }
        let mut why = self.untrusted(v);
        if why.is_none() || why.as_deref() == Some("the footage has not been scanned yet") {
            let s = self.ctx.scan_of(&v.id);
            let fresh = s.as_ref().is_some_and(|s| s.scanned && (self.now)() - s.scanned_at.unwrap_or(0.0) < self.fresh_ms);
            if !fresh {
                if let Err(e) = self.ctx.rescan(&v.id) {
                    return Err(format!("the footage could not be scanned ({})", e));
                }
                why = self.untrusted(v);
            }
        }
        if let Some(w) = why {
            return Err(w);
        }
        let mut out: Option<Result<Plan, String>> = None;
        self.ctx.with_bin_lock(&v.id, &mut || {
            if let Some(again) = self.untrusted(v) {
                out = Some(Err(again));
                return;
            }
            let starts = self.footage_of(v);
            if starts.is_empty() {
                out = Some(Err("the car has no footage at all (a share outage looks the same): nothing is deleted".into()));
                return;
            }
            let oldest = starts[0];
            let mut gone = gone_in.to_vec();
            gone.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            let gone_starts: Vec<f64> = gone.iter().map(|g| g.0).collect();
            let mut max_end: Vec<f64> = Vec::new();
            for (i, g) in gone.iter().enumerate() {
                max_end.push(g.1.max(if i > 0 { max_end[i - 1] } else { f64::NEG_INFINITY }));
            }
            let in_gone = |from: f64, to: f64| {
                let i = lower_bound(&gone_starts, to);
                i > 0 && max_end[i - 1] > from
            };
            let unlinked_before = (self.now)() - cfg.unlinked_days * DAY_MS;
            let mut todo = Vec::new();
            for key in &keys {
                for s in spans(&self.logs.rows_of(key)) {
                    if overlaps(&starts, s.from, s.to) {
                        continue;
                    }
                    let gone_here = cfg.with_footage && in_gone(s.from, s.to);
                    let old = cfg.with_footage && s.to < oldest - MARGIN_MS;
                    let unlinked = cfg.delete_unlinked && s.to.max(s.row.mtime_ms) < unlinked_before;
                    if !gone_here && !old && !unlinked {
                        continue;
                    }
                    todo.push((key.clone(), s.row.name.clone(), s.from, s.to, if gone_here { "footage" } else if old { "old" } else { "unlinked" }));
                }
            }
            let mut keep = Vec::new();
            let mut pending = 0;
            let mut held = Vec::new();
            for t in todo {
                if self.pending_log(&t.0, &t.1) {
                    pending += 1;
                    if t.4 == "footage" {
                        held.push((t.2, t.3));
                    }
                    continue;
                }
                keep.push(t);
            }
            out = Some(Ok(Plan { todo: keep, pending, held, oldest }));
        });
        out.unwrap_or_else(|| Err("locked".into()))
    }

    fn done(&self, vid: &str, last: Map<String, Value>) -> Value {
        let mut s = self.load_state(vid);
        let mut l = Map::new();
        l.insert("at".into(), n((self.now)()));
        for (k, v) in last {
            l.insert(k, v);
        }
        s.insert("last".into(), Value::Object(l.clone()));
        self.ctx.set_setting(&format!("can-prune:{}", vid), Value::Object(s));
        (self.on_change)(vid);
        Value::Object(l)
    }

    fn run(&self, vid: &str) -> Option<Value> {
        let v = self.ctx.vehicle(vid)?;
        let st = self.load_state(vid);
        let cfg = self.settings();
        let skip = |why: &str| {
            let mut m = Map::new();
            m.insert("removed".into(), json!(0));
            m.insert("skip".into(), json!(why));
            m
        };
        if !Self::any_on(&cfg) {
            return Some(self.done(vid, skip("turned off")));
        }
        let gone = Self::gone_of(&st);
        let p = match self.plan(&v, &gone, &cfg) {
            Ok(p) => p,
            Err(why) => {
                if !gone.is_empty() {
                    self.ctx.log("info", &format!("CAN logs of {}: not looked at now: {}", v.name, why));
                }
                return Some(self.done(vid, skip(&why)));
            }
        };
        let take: Vec<_> = p.todo.iter().take(self.batch).collect();
        let mut removed = 0usize;
        let mut names = Vec::new();
        let mut by_why: HashMap<&str, usize> = HashMap::new();
        for (i, t) in take.iter().enumerate() {
            if i > 0 && i % 50 == 0 && self.untrusted(&v).is_some() {
                break;
            }
            if !Self::any_on(&self.settings()) {
                break;
            }
            if let Err(e) = self.logs.remove(&t.1) {
                if e.status != 404 {
                    self.ctx.log("warn", &format!("CAN log {}: not deleted: {}", t.1, e.message));
                    continue;
                }
            }
            (self.drop)(&t.0, &t.1);
            self.trust.deleted(&t.0, &t.1);
            removed += 1;
            names.push(t.1.clone());
            *by_why.entry(t.4).or_default() += 1;
        }
        let more = p.todo.len() as i64 - removed as i64;
        let mut s = self.load_state(vid);
        let at = (self.now)();
        let seen: HashSet<String> = gone.iter().map(|g| format!("{},{},{}", json::num_str(g.0), json::num_str(g.1), json::num_str(g.2))).collect();
        if more <= 0 && cfg.with_footage {
            let cur = Self::gone_of(&s);
            let kept: Vec<(f64, f64, f64)> = cur
                .into_iter()
                .filter(|g| !seen.contains(&format!("{},{},{}", json::num_str(g.0), json::num_str(g.1), json::num_str(g.2))) || (at - g.2 < GONE_KEEP_MS && p.held.iter().any(|(a, b)| g.0 < *b && g.1 > *a)))
                .collect();
            s.insert("gone".into(), Self::gone_value(&kept));
        }
        self.ctx.set_setting(&format!("can-prune:{}", vid), Value::Object(s));
        let (f, o, u) = (*by_why.get("footage").unwrap_or(&0), *by_why.get("old").unwrap_or(&0), *by_why.get("unlinked").unwrap_or(&0));
        if removed > 0 {
            let parts: Vec<String> = [
                (f > 0).then(|| format!("{} with their footage deleted", f)),
                (o > 0).then(|| format!("{} older than the car's oldest footage", o)),
                (u > 0).then(|| format!("{} not linked to footage after {} days", u, json::num_str(cfg.unlinked_days))),
            ]
            .into_iter()
            .flatten()
            .collect();
            let parts = parts.join(", ");
            self.ctx.log("info", &format!("CAN logs: removed {} ({}) (car {})", removed, parts, v.name));
            self.ctx.audit(
                "info",
                &format!("CAN logs deleted (car {}): {} ({}), {}{}: automatic (Nerd settings, Keeping logs)", v.name, removed, parts, names[0], if removed > 1 { format!(" to {}", names[names.len() - 1]) } else { String::new() }),
            );
        }
        if more > 0 && removed > 0 {
            self.soon(vid, 60_000.0);
        }
        let mut last = Map::new();
        for (k, val) in [("removed", json!(removed)), ("footage", json!(f)), ("old", json!(o)), ("unlinked", json!(u)), ("pending", json!(p.pending)), ("more", json!(more.max(0))), ("oldestFootage", n(p.oldest))] {
            last.insert(k.into(), val);
        }
        Some(self.done(vid, last))
    }

    /// check(vid): one run per car at a time; asked during one: once more after it.
    pub fn check(&self, vid: &str) -> Option<Value> {
        {
            let mut r = self.running.lock().unwrap();
            if let Some(again) = r.get_mut(vid) {
                *again = true;
                return None;
            }
            r.insert(vid.to_string(), false);
        }
        let mut out;
        loop {
            out = self.run(vid);
            let mut r = self.running.lock().unwrap();
            if r.get(vid) == Some(&true) {
                r.insert(vid.to_string(), false);
                continue;
            }
            r.remove(vid);
            break;
        }
        out
    }

    /// sweep(): every car (the hourly look).
    pub fn sweep(&self) {
        if !Self::any_on(&self.settings()) {
            return;
        }
        for v in self.ctx.vehicles() {
            self.check(&v.id);
        }
    }

    /// set(input): the "Keeping logs" settings.
    pub fn set(&self, input: &Value) -> Value {
        let cur = self.settings();
        let days = input.get("unlinkedDays").map(|d| json::js_number(Some(d))).unwrap_or(f64::NAN);
        let next = Keep {
            with_footage: input.get("withFootage").and_then(|v| v.as_bool()).unwrap_or(cur.with_footage),
            delete_unlinked: input.get("deleteUnlinked").and_then(|v| v.as_bool()).unwrap_or(cur.delete_unlinked),
            unlinked_days: if days.fract() == 0.0 && (1.0..=365.0).contains(&days) { days } else { cur.unlinked_days },
        };
        let v = json!({ "withFootage": next.with_footage, "deleteUnlinked": next.delete_unlinked, "unlinkedDays": n(next.unlinked_days) });
        self.ctx.set_setting("can-keep", v.clone());
        if Self::any_on(&next) {
            for car in self.ctx.vehicles() {
                self.soon(&car.id, 5000.0);
            }
        }
        v
    }

    pub fn status(&self) -> Value {
        let mut o = self.settings_json();
        let cars: Map<String, Value> = self.ctx.vehicles().into_iter().map(|v| (v.id.clone(), self.load_state(&v.id).get("last").cloned().unwrap_or(Value::Null))).collect();
        o.insert("cars".into(), Value::Object(cars));
        Value::Object(o)
    }
}
