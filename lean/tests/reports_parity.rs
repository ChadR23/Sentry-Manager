//! The Rust report client against the Node code it ports, on the same input:
//!   - the scrubber (server/reportsScrub.js cleanReport), anonymous or not;
//!   - the payload schema (reportsProtocol.js validatePayload);
//!   - the heartbeat block (reports.js normalizeHeartbeat);
//!   - and the whole round trip against the tests' local fake receiver
//!     (test/fixtures/reportsReceiver.js, on 127.0.0.1): it checks the body,
//!     the proof of work and the signature, opens the sealed report with the
//!     Node code and validates it, so a report the Rust client makes is one
//!     the developers' receiver takes.
//!
//! Nothing is ever sent anywhere but 127.0.0.1. Skipped when node is missing.

use sentry_lean::ops::net::{HttpReq, HttpRes, Https, Transport};
use sentry_lean::ops::reports::{scrub, Reports};
use sentry_lean::ops::testing::FakeCtx;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;

fn node() -> bool {
    let ok = Command::new("node").arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
    if !ok {
        eprintln!("skipped: node is needed for the Node side");
    }
    ok
}

fn script() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("parity/reports.js")
}

fn node_says(mode: &str, input: &Value) -> Value {
    let mut c = Command::new("node").arg(script()).arg(mode).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    c.stdin.take().unwrap().write_all(input.to_string().as_bytes()).unwrap();
    let out = c.wait_with_output().unwrap();
    assert!(out.status.success());
    serde_json::from_slice(&out.stdout).unwrap()
}

