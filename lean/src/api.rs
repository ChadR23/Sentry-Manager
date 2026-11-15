//! The HTTP side: the routes of server/index.js this slice answers, field
//! for field, and the stock UI's files. Everything else under /api/ is
//! "Not found", as on the Node server.

use crate::app::{App, Vehicle};
use crate::inventory::{self, num, Recording};
use crate::media;
use axum::body::Body;
use axum::extract::State;
use axum::http::{header, HeaderMap, Method, Request, Response, StatusCode};
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

/// Object.fromEntries(url.searchParams): the last of a repeated key wins.
fn query_of(q: Option<&str>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for pair in q.unwrap_or("").split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        out.insert(decode(k, true).unwrap_or_default(), decode(v, true).unwrap_or_default());
    }
    out
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

fn policy_default() -> Value {
    json!({ "enabled": false, "runAt": "03:30", "keepDays": { "Recent": null, "Sentry": null, "Saved": null, "Other": null },
        "binDays": null, "maxGB": null, "lastRunAt": null, "lastResult": null })
}

/// (free, total) bytes of the file system holding p.
fn disk_space(p: &Path) -> Option<(u64, u64)> {
    let c = std::ffi::CString::new(p.as_os_str().as_encoded_bytes()).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    Some((s.f_bavail as u64 * s.f_frsize as u64, s.f_blocks as u64 * s.f_frsize as u64))
}

