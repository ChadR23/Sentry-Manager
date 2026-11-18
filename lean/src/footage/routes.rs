//! The footage area's routes (index.js), field for field: vehicles and
//! shares, scan, protect, Move to trash, the Recycle Bin, cleanup policies,
//! the footage check and stars. Access (signed in, admin, the CSRF header)
//! is core's: it has checked them before `handle` is called; a route that
//! wants the password again asks `Caller::require_confirmed`, as Node.

use super::bin;
use super::ctx::{Caller, Fail, Level, Res};
use super::js;
use super::vehicles::{describe_source, Vehicle, VehicleEvent};
use crate::app::App;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

/// What a route answers.
pub enum Reply {
    Json(Value),
    /// a picture for a bin item: the file, made from a clip when `clip`
    Thumbnail { file: PathBuf, clip: bool },
}

fn ok(v: Value) -> Option<Res<Reply>> {
    Some(Ok(Reply::Json(v)))
}

fn fail<T>(f: Fail) -> Option<Res<T>> {
    Some(Err(f))
}

fn vehicle_or_404(app: &App, id: &str) -> Res<Vehicle> {
    app.vehicle(id).ok_or_else(|| Fail::new(404, "No such vehicle."))
}

macro_rules! tri {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return Some(Err(e)),
        }
    };
}

/// Send the share's events where Node sends them: status to the notifications and the
/// 'vehicles' topic; a share that becomes healthy settles its Recycle Bin, then is scanned
/// (the first scan after a start may resume from the catalog).
pub fn wire(app: &Arc<App>) {
    let weak = Arc::downgrade(app);
    app.vehicles.on_event(move |e| {
        let Some(app) = weak.upgrade() else { return };
        match e {
            VehicleEvent::Changed => app.core.announce("vehicles"),
            VehicleEvent::Status(id) => {
                if let Some(s) = app.vehicles.share(&id) {
                    app.core.share_status(&id, &s.status());
                }
                app.core.announce("vehicles");
            }
            VehicleEvent::Health(id, healthy) => {
                if !healthy {
                    return;
                }
                let a = app.clone();
                std::thread::spawn(move || {
                    // footage mounted read-only has no Recycle Bin to settle: only its scan
                    let read_only = a.vehicles.share(&id).is_some_and(|s| s.state().read_only);
                    if !read_only {
                        if let Err(e) = bin::reconcile(&a, &id) {
                            a.core.log("server", Level::Warn, &format!("Recycle Bin check of {id}: {}", e.message));
                        }
                    }
                    let light = !a.state_of(&id).is_some_and(|s| s.scanned);
                    if a.scan_now(&id, light).is_ok() {
                        a.core.announce("inventory");
                    }
                });
            }
        }
    });
}

/// index.js storageOf: days until full, from the free space and the footage a day lately.
fn storage_of(app: &App, v: &Vehicle) -> Value {
    let Some(share) = app.vehicles.share(&v.id) else { return Value::Null };
    let st = share.state();
    let (Some(free), total) = (st.free_bytes, st.total_bytes) else { return Value::Null };
    const DAY: f64 = 86_400_000.0;
    let now = js::now();
    let since = chrono::DateTime::from_timestamp_millis((now - 14.0 * DAY) as i64).map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default();
    let mut bytes = 0u64;
    let mut first: Option<String> = None;
    if let Some(inv) = app.state_of(&v.id) {
        for f in inv.file_list.iter() {
            if f.day.is_empty() || f.day < since {
                continue;
            }
            bytes += f.size;
            if first.as_ref().map_or(true, |x| f.day < *x) {
                first = Some(f.day.clone());
            }
        }
    }
    let span = match &first {
        Some(d) => {
            let t = js::day_ms(d);
            ((now - t) / DAY).round().max(1.0).min(14.0)
        }
        None => 14.0,
    };
    let per_day = bytes as f64 / if span.is_nan() { f64::NAN } else { span };
    let policy = super::policies::get(app, &v.id);
    let capped = js::truthy(policy.get("enabled"))
        && policy.get("keepDays").and_then(Value::as_object).is_some_and(|k| k.values().all(|d| d.as_f64().is_some_and(|x| x.is_finite() && x > 0.0)));
    json!({
        "free": free, "total": total, "perDay": js::num(per_day.round()),
        "daysLeft": if per_day > 0.0 { js::num((free as f64 / per_day).floor()) } else { Value::Null },
        "capped": capped
    })
}

