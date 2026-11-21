//! Electricity price (server/powerPrice.js) and space saved by conversions
//! (server/savings.js), with PUT /api/settings/power and
//! GET /api/vehicles/:id/savings-by-month.

use super::js::{num, number, truthy};
use super::store::{self, DbResult};
use chrono::{Datelike, Local, TimeZone, Timelike};
use rusqlite::Connection;
use serde_json::{json, Map, Value};

pub const MAX_RATES: usize = 12;

#[derive(Debug, PartialEq)]
pub struct PriceError(pub String);

fn money(v: Option<&Value>, what: &str) -> Result<Value, PriceError> {
    let v = match v {
        None | Some(Value::Null) => return Ok(Value::Null),
        Some(Value::String(s)) if s.is_empty() => return Ok(Value::Null),
        Some(v) => v,
    };
    let n = number(v);
    if !n.is_finite() || !(0.0..=10.0).contains(&n) {
        return Err(PriceError(format!("{what}: enter a price per kWh between 0 and 10.")));
    }
    Ok(num((n * 100000.0).round() / 100000.0))
}

fn minutes(v: &Value) -> Option<u32> {
    let s = v.as_str()?;
    let b = s.as_bytes();
    if b.len() != 5 || b[2] != b':' || !b.iter().enumerate().all(|(i, c)| i == 2 || c.is_ascii_digit()) {
        return None;
    }
    let h: u32 = s[..2].parse().ok()?;
    let m: u32 = s[3..].parse().ok()?;
    (h <= 23 && m <= 59).then_some(h * 60 + m)
}

fn bad_chars(s: &str) -> bool {
    s.chars().any(|c| matches!(c, '<' | '>' | '&' | '"' | '\'' | '`' | '\\'))
}

/// JavaScript's String(x ?? def).trim().slice(0, n) (n in UTF-16 units; the text here is short).
fn text_of(v: Option<&Value>, def: &str, n: usize) -> String {
    let s = match v {
        None | Some(Value::Null) => def.to_string(),
        Some(v) => super::js::to_string(v),
    };
    js_slice(s.trim(), n)
}

/// str.slice(0, n) in UTF-16 code units (a split surrogate pair is dropped, as close as Rust strings allow).
pub fn js_slice(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut units = 0;
    for c in s.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}

/// Checks and tidies what Settings sends.
pub fn parse_power_settings(body: &Value) -> Result<Value, PriceError> {
    let empty = Map::new();
    let b = body.as_object().unwrap_or(&empty);
    let mut currency = text_of(b.get("currency"), "$", 3);
    if currency.is_empty() {
        currency = "$".into();
    }
    if bad_chars(&currency) {
        return Err(PriceError("Use a currency symbol like $, €, £ or kr.".into()));
    }
    let mode = if b.get("mode") == Some(&json!("tou")) { "tou" } else { "flat" };
    let price = money(b.get("pricePerKwh"), "Price")?;
    let default_price = money(b.get("defaultPrice"), "Other hours")?;
    let rates_in: Vec<Value> = b.get("rates").and_then(Value::as_array).cloned().unwrap_or_default();
    if rates_in.len() > MAX_RATES {
        return Err(PriceError(format!("At most {MAX_RATES} rates.")));
    }
    let mut rates = Vec::new();
    for (i, r) in rates_in.iter().enumerate() {
        let mut label = text_of(r.get("label"), "", 24);
        if label.is_empty() {
            label = format!("Rate {}", i + 1);
        }
        if bad_chars(&label) {
            return Err(PriceError(format!("{label}: use plain words for the name.")));
        }
        let price = money(r.get("price"), &label)?;
        if price.is_null() {
            return Err(PriceError(format!("{label}: enter its price per kWh.")));
        }
        let from = r.get("from").cloned().unwrap_or(Value::Null);
        let to = r.get("to").cloned().unwrap_or(Value::Null);
        if minutes(&from).is_none() || minutes(&to).is_none() {
            return Err(PriceError(format!("{label}: times are HH:MM, like 07:00 and 21:30.")));
        }
        if from == to {
            return Err(PriceError(format!("{label}: from and to are the same time.")));
        }
        let mut days: Vec<i64> = r.get("days").and_then(Value::as_array).map(|a| a.iter().map(number).filter(|d| d.fract() == 0.0 && (0.0..=6.0).contains(d)).map(|d| d as i64).collect()).unwrap_or_default();
        days.sort_unstable();
        days.dedup();
        if days.is_empty() {
            return Err(PriceError(format!("{label}: pick at least one day.")));
        }
        rates.push(json!({ "label": label, "price": price, "days": days, "from": from, "to": to }));
    }
    if mode == "tou" && rates.is_empty() && default_price.is_null() {
        return Err(PriceError("Add a rate or a price for the other hours.".into()));
    }
    Ok(json!({ "currency": currency, "mode": mode, "pricePerKwh": price, "defaultPrice": default_price, "rates": rates }))
}

