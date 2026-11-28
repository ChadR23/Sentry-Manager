use super::*;
use super::lanes_tests::{Harness,HarnessOptions,t400,cpu,until};
use crate::converter::gpu_memory::{Gate,Reading};
use std::fs;
use std::time::Duration;

fn gpu_options(clips:usize) -> HarnessOptions {
    HarnessOptions { clips, devices:vec![t400(),cpu()], default_device:Some(Some(t400()["id"].as_str().unwrap().into())),
        verify_ok:true, hold:false, ..Default::default() }
}
fn gpu_config(h:&Harness, concurrency:u64) -> Value {
    h.config(json!({"lanes":[{"device":t400()["id"],"concurrency":concurrency}],"concurrency":concurrency}))
}

#[test]
fn gpu_memory_errors_never_publish_even_when_encoder_exits_zero() {
    for nonzero in [false,true] {
    let h=Harness::new(gpu_options(1));
    if nonzero {fs::write(h.ctl.join("fail-if"),"hevc_nvenc").unwrap();}
    fs::write(h.ctl.join("stderr"),"[CUDA] cuMemAlloc failed -> CUDA_ERROR_OUT_OF_MEMORY\nError submitting packet to decoder\n").unwrap();
    let id=h.service().start(&gpu_config(&h,1)).unwrap();
    let job=h.finish_job(&id);
    let item=&job["items"][0];
    assert_eq!(item["state"],"failed","{job}");
    assert_eq!(item["resultCode"],"gpu-memory-exhausted");
    assert_eq!(item["failure"]["retryable"],true);
    assert_eq!(h.spawned().len(),3,"two automatic retries, then leave it retryable");
    assert!(h.spawned().iter().all(|s| s.gpu.as_deref()==Some("nvidia0")));
    assert_eq!(fs::read(item["sourcePath"].as_str().unwrap()).unwrap(),vec![0u8;4000]);
    assert!(!h.dir.path().join("out/RecentClips").exists() || fs::read_dir(h.dir.path().join("out/RecentClips")).unwrap().next().is_none());
    }
}

#[test]
fn gpu_memory_retry_succeeds_after_pressure_clears() {
    let h=Harness::new(gpu_options(1));
    fs::write(h.ctl.join("oom-once"),"").unwrap();
    let id=h.service().start(&gpu_config(&h,1)).unwrap();
    let job=h.finish_job(&id);
    assert_eq!(job["items"][0]["state"],"completed","{job}");
    assert_eq!(h.spawned().len(),2,"exit zero with OOM must be discarded and retried");
    assert_eq!(job["items"][0]["attempts"],2);
}

#[test]
fn gpu_memory_admission_makes_lane_concurrency_an_upper_bound() {
    let mut o=gpu_options(3);o.hold=true;
    o.gpu_memory=Some(Arc::new(Gate::new(Arc::new(|_|Some(Reading{free_mib:1500,total_mib:8192})))));
    let h=Harness::new(o);
    let id=h.service().start(&gpu_config(&h,3)).unwrap();
    assert!(until(||!h.held().is_empty()));
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(h.held().len(),1,"reservations must also cover workers racing to spawn");
    let job=h.finish_job(&id);
    assert!(job["items"].as_array().unwrap().iter().all(|i|i["state"]=="completed"));
}

#[test]
fn gpu_memory_legacy_retry_keeps_pause_and_excludes_invalid_h264() {
    let h=Harness::new(gpu_options(4));
    let id=h.service().start(&gpu_config(&h,1)).unwrap();
    let finished=h.finish_job(&id);
    let items:Vec<Value>=finished["items"].as_array().unwrap().iter().enumerate().map(|(n,i)| {
            let code=["frame-count-mismatch","invalid-h264","encoder-crashed","encoder-crashed"][n];
            merge(i,&vec![("state",Some(json!("failed"))),("resultCode",Some(json!(code))),
                ("encoder",Some(json!(if n==3 {"libx265"} else {"hevc_nvenc"}))),
                ("failure",Some(json!({"code":code,"retryable":n==2})))])
        }).collect();
    let manifest=h.service().store().create(json!({"state":"paused","config":finished["config"],"discoveryComplete":true,"items":items}).as_object().unwrap()).unwrap();
    let id=manifest.id().to_string();
    let mut options=h.service().0.o.clone();
    options.store=Arc::new(JobStore::new(h.conv.jobs_root()).unwrap());
    let restarted=Service::new(options);
    assert!(restarted.runtime_of(&id).is_none());
    let original=restarted.get(&id).unwrap();
    let queued=restarted.retry_temporary(&id).unwrap();
    assert_eq!(queued["state"],"paused");
    assert_eq!(queued["items"][0]["state"],"queued");
    assert_eq!(queued["items"][0]["resultCode"],"gpu-memory-retry");
    assert_eq!(queued["items"][1],original["items"][1]);
    assert_eq!(queued["items"][2]["resultCode"],"gpu-memory-retry","retry a hardware crash with one encode on the device");
    assert_eq!(queued["items"][3],original["items"][3],"a CPU crash stays failed");
    assert!(!restarted.runtime_of(&id).unwrap().lock().running);
    assert_eq!(public_snapshot(&restarted.store().load(&id).unwrap().unwrap()),queued);
    assert_eq!(h.spawned().len(),4,"the retry action never resumes the owner pause");
}

