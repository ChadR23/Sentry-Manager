//! "When did this start" (server/canSearch.js): over every indexed CAN minute
//! of a car, the first times a decoded signal met a condition, and when CAN
//! ids appeared or stopped. A scan reads for at most 45 s, then answers a
//! token that goes on where it stopped. One search at a time for everyone,
//! one per user (a newer one stops the older), a few waiting (createSearchQueue).

use super::format::{self, ids_of_head};
use super::index::minute_key;
use super::json::{self, n};
use super::tz;
use super::util;
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

pub const OPS: [&str; 8] = [">", "<", ">=", "<=", "=", "!=", "changed", "appeared"];
const BUDGET_MS: f64 = 45_000.0;
const KEEP_MS: f64 = 15.0 * 60_000.0;
const KEEP_MAX: usize = 16;

#[derive(Debug, Clone)]
pub struct SearchError {
    pub status: u16,
    pub message: String,
}
fn err(msg: impl Into<String>) -> SearchError {
    SearchError { status: 400, message: msg.into() }
}
fn err_s(status: u16, msg: impl Into<String>) -> SearchError {
    SearchError { status, message: msg.into() }
}

/// localKey: a UTC time as the car's wall clock, YYYY-MM-DD_HH-MM-SS.
pub fn local_key(ms: f64, zone: &str) -> String {
    let (y, mo, d, h, mi, s) = tz::parts(zone, ms.floor() as i64);
    format!("{:04}-{:02}-{:02}_{:02}-{:02}-{:02}", y, mo, d, h, mi, s)
}
/// localTime: the same as "YYYY-MM-DD HH:MM:SS".
pub fn local_time(ms: f64, zone: &str) -> String {
    let k = local_key(ms, zone);
    format!("{} {}:{}:{}", &k[..10], &k[11..13], &k[14..16], &k[17..19])
}
fn key_seconds(k: &str) -> Option<f64> {
    let b = k.as_bytes();
    if b.len() != 19 || b[10] != b'_' {
        return None;
    }
    let num = |a: usize, z: usize| k.get(a..z)?.parse::<i64>().ok();
    Some(tz::utc_ms(num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?) as f64 / 1000.0)
}

/// tsFrom: YYYY-MM-DD_HH-MM-SS of a clip name, or None.
pub fn ts_from(name: &str) -> Option<String> {
    let b = name.as_bytes();
    if b.len() < 19 {
        return None;
    }
    for i in 0..=b.len() - 19 {
        let w = &b[i..i + 19];
        let d = |j: usize| w[j].is_ascii_digit();
        if (0..4).all(d) && w[4] == b'-' && d(5) && d(6) && w[7] == b'-' && d(8) && d(9) && w[10] == b'_' && d(11) && d(12) && w[13] == b'-' && d(14) && d(15) && w[16] == b'-' && d(17) && d(18) {
            return Some(String::from_utf8_lossy(w).into_owned());
        }
    }
    None
}

/// clipStamps: every clip name stamp of a car's recordings, sorted, once each.
pub fn clip_stamps<'a>(clip_rels: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut set: Vec<String> = clip_rels.filter_map(|r| ts_from(r.rsplit('/').next().unwrap_or(r))).collect::<HashSet<_>>().into_iter().collect();
    set.sort();
    set
}

/// footageAt: the clip covering a moment, or null.
pub fn footage_at(stamps: Option<&[String]>, ms: f64, zone: &str) -> Value {
    let Some(stamps) = stamps.filter(|s| !s.is_empty()) else { return Value::Null };
    if !ms.is_finite() {
        return Value::Null;
    }
    let key = local_key(ms, zone);
    let best = stamps.partition_point(|s| s.as_str() <= key.as_str());
    if best == 0 {
        return Value::Null;
    }
    let st = &stamps[best - 1];
    let second = match (key_seconds(&key), key_seconds(st)) {
        (Some(a), Some(b)) => a - b,
        _ => f64::NAN,
    };
    if !(second >= 0.0 && second < 62.0) {
        return Value::Null;
    }
    json!({ "at": n(ms), "localTime": local_time(ms, zone), "day": &st[..10], "clip": st, "second": n(second.floor()) })
}

