//! Saved places (a port of server/places.js), and the event spots the map,
//! the drives and Settings > Places read: where each Sentry and Saved event
//! was (Tesla's event.json est_lat / est_lon), read once while the file does
//! not change.

use super::ctx::{Ctx, Files};
use super::js::{self, num};
use crate::inventory::Recording;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Mutex;

pub const DEFAULT_RADIUS: f64 = 200.0;
pub const MIN_RADIUS: f64 = 50.0;
pub const MAX_RADIUS: f64 = 2000.0;
pub const CLUSTER_M: f64 = 150.0;

/// Metres between two positions (haversine).
pub fn metres(a: (f64, f64), b: (f64, f64)) -> f64 {
    super::speed_index::metres(a.0, a.1, b.0, b.1)
}

fn f(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64).filter(|x| x.is_finite())
}

/// A place's radius: its own, else 200 m.
pub fn radius_of(place: &Value) -> f64 {
    let r = js::number(place.get("radius"));
    if r.is_finite() && (MIN_RADIUS..=MAX_RADIUS).contains(&r) { r } else { DEFAULT_RADIUS }
}

fn numeric(s: &str, signed: bool) -> bool {
    let t = s.trim();
    let t = if signed { t.strip_prefix('-').unwrap_or(t) } else { t };
    let (int, frac) = match t.split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => (t, None),
    };
    !int.is_empty() && int.bytes().all(|c| c.is_ascii_digit()) && frac.map_or(true, |b| !b.is_empty() && b.bytes().all(|c| c.is_ascii_digit()))
}

/// A radius from the browser, in whole metres, or None when it is not 50 to 2000 m.
pub fn clean_radius(v: &Value) -> Option<f64> {
    let n = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) if numeric(s, false) => js::number_str(s),
        _ => return None,
    };
    let r = js::js_round(n);
    (r.is_finite() && (MIN_RADIUS..=MAX_RADIUS).contains(&r)).then_some(r)
}

/// A latitude or longitude from the browser: a number or a plain numeric string, else NaN.
pub fn coord(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) if numeric(s, true) => js::number_str(s),
        _ => f64::NAN,
    }
}

/// The saved place nearest to pos within its radius.
pub fn place_of<'a>(pos: (f64, f64), places: &'a [Value]) -> Option<&'a Value> {
    let mut best: Option<(&Value, f64)> = None;
    for p in places {
        let (Some(lat), Some(lon)) = (f(p, "lat"), f(p, "lon")) else { continue };
        let m = metres(pos, (lat, lon));
        if m <= radius_of(p) && best.map_or(true, |b| m < b.1) {
            best = Some((p, m));
        }
    }
    best.map(|b| b.0)
}

pub fn place_at(pos: (f64, f64), places: &[Value]) -> Value {
    place_of(pos, places).and_then(|p| p.get("name").cloned()).unwrap_or(Value::Null)
}

/// An event's position for the suggestions: { lat, lon, key, at, city, street, vehicle }
#[derive(Debug, Clone)]
pub struct Spot {
    pub lat: f64,
    pub lon: f64,
    pub key: Value,
    pub at: Value,
    pub city: Value,
    pub street: Value,
    pub vehicle: Value,
}

