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

// ---- calendar schedules

fn utc_ms(y: i32, mo: u32, d: u32, h: u32) -> i64 {
    chrono::NaiveDate::from_ymd_opt(y, mo, d).unwrap().and_hms_opt(h, 0, 0).unwrap().and_utc().timestamp() * 1000
}

fn nightly() -> Value {
    json!({ "kind": "daily", "hour": 2, "zone": "UTC" })
}

struct Sched {
    d: crate::converter::testutil::TempDir,
    auto: Arc<Auto>,
    s: Arc<FakeService>,
    now: Arc<std::sync::atomic::AtomicI64>,
    scans: Arc<std::sync::atomic::AtomicUsize>,
}

impl Sched {
    fn at(&self, ms: i64) {
        self.now.store(ms, std::sync::atomic::Ordering::SeqCst);
    }
    fn scans(&self) -> usize {
        self.scans.load(std::sync::atomic::Ordering::SeqCst)
    }
    fn status(&self, k: &str) -> Value {
        self.auto.get_state()["status"][k].clone()
    }
    fn settings(&self) -> Value {
        self.auto.get_state()["settings"].clone()
    }
}

/// A store in `d` whose clock reads `now`; each vehicle folder holds 2 new clips, and every scan is counted.
fn sched_in(d: crate::converter::testutil::TempDir, now: i64) -> Sched {
    sched_with(d, now, |_| {})
}

/// sched_in, with the options changed by `tweak` before the store is made.
fn sched_with(d: crate::converter::testutil::TempDir, now: i64, tweak: impl FnOnce(&mut AutoOptions)) -> Sched {
    let s = Arc::new(FakeService::default());
    let scans = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = scans.clone();
    let scanner: Arc<Scanner> = Arc::new(move |_c: &Value, _a: &AtomicBool, out: &mut dyn FnMut(Value) -> bool| {
        counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        for i in 0..2 {
            out(json!({ "relativePath": format!("RecentClips/{i}.mp4"), "sourceBytes": 100, "mtimeMs": 1 }));
        }
        Ok(())
    });
    let clock = Arc::new(std::sync::atomic::AtomicI64::new(now));
    let mut o = opts(s.clone(), scanner, d.path());
    let c = clock.clone();
    o.now = Arc::new(move || c.load(std::sync::atomic::Ordering::SeqCst));
    o.hour_of = Arc::new(|ms| (ms / 3_600_000).rem_euclid(24));
    tweak(&mut o);
    let auto = Auto::new(o);
    Sched { d, auto, s, now: clock, scans }
}

fn sched(now: i64) -> Sched {
    sched_in(tempdir().unwrap(), now)
}

fn nightly_without_catch_up(t: &Sched) {
    t.auto.configure(&shared(json!({ "enabled": true, "configs": [car("/cars/a", "h265")], "schedule": nightly(), "catchUp": false }))).unwrap();
    wait_ticks(&t.auto);
}

fn no_schedule(settings: &Value) -> bool {
    settings.get("schedule").is_none_or(Value::is_null)
}

#[test]
fn daily_schedule_sets_next_check() {
    let t = sched(utc_ms(2026, 11, 21, 10));
    nightly_without_catch_up(&t);
    assert_eq!(t.status("nextCheckAt"), json!(utc_ms(2026, 11, 22, 2)));
    assert!(t.s.started().is_empty());
    let st = t.settings();
    assert_eq!(st["schedule"], nightly());
    assert_eq!(st["catchUp"], false);
    assert_eq!(st["intervalMinutes"], 1440, "Original's dropdown reads every 24 hours");
    assert_eq!(st["window"], Value::Null);
}

#[test]
fn due_check_runs_then_moves_to_next_slot() {
    let t = sched(utc_ms(2026, 11, 21, 10));
    nightly_without_catch_up(&t);
    t.at(utc_ms(2026, 11, 22, 2));
    t.auto.tick();
    assert_eq!(t.s.started().len(), 1);
    assert_eq!(t.status("nextCheckAt"), json!(utc_ms(2026, 11, 23, 2)));
    assert_eq!(t.status("lastCheckAt"), json!(utc_ms(2026, 11, 22, 2)));
}

