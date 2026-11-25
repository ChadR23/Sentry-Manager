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
    let h=Harness::new(gpu_options(2));
    let id=h.service().start(&gpu_config(&h,1)).unwrap();
    let finished=h.finish_job(&id);
    let items:Vec<Value>=finished["items"].as_array().unwrap().iter().enumerate().map(|(n,i)| {
            let code=if n==0 {"frame-count-mismatch"} else {"invalid-h264"};
            merge(i,&vec![("state",Some(json!("failed"))),("resultCode",Some(json!(code))),
                ("failure",Some(json!({"code":code,"retryable":false})))])
        }).collect();
    let manifest=h.service().store().create(json!({"state":"paused","config":finished["config"],"discoveryComplete":true,"items":items}).as_object().unwrap()).unwrap();
    let id=manifest.id().to_string();
    let rt=h.service().ensure_runtime(&id).unwrap();
    rt.lock().pause_requested=true;
    let original=h.service().get(&id).unwrap();
    let queued=h.service().retry_temporary(&id).unwrap();
    assert_eq!(queued["state"],"paused");
    assert_eq!(queued["items"][0]["state"],"queued");
    assert_eq!(queued["items"][0]["resultCode"],"gpu-memory-retry");
    assert_eq!(queued["items"][1],original["items"][1]);
    assert_eq!(h.spawned().len(),2,"the retry action never resumes the owner pause");
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
