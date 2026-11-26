//! What the job service runs besides its job store and staging area
//! (runtime.js serviceDeps): ffprobe inspection, the telemetry timeline,
//! the telemetry writers, the verifier, the encoder planner, the network
//! checks and the destination guard. `Tools` is the seam the tests use.

use super::super::error::{CError, CResult};
use super::super::planner::{self, Planner, Selected};
use super::super::process::{BoundedRunner, ProcResult, RunOptions, Runner};
use super::super::recovery::{self, Facts, ReplaceState};
use super::super::snapshot::{Artifact, Registry};
use super::super::timeline::{self, Timeline};
use super::super::verifier::{self, Verdict, VerifyOptions};
use super::super::adapters::{self, Codec};
use super::super::jobstore::states::JobState;
use super::super::jobstore::Manifest;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// inspectVideo's answer (parseVideoProbe)
#[derive(Debug, Clone, PartialEq)]
pub struct Inspected {
    pub codec: String,
    pub duration_seconds: f64,
}

pub struct VerifyRequest<'a> {
    pub source: &'a str,
    pub candidate: &'a str,
    pub codec: &'a str,
    pub profile_id: &'a str,
    pub timeline: &'a Timeline,
    pub source_duration_us: Option<f64>,
    pub verify_mode: &'static str,
    pub keep_off_target: bool,
    pub allow_larger: bool,
    pub cancel: Arc<AtomicBool>,
    /// GPU decode for a Full verify (empty: the CPU)
    pub decode_accel: Vec<String>,
    pub on_decode_accel_fallback: Option<Arc<dyn Fn() + Send + Sync>>,
}

pub trait Tools: Send + Sync {
    fn inspect_video(&self, source: &str, cancel: &Arc<AtomicBool>) -> CResult<Inspected>;
    /// Only after empty encoder output: prove the original has packets but no
    /// playable frames. Unavailable or incomplete proof leaves an output failure.
    fn source_has_no_playable_frames(&self, _source: &str, _cancel: &Arc<AtomicBool>) -> CResult<bool> { Ok(false) }
    fn read_timeline(&self, source: &str, cancel: &AtomicBool) -> CResult<Timeline>;
    fn write_telemetry(&self, codec: &str, candidate: &str, timeline: &Timeline, cancel: &AtomicBool) -> CResult<()>;
    fn verify(&self, r: &VerifyRequest) -> Verdict;
    /// The leftover tidy's proof that `converted` is a whole, good copy of `original`
    /// (leftovers::verify_converted): only reads both. Tools that cannot run the verifier
    /// say so, and the original is kept.
    fn verify_converted(&self, _original: &Path, _converted: &Path, _codec: &str) -> Result<(), String> {
        Err("no verifier here".into())
    }
    fn select(&self, codec: &str) -> CResult<Selected>;
    fn select_cpu_fallback(&self, codec: &str) -> CResult<Selected>;
    /// planner.selectFor(codec, device): a lane's GPU proven with its own arguments
    fn select_for(&self, codec: &str, _device: &super::super::planner::Device) -> CResult<Selected> {
        self.select(codec)
    }
    fn ffmpeg_path(&self) -> &str;
    /// Dimensions for the local GPU memory budget. Missing metadata uses the
    /// conservative UHD estimate; it does not weaken source verification.
    fn video_dimensions(&self, _source:&str, _cancel:&Arc<AtomicBool>)->Option<(u64,u64)> { None }
    /// network.checkPath(target, { allowAncestor })
    fn check_path(&self, target: &str, allow_ancestor: bool) -> bool {
        let mut probe = super::super::owned::resolve(Path::new(target));
        loop {
            match std::fs::metadata(&probe).map(|_| ()).or_else(|e| if e.kind() == std::io::ErrorKind::PermissionDenied { Err(e) } else { Err(e) }) {
                Ok(()) => return true,
                Err(e) => {
                    if e.kind() != std::io::ErrorKind::NotFound || !allow_ancestor {
                        return false;
                    }
                    match probe.parent() {
                        Some(p) if p != probe => probe = p.to_path_buf(),
                        _ => return false,
                    }
                }
            }
        }
    }
    /// createRecoveryInspector
    fn inspect_recovery(&self, m: &Manifest, cancel: &AtomicBool) -> CResult<Facts> {
        inspect_recovery(m, cancel)
    }
    /// readMp4VideoCodec for discovery (mp4Header.js): 'h264' / 'h265' /
    /// 'av1', None for anything else; file system errors are returned so
    /// discovery waits for the share
    fn read_video_codec(&self, source: &str, size: u64, cancel: &AtomicBool) -> std::io::Result<Option<String>> {
        let o = super::super::mp4_header::ReadOptions { size: Some(size), cancel: Some(cancel), ..Default::default() };
        Ok(super::super::mp4_header::read_mp4_video_codec(Path::new(source), &o)?.map(str::to_string))
    }
}

