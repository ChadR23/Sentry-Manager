//! Archive gaps (a port of server/archiveGap.js): footage the car recorded
//! that has not reached the share. After every scan each car's last seven
//! days are looked at for CAN Bridge driving with no footage (the CAN index's
//! minute files, with what was learned of the car's keys and Sentry Mode),
//! drives cut off while the car was moving (the speed index), minutes with
//! only some of their cameras, clips still arriving hours after they were
//! recorded, Sentry USB's transfer, its missed snapshots and its list of what
//! the car wrote (carFilesPass); and the share as a whole for having gone
//! quiet. The answer and the state kept between checks (`archive-gap:<vid>`)
//! are Node's. Notifications go through `Ctx::raise_note` (ops'
//! notifications). A clip's arrival is its birth time where the share has
//! one, else its change time (arrivalOf).

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

/// The moment ms on the clock of tz, as seconds (stampSec's scale): Intl's zones (any IANA
/// name in any case, offsets); a name Intl does not know reads as UTC.
pub fn wall_sec(ms: f64, tz: &str) -> f64 {
    let t = (ms / 1000.0).floor() * 1000.0;
    if tz == "UTC" {
        return t / 1000.0;
    }
    match crate::footage::tz::zone(tz) {
        Some(z) => {
            let (y, mo, d, h, mi, s) = crate::footage::tz::parts(t, z);
            js::utc_seconds(y as i64, mo as i64, d as i64, h as i64, mi as i64, s as i64)
        }
        None => t / 1000.0,
    }
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
    name: &'a str,
    s: f64,
    dir: &'a str,
    typ: &'static str,
    recent: bool,
    camera: Option<&'a str>,
    arrival: Option<f64>,
    mtime: f64,
}

/// What Sentry USB's list says of a day (carFilesPass's `d.cf`)
#[derive(Default)]
struct Cf {
    pi: HashSet<i64>,
    pi_clips: usize,
    car: HashSet<i64>,
    unknown: HashMap<i64, &'static str>,
    waiting: HashSet<i64>,
    deleted: HashSet<i64>,
    deleted_clips: usize,
}

#[derive(Default)]
struct DayAcc {
    missing: HashSet<i64>,
    quiet: HashSet<i64>,
    can: Vec<i64>,
    cut: HashSet<i64>,
    cutoffs: Vec<(f64, f64, Option<f64>, f64)>,
    partial: Vec<(f64, usize, usize, Vec<String>)>,
    late: usize,
    max_late_ms: f64,
    last_arrival: f64,
    held: HashSet<i64>,
    pi_held: HashSet<i64>,
    pi_range: bool,
    cf: Option<Cf>,
}

/// Sentry USB is still copying (its status file): the stamps (stampSec) of the first and the
/// last clip still arriving; past its give-up time (`overdue`) every minute from the first on waits.
#[derive(Debug, Clone, Default)]
pub struct Pi {
    pub overdue: bool,
    pub first_s: f64,
    pub last_s: Option<f64>,
}

/// Sentry USB's snapshots (sentryUsb.js snapshotInfo): the interval and the gaps.
#[derive(Debug, Clone, Default)]
pub struct Snaps {
    pub interval_s: f64,
    /// (fromUnix, toUnix, seconds, lostToUnix)
    pub gaps: Vec<(f64, f64, f64, Option<f64>)>,
}

/// Sentry USB's list of what the car wrote (sentryUsb.js carFiles()).
#[derive(Clone, Default)]
pub struct CarFilesIn {
    pub list: Option<Arc<crate::can::sentry_usb::CarFiles>>,
    pub error: Option<String>,
    pub file_unix: f64,
    pub archived_unix: Option<f64>,
}

/// What analyze() is given (archiveGap.js analyze's options).
#[derive(Default)]
pub struct Input<'a> {
    pub now_ms: f64,
    pub tz: &'a str,
    pub encoded: HashSet<String>,
    pub speeds: HashMap<String, Vec<Value>>,
    /// minutes (the car's clock, seconds) CAN Bridge shows driving with no footage; None: no CAN data
    pub can_driving: Option<Vec<f64>>,
    pub can_sentry: Vec<f64>,
    pub can_minutes: Option<Vec<f64>>,
    pub received_ms: f64,
    pub last_recent_s: Option<f64>,
    pub sentry_usb: Option<Pi>,
    pub snapshots: Option<Snaps>,
    pub clock24: bool,
    pub car_files: Option<CarFilesIn>,
    pub binned: Option<Vec<String>>,
    pub deleted: Option<Vec<String>>,
}

pub struct Analysis {
    pub days: BTreeMap<String, Value>,
    pub stalled: Value,
    pub signals: Value,
    pub newest_recent: Option<f64>,
    pub received: f64,
    /// carFilesPass's answer, or null without a list
    pub car_files: Value,
}

const MAX_GAPS_SHOWN: usize = 3;
const SENTRY_QUIET_MIN: usize = 60;
const CF_BEHIND_S: f64 = 11.0 * MIN;
const CF_ARCHIVE_MARGIN_S: f64 = 60.0;

fn why(kind: &str, many: bool) -> &'static str {
    match (kind, many) {
        ("pi", false) => "The car wrote this clip, but Sentry USB didn't keep or upload it.",
        ("pi", true) => "The car wrote these clips, but Sentry USB didn't keep or upload them.",
        ("car", _) => "The car was driving but didn't save video to the USB drive (car or USB drive problem).",
        ("off", _) => "No footage, and Sentry USB was off or restarting then, so it can't tell whether the car recorded.",
        ("uncovered", _) => "No footage, and Sentry USB's list of what the car wrote doesn't cover this time, so it can't tell whether the car recorded.",
        ("waiting", false) => "The car wrote this; Sentry USB hasn't archived since, so it is still on its way.",
        _ => "The car wrote these; Sentry USB hasn't archived since, so they are still on their way.",
    }
}

/// Consecutive minutes (seconds, sorted) as runs [{ from, to, minutes }].
fn run_list(minutes: &[i64]) -> Vec<Value> {
    let mut runs: Vec<(i64, i64)> = Vec::new();
    for &m in minutes {
        match runs.last_mut() {
            Some(last) if m - last.1 <= MIN as i64 => last.1 = m,
            _ => runs.push((m, m)),
        }
    }
    runs.into_iter().map(|(a, b)| json!({ "from": key_of_sec(a as f64), "to": key_of_sec(b as f64), "minutes": num(js::js_round((b - a) as f64 / MIN) + 1.0) })).collect()
}

fn sorted(set: impl IntoIterator<Item = i64>) -> Vec<i64> {
    let mut v: Vec<i64> = set.into_iter().collect();
    v.sort_unstable();
    v
}

/// x - (x mod 60), as JavaScript's % (the sign of x)
fn floor_min(s: i64) -> i64 {
    s - (((s % 60) + 60) % 60)
}

fn basename(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

fn dirname(p: &str) -> &str {
    p.rfind('/').map_or(".", |i| if i == 0 { "/" } else { &p[..i] })
}

/// matchKey: a Recent clip by its name, an event clip by its event folder and name
fn match_key(typ: &str, event: Option<&str>, name: &str) -> Option<String> {
    if typ == "RecentClips" {
        return Some(format!("R|{name}"));
    }
    match event {
        Some(e) if !e.is_empty() && (typ == "SentryClips" || typ == "SavedClips") => Some(format!("{typ}|{e}|{name}")),
        _ => None,
    }
}

/// keyOfRel: the type and event folder of a share rel ("Car/SentryClips/<event>/<clip>")
fn key_of_rel(rel: &str) -> Option<String> {
    let parts: Vec<&str> = rel.split('/').collect();
    let last = parts[parts.len() - 1];
    let name = last.strip_suffix(".binned").unwrap_or(last);
    for i in (0..parts.len().saturating_sub(1)).rev() {
        let t = match parts[i].to_lowercase().as_str() {
            "recentclips" => "RecentClips",
            "sentryclips" => "SentryClips",
            "savedclips" => "SavedClips",
            _ => continue,
        };
        let event = if t == "RecentClips" { None } else { parts.get(i + 1).copied().filter(|e| *e != name) };
        return match_key(t, event, name);
    }
    None
}

/// carFiles.js dailyCounts over (name, type, event)
fn daily_counts<'a>(entries: impl Iterator<Item = (&'a str, &'a str, Option<&'a str>)>) -> HashMap<String, [usize; 4]> {
    let mut out: HashMap<String, [usize; 4]> = HashMap::new();
    let mut minutes: HashMap<String, HashSet<String>> = HashMap::new();
    let mut events: HashMap<(String, bool), HashSet<String>> = HashMap::new();
    for (name, typ, event) in entries {
        let day = js::slice_units(name, 10);
        let d = out.entry(day.clone()).or_insert([0; 4]);
        if typ == "RecentClips" {
            d[0] += 1;
            minutes.entry(day).or_default().insert(js::slice_units(name, 16));
        } else if let Some(e) = event.filter(|e| !e.is_empty() && (typ == "SentryClips" || typ == "SavedClips")) {
            events.entry((day, typ == "SentryClips")).or_default().insert(e.to_string());
        }
    }
    for (day, set) in minutes {
        out.get_mut(&day).unwrap()[1] = set.len();
    }
    for ((day, sentry), set) in events {
        out.get_mut(&day).unwrap()[if sentry { 2 } else { 3 }] = set.len();
    }
    out
}

