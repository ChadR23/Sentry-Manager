//! Cleanup policies per vehicle (a port of server/policies.js): "keep Recent
//! clips N days" and the like, and "keep the footage under N GB". A policy
//! MOVES old recordings to the Recycle Bin; protected ones stay. Nothing is
//! deleted for good unless "empty the Recycle Bin after N days" (binDays) is
//! set: then, at the policy's run, what sat in the bin longer goes.

use super::ctx::{Fail, Level, Res};
use super::inventory::Recording;
use super::js;
use crate::app::App;
use serde_json::{json, Map, Value};
use std::sync::Arc;

pub const CATEGORIES: [&str; 4] = ["Recent", "Sentry", "Saved", "Other"];

pub fn default_policy() -> Value {
    json!({ "enabled": false, "runAt": "03:30", "keepDays": { "Recent": null, "Sentry": null, "Saved": null, "Other": null },
        "binDays": null, "maxGB": null, "lastRunAt": null, "lastResult": null })
}

/// ruleKey: what decides what a run moves or deletes (equal keys: the same rule).
pub fn rule_key(p: &Value) -> String {
    let n = |v: Option<&Value>| -> Value {
        match v {
            None | Some(Value::Null) => Value::Null,
            Some(Value::String(s)) if s.is_empty() => Value::Null,
            Some(v) => js::num(js::number(Some(v))),
        }
    };
    let keep = p.get("keepDays").filter(|k| js::truthy(Some(k)));
    json!({ "keepDays": CATEGORIES.iter().map(|c| n(keep.and_then(|k| k.get(*c)))).collect::<Vec<_>>(), "binDays": n(p.get("binDays")), "maxGB": n(p.get("maxGB")) }).to_string()
}

fn bad(m: impl Into<String>) -> Fail {
    Fail::new(400, m)
}

fn run_at_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 5 && b[2] == b':' && b.iter().enumerate().all(|(i, c)| i == 2 || c.is_ascii_digit()) && (b[0] < b'2' || (b[0] == b'2' && b[1] <= b'3')) && b[3] <= b'5'
}

/// normalizePolicy: `input` over `prev`, every field checked.
pub fn normalize(input: &Value, prev: &Value) -> Res<Value> {
    let mut out = prev.as_object().cloned().unwrap_or_default();
    let mut keep = prev.get("keepDays").and_then(Value::as_object).cloned().unwrap_or_default();
    let present = |k: &str| input.get(k).is_some();
    if present("enabled") {
        out.insert("enabled".into(), json!(js::truthy(input.get("enabled"))));
    }
    if present("runAt") {
        let s = js::string(&input["runAt"]);
        if !run_at_ok(&s) {
            return Err(bad("Run time must be HH:MM."));
        }
        out.insert("runAt".into(), json!(s));
    }
    // keep the footage under this many GB: the oldest unprotected recordings beyond it go at the run
    if present("maxGB") {
        let v = &input["maxGB"];
        if v.is_null() || v.as_str() == Some("") {
            out.insert("maxGB".into(), Value::Null);
        } else {
            let n = js::number(Some(v));
            if !n.is_finite() || !(1.0..=1_000_000.0).contains(&n) {
                return Err(bad("Keep the footage under 1 GB or more, or leave it empty for no limit."));
            }
            out.insert("maxGB".into(), js::num((n * 10.0).round() / 10.0));
        }
    }
    if present("binDays") {
        let v = &input["binDays"];
        if v.is_null() || v.as_str() == Some("") {
            out.insert("binDays".into(), Value::Null);
        } else {
            let n = js::number(Some(v));
            if !js::is_integer(n) || !(1.0..=365.0).contains(&n) {
                return Err(bad("Empty the Recycle Bin after 1 to 365 days, or leave empty to keep it until you empty it."));
            }
            out.insert("binDays".into(), js::num(n));
        }
    }
    for c in CATEGORIES {
        let Some(v) = input.get("keepDays").and_then(|k| k.get(c)) else { continue };
        if v.is_null() || v.as_str() == Some("") {
            keep.insert(c.into(), Value::Null);
        } else {
            let n = js::number(Some(v));
            if !js::is_integer(n) || !(1.0..=3650.0).contains(&n) {
                return Err(bad(format!("{c}: keep between 1 and 3650 days, or leave empty to keep forever.")));
            }
            keep.insert(c.into(), js::num(n));
        }
    }
    out.insert("keepDays".into(), Value::Object(keep));
    Ok(Value::Object(out))
}

fn day_ms(day: &str) -> f64 {
    js::day_ms(day)
}