/// server/converterHost.js RETRYABLE (network.isRetryable)
pub const RETRYABLE: [&str; 12] = ["ENOENT", "ENOTCONN", "ENETDOWN", "EHOSTUNREACH", "ECONNRESET", "ETIMEDOUT", "EIO", "EHOSTDOWN", "ESTALE", "EAGAIN", "ECONNABORTED", "ENETUNREACH"];

pub fn is_retryable(code: &str) -> bool {
    RETRYABLE.contains(&code)
}

/// parseVideoProbe
pub fn parse_video_probe(r: &ProcResult) -> CResult<Inspected> {
    let fail = || CError::code("VIDEO_INSPECTION_FAILED");
    if r.status != Some(0) || r.error.is_some() || r.timed_out || r.output_limit_exceeded {
        return Err(fail());
    }
    let parsed: Value = serde_json::from_str(&r.stdout).map_err(|_| fail())?;
    let stream = parsed.get("streams").and_then(Value::as_array).filter(|s| s.len() == 1).map(|s| &s[0]);
    let codec = match stream.and_then(|s| s.get("codec_name")).and_then(Value::as_str) {
        Some("h264") => "h264",
        Some("hevc") => "h265",
        Some("av1") => "av1",
        _ => return Err(fail()),
    };
    // Recorder shutdown stubs can have no duration at all. They are kept,
    // never submitted to an encoder; an unknown/zero frame count is not proof.
    if codec == "h264" && stream.and_then(|s| s.get("nb_frames")).is_some_and(|v| v == "1" || v == 1) {
        return Err(CError::code("SOURCE_TOO_SHORT"));
    }
    // Number(stream.duration || format.duration)
    let pick = |v: Option<&Value>| -> Option<Value> { v.filter(|x| super::super::jobstore::normalize::truthy(x)).cloned() };
    let raw = pick(stream.and_then(|s| s.get("duration"))).or_else(|| pick(parsed.get("format").and_then(|f| f.get("duration"))));
    let duration = match raw {
        Some(Value::String(s)) => verifier::js_number(&s),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        _ => f64::NAN,
    };
    if !duration.is_finite() || duration <= 0.0 {
        return Err(fail());
    }
    Ok(Inspected { codec: codec.into(), duration_seconds: duration })
}

pub fn probe_args(source: &str) -> Vec<String> {
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,duration,nb_frames:format=duration", "-of", "json", source].iter().map(|s| s.to_string()).collect()
}

