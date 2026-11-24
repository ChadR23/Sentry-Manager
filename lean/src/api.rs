//! The first slice's routes, field for field as server/index.js answers
//! them: a vehicle's days, its recordings, one recording and its thumbnail,
//! and /api/media (src/wire puts them in core's router). Also the
//! percent-decoding every area uses.

use crate::app::{App, Vehicle};
use crate::inventory::{self, num, Recording};
use crate::media;
use axum::body::Body;
use axum::http::{header, HeaderMap, Method, Response, StatusCode};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

type Res = Response<Body>;

pub fn json_response(status: StatusCode, v: &Value) -> Res {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(Body::from(v.to_string()))
        .unwrap()
}

fn error(status: StatusCode, msg: &str) -> Res {
    json_response(status, &json!({ "error": msg }))
}

fn ok(v: Value) -> Res {
    json_response(StatusCode::OK, &v)
}

fn hex(b: u8) -> Option<u8> {
    (b as char).to_digit(16).map(|d| d as u8)
}

/// Percent-decoding. `query`: as URLSearchParams (+ is a space, a bad escape stays as it is,
/// bad UTF-8 is replaced); else as decodeURIComponent (either is refused).
pub fn decode(s: &str, query: bool) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' => {
                if i + 2 < b.len() {
                    if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                        out.push(h * 16 + l);
                        i += 3;
                        continue;
                    }
                }
                if !query {
                    return None;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' if query => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    if query { Some(String::from_utf8_lossy(&out).into_owned()) } else { String::from_utf8(out).ok() }
}

/// JavaScript's Number(string): NaN as None.
fn js_number(s: Option<&String>) -> Option<f64> {
    let t = s.map_or("", |s| s.trim());
    if t.is_empty() {
        return Some(0.0);
    }
    match t {
        "Infinity" | "+Infinity" => return Some(f64::INFINITY),
        "-Infinity" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    for (p, r) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(d) = t.strip_prefix(p) {
            return u64::from_str_radix(d, r).ok().map(|n| n as f64);
        }
    }
    if !t.bytes().all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-')) {
        return None;
    }
    t.parse::<f64>().ok()
}

/// list.slice(start, end) with JavaScript's conversions (start, end >= 0 here).
fn slice<T: Clone>(list: &[T], start: f64, end: f64) -> Vec<T> {
    let clamp = |x: f64| if x.is_nan() { 0 } else { x.trunc().clamp(0.0, list.len() as f64) as usize };
    let (s, e) = (clamp(start), clamp(end));
    if s >= e { Vec::new() } else { list[s..e].to_vec() }
}

fn valid_day(s: Option<&String>) -> Option<&str> {
    s.map(String::as_str).filter(|d| crate::footage::is_day_shape(d))
}

/// index.js filtered: category, then date, else from / to.
fn filtered<'a>(recs: &'a [Recording], q: &HashMap<String, String>) -> Vec<&'a Recording> {
    let mut list: Vec<&Recording> = recs.iter().collect();
    if let Some(c) = q.get("category").filter(|c| !c.is_empty() && *c != "all") {
        list.retain(|r| r.category == c);
    }
    if let Some(d) = q.get("date").filter(|d| !d.is_empty()) {
        list.retain(|r| &r.day == d);
    } else {
        if let Some(f) = valid_day(q.get("from")) {
            list.retain(|r| r.day.as_str() >= f);
        }
        if let Some(t) = valid_day(q.get("to")) {
            list.retain(|r| r.day.as_str() <= t);
        }
    }
    list
}

fn paging(q: &HashMap<String, String>, max: f64, default: f64) -> (f64, f64) {
    let or = |x: Option<f64>, d: f64| x.filter(|v| !v.is_nan() && *v != 0.0).unwrap_or(d);
    let offset = or(js_number(q.get("offset")), 0.0).max(0.0);
    let limit = or(js_number(q.get("limit")), default).max(1.0).min(max);
    (offset, limit)
}