#[test]
fn the_scrubber_answers_as_node() {
    if !node() {
        return;
    }
    let ids: Vec<Value> = ["tower", "Daily Driver", "veh-abc123", "/footage/daily", "bob", "SentryPi", "Home WiFi", "Mom's house", "nas", "ab", "x.y"].iter().map(|s| json!(s)).collect();
    let texts = [
        "from 192.168.1.50:445 ok",
        "peer ::ffff:10.1.2.3 and fe80::1%eth0 and 2001:db8::8a2e:370:7334",
        "mac 00:1A:2B:3C:4D:5E / 00-1a-2b-3c-4d-5e / 00:1a-2b:3c:4d:5e",
        "car 5YJ3E1EA7KF123456 and LRW3E7EK1NC123456 and 7SAYGDEE1PA123456 and 5YJ3E1EA7KF12345",
        "mail bob.smith+x@example.co.uk now, x@y.z, a@b.co",
        "at 30.267153, -97.743057 today; 1.5, 2.25; lat=30.1 lng: -97",
        "{\"lat\":30.2672,\"lon\":-97.7431,\"latitude\": 1}",
        "share \\\\nas\\TeslaCam\\RecentClips and //nas2/cam and smb://bob:pw@host/x",
        "host pi.local and tower.lan and car.tail1234.ts.net and fritz.box and x.home.arpa",
        "fetch https://my-ddns.example.net/x failed, https://github.com/a ok, http://[fe80::1]:80/ ws://10.0.0.1/",
        "2026-11-11T18:20:30.000Z at 12:30:00 node v26.13.0 ffmpeg version 7.1.1 kernel 6.18.44-fc-v378 sha 1345348 Build 130 a 1:2 ratio",
        "Error: x\n    at foo (/app/server/index.js:12:5)\n    at read (/footage/daily/x.js:1:1)",
        "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----\nafter",
        "mount //nas/share -o username=bob,password=s3cret!,vers=3.1.1 pass=x9",
        "https://discord.com/api/webhooks/123/abc https://hooks.slack.com/services/T0 https://x.example.org/api/webhook/1",
        "Authorization: Bearer abcdefghijklmnop.qrs Basic dXNlcjpwYXNz Token short",
        "token=abc123 secret: \"x y z\" api_key=K-1 sm_session=zzz; other=1 'pwd': 'q w' auth=1",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjg ghp_abcdefghijklmnopqrstuvwxyz0123456789 github_pat_abcdefghijklmnopqrstuvwx",
        "Daily Driver (veh-abc123) on tower: /footage/daily/TeslaCam missing; signed in as bob; SentryPi on Home WiFi near Mom's house",
        "Scarlet Car car DAILY DRIVER daily-driver tower2 xtower tower.",
        "ip:2001:db8::1 peer:fe80::1%eth0 10:00:00 at x.js:10:5 ::1 1::",
        "Größe 12.5 GB, café at 192.168.0.1é, ünïcode tower café",
        "",
    ];
    let mut cases = Vec::new();
    for t in texts {
        for anonymous in [false, true] {
            cases.push(json!({ "value": t, "anonymous": anonymous, "identifiers": ids }));
        }
    }
    let objects = [
        json!({ "password": "hunter2", "smbPassword": "x", "passwordSet": true, "token": 3, "tokenHash": null, "keys": [1], "keyframe": 1, "monkey": "kept", "nested": [{ "deep": { "secret": { "a": 1 }, "ok": "kept" } }] }),
        json!({ "hostname": "tower", "ip": "10.0.0.4", "lat": 30.26, "home": { "ssid": "x" }, "keep": { "paired": true, "cores": 8 }, "by": false, "from": null, "tower": 1, "veh-abc123": { "keepDays": 30 }, "Daily Driver": 2 }),
        json!({ "system": { "hostname": "tower", "os": "Debian", "ip": "192.168.1.9", "note": "smb password=hunter2 from 192.168.1.9" }, "logs": ["WARN share //nas/TeslaCam (Daily Driver) gone at 10.0.0.2"] }),
    ];
    for o in objects {
        for anonymous in [false, true] {
            cases.push(json!({ "value": o, "anonymous": anonymous, "identifiers": ids }));
        }
    }
    let want = node_says("scrub", &Value::Array(cases.clone()));
    for (i, c) in cases.iter().enumerate() {
        let idv: Vec<String> = c["identifiers"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
        let got = scrub::clean_report(&c["value"], c["anonymous"].as_bool().unwrap(), &idv);
        assert_eq!(got, want[i], "case {i}: {}", c);
    }
}

#[test]
fn the_payload_schema_and_the_heartbeat_answer_as_node() {
    if !node() {
        return;
    }
    let base = json!({ "kind": "feedback", "sentAt": "2026-11-15T10:00:00.000Z", "install": "a".repeat(32), "anonymous": false, "build": { "build": 130, "sha": "1345348", "builtAt": null, "tag": null }, "ui": "original", "message": "hello" });
    let with = |patch: Value| {
        let mut p = base.clone();
        for (k, v) in patch.as_object().unwrap() {
            if v.is_null() && k.starts_with('-') {
                p.as_object_mut().unwrap().remove(&k[1..]);
            } else {
                p[k] = v.clone();
            }
        }
        p
    };
    let payloads = vec![
        base.clone(),
        json!([1]),
        with(json!({ "kind": "nope", "sentAt": "x", "install": "ANON", "extra": 1 })),
        with(json!({ "install": "ANON", "anonymous": true, "contact": "me" })),
        with(json!({ "kind": "support", "-message": null })),
        with(json!({ "kind": "support", "diagnostics": { "system": { "a": [1, 2] }, "bogus": 1 }, "message": "x".repeat(1001) })),
        with(json!({ "kind": "daily", "diagnostics": {}, "contact": "x" })),
        with(json!({ "kind": "crash", "crash": { "at": "2026-11-15", "name": "E", "message": "m", "stack": "s", "source": "other", "x": 1 }, "diagnostics": {} })),
        with(json!({ "build": { "build": 0, "sha": "XYZ", "builtAt": 5, "extra": 1 } })),
        with(json!({ "message": "   " })),
        with(json!({ "kind": "heartbeat", "-message": null, "heartbeat": { "uptimeSec": 1 } })),
        with(json!({ "kind": "heartbeat", "-message": null, "heartbeat": { "uptimeSec": 1, "health": { "overall": "ok", "warnings": 1, "problems": 0 }, "vehicles": 1, "footageBytes": 1, "recordings": 1, "spaceSavedBytes": 1, "distanceKm": 1.25, "freeBytes": 5, "totalBytes": null, "converting": false, "jobsQueued": 0, "features": { "can": true, "sentryUsbPaired": false, "gpu": 1 }, "cpu": "a\"b", "gpus": ["x", ""], "cars": [{ "model": "Model 3" }], "host": { "os": "beos", "docker": 1 }, "nodes": [{ "cpu": null, "gpus": [], "convert": { "fps": 1.25 } }], "bogus": 1 } })),
    ];
    let want = node_says("validate", &Value::Array(payloads.clone()));
    for (i, p) in payloads.iter().enumerate() {
        let got: Vec<String> = sentry_lean::ops::reports::protocol::validate_payload(p);
        assert_eq!(json!(got), want[i], "payload {i}: {p}");
    }
    let raws = vec![
        json!({}),
        json!({ "uptimeSec": "12", "health": { "warnings": 1e9, "problems": "x" }, "freeBytes": 10, "totalBytes": 0, "distanceKm": "1.26", "cars": [null, { "model": "y", "firmware": "2025.1" }, { "model": "cybertruck", "firmware": "2025.14.3.1.2" }], "gpus": "x", "convert": { "fps": "12.34", "device": "Ñvidia  RTX\t4070" }, "host": { "os": "macos" } }),
        json!({ "platform": "  ", "arch": "arm64", "nodes": [1, { "gpus": ["a", "b", "c", "d", "e"] }], "clips24h": { "sentry": -1, "dashcam": 2.5 }, "footageSeconds": null }),
    ];
    let want = node_says("heartbeat", &Value::Array(raws.clone()));
    for (i, r) in raws.iter().enumerate() {
        let got = sentry_lean::ops::reports::normalize_heartbeat(r);
        assert_eq!(got.to_string(), want[i].to_string(), "heartbeat {i}: {r}");
    }
}

struct Receiver {
    child: Child,
    url: String,
    line: String,
    control: String,
}

impl Receiver {
    fn start(difficulty: u32, moved_to: Option<&str>) -> Receiver {
        let mut cmd = Command::new("node");
        cmd.arg(script()).arg("receiver").arg(difficulty.to_string());
        if let Some(m) = moved_to {
            cmd.arg(m);
        }
        let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let mut first = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut first).unwrap();
        let v: Value = serde_json::from_str(&first).unwrap();
        Receiver { child, url: v["url"].as_str().unwrap().into(), line: v["line"].as_str().unwrap().into(), control: v["control"].as_str().unwrap().into() }
    }

    fn index(&self) -> Vec<Value> {
        let r = Https.request(&HttpReq { method: "GET".into(), url: format!("{}/index", self.control), headers: vec![], body: None, timeout_ms: 5000, follow_redirects: false, max_body: 1 << 24, too_much: String::new() }).unwrap();
        serde_json::from_slice::<Value>(&r.body).unwrap().as_array().unwrap().clone()
    }

    fn set(&self, opts: Value) {
        Https.request(&HttpReq { method: "POST".into(), url: format!("{}/opts", self.control), headers: vec![], body: Some(opts.to_string().into_bytes()), timeout_ms: 5000, follow_redirects: false, max_body: 1024, too_much: String::new() }).unwrap();
    }
}

