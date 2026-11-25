//! Parity with the Node converter (lean/parity/converterAuto.js): the same
//! scenarios, written here as data, run by both. Automatic conversion
//! (every state, every call to the job service, every ticks' decisions and
//! the files written, byte for byte), the benchmark (its progress events and
//! result) and the device list (discovery over a fake /dev and /sys,
//! nvidia-smi, and devices() over fake test encodes). Node's answers are
//! frozen in tests/fixtures/node-reference/converter-{auto,bench,devices}.json.

use super::auto_convert::{Auto, AutoOptions, AutoService, Scanner};
use super::service::{Fail, SResult};
use super::testutil::tempdir;
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// Node's answer (lean/parity/converterAuto.js <mode> <scenario.json>, over
/// src/main/converter), frozen in tests/fixtures/node-reference/converter-<mode>.json.
fn node(mode: &str, scenario: &Value, dir: &Path) -> Value {
    let places = [("{DIR}", dir.to_string_lossy().into_owned())];
    crate::reference::answer(&format!("converter-{mode}"), &places, scenario)
}

/// first difference between two values, as a path
fn diff(a: &Value, b: &Value, at: &str) -> Option<String> {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let kx: Vec<&String> = x.keys().collect();
            let ky: Vec<&String> = y.keys().collect();
            if kx != ky {
                return Some(format!("{at}: keys {kx:?} vs {ky:?}"));
            }
            x.iter().find_map(|(k, v)| diff(v, &y[k], &format!("{at}.{k}")))
        }
        (Value::Array(x), Value::Array(y)) => {
            if x.len() != y.len() {
                return Some(format!("{at}: {} vs {} entries: {a} vs {b}", x.len(), y.len()));
            }
            x.iter().zip(y).enumerate().find_map(|(i, (p, q))| diff(p, q, &format!("{at}[{i}]")))
        }
        (Value::Number(x), Value::Number(y)) if x.as_f64() == y.as_f64() => None,
        _ if a == b => None,
        _ => Some(format!("{at}: {a} vs {b}")),
    }
}

// ---- automatic conversion

struct World {
    now: i64,
    hour: i64,
    clips: Value,
    down: Vec<String>,
    devices: Value,
    priorities: Value,
    busy: bool,
    cheap: Value,
    ticks: usize,
}

#[derive(Default)]
struct Svc {
    jobs: Mutex<IndexMap<String, Value>>,
    calls: Mutex<Vec<Value>>,
    refuse: Mutex<Option<String>>,
    n: AtomicUsize,
}

impl AutoService for Svc {
    fn start(&self, c: &Value) -> SResult<String> {
        if let Some(code) = self.refuse.lock().unwrap().take() {
            return Err(Fail::code(&code));
        }
        let id = format!("job-{}", self.n.fetch_add(1, Ordering::SeqCst) + 1);
        self.calls.lock().unwrap().push(json!(["start", id, c]));
        self.jobs.lock().unwrap().insert(id.clone(), json!({ "id": id, "state": "encoding", "config": c, "items": [] }));
        Ok(id)
    }
    fn get(&self, id: &str) -> SResult<Value> {
        Ok(self.jobs.lock().unwrap().get(id).cloned().unwrap_or(Value::Null))
    }
    fn list(&self) -> SResult<Vec<Value>> {
        Ok(self.jobs.lock().unwrap().values().cloned().collect())
    }
    fn pause(&self, id: &str) -> SResult<Value> {
        self.calls.lock().unwrap().push(json!(["pause", id]));
        if let Some(j) = self.jobs.lock().unwrap().get_mut(id) {
            j["state"] = json!("paused");
        }
        Ok(json!({}))
    }
    fn resume(&self, id: &str) -> SResult<Value> {
        self.calls.lock().unwrap().push(json!(["resume", id]));
        if let Some(j) = self.jobs.lock().unwrap().get_mut(id) {
            if j["state"] == "paused" {
                j["state"] = json!("encoding");
            }
        }
        Ok(json!({}))
    }
    fn set_lanes(&self, id: &str, l: &Value) -> SResult<Value> {
        self.calls.lock().unwrap().push(json!(["setLanes", id, l]));
        Ok(json!({}))
    }
}