/// index.js withCar(vehicleSummary(v))
pub fn vehicle_summary(app: &App, v: &Vehicle) -> Value {
    let mut out = app.vehicles.public_view(v);
    let security = if v.is_smb() { json!(super::smb::security_summary(v.source.get("encrypt") != Some(&Value::Bool(false)), v.source.get("version").and_then(Value::as_str).unwrap_or(""))) } else { Value::Null };
    out.insert("security".into(), security);
    let st = app.state_of(&v.id);
    out.insert("inventory".into(), st.as_ref().filter(|s| s.scanned).map_or(Value::Null, |s| super::inventory::totals(&s.recordings, s.files, s.scanned_at.unwrap_or(0.0))));
    out.insert("scanning".into(), json!(st.as_ref().is_some_and(|s| s.scanning)));
    let items = app.core.db().bin_items(Some(&v.id));
    out.insert("binBytes".into(), json!(items.iter().map(|i| i.bytes).sum::<u64>()));
    out.insert("binItems".into(), json!(items.len()));
    out.insert("policy".into(), super::policies::get(app, &v.id));
    out.insert("saved".into(), app.core.saved(&v.id));
    out.insert("storage".into(), storage_of(app, v));
    let car = match app.core.car_summary(&v.raw) {
        Value::Null => super::cars::default_summary(v.raw.get("car")),
        c => c,
    };
    out.insert("car".into(), car);
    Value::Object(out)
}

