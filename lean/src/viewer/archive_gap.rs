//! Archive gaps (a port of server/archiveGap.js): footage the car recorded
//! that has not reached the share. After every scan each car's last seven
//! days are looked at for drives cut off while the car was moving (the speed
//! index), minutes with only some of their cameras, and clips still arriving
//! hours after they were recorded; and the share as a whole for having gone
//! quiet. The answer and the state kept between checks (`archive-gap:<vid>`)
//! are Node's.
//!
//! Not here yet: the CAN Bridge evidence (the CAN index), Sentry USB's status
//! file, snapshots and list of what the car wrote. The analysis is then what
//! Node gives a car without CAN logs and without a Sentry USB. Notifications
//! go through `Ctx::raise_note` (ops' notifications). A clip's arrival is its
//! birth time where the share has one, else its change time (arrivalOf).

use super::ctx::{Ctx, Files};
use super::js::{self, num};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

const MIN: f64 = 60.0;
const HOUR: f64 = 3600.0;
const GRACE_S: f64 = 3.0 * HOUR;
const LONG_GRACE_S: f64 = 24.0 * HOUR;
const WINDOW_DAYS: f64 = 7.0;
const HABIT_DAYS: f64 = 14.0;
const MOVING: f64 = 3.0;
const GAP_S: f64 = 3.0 * MIN;
const LATE_MS: f64 = 3600.0 * 1000.0;
const FILLING_MS: f64 = 2.0 * 3600.0 * 1000.0;
const BULK_MS: f64 = 30.0 * 24.0 * 3600.0 * 1000.0;
const BULK_FILES: usize = 20;
const ABSENT_MS: f64 = 6.0 * 3600.0 * 1000.0;
pub const ADVICE: &str = "Check the Sentry USB (or whatever copies the car's USB drive to the share): its Logs page, its archive settings and its Wi-Fi to the NAS. Clips it recycles before copying them are lost.";

pub fn stamp_sec(name: &str) -> Option<f64> {
    js::stamp_in(name).map(|x| x.1)
}

pub fn key_of_sec(s: f64) -> String {
    js::iso(s * 1000.0)[..19].replace('T', "_").replace(':', "-")
}

pub fn day_of_sec(s: f64) -> String {
    js::iso((s / 86400.0).floor() * 86400_000.0)[..10].to_string()
}

/// web/duration.js footMinutes: "2 h 54 min", "1 day"
pub fn foot_minutes(min: f64) -> String {
    let m = js::js_round(if min.is_finite() { min } else { 0.0 }).max(0.0) as i64;
    let (days, hours, mins) = (m / 1440, (m % 1440) / 60, m % 60);
    let mut parts = Vec::new();
    if days > 0 {
        parts.push(format!("{days} {}", if days == 1 { "day" } else { "days" }));
    }
    if hours > 0 {
        parts.push(format!("{hours} h"));
    }
    if mins > 0 || parts.is_empty() {
        parts.push(format!("{mins} min"));
    }
    parts.join(" ")
}

fn clock_parts(k: &str, h24: bool) -> (String, &'static str) {
    let h: u32 = k[11..13].parse().unwrap_or(0);
    let mm = &k[14..16];
    if h24 {
        return (format!("{}:{mm}", &k[11..13]), "");
    }
    (format!("{}:{mm}", if h % 12 == 0 { 12 } else { h % 12 }), if h < 12 { "AM" } else { "PM" })
}

/// "Wed 1 May" (toLocaleDateString en-GB, weekday short, day numeric, month short)
pub fn short_day(day: &str) -> String {
    match chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d") {
        Ok(d) => d.format("%a %-d %b").to_string(),
        Err(_) => day.to_string(),
    }
}

pub fn clock_one(k: &str, day: &str, h24: bool) -> String {
    let (t, ampm) = clock_parts(k, h24);
    let pre = if !day.is_empty() && &k[..10] != day { format!("{} ", short_day(&k[..10])) } else { String::new() };
    format!("{pre}{t}{}", if ampm.is_empty() { String::new() } else { format!(" {ampm}") })
}

pub fn clock_pair(a: &str, b: &str, day: &str, h24: bool, joiner: &str) -> String {
    let (ta, aa) = clock_parts(a, h24);
    let (tb, ab) = clock_parts(b, h24);
    let da = if &a[..10] != day { format!("{} ", short_day(&a[..10])) } else { String::new() };
    let db = if &b[..10] != day { format!("{} ", short_day(&b[..10])) } else { String::new() };
    let same_half = da.is_empty() && db.is_empty() && aa == ab;
    let left = format!("{da}{ta}{}", if !aa.is_empty() && !same_half { format!(" {aa}") } else { String::new() });
    let right = format!("{db}{tb}{}", if ab.is_empty() { String::new() } else { format!(" {ab}") });
    format!("{left}{joiner}{right}")
}

