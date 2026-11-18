//! Drives from the car's own clips (a port of server/drives.js): clips back
//! to back, a gap of more than 5 minutes (by default) starts a new drive;
//! Sentry and Saved events are not drives. Where the speed index has read a
//! clip, its speeds say when the car really moved.

use super::js::{self, num};
use super::speed_index::Stats;
use crate::inventory::Recording;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::sync::Arc;

pub const CLIP_S: f64 = 60.0;
pub const DEFAULT_GAP_S: f64 = 300.0;

/// One minute of the car's own recording.
#[derive(Debug, Clone, Copy)]
pub struct Clip<'a> {
    pub key: &'a str,
    pub t: f64,
    pub day: &'a str,
    pub rel: &'a str,
    pub front: bool,
    pub rec_id: &'a str,
    pub rec_day: &'a str,
}

/// clipsOf: one per minute, oldest first, events left out.
pub fn clips_of(recordings: &[Recording]) -> Vec<Clip<'_>> {
    let mut out: Vec<Clip> = Vec::new();
    let mut at: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for rec in recordings {
        if rec.event_id.is_some() || rec.typ == "SentryClips" || rec.typ == "SavedClips" {
            continue;
        }
        for rel in rec.clip_rels() {
            let name = rel.rsplit('/').next().unwrap_or(rel);
            let Some(i) = js::stamp_at(name) else { continue };
            let key = &name[i..i + 19];
            let front = name.len() >= 10 && name.as_bytes()[name.len() - 10..].eq_ignore_ascii_case(b"-front.mp4");
            match at.get(key) {
                None => {
                    at.insert(key, out.len());
                    out.push(Clip { key, t: js::stamp_seconds(key), day: &key[..10], rel, front, rec_id: &rec.id, rec_day: &rec.day });
                }
                Some(&j) if front && !out[j].front => {
                    let c = &mut out[j];
                    c.rel = rel;
                    c.front = true;
                    c.rec_id = &rec.id;
                    c.rec_day = &rec.day;
                }
                Some(_) => {}
            }
        }
    }
    out.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap());
    out
}

/// When a clip had driving in it: [from, to] wall seconds, or None when it stood still.
pub fn activity_of(c: &Clip, s: Option<&Stats>) -> Option<(f64, f64)> {
    match s {
        None => Some((c.t, c.t + CLIP_S)),
        Some(s) if s.m == 0 || s.f < 0 => None,
        Some(s) => Some((c.t + s.f as f64, c.t + s.l as f64 + 1.0)),
    }
}

pub struct Drive<'a> {
    pub clips: Vec<Clip<'a>>,
    pub from: f64,
    pub to: f64,
}

/// group: drives newest first, `limit` of them, `before` a clip key; (drives, more)
pub fn group<'a>(clips: &[Clip<'a>], stats_for: &mut dyn FnMut(&Clip) -> Option<Stats>, gap_s: f64, limit: usize, before: Option<&str>) -> (Vec<Drive<'a>>, bool) {
    let mut i = clips.len() as i64 - 1;
    if let Some((_, t)) = before.and_then(js::stamp_in) {
        while i >= 0 && clips[i as usize].t >= t {
            i -= 1;
        }
    }
    let mut found: Vec<(usize, usize, f64, f64)> = Vec::new();
    let mut cur: Option<(usize, usize, f64, f64)> = None;
    let mut more = false;
    while i >= 0 {
        let c = &clips[i as usize];
        let st = stats_for(c);
        if let Some(iv) = activity_of(c, st.as_ref()) {
            if let Some(d) = cur {
                if d.2 - iv.1 > gap_s {
                    found.push(d);
                    cur = None;
                    if found.len() >= limit {
                        more = true;
                        break;
                    }
                }
            }
            cur = Some(match cur {
                None => (i as usize, i as usize, iv.0, iv.1),
                Some((hi, _, f, t)) => (hi, i as usize, f.min(iv.0), t.max(iv.1)),
            });
        }
        i -= 1;
    }
    if let Some(d) = cur {
        found.push(d);
    }
    (found.into_iter().map(|(hi, lo, from, to)| Drive { clips: clips[lo..=hi].to_vec(), from, to }).collect(), more)
}

