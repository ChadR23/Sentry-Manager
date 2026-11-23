//! test/autoGiveUp.test.js, test/autoPerVehicle.test.js and the automatic
//! parts of test/lanes.test.js, over a stand-in job service and scanner.

use super::*;
use crate::converter::service::{Fail, SResult};
use crate::converter::testutil::tempdir;
use std::collections::HashMap;

#[derive(Default)]
struct FakeService {
    jobs: Mutex<IndexMap<String, Value>>,
    started: Mutex<Vec<Value>>,
    paused: Mutex<Vec<String>>,
    resumed: Mutex<Vec<String>>,
    lanes: Mutex<Vec<(String, Value)>>,
    fixed_id: Option<String>,
}

impl AutoService for FakeService {
    fn start(&self, c: &Value) -> SResult<String> {
        let mut st = self.started.lock().unwrap();
        let id = self.fixed_id.clone().unwrap_or_else(|| format!("job-{}", st.len() + 1));
        st.push(json!({ "id": id, "sourceRoot": c["sourceRoot"], "codec": c["codec"], "auto": c["autoConvert"], "lanes": c.get("lanes") }));
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
        self.paused.lock().unwrap().push(id.into());
        Ok(json!({}))
    }
    fn resume(&self, id: &str) -> SResult<Value> {
        self.resumed.lock().unwrap().push(id.into());
        Ok(json!({}))
    }
    fn set_lanes(&self, id: &str, l: &Value) -> SResult<Value> {
        self.lanes.lock().unwrap().push((id.into(), l.clone()));
        Ok(json!({}))
    }
}

impl FakeService {
    fn set(&self, id: &str, f: impl FnOnce(&mut Value)) {
        f(self.jobs.lock().unwrap().get_mut(id).unwrap())
    }
    fn started(&self) -> Vec<Value> {
        self.started.lock().unwrap().clone()
    }
}

fn scanner_of(clips: Arc<Mutex<HashMap<String, usize>>>, down: Arc<Mutex<Vec<String>>>) -> Arc<Scanner> {
    Arc::new(move |c: &Value, _a: &AtomicBool, out: &mut dyn FnMut(Value) -> bool| {
        let root = c["sourceRoot"].as_str().unwrap_or("").to_string();
        if down.lock().unwrap().contains(&root) {
            return Err("SOURCE_UNAVAILABLE".into());
        }
        let n = clips.lock().unwrap().get(&root).copied().unwrap_or(0);
        for i in 0..n {
            if !out(json!({ "relativePath": format!("RecentClips/{i}.mp4"), "sourceBytes": 100, "mtimeMs": 1 })) {
                break;
            }
        }
        Ok(())
    })
}

fn opts(service: Arc<FakeService>, scanner: Arc<Scanner>, dir: &Path) -> AutoOptions {
    let mut o = AutoOptions::new(service, scanner, dir.to_path_buf());
    o.timer = false;
    o
}

fn clip(rel: &str, size: i64) -> Value {
    json!({ "relativePath": rel, "sourceBytes": size, "mtimeMs": 5 })
}

fn give_up_config(dir: &Path) -> Value {
    json!({ "sourceRoot": dir.join("src"), "destinationRoot": null, "codec": "h265", "profileId": "balanced", "networkMode": "direct", "outputMode": "replace",
      "includedGroups": ["RecentClips"], "groupOrder": ["SavedClips", "SentryClips", "RecentClips"], "replacementConfirmed": true, "concurrency": 2, "verifyMode": "quick", "autoConvert": true })
}

fn give_up_setup(dir: &Path, job: Value) -> (Arc<Auto>, Arc<FakeService>) {
    let s = Arc::new(FakeService { fixed_id: Some("new".into()), ..Default::default() });
    s.jobs.lock().unwrap().insert(job["id"].as_str().unwrap().to_string(), job);
    let none: Arc<Scanner> = Arc::new(|_c: &Value, _a: &AtomicBool, _o: &mut dyn FnMut(Value) -> bool| Ok(()));
    let mut o = opts(s.clone(), none, dir);
    o.now = Arc::new(|| 0);
    o.is_busy = Arc::new(|| true);
    let a = Auto::new(o);
    a.start();
    a.tick();
    (a, s)
}