#[test]
fn one_catch_up_after_downtime() {
    let now = utc_ms(2026, 11, 21, 10);
    let d = tempdir().unwrap();
    let settings = json!({ "enabled": true, "intervalMinutes": 1440, "window": null, "holdManual": false, "keepRunning": false, "openAtLogin": false,
        "configs": [car("/cars/a", "h265")], "schedule": nightly(), "catchUp": false });
    std::fs::write(d.path().join("settings.json"), settings.to_string()).unwrap();
    std::fs::write(d.path().join("state.json"), json!({ "lastCheckAt": now - 3 * 86_400_000 }).to_string()).unwrap();
    let t = sched_in(d, now);
    t.auto.start();
    t.auto.tick();
    assert_eq!(t.scans(), 1, "one catch-up round, not one per missed night");
    assert_eq!(t.s.started().len(), 1);
    t.s.set("job-1", |j| j["state"] = json!("completed"));
    t.auto.tick();
    t.auto.tick();
    assert_eq!(t.scans(), 1);
    assert_eq!(t.s.started().len(), 1);
    assert_eq!(t.status("nextCheckAt"), json!(utc_ms(2026, 11, 22, 2)));
    t.auto.stop();
}

#[test]
fn no_catch_up_when_nothing_was_missed() {
    let now = utc_ms(2026, 11, 21, 10);
    let d = tempdir().unwrap();
    let settings = json!({ "enabled": true, "intervalMinutes": 1440, "window": null, "configs": [car("/cars/a", "h265")], "schedule": nightly(), "catchUp": false });
    std::fs::write(d.path().join("settings.json"), settings.to_string()).unwrap();
    std::fs::write(d.path().join("state.json"), json!({ "lastCheckAt": utc_ms(2026, 11, 21, 2) }).to_string()).unwrap();
    let t = sched_in(d, now);
    t.auto.start();
    t.auto.tick();
    assert_eq!(t.scans(), 0);
    assert_eq!(t.status("nextCheckAt"), json!(utc_ms(2026, 11, 22, 2)));
    assert_eq!(t.status("lastCheckAt"), json!(utc_ms(2026, 11, 21, 2)));
    t.auto.stop();
}

#[test]
fn a_scheduled_check_is_remembered_across_a_restart() {
    let t = sched(utc_ms(2026, 11, 21, 10));
    nightly_without_catch_up(&t);
    t.at(utc_ms(2026, 11, 22, 2));
    t.auto.tick();
    t.s.set("job-1", |j| j["state"] = json!("completed"));
    t.auto.tick();
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(t.d.path().join("state.json")).unwrap()).unwrap();
    assert_eq!(saved["lastCheckAt"], json!(utc_ms(2026, 11, 22, 2)));
    // back an hour later: nothing missed, so no check until the next night
    let again = sched_in(t.d, utc_ms(2026, 11, 22, 3));
    again.auto.start();
    again.auto.tick();
    assert_eq!(again.scans(), 0);
    assert_eq!(again.status("nextCheckAt"), json!(utc_ms(2026, 11, 23, 2)));
    again.auto.stop();
}

#[test]
fn original_save_keeps_calendar() {
    let t = sched(utc_ms(2026, 11, 21, 10));
    nightly_without_catch_up(&t);
    t.auto.configure(&shared(json!({ "enabled": true, "intervalMinutes": 1440, "window": null, "config": car("/cars/a", "av1") }))).unwrap();
    wait_ticks(&t.auto);
    let st = t.settings();
    assert_eq!(st["schedule"], nightly());
    assert_eq!(st["catchUp"], false, "Original doesn't send the catch-up switch either");
    assert_eq!(st["configs"][0]["codec"], "av1");
    assert_eq!(t.status("nextCheckAt"), json!(utc_ms(2026, 11, 22, 2)));
    assert!(t.s.started().is_empty());
}