/// daysBetween(a, b): whole days from a to b (NaN for a day that is not one)
fn days_between(a: &str, b: &str) -> f64 {
    ((day_ms(b) - day_ms(a)) / 86_400_000.0).round()
}

/// selectExpired: recordings older than their category's keepDays by their capture day.
pub fn select_expired<'a>(recs: &'a [Recording], policy: &Value, now_ms: f64, tz: &str) -> Vec<&'a Recording> {
    let today = super::tz::day_in_zone(now_ms, tz);
    recs.iter()
        .filter(|r| {
            let keep = js::number(policy.get("keepDays").and_then(|k| k.get(r.category)));
            if !(keep.is_finite() && keep != 0.0) || r.protected || r.day.is_empty() {
                return false;
            }
            days_between(&r.day, &today) >= keep
        })
        .collect()
}

/// The vehicle's policy: the default with what was saved over it.
pub fn get(app: &App, vid: &str) -> Value {
    let mut out = default_policy().as_object().cloned().unwrap_or_default();
    if let Some(Value::Object(saved)) = app.core.db().get(&format!("policy:{vid}")) {
        out.extend(saved);
    }
    Value::Object(out)
}

pub fn set(app: &App, vid: &str, input: &Value) -> Res<Value> {
    if app.vehicle(vid).is_none() {
        return Err(Fail::new(404, "No such vehicle."));
    }
    let next = normalize(input, &get(app, vid))?;
    app.core.db().set(&format!("policy:{vid}"), &next);
    Ok(next)
}

/// What a run would move now: { recordings, bytes, byCategory, overLimit, ids }
pub fn preview(app: &App, vid: &str) -> Value {
    preview_at(app, vid, js::now())
}

pub fn preview_at(app: &App, vid: &str, now_ms: f64) -> Value {
    let (Some(v), Some(inv)) = (app.vehicle(vid), app.state_of(vid).filter(|s| s.scanned)) else {
        return json!({ "recordings": 0, "bytes": 0, "byCategory": {} });
    };
    let policy = get(app, vid);
    let recs = &inv.recordings;
    let mut hit: Vec<&Recording> = select_expired(recs, &policy, now_ms, &v.timezone);
    let mut over_limit = 0;
    let max_gb = js::number(policy.get("maxGB"));
    if js::truthy(policy.get("maxGB")) && max_gb.is_finite() {
        let limit = max_gb * 1024f64.powi(3);
        let chosen: std::collections::HashSet<&str> = hit.iter().map(|r| r.id.as_str()).collect();
        let mut total = recs.iter().map(|r| r.bytes as f64).sum::<f64>() - hit.iter().map(|r| r.bytes as f64).sum::<f64>();
        let mut oldest: Vec<&Recording> = recs.iter().filter(|r| !chosen.contains(r.id.as_str()) && !r.protected).collect();
        oldest.sort_by(|a, b| a.start_key.as_deref().unwrap_or("null").cmp(b.start_key.as_deref().unwrap_or("null")));
        for r in oldest {
            if total <= limit {
                break;
            }
            hit.push(r);
            total -= r.bytes as f64;
            over_limit += 1;
        }
    }
    let mut by = Map::new();
    for r in &hit {
        let e = by.entry(r.category).or_insert_with(|| json!({ "recordings": 0, "bytes": 0 }));
        e["recordings"] = json!(e["recordings"].as_u64().unwrap_or(0) + 1);
        e["bytes"] = json!(e["bytes"].as_u64().unwrap_or(0) + r.bytes);
    }
    json!({ "recordings": hit.len(), "bytes": hit.iter().map(|r| r.bytes).sum::<u64>(), "byCategory": by, "overLimit": over_limit, "ids": hit.iter().map(|r| r.id.clone()).collect::<Vec<_>>() })
}

fn changed() -> Fail {
    Fail::new(409, "The cleanup rule changed after you confirmed. Check it and run it again.")
}

