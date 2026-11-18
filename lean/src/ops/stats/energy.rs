//! energy.js: energy in Wh, integrated from the power samples, per day (in
//! the server's time zone) and per conversion job, and what it cost at the
//! price of each moment. Only time that was sampled counts. A job's record
//! keeps where the job stood when its energy began to be measured (its
//! baseline), so clips and space per kWh count only what was converted while
//! the energy was measured. Also the highest watts seen per server (peaks).

use crate::ops::js::num as jnum;
use chrono::{Datelike, Local, NaiveDate, TimeZone};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

const DAYS_KEPT: usize = 62;
const JOBS_KEPT: usize = 200;
const NODE_GAP_MS: i64 = 90_000;
const PEAK_MAX_W: f64 = 100_000.0;
const PEAKS_KEPT: usize = 64;

/// The local calendar date of t.
pub fn local_date(t: i64) -> NaiveDate {
    Local.timestamp_millis_opt(t).single().or_else(|| Local.timestamp_millis_opt(t).earliest()).map(|d| d.date_naive()).unwrap_or_default()
}

/// new Date(y, m, d, hour).getTime() for a local date (a time in a DST gap moves on, as V8 does).
pub fn local_ms(d: NaiveDate, hour: u32) -> i64 {
    let ndt = d.and_hms_opt(hour, 0, 0).unwrap_or_default();
    match Local.from_local_datetime(&ndt) {
        chrono::LocalResult::Single(x) => x.timestamp_millis(),
        chrono::LocalResult::Ambiguous(a, _) => a.timestamp_millis(),
        chrono::LocalResult::None => {
            // the hour does not exist (clocks went forward): the same wall time an hour on
            let later = ndt + chrono::Duration::hours(1);
            Local.from_local_datetime(&later).earliest().map(|x| x.timestamp_millis() - 3_600_000).unwrap_or(0)
        }
    }
}

/// 'YYYY-MM-DD' in the server's time zone.
pub fn day_key(t: i64) -> String {
    let d = local_date(t);
    format!("{:04}-{:02}-{:02}", d.year(), d.month(), d.day())
}

/// The 7 calendar days ending on t's day (counted by date).
pub fn week_keys(t: i64) -> Vec<String> {
    let d = local_date(t);
    (0..7).map(|i| day_key(local_ms(d - chrono::Duration::days(i), 12))).collect()
}

fn r3(n: f64) -> f64 {
    super::util::js_round(n * 1000.0) / 1000.0
}

/// a few seconds of a few watts cost a millionth; the screens round for display
pub fn money(n: Option<f64>) -> Option<f64> {
    n.map(|n| super::util::js_round(n * 1e6) / 1e6)
}

fn finite(n: Option<f64>) -> Option<f64> {
    n.filter(|x| x.is_finite() && *x >= 0.0)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Base {
    pub clips: f64,
    pub saved_b: f64,
    pub wh: f64,
}

/// A saved or reported baseline ({ clips, savedB, wh }), or None.
fn clean_base(base: &Value, max_wh: f64) -> Option<Base> {
    let o = base.as_object()?;
    let clips = o.get("clips")?.as_f64()?;
    let saved = o.get("savedB").and_then(Value::as_f64)?;
    let wh = finite(o.get("wh").and_then(Value::as_f64))?;
    let safe_int = clips.fract() == 0.0 && clips.abs() <= 9_007_199_254_740_991.0 && o["clips"].is_number();
    if !safe_int || clips < 0.0 || !saved.is_finite() || wh > max_wh {
        return None;
    }
    Some(Base { clips, saved_b: saved, wh })
}

#[derive(Clone, Debug, PartialEq)]
pub struct Job {
    pub wh: f64,
    pub seconds: f64,
    pub at: f64,
    pub cost: Option<f64>,
    pub base: Option<Base>,
    pub node_wh: Option<f64>,
}

impl Job {
    fn new(at: i64) -> Job {
        Job { wh: 0.0, seconds: 0.0, at: at as f64, cost: None, base: None, node_wh: None }
    }
}

/// Where a conversion job stands now ({ clips, savedB }), asked at each sample while its energy is counted.
pub type ProgressOf = Box<dyn Fn(&str) -> Option<(f64, f64)> + Send + Sync>;

#[derive(Clone, Debug)]
struct NodeReading {
    t: i64,
    w: f64,
    encoding: bool,
    job: Option<String>,
}

pub struct Energy {
    max_gap_ms: i64,
    last: Option<(i64, f64)>,
    /// insertion order kept, as a JS object's string keys
    days: Vec<(String, f64)>,
    costs: Vec<(String, f64)>,
    jobs: Vec<(String, Job)>,
    job: Option<String>,
    progress_of: Option<ProgressOf>,
    seen: HashMap<String, (f64, f64)>,
    marked: bool,
    peaks: Vec<(String, f64, f64)>,
    nodes: HashMap<String, Option<NodeReading>>,
}

fn get<'a, T>(v: &'a [(String, T)], k: &str) -> Option<&'a T> {
    v.iter().find(|e| e.0 == k).map(|e| &e.1)
}

