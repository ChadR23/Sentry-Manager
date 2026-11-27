//! Generated sources only: exercise the actual source reader, encoder and verifier.
use super::*;
use crate::converter::{adapters, lead_in, planner::Selected, process::BoundedRunner, service::EncodeRequest, testutil::tempdir};
use std::{fs, path::Path, process::Command};

fn generate(path: &Path, ticks: &[u64]) {
    generate_at_rate(path, ticks, 25);
}

fn generate_at_rate(path: &Path, ticks: &[u64], rate: u32) {
    let r = Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", &format!("testsrc2=size=160x96:rate={rate}"),
        "-frames:v", &ticks.len().to_string(), "-c:v", "libx264", "-qp", "0", "-g", "12", "-bf", "0",
        "-bsf:v", "filter_units=remove_types=6,h264_metadata=tick_rate=20000/1:fixed_frame_rate_flag=0:sei_user_data=42424242-4242-4242-4242-424242426942+generated",
        "-video_track_timescale", "10000", "-use_editlist", "0"]).arg(path).output().unwrap();
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    retime_generated(path, ticks);
}

pub(super) fn retime_generated(path: &Path, ticks: &[u64]) {
    let mut bytes = fs::read(path).unwrap();
    if ticks.len() == 1 {
        // A fixed-size stsz is valid for a one-sample stub. No sample-index
        // reader is needed to change the generated v0 timing headers.
        let tree = mp4w::parse(&bytes).unwrap();
        let positions:Vec<_> = [(b"stts",12), (b"mdhd",16), (b"tkhd",20), (b"mvhd",16)].into_iter()
            .map(|(name, offset)| (tree.node(tree.find(mp4w::ROOT,name)[0]).content as usize + offset, name)).collect();
        for (at,name) in positions {
            let duration = if name == b"tkhd" || name == b"mvhd" { ticks[0] / 10 } else { ticks[0] };
            bytes[at..at+4].copy_from_slice(&(duration as u32).to_be_bytes());
        }
    } else {
        bytes = lead_in::retime_to_source(&bytes, 10000, ticks).unwrap();
        if ticks.last() == Some(&0) {
            // An edit ending at the final PTS reproduces the recorder's
            // discarded last packet, rather than asking the decoder to show it.
            let tree = mp4w::parse(&bytes).unwrap();
            fn rebuild(tree:&Tree, node:usize, duration:u32)->Vec<u8> {
                let n=tree.node(node);
                let mut payload=if n.children.is_empty() {tree.payload(node).unwrap().to_vec()} else {
                    n.children.iter().flat_map(|&child|rebuild(tree,child,duration)).collect()
                };
                if &n.typ == b"trak" {
                    let entries=[0u32,1,duration,0,0x00010000].iter().flat_map(|n|n.to_be_bytes()).collect::<Vec<_>>();
                    payload.extend(mp4w::make_box(b"edts",&mp4w::make_box(b"elst",&entries).unwrap()).unwrap());
                }
                mp4w::make_box(&n.typ,&payload).unwrap()
            }
            bytes=tree.top().iter().flat_map(|&node|rebuild(&tree,node,(ticks.iter().sum::<u64>()/10) as u32)).collect();
        }
    }
    fs::write(path, bytes).unwrap();
}

fn encode(source: &Path, target: &Path) {
    encode_profile(source, target, "custom");
}

pub(super) fn encode_profile(source: &Path, target: &Path, profile: &str) {
    let timeline = encode_without_telemetry(source, target, profile);
    let bytes = adapters::telemetry_bytes(&fs::read(target).unwrap(), &timeline, Codec::H265).unwrap();
    fs::write(target, bytes).unwrap();
}

fn encode_without_telemetry(source: &Path, target: &Path, profile: &str) -> Timeline {
    use crate::converter::service::{tools::Inspected, work::initial_plan};
    let source_bytes = fs::read(source).unwrap();
    let timeline = extract(&source_bytes).unwrap();
    let selected = Selected { family:"h265".into(), codec:"libx265".into(), hardware:false, remote:false, timed_out:false, device:None };
    let inspected = Inspected {codec:"h264".into(), duration_seconds:timeline.samples.iter().map(|s|s.duration_us).sum::<i64>() as f64 / 1_000_000.0};
    let plan = initial_plan(&json!({"codec":"h265","profileId":profile,"bitrateKbps":100}), source_bytes.len() as u64,
        &inspected, &timeline, selected, vec![]).unwrap();
    let args = EncodeRequest { source:source.to_str().unwrap(), target:target.to_str().unwrap(), codec:"h265", encoder:&plan.selected,
        bitrate:plan.bitrate, quality:plan.quality.as_deref(), duration_us:plan.duration_us, window:None, hold_frames:plan.hold_frames, smallest:plan.smallest, keep_order:plan.keep_order,
        decode:None, lane_id:None }.local_args().unwrap();
    let r = Command::new("ffmpeg").args(args).output().unwrap();
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    timeline
}

fn verify(source: &Path, candidate: &Path, mode: &str) -> Verdict {
    verify_profile(source, candidate, mode, "custom")
}

pub(super) fn verify_profile(source: &Path, candidate: &Path, mode: &str, profile: &str) -> Verdict {
    let dir = tempdir().unwrap();
    let registry = Registry::new(dir.path().to_path_buf());
    let runner = BoundedRunner::host();
    verify_candidate(&VerifyOptions { source:source.into(), candidate:candidate.into(), codec:Codec::H265, profile_id:profile.into(),
        verify_mode:Some(mode.into()), keep_off_target:false, allow_larger:false, trusted_snapshot:false, adopt_candidate:false,
        decode_accel:vec![], source_duration_us:None, source_timeline:None, ffprobe_path:"ffprobe".into(), ffmpeg_path:"ffmpeg".into(),
        run_ffprobe:&runner, run_full_decode:&runner, registry:&registry, on_decode_accel_fallback:None, cancel:None })
}

#[test]
fn source_checks_tiny_durations_and_short_keyframe_round_trip() {
    for discarded_tail in [false,true] {
    let dir = tempdir().unwrap();
    let source = dir.path().join("source.mp4");
    let output = dir.path().join("output.mp4");
    let mut ticks:Vec<u64> = (0..96).map(|i| 270 + (i * 17) % 181).collect();
    for (i, d) in [(3, 1), (7, 4), (12, 1), (19, 87), (25, 42)] { ticks[i] = d; }
    if discarded_tail {ticks[95]=0;}
    generate(&source, &ticks);
    let probe = Command::new("ffprobe").args(["-v", "error", "-select_streams", "v:0", "-count_packets", "-count_frames", "-show_entries",
        "stream=time_base,r_frame_rate,nb_read_packets,nb_read_frames", "-of", "json"]).arg(&source).output().unwrap();
    assert!(probe.status.success());
    let metadata:Value = serde_json::from_slice(&probe.stdout).unwrap();
    eprintln!("tiny source: {metadata}");
    assert_eq!(metadata["streams"][0]["time_base"], "1/10000");
    assert_eq!(metadata["streams"][0]["nb_read_packets"], "96");
    assert_eq!(metadata["streams"][0]["nb_read_frames"], if discarded_tail {"95"} else {"96"});
    assert_eq!(metadata["streams"][0]["r_frame_rate"], "10000/1");
    encode(&source, &output);
    let original = read_output_timing(&fs::read(&source).unwrap()).unwrap();
    let encoded = read_output_timing(&fs::read(&output).unwrap()).unwrap();
    assert_eq!(encoded.samples, original.samples[..if discarded_tail {95} else {96}], "every tiny duration must survive, not just overall duration");
    for mode in ["quick", "full"] {
        let v = verify(&source, &output, mode);
        assert!(v.ok, "{mode}: {}", v.to_json());
        assert!(v.details["telemetryEvents"].as_u64().unwrap() >= 8, "generated telemetry must survive too");
    }
    }
}