/// A position named: the saved place, else a nearby event's street and town (labeller).
pub type Label = dyn Fn(f64, f64) -> (Value, Value);

pub fn labeller(places: Arc<Vec<Value>>, spots: Vec<(f64, f64, Value, Value)>) -> impl Fn(f64, f64) -> (Value, Value) {
    move |lat, lon| {
        if let Some(p) = super::places::place_of((lat, lon), &places) {
            let n = p.get("name").cloned().unwrap_or(Value::Null);
            return (n.clone(), n);
        }
        let mut best: Option<(usize, f64)> = None;
        for (i, (slat, slon, city, street)) in spots.iter().enumerate() {
            if city.is_null() && street.is_null() {
                continue;
            }
            if (slat - lat).abs() > 0.05 || (slon - lon).abs() > 0.07 {
                continue;
            }
            let m = super::places::metres((lat, lon), (*slat, *slon));
            if m <= 3000.0 && best.map_or(true, |b| m < b.1) {
                best = Some((i, m));
            }
        }
        let Some((i, m)) = best else { return (Value::Null, Value::Null) };
        let (_, _, city, street) = &spots[i];
        if m <= 250.0 && !street.is_null() {
            let label = if city.is_null() { street.clone() } else { json!(format!("{}, {}", street.as_str().unwrap_or(""), city.as_str().unwrap_or(""))) };
            return (Value::Null, label);
        }
        (Value::Null, city.clone())
    }
}

/// { lat, lon, place, label } of a position
pub fn end_of(pos: Option<(f64, f64)>, label: &Label) -> Value {
    match pos {
        None => Value::Null,
        Some((lat, lon)) => {
            let (place, l) = label(lat, lon);
            json!({ "lat": num(lat), "lon": num(lon), "place": place, "label": l })
        }
    }
}

/// describe: a drive for the API
pub fn describe(d: &Drive, stats_of: &dyn Fn(&Clip) -> Option<Stats>, label: &Label) -> Map<String, Value> {
    let first = &d.clips[0];
    let (mut distance, mut moving, mut top, mut brakes, mut swerves, mut read) = (0.0, 0u32, 0.0, 0u32, 0u32, 0u32);
    let (mut a, mut z) = (None, None);
    for c in &d.clips {
        let Some(s) = stats_of(c) else { continue };
        read += 1;
        distance += s.d;
        moving += s.m;
        if s.v > top {
            top = s.v;
        }
        brakes += s.b;
        swerves += s.t;
        if a.is_none() && s.a.is_some() {
            a = s.a;
        }
        if s.z.is_some() {
            z = s.z;
        }
    }
    let start = d.clips.iter().find(|c| c.t + CLIP_S > d.from).unwrap_or(first);
    let second = js::js_round(d.from - start.t).max(0.0);
    let recs: HashSet<&str> = d.clips.iter().map(|c| c.rec_id).filter(|s| !s.is_empty()).collect();
    let r = read > 0;
    let mut m = Map::new();
    m.insert("id".into(), json!(first.key));
    m.insert("date".into(), json!(js::wall(d.from)[..10]));
    m.insert("start".into(), json!(js::wall(d.from)));
    m.insert("end".into(), json!(js::wall(d.to)));
    m.insert("seconds".into(), num(js::js_round(d.to - d.from).max(0.0)));
    m.insert("clips".into(), json!(d.clips.len()));
    m.insert("recordings".into(), json!(recs.len()));
    m.insert("indexed".into(), json!(read));
    m.insert("distance".into(), if r { num(js::js_round(distance)) } else { Value::Null });
    m.insert("moving".into(), if r { json!(moving) } else { Value::Null });
    m.insert("top".into(), if r { num(top) } else { Value::Null });
    m.insert("hardBrakes".into(), if r { json!(brakes) } else { Value::Null });
    m.insert("swerves".into(), if r { json!(swerves) } else { Value::Null });
    m.insert("from".into(), end_of(a, label));
    m.insert("to".into(), end_of(z, label));
    // (no CAN Bridge data here until the CAN area lands)
    m.insert("can".into(), json!(false));
    m.insert("open".into(), json!({ "recording": if start.rec_id.is_empty() { Value::Null } else { json!(start.rec_id) }, "day": if start.rec_day.is_empty() { json!(start.day) } else { json!(start.rec_day) }, "clip": start.key, "second": num(second) }));
    m
}