fn real_time(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64) -> bool {
    let t = tz::utc_ms(y, mo, d, 0, 0, 0);
    let (yy, mm, dd) = tz::civil_from_days(t.div_euclid(86_400_000));
    yy == y && mm == mo && dd == d && h <= 23 && mi <= 59 && s <= 59
}

/// parseWhen: a time from a query (ms, ISO with a zone, or the car's wall clock); None for nothing.
pub fn parse_when(s: Option<&str>, to_utc: &dyn Fn(i64, i64, i64, i64, i64, i64) -> f64, end: bool) -> Result<Option<f64>, SearchError> {
    let t = s.unwrap_or("").trim();
    if t.is_empty() {
        return Ok(None);
    }
    let bad = || err(format!("\"{}\" is not a time: give YYYY-MM-DD or YYYY-MM-DDTHH:MM.", util::utf16_slice(t, 40)));
    let b = t.as_bytes();
    if (9..=15).contains(&b.len()) && b.iter().all(|c| c.is_ascii_digit()) {
        return Ok(Some(t.parse::<f64>().unwrap()));
    }
    let d = |i: usize| b.get(i).is_some_and(|c| c.is_ascii_digit());
    let num = |a: usize, z: usize| t[a..z].parse::<i64>().unwrap();
    let date = b.len() >= 10 && (0..4).all(d) && b[4] == b'-' && d(5) && d(6) && b[7] == b'-' && d(8) && d(9);
    // with a zone: YYYY-MM-DDTHH:MM[:SS[.fff]](Z|±HH[:]MM)
    if date && b.len() >= 17 && (b[10] == b'T' || b[10] == b't') && d(11) && d(12) && b[13] == b':' && d(14) && d(15) {
        let mut i = 16;
        let mut sec = 0;
        let mut ok = true;
        if b.get(i) == Some(&b':') {
            if d(i + 1) && d(i + 2) {
                sec = num(i + 1, i + 3);
                i += 3;
                if b.get(i) == Some(&b'.') {
                    let st = i + 1;
                    let mut j = st;
                    while d(j) {
                        j += 1;
                    }
                    if j == st || j - st > 3 {
                        ok = false;
                    }
                    i = j;
                }
            } else {
                ok = false;
            }
        }
        let zone = &t[i.min(t.len())..];
        let zb = zone.as_bytes();
        let zone_ok = zone.eq_ignore_ascii_case("z")
            || (matches!(zb.first(), Some(b'+') | Some(b'-'))
                && ((zb.len() == 5 && zb[1..].iter().all(|c| c.is_ascii_digit())) || (zb.len() == 6 && zb[3] == b':' && zb[1..3].iter().chain(&zb[4..]).all(|c| c.is_ascii_digit()))));
        if ok && zone_ok {
            let ms = tz::parse_iso(t);
            if !real_time(num(0, 4), num(5, 7), num(8, 10), num(11, 13), num(14, 16), sec) || ms.is_none() {
                return Err(bad());
            }
            return Ok(Some(ms.unwrap() as f64));
        }
    }
    // the car's wall clock: YYYY-MM-DD[(T| )HH:MM[:SS]]
    if !date {
        return Err(bad());
    }
    let (y, mo, dd) = (num(0, 4), num(5, 7), num(8, 10));
    if b.len() == 10 {
        if !real_time(y, mo, dd, 0, 0, 0) {
            return Err(bad());
        }
        let day = to_utc(y, mo, dd, 0, 0, 0);
        if !end {
            return Ok(Some(day));
        }
        let next = tz::utc_ms(y, mo, dd + 1, 0, 0, 0);
        let (ny, nm, nd) = tz::civil_from_days(next.div_euclid(86_400_000));
        return Ok(Some(to_utc(ny, nm, nd, 0, 0, 0) - 1.0));
    }
    let timed = (b.len() == 16 || b.len() == 19) && (b[10] == b'T' || b[10] == b' ') && d(11) && d(12) && b[13] == b':' && d(14) && d(15) && (b.len() == 16 || (b[16] == b':' && d(17) && d(18)));
    if !timed {
        return Err(bad());
    }
    let (h, mi) = (num(11, 13), num(14, 16));
    let s = if b.len() == 19 { num(17, 19) } else { 0 };
    if !real_time(y, mo, dd, h, mi, s) {
        return Err(bad());
    }
    Ok(Some(to_utc(y, mo, dd, h, mi, s) + if end && b.len() == 16 { 59_999.0 } else { 0.0 }))
}

