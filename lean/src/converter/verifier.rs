//! src/main/converter/verifier.js: whether an encoded candidate may stand in
//! for its original. Every check of the Node verifier, in the same order,
//! with the same reasons and details:
//!
//! stat sizes -> read the candidate (size must match the stat) -> SHA-256 ->
//! private snapshot (all later reads are of the snapshot, re-checked against
//! the digest) -> [verify off: integrity, smaller, size profile] -> the
//! original read whole: timeline and timing must agree (and match a cached
//! timeline) -> ffprobe codec/tag -> [full: complete decode, GPU first then
//! CPU] -> snapshot read -> container timing -> frame counts (probe,
//! decode) -> dimensions -> durations (probe, original) -> VFR proof and
//! frame count tolerance -> exact frame timing for lead-in / gap clips ->
//! one-frame-off length rule -> telemetry inspection -> every source
//! telemetry record mapped -> per-frame fingerprints, gaps and transitions
//! byte-compared -> smaller than the original -> size profile -> read once
//! more -> transfer the snapshot as the publication artifact.

use super::adapters::Codec;
use super::contracts::{self, has_size_target, is_within_profile, js_round, target_output_bytes};
use super::frame_num::undecodable_frames;
use super::mp4w::{self, be32, Tree};
use super::process::{ProcResult, RunOptions, Runner};
use super::snapshot::{Artifact, Registry, Snapshot};
use super::tesla_sei::sha256_hex;
use super::timeline::{extract, map_to_output, MappedSample, OutputSample, Timeline};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const SHORT_CLIP_PROFILE_MAX_US: i64 = 2_000_000;
const MAX_INSPECTOR_DIAGNOSTICS: usize = 8;
const MAX_RATE_MULTIPLE: f64 = 16.0;
const ONE_OFF_SHARE: f64 = 0.75;
const FFPROBE_ENTRIES: &str = "stream=index,codec_type,codec_name,codec_tag_string,width,height,duration,nb_frames,nb_read_packets,avg_frame_rate,r_frame_rate:format=duration";
const INSPECTOR_CODES: [&str; 6] = ["INVALID_MP4", "INVALID_H265", "INVALID_AV1", "INVALID_AV1_TELEMETRY", "UNSUPPORTED_CONTAINER", "UNSUPPORTED_H265"];

pub mod reasons {
    pub const INVALID_INPUT: &str = "invalid-input";
    pub const SOURCE_UNREADABLE: &str = "source-unreadable";
    pub const SOURCE_CHANGED: &str = "source-changed";
    pub const SOURCE_INVALID: &str = "source-invalid";
    pub const SOURCE_TIMELINE_MISMATCH: &str = "source-timeline-mismatch";
    pub const CANDIDATE_UNREADABLE: &str = "candidate-unreadable";
    pub const EMPTY_OUTPUT: &str = "empty-output";
    pub const CANDIDATE_CHANGED: &str = "candidate-changed";
    pub const SNAPSHOT_FAILED: &str = "snapshot-failed";
    pub const SNAPSHOT_CLEANUP_FAILED: &str = "snapshot-cleanup-failed";
    pub const SNAPSHOT_TRANSFER_FAILED: &str = "snapshot-transfer-failed";
    pub const PROBE_FAILED: &str = "probe-failed";
    pub const CODEC_MISMATCH: &str = "codec-mismatch";
    pub const DIMENSION_MISMATCH: &str = "dimension-mismatch";
    pub const DECODE_FAILED: &str = "decode-failed";
    pub const CONTAINER_INVALID: &str = "container-invalid";
    pub const DURATION_MISMATCH: &str = "duration-mismatch";
    pub const FRAME_COUNT_MISMATCH: &str = "frame-count-mismatch";
    pub const TELEMETRY_INVALID: &str = "telemetry-invalid";
    pub const TELEMETRY_MISMATCH: &str = "telemetry-mismatch";
    pub const NOT_SMALLER: &str = "not-smaller";
    pub const PROFILE_SIZE: &str = "profile-size";
}
use reasons as R;

#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    pub ok: bool,
    pub reason: Option<&'static str>,
    pub retryable: bool,
    pub source_bytes: Option<u64>,
    pub output_bytes: Option<u64>,
    pub details: Value,
    pub publication_artifact: Option<Artifact>,
}

impl Verdict {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("ok".into(), json!(self.ok));
        m.insert("reason".into(), json!(self.reason));
        m.insert("retryable".into(), json!(self.retryable));
        m.insert("sourceBytes".into(), json!(self.source_bytes));
        m.insert("outputBytes".into(), json!(self.output_bytes));
        m.insert("details".into(), self.details.clone());
        if let Some(a) = &self.publication_artifact {
            m.insert("publicationArtifact".into(), serde_json::to_value(a).unwrap());
        }
        Value::Object(m)
    }
}

fn failure(reason: &'static str, s: Option<u64>, o: Option<u64>, details: Value) -> Verdict {
    Verdict { ok: false, reason: Some(reason), retryable: reason == R::PROFILE_SIZE, source_bytes: s, output_bytes: o, details, publication_artifact: None }
}

/// The two runners and paths the verifier uses, and everything an
/// operation passes (verifyCandidate options).
pub struct VerifyOptions<'a> {
    pub source: PathBuf,
    pub candidate: PathBuf,
    pub codec: Codec,
    pub profile_id: String,
    pub verify_mode: Option<String>,
    pub keep_off_target: bool,
    pub allow_larger: bool,
    pub trusted_snapshot: bool,
    pub adopt_candidate: bool,
    pub decode_accel: Vec<String>,
    pub source_duration_us: Option<f64>,
    pub source_timeline: Option<&'a Timeline>,
    pub ffprobe_path: String,
    pub ffmpeg_path: String,
    pub run_ffprobe: &'a dyn Runner,
    pub run_full_decode: &'a dyn Runner,
    pub registry: &'a Registry,
    pub on_decode_accel_fallback: Option<&'a (dyn Fn() + Sync)>,
    pub cancel: Option<Arc<AtomicBool>>,
}

struct Expected {
    codec: &'static str,
    tag: &'static str,
}

fn expected_video(c: Codec) -> Expected {
    match c {
        Codec::H265 => Expected { codec: "hevc", tag: "hvc1" },
        Codec::Av1 => Expected { codec: "av1", tag: "av01" },
    }
}

fn canonical_profile_id(id: &str) -> Option<String> {
    if id == contracts::CUSTOM_PROFILE_ID || id == contracts::QUALITY_PROFILE_ID || id == contracts::SMALLEST_PROFILE_ID {
        return Some(id.into());
    }
    let c = match id {
        "high-quality" => "conservative",
        "smaller" => "aggressive",
        other => other,
    };
    contracts::profile(c).map(|_| c.to_string())
}

fn validate_options(o: &VerifyOptions) -> Option<String> {
    if o.source.as_os_str().is_empty() || o.candidate.as_os_str().is_empty() || o.ffprobe_path.is_empty() || o.ffmpeg_path.is_empty() {
        return None;
    }
    if o.decode_accel.len() > 8 || o.decode_accel.iter().any(|a| a.is_empty() || a.len() >= 256) {
        return None;
    }
    if let Some(m) = &o.verify_mode {
        if !contracts::is_valid_verify_mode(m) {
            return None;
        }
    }
    canonical_profile_id(&o.profile_id)
}

// ---- ffprobe / ffmpeg results

