use super::*;
use super::super::speed::Backend;

struct BackendFake {
    devices: Mutex<Vec<Value>>,
    outcome: Mutex<Result<Value, String>>,
    calls: Mutex<Vec<(Value, bool)>>,
    service: Arc<FakeService>,
}
impl Backend for BackendFake {
    fn devices(&self) -> Vec<Value> { self.devices.lock().unwrap().clone() }
    fn run(&self, c: &Value, requested: bool, progress: &(dyn Fn(Value) + Sync)) -> Result<Value, String> {
        let busy = self.service.jobs.lock().unwrap().values().any(|j| !terminal(&j["state"]) && !(requested && j["state"] == "paused"));
        if busy || self.service.preview_active.load(Ordering::SeqCst) { return Err("JOB_ACTIVE".into()); }
        self.calls.lock().unwrap().push((c.clone(), requested));
        progress(json!({"step":"run","device":{"name":"GPU A"},"level":2}));
        self.outcome.lock().unwrap().clone()
    }
}
fn rig() -> (crate::converter::testutil::TempDir, Arc<Auto>, Arc<BackendFake>) {
    let d = tempdir().unwrap();
    let service = Arc::new(FakeService::default());
    let scanner: Arc<Scanner> = Arc::new(|_, _, out| { out(clip("RecentClips/old.mp4", 200)); Ok(()) });
    let backend = Arc::new(BackendFake {
        devices: Mutex::new(vec![json!({"id":"pci:0000:01:00.0","kind":"nvidia","name":"GPU A"})]),
        outcome: Mutex::new(Ok(json!({"devices":[{"id":"pci:0000:01:00.0","name":"GPU A","concurrency":2,"filesPerMinute":4.0,"filesPerKwh":null}]}))),
        calls: Mutex::new(vec![]), service,
    });
    let mut options = opts(backend.service.clone(), scanner, d.path());
    let b = backend.clone();
    options.devices = Some(Arc::new(move || Ok(b.devices())));
    let auto = Auto::new(options);
    auto.install_speed_backend(backend.clone());
    auto.start();
    (d, auto, backend)
}
fn configuration() -> Value { json!({"sourceRoot":"/generated", "codec":"h265", "profileId":"aggressive", "concurrency":1, "verifyMode":"quick"}) }
fn enable(auto: &Arc<Auto>, config: Value) { auto.configure(&json!({"enabled":true,"config":config,"intervalMinutes":60,"catchUp":true})).unwrap(); }
fn state(auto: &Auto) -> Value { auto.get_state()["status"]["speedTests"]["/generated"].clone() }

#[test]
fn manifest_apply_speed_result_saves_a_valid_job_configuration() {
    let (d,auto,_)=rig();
    let mut c=tested_config();
    c["sourceRoot"]=json!("/generated"); c["concurrency"]=json!(1);
    for k in ["lanes","deviceSettingsSource","keepRecent"] {c.as_object_mut().unwrap().remove(k);}
    enable(&auto,c);
    assert_eq!(state(&auto)["settingsSource"],"test");
    assert_eq!(auto.get_state()["settings"]["configs"][0]["deviceSettingsSource"],"test");
    let saved:Value=serde_json::from_slice(&std::fs::read(d.path().join(SETTINGS_FILE)).unwrap()).unwrap();
    let config=&saved["configs"][0];
    assert_eq!(config["concurrency"],2);
    assert!(config.get("deviceSettingsSource").is_none());
    crate::converter::jobstore::normalize_manifest(&json!({"schemaVersion":1,"id":"tested-new-job","state":"discovering","revision":0,
        "config":config,"items":[],"summary":null,"counters":crate::converter::contracts::create_empty_counters()})).unwrap();
}

#[test]
fn speed_test_forgotten_queue_cannot_bypass_another_vehicles_test() {
    let (_d, auto, backend) = rig();
    auto.lock().status["speedTests"] = json!({"/forgotten":{"phase":"queued","source":"automatic"}});
    enable(&auto, configuration());
    assert_eq!(backend.calls.lock().unwrap().len(), 1);
    assert_eq!(backend.service.started()[0]["lanes"][0]["concurrency"], 2);
    assert!(auto.get_state()["status"]["speedTests"].get("/forgotten").is_none());
}

#[test]
fn speed_test_requested_owner_pause_is_not_blocked_by_an_automatic_queue() {
    let (_d, auto, backend) = rig();
    let mut manual = configuration();
    manual["concurrency"] = json!(4);
    manual["lanes"] = json!([{"device":"pci:0000:01:00.0","concurrency":4}]);
    backend.service.jobs.lock().unwrap().insert("owner".into(), json!({"id":"owner","state":"paused","config":manual,"items":[]}));
    let mut other = configuration(); other["sourceRoot"] = json!("/other-generated");
    enable(&auto, other.clone());
    auto.configure(&json!({"configs":[other,manual],"catchUp":true})).unwrap();
    assert_eq!(auto.get_state()["status"]["speedTests"]["/other-generated"]["phase"], "waiting");
    auto.request_speed_test("/generated").unwrap();
    auto.tick();
    assert_eq!(state(&auto)["phase"], "done", "an automatic test waiting for a paused job must yield to a requested test");
    assert_eq!(backend.calls.lock().unwrap().len(), 1);
    assert!(backend.calls.lock().unwrap()[0].1);
    assert_eq!(backend.service.jobs.lock().unwrap()["owner"]["state"], "paused");
}