/// createRecoveryInspector(manifest): the facts of the job's active clip.
pub fn inspect_recovery(m: &Manifest, cancel: &AtomicBool) -> CResult<Facts> {
    let item = m.active_item();
    let recovery_from = super::recorded_from(m);
    let replacing = m.state() == JobState::Replacing || recovery_from == Some(JobState::Replacing);
    let copying = m.state() == JobState::Copying || recovery_from == Some(JobState::Copying);
    // item.ownedPaths || manifest.ownedPaths || {}
    let owned = item.and_then(|i| i.get("ownedPaths")).filter(|v| v.is_object()).or_else(|| m.get("ownedPaths").filter(|v| v.is_object()));
    let path_of = |k: &str| owned.and_then(|o| o.get(k)).and_then(Value::as_str).map(str::to_string);
    let config = m.config();
    let separate_final = if config["outputMode"] == "replace" {
        None
    } else {
        match (config.get("destinationRoot").and_then(Value::as_str), item.and_then(|i| i.str("relativePath"))) {
            (Some(d), Some(rel)) if !d.is_empty() && !rel.is_empty() => {
                let mut p = super::super::owned::resolve(Path::new(d));
                for part in rel.split('/') {
                    p.push(part);
                }
                Some(super::super::owned::resolve(&p).to_string_lossy().to_string())
            }
            _ => None,
        }
    };
    let artifact: Option<Artifact> = item
        .and_then(|i| i.get("publicationArtifact"))
        .filter(|v| v.is_object())
        .or_else(|| m.get("publicationArtifact").filter(|v| v.is_object()))
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    let source = item.and_then(|i| i.str("sourcePath")).map(str::to_string);
    let (rc, ec, dp, rb) = (path_of("replacementCandidate"), path_of("encodedCandidate"), path_of("destinationPartial"), path_of("replacementBackup"));
    if cancel.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(CError::code("CANCELLED"));
    }
    // (no clip: nothing at its paths)
    let src = source.clone().unwrap_or_default();
    let s = ReplaceState {
        replacing: replacing && source.is_some(),
        copying,
        source: &src,
        separate_final: if config["outputMode"] == "replace" { None } else { separate_final.as_deref() },
        replacement_candidate: rc.as_deref(),
        encoded_candidate: ec.as_deref(),
        destination_partial: dp.as_deref(),
        replacement_backup: rb.as_deref(),
        artifact: artifact.as_ref(),
    };
    let mut facts = recovery::inspect(&s, Some(cancel)).map_err(CError::from)?;
    if replacing && source.is_none() {
        // exists(replacing ? owned.replacementCandidate : ...) with no final to check
        facts.candidate_exists = rc.as_deref().is_some_and(|p| std::fs::symlink_metadata(p).is_ok());
        facts.final_exists = false;
        facts.source_exists = false;
        facts.final_valid = false;
    }
    Ok(facts)
}

/// The tools of a real server: ffprobe/ffmpeg as child processes, the
/// round-one telemetry writers and verifier.
pub struct RealTools {
    pub ffmpeg: String,
    pub ffprobe: String,
    pub registry: Arc<Registry>,
    pub planner: Arc<Planner<BoundedRunner>>,
    pub runner: BoundedRunner,
}

impl RealTools {
    pub fn new(ffmpeg: &str, ffprobe: &str, registry: Arc<Registry>) -> RealTools {
        Self::with_planner(ffmpeg, ffprobe, registry, Arc::new(Planner::new(BoundedRunner::host(), "linux", ffmpeg)))
    }
    /// sharing the runtime's planner (its proofs serve the device list too)
    pub fn with_planner(ffmpeg: &str, ffprobe: &str, registry: Arc<Registry>, planner: Arc<Planner<BoundedRunner>>) -> RealTools {
        RealTools { ffmpeg: ffmpeg.into(), ffprobe: ffprobe.into(), registry, planner, runner: BoundedRunner::host() }
    }
}

fn codec_of(c: &str) -> CResult<Codec> {
    match c {
        "h265" => Ok(Codec::H265),
        "av1" => Ok(Codec::Av1),
        _ => Err(CError::code("UNSUPPORTED_CODEC")),
    }
}