#[test]
fn given_up_clips_wait_for_a_converter_change_and_converted_ones_stay_skipped() {
    let d = tempdir().unwrap();
    let c = give_up_config(d.path());
    let (auto, s) = give_up_setup(d.path(), json!({ "id": "a1", "state": "encoding", "config": c, "items": [] }));
    s.set("a1", |j| {
        j["state"] = json!("completed");
        j["items"] = json!([
            { "state": "completed", "relativePath": "RecentClips/ok.mp4", "sourcePath": d.path().join("missing.mp4"), "sourceBytes": 100, "mtimeMs": 5 },
            { "state": "skipped", "resultCode": "already-converted", "relativePath": "RecentClips/h265.mp4", "sourceBytes": 100, "mtimeMs": 5 },
            { "state": "skipped", "resultCode": "no-savings", "relativePath": "RecentClips/big.mp4", "sourceBytes": 100, "mtimeMs": 5 }
        ]);
    });
    auto.tick();
    assert!(auto.is_known(&c, &clip("RecentClips/h265.mp4", 100)));
    assert!(auto.is_known(&c, &clip("RecentClips/big.mp4", 100)));
    let file = d.path().join(format!("index-{}.json", setup_key(&c)));
    let mut saved: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(saved["v"], 2);
    assert_eq!(saved["gaveUp"]["RecentClips/big.mp4"], json!([100, 5, CONVERTER_REVISION, "no-savings"]));
    assert!(saved["files"].get("RecentClips/h265.mp4").is_some());
    let mut larger = c.clone();
    larger["keepLarger"] = json!(true);
    assert!(!auto.is_known(&larger, &clip("RecentClips/big.mp4", 100)));
    assert!(auto.is_known(&larger, &clip("RecentClips/h265.mp4", 100)));
    saved["gaveUp"]["RecentClips/big.mp4"][2] = json!(CONVERTER_REVISION - 1);
    std::fs::write(&file, saved.to_string()).unwrap();
    let (later, _) = give_up_setup(d.path(), json!({ "id": "a2", "state": "encoding", "config": c, "items": [] }));
    assert!(!later.is_known(&c, &clip("RecentClips/big.mp4", 100)));
    assert!(later.is_known(&c, &clip("RecentClips/h265.mp4", 100)));
}

#[test]
fn three_failed_runs_give_up_and_a_version_1_index_starts_over() {
    let d = tempdir().unwrap();
    let c = give_up_config(d.path());
    let file = d.path().join(format!("index-{}.json", setup_key(&c)));
    std::fs::write(&file, json!({ "v": 1, "files": { "RecentClips/repeater.mp4": [100, 5] }, "failures": {} }).to_string()).unwrap();
    let (mut auto, mut s) = give_up_setup(d.path(), json!({ "id": "r0", "state": "encoding", "config": c, "items": [] }));
    assert!(!auto.is_known(&c, &clip("RecentClips/repeater.mp4", 100)));
    for i in 1..=3 {
        let id = format!("r{}", i - 1);
        s.set(&id, |j| {
            j["state"] = json!("completed");
            j["items"] = json!([{ "state": "failed", "relativePath": "RecentClips/repeater.mp4", "sourceBytes": 100, "mtimeMs": 5 }]);
        });
        auto.tick();
        assert_eq!(auto.is_known(&c, &clip("RecentClips/repeater.mp4", 100)), i == 3, "after {i} failed run(s)");
        if i < 3 {
            (auto, s) = give_up_setup(d.path(), json!({ "id": format!("r{i}"), "state": "encoding", "config": c, "items": [] }));
        }
    }
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(saved["gaveUp"]["RecentClips/repeater.mp4"], json!([100, 5, CONVERTER_REVISION]));
    assert!(saved["files"].get("RecentClips/repeater.mp4").is_none());
    assert!(!auto.is_known(&c, &clip("RecentClips/repeater.mp4", 101)));
}