#[test]
fn original_save_keeps_calendar_with_off_peak() {
    let t = sched(utc_ms(2026, 11, 21, 10));
    let off_peak = json!({ "follow": "off-peak" });
    t.auto.configure(&shared(json!({ "enabled": true, "window": off_peak, "configs": [car("/cars/a", "h265")], "schedule": nightly(), "catchUp": false }))).unwrap();
    wait_ticks(&t.auto);
    assert_eq!(t.settings()["window"], off_peak);
    assert_eq!(t.settings()["intervalMinutes"], 1440);
    t.auto.configure(&shared(json!({ "enabled": true, "intervalMinutes": 1440, "window": off_peak, "config": car("/cars/a", "av1") }))).unwrap();
    wait_ticks(&t.auto);
    assert_eq!(t.settings()["schedule"], nightly());
    assert_eq!(t.settings()["window"], off_peak);
    // a different window from Original replaces the calendar
    t.auto.configure(&shared(json!({ "enabled": true, "intervalMinutes": 1440, "window": null, "config": car("/cars/a", "av1") }))).unwrap();
    wait_ticks(&t.auto);
    assert!(no_schedule(&t.settings()));
}

#[test]
fn original_save_vehicle_keeps_calendar() {
    let t = sched(utc_ms(2026, 11, 21, 10));
    nightly_without_catch_up(&t);
    t.auto.save_vehicle(&car("/cars/a", "av1")).unwrap();
    wait_ticks(&t.auto);
    let st = t.settings();
    assert_eq!(st["schedule"], nightly());
    assert_eq!(st["configs"][0]["codec"], "av1");
    assert!(t.s.started().is_empty());
}

#[test]
fn original_interval_change_clears_calendar() {
    let t = sched(utc_ms(2026, 11, 21, 10));
    nightly_without_catch_up(&t);
    t.auto.configure(&shared(json!({ "enabled": true, "intervalMinutes": 60, "window": null, "config": car("/cars/a", "h265") }))).unwrap();
    wait_ticks(&t.auto);
    let st = t.settings();
    assert!(no_schedule(&st));
    assert_eq!(st["intervalMinutes"], 60);
}

#[test]
fn null_schedule_clears_calendar() {
    let t = sched(utc_ms(2026, 11, 21, 10));
    nightly_without_catch_up(&t);
    t.auto.configure(&shared(json!({ "enabled": true, "intervalMinutes": 1440, "window": null, "schedule": null, "config": car("/cars/a", "h265") }))).unwrap();
    wait_ticks(&t.auto);
    assert!(no_schedule(&t.settings()));
    assert_eq!(t.settings()["intervalMinutes"], 1440);
}

#[test]
fn asap_is_interval_60() {
    let now = utc_ms(2026, 11, 21, 10);
    let t = sched(now);
    t.auto.configure(&shared(json!({ "enabled": true, "intervalMinutes": 60, "schedule": null, "config": car("/cars/a", "h265") }))).unwrap();
    wait_ticks(&t.auto);
    assert_eq!(t.s.started().len(), 1, "saving checks at once, as today");
    assert_eq!(t.status("nextCheckAt"), json!(now + 60 * 60_000));
    assert!(no_schedule(&t.settings()));
}

#[test]
fn save_without_catch_up_does_not_tick_now() {
    let t = sched(utc_ms(2026, 11, 21, 10));
    nightly_without_catch_up(&t);
    assert!(t.s.started().is_empty());
    assert_eq!(t.scans(), 0);
    // the next timer tick (still before 02:00) doesn't check the new vehicle either
    t.at(utc_ms(2026, 11, 21, 10) + 30_000);
    t.auto.tick();
    assert_eq!(t.scans(), 0);
    assert!(t.s.started().is_empty());
}

#[test]
fn a_bad_schedule_is_refused() {
    let t = sched(utc_ms(2026, 11, 21, 10));
    let bad = json!({ "kind": "monthly", "day": 31, "hour": 2, "zone": "UTC" });
    let e = t.auto.configure(&shared(json!({ "enabled": true, "configs": [car("/cars/a", "h265")], "schedule": bad }))).unwrap_err();
    assert_eq!(e, "INVALID_AUTO_SCHEDULE");
}

