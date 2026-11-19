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

/// The vehicle's policy: the default with what was saved over it (an error when it could not be read).
pub fn get(app: &App, vid: &str) -> Res<Value> {
    let mut out = default_policy().as_object().cloned().unwrap_or_default();
    if let Some(Value::Object(saved)) = app.core.db().get(&format!("policy:{vid}"))? {
        out.extend(saved);
    }
    Ok(Value::Object(out))
}

pub fn set(app: &App, vid: &str, input: &Value) -> Res<Value> {
    // (a vehicle list that cannot be read is an error, not "no such vehicle")
    if app.vehicles.try_get(vid)?.is_none() {
        return Err(Fail::new(404, "No such vehicle."));
    }
    let next = normalize(input, &get(app, vid)?)?;
    app.core.db().set(&format!("policy:{vid}"), &next)?;
    Ok(next)
}

/// What a run would move now: { recordings, bytes, byCategory, overLimit, ids }
pub fn preview(app: &App, vid: &str) -> Res<Value> {
    preview_at(app, vid, js::now())
}

pub fn preview_at(app: &App, vid: &str, now_ms: f64) -> Res<Value> {
    let (Some(v), Some(inv)) = (app.vehicles.try_get(vid)?, app.state_of(vid).filter(|s| s.scanned)) else {
        return Ok(json!({ "recordings": 0, "bytes": 0, "byCategory": {} }));
    };
    let policy = get(app, vid)?;
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
    Ok(json!({ "recordings": hit.len(), "bytes": hit.iter().map(|r| r.bytes).sum::<u64>(), "byCategory": by, "overLimit": over_limit, "ids": hit.iter().map(|r| r.id.clone()).collect::<Vec<_>>() }))
}

fn changed() -> Fail {
    Fail::new(409, "The cleanup rule changed after you confirmed. Check it and run it again.")
}