struct Cars {
    _d: crate::converter::testutil::TempDir,
    auto: Arc<Auto>,
    s: Arc<FakeService>,
    clips: Arc<Mutex<HashMap<String, usize>>>,
    down: Arc<Mutex<Vec<String>>>,
}

fn cars() -> Cars {
    let d = tempdir().unwrap();
    let s = Arc::new(FakeService::default());
    let clips = Arc::new(Mutex::new(HashMap::from([("/cars/a".to_string(), 2), ("/cars/b".to_string(), 0), ("/cars/c".to_string(), 3)])));
    let down = Arc::new(Mutex::new(vec![]));
    let auto = Auto::new(opts(s.clone(), scanner_of(clips.clone(), down.clone()), d.path()));
    Cars { _d: d, auto, s, clips, down }
}

fn car(root: &str, codec: &str) -> Value {
    json!({ "sourceRoot": root, "destinationRoot": null, "codec": codec, "profileId": "balanced", "networkMode": "direct", "outputMode": "replace",
      "includedGroups": ["RecentClips"], "replacementConfirmed": true, "concurrency": 2, "verifyMode": "quick" })
}

fn shared(extra: Value) -> Value {
    let mut v = json!({ "intervalMinutes": 60, "window": null, "holdManual": false, "keepRunning": false, "openAtLogin": false });
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    v
}

fn wait_ticks(a: &Auto) {
    // configure ticks on a thread of its own: wait for it
    drop(a.ticking.lock());
}