fn get_mut<'a, T>(v: &'a mut [(String, T)], k: &str) -> Option<&'a mut T> {
    v.iter_mut().find(|e| e.0 == k).map(|e| &mut e.1)
}

/// JS object key order: integer-like keys first (ascending), then the rest in insertion order.
fn js_order<T: Clone>(v: &[(String, T)]) -> Vec<(String, T)> {
    let int = |k: &str| !k.is_empty() && k.len() < 10 && k.bytes().all(|c| c.is_ascii_digit()) && (k == "0" || !k.starts_with('0'));
    let mut a: Vec<(String, T)> = v.iter().filter(|e| int(&e.0)).cloned().collect();
    a.sort_by_key(|e| e.0.parse::<u64>().unwrap_or(0));
    a.extend(v.iter().filter(|e| !int(&e.0)).cloned());
    a
}

impl Energy {
    pub fn new(interval_ms: i64, progress_of: Option<ProgressOf>) -> Energy {
        Energy {
            max_gap_ms: (3 * interval_ms).max(10000),
            last: None,
            days: Vec::new(),
            costs: Vec::new(),
            jobs: Vec::new(),
            job: None,
            progress_of,
            seen: HashMap::new(),
            marked: false,
            peaks: Vec::new(),
            nodes: HashMap::new(),
        }
    }

    /// Remember w (W at time t) when it is the highest seen for key.
    pub fn note_peak(&mut self, key: &str, w: Option<f64>, t: f64) {
        let Some(w) = finite(w) else { return };
        if w <= 0.0 || w > PEAK_MAX_W || key.encode_utf16().count() > 200 {
            return;
        }
        let at = if t.is_finite() && t != 0.0 { t } else { 0.0 };
        let w = super::util::js_round(w * 10.0) / 10.0;
        if let Some(p) = self.peaks.iter_mut().find(|p| p.0 == key) {
            if p.1 >= w {
                return;
            }
            p.1 = w;
            p.2 = at;
            return;
        }
        if self.peaks.len() >= PEAKS_KEPT {
            return;
        }
        self.peaks.push((key.to_string(), w, at));
    }

    /// The highest W seen for key.
    pub fn peak(&self, key: &str) -> Option<f64> {
        self.peaks.iter().find(|p| p.0 == key).map(|p| p.1)
    }

    fn progress(&self, job: &str) -> Option<(f64, f64)> {
        let p = self.progress_of.as_ref()?(job)?;
        (p.0.fract() == 0.0 && p.0 >= 0.0 && p.1.is_finite()).then_some(p)
    }

    /// One power sample (W or None) at time t, and the price per kWh in force then.
    pub fn add(&mut self, t: i64, watts: Option<f64>, price: Option<f64>) {
        let w = finite(watts);
        if w.is_some() {
            self.note_peak("self", w, t as f64);
        }
        let prev = self.last;
        self.last = w.map(|w| (t, w));
        let ms = match (prev, w) {
            (Some(p), Some(_)) => Some(t - p.0),
            _ => None,
        };
        let counted = ms.is_some_and(|ms| ms > 0 && ms <= self.max_gap_ms);
        let now = self.job.clone().and_then(|j| self.progress(&j));
        if self.job.is_some() {
            self.follow(now, !counted || self.marked);
        }
        self.marked = false;
        if !counted {
            return;
        }
        let (pw, ms) = (prev.unwrap().1, ms.unwrap());
        let wh = (pw + w.unwrap()) / 2.0 * (ms as f64 / 3_600_000.0);
        let cost = finite(price).map(|p| wh / 1000.0 * p);
        let key = day_key(t);
        match get_mut(&mut self.days, &key) {
            Some(v) => *v += wh,
            None => self.days.push((key.clone(), wh)),
        }
        if let Some(c) = cost {
            match get_mut(&mut self.costs, &key) {
                Some(v) => *v += c,
                None => self.costs.push((key, c)),
            }
        }
        if let Some(job) = self.job.clone() {
            if get(&self.jobs, &job).is_none() {
                self.jobs.push((job.clone(), Job::new(t)));
            }
            let j = get_mut(&mut self.jobs, &job).unwrap();
            if j.base.is_none() {
                if let Some(n) = now {
                    j.base = Some(Base { clips: n.0, saved_b: n.1, wh: j.wh });
                }
            }
            j.wh += wh;
            j.seconds += ms as f64 / 1000.0;
            j.at = t as f64;
            if let Some(c) = cost {
                j.cost = Some(j.cost.unwrap_or(0.0) + c);
            }
        }
    }

