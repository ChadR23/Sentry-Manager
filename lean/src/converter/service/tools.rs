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
    fn read_timeline(&self, source: &str, cancel: &AtomicBool) -> CResult<Timeline>;
    fn write_telemetry(&self, codec: &str, candidate: &str, timeline: &Timeline, cancel: &AtomicBool) -> CResult<()>;
    fn verify(&self, r: &VerifyRequest) -> Verdict;
    fn select(&self, codec: &str) -> CResult<Selected>;
    fn select_cpu_fallback(&self, codec: &str) -> CResult<Selected>;
    /// planner.selectFor(codec, device): a lane's GPU proven with its own arguments
    fn select_for(&self, codec: &str, _device: &super::super::planner::Device) -> CResult<Selected> {
        self.select(codec)
    }
    fn ffmpeg_path(&self) -> &str;
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
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,duration:format=duration", "-of", "json", source].iter().map(|s| s.to_string()).collect()
}

/// createRecoveryInspector(manifest): the facts of the job's active clip.
pub fn inspect_recovery(m: &Manifest, cancel: &AtomicBool) -> CResult<Facts> {
    let item = m.active_item();
    let recovery_from = m.get("recovery").and_then(|r| r.get("fromState")).and_then(Value::as_str);
    let replacing = m.state() == "replacing" || recovery_from == Some("replacing");
    let copying = m.state() == "copying" || recovery_from == Some("copying");
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
        Self::with_planner(ffmpeg, ffprobe, registry, Arc::new(Planner::new(BoundedRunner::default(), "linux", ffmpeg)))
    }
    /// sharing the runtime's planner (its proofs serve the device list too)
    pub fn with_planner(ffmpeg: &str, ffprobe: &str, registry: Arc<Registry>, planner: Arc<Planner<BoundedRunner>>) -> RealTools {
        RealTools { ffmpeg: ffmpeg.into(), ffprobe: ffprobe.into(), registry, planner, runner: BoundedRunner::default() }
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
    fn inspect_video(&self, source: &str, cancel: &Arc<AtomicBool>) -> CResult<Inspected> {
        let run = |timeout: u64| self.runner.run(&self.ffprobe, &probe_args(source), &RunOptions { timeout_ms: Some(timeout), cancel: Some(cancel.clone()), cwd: None }).map_err(|_| CError::code("VIDEO_INSPECTION_FAILED"));
        let first = run(30_000)?;
        if !first.timed_out || cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return parse_video_probe(&first);
        }
        parse_video_probe(&run(120_000)?)
    }
    fn read_timeline(&self, source: &str, cancel: &AtomicBool) -> CResult<Timeline> {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(CError::code("CANCELLED"));
        }
        let bytes = std::fs::read(source)?;
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(CError::code("CANCELLED"));
        }
        timeline::extract(&bytes)
    }
    fn write_telemetry(&self, codec: &str, candidate: &str, timeline: &Timeline, cancel: &AtomicBool) -> CResult<()> {
        adapters::write_telemetry(Path::new(candidate), timeline, codec_of(codec)?, cancel)
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
