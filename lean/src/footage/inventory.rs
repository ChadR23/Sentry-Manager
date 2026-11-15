//! Recordings from a scan (a port of server/inventory.js): each Sentry /
//! Saved event folder is one recording; Recent (and other) clips are grouped
//! into drives, a gap of more than 90 s between one-minute clips starting a
//! new one. Day cards summarize them; clip codecs (read from the MP4 headers
//! after each scan) tell encoded recordings from Tesla's originals.

use crate::footage::{self, Kind};
use crate::scanner::FileEntry;
use serde_json::{json, Map, Value};
use std::collections::{BTreeSet, HashMap};

const SESSION_GAP_S: i64 = 90;

pub type Codecs = HashMap<String, Option<String>>;

#[derive(Debug, Clone)]
pub struct Recording {
    pub id: String,
    pub key: String,
    pub vehicle_id: String,
    pub typ: &'static str,
    pub category: &'static str,
    pub folder: String,
    pub event_id: Option<String>,
    pub start_key: Option<String>,
    pub start: Option<String>,
    pub end: Option<String>,
    pub event_at: Option<String>,
    pub day: String,
    /// every file, sorted: (rel, size)
    pub files: Vec<(String, u64)>,
    pub clip_count: usize,
    pub minutes: usize,
    pub clip_rels: Vec<String>,
    pub bytes: u64,
    pub cameras: Vec<String>,
    pub thumb_rel: Option<String>,
    pub front_rel: Option<String>,
    pub protected: bool,
    pub mtime_ms: f64,
}

fn category(typ: &str) -> &'static str {
    match typ {
        "RecentClips" => "Recent",
        "SentryClips" => "Sentry",
        "SavedClips" => "Saved",
        _ => "Other",
    }
}

/// "YYYY-MM-DD HH:MM:SS" of a stamp key.
fn display(key: Option<&str>) -> Option<String> {
    key.map(|k| format!("{} {}", &k[0..10], k[11..].replace('-', ":")))
}

fn hash_id(s: &str) -> String {
    let mut h = sha1_smol::Sha1::new();
    h.update(s.as_bytes());
    h.digest().to_string()[0..16].to_string()
}

fn dirname(rel: &str) -> &str {
    rel.rfind('/').map_or(".", |i| &rel[..i])
}
fn basename(rel: &str) -> &str {
    rel.rfind('/').map_or(rel, |i| &rel[i + 1..])
}

/// A number as JavaScript writes it: integers without ".0".
pub fn num(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9.007_199_254_740_992e15 {
        json!(x as i64)
    } else {
        json!(x)
    }
}

fn finish(out: &mut Vec<Recording>, vehicle: &str, key: String, typ: &'static str, folder: &str, list: &[&FileEntry], start_key: Option<&str>) {
    let clips: Vec<&&FileEntry> = list.iter().filter(|f| f.kind == Kind::Clip).collect();
    let mut stamps: Vec<&str> = clips.iter().filter_map(|f| footage::ts_from(basename(&f.rel))).collect();
    stamps.sort_unstable();
    let mut files: Vec<(String, u64)> = list.iter().map(|f| (f.rel.clone(), f.size)).collect();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let cameras: BTreeSet<String> = clips.iter().filter_map(|f| f.camera.clone()).collect();
    let thumb = list.iter().find(|f| f.rel.to_lowercase().ends_with("/thumb.png"));
    let first = stamps.first().copied().or(start_key);
    let event_id = list[0].event_id.clone();
    out.push(Recording {
        id: hash_id(&format!("{vehicle}|{key}")),
        key,
        vehicle_id: vehicle.to_string(),
        typ,
        category: category(typ),
        folder: folder.to_string(),
        start_key: first.map(String::from),
        start: display(first),
        end: display(stamps.last().copied().or(start_key)),
        event_at: if event_id.is_some() { display(start_key) } else { None },
        event_id,
        day: first.map(|s| s[0..10].to_string()).filter(|d| !d.is_empty()).unwrap_or_else(|| list[0].day.clone()),
        clip_count: clips.len(),
        minutes: stamps.iter().collect::<BTreeSet<_>>().len(),
        clip_rels: clips.iter().map(|f| f.rel.clone()).collect(),
        bytes: list.iter().map(|f| f.size).sum(),
        cameras: cameras.into_iter().collect(),
        thumb_rel: thumb.map(|f| f.rel.clone()),
        front_rel: clips.iter().find(|f| f.camera.as_deref() == Some("front")).or(clips.first()).map(|f| f.rel.clone()),
        protected: false,
        mtime_ms: list.iter().map(|f| f.mtime_ms).fold(f64::NEG_INFINITY, f64::max),
        files,
    });
}