#[test]
fn each_vehicle_keeps_its_settings_and_one_round_converts_them_one_after_another() {
    let t = cars();
    for (r, c) in [("/cars/a", "h265"), ("/cars/b", "av1"), ("/cars/c", "av1")] {
        t.auto.configure(&shared(json!({ "enabled": true, "config": car(r, c) }))).unwrap();
        wait_ticks(&t.auto);
    }
    let st = t.auto.get_state();
    assert_eq!(st["settings"]["configs"].as_array().unwrap().iter().map(|c| json!([c["sourceRoot"], c["codec"]])).collect::<Vec<_>>(), vec![json!(["/cars/a", "h265"]), json!(["/cars/b", "av1"]), json!(["/cars/c", "av1"])]);
    t.auto.tick();
    let roots = |s: &FakeService| s.started().iter().map(|j| j["sourceRoot"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(roots(&t.s), vec!["/cars/a"]);
    assert_eq!(t.s.started()[0]["auto"], true);
    assert_eq!(t.auto.get_state()["status"]["activeSource"], "/cars/a");
    t.auto.tick();
    assert_eq!(t.s.started().len(), 1);
    t.s.set("job-1", |j| j["state"] = json!("completed"));
    t.auto.tick();
    assert_eq!(roots(&t.s), vec!["/cars/a", "/cars/c"]);
    assert_eq!(t.s.started()[1]["codec"], "av1");
    assert_eq!(t.auto.get_state()["status"]["sources"]["/cars/b"]["lastNewFiles"], 0);
    t.s.set("job-2", |j| j["state"] = json!("completed"));
    t.auto.tick();
    assert_eq!(t.s.started().len(), 2);
    assert!(t.auto.get_state()["status"]["nextCheckAt"].as_i64().unwrap() > crate::converter::jobstore::now_ms() as i64);
}

#[test]
fn a_share_that_is_down_does_not_stop_the_others_and_turning_one_off_keeps_the_rest() {
    let t = cars();
    t.down.lock().unwrap().push("/cars/a".into());
    t.auto.configure(&shared(json!({ "enabled": true, "config": car("/cars/a", "h265") }))).unwrap();
    wait_ticks(&t.auto);
    t.auto.configure(&shared(json!({ "enabled": true, "config": car("/cars/c", "h265") }))).unwrap();
    wait_ticks(&t.auto);
    t.auto.tick();
    assert_eq!(t.s.started().iter().map(|j| j["sourceRoot"].clone()).collect::<Vec<_>>(), vec![json!("/cars/c")]);
    assert_eq!(t.auto.get_state()["status"]["sources"]["/cars/a"]["error"], "SOURCE_UNAVAILABLE");
    t.auto.configure(&shared(json!({ "enabled": false, "removeSource": "/cars/a" }))).unwrap();
    wait_ticks(&t.auto);
    let st = t.auto.get_state();
    assert_eq!(st["settings"]["configs"].as_array().unwrap().iter().map(|c| c["sourceRoot"].clone()).collect::<Vec<_>>(), vec![json!("/cars/c")]);
    assert_eq!(st["settings"]["enabled"], true);
    t.auto.configure(&shared(json!({ "intervalMinutes": 180, "enabled": false }))).unwrap();
    wait_ticks(&t.auto);
    let st = t.auto.get_state();
    assert_eq!(st["settings"]["configs"].as_array().unwrap().len(), 1);
    assert_eq!(st["settings"]["intervalMinutes"], 180);
    t.auto.configure(&shared(json!({ "enabled": false, "removeSource": "/cars/c" }))).unwrap();
    wait_ticks(&t.auto);
    assert_eq!(t.auto.get_state()["settings"]["enabled"], false);
    // the folder turned off keeps its settings as saved-only
    assert_eq!(t.auto.get_state()["saved"].as_array().unwrap().len(), 2);
}

#[test]
fn settings_from_before_one_per_vehicle_become_that_vehicles() {
    let d = tempdir().unwrap();
    std::fs::write(d.path().join("settings.json"), shared(json!({ "enabled": true, "config": car("/cars/a", "h265") })).to_string()).unwrap();
    let s = Arc::new(FakeService::default());
    let auto = Auto::new(opts(s, scanner_of(Default::default(), Default::default()), d.path()));
    auto.start();
    auto.stop();
    wait_ticks(&auto);
    let st = auto.get_state();
    assert_eq!(st["settings"]["configs"][0]["sourceRoot"], "/cars/a");
    assert_eq!(st["settings"]["enabled"], true);
}

#[test]
fn a_job_stopped_at_its_clip_limit_is_checked_again_at_once() {
    let t = cars();
    t.clips.lock().unwrap().insert("/cars/a".into(), 5);
    t.auto.configure(&shared(json!({ "intervalMinutes": 720, "enabled": true, "config": car("/cars/a", "h265") }))).unwrap();
    wait_ticks(&t.auto);
    t.auto.tick();
    assert_eq!(t.s.started().len(), 1);
    t.s.set("job-1", |j| {
        j["state"] = json!("completed");
        j["moreAfter"] = json!("RecentClips/2.mp4");
        j["items"] = json!((0..3).map(|n| json!({ "state": "completed", "relativePath": format!("RecentClips/{n}.mp4"), "sourceBytes": 100, "mtimeMs": 1 })).collect::<Vec<_>>());
    });
    t.auto.tick();
    assert_eq!(t.s.started().len(), 2, "the next part on the next tick");
    t.s.set("job-2", |j| {
        j["state"] = json!("completed");
        j["items"] = json!((3..5).map(|n| json!({ "state": "completed", "relativePath": format!("RecentClips/{n}.mp4"), "sourceBytes": 100, "mtimeMs": 1 })).collect::<Vec<_>>());
    });
    t.auto.tick();
    assert_eq!(t.s.started().len(), 2);
}

#[test]
fn set_lanes_saves_the_lanes_and_their_total_and_a_bad_saved_value_is_left_out() {
    let d = tempdir().unwrap();
    let s = Arc::new(FakeService::default());
    let auto = Auto::new(opts(s.clone(), scanner_of(Default::default(), Default::default()), d.path()));
    let mut config = car(d.path().to_str().unwrap(), "h265");
    config["destinationRoot"] = json!(d.path().join("out"));
    config["outputMode"] = json!("separate");
    config["concurrency"] = json!(5);
    auto.configure(&json!({ "enabled": true, "intervalMinutes": 60, "window": null, "config": config })).unwrap();
    wait_ticks(&auto);
    let lanes = json!([{ "device": "pci:0000:03:00.0", "concurrency": 3 }, { "device": "pci:0000:00:02.0", "concurrency": 1 }]);
    auto.set_lanes(&lanes, None).unwrap();
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(d.path().join("settings.json")).unwrap()).unwrap();
    assert_eq!(saved["configs"][0]["lanes"], lanes);
    assert_eq!(saved["configs"][0]["concurrency"], 4);
    auto.set_concurrency(&json!(2), None).unwrap();
    let st = auto.get_state();
    assert!(st["settings"]["configs"][0].get("lanes").is_none());
    assert_eq!(st["settings"]["configs"][0]["concurrency"], 2);
    let mut bad = config.clone();
    bad["lanes"] = json!([{ "device": "renderD128", "concurrency": 2 }]);
    std::fs::write(d.path().join("settings.json"), json!({ "enabled": true, "intervalMinutes": 60, "config": bad }).to_string()).unwrap();
    let re = Auto::new(opts(s, scanner_of(Default::default(), Default::default()), d.path()));
    re.start();
    re.stop();
    wait_ticks(&re);
    let st = re.get_state();
    assert!(st["settings"]["configs"][0].get("lanes").is_none());
    assert_eq!(st["settings"]["configs"][0]["concurrency"], 5);
}

#[test]
fn plan_lanes_gives_own_devices_to_the_local_holder_and_nodes_by_priority() {
    let cars = vec![
        json!({ "sourceRoot": "/a", "lanes": [{ "device": "pci:0000:03:00.0", "concurrency": 2 }, { "device": "node:abcdefabcdef@cpu", "concurrency": 3 }] }),
        json!({ "sourceRoot": "/b", "lanes": [{ "device": "pci:0000:03:00.0", "concurrency": 1 }] }),
    ];
    let devices = vec![json!({ "id": "pci:0000:03:00.0", "kind": "dri" }), json!({ "id": "node:abcdefabcdef@cpu", "kind": "node", "slots": 4, "isDefault": true })];
    let plan = plan_lanes(&cars, &["/a".into(), "/b".into()], Some("/b"), &devices, &json!({}));
    assert_eq!(plan["/b"], vec![json!({ "device": "pci:0000:03:00.0", "concurrency": 1 })]);
    assert_eq!(plan["/a"], vec![json!({ "device": "node:abcdefabcdef@cpu", "concurrency": 3 })]);
    // the node's list puts /b first: /b gets its default device at what it converts now
    let plan = plan_lanes(&cars, &["/a".into(), "/b".into()], Some("/b"), &devices, &json!({ "node:abcdefabcdef": ["/b"] }));
    assert_eq!(plan["/b"], vec![json!({ "device": "pci:0000:03:00.0", "concurrency": 1 }), json!({ "device": "node:abcdefabcdef@cpu", "concurrency": 4 })]);
    assert!(plan["/a"].is_empty());
    let _ = Fail::default();
}

// ---- test/nodePriority.test.js (planning)

const GPU: &str = "pci:0000:03:00.0";
const N2: &str = "node:aaaaaaaaaaaa";
const N3: &str = "node:bbbbbbbbbbbb";
const NODE_KEY: &str = "node:cccccccccccc";

fn pcar(name: &str, lanes: Value) -> Value {
    json!({ "sourceRoot": format!("/cars/{name}"), "destinationRoot": null, "codec": "h265", "profileId": "balanced", "networkMode": "direct", "outputMode": "replace",
        "includedGroups": ["RecentClips"], "replacementConfirmed": true, "concurrency": 2, "verifyMode": "quick", "lanes": lanes })
}

fn roots(r: &[&str]) -> Vec<String> {
    r.iter().map(|x| format!("/cars/{x}")).collect()
}

#[test]
fn planning_a_node_serves_its_first_vehicle_else_helps_and_never_one_that_set_it_off() {
    let devices = vec![json!({ "id": GPU, "kind": "gpu" }), json!({ "id": N2, "kind": "node", "online": true, "slots": 2 }), json!({ "id": N3, "kind": "node", "online": true, "slots": 3 })];
    let a = pcar("a", json!([{ "device": GPU, "concurrency": 2 }, { "device": N2, "concurrency": 2 }]));
    let b = pcar("b", json!([{ "device": GPU, "concurrency": 1 }]));
    let cars = vec![a.clone(), b.clone()];
    let pr = json!({ N2: ["/cars/b"] });
    let plan = plan_lanes(&cars, &roots(&["a", "b"]), Some("/cars/a"), &devices, &pr);
    assert_eq!(plan["/cars/a"], vec![json!({ "device": GPU, "concurrency": 2 })]);
    assert_eq!(plan["/cars/b"], vec![json!({ "device": N2, "concurrency": 2 })]);
    let plan = plan_lanes(&cars, &roots(&["a"]), Some("/cars/a"), &devices, &pr);
    assert_eq!(plan["/cars/a"], vec![json!({ "device": GPU, "concurrency": 2 }), json!({ "device": N2, "concurrency": 2 })]);
    assert!(!plan["/cars/a"].iter().any(|l| l["device"] == N3));
    let plan = plan_lanes(&cars, &roots(&["b"]), None, &[json!({ "id": N2, "kind": "node", "online": false })], &pr);
    assert!(plan["/cars/b"].is_empty());
    let mut off = pcar("a", json!([{ "device": GPU, "concurrency": 2 }]));
    off["nodesOff"] = json!([N2]);
    let b1 = pcar("b", json!([{ "device": N2, "concurrency": 1 }]));
    let plan = plan_lanes(&[off, b1], &roots(&["a", "b"]), Some("/cars/a"), &devices, &json!({ N2: ["/cars/a", "/cars/b"] }));
    assert_eq!(plan["/cars/a"], vec![json!({ "device": GPU, "concurrency": 2 })]);
    assert_eq!(plan["/cars/b"], vec![json!({ "device": N2, "concurrency": 1 })]);
}

#[test]
fn planning_with_a_nodes_devices_the_node_goes_to_one_vehicle_as_a_whole() {
    let ngpu = format!("{NODE_KEY}@pci:0000:01:00.0");
    let ncpu = format!("{NODE_KEY}@cpu");
    let node_gpu = json!({ "id": ngpu, "kind": "node", "isDefault": true, "online": true, "slots": 2 });
    let node_cpu = json!({ "id": ncpu, "kind": "node", "isDefault": false, "online": true, "slots": 0 });
    let devices = vec![json!({ "id": GPU, "kind": "gpu" }), node_gpu.clone(), node_cpu.clone()];
    let a = pcar("a", json!([{ "device": GPU, "concurrency": 2 }, { "device": ngpu, "concurrency": 2 }, { "device": ncpu, "concurrency": 1 }]));
    let b = pcar("b", json!([{ "device": GPU, "concurrency": 1 }]));
    let pr = json!({ NODE_KEY: ["/cars/b"] });
    let plan = plan_lanes(&[a.clone(), b.clone()], &roots(&["a", "b"]), Some("/cars/a"), &devices, &pr);
    assert_eq!(plan["/cars/b"], vec![json!({ "device": ngpu, "concurrency": 2 })]);
    assert_eq!(plan["/cars/a"], vec![json!({ "device": GPU, "concurrency": 2 })]);
    let plan = plan_lanes(&[a.clone(), b.clone()], &roots(&["a"]), Some("/cars/a"), &devices, &pr);
    assert_eq!(plan["/cars/a"], vec![json!({ "device": GPU, "concurrency": 2 }), json!({ "device": ngpu, "concurrency": 2 }), json!({ "device": ncpu, "concurrency": 1 })]);
    let mut off = a.clone();
    off["nodesOff"] = json!([NODE_KEY]);
    let plan = plan_lanes(&[off, b.clone()], &roots(&["a"]), Some("/cars/a"), &devices, &json!({ NODE_KEY: ["/cars/a"] }));
    assert_eq!(plan["/cars/a"], vec![json!({ "device": GPU, "concurrency": 2 })]);
    let old = pcar("old", json!([{ "device": GPU, "concurrency": 1 }, { "device": NODE_KEY, "concurrency": 3 }]));
    let plan = plan_lanes(&[old], &roots(&["old"]), Some("/cars/old"), &devices, &json!({}));
    assert_eq!(plan["/cars/old"], vec![json!({ "device": GPU, "concurrency": 1 }), json!({ "device": ngpu, "concurrency": 3 })]);
    let mut g2 = node_gpu.clone();
    g2["online"] = json!(false);
    let mut c2 = node_cpu.clone();
    c2["online"] = json!(false);
    let plan = plan_lanes(&[a], &roots(&["a"]), Some("/cars/a"), &[json!({ "id": GPU, "kind": "gpu" }), g2, c2], &json!({}));
    assert_eq!(plan["/cars/a"], vec![json!({ "device": GPU, "concurrency": 2 })]);
}

fn young_setup(dir: &Path, key: Option<&str>) -> (Arc<Auto>, Value, Arc<std::sync::atomic::AtomicI64>) {
    let now = Arc::new(std::sync::atomic::AtomicI64::new(0));
    let key = key.map(str::to_string);
    let scanner: Arc<Scanner> = Arc::new(move |_c: &Value, _a: &AtomicBool, out: &mut dyn FnMut(Value) -> bool| {
        let mut d = json!({ "relativePath": "RecentClips/2026-11-20_10-00-00-front.mp4", "sourceBytes": 100, "mtimeMs": 1, "camera": "front" });
        if let Some(k) = &key {
            d["timestampKey"] = json!(k);
        }
        out(d);
        Ok(())
    });
    let mut o = opts(Arc::new(FakeService::default()), scanner, dir);
    let n = now.clone();
    o.now = Arc::new(move || n.load(std::sync::atomic::Ordering::SeqCst));
    let c = json!({ "sourceRoot": dir.join("src"), "autoConvert": true, "keepRecent": { "days": 7, "zone": "UTC" } });
    (Auto::new(o), c, now)
}

fn at_ms(y: i32, mo: u32, d: u32) -> i64 {
    chrono::NaiveDate::from_ymd_opt(y, mo, d).unwrap().and_hms_opt(12, 0, 0).unwrap().and_utc().timestamp() * 1000
}

const YOUNG_CLIP: &str = "RecentClips/2026-11-20_10-00-00-front.mp4";

fn young_d() -> Value {
    json!({ "relativePath": YOUNG_CLIP, "sourceBytes": 100, "mtimeMs": 1, "timestampKey": "2026-11-20_10-00-00", "camera": "front" })
}

#[test]
fn young_clip_is_deferred_then_converted_once_old() {
    let d = tempdir().unwrap();
    let (auto, c, now) = young_setup(d.path(), Some("2026-11-20_10-00-00"));
    now.store(at_ms(2026, 11, 21), std::sync::atomic::Ordering::SeqCst);
    assert!(auto.is_known(&c, &young_d()));
    assert_eq!(auto.sweep(&c).unwrap(), 0);
    assert!(auto.lock().indexes.get(&setup_key(&c)).is_none_or(|ix| !ix.files.contains_key(YOUNG_CLIP) && !ix.gave_up.contains_key(YOUNG_CLIP)));
    now.store(at_ms(2026, 11, 28), std::sync::atomic::Ordering::SeqCst);
    assert!(!auto.is_known(&c, &young_d()));
    assert_eq!(auto.sweep(&c).unwrap(), 1);
}

#[test]
fn manual_jobs_ignore_keep_recent() {
    let d = tempdir().unwrap();
    let (auto, mut c, now) = young_setup(d.path(), Some("2026-11-20_10-00-00"));
    c.as_object_mut().unwrap().remove("autoConvert");
    now.store(at_ms(2026, 11, 21), std::sync::atomic::Ordering::SeqCst);
    assert!(!auto.is_known(&c, &young_d()));
}

#[test]
fn unknown_date_is_left_alone() {
    let d = tempdir().unwrap();
    let (auto, c, now) = young_setup(d.path(), None);
    now.store(at_ms(2026, 11, 21), std::sync::atomic::Ordering::SeqCst);
    let no_key = json!({ "relativePath": "RecentClips/x.mp4", "sourceBytes": 100, "mtimeMs": 1 });
    assert!(auto.is_known(&c, &no_key));
    assert_eq!(auto.sweep(&c).unwrap(), 0);
    let mut plain = c.clone();
    plain.as_object_mut().unwrap().remove("keepRecent");
    assert!(!auto.is_known(&plain, &no_key));
}

fn stored_config(t: &Cars, root: &str) -> Value {
    t.auto.get_state()["settings"]["configs"].as_array().unwrap().iter().find(|c| c["sourceRoot"] == root).cloned().unwrap()
}

#[test]
fn original_save_keeps_keep_recent() {
    let t = cars();
    let mut first = car("/cars/a", "h265");
    first["keepRecent"] = json!({ "days": 30, "zone": "UTC" });
    t.auto.configure(&shared(json!({ "enabled": true, "config": first }))).unwrap();
    wait_ticks(&t.auto);
    t.auto.configure(&shared(json!({ "enabled": true, "config": car("/cars/a", "av1") }))).unwrap();
    wait_ticks(&t.auto);
    let c = stored_config(&t, "/cars/a");
    assert_eq!(c["codec"], "av1");
    assert_eq!(c["keepRecent"]["days"], 30);
}

#[test]
fn null_keep_recent_removes_it() {
    let t = cars();
    let mut first = car("/cars/a", "h265");
    first["keepRecent"] = json!({ "days": 30, "zone": "UTC" });
    t.auto.configure(&shared(json!({ "enabled": true, "config": first }))).unwrap();
    wait_ticks(&t.auto);
    let mut off = car("/cars/a", "h265");
    off["keepRecent"] = Value::Null;
    t.auto.configure(&shared(json!({ "enabled": true, "config": off }))).unwrap();
    wait_ticks(&t.auto);
    assert!(stored_config(&t, "/cars/a").get("keepRecent").is_none());
}

#[test]
fn saved_but_not_automatic_vehicle_keeps_keep_recent_too() {
    let t = cars();
    let mut first = car("/cars/a", "h265");
    first["keepRecent"] = json!({ "days": 7, "zone": "UTC" });
    t.auto.save_vehicle(&first).unwrap();
    t.auto.save_vehicle(&car("/cars/a", "av1")).unwrap();
    let saved = t.auto.lock().saved.clone();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0]["codec"], "av1");
    assert_eq!(saved[0]["keepRecent"]["days"], 7);
    let mut off = car("/cars/a", "av1");
    off["keepRecent"] = Value::Null;
    t.auto.save_vehicle(&off).unwrap();
    assert!(t.auto.lock().saved[0].get("keepRecent").is_none());
}