/// The moment ms on the clock of tz, as seconds (stampSec's scale). Only UTC and the
/// server's own zone (TZ) are known here; another zone reads as UTC until core brings a zone table.
pub fn wall_sec(ms: f64, tz: &str) -> f64 {
    let t = (ms / 1000.0).floor() * 1000.0;
    let own = std::env::var("TZ").unwrap_or_else(|_| "UTC".into());
    if tz == own && tz != "UTC" {
        use chrono::{Local, TimeZone};
        if let chrono::LocalResult::Single(d) | chrono::LocalResult::Ambiguous(d, _) = Local.timestamp_millis_opt(t as i64) {
            return d.naive_local().and_utc().timestamp() as f64;
        }
    }
    t / 1000.0
}

pub fn utc_of_wall(s: f64, tz: &str, cache: &mut HashMap<i64, f64>) -> f64 {
    let hour = (s / HOUR).floor() as i64;
    if let Some(off) = cache.get(&hour) {
        return s - off;
    }
    let offset_at = |u: f64| wall_sec(u * 1000.0, tz) - u;
    let first = s - offset_at(s);
    let off = offset_at(first);
    cache.insert(hour, off);
    s - off
}

fn cover_idx(starts: &[f64], s: f64) -> Option<usize> {
    let i = starts.partition_point(|&x| x <= s);
    (i > 0 && s - starts[i - 1] < 62.0).then(|| i - 1)
}

fn covered(starts: &[f64], s: f64) -> bool {
    cover_idx(starts, s).is_some()
}

fn next_after(starts: &[f64], s: f64) -> Option<usize> {
    let i = starts.partition_point(|&x| x <= s);
    (i < starts.len()).then_some(i)
}

fn plural(n: usize, w: &str) -> String {
    format!("{n} {w}{}", if n == 1 { "" } else { "s" })
}

pub fn day_label(day: &str) -> String {
    short_day(day)
}

/// A clip of the scan, for the analysis
struct C<'a> {
    rel: &'a str,
    s: f64,
    dir: &'a str,
    recent: bool,
    camera: Option<&'a str>,
    arrival: Option<f64>,
    mtime: f64,
}

#[derive(Default)]
struct DayAcc {
    missing: HashSet<i64>,
    cut: HashSet<i64>,
    cutoffs: Vec<(f64, f64, Option<f64>, f64)>,
    partial: Vec<(f64, usize, usize, Vec<String>)>,
    late: usize,
    max_late_ms: f64,
    last_arrival: f64,
    held: HashSet<i64>,
}

pub struct Analysis {
    pub days: BTreeMap<String, Value>,
    pub stalled: Value,
    pub signals: Value,
    pub newest_recent: Option<f64>,
    pub received: f64,
}