#[test]
fn source_checks_smallest_preserves_tiny_samples_too() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("source.mp4");
    let output = dir.path().join("output.mp4");
    let mut ticks = vec![400; 48]; ticks[12] = 1;
    generate(&source, &ticks);
    encode_profile(&source, &output, "smallest");
    for mode in ["quick", "full"] {
        let v = verify_profile(&source, &output, mode, "smallest");
        assert!(v.ok, "{mode}: {}", v.to_json());
    }
}

#[test]
fn source_checks_reject_a_changed_tiny_duration_even_with_same_frame_count_and_length() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("source.mp4");
    let output = dir.path().join("output.mp4");
    let mut ticks = vec![400; 48]; ticks[12] = 1;
    generate(&source, &ticks);
    encode(&source, &output);
    ticks[12] = 2; ticks[13] = 399;
    fs::write(&output, lead_in::retime_to_source(&fs::read(&output).unwrap(), 10000, &ticks).unwrap()).unwrap();
    for mode in ["quick", "full"] {
        let v = verify(&source, &output, mode);
        assert!(!v.ok, "{mode} accepted a changed 1-tick keyframe: {}", v.to_json());
        assert_eq!(v.reason, Some(R::DURATION_MISMATCH));
        assert!(!v.retryable);
    }
}

#[test]
fn source_checks_single_frame_is_kept_without_an_encode_or_problem() {
    use crate::converter::runtime::{Converter, RuntimeOptions};
    for ticks in [0, 400] {
        for mode in ["replace", "separate"] {
            let dir = tempdir().unwrap();
            let root = dir.path().join("footage");
            fs::create_dir_all(root.join("RecentClips")).unwrap();
            for folder in ["temp", "out"] { fs::create_dir_all(dir.path().join(folder)).unwrap(); }
            let relative = "RecentClips/2026-01-01_12-00-00-front.mp4";
            let source = root.join(relative);
            generate(&source, &[ticks]);
            let before = fs::read(&source).unwrap();
            let spawned = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counter = spawned.clone();
            let mut options = RuntimeOptions::new(dir.path().join("data"), dir.path().join("temp"), "ffmpeg", "ffprobe");
            options.auto_timer = false;
            options.tune = Some(Box::new(move |o| o.on_spawn = Some(std::sync::Arc::new(move |_| {counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);} ))));
            let converter = Converter::open(options).unwrap();
            let id = converter.service.start(&json!({"sourceRoot":root,"destinationRoot":if mode=="separate" {Some(dir.path().join("out"))} else {None},
                "outputMode":mode,"replacementConfirmed":mode=="replace","codec":"h265","profileId":"balanced","verifyMode":"quick",
                "includedGroups":["RecentClips"],"networkMode":"direct","concurrency":1})).unwrap();
            converter.service.when_idle(&id).unwrap();
            let job = converter.service.get(&id).unwrap();
            assert_eq!(job["items"][0]["resultCode"], "too-short", "{ticks} {mode}: {job}");
            assert_eq!(job["items"][0]["state"], if mode == "replace" {"skipped"} else {"completed"});
            assert!(job["items"][0]["failure"].is_null());
            assert_eq!(spawned.load(std::sync::atomic::Ordering::SeqCst), 0);
            assert_eq!(fs::read(&source).unwrap(), before);
            if mode == "separate" { assert_eq!(fs::read(dir.path().join("out").join(relative)).unwrap(), before); }
            converter.shutdown();
        }
    }
}

#[test]
fn source_checks_zero_duration_inside_the_clip_has_a_precise_refusal() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("source.mp4");
    let output = dir.path().join("output.mp4");
    generate(&source, &vec![400; 48]);
    encode(&source, &output);
    let mut ticks = vec![400;48]; ticks[12] = 0;
    fs::write(&source, lead_in::retime_to_source(&fs::read(&source).unwrap(), 10000, &ticks).unwrap()).unwrap();
    let v = verify(&source, &output, "quick");
    assert_eq!(v.reason, Some(R::SOURCE_INVALID));
    assert_eq!(v.details["kind"], "nonpositive-sample-duration");
    assert_eq!(v.details["sampleIndex"], 12);
    assert!(!v.retryable);
}

#[test]
fn source_checks_packet_frame_deficit_is_not_permission_to_ignore_broken_nals() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("source.mp4");
    let output = dir.path().join("output.mp4");
    generate(&source, &vec![400;48]);
    encode(&source, &output);
    let mut bytes = fs::read(&source).unwrap();
    let tree = mp4w::parse(&bytes).unwrap();
    let (track, _) = mp4w::select_video_track(&tree).unwrap();
    let samples = mp4w::build_sample_index(&tree, track).unwrap();
    for i in [7, 19, 31] { let at = samples[i].offset as usize; bytes[at..at+4].copy_from_slice(&u32::MAX.to_be_bytes()); }
    fs::write(&source, &bytes).unwrap();
    let probe = Command::new("ffprobe").args(["-v", "error", "-count_packets", "-count_frames", "-show_entries",
        "stream=nb_read_packets,nb_read_frames", "-of", "json"]).arg(&source).output().unwrap();
    let metadata:Value = serde_json::from_slice(&probe.stdout).unwrap();
    eprintln!("broken NAL source: {metadata}; stderr={}", String::from_utf8_lossy(&probe.stderr));
    assert_eq!(metadata["streams"][0]["nb_read_packets"], "48");
    assert_eq!(metadata["streams"][0]["nb_read_frames"], "45");
    let error = extract(&bytes).unwrap_err();
    assert_eq!(error.code, "INVALID_H264");
    assert_eq!(error.path.as_deref(), Some("samples[7]"));
    let failure = crate::converter::service::Fail::from(error);
    assert_eq!(failure.detail.as_deref(), Some("samples[7]: NAL length exceeds sample boundary"));
    assert!(!failure.retryable);
    let v = verify(&source, &output, "quick");
    assert_eq!(v.reason, Some(R::SOURCE_INVALID));
    assert_eq!(v.details["kind"], "h264-nal");
    assert_eq!(v.details["check"], "NAL length exceeds sample boundary");
    assert_eq!(v.details["sample"], "samples[7]");
    assert!(!v.retryable);

    // Exercise the service too: diagnostics must survive without adding
    // unsupported fields to the persisted failure schema or retrying the clip.
    use crate::converter::runtime::{Converter, RuntimeOptions};
    let root = dir.path().join("footage");
    fs::create_dir_all(root.join("RecentClips")).unwrap();
    fs::create_dir_all(dir.path().join("temp")).unwrap();
    let clip = root.join("RecentClips/2026-01-01_12-00-00-front.mp4");
    fs::write(&clip, &bytes).unwrap();
    let mut options = RuntimeOptions::new(dir.path().join("data"), dir.path().join("temp"), "ffmpeg", "ffprobe");
    options.auto_timer = false;
    let converter = Converter::open(options).unwrap();
    let id = converter.service.start(&json!({"sourceRoot":root,"destinationRoot":null,"outputMode":"replace",
        "replacementConfirmed":true,"codec":"h265","profileId":"balanced","verifyMode":"quick",
        "includedGroups":["RecentClips"],"networkMode":"direct","concurrency":1})).unwrap();
    converter.service.when_idle(&id).unwrap();
    let job = converter.service.get(&id).unwrap();
    assert_eq!(job["items"][0]["state"], "skipped", "{job}");
    assert_eq!(job["items"][0]["resultCode"], "source-nal-boundary");
    assert!(job["items"][0]["failure"].is_null());
    assert_eq!(job["items"][0]["attempts"], 0);
    assert_eq!(fs::read(&clip).unwrap(), bytes);
    assert!(crate::converter::service::LOGGED.lock().unwrap().iter().any(|line|
        line.contains(&id) && line.contains("SOURCE_NAL_BOUNDARY") && line.contains("samples[7]: NAL length exceeds sample boundary")));
    converter.shutdown();
}