fn saved_state(t: &Sched) -> Value {
    serde_json::from_str(&std::fs::read_to_string(t.d.path().join("state.json")).unwrap()).unwrap()
}

fn two_nightly_cars(t: &Sched) {
    t.auto.configure(&shared(json!({ "enabled": true, "configs": [car("/cars/a", "h265"), car("/cars/b", "h265")], "schedule": nightly(), "catchUp": false }))).unwrap();
    wait_ticks(&t.auto);
}

#[test]
fn a_check_now_cut_short_by_a_restart_checks_again() {
    let t = sched(utc_ms(2026, 11, 21, 10));
    two_nightly_cars(&t);
    t.auto.check_now();
    assert_eq!(t.s.started().len(), 1, "one job at a time: /cars/b waits");
    assert!(saved_state(&t)["nextCheckAt"].as_i64().unwrap() <= utc_ms(2026, 11, 21, 10), "saved as due while /cars/b has no job");
    let again = sched_in(t.d, utc_ms(2026, 11, 21, 11));
    again.auto.start();
    assert_eq!(again.scans(), 2, "both vehicles checked again");
    again.auto.stop();
}

#[test]
fn a_round_saves_its_next_time_once_its_jobs_are_done() {
    let t = sched(utc_ms(2026, 11, 22, 2));
    two_nightly_cars(&t);
    t.auto.check_now();
    t.s.set("job-1", |j| j["state"] = json!("completed"));
    t.auto.tick();
    assert_eq!(t.s.started().len(), 2);
    assert_eq!(saved_state(&t)["nextCheckAt"], json!(utc_ms(2026, 11, 22, 2)), "a running job may still have a next part");
    t.s.set("job-2", |j| j["state"] = json!("completed"));
    t.auto.tick();
    let st = saved_state(&t);
    assert_eq!((st["lastCheckAt"].clone(), st["nextCheckAt"].clone()), (json!(utc_ms(2026, 11, 22, 2)), json!(utc_ms(2026, 11, 23, 2))));
    assert_eq!(st["schedule"], nightly());
}

#[test]
fn changing_the_schedule_mid_round_keeps_the_round_due() {
    let t = sched(utc_ms(2026, 11, 22, 2));
    two_nightly_cars(&t);
    t.auto.check_now();
    let weekly = json!({ "kind": "weekly", "weekday": 3, "hour": 2, "zone": "UTC" });
    t.auto.configure(&shared(json!({ "enabled": true, "intervalMinutes": 1440, "schedule": weekly, "config": car("/cars/a", "h265") }))).unwrap();
    assert!(saved_state(&t)["nextCheckAt"].as_i64().unwrap() <= utc_ms(2026, 11, 22, 2));
    assert_eq!(t.status("nextCheckAt"), json!(utc_ms(2026, 11, 25, 2)));
}

#[test]
fn a_next_part_waiting_outside_the_window_survives_a_restart() {
    let t = sched(utc_ms(2026, 11, 22, 2));
    let window = json!({ "startHour": 1, "endHour": 5 });
    t.auto.configure(&shared(json!({ "enabled": true, "window": window, "configs": [car("/cars/a", "h265")], "schedule": nightly(), "catchUp": false }))).unwrap();
    t.auto.check_now();
    assert_eq!(t.s.started().len(), 1);
    t.at(utc_ms(2026, 11, 22, 6));
    t.s.set("job-1", |j| {
        j["state"] = json!("completed");
        j["moreAfter"] = json!("RecentClips/1.mp4");
    });
    t.auto.tick();
    assert!(saved_state(&t)["nextCheckAt"].as_i64().unwrap() <= utc_ms(2026, 11, 22, 6));
    let again = sched_in(t.d, utc_ms(2026, 11, 22, 7));
    again.auto.start();
    assert_eq!(again.status("nextCheckAt"), json!(utc_ms(2026, 11, 22, 7)), "due: the next part goes once the window opens");
    again.auto.stop();
}

