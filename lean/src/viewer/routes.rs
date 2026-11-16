//! The viewer area's routes, field for field as server/index.js answers them.

use super::js::{self, num};
use super::{drive_data, drives, places, recording_place, studio, work_limits, Viewer};
use axum::body::Body;
use axum::http::{header, HeaderMap, Method, Response, StatusCode};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;

type Res = Response<Body>;

pub struct Req<'a> {
    pub method: &'a Method,
    /// the decoded path, "/api/…"
    pub path: &'a str,
    pub query: &'a HashMap<String, String>,
    pub headers: &'a HeaderMap,
    pub body: &'a [u8],
}

fn json_res(status: u16, v: &Value) -> Res {
    crate::api::json_response(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), v)
}

fn ok(v: Value) -> Res {
    json_res(200, &v)
}

fn error(status: u16, msg: &str) -> Res {
    json_res(status, &json!({ "error": msg }))
}

fn refused((status, msg): (u16, String)) -> Res {
    error(status, &msg)
}

fn answer(r: Result<Value, (u16, String)>) -> Res {
    match r {
        Ok(v) => ok(v),
        Err(e) => refused(e),
    }
}

/// readJson: an empty body is undefined (Null here, read as missing fields), bad JSON a 400
fn body_of(req: &Req) -> Result<Value, Res> {
    let text = String::from_utf8_lossy(req.body);
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|_| error(400, "Invalid JSON"))
}

fn is_day(s: &str) -> bool {
    crate::footage::is_day_shape(s)
}

fn clip_key_of(rel: &str) -> Value {
    js::stamp_in(rel).map_or(Value::Null, |(k, _)| json!(k))
}

fn join(root: &Path, rel: &str) -> String {
    root.join(rel).to_string_lossy().into_owned()
}

impl Viewer {
    fn vehicle_or_404(&self, id: &str) -> Result<super::ctx::VehicleRef, Res> {
        self.ctx.vehicle(id).ok_or_else(|| error(404, "No such vehicle."))
    }

    /// The route's answer, or None when the path is not the viewer's.
    pub fn route(self: &Arc<Self>, req: &Req) -> Option<Res> {
        let seg: Vec<&str> = req.path.trim_start_matches("/api/").split('/').collect();
        let m = req.method;
        let get = m == Method::GET || m == Method::HEAD;
        let post = m == Method::POST;
        let ctx = &*self.ctx;
        let dec = |s: &str| crate::api::decode(s, false).unwrap_or_default();
        Some(match seg.as_slice() {
            ["telemetry"] if get => self.telemetry(req),
            ["telemetry", "speeds"] if post => self.telemetry_speeds(req),
            ["scrub"] if get => self.scrub(req),
            ["speeds", "status"] if get => ok(self.speed_index.status()),
            ["speeds", "index"] if post => self.admin(req, |v| {
                v.speed_index.kick();
                ok(v.speed_index.status())
            }),
            ["places"] if get => ok(json!({ "places": places::place_list(ctx) })),
            ["places"] if post => self.admin(req, |v| with_body(req, |b| answer(places::add(&*v.ctx, b)))),
            ["places", "near"] if get => self.near(req),
            ["places", "suggestions"] if get => ok(places::suggestions(ctx, &self.spots)),
            ["places", id] if m == Method::PATCH => self.admin(req, |v| with_body(req, |b| answer(places::patch(&*v.ctx, &dec(id), b)))),
            ["places", id] if m == Method::DELETE => self.admin(req, |v| answer(places::remove(&*v.ctx, &dec(id)))),
            ["settings", "work-limits"] if get => self.admin(req, |v| ok(v.limits.read().unwrap().view())),
            ["settings", "work-limits"] if m == Method::PUT => self.admin(req, |v| with_body(req, |b| v.set_work_limits(b))),
            ["studio", "context"] if get => ok(studio::context(ctx)),
            ["studio", "settings"] if get => ok(studio::settings(ctx)),
            ["studio", "settings"] if post => self.admin(req, |v| with_body(req, |b| answer(studio::set_setting(&*v.ctx, b)))),
            ["studio", "readDir"] if post => with_body(req, |b| answer(studio::read_dir_route(ctx, b))),
            ["studio", "readFile"] if post => with_body(req, |b| answer(studio::read_file_route(ctx, b))),
            ["studio", "exists"] if post => with_body(req, |b| ok(studio::exists_route(ctx, b))),
            ["studio", "stat"] if post => with_body(req, |b| ok(studio::stat_route(ctx, b))),
            ["studio", "thumbnail"] if post => with_body(req, |b| ok(studio::thumbnail_route(ctx, &self.strips, b))),
            ["studio", "browse"] if post => self.admin(req, |v| with_body(req, |b| answer(studio::browse(&*v.ctx, b)))),
            ["vehicles", id, "speeds"] if get => self.day_speeds(&dec(id), req.query),
            ["vehicles", id, "moments"] if get => self.moments(&dec(id), req.query),
            ["vehicles", id, "driving"] if get => self.driving(&dec(id), req.query),
            ["vehicles", id, "event-map"] if get => match self.vehicle_or_404(&dec(id)) {
                Ok(v) => ok(places::event_map(ctx, &self.spots, &v.id)),
                Err(r) => r,
            },
            ["vehicles", id, "drives"] if get => self.drives(&dec(id), req.query),
            ["vehicles", id, "archive-gaps"] if get => match self.vehicle_or_404(&dec(id)) {
                Ok(v) => ok(self.archive.route(&v)),
                Err(r) => r,
            },
            _ => return None,
        })
    }