/// Run the vehicle's policy now. `expect`: the policy the person confirmed; when the saved
/// one has changed since, nothing runs. The answer is the Recycle Bin move's.
pub fn run(app: &Arc<App>, vid: &str, expect: Option<&Value>) -> Res<Value> {
    let unchanged = || expect.map_or(true, |e| rule_key(&get(app, vid)) == rule_key(e));
    if !unchanged() {
        return Err(changed());
    }
    app.scan_now(vid, false)?;
    if !unchanged() {
        return Err(changed());
    }
    let ids: Vec<String> = preview(app, vid)["ids"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    let result = if ids.is_empty() { super::bin::Trashed::default() } else { super::bin::trash(app, vid, &ids, "policy")? };
    let policy = get(app, vid);
    // checked again right before anything is deleted for good
    if !unchanged() {
        return Err(changed());
    }
    let bin_days = js::number(policy.get("binDays"));
    let emptied = (js::truthy(policy.get("binDays")) && bin_days.is_finite()).then(|| empty_old(app, vid, bin_days, js::now()));
    let mut last = json!({ "moved": result.moved.len(), "skipped": result.skipped.len(), "bytes": result.bytes });
    if let Some((deleted, freed)) = emptied {
        last["emptied"] = json!(deleted);
        last["freed"] = json!(freed);
    }
    let mut saved = policy.as_object().cloned().unwrap_or_default();
    saved.insert("lastRunAt".into(), json!(js::now() as i64));
    saved.insert("lastResult".into(), last);
    app.core.db().set(&format!("policy:{vid}"), &Value::Object(saved));
    Ok(result.json())
}

/// Delete for good what has been in the vehicle's Recycle Bin longer than `days`: (deleted, bytes)
pub fn empty_old(app: &App, vid: &str, days: f64, now_ms: f64) -> (usize, u64) {
    let before = now_ms - days * 86_400_000.0;
    let mut deleted = 0;
    let mut bytes = 0;
    for item in app.core.db().bin_items(Some(vid)) {
        if !(item.trashed_at < before) {
            continue;
        }
        match super::bin::delete_forever(app, &item.id) {
            Ok(b) => {
                bytes += b;
                deleted += 1;
            }
            Err(e) => app.core.log("policies", Level::Warn, &format!("Recycle Bin: could not empty {}: {}", item.label, e.message)),
        }
    }
    if deleted > 0 {
        app.core.log("policies", Level::Info, &format!("Recycle Bin of {vid}: {deleted} item(s) older than {} days deleted", js::num_string(days)));
    }
    (deleted, bytes)
}

/// Called every minute: run the policies whose time has come (the server's local time, as Node).
pub fn tick(app: &Arc<App>, now: chrono::DateTime<chrono::Local>) {
    for v in app.vehicles.list() {
        let p = get(app, &v.id);
        if !js::truthy(p.get("enabled")) {
            continue;
        }
        let hhmm = now.format("%H:%M").to_string();
        let ran_today = p.get("lastRunAt").and_then(Value::as_f64).filter(|t| *t != 0.0).is_some_and(|t| {
            use chrono::TimeZone;
            chrono::Local.timestamp_millis_opt(t as i64).single().is_some_and(|d| d.date_naive() == now.date_naive())
        });
        let run_at = p.get("runAt").map(js::string).unwrap_or_default();
        if hhmm.as_str() >= run_at.as_str() && !ran_today {
            if let Err(e) = run(app, &v.id, None) {
                app.core.log("policies", Level::Warn, &format!("Policy for {} did not run: {}", v.name, e.message));
                let mut saved = p.as_object().cloned().unwrap_or_default();
                saved.insert("lastRunAt".into(), json!(js::now() as i64));
                saved.insert("lastResult".into(), json!({ "error": e.message }));
                app.core.db().set(&format!("policy:{}", v.id), &Value::Object(saved));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_and_rule_key() {
        let p = normalize(&json!({ "enabled": 1, "runAt": "04:05", "maxGB": "12.34", "binDays": 30, "keepDays": { "Recent": "7", "Saved": "" } }), &default_policy()).unwrap();
        assert_eq!(p.to_string(), r#"{"enabled":true,"runAt":"04:05","keepDays":{"Recent":7,"Sentry":null,"Saved":null,"Other":null},"binDays":30,"maxGB":12.3,"lastRunAt":null,"lastResult":null}"#);
        let err = |i: Value| normalize(&i, &default_policy()).unwrap_err().message;
        assert_eq!(err(json!({ "runAt": "24:00" })), "Run time must be HH:MM.");
        assert_eq!(err(json!({ "keepDays": { "Sentry": 1.5 } })), "Sentry: keep between 1 and 3650 days, or leave empty to keep forever.");
        assert_eq!(err(json!({ "binDays": 0 })), "Empty the Recycle Bin after 1 to 365 days, or leave empty to keep it until you empty it.");
        assert_eq!(err(json!({ "maxGB": 0.5 })), "Keep the footage under 1 GB or more, or leave it empty for no limit.");
        assert_eq!(rule_key(&p), rule_key(&json!({ "keepDays": { "Recent": "7" }, "binDays": "30", "maxGB": 12.3, "enabled": false })));
        assert_ne!(rule_key(&p), rule_key(&json!({ "keepDays": { "Recent": 8 }, "binDays": 30, "maxGB": 12.3 })));
        assert_eq!(days_between("2025-03-01", "2025-03-08"), 7.0);
    }
}