/// analyze() for a car without CAN logs and without a Sentry USB.
pub fn analyze(files: &Files, now_ms: f64, tz: &str, encoded: &HashSet<String>, speeds: &HashMap<String, Vec<Value>>, received_ms: f64, last_recent_s: Option<f64>, clock24: bool) -> Analysis {
    let now = wall_sec(now_ms, tz);
    let mut offsets = HashMap::new();
    let first_day_sec = ((now - (WINDOW_DAYS - 1.0) * 86400.0) / 86400.0).floor() * 86400.0;
    let mut clips: Vec<C> = Vec::new();
    for f in files.values() {
        if f.kind != crate::footage::Kind::Clip || f.size == 0 {
            continue;
        }
        let name = f.rel.rsplit('/').next().unwrap_or(&f.rel);
        let Some(s) = stamp_sec(name) else { continue };
        let dir = f.rel.rfind('/').map_or(".", |i| &f.rel[..i]);
        clips.push(C { rel: &f.rel, s, dir, recent: f.typ == "RecentClips", camera: f.camera.as_deref(), arrival: if f.birthtime_ms > 0.0 { Some(f.birthtime_ms) } else { (f.ctime_ms > 0.0).then_some(f.ctime_ms) }, mtime: f.mtime_ms });
    }
    let mut starts: Vec<f64> = clips.iter().map(|c| c.s).collect();
    starts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    starts.dedup();
    let newest_recent = clips.iter().filter(|c| c.recent).map(|c| c.s).reduce(f64::max);
    let newest_other = clips.iter().filter(|c| !c.recent).map(|c| c.s).reduce(f64::max);
    let ever_recent = match newest_recent {
        None => last_recent_s,
        Some(n) => Some(n.max(last_recent_s.unwrap_or(n))),
    };
    let habit = ever_recent.is_some() && !newest_other.is_some_and(|o| o > ever_recent.unwrap() + HABIT_DAYS * 86400.0);
    let mut received = if received_ms > 0.0 { received_ms } else { 0.0 };
    for c in &clips {
        if encoded.contains(c.rel) {
            continue;
        }
        if let Some(a) = c.arrival.filter(|a| *a <= now_ms + 60_000.0) {
            received = received.max(a);
        }
    }
    let catching_up = received > 0.0 && now_ms - received < FILLING_MS;
    let mut days: BTreeMap<String, DayAcc> = BTreeMap::new();
    let past = |s: f64| newest_recent.is_some_and(|n| n > s + MIN);
    let quiet = |s: f64| now - s >= LONG_GRACE_S && !catching_up;
    let in_window = |s: f64| s >= first_day_sec;
    let values_of = |rel: &str| -> Vec<f64> { speeds.get(rel).map(|v| v.iter().filter_map(Value::as_f64).filter(|x| x.is_finite()).collect()).unwrap_or_default() };
    let mut front_at: HashMap<i64, Vec<f64>> = HashMap::new();
    for c in &clips {
        if c.camera == Some("front") && speeds.contains_key(c.rel) {
            front_at.insert(c.s as i64, values_of(c.rel));
        }
    }

    // cutoff: footage that stops while the car is moving
    if habit && !speeds.is_empty() {
        let mut front: Vec<&C> = clips.iter().filter(|c| c.recent && c.camera == Some("front") && front_at.contains_key(&(c.s as i64))).collect();
        front.sort_by(|a, b| a.s.partial_cmp(&b.s).unwrap());
        for c in front {
            if !in_window(c.s) {
                continue;
            }
            let v = values_of(c.rel);
            if v.len() < 40 {
                continue;
            }
            let tail = &v[v.len() - 3..];
            if !tail.iter().all(|x| *x > MOVING) {
                continue;
            }
            let end = c.s + MIN;
            let next = next_after(&starts, c.s).map(|i| starts[i]);
            let end_u = utc_of_wall(c.s, tz, &mut offsets) + MIN;
            let gap = next.map(|n| utc_of_wall(n, tz, &mut offsets) - end_u);
            if gap.is_some_and(|g| g < GAP_S) || now - end < GRACE_S {
                continue;
            }
            if next.is_none() && !quiet(end) {
                if now - end >= GRACE_S && !past(end) && catching_up {
                    days.entry(day_of_sec(end)).or_default().held.insert(end as i64);
                }
                continue;
            }
            let mut lost = 1.0;
            if let Some(g) = gap.filter(|g| *g <= 3.0 * HOUR) {
                let head: Vec<f64> = front_at.get(&(next.unwrap() as i64)).map(|v| v.iter().take(3).copied().collect()).unwrap_or_default();
                if head.len() == 3 && head.iter().all(|x| *x > MOVING) {
                    lost = (g / MIN).floor().max(1.0);
                }
            }
            let day = day_of_sec(c.s);
            let d = days.entry(day.clone()).or_default();
            let mut i = 0.0;
            while i < lost {
                let m = wall_sec((end_u + i * MIN) * 1000.0, tz);
                i += 1.0;
                if day_of_sec(m) != day || covered(&starts, m + 30.0) {
                    continue;
                }
                d.missing.insert(m as i64);
                d.cut.insert(m as i64);
            }
            d.cutoffs.push((c.s + v.len() as f64, js::js_round(tail[2] * 3.6), next, lost));
        }
    }

    // partial: a minute with only some of the cameras its neighbours have
    let mut by_dir: BTreeMap<&str, BTreeMap<i64, (f64, Vec<String>, f64)>> = BTreeMap::new();
    for c in &clips {
        let e = by_dir.entry(c.dir).or_default().entry(c.s as i64).or_insert((c.s, Vec::new(), 0.0));
        if let Some(cam) = c.camera {
            if !e.1.iter().any(|x| x == cam) {
                e.1.push(cam.to_string());
            }
        }
        e.2 = e.2.max(c.arrival.unwrap_or(0.0));
    }
    for m in by_dir.values() {
        let list: Vec<&(f64, Vec<String>, f64)> = m.values().collect();
        for i in 0..list.len() {
            let e = list[i];
            if !in_window(e.0) || now - e.0 < GRACE_S {
                continue;
            }
            let prev = (i > 0 && e.0 - list[i - 1].0 <= 90.0).then(|| list[i - 1]);
            let next = (i + 1 < list.len() && list[i + 1].0 - e.0 <= 90.0).then(|| list[i + 1]);
            let refs: Vec<_> = [prev, next].into_iter().flatten().collect();
            if refs.is_empty() {
                continue;
            }
            let mut lacking: Vec<String> = refs[0].1.iter().filter(|cam| !e.1.contains(cam) && refs.iter().all(|r| r.1.contains(cam))).cloned().collect();
            if lacking.is_empty() {
                continue;
            }
            if next.is_none() && !(if e.2 > 0.0 { now_ms - e.2 >= FILLING_MS && now - e.0 >= GRACE_S } else { now - e.0 >= LONG_GRACE_S }) {
                continue;
            }
            lacking.sort();
            let has = e.1.len();
            days.entry(day_of_sec(e.0)).or_default().partial.push((e.0, has, has + lacking.len(), lacking));
        }
    }

    // late: clips still reaching the share hours after they were recorded
    let mut bulk = 0;
    for c in &clips {
        if in_window(c.s) {
            continue;
        }
        if let Some(a) = c.arrival {
            if now_ms - a < 24.0 * 3600.0 * 1000.0 && a - (utc_of_wall(c.s, tz, &mut offsets) + MIN) * 1000.0 > LATE_MS {
                bulk += 1;
            }
        }
    }
    let mut informative = false;
    for c in &clips {
        if bulk >= BULK_FILES {
            break;
        }
        if !in_window(c.s) || encoded.contains(c.rel) {
            continue;
        }
        let Some(a) = c.arrival else { continue };
        let lag = a - (utc_of_wall(c.s, tz, &mut offsets) + MIN) * 1000.0;
        if lag > BULK_MS || lag < LATE_MS {
            continue;
        }
        informative = true;
        let d = days.entry(day_of_sec(c.s)).or_default();
        d.late += 1;
        d.max_late_ms = d.max_late_ms.max(lag);
        d.last_arrival = d.last_arrival.max(a);
    }

    let mut out = BTreeMap::new();
    for (day, d) in &days {
        let missing = d.missing.len();
        let partial_minutes = d.partial.len();
        let late = d.late >= 4 && now_ms - d.last_arrival < FILLING_MS;
        let partial = missing > 0 || partial_minutes >= 2;
        if !partial && !late && d.held.is_empty() {
            continue;
        }
        let state = if partial { "partial" } else { "filling" };
        let mut sources: Vec<&str> = Vec::new();
        if !d.cutoffs.is_empty() {
            sources.push("speed");
        }
        if partial_minutes > 0 {
            sources.push("partial");
        }
        let mut f = json!({
            "day": day, "state": state, "missingMinutes": missing, "partialMinutes": partial_minutes, "waitingMinutes": d.held.len(),
            "sentryUsb": null, "sentryUsbMinutes": 0,
            "lateClips": if late { d.late } else { 0 }, "maxLateHours": if late { num(js::js_round(d.max_late_ms / 360000.0) / 10.0) } else { json!(0) },
            "can": [], "sentry": [],
            "cutoffs": d.cutoffs.iter().map(|(at, kph, next, lost)| json!({ "at": key_of_sec(*at), "kph": num(*kph), "next": next.map(key_of_sec), "minutes": num(*lost) })).collect::<Vec<_>>(),
            "partial": d.partial.iter().map(|(at, has, of, lacking)| json!({ "at": key_of_sec(*at), "cameras": has, "of": of, "lacking": lacking })).collect::<Vec<_>>(),
            "sources": sources,
            "missedSnapshots": [], "missedSnapshotMinutes": 0, "snapshotIntervalS": null, "sentryQuiet": null, "carFiles": null
        });
        f["summary"] = json!(summarize(&f, received, now_ms, clock24));
        f["advice"] = json!(ADVICE);
        out.insert(day.clone(), f);
    }

    let mut stalled = Value::Null;
    if !clips.is_empty() {
        let newest = clips.iter().map(|c| c.arrival.unwrap_or(0.0).max(c.mtime)).fold(0.0, f64::max);
        let quiet_ms = now_ms - newest;
        let last_day = day_of_sec(*starts.last().unwrap());
        let dayset: HashSet<String> = starts.iter().map(|s| day_of_sec(*s)).collect();
        let base = stamp_sec(&format!("{last_day}_12-00-00")).unwrap_or(0.0);
        let had = (0..HABIT_DAYS as i64).filter(|i| dayset.contains(&day_of_sec(base - *i as f64 * 86400.0))).count();
        if quiet_ms >= 36.0 * 3600.0 * 1000.0 && had as f64 / HABIT_DAYS >= 0.6 {
            stalled = json!({ "since": num(newest), "hours": num(js::js_round(quiet_ms / 3600000.0)), "usualDays": had, "of": HABIT_DAYS as i64 });
        }
    }
    let signals = json!({ "can": false, "speed": habit && !speeds.is_empty(), "arrival": informative, "recent": habit, "catchingUp": catching_up,
        "receivedAt": if received > 0.0 { num(received) } else { Value::Null }, "tzShift": [], "sentryUsb": null, "carfiles": false });
    Analysis { days: out, stalled, signals, newest_recent, received }
}