impl Tools for RealTools {
    fn source_has_no_playable_frames(&self, source: &str, cancel: &Arc<AtomicBool>) -> CResult<bool> {
        // show_frames forces a full decode and emits an explicit [] for zero
        // frames. A missing nb_read_frames field alone is not a zero count.
        // No interval, packet or frame limit: reaching a bound is inconclusive.
        let args = ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_frames", "-show_entries",
            "frame=media_type:stream=nb_read_packets", "-of", "json", source].map(str::to_string);
        let result = self.runner.run(&self.ffprobe, &args, &RunOptions { timeout_ms: Some(30_000), cancel: Some(cancel.clone()), cwd: None });
        if cancel.load(std::sync::atomic::Ordering::SeqCst) || result.as_ref().is_ok_and(|r| r.aborted) {
            return Err(CError::code("CANCELLED"));
        }
        Ok(result.as_ref().is_ok_and(no_playable_frames))
    }
    fn video_dimensions(&self, source:&str, cancel:&Arc<AtomicBool>)->Option<(u64,u64)> {
        let args=["-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","json",source].map(str::to_string);
        let r=self.runner.run(&self.ffprobe,&args,&RunOptions{timeout_ms:Some(5000),cancel:Some(cancel.clone()),..Default::default()}).ok()?;
        if r.status!=Some(0)||r.timed_out||r.aborted||r.output_limit_exceeded {return None;}
        let v:Value=serde_json::from_str(&r.stdout).ok()?;
        let (w,h)=(v["streams"][0]["width"].as_u64()?,v["streams"][0]["height"].as_u64()?);
        (w>0&&h>0&&w<=32768&&h<=32768).then_some((w,h))
    }
    fn inspect_video(&self, source: &str, cancel: &Arc<AtomicBool>) -> CResult<Inspected> {
        let run = |timeout: u64| self.runner.run(&self.ffprobe, &probe_args(source), &RunOptions { timeout_ms: Some(timeout), cancel: Some(cancel.clone()), cwd: None }).map_err(|_| CError::code("VIDEO_INSPECTION_FAILED"));
        let first = run(30_000)?;
        if cancel.load(std::sync::atomic::Ordering::SeqCst) || first.aborted {
            return Err(CError::code("CANCELLED"));
        }
        let probe = if first.timed_out { run(120_000)? } else { first };
        if cancel.load(std::sync::atomic::Ordering::SeqCst) || probe.aborted {
            return Err(CError::code("CANCELLED"));
        }
        let inspected = parse_video_probe(&probe).or_else(|e| {
            // A failed probe alone proves nothing. Inspect the original bytes
            // before identifying an unfinished source sample table.
            if e.code=="SOURCE_TOO_SHORT" {return Err(e);}
            if let Ok(bytes)=std::fs::read(source) { if let Err(defect)=timeline::extract(&bytes) {
                let classified=source_defect(defect,&bytes); if kept_code(&classified.code).is_some(){return Err(classified);}
            }}
            Err(e)
        })?;
        // A shutdown edit can discard the second of two fully recorded samples.
        // Only suspicious originals pay for a decode: two declared frames, or
        // at most 100 ms (a few frames at the recorder's 24/36 fps).
        if inspected.codec == "h264" && (inspected.duration_seconds <= 0.1 || probe_frame_count(&probe, "nb_frames") == Some(2)) {
            let args = ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "json", source].map(str::to_string);
            let counted = self.runner.run(&self.ffprobe, &args, &RunOptions { timeout_ms: Some(30_000), cancel: Some(cancel.clone()), cwd: None })
                .map_err(|_| CError::code("VIDEO_INSPECTION_FAILED"))?;
            if cancel.load(std::sync::atomic::Ordering::SeqCst) || counted.aborted {
                return Err(CError::code("CANCELLED"));
            }
            // Partial/failed counts, decoder errors and zero/unknown counts
            // cannot justify keeping a source. Normal checks still apply.
            if counted.stderr.trim().is_empty() && probe_frame_count(&counted, "nb_read_frames") == Some(1) {
                return Err(CError::code("SOURCE_TOO_SHORT"));
            }
        }
        Ok(inspected)
    }
    fn read_timeline(&self, source: &str, cancel: &AtomicBool) -> CResult<Timeline> {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(CError::code("CANCELLED"));
        }
        let bytes = std::fs::read(source)?;
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(CError::code("CANCELLED"));
        }
        let timeline=timeline::extract(&bytes).map_err(|e|source_defect(e,&bytes))?;
        if timeline.samples.iter().any(|s|s.duration_us==0 && s.sample_index+1<timeline.samples.len()) {
            return Err(CError::new("SOURCE_DUPLICATE_TIMESTAMP","Two recorded frames share one timestamp."));
        }
        Ok(timeline)
    }
    fn write_telemetry(&self, codec: &str, candidate: &str, timeline: &Timeline, cancel: &AtomicBool) -> CResult<()> {
        adapters::write_telemetry(Path::new(candidate), timeline, codec_of(codec)?, cancel)
    }
    fn verify_converted(&self, original: &Path, converted: &Path, codec: &str) -> Result<(), String> {
        super::super::leftovers::verify_converted(original, converted, codec, &self.ffprobe, &self.ffmpeg, &self.runner, &self.registry, None)
    }
    fn verify(&self, r: &VerifyRequest) -> Verdict {
        let codec = match codec_of(r.codec) {
            Ok(c) => c,
            Err(_) => return Verdict { ok: false, reason: Some("verification-failed"), retryable: false, source_bytes: None, output_bytes: None, details: Value::Null, publication_artifact: None },
        };
        let fallback = r.on_decode_accel_fallback.clone().map(|f| move || f());
        verifier::verify_candidate(&VerifyOptions {
            source: PathBuf::from(r.source),
            candidate: PathBuf::from(r.candidate),
            codec,
            profile_id: r.profile_id.into(),
            verify_mode: Some(r.verify_mode.into()),
            keep_off_target: r.keep_off_target,
            allow_larger: r.allow_larger,
            trusted_snapshot: true,
            adopt_candidate: true,
            decode_accel: r.decode_accel.clone(),
            source_duration_us: r.source_duration_us,
            source_timeline: Some(r.timeline),
            ffprobe_path: self.ffprobe.clone(),
            ffmpeg_path: self.ffmpeg.clone(),
            run_ffprobe: &self.runner,
            run_full_decode: &self.runner,
            registry: &self.registry,
            on_decode_accel_fallback: fallback.as_ref().map(|f| f as &(dyn Fn() + Sync)),
            cancel: Some(r.cancel.clone()),
        })
    }
    fn select(&self, codec: &str) -> CResult<Selected> {
        match self.planner.select(codec, true) {
            Ok(Some(s)) => Ok(s),
            Ok(None) => self.select_cpu_fallback(codec),
            Err(e) => Err(CError::new("ENCODER_UNAVAILABLE", e)),
        }
    }
    fn select_cpu_fallback(&self, codec: &str) -> CResult<Selected> {
        self.planner.select_cpu_fallback(codec).map_err(|e| CError::new("ENCODER_UNAVAILABLE", e))
    }
    fn select_for(&self, codec: &str, device: &super::super::planner::Device) -> CResult<Selected> {
        match self.planner.select_for(codec, device, true) {
            Ok(Some(s)) => Ok(s),
            Ok(None) => self.select_cpu_fallback(codec),
            Err(e) => Err(CError::new("ENCODER_UNAVAILABLE", e)),
        }
    }
    fn ffmpeg_path(&self) -> &str {
        &self.ffmpeg
    }
}