fn local(ms: i64) -> chrono::DateTime<Local> {
    match Local.timestamp_millis_opt(ms) {
        chrono::LocalResult::Single(t) | chrono::LocalResult::Ambiguous(t, _) => t,
        chrono::LocalResult::None => Local.timestamp_millis_opt(0).unwrap(),
    }
}

fn finite(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

/// The time-of-use rate in force at `ms` (server time zone): a rate from 21:00 to
/// 07:00 covers the night and belongs to the day it starts.
pub fn rate_at(settings: &Value, ms: i64) -> Option<&Value> {
    if settings["mode"] != "tou" {
        return None;
    }
    let d = local(ms);
    let now = d.hour() * 60 + d.minute();
    let today = i64::from(d.weekday().num_days_from_sunday());
    let yesterday = (today + 6) % 7;
    settings["rates"].as_array()?.iter().find(|r| {
        let (Some(from), Some(to)) = (minutes(&r["from"]), minutes(&r["to"])) else { return false };
        let has = |day: i64| r["days"].as_array().is_some_and(|a| a.iter().any(|x| x.as_i64() == Some(day)));
        if from < to {
            has(today) && now >= from && now < to
        } else {
            (has(today) && now >= from) || (has(yesterday) && now < to)
        }
    })
}

/// The price per kWh at `ms`, or None when no price is set.
pub fn price_at(settings: &Value, ms: i64) -> Option<f64> {
    if !truthy(settings) {
        return None;
    }
    if settings["mode"] != "tou" {
        return finite(&settings["pricePerKwh"]);
    }
    if let Some(r) = rate_at(settings, ms) {
        return r["price"].as_f64();
    }
    finite(&settings["defaultPrice"])
}

/// The rate's name at `ms`, for "now: Off-peak".
pub fn rate_name_at(settings: &Value, ms: i64) -> Option<String> {
    if settings["mode"] != "tou" {
        return None;
    }
    match rate_at(settings, ms).and_then(|r| r["label"].as_str()).filter(|s| !s.is_empty()) {
        Some(l) => Some(l.to_string()),
        None => finite(&settings["defaultPrice"]).map(|_| "Other hours".to_string()),
    }
}

/// True while the cheapest price of a time-of-use plan is in force; None without such a plan.
pub fn is_cheapest(settings: &Value, ms: i64) -> Option<bool> {
    if settings["mode"] != "tou" {
        return None;
    }
    let mut prices: Vec<f64> = settings["rates"].as_array().map(|a| a.iter().filter_map(|r| r["price"].as_f64()).collect()).unwrap_or_default();
    prices.extend(finite(&settings["defaultPrice"]));
    if prices.is_empty() {
        return None;
    }
    let min = prices.iter().cloned().fold(f64::INFINITY, f64::min);
    Some(price_at(settings, ms).is_some_and(|now| now <= min + 1e-9))
}

/// index.js GET /api/settings `power` default.
pub fn power_settings(db: &Connection) -> DbResult<Value> {
    store::get_or(db, "power", json!({ "currency": "$", "mode": "flat", "pricePerKwh": null, "defaultPrice": null, "rates": [] }))
}

// ---- savings (server/savings.js)

const KEY: &str = "savings";

/// The totals (an error when manager.db could not read them: never written over then).
fn load(db: &Connection) -> DbResult<Value> {
    let s = store::get_or(db, KEY, Value::Null)?;
    let pick = |k: &str| if truthy(&s[k]) { s[k].clone() } else { json!({}) };
    Ok(if s.is_object() {
        json!({ "vehicles": pick("vehicles"), "jobs": pick("jobs"), "months": pick("months"), "monthsSince": if truthy(&s["monthsSince"]) { s["monthsSince"].clone() } else { Value::Null } })
    } else {
        json!({ "vehicles": {}, "jobs": {}, "months": {}, "monthsSince": null })
    })
}

fn month_of(ms: i64) -> String {
    let d = local(ms);
    format!("{}-{:02}", d.year(), d.month())
}

fn add_month(s: &mut Value, vehicle: &str, month: &str, bytes: f64, clips: f64) {
    let months = s["months"].as_object_mut().unwrap();
    let v = months.entry(vehicle.to_string()).or_insert_with(|| json!({}));
    if !v.is_object() {
        *v = json!({});
    }
    let m = v.as_object_mut().unwrap().entry(month.to_string()).or_insert_with(|| json!({ "bytes": 0, "clips": 0 }));
    m["bytes"] = num(number(&m["bytes"]) + bytes.max(0.0));
    m["clips"] = num(number(&m["clips"]) + clips.max(0.0));
}

fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

/// A converter job's totals so far; only what it adds since its last call counts.
pub fn record(db: &Connection, job: &str, vehicle: &str, bytes: f64, clips: f64) -> DbResult<bool> {
    if job.is_empty() || vehicle.is_empty() {
        return Ok(false);
    }
    let bytes = if bytes.is_finite() { bytes.round().max(0.0) } else { 0.0 };
    let clips = if clips.is_finite() && clips.fract() == 0.0 && clips.abs() < 9.007_199_254_740_992e15 { clips.max(0.0) } else { 0.0 };
    let mut s = load(db)?;
    let seen = if s["jobs"][job].is_object() { s["jobs"][job].clone() } else { json!({ "vehicleId": vehicle, "bytes": 0, "clips": 0 }) };
    let add_b = bytes - f(&seen["bytes"]);
    let add_c = clips - f(&seen["clips"]);
    if add_b <= 0.0 && add_c <= 0.0 {
        return Ok(false);
    }
    let vid = seen["vehicleId"].as_str().unwrap_or(vehicle).to_string();
    let mut v = if s["vehicles"][&vid].is_object() { s["vehicles"][&vid].clone() } else { json!({ "bytes": 0, "clips": 0 }) };
    v["bytes"] = num(f(&v["bytes"]) + add_b.max(0.0));
    v["clips"] = num(f(&v["clips"]) + add_c.max(0.0));
    s["vehicles"][&vid] = v;
    add_month(&mut s, &vid, &month_of(store::now_ms()), add_b, add_c);
    s["jobs"][job] = json!({ "vehicleId": vid, "bytes": num(bytes.max(f(&seen["bytes"]))), "clips": num(clips.max(f(&seen["clips"]))) });
    store::set(db, KEY, &s)?;
    Ok(true)
}

/// One vehicle's total: { bytes, clips }.
pub fn for_vehicle(db: &Connection, vehicle: &str) -> DbResult<Value> {
    let v = &load(db)?["vehicles"][vehicle];
    let pick = |k: &str| if truthy(&v[k]) { v[k].clone() } else { json!(0) };
    Ok(json!({ "bytes": pick("bytes"), "clips": pick("clips") }))
}

/// A removed vehicle's total goes with it.
pub fn forget(db: &Connection, vehicle: &str) -> DbResult<()> {
    let mut s = load(db)?;
    if !truthy(&s["vehicles"][vehicle]) {
        return Ok(());
    }
    s["vehicles"].as_object_mut().unwrap().remove(vehicle);
    s["months"].as_object_mut().unwrap().remove(vehicle);
    s["jobs"].as_object_mut().unwrap().retain(|_, j| j["vehicleId"] != vehicle);
    store::set(db, KEY, &s)
}

/// Starts a vehicle's total over; the jobs it has seen stay remembered.
pub fn reset(db: &Connection, vehicle: &str) -> DbResult<bool> {
    let mut s = load(db)?;
    let v = &s["vehicles"][vehicle];
    if !truthy(v) || (!truthy(&v["bytes"]) && !truthy(&v["clips"])) {
        return Ok(false);
    }
    s["vehicles"][vehicle] = json!({ "bytes": 0, "clips": 0 });
    s["months"].as_object_mut().unwrap().remove(vehicle);
    store::set(db, KEY, &s)?;
    Ok(true)
}

/// Once: the jobs counted before months were kept go to the month they finished in (nothing is
/// written when a job's month could not be read: tried again at the next start).
pub fn backfill(db: &Connection, month_of_job: impl Fn(&str) -> DbResult<Option<String>>) -> DbResult<bool> {
    let mut s = load(db)?;
    if truthy(&s["monthsSince"]) {
        return Ok(false);
    }
    let jobs: Vec<(String, Value)> = s["jobs"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    for (id, j) in jobs {
        let vid = super::js::to_string(&j["vehicleId"]);
        if !truthy(&s["vehicles"][&vid]) {
            continue;
        }
        let month = month_of_job(&id)?.filter(|m| !m.is_empty()).unwrap_or_else(|| month_of(store::now_ms()));
        add_month(&mut s, &vid, &month, f(&j["bytes"]), f(&j["clips"]));
    }
    s["monthsSince"] = json!(store::now_ms());
    store::set(db, KEY, &s)?;
    Ok(true)
}

/// One vehicle's savings by month, oldest first, the last `count` months (empty ones too).
pub fn by_month(db: &Connection, vehicle: &str, count: f64, now_ms: i64) -> DbResult<Vec<Value>> {
    let s = load(db)?;
    let m = &s["months"][vehicle];
    let now = local(now_ms);
    let mut out = Vec::new();
    // for (let i = count - 1; i >= 0; i--) new Date(y, month - i, 1): a fraction is cut by Date
    let mut i = count - 1.0;
    while i >= 0.0 {
        let total = i64::from(now.year()) * 12 + (f64::from(now.month0()) - i).trunc() as i64;
        i -= 1.0;
        let key = format!("{}-{:02}", total.div_euclid(12), total.rem_euclid(12) + 1);
        let pick = |k: &str| if truthy(&m[&key][k]) { m[&key][k].clone() } else { json!(0) };
        out.push(json!({ "month": key, "bytes": pick("bytes"), "clips": pick("clips") }));
    }
    Ok(out)
}

/// GET /api/vehicles/:id/savings-by-month (the vehicle is known)
pub fn savings_by_month(db: &Connection, vehicle: &str, months_q: Option<&str>) -> DbResult<Value> {
    let n = months_q.map(super::js::number_str).filter(|x| truthy(&num(*x))).unwrap_or(12.0);
    let months = n.clamp(3.0, 36.0);
    Ok(json!({ "months": by_month(db, vehicle, months, store::now_ms())?, "total": for_vehicle(db, vehicle)? }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(iso: &str) -> i64 {
        chrono::NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S").unwrap().and_utc().timestamp_millis()
    }

    fn plan() -> Value {
        parse_power_settings(&json!({
            "currency": "$", "mode": "tou", "defaultPrice": 0.18,
            "rates": [
                { "label": "Peak", "price": 0.42, "days": [1, 2, 3, 4, 5], "from": "16:00", "to": "21:00" },
                { "label": "Off-peak", "price": 0.09, "days": [0, 1, 2, 3, 4, 5, 6], "from": "23:00", "to": "07:00" }
            ]
        }))
        .unwrap()
    }

    fn utc() {
        std::env::set_var("TZ", "UTC");
    }

    // test/powerPrice.test.js
    #[test]
    fn a_single_price_applies_all_the_time() {
        utc();
        let flat = parse_power_settings(&json!({ "pricePerKwh": "0.15", "currency": "€" })).unwrap();
        assert_eq!(flat, json!({ "currency": "€", "mode": "flat", "pricePerKwh": 0.15, "defaultPrice": null, "rates": [] }));
        assert_eq!(price_at(&flat, at("2026-10-23T03:00:00")), Some(0.15));
        assert_eq!(price_at(&parse_power_settings(&json!({})).unwrap(), at("2026-10-23T03:00:00")), None);
    }

    #[test]
    fn time_of_use() {
        utc();
        let p = plan();
        assert_eq!(price_at(&p, at("2026-10-23T17:30:00")), Some(0.42));
        assert_eq!(price_at(&p, at("2026-10-24T17:30:00")), Some(0.18));
        assert_eq!(price_at(&p, at("2026-10-23T23:30:00")), Some(0.09));
        assert_eq!(price_at(&p, at("2026-10-24T06:59:00")), Some(0.09));
        assert_eq!(price_at(&p, at("2026-10-24T07:00:00")), Some(0.18));
        assert_eq!(price_at(&p, at("2026-10-23T12:00:00")), Some(0.18));
        assert_eq!(rate_name_at(&p, at("2026-10-23T17:30:00")).as_deref(), Some("Peak"));
        assert_eq!(rate_name_at(&p, at("2026-10-23T12:00:00")).as_deref(), Some("Other hours"));
    }

    #[test]
    fn an_overnight_rate_belongs_to_the_day_it_starts() {
        utc();
        let fri = parse_power_settings(&json!({ "mode": "tou", "rates": [{ "label": "Weekend night", "price": 0.05, "days": [5], "from": "22:00", "to": "06:00" }] })).unwrap();
        assert_eq!(price_at(&fri, at("2026-10-24T05:00:00")), Some(0.05));
        assert_eq!(price_at(&fri, at("2026-10-23T05:00:00")), None);
    }

    #[test]
    fn bad_input_is_refused_with_a_readable_reason() {
        let bad = |b: Value, re: &str| {
            let e = parse_power_settings(&b).unwrap_err();
            assert!(e.0.contains(re), "{} !~ {re}", e.0);
        };
        bad(json!({ "pricePerKwh": -1 }), "between 0 and 10");
        bad(json!({ "pricePerKwh": "abc" }), "between 0 and 10");
        bad(json!({ "currency": "<b>" }), "currency symbol");
        bad(json!({ "mode": "tou", "rates": [{ "label": "Peak", "price": 0.4, "days": [1], "from": "7:00", "to": "21:00" }] }), "HH:MM");
        bad(json!({ "mode": "tou", "rates": [{ "label": "Peak", "price": 0.4, "days": [], "from": "07:00", "to": "21:00" }] }), "at least one day");
        bad(json!({ "mode": "tou", "rates": [{ "label": "Peak", "price": 0.4, "days": [1], "from": "07:00", "to": "07:00" }] }), "same time");
        bad(json!({ "mode": "tou", "rates": [] }), "Add a rate");
        let many: Vec<Value> = (0..13).map(|_| json!({ "price": 1, "days": [1], "from": "01:00", "to": "02:00" })).collect();
        bad(json!({ "mode": "tou", "rates": many }), "At most 12");
    }

    #[test]
    fn off_peak_only() {
        utc();
        let p = plan();
        assert_eq!(is_cheapest(&p, at("2026-10-24T02:00:00")), Some(true));
        assert_eq!(is_cheapest(&p, at("2026-10-23T12:00:00")), Some(false));
        assert_eq!(is_cheapest(&p, at("2026-10-23T17:00:00")), Some(false));
        assert_eq!(is_cheapest(&parse_power_settings(&json!({ "pricePerKwh": 0.2 })).unwrap(), at("2026-10-23T17:00:00")), None);
    }

    fn mem() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        store::ensure_schema(&db).unwrap();
        db
    }

    // test/savings.test.js
    #[test]
    fn each_job_adds_only_what_it_adds() {
        let db = mem();
        record(&db, "j1", "car", 100.0, 1.0).unwrap();
        record(&db, "j1", "car", 100.0, 1.0).unwrap();
        record(&db, "j1", "car", 250.0, 3.0).unwrap();
        record(&db, "j2", "car", 50.0, 1.0).unwrap();
        record(&db, "j3", "other", 7.0, 1.0).unwrap();
        assert_eq!(for_vehicle(&db, "car").unwrap(), json!({ "bytes": 300, "clips": 4 }));
        assert_eq!(for_vehicle(&db, "other").unwrap(), json!({ "bytes": 7, "clips": 1 }));
        assert_eq!(for_vehicle(&db, "none").unwrap(), json!({ "bytes": 0, "clips": 0 }));
        record(&db, "j1", "car", 250.0, 3.0).unwrap();
        assert_eq!(for_vehicle(&db, "car").unwrap(), json!({ "bytes": 300, "clips": 4 }));
        record(&db, "j1", "car", -5.0, f64::NAN).unwrap();
        assert_eq!(for_vehicle(&db, "car").unwrap(), json!({ "bytes": 300, "clips": 4 }));
        forget(&db, "car").unwrap();
        assert_eq!(for_vehicle(&db, "car").unwrap(), json!({ "bytes": 0, "clips": 0 }));
        assert_eq!(for_vehicle(&db, "other").unwrap(), json!({ "bytes": 7, "clips": 1 }));
    }

    #[test]
    fn a_reset_starts_one_vehicle_over() {
        let db = mem();
        record(&db, "j1", "car", 400.0, 4.0).unwrap();
        record(&db, "j2", "other", 9.0, 1.0).unwrap();
        assert!(reset(&db, "car").unwrap());
        assert_eq!(for_vehicle(&db, "car").unwrap(), json!({ "bytes": 0, "clips": 0 }));
        assert_eq!(for_vehicle(&db, "other").unwrap(), json!({ "bytes": 9, "clips": 1 }));
        record(&db, "j1", "car", 400.0, 4.0).unwrap();
        assert_eq!(for_vehicle(&db, "car").unwrap(), json!({ "bytes": 0, "clips": 0 }));
        record(&db, "j1", "car", 450.0, 5.0).unwrap();
        assert_eq!(for_vehicle(&db, "car").unwrap(), json!({ "bytes": 50, "clips": 1 }));
        assert!(!reset(&db, "none").unwrap());
    }

    // test/savingsByMonth.test.js
    #[test]
    fn savings_by_month_backfilled_once() {
        let db = mem();
        let gb = 1024f64.powi(3);
        store::set(&db, "savings", &json!({ "vehicles": { "car": { "bytes": num(5.0 * gb), "clips": 50 } }, "jobs": { "j1": { "vehicleId": "car", "bytes": num(3.0 * gb), "clips": 30 }, "j2": { "vehicleId": "car", "bytes": num(2.0 * gb), "clips": 20 } } })).unwrap();
        let now = store::now_ms();
        let this = month_of(now);
        let d = local(now);
        let lm = i64::from(d.year()) * 12 + i64::from(d.month0()) - 1;
        let last = format!("{}-{:02}", lm.div_euclid(12), lm.rem_euclid(12) + 1);
        let l2 = last.clone();
        assert!(backfill(&db, move |id| Ok((id == "j1").then(|| l2.clone()))).unwrap());
        assert!(!backfill(&db, |_| Ok(None)).unwrap(), "only once");
        let months = by_month(&db, "car", 12.0, now).unwrap();
        assert_eq!(months.len(), 12);
        assert_eq!(months[11]["month"], json!(this));
        assert_eq!(months[10], json!({ "month": last, "bytes": num(3.0 * gb), "clips": 30 }));
        assert_eq!(months[11], json!({ "month": this, "bytes": num(2.0 * gb), "clips": 20 }));
        record(&db, "j3", "car", gb, 5.0).unwrap();
        record(&db, "j3", "car", 1.5 * gb, 8.0).unwrap();
        let months = by_month(&db, "car", 12.0, now).unwrap();
        assert_eq!(months[11], json!({ "month": this, "bytes": num(3.5 * gb), "clips": 28 }));
        assert_eq!(for_vehicle(&db, "car").unwrap()["bytes"], num(6.5 * gb));
        reset(&db, "car").unwrap();
        assert!(by_month(&db, "car", 12.0, now).unwrap().iter().all(|m| m["bytes"] == 0));
    }

    #[test]
    fn savings_by_month_route_clamps_the_count() {
        let db = mem();
        assert_eq!(savings_by_month(&db, "car", None).unwrap()["months"].as_array().unwrap().len(), 12);
        assert_eq!(savings_by_month(&db, "car", Some("1")).unwrap()["months"].as_array().unwrap().len(), 3);
        assert_eq!(savings_by_month(&db, "car", Some("99")).unwrap()["months"].as_array().unwrap().len(), 36);
        assert_eq!(savings_by_month(&db, "car", Some("abc")).unwrap()["months"].as_array().unwrap().len(), 12);
        assert_eq!(savings_by_month(&db, "car", None).unwrap()["total"], json!({ "bytes": 0, "clips": 0 }));
    }

    #[test]
    fn savings_not_kept_are_an_error_and_counted_at_the_next_snapshot() {
        let db = mem();
        record(&db, "j1", "car", 100.0, 1.0).unwrap();
        db.execute_batch("CREATE TEMP TRIGGER refused BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;").unwrap();
        assert!(record(&db, "j1", "car", 250.0, 3.0).is_err());
        assert!(reset(&db, "car").is_err() && forget(&db, "car").is_err());
        db.execute_batch("DROP TRIGGER refused;").unwrap();
        assert_eq!(for_vehicle(&db, "car").unwrap(), json!({ "bytes": 100, "clips": 1 }));
        assert!(record(&db, "j1", "car", 250.0, 3.0).unwrap(), "what the job added since is counted then");
        assert_eq!(for_vehicle(&db, "car").unwrap(), json!({ "bytes": 250, "clips": 3 }));
    }
}