#[test]
fn turned_off_over_a_scheduled_time_then_on_waits_for_the_next() {
    let t = sched(utc_ms(2026, 11, 21, 10));
    nightly_without_catch_up(&t);
    t.auto.configure(&shared(json!({ "enabled": false, "intervalMinutes": 1440, "removeSource": "/cars/a" }))).unwrap();
    let again = sched_in(t.d, utc_ms(2026, 11, 22, 3));
    again.auto.start();
    again.auto.configure(&shared(json!({ "enabled": true, "intervalMinutes": 1440, "config": car("/cars/a", "h265") }))).unwrap();
    again.auto.tick();
    assert_eq!(again.scans(), 0);
    assert_eq!(again.status("nextCheckAt"), json!(utc_ms(2026, 11, 23, 2)));
    again.auto.stop();
}

#[test]
fn times_saved_for_another_schedule_are_ignored() {
    let now = utc_ms(2026, 11, 21, 10);
    let d = tempdir().unwrap();
    let settings = json!({ "enabled": true, "intervalMinutes": 1440, "window": null, "configs": [car("/cars/a", "h265")], "schedule": nightly(), "catchUp": false });
    std::fs::write(d.path().join("settings.json"), settings.to_string()).unwrap();
    let monthly = json!({ "kind": "monthly", "day": 1, "hour": 2, "zone": "UTC" });
    std::fs::write(d.path().join("state.json"), json!({ "lastCheckAt": now - 3 * 86_400_000, "nextCheckAt": utc_ms(2026, 12, 1, 2), "schedule": monthly }).to_string()).unwrap();
    let t = sched_in(d, now);
    t.auto.start();
    assert_eq!(t.scans(), 0);
    assert_eq!(t.status("nextCheckAt"), json!(utc_ms(2026, 11, 22, 2)));
    t.auto.stop();
}

#[test]
fn a_round_owed_after_a_restart_stays_due_when_the_schedule_changes() {
    let t = sched(utc_ms(2026, 11, 22, 2));
    let window = json!({ "startHour": 1, "endHour": 5 });
    t.auto.configure(&shared(json!({ "enabled": true, "window": window, "configs": [car("/cars/a", "h265")], "schedule": nightly(), "catchUp": false }))).unwrap();
    t.auto.check_now();
    let again = sched_in(t.d, utc_ms(2026, 11, 22, 7));
    again.auto.start();
    let weekly = json!({ "kind": "weekly", "weekday": 3, "hour": 2, "zone": "UTC" });
    again.auto.configure(&shared(json!({ "enabled": true, "intervalMinutes": 1440, "window": window, "schedule": weekly, "config": car("/cars/a", "h265") }))).unwrap();
    assert_eq!(again.status("nextCheckAt"), json!(utc_ms(2026, 11, 22, 7)), "still owed: it runs once the window opens");
    again.at(utc_ms(2026, 11, 23, 1));
    again.auto.tick();
    assert_eq!(again.scans(), 1);
    assert_eq!(again.status("nextCheckAt"), json!(utc_ms(2026, 11, 25, 2)));
    again.auto.stop();
}

// ---- the catch-up run

fn in_catch_up(t: &Sched, root: &str) -> bool {
    t.status("catchUp").get(root).is_some()
}

/// A store whose off-peak plan reads `cheap` (true: the cheapest rate is in force now).
fn sched_off_peak(now: i64, cheap: bool) -> (Sched, Arc<AtomicBool>) {
    let flag = Arc::new(AtomicBool::new(cheap));
    let f = flag.clone();
    let t = sched_with(tempdir().unwrap(), now, move |o| o.is_cheap_now = Some(Arc::new(move |_t| Some(f.load(Ordering::SeqCst)))));
    (t, flag)
}

/// Each folder holds 2 clips recorded long ago, so a keep window never holds them back.
fn dated_clips(o: &mut AutoOptions) {
    o.scanner = Arc::new(|_c: &Value, _a: &AtomicBool, out: &mut dyn FnMut(Value) -> bool| {
        for i in 0..2 {
            out(json!({ "relativePath": format!("RecentClips/2026-01-01_10-0{i}-00-front.mp4"), "sourceBytes": 100, "mtimeMs": 1, "timestampKey": format!("2026-01-01_10-0{i}-00"), "camera": "front" }));
        }
        Ok(())
    });
}