fn run_auto(scenario: &Value, steps_node: &[Value]) -> Value {
    let dir = PathBuf::from(scenario["directory"].as_str().unwrap());
    let svc = Arc::new(Svc::default());
    let world = Arc::new(Mutex::new(World {
        now: scenario["now"].as_i64().unwrap_or(0),
        hour: scenario["hour"].as_i64().unwrap_or(12),
        clips: scenario.get("clips").cloned().unwrap_or(json!({})),
        down: vec![],
        devices: scenario.get("devices").cloned().unwrap_or(Value::Null),
        priorities: scenario.get("priorities").cloned().unwrap_or(json!({})),
        busy: false,
        cheap: Value::Null,
        ticks: 0,
    }));
    let w = world.clone();
    let scanner: Arc<Scanner> = Arc::new(move |c: &Value, _a: &AtomicBool, out: &mut dyn FnMut(Value) -> bool| {
        let (down, clips) = {
            let w = w.lock().unwrap();
            (w.down.clone(), w.clips.clone())
        };
        let root = c["sourceRoot"].as_str().unwrap_or("");
        if down.iter().any(|d| d == root) {
            return Err("SOURCE_UNAVAILABLE".into());
        }
        for clip in clips.get(root).and_then(Value::as_array).cloned().unwrap_or_default() {
            if !out(clip) {
                break;
            }
        }
        Ok(())
    });
    let make = || {
        let mut o = AutoOptions::new(svc.clone(), scanner.clone(), dir.clone());
        o.timer = false;
        let w = world.clone();
        o.now = Arc::new(move || w.lock().unwrap().now);
        let w = world.clone();
        o.hour_of = Arc::new(move |_t| {
            let mut w = w.lock().unwrap();
            w.ticks += 1;
            w.hour
        });
        let w = world.clone();
        o.is_cheap_now = Some(Arc::new(move |_t| {
            let mut w = w.lock().unwrap();
            w.ticks += 1;
            w.cheap.as_bool()
        }));
        let w = world.clone();
        o.is_busy = Arc::new(move || w.lock().unwrap().busy);
        let w = world.clone();
        o.devices = Some(Arc::new(move || {
            let d = w.lock().unwrap().devices.clone();
            if d == "fail" {
                Err("x".into())
            } else {
                Ok(d.as_array().cloned().unwrap_or_default())
            }
        }));
        let w = world.clone();
        o.node_priorities = Some(Arc::new(move || w.lock().unwrap().priorities.clone()));
        Auto::new(o)
    };
    let mut a = make();
    let mut out = vec![];
    for (i, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
        world.lock().unwrap().ticks = 0;
        let mut value = Value::Null;
        let err = |e: String| json!({ "error": e });
        match step["op"].as_str().unwrap() {
            "start" => {
                a.start();
            }
            "restart" => {
                a.stop();
                a = make();
                a.start();
            }
            "configure" => {
                if let Err(e) = a.configure(&step["value"]) {
                    value = err(e);
                }
            }
            "tick" => a.tick(),
            "checkNow" => {
                a.check_now();
            }
            "finish" => {
                let mut jobs = svc.jobs.lock().unwrap();
                let j = jobs.get_mut(step["id"].as_str().unwrap()).unwrap();
                j["state"] = step.get("state").cloned().unwrap_or(json!("completed"));
                j["items"] = step.get("items").cloned().unwrap_or(json!([]));
                if let Some(m) = step.get("moreAfter") {
                    j["moreAfter"] = m.clone();
                }
            }
            "manual" => {
                let id = step["id"].as_str().unwrap().to_string();
                svc.jobs.lock().unwrap().insert(id.clone(), json!({ "id": id, "state": step.get("state").cloned().unwrap_or(json!("encoding")), "config": { "sourceRoot": "/manual" }, "items": [] }));
            }
            "set" => {
                let mut w = world.lock().unwrap();
                for (k, v) in step["world"].as_object().into_iter().flatten() {
                    match k.as_str() {
                        "now" => w.now = v.as_i64().unwrap(),
                        "hour" => w.hour = v.as_i64().unwrap(),
                        "clips" => w.clips = v.clone(),
                        "devices" => w.devices = v.clone(),
                        "priorities" => w.priorities = v.clone(),
                        "busy" => w.busy = v == true,
                        "cheap" => w.cheap = v.clone(),
                        _ => panic!("{k}"),
                    }
                }
                if let Some(d) = step.get("down") {
                    w.down = d.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
                }
            }
            "refuse" => *svc.refuse.lock().unwrap() = Some(step["code"].as_str().unwrap().into()),
            "setLanes" => {
                if let Err(e) = a.set_lanes(&step["lanes"], step["root"].as_str()) {
                    value = err(e);
                }
            }
            "setConcurrency" => {
                let _ = a.set_concurrency(&step["value"], step["root"].as_str());
            }
            "saveVehicle" => {
                if let Err(e) = a.save_vehicle(&step["config"]) {
                    value = err(e);
                }
            }
            "forgetVehicle" => {
                a.forget_vehicle(step["root"].as_str().unwrap());
            }
            "ownerResumed" => a.owner_resumed(step["id"].as_str().unwrap()),
            "isKnown" => value = json!(a.is_known(&step["config"], &step["clip"])),
            other => panic!("{other}"),
        }
        // as many ticks as Node ran for this step
        let want = steps_node[i]["ticks"].as_u64().unwrap_or(0) as usize;
        while world.lock().unwrap().ticks < want {
            a.tick();
        }
        let ticks = world.lock().unwrap().ticks;
        out.push(json!({ "op": step["op"], "ticks": ticks, "value": value, "state": a.get_state(), "calls": std::mem::take(&mut *svc.calls.lock().unwrap()) }));
    }
    a.stop();
    let mut files = serde_json::Map::new();
    let mut names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
    names.sort();
    for n in names {
        files.insert(n.clone(), json!(std::fs::read_to_string(dir.join(&n)).unwrap()));
    }
    json!({ "steps": out, "files": files })
}

