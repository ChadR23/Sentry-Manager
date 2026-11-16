//! Where a recording was, for the Footage page's place tag (a port of
//! server/recordingPlace.js): the car's position at the start and the end of
//! the recording from the cameras' GPS (the speed index: the first indexed
//! front clip's first position, the last one's last), and for Sentry and
//! Saved events Tesla's event.json estimate; then CAN Bridge GPS (0x04F, only
//! fixes of 15 m or better, from the CAN index's minute files at the
//! recording's first and last minutes, a few minutes inward when those have
//! none) for an end the car gave no position for. A recording is at a place
//! when it starts and ends there; otherwise from and to name where it started
//! and ended.

use super::ctx::Files;
use super::speed_index::{SpeedIndex, Stats};
use crate::inventory::Recording;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

const PARKED_LOOKBACK_S: f64 = 3.0 * 86400.0;

fn good(p: Option<(f64, f64)>) -> Option<(f64, f64)> {
    p.filter(|(lat, lon)| lat.is_finite() && lon.is_finite() && !(*lat == 0.0 && *lon == 0.0) && lat.abs() <= 90.0 && lon.abs() <= 180.0)
}

struct Front {
    rel: String,
    day: String,
    stamp: String,
}

fn front_of(rel: &str, files: Option<&Files>) -> Option<Front> {
    let f = files.and_then(|fs| fs.get(rel));
    let cam = f.and_then(|f| f.camera.clone()).or_else(|| rel.to_lowercase().ends_with("-front.mp4").then(|| "front".to_string()));
    if cam.as_deref() != Some("front") {
        return None;
    }
    let (stamp, _) = super::js::stamp_in(rel.rsplit('/').next().unwrap_or(rel))?;
    let day = f.map(|f| f.day.clone()).filter(|d| !d.is_empty()).unwrap_or_else(|| stamp[..10].to_string());
    Some(Front { rel: rel.to_string(), day, stamp })
}

enum End {
    Pos((f64, f64)),
    Unknown,
    None,
}

struct Reader<'a> {
    idx: &'a SpeedIndex,
    vid: &'a str,
    days: HashMap<String, HashMap<String, Stats>>,
    read: HashMap<String, HashSet<String>>,
}

impl Reader<'_> {
    fn stats(&mut self, c: &Front) -> Option<Stats> {
        if !self.days.contains_key(&c.day) {
            let s = self.idx.clip_stats(self.vid, &c.day);
            self.days.insert(c.day.clone(), s);
        }
        self.days[&c.day].get(&c.rel).cloned()
    }
    fn was_read(&mut self, c: &Front) -> bool {
        if !self.read.contains_key(&c.day) {
            let s = self.idx.clips_read(self.vid, &c.day);
            self.read.insert(c.day.clone(), s);
        }
        self.read[&c.day].contains(&c.rel)
    }
    fn walk<'c>(&mut self, list: impl Iterator<Item = &'c Front>, first: bool) -> End {
        for c in list {
            if let Some(s) = self.stats(c) {
                if let Some(p) = good(if first { s.a } else { s.z }) {
                    return End::Pos(p);
                }
                continue;
            }
            if self.was_read(c) {
                continue;
            }
            return End::Unknown;
        }
        End::None
    }
}

/// videoEnds: (a, z, inferred)
fn video_ends(idx: &SpeedIndex, vid: &str, files: Option<&Files>, rec: &Recording) -> (Option<(f64, f64)>, Option<(f64, f64)>, bool) {
    let mut clips: Vec<Front> = rec.clip_rels().filter_map(|r| front_of(r, files)).collect();
    clips.sort_by(|a, b| super::js::locale_cmp(&a.stamp, &b.stamp));
    if clips.is_empty() {
        return (None, None, false);
    }
    let mut r = Reader { idx, vid, days: HashMap::new(), read: HashMap::new() };
    let a = r.walk(clips.iter(), true);
    let pos = |e: &End| if let End::Pos(p) = e { Some(*p) } else { None };
    match a {
        End::Unknown => (None, None, false),
        End::Pos(p) => {
            let z = r.walk(clips.iter().rev(), false);
            (Some(p), pos(&z), false)
        }
        End::None => {
            let before = last_before(&mut r, files, &clips[0].stamp);
            (before, before, before.is_some())
        }
    }
}

