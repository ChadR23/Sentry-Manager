//! Live CAN stats for a Stream Deck (server/canNow.js, GET /api/can/now and the Stream Deck
//! link): the ports of test/canNow.test.js that make sense here (the pure stats are tested in
//! src/can/now.rs), and the CAN index's newest-first order (server/canIndex.js, edb6989).

use axum::body::Bytes;
use axum::http::{HeaderMap, Method};
use http_body_util::BodyExt;
use sentry_lean::can::ctx::{CanCtx, Car, Scan, Who};
use sentry_lean::can::index::CanIndex;
use sentry_lean::can::now::{latest_stats, stat_ids};
use sentry_lean::can::routes::{Can, Req, Res};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

fn tmp(tag: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let d = std::env::temp_dir().join(format!("can-now-{}-{}-{}", std::process::id(), tag, N.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

const T0: f64 = 1_794_852_000_000.0; // Date.UTC(2026, 10, 16, 18, 0, 0)

/// test/canNow.test.js line(): a candump line
fn line(ms: f64, id: &str, payload: &str) -> String {
    let ms = ms as i64;
    format!("({}.{:06}) can0 {}#{}", ms.div_euclid(1000), ms.rem_euclid(1000) * 1000, id, payload)
}
/// 0x132 with BattVoltage132 (0.01 V)
fn volts(ms: f64, v: f64) -> String {
    let raw = (v / 0.01).round() as u16;
    let b = [raw as u8, (raw >> 8) as u8, 0, 0, 0, 0, 0, 0];
    line(ms, "132", &b.iter().map(|x| format!("{:02X}", x)).collect::<String>())
}
fn xz(text: &str) -> Vec<u8> {
    use std::io::Write;
    let mut child = std::process::Command::new("xz").args(["-1", "-c"]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
    child.stdin.take().unwrap().write_all(text.as_bytes()).unwrap();
    child.wait_with_output().unwrap().stdout
}
fn has_xz() -> bool {
    std::process::Command::new("xz").arg("--version").output().is_ok_and(|o| o.status.success())
}
fn stamp(ms: f64) -> String {
    let iso = sentry_lean::can::tz::iso(ms as i64);
    format!("{}Z", iso.replace(['-', ':'], "").split('.').next().unwrap())
}

#[test]
fn from_a_real_can_index_the_newest_minutes_values() {
    if !has_xz() {
        eprintln!("skipped: needs xz");
        return;
    }
    let base = tmp("real");
    let name = "K_20261116T180000Z_1.log.xz";
    std::fs::create_dir_all(base.join("can/K")).unwrap();
    let lines: Vec<String> = (0..100).map(|i| volts(T0 + i as f64 * 1000.0, 370.0 + i as f64 * 0.1)).collect();
    std::fs::write(base.join("can/K").join(name), xz(&format!("{}\n", lines.join("\n")))).unwrap();
    let index = CanIndex::new(base.join("can"), base.join("idx"));
    index.index_log("K", name, false, None, None).unwrap();
    let got = latest_stats(&index, "K", false, T0 + 100_000.0).unwrap();
    assert_eq!(got.at, T0 + 99_000.0);
    assert_eq!(got.stats.iter().find(|s| s.id == "batteryVoltage").unwrap().value, json!(380), "the last frame (379.9 V, shown whole)");
    let _ = std::fs::remove_dir_all(&base);
}

// 'a fresh log is indexed at once even while the converter runs; an old one waits for an idle moment'
#[test]
fn a_fresh_log_goes_first_and_does_not_wait_for_the_converter() {
    if !has_xz() {
        eprintln!("skipped: needs xz");
        return;
    }
    let base = tmp("fresh");
    std::fs::create_dir_all(base.join("can/K")).unwrap();
    let now = (sentry_lean::can::util::now_ms() / 60_000.0).floor() * 60_000.0 - 60_000.0;
    let old = 1_767_254_400_000.0; // Date.UTC(2026, 0, 1, 8, 0, 0)
    let write = |t: f64, n: u32| {
        let lines: Vec<String> = (0..20).map(|i| volts(t + i as f64 * 1000.0, 360.0 + n as f64)).collect();
        let name = format!("K_{}_{}.log.xz", stamp(t), n);
        std::fs::write(base.join("can/K").join(&name), xz(&format!("{}\n", lines.join("\n")))).unwrap();
    };
    write(old, 1);
    write(now, 2);
    let converting = Arc::new(AtomicBool::new(true));
    let mut idx = CanIndex::new(base.join("can"), base.join("idx"));
    let c = converting.clone();
    idx.idle = Box::new(move || !c.load(Ordering::SeqCst));
    idx.auto_repack = false;
    let index = Arc::new(idx);
    index.kick();
    let end = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut got = None;
    while std::time::Instant::now() < end {
        got = latest_stats(&*index, "K", false, sentry_lean::can::util::now_ms());
        if got.is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let got = got.expect("the fresh log was indexed while \"converting\"");
    assert_eq!(got.stats.iter().find(|s| s.id == "batteryVoltage").unwrap().value, json!(362));
    let minutes = || index.minute_times("K", f64::NEG_INFINITY, f64::INFINITY);
    assert!(minutes().iter().all(|t| *t >= now - 3600_000.0), "the old one still waits");
    converting.store(false, Ordering::SeqCst); // the conversion done: the old one goes too
    index.settled();
    assert!(minutes().iter().any(|t| *t < now - 3600_000.0));
    let _ = std::fs::remove_dir_all(&base);
}

// ---- the routes, on a CAN area with a stand-in for core
struct TestCtx {
    data: PathBuf,
    settings: Mutex<HashMap<String, Value>>,
    /// the settings fail to read and to keep (manager.db busy, read-only or damaged)
    fail: AtomicBool,
    /// only the key-to-car map (can-vehicles) fails to read
    fail_map: AtomicBool,
    audit: Mutex<Vec<String>>,
    tls: Option<Value>,
}
impl CanCtx for TestCtx {
    fn data_dir(&self) -> PathBuf {
        self.data.clone()
    }
    fn setting(&self, key: &str) -> Result<Option<Value>, String> {
        if self.fail.load(Ordering::SeqCst) || (self.fail_map.load(Ordering::SeqCst) && key == "can-vehicles") {
            return Err("manager.db: database is locked".into());
        }
        Ok(self.settings.lock().unwrap().get(key).cloned().filter(|v| !v.is_null()))
    }
    fn set_setting(&self, key: &str, value: Value) -> Result<(), String> {
        if self.fail.load(Ordering::SeqCst) {
            return Err("manager.db: attempt to write a readonly database".into());
        }
        self.settings.lock().unwrap().insert(key.to_string(), value);
        Ok(())
    }
    fn vehicles(&self) -> Vec<Car> {
        vec![Car { id: "daily-driver".into(), name: "Daily Driver".into(), timezone: String::new(), root: None, studio_root: None, car: None }]
    }
    fn scan_of(&self, _: &str) -> Option<Scan> {
        None
    }
    fn rescan(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn announce(&self, _: &str) {}
    fn audit(&self, level: &str, line: &str) {
        self.audit.lock().unwrap().push(format!("{level}: {line}"));
    }
    fn log(&self, _: &str, _: &str) {}
    fn tls_status(&self) -> Option<Value> {
        self.tls.clone()
    }
    fn ca_pem(&self) -> Option<Vec<u8>> {
        self.tls.as_ref().map(|_| b"-----BEGIN CERTIFICATE-----\n".to_vec())
    }
    fn app_root(&self) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
    }
}

fn req(method: Method, path: &str, admin: bool) -> Req {
    Req {
        method,
        path: path.into(),
        query: HashMap::new(),
        headers: HeaderMap::new(),
        body: Bytes::new(),
        remote: "127.0.0.1".into(),
        local_port: 9000,
        encrypted: true,
        who: Who { by: "admin from 127.0.0.1".into(), owner: "admin".into(), admin_here: admin },
        confirmed: false,
        closed: Arc::new(AtomicBool::new(false)),
    }
}
fn body(res: Res) -> (u16, HeaderMap, Vec<u8>) {
    let status = res.status().as_u16();
    let headers = res.headers().clone();
    let b = futures_util::FutureExt::now_or_never(res.into_body().collect()).unwrap().unwrap().to_bytes().to_vec();
    (status, headers, b)
}
fn json_of(b: &[u8]) -> Value {
    serde_json::from_slice(b).unwrap()
}

#[test]
fn the_link_off_until_made_only_with_its_token_plain_text_per_stat() {
    let data = tmp("routes");
    let ctx = Arc::new(TestCtx { data: data.clone(), settings: Mutex::new(HashMap::new()), audit: Mutex::new(Vec::new()), tls: None, fail: AtomicBool::new(false), fail_map: AtomicBool::new(false) });
    let can = Can::new(ctx.clone());
    let now = |path: &str, query: Option<&str>, auth: Option<&str>| body(can.now_answer(&Method::GET, path, query, auth));
    let (s, h, b) = now("/api/can/now", Some("token=x"), None);
    assert_eq!(s, 404, "off: not found");
    assert_eq!(json_of(&b), json!({ "error": "Not found" }));
    assert_eq!(h["access-control-allow-origin"], "*");
    let made = body(can.handle(&req(Method::POST, "/api/can/stream-deck", true)).unwrap());
    assert_eq!(made.0, 200);
    let made = json_of(&made.2);
    let token = made["token"].as_str().unwrap().to_string();
    assert_eq!(token.len(), 32);
    assert!(made["stats"].as_array().unwrap().iter().any(|s| s["id"] == "battery"));
    assert_eq!(made["pin"], Value::Null, "no pin without HTTPS of its own");
    assert_eq!(ctx.audit.lock().unwrap().last().unwrap(), "warn: Stream Deck link made (new token; any older link stops working): admin from 127.0.0.1");
    let tok = format!("token={}", token);
    let (s, h, b) = now("/api/can/now", None, None);
    assert_eq!((s, String::from_utf8(b).unwrap()), (401, "Token required (Nerd panel → Stream Deck)".to_string()), "no token");
    assert_eq!(h["content-type"], "text/plain; charset=utf-8");
    assert_eq!(now("/api/can/now", Some("token=wrong"), None).0, 401);
    let (s, _, b) = now("/api/can/now", Some(&tok), None);
    assert_eq!(s, 200);
    assert_eq!(json_of(&b), json!({ "car": null, "at": null, "stale": true, "units": "mi", "stats": {} }), "no CAN data yet");
    assert_eq!(String::from_utf8(now("/api/can/now/battery", Some(&tok), None).2).unwrap(), "—");
    assert_eq!(now("/api/can/now/battery", None, Some(&format!("Bearer {}", token))).0, 200, "or as a Bearer header");
    let (s, _, b) = now("/api/can/now/nope", Some(&tok), None);
    assert_eq!(s, 404);
    assert_eq!(json_of(&b)["error"], format!("No stat \"nope\". Stats: {}", stat_ids().join(", ")));
    assert_eq!(now("/api/can/now/%E0", Some(&tok), None).0, 500, "decodeURIComponent throws");
    assert_eq!(now("/api/can/now/ca.crt", None, None).0, 404, "no local certificate authority");
    assert_eq!(body(can.now_answer(&Method::POST, "/api/can/now", Some(&tok), None)).0, 405);
    let got = json_of(&body(can.handle(&req(Method::GET, "/api/can/stream-deck", true)).unwrap()).2);
    assert_eq!(got["enabled"], true);
    // the plugin: the files under assets/streamdeck, zipped
    let (s, h, zip) = body(can.handle(&req(Method::GET, "/api/can/stream-deck/plugin", true)).unwrap());
    assert_eq!(s, 200);
    assert_eq!(h["content-disposition"], "attachment; filename=\"Sentry_Six_CAN_Stats.streamDeckPlugin\"");
    assert_eq!(h["content-type"], "application/octet-stream");
    let names: Vec<String> = sentry_lean::ui::zip::read_zip(&zip, &Default::default()).unwrap().into_iter().map(|e| e.name).collect();
    for f in ["manifest.json", "bin/plugin.js", "stats.js", "pi.html", "images/key@2x.png"] {
        assert!(names.contains(&format!("com.sentrysix.canstats.sdPlugin/{}", f)), "{:?}", names);
    }
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted, "in name order");
    // only an admin here
    let (s, _, b) = body(can.handle(&req(Method::GET, "/api/can/stream-deck/plugin", false)).unwrap());
    assert_eq!((s, json_of(&b)["error"].clone()), (403, json!("Only an admin can download the Stream Deck plugin.")));
    let (s, _, b) = body(can.handle(&req(Method::GET, "/api/can/stream-deck", false)).unwrap());
    assert_eq!((s, json_of(&b)["error"].clone()), (403, json!("Only an admin can manage the Stream Deck link.")));
    // a new link: the old token stops
    let again = json_of(&body(can.handle(&req(Method::POST, "/api/can/stream-deck", true)).unwrap()).2);
    assert_eq!(now("/api/can/now", Some(&tok), None).0, 401);
    assert_eq!(now("/api/can/now", Some(&format!("token={}", again["token"].as_str().unwrap())), None).0, 200);
    assert_eq!(json_of(&body(can.handle(&req(Method::DELETE, "/api/can/stream-deck", true)).unwrap()).2), json!({ "enabled": false }));
    assert_eq!(ctx.audit.lock().unwrap().last().unwrap(), "warn: Stream Deck link turned off: admin from 127.0.0.1");
    assert_eq!(now("/api/can/now", Some(&format!("token={}", again["token"].as_str().unwrap())), None).0, 404, "off again");
    let _ = std::fs::remove_dir_all(&data);
}

#[test]
fn the_pin_follows_the_certificate() {
    let pin = |tls: Value| {
        let data = tmp("pin");
        let ctx = Arc::new(TestCtx { data: data.clone(), settings: Mutex::new(HashMap::new()), audit: Mutex::new(Vec::new()), tls: Some(tls), fail: AtomicBool::new(false), fail_map: AtomicBool::new(false) });
        let can = Can::new(ctx);
        let got = json_of(&body(can.handle(&req(Method::GET, "/api/can/stream-deck", true)).unwrap()).2);
        let _ = std::fs::remove_dir_all(&data);
        got["pin"].clone()
    };
    assert_eq!(pin(json!({ "mode": "local-ca", "ca": { "fingerprint": "AB:CD" }, "certificate": { "fingerprint": "11:22" } })), json!("ca:abcd"));
    assert_eq!(pin(json!({ "mode": "own", "certificate": { "fingerprint": "11:22" }, "ca": null })), json!("cert:1122"));
    assert_eq!(pin(json!({ "mode": "acme", "serving": "acme", "ca": { "fingerprint": "AB" } })), Value::Null, "Let's Encrypt: trusted everywhere");
    assert_eq!(pin(json!({ "mode": "acme", "serving": "self-signed", "ca": { "fingerprint": "AB" } })), json!("ca:ab"), "until it is issued");
}

#[test]
fn answers_from_the_index_with_the_car_and_the_cache() {
    if !has_xz() {
        eprintln!("skipped: needs xz");
        return;
    }
    let data = tmp("answers");
    let name = "K_20261116T180000Z_1.log.xz";
    std::fs::create_dir_all(data.join("can/K")).unwrap();
    let lines: Vec<String> = (0..10).map(|i| volts(T0 + i as f64 * 1000.0, 380.0)).collect();
    std::fs::write(data.join("can/K").join(name), xz(&format!("{}\n", lines.join("\n")))).unwrap();
    let ctx = Arc::new(TestCtx { data: data.clone(), settings: Mutex::new(HashMap::new()), audit: Mutex::new(Vec::new()), tls: None, fail: AtomicBool::new(false), fail_map: AtomicBool::new(false) });
    let can = Can::new(ctx.clone());
    can.index.index_log("K", name, false, None, None).unwrap();
    let token = json_of(&body(can.handle(&req(Method::POST, "/api/can/stream-deck", true)).unwrap()).2)["token"].as_str().unwrap().to_string();
    let ask = |q: &str| body(can.now_answer(&Method::GET, "/api/can/now", Some(&format!("token={}&{}", token, q)), None));
    let a = json_of(&ask("units=km").2);
    assert_eq!(a["car"], "Daily Driver", "the only car");
    assert_eq!(a["at"], "2026-11-16T18:00:09.000Z");
    assert_eq!(a["stale"], true);
    assert_eq!(a["units"], "km");
    assert_eq!(a["stats"]["batteryVoltage"], json!({ "label": "Battery voltage", "value": 380, "unit": "V", "text": "380 V" }));
    let keys: Vec<&String> = a.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["car", "at", "ageSec", "stale", "units", "stats"]);
    for car in ["daily driver", "DAILY-DRIVER", "k", " K "] {
        assert_eq!(json_of(&ask(&format!("car={}", car)).2)["at"], "2026-11-16T18:00:09.000Z", "{car}");
    }
    assert_eq!(json_of(&ask("car=nope").2)["at"], Value::Null);
    assert_eq!(String::from_utf8(body(can.now_answer(&Method::GET, "/api/can/now/batteryVoltage.txt", Some(&format!("token={}", token)), None)).2).unwrap(), "380 V");
    assert_eq!(String::from_utf8(ask("stat=batteryVoltage").2).unwrap(), "380 V");
    // worked out at most every 3 s: a new minute shows only after that
    let more: Vec<String> = (0..10).map(|i| volts(T0 + 60_000.0 + i as f64 * 1000.0, 390.0)).collect();
    let name2 = "K_20261116T180100Z_2.log.xz";
    std::fs::write(data.join("can/K").join(name2), xz(&format!("{}\n", more.join("\n")))).unwrap();
    can.index.index_log("K", name2, false, None, None).unwrap();
    assert_eq!(String::from_utf8(ask("stat=batteryVoltage").2).unwrap(), "380 V", "from the cache");
    std::thread::sleep(std::time::Duration::from_millis(3100));
    assert_eq!(String::from_utf8(ask("stat=batteryVoltage").2).unwrap(), "390 V");
    let _ = std::fs::remove_dir_all(&data);
}

#[test]
fn a_link_setting_that_cannot_be_read_or_kept_answers_500_not_off_and_is_not_made() {
    let data = tmp("unreadable");
    let ctx = Arc::new(TestCtx { data: data.clone(), settings: Mutex::new(HashMap::new()), audit: Mutex::new(Vec::new()), tls: None, fail: AtomicBool::new(false), fail_map: AtomicBool::new(false) });
    let can = Can::new(ctx.clone());
    let token = json_of(&body(can.handle(&req(Method::POST, "/api/can/stream-deck", true)).unwrap()).2)["token"].as_str().unwrap().to_string();
    let audits = ctx.audit.lock().unwrap().len();
    ctx.fail.store(true, Ordering::SeqCst);
    let (s, _, b) = body(can.now_answer(&Method::GET, "/api/can/now", Some(&format!("token={token}")), None));
    assert_eq!((s, json_of(&b)), (500, json!({ "error": "Internal error" })), "not 404 (off)");
    for (method, what) in [(Method::POST, "made"), (Method::DELETE, "turned off"), (Method::GET, "shown")] {
        let (s, _, b) = body(can.handle(&req(method, "/api/can/stream-deck", true)).unwrap());
        assert_eq!((s, json_of(&b)), (500, json!({ "error": "Internal error" })), "{what}");
    }
    assert_eq!(ctx.audit.lock().unwrap().len(), audits, "no audit line for a change that was not made");
    ctx.fail.store(false, Ordering::SeqCst);
    let (s, _, _) = body(can.now_answer(&Method::GET, "/api/can/now", Some(&format!("token={token}")), None));
    assert_eq!(s, 200, "the link made before still works");
    let _ = std::fs::remove_dir_all(&data);
}

#[test]
fn routes_that_need_the_key_to_car_map_answer_500_when_it_cannot_be_read() {
    if !has_xz() {
        eprintln!("skipped: needs xz");
        return;
    }
    let data = tmp("unmapped");
    let name = "K_20261116T180000Z_1.log.xz";
    std::fs::create_dir_all(data.join("can/K")).unwrap();
    let lines: Vec<String> = (0..10).map(|i| volts(T0 + i as f64 * 1000.0, 380.0)).collect();
    std::fs::write(data.join("can/K").join(name), xz(&format!("{}\n", lines.join("\n")))).unwrap();
    let ctx = Arc::new(TestCtx { data: data.clone(), settings: Mutex::new(HashMap::new()), audit: Mutex::new(Vec::new()), tls: None, fail: AtomicBool::new(false), fail_map: AtomicBool::new(false) });
    let can = Can::new(ctx.clone());
    can.index.index_log("K", name, false, None, None).unwrap();
    let token = json_of(&body(can.handle(&req(Method::POST, "/api/can/stream-deck", true)).unwrap()).2)["token"].as_str().unwrap().to_string();
    let get = |path: &str, query: &[(&str, &str)]| {
        let mut r = req(Method::GET, path, true);
        r.query = query.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        body(can.handle(&r).unwrap())
    };
    let routes: Vec<(&str, Vec<(&str, &str)>)> = vec![
        ("/api/can/vehicle-signals", vec![("vehicle", "daily-driver")]),
        ("/api/can/search", vec![("vehicle", "daily-driver")]),
        ("/api/can/id-events", vec![("vehicle", "daily-driver")]),
        ("/api/can/files", vec![]),
        ("/api/can/export/new-ids", vec![("key", "K"), ("since", "2026-11-16")]),
    ];
    let now = || body(can.now_answer(&Method::GET, "/api/can/now", Some(&format!("token={token}&car=daily-driver")), None));
    for (path, q) in &routes {
        assert_ne!(get(path, q).0, 500, "{path} while the map reads");
    }
    assert_eq!(json_of(&now().2)["car"], "Daily Driver");
    ctx.fail_map.store(true, Ordering::SeqCst);
    for (path, q) in &routes {
        let (s, _, b) = get(path, q);
        assert_eq!((s, json_of(&b)), (500, json!({ "error": "Internal error" })), "{path}: not an answer worked out without the map");
    }
    let (s, _, b) = now();
    assert_eq!((s, json_of(&b)), (500, json!({ "error": "Internal error" })), "not another car's numbers, nor without its name");
    let _ = std::fs::remove_dir_all(&data);
}

#[test]
fn without_a_car_filter_or_numbers_to_name_a_car_for_the_map_is_not_read() {
    let data = tmp("now-no-map");
    let ctx = Arc::new(TestCtx { data: data.clone(), settings: Mutex::new(HashMap::new()), audit: Mutex::new(Vec::new()), tls: None, fail: AtomicBool::new(false), fail_map: AtomicBool::new(false) });
    let can = Can::new(ctx.clone());
    let token = json_of(&body(can.handle(&req(Method::POST, "/api/can/stream-deck", true)).unwrap()).2)["token"].as_str().unwrap().to_string();
    ctx.fail_map.store(true, Ordering::SeqCst);
    let now = |path: &str, more: &str| body(can.now_answer(&Method::GET, path, Some(&format!("token={token}{more}")), None));
    let (s, _, b) = now("/api/can/now", "");
    assert_eq!((s, json_of(&b)), (200, json!({ "car": null, "at": null, "stale": true, "units": "mi", "stats": {} })), "no CAN data: nothing to name");
    assert_eq!(now("/api/can/now/nope", "").0, 404, "an unknown stat");
    assert_eq!(now("/api/can/now", "&car=daily-driver").0, 500, "a car filter needs the map");
    let _ = std::fs::remove_dir_all(&data);
}

#[test]
fn tags_a_car_summary_and_a_preview_are_errors_without_the_map_and_a_real_delete_says_why_it_skipped() {
    let data = tmp("map-unread");
    let ctx = Arc::new(TestCtx { data: data.clone(), settings: Mutex::new(HashMap::new()), audit: Mutex::new(Vec::new()), tls: None, fail: AtomicBool::new(false), fail_map: AtomicBool::new(false) });
    let can = Can::new(ctx.clone());
    let car = ctx.vehicles().remove(0);
    let rels = vec!["TeslaCam/RecentClips/2026-11-16_18-00-00-front.mp4".to_string()];
    assert!(can.has_can(&car).is_ok() && can.car_summary(&car).is_ok());
    assert!(can.prune.preview_with("daily-driver", &rels, None).is_ok());
    ctx.fail_map.store(true, Ordering::SeqCst);
    assert!(can.has_can(&car).is_err(), "not recordings shown without their tags");
    assert!(can.car_summary(&car).is_err(), "not a car shown without what was detected of it");
    assert!(can.prune.preview_with("daily-driver", &rels, None).is_err(), "not a count worked out without the keys");
    let real = can.prune.delete_with("daily-driver", &rels, None, "admin", false);
    assert_eq!(real["skip"], "the CAN settings could not be read", "the footage moved already: its answer says why the logs stay");
    let _ = std::fs::remove_dir_all(&data);
}