#[derive(Clone, Debug)]
struct SignalSt {
    name: String,
    op: String,
    want: Option<f64>,
    names: Option<Map<String, Value>>,
    unit: String,
    all: bool,
    limit: usize,
    lo: f64,
    hi: f64,
    next: Option<f64>,
    matches: Vec<Value>,
    matching_minutes: u64,
    with_data: u64,
    scanned: u64,
    prev: Option<f64>,
    in_match: bool,
    last_t: Option<f64>,
}

#[derive(Clone, Debug)]
struct IdStat {
    first: f64,
    last: f64,
    seen: u64,
    run: u64,
    run_start: u64,
    last_awake: u64,
    missing: u64,
    missing_since: Option<f64>,
    open: Option<usize>,
}

#[derive(Clone, Debug)]
struct IdsSt {
    gap: u64,
    limit: usize,
    regular: f64,
    min_seen: u64,
    settle: u64,
    only: Option<String>,
    before: Option<f64>,
    lo: f64,
    hi: f64,
    next: Option<f64>,
    stats: IndexMap<String, IdStat>,
    stopped: Vec<Map<String, Value>>,
    awake: u64,
    scanned: u64,
    settled_at: Option<f64>,
    first_minute: Option<f64>,
    last_minute: Option<f64>,
}

#[derive(Clone)]
enum Kept {
    Signal(SignalSt),
    Ids(IdsSt),
}

pub struct SignalQuery {
    pub signal: Option<String>,
    pub op: Option<String>,
    pub value: Option<String>,
    pub from: Option<f64>,
    pub to: Option<f64>,
    pub limit: Option<String>,
    pub all: bool,
    pub resume: Option<String>,
}

pub struct IdsQuery {
    pub from: Option<f64>,
    pub to: Option<f64>,
    pub before: Option<f64>,
    pub gap: Option<String>,
    pub id: Option<String>,
    pub limit: Option<String>,
    pub resume: Option<String>,
}

pub struct CanSearch {
    pub dir: PathBuf,
    pub now: Box<dyn Fn() -> f64 + Send + Sync>,
    pub budget_ms: f64,
    kept: Mutex<Vec<(String, String, String, f64, Kept)>>, // token, kind, keys, at, state
}

fn minute_of(name: &str) -> Option<f64> {
    super::index::minute_of_file(name)
}

/// Math.floor(Number(x)) || d, as the Node code reads a count from a query.
fn count_of(v: Option<&str>, d: f64) -> f64 {
    let x = v.map(json::str_number).unwrap_or(f64::NAN).floor();
    if x.is_nan() || x == 0.0 { d } else { x }
}

impl CanSearch {
    pub fn new(dir: PathBuf) -> CanSearch {
        CanSearch { dir, now: Box::new(util::now_ms), budget_ms: BUDGET_MS, kept: Mutex::new(Vec::new()) }
    }

    fn file_of(&self, key: &str, t: f64) -> PathBuf {
        self.dir.join(key).join(format!("{}.json.gz", minute_key(t)))
    }

    fn read_ids(&self, key: &str, t: f64) -> Option<IndexMap<String, f64>> {
        let f = self.file_of(key, t);
        if let Some(h) = ids_of_head(format::read_head(&f).as_ref()) {
            return Some(h);
        }
        let text = format::gunzip(&std::fs::read(&f).ok()?)?;
        let text = String::from_utf8_lossy(&text).into_owned();
        if let Some(at) = text.rfind(",\"ids\":").filter(|a| *a > 0) {
            if text.ends_with('}') {
                if let Ok(v) = serde_json::from_str::<Value>(&text[at + 7..text.len() - 1]) {
                    return Some(obj_counts(&v));
                }
            }
        }
        let v: Value = serde_json::from_str(&text).ok()?;
        Some(obj_counts(v.get("ids").unwrap_or(&Value::Null)))
    }

