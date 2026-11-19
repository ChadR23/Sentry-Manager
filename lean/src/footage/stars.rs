//! Starred moments (index.js /api/stars): a moment marked with a note, kept
//! in the `stars` setting for every interface. An admin's star also protects
//! its recording, so policies and "Delete through this date" leave it alone;
//! removing the last star of such a recording unprotects it.

use super::ctx::{Caller, Fail, Res};
use super::js;
use super::inventory::Recording;
use super::mdb::DbResult;
use crate::app::App;
use serde_json::{json, Value};

pub const MAX_STARS: usize = 2000;

/// The stars (an error when manager.db could not read them: never written over then).
fn star_list(app: &App) -> DbResult<Vec<Value>> {
    Ok(match app.core.db().get("stars")? {
        Some(Value::Array(a)) => a,
        _ => Vec::new(),
    })
}

fn save(app: &App, list: &[Value]) -> DbResult<()> {
    app.core.db().set("stars", &Value::Array(list.to_vec()))
}

/// cleanNote: control characters as spaces, trimmed, at most 200 characters.
pub fn clean_note(n: Option<&Value>) -> String {
    let s: String = js::string_or(n, "").chars().map(|c| if (c as u32) < 0x20 { ' ' } else { c }).collect();
    js::slice16(js::trim(&s), 200)
}

/// "YYYY-MM-DD_HH-MM-SS"
pub fn is_clip_key(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 19 && b.iter().enumerate().all(|(i, c)| match i {
        4 | 7 | 13 | 16 => *c == b'-',
        10 => *c == b'_',
        _ => c.is_ascii_digit(),
    })
}

fn recording_of_clip(app: &App, vid: &str, clip: &str) -> Option<Recording> {
    app.state_of(vid)?.recordings.iter().find(|r| r.files().any(|(rel, _)| rel.contains(clip))).cloned()
}

fn iso_now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// GET /api/stars?vehicle=
pub fn list(app: &App, vehicle: Option<&str>) -> Res<Value> {
    let known: Vec<String> = app.vehicles.try_list()?.into_iter().map(|v| v.id).collect();
    let mut stars: Vec<Value> = star_list(app)?
        .into_iter()
        .filter(|x| {
            let v = x.get("vehicle").and_then(Value::as_str).unwrap_or("");
            known.iter().any(|k| k == v) && vehicle.map_or(true, |w| w == v)
        })
        .collect();
    let clip = |x: &Value| x.get("clip").map(js::string).unwrap_or_else(|| "undefined".into());
    let second = |x: &Value| js::number(x.get("second"));
    stars.sort_by(|a, b| clip(b).cmp(&clip(a)).then(second(b).partial_cmp(&second(a)).unwrap_or(std::cmp::Ordering::Equal)));
    Ok(json!({ "stars": stars }))
}

/// POST /api/stars
pub fn add(app: &App, who: &Caller, body: &Value) -> Res<Value> {
    let vid = if js::truthy(body.get("vehicle")) { js::string(&body["vehicle"]) } else { String::new() };
    let v = app.vehicles.try_get(&vid)?.ok_or_else(|| Fail::new(404, "No such vehicle."))?;
    let clip = if js::truthy(body.get("clip")) { js::string(&body["clip"]) } else { String::new() };
    let second = js::number(body.get("second")).floor();
    if !is_clip_key(&clip) || !second.is_finite() || !(0.0..=7200.0).contains(&second) {
        return Err(Fail::new(400, "Give the clip and second to star."));
    }
    let mut list = star_list(app)?;
    if list.len() >= MAX_STARS {
        return Err(Fail::new(400, format!("There are {MAX_STARS} starred moments already: remove some first.")));
    }
    let mut star = json!({ "id": super::random_hex(6), "vehicle": v.id, "day": &clip[0..10], "clip": clip, "second": js::num(second), "note": clean_note(body.get("note")), "createdAt": iso_now() });
    // its recording is protected (by an admin's star: a watch-only account changes nothing kept)
    let rec = recording_of_clip(app, &v.id, &clip);
    if let Some(r) = rec.as_ref().filter(|r| !r.protected && who.admin_here) {
        star["protects"] = json!(r.id);
        // (protected before the star is kept: a star never stands for a protection that was not kept)
        let rels: Vec<String> = r.files().map(|(f, _)| f.to_string()).collect();
        super::bin::set_protected(app, &v.id, &rels, true)?;
        app.rebuild(&v.id, None);
        app.core.announce("inventory");
    }
    list.push(star.clone());
    save(app, &list)?;
    let protected = rec.as_ref().is_some_and(|r| r.protected || star.get("protects").is_some());
    Ok(json!({ "star": star, "protected": protected }))
}