fn process_result_error(r: &ProcResult, require_silence: bool) -> Option<Value> {
    let Some(status) = r.status else { return Some(json!({ "kind": "invalid-runner-result" })) };
    if r.timed_out {
        return Some(json!({ "kind": "timeout", "status": status }));
    }
    if r.error.is_some() {
        return Some(json!({ "kind": "runner-error", "status": status }));
    }
    if status != 0 {
        return Some(json!({ "kind": "non-zero-status", "status": status }));
    }
    if !r.stderr.trim().is_empty() {
        return Some(json!({ "kind": "stderr-output", "status": status }));
    }
    if require_silence && !r.stdout.trim().is_empty() {
        return Some(json!({ "kind": "stdout-output", "status": status }));
    }
    None
}

/// String(value) of a JSON number the way JS prints it, for integers.
fn js_text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                Some(u.to_string())
            } else if let Some(i) = n.as_i64() {
                Some(i.to_string())
            } else {
                let f = n.as_f64()?;
                if f.fract() == 0.0 && f.abs() < 1e21 {
                    Some(format!("{}", f as i128))
                } else {
                    Some(format!("{f}"))
                }
            }
        }
        _ => None,
    }
}

fn parse_positive_integer(v: Option<&Value>) -> Option<u64> {
    let t = js_text(v?)?;
    let b = t.as_bytes();
    if b.is_empty() || !(b'1'..=b'9').contains(&b[0]) || !b.iter().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let n: f64 = t.parse().ok()?;
    if n > mp4w::MAX_SAFE as f64 {
        return None;
    }
    Some(n as u64)
}

/// JS Number(string) for the forms ffprobe prints (decimal, exponent, hex).
pub fn js_number(s: &str) -> f64 {
    let t = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (p, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(rest) = t.strip_prefix(p) {
            return u128::from_str_radix(rest, radix).map(|v| v as f64).unwrap_or(f64::NAN);
        }
    }
    if t.bytes().any(|c| !(c.is_ascii_digit() || c == b'.' || c == b'e' || c == b'E' || c == b'+' || c == b'-')) {
        return f64::NAN;
    }
    t.parse().unwrap_or(f64::NAN)
}

fn parse_duration_us(v: Option<&Value>) -> Option<i64> {
    let v = v?;
    let s = match v {
        Value::String(s) => s.clone(),
        Value::Number(_) => js_text(v)?,
        _ => return None,
    };
    if s.trim().is_empty() {
        return None;
    }
    let seconds = match v {
        Value::Number(n) => n.as_f64()?,
        _ => js_number(&s),
    };
    let us = js_round(seconds * 1_000_000.0);
    if !seconds.is_finite() || seconds <= 0.0 || !us.is_finite() || us.abs() > mp4w::MAX_SAFE as f64 || us <= 0.0 {
        return None;
    }
    Some(us as i64)
}

#[derive(Debug, Clone)]
struct Rate {
    num: u128,
    den: u128,
    text: String,
    value: f64,
}

fn parse_rate(v: Option<&Value>) -> Option<Rate> {
    let s = v?.as_str()?;
    if s.len() > 39 {
        return None;
    }
    let (a, b) = s.split_once('/')?;
    let digits = |x: &str| !x.is_empty() && x.len() <= 19 && x.bytes().all(|c| c.is_ascii_digit());
    if !digits(a) || !digits(b) {
        return None;
    }
    let (n, d): (u128, u128) = (a.parse().ok()?, b.parse().ok()?);
    if n == 0 || d == 0 || n > mp4w::MAX_SAFE as u128 || d > mp4w::MAX_SAFE as u128 {
        return None;
    }
    let value = n as f64 / d as f64;
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    Some(Rate { num: n, den: d, text: format!("{n}/{d}"), value })
}

#[derive(Debug, Clone)]
struct Metadata {
    codec: String,
    tag: String,
    width: u64,
    height: u64,
    duration_us: i64,
    frame_count: u64,
    average_rate: Rate,
    real_rate: Rate,
}

fn name_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'.' || c == b'-')
}

fn parse_probe_metadata(stdout: &str) -> Result<Metadata, &'static str> {
    if stdout.len() > 1_000_000 {
        return Err("invalid-metadata");
    }
    let doc: Value = serde_json::from_str(stdout).map_err(|_| "malformed-json")?;
    (|| -> Option<Metadata> {
        let streams = doc.as_object()?.get("streams")?.as_array()?;
        if streams.len() != 1 {
            return None;
        }
        let st = streams[0].as_object()?;
        let index = st.get("index")?;
        if !index.as_f64().is_some_and(|i| i >= 0.0 && i.fract() == 0.0) || st.get("codec_type")?.as_str()? != "video" {
            return None;
        }
        let codec = st.get("codec_name")?.as_str().filter(|s| name_ok(s))?;
        let tag = st.get("codec_tag_string")?.as_str().filter(|s| name_ok(s))?;
        let dv = match st.get("duration") {
            None => doc.get("format").and_then(|f| f.get("duration")),
            Some(d) => Some(d),
        };
        let duration_us = parse_duration_us(dv)?;
        let frame_count = parse_positive_integer(st.get("nb_read_packets"))?;
        if let Some(nb) = st.get("nb_frames") {
            if nb.as_str() != Some("N/A") {
                if parse_positive_integer(Some(nb))? != frame_count {
                    return None;
                }
            }
        }
        let average_rate = parse_rate(st.get("avg_frame_rate"))?;
        let real_rate = parse_rate(st.get("r_frame_rate"))?;
        Some(Metadata {
            codec: codec.to_lowercase(),
            tag: tag.to_lowercase(),
            width: parse_positive_integer(st.get("width"))?,
            height: parse_positive_integer(st.get("height"))?,
            duration_us,
            frame_count,
            average_rate,
            real_rate,
        })
    })()
    .ok_or("invalid-metadata")
}

pub fn ffprobe_args(target: &Path) -> Vec<String> {
    ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", FFPROBE_ENTRIES, "-of", "json"]
        .iter()
        .map(|s| s.to_string())
        .chain([target.to_string_lossy().into_owned()])
        .collect()
}

fn run_opts(o: &VerifyOptions) -> RunOptions {
    RunOptions { cancel: o.cancel.clone(), ..Default::default() }
}

fn probe_target(o: &VerifyOptions, target: &Path, label: &str) -> Result<Metadata, Value> {
    let r = match o.run_ffprobe.run(&o.ffprobe_path, &ffprobe_args(target), &run_opts(o)) {
        Ok(r) => r,
        Err(_) => return Err(json!({ "target": label, "kind": "runner-threw" })),
    };
    if let Some(Value::Object(e)) = process_result_error(&r, false) {
        let mut m = Map::new();
        m.insert("target".into(), json!(label));
        m.extend(e);
        return Err(Value::Object(m));
    }
    parse_probe_metadata(&r.stdout).map_err(|k| json!({ "target": label, "kind": k }))
}

pub fn decode_args(candidate: &Path, accel: &[String]) -> Vec<String> {
    let mut a: Vec<String> = ["-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-err_detect", "explode"].iter().map(|s| s.to_string()).collect();
    a.extend(accel.iter().cloned());
    a.push("-i".into());
    a.push(candidate.to_string_lossy().into_owned());
    a.extend(["-map", "0:v:0", "-an", "-sn", "-dn", "-fps_mode", "passthrough", "-progress", "pipe:1", "-nostats", "-f", "null", "-"].iter().map(|s| s.to_string()));
    a
}