/// The evidence in plain words (summarize), for the sources there are here.
pub fn summarize(f: &Value, received_ms: f64, now_ms: f64, clock24: bool) -> String {
    let day = f["day"].as_str().unwrap_or("");
    let mut bits: Vec<String> = Vec::new();
    let cutoffs = f["cutoffs"].as_array().cloned().unwrap_or_default();
    for c in cutoffs.iter().take(2) {
        let at = c["at"].as_str().unwrap_or("");
        let next = match c["next"].as_str() {
            Some(n) => format!(", and the next starts at {}", clock_one(n, day, clock24)),
            None => ", and nothing later is on the share".into(),
        };
        bits.push(format!("the footage stops at {} while the car was moving ({} km/h){next}", clock_one(at, day, clock24), c["kph"]));
    }
    if cutoffs.len() > 2 {
        bits.push(format!("{} more drives stop like that", cutoffs.len() - 2));
    }
    let pm = f["partialMinutes"].as_u64().unwrap_or(0) as usize;
    if pm > 0 {
        let p = &f["partial"][0];
        let one = if pm == 1 { format!(" ({} of {} at {})", p["cameras"], p["of"], clock_one(p["at"].as_str().unwrap_or(""), day, clock24)) } else { String::new() };
        bits.push(format!("{} {} only some cameras{one}", plural(pm, "minute"), if pm == 1 { "has" } else { "have" }));
    }
    let wm = f["waitingMinutes"].as_u64().unwrap_or(0) as usize;
    if wm > 0 {
        let ago = if received_ms > 0.0 { format!(" (the latest {} min ago)", js::js_round((now_ms - received_ms) / 60000.0).max(1.0)) } else { String::new() };
        bits.push(format!("the share is still receiving footage{ago}, and {} the car recorded after its newest clip {} not there yet", plural(wm, "minute"), if wm == 1 { "is" } else { "are" }));
    }
    if f["lateClips"].as_u64().unwrap_or(0) > 0 {
        bits.push(format!("clips are reaching the share up to {} h after they were recorded", f["maxLateHours"]));
    }
    let mm = f["missingMinutes"].as_u64().unwrap_or(0) as usize;
    let head = if f["state"] == json!("filling") {
        "Still being copied: ".to_string()
    } else if mm > 0 {
        format!("About {} the car recorded {} not on the share: ", plural(mm, "minute"), if mm == 1 { "is" } else { "are" })
    } else {
        "Some footage looks only partly copied: ".to_string()
    };
    let text = bits.join("; ");
    let b = text.as_bytes();
    let lower = b.len() >= 2 && b[0].is_ascii_uppercase() && b[1].is_ascii_lowercase() && !text.starts_with("Sentry USB");
    let text = if lower { format!("{}{}", text[..1].to_lowercase(), &text[1..]) } else { text };
    format!("{head}{text}.")
}