impl Drop for Receiver {
    fn drop(&mut self) {
        drop(self.child.stdin.take());
        let _ = self.child.wait();
    }
}

fn env_for(r: &Receiver) -> HashMap<String, String> {
    [("NODE_ENV", "test"), ("REPORTS_URL", r.url.as_str()), ("REPORTS_PUBLIC_KEY", r.line.as_str())].iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
}

fn client(r: &Receiver) -> (Arc<FakeCtx>, Arc<Reports>) {
    let ctx = FakeCtx::new();
    *ctx.diagnostics.lock().unwrap() = json!({ "system": { "hostname": "tower", "os": "Debian", "ip": "192.168.1.9", "note": "smb password=hunter2 from 192.168.1.9" }, "logs": ["WARN share //nas/TeslaCam (Daily Driver) gone at 10.0.0.2"] });
    *ctx.identifiers.lock().unwrap() = vec!["tower".into(), "Daily Driver".into(), "nas".into()];
    *ctx.heartbeat.lock().unwrap() = json!({ "uptimeSec": 30, "vehicles": 1, "health": { "warnings": 0, "problems": 1 }, "platform": "linux", "arch": "x64", "cpu": "tower CPU", "host": { "os": "debian", "docker": true } });
    let rep = Reports::new(ctx.clone(), env_for(r), json!({ "build": 130, "sha": "1345348abcdef0", "builtAt": "2026-11-11T00:00:00Z", "tag": "latest" }), Arc::new(Https), None);
    (ctx, rep)
}