fn decoded_frame_count(stdout: &str) -> Result<u64, &'static str> {
    if stdout.len() > 1_000_000 {
        return Err("stdout-output");
    }
    let mut frames: Option<f64> = None;
    let mut ended = false;
    for line in stdout.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { return Err("stdout-output") };
        if k.is_empty() || !k.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_') || v.contains('\r') {
            return Err("stdout-output");
        }
        if k == "frame" {
            let t = v.trim();
            frames = Some(if !t.is_empty() && t.bytes().all(|c| c.is_ascii_digit()) { t.parse().unwrap_or(f64::NAN) } else { f64::NAN });
        }
        if k == "progress" {
            ended = v == "end";
        }
    }
    match frames {
        Some(f) if ended && f.is_finite() && f > 0.0 && f <= mp4w::MAX_SAFE as f64 => Ok(f as u64),
        _ => Err("incomplete-decode"),
    }
}

fn tolerated(line: &str) -> bool {
    // ^\[null[^\r\n]*\] Application provided invalid, non monotonically increasing dts to muxer in stream 0: \d+ >= \d+$
    let Some(rest) = line.strip_prefix("[null") else { return false };
    let needle = "] Application provided invalid, non monotonically increasing dts to muxer in stream 0: ";
    // the greedy [^\r\n]* backtracks to the last match of the needle
    let Some(at) = rest.rfind(needle) else { return false };
    let tail = &rest[at + needle.len()..];
    let Some((a, b)) = tail.split_once(" >= ") else { return false };
    let d = |x: &str| !x.is_empty() && x.bytes().all(|c| c.is_ascii_digit());
    d(a) && d(b)
}

fn repeated(line: &str) -> bool {
    // ^\s*(?:\[[^\]\r\n]*\]\s*)?Last message repeated \d+ times?\s*$
    let mut t = line.trim_start();
    if t.starts_with('[') {
        if let Some(end) = t.find(']') {
            if !t[1..end].contains(['\r', '\n']) {
                t = t[end + 1..].trim_start();
            }
        }
    }
    let Some(rest) = t.strip_prefix("Last message repeated ") else { return false };
    let digits = rest.bytes().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 {
        return false;
    }
    let after = rest[digits..].trim_end();
    after == " time" || after == " times"
}

/// withoutToleratedStderr
pub fn without_tolerated_stderr(stderr: &str) -> String {
    let mut kept = Vec::new();
    let mut prev = false;
    let lines: Vec<&str> = stderr.split("\r\n").flat_map(|l| l.split(['\n', '\r'])).collect();
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        if repeated(line) {
            if !prev {
                kept.push(line);
            }
            continue;
        }
        prev = tolerated(line);
        if !prev {
            kept.push(line);
        }
    }
    kept.join("\n")
}

fn run_decode_once(o: &VerifyOptions, candidate: &Path, accel: &[String]) -> Result<u64, Value> {
    let r = match o.run_full_decode.run(&o.ffmpeg_path, &decode_args(candidate, accel), &run_opts(o)) {
        Ok(r) => r,
        Err(_) => return Err(json!({ "kind": "runner-threw" })),
    };
    let mut n = r.clone();
    if n.status == Some(0) {
        n.stderr = without_tolerated_stderr(&n.stderr);
    }
    if let Some(e) = process_result_error(&n, false) {
        return Err(e);
    }
    decoded_frame_count(&n.stdout).map_err(|k| json!({ "kind": k }))
}

/// runCompleteDecode: a GPU decode first when offered; any GPU failure is
/// re-checked on the CPU, so only a CPU decode can reject a candidate.
fn run_complete_decode(o: &VerifyOptions, candidate: &Path) -> Result<u64, Value> {
    if !o.decode_accel.is_empty() {
        let gpu = run_decode_once(o, candidate, &o.decode_accel);
        if gpu.is_ok() {
            return gpu;
        }
        if o.cancel.as_ref().is_some_and(|c| c.load(Ordering::SeqCst)) {
            return gpu;
        }
        if let Some(f) = o.on_decode_accel_fallback {
            f();
        }
    }
    run_decode_once(o, candidate, &[])
}

// ---- container timing

fn ticks_to_us(ticks: i128, timescale: u32) -> Option<i64> {
    let d = timescale as i128;
    let s = ticks * 1_000_000;
    let r = if s >= 0 { (s + d / 2) / d } else { -((-s + d / 2) / d) };
    if r.abs() > mp4w::MAX_SAFE as i128 {
        return None;
    }
    Some(r as i64)
}

fn read_track_timescale(tree: &Tree, track: usize) -> Option<u32> {
    let b = tree.find(track, b"mdhd");
    if b.len() != 1 {
        return None;
    }
    let n = tree.node(b[0]);
    let (s, e) = (n.content as usize, n.end as usize);
    if e - s < 4 {
        return None;
    }
    let at = match tree.buf[s] {
        0 => 12,
        1 => 20,
        _ => return None,
    };
    if e - s < at + 4 {
        return None;
    }
    let ts = be32(tree.buf, s + at);
    (ts != 0).then_some(ts)
}

fn read_visual_dimensions(tree: &Tree, track: usize) -> Option<(u16, u16)> {
    let d = tree.find(track, b"stsd");
    if d.len() != 1 {
        return None;
    }
    let p = tree.payload(d[0]).ok()?;
    if p.len() < 16 || be32(p, 0) != 0 || be32(p, 4) != 1 {
        return None;
    }
    let e = &p[8..];
    let ext = be32(e, 0) == 1;
    let h = if ext { 16 } else { 8 };
    if e.len() < h + 78 {
        return None;
    }
    let size = if ext { mp4w::be64(e, 8) } else { be32(e, 0) as u64 };
    if size != e.len() as u64 || !["avc1", "avc3", "hvc1", "hev1", "av01"].contains(&std::str::from_utf8(&e[4..8]).unwrap_or("")) {
        return None;
    }
    let w = mp4w::be16(e, h + 24);
    let hh = mp4w::be16(e, h + 26);
    if w == 0 || hh == 0 {
        return None;
    }
    Some((w, hh))
}

#[derive(Debug, Clone)]
struct Timing {
    width: u16,
    height: u16,
    samples: Vec<(i64, i64)>,
    timescale: u32,
    duration_ticks: Vec<i64>,
    duration_us: i64,
    tolerance_us: i64,
    nonuniform: bool,
    min_us: i64,
    max_us: i64,
}

fn read_output_timing(bytes: &[u8]) -> Option<Timing> {
    let tree = mp4w::parse(bytes).ok()?;
    let (track, _) = mp4w::select_video_track(&tree).ok()?;
    let (width, height) = read_visual_dimensions(&tree, track)?;
    let idx = mp4w::build_sample_index(&tree, track).ok()?;
    if idx.is_empty() {
        return None;
    }
    let timescale = read_track_timescale(&tree, track)?;
    let mut total: i128 = 0;
    let mut ticks = Vec::with_capacity(idx.len());
    let mut samples = Vec::with_capacity(idx.len());
    for (i, s) in idx.iter().enumerate() {
        if s.duration <= 0 && !(i == idx.len() - 1 && s.duration == 0) {
            return None;
        }
        total += s.duration as i128;
        ticks.push(s.duration);
        let pts = ticks_to_us(s.pts, timescale)?;
        let dur = ticks_to_us(s.duration as i128, timescale)?;
        if dur < 0 {
            return None;
        }
        samples.push((pts, dur));
    }
    let duration_us = ticks_to_us(total, timescale)?;
    let pos: Vec<i64> = samples.iter().map(|s| s.1).filter(|&d| d > 0).collect();
    let min = pos.iter().copied().min().unwrap_or(mp4w::MAX_SAFE as i64);
    let max = pos.iter().copied().max().unwrap_or(0);
    if duration_us <= 0 || min <= 0 || max <= 0 {
        return None;
    }
    Some(Timing { width, height, nonuniform: ticks.iter().any(|&d| d != ticks[0]), samples, timescale, duration_ticks: ticks, duration_us, tolerance_us: max, min_us: min, max_us: max })
}