#[test]
fn gpu_memory_retry_at_queue_tail_drains_busy_device_before_normal_work() {
    let mut options = gpu_options(12); options.hold = true;
    options.gpu_memory = Some(Arc::new(Gate::new(Arc::new(|_| None))));
    let h = Harness::new(options);
    let first = h.service().start(&gpu_config(&h, 3)).unwrap();
    let done = h.finish_job(&first);
    let mut items = done["items"].as_array().unwrap().clone();
    for item in &mut items {
        item["state"] = json!("queued"); item["attempts"] = json!(0); item["resultCode"] = Value::Null;
    }
    items.last_mut().unwrap()["resultCode"] = json!("gpu-memory-retry");
    let retry_path = items.last().unwrap()["sourcePath"].as_str().unwrap().to_string();
    let mut config=done["config"].clone();
    fs::create_dir_all(h.dir.path().join("retry-out")).unwrap();
    config["destinationRoot"]=json!(h.dir.path().join("retry-out"));
    let m = h.service().store().create(json!({"state":"paused", "config":config, "discoveryComplete":true, "items":items}).as_object().unwrap()).unwrap();
    let before = h.spawned().len();
    h.service().resume(m.id()).unwrap();
    assert!(until(|| !h.held().is_empty()));
    // Let the retry finish its source inspection and register the serial
    // turn before releasing normal children. A queued-at-tail retry cannot
    // reach this barrier while the first normal children are held.
    let device = super::super::devices::device_of(&t400());
    assert!(until(|| h.service().0.o.gpu_memory.draining(&device)));
    let mut normal = std::collections::HashSet::new();
    loop {
        let held = h.held();
        if let Some(retry) = held.iter().find(|s| s.args.contains(&retry_path)) {
            assert_eq!(held.len(), 1, "a memory retry must encode alone");
            h.finish(retry);
            break;
        }
        // finish() releases asynchronously; a child still visible in the
        // next poll is the same admitted encode, not another normal start.
        normal.extend(held.iter().map(|s| s.pid.clone()));
        assert!(normal.len() <= 2, "a queued retry must run after at most the other already-admitted workers, not after the backlog");
        for child in &held { h.finish(child); }
        assert!(until(|| h.held().iter().any(|s| !held.iter().any(|old| old.pid == s.pid))));
    }
    let job = h.finish_job(m.id());
    assert_eq!(h.spawned().len() - before, 12);
    assert!(job["items"].as_array().unwrap().iter().all(|i| i["state"] == "completed"), "{job}");
}

#[test]
fn gpu_memory_retry_refuses_activity_in_a_persisted_pause() {
    let h = Harness::new(gpu_options(0));
    let m = h.service().store().create(json!({"state":"paused", "config":gpu_config(&h,1), "items":[]}).as_object().unwrap()).unwrap();
    let rt = h.service().ensure_runtime(m.id()).unwrap();
    // Even an idle runtime must not hide active encode or node-check state.
    for block in [0, 1, 2, 3, 4] {
        { let mut s = rt.lock(); s.pause_requested = true;
          match block { 0 => s.encodes.push(("clip".into(), json!({}))), 1 => {s.node_checks.insert("node".into(),1);},
              2 => s.live_workers = 1, 3 => s.cancel_requested = true, _ => s.stop_requested = true }
        }
        assert_eq!(h.service().retry_temporary(m.id()).unwrap_err().code.as_deref(), Some("JOB_ACTIVE"), "block {block}");
        { let mut s = rt.lock(); s.encodes.clear(); s.node_checks.clear(); s.live_workers = 0; s.cancel_requested = false; s.stop_requested = false; }
    }
}