fn stamp_secs(s: &str) -> f64 {
    super::js::stamp_in(s).map_or(f64::NAN, |x| x.1)
}

/// The car's last camera position before a clip stamp (within three days), or None.
fn last_before(r: &mut Reader, files: Option<&Files>, stamp: &str) -> Option<(f64, f64)> {
    let files = files?;
    let mut list: Vec<Front> = files.values().filter_map(|f| front_of(&f.rel, Some(files))).collect();
    list.sort_by(|a, b| super::js::locale_cmp(&a.stamp, &b.stamp));
    let limit = stamp_secs(stamp) - PARKED_LOOKBACK_S;
    let lo = list.partition_point(|c| c.stamp.as_str() < stamp);
    for c in list[..lo].iter().rev() {
        if stamp_secs(&c.stamp) < limit {
            break;
        }
        if let Some(s) = r.stats(c) {
            if let Some(p) = good(s.z) {
                return Some(p);
            }
            continue;
        }
        if r.was_read(c) {
            continue;
        }
        return None;
    }
    None
}

// ---- CAN Bridge GPS

const CAN_FIX_MAX_M: f64 = 15.0;
const CAN_INWARD_MIN: i64 = 5;
const CAN_SLACK_MS: f64 = 30_000.0;
const EVENT_NEAR_MS: f64 = 120_000.0;
const FIXES_KEPT: usize = 20_000;
/// canFootage.js CLIP_MS: a Tesla clip is a minute, a second or two more
const CLIP_MS: f64 = 62_000.0;

/// [UTC ms, lat, lon, accuracy m]
type Fix = (f64, f64, f64, f64);