fn prove_vfr(m: &Metadata, t: &Timing) -> Option<Value> {
    let (a, r) = (&m.average_rate, &m.real_rate);
    let differs = a.num * r.den != r.num * a.den;
    if !differs || !t.nonuniform || r.value <= a.value {
        return None;
    }
    if t.max_us as f64 / t.min_us as f64 > MAX_RATE_MULTIPLE {
        return None;
    }
    let at_avg = (t.duration_us as f64 * a.value) / 1_000_000.0;
    if !at_avg.is_finite() || (at_avg - t.samples.len() as f64).abs() > 0.001 {
        return None;
    }
    let grid = t.samples.iter().all(|s| {
        let mult = (s.1 as f64 * r.value) / 1_000_000.0;
        let rounded = js_round(mult);
        rounded >= 1.0 && rounded <= MAX_RATE_MULTIPLE && (mult - rounded).abs() <= 0.001
    });
    if !grid {
        return None;
    }
    Some(json!({
        "frameRateProof": { "output": { "average": a.text, "real": r.text } },
        "sampleTimingProof": { "nonuniform": t.nonuniform, "minDurationUs": t.min_us, "maxDurationUs": t.max_us }
    }))
}

// ---- the original

fn hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// normalizeSourceTimeline's checks on a timeline (ours is typed already).
fn normalize_ok(t: &Timeline) -> bool {
    let n = t.samples.len();
    let mut records = Vec::new();
    for (i, s) in t.samples.iter().enumerate() {
        if s.duration_us < 0 || (s.duration_us == 0 && i != n - 1) || s.sample_index != i {
            return false;
        }
        for r in &s.sei_nals {
            if r.nal.is_empty() || !hex64(&r.fingerprint) {
                return false;
            }
            records.push((i, s.pts_us, r));
        }
        if s.has_telemetry != !s.sei_nals.is_empty() {
            return false;
        }
    }
    if t.events.len() != records.len() {
        return false;
    }
    t.events.iter().zip(records).all(|(e, (i, pts, r))| {
        e.source_sample_index < n && e.source_pts_us == t.samples[e.source_sample_index].pts_us && !e.nal.is_empty() && hex64(&e.fingerprint)
            && e.source_sample_index == i && e.source_pts_us == pts && e.fingerprint == r.fingerprint && e.nal == r.nal
    })
}

fn dropped_of(t: &Timeline) -> Vec<usize> {
    if undecodable_frames(Some(&t.undecodable)) > 0 {
        t.undecodable.samples.clone()
    } else {
        vec![]
    }
}

fn same_timeline(a: &Timeline, b: &Timeline) -> bool {
    if a.samples.len() != b.samples.len() || a.events.len() != b.events.len() || dropped_of(a) != dropped_of(b) {
        return false;
    }
    for (x, y) in a.samples.iter().zip(&b.samples) {
        if x.sample_index != y.sample_index || x.pts_us != y.pts_us || x.duration_us != y.duration_us || x.has_telemetry != y.has_telemetry || x.sei_nals != y.sei_nals {
            return false;
        }
    }
    a.events.iter().zip(&b.events).all(|(x, y)| x.source_sample_index == y.source_sample_index && x.source_pts_us == y.source_pts_us && x.fingerprint == y.fingerprint && x.nal == y.nal)
}

struct SourceAuthority {
    timeline: Timeline,
    timing: Timing,
    lead_in_frames: usize,
    undecodable_frames: usize,
    expected: Vec<(i64, i64)>,
}

fn read_source_authority(o: &VerifyOptions, sb: Option<u64>, ob: Option<u64>) -> Result<SourceAuthority, Verdict> {
    let bytes = std::fs::read(&o.source).map_err(|_| failure(R::SOURCE_UNREADABLE, sb, ob, json!({ "kind": "read-failed" })))?;
    if bytes.is_empty() {
        return Err(failure(R::SOURCE_UNREADABLE, sb, ob, json!({ "kind": "invalid-bytes" })));
    }
    if Some(bytes.len() as u64) != sb {
        return Err(failure(R::SOURCE_CHANGED, sb, ob, json!({ "statBytes": sb, "readBytes": bytes.len() })));
    }
    let invalid = || failure(R::SOURCE_INVALID, sb, ob, json!({ "kind": "sample-timing" }));
    let timeline = extract(&bytes).map_err(|e| failure(R::SOURCE_INVALID, sb, ob,
        json!({"kind":if e.code == "INVALID_H264" {"h264-nal"} else {"h264-container"}, "code":e.code, "check":e.message, "sample":e.path})))?;
    if let Some(s) = timeline.samples.iter().find(|s| s.duration_us < 0 || (s.duration_us == 0 && s.sample_index + 1 < timeline.samples.len())) {
        return Err(failure(R::SOURCE_INVALID, sb, ob, json!({"kind":"nonpositive-sample-duration", "sampleIndex":s.sample_index, "durationUs":s.duration_us})));
    }
    if !normalize_ok(&timeline) {
        return Err(failure(R::SOURCE_INVALID, sb, ob, json!({"kind":"timeline-metadata"})));
    }
    let lead_in_frames = timeline.lead_in.frames.unwrap_or(0);
    let mut timing = read_output_timing(&bytes).ok_or_else(invalid)?;
    if timing.samples.last().is_some_and(|s| s.1 == 0) {
        let last_pts = timing.samples.last().unwrap().0;
        timing.samples.pop();
        timing.duration_us = if last_pts != 0 { last_pts } else { timing.duration_us };
    }
    // trimTerminalZeroDurationSample, then timelineMatchesTiming
    let mut ts: Vec<(i64, i64)> = timeline.samples.iter().map(|s| (s.pts_us, s.duration_us)).collect();
    if ts.last().is_some_and(|s| s.1 == 0) {
        ts.pop();
    }
    if ts != timing.samples {
        return Err(failure(R::SOURCE_INVALID, sb, ob, json!({"kind":"timeline-container-mismatch"})));
    }
    if let Some(cached) = o.source_timeline {
        if !normalize_ok(cached) {
            return Err(failure(R::SOURCE_TIMELINE_MISMATCH, sb, ob, json!({ "kind": "cache-invalid" })));
        }
        if !same_timeline(cached, &timeline) {
            return Err(failure(R::SOURCE_TIMELINE_MISMATCH, sb, ob, json!({ "kind": "cache-mismatch" })));
        }
    }
    let dropped: HashSet<usize> = dropped_of(&timeline).into_iter().collect();
    let mut expected: Vec<(i64, i64)> = Vec::new();
    let mut merged: i128 = 0;
    for (i, s) in timing.samples.iter().enumerate() {
        if !dropped.contains(&i) {
            expected.push(*s);
            merged = timing.duration_ticks[i] as i128;
            continue;
        }
        merged += timing.duration_ticks[i] as i128;
        let d = ticks_to_us(merged, timing.timescale).ok_or_else(invalid)?;
        match expected.last_mut() {
            Some(l) => l.1 = d,
            None => return Err(invalid()),
        }
    }
    Ok(SourceAuthority { undecodable_frames: dropped.len(), timeline, timing, lead_in_frames, expected })
}