#[test]
fn readonly_proven_source_defects_are_kept_without_encoding() {
    use crate::converter::runtime::{Converter, RuntimeOptions};
    for kind in ["duplicate-timestamp", "nal-boundary", "unfinished-sample-table", "missing-sample-entry"] {
        let dir=tempdir().unwrap(); let root=dir.path().join("footage");
        fs::create_dir_all(root.join("RecentClips")).unwrap(); fs::create_dir_all(dir.path().join("temp")).unwrap();
        let source=root.join("RecentClips/2026-01-01_00-00-00-front.mp4");
        generate(&source,&vec![400;48]);
        let mut bytes=fs::read(&source).unwrap();
        match kind {
            "duplicate-timestamp" => { let mut ticks=vec![400;48]; ticks[12]=0; bytes=lead_in::retime_to_source(&bytes,10000,&ticks).unwrap(); }
            "nal-boundary" => {let tree=mp4w::parse(&bytes).unwrap(); let (track,_)=mp4w::select_video_track(&tree).unwrap(); let samples=mp4w::build_sample_index(&tree,track).unwrap(); let at=samples[7].offset as usize; bytes[at..at+4].copy_from_slice(&u32::MAX.to_be_bytes());}
            "missing-sample-entry" => {let tree=mp4w::parse(&bytes).unwrap(); let at=tree.node(tree.find(mp4w::ROOT,b"stsz")[0]).content as usize+8; bytes[at..at+4].copy_from_slice(&49u32.to_be_bytes());}
            _ => {let tree=mp4w::parse(&bytes).unwrap(); let n=tree.node(tree.find(mp4w::ROOT,b"stsz")[0]); let start=n.start as usize; let end=(n.content+4) as usize; let oldend=(n.start+n.size) as usize; bytes[start..start+4].copy_from_slice(&((end-start) as u32).to_be_bytes()); bytes[end+4..end+8].copy_from_slice(b"free"); bytes[end..end+4].copy_from_slice(&((oldend-end) as u32).to_be_bytes());}
        }
        fs::write(&source,&bytes).unwrap();
        let spawned=std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)); let counter=spawned.clone();
        let mut opts=RuntimeOptions::new(dir.path().join("data"),dir.path().join("temp"),"ffmpeg","ffprobe"); opts.auto_timer=false;
        opts.tune=Some(Box::new(move |o|o.on_spawn=Some(std::sync::Arc::new(move |_|{counter.fetch_add(1,std::sync::atomic::Ordering::SeqCst);} ))));
        let conv=Converter::open(opts).unwrap();
        let id=conv.service.start(&json!({"sourceRoot":root,"destinationRoot":null,"outputMode":"replace","replacementConfirmed":true,"codec":"h265","profileId":"balanced","verifyMode":"quick","includedGroups":["RecentClips"],"networkMode":"direct","concurrency":1})).unwrap();
        conv.service.when_idle(&id).unwrap(); let job=conv.service.get(&id).unwrap();
        assert_eq!(job["items"][0]["state"],"skipped","{kind}: {job}");
        assert_eq!(job["items"][0]["resultCode"],format!("source-{}",if kind=="missing-sample-entry" {"unfinished-sample-table"} else {kind}));
        assert!(job["items"][0]["failure"].is_null());
        assert_eq!(spawned.load(std::sync::atomic::Ordering::SeqCst),0);
        assert_eq!(fs::read(&source).unwrap(),bytes); conv.shutdown();
    }
}
#[test]
fn readonly_restart_reloads_skipped_clip_and_index_then_converts_exactly_once() { restart_folder_wait(false); }
#[test]
fn readonly_restart_paused_job_resumes_exactly_once() { restart_folder_wait(true); }
fn restart_folder_wait(paused:bool) {
    use crate::converter::{runtime::{Converter,RuntimeOptions}};
    use std::os::unix::fs::PermissionsExt;
    let dir=tempdir().unwrap();let root=dir.path().join("footage");let folder=root.join("RecentClips");
    fs::create_dir_all(&folder).unwrap();fs::create_dir_all(dir.path().join("temp")).unwrap();
    let source=folder.join("2020-01-01_00-00-00-front.mp4");generate(&source,&vec![400;48]);
    let spawned=std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let open=|| {
        let counter=spawned.clone();let mut o=RuntimeOptions::new(dir.path().join("data"),dir.path().join("temp"),"ffmpeg","ffprobe");
        o.auto_timer=false;o.tune=Some(Box::new(move |o|o.on_spawn=Some(std::sync::Arc::new(move |_|{counter.fetch_add(1,std::sync::atomic::Ordering::SeqCst);} ))));Converter::open(o).unwrap()
    };
    let c=json!({"sourceRoot":root,"destinationRoot":null,"outputMode":"replace","replacementConfirmed":true,"codec":"h265","profileId":"balanced","verifyMode":"quick","includedGroups":["RecentClips"],"networkMode":"direct","concurrency":1,"autoConvert":true});
    let conv=open();
    // A durable race outcome from the preceding process, as produced by fail_item.
    let metadata=fs::metadata(&source).unwrap();let item=json!({"id":"item-000001","state":"skipped","eventId":null,"kind":"video","relativePath":"RecentClips/2020-01-01_00-00-00-front.mp4","sourcePath":source,"sourceBytes":metadata.len(),"mtimeMs":crate::converter::jobstore::mtime_ms(&metadata),"group":"RecentClips","timestampKey":"2020-01-01_00-00-00","camera":"front","resultCode":"folder-not-writable","failure":{"code":"folder-not-writable","retryable":true},"attempts":0});
    fs::set_permissions(&folder,fs::Permissions::from_mode(0o555)).unwrap();
    let old=conv.store.create(json!({"config":c,"state":if paused {"paused"} else {"completed"},"items":[item],"counters":contracts::create_empty_counters(),"summary":if paused {Value::Null} else {contracts::serialize_summary(&contracts::create_empty_counters())},"discoveryComplete":true,
        "permissionBlock":if paused {Some(crate::converter::folder_access::scan(&c))}else{None}}).as_object().unwrap()).unwrap();
    conv.start().unwrap();conv.auto.configure(&json!({"enabled":true,"config":c,"catchUp":true})).unwrap();conv.auto.check_now();
    assert_eq!(spawned.load(std::sync::atomic::Ordering::SeqCst),0);
    conv.shutdown();drop(conv);
    let restarted=open();restarted.start().unwrap();
    assert_eq!(restarted.service.get(old.id()).unwrap()["items"][0]["resultCode"],"folder-not-writable");
    fs::set_permissions(&folder,fs::Permissions::from_mode(0o755)).unwrap();
    restarted.auto.check_now();let state=restarted.auto.get_state();let id=state["status"]["active"][root.to_str().unwrap()]["jobId"].as_str().unwrap().to_string();
    restarted.service.when_idle(&id).unwrap();restarted.auto.check_now();
    assert_eq!(restarted.service.get(&id).unwrap()["items"][0]["state"],"completed");
    assert_eq!(spawned.load(std::sync::atomic::Ordering::SeqCst),1);
    restarted.shutdown();drop(restarted);
    let again=open();again.start().unwrap();again.auto.check_now();
    assert_eq!(spawned.load(std::sync::atomic::Ordering::SeqCst),1,"reloaded converted index must never encode this clip twice");
    assert_eq!(again.service.list().unwrap().len(),if paused {1}else{2},"no empty extra jobs for converted clips");again.shutdown();
}
#[test]
fn readonly_valid_fixed_size_table_is_not_reported_as_unfinished() {
    use crate::converter::service::tools::{Tools,RealTools};
    let dir=tempdir().unwrap();let source=dir.path().join("single.mp4");generate(&source,&[400]);
    let tools=RealTools::new("ffmpeg","ffprobe",std::sync::Arc::new(Registry::new(dir.path().to_path_buf())));
    let result=tools.read_timeline(source.to_str().unwrap(),&std::sync::atomic::AtomicBool::new(false));
    assert!(!result.is_err_and(|e|e.code=="SOURCE_UNFINISHED_SAMPLE_TABLE"),"a valid fixed-size stsz is not proof of truncation");
}