/// fixesOf: a minute's good fixes by time (signals as point lists, ms into minute t).
pub fn fixes_of(signals: &crate::can::format::Signals, t: f64) -> Vec<Fix> {
    let (Some(lat), Some(lon), Some(acc)) = (signals.get("GPSLatitude04F"), signals.get("GPSLongitude04F"), signals.get("GPSAccuracy04F")) else { return Vec::new() };
    if acc.is_empty() {
        return Vec::new();
    }
    let lon_at: HashMap<u64, f64> = lon.iter().map(|p| (p.0.to_bits(), p.1)).collect();
    let acc_at: HashMap<u64, f64> = acc.iter().map(|p| (p.0.to_bits(), p.1)).collect();
    let mut lon_sorted = lon.clone();
    lon_sorted.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut out = Vec::new();
    for &(ms, la) in lat {
        let lo = lon_at.get(&ms.to_bits()).copied().or_else(|| {
            // the longitude stayed the same: its last point, if within a second and a half before
            let mut held = None;
            for &(m2, v) in &lon_sorted {
                if m2 > ms {
                    break;
                }
                held = (ms - m2 <= 1500.0).then_some(v);
            }
            held
        });
        let ac = acc_at.get(&ms.to_bits()).copied().or_else(|| {
            let mut best: Option<(f64, f64)> = None;
            for &(m2, v) in acc {
                let d = (m2 - ms).abs();
                if d <= 1000.0 && best.is_none_or(|b| d < b.0) {
                    best = Some((d, v));
                }
            }
            best.map(|b| b.1)
        });
        let (Some(lo), Some(ac)) = (lo, ac) else { continue };
        if good(Some((la, lo))).is_none() || !ac.is_finite() || !(0.0..=CAN_FIX_MAX_M).contains(&ac) {
            continue;
        }
        out.push((t + ms, la, lo, ac));
    }
    out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// The CAN index's minute files, their fixes kept while a file does not change.
pub struct CanGps {
    dir: std::path::PathBuf,
    fixes: std::sync::Mutex<indexmap::IndexMap<std::path::PathBuf, (String, std::sync::Arc<Vec<Fix>>)>>,
}

impl CanGps {
    pub fn new(dir: std::path::PathBuf) -> CanGps {
        CanGps { dir, fixes: std::sync::Mutex::new(indexmap::IndexMap::new()) }
    }

    /// minuteFileOf: a key's minute file at t (UTC ms)
    fn file(&self, key: &str, t: f64) -> std::path::PathBuf {
        let name: String = super::js::iso(t)[..16].chars().filter(|c| *c != '-' && *c != ':').collect();
        self.dir.join(key).join(format!("{name}.json.gz"))
    }

    fn minute_fixes(&self, key: &str, t: f64) -> std::sync::Arc<Vec<Fix>> {
        let file = self.file(key, t);
        let Ok(st) = std::fs::metadata(&file) else { return std::sync::Arc::new(Vec::new()) };
        let mtime = st.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        let stamp = format!("{}/{}", st.len(), super::js::js_round(mtime));
        if let Some((s, f)) = self.fixes.lock().unwrap().get(&file) {
            if *s == stamp {
                return f.clone();
            }
        }
        let fixes = std::sync::Arc::new(crate::can::format::read_minute_file(&file).map(|m| fixes_of(&m.signals, t)).unwrap_or_default());
        let mut c = self.fixes.lock().unwrap();
        c.shift_remove(&file);
        c.insert(file, (stamp, fixes.clone()));
        if c.len() > FIXES_KEPT {
            c.shift_remove_index(0);
        }
        fixes
    }

    fn fixes_at(&self, keys: &[String], t: f64) -> Vec<Fix> {
        let mut all: Vec<Fix> = keys.iter().flat_map(|k| self.minute_fixes(k, t).iter().copied().collect::<Vec<_>>()).collect();
        all.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        all
    }

    /// canEnds: CAN GPS at the start and end of [from, to) (UTC ms)
    pub fn ends(&self, keys: &[String], from: f64, to: f64) -> (Option<(f64, f64)>, Option<(f64, f64)>) {
        if keys.is_empty() || !from.is_finite() || !to.is_finite() || to < from {
            return (None, None);
        }
        let first = ((from - CAN_SLACK_MS) / 60_000.0).floor() * 60_000.0;
        let last = ((to + CAN_SLACK_MS) / 60_000.0).floor() * 60_000.0;
        let within = |f: &Fix| f.0 >= from - CAN_SLACK_MS && f.0 <= to + CAN_SLACK_MS;
        let mut a = None;
        let (mut t, mut n) = (first, 0);
        while t <= last && n <= CAN_INWARD_MIN && a.is_none() {
            a = self.fixes_at(keys, t).into_iter().find(within);
            t += 60_000.0;
            n += 1;
        }
        let mut z = None;
        let (mut t, mut n) = (last, 0);
        while t >= first && n <= CAN_INWARD_MIN && z.is_none() {
            z = self.fixes_at(keys, t).into_iter().filter(within).last();
            t -= 60_000.0;
            n += 1;
        }
        (a.map(|f| (f.1, f.2)), z.map(|f| (f.1, f.2)))
    }

    /// canNear: the fix nearest `at` (UTC ms) within two minutes
    pub fn near(&self, keys: &[String], at: f64) -> Option<(f64, f64)> {
        if keys.is_empty() || !at.is_finite() {
            return None;
        }
        let m = (at / 60_000.0).floor() * 60_000.0;
        let mut best: Option<(f64, Fix)> = None;
        for t in [m, m - 60_000.0, m + 60_000.0, m - 120_000.0, m + 120_000.0] {
            for f in self.fixes_at(keys, t) {
                let d = (f.0 - at).abs();
                if d <= EVENT_NEAR_MS && best.is_none_or(|b| d < b.0) {
                    best = Some((d, f));
                }
            }
        }
        best.map(|b| (b.1 .1, b.1 .2))
    }
}

/// canStartOf: a clip stamp ("YYYY-MM-DD_HH-MM-SS" somewhere in it) as UTC ms in the car's zone
pub fn utc_of(stamp: &str, tz: &str) -> f64 {
    let Some((k, _)) = super::js::stamp_in(stamp) else { return f64::NAN };
    let n = |a: usize, z: usize| k[a..z].parse::<u32>().unwrap_or(0);
    crate::footage::tz::zoned_to_utc(n(0, 4) as i32, n(5, 7), n(8, 10), n(11, 13), n(14, 16), n(17, 19), if tz.is_empty() { "UTC" } else { tz })
}

/// The CAN side of a tag: the GPS reader, the car's keys (none when CAN data does not cover the
/// recording) and its time zone.
pub struct CanSide<'a> {
    pub gps: &'a CanGps,
    pub keys: Vec<String>,
    pub tz: &'a str,
}