fn frame_timing_mismatch(src: &[(i64, i64)], out: &[(i64, i64)]) -> Option<Value> {
    for i in 0..src.len().max(out.len()) {
        let (s, o) = (src.get(i), out.get(i));
        if s.is_none() || o.is_none() || s != o {
            return Some(json!({
                "sampleIndex": i,
                "sourcePtsUs": s.map(|x| x.0), "outputPtsUs": o.map(|x| x.0),
                "sourceDurationUs": s.map(|x| x.1), "outputDurationUs": o.map(|x| x.1)
            }));
        }
    }
    None
}

/// shownTimingMismatch: the first frame, in the order shown, whose time
/// differs from the original's by more than 1 us (rounding between time scales)
fn shown_timing_mismatch(src: &[(i64, i64)], out: &[(i64, i64)]) -> Option<Value> {
    let mut shown: Vec<i64> = out.iter().map(|x| x.0).collect();
    shown.sort_unstable();
    for i in 0..src.len().max(shown.len()) {
        let (s, o) = (src.get(i).map(|x| x.0), shown.get(i).copied());
        if s.is_none() || o.is_none() || (s.unwrap() - o.unwrap()).abs() > 1 {
            return Some(json!({ "shownIndex": i, "sourcePtsUs": s, "outputPtsUs": o }));
        }
    }
    None
}

/// oneFrameOffLength: Sentry USB's rule for an encode one frame off.
fn one_frame_off_length(src: &Timing, out: &Timing) -> Option<Value> {
    let (sf, of) = (src.samples.len() as i64, out.samples.len() as i64);
    if (sf - of).abs() != 1 {
        return None;
    }
    let tol = ((src.duration_us as f64 / sf as f64) * ONE_OFF_SHARE).floor();
    let delta = (src.duration_us - out.duration_us).abs();
    if delta as f64 > tol {
        Some(json!({ "deltaUs": delta, "toleranceUs": tol }))
    } else {
        None
    }
}

// ---- telemetry comparison

#[derive(Clone)]
struct InspectedView {
    marker_count: usize,
    has_marker: bool,
    fingerprints: Vec<String>,
}

fn gap_ranges(lens: &[usize]) -> Vec<[usize; 2]> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, &n) in lens.iter().enumerate() {
        let gap = n == 0;
        if gap && start.is_none() {
            start = Some(i);
        }
        if !gap {
            if let Some(s) = start.take() {
                out.push([s, i - 1]);
            }
        }
    }
    if let Some(s) = start {
        out.push([s, lens.len() - 1]);
    }
    out
}

fn transitions(lens: &[usize]) -> Vec<usize> {
    (1..lens.len()).filter(|&i| (lens[i - 1] > 0) != (lens[i] > 0)).collect()
}

fn compare_telemetry(expected: &[MappedSample], inspected: &[InspectedView]) -> Option<Value> {
    if inspected.len() != expected.len() {
        return Some(json!({ "kind": "sample-count", "expectedSamples": expected.len(), "actualSamples": inspected.len() }));
    }
    for (i, s) in inspected.iter().enumerate() {
        if s.marker_count != 1 || !s.has_marker {
            return Some(json!({ "kind": "picture-markers", "sampleIndex": i, "markerCount": s.marker_count }));
        }
    }
    let el: Vec<usize> = expected.iter().map(|s| s.sei_nals.len()).collect();
    let al: Vec<usize> = inspected.iter().map(|s| s.fingerprints.len()).collect();
    let (eg, ag) = (gap_ranges(&el), gap_ranges(&al));
    if eg != ag {
        return Some(json!({ "kind": "gap-ranges", "expectedGapRanges": eg, "actualGapRanges": ag }));
    }
    let (et, at) = (transitions(&el), transitions(&al));
    if et != at {
        return Some(json!({ "kind": "transitions", "expectedTransitions": et, "actualTransitions": at }));
    }
    for (i, e) in expected.iter().enumerate() {
        let ef: Vec<&String> = e.sei_nals.iter().map(|r| &r.fingerprint).collect();
        let af: Vec<&String> = inspected[i].fingerprints.iter().collect();
        if ef != af {
            return Some(json!({ "kind": "fingerprint-order", "sampleIndex": i, "expectedCount": ef.len(), "actualCount": af.len() }));
        }
    }
    None
}

fn inspector_area(path: &str) -> &'static str {
    let p: String = path.chars().take(32).collect();
    let starts = |w: &str| {
        let rest = p.strip_prefix(w).map(|r| r.strip_prefix('s').unwrap_or(r));
        rest.is_some_and(|r| r.is_empty() || r.starts_with('[') || r.starts_with('.'))
    };
    if starts("track") {
        "tracks"
    } else if starts("sample") {
        "samples"
    } else if p.strip_prefix("telemetry").is_some_and(|r| r.is_empty() || r.starts_with('[') || r.starts_with('.')) {
        "telemetry"
    } else if p.strip_prefix("mdat").is_some_and(|r| r.is_empty() || r.starts_with('[') || r.starts_with('.')) {
        "media"
    } else {
        "unknown"
    }
}

pub fn sanitize_inspector_diagnostics(errors: &[super::h265::ValidationError]) -> Value {
    Value::Array(
        errors
            .iter()
            .take(MAX_INSPECTOR_DIAGNOSTICS)
            .map(|e| json!({ "code": if INSPECTOR_CODES.contains(&e.code.as_str()) { e.code.as_str() } else { "INVALID_OUTPUT" }, "area": inspector_area(&e.path) }))
            .collect(),
    )
}

fn off_target_details(sb: u64, ob: u64, profile_id: &str, target: f64, tol: f64) -> Map<String, Value> {
    let saved = js_round(((sb as f64 - ob as f64) / sb as f64) * 1000.0) / 10.0;
    let target_pct = js_round(contracts::profile(profile_id).unwrap().savings * 100.0);
    let mut m = Map::new();
    m.insert("offTarget".into(), json!(true));
    m.insert("offTargetSavedPercent".into(), json!(saved));
    m.insert("offTargetTargetPercent".into(), json!(target_pct));
    m.insert("targetBytes".into(), json!(target));
    m.insert("toleranceBytes".into(), json!(tol));
    m
}

fn read_exact_snapshot(s: &Snapshot, size: u64, sha: &str, trusted: bool) -> Option<Vec<u8>> {
    let b = s.read().ok()?;
    if b.len() as u64 != size || (!trusted && sha256_hex(&b) != sha) {
        return None;
    }
    Some(b)
}

