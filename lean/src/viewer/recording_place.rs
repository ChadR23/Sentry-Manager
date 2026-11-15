//! Where a recording was, for the Footage page's place tag (a port of
//! server/recordingPlace.js): the car's position at the start and the end of
//! the recording from the cameras' GPS (the speed index: the first indexed
//! front clip's first position, the last one's last), and for Sentry and
//! Saved events Tesla's event.json estimate. A recording is at a place when
//! it starts and ends there; otherwise from and to name where it started and
//! ended. CAN Bridge GPS (the other source in Node) comes with the CAN area:
//! until then no car has CAN keys here, which is the answer Node gives a car
//! without CAN logs.

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
    let mut clips: Vec<Front> = rec.clip_rels.iter().filter_map(|r| front_of(r, files)).collect();
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

/// The place fields of a recording: { place, from?, to?, placeSource? }
pub fn tag(idx: &SpeedIndex, vid: &str, files: Option<&Files>, rec: &Recording, event_pos: Option<(f64, f64)>, places: &[Value]) -> Map<String, Value> {
    let name = |p: Option<(f64, f64)>| p.and_then(|p| super::places::place_of(p, places)).and_then(|x| x.get("name").cloned()).unwrap_or(Value::Null);
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
        out.insert("place".into(), Value::Null);
        return out;
    }
    let (a, z, _) = video_ends(idx, vid, files, rec);
    if a.is_none() || z.is_none() {
        out.insert("place".into(), Value::Null);
        return out;
    }
    let (from, to) = (name(a), name(z));
    let truthy = |v: &Value| !v.is_null() && v != &json!("");
    if truthy(&from) && from == to {
        out.insert("place".into(), from);
        out.insert("placeSource".into(), json!("video"));
        return out;
    }
    if !truthy(&from) && !truthy(&to) {
        out.insert("place".into(), Value::Null);
        return out;
    }
    out.insert("place".into(), Value::Null);
    out.insert("from".into(), from);
    out.insert("to".into(), to);
    out.insert("placeSource".into(), json!("video"));
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
        assert_eq!(Value::Object(tag(&idx, "v1", files.as_ref(), drive, None, &places)), json!({ "place": null, "from": "Home", "to": "Work", "placeSource": "video" }));
        let parked = recs.iter().find(|r| r.start_key.as_deref() == Some("2026-10-01_12-00-00")).unwrap();
        // parked all through: where the car was last seen (Work, 08:01's last position is within reach)
        let t = tag(&idx, "v1", files.as_ref(), parked, None, &places);
        assert_eq!(Value::Object(t), json!({ "place": "Work", "placeSource": "video" }));
        // an event at its event.json position
        let mut ev = drive.clone();
        ev.event_id = Some("2026-10-01_08-00-00".into());
        assert_eq!(Value::Object(tag(&idx, "v1", files.as_ref(), &ev, Some((41.88, -87.63)), &places)), json!({ "place": "Home", "placeSource": "event" }));
        // nowhere saved
        assert_eq!(Value::Object(tag(&idx, "v1", files.as_ref(), drive, None, &[])), json!({ "place": null }));
    }
}