fn dates(recs: &[Recording]) -> Vec<String> {
    let mut d: Vec<String> = recs.iter().map(|r| r.day.clone()).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
    d.reverse();
    d
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// path.join(root, rel)
fn join(root: &Path, rel: &str) -> String {
    if rel == "." || rel.is_empty() {
        return path_str(root);
    }
    path_str(&root.join(rel))
}

/// What a page needs could not be read (manager.db): logged as "METHOD path: error", answered 500.
fn failed(app: &App, what: &str, e: &str) -> Res {
    app.core.log("server", crate::footage::ctx::Level::Error, &format!("{what}: {e}"));
    error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
}

fn state_fields(st: Option<&crate::app::VehicleState>, out: &mut Map<String, Value>) {
    out.insert("scannedAt".into(), st.and_then(|s| s.scanned_at).filter(|t| *t != 0.0).map_or(Value::Null, num));
    out.insert("scanning".into(), json!(st.is_some_and(|s| s.scanning)));
    out.insert("error".into(), json!(st.and_then(|s| s.last_error.clone())));
}

/// One page of day summaries (newest day first) with how many days and recordings there are in
/// all. Only the page's days are summed up: a day's summary is of its own recordings.
fn day_page(list: &[&Recording], codecs: &inventory::Codecs, start: f64, end: f64) -> (Vec<Map<String, Value>>, usize, usize) {
    let days: Vec<&str> = list.iter().map(|r| r.day.as_str()).collect::<std::collections::BTreeSet<_>>().into_iter().rev().collect();
    let page: std::collections::HashSet<&str> = slice(&days, start, end).into_iter().collect();
    let on_page: Vec<&Recording> = list.iter().copied().filter(|r| page.contains(r.day.as_str())).collect();
    (inventory::summarize_days(&on_page, codecs), days.len(), list.len())
}

fn days(app: &App, v: &Vehicle, q: &HashMap<String, String>) -> Res {
    let st = app.state_of(&v.id);
    let empty = Arc::new(Vec::new());
    let recs = st.as_ref().map_or(empty, |s| s.recordings.clone());
    let codecs = st.as_ref().map(|s| s.codecs.clone()).unwrap_or_default();
    let list = filtered(&recs, q);
    let (offset, limit) = paging(q, 100.0, 30.0);
    let (mut shown, total, recordings) = day_page(&list, &codecs, offset, offset + limit);
    let wanted: Vec<String> = shown.iter().map(|d| d["day"].as_str().unwrap_or("").to_string()).collect();
    let idx = crate::viewer::get().map(|viewer| viewer.speed_index.progress(&v.id, &wanted)).unwrap_or_default();
    let gaps = crate::viewer::get().map(|viewer| viewer.archive.for_days(&v.id)).unwrap_or_default();
    let car_files = crate::viewer::get().map(|viewer| viewer.archive.car_files(&v.id)).unwrap_or(Value::Null);
    // how many of each day's recordings have CAN Bridge data (the green "CAN" tag)
    let has_can = match app.core.has_can(&v.id) {
        Ok(h) => h,
        Err(e) => return failed(app, &format!("GET /api/vehicles/{}/days", v.id), &e.message),
    };
    let mut can_days: HashMap<&str, u64> = HashMap::new();
    if let Some(f) = &has_can {
        for r in &list {
            if wanted.iter().any(|d| *d == r.day) && f(r) {
                *can_days.entry(r.day.as_str()).or_insert(0) += 1;
            }
        }
    }
    for d in &mut shown {
        let (clips, indexed) = idx.get(d["day"].as_str().unwrap_or("")).copied().unwrap_or((0, 0));
        d.insert("speedIndex".into(), json!({ "clips": clips, "indexed": indexed }));
        // footage that looks only partly copied to the share yet (the "Partly archived?" tag), and
        // what Sentry USB's list says the car wrote that day, beside the share's own counts
        let day = d["day"].as_str().unwrap_or("").to_string();
        d.insert("archive".into(), gaps.get(&day).cloned().unwrap_or(Value::Null));
        d.insert("carFiles".into(), car_files["days"].get(&day).cloned().unwrap_or(Value::Null));
        if has_can.is_some() {
            let n = can_days.get(d["day"].as_str().unwrap_or("")).copied().unwrap_or(0);
            d.insert("canRecordings".into(), json!(n));
        }
    }
    let mut out = Map::new();
    // Sentry USB's status file on this share (as GET /api/vehicles/:id/sentry-usb)
    out.insert("sentryUsb".into(), app.core.sentry_usb(&v.id));
    out.insert("total".into(), json!(total));
    out.insert("recordings".into(), json!(recordings));
    out.insert("offset".into(), num(offset));
    out.insert("limit".into(), num(limit));
    state_fields(st.as_ref(), &mut out);
    out.insert("dates".into(), json!(dates(&recs)));
    out.insert("days".into(), json!(shown));
    ok(Value::Object(out))
}

fn recordings(app: &App, v: &Vehicle, q: &HashMap<String, String>) -> Res {
    let st = app.state_of(&v.id);
    let empty = Arc::new(Vec::new());
    let recs = st.as_ref().map_or(empty, |s| s.recordings.clone());
    let codecs = st.as_ref().map(|s| s.codecs.clone()).unwrap_or_default();
    let mut list = filtered(&recs, q);
    if q.get("protected").is_some_and(|p| p == "1") {
        list.retain(|r| r.protected);
    }
    let (offset, limit) = paging(q, 500.0, 100.0);
    let page = slice(&list, offset, offset + limit);
    let mut out = Map::new();
    out.insert("total".into(), json!(list.len()));
    out.insert("offset".into(), num(offset));
    out.insert("limit".into(), num(limit));
    state_fields(st.as_ref(), &mut out);
    out.insert("dates".into(), json!(dates(&recs)));
    let mut tagged: Vec<Map<String, Value>> = page.iter().map(|r| inventory::public(r, &codecs)).collect();
    let has_can = match app.core.has_can(&v.id) {
        Ok(h) => h,
        Err(e) => return failed(app, &format!("GET /api/vehicles/{}/recordings", v.id), &e.message),
    };
    if let Some(has_can) = has_can {
        for (t, r) in tagged.iter_mut().zip(page.iter()) {
            if has_can(r) {
                t.insert("can".into(), json!(true));
            }
        }
    }
    if let Some(viewer) = crate::viewer::get() {
        match viewer.place_tags(&v.id, &page) {
            Ok(Some(tags)) => {
                for (t, extra) in tagged.iter_mut().zip(tags) {
                    t.extend(extra);
                }
            }
            Ok(None) => {}
            // (saved places that cannot be read: not a page without them, as Node throws)
            Err(e) => return failed(app, &format!("GET /api/vehicles/{}/recordings", v.id), &e),
        }
    }
    out.insert("recordings".into(), Value::Array(tagged.into_iter().map(Value::Object).collect()));
    ok(Value::Object(out))
}

const EVENT_JSON_MAX: u64 = 64 * 1024;
const EVENT_JSON_KEPT: usize = 512;

/// event.json files read lately, by path, with the file they were then (device, inode, size, mtime, ctime)
#[derive(Default)]
struct EventJsonCache {
    tick: u64,
    kept: HashMap<PathBuf, (FileStamp, u64, Value)>,
}

impl EventJsonCache {
    fn get(&mut self, path: &Path, stamp: &FileStamp) -> Option<Value> {
        self.tick += 1;
        let tick = self.tick;
        let (was, used, info) = self.kept.get_mut(path)?;
        if was != stamp {
            return None;
        }
        *used = tick;
        Some(info.clone())
    }

    fn keep(&mut self, path: PathBuf, stamp: FileStamp, info: Value) {
        if self.kept.len() >= EVENT_JSON_KEPT && !self.kept.contains_key(&path) {
            if let Some(oldest) = self.kept.iter().min_by_key(|(_, (_, used, _))| *used).map(|(p, _)| p.clone()) {
                self.kept.remove(&oldest);
            }
        }
        self.tick += 1;
        self.kept.insert(path, (stamp, self.tick, info));
    }
}

static EVENT_JSON: std::sync::LazyLock<std::sync::Mutex<EventJsonCache>> = std::sync::LazyLock::new(Default::default);

type FileStamp = (u64, u64, u64, i64, i64, i64, i64);

fn file_stamp(md: &std::fs::Metadata) -> FileStamp {
    use std::os::unix::fs::MetadataExt;
    (md.dev(), md.ino(), md.len(), md.mtime(), md.mtime_nsec(), md.ctime(), md.ctime_nsec())
}

/// A local disk, where a file's stamp is the kernel's own (not a network or FUSE mount's cached copy)
fn local_disk(file: &std::fs::File) -> bool {
    use std::os::fd::AsRawFd;
    let mut st: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatfs(file.as_raw_fd(), &mut st) } != 0 {
        return false;
    }
    // ext2/3/4, xfs, btrfs, f2fs, fat, exfat, ntfs3, zfs, tmpfs
    matches!(st.f_type as u32, 0xEF53 | 0x5846_5342 | 0x9123_683E | 0xF2F5_2010 | 0x4D44 | 0x2011_BAB0 | 0x7366_746E | 0x2FC1_2FC1 | 0x0102_1994)
}