/// canEndsOf: a recording's CAN ends, from its front clips' first and last stamps
fn can_ends_of(c: &CanSide, files: Option<&Files>, rec: &Recording) -> (Option<(f64, f64)>, Option<(f64, f64)>) {
    let mut fronts: Vec<Front> = rec.clip_rels().filter_map(|r| front_of(r, files)).collect();
    fronts.sort_by(|a, b| super::js::locale_cmp(&a.stamp, &b.stamp));
    let mut stamps: Vec<String> = fronts.into_iter().map(|f| f.stamp).collect();
    if stamps.is_empty() {
        if let Some((k, _)) = rec.start_key.as_deref().and_then(super::js::stamp_in) {
            stamps.push(k);
        }
    }
    if stamps.is_empty() {
        return (None, None);
    }
    let from = utc_of(&stamps[0], c.tz);
    let to = utc_of(&stamps[stamps.len() - 1], c.tz) + CLIP_MS;
    c.gps.ends(&c.keys, from, to)
}

/// stampOf: a display time ("YYYY-MM-DD HH:MM:SS") as a clip stamp
fn stamp_of(display: Option<&str>) -> Option<String> {
    let d = display?;
    let b = d.as_bytes();
    let ok = b.len() == 19 && b[10] == b' ' && b[4] == b'-' && b[7] == b'-' && b[13] == b':' && b[16] == b':' && b.iter().enumerate().all(|(i, c)| [4, 7, 10, 13, 16].contains(&i) || c.is_ascii_digit());
    ok.then(|| d.replace(' ', "_").replace(':', "-"))
}

/// The place fields of a recording: { place, from?, to?, placeSource? }
pub fn tag(idx: &SpeedIndex, vid: &str, files: Option<&Files>, rec: &Recording, event_pos: Option<(f64, f64)>, places: &[Value], can: Option<&CanSide>) -> Map<String, Value> {
    let name = |p: Option<(f64, f64)>| p.and_then(|p| super::places::place_of(p, places)).and_then(|x| x.get("name").cloned()).unwrap_or(Value::Null);
    let keys = can.filter(|c| !c.keys.is_empty());
    let mut out = Map::new();
    if rec.event_id.is_some() {
        if event_pos.is_some() {
            out.insert("place".into(), name(event_pos));
            out.insert("placeSource".into(), json!("event"));
            return out;
        }
        let (_, z, _) = video_ends(idx, vid, files, rec);
        if z.is_some() {
            out.insert("place".into(), name(z));
            out.insert("placeSource".into(), json!("video"));
            return out;
        }
        let at = stamp_of(rec.event_at.as_deref());
        let near = match (keys, at) {
            (Some(c), Some(at)) => c.gps.near(&c.keys, utc_of(&at, c.tz)),
            _ => None,
        };
        out.insert("place".into(), name(near));
        if near.is_some() {
            out.insert("placeSource".into(), json!("can"));
        }
        return out;
    }
    let (mut va, mut vz, inferred) = video_ends(idx, vid, files, rec);
    let (ca, cz) = match keys {
        Some(c) if va.is_none() || vz.is_none() || inferred => can_ends_of(c, files, rec),
        _ => (None, None),
    };
    // where the car was last seen (parked all through, no GPS of its own) yields to a CAN fix at the time
    if inferred && (ca.is_some() || cz.is_some()) {
        va = None;
        vz = None;
    }
    let source = if va.is_some() || vz.is_some() { "video" } else { "can" };
    let (a, z) = (va.or(ca), vz.or(cz));
    if a.is_none() || z.is_none() {
        out.insert("place".into(), Value::Null);
        return out;
    }
    let (from, to) = (name(a), name(z));
    let truthy = |v: &Value| !v.is_null() && v != &json!("");
    if truthy(&from) && from == to {
        out.insert("place".into(), from);
        out.insert("placeSource".into(), json!(source));
        return out;
    }
    if !truthy(&from) && !truthy(&to) {
        out.insert("place".into(), Value::Null);
        return out;
    }
    out.insert("place".into(), Value::Null);
    out.insert("from".into(), from);
    out.insert("to".into(), to);
    out.insert("placeSource".into(), json!(source));
    out
}

