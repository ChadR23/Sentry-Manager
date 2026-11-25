use super::*;
use super::lanes_tests::{until, Harness, HarnessOptions};

fn requested_speed_test_after_restart(materialize_runtime: bool) {
    let h = Harness::new(HarnessOptions {clips:2, verify_ok:true, ..Default::default()});
    let job = h.service().start(&h.config(json!({}))).unwrap();
    let id = job.as_str();
    assert!(until(|| !h.held().is_empty()));
    h.service().pause(id).unwrap();
    h.finish_all();
    assert!(until(|| h.service().get(id).unwrap()["state"] == "paused"));
    h.conv.shutdown();

    // Reopen the persisted job with neither the old store cache nor its runtime.
    let mut options = h.service().0.o.clone();
    options.store = Arc::new(JobStore::new(h.conv.jobs_root()).unwrap());
    let service = Service::new(options);
    assert!(service.runtime_of(id).is_none());
    let before = service.get(id).unwrap();
    assert_eq!(before["state"], "paused");
    assert!(before["recovery"].is_null());
    assert!(before["items"].as_array().unwrap().iter().any(|i| i["state"] == "queued"));
    if materialize_runtime {
        // Converter startup reconciles persisted pauses before leaving them idle.
        service.recover(id, false).unwrap();
        service.when_idle(id).unwrap();
        let rt = service.ensure_runtime(id).unwrap();
        assert!(!rt.lock().running);
        assert!(!rt.lock().pause_requested);
    }

    assert!(service.try_speed_test(false).unwrap().is_none(), "only requested tests may borrow an owner pause");
    let lease = service.try_speed_test(true).unwrap().expect("a user pause restored from disk is drained");
    assert!(service.try_speed_test(true).unwrap().is_none());
    assert!(service.try_preview().unwrap().is_none());
    assert_eq!(service.resume(id).unwrap_err().code.as_deref(), Some("SPEED_TEST_RUNNING"));
    assert_eq!(service.start(&h.config(json!({}))).unwrap_err().code.as_deref(), Some("SPEED_TEST_RUNNING"));
    assert_eq!(service.get(id).unwrap(), before);
    drop(lease);
    assert!(!service.speed_test_active());
    assert_eq!(service.get(id).unwrap(), before);
    assert_eq!(public_snapshot(&service.store().load(id).unwrap().unwrap()), before);
    if !materialize_runtime { assert!(service.runtime_of(id).is_none()); }
}

#[test]
fn requested_speed_test_admits_an_owner_pause_restored_without_a_runtime() {
    requested_speed_test_after_restart(false);
}

#[test]
fn requested_speed_test_admits_an_owner_pause_restored_with_an_idle_runtime() {
    requested_speed_test_after_restart(true);
}

#[test]
fn speed_test_reservation_refuses_idle_runtime_activity_and_non_owner_pauses() {
    let h = Harness::new(HarnessOptions {clips:0, ..Default::default()});
    let service = h.service();
    let m = service.store().create(json!({"state":"paused", "config":h.config(json!({})), "items":[]}).as_object().unwrap()).unwrap();
    let blockers: &[(&str, fn(&mut RtState))] = &[
        ("running without a drained pause", |s| s.running = true),
        ("live workers even when parked", |s| { s.live_workers = 1; s.parked_workers = 1; }),
        ("preview pause", |s| s.preview_pause = Some(1)),
        ("recovery", |s| s.recovery_required = true),
        ("cancel requested", |s| s.cancel_requested = true),
        ("stop requested", |s| s.stop_requested = true),
        ("child", |s| { s.children.insert("clip".into(), ChildEntry {pid:0, termination_requested:false, remote:Some(Arc::new(|_| {})), withdrawn:false}); }),
        ("encode", |s| s.encodes.push(("clip".into(), json!({})))),
        ("in flight", |s| s.in_flight.push("clip".into())),
        ("commit holder", |s| s.commit_holder = Some("clip".into())),
        ("node check", |s| { s.node_checks.insert("node".into(), 1); }),
    ];
    for (label, block) in blockers {
        let rt = Runtime::new(m.clone());
        let _reset = ParkedFixture(rt.clone());
        block(&mut rt.lock());
        service.0.jobs.lock().unwrap().insert(m.id().into(), rt);
        assert!(service.try_speed_test(true).unwrap().is_none(), "{label}");
    }
    service.0.jobs.lock().unwrap().clear();
    for (state, recovery) in [("waiting", Value::Null),
        ("paused_network", json!({"action":"resume-network", "fromState":"paused_network", "pathRole":"discovery", "resumeState":"waiting"})),
        ("paused", json!({"action":"manual-intervention", "fromState":"encoding"}))] {
        service.store().transition(m.id(), Patch::new().set("state", json!(state)).set("recovery", recovery)).unwrap();
        assert!(service.try_speed_test(true).unwrap().is_none(), "{state} without a runtime");
        service.ensure_runtime(m.id()).unwrap();
        assert!(service.try_speed_test(true).unwrap().is_none(), "{state} with an idle runtime");
        service.0.jobs.lock().unwrap().clear();
    }
}