/// The check after each scan, and the last result for the route.
pub struct ArchiveGap {
    ctx: Arc<dyn Ctx>,
    speed_index: Arc<super::speed_index::SpeedIndex>,
    results: Mutex<HashMap<String, Value>>,
    running: Mutex<()>,
}

impl ArchiveGap {
    pub fn new(ctx: Arc<dyn Ctx>, speed_index: Arc<super::speed_index::SpeedIndex>) -> Arc<ArchiveGap> {
        Arc::new(ArchiveGap { ctx, speed_index, results: Mutex::new(HashMap::new()), running: Mutex::new(()) })
    }

    fn clock24(&self) -> bool {
        self.ctx.setting("appearance").and_then(|a| a.get("clock24").cloned()).is_some_and(|v| v == json!(true) || v.as_f64().is_some_and(|x| x != 0.0))
    }

    /// One check of a car (one at a time); its result, or None before the first scan.
    pub fn check(&self, vid: &str) -> Option<Value> {
        let _one = self.running.lock().unwrap();
        let v = self.ctx.vehicle(vid)?;
        let files = self.ctx.files(vid)?;
        let now_ms = js::now_ms();
        let tz = if v.timezone.is_empty() { "UTC".to_string() } else { v.timezone.clone() };
        let key = format!("archive-gap:{vid}");
        let mut st = match self.ctx.setting(&key) {
            Some(Value::Object(o)) if o.contains_key("days") => o,
            _ => {
                let mut o = Map::new();
                o.insert("days".into(), json!({}));
                o
            }
        };
        // received(): the clips from a fixed start went up in number
        let from = stamp_sec(&format!("{}_00-00-00", day_of_sec(wall_sec(now_ms, &tz) - (WINDOW_DAYS + 1.0) * 86400.0))).unwrap_or(0.0);
        let count_from = |f0: f64| files.values().filter(|f| f.kind == crate::footage::Kind::Clip && f.size > 0).filter_map(|f| stamp_sec(f.rel.rsplit('/').next().unwrap_or(&f.rel))).filter(|s| *s >= f0).count();
        let rx = st.get("rx").filter(|r| r.is_object()).cloned();
        let grew = rx.as_ref().map_or(true, |r| count_from(js::number(r.get("from"))) as f64 > js::number(r.get("count")));
        let at = if grew { now_ms } else { js::number(rx.as_ref().and_then(|r| r.get("at"))) };
        st.insert("rx".into(), json!({ "from": num(from), "count": count_from(from), "at": num(at) }));
        let mut speeds = HashMap::new();
        let today = wall_sec(now_ms, &tz);
        for i in 0..WINDOW_DAYS as i64 {
            for (rel, sp) in self.speed_index.day(vid, &day_of_sec(today - i as f64 * 86400.0)) {
                if let Value::Array(a) = sp {
                    speeds.insert(rel, a);
                }
            }
        }
        let last_recent = st.get("lastRecentS").and_then(Value::as_f64);
        let res = analyze(&files, now_ms, &tz, &self.ctx.encoded(vid), &speeds, at, last_recent, self.clock24());
        if let Some(n) = res.newest_recent {
            st.insert("lastRecentS".into(), num(n.max(last_recent.unwrap_or(0.0))));
        }
        self.sync(&v, &res, &mut st, &files, now_ms, &tz);
        self.ctx.set_setting(&key, Value::Object(st));
        let out = json!({ "days": res.days, "stalled": res.stalled, "signals": res.signals, "checkedAt": num(now_ms), "carFiles": null });
        self.results.lock().unwrap().insert(vid.to_string(), out.clone());
        Some(out)
    }