fn shutdown_source(path: &Path, rate: u32) {
    let ticks = if rate == 36 { 367u32 } else { 417 };
    generate_at_rate(path, &[u64::from(ticks), 0], rate);
    // Use the recorder's 1/10000 movie clock too, so the edit and format
    // duration end at exactly 0.0367 (or 0.0417), not rounded milliseconds.
    let mut bytes = fs::read(path).unwrap();
    let tree = mp4w::parse(&bytes).unwrap();
    let positions:Vec<_> = [(b"mvhd",12,10000), (b"mvhd",16,ticks), (b"tkhd",20,ticks), (b"elst",8,ticks)].into_iter()
        .map(|(name, offset, value)| (tree.node(tree.find(mp4w::ROOT,name)[0]).content as usize + offset, value)).collect();
    for (at, value) in positions { bytes[at..at+4].copy_from_slice(&value.to_be_bytes()); }
    fs::write(path, bytes).unwrap();
}

fn frame_probe(path: &Path) -> Value {
    let probe = Command::new("ffprobe").args(["-v","error","-select_streams","v:0","-count_frames","-show_entries",
        "stream=nb_frames,nb_read_frames:format=duration","-of","json"]).arg(path).output().unwrap();
    assert!(probe.status.success(), "{}", String::from_utf8_lossy(&probe.stderr));
    serde_json::from_slice(&probe.stdout).unwrap()
}

#[test]
fn shutdown_stub_candidate_single_sample_is_not_a_truncated_table() {
    let dir = tempdir().unwrap(); let source = dir.path().join("source.mp4"); let target = dir.path().join("candidate.mp4");
    shutdown_source(&source, 36);
    let bytes = fs::read(&source).unwrap(); let tree = mp4w::parse(&bytes).unwrap();
    let stsz = tree.payload(tree.find(mp4w::ROOT,b"stsz")[0]).unwrap();
    assert_eq!(stsz.len(),20); assert_eq!(mp4w::be32(stsz,4),0); assert_eq!(mp4w::be32(stsz,8),2);
    assert_eq!(extract(&bytes).unwrap().samples.len(),2);
    let probe = frame_probe(&source);
    assert_eq!(probe["streams"][0]["nb_frames"],"2"); assert_eq!(probe["streams"][0]["nb_read_frames"],"1");
    assert_eq!(probe["format"]["duration"],"0.036700");
    let timeline = encode_without_telemetry(&source, &target, "balanced");
    let encoded = fs::read(&target).unwrap(); let tree = mp4w::parse(&encoded).unwrap();
    let stsz = tree.payload(tree.find(mp4w::ROOT,b"stsz")[0]).unwrap();
    assert_eq!(stsz.len(),12); assert!(mp4w::be32(stsz,4)>0); assert_eq!(mp4w::be32(stsz,8),1);
    assert_eq!(adapters::output_timing(&encoded).unwrap().len(),1,"valid constant-size header");
    assert!(adapters::telemetry_bytes(&encoded,&timeline,Codec::H265).is_ok());
}

#[test]
fn shutdown_stub_is_kept_before_encoding_in_both_output_modes() {
    use crate::converter::runtime::{Converter, RuntimeOptions};
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
    for rate in [36,24] { for mode in ["replace","separate"] {
        let dir = tempdir().unwrap(); let root = dir.path().join("footage");
        for path in [root.join("RecentClips"),dir.path().join("temp"),dir.path().join("out")] {fs::create_dir_all(path).unwrap();}
        let relative = "RecentClips/2020-01-01_00-00-00-front.mp4"; let source = root.join(relative);
        shutdown_source(&source,rate); let before = fs::read(&source).unwrap();
        let spawned = Arc::new(AtomicUsize::new(0)); let counter = spawned.clone();
        let mut opts = RuntimeOptions::new(dir.path().join("data"),dir.path().join("temp"),"ffmpeg","ffprobe"); opts.auto_timer = false;
        opts.tune = Some(Box::new(move |o|o.on_spawn=Some(Arc::new(move |_|{counter.fetch_add(1,Ordering::SeqCst);} ))));
        let conv = Converter::open(opts).unwrap();
        let id = conv.service.start(&json!({"sourceRoot":root,"destinationRoot":if mode=="separate" {Some(dir.path().join("out"))} else {None},
            "outputMode":mode,"replacementConfirmed":mode=="replace","codec":"h265","profileId":"balanced","verifyMode":"quick",
            "includedGroups":["RecentClips"],"networkMode":"direct","concurrency":1})).unwrap();
        conv.service.when_idle(&id).unwrap(); let job = conv.service.get(&id).unwrap(); let item = &job["items"][0];
        assert_eq!(item["resultCode"],"too-short","{rate} {mode}: {job}");
        assert_eq!(item["state"],if mode=="replace" {"skipped"} else {"completed"});
        assert!(item["failure"].is_null()); assert_eq!(item["attempts"],0); assert_eq!(spawned.load(Ordering::SeqCst),0);
        assert_eq!(fs::read(&source).unwrap(),before);
        if mode=="separate" {assert_eq!(fs::read(dir.path().join("out").join(relative)).unwrap(),before);}
        assert!(item["ownedPaths"].as_object().is_none_or(|o|o.is_empty()));
        conv.shutdown();
    }}
}

#[test]
fn shutdown_stub_checks_do_not_keep_real_short_clips() {
    use crate::converter::service::tools::{RealTools, Tools};
    use std::sync::{Arc,atomic::AtomicBool};
    let dir = tempdir().unwrap();
    let tools = RealTools::new("ffmpeg","ffprobe",Arc::new(Registry::new(dir.path().to_path_buf())));
    for (name,ticks) in [("two",vec![367,367]),("72",vec![278;72])] {
        let source = dir.path().join(format!("{name}.mp4")); let target = dir.path().join(format!("{name}-out.mp4"));
        generate_at_rate(&source,&ticks,36);
        assert!(tools.inspect_video(source.to_str().unwrap(),&Arc::new(AtomicBool::new(false))).is_ok());
        assert_eq!(frame_probe(&source)["streams"][0]["nb_read_frames"],ticks.len().to_string());
        encode(&source,&target);
        for mode in ["quick","full"] {let v=verify(&source,&target,mode);assert!(v.ok,"{name} {mode}: {}",v.to_json());}
    }
}

fn empty_encode(path: &Path, keep_track: bool) {
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-v","error","-f","lavfi","-i","testsrc2=size=160x96:rate=36","-c:v","libx265","-x265-params","pools=1","-frames:v","0"]);
    if keep_track {cmd.args(["-movflags","empty_moov"]);}
    let r = cmd.arg(path).output().unwrap(); assert!(r.status.success(),"{}",String::from_utf8_lossy(&r.stderr));
    if keep_track {
        // ffmpeg normally omits an empty track. Its empty_moov mode retains
        // the zero-entry tables; remove the fragment declaration/index (no fragments
        // were written) to exercise the supported, non-fragmented empty track.
        let mut bytes=fs::read(path).unwrap();
        let positions:Vec<_>=bytes.windows(4).enumerate().filter_map(|(i,b)|(b==b"mvex" || b==b"mfra").then_some(i)).collect();
        assert_eq!(positions.len(),2);
        for at in positions {bytes[at..at+4].copy_from_slice(b"free");}
        fs::write(path,bytes).unwrap();
    }
}

#[test]
fn shutdown_stub_empty_encode_is_an_output_failure() {
    let dir = tempdir().unwrap(); let source = dir.path().join("source.mp4"); generate(&source,&vec![400;48]);
    let timeline = extract(&fs::read(&source).unwrap()).unwrap();
    for keep_track in [false,true] {
        let target = dir.path().join(format!("empty-{keep_track}.mp4")); empty_encode(&target,keep_track);
        let bytes = fs::read(&target).unwrap(); let tree = mp4w::parse(&bytes).unwrap();
        if keep_track {let p=tree.payload(tree.find(mp4w::ROOT,b"stsz")[0]).unwrap();assert_eq!(mp4w::be32(p,8),0);}
        else {assert!(tree.find(mp4w::ROOT,b"trak").is_empty());}
        let error = adapters::telemetry_bytes(&bytes,&timeline,Codec::H265).unwrap_err();
        assert_eq!(error.code,"ENCODED_NO_VIDEO_SAMPLES","{error:?}");
        assert!(error.message.contains("Encoder output"));
    }
}

