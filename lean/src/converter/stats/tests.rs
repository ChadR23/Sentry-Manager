//! test/encoderStats.test.js (the block, not the page's rendering), the
//! encoder-block test of test/lanes.test.js, and convertStats' rules.

use super::*;

fn worker(over: Value) -> Value {
    let mut w = json!({ "jobId": "j1", "itemId": "i1", "relativePath": "RecentClips/a-front.mp4", "encoder": "hevc_vaapi", "hardware": true, "decode": "gpu", "device": "/dev/dri/renderD128", "fps": 400 });
    for (k, v) in over.as_object().unwrap() {
        w[k] = v.clone();
    }
    w
}

#[test]
fn the_block_names_the_running_job_its_gpu_energy_and_saved_space() {
    let s = EncoderStats::default();
    let jobs = vec![
        json!({ "id": "old", "state": "completed", "items": [] }),
        json!({ "id": "j1", "state": "encoding", "createdAt": 1000, "counters": { "savedBytes": 5e9 }, "items": [{ "kind": "video", "state": "completed" }, { "kind": "video", "state": "completed", "eligibleVideo": false }, { "kind": "video", "state": "waiting" }] }),
    ];
    let snapshot = json!({ "cpu": { "usage": 25 }, "gpus": [{ "name": "Intel Arc A380", "node": "renderD128", "video": 94 }], "filesystems": [] });
    let energy = json!({ "byJob": { "j1": { "wh": 312.44, "avgW": 67.6, "seconds": 16000, "cost": 0.041, "base": { "clips": 0, "savedB": 1e9, "wh": 12.44 } } } });
    let out = s.encoder_block(&snapshot, &jobs, &[worker(json!({})), worker(json!({ "jobId": "other" }))], &energy, None);
    assert_eq!(out["jobId"], "j1");
    assert_eq!(out["running"], true);
    assert_eq!(out["workers"].as_array().unwrap().len(), 1);
    assert_eq!(out["device"], json!({ "encoder": "hevc_vaapi", "hardware": true, "gpuName": "Intel Arc A380", "node": "/dev/dri/renderD128", "decode": "gpu" }));
    let run = &out["run"];
    assert_eq!(json!([run["wh"], run["avgW"], run["cost"], run["clips"], run["savedB"], run["sinceWh"], run["cpuMeasured"], run["startedAt"]]), json!([312.4, 68, 0.041, 1, 4e9 as i64, 300, null, 1000]));
    assert!(out.get("bottleneck").is_none());
}

#[test]
fn clips_and_space_count_from_the_baseline_and_cpu_measured_stays_put() {
    let s = EncoderStats::default();
    let items = |n: usize| json!(vec![json!({ "kind": "video", "state": "completed" }); n]);
    let gpu_only = json!({ "power": { "totalW": 31, "cpuW": null, "gpuW": 31, "cpuSource": null, "gpuSource": "hwmon" }, "gpus": [] });
    let base = json!({ "clips": 10412, "savedB": 211e12, "wh": 0 });
    let block = |done: usize, saved: f64, wh: f64, b: &Value, snap: &Value| {
        let jobs = vec![json!({ "id": "j1", "state": "encoding", "items": items(done), "counters": { "savedBytes": saved } })];
        s.encoder_block(snap, &jobs, &[worker(json!({}))], &json!({ "byJob": { "j1": { "wh": wh, "avgW": 31, "seconds": 90, "cost": null, "base": b } } }), None)["run"].clone()
    };
    let start = block(10412, 211e12, 0.8, &base, &gpu_only);
    assert_eq!(json!([start["wh"], start["clips"], start["savedB"], start["sinceWh"], start["cpuMeasured"]]), json!([0.8, 0, 0, 0.8, false]));
    let later = block(10442, 211e12 + 6e9, 15.04, &base, &gpu_only);
    assert_eq!(json!([later["wh"], later["clips"], later["savedB"], later["sinceWh"]]), json!([15, 30, 6e9 as i64, 15]));
    let mut b10 = base.clone();
    b10["wh"] = json!(10);
    assert_eq!(block(10442, 211e12 + 6e9, 15.04, &b10, &gpu_only)["sinceWh"], 5);
    let none = block(10442, 1.0, 3.0, &Value::Null, &gpu_only);
    assert_eq!(json!([none["clips"], none["savedB"], none["sinceWh"]]), json!([0, 0, 0]));
    let neg = block(10400, 200e12, 3.0, &base, &gpu_only);
    assert_eq!(json!([neg["clips"], neg["savedB"]]), json!([0, 0]));
    let jobs = vec![json!({ "id": "j1", "state": "encoding", "items": items(12), "counters": { "savedBytes": 5e9 } })];
    let plain = s.encoder_block(&json!({}), &jobs, &[worker(json!({}))], &json!({ "byJob": {} }), None)["run"].clone();
    assert_eq!(json!([plain["wh"], plain["clips"], plain["savedB"], plain["sinceWh"]]), json!([null, 12, 5e9 as i64, null]));

    let measured = |id: &str, power: Value| {
        let jobs = vec![json!({ "id": id, "state": "encoding", "items": [{ "kind": "video", "state": "completed" }], "counters": {} })];
        s.encoder_block(&json!({ "power": power, "gpus": [] }), &jobs, &[worker(json!({ "jobId": id }))], &json!({ "byJob": { id: { "wh": 3, "avgW": 31, "seconds": 90, "cost": null, "base": null } } }), None)["run"]["cpuMeasured"].clone()
    };
    let gpu_only = json!({ "cpuSource": null, "gpuSource": "hwmon" });
    let none = json!({ "cpuSource": null, "gpuSource": null });
    let rapl = json!({ "cpuSource": "rapl", "gpuSource": "hwmon" });
    assert_eq!(measured("apu", none.clone()), Value::Null);
    assert_eq!(measured("apu", gpu_only.clone()), false);
    assert_eq!(measured("apu", none.clone()), false);
    assert_eq!(measured("rapl", rapl), true);
    assert_eq!(measured("rapl", gpu_only.clone()), true);
    assert_eq!(measured("rapl", none), true);
    assert_eq!(measured("next", gpu_only), false);
    assert_eq!(measured("chip", json!({ "cpuSource": null, "gpuSource": "hwmon", "chipW": 31 })), true);
}