    /// Raise, update or resolve the car's archive notifications.
    fn sync(&self, v: &super::ctx::VehicleRef, res: &Analysis, st: &mut Map<String, Value>, files: &Files, now_ms: f64, tz: &str) {
        let open: HashSet<String> = self.ctx.open_notes(&v.id, "archive").into_iter().collect();
        let first_day = day_of_sec(wall_sec(now_ms, tz) - (WINDOW_DAYS - 1.0) * 86400.0);
        let mut per_day: HashMap<String, usize> = HashMap::new();
        for f in files.values().filter(|f| f.kind == crate::footage::Kind::Clip && f.size > 0) {
            if let Some(s) = stamp_sec(f.rel.rsplit('/').next().unwrap_or(&f.rel)) {
                *per_day.entry(day_of_sec(s)).or_default() += 1;
            }
        }
        let known = st.get("days").and_then(Value::as_object).cloned().unwrap_or_default();
        let found: BTreeMap<String, &Value> = res.days.values().filter(|f| f["state"] == json!("partial")).map(|f| (format!("archive:{}:{}", v.id, f["day"].as_str().unwrap_or("")), f)).collect();
        let mut keys: Vec<String> = known.keys().cloned().collect();
        for k in found.keys() {
            if !keys.contains(k) {
                keys.push(k.clone());
            }
        }
        let mut next = Map::new();
        for key in keys {
            let mut p = known.get(&key).and_then(Value::as_object).cloned();
            let day = p.as_ref().and_then(|p| p.get("day")).and_then(Value::as_str).map(String::from).or_else(|| found.get(&key).and_then(|f| f["day"].as_str()).map(String::from)).unwrap_or_default();
            let is_open = open.contains(&key);
            let flag = |p: &Map<String, Value>, k: &str| p.get(k) == Some(&json!(true));
            if let Some(p) = p.as_mut() {
                if flag(p, "raised") && !flag(p, "resolved") && !is_open {
                    p.insert("dismissed".into(), json!(true));
                }
            }
            if day < first_day {
                if p.as_ref().is_some_and(|p| flag(p, "raised") && !flag(p, "resolved")) && is_open {
                    self.ctx.resolve_note(&key);
                }
                continue;
            }
            if let Some(f) = found.get(&key) {
                let score = f["missingMinutes"].as_f64().unwrap_or(0.0) + f["partialMinutes"].as_f64().unwrap_or(0.0);
                if let Some(p) = p.as_ref().filter(|p| flag(p, "dismissed")) {
                    let ps = js::number(p.get("score"));
                    if !(score >= ps * 1.5 && score - ps >= 10.0) {
                        let mut p = p.clone();
                        p.insert("absentSince".into(), Value::Null);
                        next.insert(key, Value::Object(p));
                        continue;
                    }
                }
                let note = json!({ "kind": "archive", "level": "warning", "vehicleId": v.id, "dedupeKey": key,
                    "title": format!("{}: {} looks only partly archived", v.name, day_label(&day)), "message": format!("{} {ADVICE}", f["summary"].as_str().unwrap_or("")) });
                let clips = per_day.get(&day).copied().unwrap_or(0);
                if self.ctx.raise_note(&note) {
                    next.insert(key, json!({ "day": day, "score": num(score), "raised": true, "resolved": false, "dismissed": false, "clips": clips, "sources": f["sources"], "absentSince": null }));
                } else {
                    let mut e = p.unwrap_or_else(|| json!({ "day": day, "score": num(score), "raised": false, "clips": clips, "sources": f["sources"] }).as_object().unwrap().clone());
                    e.insert("absentSince".into(), Value::Null);
                    next.insert(key, Value::Object(e));
                }
                continue;
            }
            let Some(mut p) = p else { continue };
            let absent = p.get("absentSince").and_then(Value::as_f64).filter(|x| *x != 0.0).unwrap_or(now_ms);
            if flag(&p, "raised") && !flag(&p, "resolved") && is_open {
                let arrived = p.get("clips").is_none() || per_day.get(&day).copied().unwrap_or(0) as f64 > js::number(p.get("clips"));
                let ran = p.get("sources").and_then(Value::as_array).map_or(true, |s| s.iter().all(|x| x == "partial" || res.signals.get(x.as_str().unwrap_or("")) == Some(&json!(true))));
                if arrived || (ran && now_ms - absent >= ABSENT_MS) {
                    self.ctx.resolve_note(&key);
                    p.insert("resolved".into(), json!(true));
                    p.insert("absentSince".into(), num(absent));
                    next.insert(key, Value::Object(p));
                    continue;
                }
            }
            p.insert("absentSince".into(), num(absent));
            next.insert(key, Value::Object(p));
        }
        st.insert("days".into(), Value::Object(next));
    }

