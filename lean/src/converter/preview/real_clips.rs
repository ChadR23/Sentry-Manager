//! Opt-in local diagnostics. Sources are read-only; logs may contain private
//! verifier details and must stay beside the derived media, outside the repo.
use super::*;
use std::cell::RefCell;

fn report(kind: &str, case: &Value, details: Value) {
    let mut row = case.clone();
    row.as_object_mut().unwrap().extend(details.as_object().unwrap().clone());
    eprintln!("REAL_{kind} {row}");
}

fn compare_candidate(case: &Value, source: &Path, target: &Path, profile: &str, preview: bool,
    work: &Path, tools: &RealTools, cancel: &Arc<AtomicBool>) -> Result<()> {
    let original = frames::probe("ffprobe", source, false, cancel)?;
    let output = frames::probe("ffprobe", target, false, cancel)?;
    let off = original.times.iter().zip(&output.times).filter(|(a, b)| a.abs_diff(**b) > 2).count();
    let max_delta = original.times.iter().zip(&output.times).map(|(a, b)| a.abs_diff(*b)).max();
    let source_bytes = fs::metadata(source).map_err(err)?.len();
    let output_bytes = fs::metadata(target).map_err(err)?.len();
    report("TIMING", case, json!({"sourceFrames":original.times.len(), "outputFrames":output.times.len(),
        "timestampsOff":off, "maxDeltaUs":max_delta, "sourceDurationUs":original.duration_us, "outputDurationUs":output.duration_us}));
    let timeline = tools.read_timeline(source.to_str().ok_or("INVALID_SOURCE_PATH")?, cancel).map_err(err)?;
    let registry = Registry::new(work.to_path_buf());
    let mut ok = original.times.len() == output.times.len() && off == 0;
    for mode in ["quick", "full"] {
        let verdict = verifier::verify_candidate(&verifier::VerifyOptions {
            source: source.to_path_buf(), candidate: target.to_path_buf(), codec: super::super::adapters::Codec::H265,
            profile_id: (if preview && profile != "smallest" { "custom" } else { profile }).into(), verify_mode: Some(mode.into()),
            keep_off_target: true, allow_larger: preview, trusted_snapshot: false, adopt_candidate: false, decode_accel: vec![],
            source_duration_us: Some(original.duration_us as f64), source_timeline: Some(&timeline),
            ffprobe_path: "ffprobe".into(), ffmpeg_path: "ffmpeg".into(), run_ffprobe: &tools.runner, run_full_decode: &tools.runner,
            registry: &registry, on_decode_accel_fallback: None, cancel: Some(cancel.clone()),
        });
        report("DETAIL", case, json!({"mode":mode, "verdict":verdict.to_json(), "savedBytes":source_bytes as i128 - output_bytes as i128}));
        let size_only = matches!(verdict.reason, Some("not-smaller" | "profile-size"));
        let outcome = if verdict.ok { "verified" } else if size_only { "kept original (size)" } else { "failed" };
        report("TIMING", case, json!({"mode":mode, "verified":verdict.ok, "reason":verdict.reason, "outcome":outcome}));
        // Size-only rejection follows the production keep-original policy. It
        // never excuses a frame-count/PTS mismatch or another verifier failure.
        ok &= verdict.ok || size_only;
    }
    if ok { Ok(()) } else { Err("TIMING_OR_VERIFICATION_FAILED".into()) }
}

fn whole_clip(case: &Value, source: &Path, profile: &str, work: &Path, cancel: &Arc<AtomicBool>) -> Result<()> {
    let tools = RealTools::new("ffmpeg", "ffprobe", Arc::new(Registry::new(work.to_path_buf())));
    let src = source.to_str().ok_or("INVALID_SOURCE_PATH")?;
    let inspected = tools.inspect_video(src, cancel).map_err(err)?;
    let timeline = tools.read_timeline(src, cancel).map_err(err)?;
    let plan = initial_plan(&json!({"codec":"h265", "profileId":profile, "keepOffTarget":true}),
        fs::metadata(source).map_err(err)?.len(), &inspected, &timeline,
        tools.select_cpu_fallback("h265").map_err(err)?, vec![]).map_err(|e| e.code.unwrap_or_else(|| "PLAN_FAILED".into()))?;
    report("TIMING", case, json!({"sourceSamples":timeline.samples.len(), "timeScale":timeline.timescale,
        "lastDurationUs":timeline.samples.last().map(|s| s.duration_us)}));
    let target = work.join(format!("{profile}.mp4"));
    let args = EncodeRequest { source:src, target:target.to_str().ok_or("INVALID_TARGET_PATH")?, codec:&plan.codec, encoder:&plan.selected,
        bitrate:plan.bitrate, quality:plan.quality.as_deref(), duration_us:plan.duration_us, window:None,
        hold_frames:plan.hold_frames, smallest:plan.smallest, keep_order:plan.keep_order, decode:None, lane_id:None }
        .local_args().map_err(err)?;
    command("ffmpeg", &args, cancel)?;
    tools.write_telemetry(&plan.codec, target.to_str().ok_or("INVALID_TARGET_PATH")?, &timeline, cancel).map_err(err)?;
    compare_candidate(case, source, &target, profile, false, work, &tools, cancel)
}