fn ids_of(body: &Value) -> Vec<String> {
    body.get("ids").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

fn say_car(c: &Value) -> String {
    let model = c["model"].as_str().unwrap_or("auto");
    if model == "auto" {
        return "Automatic".into();
    }
    let g = c["generation"].as_str().unwrap_or("auto");
    if g == "auto" {
        format!("Model {model}")
    } else {
        format!("Model {model} {}", super::cars::generation_by_id(g).map_or(g, |x| x.label))
    }
}

/// smbTest.js: mount once with the typed details, read, look for footage, try a write, unmount.
fn test_smb(app: &App, source: Option<&Value>, vehicle_id: Option<&str>) -> Res<Value> {
    let existing = vehicle_id.and_then(|id| app.vehicle(id)).map(|v| v.source);
    let prev = existing.as_ref().filter(|s| s.get("type").and_then(Value::as_str) == Some("smb"));
    let empty = json!({});
    let smb = match super::smb::normalize_smb(source.unwrap_or(&empty), prev) {
        Ok(s) => s,
        Err(e) => return Ok(json!({ "ok": false, "stage": "details", "error": e.message })),
    };
    let test_id = super::vehicles::TEST_ID;
    if app.vehicle(test_id).is_some() {
        return Ok(json!({ "ok": false, "stage": "details", "error": format!("A vehicle uses the id \"{test_id}\", which the test needs. Rename that vehicle first.") }));
    }
    {
        let mut t = app.footage.smb_test.lock().unwrap();
        if t.0 {
            return Err(Fail::new(429, "A connection test is already running. Try again in a moment."));
        }
        let now = js::now();
        t.1.retain(|x| now - x < 60_000.0);
        if t.1.len() >= 6 {
            return Err(Fail::new(429, "Too many connection tests. Try again in a minute."));
        }
        t.1.push(now);
        t.0 = true;
    }
    let started = js::now();
    let ms = || js::num((js::now() - started).trunc());
    let mounter = app.core.mounter();
    let share = smb["share"].as_str().unwrap_or("").to_string();
    let user = smb["username"].as_str().filter(|u| !u.is_empty()).unwrap_or("(guest)").to_string();
    let run = || -> Value {
        let res = match &mounter {
            Some(m) => m.mount(test_id, &smb),
            None => super::ctx::MountResult { code: -1, output: "An SMB vehicle needs a mounter.".into(), ..Default::default() },
        };
        if res.code != 0 {
            let error = if res.not_found {
                "The mount command is missing from the image (cifs-utils).".to_string()
            } else if res.timed_out {
                "The NAS did not answer (is port 445 reachable from the Docker host?).".to_string()
            } else {
                let t = super::share::tail(&res.output, 2);
                if t.is_empty() { format!("mount exited with {}", res.code) } else { t }
            };
            app.core.log("vehicles", Level::Info, &format!("SMB test of {share} as {user}: failed ({error})"));
            return json!({ "ok": false, "stage": "connect", "error": error, "hint": super::share::explain_mount_error(&res.output), "ms": ms() });
        }
        let root = mounter.as_ref().map(|m| m.target(test_id)).unwrap_or_default();
        let entries = match std::fs::read_dir(&root) {
            Ok(l) => l.count(),
            Err(e) => {
                let code = e.raw_os_error().map(super::share::errno_name).map(String::from).unwrap_or_else(|| e.to_string());
                return json!({ "ok": false, "stage": "read", "error": format!("Connected, but the share could not be read ({code})."), "ms": ms() });
            }
        };
        let clips = super::vehicles::find_clip_root(&root);
        let write = super::share::check_writable(&root);
        app.core.log("vehicles", Level::Info, &format!("SMB test of {share} as {user}: connected{}{}", if clips.is_some() { ", footage found" } else { "" }, if write.ok { "" } else { ", read-only" }));
        let footage = clips.map(|c| {
            let rel = c.strip_prefix(&root).map(|r| r.to_string_lossy().into_owned()).unwrap_or_default();
            if rel.is_empty() { ".".to_string() } else { rel }
        });
        json!({
            "ok": true, "entries": entries, "writable": write.ok, "ms": ms(),
            "writeProblem": if write.ok { Value::Null } else { json!(format!("Read-only for this account: {} failed ({}).{}", write.step.unwrap_or_default(), write.error.unwrap_or_default(), write.hint.map(|h| format!(" {h}")).unwrap_or_default())) },
            "footage": footage
        })
    };
    let out = run();
    if let Some(m) = &mounter {
        m.unmount(test_id, true);
        m.forget(test_id);
    }
    app.footage.smb_test.lock().unwrap().0 = false;
    Ok(out)
}

/// The routes of this area under /api/ (`seg`: the path after /api/, split at '/', each part
/// decoded). None: not one of them.
pub fn handle(app: &Arc<App>, who: &Caller, method: &str, seg: &[&str], query: &HashMap<String, String>, body: Option<&Value>) -> Option<Res<Reply>> {
    let empty = json!({});
    let b = body.unwrap_or(&empty);
    let qv = |k: &str| query.get(k).filter(|v| !v.is_empty()).map(String::as_str);
    match (method, seg) {
        ("GET", ["vehicles"]) => {
            let list = app.vehicles.list();
            let days: std::collections::BTreeSet<String> = list.iter().filter_map(|v| app.state_of(&v.id)).flat_map(|s| super::inventory::footage_days(&s.recordings)).collect();
            ok(json!({ "vehicles": list.iter().map(|v| vehicle_summary(app, v)).collect::<Vec<_>>(), "footageDays": days.len(), "carModels": super::cars::choices() }))
        }
        ("POST", ["vehicles", "test-smb"]) => {
            let vid = b.get("vehicleId").and_then(Value::as_str).filter(|s| !s.is_empty());
            if let Some(id) = vid {
                tri!(vehicle_or_404(app, id));
            }
            let result = tri!(test_smb(app, b.get("source"), vid));
            let share: String = b.get("source").and_then(|s| s.get("share")).filter(|s| js::truthy(Some(s))).map(js::string).unwrap_or_default()
                .chars().map(|c| if (c as u32) < 0x20 || (0x7f..=0x9f).contains(&(c as u32)) { ' ' } else { c }).collect();
            let outcome = if result["ok"] == true { "connected".to_string() } else { format!("failed ({})", js::string(&result["stage"])) };
            app.core.audit(Level::Info, &format!("SMB connection test of {}: {outcome}: {}", js::slice16(&share, 200), who.by()));
            ok(result)
        }
        ("POST", ["vehicles"]) => {
            tri!(who.require_confirmed());
            let v = tri!(app.vehicles.add(b));
            app.core.audit(Level::Info, &format!("Vehicle \"{}\" ({}) added, {}: {}", v.name, v.id, describe_source(&v.source), who.by()));
            ok(vehicle_summary(app, &v))
        }
        ("PUT", ["vehicles", id]) => {
            let before = tri!(vehicle_or_404(app, id));
            if b.get("source").is_some() {
                tri!(who.require_confirmed());
            }
            let v = tri!(app.vehicles.update(id, b));
            if before.source.to_string() != v.source.to_string() {
                let same = before.source.get("type") == v.source.get("type") && before.source.get("share") == v.source.get("share") && before.source.get("path") == v.source.get("path");
                let what = if same { describe_source(&v.source) } else { format!("{} -> {}", describe_source(&before.source), describe_source(&v.source)) };
                let pw = if before.source.get("password") != v.source.get("password") { ", new password" } else { "" };
                app.core.audit(Level::Info, &format!("Vehicle \"{}\" ({}) footage source changed: {what}{pw}: {}", v.name, v.id, who.by()));
            } else if before.name != v.name || before.timezone != v.timezone {
                app.core.audit(Level::Info, &format!("Vehicle {} renamed or time zone changed: {}", v.id, who.by()));
            }
            let (was, now) = (super::cars::normalize_car(before.raw.get("car")), super::cars::normalize_car(v.raw.get("car")));
            if was != now {
                app.core.audit(Level::Info, &format!("Vehicle {} car model: {} -> {}: {}", v.id, say_car(&was), say_car(&now), who.by()));
            }
            ok(vehicle_summary(app, &v))
        }
        ("DELETE", ["vehicles", id, "saved"]) => {
            let v = tri!(vehicle_or_404(app, id));
            let before = app.core.saved(&v.id);
            app.core.reset_saved(&v.id);
            app.core.audit(Level::Info, &format!("Space saved of \"{}\" reset (was {}, {} clips): {}", v.name, bin::format_bytes(js::number(before.get("bytes"))), js::string_or(before.get("clips"), "undefined"), who.by()));
            app.core.announce("inventory");
            ok(json!({ "ok": true, "saved": app.core.saved(&v.id) }))
        }
        ("DELETE", ["vehicles", id]) => {
            tri!(who.require_confirmed());
            let v = tri!(vehicle_or_404(app, id));
            tri!(app.vehicles.remove(id));
            super::deleted_clips::forget(app.core.db(), id);
            app.core.vehicle_removed(id);
            if let Some(Value::Object(mut rec)) = app.core.db().get("sentry-usb-record") {
                if rec.shift_remove(*id).is_some() {
                    app.core.db().set("sentry-usb-record", &Value::Object(rec));
                }
            }
            app.core.audit(Level::Info, &format!("Vehicle \"{}\" ({}) removed (its footage is untouched): {}", v.name, v.id, who.by()));
            ok(json!({ "ok": true }))
        }
        ("POST", ["vehicles", id, "reconnect"]) => {
            tri!(vehicle_or_404(app, id));
            ok(json!({ "share": app.vehicles.share(id).map_or(Value::Null, |s| s.reconnect()) }))
        }
        ("POST", ["vehicles", id, "scan"]) => {
            let v = tri!(vehicle_or_404(app, id));
            let job = app.core.job_start("scan", Some(&v.id), &format!("Refresh inventory of {}", v.name));
            let a = app.clone();
            std::thread::spawn(move || {
                match a.scan_now(&v.id, false) {
                    Ok(e) => a.core.job_finish(job, "done", &format!("{} recordings, {} files{}", e.recordings.len(), e.files, if e.error_count > 0 { format!(", {} unreadable", e.error_count) } else { String::new() }), None),
                    Err(err) => a.core.job_finish(job, "failed", &err.message, None),
                }
                a.core.announce("inventory");
            });
            ok(json!({ "ok": true, "jobId": job }))
        }
        ("POST", ["vehicles", id, "trash-days"]) => trash_days(app, who, id, b),
        ("POST", ["vehicles", id, "protect"]) => {
            let v = tri!(vehicle_or_404(app, id));
            let on = b.get("protected") != Some(&Value::Bool(false));
            let st = app.state_of(&v.id);
            let recs: Vec<_> = b.get("ids").and_then(Value::as_array).cloned().unwrap_or_default().iter()
                .filter_map(|x| x.as_str().and_then(|rid| st.as_ref()?.recordings.iter().find(|r| r.id == rid).cloned()))
                .collect();
            let rels: Vec<String> = recs.iter().flat_map(|r| r.files().map(|(f, _)| f.to_string())).collect();
            bin::set_protected(app, &v.id, &rels, on);
            app.rebuild(&v.id, None);
            app.core.announce("inventory");
            ok(json!({ "ok": true, "count": recs.len() }))
        }
        ("POST", ["vehicles", id, "trash"]) => {
            tri!(vehicle_or_404(app, id));
            let recs: HashMap<String, Vec<String>> = app.state_of(id).map(|s| s.recordings.iter().map(|r| (r.id.clone(), r.files().map(|(f, _)| f.to_string()).collect())).collect()).unwrap_or_default();
            let out = tri!(bin::trash(app, id, &ids_of(b), "manual"));
            let mut v = out.json();
            // "Also delete its CAN data": the logs of the moved recordings' minutes go now, for good
            if b.get("withCan") == Some(&Value::Bool(true)) && !out.moved.is_empty() {
                let rels: Vec<String> = out.moved.iter().flat_map(|m| recs.get(m).cloned().unwrap_or_default()).collect();
                if let Some(c) = app.core.can_delete_with(id, &rels, None, &who.by()) {
                    v["can"] = c;
                }
                app.core.announce("can");
            }
            app.core.announce("inventory");
            app.core.announce("bin");
            ok(v)
        }
        ("POST", ["vehicles", id, "trash-preview"]) => {
            tri!(vehicle_or_404(app, id));
            let wanted = ids_of(b);
            let recs: Vec<_> = app.state_of(id).map(|s| s.recordings.iter().filter(|r| wanted.contains(&r.id) && !r.protected).cloned().collect()).unwrap_or_default();
            let rels: Vec<String> = recs.iter().flat_map(|r| r.files().map(|(f, _)| f.to_string())).collect();
            let can = if recs.is_empty() { Value::Null } else { app.core.can_with(id, &rels, None).unwrap_or(Value::Null) };
            ok(json!({ "recordings": recs.len(), "can": can }))
        }
        ("GET", ["bin", item, "thumbnail"]) => {
            let Some(it) = app.core.db().bin_item(item) else { return fail(Fail::new(404, "No thumbnail")) };
            tri!(vehicle_or_404(app, &it.vehicle_id));
            let Some((kind, abs)) = bin::thumbnail_source(app, item) else { return fail(Fail::new(404, "No thumbnail")) };
            let roots: Vec<PathBuf> = app.vehicles.list().into_iter().map(|v| v.root).collect();
            let Some(real) = crate::media::resolve_inside(&abs.to_string_lossy(), &roots) else { return fail(Fail::new(404, "No thumbnail")) };
            Some(Ok(Reply::Thumbnail { file: real, clip: kind == "clip" }))
        }
        ("GET", ["bin"]) => ok(json!({ "items": bin::list(app, qv("vehicle")) })),
        ("POST", ["bin", item, "restore"]) => {
            let out = tri!(bin::restore(app, item));
            app.core.announce("bin");
            app.core.announce("inventory");
            ok(out)
        }
        ("POST", ["bin", "empty"]) => {
            if b.get("confirm") != Some(&Value::Bool(true)) {
                return fail(Fail::new(400, "Confirm emptying the Recycle Bin."));
            }
            tri!(who.require_confirmed());
            let vid = if js::truthy(b.get("vehicle")) { Some(js::string(&b["vehicle"])) } else { None };
            if let Some(v) = &vid {
                tri!(vehicle_or_404(app, v));
            }
            let out = bin::empty(app, vid.as_deref());
            app.core.audit(Level::Info, &format!("Recycle Bin emptied{}: {} item(s), {}: {}", vid.as_ref().map(|v| format!(" for {v}")).unwrap_or_default(), out["deleted"], bin::format_bytes(js::number(out.get("bytes"))), who.by()));
            app.core.announce("bin");
            ok(out)
        }
        ("POST", ["bin", item, "delete"]) => {
            if b.get("confirm") != Some(&Value::Bool(true)) {
                return fail(Fail::new(400, "Confirm permanent deletion."));
            }
            tri!(who.require_confirmed());
            let label = app.core.db().bin_item(item).map(|i| i.label).filter(|l| !l.is_empty()).unwrap_or_else(|| item.to_string());
            let bytes = tri!(bin::delete_forever(app, item));
            app.core.audit(Level::Info, &format!("Deleted forever from the Recycle Bin: {label} ({}): {}", bin::format_bytes(bytes as f64), who.by()));
            app.core.announce("bin");
            ok(json!({ "bytes": bytes }))
        }
        ("GET", ["vehicles", id, "policy"]) => {
            let v = tri!(vehicle_or_404(app, id));
            ok(json!({ "policy": super::policies::get(app, &v.id), "preview": super::policies::preview(app, id) }))
        }
        ("PUT", ["vehicles", id, "policy"]) => {
            let policy = tri!(super::policies::set(app, id, b));
            ok(json!({ "policy": policy, "preview": super::policies::preview(app, id) }))
        }
        ("POST", ["vehicles", id, "policy", "run"]) => {
            tri!(vehicle_or_404(app, id));
            let expect = b.get("expect").filter(|e| e.is_object() || e.is_array());
            let out = tri!(super::policies::run(app, id, expect));
            app.core.announce("inventory");
            app.core.announce("bin");
            ok(out)
        }
        ("GET", ["vehicles", id, "integrity"]) => {
            let v = tri!(vehicle_or_404(app, id));
            ok(super::integrity::results(app, &v.id))
        }
        ("POST", ["vehicles", id, "integrity"]) => {
            let v = tri!(vehicle_or_404(app, id));
            if !app.state_of(&v.id).is_some_and(|s| s.scanned) {
                tri!(app.scan_now(&v.id, false));
            }
            ok(super::integrity::start(app, &v.id))
        }
        ("GET", ["stars"]) => ok(super::stars::list(app, qv("vehicle"))),
        ("POST", ["stars"]) => Some(super::stars::add(app, who, b).map(Reply::Json)),
        ("PATCH", ["stars", id]) => Some(super::stars::edit(app, id, b).map(Reply::Json)),
        ("DELETE", ["stars", id]) => Some(super::stars::remove(app, id).map(Reply::Json)),
        _ => None,
    }
}

/// "Delete this day" / "Delete through this date": the day's recordings (or that day's and
/// every older one's) go to the Recycle Bin, protected ones stay; preview only counts them.
fn trash_days(app: &Arc<App>, who: &Caller, id: &str, b: &Value) -> Option<Res<Reply>> {
    let v = tri!(vehicle_or_404(app, id));
    let day = if js::truthy(b.get("day")) { js::string(&b["day"]) } else { String::new() };
    if !super::is_day_shape(&day) {
        return fail(Fail::new(400, "Choose a day."));
    }
    let through = js::truthy(b.get("through"));
    let category = b.get("category").filter(|c| js::truthy(Some(c)) && c.as_str() != Some("all"));
    let st = app.state_of(&v.id);
    let list: Vec<_> = st.as_ref().map(|s| s.recordings.iter().filter(|r| category.map_or(true, |c| c.as_str() == Some(r.category))).filter(|r| if through { r.day <= day } else { r.day == day }).cloned().collect()).unwrap_or_default();
    let movable: Vec<_> = list.iter().filter(|r| !r.protected).cloned().collect();
    let mut summary = Map::new();
    summary.insert("recordings".into(), json!(movable.len()));
    summary.insert("bytes".into(), json!(movable.iter().map(|r| r.bytes).sum::<u64>()));
    summary.insert("protected".into(), json!(list.len() - movable.len()));
    summary.insert("days".into(), json!(movable.iter().map(|r| r.day.as_str()).collect::<std::collections::HashSet<_>>().len()));
    summary.insert("oldest".into(), if movable.is_empty() { Value::Null } else { json!(movable.iter().map(|r| r.day.as_str()).fold(day.as_str(), |a, x| if x < a { x } else { a })) });
    let until = through.then(|| {
        let n: Vec<i64> = day.split('-').map(|x| x.parse().unwrap_or(0)).collect();
        super::tz::zoned_to_utc(n[0] as i32, n[1] as u32, n[2] as u32, 23, 59, 59, &v.timezone) + 1000.0
    });
    let rels: Vec<String> = movable.iter().flat_map(|r| r.files().map(|(f, _)| f.to_string())).collect();
    if b.get("preview") == Some(&Value::Bool(true)) || movable.is_empty() {
        let can = if movable.is_empty() { Value::Null } else { app.core.can_with(&v.id, &rels, until).unwrap_or(Value::Null) };
        summary.insert("can".into(), can);
        summary.insert("started".into(), json!(false));
        return ok(Value::Object(summary));
    }
    let with_can = b.get("withCan") == Some(&Value::Bool(true));
    let ids: Vec<String> = movable.iter().map(|r| r.id.clone()).collect();
    let files: HashMap<String, Vec<String>> = movable.iter().map(|r| (r.id.clone(), r.files().map(|(f, _)| f.to_string()).collect())).collect();
    let a = app.clone();
    let by = who.by();
    std::thread::spawn(move || {
        match bin::trash(&a, &v.id, &ids, "manual") {
            Ok(out) => {
                // only when footage really moved, and only the minutes of the recordings that did
                if with_can && !out.moved.is_empty() {
                    let rels: Vec<String> = out.moved.iter().flat_map(|m| files.get(m).cloned().unwrap_or_default()).collect();
                    if let Some(r) = a.core.can_delete_with(&v.id, &rels, until, &by) {
                        a.core.log("server", Level::Info, &format!("CAN data with {}'s footage: {r}", v.name));
                    }
                    a.core.announce("can");
                }
            }
            Err(e) => a.core.log("server", Level::Warn, &format!("Moving {}'s footage to the Recycle Bin failed: {}", v.name, e.message)),
        }
        a.core.announce("inventory");
        a.core.announce("bin");
    });
    summary.insert("started".into(), json!(true));
    ok(Value::Object(summary))
}