#[test]
fn shutdown_stub_empty_encoder_output_preserves_original_and_cleans_candidate() {
    use crate::converter::runtime::{Converter,RuntimeOptions};
    use std::{os::unix::fs::PermissionsExt,sync::{Arc,Mutex}};
    for mode in ["replace","separate"] {
        let dir = tempdir().unwrap(); let root = dir.path().join("footage");
        for p in [root.join("RecentClips"),dir.path().join("temp"),dir.path().join("out")] {fs::create_dir_all(p).unwrap();}
        let source = root.join("RecentClips/2020-01-01_00-00-00-front.mp4"); generate(&source,&vec![400;48]);
        let before = fs::read(&source).unwrap(); let empty = dir.path().join("empty.mp4"); empty_encode(&empty,false);
        // Only the encode is replaced: source inspection, selection/proofs,
        // telemetry writing, failure persistence and owned cleanup are real.
        let encoder = dir.path().join("empty-encoder");
        fs::write(&encoder,format!("#!/bin/sh\nempty=0\nfor arg do\n [ \"$arg\" != -progress ] || empty=1\n last=$arg\ndone\nif [ $empty = 1 ]; then cp '{}' \"$last\"; else exec ffmpeg \"$@\"; fi\n",empty.display())).unwrap();
        fs::set_permissions(&encoder,fs::Permissions::from_mode(0o755)).unwrap();
        let candidates = Arc::new(Mutex::new(Vec::<String>::new())); let seen = candidates.clone();
        let mut opts = RuntimeOptions::new(dir.path().join("data"),dir.path().join("temp"),encoder.to_str().unwrap(),"ffprobe"); opts.auto_timer=false;
        opts.tune=Some(Box::new(move |o|o.on_spawn=Some(Arc::new(move |args|seen.lock().unwrap().push(args.last().unwrap().clone())))));
        let conv = Converter::open(opts).unwrap();
        let id=conv.service.start(&json!({"sourceRoot":root,"destinationRoot":if mode=="separate" {Some(dir.path().join("out"))}else{None},
            "outputMode":mode,"replacementConfirmed":mode=="replace","codec":"h265","profileId":"balanced","verifyMode":"quick",
            "includedGroups":["RecentClips"],"networkMode":"direct","concurrency":1})).unwrap();
        conv.service.when_idle(&id).unwrap(); let job=conv.service.get(&id).unwrap(); let item=&job["items"][0];
        assert_eq!(item["state"],"failed","{job}"); assert_eq!(item["resultCode"],"encoded-no-video-samples","{job}");
        assert_eq!(item["failure"]["retryable"],false); assert_eq!(item["attempts"],1);
        assert_eq!(fs::read(&source).unwrap(),before);
        assert_eq!(fs::read_dir(source.parent().unwrap()).unwrap().count(),1,"no replacement/backup leftovers");
        assert!(!dir.path().join("out/RecentClips/2020-01-01_00-00-00-front.mp4").exists());
        let candidates=candidates.lock().unwrap(); assert_eq!(candidates.len(),1);
        for p in candidates.iter() {assert!(!Path::new(p).exists(),"candidate not cleaned: {p}");}
        assert!(item["ownedPaths"].as_object().is_none_or(|o|o.is_empty())); conv.shutdown();
    }
}

#[test]
fn shutdown_stub_failed_items_become_kept_on_the_next_automatic_run() {
    failed_stubs_become_kept(false);
}

#[test]
fn no_playable_stub_failed_items_become_kept_on_the_next_automatic_run() {
    failed_stubs_become_kept(true);
}

fn failed_stubs_become_kept(no_frames: bool) {
    use crate::converter::{runtime::{Converter,RuntimeOptions},auto_convert::setup_key};
    use std::sync::{Arc,atomic::{AtomicUsize,Ordering}};
    let dir=tempdir().unwrap(); let root=dir.path().join("footage");
    for p in [root.join("SavedClips/generated"),root.join("SentryClips/generated"),dir.path().join("temp")] {fs::create_dir_all(p).unwrap();}
    let c=json!({"sourceRoot":root,"destinationRoot":null,"outputMode":"replace","replacementConfirmed":true,"codec":"h265",
        "profileId":"balanced","verifyMode":"quick","includedGroups":["SavedClips","SentryClips"],"networkMode":"direct","concurrency":1,"autoConvert":true});
    let paths=["SentryClips/generated/2020-01-01_00-00-00-back.mp4","SavedClips/generated/2020-01-01_00-00-00-left_repeater.mp4",
        "SavedClips/generated/2020-01-01_00-00-00-right_repeater.mp4"];
    let mut items=vec![]; let mut originals=vec![]; let mut failures=serde_json::Map::new();
    for (n,relative) in paths.iter().enumerate() {
        let source=root.join(relative);
        if no_frames && n == 2 { subsecond_no_playable_source(&source); }
        else if no_frames { no_playable_source(&source); } else { shutdown_source(&source,36); }
        originals.push(fs::read(&source).unwrap()); let metadata=fs::metadata(&source).unwrap();
        let old_code=if no_frames { ["unsupported-container","encoded-no-video-samples","cancelled"][n] } else {"invalid-mp4"};
        items.push(json!({"id":format!("item-{:06}",n+1),"state":"failed","eventId":null,"kind":"video","relativePath":relative,"sourcePath":source,
            "sourceBytes":metadata.len(),"mtimeMs":crate::converter::jobstore::mtime_ms(&metadata),"group":relative.split('/').next().unwrap(),
            "timestampKey":"2020-01-01_00-00-00","camera":"front","resultCode":old_code,"failure":{"code":old_code,"retryable":false},"attempts":1}));
        failures.insert(relative.to_string(),json!(1));
        if old_code == "cancelled" { items[n]["encoder"] = json!("hevc_vaapi"); }
    }
    let spawned=Arc::new(AtomicUsize::new(0));
    let open=|| {
        let counter=spawned.clone(); let mut o=RuntimeOptions::new(dir.path().join("data"),dir.path().join("temp"),"ffmpeg","ffprobe"); o.auto_timer=false;
        o.tune=Some(Box::new(move |o|o.on_spawn=Some(Arc::new(move |_|{counter.fetch_add(1,Ordering::SeqCst);} )))); Converter::open(o).unwrap()
    };
    let conv=open();
    let old=conv.store.create(json!({"config":c,"state":"completed","items":items,"discoveryComplete":true,
        "counters":contracts::create_empty_counters(),"summary":contracts::serialize_summary(&contracts::create_empty_counters())}).as_object().unwrap()).unwrap();
    // Persist the pre-upgrade manifest and automatic state: failed items are
    // failure counts, never converted-index entries. No Retry/Clear action.
    let auto=dir.path().join("data/converter-auto"); fs::create_dir_all(&auto).unwrap();
    fs::write(auto.join("settings.json"),json!({"enabled":true,"configs":[c],"catchUp":true,"intervalMinutes":60}).to_string()).unwrap();
    fs::write(auto.join("state.json"),json!({"catchUp":{root.to_str().unwrap():{"since":1}}}).to_string()).unwrap();
    let index=auto.join(format!("index-{}.json",setup_key(&c)));
    fs::write(&index,json!({"v":2,"files":{},"gaveUp":{},"failures":failures}).to_string()).unwrap();
    conv.shutdown(); drop(conv);
    let restarted=open(); restarted.start().unwrap(); restarted.auto.tick();
    let state=restarted.auto.get_state(); let id=state["status"]["active"][root.to_str().unwrap()]["jobId"].as_str().expect("next automatic run").to_string();
    restarted.service.when_idle(&id).unwrap(); restarted.auto.tick();
    let job=restarted.service.get(&id).unwrap(); assert_eq!(job["items"].as_array().unwrap().len(),3,"{job}");
    for item in job["items"].as_array().unwrap() {assert_eq!(item["resultCode"],if no_frames {"source-no-playable-frames"} else {"too-short"},"{job}");assert_eq!(item["state"],"skipped");assert!(item["failure"].is_null());}
    assert_eq!(spawned.load(Ordering::SeqCst),0,"subsecond stubs are kept before encoding");
    assert_eq!(restarted.service.get(old.id()).unwrap()["items"],Value::Array(items),"failure history remains intact");
    let saved:Value=serde_json::from_slice(&fs::read(&index).unwrap()).unwrap();
    assert!(saved["failures"].as_object().unwrap().is_empty()); assert_eq!(saved["files"].as_object().unwrap().len(),3);
    for (n,relative) in paths.iter().enumerate() {assert_eq!(fs::read(root.join(relative)).unwrap(),originals[n]);}
    restarted.shutdown(); drop(restarted);
    let again=open(); again.start().unwrap(); again.auto.tick();
    assert_eq!(again.service.list().unwrap().len(),2,"kept clips are not submitted again"); assert_eq!(spawned.load(Ordering::SeqCst),0); again.shutdown();
}