#[test]
fn speed_test_precedes_catchup_persists_and_retests_changed_devices() {
    let (d, auto, backend) = rig();
    enable(&auto, configuration());
    assert_eq!(backend.calls.lock().unwrap().len(), 1);
    assert_eq!(backend.service.started()[0]["lanes"], json!([{"device":"pci:0000:01:00.0","concurrency":2}]));
    assert_eq!(state(&auto)["settingsSource"], "test");
    assert_eq!(state(&auto)["result"]["profileId"], "aggressive");
    let read = auto.get_state();
    assert_eq!(auto.get_state(), read, "reading does not queue or run a test");
    backend.service.set("job-1", |j| j["state"] = json!("completed"));
    auto.tick();
    assert_eq!(backend.calls.lock().unwrap().len(), 1);
    backend.service.jobs.lock().unwrap().clear();
    backend.devices.lock().unwrap().push(json!({"id":"pci:0000:02:00.0","kind":"dri","name":"GPU B"}));
    auto.tick();
    assert_eq!(backend.calls.lock().unwrap().len(), 2);
    let restored = Auto::new(opts(backend.service.clone(), Arc::new(|_,_,_| Ok(())), d.path()));
    restored.start();
    assert_eq!(state(&restored)["result"], state(&auto)["result"]);
}

#[test]
fn speed_test_running_paused_and_preview_wait_without_job_commands() {
    for job_state in ["encoding", "verifying", "replacing", "paused"] {
        let (_d, auto, backend) = rig();
        backend.service.jobs.lock().unwrap().insert("owner".into(), json!({"id":"owner","state":job_state,"config":configuration(),"items":[]}));
        enable(&auto, configuration());
        assert_eq!(state(&auto)["phase"], "waiting", "{job_state}");
        assert!(backend.calls.lock().unwrap().is_empty());
        assert!(backend.service.started().is_empty());
        assert!(backend.service.paused.lock().unwrap().is_empty());
        assert!(backend.service.resumed.lock().unwrap().is_empty());
        assert_eq!(backend.service.jobs.lock().unwrap()["owner"]["state"], job_state);
    }
    let (_d, auto, backend) = rig();
    backend.service.preview_active.store(true, Ordering::SeqCst);
    enable(&auto, configuration());
    assert_eq!(state(&auto)["phase"], "waiting");
    assert!(backend.service.started().is_empty());
}

#[test]
fn speed_test_failure_cancel_and_no_originals_release_catchup_without_retry_loop() {
    for (error, phase) in [("ENCODE_FAILED","failed"),("CANCELLED","cancelled"),("BENCHMARK_SOURCE_REQUIRED","skipped")] {
        let (_d, auto, backend) = rig();
        *backend.outcome.lock().unwrap() = Err(error.into());
        enable(&auto, configuration());
        assert_eq!(state(&auto)["phase"], phase);
        assert!(!state(&auto)["reason"].as_str().unwrap().is_empty());
        assert_eq!(auto.get_state()["settings"]["configs"][0]["concurrency"], 1);
        assert!(auto.get_state()["settings"]["configs"][0].get("lanes").is_none());
        assert_eq!(backend.service.started().len(), 1);
        auto.tick();
        assert_eq!(backend.calls.lock().unwrap().len(), 1);
    }
}

#[test]
fn speed_test_requested_on_owner_pause_recommends_without_overwriting_manual_lanes() {
    let (_d, auto, backend) = rig();
    let mut c = configuration(); c["concurrency"] = json!(4); c["lanes"] = json!([{"device":"pci:0000:01:00.0","concurrency":4}]);
    enable(&auto, c.clone());
    assert!(backend.calls.lock().unwrap().is_empty());
    backend.service.set("job-1", |j| j["state"] = json!("paused"));
    let job = backend.service.jobs.lock().unwrap()["job-1"].clone();
    auto.request_speed_test("/generated").unwrap();
    auto.tick();
    assert_eq!(state(&auto)["phase"], "done");
    assert_eq!(state(&auto)["result"]["source"], "requested");
    assert_eq!(auto.get_state()["settings"]["configs"][0]["lanes"], c["lanes"]);
    assert_eq!(backend.service.jobs.lock().unwrap()["job-1"], job);
    auto.apply_speed_test("/generated").unwrap();
    assert_eq!(auto.get_state()["settings"]["configs"][0]["concurrency"], 2);
    assert_eq!(state(&auto)["settingsSource"], "test");
    assert_eq!(backend.service.jobs.lock().unwrap()["job-1"], job);
    auto.set_lanes(&c["lanes"], Some("/generated")).unwrap();
    assert_eq!(state(&auto)["settingsSource"], "user");
}