#[cfg(test)]
mod tests {
    // test/drives.test.js
    use super::*;
    use crate::scanner::FileEntry;

    fn recs(list: &[(&str, &str)]) -> Vec<Recording> {
        // (folder, clip stamp) -> scan files -> recordings
        let mut files: Vec<FileEntry> = Vec::new();
        for (folder, stamp) in list {
            let rel = format!("TeslaCam/{folder}/{stamp}-front.mp4");
            let c = crate::footage::classify(&rel).unwrap();
            files.push(FileEntry { rel, size: 10, mtime_ms: 0.0, ctime_ms: 0.0, birthtime_ms: 0.0, kind: c.kind, typ: c.typ, day: c.day.unwrap_or_else(|| stamp[..10].into()), camera: c.camera, event_id: c.event_id });
        }
        crate::inventory::build_recordings(&std::sync::Arc::new(crate::scanner::FileList::from(files)), "v1")
    }

    fn stamp(day: &str, h: u32, m: u32) -> String {
        format!("{day}_{h:02}-{m:02}-00")
    }

    fn no_label(_: f64, _: f64) -> (Value, Value) {
        (Value::Null, Value::Null)
    }

    #[test]
    fn back_to_back_is_one_drive_a_gap_starts_the_next() {
        let d = "2026-03-01";
        let r = recs(&[("RecentClips", &stamp(d, 8, 0)), ("RecentClips", &stamp(d, 8, 1)), ("RecentClips", &stamp(d, 8, 2)), ("RecentClips", &stamp(d, 8, 9)), ("RecentClips", &stamp(d, 8, 10))]);
        let clips = clips_of(&r);
        assert_eq!(clips.len(), 5);
        let (drives, more) = group(&clips, &mut |_| None, DEFAULT_GAP_S, 50, None);
        assert!(!more);
        assert_eq!(drives.len(), 2);
        let first = describe(&drives[0], &|_| None, &no_label);
        assert_eq!(first["id"], json!("2026-03-01_08-09-00"));
        assert_eq!(first["seconds"], json!(120));
        assert_eq!(first["distance"], Value::Null);
        let second = describe(&drives[1], &|_| None, &no_label);
        assert_eq!((second["start"].clone(), second["end"].clone(), second["clips"].clone()), (json!("2026-03-01 08:00:00"), json!("2026-03-01 08:03:00"), json!(3)));
        // a gap of exactly the limit does not split (08:03 end to 08:08 start is 5 min)
        let r = recs(&[("RecentClips", &stamp(d, 8, 0)), ("RecentClips", &stamp(d, 8, 6))]);
        assert_eq!(group(&clips_of(&r), &mut |_| None, DEFAULT_GAP_S, 50, None).0.len(), 1);
    }

    #[test]
    fn one_clip_a_minute_its_front_where_there_is_one() {
        let d = "2026-03-01";
        let mut files: Vec<FileEntry> = Vec::new();
        for (m, cam) in [(1, "back"), (1, "front"), (0, "left_repeater"), (2, "FRONT"), (2, "back")] {
            let rel = format!("TeslaCam/RecentClips/{}-{cam}.mp4", stamp(d, 8, m));
            let c = crate::footage::classify(&rel).unwrap();
            files.push(FileEntry { rel, size: 10, mtime_ms: 0.0, ctime_ms: 0.0, birthtime_ms: 0.0, kind: c.kind, typ: c.typ, day: d.into(), camera: c.camera, event_id: c.event_id });
        }
        let recs = crate::inventory::build_recordings(&std::sync::Arc::new(crate::scanner::FileList::from(files)), "v1");
        let clips = clips_of(&recs);
        let got: Vec<(&str, f64, bool, &str)> = clips.iter().map(|c| (c.key, c.t, c.front, c.rel.rsplit('/').next().unwrap())).collect();
        let t = |m: i64| js::utc_seconds(2026, 3, 1, 8, m, 0);
        assert_eq!(got, [("2026-03-01_08-00-00", t(0), false, "2026-03-01_08-00-00-left_repeater.mp4"), ("2026-03-01_08-01-00", t(1), true, "2026-03-01_08-01-00-front.mp4"), ("2026-03-01_08-02-00", t(2), true, "2026-03-01_08-02-00-FRONT.mp4")]);
        assert!(clips.iter().all(|c| c.day == d));
    }