    /// minutesOf: every indexed minute of these cars between two times, oldest first.
    pub fn minutes_of(&self, keys: &[String], from: f64, to: f64) -> Vec<(f64, Vec<String>)> {
        let mut by: IndexMap<i64, Vec<String>> = IndexMap::new();
        for key in keys {
            if !super::logs::valid_key(key) {
                continue;
            }
            let Some(names) = util::names(&self.dir.join(key)) else { continue };
            for name in names {
                let Some(t) = minute_of(&name) else { continue };
                if t + 60_000.0 <= from || t > to {
                    continue;
                }
                by.entry(t as i64).or_default().push(key.clone());
            }
        }
        let mut v: Vec<(f64, Vec<String>)> = by.into_iter().map(|(t, k)| (t as f64, k)).collect();
        v.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        v
    }

    fn meta_of(&self, keys: &[String], name: &str) -> Option<Value> {
        for key in keys {
            if let Some(all) = util::read_json(&self.dir.join(key).join("signals.json")) {
                if let Some(m) = all.get(name).filter(|v| json::truthy(Some(v))) {
                    return Some(m.clone());
                }
            }
        }
        None
    }

    fn keep(&self, kind: &str, keys: &[String], st: Kept, token: Option<String>) -> String {
        let token = token.unwrap_or_else(|| util::hex(&util::random(12)));
        let t = (self.now)();
        let mut k = self.kept.lock().unwrap();
        k.retain(|p| t - p.3 <= KEEP_MS);
        while k.len() >= KEEP_MAX {
            k.remove(0);
        }
        k.retain(|p| p.0 != token);
        k.push((token.clone(), kind.to_string(), keys.join(","), t, st));
        token
    }
    fn take_kept(&self, kind: &str, keys: &[String], token: &str) -> Result<Kept, SearchError> {
        let mut k = self.kept.lock().unwrap();
        let Some(i) = k.iter().position(|p| p.0 == token) else { return Err(err("That search is no longer kept: search again.")) };
        let p = &k[i];
        if p.1 != kind || p.2 != keys.join(",") || (self.now)() - p.3 > KEEP_MS {
            return Err(err("That search is no longer kept: search again."));
        }
        Ok(k.remove(i).4)
    }
    fn halt(&self, kind: &str, keys: &[String], st: Kept, token: Option<&String>) -> SearchError {
        if let Some(t) = token {
            self.keep(kind, keys, st, Some(t.clone()));
        }
        err_s(409, "The search was stopped.")
    }