fn verify_integrity_only(o: &VerifyOptions, profile_id: &str, sb: u64, ob: u64, sha: &str, snap: &Snapshot) -> Verdict {
    let (s, b) = (Some(sb), Some(ob));
    if read_exact_snapshot(snap, ob, sha, o.trusted_snapshot).is_none() {
        return failure(R::SNAPSHOT_FAILED, s, b, json!({ "kind": "integrity-failed" }));
    }
    if ob >= sb && (!o.allow_larger || has_size_target(profile_id)) {
        return failure(R::NOT_SMALLER, s, b, json!({ "savedBytes": sb as i64 - ob as i64 }));
    }
    let mut off = Map::new();
    if has_size_target(profile_id) {
        let short = sb >= 500_000 && o.source_duration_us.is_some_and(|d| d.is_finite() && d <= SHORT_CLIP_PROFILE_MAX_US as f64);
        if !short && !is_within_profile(sb, ob, profile_id) {
            let target = target_output_bytes(sb, profile_id);
            let tol = sb as f64 * contracts::profile(profile_id).unwrap().tolerance;
            if !o.keep_off_target {
                return failure(R::PROFILE_SIZE, s, b, json!({ "profileId": profile_id, "targetBytes": target, "toleranceBytes": tol }));
            }
            off = off_target_details(sb, ob, profile_id, target, tol);
        }
    }
    let ev = expected_video(o.codec);
    let mut d = Map::new();
    d.insert("codec".into(), json!(ev.codec));
    d.insert("tag".into(), json!(ev.tag));
    d.insert("profileId".into(), json!(profile_id));
    d.insert("verifyMode".into(), json!("off"));
    d.extend(off);
    if ob >= sb {
        d.insert("larger".into(), json!(true));
        d.insert("largerBytes".into(), json!(ob - sb));
    }
    Verdict { ok: true, reason: None, retryable: false, source_bytes: s, output_bytes: b, details: Value::Object(d), publication_artifact: None }
}

struct Inspected {
    accepted: bool,
    layout_valid: bool,
    sample_entry: Option<String>,
    sample_count: usize,
    errors: Vec<super::h265::ValidationError>,
    samples: Vec<InspectedView>,
}

fn inspect(codec: Codec, bytes: &[u8]) -> Option<Inspected> {
    match codec {
        Codec::H265 => {
            let i = super::h265::inspect(bytes).ok()?;
            Some(Inspected {
                accepted: i.accepted,
                layout_valid: i.layout_valid,
                sample_entry: Some(i.sample_entry),
                sample_count: i.sample_count,
                errors: i.validation_errors,
                samples: i.samples.into_iter().map(|s| InspectedView { marker_count: s.picture_marker_count, has_marker: s.has_picture_marker, fingerprints: s.telemetry_fingerprints }).collect(),
            })
        }
        Codec::Av1 => {
            let i = super::av1::inspect(bytes);
            Some(Inspected {
                accepted: i.accepted,
                layout_valid: i.layout_valid,
                sample_entry: i.sample_entry,
                sample_count: i.sample_count,
                errors: i.validation_errors,
                samples: i.samples.into_iter().map(|s| InspectedView { marker_count: s.picture_marker_count, has_marker: s.has_picture_marker, fingerprints: s.telemetry_fingerprints }).collect(),
            })
        }
    }
}