// A job worker can be descheduled after it wakes idle waiters. Let its
// cleanup run inside the retry's first write, before update installs the
// waiting manifest in memory. This orders the handoff without a sleep.
#[derive(Default)]
struct LateWorkerCleanup(Mutex<Option<(Service, Arc<Runtime>)>>);

impl crate::converter::jobstore::StoreHooks for LateWorkerCleanup {
    fn after_write(&self, next: &Manifest, _: Option<&Manifest>) {
        if next.state() == JobState::Waiting {
            if let Some((service, previous)) = self.0.lock().unwrap().take() {
                service.forget_finished(&previous);
            }
        }
    }
}

fn check_terminal_retry(retry: fn(&Service, &str) -> SResult<Value>) {
    let h = Harness::new(gpu_options(0));
    let cleanup = Arc::new(LateWorkerCleanup::default());
    let mut options = h.service().0.o.clone();
    options.store = Arc::new(JobStore::new(h.conv.jobs_root()).unwrap().with_hooks(cleanup.clone()));
    let service = Service::new(options);
    let relative = "RecentClips/2020-01-01_00-00-00-back.mp4";
    let source = h.dir.path().join("footage").join(relative);
    fs::write(&source, [0; 4000]).unwrap();
    let counters = contracts::create_empty_counters();
    let job = service.store().create(json!({
        "state":"completed", "config":gpu_config(&h, 1), "discoveryComplete":true,
        "counters":counters, "summary":contracts::serialize_summary(&counters),
        "items":[{"id":"item-000001","state":"failed","kind":"video","group":"RecentClips","relativePath":relative,
            "sourcePath":source,"sourceBytes":4000,"mtimeMs":0,"eventId":null,"camera":"back","timestampKey":"2020-01-01_00-00-00",
            "attempts":1,"resultCode":"frame-count-mismatch","failure":{"code":"frame-count-mismatch","retryable":false},"encoder":"hevc_nvenc"}]
    }).as_object().unwrap()).unwrap();
    let id = job.id();
    let previous = service.ensure_runtime(id).unwrap();
    *cleanup.0.lock().unwrap() = Some((service.clone(), previous.clone()));
    fs::write(h.ctl.join("hold"), "").unwrap();
    retry(&service, id).unwrap();
    let visible = service.runtime_of(id).is_some_and(|rt| rt.lock().running);
    fs::write(h.ctl.join("release-all"), "").unwrap();
    let idle = service.when_idle(id).unwrap();
    service.wait_idle(&previous); // Also drain the detached worker on regression.
    assert!(cleanup.0.lock().unwrap().is_none());
    assert!(visible, "the acknowledged retry must remain registered while its encoder is held");
    assert_eq!(idle["state"], "completed", "{idle}");
    assert_eq!(idle["items"][0]["state"], "completed", "{idle}");
    assert_eq!(h.spawned().len(), 1);
}

#[test]
fn temporary_retry_survives_previous_worker_cleanup() {
    check_terminal_retry(Service::retry_temporary);
}

#[test]
fn failed_retry_survives_previous_worker_cleanup() {
    check_terminal_retry(Service::retry_failed);
}

#[test]
fn gpu_memory_waiting_retry_prevents_new_normal_encodes_until_it_runs_alone() {
    let mut options = gpu_options(12); options.hold = true;
    options.gpu_memory = Some(Arc::new(Gate::new(Arc::new(|_| None))));
    let h = Harness::new(options);
    let id = h.service().start(&gpu_config(&h, 3)).unwrap();
    assert!(until(|| h.held().len() == 3));
    let rt = h.service().ensure_runtime(&id).unwrap();
    assert!(until(|| !rt.lock().queue.is_empty()));
    let retry_id = rt.lock().queue.front().unwrap().clone();
    h.service().item_patch(&rt, &retry_id, vec![("resultCode",Some(json!("gpu-memory-retry")))], vec![]).unwrap();
    let initial = h.held();
    h.finish(&initial[0]);
    assert!(until(|| rt.lock().item(&retry_id).is_some_and(|i| i["attempts"] == 1)));
    // The retry is now waiting behind two actual encode leases.
    std::thread::sleep(Duration::from_millis(250));
    h.finish(&initial[1]);
    assert!(until(|| !h.held().iter().any(|s| s.pid == initial[1].pid)));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(h.spawned().len(), 3, "normal work must not refill the device while a serial retry drains it");
    h.finish(&initial[2]);
    assert!(until(|| h.spawned().len() == 4));
    let held = h.held();
    assert_eq!(held.len(), 1);
    assert!(held[0].args.contains(&rt.lock().item(&retry_id).unwrap()["sourcePath"].as_str().unwrap().to_string()));
    h.finish(&held[0]);
    let job = h.finish_job(&id);
    assert!(job["items"].as_array().unwrap().iter().all(|i| i["state"] == "completed"));
}