/// Group a scan's files into recordings, newest first (inventory.js buildRecordings).
pub fn build_recordings(files: &[FileEntry], vehicle: &str) -> Vec<Recording> {
    // (folders and files in the order the scan saw them, as Node: scanner.rs node_order)
    let mut events: Vec<(&str, Vec<&FileEntry>)> = Vec::new();
    let mut loose: Vec<(&str, Vec<(&FileEntry, &str)>)> = Vec::new();
    let mut ev_at: HashMap<&str, usize> = HashMap::new();
    let mut lo_at: HashMap<&str, usize> = HashMap::new();
    for f in files {
        let dir = dirname(&f.rel);
        if f.event_id.is_some() && (f.typ == "SentryClips" || f.typ == "SavedClips") {
            let i = *ev_at.entry(dir).or_insert_with(|| {
                events.push((dir, Vec::new()));
                events.len() - 1
            });
            events[i].1.push(f);
        } else if let Some(ts) = footage::ts_from(basename(&f.rel)) {
            let i = *lo_at.entry(dir).or_insert_with(|| {
                loose.push((dir, Vec::new()));
                loose.len() - 1
            });
            loose[i].1.push((f, ts));
        }
    }
    let mut out = Vec::new();
    for (dir, list) in &events {
        finish(&mut out, vehicle, format!("event:{dir}"), list[0].typ, dir, list, footage::ts_from(basename(dir)));
    }
    for (dir, entries) in &mut loose {
        entries.sort_by(|a, b| a.1.cmp(b.1));
        let mut session: Vec<(&FileEntry, &str)> = Vec::new();
        let mut last: Option<i64> = None;
        let flush = |session: &mut Vec<(&FileEntry, &str)>, out: &mut Vec<Recording>| {
            if session.is_empty() {
                return;
            }
            let list: Vec<&FileEntry> = session.iter().map(|e| e.0).collect();
            finish(out, vehicle, format!("session:{dir}:{}", session[0].1), session[0].0.typ, dir, &list, Some(session[0].1));
            session.clear();
        };
        for e in entries.iter() {
            let t = footage::key_seconds(e.1);
            if last.is_some_and(|l| t - l > SESSION_GAP_S) {
                flush(&mut session, &mut out);
            }
            session.push(*e);
            last = Some(t);
        }
        flush(&mut session, &mut out);
    }
    out.sort_by(|a, b| b.start_key.as_deref().unwrap_or("null").cmp(a.start_key.as_deref().unwrap_or("null")));
    out
}

pub struct Encoded {
    pub clips: usize,
    pub encoded: usize,
    pub unknown: usize,
    pub codecs: Vec<String>,
}

pub fn encoded_of(rec: &Recording, codecs: &Codecs) -> Encoded {
    let mut e = Encoded { clips: rec.clip_rels.len(), encoded: 0, unknown: 0, codecs: Vec::new() };
    let mut seen = BTreeSet::new();
    for rel in &rec.clip_rels {
        match codecs.get(rel) {
            None => e.unknown += 1,
            Some(Some(c)) if c == "h265" || c == "av1" => {
                e.encoded += 1;
                seen.insert(c.clone());
            }
            _ => {}
        }
    }
    e.codecs = seen.into_iter().collect();
    e
}

impl Encoded {
    pub fn json(&self) -> Value {
        json!({ "clips": self.clips, "encoded": self.encoded, "unknown": self.unknown, "codecs": self.codecs })
    }
}

/// A recording as the API shows it (index.js publicRecording): no file lists.
pub fn public(rec: &Recording, codecs: &Codecs) -> Map<String, Value> {
    let v = json!({
        "id": rec.id, "key": rec.key, "vehicleId": rec.vehicle_id, "type": rec.typ, "category": rec.category,
        "folder": rec.folder, "eventId": rec.event_id, "startKey": rec.start_key, "start": rec.start, "end": rec.end,
        "eventAt": rec.event_at, "day": rec.day, "fileCount": rec.files.len(), "clipCount": rec.clip_count,
        "minutes": rec.minutes, "bytes": rec.bytes, "cameras": rec.cameras, "thumbRel": rec.thumb_rel,
        "frontRel": rec.front_rel, "protected": rec.protected, "mtimeMs": num(rec.mtime_ms),
        "encoded": encoded_of(rec, codecs).json()
    });
    match v {
        Value::Object(m) => m,
        _ => unreachable!(),
    }
}