    fn follow(&mut self, now: Option<(f64, f64)>, skipped: bool) {
        let Some(job) = self.job.clone() else { return };
        let seen = self.seen.get(&job).copied();
        if let (true, Some(j), Some(seen), Some(now)) = (skipped, get_mut(&mut self.jobs, &job), seen, now) {
            if let Some(b) = j.base {
                j.base = Some(Base { clips: (b.clips + now.0 - seen.0).max(0.0), saved_b: b.saved_b + now.1 - seen.1, wh: b.wh });
            }
        }
        if let Some(now) = now {
            self.seen.insert(job, now);
        }
    }

    /// A node's total W read at t, and whether it was converting clips of this server's job then.
    pub fn add_node(&mut self, node: &str, t: i64, watts: Option<f64>, encoding: bool, price: Option<f64>) {
        let w = finite(watts);
        let prev = self.nodes.get(node).cloned().flatten();
        if w.is_some() {
            self.note_peak(&format!("node:{node}"), w, t as f64);
        }
        self.nodes.insert(node.to_string(), w.map(|w| NodeReading { t, w, encoding, job: self.job.clone() }));
        let (Some(prev), Some(w), Some(job)) = (prev, w, self.job.clone()) else { return };
        if prev.job.as_deref() != Some(job.as_str()) {
            return;
        }
        if !prev.encoding && !encoding {
            return;
        }
        let ms = t - prev.t;
        if !(ms > 0 && ms <= NODE_GAP_MS) {
            return;
        }
        let wh = (prev.w + w) / 2.0 * (ms as f64 / 3_600_000.0);
        if get(&self.jobs, &job).is_none() {
            self.jobs.push((job.clone(), Job::new(t)));
        }
        let j = get_mut(&mut self.jobs, &job).unwrap();
        j.wh += wh;
        j.node_wh = Some(j.node_wh.unwrap_or(0.0) + wh);
        if let Some(p) = finite(price) {
            j.cost = Some(j.cost.unwrap_or(0.0) + wh / 1000.0 * p);
        }
    }

    pub fn mark_job(&mut self, job: Option<&str>) {
        let job = job.map(str::to_string);
        if job != self.job {
            self.marked = true;
        }
        self.job = job;
    }

    /// A job needs power samples to keep coming.
    pub fn active(&self) -> bool {
        self.job.is_some()
    }

    pub fn summary(&self, t: i64) -> Value {
        let today = day_key(t);
        let mut week = 0.0;
        let mut week_cost: Option<f64> = None;
        for key in week_keys(t) {
            week += get(&self.days, &key).copied().unwrap_or(0.0);
            if let Some(c) = get(&self.costs, &key) {
                week_cost = Some(week_cost.unwrap_or(0.0) + c);
            }
        }
        let mut by_job = Map::new();
        for (id, j) in js_order(&self.jobs) {
            let mut o = Map::new();
            o.insert("wh".into(), jnum(r3(j.wh)));
            o.insert("avgW".into(), if j.seconds > 0.0 { jnum(super::util::js_round(j.wh * 3600.0 / j.seconds * 10.0) / 10.0) } else { Value::Null });
            o.insert("seconds".into(), jnum(super::util::js_round(j.seconds)));
            o.insert("cost".into(), money(j.cost).map_or(Value::Null, jnum));
            if let Some(n) = j.node_wh.filter(|n| *n > 0.0) {
                o.insert("nodeWh".into(), jnum(r3(n)));
            }
            o.insert("base".into(), j.base.map_or(Value::Null, |b| json!({ "clips": jnum(b.clips), "savedB": jnum(b.saved_b), "wh": jnum(r3(b.wh)) })));
            by_job.insert(id, Value::Object(o));
        }
        json!({
            "todayWh": jnum(r3(get(&self.days, &today).copied().unwrap_or(0.0))), "weekWh": jnum(r3(week)),
            "todayCost": money(get(&self.costs, &today).copied()).map_or(Value::Null, jnum), "weekCost": money(week_cost).map_or(Value::Null, jnum),
            "byJob": by_job, "peakW": self.peak("self").map_or(Value::Null, jnum)
        })
    }