/// Unchanged for the last few seconds, so a write still to come cannot keep its stamp
fn settled(md: &std::fs::Metadata, now: std::time::SystemTime) -> bool {
    use std::os::unix::fs::MetadataExt;
    now.duration_since(std::time::UNIX_EPOCH).is_ok_and(|d| md.ctime() <= d.as_secs() as i64 - 3)
}

/// event.json of a Sentry / Saved event, when present and small (inventory.js eventInfo).
pub(crate) fn event_info(v: &Vehicle, rec: &Recording) -> Value {
    event_info_at(v, rec, std::time::SystemTime::now())
}

fn event_info_at(v: &Vehicle, rec: &Recording, now: std::time::SystemTime) -> Value {
    use std::io::Read;
    if rec.event_id.is_none() {
        return Value::Null;
    }
    let Some(rel) = rec.event_json() else { return Value::Null };
    let abs = v.root.join(rel);
    let Ok(file) = std::fs::File::open(&abs) else { return Value::Null };
    let Ok(md) = file.metadata() else { return Value::Null };
    if md.len() > EVENT_JSON_MAX {
        return Value::Null;
    }
    let stamp = (settled(&md, now) && local_disk(&file)).then(|| file_stamp(&md));
    if let Some(info) = stamp.as_ref().and_then(|s| EVENT_JSON.lock().unwrap().get(&abs, s)) {
        return info;
    }
    let mut text = String::new();
    if (&file).take(EVENT_JSON_MAX + 1).read_to_string(&mut text).is_err() || text.len() as u64 > EVENT_JSON_MAX {
        return Value::Null;
    }
    let info = match serde_json::from_str::<Value>(&text) {
        Ok(data) => inventory::event_pick(&data).map_or(Value::Null, Value::Object),
        Err(_) => Value::Null,
    };
    if let Some(stamp) = stamp {
        EVENT_JSON.lock().unwrap().keep(abs, stamp, info.clone());
    }
    info
}