#[test]
fn a_report_from_the_rust_client_is_taken_by_the_receiver() {
    if !node() {
        return;
    }
    let r = Receiver::start(6, None);
    let (ctx, rep) = client(&r);
    assert_eq!(rep.status()["configured"], true);
    let pv = rep.preview(&json!({ "kind": "feedback", "message": "Love it", "contact": "me@example.org", "attach": true })).unwrap();
    let sent = rep.send_preview(&pv["previewId"]).unwrap();
    assert_eq!(sent["result"], "sent", "{sent}");
    let reference = sent["ref"].as_str().unwrap().to_string();
    assert!(reference.starts_with("SR-") && reference.len() == 9);
    let idx = r.index();
    assert_eq!(idx[0]["ref"], json!(reference));
    assert_eq!(idx[0]["trust"], "new");
    assert_eq!(idx[0]["payload"], pv["payload"], "exactly what the preview showed");

    // a support report: the same install and key again
    let sp = rep.preview(&json!({ "kind": "support", "message": "Encoder stuck" })).unwrap();
    assert_eq!(rep.send_preview(&sp["previewId"]).unwrap()["result"], "sent");
    assert_eq!(r.index()[1]["trust"], "verified");
    let refs: Vec<Value> = rep.status()["sentRefs"].as_array().unwrap().iter().map(|x| x["kind"].clone()).collect();
    assert_eq!(refs, [json!("support"), json!("feedback")]);
    assert_eq!(rep.status()["installCode"], json!(&pv["payload"]["install"].as_str().unwrap()[..8]));

    // anonymous: ANON install, a key of its own
    let rep = Arc::clone(&rep);
    rep.set_settings(&json!({ "anonymous": true })).unwrap();
    let pv = rep.preview(&json!({ "kind": "feedback", "message": "from tower at 192.168.1.9", "contact": "x@y.org" })).unwrap();
    assert_eq!(rep.send_preview(&pv["previewId"]).unwrap()["result"], "sent");
    let idx = r.index();
    assert_eq!(idx[2]["trust"], "anon");
    assert_ne!(idx[2]["key"], idx[0]["key"], "not linkable to the install");
    assert!(!idx[2]["payload"].to_string().contains("tower"));

    // sharing on: a heartbeat and a crash report go, and pass the receiver's schema check
    rep.set_settings(&json!({ "anonymous": false, "share": true })).unwrap();
    assert_eq!(rep.send_heartbeat().unwrap()["result"], "sent");
    rep.note_crash("TypeError", "boom at 192.168.1.4", "TypeError: boom\n    at x (/app/server/a.js:1:1)", "crash");
    let out = rep.send_crashes();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["result"], "sent");
    let idx = r.index();
    assert_eq!(idx[3]["kind"], "heartbeat");
    assert_eq!(idx[3]["payload"]["heartbeat"]["health"]["overall"], "problem");
    assert_eq!(idx[3]["payload"]["heartbeat"]["cpu"], "ANON CPU", "the heartbeat's text is always scrubbed");
    assert_eq!(idx[4]["payload"]["crash"]["name"], "TypeError");

    // the receiver raises its difficulty: refused once with POW, then stamped again
    r.set(json!({ "difficulty": 9 }));
    let pl = rep.build_payload("feedback", Some(&json!("x")), None, false, None).unwrap();
    assert_eq!(rep.enqueue(&pl).unwrap()["result"], "sent");
    // and a refusal for good is dropped, not retried for ever
    r.set(json!({ "limitHour": 0 }));
    let pl = rep.build_payload("feedback", Some(&json!("y")), None, false, None).unwrap();
    let res = rep.enqueue(&pl).unwrap();
    assert_eq!(res["result"], "retry");
    assert_eq!(res["status"], 429);
    assert!(rep.status()["lastError"]["message"].as_str().unwrap().contains("busy"));
    assert_eq!(rep.outbox().len(), 1);
    assert!(ctx.data.join("reports/install-key.pem").exists() && ctx.data.join("reports/anon-key.pem").exists());
}

/// Sends what is meant for the named addresses to local ones (stand-ins for
/// real domains); anything else is refused, so nothing leaves this machine.
struct Mapped(Vec<(String, String)>);

impl Transport for Mapped {
    fn request(&self, r: &HttpReq) -> Result<HttpRes, String> {
        let mut q = r.clone();
        for (from, to) in &self.0 {
            q.url = q.url.replace(from.as_str(), to.as_str());
        }
        if !q.url.starts_with("http://127.0.0.1:") {
            return Err(format!("not local: {}", q.url));
        }
        Https.request(&q)
    }
}

#[test]
fn a_signed_move_is_followed_and_a_forged_one_is_not() {
    if !node() {
        return;
    }
    let target = Receiver::start(4, None);
    let moved = Receiver::start(4, Some("https://reports2.example.org"));
    let ctx = FakeCtx::new();
    let env: HashMap<String, String> = [("NODE_ENV", "test"), ("REPORTS_PUBLIC_KEY", moved.line.as_str())].iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
    let map = Mapped(vec![("https://reports.skittles.live".into(), moved.url.clone()), ("https://reports2.example.org".into(), target.url.clone())]);
    let rep = Reports::new(ctx.clone(), env.clone(), json!({}), Arc::new(map), None);
    assert_eq!(rep.endpoint(), "https://reports.skittles.live");
    rep.remote_config(true).unwrap();
    assert_eq!(rep.endpoint(), "https://reports2.example.org");
    assert_eq!(sentry_lean::ops::store::get(&ctx.db.lock().unwrap(), "reports-state").unwrap()["moved"]["url"], "https://reports2.example.org");

    // REPORTS_URL set by hand is never moved
    let fixed = Reports::new(FakeCtx::new(), env_for(&moved), json!({}), Arc::new(Https), None);
    fixed.remote_config(true).unwrap();
    assert_eq!(fixed.endpoint(), moved.url);

    // a move signed by another receiver's key is ignored
    let forged = Receiver::start(4, Some("https://evil.example.org"));
    let other = Reports::new(FakeCtx::new(), env, json!({}), Arc::new(Mapped(vec![("https://reports.skittles.live".into(), forged.url.clone())])), None);
    other.remote_config(true).unwrap();
    assert_eq!(other.endpoint(), "https://reports.skittles.live");
}