    fn trim(&mut self) {
        for map in [&mut self.days, &mut self.costs] {
            let mut keys: Vec<String> = map.iter().map(|e| e.0.clone()).collect();
            keys.sort();
            let n = keys.len().saturating_sub(DAYS_KEPT);
            for k in &keys[..n] {
                map.retain(|e| &e.0 != k);
            }
        }
        let mut jobs: Vec<(String, f64)> = self.jobs.iter().map(|(id, j)| (id.clone(), j.at)).collect();
        jobs.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        let n = jobs.len().saturating_sub(JOBS_KEPT);
        for (id, _) in &jobs[..n] {
            if Some(id) != self.job.as_ref() {
                self.jobs.retain(|e| &e.0 != id);
            }
        }
        let keep: Vec<String> = self.seen.keys().filter(|id| get(&self.jobs, id).is_some() || Some(*id) == self.job.as_ref()).cloned().collect();
        self.seen.retain(|k, _| keep.contains(k));
    }

    pub fn to_json(&mut self) -> Value {
        self.trim();
        let per_day = |v: &[(String, f64)]| Value::Object(v.iter().map(|(k, x)| (k.clone(), jnum(*x))).collect());
        let mut jobs = Map::new();
        for (id, j) in js_order(&self.jobs) {
            let mut o = Map::new();
            o.insert("wh".into(), jnum(j.wh));
            o.insert("seconds".into(), jnum(j.seconds));
            o.insert("at".into(), jnum(j.at));
            o.insert("cost".into(), j.cost.map_or(Value::Null, jnum));
            o.insert("base".into(), j.base.map_or(Value::Null, |b| json!({ "clips": jnum(b.clips), "savedB": jnum(b.saved_b), "wh": jnum(b.wh) })));
            if let Some(n) = j.node_wh {
                o.insert("nodeWh".into(), jnum(n));
            }
            jobs.insert(id, Value::Object(o));
        }
        let peaks: Map<String, Value> = js_order(&self.peaks.iter().map(|p| (p.0.clone(), (p.1, p.2))).collect::<Vec<_>>()).into_iter().map(|(k, (w, at))| (k, json!({ "w": jnum(w), "at": jnum(at) }))).collect();
        json!({ "days": per_day(&js_order(&self.days)), "costs": per_day(&js_order(&self.costs)), "jobs": jobs, "peaks": peaks })
    }

    pub fn load(&mut self, data: &Value) {
        let Some(d) = data.as_object() else { return };
        let per_day = |src: Option<&Value>| -> Vec<(String, f64)> {
            src.and_then(Value::as_object).map(|o| o.iter().filter(|(k, _)| super::util::re!(r"^\d{4}-\d{2}-\d{2}$").is(k)).filter_map(|(k, v)| finite(v.as_f64()).filter(|_| v.is_number()).map(|x| (k.clone(), x))).collect()).unwrap_or_default()
        };
        let mut jobs = Vec::new();
        if let Some(o) = d.get("jobs").and_then(Value::as_object) {
            for (k, j) in o {
                let (Some(wh), Some(sec)) = (finite(j["wh"].as_f64()), finite(j["seconds"].as_f64())) else { continue };
                if k.encode_utf16().count() > 200 || !j.is_object() {
                    continue;
                }
                let at = crate::ops::js::number(&j["at"]);
                let node_wh = finite(j["nodeWh"].as_f64()).filter(|n| *n <= wh);
                jobs.push((k.clone(), Job { wh, seconds: sec, at: if at.is_finite() && at != 0.0 { at } else { 0.0 }, cost: finite(j["cost"].as_f64()), base: clean_base(&j["base"], wh), node_wh }));
            }
        }
        self.days = per_day(d.get("days"));
        self.costs = per_day(d.get("costs"));
        self.jobs = jobs;
        self.peaks.clear();
        if let Some(o) = d.get("peaks").and_then(Value::as_object) {
            for (k, p) in o {
                let at = crate::ops::js::number(&p["at"]);
                self.note_peak(k, p["w"].as_f64(), at);
            }
        }
        self.trim();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(y: i32, m: u32, d: u32, h: u32, mi: u32, s: u32) -> i64 {
        let ndt = NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, mi, s).unwrap();
        Local.from_local_datetime(&ndt).earliest().unwrap().timestamp_millis()
    }