fn car(root: &str, codec: &str, extra: Value) -> Value {
    let mut c = json!({ "sourceRoot": root, "destinationRoot": null, "codec": codec, "profileId": "balanced", "networkMode": "direct", "outputMode": "replace",
        "includedGroups": ["RecentClips"], "groupOrder": ["SavedClips", "SentryClips", "RecentClips"], "replacementConfirmed": true, "concurrency": 2, "verifyMode": "quick" });
    for (k, v) in extra.as_object().unwrap() {
        c[k] = v.clone();
    }
    c
}

fn sched(extra: Value) -> Value {
    let mut v = json!({ "enabled": true, "intervalMinutes": 60, "window": null, "holdManual": false, "keepRunning": false, "openAtLogin": false });
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    v
}

fn clips(n: usize, base: &str) -> Value {
    json!((0..n).map(|i| json!({ "kind": "video", "relativePath": format!("RecentClips/{base}{i}.mp4"), "sourceBytes": 100 + i, "mtimeMs": 1_700_000_000_000i64 + i as i64 })).collect::<Vec<_>>())
}

fn auto_scenario(dir: &Path) -> Value {
    const ARC: &str = "pci:0000:03:00.0";
    const NODE: &str = "node:abcdefabcdef@cpu";
    let items = json!([
        { "state": "completed", "relativePath": "RecentClips/a0.mp4", "sourcePath": "/nonexistent/a0.mp4", "sourceBytes": 100, "mtimeMs": 1_700_000_000_000i64 },
        { "state": "failed", "relativePath": "RecentClips/a1.mp4", "sourceBytes": 101, "mtimeMs": 1_700_000_000_001i64 },
        { "state": "skipped", "resultCode": "no-savings", "relativePath": "RecentClips/a2.mp4", "sourceBytes": 102, "mtimeMs": 1_700_000_000_002i64 },
        { "state": "skipped", "resultCode": "already-converted", "relativePath": "RecentClips/a3.mp4", "sourceBytes": 103, "mtimeMs": 1_700_000_000_003i64 }
    ]);
    let steps: Vec<Value> = vec![
        json!({ "op": "start" }),
        json!({ "op": "configure", "value": sched(json!({ "config": car("/cars/a", "h265", json!({ "keepOffTarget": false })) })) }),
        json!({ "op": "configure", "value": sched(json!({ "config": car("/cars/b", "av1", json!({})) })) }),
        json!({ "op": "configure", "value": sched(json!({ "config": car("/cars/c", "av1", json!({ "keepLarger": true })) })) }),
        json!({ "op": "tick" }),
        json!({ "op": "finish", "id": "job-1", "items": items }),
        json!({ "op": "tick" }),
        json!({ "op": "isKnown", "config": car("/cars/a", "h265", json!({ "autoConvert": true })), "clip": { "relativePath": "RecentClips/a2.mp4", "sourceBytes": 102, "mtimeMs": 1_700_000_000_002i64 } }),
        json!({ "op": "isKnown", "config": car("/cars/a", "h265", json!({ "autoConvert": true, "keepLarger": true })), "clip": { "relativePath": "RecentClips/a2.mp4", "sourceBytes": 102, "mtimeMs": 1_700_000_000_002i64 } }),
        json!({ "op": "configure", "value": sched(json!({ "window": { "startHour": 22, "endHour": 6 }, "holdManual": true, "config": car("/cars/c", "av1", json!({ "keepLarger": true })) })) }),
        json!({ "op": "manual", "id": "manual-1" }),
        json!({ "op": "tick" }),
        json!({ "op": "ownerResumed", "id": "manual-1" }),
        json!({ "op": "set", "world": { "hour": 23, "now": 1_800_000_100_000i64 } }),
        json!({ "op": "tick" }),
        json!({ "op": "finish", "id": "job-2", "moreAfter": "RecentClips/c1.mp4", "items": [{ "state": "completed", "relativePath": "RecentClips/c0.mp4", "sourcePath": "/nonexistent/c0.mp4", "sourceBytes": 100, "mtimeMs": 1_700_000_000_000i64 }] }),
        json!({ "op": "tick" }),
        json!({ "op": "configure", "value": sched(json!({ "window": { "startHour": 5, "endHour": 5 }, "config": car("/cars/c", "av1", json!({})) })) }),
        json!({ "op": "configure", "value": sched(json!({ "window": { "follow": "off-peak" }, "intervalMinutes": 15, "config": car("/cars/a", "h265", json!({})) })) }),
        json!({ "op": "set", "world": { "cheap": false } }),
        json!({ "op": "tick" }),
        json!({ "op": "set", "world": { "cheap": true, "now": 1_800_010_000_000i64 }, "down": ["/cars/a"] }),
        json!({ "op": "checkNow" }),
        json!({ "op": "finish", "id": "job-3", "state": "failed", "items": [] }),
        json!({ "op": "refuse", "code": "JOB_ACTIVE" }),
        json!({ "op": "set", "world": { "now": 1_800_020_000_000i64 }, "down": [] }),
        json!({ "op": "checkNow" }),
        json!({ "op": "tick" }),
        json!({ "op": "setConcurrency", "value": 3, "root": "/cars/a" }),
        json!({ "op": "setLanes", "lanes": [{ "device": ARC, "concurrency": 2 }, { "device": "cpu", "concurrency": 1 }], "root": "/cars/a" }),
        json!({ "op": "setLanes", "lanes": [{ "device": "/dev/dri/renderD128", "concurrency": 1 }], "root": "/cars/a" }),
        json!({ "op": "saveVehicle", "config": car("/cars/z", "h265", json!({ "nodesOff": ["node:abcdefabcdef"] })) }),
        json!({ "op": "saveVehicle", "config": car("/cars/a", "h265", json!({ "concurrency": 4 })) }),
        json!({ "op": "forgetVehicle", "root": "/cars/z" }),
        json!({ "op": "configure", "value": { "enabled": true, "intervalMinutes": 60, "window": null, "configs": [
                car("/cars/d", "h265", json!({ "lanes": [{ "device": ARC, "concurrency": 2 }, { "device": NODE, "concurrency": 1 }] })),
                car("/cars/e", "h265", json!({ "lanes": [{ "device": ARC, "concurrency": 1 }] }))
            ] } }),
        json!({ "op": "set", "world": { "now": 1_800_100_000_000i64 } }),
        json!({ "op": "tick" }),
        json!({ "op": "finish", "id": "job-4", "items": [] }),
        json!({ "op": "tick" }),
        // the helper server's list puts the other vehicle first; it goes, and comes back
        json!({ "op": "set", "world": { "priorities": { "node:abcdefabcdef": ["/cars/e"] } } }),
        json!({ "op": "tick" }),
        json!({ "op": "set", "world": { "devices": [{ "id": "pci:0000:03:00.0", "kind": "dri" }, { "id": "cpu", "kind": "cpu" }] } }),
        json!({ "op": "tick" }),
        json!({ "op": "set", "world": { "devices": [{ "id": "pci:0000:03:00.0", "kind": "dri" }, { "id": "cpu", "kind": "cpu" }, { "id": "node:abcdefabcdef@cpu", "kind": "node", "slots": 3, "isDefault": true }] } }),
        json!({ "op": "tick" }),
        json!({ "op": "set", "world": { "devices": "fail" } }),
        json!({ "op": "setLanes", "lanes": [{ "device": NODE, "concurrency": 2 }], "root": "/cars/e" }),
        json!({ "op": "restart" }),
        json!({ "op": "tick" }),
        json!({ "op": "configure", "value": { "enabled": false, "intervalMinutes": 60, "window": null, "keepRunning": false, "openAtLogin": false, "removeSource": "/cars/d" } }),
        json!({ "op": "configure", "value": { "enabled": false, "intervalMinutes": 60, "window": { "startHour": 1, "endHour": 1 } } }),
    ];
    json!({
        "directory": dir, "now": 1_800_000_000_000i64, "hour": 12,
        "clips": { "/cars/a": clips(4, "a"), "/cars/b": [], "/cars/c": clips(3, "c"), "/cars/d": clips(2, "d"), "/cars/e": clips(2, "e") },
        "devices": [{ "id": ARC, "kind": "dri" }, { "id": "cpu", "kind": "cpu" }, { "id": NODE, "kind": "node", "slots": 3, "isDefault": true }],
        "steps": steps
    })
}