#[cfg(test)]
mod tests {
    // test/recordingPlace.test.js, the cameras' GPS
    use super::*;
    use crate::viewer::pace::Pace;
    use crate::viewer::telemetry_api::Limiter;
    use crate::viewer::testkit::{self, Car};
    use std::sync::Arc;

    #[test]
    fn recordings_get_a_place_or_from_and_to() {
        let car = Car::new("recplace");
        // Home -> Work (two clips), then parked at Work with no GPS (one clip of no telemetry)
        testkit::drive(&car.root.join("TeslaCam/RecentClips/2026-10-01_08-00-00-front.mp4"), &[10.0, 10.0], 41.88, -87.63);
        testkit::drive(&car.root.join("TeslaCam/RecentClips/2026-10-01_08-01-00-front.mp4"), &[10.0, 10.0], 41.95, -87.70);
        testkit::clip(&car.root.join("TeslaCam/RecentClips/2026-10-01_12-00-00-front.mp4"), 4, &vec![None; 8], 4);
        car.scan();
        let idx = SpeedIndex::new(car.data.join("speeds"), car.ctx.clone(), Arc::new(Pace::fixed(|| false)), 0, Limiter::new(|| 1));
        idx.kick();
        idx.settled();
        let places = vec![json!({ "id": "h", "name": "Home", "lat": 41.88, "lon": -87.63 }), json!({ "id": "w", "name": "Work", "lat": 41.95, "lon": -87.70 })];
        let recs = car.ctx.recs.lock().unwrap().get("v1").cloned().unwrap();
        let files = car.ctx.files.lock().unwrap().get("v1").cloned();
        let drive = recs.iter().find(|r| r.start_key.as_deref() == Some("2026-10-01_08-00-00")).unwrap();
        assert_eq!(Value::Object(tag(&idx, "v1", files.as_ref(), drive, None, &places, None)), json!({ "place": null, "from": "Home", "to": "Work", "placeSource": "video" }));
        let parked = recs.iter().find(|r| r.start_key.as_deref() == Some("2026-10-01_12-00-00")).unwrap();
        // parked all through: where the car was last seen (Work, 08:01's last position is within reach)
        let t = tag(&idx, "v1", files.as_ref(), parked, None, &places, None);
        assert_eq!(Value::Object(t), json!({ "place": "Work", "placeSource": "video" }));
        // an event at its event.json position
        let mut ev = drive.clone();
        ev.event_id = Some("2026-10-01_08-00-00".into());
        assert_eq!(Value::Object(tag(&idx, "v1", files.as_ref(), &ev, Some((41.88, -87.63)), &places, None)), json!({ "place": "Home", "placeSource": "event" }));
        // nowhere saved
        assert_eq!(Value::Object(tag(&idx, "v1", files.as_ref(), drive, None, &[], None)), json!({ "place": null }));
    }
}