    // test/statsPower.test.js "energy: Wh integrated from samples, gaps not guessed, per day in local time"
    #[test]
    fn wh_integrated_per_local_day() {
        let mut e = Energy::new(2000, None);
        let start = at(2026, 10, 23, 23, 58, 58);
        for i in 0..=60 {
            e.add(start + i * 2000, Some(120.0), None);
        }
        let s = e.summary(start + 60 * 2000);
        // 2 minutes at 120 W = 4 Wh, half of it each side of midnight
        let day1 = e.summary(start);
        assert_eq!(s["weekWh"], 4);
        assert!(day1["todayWh"].as_f64().unwrap() > 1.9 && day1["todayWh"].as_f64().unwrap() < 2.1);
        // a gap of a minute is not guessed
        let mut g = Energy::new(2000, None);
        g.add(0, Some(100.0), None);
        g.add(60_000, Some(100.0), None);
        assert_eq!(g.summary(60_000)["todayWh"], 0);
        g.add(62_000, Some(100.0), Some(0.3));
        let s = g.summary(62_000);
        assert_eq!(s["todayWh"].as_f64().unwrap(), r3(100.0 * 2.0 / 3600.0));
        assert_eq!(s["todayCost"].as_f64().unwrap(), money(Some(100.0 * 2.0 / 3600.0 / 1000.0 * 0.3)).unwrap());
        assert_eq!(s["peakW"], 100);
    }

    // "energy per job: where the job stood when measuring began is kept with its energy" and its skipped-time rule
    #[test]
    fn a_jobs_baseline_moves_on_over_time_not_counted() {
        use std::sync::{Arc, Mutex};
        let p = Arc::new(Mutex::new((10.0, 1000.0)));
        let pp = p.clone();
        let mut e = Energy::new(2000, Some(Box::new(move |_| Some(*pp.lock().unwrap()))));
        e.mark_job(Some("j1"));
        e.add(0, Some(50.0), None);
        e.add(2000, Some(50.0), None);
        let j = e.summary(2000)["byJob"]["j1"].clone();
        assert_eq!(j["base"], json!({ "clips": 10, "savedB": 1000, "wh": 0 }));
        // a gap: 5 clips converted meanwhile move the baseline on
        *p.lock().unwrap() = (15.0, 1500.0);
        e.add(100_000, Some(50.0), None);
        *p.lock().unwrap() = (16.0, 1600.0);
        e.add(102_000, Some(50.0), None);
        let j = e.summary(102_000)["byJob"]["j1"].clone();
        assert_eq!(j["base"]["clips"], 15);
        assert_eq!(j["seconds"], 4);
        let saved = e.to_json();
        let mut again = Energy::new(2000, None);
        again.load(&saved);
        assert_eq!(again.summary(102_000)["byJob"], e.summary(102_000)["byJob"]);
    }

    // "power peaks: the highest watts per server are kept across a restart, bad readings and extra servers left out"
    #[test]
    fn peaks() {
        let mut e = Energy::new(2000, None);
        e.note_peak("self", Some(80.04), 1.0);
        e.note_peak("self", Some(70.0), 2.0);
        e.note_peak("self", Some(-1.0), 3.0);
        e.note_peak("self", Some(200_000.0), 3.0);
        assert_eq!(e.peak("self"), Some(80.0));
        for i in 0..70 {
            e.note_peak(&format!("node:{i}"), Some(10.0), 1.0);
        }
        assert_eq!(e.peak("node:62"), Some(10.0));
        assert_eq!(e.peak("node:63"), None, "64 kept");
        let mut again = Energy::new(2000, None);
        again.load(&e.to_json());
        assert_eq!(again.peak("self"), Some(80.0));
    }

    #[test]
    fn a_node_counts_for_the_job_only_while_it_converts() {
        let mut e = Energy::new(2000, None);
        e.mark_job(Some("j"));
        e.add_node("n1", 0, Some(100.0), false, None);
        e.add_node("n1", 30_000, Some(100.0), false, None);
        assert_eq!(e.summary(30_000)["byJob"].as_object().unwrap().len(), 0);
        e.add_node("n1", 60_000, Some(200.0), true, Some(0.5));
        let j = e.summary(60_000)["byJob"]["j"].clone();
        assert_eq!(j["wh"].as_f64().unwrap(), r3(150.0 * 30.0 / 3600.0));
        assert_eq!(j["nodeWh"], j["wh"]);
        assert_eq!(e.summary(60_000)["todayWh"], 0, "the node's energy is not this server's day");
        e.add_node("n1", 200_000, Some(200.0), true, None);
        assert_eq!(e.summary(200_000)["byJob"]["j"]["wh"], j["wh"], "a gap over 90 s is not guessed");
    }
}
