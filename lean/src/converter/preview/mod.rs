//! Measured, first-attempt previews. Source footage is only read.
mod frames;
use super::{planner, process::{BoundedRunner, ProcResult, RunOptions, Runner}, service::{tools::{RealTools, Tools}, work::initial_plan, EncodeRequest}, snapshot::Registry, verifier};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

pub struct PreviewClip {
    pub source: PathBuf,
    pub center_ms: i64,
    pub kind: &'static str,
    pub event_id: String,
    pub when: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LevelResult {
    pub level: String,
    pub profile: String,
    pub before_bytes: u64,
    pub after_bytes: u64,
    pub saved_percent: f64,
    pub device: String,
    pub frame: PathBuf,
    pub zoom: PathBuf,
    /// Pixel coordinates in the full frame, shared by every level and its zoom.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop: Option<frames::Crop>,
    /// Actual source interval, shared by original, encoded and cached results.
    pub window_start_us: i64,
    pub window_end_us: i64,
    pub duration_us: i64,
}

type Result<T> = std::result::Result<T, String>;
/// Inspect/probe the runner's exact source/window/encoder cache key, but never
/// extract or encode a sample on a miss. Busy converters can still return hits.
pub fn cached_preview(clip: &PreviewClip, levels: &[(&str, Value)], work: &Path, cancel: &AtomicBool, progress: &dyn Fn(Value)) -> Result<Option<Vec<LevelResult>>> {
    match run_checked(clip, levels, work, cancel, progress, true) {
        Err(e) if e == "PREVIEW_CACHE_MISS" => Ok(None),
        result => result.map(Some),
    }
}
fn err(e: impl std::fmt::Display) -> String { e.to_string() }
fn words(args: &[&str]) -> Vec<String> { args.iter().map(|s| s.to_string()).collect() }
fn check(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::SeqCst) { Err("CANCELLED".into()) } else { Ok(()) }
}

fn command(program: &str, args: &[String], cancel: &Arc<AtomicBool>) -> Result<ProcResult> {
    check(cancel)?;
    let r = BoundedRunner::host().run(program, args, &RunOptions { cancel: Some(cancel.clone()), ..Default::default() })?;
    check(cancel)?;
    if r.status != Some(0) || r.error.is_some() || r.timed_out || r.output_limit_exceeded {
        return Err(format!("PREVIEW_PROCESS_FAILED: {}", r.error.as_deref().unwrap_or(&r.stderr)));
    }
    Ok(r)
}

fn remove(path: &Path) -> Result<()> {
    if fs::symlink_metadata(path).map_err(err)?.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) }.map_err(err)
}

/// `work` is a dedicated preview cache directory. Called by startup, before any previews run.
pub fn cleanup_all(work: &Path) -> Result<()> { cleanup(work, true) }
fn cleanup(work: &Path, all: bool) -> Result<()> {
    if !work.exists() { return Ok(()); }
    for entry in fs::read_dir(work).map_err(err)? {
        let path = entry.map_err(err)?.path();
        let modified = fs::symlink_metadata(&path).and_then(|m| m.modified()).map_err(err)?;
        if all || SystemTime::now().duration_since(modified).unwrap_or_default() > Duration::from_secs(86_400) { remove(&path)?; }
    }
    Ok(())
}

struct Entry { path: PathBuf, keep: bool }
impl Drop for Entry {
    fn drop(&mut self) { if !self.keep { let _ = fs::remove_dir_all(&self.path); } }
}
struct Finished<'a>(&'a AtomicBool);
impl Drop for Finished<'_> { fn drop(&mut self) { self.0.store(true, Ordering::SeqCst); } }

/// Cancellation is borrowed by the API, while existing process/tools APIs own an Arc.
/// A scoped monitor bridges them and is joined on every return (including errors).
pub fn run_preview(clip: &PreviewClip, levels: &[(&str, Value)], work: &Path, cancel: &AtomicBool, progress: &dyn Fn(Value)) -> Result<Vec<LevelResult>> {
    run_checked(clip, levels, work, cancel, progress, false)
}