#[test]
fn shutdown_stub_only_suspicious_sources_get_a_frame_count() {
    use crate::converter::service::tools::{RealTools,Tools};
    use std::{os::unix::fs::PermissionsExt,sync::{Arc,atomic::AtomicBool}};
    let dir=tempdir().unwrap(); let probe=dir.path().join("probe"); let log=dir.path().join("counts");
    fs::write(&probe,format!("#!/bin/sh\nfor arg do\n if [ \"$arg\" = -count_frames ]; then echo counted >> '{}'; fi\ndone\nexec ffprobe \"$@\"\n",log.display())).unwrap();
    fs::set_permissions(&probe,fs::Permissions::from_mode(0o755)).unwrap();
    let tools=RealTools::new("ffmpeg",probe.to_str().unwrap(),Arc::new(Registry::new(dir.path().to_path_buf())));
    let source=dir.path().join("source.mp4"); let cancel=Arc::new(AtomicBool::new(false));
    generate_at_rate(&source,&vec![278;72],36);
    assert!(tools.inspect_video(source.to_str().unwrap(),&cancel).is_ok()); assert!(!log.exists(),"normal short clips use only the metadata probe");
    generate_at_rate(&source,&[2000,2000],36);
    assert!(tools.inspect_video(source.to_str().unwrap(),&cancel).is_ok());
    assert_eq!(fs::read_to_string(&log).unwrap_or_default(),"counted\n","a tiny clip is decoded before deciding whether to keep it");
    shutdown_source(&source,36);
    assert_eq!(tools.inspect_video(source.to_str().unwrap(),&cancel).unwrap_err().code,"SOURCE_TOO_SHORT");
    assert_eq!(fs::read_to_string(&log).unwrap(),"counted\ncounted\n");
}