// These fixtures model worker state without creating threads. Clear it even
// after a failed assertion, so the harness does not wait for imaginary workers.
struct ParkedFixture(Arc<Runtime>);
impl Drop for ParkedFixture {
    fn drop(&mut self) { self.0.lock().running = false; self.0.cv.notify_all(); }
}

#[test]
fn speed_test_reservation_holds_a_drained_owner_pause_without_changing_the_job() {
    let h = Harness::new(HarnessOptions {clips:0, ..Default::default()});
    let service = h.service();
    let m = service.0.o.store.create(json!({"state":"paused", "config":h.config(json!({})),
        "discoveryComplete":true,"items":[]}).as_object().unwrap()).unwrap();
    let rt = service.ensure_runtime(m.id()).unwrap();
    let _reset = ParkedFixture(rt.clone());
    { let mut s = rt.lock(); s.pause_requested = true; s.producer_done = true; s.live_workers = 2; s.parked_workers = 2; s.running = true; }
    let before = service.get(m.id()).unwrap();
    assert!(service.try_speed_test(false).unwrap().is_none());
    let lease = service.try_speed_test(true).unwrap().expect("a drained owner pause is safe");
    assert!(service.try_preview().unwrap().is_none());
    assert_eq!(service.resume(m.id()).unwrap_err().code.as_deref(), Some("SPEED_TEST_RUNNING"));
    assert_eq!(service.start(&h.config(json!({}))).unwrap_err().code.as_deref(), Some("SPEED_TEST_RUNNING"));
    assert_eq!(service.get(m.id()).unwrap(), before);
    drop(lease);
    assert!(!service.speed_test_active());
    assert_eq!(service.get(m.id()).unwrap(), before);
    // No worker thread was started by this fixture.
    rt.lock().running = false;
}

#[test]
fn speed_test_reservation_refuses_unparked_work_recovery_and_preview() {
    let h = Harness::new(HarnessOptions {clips:0, ..Default::default()});
    let service = h.service();
    let preview = service.try_preview().unwrap().unwrap();
    assert!(service.try_speed_test(true).unwrap().is_none());
    drop(preview);
    let m = service.0.o.store.create(json!({"state":"paused", "config":h.config(json!({})), "items":[]}).as_object().unwrap()).unwrap();
    let rt = service.ensure_runtime(m.id()).unwrap();
    let _reset = ParkedFixture(rt.clone());
    { let mut s = rt.lock(); s.running = true; s.pause_requested = true; s.live_workers = 1; }
    assert!(service.try_speed_test(true).unwrap().is_none());
    { let mut s = rt.lock(); s.parked_workers = 1; }
    assert!(service.try_speed_test(true).unwrap().is_none(), "discovery may still change items");
    { let mut s = rt.lock(); s.producer_done = true; s.commit_holder = Some("saving".into()); }
    assert!(service.try_speed_test(true).unwrap().is_none());
    { let mut s = rt.lock(); s.commit_holder = None; s.in_flight.push("verifying".into()); }
    assert!(service.try_speed_test(true).unwrap().is_none());
    { let mut s = rt.lock(); s.in_flight.clear(); s.recovery_required = true; }
    assert!(service.try_speed_test(true).unwrap().is_none());
    rt.lock().running = false;
}