fn counts_json(c: &[usize; 4]) -> Value {
    json!({ "recentFiles": c[0], "minutes": c[1], "sentryEvents": c[2], "savedEvents": c[3] })
}

fn counts_text(c: &[usize; 4]) -> String {
    format!("{} covering {}, {}, {} saved {}", plural(c[0], "RecentClips file"), plural(c[1], "minute"), plural(c[2], "Sentry event"), c[3], if c[3] == 1 { "clip" } else { "clips" })
}

/// The day's accumulator (dayOf), made when first asked for.
fn day_of<'d>(days: &'d mut BTreeMap<String, DayAcc>, d: String) -> &'d mut DayAcc {
    days.entry(d).or_default()
}

/// analyze(): the gaps of one car, from what Sentry Six Manager holds (no I/O).
pub fn analyze(files: &Files, inp: &Input) -> Analysis {
    let now_ms = inp.now_ms;
    let tz = if inp.tz.is_empty() { "UTC" } else { inp.tz };
    let encoded = &inp.encoded;
    let speeds = &inp.speeds;
    let clock24 = inp.clock24;
    let now = wall_sec(now_ms, tz);
    let mut offsets = HashMap::new();
    let first_day_sec = ((now - (WINDOW_DAYS - 1.0) * 86400.0) / 86400.0).floor() * 86400.0;
    let mut clips: Vec<C> = Vec::new();
    for f in files.values() {
        if f.kind != crate::footage::Kind::Clip || f.size == 0 {
            continue;
        }
        let name = basename(&f.rel);
        let Some(s) = stamp_sec(name) else { continue };
        clips.push(C {
            rel: &f.rel,
            name,
            s,
            dir: dirname(&f.rel),
            typ: f.typ,
            recent: f.typ == "RecentClips",
            camera: f.camera.as_deref(),
            arrival: if f.birthtime_ms > 0.0 { Some(f.birthtime_ms) } else { (f.ctime_ms > 0.0).then_some(f.ctime_ms) },
            mtime: f.mtime_ms,
        });
    }
    let mut starts: Vec<f64> = clips.iter().map(|c| c.s).collect();
    starts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    starts.dedup();
    let newest_recent = clips.iter().filter(|c| c.recent).map(|c| c.s).reduce(f64::max);
    let newest_other = clips.iter().filter(|c| !c.recent).map(|c| c.s).reduce(f64::max);
    let ever_recent = match newest_recent {
        None => inp.last_recent_s,
        Some(n) => Some(n.max(inp.last_recent_s.unwrap_or(n))),
    };
    let habit = ever_recent.is_some() && !newest_other.is_some_and(|o| o > ever_recent.unwrap() + HABIT_DAYS * 86400.0);
    let mut received = if inp.received_ms > 0.0 { inp.received_ms } else { 0.0 };
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
    // Sentry USB is still copying this minute (its status file): not missing
    let pi = inp.sentry_usb.as_ref().filter(|p| p.first_s.is_finite());
    let pi_last = pi.map(|p| p.last_s.filter(|x| x.is_finite()).unwrap_or(p.first_s));
    let pi_holds = |s: f64| pi.is_some_and(|p| s >= p.first_s - MIN && (p.overdue || s <= pi_last.unwrap() + MIN));
    let hold_pi = |days: &mut BTreeMap<String, DayAcc>, s: f64| {
        if s >= first_day_sec && now - s >= GRACE_S {
            day_of(days, day_of_sec(s)).pi_held.insert(s as i64);
        }
    };
    let past = |s: f64| newest_recent.is_some_and(|n| n > s + MIN);
    let quiet = |s: f64| now - s >= LONG_GRACE_S && !catching_up;
    let due = |s: f64| now - s >= GRACE_S && (past(s) || quiet(s));
    let hold = |days: &mut BTreeMap<String, DayAcc>, s: f64| {
        if now - s >= GRACE_S && !past(s) && catching_up {
            day_of(days, day_of_sec(s)).held.insert(s as i64);
        }
    };
    let in_window = |s: f64| s >= first_day_sec;
    let values_of = |rel: &str| -> Vec<f64> { speeds.get(rel).map(|v| v.iter().filter_map(Value::as_f64).filter(|x| x.is_finite()).collect()).unwrap_or_default() };
    let mut front_at: HashMap<i64, Vec<f64>> = HashMap::new();
    for c in &clips {
        if c.camera == Some("front") && speeds.contains_key(c.rel) {
            front_at.insert(c.s as i64, values_of(c.rel));
        }
    }

    // can: minutes CAN Bridge shows the car driving, with no footage (missing); and
    // car: minutes it shows Sentry Mode on with no footage (only a note, never missing)
    let mut tz_shift: Vec<Value> = Vec::new();
    if let (true, Some(can_driving)) = (habit, inp.can_driving.as_ref()) {
        let mut what: HashMap<i64, bool> = HashMap::new(); // minute -> drive (else Sentry)
        for m in can_driving {
            what.insert(*m as i64, true);
        }
        for m in &inp.can_sentry {
            what.entry(*m as i64).or_insert(false);
        }
        let mut per_day: Vec<(String, Vec<i64>)> = Vec::new();
        for m in sorted(what.keys().copied()) {
            let mf = m as f64;
            if !in_window(mf) || covered(&starts, mf + 30.0) {
                continue;
            }
            let drive = what[&m];
            if pi_holds(mf) {
                if drive {
                    hold_pi(&mut days, mf);
                }
                continue;
            }
            if !due(mf) {
                if drive {
                    hold(&mut days, mf);
                }
                continue;
            }
            let day = day_of_sec(mf);
            match per_day.iter_mut().find(|(d, _)| *d == day) {
                Some((_, l)) => l.push(m),
                None => per_day.push((day, vec![m])),
            }
        }
        // CAN and footage a whole number of hours apart: the time zone is off, nothing is missing
        let can_set: Option<HashSet<i64>> = inp.can_minutes.as_ref().map(|c| c.iter().map(|x| floor_min(*x as i64)).collect());
        let mut starts_by_day: HashMap<String, HashSet<i64>> = HashMap::new();
        if can_set.is_some() {
            for x in &starts {
                let d = day_of_sec(*x);
                if !per_day.iter().any(|(pd, _)| *pd == d) {
                    continue;
                }
                starts_by_day.entry(d).or_default().insert(floor_min(*x as i64));
            }
        }
        for (day, list) in &per_day {
            let mut shift = 0i64;
            let mins: Vec<i64> = starts_by_day.get(day).map(|s| s.iter().copied().collect()).unwrap_or_default();
            if let Some(cs) = can_set.as_ref() {
                let aligned = |k: i64| mins.iter().filter(|x| cs.contains(&(*x + k * HOUR as i64))).count() as f64 / mins.len() as f64;
                if mins.len() >= 5 && aligned(0) < 0.3 {
                    let mut best = 0.0;
                    for k in (-12i64..=14).filter(|k| *k != 0) {
                        let back = list.iter().filter(|m| covered(&starts, (**m - k * HOUR as i64) as f64 + 30.0)).count() as f64 / list.len() as f64;
                        let a = aligned(k).min(back);
                        if a > best {
                            best = a;
                            shift = k;
                        }
                    }
                    if best < 0.7 {
                        shift = 0;
                    }
                }
            }
            if shift != 0 {
                tz_shift.push(json!({ "day": day, "hours": shift, "minutes": list.len() }));
                continue;
            }
            let d = day_of(&mut days, day.clone());
            for m in list {
                if what[m] {
                    d.missing.insert(*m);
                    d.can.push(*m);
                } else {
                    d.quiet.insert(*m);
                }
            }
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
            if pi_holds(end) {
                hold_pi(&mut days, end);
                continue;
            }
            if next.is_none() && !quiet(end) {
                hold(&mut days, end);
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
            let d = day_of(&mut days, day.clone());
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
        if let Some(cam) = c.camera.filter(|c| !c.is_empty()) {
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
            // (a minute Sentry USB is still copying is not partial yet)
            if pi_holds(e.0) {
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
            day_of(&mut days, day_of_sec(e.0)).partial.push((e.0, has, has + lacking.len(), lacking));
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
        let d = day_of(&mut days, day_of_sec(c.s));
        d.late += 1;
        d.max_late_ms = d.max_late_ms.max(lag);
        d.last_arrival = d.last_arrival.max(a);
    }

    let car_files_out = car_files_pass(inp, &clips, &mut days, first_day_sec, now, tz, habit, &pi_holds, &hold_pi);

    // the days of the range Sentry USB is copying (to its last clip; past its give-up time to now)
    if let Some(p) = pi {
        let to = if p.overdue { now } else { now.min(pi_last.unwrap() + MIN) };
        let mut s = p.first_s.max(first_day_sec);
        while s <= to {
            day_of(&mut days, day_of_sec(s)).pi_range = true;
            s = ((s / 86400.0).floor() + 1.0) * 86400.0;
        }
    }
    // the lost windows of missed snapshots, on the car's clock (stampSec's scale)
    let mut lost_windows: Vec<(f64, f64, f64, f64, f64)> = Vec::new(); // (from, to, lostTo, seconds, fromUnix)
    for (from_u, to_u, seconds, lost_to) in inp.snapshots.as_ref().map(|s| s.gaps.clone()).unwrap_or_default() {
        let Some(lost_to) = lost_to.filter(|l| l.is_finite() && *l > from_u) else { continue };
        if !from_u.is_finite() || !to_u.is_finite() {
            continue;
        }
        lost_windows.push((wall_sec(from_u * 1000.0, tz), wall_sec(to_u * 1000.0, tz), wall_sec(lost_to * 1000.0, tz), seconds, from_u));
    }
    let cf_days = car_files_out.get("days").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut out = BTreeMap::new();
    for (day, d) in &days {
        let missing = d.missing.len();
        let partial_minutes = d.partial.len();
        let late = d.late >= 4 && now_ms - d.last_arrival < FILLING_MS;
        let partial = missing > 0 || partial_minutes >= 2;
        let pi_day = pi.is_some() && (!d.pi_held.is_empty() || d.pi_range);
        let quiet_mins = sorted(d.quiet.iter().copied().filter(|m| !d.missing.contains(m) && !d.cut.contains(m)));
        let car_missed = d.cf.as_ref().map_or(0, |c| c.car.len());
        let sentry_quiet = (quiet_mins.len() >= SENTRY_QUIET_MIN).then(|| json!({ "minutes": quiet_mins.len(), "runs": run_list(&quiet_mins) }));
        if !partial && !late && d.held.is_empty() && !pi_day && sentry_quiet.is_none() && car_missed == 0 {
            continue;
        }
        let overdue = pi.is_some_and(|p| p.overdue);
        let state = if partial {
            "partial"
        } else if pi_day && overdue {
            "waiting"
        } else if late || !d.held.is_empty() || pi_day {
            "filling"
        } else {
            "car"
        };
        let mut sources: Vec<&str> = Vec::new();
        if !d.can.is_empty() {
            sources.push("can");
        }
        if !d.cutoffs.is_empty() {
            sources.push("speed");
        }
        if partial_minutes > 0 {
            sources.push("partial");
        }
        let can_runs: Vec<i64> = d.can.iter().copied().filter(|m| !d.cut.contains(m)).collect();
        let mut f = json!({
            "day": day, "state": state, "missingMinutes": missing, "partialMinutes": partial_minutes, "waitingMinutes": d.held.len(),
            "sentryUsb": if pi_day { json!(if overdue { "waiting" } else { "transferring" }) } else { Value::Null },
            "sentryUsbMinutes": d.pi_held.len(),
            "lateClips": if late { d.late } else { 0 }, "maxLateHours": if late { num(js::js_round(d.max_late_ms / 360000.0) / 10.0) } else { json!(0) },
            "can": run_list(&can_runs), "sentry": [],
            "cutoffs": d.cutoffs.iter().map(|(at, kph, next, lost)| json!({ "at": key_of_sec(*at), "kph": num(*kph), "next": next.map(key_of_sec), "minutes": num(*lost) })).collect::<Vec<_>>(),
            "partial": d.partial.iter().map(|(at, has, of, lacking)| json!({ "at": key_of_sec(*at), "cameras": has, "of": of, "lacking": lacking })).collect::<Vec<_>>(),
            "sources": sources
        });
        // missing minutes where the Pi took no snapshot for longer than the car keeps its footage
        let mut explained: Vec<(usize, usize)> = Vec::new(); // (window, its missing minutes)
        if !lost_windows.is_empty() {
            for m in &d.missing {
                let m = *m as f64;
                if let Some(w) = lost_windows.iter().position(|x| m + MIN > x.0 && m < x.2) {
                    match explained.iter_mut().find(|(i, _)| *i == w) {
                        Some(e) => e.1 += 1,
                        None => explained.push((w, 1)),
                    }
                }
            }
        }
        explained.sort_by(|a, b| lost_windows[a.0].0.partial_cmp(&lost_windows[b.0].0).unwrap());
        let missed: Vec<Value> = explained
            .iter()
            .map(|(w, n)| {
                let x = lost_windows[*w];
                json!({ "from": key_of_sec(x.0), "to": key_of_sec(x.1), "lostTo": key_of_sec(x.2), "minutes": num(js::js_round(x.3 / MIN)), "missingMinutes": n, "fromUnix": num(x.4) })
            })
            .collect();
        let missed_minutes: usize = explained.iter().map(|e| e.1).sum();
        f["snapshotIntervalS"] = if missed.is_empty() { Value::Null } else { inp.snapshots.as_ref().map_or(Value::Null, |s| num(s.interval_s)) };
        let has_missed = !missed.is_empty();
        f["missedSnapshots"] = json!(missed);
        f["missedSnapshotMinutes"] = json!(missed_minutes);
        // (key order as Node's: missedSnapshots, missedSnapshotMinutes, snapshotIntervalS)
        let interval = f["snapshotIntervalS"].take();
        f.as_object_mut().unwrap().shift_remove("snapshotIntervalS");
        f["snapshotIntervalS"] = interval;
        let _ = has_missed;
        let sentry_quiet = sentry_quiet.map(|mut q| {
            let note = car_sentence(&json!({ "day": day, "sentryQuiet": q }), clock24);
            q["note"] = json!(note);
            q
        });
        f["sentryQuiet"] = sentry_quiet.unwrap_or(Value::Null);
        // what Sentry USB's list says of the day
        let cf_day = cf_days.get(day);
        f["carFiles"] = match cf_day {
            Some(c) => json!({ "piMissed": c["piMissed"], "carMissed": c["carMissed"], "unknown": c["unknown"], "waiting": c["waiting"], "runs": c["runs"] }),
            None => Value::Null,
        };
        if cf_day.is_some_and(|c| c["piMissed"].as_u64().unwrap_or(0) > 0) {
            f["sources"].as_array_mut().unwrap().push(json!("carfiles"));
        }
        f["summary"] = json!(summarize(&f, received, now_ms, clock24));
        f["advice"] = json!(ADVICE);
        out.insert(day.clone(), f);
    }

    // stalled: nothing new on the share for a while from a car that usually has footage most days
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
            if pi.is_some_and(|p| p.overdue) {
                stalled["waitingForSentryUsb"] = json!(true);
            }
        }
    }
    let signals = json!({ "can": inp.can_driving.is_some() && habit, "speed": habit && !speeds.is_empty(), "arrival": informative, "recent": habit, "catchingUp": catching_up,
        "receivedAt": if received > 0.0 { num(received) } else { Value::Null }, "tzShift": tz_shift,
        "sentryUsb": pi.map_or(Value::Null, |p| json!(if p.overdue { "waiting" } else { "transferring" })), "carfiles": !car_files_out.is_null() });
    Analysis { days: out, stalled, signals, newest_recent, received, car_files: car_files_out }
}

/// carFilesPass: missing footage told apart by Sentry USB's list of what the car wrote. Adds
/// Pi-missed minutes to the days' missing minutes, takes "car didn't record" and not-yet-archived
/// ones out of them; null without a list.
#[allow(clippy::too_many_arguments)]
fn car_files_pass(inp: &Input, clips: &[C], days: &mut BTreeMap<String, DayAcc>, first_day_sec: f64, now: f64, tz: &str, habit: bool, pi_holds: &dyn Fn(f64) -> bool, hold_pi: &dyn Fn(&mut BTreeMap<String, DayAcc>, f64)) -> Value {
    let Some(car_files) = inp.car_files.as_ref() else { return Value::Null };
    let Some(list) = car_files.list.as_ref() else {
        return json!({ "present": true, "error": car_files.error.clone().unwrap_or_else(|| "unreadable".into()), "coveredFrom": null, "coveredTo": null, "days": {} });
    };
    // what is on the share (and in the Recycle Bin), by the key a clip is matched on
    let mut on_share: HashSet<String> = HashSet::new();
    let mut share_types: HashSet<&str> = HashSet::new();
    for c in clips {
        if let Some(k) = match_key(c.typ, if c.recent { None } else { Some(basename(c.dir)) }, c.name) {
            on_share.insert(k);
        }
        share_types.insert(c.typ);
    }
    for rel in inp.binned.iter().flatten() {
        if let Some(k) = key_of_rel(rel) {
            on_share.insert(k);
        }
    }
    let gone: HashSet<String> = inp.deleted.iter().flatten().filter_map(|r| key_of_rel(r)).collect();
    // the stretch the list can speak for: from its first line to its last listing before the
    // share's copy was written, less the Pi's time off (snapshot gaps)
    let from_s = list.first_seen_unix.map(|u| wall_sec(u * 1000.0, tz));
    let file_unix = if car_files.file_unix.is_finite() { car_files.file_unix } else { 0.0 };
    let to_unix = file_unix.max(list.last_seen_unix.unwrap_or(0.0)) - CF_BEHIND_S;
    let to_s = from_s.map(|_| wall_sec(to_unix * 1000.0, tz));
    let mut off: Vec<(f64, f64)> = Vec::new();
    for (f, t, _, _) in inp.snapshots.as_ref().map(|s| s.gaps.clone()).unwrap_or_default() {
        if f.is_finite() && t.is_finite() && t > f {
            off.push((wall_sec(f * 1000.0, tz), wall_sec(t * 1000.0, tz)));
        }
    }
    let is_off = |m: f64| off.iter().any(|w| m + MIN > w.0 && m < w.1);
    let in_list = |m: f64| from_s.is_some_and(|f| m >= f && m + MIN <= to_s.unwrap());
    let archived = car_files.archived_unix.filter(|a| a.is_finite());
    // the car's clips of the window, by minute
    let mut listed: HashSet<i64> = HashSet::new();
    let mut entries: Vec<&crate::can::sentry_usb::CarClip> = Vec::new();
    for e in list.clips.values() {
        if !matches!(e.kind, "RecentClips" | "SentryClips" | "SavedClips") {
            continue;
        }
        let Some(s) = stamp_sec(&e.name) else { continue };
        if s < first_day_sec {
            continue;
        }
        entries.push(e);
        listed.insert(floor_min(s as i64));
    }
    // pi: the car wrote it, it is not on the share, and the Pi has archived since it saw it
    for e in &entries {
        if if e.kind == "RecentClips" { !habit } else { !share_types.contains(e.kind) } {
            continue;
        }
        let Some(k) = match_key(e.kind, e.event.as_deref(), &e.name) else { continue };
        if on_share.contains(&k) {
            continue;
        }
        let s = stamp_sec(&e.name).unwrap();
        let m = floor_min(s as i64);
        let day = day_of_sec(s);
        if gone.contains(&k) {
            let cf = day_of(days, day).cf.get_or_insert_with(Cf::default);
            cf.deleted.insert(m);
            cf.deleted_clips += 1;
            continue;
        }
        // too new to judge: still on its way, not skipped
        if now - s < GRACE_S {
            day_of(days, day).cf.get_or_insert_with(Cf::default).waiting.insert(m);
            continue;
        }
        if pi_holds(s) {
            day_of(days, day.clone()).cf.get_or_insert_with(Cf::default);
            hold_pi(days, s);
            continue;
        }
        if archived.is_none_or(|a| a < e.last_seen_unix + CF_ARCHIVE_MARGIN_S) {
            day_of(days, day).cf.get_or_insert_with(Cf::default).waiting.insert(m);
            continue;
        }
        let d = day_of(days, day);
        let cf = d.cf.get_or_insert_with(Cf::default);
        cf.pi_clips += 1;
        cf.pi.insert(m);
        d.missing.insert(m);
    }
    // the minutes found missing without the list (CAN driving, a drive cut off): pi, car, waiting or unknown
    for d in days.values_mut() {
        let can_drove: HashSet<i64> = d.can.iter().map(|m| floor_min(*m)).collect();
        let raws: Vec<i64> = d.missing.iter().copied().collect();
        for raw in raws {
            let m = floor_min(raw);
            let cf = d.cf.get_or_insert_with(Cf::default);
            if cf.pi.contains(&m) {
                continue;
            }
            if cf.waiting.contains(&m) || cf.deleted.contains(&m) {
                d.missing.remove(&raw);
                continue;
            }
            if listed.contains(&m) {
                continue;
            }
            let mf = m as f64;
            if in_list(mf) && !is_off(mf) {
                if can_drove.contains(&m) {
                    cf.car.insert(m);
                }
                d.missing.remove(&raw);
                d.cut.remove(&raw);
                continue;
            }
            cf.unknown.insert(m, if is_off(mf) { "off" } else { "uncovered" });
        }
        let missing = &d.missing;
        d.can.retain(|m| missing.contains(m));
    }
    // the Pi's daily counts beside the share's
    let car_counts = daily_counts(entries.iter().map(|e| (e.name.as_str(), e.kind, e.event.as_deref())));
    let share_by_day = daily_counts(clips.iter().filter(|c| c.s >= first_day_sec).map(|c| (c.name, c.typ, if c.recent { None } else { Some(basename(c.dir)) })));
    let mut out = Map::new();
    let mut s = first_day_sec;
    while s <= now {
        let day = day_of_sec(s);
        let cf = days.get(&day).and_then(|d| d.cf.as_ref());
        let car = car_counts.get(&day).copied().unwrap_or([0; 4]);
        let share = share_by_day.get(&day).copied().unwrap_or([0; 4]);
        let end = s + 86400.0;
        let coverage = match (from_s, to_s) {
            (Some(f), Some(t)) if !(end <= f || s >= t) => {
                if s < f || end > t || off.iter().any(|w| w.1 > s && w.0 < end) {
                    "partial"
                } else {
                    "full"
                }
            }
            _ => "none",
        };
        let anything = car[0] > 0 || car[2] > 0 || car[3] > 0 || share[0] > 0 || share[2] > 0 || share[3] > 0
            || cf.is_some_and(|c| !c.pi.is_empty() || !c.car.is_empty() || !c.unknown.is_empty() || !c.waiting.is_empty() || !c.deleted.is_empty());
        if !anything {
            s += 86400.0;
            continue;
        }
        let mut runs: Vec<Value> = Vec::new();
        let mut add = |kind: &str, minutes: Vec<i64>, why_kind: &str| {
            for r in run_list(&sorted(minutes)) {
                let n = r["minutes"].as_f64().unwrap_or(1.0);
                let (from, to) = (r["from"].as_str().unwrap().to_string(), r["to"].as_str().unwrap().to_string());
                let when = if n > 1.0 { clock_pair(&from, &to, &day, inp.clock24, "–") } else { clock_one(&from, &day, inp.clock24) };
                runs.push(json!({ "kind": kind, "from": from, "to": to, "minutes": r["minutes"], "when": when, "why": why(why_kind, n > 1.0) }));
            }
        };
        if let Some(c) = cf {
            add("pi", c.pi.iter().copied().collect(), "pi");
            add("car", c.car.iter().copied().collect(), "car");
            add("waiting", c.waiting.iter().copied().collect(), "waiting");
            for w in ["off", "uncovered"] {
                add("unknown", c.unknown.iter().filter(|(_, x)| **x == w).map(|(m, _)| *m).collect(), w);
            }
            runs.sort_by(|a, b| js::locale_cmp(a["from"].as_str().unwrap_or(""), b["from"].as_str().unwrap_or("")));
        }
        out.insert(
            day.clone(),
            json!({
                "day": day, "coverage": coverage, "car": counts_json(&car), "share": counts_json(&share), "carText": counts_text(&car), "shareText": counts_text(&share),
                "piMissed": cf.map_or(0, |c| c.pi.len()), "piMissedClips": cf.map_or(0, |c| c.pi_clips), "carMissed": cf.map_or(0, |c| c.car.len()),
                "unknown": cf.map_or(0, |c| c.unknown.len()), "waiting": cf.map_or(0, |c| c.waiting.len()),
                "deleted": cf.map_or(0, |c| c.deleted.len()), "deletedClips": cf.map_or(0, |c| c.deleted_clips), "runs": runs
            }),
        );
        s += 86400.0;
    }
    json!({ "present": true, "error": null, "coveredFrom": list.first_seen_unix.map_or(Value::Null, num), "coveredTo": if from_s.is_none() { Value::Null } else { num(to_unix) }, "days": out })
}

/// Runs of minutes in words: "1:51–4:45 AM, 7:02–8:58 AM and 3 more stretches".
fn run_words(runs: &[Value], day: &str, clock24: bool) -> String {
    let shown: Vec<String> = runs
        .iter()
        .take(3)
        .map(|r| {
            let (from, to) = (r["from"].as_str().unwrap_or(""), r["to"].as_str().unwrap_or(""));
            if r["minutes"].as_f64().unwrap_or(0.0) > 1.0 { clock_pair(from, to, day, clock24, "–") } else { clock_one(from, day, clock24) }
        })
        .collect();
    let extra = runs.len() as i64 - 3;
    let more = if extra > 0 { format!(" and {extra} more stretch{}", if extra == 1 { "" } else { "es" }) } else { String::new() };
    let head = if shown.len() > 1 && more.is_empty() { format!("{} and {}", shown[..shown.len() - 1].join(", "), shown[shown.len() - 1]) } else { shown.join(", ") };
    format!("{head}{more}")
}

/// The missed snapshots of a day in words, or '' without any.
pub fn snapshot_sentence(f: &Value, clock24: bool) -> String {
    let gaps = f["missedSnapshots"].as_array().cloned().unwrap_or_default();
    if gaps.is_empty() {
        return String::new();
    }
    let day = f["day"].as_str().unwrap_or("");
    let shown = &gaps[..gaps.len().min(MAX_GAPS_SHOWN)];
    let extra = gaps.len() - shown.len();
    let join = |items: &[String]| if items.len() > 1 { format!("{} and {}", items[..items.len() - 1].join(", "), items[items.len() - 1]) } else { items[0].clone() };
    let every = match f["snapshotIntervalS"].as_f64().filter(|x| *x != 0.0) {
        Some(i) => format!("it should take one every {}", foot_minutes(i / 60.0)),
        None => String::new(),
    };
    let s = |g: &Value, k: &str| g[k].as_str().unwrap_or("").to_string();
    let between: Vec<String> = shown
        .iter()
        .enumerate()
        .map(|(i, g)| {
            let semi = if shown.len() == 1 && !every.is_empty() { format!("; {every}") } else { String::new() };
            format!("{}{} ({}{semi})", if i > 0 { "between " } else { "" }, clock_pair(&s(g, "from"), &s(g, "to"), day, clock24, " and "), foot_minutes(g["minutes"].as_f64().unwrap_or(0.0)))
        })
        .collect();
    let more = if extra > 0 { format!(", and {extra} more {}", if extra == 1 { "time" } else { "times" }) } else { String::new() };
    let lost = join(&shown.iter().map(|g| clock_pair(&s(g, "from"), &s(g, "lostTo"), day, clock24, " to about ")).collect::<Vec<_>>());
    let head = format!("Sentry USB took no snapshot between {}{more}", if extra > 0 || shown.len() == 1 { between.join(", ") } else { join(&between) });
    let rule = if shown.len() == 1 && !every.is_empty() { String::new() } else if !every.is_empty() { format!("; {every}") } else { String::new() };
    let (mm, all) = (f["missedSnapshotMinutes"].as_u64().unwrap_or(0), f["missingMinutes"].as_u64().unwrap_or(0));
    let share = if mm > 0 && mm < all { format!(" ({mm} of the {all} minutes)") } else { String::new() };
    format!("{head}{rule}, and the car keeps only about an hour, so the footage from {lost}{} was overwritten before it was copied{share}", if extra > 0 { " (and more)" } else { "" })
}

/// Driving minutes Sentry USB's list shows the car never wrote, in words; '' without any.
pub fn drive_sentence(f: &Value, clock24: bool) -> String {
    let n = f["carFiles"]["carMissed"].as_u64().unwrap_or(0);
    if n == 0 {
        return String::new();
    }
    let runs: Vec<Value> = f["carFiles"]["runs"].as_array().into_iter().flatten().filter(|r| r["kind"] == json!("car")).cloned().collect();
    format!(
        "The car was driving {} but didn't save video to the USB drive: Sentry USB's list of what the car wrote has nothing for {} (a car or USB drive problem, not the archive). Check the car: a grey dashcam icon or a USB warning on its screen, or a USB drive that needs replacing.",
        run_words(&runs, f["day"].as_str().unwrap_or(""), clock24),
        if n == 1 { "that minute".to_string() } else { format!("those {n} minutes") }
    )
}

/// The note for a day the car spent in Sentry Mode without recording (sentryQuiet); '' without one.
pub fn car_sentence(f: &Value, clock24: bool) -> String {
    let drive = drive_sentence(f, clock24);
    let q = &f["sentryQuiet"];
    let minutes = q["minutes"].as_f64().unwrap_or(0.0);
    if minutes == 0.0 {
        return drive;
    }
    format!(
        "{}The car was in Sentry Mode for {} ({}) but wrote no footage, though it usually records while parked in Sentry. Check the car: Sentry Mode may be excluded at this place (Home, Work or Favorites), or its dashcam stopped writing to the USB drive (a grey dashcam icon or a USB warning on the car's screen).",
        if drive.is_empty() { String::new() } else { format!("{drive} ") },
        foot_minutes(minutes),
        run_words(q["runs"].as_array().map(Vec::as_slice).unwrap_or(&[]), f["day"].as_str().unwrap_or(""), clock24)
    )
}

/// The evidence in plain words (for the tag and the notification).
pub fn summarize(f: &Value, received_ms: f64, now_ms: f64, clock24: bool) -> String {
    let car = car_sentence(f, clock24);
    if f["state"] == json!("car") {
        return car;
    }
    let day = f["day"].as_str().unwrap_or("");
    let list = |runs: &[Value]| run_words(runs, day, clock24);
    let arr = |k: &str| f[k].as_array().cloned().unwrap_or_default();
    let mut bits: Vec<String> = Vec::new();
    let can = arr("can");
    if !can.is_empty() {
        bits.push(format!("CAN Bridge shows the car driving {} with no footage", list(&can)));
    }
    let sentry = arr("sentry");
    if !sentry.is_empty() {
        bits.push(format!("CAN Bridge shows Sentry Mode on {} with no footage", list(&sentry)));
    }
    let cf = &f["carFiles"];
    let pi_missed = cf["piMissed"].as_u64().unwrap_or(0) as usize;
    if pi_missed > 0 {
        let runs: Vec<Value> = cf["runs"].as_array().into_iter().flatten().filter(|r| r["kind"] == json!("pi")).cloned().collect();
        bits.push(format!("Sentry USB's list shows the car wrote {} of it ({}), but Sentry USB didn't keep or upload {}", plural(pi_missed, "minute"), list(&runs), if pi_missed == 1 { "it" } else { "them" }));
    }
    let unknown = cf["unknown"].as_u64().unwrap_or(0) as usize;
    let mm = f["missingMinutes"].as_u64().unwrap_or(0) as usize;
    if unknown > 0 && mm > 0 {
        bits.push(format!("for {} Sentry USB can't tell whether the car recorded (it was off or restarting, or its list doesn't cover {})", plural(unknown, "minute"), if unknown == 1 { "it" } else { "them" }));
    }
    let cutoffs = arr("cutoffs");
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
    let pim = f["sentryUsbMinutes"].as_u64().unwrap_or(0) as usize;
    let pi_min = if pim > 0 { format!(", so {} of this day {} not here yet", plural(pim, "minute"), if pim == 1 { "is" } else { "are" }) } else { String::new() };
    match f["sentryUsb"].as_str() {
        Some("waiting") => bits.push(format!("Sentry USB's transfer stopped part way (the car most likely drove off or lost Wi-Fi){pi_min}. Nothing is lost: the clips stay on the Sentry USB and the rest arrives at its next archive")),
        Some("transferring") => bits.push(format!("Sentry USB is copying this day's clips now{}", if pim > 0 { format!("; {} {} still on the way", plural(pim, "minute"), if pim == 1 { "is" } else { "are" }) } else { String::new() })),
        _ => {}
    }
    let head = if f["state"] == json!("waiting") {
        "Waiting for Sentry USB: ".to_string()
    } else if f["state"] == json!("filling") {
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
    let snap = snapshot_sentence(f, clock24);
    format!("{head}{text}.{}{}", if snap.is_empty() { String::new() } else { format!(" {snap}.") }, if car.is_empty() { String::new() } else { format!(" {car}") })
}

/// The check after each scan, and the last result for the route.
pub struct ArchiveGap {
    ctx: Arc<dyn Ctx>,
    speed_index: Arc<super::speed_index::SpeedIndex>,
    results: Mutex<HashMap<String, Value>>,
    running: Mutex<()>,
    /// "<key>/<minute file>" -> 'drive' | 'sentry' | 'none'
    can_cache: Mutex<HashMap<String, &'static str>>,
    /// bumped by forget(): a check that started before is not kept
    generation: Mutex<HashMap<String, u64>>,
    /// soon(): the checks asked for a little later, by vehicle (the time asked last)
    soon: Mutex<HashMap<String, std::time::Instant>>,
}

const MAX_DECODE: usize = 3000;
const LEARN_READS: usize = 300;
const LEARN_MIN: usize = 10;
const SOON: std::time::Duration = std::time::Duration::from_secs(30);

fn key_ok(k: &str) -> bool {
    !k.is_empty() && k.len() <= 64 && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// A minute file's name (YYYYMMDDTHHMM.json.gz) as UTC milliseconds.
fn minute_file_ms(name: &str) -> Option<f64> {
    let b = name.as_bytes();
    if b.len() != 21 || !name.ends_with(".json.gz") || b[8] != b'T' || !b[..8].iter().chain(&b[9..13]).all(u8::is_ascii_digit) {
        return None;
    }
    let n = |a: usize, z: usize| name[a..z].parse::<i64>().unwrap_or(0);
    Some(js::utc_seconds(n(0, 4), n(4, 6), n(6, 8), n(9, 11), n(11, 13), 0) * 1000.0)
}

/// What canActivityOf found: the minutes, and what was learned.
struct CanActivity {
    driving: Vec<f64>,
    sentry: Vec<f64>,
    minutes: Vec<f64>,
    learned_sentry: bool,
    learned_matched: Vec<String>,
    used: bool,
}

impl ArchiveGap {
    pub fn new(ctx: Arc<dyn Ctx>, speed_index: Arc<super::speed_index::SpeedIndex>) -> Arc<ArchiveGap> {
        Arc::new(ArchiveGap { ctx, speed_index, results: Mutex::new(HashMap::new()), running: Mutex::new(()), can_cache: Mutex::new(HashMap::new()), generation: Mutex::new(HashMap::new()), soon: Mutex::new(HashMap::new()) })
    }

    fn clock24(&self) -> Result<bool, String> {
        Ok(self.ctx.setting("appearance")?.and_then(|a| a.get("clock24").cloned()).is_some_and(|v| crate::ops::js::truthy(&v)))
    }

    /// loadState: the state kept between checks, with Node's defaults (and the first
    /// version's, which kept only the days at the top level); an error when it cannot be read
    fn load_state(&self, vid: &str) -> Result<Map<String, Value>, String> {
        let raw = self.ctx.setting(&format!("archive-gap:{vid}"))?.filter(|v| crate::ops::js::truthy(v)).unwrap_or(json!({}));
        let mut st = Map::new();
        for (k, v) in [("days", json!({})), ("rx", Value::Null), ("lastRecentS", Value::Null), ("sentry", json!(false)), ("matched", json!([]))] {
            st.insert(k.into(), v);
        }
        let Value::Object(raw) = raw else { return Ok(st) };
        if raw.get("days").is_some_and(crate::ops::js::truthy) {
            for (k, v) in &raw {
                st.insert(k.clone(), v.clone());
            }
            // what was learned from the CAN minutes is learned again when the index decodes the
            // car's buses differently (canIndex.js CAR_FORMAT)
            if raw.get("canFormat").and_then(Value::as_str) != Some(crate::can::index::CAR_FORMAT) {
                st.insert("sentry".into(), json!(false));
                st.insert("matched".into(), json!([]));
            }
            return Ok(st);
        }
        let days: Map<String, Value> = raw.into_iter().filter(|(_, v)| v.is_object() && v.get("day").is_some_and(crate::ops::js::truthy)).collect();
        st.insert("days".into(), Value::Object(days));
        Ok(st)
    }

    fn minute_kind(&self, dir: &std::path::Path, key: &str, name: &str) -> &'static str {
        let id = format!("{key}/{name}");
        if let Some(k) = self.can_cache.lock().unwrap().get(&id) {
            return k;
        }
        let file = dir.join(key).join(name);
        let head = crate::can::format::read_head(&file);
        let kind = match head.as_ref().and_then(|h| h.get("act")).and_then(Value::as_str) {
            Some("d") => Some("drive"),
            Some("s") => Some("sentry"),
            Some("n") => Some("none"),
            _ => None,
        };
        let kind = match kind {
            Some(k) => k,
            None => match crate::can::format::read_minute_file(&file) {
                // unreadable now: asked again next time
                None => return "none",
                Some(m) => crate::can::format::classify(&m.signals),
            },
        };
        let mut c = self.can_cache.lock().unwrap();
        if c.len() > 100_000 {
            c.clear();
        }
        c.insert(id, kind);
        kind
    }

    /// canActivityOf: CAN minutes with no footage, on the car's clock (seconds), or None without CAN data
    /// (an error when the keys' cars cannot be read).
    fn can_activity_of(&self, v: &super::ctx::VehicleRef, files: &Files, now_ms: f64, st: &Map<String, Value>) -> Result<Option<CanActivity>, String> {
        let dir = self.ctx.data_dir().join("can-index");
        let keys: Vec<String> = self.ctx.can_keys(&v.id).into_iter().filter(|k| key_ok(k)).collect();
        if keys.is_empty() {
            return Ok(None);
        }
        let tz = if v.timezone.is_empty() { "UTC" } else { v.timezone.as_str() };
        let mut starts: Vec<f64> = files.values().filter(|f| f.kind == crate::footage::Kind::Clip).filter_map(|f| stamp_sec(basename(&f.rel))).collect();
        starts.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let from_key: String = js::iso(now_ms - (WINDOW_DAYS + 1.0) * 86400_000.0)[..16].chars().filter(|c| *c != '-' && *c != ':').collect();
        let now_wall = wall_sec(now_ms, tz);
        let st_sentry = st.get("sentry").is_some_and(crate::ops::js::truthy);
        let mut matched: Vec<String> = st.get("matched").and_then(Value::as_array).into_iter().flatten().filter_map(|x| x.as_str().map(String::from)).collect();
        let (mut read, mut learned, mut sentry_covered, mut sentry_bare) = (0usize, 0usize, 0usize, 0usize);
        struct K {
            key: String,
            mapped: bool,
            driving: Vec<f64>,
            sentry: Vec<f64>,
            minutes: Vec<f64>,
        }
        let mut per_key: Vec<K> = Vec::new();
        for key in keys {
            let Ok(rd) = std::fs::read_dir(dir.join(&key)) else { continue };
            let mapped = self.ctx.can_key_mapped(&key)?;
            let trusted = mapped || matched.contains(&key);
            let mut k = K { key: key.clone(), mapped, driving: vec![], sentry: vec![], minutes: vec![] };
            let mut covered_active = 0usize;
            let mut names: Vec<String> = rd.filter_map(|e| e.ok()).filter_map(|e| e.file_name().into_string().ok()).filter(|x| js::slice_units(x, 13).as_str() >= from_key.as_str() && minute_file_ms(x).is_some()).collect();
            names.sort();
            names.reverse();
            for name in names {
                let Some(ms) = minute_file_ms(&name) else { continue };
                let s = wall_sec(ms, tz);
                k.minutes.push(s);
                if now_wall - s < GRACE_S {
                    continue;
                }
                let id = format!("{key}/{name}");
                let cached = self.can_cache.lock().unwrap().contains_key(&id);
                if covered(&starts, s + 30.0) {
                    // minutes with footage are read only to learn: is this key the car, does it record in Sentry
                    if trusted && st_sentry {
                        continue;
                    }
                    if !cached {
                        learned += 1;
                        if learned > LEARN_READS {
                            continue;
                        }
                    }
                    let kind = self.minute_kind(&dir, &key, &name);
                    if kind != "none" {
                        covered_active += 1;
                    }
                    if kind == "sentry" {
                        sentry_covered += 1;
                    }
                    continue;
                }
                // only minutes old enough to count and with no footage are read
                if !cached {
                    read += 1;
                    if read > MAX_DECODE {
                        continue;
                    }
                }
                match self.minute_kind(&dir, &key, &name) {
                    "drive" => k.driving.push(s),
                    "sentry" => {
                        k.sentry.push(s);
                        sentry_bare += 1;
                    }
                    _ => {}
                }
            }
            if !mapped && covered_active >= LEARN_MIN && !matched.contains(&key) {
                matched.push(key.clone());
            }
            per_key.push(k);
        }
        let sentry = st_sentry || (sentry_covered >= LEARN_MIN && sentry_covered >= sentry_bare);
        let used: Vec<&K> = per_key.iter().filter(|k| k.mapped || matched.contains(&k.key)).collect();
        Ok(Some(CanActivity {
            driving: used.iter().flat_map(|k| k.driving.iter().copied()).collect(),
            sentry: if sentry { used.iter().flat_map(|k| k.sentry.iter().copied()).collect() } else { Vec::new() },
            minutes: used.iter().flat_map(|k| k.minutes.iter().copied()).collect(),
            learned_sentry: sentry,
            learned_matched: matched,
            used: !used.is_empty(),
        }))
    }

    /// One check of a car (one at a time); its result, or None before the first scan.
    pub fn check(&self, vid: &str) -> Option<Value> {
        let _one = self.running.lock().unwrap();
        let gen = self.generation.lock().unwrap().get(vid).copied().unwrap_or(0);
        let v = self.ctx.vehicle(vid)?;
        let files = self.ctx.files(vid)?;
        let now_ms = js::now_ms();
        let tz = if v.timezone.is_empty() { "UTC".to_string() } else { v.timezone.clone() };
        let key = format!("archive-gap:{vid}");
        // (what the check needs cannot be read: no check now, nothing raised or cleared on a guess)
        let unread = |e: String| -> Option<Value> {
            eprintln!("Archive gaps of {}: not checked now, a setting could not be read: {e}", v.name);
            None
        };
        let mut st = match self.load_state(vid) {
            Ok(st) => st,
            Err(e) => return unread(e),
        };
        // received(): the clips from a fixed start went up in number
        let from = stamp_sec(&format!("{}_00-00-00", day_of_sec(wall_sec(now_ms, &tz) - (WINDOW_DAYS + 1.0) * 86400.0))).unwrap_or(0.0);
        let count_from = |f0: f64| files.values().filter(|f| f.kind == crate::footage::Kind::Clip && f.size > 0).filter_map(|f| stamp_sec(basename(&f.rel))).filter(|s| *s >= f0).count();
        let rx = st.get("rx").filter(|r| crate::ops::js::truthy(r)).cloned();
        let grew = rx.as_ref().is_none_or(|r| count_from(js::number(r.get("from"))) as f64 > js::number(r.get("count")));
        let at = if grew { now_ms } else { js::number(rx.as_ref().and_then(|r| r.get("at"))) };
        st.insert("rx".into(), json!({ "from": num(from), "count": count_from(from), "at": num(at) }));
        let can = match self.can_activity_of(&v, &files, now_ms, &st) {
            Ok(c) => c,
            Err(e) => return unread(e),
        };
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
        let used = can.as_ref().is_some_and(|c| c.used);
        let (clock24, binned, deleted) = match (self.clock24(), self.ctx.binned(vid), self.ctx.deleted_clips(vid)) {
            (Ok(c), Ok(b), Ok(d)) => (c, b, d),
            (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => return unread(e),
        };
        let input = Input {
            now_ms,
            tz: &tz,
            encoded: self.ctx.encoded(vid),
            speeds,
            can_driving: if used { can.as_ref().map(|c| c.driving.clone()) } else { None },
            can_sentry: can.as_ref().map(|c| c.sentry.clone()).unwrap_or_default(),
            can_minutes: if used { can.as_ref().map(|c| c.minutes.clone()) } else { None },
            received_ms: at,
            last_recent_s: last_recent,
            sentry_usb: self.ctx.sentry_usb_pi(vid),
            snapshots: self.ctx.snapshots(vid),
            clock24,
            car_files: self.ctx.car_files(vid),
            binned,
            deleted,
        };
        let res = analyze(&files, &input);
        // the car was removed while this ran: nothing of it is kept or raised
        if self.generation.lock().unwrap().get(vid).copied().unwrap_or(0) != gen || self.ctx.vehicle(vid).is_none() {
            return None;
        }
        if let Some(c) = &can {
            st.insert("sentry".into(), json!(c.learned_sentry));
            st.insert("matched".into(), json!(c.learned_matched));
            st.insert("canFormat".into(), json!(crate::can::index::CAR_FORMAT));
        }
        if let Some(n) = res.newest_recent {
            st.insert("lastRecentS".into(), num(n.max(last_recent.unwrap_or(0.0))));
        }
        // (stopped at a notification manager.db did not give or keep: the days stay as they were, so
        // the next check goes on from there, and a note's being open is never guessed)
        if let Err(e) = self.sync(&v, &res, &mut st, &files, now_ms, &tz) {
            eprintln!("Archive gaps of {}: the notifications were not brought up to date: {e}", v.name);
        }
        // (a note for the next check: one that was not kept is learned again)
        if let Err(e) = self.ctx.set_setting(&key, Value::Object(st)) {
            eprintln!("Archive gaps of {}: what this check learned was not kept: {e}", v.name);
        }
        let out = json!({ "days": res.days, "stalled": res.stalled, "signals": res.signals, "carFiles": res.car_files, "checkedAt": num(now_ms) });
        self.results.lock().unwrap().insert(vid.to_string(), out.clone());
        Some(out)
    }

    /// soon(vid): a check a little later (CAN logs were indexed; several in a row make one check).
    pub fn soon(self: &Arc<Self>, vid: &str) {
        let at = std::time::Instant::now();
        self.soon.lock().unwrap().insert(vid.to_string(), at);
        let (me, id) = (self.clone(), vid.to_string());
        std::thread::spawn(move || {
            std::thread::sleep(SOON);
            let latest = me.soon.lock().unwrap().get(&id).copied();
            if latest == Some(at) {
                me.soon.lock().unwrap().remove(&id);
                me.check(&id);
            }
        });
    }

    /// indexed(key, from, to): a CAN log was indexed; what was read of its minutes is forgotten.
    pub fn indexed(&self, key: &str, from: Option<f64>, to: Option<f64>) {
        let pre = format!("{key}/");
        self.can_cache.lock().unwrap().retain(|id, _| {
            let Some(rest) = id.strip_prefix(&pre) else { return true };
            let t = minute_file_ms(rest);
            let gone = match (t, from.filter(|f| f.is_finite())) {
                (None, _) | (_, None) => true,
                (Some(t), Some(f)) => t + 60_000.0 > f && t <= to.unwrap_or(f64::NAN),
            };
            !gone
        });
    }

    /// forget(vid): a removed vehicle: its result, notifications and state go.
    pub fn forget(&self, vid: &str) {
        *self.generation.lock().unwrap().entry(vid.to_string()).or_insert(0) += 1;
        self.soon.lock().unwrap().remove(vid);
        self.results.lock().unwrap().remove(vid);
        let resolved = self.ctx.open_notes(vid, "archive").and_then(|keys| keys.iter().filter(|k| k.starts_with(&format!("archive:{vid}:"))).try_for_each(|k| self.ctx.resolve_note(k)));
        if let Err(e) = resolved {
            eprintln!("Archive gaps of removed vehicle {vid}: its notifications were not resolved: {e}");
        }
        if let Err(e) = self.ctx.set_setting(&format!("archive-gap:{vid}"), json!({})) {
            eprintln!("Archive gaps of removed vehicle {vid}: its notes were not cleared: {e}");
        }
        self.ctx.announce("notifications");
    }

    /// forDays(vid): the day cards' `archive` (no check started).
    pub fn for_days(&self, vid: &str) -> HashMap<String, Value> {
        let r = self.results.lock().unwrap().get(vid).cloned();
        let mut out = HashMap::new();
        for (d, f) in r.as_ref().and_then(|r| r["days"].as_object()).into_iter().flatten() {
            let missed = f["missedSnapshots"].as_array().filter(|a| !a.is_empty()).map_or(Value::Null, |a| json!(a));
            let or_null = |v: &Value| if crate::ops::js::truthy(v) { v.clone() } else { Value::Null };
            out.insert(
                d.clone(),
                json!({
                    "state": f["state"], "missingMinutes": f["missingMinutes"], "partialMinutes": f["partialMinutes"], "lateClips": f["lateClips"], "maxLateHours": f["maxLateHours"],
                    "sentryUsb": or_null(&f["sentryUsb"]), "missedSnapshots": missed, "missedSnapshotMinutes": if crate::ops::js::truthy(&f["missedSnapshotMinutes"]) { f["missedSnapshotMinutes"].clone() } else { json!(0) },
                    "sentryQuiet": or_null(&f["sentryQuiet"]), "carFiles": or_null(&f["carFiles"]), "summary": f["summary"],
                    "advice": if f["state"] == json!("partial") { json!(ADVICE) } else { Value::Null }
                }),
            );
        }
        out
    }

    /// carFiles(vid): what Sentry USB's list says per day, for the day cards (no check started).
    pub fn car_files(&self, vid: &str) -> Value {
        self.results.lock().unwrap().get(vid).map(|r| r["carFiles"].clone()).filter(|v| !v.is_null()).unwrap_or(Value::Null)
    }

    /// Raise, update or resolve the car's archive notifications (`st`'s days change only when all of
    /// it went through).
    fn sync(&self, v: &super::ctx::VehicleRef, res: &Analysis, st: &mut Map<String, Value>, files: &Files, now_ms: f64, tz: &str) -> Result<(), String> {
        let open: HashSet<String> = self.ctx.open_notes(&v.id, "archive")?.into_iter().collect();
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
                    self.ctx.resolve_note(&key)?;
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
                if self.ctx.raise_note(&note)? {
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
                    self.ctx.resolve_note(&key)?;
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
        Ok(())
    }

    /// /api/vehicles/:id/archive-gaps
    pub fn route(&self, v: &super::ctx::VehicleRef) -> Value {
        let had = self.results.lock().unwrap().get(&v.id).cloned();
        let out = had.or_else(|| self.check(&v.id)).unwrap_or_else(|| json!({ "days": {}, "stalled": null, "signals": {}, "checkedAt": null }));
        let mut days: Vec<Value> = out["days"].as_object().map(|o| o.values().cloned().collect()).unwrap_or_default();
        days.sort_by(|a, b| js::locale_cmp(b["day"].as_str().unwrap_or(""), a["day"].as_str().unwrap_or("")));
        // Sentry USB's list of what the car wrote, per day (null: the share has none)
        let cf = &out["carFiles"];
        let car_files = if cf.is_object() {
            let ms = |k: &str| if crate::ops::js::truthy(&cf[k]) { num(js::number(Some(&cf[k])) * 1000.0) } else { Value::Null };
            let mut cdays: Vec<Value> = cf["days"].as_object().map(|o| o.values().cloned().collect()).unwrap_or_default();
            cdays.sort_by(|a, b| js::locale_cmp(b["day"].as_str().unwrap_or(""), a["day"].as_str().unwrap_or("")));
            json!({ "present": true, "error": cf["error"], "coveredFrom": ms("coveredFrom"), "coveredTo": ms("coveredTo"), "days": cdays })
        } else {
            Value::Null
        };
        let or = |v: &Value, d: Value| if crate::ops::js::truthy(v) { v.clone() } else { d };
        json!({ "vehicleId": v.id, "timezone": if v.timezone.is_empty() { "UTC" } else { &v.timezone }, "checkedAt": or(&out["checkedAt"], Value::Null), "signals": or(&out["signals"], json!({})), "stalled": or(&out["stalled"], Value::Null),
            "days": days, "carFiles": car_files })
    }
}

#[cfg(test)]
mod tests {
    // test/archiveGap.test.js, without CAN and Sentry USB (with them: lean/parity/archiveGap.js)
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
        let res = analyze(&fs, &Input { now_ms: now, tz: "UTC", speeds, ..Default::default() });
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

    #[test]
    fn a_minute_listed_twice_is_read_as_node_reads_it() {
        let now = js::utc_seconds(2026, 11, 10, 12, 0, 0) * 1000.0;
        let day = "2026-11-10";
        let at = |h: i64, m: i64| format!("{day}_{h:02}-{m:02}-00");
        let arr = now - 6.0 * 3600.0 * 1000.0;
        let cut = format!("TeslaCam/RecentClips/{}-front.mp4", at(6, 0));
        let recent = format!("TeslaCam/RecentClips/{}-front.mp4", at(6, 30));
        let saved = format!("TeslaCam/SavedClips/{}/{}-front.mp4", at(6, 31), at(6, 30));
        // (server/archiveGap.js answers 1 and 29: the copy listed last is the one it reads)
        for (order, minutes) in [([&recent, &saved], 1), ([&saved, &recent], 29)] {
            let list: Vec<(&str, &str, f64)> = [&cut].into_iter().chain(order).map(|r| (r.as_str(), "front", arr)).collect();
            let mut speeds = HashMap::new();
            speeds.insert(cut.clone(), vec![json!(20); 60]);
            speeds.insert(recent.clone(), vec![json!(20); 60]);
            speeds.insert(saved.clone(), [vec![json!(0); 3], vec![json!(20); 57]].concat());
            let res = analyze(&files(&list), &Input { now_ms: now, tz: "UTC", speeds, ..Default::default() });
            assert_eq!(res.days[day]["cutoffs"][0]["minutes"], json!(minutes), "{order:?}");
            assert_eq!(res.days[day]["missingMinutes"], json!(minutes));
        }
    }

    #[test]
    fn notifications_that_cannot_be_read_leave_the_days_as_they_were_never_taken_as_dismissed() {
        let car = crate::viewer::testkit::Car::new("gap-notes");
        let pace = Arc::new(crate::viewer::pace::Pace::fixed(|| false));
        let idx = crate::viewer::speed_index::SpeedIndex::new(car.data.join("speeds"), car.ctx.clone(), pace, 0, crate::viewer::telemetry_api::Limiter::new(|| 1));
        let gap = ArchiveGap::new(car.ctx.clone(), idx);
        let v = car.ctx.vehicles[0].clone();
        let now = crate::footage::js::now();
        let day = day_of_sec(wall_sec(now, "UTC"));
        let key = format!("archive:v1:{day}");
        let mut st = Map::new();
        st.insert("days".into(), json!({ &key: { "day": day, "score": 20, "raised": true, "resolved": false, "dismissed": false, "clips": 3, "sources": ["partial"], "absentSince": null } }));
        car.ctx.notes.lock().unwrap().push(key.clone());
        let res = Analysis { days: BTreeMap::new(), stalled: Value::Null, signals: json!({}), newest_recent: None, received: 0.0, car_files: Value::Null };
        car.ctx.notes_fail.store(true, std::sync::atomic::Ordering::SeqCst);
        let before = st.clone();
        assert!(gap.sync(&v, &res, &mut st, &files(&[]), now, "UTC").is_err());
        assert_eq!(st, before, "the open note is not taken as dismissed");
        car.ctx.notes_fail.store(false, std::sync::atomic::Ordering::SeqCst);
        gap.sync(&v, &res, &mut st, &files(&[]), now, "UTC").unwrap();
        assert_eq!(st["days"][&key]["dismissed"], false, "still open, so still raised");
    }
}