/// Run the vehicle's policy now. `expect`: the policy the person confirmed; when the saved
/// one has changed since, nothing runs. The answer is the Recycle Bin move's.
pub fn run(app: &Arc<App>, vid: &str, expect: Option<&Value>) -> Res<Value> {
    let unchanged = || -> Res<bool> {
        Ok(match expect {
            Some(e) => rule_key(&get(app, vid)?) == rule_key(e),
            None => true,
        })
    };
    if !unchanged()? {
        return Err(changed());
    }
    app.scan_now(vid, false)?;
    if !unchanged()? {
        return Err(changed());
    }
    // (footage kept as the last scan saw it may be gone: what is there is not known to the limits)
    if app.state_of(vid).is_some_and(|s| s.kept > 0) {
        return Err(Fail::new(503, "Part of the footage could not be read, so the cleanup waits until it can."));
    }
    let ids: Vec<String> = preview(app, vid)?["ids"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    let result = if ids.is_empty() { super::bin::Trashed::default() } else { super::bin::trash(app, vid, &ids, "policy")? };
    let policy = get(app, vid)?;
    // checked again right before anything is deleted for good
    if !unchanged()? {
        return Err(changed());
    }
    let bin_days = js::number(policy.get("binDays"));
    let emptied = if js::truthy(policy.get("binDays")) && bin_days.is_finite() { Some(empty_old(app, vid, bin_days, js::now())?) } else { None };
    let mut last = json!({ "moved": result.moved.len(), "skipped": result.skipped.len(), "bytes": result.bytes });
    if let Some((deleted, freed)) = emptied {
        last["emptied"] = json!(deleted);
        last["freed"] = json!(freed);
    }
    let mut saved = policy.as_object().cloned().unwrap_or_default();
    saved.insert("lastRunAt".into(), json!(js::now() as i64));
    saved.insert("lastResult".into(), last);
    // (the run is done either way; not noted, it would run again at the next minute: in 15)
    if let Err(e) = app.core.db().set(&format!("policy:{vid}"), &Value::Object(saved)) {
        app.core.log("policies", Level::Warn, &format!("The cleanup of {vid} ran, but its last run was not noted (tried again in 15 minutes): {e}"));
        app.footage.policy_retry.lock().unwrap().insert(vid.to_string(), js::now() + RETRY_MS);
    }
    Ok(result.json())
}

/// Delete for good what has been in the vehicle's Recycle Bin longer than `days`: (deleted, bytes).
/// An error when manager.db failed (what is left stays in the bin).
pub fn empty_old(app: &App, vid: &str, days: f64, now_ms: f64) -> Res<(usize, u64)> {
    let before = now_ms - days * 86_400_000.0;
    let mut deleted = 0;
    let mut bytes = 0;
    let mut stopped = None;
    for item in app.core.db().bin_items(Some(vid))? {
        if !(item.trashed_at < before) {
            continue;
        }
        match super::bin::delete_files(app, &item.id) {
            Ok((b, kept)) => {
                bytes += b;
                if let Err(e) = kept {
                    stopped = Some(e);
                    break;
                }
                deleted += 1;
            }
            Err(e) => app.core.log("policies", Level::Warn, &format!("Recycle Bin: could not empty {}: {}", item.label, e.message)),
        }
    }
    if deleted > 0 {
        app.core.log("policies", Level::Info, &format!("Recycle Bin of {vid}: {deleted} item(s) older than {} days deleted", js::num_string(days)));
    }
    if let Some(e) = stopped {
        return Err(e.into());
    }
    Ok((deleted, bytes))
}

/// A run that met footage that cannot be reached now is tried again after this long.
const RETRY_MS: f64 = 15.0 * 60_000.0;

/// Called every minute: run the policies whose time has come (the server's local time, as Node).
/// Whether one ran (or tried to).
pub fn tick(app: &Arc<App>, now: chrono::DateTime<chrono::Local>) -> bool {
    let mut ran = false;
    for v in app.vehicles.list() {
        let key = format!("policy:{}", v.id);
        let p = match get(app, &v.id) {
            Ok(p) => {
                app.footage.unread.first(&key, false);
                p
            }
            Err(e) => {
                // (not run while it cannot be read; logged once until it can)
                if app.footage.unread.first(&key, true) {
                    app.core.log("policies", Level::Warn, &format!("Policy for {} could not be read, so it does not run: {}", v.name, e.message));
                }
                continue;
            }
        };
        if !js::truthy(p.get("enabled")) {
            continue;
        }
        let hhmm = now.format("%H:%M").to_string();
        let ran_today = p.get("lastRunAt").and_then(Value::as_f64).filter(|t| *t != 0.0).is_some_and(|t| {
            use chrono::TimeZone;
            chrono::Local.timestamp_millis_opt(t as i64).single().is_some_and(|d| d.date_naive() == now.date_naive())
        });
        let run_at = p.get("runAt").map(js::string).unwrap_or_default();
        let waiting = app.footage.policy_retry.lock().unwrap().get(&v.id).is_some_and(|t| js::now() < *t);
        if hhmm.as_str() >= run_at.as_str() && !ran_today && !waiting {
            ran = true;
            if let Err(e) = run(app, &v.id, None) {
                app.core.log("policies", Level::Warn, &format!("Policy for {} did not run: {}", v.name, e.message));
                let mut saved = p.as_object().cloned().unwrap_or_default();
                if e.status == 503 {
                    // (footage that cannot be reached now: tried again in 15 minutes, not tomorrow)
                    app.footage.policy_retry.lock().unwrap().insert(v.id.clone(), js::now() + RETRY_MS);
                } else {
                    saved.insert("lastRunAt".into(), json!(js::now() as i64));
                }
                saved.insert("lastResult".into(), json!({ "error": e.message }));
                // (not noted, it would run again at the next minute: in 15)
                if let Err(e) = app.core.db().set(&format!("policy:{}", v.id), &Value::Object(saved)) {
                    app.core.log("policies", Level::Warn, &format!("Policy for {}: the failed run was not noted (tried again in 15 minutes): {e}", v.name));
                    app.footage.policy_retry.lock().unwrap().insert(v.id.clone(), js::now() + RETRY_MS);
                }
            }
        }
    }
    ran
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

    fn with_a_clip(name: &str) -> crate::footage::testing::OnCore {
        let f = crate::footage::testing::on_core(name);
        let clip = f.dir.join("footage/car/TeslaCam/RecentClips/2020-01-01_08-00-00-front.mp4");
        std::fs::create_dir_all(clip.parent().unwrap()).unwrap();
        std::fs::write(clip, b"clip").unwrap();
        f.app.scan_now("car", false).unwrap();
        f
    }

    #[test]
    fn a_policy_that_cannot_be_read_is_not_written_over_nor_run_and_is_said_once() {
        let f = with_a_clip("policy-read");
        set(&f.app, "car", &json!({ "enabled": true, "runAt": "00:00", "keepDays": { "Recent": 30 }, "maxGB": 100 })).unwrap();
        let before = f.kept("policy:car");
        f.db.fail_setting_reads("policy:car");
        assert_eq!(set(&f.app, "car", &json!({ "keepDays": { "Sentry": 7 } })).unwrap_err().status, 0);
        assert_eq!(f.kept("policy:car"), before, "the rest of the policy is not lost");
        assert_eq!(preview(&f.app, "car").unwrap_err().status, 0);
        let now = chrono::Local::now();
        assert!(!tick(&f.app, now) && !tick(&f.app, now), "not run while it cannot be read");
        assert_eq!(f.logged("Policy for Car could not be read"), 1);
        assert_eq!(f.kept("policy:car"), before);
    }

    #[test]
    fn a_vehicle_list_that_cannot_be_read_is_an_error_for_a_policy_save_and_preview_never_no_such_vehicle() {
        let f = with_a_clip("policy-vehicles");
        set(&f.app, "car", &json!({ "enabled": true, "keepDays": { "Recent": 1 } })).unwrap();
        let before = f.kept("policy:car");
        assert_eq!(preview(&f.app, "car").unwrap()["recordings"], 1);
        f.db.fail_setting_reads("vehicles");
        assert_eq!(set(&f.app, "car", &json!({ "enabled": false })).unwrap_err().status, 0, "not a 404");
        assert_eq!(preview(&f.app, "car").unwrap_err().status, 0, "not a preview that moves nothing");
        assert_eq!(f.kept("policy:car"), before);
        f.db.mend_reads();
        assert_eq!(set(&f.app, "nope", &json!({})).unwrap_err().status, 404);
    }

    #[test]
    fn a_cleanup_whose_run_cannot_be_noted_is_tried_again_in_15_minutes_not_at_every_minute() {
        let f = with_a_clip("policy-noted");
        set(&f.app, "car", &json!({ "enabled": true, "runAt": "00:00" })).unwrap();
        f.db.conn().execute_batch("CREATE TEMP TRIGGER refused BEFORE UPDATE ON settings WHEN NEW.key = 'policy:car' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;").unwrap();
        let now = chrono::Local::now();
        assert!(tick(&f.app, now), "the day's run");
        assert_eq!(f.logged("its last run was not noted"), 1);
        assert!(!tick(&f.app, now), "not again at the next minute");
    }
}