fn verify_owned_snapshot(o: &VerifyOptions, profile_id: &str, sb: u64, ob: u64, sha: &str, snap: &Snapshot) -> Verdict {
    let mode = o.verify_mode.clone().unwrap_or_else(|| "full".into());
    if mode == "off" {
        return verify_integrity_only(o, profile_id, sb, ob, sha, snap);
    }
    let (s, b) = (Some(sb), Some(ob));
    let src = match read_source_authority(o, s, b) {
        Ok(x) => x,
        Err(v) => return v,
    };
    let ev = expected_video(o.codec);
    let probe = match probe_target(o, &snap.path, "candidate") {
        Ok(m) => m,
        Err(e) => return failure(R::PROBE_FAILED, s, b, e),
    };
    if probe.codec != ev.codec || probe.tag != ev.tag {
        return failure(R::CODEC_MISMATCH, s, b, json!({ "kind": "unexpected-codec-tag", "expectedCodec": ev.codec, "expectedTag": ev.tag }));
    }
    let decoded = if mode == "full" {
        match run_complete_decode(o, &snap.path) {
            Ok(n) => Some(n),
            Err(e) => return failure(R::DECODE_FAILED, s, b, e),
        }
    } else {
        None
    };
    let Some(bytes) = read_exact_snapshot(snap, ob, sha, o.trusted_snapshot) else {
        return failure(R::SNAPSHOT_FAILED, s, b, json!({ "kind": "integrity-failed" }));
    };
    let Some(out) = read_output_timing(&bytes) else {
        return failure(R::CONTAINER_INVALID, s, b, json!({ "kind": "sample-timing" }));
    };
    let n = out.samples.len();
    if probe.frame_count != n as u64 {
        return failure(R::FRAME_COUNT_MISMATCH, s, b, json!({ "kind": "probe-container", "probeFrames": probe.frame_count, "containerSamples": n }));
    }
    if let Some(d) = decoded {
        if d != n as u64 {
            return failure(R::FRAME_COUNT_MISMATCH, s, b, json!({ "kind": "decode-container", "decodedFrames": d, "containerSamples": n }));
        }
    }
    let st = &src.timing;
    if st.width != out.width || st.height != out.height || probe.width != out.width as u64 || probe.height != out.height as u64 {
        return failure(
            R::DIMENSION_MISMATCH,
            s,
            b,
            json!({
                "source": { "width": st.width, "height": st.height },
                "output": { "width": out.width, "height": out.height },
                "probe": { "width": probe.width, "height": probe.height }
            }),
        );
    }
    if (probe.duration_us - out.duration_us).abs() > out.tolerance_us {
        return failure(R::DURATION_MISMATCH, s, b, json!({ "kind": "probe-container", "probeDurationUs": probe.duration_us, "containerDurationUs": out.duration_us, "toleranceUs": out.tolerance_us }));
    }
    let delta = (st.duration_us - out.duration_us).abs();
    if delta > out.tolerance_us {
        return failure(
            R::DURATION_MISMATCH,
            s,
            b,
            json!({ "kind": "source-output", "sourceDurationUs": st.duration_us, "outputDurationUs": out.duration_us, "deltaUs": delta, "toleranceUs": out.tolerance_us }),
        );
    }
    let vfr = prove_vfr(&probe, &out);
    // A guessed nominal rate is not evidence that a short sample may be
    // rounded away. These clips need every frame and every tiny interval.
    let tiny_samples = st.min_us < 1_000;
    let tol_frames = if vfr.is_some() && !tiny_samples { 1 } else { 0 };
    let frame_delta = (src.expected.len() as i64 - n as i64).abs();
    let undecodable = |m: &mut Map<String, Value>| {
        if src.undecodable_frames > 0 {
            m.insert("undecodableFrames".into(), json!(src.undecodable_frames));
        }
    };
    let frame_rate_proof = vfr.as_ref().map(|v| v["frameRateProof"].clone()).unwrap_or_else(|| json!({ "output": { "average": probe.average_rate.text, "real": probe.real_rate.text } }));
    if frame_delta > tol_frames {
        let mut m = Map::new();
        m.insert("kind".into(), json!("source-output"));
        m.insert("mode".into(), json!(if vfr.is_some() { "vfr" } else { "cfr" }));
        m.insert("sourceFrames".into(), json!(st.samples.len()));
        m.insert("outputFrames".into(), json!(n));
        undecodable(&mut m);
        m.insert("frameDelta".into(), json!(frame_delta));
        m.insert("toleranceFrames".into(), json!(tol_frames));
        m.insert("frameRateProof".into(), frame_rate_proof);
        if let Some(v) = &vfr {
            m.insert("sampleTimingProof".into(), v["sampleTimingProof"].clone());
        }
        return failure(R::FRAME_COUNT_MISMATCH, s, b, Value::Object(m));
    }
    if src.lead_in_frames > 0 || src.undecodable_frames > 0 || tiny_samples {
        if let Some(Value::Object(mm)) = frame_timing_mismatch(&src.expected, &out.samples) {
            let mut m = Map::new();
            m.insert("kind".into(), json!("source-output-frame-timing"));
            m.insert("leadInFrames".into(), json!(src.lead_in_frames));
            undecodable(&mut m);
            m.insert("sourceFrames".into(), json!(st.samples.len()));
            m.insert("outputFrames".into(), json!(n));
            m.extend(mm);
            return failure(R::DURATION_MISMATCH, s, b, Value::Object(m));
        }
    } else if profile_id == contracts::SMALLEST_PROFILE_ID {
        // Smallest (CPU only) is encoded in the original's own time base: with
        // B-frames its frames are stored out of order, but each is shown at
        // exactly its original time
        if let Some(Value::Object(mm)) = shown_timing_mismatch(&src.expected, &out.samples) {
            let mut m = Map::new();
            m.insert("kind".into(), json!("source-output-shown-timing"));
            m.insert("sourceFrames".into(), json!(st.samples.len()));
            m.insert("outputFrames".into(), json!(n));
            m.extend(mm);
            return failure(R::DURATION_MISMATCH, s, b, Value::Object(m));
        }
    }
    if let Some(Value::Object(mm)) = one_frame_off_length(st, &out) {
        let mut m = Map::new();
        m.insert("kind".into(), json!("one-frame-off-length"));
        m.insert("sourceFrames".into(), json!(st.samples.len()));
        m.insert("outputFrames".into(), json!(n));
        undecodable(&mut m);
        m.extend(mm);
        return failure(R::DURATION_MISMATCH, s, b, Value::Object(m));
    }
    let Some(ins) = inspect(o.codec, &bytes) else {
        return failure(R::TELEMETRY_INVALID, s, b, json!({ "kind": "inspector-threw" }));
    };
    if !ins.accepted || !ins.layout_valid || ins.sample_entry.as_deref() != Some(ev.tag) || ins.sample_count != n {
        return failure(
            R::TELEMETRY_INVALID,
            s,
            b,
            json!({ "kind": "inspector-rejected", "validationErrors": sanitize_inspector_diagnostics(&ins.errors), "inspectedSamples": ins.sample_count, "expectedSamples": n }),
        );
    }
    let outputs: Vec<OutputSample> = out.samples.iter().map(|&(p, d)| OutputSample { pts_us: p as f64, duration_us: Some(d as f64) }).collect();
    let Ok(expected) = map_to_output(&src.timeline, &outputs) else {
        return failure(R::TELEMETRY_INVALID, s, b, json!({ "kind": "timeline-mapping" }));
    };
    let mapped: usize = expected.iter().map(|m| m.sei_nals.len()).sum();
    if mapped != src.timeline.events.len() {
        return failure(R::TELEMETRY_MISMATCH, s, b, json!({ "kind": "unmapped-source-events", "sourceEvents": src.timeline.events.len(), "mappedEvents": mapped }));
    }
    if let Some(m) = compare_telemetry(&expected, &ins.samples) {
        return failure(R::TELEMETRY_MISMATCH, s, b, m);
    }
    if ob >= sb && (!o.allow_larger || has_size_target(profile_id)) {
        return failure(R::NOT_SMALLER, s, b, json!({ "savedBytes": sb as i64 - ob as i64 }));
    }
    let custom = !has_size_target(profile_id);
    let target = if custom { None } else { Some(target_output_bytes(sb, profile_id)) };
    let short = sb >= 500_000 && st.duration_us <= SHORT_CLIP_PROFILE_MAX_US && ob < sb;
    let mut off = Map::new();
    if !custom && !short && !is_within_profile(sb, ob, profile_id) {
        let tol = sb as f64 * contracts::profile(profile_id).unwrap().tolerance;
        if !o.keep_off_target {
            return failure(R::PROFILE_SIZE, s, b, json!({ "profileId": profile_id, "targetBytes": target, "toleranceBytes": tol }));
        }
        off = off_target_details(sb, ob, profile_id, target.unwrap(), tol);
    }
    let al: Vec<usize> = ins.samples.iter().map(|s| s.fingerprints.len()).collect();
    let mut d = Map::new();
    d.insert("codec".into(), json!(ev.codec));
    d.insert("tag".into(), json!(ev.tag));
    d.insert("profileId".into(), json!(profile_id));
    d.insert("verifyMode".into(), json!(mode));
    d.insert("targetBytes".into(), json!(target));
    d.insert("sourceDurationUs".into(), json!(st.duration_us));
    d.insert("outputDurationUs".into(), json!(out.duration_us));
    d.insert("durationToleranceUs".into(), json!(out.tolerance_us));
    d.insert("sourceFrames".into(), json!(st.samples.len()));
    d.insert("outputFrames".into(), json!(n));
    d.insert("frameCountMode".into(), json!(if vfr.is_some() { "vfr" } else { "cfr" }));
    d.insert("frameCountTolerance".into(), json!(tol_frames));
    d.insert("frameRateProof".into(), frame_rate_proof);
    if let Some(v) = &vfr {
        d.insert("sampleTimingProof".into(), v["sampleTimingProof"].clone());
    }
    if src.lead_in_frames > 0 {
        d.insert("leadInFrames".into(), json!(src.lead_in_frames));
    }
    undecodable(&mut d);
    if src.lead_in_frames > 0 || src.undecodable_frames > 0 {
        d.insert("frameTiming".into(), json!("exact"));
    }
    d.insert("telemetryEvents".into(), json!(mapped));
    d.insert("telemetryTransitions".into(), json!(transitions(&al)));
    d.insert("telemetryGapRanges".into(), json!(gap_ranges(&al)));
    d.extend(off);
    if ob >= sb {
        d.insert("larger".into(), json!(true));
        d.insert("largerBytes".into(), json!(ob - sb));
    }
    Verdict { ok: true, reason: None, retryable: false, source_bytes: s, output_bytes: b, details: Value::Object(d), publication_artifact: None }
}

fn cleanup_failure(snap: &mut Snapshot, v: Verdict) -> Verdict {
    match snap.cleanup() {
        Ok(()) => v,
        Err(_) => failure(R::SNAPSHOT_CLEANUP_FAILED, v.source_bytes, v.output_bytes, json!({ "kind": "cleanup-failed", "priorReason": v.reason })),
    }
}

fn stat_size(p: &Path) -> Option<u64> {
    let m = std::fs::metadata(p).ok()?;
    if !m.is_file() || m.len() > mp4w::MAX_SAFE {
        return None;
    }
    Some(m.len())
}