fn finish(t: &Sched, id: &str, more: bool) {
    t.s.set(id, |j| {
        j["state"] = json!("completed");
        if more {
            j["moreAfter"] = json!("RecentClips/1.mp4");
        }
    });
}

/// A guided save of one vehicle: nightly at 02:00 with the catch-up switch on.
fn save_nightly(t: &Sched, config: Value) {
    t.auto.configure(&shared(json!({ "enabled": true, "schedule": nightly(), "catchUp": true, "config": config }))).unwrap();
    wait_ticks(&t.auto);
}

#[test]
fn new_vehicle_starts_catch_up_now() {
    let now = utc_ms(2026, 11, 21, 10);
    let t = sched(now);
    t.auto.configure(&shared(json!({ "enabled": true, "configs": [car("/cars/a", "h265")], "schedule": nightly(), "catchUp": true }))).unwrap();
    wait_ticks(&t.auto);
    assert_eq!(t.s.started().len(), 1, "the new vehicle's job starts on the save, not at 02:00");
    assert_eq!(t.status("catchUp")["/cars/a"], json!({ "since": now }));
    assert_eq!(t.status("nextCheckAt"), json!(utc_ms(2026, 11, 22, 2)), "the schedule itself stays");
    assert_eq!(saved_state(&t)["catchUp"]["/cars/a"]["since"], json!(now));
}

#[test]
fn catch_up_ignores_off_peak() {
    let now = utc_ms(2026, 11, 21, 10);
    let off_peak = json!({ "follow": "off-peak" });
    let (t, _) = sched_off_peak(now, false);
    t.auto.configure(&shared(json!({ "enabled": true, "window": off_peak, "configs": [car("/cars/a", "h265")], "schedule": nightly(), "catchUp": true }))).unwrap();
    wait_ticks(&t.auto);
    assert_eq!(t.s.started().len(), 1, "starts outside the cheap period");
    t.auto.tick();
    assert!(t.s.paused.lock().unwrap().is_empty(), "not paused for the window");
    assert_eq!(t.status("pausedForWindow"), false);
    // a job outside a catch-up run still pauses when the cheap period ends
    let (u, cheap) = sched_off_peak(now, true);
    u.auto.configure(&shared(json!({ "enabled": true, "window": off_peak, "configs": [car("/cars/a", "h265")], "schedule": nightly(), "catchUp": false }))).unwrap();
    wait_ticks(&u.auto);
    u.auto.check_now();
    assert_eq!(u.s.started().len(), 1);
    cheap.store(false, Ordering::SeqCst);
    u.auto.tick();
    assert_eq!(*u.s.paused.lock().unwrap(), vec!["job-1".to_string()]);
}

#[test]
fn catch_up_ends_when_nothing_left() {
    let t = sched(utc_ms(2026, 11, 21, 10));
    t.auto.configure(&shared(json!({ "enabled": true, "configs": [car("/cars/a", "h265")], "schedule": nightly(), "catchUp": true }))).unwrap();
    wait_ticks(&t.auto);
    finish(&t, "job-1", true);
    t.auto.tick();
    assert_eq!(t.s.started().len(), 2, "the next part goes at once, not at 02:00");
    assert!(in_catch_up(&t, "/cars/a"));
    finish(&t, "job-2", false);
    t.auto.tick();
    assert!(!in_catch_up(&t, "/cars/a"));
    assert!(t.status("catchUp").is_null(), "no key once no vehicle is catching up");
    assert!(saved_state(&t).get("catchUp").is_none());
    assert_eq!(t.s.started().len(), 2);
}