    fn signal_start(&self, keys: &[String], q: &SignalQuery) -> Result<SignalSt, SearchError> {
        let name = q.signal.as_deref().unwrap_or("").trim().to_string();
        if name.is_empty() || name.len() > 80 || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
            return Err(err("Give the signal's name."));
        }
        let op = q.op.clone().unwrap_or_default();
        if !OPS.contains(&op.as_str()) {
            return Err(err(format!("The condition is one of {}.", OPS.join(" "))));
        }
        let meta = self.meta_of(keys, &name);
        let names = meta.as_ref().and_then(|m| m.get("values")).filter(|v| json::truthy(Some(v))).and_then(|v| v.as_object()).cloned();
        let mut want = None;
        if op != "changed" && op != "appeared" {
            let raw = q.value.as_deref().unwrap_or("").trim().to_string();
            if raw.is_empty() {
                return Err(err("Give the value to compare with."));
            }
            let mut w = json::str_number(&raw);
            if !w.is_finite() {
                let hit = names.as_ref().and_then(|m| json::ordered_keys(m).into_iter().find(|k| super::logs::js_string(&m[*k]).to_lowercase() == raw.to_lowercase()).cloned());
                match hit {
                    Some(k) => w = json::str_number(&k),
                    None => {
                        return Err(err(match &names {
                            Some(m) => format!("\"{}\" is not a value of {} (it has {}).", raw, name, json::ordered_keys(m).into_iter().take(12).map(|k| super::logs::js_string(&m[k])).collect::<Vec<_>>().join(", ")),
                            None => format!("\"{}\" is not a number.", raw),
                        }))
                    }
                }
            }
            want = Some(w);
        }
        let limit = count_of(q.limit.as_deref(), 10.0).clamp(1.0, 200.0) as usize;
        Ok(SignalSt {
            name,
            op,
            want,
            names,
            unit: meta.as_ref().and_then(|m| m.get("unit")).filter(|v| json::truthy(Some(v))).map(|v| super::logs::js_string(v)).unwrap_or_default(),
            all: q.all,
            limit,
            lo: q.from.filter(|x| x.is_finite()).unwrap_or(f64::NEG_INFINITY),
            hi: q.to.filter(|x| x.is_finite()).unwrap_or(f64::INFINITY),
            next: None,
            matches: Vec::new(),
            matching_minutes: 0,
            with_data: 0,
            scanned: 0,
            prev: None,
            in_match: false,
            last_t: None,
        })
    }

    /// signal: the first (and next) times a signal met a condition.
    pub fn signal(&self, keys: &[String], q: &SignalQuery, stop: &AtomicBool) -> Result<Value, SearchError> {
        let mut st = match &q.resume {
            Some(tok) => match self.take_kept("signal", keys, tok)? {
                Kept::Signal(s) => s,
                _ => return Err(err("That search is no longer kept: search again.")),
            },
            None => self.signal_start(keys, q)?,
        };
        const EPS: f64 = 1e-9;
        let want = st.want.unwrap_or(f64::NAN);
        let op = st.op.clone();
        let test = |v: f64| -> bool {
            match op.as_str() {
                ">" => v > want,
                "<" => v < want,
                ">=" => v >= want - EPS,
                "<=" => v <= want + EPS,
                "=" => (v - want).abs() <= EPS,
                "!=" => (v - want).abs() > EPS,
                _ => false,
            }
        };
        let label = |names: &Option<Map<String, Value>>, v: Option<f64>| -> Value {
            let Some(v) = v else { return Value::Null };
            names.as_ref().and_then(|m| m.get(&json::num_str(v))).map(|x| Value::String(super::logs::js_string(x))).unwrap_or(Value::Null)
        };
        let minutes = self.minutes_of(keys, st.next.unwrap_or(st.lo), st.hi);
        let deadline = (self.now)() + self.budget_ms;
        let scanned_before = st.scanned;
        let mut complete = true;
        let mut token: Option<String> = None;
        for (t, ks) in &minutes {
            if stop.load(Ordering::SeqCst) {
                st.next = Some(*t);
                return Err(self.halt("signal", keys, Kept::Signal(st), q.resume.as_ref()));
            }
            if (self.now)() > deadline {
                complete = false;
                st.next = Some(*t);
                token = Some(self.keep("signal", keys, Kept::Signal(st.clone()), q.resume.clone()));
                break;
            }
            let mut pts: Vec<(f64, f64)> = Vec::new();
            for key in ks {
                if let Some(m) = format::read_minute_file(&self.file_of(key, *t)) {
                    if let Some(p) = m.signals.get(&st.name) {
                        for (ms, v) in p {
                            pts.push((t + ms, *v));
                        }
                    }
                }
            }
            if ks.len() > 1 {
                pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            }
            st.scanned += 1;
            if st.last_t.is_some_and(|l| t - l > 60_000.0) {
                st.in_match = false;
            }
            st.last_t = Some(*t);
            let mut hit = false;
            for (at, v) in &pts {
                if *at < st.lo || *at > st.hi {
                    continue;
                }
                let ok = match st.op.as_str() {
                    "appeared" => true,
                    "changed" => st.prev.is_some_and(|p| *v != p),
                    _ => test(*v),
                };
                let before = st.prev;
                st.prev = Some(*v);
                if !ok {
                    st.in_match = false;
                    continue;
                }
                hit = true;
                if (!st.in_match || st.op == "changed") && st.matches.len() < st.limit {
                    let mut m = Map::new();
                    m.insert("at".into(), n(*at));
                    m.insert("value".into(), n(*v));
                    m.insert("text".into(), label(&st.names, Some(*v)));
                    if st.op == "changed" {
                        m.insert("previous".into(), before.map(n).unwrap_or(Value::Null));
                        m.insert("previousText".into(), label(&st.names, before));
                    }
                    st.matches.push(Value::Object(m));
                }
                st.in_match = true;
            }
            if !pts.is_empty() {
                st.with_data += 1;
            } else {
                st.in_match = false;
            }
            if hit {
                st.matching_minutes += 1;
            }
            if !st.all && st.matches.len() >= st.limit {
                complete = st.scanned - scanned_before == minutes.len() as u64;
                break;
            }
        }
        Ok(json!({
            "signal": st.name, "op": st.op, "value": st.want.map(n), "unit": st.unit, "first": st.matches.first().cloned(), "matches": st.matches,
            "matchingMinutes": st.matching_minutes, "minutesWithData": st.with_data, "scannedMinutes": st.scanned, "totalMinutes": scanned_before + minutes.len() as u64,
            "complete": complete, "resumeFrom": if token.is_some() { st.next.map(n) } else { None }, "resume": token
        }))
    }

    /// ids: new CAN ids, and regularly-seen ids that stopped.
    pub fn ids(&self, keys: &[String], q: &IdsQuery, stop: &AtomicBool) -> Result<Value, SearchError> {
        let mut st = match &q.resume {
            Some(tok) => match self.take_kept("ids", keys, tok)? {
                Kept::Ids(s) => s,
                _ => return Err(err("That search is no longer kept: search again.")),
            },
            None => IdsSt {
                gap: count_of(q.gap.as_deref(), 10.0).clamp(1.0, 10_000.0) as u64,
                limit: count_of(q.limit.as_deref(), 200.0).clamp(1.0, 1000.0) as usize,
                regular: 0.9,
                min_seen: 30,
                settle: 60,
                only: q.id.as_deref().filter(|s| !s.is_empty()).map(|s| s.trim().to_lowercase()),
                before: q.before.filter(|x| x.is_finite()),
                lo: if q.before.is_some_and(|x| x.is_finite()) { f64::NEG_INFINITY } else { q.from.filter(|x| x.is_finite()).unwrap_or(f64::NEG_INFINITY) },
                hi: q.to.filter(|x| x.is_finite()).unwrap_or(f64::INFINITY),
                next: None,
                stats: IndexMap::new(),
                stopped: Vec::new(),
                awake: 0,
                scanned: 0,
                settled_at: None,
                first_minute: None,
                last_minute: None,
            },
        };
        let only = st.only.clone();
        let only_hex = only.as_ref().and_then(|o| super::index::parse_int_hex(o.rsplit(':').next().unwrap_or("").trim_start_matches("0x")));
        let matches_id = |k: &str| -> bool {
            match &only {
                None => true,
                Some(o) if o.contains(':') => k.to_lowercase() == *o,
                Some(_) => only_hex.is_some() && super::index::parse_int_hex(k.rsplit(':').next().unwrap_or("")) == only_hex,
            }
        };
        let minutes = self.minutes_of(keys, st.next.unwrap_or(st.lo), st.hi);
        let deadline = (self.now)() + self.budget_ms;
        let scanned_before = st.scanned;
        let mut complete = true;
        let mut token = None;
        let mut keep_later = false;
        if st.first_minute.is_none() {
            st.first_minute = minutes.first().map(|m| m.0);
        }
        for (t, ks) in &minutes {
            if stop.load(Ordering::SeqCst) {
                st.next = Some(*t);
                return Err(self.halt("ids", keys, Kept::Ids(st), q.resume.as_ref()));
            }
            if (self.now)() > deadline {
                complete = false;
                st.next = Some(*t);
                keep_later = true;
                break;
            }
            let mut here: IndexMap<String, ()> = IndexMap::new();
            for key in ks {
                for k in self.read_ids(key, *t).unwrap_or_default().keys() {
                    here.insert(k.clone(), ());
                }
            }
            st.scanned += 1;
            st.last_minute = Some(*t);
            if here.is_empty() {
                continue;
            }
            st.awake += 1;
            if st.awake == st.settle {
                st.settled_at = Some(*t);
            }
            let awake = st.awake;
            for k in here.keys() {
                let gap = st.gap;
                let s = st.stats.entry(k.clone()).or_insert(IdStat { first: *t, last: *t, seen: 0, run: 0, run_start: awake, last_awake: awake, missing: 0, missing_since: None, open: None });
                if s.missing >= gap {
                    s.run = 0;
                    s.run_start = awake;
                }
                s.seen += 1;
                s.run += 1;
                s.last = *t;
                s.last_awake = awake;
                if let Some(o) = s.open.take() {
                    st.stopped[o].insert("back".into(), n(*t));
                    st.stopped[o].insert("missingMinutes".into(), json!(s.missing));
                }
                s.missing = 0;
                s.missing_since = None;
            }
            let ids: Vec<String> = st.stats.keys().cloned().collect();
            for k in ids {
                if here.contains_key(&k) {
                    continue;
                }
                let (gap, limit, min_seen, regular) = (st.gap, st.limit, st.min_seen, st.regular);
                let s = st.stats.get_mut(&k).unwrap();
                s.missing += 1;
                if s.missing == 1 {
                    s.missing_since = Some(*t);
                }
                if s.missing != gap || s.open.is_some() {
                    continue;
                }
                if s.run >= min_seen && s.run as f64 / (s.last_awake - s.run_start + 1) as f64 >= regular && matches_id(&k) {
                    let mut o = Map::new();
                    o.insert("id".into(), json!(k));
                    o.insert("at".into(), s.missing_since.map(n).unwrap_or(Value::Null));
                    o.insert("lastSeen".into(), n(s.last + 59_999.0));
                    o.insert("seenMinutes".into(), json!(s.seen));
                    o.insert("back".into(), Value::Null);
                    o.insert("missingMinutes".into(), Value::Null);
                    if st.stopped.len() < limit {
                        st.stopped.push(o);
                        s.open = Some(st.stopped.len() - 1);
                    } else {
                        // (an open episode not listed: tracked so it is not opened again)
                        s.open = Some(usize::MAX);
                    }
                }
            }
        }
        // still missing (as far as read): in the kept state too, as the Node code's shared objects are
        let opens: Vec<(usize, u64)> = st.stats.values().filter_map(|s| s.open.filter(|o| *o != usize::MAX).map(|o| (o, s.missing))).collect();
        for (o, m) in opens {
            st.stopped[o].insert("missingMinutes".into(), json!(m));
        }
        let stopped_now = st.stopped.clone();
        if keep_later {
            token = Some(self.keep("ids", keys, Kept::Ids(st.clone()), q.resume.clone()));
        }
        let baseline = st.before.or(st.settled_at);
        let mut appeared: Vec<(String, f64, f64, u64)> = Vec::new();
        for (k, s) in &st.stats {
            let new = match st.before {
                Some(b) => s.first >= (b / 60_000.0).floor() * 60_000.0,
                None => st.settled_at.is_some_and(|sa| s.first > sa),
            };
            if new && matches_id(k) {
                appeared.push((k.clone(), s.first, s.last + 59_999.0, s.seen));
            }
        }
        appeared.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal).then_with(|| util::locale_cmp(&a.0, &b.0)));
        let mut out = Map::new();
        out.insert("gap".into(), json!(st.gap));
        out.insert("baseline".into(), baseline.map(n).unwrap_or(Value::Null));
        out.insert("firstMinute".into(), st.first_minute.map(n).unwrap_or(Value::Null));
        out.insert("lastMinute".into(), st.last_minute.map(n).unwrap_or(Value::Null));
        out.insert("awakeMinutes".into(), json!(st.awake));
        out.insert("idCount".into(), json!(st.stats.len()));
        out.insert("appeared".into(), Value::Array(appeared.iter().take(st.limit).map(|a| json!({ "id": a.0, "at": n(a.1), "lastSeen": n(a.2), "seenMinutes": a.3 })).collect()));
        out.insert("appearedCount".into(), json!(appeared.len()));
        out.insert("stopped".into(), Value::Array(stopped_now.into_iter().map(Value::Object).collect()));
        if only.is_some() {
            out.insert("ids".into(), Value::Array(st.stats.iter().filter(|(k, _)| matches_id(k)).map(|(k, s)| json!({ "id": k, "first": n(s.first), "last": n(s.last + 59_999.0), "seenMinutes": s.seen })).collect()));
        }
        out.insert("scannedMinutes".into(), json!(st.scanned));
        out.insert("totalMinutes".into(), json!(scanned_before + minutes.len() as u64));
        out.insert("complete".into(), json!(complete));
        out.insert("resumeFrom".into(), if token.is_some() { st.next.map(n).unwrap_or(Value::Null) } else { Value::Null });
        out.insert("resume".into(), token.map(Value::String).unwrap_or(Value::Null));
        Ok(Value::Object(out))
    }
}

