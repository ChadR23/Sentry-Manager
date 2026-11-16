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

fn state_fields(st: Option<&crate::app::VehicleState>, out: &mut Map<String, Value>) {
    out.insert("scannedAt".into(), st.and_then(|s| s.scanned_at).filter(|t| *t != 0.0).map_or(Value::Null, num));
    out.insert("scanning".into(), json!(st.is_some_and(|s| s.scanning)));
    out.insert("error".into(), json!(st.and_then(|s| s.last_error.clone())));
}

fn days(app: &App, v: &Vehicle, q: &HashMap<String, String>) -> Res {
    let st = app.state_of(&v.id);
    let empty = Arc::new(Vec::new());
    let recs = st.as_ref().map_or(empty, |s| s.recordings.clone());
    let codecs = st.as_ref().map(|s| s.codecs.clone()).unwrap_or_default();
    let list = filtered(&recs, q);
    let all = inventory::summarize_days(&list, &codecs);
    let (offset, limit) = paging(q, 100.0, 30.0);
    let mut shown = slice(&all, offset, offset + limit);
    let wanted: Vec<String> = shown.iter().map(|d| d["day"].as_str().unwrap_or("").to_string()).collect();
    let idx = crate::viewer::get().map(|viewer| viewer.speed_index.progress(&v.id, &wanted)).unwrap_or_default();
    let gaps = crate::viewer::get().map(|viewer| viewer.archive.for_days(&v.id)).unwrap_or_default();
    let car_files = crate::viewer::get().map(|viewer| viewer.archive.car_files(&v.id)).unwrap_or(Value::Null);
    // how many of each day's recordings have CAN Bridge data (the green "CAN" tag)
    let has_can = app.core.has_can(&v.id);
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
    out.insert("total".into(), json!(all.len()));
    out.insert("recordings".into(), json!(all.iter().map(|d| d["recordings"].as_u64().unwrap_or(0)).sum::<u64>()));
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
    if let Some(has_can) = app.core.has_can(&v.id) {
        for (t, r) in tagged.iter_mut().zip(page.iter()) {
            if has_can(r) {
                t.insert("can".into(), json!(true));
            }
        }
    }
    if let Some(tags) = crate::viewer::get().and_then(|viewer| viewer.place_tags(&v.id, &page)) {
        for (t, extra) in tagged.iter_mut().zip(tags) {
            t.extend(extra);
        }
    }
    out.insert("recordings".into(), Value::Array(tagged.into_iter().map(Value::Object).collect()));
    ok(Value::Object(out))
}

/// event.json of a Sentry / Saved event, when present and small (inventory.js eventInfo).
fn event_info(v: &Vehicle, rec: &Recording) -> Value {
    if rec.event_id.is_none() {
        return Value::Null;
    }
    let Some(rel) = rec.event_json() else { return Value::Null };
    let abs = v.root.join(rel);
    let Ok(md) = std::fs::metadata(&abs) else { return Value::Null };
    if md.len() > 64 * 1024 {
        return Value::Null;
    }
    let Ok(text) = std::fs::read_to_string(&abs) else { return Value::Null };
    match serde_json::from_str::<Value>(&text) {
        Ok(data) => inventory::event_pick(&data).map_or(Value::Null, Value::Object),
        Err(_) => Value::Null,
    }
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
    // footage playing: background reading slows to one clip at a time
    let _watching = crate::viewer::get().map(|viewer| viewer.watching());
    let p = q.get("path").cloned().unwrap_or_default();
    let roots = roots(app);
    match media::resolve_inside(&p, &roots) {
        Some(real) if !media::hidden_path(&path_str(&real)) => media::send_media(method, headers, &real, &roots),
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
    let Some(v) = app.vehicle(id) else { return Some(error(StatusCode::NOT_FOUND, "No such vehicle.")) };
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