    /// /api/vehicles/:id/archive-gaps
    pub fn route(&self, v: &super::ctx::VehicleRef) -> Value {
        let had = self.results.lock().unwrap().get(&v.id).cloned();
        let out = had.or_else(|| self.check(&v.id)).unwrap_or_else(|| json!({ "days": {}, "stalled": null, "signals": {}, "checkedAt": null }));
        let mut days: Vec<Value> = out["days"].as_object().map(|o| o.values().cloned().collect()).unwrap_or_default();
        days.sort_by(|a, b| js::locale_cmp(b["day"].as_str().unwrap_or(""), a["day"].as_str().unwrap_or("")));
        json!({ "vehicleId": v.id, "timezone": if v.timezone.is_empty() { "UTC" } else { &v.timezone }, "checkedAt": out["checkedAt"], "signals": out["signals"], "stalled": out["stalled"],
            "days": days, "carFiles": null })
    }
}

#[cfg(test)]
mod tests {
    // test/archiveGap.test.js, without CAN and Sentry USB
    use super::*;
    use crate::footage::Kind;
    use crate::scanner::FileEntry;

    fn files(list: &[(&str, &str, f64)]) -> Files {
        Arc::new(list.iter().map(|(rel, cam, arrival)| {
            let typ = if rel.contains("RecentClips") { "RecentClips" } else { "SavedClips" };
            (rel.to_string(), FileEntry { rel: rel.to_string(), size: 100, mtime_ms: *arrival, ctime_ms: *arrival, birthtime_ms: 0.0, kind: Kind::Clip, typ, day: rel.split('/').last().unwrap()[..10].into(), camera: Some(cam.to_string()), event_id: None })
        }).collect())
    }

    #[test]
    fn words() {
        assert_eq!(foot_minutes(174.0), "2 h 54 min");
        assert_eq!(foot_minutes(1440.0), "1 day");
        assert_eq!(foot_minutes(0.0), "0 min");
        assert_eq!(clock_one("2026-11-09_09-56-00", "2026-11-09", false), "9:56 AM");
        assert_eq!(clock_one("2026-11-09_00-05-00", "2026-11-08", true), "Mon 9 Nov 00:05");
        assert_eq!(clock_pair("2026-11-09_01-51-00", "2026-11-09_04-45-00", "2026-11-09", false, " and "), "1:51 and 4:45 AM");
        assert_eq!(clock_pair("2026-11-09_09-56-00", "2026-11-09_12-50-00", "2026-11-09", false, " and "), "9:56 AM and 12:50 PM");
        assert_eq!(short_day("2024-05-01"), "Wed 1 May");
        assert_eq!(key_of_sec(stamp_sec("2026-11-09_09-56-00").unwrap()), "2026-11-09_09-56-00");
    }