    #[test]
    fn events_are_not_drives() {
        let d = "2026-03-01";
        let r = recs(&[("RecentClips", &stamp(d, 8, 0)), ("SentryClips/2026-03-01_08-30-00", &stamp(d, 8, 29)), ("RecentClips", &stamp(d, 9, 0))]);
        let clips = clips_of(&r);
        assert_eq!(clips.len(), 2);
        assert_eq!(group(&clips, &mut |_| None, DEFAULT_GAP_S, 50, None).0.len(), 2);
    }

    #[test]
    fn standing_still_is_not_driving() {
        let d = "2026-03-01";
        let r = recs(&[("RecentClips", &stamp(d, 8, 0)), ("RecentClips", &stamp(d, 8, 1)), ("RecentClips", &stamp(d, 8, 2))]);
        let clips = clips_of(&r);
        let st = |c: &Clip| -> Option<Stats> {
            Some(match &c.key[11..16] {
                "08-00" => Stats { n: 60, d: 300.0, m: 30, v: 15.0, f: 30, l: 59, a: Some((1.0, 2.0)), z: Some((1.1, 2.1)), b: 1, t: 0 },
                "08-01" => Stats { n: 60, d: 0.0, m: 0, v: 0.0, f: -1, l: -1, a: None, z: None, b: 0, t: 0 },
                _ => Stats { n: 60, d: 100.0, m: 10, v: 12.0, f: 0, l: 9, a: Some((1.2, 2.2)), z: Some((1.3, 2.3)), b: 0, t: 1 },
            })
        };
        let (drives, _) = group(&clips, &mut |c| st(c), DEFAULT_GAP_S, 50, None);
        assert_eq!(drives.len(), 1);
        let x = describe(&drives[0], &|c| st(c), &no_label);
        assert_eq!((x["start"].clone(), x["end"].clone()), (json!("2026-03-01 08:00:30"), json!("2026-03-01 08:02:10")));
        assert_eq!((x["distance"].clone(), x["moving"].clone(), x["top"].clone(), x["hardBrakes"].clone(), x["swerves"].clone()), (json!(400), json!(40), json!(15), json!(1), json!(1)));
        assert_eq!(x["open"]["second"], json!(30));
        assert_eq!(x["from"]["lat"], json!(1));
        assert_eq!(x["to"]["lon"], json!(2.3));
    }

    #[test]
    fn a_page_at_a_time() {
        let d = "2026-03-01";
        let r = recs(&[("RecentClips", &stamp(d, 8, 0)), ("RecentClips", &stamp(d, 9, 0)), ("RecentClips", &stamp(d, 10, 0))]);
        let clips = clips_of(&r);
        let (page, more) = group(&clips, &mut |_| None, DEFAULT_GAP_S, 2, None);
        assert_eq!((page.len(), more), (2, true));
        let next = &page[1].clips[0].key;
        let (rest, more) = group(&clips, &mut |_| None, DEFAULT_GAP_S, 2, Some(next));
        assert_eq!((rest.len(), more), (1, false));
        assert_eq!(rest[0].clips[0].key, "2026-03-01_08-00-00");
    }

    #[test]
    fn ends_named_by_a_place_else_a_street_and_town() {
        let places = Arc::new(vec![json!({ "id": "h", "name": "Home", "lat": 41.88, "lon": -87.63 })]);
        let spots = vec![(41.90, -87.65, json!("Chicago"), json!("N Elston Ave")), (41.95, -87.70, json!("Chicago"), Value::Null)];
        let l = labeller(places, spots);
        assert_eq!(l(41.88, -87.63), (json!("Home"), json!("Home")));
        assert_eq!(l(41.9005, -87.65), (Value::Null, json!("N Elston Ave, Chicago")));
        assert_eq!(l(41.91, -87.65), (Value::Null, json!("Chicago")));
        assert_eq!(l(45.0, -80.0), (Value::Null, Value::Null));
    }
}