fn previews(index: usize, source: &Path, work: &Path, cancel: &Arc<AtomicBool>) -> Result<()> {
    let tools = RealTools::new("ffmpeg", "ffprobe", Arc::new(Registry::new(work.to_path_buf())));
    let inspected = tools.inspect_video(source.to_str().ok_or("INVALID_SOURCE_PATH")?, cancel).map_err(err)?;
    let clip = PreviewClip { source:source.to_path_buf(), center_ms:(inspected.duration_seconds * 500.0).round() as i64,
        kind:"saved", event_id:format!("diagnostic-{index}"), when:String::new() };
    let levels = [("std", json!({"codec":"h265", "profileId":"balanced", "keepOffTarget":true})),
        ("med", json!({"codec":"h265", "profileId":"aggressive", "keepOffTarget":true})),
        ("high", json!({"codec":"h265", "profileId":"smallest", "keepOffTarget":true}))];
    let original = RefCell::new(None::<LevelResult>);
    let failures = RefCell::new(Vec::<String>::new());
    let completed = RefCell::new(Vec::<String>::new());
    // Inspect each published level while its files still exist, even if a later
    // level fails and run_preview removes the unfinished cache entry.
    let result = run_preview(&clip, &levels, &work.join("preview"), cancel, &|event| {
        if event["phase"] == "encoding" {
            report("PROGRESS", &json!({"clip":index, "scope":"preview", "level":event["level"]}), json!({"phase":"encoding"}));
        }
        if event["phase"] != "level" { return; }
        let checked = (|| -> Result<()> {
            let level: LevelResult = serde_json::from_value(event["result"].clone()).map_err(err)?;
            if level.level == "orig" { *original.borrow_mut() = Some(level); return Ok(()); }
            completed.borrow_mut().push(level.level.clone());
            let case = json!({"clip":index, "scope":"preview", "level":level.level});
            let before = original.borrow();
            let before = before.as_ref().ok_or("MISSING_PREVIEW_ORIGINAL")?;
            let checked = compare_candidate(&case, &before.frame.with_extension("mp4"), &level.frame.with_extension("mp4"),
                &level.profile, true, work, &tools, cancel);
            report("TIMING", &case, json!({"previewOk":checked.is_ok(), "windowStartUs":level.window_start_us, "windowEndUs":level.window_end_us}));
            checked
        })();
        if let Err(e) = checked {
            report("DETAIL", &json!({"clip":index, "scope":"preview"}), json!({"error":e}));
            failures.borrow_mut().push(e);
        }
    });
    for (level, _) in &levels {
        if !completed.borrow().iter().any(|done| done == level) {
            report("TIMING", &json!({"clip":index, "scope":"preview", "level":level}), json!({"previewOk":false, "completed":false}));
        }
    }
    if let Err(e) = result {
        report("DETAIL", &json!({"clip":index, "scope":"preview"}), json!({"error":e}));
        failures.borrow_mut().push(e);
    }
    if failures.borrow().is_empty() && completed.borrow().len() == levels.len() { Ok(()) }
    else { Err("PREVIEW_DIAGNOSTIC_FAILED".into()) }
}

#[test]
#[ignore = "requires REAL_CLIP_DIR and an existing separate REAL_CLIP_WORK_DIR; private local footage only"]
fn real_clips_preserve_timing() -> Result<()> {
    let source_root = fs::canonicalize(std::env::var_os("REAL_CLIP_DIR").ok_or("REAL_CLIP_DIR_REQUIRED")?).map_err(err)?;
    // Validate both existing roots before any write, including directory creation.
    let work_root = fs::canonicalize(std::env::var_os("REAL_CLIP_WORK_DIR").ok_or("REAL_CLIP_WORK_DIR_REQUIRED")?).map_err(err)?;
    if work_root.starts_with(&source_root) || source_root.starts_with(&work_root) { return Err("SOURCE_AND_WORK_MUST_BE_SEPARATE".into()); }
    let mut clips = vec![];
    for entry in fs::read_dir(&source_root).map_err(err)? {
        let entry = entry.map_err(err)?;
        if entry.file_type().map_err(err)?.is_file() && entry.path().extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("mp4")) {
            clips.push(entry.path());
        }
    }
    clips.sort();
    if clips.is_empty() { return Err("NO_MP4_CLIPS".into()); }
    let stamp = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_err(err)?.as_nanos();
    let run = work_root.join(format!("run-{}-{stamp}", std::process::id()));
    fs::create_dir(&run).map_err(err)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let mut failed = 0;
    for (offset, source) in clips.iter().enumerate() {
        let index = offset + 1;
        let work = run.join(format!("clip-{index}"));
        fs::create_dir(&work).map_err(err)?;
        let before = fs::read(source).map(|b| super::super::tesla_sei::sha256_hex(&b));
        for profile in ["balanced", "aggressive"] {
            let case = json!({"clip":index, "scope":"whole", "level":profile});
            report("PROGRESS", &case, json!({"phase":"start"}));
            let result = whole_clip(&case, source, profile, &work, &cancel);
            report("TIMING", &case, json!({"ok":result.is_ok()}));
            if let Err(e) = result { failed += 1; report("DETAIL", &case, json!({"error":e})); }
        }
        if let Err(e) = previews(index, source, &work, &cancel) {
            failed += 1;
            report("TIMING", &json!({"clip":index, "scope":"preview"}), json!({"previewOk":false}));
            report("DETAIL", &json!({"clip":index, "scope":"preview"}), json!({"error":e}));
        }
        let after = fs::read(source).map(|b| super::super::tesla_sei::sha256_hex(&b));
        let unchanged = matches!((&before, &after), (Ok(a), Ok(b)) if a == b);
        if !unchanged { failed += 1; }
        report("TIMING", &json!({"clip":index}), json!({"sourceUnchanged":unchanged}));
    }
    eprintln!("REAL_SUMMARY {}", json!({"clips":clips.len(), "failedCases":failed}));
    if failed == 0 { Ok(()) } else { Err(format!("{failed} diagnostic cases failed; inspect the private local log")) }
}