#[test]
fn concurrency_devices_and_clips_waiting_on_a_node() {
    let s = EncoderStats::default();
    let block = |config: Value, slots: Option<&dyn Fn(&str) -> Option<i64>>| s.encoder_block(&json!({}), &[json!({ "id": "j1", "state": "encoding", "items": [], "counters": {}, "config": config })], &[worker(json!({}))], &Value::Null, slots)["concurrency"].clone();
    assert_eq!(block(json!({ "concurrency": 4 }), None), 4);
    assert_eq!(block(json!({ "lanes": [{ "device": "pci:0000:03:00.0", "concurrency": 3 }, { "device": "cpu", "concurrency": 2 }] }), None), 5);
    assert_eq!(block(json!({}), None), Value::Null);
    assert_eq!(block(json!({ "concurrency": "x", "lanes": "y" }), None), Value::Null);
    let two = |_: &str| Some(2);
    assert_eq!(block(json!({ "concurrency": 4 }), Some(&two)), 2);
    let zero = |_: &str| Some(0);
    assert_eq!(block(json!({ "concurrency": 4 }), Some(&zero)), 4);
    assert_eq!(s.encoder_block(&json!({}), &[json!({ "id": "x", "state": "completed" })], &[], &Value::Null, None), Value::Null);

    // one entry per device in use: GPUs by PCI slot, the CPU last
    let jobs = vec![json!({ "id": "j1", "state": "encoding", "items": [], "counters": {} })];
    let gpus = json!([{ "name": "Intel UHD Graphics 770", "node": "renderD128", "video": 40, "busy": 20 }, { "name": "Intel Arc A380", "node": "renderD129", "video": 95, "busy": 30 }]);
    let w = |id: &str, dev: &str, d: Value| worker(json!({ "itemId": id, "encoder": "hevc_qsv", "deviceId": dev, "device": d, "fps": 300 }));
    let workers = vec![
        w("a", "pci:0000:03:00.0", json!("/dev/dri/renderD129")),
        w("b", "pci:0000:00:02.0", json!("/dev/dri/renderD128")),
        w("c", "pci:0000:03:00.0", json!("/dev/dri/renderD129")),
        worker(json!({ "itemId": "d", "deviceId": "cpu", "device": null, "encoder": "libx265", "hardware": false, "decode": "cpu" })),
    ];
    let out = s.encoder_block(&json!({ "cpu": { "usage": 40 }, "gpus": gpus, "filesystems": [] }), &jobs, &workers, &Value::Null, None);
    assert_eq!(out["devices"], json!([
        { "id": "pci:0000:00:02.0", "name": "Intel UHD Graphics 770", "node": "/dev/dri/renderD128", "encoder": "hevc_qsv", "hardware": true, "workers": 1, "video": 40, "busy": 20 },
        { "id": "pci:0000:03:00.0", "name": "Intel Arc A380", "node": "/dev/dri/renderD129", "encoder": "hevc_qsv", "hardware": true, "workers": 2, "video": 95, "busy": 30 },
        { "id": "cpu", "name": "CPU", "node": null, "encoder": "libx265", "hardware": false, "workers": 1, "video": null, "busy": null }
    ]));
    assert_eq!(out["device"]["encoder"], "hevc_qsv");
    let node = |id: &str, over: Value| {
        let mut x = worker(json!({ "itemId": id, "encoder": "libx265", "hardware": false, "decode": "cpu", "device": null, "deviceId": "node:garage" }));
        for (k, v) in over.as_object().unwrap() {
            x[k] = v.clone();
        }
        x
    };
    let out = s.encoder_block(&json!({ "gpus": [] }), &jobs, &[node("a", json!({})), node("b", json!({ "waitingOnNode": true })), node("c", json!({ "waitingOnNode": true }))], &Value::Null, None);
    assert_eq!(out["workers"].as_array().unwrap().len(), 1);
    assert_eq!(out["devices"].as_array().unwrap().iter().map(|d| json!([d["id"], d["workers"]])).collect::<Vec<_>>(), vec![json!(["node:garage", 1])]);
    let named = node("n", json!({ "encoder": "hevc_vaapi", "hardware": true, "deviceId": "node:uz2qglsgh2fe", "node": "Garage PC (node)", "remote": true, "started": true }));
    let out = s.encoder_block(&json!({ "gpus": [] }), &jobs, &[named, worker(json!({ "itemId": "c", "encoder": "libx265", "hardware": false, "decode": "cpu", "device": null, "deviceId": "cpu" }))], &Value::Null, None);
    assert_eq!(out["devices"].as_array().unwrap().iter().map(|d| json!([d["id"], d["name"]])).collect::<Vec<_>>(), vec![json!(["node:uz2qglsgh2fe", "Garage PC (node)"]), json!(["cpu", "CPU"])]);
}