fn obj_counts(v: &Value) -> IndexMap<String, f64> {
    let mut out = IndexMap::new();
    if let Value::Object(m) = v {
        for k in json::ordered_keys(m) {
            out.insert(k.clone(), m[k].as_f64().unwrap_or(0.0));
        }
    }
    out
}

// ---- one search at a time, for everyone (createSearchQueue)
struct QJob {
    id: u64,
    owner: String,
    stop: Arc<AtomicBool>,
    why: Mutex<Option<String>>,
    removed: AtomicBool,
}

#[derive(Default)]
struct QState {
    running: Option<Arc<QJob>>,
    queue: VecDeque<Arc<QJob>>,
    next_id: u64,
}

pub struct SearchQueue {
    waiting: usize,
    st: Mutex<QState>,
    cv: Condvar,
}

pub struct Cancel(Arc<QJob>, Arc<SearchQueue>);
impl Cancel {
    /// The page closed: the search stops (or leaves the queue).
    pub fn cancel(&self, why: &str) {
        let mut st = self.1.st.lock().unwrap();
        SearchQueue::cancel_job(&mut st, &self.0, why);
        self.1.cv.notify_all();
    }
}

impl SearchQueue {
    pub fn new(waiting: usize) -> Arc<SearchQueue> {
        Arc::new(SearchQueue { waiting, st: Mutex::new(QState::default()), cv: Condvar::new() })
    }