#[test]
fn automatic_conversion_decides_as_node_decides() {
    let d = tempdir().unwrap();
    let (nd, rd) = (d.path().join("node"), d.path().join("rust"));
    std::fs::create_dir_all(&nd).unwrap();
    std::fs::create_dir_all(&rd).unwrap();
    let theirs = node("auto", &auto_scenario(&nd), d.path());
    if let Ok(p) = std::env::var("LEAN_PARITY_DUMP") {
        std::fs::write(p, theirs.to_string()).unwrap();
    }
    let mut mine = run_auto(&auto_scenario(&rd), theirs["steps"].as_array().unwrap());
    // Speed-test provenance is additive and absent from the frozen Node model.
    // Keep comparing every existing field, service call and persisted file.
    for step in mine["steps"].as_array_mut().unwrap() {
        for key in ["state", "value"] {
            if let Some(status) = step[key].get_mut("status").and_then(Value::as_object_mut) {
                status.shift_remove("speedTests");
            }
        }
    }
    let metadata = mine["files"].as_object_mut().unwrap().shift_remove("speed-tests.json").unwrap();
    let metadata: Value = serde_json::from_str(metadata.as_str().unwrap()).unwrap();
    assert!(metadata.as_object().unwrap().values().all(|v| v["settingsSource"] == "user"), "legacy manual choices stay user-owned");
    for (i, (a, b)) in mine["steps"].as_array().unwrap().iter().zip(theirs["steps"].as_array().unwrap()).enumerate() {
        if let Some(e) = diff(a, b, &format!("step {i} ({})", b["op"])) {
            panic!("{e}");
        }
    }
    assert_eq!(mine["files"], theirs["files"], "the files written");
    assert!(theirs["steps"].as_array().unwrap().iter().any(|s| s["calls"].as_array().unwrap().iter().any(|c| c[0] == "setLanes")), "the scenario reaches the lanes");
}