fn recording(app: &App, v: &Vehicle, rid: &str) -> Res {
    let st = app.state_of(&v.id);
    let Some(st) = st else { return error(StatusCode::NOT_FOUND, "Recording not found (it may have moved; refresh the inventory).") };
    let Some(rec) = st.recordings.iter().find(|r| r.id == rid) else {
        return error(StatusCode::NOT_FOUND, "Recording not found (it may have moved; refresh the inventory).");
    };
    let mut out = inventory::public(rec, &st.codecs);
    let files: Vec<Value> = rec
        .files()
        .map(|(rel, size)| {
            let mut f = json!({ "rel": rel, "path": join(&v.root, rel), "size": size });
            if rel.to_lowercase().ends_with(".mp4") {
                f["codec"] = json!(st.codecs.get(rel).flatten());
            }
            f
        })
        .collect();
    out.insert("root".into(), json!(path_str(&v.root)));
    out.insert("folderPath".into(), json!(join(&v.root, &rec.folder)));
    out.insert("files".into(), json!(files));
    out.insert("event".into(), event_info(v, rec));
    ok(Value::Object(out))
}

fn roots(app: &App) -> Vec<PathBuf> {
    app.vehicles.list().into_iter().map(|v| v.root).collect()
}

fn media(app: &App, method: &Method, headers: &HeaderMap, q: &HashMap<String, String>) -> Res {
    let p = q.get("path").cloned().unwrap_or_default();
    let roots = roots(app);
    match media::resolve_inside(&p, &roots) {
        // footage playing (bytes of a clip sent, not a HEAD or a refusal): background reading
        // slows to one clip at a time while they go out, and for a while after
        Some(real) if !media::hidden_path(&path_str(&real)) => media::send_media_held(method, headers, &real, &roots, || {
            (method == Method::GET).then(|| crate::viewer::get().map(|viewer| viewer.watching())).flatten()
        }),
        _ => error(StatusCode::FORBIDDEN, "Outside the vehicle shares."),
    }
}