    #[test]
    fn a_minute_with_only_some_cameras_and_a_cut_off_drive() {
        let now = js::utc_seconds(2026, 11, 10, 12, 0, 0) * 1000.0;
        let day = "2026-11-10";
        let at = |h: i64, m: i64| format!("{day}_{h:02}-{m:02}-00");
        let arr = now - 6.0 * 3600.0 * 1000.0;
        let mut list: Vec<(String, &str, f64)> = Vec::new();
        for m in 0..3 {
            for cam in ["front", "back", "left_repeater"] {
                if m == 1 && cam == "back" {
                    continue;
                }
                if m == 2 && cam == "left_repeater" {
                    continue;
                }
                list.push((format!("TeslaCam/RecentClips/{}-{cam}.mp4", at(5, m)), cam, js::utc_seconds(2026, 11, 10, 5, m, 0) * 1000.0 + 120_000.0));
            }
        }
        list.push((format!("TeslaCam/RecentClips/{}-front.mp4", at(5, 3)), "front", arr));
        list.push((format!("TeslaCam/RecentClips/{}-back.mp4", at(5, 3)), "back", arr));
        list.push((format!("TeslaCam/RecentClips/{}-left_repeater.mp4", at(5, 3)), "left_repeater", arr));
        // a drive cut off at 06:00 while moving, the next at 06:30
        list.push((format!("TeslaCam/RecentClips/{}-front.mp4", at(6, 0)), "front", arr));
        list.push((format!("TeslaCam/RecentClips/{}-front.mp4", at(6, 30)), "front", arr));
        let refs: Vec<(&str, &str, f64)> = list.iter().map(|(a, b, c)| (a.as_str(), *b, *c)).collect();
        let fs = files(&refs);
        let mut speeds = HashMap::new();
        speeds.insert(format!("TeslaCam/RecentClips/{}-front.mp4", at(6, 0)), (0..60).map(|_| json!(20)).collect::<Vec<_>>());
        speeds.insert(format!("TeslaCam/RecentClips/{}-front.mp4", at(6, 30)), (0..60).map(|_| json!(20)).collect::<Vec<_>>());
        let res = analyze(&fs, now, "UTC", &HashSet::new(), &speeds, 0.0, None, false);
        let f = &res.days[day];
        assert_eq!(f["state"], json!("partial"));
        assert_eq!(f["partialMinutes"], json!(2));
        assert_eq!(f["partial"][0], json!({ "at": at(5, 1), "cameras": 2, "of": 3, "lacking": ["back"] }));
        assert_eq!(f["cutoffs"][0]["at"], json!(at(6, 1)));
        assert_eq!(f["cutoffs"][0]["kph"], json!(72));
        assert_eq!(f["cutoffs"][0]["minutes"], json!(29));
        assert_eq!(f["missingMinutes"], json!(29));
        assert_eq!(f["sources"], json!(["speed", "partial"]));
        assert!(f["summary"].as_str().unwrap().starts_with("About 29 minutes the car recorded are not on the share: the footage stops at 6:01 AM while the car was moving (72 km/h), and the next starts at 6:30 AM; 2 minutes have only some cameras."), "{}", f["summary"]);
        // (what server/archiveGap.js analyze answers for the same files)
        let node_day: Value = serde_json::from_str(r#"{"day":"2026-11-10","state":"partial","missingMinutes":29,"partialMinutes":2,"waitingMinutes":0,"sentryUsb":null,"sentryUsbMinutes":0,"lateClips":0,"maxLateHours":0,"can":[],"sentry":[],"cutoffs":[{"at":"2026-11-10_06-01-00","kph":72,"next":"2026-11-10_06-30-00","minutes":29}],"partial":[{"at":"2026-11-10_05-01-00","cameras":2,"of":3,"lacking":["back"]},{"at":"2026-11-10_05-02-00","cameras":2,"of":3,"lacking":["left_repeater"]}],"sources":["speed","partial"],"missedSnapshots":[],"missedSnapshotMinutes":0,"snapshotIntervalS":null,"sentryQuiet":null,"carFiles":null,"summary":"About 29 minutes the car recorded are not on the share: the footage stops at 6:01 AM while the car was moving (72 km/h), and the next starts at 6:30 AM; 2 minutes have only some cameras.","advice":"Check the Sentry USB (or whatever copies the car's USB drive to the share): its Logs page, its archive settings and its Wi-Fi to the NAS. Clips it recycles before copying them are lost."}"#).unwrap();
        assert_eq!(f, &node_day);
        let node_signals: Value = serde_json::from_str(r#"{"can":false,"speed":true,"arrival":false,"recent":true,"catchingUp":false,"receivedAt":1794290400000,"tzShift":[],"sentryUsb":null,"carfiles":false}"#).unwrap();
        assert_eq!(res.signals, node_signals);
        assert_eq!(res.signals["speed"], json!(true));
        assert_eq!(res.signals["recent"], json!(true));
        assert!(res.stalled.is_null());
    }
}