#[test]
fn shutdown_stub_inconclusive_counts_do_not_prove_one_playable_frame() {
    use crate::converter::service::tools::{RealTools,Tools};
    use std::{os::unix::fs::PermissionsExt,sync::{Arc,atomic::AtomicBool}};
    let dir=tempdir().unwrap(); let source=dir.path().join("source.mp4"); shutdown_source(&source,36);
    let probe=dir.path().join("probe"); let cancel=Arc::new(AtomicBool::new(false));
    for (body,status,stderr) in [
        (r#"{"streams":[{"nb_read_frames":"0"}]}"#,0,""),
        (r#"{"streams":[{"nb_read_frames":"N/A"}]}"#,0,""),
        (r#"{"streams":[{"nb_read_frames":"1"}]}"#,1,""),
        (r#"{"streams":[{"nb_read_frames":"1"}]}"#,0,"decode error"),
        (r#"{"streams":[{"nb_read_frames":"1"},{"nb_read_frames":"1"}]}"#,0,""),
        ("not json",0,"")
    ] {
        fs::write(&probe,format!("#!/bin/sh\nfor arg do\n if [ \"$arg\" = -count_frames ]; then\n printf '%s' '{body}'\n printf '%s' '{stderr}' >&2\n exit {status}\n fi\ndone\nexec ffprobe \"$@\"\n")).unwrap();
        fs::set_permissions(&probe,fs::Permissions::from_mode(0o755)).unwrap();
        let tools=RealTools::new("ffmpeg",probe.to_str().unwrap(),Arc::new(Registry::new(dir.path().to_path_buf())));
        assert!(!tools.inspect_video(source.to_str().unwrap(),&cancel).is_err_and(|e|e.code=="SOURCE_TOO_SHORT"),"{body} {status} {stderr}");
    }
}

// Cut the IDR sample out of a generated GOP, leaving eight complete P samples
// and no stss box, like a recording that stopped before its next keyframe.
fn no_playable_source(path: &Path) {
    generate(path, &[400; 9]);
    let bytes = fs::read(path).unwrap();
    let tree = mp4w::parse(&bytes).unwrap();
    let (track, _) = mp4w::select_video_track(&tree).unwrap();
    let samples = mp4w::build_sample_index(&tree, track).unwrap();
    let start = samples[1].offset as u32;
    fn rebuild(tree: &Tree, id: usize, start: u32) -> Vec<u8> {
        let n = tree.node(id);
        if n.typ == *b"stss" { return vec![]; }
        let mut p = if n.children.is_empty() { tree.payload(id).unwrap().to_vec() }
            else { n.children.iter().flat_map(|&c| rebuild(tree, c, start)).collect() };
        match &n.typ {
            b"stsz" => { assert_eq!(mp4w::be32(&p, 8), 9); p[8..12].copy_from_slice(&8u32.to_be_bytes()); p.drain(12..16); }
            b"stsc" => { assert_eq!(mp4w::be32(&p, 4), 1); p[12..16].copy_from_slice(&8u32.to_be_bytes()); }
            b"stco" => { assert_eq!(mp4w::be32(&p, 4), 1); p[8..12].copy_from_slice(&start.to_be_bytes()); }
            b"stts" => { assert_eq!(mp4w::be32(&p, 4), 1); p[8..12].copy_from_slice(&8u32.to_be_bytes()); }
            b"mdhd" => p[16..20].copy_from_slice(&3200u32.to_be_bytes()),
            b"mvhd" => p[16..20].copy_from_slice(&320u32.to_be_bytes()),
            b"tkhd" => p[20..24].copy_from_slice(&320u32.to_be_bytes()),
            _ => {}
        }
        mp4w::make_box(&n.typ, &p).unwrap()
    }
    // mdat precedes moov, so shrinking the sample tables cannot move the media.
    assert!(tree.node(tree.find(mp4w::ROOT, b"mdat")[0]).start < tree.node(tree.find(mp4w::ROOT, b"moov")[0]).start);
    let cut: Vec<u8> = tree.top().iter().flat_map(|&id| rebuild(&tree, id, start)).collect();
    fs::write(path, cut).unwrap();
}

fn longer_no_playable_source(path: &Path) {
    no_playable_source(path);
    retime_generated(path, &[1600; 8]); // 1.28 s, outside the pre-encode check
}

fn subsecond_no_playable_source(path: &Path) {
    no_playable_source(path);
    retime_generated(path, &[903, 903, 903, 903, 904, 904, 904, 904]); // 0.7228 s
}

fn playable_source(path: &Path) {
    generate(path, &[400; 48]);
}

#[derive(Clone, Copy)]
enum EncoderFault { Crash, MissingOutput, EmptyOutput, OutOfMemory, SuccessWithoutFile, Terminate, Cancel, Stall }

// Only the encoder and its capability advertisement are simulated. ffprobe,
// source/candidate ownership, job persistence and publication are real.
fn failed_encode(
    fixture: fn(&Path), encoder: &str, fault: EncoderFault, output_mode: &str,
) -> (Value, usize, usize) {
    use crate::converter::{runtime::{Converter, RuntimeOptions}, service::lanes_tests::until};
    use std::{os::unix::fs::PermissionsExt, sync::{Arc, Mutex}};
    let dir = tempdir().unwrap();
    let root = dir.path().join("footage");
    let output = dir.path().join("out");
    let temp = dir.path().join("temp");
    for folder in [&root.join("RecentClips"), &output, &temp] { fs::create_dir_all(folder).unwrap(); }
    let relative = "RecentClips/2020-01-01_00-00-00-front.mp4";
    let source = root.join(relative);
    fixture(&source);
    let original = fs::read(&source).unwrap();
    let ffmpeg = dir.path().join("encoder");
    let action = match fault {
        EncoderFault::Crash => "head -c 44 /dev/zero > \"$last\"\nulimit -c 0\nkill -SEGV $$",
        EncoderFault::MissingOutput => "exit 1",
        EncoderFault::EmptyOutput => ": > \"$last\"\nexit 1",
        EncoderFault::OutOfMemory => "echo 'VA-API resource allocation failed' >&2\nexit 1",
        EncoderFault::SuccessWithoutFile => "exit 0",
        EncoderFault::Terminate | EncoderFault::Cancel | EncoderFault::Stall => "printf partial > \"$last\"\nexec sleep 30",
    };
    fs::write(&ffmpeg, format!("#!/bin/sh\nfor last do :; done\ncase \"$last\" in\n-encoders) printf '%s\\n' ' V..... {encoder}' ' V..... libx265';;\n/dev/null) exit 0;;\n*) {action};;\nesac\n")).unwrap();
    let probe = dir.path().join("probe");
    let log = dir.path().join("proofs");
    fs::write(&probe, format!("#!/bin/sh\nfor last do :; done\nfor arg do\n [ \"$arg\" != -show_frames ] || printf '%s\\n' \"$last\" >> '{}'\ndone\nexec ffprobe \"$@\"\n", log.display())).unwrap();
    for program in [&ffmpeg, &probe] { fs::set_permissions(program, fs::Permissions::from_mode(0o755)).unwrap(); }
    let candidates = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = candidates.clone();
    let mut options = RuntimeOptions::new(dir.path().join("data"), temp.clone(), ffmpeg.to_str().unwrap(), probe.to_str().unwrap());
    options.auto_timer = false;
    options.tune = Some(Box::new(move |o| {
        if matches!(fault, EncoderFault::Stall) { o.encode_stall_ms = 150; }
        o.on_spawn = Some(Arc::new(move |args| seen.lock().unwrap().push(args.last().unwrap().clone())));
    }));
    let converter = Converter::open(options).unwrap();
    let id = converter.service.start(&json!({
        "sourceRoot": root, "destinationRoot": (output_mode == "separate").then_some(&output),
        "outputMode": output_mode, "replacementConfirmed": output_mode == "replace",
        "codec": "h265", "profileId": "balanced", "verifyMode": "quick",
        "includedGroups": ["RecentClips"], "networkMode": "staging", "concurrency": 1
    })).unwrap();
    if matches!(fault, EncoderFault::Cancel | EncoderFault::Terminate) {
        assert!(until(|| candidates.lock().unwrap().iter().any(|p| Path::new(p).exists())));
        if matches!(fault, EncoderFault::Cancel) {
            assert_eq!(converter.service.cancel(&id).unwrap()["state"], "cancelled");
        } else {
            let rt = converter.service.ensure_runtime(&id).unwrap();
            converter.service.terminate_children(&rt);
        }
    }
    converter.service.when_idle(&id).unwrap();
    let item = converter.service.get(&id).unwrap()["items"][0].clone();
    let stored = converter.store.load(&id).unwrap().unwrap();
    let durable = stored.items[0].value();
    for field in ["ownedPaths", "ownedArtifacts"] {
        assert!(durable[field].as_object().is_none_or(|o| o.is_empty()), "item {field}: {}", durable[field]);
        assert!(stored.get(field).and_then(Value::as_object).is_none_or(|o| o.is_empty()), "job {field}: {:?}", stored.get(field));
    }
    assert_eq!(fs::read(&source).unwrap(), original);
    assert_eq!(fs::read_dir(source.parent().unwrap()).unwrap().count(), 1, "no backup or replacement");
    if item["state"] == "completed" {
        assert_eq!(fs::read(output.join(relative)).unwrap(), original);
    } else {
        assert!(!output.join(relative).exists());
    }
    assert_eq!(fs::read_dir(temp.join("sentry-six-converter")).unwrap().count(), 0, "no staged input or partial candidate");
    let candidates = candidates.lock().unwrap();
    assert!(candidates.iter().all(|p| !Path::new(p).exists()));
    let proofs = fs::read_to_string(&log).unwrap_or_default();
    assert!(proofs.lines().all(|p| Path::new(p) == source), "proof must read the original");
    converter.shutdown();
    (item, candidates.len(), proofs.lines().count())
}

#[test]
fn encoder_crash_subsecond_stub_is_kept_before_the_encoder_sees_it() {
    let (item, encodes, proofs) = failed_encode(subsecond_no_playable_source, "hevc_vaapi", EncoderFault::Crash, "replace");
    assert_eq!(item["resultCode"], "source-no-playable-frames", "{item}");
    assert_eq!(item["state"], "skipped");
    assert!(item["failure"].is_null());
    assert_eq!(item["attempts"], 0);
    assert_eq!((encodes, proofs), (0, 1));
}

#[test]
fn encoder_crash_on_playable_source_preserves_signal_and_hardware_retry_policy() {
    for (encoder, retryable) in [("hevc_vaapi", true), ("libx265", false)] {
        let (item, encodes, proofs) = failed_encode(playable_source, encoder, EncoderFault::Crash, "separate");
        assert_eq!(item["state"], "failed");
        assert_eq!(item["resultCode"], "encoder-crashed", "{item}");
        assert_eq!(item["failure"]["code"], "encoder-crashed");
        assert_eq!(item["failure"]["retryable"], retryable);
        let detail = item["failure"]["detail"].as_str().unwrap();
        assert!(detail.contains("SIGSEGV") && detail.contains("11"), "{detail}");
        assert_eq!(item["encoder"], encoder);
        assert_eq!(item["attempts"], 1);
        assert_eq!((encodes, proofs), (1, 1), "no in-job crash retry");
    }
}

#[test]
fn encoder_crash_after_admission_keeps_a_proven_stub_and_discards_the_partial() {
    let (item, encodes, proofs) = failed_encode(longer_no_playable_source, "hevc_vaapi", EncoderFault::Crash, "separate");
    assert_eq!(item["resultCode"], "source-no-playable-frames", "{item}");
    assert_eq!(item["state"], "completed");
    assert!(item["failure"].is_null());
    assert_eq!(item["attempts"], 1);
    assert_eq!((encodes, proofs), (1, 1));
}

#[test]
fn encoder_crash_checks_an_ordinary_failure_with_no_output_before_fallback() {
    for fault in [EncoderFault::MissingOutput, EncoderFault::EmptyOutput, EncoderFault::OutOfMemory] {
        let (item, encodes, proofs) = failed_encode(longer_no_playable_source, "hevc_vaapi", fault, "replace");
        assert_eq!(item["resultCode"], "source-no-playable-frames", "{item}");
        assert_eq!(item["state"], "skipped");
        assert_eq!((encodes, proofs), (1, 1));
    }
    let (item, encodes, proofs) = failed_encode(playable_source, "libx265", EncoderFault::MissingOutput, "replace");
    assert_eq!(item["resultCode"], "encoder-failed");
    assert_eq!((encodes, proofs), (1, 1));
    let (item, encodes, proofs) = failed_encode(playable_source, "hevc_vaapi", EncoderFault::MissingOutput, "replace");
    assert_eq!(item["resultCode"], "encoder-failed");
    assert_eq!(item["encoder"], "libx265", "playable sources still get the ordinary CPU fallback");
    assert!(encodes >= 2);
    assert_eq!(proofs, 1, "repeated empty failures share the source check");
}

#[test]
fn encoder_crash_check_excludes_controlled_cancel_and_stall_watchdog() {
    for (fault, state, code) in [(EncoderFault::Cancel, "cancelled", "cancelled"), (EncoderFault::Terminate, "failed", "cancelled"), (EncoderFault::Stall, "failed", "encoder-failed")] {
        let (item, encodes, proofs) = failed_encode(longer_no_playable_source, "libx265", fault, "replace");
        assert_eq!(item["state"], state, "{item}");
        assert_eq!(item["resultCode"], code);
        assert_eq!((encodes, proofs), (1, 0), "a controlled termination must not trigger source proof");
    }
}

#[test]
fn encoder_crash_missing_candidate_after_success_also_checks_the_original() {
    for (source, expected) in [(longer_no_playable_source as fn(&Path), "source-no-playable-frames"), (playable_source, "encoded-no-video-samples")] {
        let (item, encodes, proofs) = failed_encode(source, "libx265", EncoderFault::SuccessWithoutFile, "replace");
        assert_eq!(item["resultCode"], expected, "{item}");
        assert_eq!((encodes, proofs), (1, 1));
    }
}

#[test]
fn no_playable_stub_reproduces_empty_encode_with_complete_packets() {
    let dir = tempdir().unwrap(); let source = dir.path().join("source.mp4"); let target = dir.path().join("candidate.mp4");
    no_playable_source(&source);
    let probe = Command::new("ffprobe").args(["-v", "error", "-select_streams", "v:0", "-count_packets", "-count_frames", "-show_frames", "-show_entries",
        "frame=media_type:stream=nb_frames,nb_read_packets,nb_read_frames:format=duration", "-of", "json"]).arg(&source).output().unwrap();
    assert!(probe.status.success()); assert!(probe.stderr.is_empty(), "{}", String::from_utf8_lossy(&probe.stderr));
    let counted: Value = serde_json::from_slice(&probe.stdout).unwrap();
    eprintln!("no-playable source: {counted}");
    assert_eq!(counted["streams"][0]["nb_frames"], "8");
    assert_eq!(counted["streams"][0]["nb_read_packets"], "8");
    assert!(counted["streams"][0]["nb_read_frames"].is_null());
    assert_eq!(counted["frames"], json!([]));
    let timeline = encode_without_telemetry(&source, &target, "balanced");
    let bytes = fs::read(&target).unwrap(); let tree = mp4w::parse(&bytes).unwrap();
    assert!(tree.find(mp4w::ROOT, b"trak").is_empty(), "real encode omits the empty video track");
    let error = adapters::telemetry_bytes(&bytes, &timeline, Codec::H265).unwrap_err();
    eprintln!("no-playable candidate: {}: {}", error.code, error.message);
    assert_eq!(error.code, "ENCODED_NO_VIDEO_SAMPLES");
}

#[test]
fn no_playable_stub_is_kept_after_one_encode_in_both_modes_and_read_modes() {
    no_playable_service_case(true);
}

#[test]
fn no_playable_stub_proof_is_not_run_for_successful_encodes() {
    no_playable_service_case(false);
}

fn no_playable_service_case(no_frames: bool) {
    use crate::converter::runtime::{Converter, RuntimeOptions};
    use std::{os::unix::fs::PermissionsExt, sync::{Arc, Mutex}};
    for mode in ["replace", "separate"] { for network in ["direct", "staging"] {
        let dir = tempdir().unwrap(); let root = dir.path().join("footage");
        for p in [root.join("RecentClips"), dir.path().join("temp"), dir.path().join("out")] { fs::create_dir_all(p).unwrap(); }
        let relative = "RecentClips/2020-01-01_00-00-00-front.mp4"; let source = root.join(relative);
        if no_frames { longer_no_playable_source(&source); } else { generate(&source, &[400; 48]); }
        let before = fs::read(&source).unwrap();
        let probe = dir.path().join("probe"); let log = dir.path().join("proofs");
        fs::write(&probe, format!("#!/bin/sh\nproof=0\nfor arg do\n [ \"$arg\" != -show_frames ] || proof=1\n last=$arg\ndone\nif [ $proof = 1 ]; then printf '%s\\n' \"$last\" >> '{}'; fi\nexec ffprobe \"$@\"\n", log.display())).unwrap();
        fs::set_permissions(&probe, fs::Permissions::from_mode(0o755)).unwrap();
        let candidates = Arc::new(Mutex::new(Vec::<String>::new())); let seen = candidates.clone();
        let mut opts = RuntimeOptions::new(dir.path().join("data"), dir.path().join("temp"), "ffmpeg", probe.to_str().unwrap()); opts.auto_timer = false;
        opts.tune = Some(Box::new(move |o| o.on_spawn = Some(Arc::new(move |args| seen.lock().unwrap().push(args.last().unwrap().clone())))));
        let conv = Converter::open(opts).unwrap();
        let id = conv.service.start(&json!({"sourceRoot":root,"destinationRoot":if mode=="separate" {Some(dir.path().join("out"))} else {None},
            "outputMode":mode,"replacementConfirmed":mode=="replace","codec":"h265","profileId":"balanced","verifyMode":"quick",
            "includedGroups":["RecentClips"],"networkMode":network,"concurrency":1})).unwrap();
        conv.service.when_idle(&id).unwrap(); let job = conv.service.get(&id).unwrap(); let item = &job["items"][0];
        assert_eq!(item["resultCode"], if no_frames {"source-no-playable-frames"} else {"converted"}, "{mode} {network}: {job}");
        assert_eq!(item["state"], if no_frames && mode=="replace" {"skipped"} else {"completed"});
        assert!(item["failure"].is_null()); assert_eq!(item["attempts"], 1);
        assert_eq!(fs::read_to_string(&log).unwrap_or_default(), if no_frames {format!("{}\n", source.display())} else {String::new()}, "proof reads the original, only after empty output");
        if no_frames {
            let trimmed = crate::converter::ipc::sanitize_snapshot(&json!({"items":vec![item.clone(); 257]})).unwrap();
            assert_eq!(trimmed["itemKeptCounts"]["source-no-playable-frames"], 257);
        }
        if no_frames || mode=="separate" { assert_eq!(fs::read(&source).unwrap(), before); }
        assert_eq!(fs::read_dir(source.parent().unwrap()).unwrap().count(), 1, "no replacement or backup leftovers");
        if no_frames && mode=="separate" { assert_eq!(fs::read(dir.path().join("out").join(relative)).unwrap(), before); }
        let candidates = candidates.lock().unwrap(); assert_eq!(candidates.len(), 1, "never encode twice");
        for p in candidates.iter() { assert!(!Path::new(p).exists(), "candidate not cleaned: {p}"); }
        assert!(item["ownedPaths"].as_object().is_none_or(|o| o.is_empty()));
        assert_eq!(fs::read_dir(dir.path().join("temp/sentry-six-converter")).unwrap().count(), 0, "staged input is cleaned too");
        conv.shutdown();
    }}
}

#[test]
fn no_playable_stub_proof_does_not_accept_failed_or_limited_processes() {
    use crate::converter::service::tools::{RealTools, Tools};
    use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
    let dir = tempdir().unwrap(); let source = dir.path().join("source.mp4");
    no_playable_source(&source);
    let mut tools = RealTools::new("ffmpeg", "ffprobe", Arc::new(Registry::new(dir.path().to_path_buf())));
    let cancel = Arc::new(AtomicBool::new(false));
    assert!(tools.source_has_no_playable_frames(source.to_str().unwrap(), &cancel).unwrap());
    tools.runner.max_output_bytes = 1;
    assert!(!tools.source_has_no_playable_frames(source.to_str().unwrap(), &cancel).unwrap());
    tools.runner.max_output_bytes = 1024 * 1024;
    tools.ffprobe = dir.path().join("missing-probe").to_str().unwrap().into();
    assert!(!tools.source_has_no_playable_frames(source.to_str().unwrap(), &cancel).unwrap());
    tools.ffprobe = "ffprobe".into();
    cancel.store(true, Ordering::SeqCst);
    assert_eq!(tools.source_has_no_playable_frames(source.to_str().unwrap(), &cancel).unwrap_err().code, "CANCELLED");
    cancel.store(false, Ordering::SeqCst);
    generate(&source, &[400; 48]);
    assert!(!tools.source_has_no_playable_frames(source.to_str().unwrap(), &cancel).unwrap());
    fs::write(&source, b"not a video").unwrap();
    assert!(!tools.source_has_no_playable_frames(source.to_str().unwrap(), &cancel).unwrap());
}