fn thumbnail(app: &App, v: &Vehicle, rid: &str, method: &Method, headers: &HeaderMap) -> Res {
    let st = app.state_of(&v.id);
    let rec = st.as_ref().and_then(|s| s.recordings.iter().find(|r| r.id == rid));
    let Some(rec) = rec else { return error(StatusCode::NOT_FOUND, "Not found") };
    // Tesla's own thumb.png, else one frame of the front clip (thumbnails.rs, with ffmpeg)
    let Some(source) = rec.thumb_rel.as_ref().or(rec.front_rel.as_ref()) else { return error(StatusCode::NOT_FOUND, "No thumbnail") };
    let roots = roots(app);
    let Some(real) = media::resolve_inside(&join(&v.root, source), &roots) else { return error(StatusCode::NOT_FOUND, "No thumbnail") };
    if rec.thumb_rel.is_some() {
        return media::send_media(method, headers, &real, &roots);
    }
    match app.thumbnails.for_clip(&real) {
        Ok(Some(file)) => media::send_media(method, headers, &file, std::slice::from_ref(&app.thumbnails.dir)),
        Ok(None) => error(StatusCode::NOT_FOUND, "No thumbnail"),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error"),
    }
}

/// The first slice's routes core sends here: a vehicle's days, recordings, one recording and
/// its thumbnail (`raw_path`: as sent; each part is decoded as the router decodes params).
/// None for any other path.
pub fn slice_route(app: &Arc<App>, method: &Method, raw_path: &str, q: &HashMap<String, String>, headers: &HeaderMap) -> Option<Res> {
    if method != Method::GET && method != Method::HEAD {
        return None;
    }
    let parts: Vec<String> = raw_path.trim_start_matches("/api/").split('/').map(|s| decode(s, false)).collect::<Option<_>>()?;
    let seg: Vec<&str> = parts.iter().map(String::as_str).collect();
    let ["vehicles", id, rest @ ..] = seg.as_slice() else { return None };
    if !matches!(rest, ["days"] | ["recordings"] | ["recordings", _] | ["recordings", _, "thumbnail"]) {
        return None;
    }
    let v = match app.vehicles.try_get(id) {
        Ok(Some(v)) => v,
        Ok(None) => return Some(error(StatusCode::NOT_FOUND, "No such vehicle.")),
        // (the vehicles cannot be read: not "no such vehicle")
        Err(e) => return Some(failed(app, &format!("GET {raw_path}"), &e.to_string())),
    };
    Some(match rest {
        ["days"] => days(app, &v, q),
        ["recordings"] => recordings(app, &v, q),
        ["recordings", rid] => recording(app, &v, rid),
        ["recordings", rid, "thumbnail"] => thumbnail(app, &v, rid, method, headers),
        _ => return None,
    })
}

