use super::*;
use super::lanes_tests::{Harness, HarnessOptions};

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