#[test]
fn a_check_that_finds_nothing_ends_catch_up() {
    let t = cars();
    t.auto.configure(&shared(json!({ "enabled": true, "catchUp": true, "config": car("/cars/b", "h265") }))).unwrap();
    wait_ticks(&t.auto);
    assert_eq!(t.auto.get_state()["status"]["sources"]["/cars/b"]["lastNewFiles"], 0);
    assert!(t.auto.get_state()["status"].get("catchUp").is_none());
}

#[test]
fn user_pause_holds() {
    let (t, cheap) = sched_off_peak(utc_ms(2026, 11, 21, 10), true);
    t.auto.configure(&shared(json!({ "enabled": true, "window": { "follow": "off-peak" }, "configs": [car("/cars/a", "h265")], "schedule": nightly(), "catchUp": true }))).unwrap();
    wait_ticks(&t.auto);
    assert_eq!(t.s.started().len(), 1);
    t.s.set("job-1", |j| j["state"] = json!("paused"));
    t.auto.tick();
    cheap.store(false, Ordering::SeqCst);
    t.auto.tick();
    cheap.store(true, Ordering::SeqCst);
    t.auto.tick();
    // nor at the next scheduled check
    t.at(utc_ms(2026, 11, 22, 2));
    t.auto.tick();
    assert!(t.s.resumed.lock().unwrap().is_empty(), "only Resume resumes it");
    assert!(t.s.paused.lock().unwrap().is_empty());
    assert!(in_catch_up(&t, "/cars/a"));
}

#[test]
fn shorter_keep_restarts_catch_up() {
    let t = sched_with(tempdir().unwrap(), utc_ms(2026, 11, 21, 10), dated_clips);
    let keep = |days: i64| {
        let mut c = car("/cars/a", "h265");
        c["keepRecent"] = json!({ "days": days, "zone": "UTC" });
        c
    };
    save_nightly(&t, keep(30));
    assert_eq!(t.s.started().len(), 1);
    finish(&t, "job-1", false);
    t.auto.tick();
    assert!(!in_catch_up(&t, "/cars/a"));
    save_nightly(&t, keep(7));
    assert!(in_catch_up(&t, "/cars/a"), "a shorter keep window makes more footage eligible");
    assert_eq!(t.s.started().len(), 2, "and its job starts now");
    finish(&t, "job-2", false);
    t.auto.tick();
    save_nightly(&t, keep(30));
    assert!(!in_catch_up(&t, "/cars/a"), "a longer one doesn't");
    assert_eq!(t.s.started().len(), 2);
}

#[test]
fn a_group_switched_on_or_a_new_level_restarts_catch_up_and_other_changes_do_not() {
    let t = sched(utc_ms(2026, 11, 21, 10));
    let done = |id: &str| {
        finish(&t, id, false);
        t.auto.tick();
        assert!(!in_catch_up(&t, "/cars/a"));
    };
    let base = car("/cars/a", "h265");
    save_nightly(&t, base.clone());
    done("job-1");
    let mut codec = base.clone();
    codec["codec"] = json!("av1");
    save_nightly(&t, codec.clone());
    assert!(!in_catch_up(&t, "/cars/a"), "a codec change alone doesn't");
    let mut fewer = codec.clone();
    fewer["includedGroups"] = json!([]);
    save_nightly(&t, fewer.clone());
    assert!(!in_catch_up(&t, "/cars/a"), "nor a group switched off");
    let mut groups = codec.clone();
    groups["includedGroups"] = json!(["RecentClips", "SentryClips"]);
    save_nightly(&t, groups.clone());
    assert!(in_catch_up(&t, "/cars/a"), "a group switched on");
    assert_eq!(t.s.started().len(), 2);
    done("job-2");
    let mut level = groups.clone();
    level["profileId"] = json!("aggressive");
    save_nightly(&t, level);
    assert!(in_catch_up(&t, "/cars/a"), "a new space level");
    assert_eq!(t.s.started().len(), 3);
}

