//! Generated sources only: exercise the actual source reader, encoder and verifier.
use super::*;
use crate::converter::{adapters, lead_in, planner::Selected, process::BoundedRunner, service::EncodeRequest, testutil::tempdir};
use std::{fs, path::Path, process::Command};

fn generate(path: &Path, ticks: &[u64]) {
    let r = Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=25",
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
    let bytes = adapters::telemetry_bytes(&fs::read(target).unwrap(), &timeline, Codec::H265).unwrap();
    fs::write(target, bytes).unwrap();
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
    for kind in ["duplicate-timestamp", "nal-boundary", "unfinished-sample-table"] {
        let dir=tempdir().unwrap(); let root=dir.path().join("footage");
        fs::create_dir_all(root.join("RecentClips")).unwrap(); fs::create_dir_all(dir.path().join("temp")).unwrap();
        let source=root.join("RecentClips/2026-01-01_00-00-00-front.mp4");
        generate(&source,&vec![400;48]);
        let mut bytes=fs::read(&source).unwrap();
        match kind {
            "duplicate-timestamp" => { let mut ticks=vec![400;48]; ticks[12]=0; bytes=lead_in::retime_to_source(&bytes,10000,&ticks).unwrap(); }
            "nal-boundary" => {let tree=mp4w::parse(&bytes).unwrap(); let (track,_)=mp4w::select_video_track(&tree).unwrap(); let samples=mp4w::build_sample_index(&tree,track).unwrap(); let at=samples[7].offset as usize; bytes[at..at+4].copy_from_slice(&u32::MAX.to_be_bytes());}
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
        assert_eq!(job["items"][0]["resultCode"],format!("source-{kind}"));
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