fn not_found() -> Fail {
    Fail::new(404, "No such starred moment.")
}

/// PATCH /api/stars/:id
pub fn edit(app: &App, id: &str, body: &Value) -> Res<Value> {
    let mut list = star_list(app)?;
    let star = list.iter_mut().find(|x| x.get("id").and_then(Value::as_str) == Some(id)).ok_or_else(not_found)?;
    star["note"] = json!(clean_note(body.get("note")));
    let out = star.clone();
    save(app, &list)?;
    Ok(json!({ "star": out }))
}

/// DELETE /api/stars/:id
pub fn remove(app: &App, id: &str) -> Res<Value> {
    let list = star_list(app)?;
    let star = list.iter().find(|x| x.get("id").and_then(Value::as_str) == Some(id)).cloned().ok_or_else(not_found)?;
    let rest: Vec<Value> = list.into_iter().filter(|x| x.get("id").and_then(Value::as_str) != Some(id)).collect();
    // (the star goes first: a failure after it leaves its recording protected, never the other way)
    save(app, &rest)?;
    // a recording that only this star protected is no longer kept for it
    if js::truthy(star.get("protects")) {
        let vid = star.get("vehicle").map(js::string).unwrap_or_default();
        let clip = star.get("clip").map(js::string).unwrap_or_default();
        let rec = recording_of_clip(app, &vid, &clip);
        let others = rest.iter().any(|x| {
            x.get("vehicle").map(js::string).as_deref() == Some(vid.as_str())
                && rec.as_ref().is_some_and(|r| r.files().any(|(rel, _)| rel.contains(&x.get("clip").map(js::string).unwrap_or_else(|| "undefined".into()))))
        });
        if let Some(r) = rec.filter(|r| r.protected && !others) {
            let rels: Vec<String> = r.files().map(|(f, _)| f.to_string()).collect();
            super::bin::set_protected(app, &vid, &rels, false)?;
            app.rebuild(&vid, None);
            app.core.announce("inventory");
        }
    }
    Ok(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_and_keys() {
        assert_eq!(clean_note(Some(&json!("  a\tb\n "))), "a b");
        assert_eq!(clean_note(None), "");
        assert_eq!(clean_note(Some(&json!(12))), "12");
        assert!(is_clip_key("2025-03-01_08-00-00") && !is_clip_key("2025-03-01 08-00-00"));
    }

    #[test]
    fn stars_that_cannot_be_read_are_never_written_over_and_answer_500() {
        let f = crate::footage::testing::on_core("stars");
        let who = Caller { user: Some("admin".into()), client: "127.0.0.1".into(), admin_here: true, confirmed: true };
        let first = add(&f.app, &who, &json!({ "vehicle": "car", "clip": "2020-01-01_08-00-00", "second": 3 })).unwrap();
        let id = first["star"]["id"].as_str().unwrap().to_string();
        let before = f.kept("stars");
        f.db.fail_setting_reads("stars");
        assert_eq!(add(&f.app, &who, &json!({ "vehicle": "car", "clip": "2020-01-01_09-00-00", "second": 1 })).unwrap_err().status, 0);
        assert_eq!(edit(&f.app, &id, &json!({ "note": "new" })).unwrap_err().status, 0, "not \"no such starred moment\"");
        assert_eq!(remove(&f.app, &id).unwrap_err().status, 0);
        assert_eq!(list(&f.app, None).unwrap_err().status, 0, "not an empty list");
        assert_eq!(f.kept("stars"), before);
    }
}