fn run_checked(clip: &PreviewClip, levels: &[(&str, Value)], work: &Path, cancel: &AtomicBool, progress: &dyn Fn(Value), cached_only: bool) -> Result<Vec<LevelResult>> {
    check(cancel)?;
    let signal = Arc::new(AtomicBool::new(false));
    let done = AtomicBool::new(false);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            while !done.load(Ordering::SeqCst) {
                if cancel.load(Ordering::SeqCst) { signal.store(true, Ordering::SeqCst); break; }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        let _finished = Finished(&done);
        let result = run(clip, levels, work, &signal, &|e| {
            progress(e);
            if cancel.load(Ordering::SeqCst) { signal.store(true, Ordering::SeqCst); }
        }, cached_only);
        // Existing tools may wrap an aborted probe/read in their own error code.
        if result.is_err() && cancel.load(Ordering::SeqCst) { Err("CANCELLED".into()) } else { result }
    })
}

fn run(clip: &PreviewClip, levels: &[(&str, Value)], work: &Path, cancel: &Arc<AtomicBool>, progress: &dyn Fn(Value), cached_only: bool) -> Result<Vec<LevelResult>> {
    let source = fs::canonicalize(&clip.source).map_err(err)?;
    fs::create_dir_all(work).map_err(err)?;
    let work = fs::canonicalize(work).map_err(err)?;
    if source.starts_with(&work) { return Err("PREVIEW_SOURCE_IN_WORK_DIR".into()); }
    cleanup(&work, false)?;
    let md = fs::metadata(&source).map_err(err)?;
    let modified = md.modified().map_err(err)?;
    let ffmpeg = std::env::var("FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".into());
    let ffprobe = std::env::var("FFPROBE_PATH").unwrap_or_else(|_| "ffprobe".into());
    let tools = RealTools::new(&ffmpeg, &ffprobe, Arc::new(Registry::new(work.clone())));
    let src = source.to_str().ok_or("INVALID_SOURCE_PATH")?;
    let inspected = tools.inspect_video(src, cancel).map_err(err)?;
    check(cancel)?;
    if inspected.codec != "h264" { return Err("PREVIEW_REQUIRES_H264".into()); }
    let timeline = tools.read_timeline(src, cancel).map_err(err)?;
    let duration = (inspected.duration_seconds * 1_000_000.0).round() as i64;
    let event = clip.center_ms.saturating_mul(1000).clamp(0, duration);
    let desired = (event - 3_000_000).clamp(0, (duration - 6_000_000).max(0));
    let keys = frames::probe(&ffprobe, &source, true, cancel)?;
    // Snapping backwards must not drop the event. Near the tail a later keyframe
    // can give a shorter sample (26..31 s), while still obeying the six-second cap.
    let start = keys.times.iter().copied().filter(|t| *t >= 0 && *t <= desired && *t + 6_000_000 >= event).max()
        .or_else(|| keys.times.iter().copied().filter(|t| *t >= 0 && *t >= event - 6_000_000 && *t <= event).min())
        .ok_or("PREVIEW_EVENT_OUTSIDE_WINDOW")?;
    let window = (start, (start + 6_000_000).min(duration));
    if window.1 - window.0 < 2_000_000 { return Err("PREVIEW_EVENT_OUTSIDE_WINDOW".into()); }
    let mut plans = vec![];
    for (_, config) in levels {
        check(cancel)?;
        let codec = config["codec"].as_str().unwrap_or("h265");
        let mut selected = if config["profileId"] == "smallest" { tools.select_cpu_fallback(codec) } else { tools.select(codec) }.map_err(err)?;
        // Nodes do not support windows. Never send them a whole source clip as a preview.
        if selected.remote { selected = tools.select_cpu_fallback(codec).map_err(err)?; }
        let mut tiers = vec![];
        if selected.hardware {
            let zero_copy = super::lead_in::hold_frames(Some(&timeline.lead_in)) == 0;
            for (name, zero) in [("zero-copy", true), ("gpu", false)] {
                if zero && !zero_copy { continue; }
                if let Some(args) = planner::decode_accel_args(&selected.codec, "linux", None, zero, selected.device.as_ref())?.filter(|a| !a.is_empty()) {
                    tiers.push((name.into(), args));
                }
            }
        }
        plans.push(initial_plan(config, md.len(), &inspected, &timeline, selected, tiers).map_err(|e| e.code.unwrap_or_else(|| "PREVIEW_PLAN_FAILED".into()))?);
    }
    // In addition to source/window/config identity, bind actual encoder, device and decode tier.
    let selection: Vec<_> = plans.iter().map(|p| json!([p.selected.to_json(), p.bitrate, p.quality, p.smallest.map(|s| s.maxrate), p.keep_order, p.decode])).collect();
    let key = super::tesla_sei::sha256_hex(json!(["preview-v1", source, md.len(), modified.duration_since(SystemTime::UNIX_EPOCH).map_err(err)?.as_nanos().to_string(), window, levels, selection, std::env::var("CPU_ENCODER_PRESET").ok()]).to_string().as_bytes());
    let path = work.join(key);
    let manifest = path.join("result.json");
    if let Ok(bytes) = fs::read(&manifest) {
        if let Ok(results) = serde_json::from_slice::<Vec<LevelResult>>(&bytes) {
            if results.len() == levels.len() + 1 && results.iter().all(|r| r.crop.is_some() && [&r.frame, &r.zoom].iter().all(|p| p.parent() == Some(path.as_path()) && p.is_file()) && r.frame.with_extension("mp4").is_file()) {
                progress(json!({"phase":"cached"})); check(cancel)?; return Ok(results);
            }
        }
    }
    if cached_only { return Err("PREVIEW_CACHE_MISS".into()); }
    if path.exists() { remove(&path)?; }
    fs::create_dir(&path).map_err(err)?;
    let mut entry = Entry { path, keep: false };
    let before = entry.path.join("orig.mp4");
    progress(json!({"phase":"extracting", "window":window}));
    command(&ffmpeg, &words(&["-nostdin", "-v", "error", "-n", "-ss", &format!("{}us", window.0), "-i", src,
        "-t", &format!("{}us", window.1 - window.0), "-map", "0:v:0", "-c", "copy", "-an", "-sn", "-dn", "-avoid_negative_ts", "make_zero", "-use_editlist", "0", before.to_str().unwrap()]), cancel)?;
    let original = frames::probe(&ffprobe, &before, false, cancel)?;
    let source_frames = frames::probe(&ffprobe, &source, false, cancel)?;
    let expected: Vec<_> = source_frames.times.iter().copied().filter(|t| *t >= window.0 && *t < window.1).map(|t| t - window.0).collect();
    original.matches(&expected, source_frames.width, source_frames.height)?;
    if (original.duration_us - (window.1 - window.0)).abs() > original.frame_duration() { return Err("PREVIEW_BOUNDARY_MISMATCH".into()); }
    // Extracting this stream copy rebases samples/events and describes only this segment's lead-in.
    let segment = tools.read_timeline(before.to_str().unwrap(), cancel).map_err(err)?;
    let frame_index = original.times.iter().position(|t| *t >= (window.1 - window.0) / 2).unwrap_or(original.times.len() - 1);
    let (frame, zoom, crop) = frames::save(&ffmpeg, &before, &original, frame_index, None, cancel)?;
    let before_bytes = fs::metadata(&before).map_err(err)?.len();
    let mut results = vec![LevelResult { level: "orig".into(), profile: "".into(), before_bytes, after_bytes: before_bytes, saved_percent: 0.0, device: "".into(), frame, zoom,
        crop: Some(crop), window_start_us: window.0, window_end_us: window.1, duration_us: window.1 - window.0 }];
    progress(json!({"phase":"level", "result":results[0], "crop":crop}));
    for (i, ((level, _), plan)) in levels.iter().zip(plans).enumerate() {
        check(cancel)?;
        let target = entry.path.join(format!("level-{i}.mp4"));
        let device = if !plan.selected.hardware { "CPU".into() } else { plan.selected.device.as_ref().map(|d| d.name.clone().unwrap_or_else(|| d.id.clone())).unwrap_or_else(|| plan.selected.codec.clone()) };
        let request = EncodeRequest { source: src, target: target.to_str().unwrap(), codec: &plan.codec, encoder: &plan.selected,
            bitrate: plan.bitrate, quality: plan.quality.as_deref(), duration_us: Some(window.1 - window.0), window: Some(window),
            hold_frames: plan.hold_frames, smallest: plan.smallest, keep_order: plan.keep_order, decode: plan.decode.first().map(|t| t.1.as_slice()), lane_id: None };
        let args = request.local_args().map_err(err)?;
        progress(json!({"phase":"encoding", "level":level, "profile":plan.profile_id, "encoder":plan.selected.codec, "device":device,
            "window":window, "durationUs":request.duration_us, "bitrate":plan.bitrate, "maxrate":plan.smallest.and_then(|s| s.maxrate)}));
        command(&ffmpeg, &args, cancel)?; // one attempt, with no size or encoder retries
        tools.write_telemetry(&plan.codec, target.to_str().unwrap(), &segment, cancel).map_err(err)?;
        let output = frames::probe(&ffprobe, &target, false, cancel)?;
        output.matches(&original.times, original.width, original.height)?;
        let registry = Registry::new(entry.path.clone());
        // Size targets deliberately do not gate a preview. All media/telemetry checks remain.
        let verdict = verifier::verify_candidate(&verifier::VerifyOptions {
            source: before.clone(), candidate: target.clone(), codec: if plan.codec == "h265" { super::adapters::Codec::H265 } else { super::adapters::Codec::Av1 },
            profile_id: if plan.smallest.is_some() { "smallest" } else { "custom" }.into(), verify_mode: Some("quick".into()),
            keep_off_target: true, allow_larger: true, trusted_snapshot: false, adopt_candidate: false, decode_accel: vec![],
            source_duration_us: Some((window.1 - window.0) as f64), source_timeline: Some(&segment), ffprobe_path: ffprobe.clone(), ffmpeg_path: ffmpeg.clone(),
            run_ffprobe: &tools.runner, run_full_decode: &tools.runner, registry: &registry, on_decode_accel_fallback: None, cancel: Some(cancel.clone()),
        });
        check(cancel)?;
        if !verdict.ok { return Err(format!("PREVIEW_VERIFY_FAILED: {} {}", verdict.reason.unwrap_or("unknown"), verdict.details)); }
        if let Some(a) = verdict.publication_artifact { remove(Path::new(&a.path).parent().ok_or("INVALID_SNAPSHOT")?)?; }
        let (frame, zoom, _) = frames::save(&ffmpeg, &target, &output, frame_index, Some(crop), cancel)?;
        let after_bytes = fs::metadata(&target).map_err(err)?.len();
        results.push(LevelResult { level: (*level).into(), profile: plan.profile_id, before_bytes, after_bytes,
            saved_percent: 100.0 * (before_bytes as f64 - after_bytes as f64) / before_bytes as f64, device, frame, zoom,
            crop: Some(crop), window_start_us: window.0, window_end_us: window.1, duration_us: window.1 - window.0 });
        progress(json!({"phase":"level", "result":results.last(), "crop":crop}));
    }
    check(cancel)?;
    let after = fs::metadata(&source).map_err(err)?;
    if after.len() != md.len() || after.modified().map_err(err)? != modified { return Err("PREVIEW_SOURCE_CHANGED".into()); }
    fs::write(&manifest, serde_json::to_vec(&results).map_err(err)?).map_err(err)?;
    entry.keep = true;
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::converter::testutil::tempdir;
    use std::{cell::RefCell, fs, process::Command};

    fn fixture(root: &Path, flat: bool) -> PreviewClip {
        fixture_length(root, flat, 30, 20)
    }
    fn fixture_length(root: &Path, flat: bool, seconds: u32, gop: u32) -> PreviewClip {
        let source = root.join("source.mp4");
        let input = format!("{}320x240:rate=10:duration={seconds}", if flat { "color=c=gray:size=" } else { "testsrc2=size=" });
        let r = Command::new("ffmpeg").args(["-v", "error", "-nostdin", "-f", "lavfi", "-i",
            &input, "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-crf", "30", "-g", &gop.to_string(), "-bf", "0"])
            .arg(&source).output().unwrap();
        assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
        PreviewClip { source, center_ms: 15_500, kind: "saved", event_id: "synthetic".into(), when: "2026-01-01T00:00:00Z".into() }
    }
    fn levels() -> Vec<(&'static str, Value)> {
        [("std", "balanced"), ("med", "aggressive"), ("high", "smallest")].into_iter()
            .map(|(l, p)| (l, json!({"codec":"h265", "profileId":p, "keepOffTarget":true}))).collect()
    }
    fn probe(path: &Path) -> Value {
        let r = Command::new("ffprobe").args(["-v", "error", "-select_streams", "v:0", "-count_frames",
            "-show_entries", "stream=width,height,nb_read_frames:format=duration", "-of", "json"]).arg(path).output().unwrap();
        assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
        serde_json::from_slice(&r.stdout).unwrap()
    }

    fn vfr_fixture(root: &Path, rate: u32) -> PreviewClip {
        let source = root.join("vfr.mp4");
        let generated = Command::new("ffmpeg").args(["-v", "error", "-nostdin", "-f", "lavfi", "-i",
            &format!("testsrc2=size=320x240:rate={rate}:duration=12"),
            "-vf", &format!("settb=1/10000,setpts=N*10000/{rate}+20*sin(N*1.7)"),
            "-c:v", "libx264", "-threads", "1", "-preset", "ultrafast", "-crf", "18",
            "-fps_mode", "passthrough", "-enc_time_base", "1/10000",
            "-video_track_timescale", "10000", "-g", &(rate * 2).to_string(), "-bf", "0"])
            .arg(&source).output().unwrap();
        assert!(generated.status.success(), "{}", String::from_utf8_lossy(&generated.stderr));
        let cancel = Arc::new(AtomicBool::new(false));
        let frames = frames::probe("ffprobe", &source, false, &cancel).unwrap();
        assert!(frames.times.windows(3).any(|w| w[2] - w[1] != w[1] - w[0]), "fixture must be VFR");
        PreviewClip { source, center_ms: 7500, kind: "saved", event_id: "synthetic-vfr".into(), when: "2026-01-01T00:00:00Z".into() }
    }

    #[test]
    fn preview_preserves_vfr_at_24_and_36_fps() {
        for rate in [24, 36] {
            let dir = tempdir().unwrap();
            let clip = vfr_fixture(dir.path(), rate);
            let cancel = Arc::new(AtomicBool::new(false));
            let results = run_preview(&clip, &levels(), &dir.path().join("work"), &cancel, &|_| {})
                .unwrap_or_else(|e| panic!("{rate} fps VFR preview: {e}"));
            let original = frames::probe("ffprobe", &results[0].frame.with_extension("mp4"), false, &cancel).unwrap();
            for result in &results[1..] {
                let output = frames::probe("ffprobe", &result.frame.with_extension("mp4"), false, &cancel).unwrap();
                output.matches(&original.times, original.width, original.height).unwrap();
            }
        }
    }

    /// Diagnostic only: records the unchanged whole-clip path's timing and verdict.
    #[test]
    #[ignore = "manual production VFR investigation; no hardware qualification"]
    fn production_vfr_timing_diagnostic() {
        for rate in [24, 36] {
            let dir = tempdir().unwrap();
            let clip = vfr_fixture(dir.path(), rate);
            let cancel = Arc::new(AtomicBool::new(false));
            let tools = RealTools::new("ffmpeg", "ffprobe", Arc::new(Registry::new(dir.path().to_path_buf())));
            let src = clip.source.to_str().unwrap();
            let inspected = tools.inspect_video(src, &cancel).unwrap();
            let timeline = tools.read_timeline(src, &cancel).unwrap();
            let original = frames::probe("ffprobe", &clip.source, false, &cancel).unwrap();
            let header = Command::new("ffprobe").args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,avg_frame_rate,time_base", "-of", "json", src]).output().unwrap();
            eprintln!("fixture {rate}: {}", String::from_utf8_lossy(&header.stdout));
            for profile in ["balanced", "aggressive"] {
                let plan = initial_plan(&json!({"codec":"h265", "profileId":profile, "keepOffTarget":true}), fs::metadata(src).unwrap().len(), &inspected, &timeline,
                    tools.select_cpu_fallback("h265").unwrap(), vec![]).unwrap();
                let target = dir.path().join(format!("{profile}.mp4"));
                let args = EncodeRequest { source:src, target:target.to_str().unwrap(), codec:&plan.codec, encoder:&plan.selected,
                    bitrate:plan.bitrate, quality:plan.quality.as_deref(), duration_us:plan.duration_us, window:None,
                    hold_frames:plan.hold_frames, smallest:plan.smallest, keep_order:plan.keep_order, decode:None, lane_id:None }.local_args().unwrap();
                eprintln!("{rate} {profile} args: {args:?}");
                command("ffmpeg", &args, &cancel).unwrap();
                tools.write_telemetry(&plan.codec, target.to_str().unwrap(), &timeline, &cancel).unwrap();
                let output = frames::probe("ffprobe", &target, false, &cancel).unwrap();
                let off = output.times.iter().zip(&original.times).filter(|(a,b)| a.abs_diff(**b) > 2).count();
                eprintln!("{rate} {profile}: source_frames={}, output_frames={}, timestamps_off_by_more_than_2us={off}; first source={:?}, output={:?}", original.times.len(), output.times.len(), &original.times[..6], &output.times[..6]);
                for mode in ["quick", "full"] {
                    let registry = Registry::new(dir.path().to_path_buf());
                    let verdict = verifier::verify_candidate(&verifier::VerifyOptions { source:clip.source.clone(), candidate:target.clone(), codec:super::super::adapters::Codec::H265,
                        profile_id:profile.into(), verify_mode:Some(mode.into()), keep_off_target:true, allow_larger:false, trusted_snapshot:false,
                        adopt_candidate:false, decode_accel:vec![], source_duration_us:plan.duration_us.map(|d| d as f64), source_timeline:Some(&timeline),
                        ffprobe_path:"ffprobe".into(), ffmpeg_path:"ffmpeg".into(), run_ffprobe:&tools.runner, run_full_decode:&tools.runner,
                        registry:&registry, on_decode_accel_fallback:None, cancel:Some(cancel.clone()) });
                    eprintln!("{rate} {profile} {mode}: {}", verdict.to_json());
                    assert_ne!(verdict.reason, Some("snapshot-failed"), "diagnostic snapshot setup");
                }
            }
        }
    }

    #[test]
    fn preview_measures_each_level() {
        let dir = tempdir().unwrap();
        let clip = fixture(dir.path(), false);
        let original = fs::read(&clip.source).unwrap();
        let events = RefCell::new(vec![]);
        let results = run_preview(&clip, &levels(), &dir.path().join("work"), &AtomicBool::new(false), &|e| events.borrow_mut().push(e)).unwrap();
        assert_eq!(results.iter().map(|r| r.level.as_str()).collect::<Vec<_>>(), ["orig", "std", "med", "high"]);
        assert_eq!((results[0].profile.as_str(), results[0].device.as_str(), results[0].saved_percent), ("", "", 0.0));
        assert_eq!(results[0].before_bytes, results[0].after_bytes);
        for r in &results {
            assert!(r.before_bytes > 0 && r.after_bytes > 0);
            assert_eq!(r.before_bytes, results[0].before_bytes);
            assert_eq!(r.saved_percent, 100.0 * (r.before_bytes as f64 - r.after_bytes as f64) / r.before_bytes as f64);
            let frame = probe(&r.frame);
            assert_eq!((frame["streams"][0]["width"].as_u64(), frame["streams"][0]["height"].as_u64()), (Some(320), Some(240)));
            let zoom = probe(&r.zoom);
            assert_eq!((zoom["streams"][0]["width"].as_u64(), zoom["streams"][0]["height"].as_u64()), (Some(72), Some(54)));
            let video = r.frame.with_extension("mp4");
            assert_eq!(fs::metadata(&video).unwrap().len(), r.after_bytes);
            let p = probe(&video);
            assert_eq!(p["streams"][0]["nb_read_frames"], "60");
            assert!((p["format"]["duration"].as_str().unwrap().parse::<f64>().unwrap() - 6.0).abs() < 0.01);
        }
        let events = events.borrow();
        let encodes: Vec<_> = events.iter().filter(|e| e["phase"] == "encoding").collect();
        assert_eq!(encodes.len(), 3, "exactly one attempt per level");
        for e in encodes { assert_eq!(e["window"], json!([12_000_000, 18_000_000])); assert_eq!(e["durationUs"], 6_000_000); }
        let gray = |file: &Path, filter: &str| {
            let r = Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(file)
                .args(["-vf", filter, "-frames:v", "1", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"]).output().unwrap();
            assert!(r.status.success()); r.stdout
        };
        let expected = gray(&clip.source, "select=eq(n\\,150)"); // 15 s: midpoint after the start snapped to 12 s
        let actual = gray(&results[0].frame, "null");
        assert_eq!(expected.len(), actual.len());
        let error = expected.iter().zip(actual).map(|(a,b)| (*a as f64 - b as f64).abs()).sum::<f64>() / expected.len() as f64;
        assert!(error < 3.0, "the original image must show the source midpoint frame, MAE={error}");
        assert_eq!(fs::read(&clip.source).unwrap(), original, "source remains untouched");
    }

    #[test]
    fn preview_reports_growth_honestly() {
        let dir = tempdir().unwrap();
        let clip = fixture(dir.path(), true);
        let result = run_preview(&clip, &[("custom", json!({"codec":"h265", "profileId":"custom", "bitrateKbps":5000}))],
            &dir.path().join("work"), &AtomicBool::new(false), &|_| {}).unwrap();
        assert!(result[1].after_bytes > result[1].before_bytes, "{result:?}");
        assert!(result[1].saved_percent < 0.0);
    }

    #[test]
    fn preview_tail_window_contains_event() {
        let dir = tempdir().unwrap();
        let mut clip = fixture_length(dir.path(), false, 31, 20);
        clip.center_ms = 30_500;
        let events = RefCell::new(vec![]);
        let results = run_preview(&clip, &levels()[..1], &dir.path().join("work"), &AtomicBool::new(false), &|e| events.borrow_mut().push(e)).unwrap();
        let events = events.borrow();
        let encode = events.iter().find(|e| e["phase"] == "encoding").unwrap();
        assert_eq!(encode["window"], json!([26_000_000, 31_000_000]));
        assert_eq!(encode["durationUs"], 5_000_000);
        for r in &results {
            assert_eq!((r.window_start_us, r.window_end_us, r.duration_us), (26_000_000, 31_000_000, 5_000_000));
            let p = probe(&r.frame.with_extension("mp4"));
            assert_eq!(p["streams"][0]["nb_read_frames"], "50");
            assert_eq!(p["format"]["duration"], "5.000000");
        }
    }

    #[test]
    fn preview_rejects_tail_with_less_than_two_seconds() {
        let dir = tempdir().unwrap();
        let mut clip = fixture_length(dir.path(), false, 31, 300);
        clip.center_ms = 30_500;
        let result = run_preview(&clip, &levels()[..1], &dir.path().join("work"), &AtomicBool::new(false), &|_| {});
        assert_eq!(result.unwrap_err(), "PREVIEW_EVENT_OUTSIDE_WINDOW");
    }

    #[test]
    fn cache_hit_skips_encoding() {
        let dir = tempdir().unwrap();
        let clip = fixture(dir.path(), false);
        let work = dir.path().join("work");
        let events = RefCell::new(vec![]);
        let cancel = AtomicBool::new(false);
        let first = run_preview(&clip, &levels()[..1], &work, &cancel, &|e| events.borrow_mut().push(e)).unwrap();
        assert_eq!(events.borrow().iter().filter(|e| e["phase"] == "encoding").count(), 1);
        events.borrow_mut().clear();
        let second = run_preview(&clip, &levels()[..1], &work, &cancel, &|e| events.borrow_mut().push(e)).unwrap();
        assert_eq!(first, second);
        assert_eq!(events.borrow().iter().filter(|e| e["phase"] == "encoding").count(), 0);
        assert!(events.borrow().iter().any(|e| e["phase"] == "cached"));
    }

    #[test]
    fn preview_crop_survives_cache_and_legacy_entries_are_misses() {
        let dir = tempdir().unwrap();
        let clip = fixture(dir.path(), false);
        let work = dir.path().join("work");
        let cancel = AtomicBool::new(false);
        let events = RefCell::new(vec![]);
        let results = run_preview(&clip, &levels()[..1], &work, &cancel, &|e| events.borrow_mut().push(e)).unwrap();
        let crop = events.borrow().iter().find_map(|e| e.get("crop").cloned()).unwrap();
        for r in &results { assert_eq!(serde_json::to_value(r).unwrap()["crop"], crop); }
        assert_eq!(crop["width"], 72); assert_eq!(crop["height"], 54);
        assert!(crop["x"].as_u64().unwrap() + 72 <= 320);
        assert!(crop["y"].as_u64().unwrap() + 54 <= 240);
        assert_eq!(cached_preview(&clip, &levels()[..1], &work, &cancel, &|_| {}).unwrap(), Some(results.clone()));
        let manifest = results[0].frame.parent().unwrap().join("result.json");
        let mut legacy = serde_json::to_value(&results).unwrap();
        for r in legacy.as_array_mut().unwrap() { r.as_object_mut().unwrap().remove("crop"); }
        assert!(serde_json::from_value::<Vec<LevelResult>>(legacy.clone()).is_ok(), "old manifests remain readable");
        fs::write(manifest, serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert!(cached_preview(&clip, &levels()[..1], &work, &cancel, &|_| {}).unwrap().is_none());
        let rebuilt = run_preview(&clip, &levels()[..1], &work, &cancel, &|_| {}).unwrap();
        for r in rebuilt { assert_eq!(serde_json::to_value(r).unwrap()["crop"], crop); }
    }

    #[test]
    fn preview_cache_lookup_never_extracts_or_encodes_a_sample() {
        let dir = tempdir().unwrap();
        let clip = fixture(dir.path(), false);
        let work = dir.path().join("work");
        let cancel = AtomicBool::new(false);
        let events = RefCell::new(vec![]);
        let progress = |e: Value| events.borrow_mut().push(e);
        assert!(cached_preview(&clip, &levels()[..1], &work, &cancel, &progress).unwrap().is_none());
        assert!(events.borrow().is_empty());
        assert!(fs::read_dir(&work).unwrap().next().is_none());
        let results = run_preview(&clip, &levels()[..1], &work, &cancel, &|_| {}).unwrap();
        assert_eq!(cached_preview(&clip, &levels()[..1], &work, &cancel, &progress).unwrap(), Some(results));
        assert_eq!(*events.borrow(), vec![json!({"phase":"cached"})]);
    }

    #[test]
    fn cancel_stops_and_cleans() {
        let dir = tempdir().unwrap();
        let clip = fixture(dir.path(), false);
        let work = dir.path().join("work");
        let cancel = AtomicBool::new(false);
        let result = run_preview(&clip, &levels(), &work, &cancel, &|e| {
            if e["phase"] == "encoding" { cancel.store(true, Ordering::SeqCst); }
        });
        assert_eq!(result.unwrap_err(), "CANCELLED");
        assert!(work.is_dir() && fs::read_dir(work).unwrap().next().is_none());
    }

    #[test]
    fn cache_invalidates_inputs_and_expires_without_following_links() {
        use std::time::{Duration, SystemTime};
        let dir = tempdir().unwrap();
        let mut clip = fixture(dir.path(), false);
        let work = dir.path().join("work");
        fs::create_dir_all(work.join("expired")).unwrap();
        fs::write(work.join("expired/partial.mp4"), b"old").unwrap();
        fs::File::open(work.join("expired")).unwrap().set_times(fs::FileTimes::new().set_modified(SystemTime::now() - Duration::from_secs(86_401))).unwrap();
        let count = std::cell::Cell::new(0);
        let progress = |e: Value| { if e["phase"] == "encoding" { count.set(count.get() + 1); } };
        let cancel = AtomicBool::new(false);
        let mut level = levels()[..1].to_vec();
        run_preview(&clip, &level, &work, &cancel, &progress).unwrap();
        assert!(!work.join("expired").exists());
        clip.center_ms = 100; // clamp to the beginning
        let head = run_preview(&clip, &level, &work, &cancel, &progress).unwrap();
        assert_eq!(probe(&head[0].frame.with_extension("mp4"))["streams"][0]["nb_read_frames"], "60");
        clip.center_ms = 100_000; // clamp to the end
        run_preview(&clip, &level, &work, &cancel, &progress).unwrap();
        level[0].1["profileId"] = json!("aggressive");
        run_preview(&clip, &level, &work, &cancel, &progress).unwrap();
        let modified = fs::metadata(&clip.source).unwrap().modified().unwrap() + Duration::from_secs(1);
        fs::File::open(&clip.source).unwrap().set_times(fs::FileTimes::new().set_modified(modified)).unwrap();
        run_preview(&clip, &level, &work, &cancel, &progress).unwrap();
        use std::io::Write;
        fs::OpenOptions::new().append(true).open(&clip.source).unwrap().write_all(&[0, 0, 0, 8, b'f', b'r', b'e', b'e']).unwrap();
        fs::File::open(&clip.source).unwrap().set_times(fs::FileTimes::new().set_modified(modified)).unwrap();
        run_preview(&clip, &level, &work, &cancel, &progress).unwrap();
        assert_eq!(count.get(), 6, "changed window, config, mtime, or size must miss the cache");
        std::os::unix::fs::symlink(dir.path(), work.join("external")).unwrap();
        cleanup_all(&work).unwrap();
        assert!(fs::read_dir(work).unwrap().next().is_none());
        assert!(clip.source.exists());
    }
}