#[test]
fn removing_a_vehicle_drops_its_catch_up_and_adding_it_back_starts_another() {
    let t = sched(utc_ms(2026, 11, 21, 10));
    save_nightly(&t, car("/cars/a", "h265"));
    assert!(in_catch_up(&t, "/cars/a"));
    t.auto.configure(&shared(json!({ "enabled": false, "removeSource": "/cars/a" }))).unwrap();
    wait_ticks(&t.auto);
    assert!(!in_catch_up(&t, "/cars/a"));
    assert!(saved_state(&t).get("catchUp").is_none());
    finish(&t, "job-1", false);
    t.auto.tick();
    save_nightly(&t, car("/cars/a", "h265"));
    assert!(in_catch_up(&t, "/cars/a"));
    assert_eq!(t.s.started().len(), 2);
}

#[test]
fn a_catch_up_run_carries_on_after_a_restart() {
    let now = utc_ms(2026, 11, 21, 10);
    let t = sched(now);
    t.auto.configure(&shared(json!({ "enabled": true, "configs": [car("/cars/a", "h265")], "schedule": nightly(), "catchUp": true }))).unwrap();
    wait_ticks(&t.auto);
    assert_eq!(t.s.started().len(), 1);
    let again = sched_in(t.d, utc_ms(2026, 11, 21, 11));
    again.auto.start();
    assert_eq!(again.s.started().len(), 1, "the run goes on at once, not at 02:00");
    assert_eq!(again.status("catchUp")["/cars/a"], json!({ "since": now }));
    again.auto.stop();
}

#[test]
fn turning_the_switch_off_ends_the_runs() {
    let off_peak = json!({ "follow": "off-peak" });
    let (t, _) = sched_off_peak(utc_ms(2026, 11, 21, 10), false);
    let save = |catch_up: bool| {
        t.auto.configure(&shared(json!({ "enabled": true, "window": off_peak, "configs": [car("/cars/a", "h265")], "schedule": nightly(), "catchUp": catch_up }))).unwrap();
        wait_ticks(&t.auto);
    };
    save(true);
    assert_eq!(t.s.started().len(), 1);
    save(false);
    assert!(t.status("catchUp").is_null());
    t.auto.tick();
    assert_eq!(*t.s.paused.lock().unwrap(), vec!["job-1".to_string()], "the window applies again");
}

#[test]
fn catch_up_means_the_same_in_interval_mode() {
    let window = json!({ "startHour": 1, "endHour": 5 });
    let now = utc_ms(2026, 11, 21, 10);
    let t = sched(now);
    t.auto.configure(&shared(json!({ "enabled": true, "window": window, "catchUp": true, "config": car("/cars/a", "h265") }))).unwrap();
    wait_ticks(&t.auto);
    assert_eq!(t.settings()["catchUp"], true);
    assert_eq!(t.s.started().len(), 1, "a new vehicle's catch-up ignores the window here too");
    t.auto.tick();
    assert!(t.s.paused.lock().unwrap().is_empty());
    // catchUp:false carried over by an Original save that clears the calendar still means off
    let u = sched(now);
    u.auto.configure(&shared(json!({ "enabled": true, "window": window, "configs": [car("/cars/a", "h265")], "schedule": nightly(), "catchUp": false }))).unwrap();
    wait_ticks(&u.auto);
    u.auto.configure(&shared(json!({ "enabled": true, "intervalMinutes": 60, "window": window, "config": car("/cars/b", "h265") }))).unwrap();
    wait_ticks(&u.auto);
    let st = u.settings();
    assert!(no_schedule(&st));
    assert_eq!(st["catchUp"], false);
    assert!(u.s.started().is_empty(), "the new vehicle waits for the window");
    assert!(u.status("catchUp").is_null());
}

#[test]
fn a_setup_saved_without_the_switch_keeps_nodes_behaviour() {
    let window = json!({ "startHour": 1, "endHour": 5 });
    let t = sched(utc_ms(2026, 11, 21, 10));
    t.auto.configure(&shared(json!({ "enabled": true, "window": window, "config": car("/cars/a", "h265") }))).unwrap();
    wait_ticks(&t.auto);
    assert!(t.settings().get("catchUp").is_none());
    assert!(t.s.started().is_empty(), "waits for the window, as Node does");
    assert!(t.status("catchUp").is_null());
}