fn memory_benchmark(free_mib: u64, total_mib: u64) -> Value {
    let mut o=gpu_options(1);
    o.gpu_memory=Some(Arc::new(Gate::new(Arc::new(move |_|Some(Reading{free_mib,total_mib})))));
    let h=Harness::new(o);
    let source=fs::read_dir(h.dir.path().join("footage/RecentClips")).unwrap().next().unwrap().unwrap().path();
    let generated=std::process::Command::new("ffmpeg").args(["-v","error","-y","-f","lavfi","-i","testsrc2=size=64x64:rate=12:duration=0.5","-c:v","libx264","-bf","0","-pix_fmt","yuv420p","-use_editlist","0"]).arg(&source).output().unwrap();
    assert!(generated.status.success());
    let original=fs::read(&source).unwrap();
    let output=h.conv.run_benchmark_mode(&crate::converter::runtime::BenchRequest{codecs:vec!["h265".into()],profile_id:"aggressive".into(),
        bitrate_kbps:None,quality_level:None,verify_mode:"quick".into(),source_root:Some(h.dir.path().join("footage").to_string_lossy().into_owned())},false,true,&|_|{}).unwrap();
    assert_eq!(fs::read(&source).unwrap(),original);
    assert!(h.service().list().unwrap().is_empty(),"benchmark keeps its own job store");
    output["devices"][0]["codecs"][0].clone()
}

#[test]
fn gpu_memory_benchmark_stops_before_a_parallel_level_that_does_not_fit() {
    let result=memory_benchmark(1304,8192);
    assert_eq!(result["results"][1]["ok"],false,"memory must bound the measured parallel level: {result}");
    assert_eq!(result["best"]["level"],1);
    assert_eq!(result["memory"]["limit"],1);
    assert_eq!(result["memory"]["perEncodeMib"],1010);
    assert_eq!(result["memory"]["limited"],true,"the refused level must be distinguished from memory telemetry");
}

#[test]
fn gpu_memory_benchmark_does_not_call_available_memory_a_limit() {
    let result=memory_benchmark(10000,10000);
    assert_eq!(result["results"].as_array().unwrap().len(),5);
    assert!(result["results"].as_array().unwrap().iter().all(|r|r["ok"]==true));
    assert_eq!(result["memory"]["limit"],9);
    assert_eq!(result["memory"]["limited"],false,"no tested level was refused");
}

#[test]
fn gpu_memory_wait_drains_for_a_user_pause_and_can_resume_after_a_speed_test() {
    use std::sync::atomic::AtomicU64;
    let free=Arc::new(AtomicU64::new(0));let sample=free.clone();
    let mut o=gpu_options(1);
    o.gpu_memory=Some(Arc::new(Gate::new(Arc::new(move |_|Some(Reading{free_mib:sample.load(Ordering::SeqCst),total_mib:8192})))));
    let h=Harness::new(o);
    let id=h.service().start(&gpu_config(&h,1)).unwrap();
    let rt=h.service().ensure_runtime(&id).unwrap();
    assert!(until(||!rt.lock().in_flight.is_empty()));
    h.service().pause(&id).unwrap();
    assert!(until(||{let s=rt.lock();s.manifest.state()==JobState::Paused && s.producer_done && s.in_flight.is_empty() && s.parked_workers==s.live_workers}));
    let paused=h.service().get(&id).unwrap();
    assert_eq!(paused["items"][0]["state"],"queued");
    assert!(h.spawned().is_empty());
    let test=h.service().try_speed_test(true).unwrap().unwrap();
    assert_eq!(h.service().resume(&id).unwrap_err().code.as_deref(),Some("SPEED_TEST_RUNNING"));
    assert_eq!(h.service().get(&id).unwrap(),paused);
    drop(test);
    free.store(1304,Ordering::SeqCst);
    h.service().resume(&id).unwrap();
    assert_eq!(h.finish_job(&id)["items"][0]["state"],"completed");
}