/// One card per day, newest first (inventory.js summarizeDays).
pub fn summarize_days(recs: &[&Recording], codecs: &Codecs) -> Vec<Map<String, Value>> {
    struct Day<'a> {
        day: String,
        recordings: usize,
        by: Map<String, Value>,
        bytes: u64,
        minutes: usize,
        clips: usize,
        encoded: usize,
        encoded_recordings: usize,
        unknown: usize,
        codecs: BTreeSet<String>,
        cameras: usize,
        protected: usize,
        list: Vec<&'a Recording>,
    }
    let mut days: Vec<Day> = Vec::new();
    let mut at: HashMap<&str, usize> = HashMap::new();
    for rec in recs {
        let i = *at.entry(rec.day.as_str()).or_insert_with(|| {
            days.push(Day { day: rec.day.clone(), recordings: 0, by: Map::new(), bytes: 0, minutes: 0, clips: 0, encoded: 0, encoded_recordings: 0, unknown: 0, codecs: BTreeSet::new(), cameras: 0, protected: 0, list: Vec::new() });
            days.len() - 1
        });
        let d = &mut days[i];
        let enc = encoded_of(rec, codecs);
        d.recordings += 1;
        let n = d.by.get(rec.category).and_then(Value::as_u64).unwrap_or(0);
        d.by.insert(rec.category.into(), json!(n + 1));
        d.bytes += rec.bytes;
        d.minutes += rec.minutes;
        d.clips += enc.clips;
        d.encoded += enc.encoded;
        if enc.clips > 0 && enc.encoded == enc.clips {
            d.encoded_recordings += 1;
        }
        d.unknown += enc.unknown;
        d.codecs.extend(enc.codecs);
        d.cameras = d.cameras.max(rec.cameras.len());
        if rec.protected {
            d.protected += 1;
        }
        d.list.push(rec);
    }
    days.sort_by(|a, b| b.day.cmp(&a.day));
    days.into_iter()
        .map(|d| {
            let mut by_time = d.list.clone();
            by_time.sort_by(|a, b| a.start_key.as_deref().unwrap_or("null").cmp(b.start_key.as_deref().unwrap_or("null")));
            let thumb = by_time.iter().find(|r| r.category == "Sentry" || r.category == "Saved").or(by_time.first());
            let v = json!({
                "day": d.day, "recordings": d.recordings, "byCategory": d.by, "bytes": d.bytes, "minutes": d.minutes,
                "clips": d.clips, "encoded": d.encoded, "encodedRecordings": d.encoded_recordings, "unknown": d.unknown,
                "cameras": d.cameras, "protected": d.protected, "codecs": d.codecs.into_iter().collect::<Vec<_>>(),
                "thumbId": thumb.map(|r| r.id.clone())
            });
            match v {
                Value::Object(m) => m,
                _ => unreachable!(),
            }
        })
        .collect()
}

/// The days with any recording, oldest first.
pub fn footage_days(recs: &[Recording]) -> Vec<String> {
    recs.iter().map(|r| r.day.clone()).filter(|d| !d.is_empty()).collect::<BTreeSet<_>>().into_iter().collect()
}

/// inventory.js totals
pub fn totals(recs: &[Recording], files: usize, scanned_at: f64) -> Value {
    let mut by = Map::new();
    for r in recs {
        let e = by.entry(r.category).or_insert_with(|| json!({ "recordings": 0, "bytes": 0 }));
        e["recordings"] = json!(e["recordings"].as_u64().unwrap() + 1);
        e["bytes"] = json!(e["bytes"].as_u64().unwrap() + r.bytes);
    }
    let days = footage_days(recs);
    json!({
        "recordings": recs.len(), "days": days.len(), "firstDay": days.first(), "lastDay": days.last(),
        "files": files, "bytes": recs.iter().map(|r| r.bytes).sum::<u64>(),
        "minutes": recs.iter().map(|r| r.minutes).sum::<usize>(), "byCategory": by, "scannedAt": num(scanned_at)
    })
}

/// String(value).slice(0, 200), as JavaScript would write the value.
fn js_string(v: &Value) -> String {
    let s = match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.as_f64().map(|x| if x.fract() == 0.0 && x.abs() < 1e21 { format!("{}", x as i128) } else { format!("{x}") }).unwrap_or_default(),
        Value::Bool(b) => b.to_string(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        Value::Null => "null".into(),
    };
    // (200 UTF-16 units)
    let mut units = 0;
    s.chars().take_while(|c| {
        units += c.len_utf16();
        units <= 200
    }).collect()
}

/// The fields the UI shows from a parsed event.json (inventory.js eventInfo).
pub fn event_pick(data: &Value) -> Option<Map<String, Value>> {
    if data.is_null() {
        return None;
    }
    let mut pick = Map::new();
    if let Value::Object(o) = data {
        for k in ["timestamp", "city", "street", "est_lat", "est_lon", "reason", "camera"] {
            if let Some(v) = o.get(k).filter(|v| !v.is_null()) {
                pick.insert(k.into(), json!(js_string(v)));
            }
        }
    }
    Some(pick)
}

/// A recording is protected when any of its files is (inventory.js buildRecordings protectedRels).
pub fn mark_protected(recs: &mut [Recording], protected: &std::collections::HashSet<String>) {
    for r in recs {
        r.protected = !protected.is_empty() && r.files.iter().any(|(rel, _)| protected.contains(rel));
    }
}

/// inventory.js arrivedClips: the clips that reached the share since `since_ms` (their birth
/// time, else ctime): (sentry, dashcam).
pub fn arrived_clips(files: &[FileEntry], since_ms: f64) -> (usize, usize) {
    let (mut sentry, mut dashcam) = (0, 0);
    for f in files.iter().filter(|f| f.kind == Kind::Clip) {
        let at = if f.birthtime_ms > 0.0 { f.birthtime_ms } else { f.ctime_ms };
        if !(at >= since_ms) {
            continue;
        }
        if f.typ == "SentryClips" { sentry += 1 } else { dashcam += 1 }
    }
    (sentry, dashcam)
}