/// /api/media: a clip's bytes with Range support, inside a vehicle's folder only.
pub fn media_route(app: &App, method: &Method, headers: &HeaderMap, q: &HashMap<String, String>) -> Res {
    media(app, method, headers, q)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scanner::{FileEntry, FileList};

    fn event_recording(root: &Path) -> (Vec<Recording>, PathBuf) {
        let _ = std::fs::remove_dir_all(root);
        let dir = "TeslaCam/SavedClips/2026-11-10_06-00-00";
        std::fs::create_dir_all(root.join(dir)).unwrap();
        let clip = format!("{dir}/2026-11-10_05-59-00-front.mp4");
        std::fs::write(root.join(&clip), b"x").unwrap();
        let ev = root.join(dir).join("event.json");
        std::fs::write(&ev, r#"{"reason":"aaaa"}"#).unwrap();
        let files: Vec<FileEntry> = [clip, format!("{dir}/event.json")]
            .into_iter()
            .map(|rel| {
                let c = crate::footage::classify(&rel).unwrap();
                FileEntry { rel, size: 1, mtime_ms: 0.0, ctime_ms: 0.0, birthtime_ms: 0.0, kind: c.kind, typ: c.typ, day: "2026-11-10".into(), camera: c.camera, event_id: c.event_id }
            })
            .collect();
        (inventory::build_recordings(&Arc::new(FileList::from(files)), "v1"), ev)
    }

    fn kept(path: &Path) -> bool {
        EVENT_JSON.lock().unwrap().kept.contains_key(path)
    }

    #[test]
    fn an_event_json_rewritten_or_replaced_with_the_same_size_and_time_is_read_again() {
        let root = std::env::temp_dir().join(format!("lean-event-json-{}", std::process::id()));
        let (recs, ev) = event_recording(&root);
        let rec = recs.iter().find(|r| r.event_id.is_some()).unwrap();
        let v = crate::footage::vehicles::folder_vehicle("v1", "Car", "UTC", root.clone());
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(10);
        let when = std::fs::metadata(&ev).unwrap().modified().unwrap();
        assert_eq!(event_info_at(&v, rec, later)["reason"], json!("aaaa"));
        assert!(kept(&ev), "a settled file on a local disk is kept");
        assert_eq!(event_info_at(&v, rec, later)["reason"], json!("aaaa"));
        std::fs::write(&ev, r#"{"reason":"bbbb"}"#).unwrap();
        std::fs::File::options().write(true).open(&ev).unwrap().set_modified(when).unwrap();
        assert_eq!(event_info_at(&v, rec, later)["reason"], json!("bbbb"), "rewritten in place");
        let next = ev.with_file_name("event.json.new");
        std::fs::write(&next, r#"{"reason":"cccc"}"#).unwrap();
        std::fs::File::options().write(true).open(&next).unwrap().set_modified(when).unwrap();
        std::fs::rename(&next, &ev).unwrap();
        assert_eq!(event_info_at(&v, rec, later)["reason"], json!("cccc"), "replaced by another file");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_event_json_changed_in_the_last_seconds_is_read_every_time() {
        let root = std::env::temp_dir().join(format!("lean-event-json-fresh-{}", std::process::id()));
        let (recs, ev) = event_recording(&root);
        let rec = recs.iter().find(|r| r.event_id.is_some()).unwrap();
        let v = crate::footage::vehicles::folder_vehicle("v1", "Car", "UTC", root.clone());
        assert_eq!(event_info(&v, rec)["reason"], json!("aaaa"));
        assert!(!kept(&ev));
        std::fs::write(&ev, &[b' '; 70 * 1024]).unwrap();
        assert_eq!(event_info(&v, rec), Value::Null, "over 64 KiB");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_page_of_days_is_that_part_of_all_the_days_summed_up() {
        let mut rels: Vec<(String, &str)> = Vec::new();
        for (day, hour) in [("2026-11-01", "08"), ("2026-11-03", "08"), ("2026-11-03", "20"), ("2026-11-02", "09"), ("2026-11-05", "07"), ("2026-11-04", "10")] {
            rels.push((format!("TeslaCam/RecentClips/{day}_{hour}-00-00-front.mp4"), day));
        }
        rels.push(("TeslaCam/SentryClips/2026-11-02_12-30-00/2026-11-02_12-29-00-front.mp4".into(), "2026-11-02"));
        let files: Vec<FileEntry> = rels
            .iter()
            .map(|(rel, day)| {
                let c = crate::footage::classify(rel).unwrap();
                FileEntry { rel: rel.clone(), size: 1, mtime_ms: 0.0, ctime_ms: 0.0, birthtime_ms: 0.0, kind: c.kind, typ: c.typ, day: (*day).into(), camera: c.camera, event_id: c.event_id }
            })
            .collect();
        let mut recs = inventory::build_recordings(&Arc::new(FileList::from(files)), "v1");
        recs[0].day = String::new();
        let list: Vec<&Recording> = recs.iter().collect();
        let codecs = inventory::Codecs::default();
        let all = inventory::summarize_days(&list, &codecs);
        assert!(all.len() >= 5 && all.iter().any(|d| d["recordings"] == json!(2)) && all.iter().any(|d| d["day"] == json!("")), "{all:?}");
        for (start, end) in [(0.0, 30.0), (0.0, 1.0), (1.0, 3.0), (2.0, 4.0), (4.0, 9.0), (9.0, 12.0), (3.0, 3.0)] {
            let (shown, total, recordings) = day_page(&list, &codecs, start, end);
            assert_eq!(shown, slice(&all, start, end), "days {start}..{end}");
            assert_eq!(total, all.len());
            assert_eq!(recordings as u64, all.iter().map(|d| d["recordings"].as_u64().unwrap()).sum::<u64>());
        }
    }

    #[test]
    fn the_event_json_cache_lets_go_of_the_one_used_longest_ago() {
        let mut c = EventJsonCache::default();
        let stamp: FileStamp = (1, 2, 3, 4, 5, 6, 7);
        let path = |i: usize| PathBuf::from(format!("/x/{i}/event.json"));
        for i in 0..EVENT_JSON_KEPT {
            c.keep(path(i), stamp, json!(i));
        }
        assert_eq!(c.get(&path(0), &stamp), Some(json!(0)));
        assert_eq!(c.get(&path(1), &(1, 2, 3, 4, 5, 6, 8)), None);
        c.keep(path(EVENT_JSON_KEPT), stamp, json!(EVENT_JSON_KEPT));
        assert_eq!(c.kept.len(), EVENT_JSON_KEPT);
        assert_eq!(c.get(&path(0), &stamp), Some(json!(0)));
        assert_eq!(c.get(&path(1), &stamp), None);
        assert_eq!(c.get(&path(2), &stamp), Some(json!(2)));
        c.keep(path(2), stamp, json!("again"));
        assert_eq!(c.kept.len(), EVENT_JSON_KEPT);
        assert_eq!(c.get(&path(2), &stamp), Some(json!("again")));
    }
}