// ---- the benchmark

fn run_bench(s: &Value) -> Value {
    use super::benchmark::*;
    let dir = PathBuf::from(s["directory"].as_str().unwrap());
    let clock = Mutex::new(0.0f64);
    let events = Mutex::new(vec![]);
    struct M(Value, Mutex<usize>);
    impl PowerMeter for M {
        fn start(&self) -> Result<Value, String> {
            if self.0["failStart"] == true {
                return Err("no".into());
            }
            let mut n = self.1.lock().unwrap();
            *n += 1;
            Ok(json!(format!("token-{n}")))
        }
        fn stop(&self, t: &Value) -> Result<Option<Value>, String> {
            let n: usize = t.as_str().unwrap()[6..].parse().unwrap();
            match self.0["readings"].get(n - 1) {
                Some(Value::String(e)) if e == "error" => Err("gone".into()),
                Some(Value::Null) | None => Ok(None),
                Some(r) => Ok(Some(r.clone())),
            }
        }
    }
    let meter: Option<Arc<dyn PowerMeter>> = s.get("meter").filter(|m| !m.is_null()).map(|m| Arc::new(M(m.clone(), Mutex::new(0))) as Arc<dyn PowerMeter>);
    let level = |r: &LevelRequest, _c: &Arc<AtomicBool>| -> Result<Value, String> {
        *clock.lock().unwrap() += s["seconds"][r.level.to_string()].as_f64().unwrap_or(1.0) * 1000.0 + if r.verify_mode == Some("full") { 500.0 } else { 0.0 };
        if s["cancelAt"].as_i64() == Some(r.level) {
            return Err("CANCELLED".into());
        }
        let dirp = r.source_root.join("RecentClips");
        let mut names: Vec<String> = std::fs::read_dir(&dirp).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        names.sort();
        let items: Vec<Value> = names
            .iter()
            .map(|n| {
                let body = std::fs::read_to_string(dirp.join(n)).unwrap();
                let rule = s["fail"].as_array().into_iter().flatten().find(|f| f.get("content").map_or(true, |c| c == body.as_str()) && f.get("fromLevel").and_then(Value::as_i64).map_or(true, |l| r.level >= l));
                match rule {
                    Some(f) => json!({ "state": "failed", "relativePath": format!("RecentClips/{n}"), "failure": { "code": f["code"] } }),
                    None => json!({ "state": "completed", "relativePath": format!("RecentClips/{n}"), "sourceBytes": 1000, "outputBytes": 400 }),
                }
            })
            .collect();
        let n = items.len();
        Ok(json!({ "items": items, "timings": { "files": n, "totalMs": { "verify": 1234 * n } } }))
    };
    let now = || *clock.lock().unwrap();
    let progress = |e: Value| events.lock().unwrap().push(e);
    let count = |p: &Path| std::fs::read(p).map(|b| b.len() as i64).unwrap_or(0);
    let r = run_converter_benchmark(&BenchOptions {
        clips: s["clips"].as_array().unwrap().iter().map(|c| (dir.join(c["name"].as_str().unwrap()), c["name"].as_str().unwrap().to_string())).collect(),
        run_level: &level,
        count_frames: &count,
        encoder: s["encoder"].clone(),
        temp_root: dir.clone(),
        cancel: Arc::new(AtomicBool::new(false)),
        on_progress: &progress,
        now: &now,
        power_meter: meter,
        compare_verify_modes: s["compare"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default(),
    });
    json!({ "events": *events.lock().unwrap(), "result": r.unwrap_or_else(|e| json!({ "error": e })) })
}

#[test]
fn the_benchmark_reports_as_node_reports() {
    let d = tempdir().unwrap();
    let names = ["2026-10-20_17-00-00-front.mp4", "2026-10-20_17-00-00-back.mp4", "2026-10-20_17-00-00-left_repeater.mp4", "odd-name.mp4"];
    for (i, n) in names.iter().enumerate() {
        std::fs::write(d.path().join(n), "x".repeat(10 + i)).unwrap();
    }
    let clips: Vec<Value> = names.iter().map(|n| json!({ "name": n })).collect();
    let enc = json!({ "family": "h265", "codec": "hevc_qsv", "hardware": true });
    let r = |wh: f64, w: f64| json!({ "wh": wh, "avgW": w });
    let scenarios = vec![
        json!({ "clips": [clips[0]], "seconds": { "1": 10, "2": 5, "4": 8, "6": 9, "8": 10 }, "encoder": enc, "compare": ["quick", "full"] }),
        json!({ "clips": clips, "seconds": { "1": 3, "2": 4, "4": 7, "6": 9.5, "8": 13 }, "encoder": enc, "fail": [{ "content": "xxxxxxxxxxx", "code": "duration-mismatch" }],
                "meter": { "readings": [r(0.2, 72.0), r(0.1, 72.5), null, r(0.16, 72.0), r(0.3, 120.0), r(0.5, 180.0), r(0.4, 100.0), r(0.45, 99.0)] }, "compare": ["quick", "full"] }),
        json!({ "clips": [clips[0], clips[3]], "seconds": { "1": 2 }, "encoder": enc, "fail": [{ "fromLevel": 4, "code": "decode-failed" }], "meter": { "readings": ["error", r(1.0, 5.0)] } }),
        json!({ "clips": [clips[0]], "seconds": {}, "encoder": enc, "fail": [{ "code": "duration-mismatch" }] }),
        json!({ "clips": [clips[1]], "seconds": {}, "encoder": enc, "cancelAt": 2, "meter": { "failStart": true, "readings": [] } }),
    ];
    for (i, mut s) in scenarios.into_iter().enumerate() {
        s["directory"] = json!(d.path());
        let theirs = node("bench", &s, d.path());
        let mine = run_bench(&s);
        if let Some(e) = diff(&mine, &theirs, &format!("scenario {i}")) {
            panic!("{e}");
        }
    }
}

// ---- devices

fn machine(root: &Path) -> (PathBuf, PathBuf) {
    use std::os::unix::fs::symlink;
    let (dev, sys) = (root.join("dev"), root.join("sys"));
    std::fs::create_dir_all(dev.join("dri")).unwrap();
    let pci = |slot: &str, vendor: &str, device: &str, driver: &str| {
        let d = sys.join("devices/pci0000:00").join(slot);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("vendor"), format!("{vendor}\n")).unwrap();
        std::fs::write(d.join("device"), format!("{device}\n")).unwrap();
        let drv = sys.join("bus/pci/drivers").join(driver);
        std::fs::create_dir_all(&drv).unwrap();
        symlink(&drv, d.join("driver")).unwrap();
        d
    };
    let uhd = pci("0000:00:02.0", "0x8086", "0x4680", "i915");
    let arc = pci("0000:03:00.0", "0x8086", "0x56A5", "i915");
    let amd = pci("0000:0c:00.0", "0x1002", "0x7480", "amdgpu");
    let nv = pci("0000:01:00.0", "0x10de", "0x1fb2", "nvidia");
    let v3d = sys.join("devices/platform/fec00000.v3d");
    std::fs::create_dir_all(&v3d).unwrap();
    for (name, t) in [("renderD128", &uhd), ("renderD129", &arc), ("renderD130", &v3d), ("renderD131", &nv), ("renderD132", &amd), ("renderD133", &arc)] {
        std::fs::create_dir_all(sys.join("class/drm").join(name)).unwrap();
        symlink(t, sys.join("class/drm").join(name).join("device")).unwrap();
        std::fs::write(dev.join("dri").join(name), "").unwrap();
    }
    std::fs::write(dev.join("dri/card0"), "").unwrap();
    (dev, sys)
}