fn key_text(v: &Value) -> String {
    match v {
        Value::Null => "".into(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn most_common(values: &[&Value]) -> Value {
    let mut n: Vec<(&Value, usize)> = Vec::new();
    for v in values {
        let truthy = match v {
            Value::Null => false,
            Value::String(s) => !s.is_empty(),
            Value::Bool(b) => *b,
            Value::Number(x) => x.as_f64() != Some(0.0),
            _ => true,
        };
        if !truthy {
            continue;
        }
        match n.iter_mut().find(|(k, _)| k == v) {
            Some(e) => e.1 += 1,
            None => n.push((v, 1)),
        }
    }
    let mut best: Option<(&Value, usize)> = None;
    for (v, c) in n {
        if best.map_or(true, |b| c > b.1) {
            best = Some((v, c));
        }
    }
    best.map_or(Value::Null, |b| b.0.clone())
}

/// Where the car parks most (suggestPlaces).
pub fn suggest_places(spots: &[Spot], places: &[Value]) -> Vec<Value> {
    struct Group<'a> {
        lat: f64,
        lon: f64,
        members: Vec<&'a Spot>,
    }
    let mut sorted: Vec<&Spot> = spots.iter().filter(|s| s.lat.is_finite() && s.lon.is_finite() && place_of((s.lat, s.lon), places).is_none()).collect();
    sorted.sort_by(|a, b| js::locale_cmp(&key_text(&b.key), &key_text(&a.key)));
    let mut groups: Vec<Group> = Vec::new();
    for s in sorted {
        let mut best: Option<(usize, f64)> = None;
        for (i, g) in groups.iter().enumerate() {
            let m = metres((g.lat, g.lon), (s.lat, s.lon));
            if m <= CLUSTER_M && best.map_or(true, |b| m < b.1) {
                best = Some((i, m));
            }
        }
        match best {
            Some((i, _)) => {
                let g = &mut groups[i];
                g.members.push(s);
                let n = g.members.len() as f64;
                g.lat += (s.lat - g.lat) / n;
                g.lon += (s.lon - g.lon) / n;
            }
            None => groups.push(Group { lat: s.lat, lon: s.lon, members: vec![s] }),
        }
    }
    let mut groups: Vec<Group> = groups.into_iter().filter(|g| g.members.len() >= 2).collect();
    groups.sort_by(|a, b| b.members.len().cmp(&a.members.len()).then_with(|| js::locale_cmp(&key_text(&b.members[0].key), &key_text(&a.members[0].key))));
    groups
        .into_iter()
        .take(8)
        .map(|g| {
            let mut vehicles: Vec<Value> = Vec::new();
            for m in &g.members {
                if !m.vehicle.is_null() && m.vehicle != json!("") && !vehicles.contains(&m.vehicle) {
                    vehicles.push(m.vehicle.clone());
                }
            }
            json!({ "lat": num(js::r6(g.lat)), "lon": num(js::r6(g.lon)), "count": g.members.len(), "last": g.members[0].at.clone(),
                "city": most_common(&g.members.iter().map(|m| &m.city).collect::<Vec<_>>()),
                "street": most_common(&g.members.iter().map(|m| &m.street).collect::<Vec<_>>()), "vehicles": vehicles })
        })
        .collect()
}

/// How many spots are at each saved place: { id: n }
pub fn count_at_places(spots: &[Spot], places: &[Value]) -> Value {
    let mut out = Map::new();
    for p in places {
        out.insert(key_text(p.get("id").unwrap_or(&Value::Null)), json!(0));
    }
    for s in spots {
        if let Some(p) = place_of((s.lat, s.lon), places) {
            let k = key_text(p.get("id").unwrap_or(&Value::Null));
            let n = out.get(&k).and_then(Value::as_u64).unwrap_or(0);
            out.insert(k, json!(n + 1));
        }
    }
    Value::Object(out)
}

/// db.get('places', []) when it is a list
pub fn place_list(ctx: &dyn Ctx) -> Vec<Value> {
    match ctx.setting("places") {
        Some(Value::Array(a)) => a,
        _ => Vec::new(),
    }
}

/// placeName: String(n ?? '') without control characters, trimmed, at most 60
pub fn place_name(v: Option<&Value>) -> String {
    let s = js_string(v);
    let s: String = s.chars().map(|c| if (c as u32) < 0x20 { ' ' } else { c }).collect();
    js::slice_units(s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}'), 60)
}

/// String(v ?? '')
pub fn js_string(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => num(n.as_f64().unwrap_or(0.0)).to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Array(a)) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(Some(x)) }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// What event.json says, and where (est_lat / est_lon), when it is a position.
#[derive(Debug, Clone)]
pub struct EventSpot {
    pub info: Option<Map<String, Value>>,
    pub pos: Option<(f64, f64)>,
}

/// eventSpot: each event.json read once while its size and time do not change.
#[derive(Default)]
pub struct EventSpots {
    cache: Mutex<HashMap<String, (String, Map<String, Value>)>>,
}

impl EventSpots {
    pub fn get(&self, ctx: &dyn Ctx, vid: &str, files: Option<&Files>, rec: &Recording) -> Option<EventSpot> {
        let rel = rec.files.iter().map(|(r, _)| r).find(|r| r.to_lowercase().ends_with("/event.json"))?;
        let f = files?.get(rel)?;
        let key = format!("{vid}/{rel}");
        let stamp = format!("{}/{}", f.size, num(js::js_round(f.mtime_ms)));
        let had = self.cache.lock().unwrap().get(&key).filter(|(s, _)| *s == stamp).map(|(_, i)| i.clone());
        let info = match had {
            Some(i) => Some(i),
            None => {
                let i = event_info(ctx, vid, rec);
                if let Some(i) = &i {
                    let mut c = self.cache.lock().unwrap();
                    c.insert(key, (stamp, i.clone()));
                    if c.len() > 20000 {
                        if let Some(k) = c.keys().next().cloned() {
                            c.remove(&k);
                        }
                    }
                }
                i
            }
        };
        let lat = js::number(info.as_ref().and_then(|i| i.get("est_lat")));
        let lon = js::number(info.as_ref().and_then(|i| i.get("est_lon")));
        let pos = (lat.is_finite() && lon.is_finite() && !(lat == 0.0 && lon == 0.0) && lat.abs() <= 90.0 && lon.abs() <= 180.0).then_some((lat, lon));
        Some(EventSpot { info, pos })
    }
}

/// inventory.js eventInfo: the picked fields of a small event.json
pub fn event_info(ctx: &dyn Ctx, vid: &str, rec: &Recording) -> Option<Map<String, Value>> {
    rec.event_id.as_ref()?;
    let v = ctx.vehicle(vid)?;
    let (rel, _) = rec.files.iter().find(|(r, _)| r.to_lowercase().ends_with("/event.json"))?;
    let abs = v.root.join(rel);
    let real = std::fs::canonicalize(&abs).ok()?;
    if !real.starts_with(std::fs::canonicalize(&v.root).ok()?) {
        return None;
    }
    let md = std::fs::metadata(&real).ok()?;
    if md.len() > 64 * 1024 {
        return None;
    }
    let data: Value = serde_json::from_str(&std::fs::read_to_string(&real).ok()?).ok()?;
    crate::inventory::event_pick(&data)
}

fn text_or_null(info: Option<&Map<String, Value>>, k: &str) -> Value {
    match info.and_then(|i| i.get(k)) {
        Some(Value::String(s)) if !s.is_empty() => json!(s),
        _ => Value::Null,
    }
}

/// The event recordings of a car, newest first (by startKey), at most `n`.
fn events_of(recs: &[Recording], n: usize) -> Vec<&Recording> {
    let mut list: Vec<&Recording> = recs.iter().filter(|r| r.event_id.is_some()).collect();
    list.sort_by(|a, b| js::locale_cmp(b.start_key.as_deref().unwrap_or("undefined"), a.start_key.as_deref().unwrap_or("undefined")));
    list.truncate(n);
    list
}

/// /api/vehicles/:id/event-map
pub fn event_map(ctx: &dyn Ctx, spots: &EventSpots, vid: &str) -> Value {
    let recs = ctx.recordings(vid).unwrap_or_default();
    let files = ctx.files(vid);
    let list = events_of(&recs, 1000);
    let places = place_list(ctx);
    let mut out = Vec::new();
    for rec in &list {
        let Some(spot) = spots.get(ctx, vid, files.as_ref(), rec) else { continue };
        let Some(pos) = spot.pos else { continue };
        let info = spot.info.as_ref();
        out.push((rec.start_key.clone().unwrap_or_default(), json!({
            "recording": rec.id, "category": rec.category, "day": rec.day, "start": rec.start, "startKey": rec.start_key,
            "lat": num(pos.0), "lon": num(pos.1), "reason": text_or_null(info, "reason"), "city": text_or_null(info, "city"),
            "street": text_or_null(info, "street"), "at": text_or_null(info, "timestamp"), "place": place_at(pos, &places)
        })));
    }
    out.sort_by(|a, b| js::locale_cmp(&b.0, &a.0));
    let n = out.len();
    json!({ "events": out.into_iter().map(|x| x.1).collect::<Vec<_>>(), "withoutPosition": list.len() - n })
}

/// The spots of a car's events with a street or town (the drives' labeller), newest 3,000.
pub fn drive_spots(ctx: &dyn Ctx, spots: &EventSpots, vid: &str) -> Vec<(f64, f64, Value, Value)> {
    let recs = ctx.recordings(vid).unwrap_or_default();
    let files = ctx.files(vid);
    let mut out = Vec::new();
    for rec in events_of(&recs, 3000) {
        let Some(s) = spots.get(ctx, vid, files.as_ref(), rec) else { continue };
        let (Some(pos), info) = (s.pos, s.info.as_ref()) else { continue };
        let (city, street) = (text_or_null(info, "city"), text_or_null(info, "street"));
        if !city.is_null() || !street.is_null() {
            out.push((pos.0, pos.1, city, street));
        }
    }
    out
}

/// /api/places/suggestions
pub fn suggestions(ctx: &dyn Ctx, spots: &EventSpots) -> Value {
    let since = js::iso(js::now_ms() - 90.0 * 86400000.0)[..10].to_string();
    let mut recs: Vec<(String, String, Recording)> = Vec::new();
    for v in ctx.vehicles() {
        for rec in ctx.recordings(&v.id).unwrap_or_default().iter() {
            if rec.event_id.is_some() && (rec.day.is_empty() || rec.day >= since) {
                recs.push((v.id.clone(), if v.name.is_empty() { v.id.clone() } else { v.name.clone() }, rec.clone()));
            }
        }
    }
    recs.sort_by(|a, b| js::locale_cmp(b.2.start_key.as_deref().unwrap_or("undefined"), a.2.start_key.as_deref().unwrap_or("undefined")));
    recs.truncate(1500);
    let mut list = Vec::new();
    let mut files: HashMap<String, Option<Files>> = HashMap::new();
    for (vid, name, rec) in &recs {
        let fs = files.entry(vid.clone()).or_insert_with(|| ctx.files(vid)).clone();
        let Some(s) = spots.get(ctx, vid, fs.as_ref(), rec) else { continue };
        let Some(pos) = s.pos else { continue };
        let info = s.info.as_ref();
        let at = match info.and_then(|i| i.get("timestamp")) {
            Some(Value::String(t)) if !t.is_empty() => json!(t),
            _ => rec.start.clone().map(Value::from).or_else(|| (!rec.day.is_empty()).then(|| json!(rec.day))).unwrap_or(Value::Null),
        };
        list.push(Spot { lat: pos.0, lon: pos.1, key: json!(rec.start_key), at, city: text_or_null(info, "city"), street: text_or_null(info, "street"), vehicle: json!(name) });
    }
    let places = place_list(ctx);
    json!({ "days": 90, "events": recs.len(), "withPosition": list.len(), "suggestions": suggest_places(&list, &places), "counts": count_at_places(&list, &places) })
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut b);
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// (status, answer) of the places routes that change something
pub fn add(ctx: &dyn Ctx, body: &Value) -> Result<Value, (u16, String)> {
    let name = place_name(body.get("name"));
    if name.is_empty() {
        return Err((400, "Give the place a name.".into()));
    }
    let (lat, lon) = pos_of(body)?;
    let radius = match body.get("radius") {
        None | Some(Value::Null) => DEFAULT_RADIUS,
        Some(r) => radius_or_400(r)?,
    };
    let list = place_list(ctx);
    if list.len() >= 200 {
        return Err((400, "There are 200 saved places already: remove some first.".into()));
    }
    let place = json!({ "id": random_hex(5), "name": name, "lat": num(lat), "lon": num(lon), "radius": num(radius) });
    let mut next = list;
    next.push(place.clone());
    ctx.set_setting("places", Value::Array(next));
    Ok(json!({ "place": place }))
}

fn radius_or_400(v: &Value) -> Result<f64, (u16, String)> {
    clean_radius(v).ok_or_else(|| (400, format!("The radius is {MIN_RADIUS} to {MAX_RADIUS} m.")))
}

fn pos_of(b: &Value) -> Result<(f64, f64), (u16, String)> {
    let lat = coord(b.get("lat"));
    let lon = coord(b.get("lon"));
    if !lat.is_finite() || !lon.is_finite() || lat.abs() > 90.0 || lon.abs() > 180.0 {
        return Err((400, "That is not a place on the map.".into()));
    }
    Ok((js::r6(lat), js::r6(lon)))
}

pub fn patch(ctx: &dyn Ctx, id: &str, body: &Value) -> Result<Value, (u16, String)> {
    let mut list = place_list(ctx);
    let Some(i) = list.iter().position(|p| p.get("id").and_then(Value::as_str) == Some(id)) else { return Err((404, "No such place.".into())) };
    let has_name = body.get("name").is_some();
    let has_radius = body.get("radius").is_some();
    let has_at = body.get("lat").is_some() || body.get("lon").is_some();
    if !has_name && !has_radius && !has_at {
        return Err((400, "Send a name, a radius or a position.".into()));
    }
    let name = if has_name { place_name(body.get("name")) } else { js_string(list[i].get("name")) };
    if name.is_empty() {
        return Err((400, "Give the place a name.".into()));
    }
    let radius = if has_radius { Some(radius_or_400(&body["radius"])?) } else { None };
    let at = if has_at { Some(pos_of(body)?) } else { None };
    let place = list[i].as_object_mut().ok_or((404, "No such place.".to_string()))?;
    place.insert("name".into(), json!(name));
    if let Some(r) = radius {
        place.insert("radius".into(), num(r));
    }
    if let Some((lat, lon)) = at {
        place.insert("lat".into(), num(lat));
        place.insert("lon".into(), num(lon));
    }
    let out = json!({ "place": list[i].clone() });
    ctx.set_setting("places", Value::Array(list));
    Ok(out)
}

pub fn remove(ctx: &dyn Ctx, id: &str) -> Result<Value, (u16, String)> {
    let list = place_list(ctx);
    if !list.iter().any(|p| p.get("id").and_then(Value::as_str) == Some(id)) {
        return Err((404, "No such place.".into()));
    }
    ctx.set_setting("places", Value::Array(list.into_iter().filter(|p| p.get("id").and_then(Value::as_str) != Some(id)).collect()));
    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    // test/places.test.js
    use super::*;

    #[test]
    fn each_place_has_its_own_radius() {
        let places = vec![json!({ "id": "h", "name": "Home", "lat": 37.7749, "lon": -122.4194 }), json!({ "id": "w", "name": "Work", "lat": 37.79, "lon": -122.40, "radius": 600 })];
        assert_eq!(place_at((37.7749, -122.4194), &places), json!("Home"));
        assert_eq!(place_at((37.7749 + 0.0015, -122.4194), &places), json!("Home"), "about 167 m: inside the old 200 m");
        assert_eq!(place_at((37.7749 + 0.0025, -122.4194), &places), Value::Null, "about 280 m: outside");
        assert_eq!(place_at((37.79 + 0.004, -122.40), &places), json!("Work"), "about 445 m: inside Work's 600 m");
        assert_eq!(radius_of(&json!({ "radius": 10 })), 200.0);
        assert_eq!(radius_of(&json!({ "radius": 1500 })), 1500.0);
    }

    #[test]
    fn radius_and_coordinates_from_the_browser() {
        assert_eq!(clean_radius(&json!(300)), Some(300.0));
        assert_eq!(clean_radius(&json!("250.6")), Some(251.0));
        assert_eq!(clean_radius(&json!(" 50 ")), Some(50.0));
        assert_eq!(clean_radius(&json!(49)), None);
        assert_eq!(clean_radius(&json!(2001)), None);
        assert_eq!(clean_radius(&json!("-100")), None);
        assert_eq!(clean_radius(&json!("1e3")), None);
        assert_eq!(clean_radius(&json!(true)), None);
        assert_eq!(coord(Some(&json!("-97.5"))), -97.5);
        assert_eq!(coord(Some(&json!(12))), 12.0);
        assert!(coord(Some(&json!("12,5"))).is_nan());
        assert!(coord(None).is_nan());
    }

    #[test]
    fn where_the_car_parks_most() {
        let spot = |lat: f64, lon: f64, key: &str, city: &str| Spot { lat, lon, key: json!(key), at: json!(key), city: json!(city), street: Value::Null, vehicle: json!("Car") };
        let spots = vec![
            spot(37.7749, -122.4194, "2026-01-03_10-00-00", "San Francisco"),
            spot(37.7750, -122.4195, "2026-01-02_10-00-00", "San Francisco"),
            spot(37.7751, -122.4193, "2026-01-01_10-00-00", "SF"),
            spot(37.80, -122.27, "2026-01-05_10-00-00", "Oakland"),
            spot(37.8001, -122.2701, "2026-01-04_10-00-00", "Oakland"),
            spot(38.5, -121.5, "2026-01-06_10-00-00", "Sacramento"),
        ];
        let out = suggest_places(&spots, &[]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["count"], json!(3));
        assert_eq!(out[0]["city"], json!("San Francisco"));
        assert_eq!(out[0]["last"], json!("2026-01-03_10-00-00"));
        assert_eq!(out[1]["city"], json!("Oakland"));
        assert_eq!(out[0]["vehicles"], json!(["Car"]));
        assert!(out[0]["lat"].to_string().split('.').nth(1).unwrap().len() <= 6);
        let home = vec![json!({ "id": "h", "name": "Home", "lat": 37.7749, "lon": -122.4194 })];
        let out = suggest_places(&spots, &home);
        assert_eq!(out.len(), 1, "inside a saved place: left out");
        assert_eq!(count_at_places(&spots, &home), json!({ "h": 3 }));
    }

    #[test]
    fn names() {
        assert_eq!(place_name(Some(&json!("  Ho\u{1}me  "))), "Ho me");
        assert_eq!(place_name(Some(&json!(12))), "12");
        assert_eq!(place_name(None), "");
        assert_eq!(place_name(Some(&json!("x".repeat(80)))).len(), 60);
    }
}