#[test]
fn convert_stats_average_the_day_name_the_device_late_and_keep_nodes_apart() {
    let store = Arc::new(Mutex::new(HashMap::<String, Value>::new()));
    let (g, st) = (store.clone(), store.clone());
    let mut s = ConvertStats::new(Some(Arc::new(move |k| g.lock().unwrap().get(k).cloned())), Some(Arc::new(move |k, v| {
        st.lock().unwrap().insert(k.to_string(), v.clone());
    })));
    let now = Arc::new(Mutex::new(1_000_000i64));
    let n2 = now.clone();
    s.now = Arc::new(move || *n2.lock().unwrap());
    s.cpu_name = Arc::new(|| Some("AMD Ryzen 5".into()));
    assert_eq!(s.summary(None), empty());
    let enc = |e: &str, fps: f64, dev: Value| json!({ "encoder": e, "hardware": !e.starts_with("lib"), "fps": fps, "device": dev });
    assert!(s.sample(&|| vec![enc("hevc_vaapi", 100.0, json!("/dev/dri/renderD128")), enc("hevc_vaapi", 50.0, json!("/dev/dri/renderD128")), enc("libx265", 10.0, Value::Null)]));
    assert!(!s.sample(&|| vec![enc("libx265", 10.0, Value::Null)]), "at most one sample every 30 s");
    *now.lock().unwrap() += 30_000;
    assert!(s.sample(&|| vec![enc("libx265", 40.0, Value::Null)]));
    let found = json!({ "gpus": [{ "name": "Intel Arc A380", "vendor": "intel", "node": "/dev/dri/renderD128" }] });
    let hw = heartbeat_hardware(&found, Some("AMD Ryzen 5"), &s, &[], 8);
    assert_eq!(hw["convert"], json!({ "fps": 100, "encoder": "libx265", "device": "AMD Ryzen 5", "api": "cpu", "codec": "h265" }));
    // a restart: the latest numbers from the settings
    let (g, st) = (store.clone(), store.clone());
    let again = ConvertStats::new(Some(Arc::new(move |k| g.lock().unwrap().get(k).cloned())), Some(Arc::new(move |k, v| {
        st.lock().unwrap().insert(k.to_string(), v.clone());
    })));
    assert_eq!(again.summary(Some(&|_r: &Value| Some("CPU X".into())))["fps"], 100);
    // a node's clips apart, by its lane
    *now.lock().unwrap() += 30_000;
    let mut remote = enc("hevc_nvenc", 200.0, Value::Null);
    remote["remote"] = json!(true);
    remote["deviceId"] = json!("node:abcdefabcdef@pci:0000:01:00.0");
    assert!(!s.sample(&|| vec![remote.clone()]));
    let paired = vec![json!({ "id": "abcdefabcdef", "hardware": { "cpu": "Intel i5", "gpus": ["NVIDIA T400"], "devices": [{ "id": "pci:0000:01:00.0", "name": "NVIDIA T400" }] } })];
    let hw = heartbeat_hardware(&found, Some("AMD Ryzen 5"), &s, &paired, 8);
    assert_eq!(hw["nodes"][0]["convert"], json!({ "fps": 200, "encoder": "hevc_nvenc", "device": "NVIDIA T400", "api": "nvenc", "codec": "h265" }));
    assert_eq!(hw["nodes"][0]["cpu"], "Intel i5");
    heartbeat_hardware(&found, None, &s, &[], 8);
    assert!(store.lock().unwrap()["convert-stats-nodes"].as_object().unwrap().is_empty(), "a node no longer paired is forgotten");
    assert_eq!(hardware_from_devices(&json!([{ "id": "cpu", "name": "CPU (software encoder)" }, { "id": "pci:0000:03:00.0", "name": "Intel GPU (0000:03:00.0)" }])), json!({ "cpu": null, "gpus": ["Intel GPU"], "devices": [{ "id": "cpu", "name": "CPU (software encoder)" }, { "id": "pci:0000:03:00.0", "name": "Intel GPU" }] }));
    assert_eq!(api_of("libaom-av1"), Some("cpu"));
    assert_eq!(api_of("h264_v4l2m2m"), Some("v4l2m2m"));
    assert_eq!(codec_of("librav1e"), Some("av1"));
}