    fn cancel_job(st: &mut QState, j: &Arc<QJob>, why: &str) {
        *j.why.lock().unwrap() = Some(why.to_string());
        j.stop.store(true, Ordering::SeqCst);
        if let Some(i) = st.queue.iter().position(|x| x.id == j.id) {
            st.queue.remove(i);
            j.removed.store(true, Ordering::SeqCst);
        }
    }

    /// A ticket in the queue (a newer search of the same owner stops the older), or 429.
    pub fn enter(self: &Arc<Self>, owner: &str) -> Result<Cancel, SearchError> {
        let mut st = self.st.lock().unwrap();
        let mine: Vec<Arc<QJob>> = st.running.iter().cloned().chain(st.queue.iter().cloned()).filter(|j| !owner.is_empty() && j.owner == owner).collect();
        for j in mine {
            Self::cancel_job(&mut st, &j, "Stopped: a newer search took its place.");
        }
        self.cv.notify_all();
        if st.queue.len() >= self.waiting {
            return Err(err_s(429, "The CAN search is busy with other searches: try again in a minute."));
        }
        st.next_id += 1;
        let job = Arc::new(QJob { id: st.next_id, owner: owner.to_string(), stop: Arc::new(AtomicBool::new(false)), why: Mutex::new(None), removed: AtomicBool::new(false) });
        st.queue.push_back(job.clone());
        Ok(Cancel(job, self.clone()))
    }