/// verifyCandidate(options): the verdict, with the publication artifact (the
/// verified snapshot, transferred) when it is ok.
pub fn verify_candidate(o: &VerifyOptions) -> Verdict {
    let Some(profile_id) = validate_options(o) else {
        return failure(R::INVALID_INPUT, None, None, json!({ "kind": "invalid-options" }));
    };
    let Some(sb) = stat_size(&o.source) else {
        return failure(R::SOURCE_UNREADABLE, None, None, json!({ "kind": "stat-failed" }));
    };
    if sb == 0 {
        return failure(R::SOURCE_UNREADABLE, Some(sb), None, json!({ "kind": "empty-source" }));
    }
    let Some(ob) = stat_size(&o.candidate) else {
        return failure(R::CANDIDATE_UNREADABLE, Some(sb), None, json!({ "kind": "stat-failed" }));
    };
    let (s, b) = (Some(sb), Some(ob));
    if ob == 0 {
        return failure(R::EMPTY_OUTPUT, s, b, json!({ "kind": "empty-file" }));
    }
    let Ok(bytes) = std::fs::read(&o.candidate) else {
        return failure(R::CANDIDATE_UNREADABLE, s, b, json!({ "kind": "read-failed" }));
    };
    if bytes.is_empty() {
        return failure(R::CANDIDATE_UNREADABLE, s, b, json!({ "kind": "invalid-bytes" }));
    }
    if bytes.len() as u64 != ob {
        return failure(R::CANDIDATE_CHANGED, s, b, json!({ "statBytes": ob, "readBytes": bytes.len() }));
    }
    let sha = sha256_hex(&bytes);
    let adopt = if o.adopt_candidate { Some(o.candidate.as_path()) } else { None };
    let mut snap = match o.registry.create(&bytes, &sha, adopt, o.trusted_snapshot) {
        Ok(x) => x,
        Err(_) => return failure(R::SNAPSHOT_FAILED, s, b, json!({ "kind": "create-failed" })),
    };
    drop(bytes);
    // normalizeSnapshotContract: never the candidate's or the original's own path
    let same = |a: &Path, c: &Path| super::owned::resolve(a) == super::owned::resolve(c);
    if same(&snap.path, &o.candidate) || same(&snap.path, &o.source) || snap.size != ob || snap.sha256 != sha {
        return cleanup_failure(&mut snap, failure(R::SNAPSHOT_FAILED, s, b, json!({ "kind": "invalid-contract" })));
    }
    let v = verify_owned_snapshot(o, &profile_id, sb, ob, &sha, &snap);
    if !v.ok {
        return cleanup_failure(&mut snap, v);
    }
    if !o.trusted_snapshot && read_exact_snapshot(&snap, ob, &sha, false).is_none() {
        return cleanup_failure(&mut snap, failure(R::SNAPSHOT_FAILED, s, b, json!({ "kind": "integrity-failed" })));
    }
    if snap.transfer().is_err() {
        return cleanup_failure(&mut snap, failure(R::SNAPSHOT_TRANSFER_FAILED, s, b, json!({ "kind": "transfer-failed" })));
    }
    Verdict {
        publication_artifact: Some(Artifact { path: snap.path.to_string_lossy().into_owned(), token: snap.token.clone(), sha256: sha, size: ob }),
        ..v
    }
}

#[cfg(test)]
#[path = "source_checks_tests.rs"]
mod source_checks_tests;
#[cfg(test)]
#[path = "frame_num_tests.rs"]
mod frame_num_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tolerated_stderr_and_repeats() {
        // test/verifierRepeatedMessage.test.js
        let dts = "[null @ 0x55d] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 512 >= 512";
        assert_eq!(without_tolerated_stderr(&format!("{dts}\n    Last message repeated 3 times\n")), "");
        assert_eq!(without_tolerated_stderr(&format!("{dts}\r\n[null @ 0x55d] Last message repeated 1 time\r\n")), "");
        let other = "[hevc @ 0x1] Error parsing NAL unit";
        assert_eq!(without_tolerated_stderr(&format!("{other}\n    Last message repeated 2 times\n")), format!("{other}\n    Last message repeated 2 times"));
        assert_eq!(without_tolerated_stderr("    Last message repeated 2 times\n"), "    Last message repeated 2 times");
        assert_eq!(without_tolerated_stderr(&format!("{dts}\n{other}\n    Last message repeated 4 times")), format!("{other}\n    Last message repeated 4 times"));
        assert_eq!(without_tolerated_stderr(&format!("{dts} extra")), format!("{dts} extra"));
    }

    #[test]
    fn decode_progress_needs_the_end() {
        assert_eq!(decoded_frame_count("frame=10\nfps=0.0\nprogress=continue\nframe=36\nprogress=end\n"), Ok(36));
        assert_eq!(decoded_frame_count("frame=36\nprogress=continue\n"), Err("incomplete-decode"));
        assert_eq!(decoded_frame_count("frame=0\nprogress=end\n"), Err("incomplete-decode"));
        assert_eq!(decoded_frame_count("hello\n"), Err("stdout-output"));
        assert_eq!(decoded_frame_count("Frame=1\nprogress=end\n"), Err("stdout-output"));
    }

    #[test]
    fn probe_metadata_rules() {
        let ok = r#"{"streams":[{"index":0,"codec_type":"video","codec_name":"hevc","codec_tag_string":"hvc1","width":160,"height":120,"duration":"3.000000","nb_frames":"36","nb_read_packets":"36","avg_frame_rate":"12/1","r_frame_rate":"12/1"}],"format":{"duration":"3.0"}}"#;
        let m = parse_probe_metadata(ok).unwrap();
        assert_eq!((m.frame_count, m.duration_us, m.width), (36, 3_000_000, 160));
        assert_eq!(parse_probe_metadata("nope").unwrap_err(), "malformed-json");
        let conflict = ok.replace("\"nb_frames\":\"36\"", "\"nb_frames\":\"35\"");
        assert_eq!(parse_probe_metadata(&conflict).unwrap_err(), "invalid-metadata");
        let na = ok.replace("\"nb_frames\":\"36\"", "\"nb_frames\":\"N/A\"");
        assert!(parse_probe_metadata(&na).is_ok());
        let no_dur = ok.replace("\"duration\":\"3.000000\",", "");
        assert_eq!(parse_probe_metadata(&no_dur).unwrap().duration_us, 3_000_000);
        let zero_rate = ok.replace("\"12/1\",\"r_frame", "\"0/0\",\"r_frame");
        assert!(parse_probe_metadata(&zero_rate).is_err());
        assert_eq!(js_number(" 1.5 "), 1.5);
        assert!(js_number("1.5s").is_nan());
    }

    #[test]
    fn one_frame_off_rule() {
        let t = |n: usize, dur: i64| Timing { width: 1, height: 1, samples: vec![(0, 1); n], timescale: 1, duration_ticks: vec![], duration_us: dur, tolerance_us: 1, nonuniform: false, min_us: 1, max_us: 1 };
        // 36 frames over 3 s: an average frame is 83 333 us, 3/4 of it 62 499
        assert!(one_frame_off_length(&t(36, 3_000_000), &t(35, 2_940_000)).is_none());
        assert_eq!(one_frame_off_length(&t(36, 3_000_000), &t(35, 2_916_667)).unwrap()["deltaUs"], json!(83_333));
        assert!(one_frame_off_length(&t(36, 3_000_000), &t(34, 1)).is_none(), "two off: the frame count checks decide");
    }

    #[test]
    fn gaps_and_transitions() {
        assert_eq!(gap_ranges(&[0, 0, 1, 1, 0, 1, 0]), vec![[0, 1], [4, 4], [6, 6]]);
        assert_eq!(transitions(&[0, 0, 1, 1, 0, 1, 0]), vec![2, 4, 5, 6]);
        assert_eq!(inspector_area("tracks[0]"), "tracks");
        assert_eq!(inspector_area("telemetry.records[3]"), "telemetry");
        assert_eq!(inspector_area("mdat[0]"), "media");
        assert_eq!(inspector_area("video.sampleDescription"), "unknown");
    }
}