    fn admin(self: &Arc<Self>, req: &Req, f: impl FnOnce(&Arc<Self>) -> Res) -> Res {
        match self.ctx.refuse_admin(req.headers) {
            Some(e) => refused(e),
            None => f(self),
        }
    }

    fn telemetry(&self, req: &Req) -> Res {
        let p = req.query.get("path").cloned().unwrap_or_default();
        let Some(real) = studio::readable(&*self.ctx).resolve(&p).filter(|r| !studio::hidden_path(r)) else { return error(403, "Outside the vehicle shares.") };
        let (key, body) = match self.telemetry.for_file(&real) {
            Ok(x) => x,
            Err(super::telemetry_api::Refused(s, m)) => return error(s, &m),
        };
        let etag = format!("\"{key}\"");
        let b = Response::builder()
            .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
            .header(header::CACHE_CONTROL, "private, no-cache")
            .header(header::ETAG, &etag)
            .header(header::VARY, "Accept-Encoding")
            .header("X-Content-Type-Options", "nosniff");
        if req.headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
            return b.status(StatusCode::NOT_MODIFIED).body(Body::empty()).unwrap();
        }
        let accept = req.headers.get(header::ACCEPT_ENCODING).and_then(|v| v.to_str().ok()).unwrap_or("");
        let gzip = accept.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| w == "gzip");
        if gzip {
            let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(6));
            let _ = e.write_all(body.as_bytes());
            let z = e.finish().unwrap_or_default();
            return b.header(header::CONTENT_ENCODING, "gzip").body(Body::from(z)).unwrap();
        }
        b.body(Body::from(body)).unwrap()
    }

    fn scrub(&self, req: &Req) -> Res {
        let p = req.query.get("path").cloned().unwrap_or_default();
        let real = studio::readable(&*self.ctx).resolve(&p).filter(|r| !studio::hidden_path(r) && r.to_string_lossy().to_lowercase().ends_with(".mp4"));
        let Some(real) = real else { return error(403, "Outside the vehicle shares.") };
        let Some(grid) = self.scrub.get(&real, true, true, true) else { return error(404, "No previews for this clip.") };
        let Ok(bytes) = std::fs::read(&grid) else { return error(404, "No previews for this clip.") };
        let b = Response::builder()
            .header(header::CONTENT_TYPE, "image/jpeg")
            .header(header::CONTENT_LENGTH, bytes.len())
            .header(header::CACHE_CONTROL, "private, max-age=86400")
            .header("X-Content-Type-Options", "nosniff");
        if req.method == Method::HEAD {
            return b.body(Body::empty()).unwrap();
        }
        b.body(Body::from(bytes)).unwrap()
    }

    /// vehicleForReal: the car whose folder holds a real path, and the path below it
    fn owner_of(&self, real: &Path) -> Option<(String, String)> {
        for v in self.ctx.vehicles() {
            let root = std::fs::canonicalize(&v.root).unwrap_or(v.root.clone());
            if let Ok(rel) = real.strip_prefix(&root) {
                return Some((v.id, rel.to_string_lossy().into_owned()));
            }
        }
        None
    }

    fn telemetry_speeds(&self, req: &Req) -> Res {
        let body = match body_of(req) {
            Ok(b) => b,
            Err(r) => return r,
        };
        let paths: Vec<String> = body.get("paths").and_then(Value::as_array).map(|a| a.iter().filter_map(|p| p.as_str().map(String::from)).take(40).collect()).unwrap_or_default();
        let guard = studio::readable(&*self.ctx);
        let mut speeds = Vec::new();
        for p in paths {
            let Some(real) = guard.resolve(&p).filter(|r| !studio::hidden_path(r)) else {
                speeds.push(Value::Null);
                continue;
            };
            let Ok(md) = std::fs::metadata(&real) else {
                speeds.push(Value::Null);
                continue;
            };
            use std::os::unix::fs::MetadataExt;
            let owner = self.owner_of(&real);
            let mtime = crate::scanner::ms_of(md.mtime(), md.mtime_nsec());
            speeds.push(self.speed_index.clip(owner.as_ref().map(|o| o.0.as_str()), owner.as_ref().map(|o| o.1.as_str()), &real, md.size(), mtime));
        }
        ok(json!({ "speeds": speeds }))
    }

    fn near(&self, req: &Req) -> Res {
        let lat = js::query_number(req.query.get("lat"));
        let lon = js::query_number(req.query.get("lon"));
        let radius = js::or(js::query_number(req.query.get("radius")), 150.0).clamp(25.0, 5000.0);
        if !lat.is_finite() || !lon.is_finite() || lat.abs() > 90.0 || lon.abs() > 180.0 {
            return error(400, "Give a place (lat, lon).");
        }
        let list = self.ctx.vehicles();
        let hits = self.speed_index.near(&list.iter().map(|v| v.id.clone()).collect::<Vec<_>>(), lat, lon, radius, 300);
        let mut files: HashMap<String, Option<super::ctx::Files>> = HashMap::new();
        let results: Vec<Value> = hits
            .into_iter()
            .filter(|h| files.entry(h.vid.clone()).or_insert_with(|| self.ctx.files(&h.vid)).as_ref().is_some_and(|f| f.contains_key(&h.rel)))
            .map(|h| {
                let v = list.iter().find(|v| v.id == h.vid);
                json!({ "vehicle": h.vid, "vehicleName": v.map_or(h.vid.clone(), |v| if v.name.is_empty() { h.vid.clone() } else { v.name.clone() }),
                    "day": h.day, "clip": clip_key_of(&h.rel), "path": v.map(|v| join(&v.root, &h.rel)), "second": num(h.second), "metres": num(h.metres) })
            })
            .collect();
        ok(json!({ "radius": num(radius), "results": results }))
    }

    fn day_speeds(&self, id: &str, q: &HashMap<String, String>) -> Res {
        let v = match self.vehicle_or_404(id) {
            Ok(v) => v,
            Err(r) => return r,
        };
        let mut out = Map::new();
        for (rel, sp) in self.speed_index.day(&v.id, q.get("date").map_or("", String::as_str)) {
            out.insert(join(&v.root, &rel), sp);
        }
        ok(json!({ "speeds": out }))
    }

    fn moments(&self, id: &str, q: &HashMap<String, String>) -> Res {
        let v = match self.vehicle_or_404(id) {
            Ok(v) => v,
            Err(r) => return r,
        };
        let day = q.get("date").cloned().unwrap_or_default();
        if !is_day(&day) {
            return error(400, "Give a day (date=YYYY-MM-DD).");
        }
        let list = self.speed_index.moments(&v.id, &day);
        let (clips, indexed) = self.speed_index.progress(&v.id, std::slice::from_ref(&day)).get(&day).copied().unwrap_or((0, 0));
        let (mut distance, mut driving, mut top) = (0.0, 0u64, 0.0);
        for (_, sp) in self.speed_index.day(&v.id, &day) {
            for x in sp.as_array().into_iter().flatten() {
                let Some(x) = x.as_f64().filter(|x| x.is_finite()) else { continue };
                distance += x;
                if x > 0.5 {
                    driving += 1;
                }
                if x > top {
                    top = x;
                }
            }
        }
        ok(json!({
            "moments": list.iter().map(|m| json!({ "kind": m.kind, "path": join(&v.root, &m.rel), "clip": clip_key_of(&m.rel), "second": m.second, "value": num(m.value) })).collect::<Vec<_>>(),
            "clips": clips, "indexed": indexed,
            "summary": { "distance": num(js::js_round(distance)), "driving": driving, "top": num(js::r2(top)) }
        }))
    }

    fn driving(&self, id: &str, q: &HashMap<String, String>) -> Res {
        let v = match self.vehicle_or_404(id) {
            Ok(v) => v,
            Err(r) => return r,
        };
        let weeks = js::or(js::query_number(q.get("weeks")), 12.0).clamp(1.0, 52.0);
        let this_week = js::monday(&js::day_in_zone(js::now_ms(), if v.timezone.is_empty() { "UTC" } else { &v.timezone }));
        let first = js::add_days(&this_week, -(7.0 * (weeks - 1.0)).trunc() as i64);
        let mut order: Vec<String> = Vec::new();
        let mut out: HashMap<String, (f64, u64, f64, u64, u64, u64)> = HashMap::new();
        let mut i = 0.0;
        while i < weeks {
            let key = js::add_days(&first, 7 * i as i64);
            order.push(key.clone());
            out.insert(key, (0.0, 0, 0.0, 0, 0, 0));
            i += 1.0;
        }
        let days = self.ctx.recordings(&v.id).map(|r| crate::inventory::footage_days(&r)).unwrap_or_default();
        for d in days.into_iter().filter(|d| *d >= first) {
            let Some(w) = out.get_mut(&js::monday(&d)) else { continue };
            let mut moved = false;
            for (_, sp) in self.speed_index.day(&v.id, &d) {
                for x in sp.as_array().into_iter().flatten() {
                    let Some(x) = x.as_f64().filter(|x| x.is_finite()) else { continue };
                    w.0 += x;
                    if x > 0.5 {
                        w.1 += 1;
                        moved = true;
                    }
                    if x > w.2 {
                        w.2 = x;
                    }
                }
            }
            if moved {
                w.5 += 1;
            }
            for m in self.speed_index.moments(&v.id, &d) {
                if m.kind == "brake" {
                    w.3 += 1;
                } else if m.kind == "swerve" {
                    w.4 += 1;
                }
            }
        }
        ok(json!({ "weeks": order.iter().map(|k| {
            let w = out[k];
            json!({ "week": k, "distance": num(js::js_round(w.0)), "driving": w.1, "top": num(js::r2(w.2)), "hardBrakes": w.3, "swerves": w.4, "days": w.5 })
        }).collect::<Vec<_>>() }))
    }

    fn drives(&self, id: &str, q: &HashMap<String, String>) -> Res {
        let v = match self.vehicle_or_404(id) {
            Ok(v) => v,
            Err(r) => return r,
        };
        let gap_min = match q.get("gap") {
            None => drives::DEFAULT_GAP_S / 60.0,
            Some(g) => js::number_str(g),
        };
        if !gap_min.is_finite() || !(1.0..=120.0).contains(&gap_min) {
            return error(400, "The gap is 1 to 120 minutes.");
        }
        let limit = js::or(js::query_number(q.get("limit")).floor(), 50.0).clamp(1.0, 200.0) as usize;
        let before = q.get("before").filter(|b| !b.is_empty()).cloned();
        if let Some(b) = &before {
            if !(b.len() == 19 && js::stamp_in(b).is_some_and(|x| x.0 == *b)) {
                return error(400, "before is a clip time (YYYY-MM-DD_HH-MM-SS).");
            }
        }
        let recs = self.ctx.recordings(&v.id).unwrap_or_default();
        let clips = drives::clips_of(&recs);
        let by_day = std::cell::RefCell::new(HashMap::<String, HashMap<String, super::speed_index::Stats>>::new());
        let read_day = |day: &str| {
            if !by_day.borrow().contains_key(day) {
                let s = self.speed_index.clip_stats(&v.id, day);
                by_day.borrow_mut().insert(day.to_string(), s);
            }
        };
        let stats_for = |c: &drives::Clip| by_day.borrow().get(&c.day).and_then(|s| s.get(&c.rel).cloned());
        let places_list = Arc::new(places::place_list(&*self.ctx));
        let label_for = |need: bool| {
            let spots = if need { places::drive_spots(&*self.ctx, &self.spots, &v.id) } else { Vec::new() };
            drives::labeller(places_list.clone(), spots)
        };
        self.drive_data.check(&v.id, false);
        let dd = self.drive_data.view(&v.id);
        let usb = if dd.usable { self.drive_data.drives(&v.id, gap_min * 60.0) } else { Arc::new(Vec::new()) };
        let scanning = self.ctx.scanning(&v.id);
        let indexing = self.speed_index.running();
        if !usb.is_empty() {
            let mut i = 0;
            if let Some(b) = &before {
                while i < usb.len() && drive_data::key_of_ms(usb[i].start_ms).as_str() >= b.as_str() {
                    i += 1;
                }
            }
            let page: Vec<&drive_data::UsbDrive> = usb.iter().skip(i).take(limit).collect();
            let more = i + limit < usb.len();
            let by_key: HashMap<&str, &drives::Clip> = clips.iter().map(|c| (c.key.as_str(), c)).collect();
            for d in &page {
                for k in &d.keys {
                    if let Some(c) = by_key.get(k.as_str()) {
                        read_day(&c.day);
                    }
                }
            }
            let label = label_for(page.iter().any(|d| d.from.is_some() || d.to.is_some()));
            let tags = self.drive_data.tags(&v.id);
            let has_can = self.ctx.has_can(&v.id);
            let list: Vec<Value> = page
                .iter()
                .map(|d| {
                    let mut out = drive_data::describe_drive(d, tags.as_ref(), &|k| by_key.get(k).map(|c| (*c).clone()), &|c| stats_for(c), &label);
                    // (the drive's first and last minutes, as the car names its Recent clips)
                    if let (Some(f), Some(first), Some(last)) = (has_can.as_ref(), d.keys.first(), d.keys.last()) {
                        out["can"] = json!(f(&[format!("RecentClips/{first}-front.mp4"), format!("RecentClips/{last}-front.mp4")], Some(first)));
                    }
                    out
                })
                .collect();
            let next = if more { list.last().map(|d| d["id"].clone()).unwrap_or(Value::Null) } else { Value::Null };
            return ok(json!({ "drives": list, "more": more, "next": next, "gap": num(gap_min), "source": "sentry-usb", "driveData": dd.meta, "reading": dd.reading, "scanning": scanning, "indexing": indexing }));
        }
        let (found, more) = drives::group(&clips, &mut |c| {
            read_day(&c.day);
            stats_for(c)
        }, gap_min * 60.0, limit, before.as_deref());
        let label = label_for(found.iter().any(|d| d.clips.iter().any(|c| stats_for(c).is_some_and(|s| s.a.is_some()))));
        let has_can = self.ctx.has_can(&v.id);
        let mut list: Vec<Map<String, Value>> = found
            .iter()
            .map(|d| {
                let mut m = drives::describe(d, &|c| stats_for(c), &label);
                if let (Some(f), Some(first), Some(last)) = (has_can.as_ref(), d.clips.first(), d.clips.last()) {
                    m.insert("can".into(), json!(f(&[first.rel.clone(), last.rel.clone()], Some(&first.key))));
                }
                m
            })
            .collect();
        // where a drive with CAN Bridge data started and ended: its GPS (good fixes only) over the cameras'
        if list.iter().any(|d| d.get("can") == Some(&json!(true))) {
            let mut keys = self.ctx.can_keys(&v.id);
            keys.sort();
            let stamp = |w: &Value| w.as_str().unwrap_or("").replace(' ', "_").replace(':', "-");
            for d in list.iter_mut().filter(|d| d.get("can") == Some(&json!(true))) {
                let from = recording_place::utc_of(&stamp(&d["start"]), &v.timezone);
                let to = recording_place::utc_of(&stamp(&d["end"]), &v.timezone);
                let (a, z) = self.can_gps.ends(&keys, from, to);
                if a.is_some() {
                    d.insert("from".into(), drives::end_of(a, &label));
                }
                if z.is_some() {
                    d.insert("to".into(), drives::end_of(z, &label));
                }
            }
        }
        let list: Vec<Value> = list.into_iter().map(Value::Object).collect();
        let next = if more { list.last().map(|d| d["id"].clone()).unwrap_or(Value::Null) } else { Value::Null };
        ok(json!({ "drives": list, "more": more, "next": next, "gap": num(gap_min), "source": "clips", "driveData": dd.meta, "reading": dd.reading, "scanning": scanning, "indexing": indexing }))
    }

    fn set_work_limits(&self, body: &Value) -> Res {
        let empty = json!({});
        let next = match work_limits::parse_override(if body.is_null() { &empty } else { body }) {
            Ok(n) => n,
            Err(e) => return error(400, &e),
        };
        self.ctx.set_setting("work-limits", next.clone());
        let picked = work_limits::pick_limits(self.resources.clone(), Some(&next));
        *self.limits.write().unwrap() = picked;
        let set = next.as_object().unwrap();
        let text = if set.is_empty() { "automatic".to_string() } else { set.iter().map(|(k, v)| format!("{k} {v}")).collect::<Vec<_>>().join(", ") };
        self.ctx.audit(&format!("Background work limits set to {text}: {}", self.ctx.who()));
        ok(self.limits.read().unwrap().view())
    }

    /// The place fields of a page of recordings (when places are saved), to merge into each.
    pub fn place_tags(&self, vid: &str, page: &[&crate::inventory::Recording]) -> Option<Vec<Map<String, Value>>> {
        let list = places::place_list(&*self.ctx);
        if list.is_empty() {
            return None;
        }
        let files = self.ctx.files(vid);
        // CAN Bridge GPS for the recordings CAN data covers (the car's keys, sorted)
        let has_can = self.ctx.has_can(vid);
        let mut keys = if has_can.is_some() { self.ctx.can_keys(vid) } else { Vec::new() };
        keys.sort();
        let tz = self.ctx.vehicle(vid).map(|v| v.timezone).unwrap_or_default();
        Some(page.iter().map(|rec| {
            let ev = if rec.event_id.is_some() { self.spots.get(&*self.ctx, vid, files.as_ref(), rec).and_then(|s| s.pos) } else { None };
            let covered = has_can.as_ref().is_some_and(|f| f(&rec.clip_rels, rec.start_key.as_deref()));
            let side = recording_place::CanSide { gps: &self.can_gps, keys: if covered { keys.clone() } else { Vec::new() }, tz: &tz };
            recording_place::tag(&self.speed_index, vid, files.as_ref(), rec, ev, &list, Some(&side))
        }).collect())
    }
}

fn with_body(req: &Req, f: impl FnOnce(&Value) -> Res) -> Res {
    match body_of(req) {
        Ok(b) => f(&b),
        Err(r) => r,
    }
}