    /// Run a job entered before, when its turn comes; a cancelled one answers 409 with why.
    pub fn run<T>(&self, ticket: &Cancel, f: impl FnOnce(&AtomicBool) -> Result<T, SearchError>) -> Result<T, SearchError> {
        let job = ticket.0.clone();
        let stopped = |j: &QJob| err_s(409, j.why.lock().unwrap().clone().unwrap_or_else(|| "The search was stopped.".into()));
        {
            let mut st = self.st.lock().unwrap();
            loop {
                if job.removed.load(Ordering::SeqCst) {
                    return Err(stopped(&job));
                }
                if st.running.is_none() && st.queue.front().is_some_and(|f| f.id == job.id) {
                    st.queue.pop_front();
                    st.running = Some(job.clone());
                    break;
                }
                st = self.cv.wait(st).unwrap();
            }
        }
        let out = if job.stop.load(Ordering::SeqCst) {
            Err(stopped(&job))
        } else {
            match f(&job.stop) {
                Err(e) if job.stop.load(Ordering::SeqCst) && e.status == 409 => Err(stopped(&job)),
                r => r,
            }
        };
        let mut st = self.st.lock().unwrap();
        st.running = None;
        self.cv.notify_all();
        out
    }

    pub fn size(&self) -> usize {
        let st = self.st.lock().unwrap();
        st.queue.len() + usize::from(st.running.is_some())
    }
}

#[allow(dead_code)]
fn _paths(_: &Path, _: HashMap<(), ()>) {}