#[test]
fn the_device_list_and_devices_answer_as_node_answers() {
    let d = tempdir().unwrap();
    let (dev, sys) = machine(d.path());
    let nvidia = [
        Value::Null,
        json!({ "status": 0, "stdout": "1, 00000000:02:00.0, NVIDIA GeForce RTX 3060\n0, 00000000:01:00.0, NVIDIA T400\nbad line\n2, 00000000:02:00.0, again\n3, nonsense, x\n", "stderr": "" }),
        json!({ "status": 9, "stdout": "0, 00000000:01:00.0, NVIDIA T400\n", "stderr": "NVML" }),
    ];
    let machines: Vec<Value> = nvidia.iter().map(|n| { let mut m = json!({ "dev": dev, "sys": sys }); if !n.is_null() { m["nvidia"] = n.clone(); } m }).collect();
    let arc = json!({ "id": "pci:0000:03:00.0", "kind": "dri", "vendor": "intel", "name": "Intel Arc A380", "node": "/dev/dri/renderD129", "index": null, "pci": "0000:03:00.0" });
    let uhd = json!({ "id": "pci:0000:00:02.0", "kind": "dri", "vendor": "intel", "name": "Intel UHD Graphics 770", "node": "/dev/dri/renderD128", "index": null, "pci": "0000:00:02.0" });
    let t400 = json!({ "id": "pci:0000:01:00.0", "kind": "nvidia", "vendor": "nvidia", "name": "NVIDIA T400", "node": null, "index": 0, "pci": "0000:01:00.0" });
    let rtx = json!({ "id": "pci:0000:02:00.0", "kind": "nvidia", "vendor": "nvidia", "name": "NVIDIA GeForce RTX 3060", "node": null, "index": 1, "pci": "0000:02:00.0" });
    let cpu = super::devices::cpu_device();
    let adv = json!(["libx265", "libsvtav1", "hevc_nvenc", "av1_nvenc", "hevc_qsv", "av1_qsv", "hevc_vaapi", "av1_vaapi"]);
    let desktop = json!({ "advertised": adv, "ok": { "hevc_qsv": ["/dev/dri/renderD129", "/dev/dri/renderD128", "default"], "av1_qsv": ["/dev/dri/renderD129"], "hevc_nvenc": ["nvidia0"], "av1_nvenc": ["nvidia0"] } });
    let cases = json!([
        { "devices": [uhd, arc, t400, cpu], "works": desktop, "resolve": [arc["id"], "/dev/dri/renderD129", "pci:0000:09:00.0", "cpu"] },
        { "devices": [arc, t400, cpu], "works": { "advertised": adv, "ok": { "hevc_qsv": ["/dev/dri/renderD129"], "hevc_nvenc": ["nvidia0", "default"], "av1_nvenc": ["nvidia0", "default"] } } },
        { "devices": [uhd, cpu], "works": desktop },
        { "devices": [cpu], "works": desktop },
        { "devices": [t400, rtx, cpu], "works": { "advertised": adv, "ok": { "hevc_nvenc": ["nvidia1", "default"] } } },
        { "devices": [t400, rtx, cpu], "works": { "advertised": adv, "ok": { "hevc_nvenc": ["nvidia0", "nvidia1", "default"] } } },
        { "devices": [uhd, arc, cpu], "works": { "advertised": adv, "ok": desktop["ok"], "timeout": ["hevc_qsv@/dev/dri/renderD129"] } },
        { "devices": [uhd, arc, cpu], "works": { "advertised": ["libx265", "libsvtav1", "hevc_vaapi"], "ok": { "hevc_vaapi": ["/dev/dri/renderD128", "default"] } } }
    ]);
    let scenario = json!({ "directory": d.path().join("rt"), "machines": machines, "cases": cases });
    let theirs = node("devices", &scenario, d.path());
    // the device list
    for (i, m) in machines.iter().enumerate() {
        let mut disc = super::devices::Discovery::new(None);
        disc.platform = "linux".into();
        disc.dev_root = dev.clone();
        disc.sys_root = sys.clone();
        disc.rdev = super::devices::Rdev::None;
        if let Some(n) = m.get("nvidia") {
            let n = n.clone();
            disc.run = Some(Arc::new(FixedRun(n)));
        } else {
            disc.run = Some(Arc::new(FixedRun(json!({ "status": null, "error": { "code": "PROCESS_START_FAILED" }, "stdout": "" }))));
        }
        let mine = Value::Array(disc.list());
        if let Some(e) = diff(&mine, &theirs["lists"][i], &format!("machine {i}")) {
            panic!("{e}");
        }
    }
    // devices() and resolveDevice
    for (i, c) in cases.as_array().unwrap().iter().enumerate() {
        let probe = Arc::new(super::service::lanes_tests::FakeProbe { works: works_of(&c["works"]), calls: AtomicUsize::new(0), advertised: c["works"]["advertised"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()) });
        let planner: Arc<dyn super::devices::Encoders> = Arc::new(super::planner::Planner::new(probe, "linux", "ffmpeg"));
        let mut disc = super::devices::Discovery::new(None);
        let list = c["devices"].as_array().unwrap().clone();
        disc.fixed = Some(Arc::new(move || list.clone()));
        let reg = super::devices::Registry::new(disc, planner);
        let first = reg.devices().unwrap();
        let again = reg.devices().unwrap();
        let resolved: Vec<Value> = c["resolve"].as_array().into_iter().flatten().map(|id| reg.resolve_device(id.as_str().unwrap()).unwrap_or(Value::Null)).collect();
        let mine = json!({ "first": first, "again": again, "resolved": resolved });
        if let Some(e) = diff(&mine, &theirs["answers"][i], &format!("case {i}")) {
            panic!("{e}");
        }
    }
}

struct FixedRun(Value);
impl super::process::Runner for FixedRun {
    fn run(&self, _c: &str, _a: &[String], _o: &super::process::RunOptions) -> Result<super::process::ProcResult, String> {
        let v = &self.0;
        Ok(super::process::ProcResult { status: v["status"].as_i64().map(|s| s as i32), stdout: v["stdout"].as_str().unwrap_or("").into(), stderr: v["stderr"].as_str().unwrap_or("").into(), error: v.get("error").filter(|e| !e.is_null()).map(|_| "PROCESS_START_FAILED".into()), ..Default::default() })
    }
}

fn works_of(w: &Value) -> super::service::lanes_tests::Works {
    let w = w.clone();
    Arc::new(move |enc: &str, args: &[String]| {
        if enc.starts_with("lib") {
            return Some(true);
        }
        let gpu = super::service::lanes_tests::gpu_of(args).unwrap_or_else(|| "default".into());
        if w["timeout"].as_array().is_some_and(|t| t.iter().any(|x| x == format!("{enc}@{gpu}").as_str())) {
            return None;
        }
        Some(w["ok"][enc].as_array().is_some_and(|a| a.iter().any(|x| x == gpu.as_str())))
    })
}