fn vehicle_summary(app: &App, v: &Vehicle) -> Value {
    let st = app.state_of(&v.id);
    let root = path_str(&v.root);
    let readable = std::fs::read_dir(&v.root).is_ok();
    let space = disk_space(&v.root);
    json!({
        "id": v.id, "name": v.name, "timezone": v.timezone,
        "source": { "type": "path", "path": root }, "root": root, "studioRoot": path_str(&app.studio_root(v)),
        // (the lean server never writes to the footage, so it does not test whether it could)
        "share": { "mode": "local", "share": null, "path": root, "healthy": readable, "mounted": false, "readable": readable, "writable": null,
            "totalBytes": space.map(|s| s.1), "freeBytes": space.map(|s| s.0), "lastError": null, "network": false },
        "security": null,
        "inventory": st.as_ref().filter(|s| s.scanned).map(|s| inventory::totals(&s.recordings, s.files, s.scanned_at.unwrap_or(0.0))),
        "scanning": st.as_ref().is_some_and(|s| s.scanning),
        "binBytes": 0, "binItems": 0, "policy": policy_default(), "saved": { "bytes": 0, "clips": 0 },
        "storage": space.map(|(free, total)| json!({ "free": free, "total": total, "perDay": 0, "daysLeft": null, "capped": false })),
        "car": null
    })
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
    let idx = match crate::viewer::get() {
        Some(viewer) => viewer.speed_index.progress(&v.id, &wanted),
        None => app.catalog.progress(&v.id, &wanted).unwrap_or_default(),
    };
    for d in &mut shown {
        let (clips, indexed) = idx.get(d["day"].as_str().unwrap_or("")).copied().unwrap_or((0, 0));
        d.insert("speedIndex".into(), json!({ "clips": clips, "indexed": indexed }));
        d.insert("archive".into(), Value::Null);
        d.insert("carFiles".into(), Value::Null);
        // (no CAN Bridge data here: no recording has any)
        d.insert("canRecordings".into(), json!(0));
    }
    let mut out = Map::new();
    out.insert("sentryUsb".into(), json!({ "present": false }));
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
    let Some((rel, _)) = rec.files.iter().find(|(r, _)| r.to_lowercase().ends_with("/event.json")) else { return Value::Null };
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
        .files
        .iter()
        .map(|(rel, size)| {
            let mut f = json!({ "rel": rel, "path": join(&v.root, rel), "size": size });
            if rel.to_lowercase().ends_with(".mp4") {
                f["codec"] = json!(st.codecs.get(rel).cloned().flatten());
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

fn speeds_status(app: &App) -> Res {
    let s = app.speeds.lock().unwrap().clone();
    ok(json!({ "running": s.running, "done": s.done, "total": s.total, "day": s.day, "finishedAt": s.finished_at.map(num),
        "last": s.last, "limit": 1, "readMode": if s.finished_at.is_some() { json!("short") } else { Value::Null } }))
}

fn day_speeds(app: &App, v: &Vehicle, q: &HashMap<String, String>) -> Res {
    let day = q.get("date").cloned().unwrap_or_default();
    let mut out = Map::new();
    if crate::footage::is_day_shape(&day) {
        for (rel, sp) in app.catalog.day_speeds(&v.id, &day).unwrap_or_default() {
            out.insert(join(&v.root, &rel), sp.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null));
        }
    }
    ok(json!({ "speeds": out }))
}

fn roots(app: &App) -> Vec<PathBuf> {
    app.vehicles.iter().map(|v| v.root.clone()).collect()
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
    let rec = st.as_ref().and_then(|s| s.recordings.iter().find(|r| r.id == rid).cloned());
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

/// The ops area, on its stand-alone context (ops::lean) until core lands.
pub fn ops_of(app: &Arc<App>) -> &'static Arc<crate::ops::Ops> {
    static OPS: std::sync::OnceLock<Arc<crate::ops::Ops>> = std::sync::OnceLock::new();
    OPS.get_or_init(|| {
        let data = PathBuf::from(std::env::var("DATA_PATH").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/data".into()));
        let ctx = crate::ops::lean::LeanCtx::open(app.clone(), &data).expect("manager.db");
        crate::ops::Ops::new(ctx, Arc::new(crate::ops::net::Https), crate::ops::Ops::process_env())
    })
}

fn ops_route(app: &Arc<App>, method: &Method, path: &str, q: &HashMap<String, String>, headers: &HeaderMap, body: &[u8]) -> Res {
    let get = method == Method::GET || method == Method::HEAD;
    if !get && headers.get("x-requested-with").and_then(|v| v.to_str().ok()) != Some("sentry-six-manager") {
        return error(StatusCode::FORBIDDEN, "Missing X-Requested-With header.");
    }
    let json_body = if String::from_utf8_lossy(body).trim().is_empty() {
        Value::Null
    } else {
        match serde_json::from_slice(body) {
            Ok(v) => v,
            Err(_) => return error(StatusCode::BAD_REQUEST, "Invalid JSON"),
        }
    };
    // no accounts yet: the fixed local admin of /api/auth/me, never "confirmed"
    // (the 🔑 routes wait for core's sign-in, which comes with HTTPS)
    let caller = crate::ops::ctx::Caller { user: Some("local".into()), client: "127.0.0.1".into(), confirmed: false, https: false };
    let auth = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok());
    let r = crate::ops::Request { method: method.as_str(), path, query: q, body: &json_body, caller: &caller, authorization: auth };
    let Some(reply) = ops_of(app).handle(&r) else { return error(StatusCode::NOT_FOUND, "Not found") };
    let mut b = Response::builder().status(reply.status);
    for (k, v) in &reply.headers {
        b = b.header(k.as_str(), v.as_str());
    if !reply.headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("x-content-type-options")) {
        b = b.header("X-Content-Type-Options", "nosniff");
    b.body(Body::from(reply.body)).unwrap()

fn api(app: &Arc<App>, method: &Method, path: &str, q: &HashMap<String, String>, headers: &HeaderMap) -> Res {
fn api(app: &Arc<App>, method: &Method, path: &str, q: &HashMap<String, String>, headers: &HeaderMap, body: &[u8]) -> Res {
    let seg: Vec<&str> = path.trim_start_matches("/api/").split('/').collect();
    let get = method == Method::GET || method == Method::HEAD;
    if method != Method::GET && method != Method::HEAD && headers.get("x-requested-with").and_then(|v| v.to_str().ok()) != Some("sentry-six-manager") {
        return error(StatusCode::FORBIDDEN, "Missing X-Requested-With header.");
    }
    if let Some(viewer) = crate::viewer::get() {
        if let Some(res) = viewer.route(&crate::viewer::routes::Req { method, path, query: q, headers, body }) {
            return res;
        }
    }
    let vehicle = |id: &str| app.vehicle(&decode(id, false).unwrap_or_default()).cloned();
    match (get, seg.as_slice()) {
        (true, ["auth", "me"]) => ok(json!({ "user": "local", "role": "admin", "twoFactor": false, "needsSetup": false, "secure": false, "fingerprint": null })),
        (true, ["vehicles"]) => {
            let days: std::collections::BTreeSet<String> =
                app.vehicles.iter().filter_map(|v| app.state_of(&v.id)).flat_map(|s| inventory::footage_days(&s.recordings)).collect();
            ok(json!({ "vehicles": app.vehicles.iter().map(|v| vehicle_summary(app, v)).collect::<Vec<_>>(), "footageDays": days.len(), "carModels": [] }))
        }
        (_, ["vehicles", id, rest @ ..]) => {
            let Some(v) = vehicle(id) else {
                return if matches!((get, rest), (true, ["days"] | ["recordings"] | ["recordings", _] | ["recordings", _, "thumbnail"] | ["speeds"]) | (false, ["scan"])) {
                    error(StatusCode::NOT_FOUND, "No such vehicle.")
                } else {
                    error(StatusCode::NOT_FOUND, "Not found")
                };
            };
            match (get, rest) {
                (true, ["days"]) => days(app, &v, q),
                (true, ["recordings"]) => recordings(app, &v, q),
                (true, ["recordings", rid]) => recording(app, &v, &decode(rid, false).unwrap_or_default()),
                (true, ["recordings", rid, "thumbnail"]) => thumbnail(app, &v, &decode(rid, false).unwrap_or_default(), method, headers),
                (true, ["speeds"]) => day_speeds(app, &v, q),
                (false, ["scan"]) if method == Method::POST => {
                    app.scan(&v.id, false);
                    ok(json!({ "ok": true, "jobId": format!("scan:{}", v.id) }))
                }
                _ => error(StatusCode::NOT_FOUND, "Not found"),
            }
        }
        (true, ["speeds", "status"]) => speeds_status(app),
        (true, ["media"]) => media(app, method, headers, q),
        _ => error(StatusCode::NOT_FOUND, "Not found"),
    }
}

/// One decoded, normalized path for every decision (no %2F tricks), as index.js.
fn clean_path(raw: &str) -> Option<String> {
    let p = decode(raw, false)?;
    if p.contains('\0') || p.contains('\\') || p.contains("//") || p.split('/').any(|s| s == "." || s == "..") {
        return None;
    }
    Some(p)
}

fn not_found() -> Res {
    error(StatusCode::NOT_FOUND, "Not found")
}

fn web(app: &App, method: &Method, headers: &HeaderMap, p: &str) -> Res {
    let root = &app.app_root;
    let serve = |dir: PathBuf, rel: &str, cache: &str| media::serve_static(method, headers, &dir, rel, cache).unwrap_or_else(not_found);
    match p {
        "/" | "/index.html" => serve(root.join("web"), "index.html", "no-cache"),
        "/login" => serve(root.join("web"), "login.html", "no-cache"),
        "/login/code" => serve(root.join("web"), "login-code.html", "no-cache"),
        "/healthz" => Response::builder().header(header::CONTENT_TYPE, "text/plain").header(header::CACHE_CONTROL, "no-store").body(Body::from("ok")).unwrap(),
        "/studio" | "/studio/" => Response::builder().status(StatusCode::FOUND).header(header::LOCATION, "/studio/index.html").body(Body::empty()).unwrap(),
        _ => {
            let cache = if p.contains("/fonts/") { "public, max-age=604800" } else { "no-cache" };
            if let Some(rel) = p.strip_prefix("/web/") {
                serve(root.join("web"), rel, cache)
            } else if let Some(rel) = p.strip_prefix("/studio/") {
                serve(root.join("src/renderer"), rel, cache)
            } else if let Some(rel) = p.strip_prefix("/shared/") {
                serve(root.join("src/shared"), rel, cache)
            } else if let Some(rel) = p.strip_prefix("/assets/") {
                serve(root.join("assets"), rel, cache)
            } else {
                not_found()
            }
        }
    }
}

pub async fn handle(State(app): State<Arc<App>>, req: Request<Body>) -> Res {
    let method = req.method().clone();
    let headers = req.headers().clone();
    let raw = req.uri().path().to_string();
    let q = query_of(req.uri().query());
    let Some(p) = clean_path(&raw) else { return error(StatusCode::BAD_REQUEST, "Bad request") };
    // the ops area's routes (src/ops): notifications, health, stats, reports, ...
    if crate::ops::access(method.as_str(), &p).is_some() {
        let body = axum::body::to_bytes(req.into_body(), 1024 * 1024).await.unwrap_or_default();
        return tokio::task::spawn_blocking(move || ops_route(&app, &method, &p, &q, &headers, &body))
            .await
            .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error"));
    }
    let body = if method == Method::GET || method == Method::HEAD {
        bytes::Bytes::new()
    } else {
        match axum::body::to_bytes(req.into_body(), 1024 * 1024).await {
            Ok(b) => b,
            Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large"),
        }
    };
    // file work happens off the async threads
    tokio::task::spawn_blocking(move || if p.starts_with("/api/") { api(&app, &method, &p, &q, &headers, &body) } else { web(&app, &method, &headers, &p) })
        .await
        .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error"))
}