pub fn bitrate_floor(codec: &str) -> i64 {
    planner::bitrate_floor(codec)
}

fn probe_frame_count(r: &ProcResult, field: &str) -> Option<u64> {
    if r.status != Some(0) || r.error.is_some() || r.timed_out || r.aborted || r.output_limit_exceeded { return None; }
    let parsed: Value = serde_json::from_str(&r.stdout).ok()?;
    let streams = parsed.get("streams")?.as_array()?;
    if streams.len() != 1 { return None; }
    let count = streams[0].get(field)?;
    count.as_u64().or_else(|| count.as_str()?.parse().ok())
}

fn no_playable_frames(r: &ProcResult) -> bool {
    if r.signal.is_some() || !r.stderr.trim().is_empty() || !probe_frame_count(r, "nb_read_packets").is_some_and(|n| n > 0) { return false; }
    let Ok(parsed) = serde_json::from_str::<Value>(&r.stdout) else { return false; };
    parsed.get("frames").and_then(Value::as_array).is_some_and(Vec::is_empty)
}

#[cfg(test)]
#[test]
fn shutdown_stub_partial_probe_counts_are_never_proof() {
    let good = ProcResult { status: Some(0), stdout: r#"{"streams":[{"nb_read_frames":"1"}]}"#.into(), ..Default::default() };
    assert_eq!(probe_frame_count(&good, "nb_read_frames"), Some(1));
    for incomplete in [
        ProcResult { timed_out: true, ..good.clone() },
        ProcResult { aborted: true, ..good.clone() },
        ProcResult { output_limit_exceeded: true, ..good.clone() },
        ProcResult { error: Some("PROCESS_START_FAILED".into()), ..good.clone() },
        ProcResult { status: None, ..good.clone() },
    ] { assert_eq!(probe_frame_count(&incomplete, "nb_read_frames"), None); }
}

#[cfg(test)]
#[test]
fn no_playable_stub_requires_a_clean_complete_decode_and_packets() {
    let good = ProcResult { status: Some(0), stdout: r#"{"frames":[],"streams":[{"nb_read_packets":"7"}]}"#.into(), ..Default::default() };
    assert!(no_playable_frames(&good));
    for incomplete in [
        ProcResult { status: Some(1), ..good.clone() },
        ProcResult { status: None, ..good.clone() },
        ProcResult { timed_out: true, ..good.clone() },
        ProcResult { aborted: true, ..good.clone() },
        ProcResult { output_limit_exceeded: true, ..good.clone() },
        ProcResult { error: Some("PROCESS_START_FAILED".into()), ..good.clone() },
        ProcResult { signal: Some("SIGTERM".into()), ..good.clone() },
        ProcResult { stderr: "decoder error".into(), ..good.clone() },
    ] { assert!(!no_playable_frames(&incomplete), "{incomplete:?}"); }
    for body in [
        r#"{"streams":[{"nb_read_packets":"7"}]}"#, // absent count is not zero
        r#"{"frames":[],"streams":[{"nb_read_packets":"0"}]}"#,
        r#"{"frames":[],"streams":[{}]}"#,
        r#"{"frames":[],"streams":[{"nb_read_packets":"N/A"}]}"#,
        r#"{"frames":[],"streams":[{"nb_read_packets":"7"},{"nb_read_packets":"7"}]}"#,
        r#"{"frames":[{"media_type":"video"}],"streams":[{"nb_read_packets":"7"}]}"#,
        r#"{"frames":null,"streams":[{"nb_read_packets":"7"}]}"#,
        "not json",
    ] { assert!(!no_playable_frames(&ProcResult { stdout: body.into(), ..good.clone() }), "{body}"); }
}

/// Only precise defects read from the original qualify. Never classify encoder
/// output or a generic probe/verifier failure as damage to the source.
fn source_defect(e:CError,bytes:&[u8])->CError {
    let code=if e.code=="INVALID_H264" && e.message=="NAL length exceeds sample boundary" && e.path.as_deref().is_some_and(|p|p.starts_with("samples[")) {Some("SOURCE_NAL_BOUNDARY")}
        else if e.code=="INVALID_MP4" && ["Truncated stsz full box","Truncated stsz table"].contains(&e.message.as_str()) && truncated_sample_table(bytes) {Some("SOURCE_UNFINISHED_SAMPLE_TABLE")} else {None};
    match code {Some(code)=>CError{code:code.into(),..e},None=>e}
}
fn truncated_sample_table(bytes:&[u8])->bool {
    use super::super::mp4w;
    let Ok(tree)=mp4w::parse(bytes) else {return false;};
    tree.find(mp4w::ROOT,b"stsz").iter().any(|&id| {
        let Ok(p)=tree.payload(id) else {return false;};
        // A constant-size table needs only the 12-byte header, no entries.
        if p.len()<12 {return true;}
        let size=u32::from_be_bytes(p[4..8].try_into().unwrap());
        let count=u32::from_be_bytes(p[8..12].try_into().unwrap());
        size==0 && (p.len() as u64)<12+u64::from(count)*4
    })
}
pub fn kept_code(code:&str)->Option<&'static str>{match code {
    "SOURCE_NO_PLAYABLE_FRAMES"=>Some("source-no-playable-frames"),
    "SOURCE_DUPLICATE_TIMESTAMP"=>Some("source-duplicate-timestamp"),
    "SOURCE_NAL_BOUNDARY"=>Some("source-nal-boundary"),
    "SOURCE_UNFINISHED_SAMPLE_TABLE"=>Some("source-unfinished-sample-table"),_=>None}}
pub fn is_kept(code:&str)->bool{["too-short","source-no-playable-frames","source-duplicate-timestamp","source-nal-boundary","source-unfinished-sample-table"].contains(&code)}
