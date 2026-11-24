//! src/main/converter/encoderPlanner.js: the ffmpeg arguments of an encode
//! (GPU and CPU encoders, constant quality or bitrate, lead-in hold, device
//! choice), GPU decode arguments, the probe that proves an encoder works,
//! the planner that picks one (VAAPI / QSV / NVENC / AMF, then the CPU), and
//! the bitrate rules.

use super::process::{RunOptions, Runner};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

pub const SAFE_FLOOR_H265: i64 = 250_000;
pub const SAFE_FLOOR_AV1: i64 = 200_000;
pub const DEFAULT_PROBE_BITRATE: f64 = 500_000.0;
pub const DEFAULT_PROBE_TIMEOUT_MS: u64 = 10_000;
pub const CPU_PROBE_TIMEOUT_MS: u64 = 45_000;

pub fn hardware_candidates(family: &str, platform: &str) -> &'static [&'static str] {
    match (family, platform) {
        ("h265", "win32") => &["hevc_nvenc", "hevc_qsv", "hevc_amf"],
        ("h265", "darwin") => &["hevc_videotoolbox"],
        ("h265", "linux") => &["hevc_nvenc", "hevc_qsv", "hevc_amf", "hevc_vaapi"],
        ("av1", "win32") => &["av1_nvenc", "av1_qsv", "av1_amf"],
        ("av1", "darwin") => &["av1_videotoolbox"],
        ("av1", "linux") => &["av1_nvenc", "av1_qsv", "av1_amf", "av1_vaapi"],
        _ => &[],
    }
}

pub fn cpu_candidates(family: &str) -> &'static [&'static str] {
    match family {
        "h265" => &["libx265"],
        "av1" => &["libsvtav1", "libaom-av1"],
        _ => &[],
    }
}

fn require_family(codec: &str) -> Result<(), String> {
    if codec == "h265" || codec == "av1" {
        Ok(())
    } else {
        Err(format!("Unsupported encoder family: {codec}"))
    }
}

pub fn bitrate_floor(codec: &str) -> i64 {
    if codec == "av1" {
        SAFE_FLOOR_AV1
    } else {
        SAFE_FLOOR_H265
    }
}

pub fn encoder_belongs_to_family(codec: &str, encoder: &str) -> bool {
    cpu_candidates(codec).contains(&encoder) || ["win32", "darwin", "linux"].iter().any(|p| hardware_candidates(codec, p).contains(&encoder))
}

/// cpuPresetFrom(CPU_ENCODER_PRESET): (x265 preset, svt-av1 preset, aom cpu-used)
pub fn cpu_preset(value: Option<&str>) -> (&'static str, &'static str, &'static str) {
    match value.unwrap_or("").trim().to_lowercase().as_str() {
        "fast" => ("fast", "9", "7"),
        "faster" => ("faster", "10", "8"),
        _ => ("medium", "8", "6"),
    }
}

fn quality_value(table: &str, level: &str) -> &'static str {
    let i = match level {
        "high" => 0,
        "balanced" => 1,
        _ => 2,
    };
    match table {
        "hw51" => ["24", "28", "32"][i],
        "hw255" => ["96", "112", "128"][i],
        "videotoolbox" => ["65", "55", "45"][i],
        "x265" => ["22", "26", "30"][i],
        _ => ["30", "36", "42"][i],
    }
}

fn v(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

pub fn quality_rate_args(codec: &str, encoder: &str, level: &str) -> Result<Vec<String>, String> {
    if !["high", "balanced", "small"].contains(&level) {
        return Err(format!("Unknown quality level: {level}"));
    }
    let p = |t| quality_value(t, level);
    Ok(if encoder.ends_with("_nvenc") {
        v(&["-rc", "vbr", "-cq", p("hw51"), "-b:v", "0"])
    } else if encoder.ends_with("_qsv") {
        v(&["-global_quality", p("hw51")])
    } else if encoder.ends_with("_amf") {
        let qp = if codec == "av1" { p("hw255") } else { p("hw51") };
        v(&["-rc", "cqp", "-qp_i", qp, "-qp_p", qp])
    } else if encoder.ends_with("_vaapi") {
        if codec == "av1" {
            v(&["-rc_mode", "CQP", "-global_quality", p("hw255")])
        } else {
            v(&["-rc_mode", "CQP", "-qp", p("hw51")])
        }
    } else if encoder.ends_with("_videotoolbox") {
        v(&["-q:v", p("videotoolbox")])
    } else if encoder == "libx265" {
        v(&["-crf", p("x265")])
    } else if encoder == "libaom-av1" {
        v(&["-crf", p("av1crf"), "-b:v", "0"])
    } else {
        v(&["-crf", p("av1crf")])
    })
}

fn js_round(x: f64) -> i64 {
    super::contracts::js_round(x) as i64
}

pub fn bitrate_args(encoder: &str, bitrate: f64) -> Vec<String> {
    let r = js_round(bitrate);
    if encoder == "hevc_nvenc" {
        return vec!["-rc".into(), "vbr".into(), "-b:v".into(), r.to_string(), "-maxrate".into(), r.to_string(), "-bufsize".into(), (2 * r).to_string()];
    }
    vec!["-b:v".into(), r.to_string()]
}

/// An encoding device (encodeDevices.js), as far as the planner needs it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Device {
    pub id: String,
    pub kind: String,
    pub vendor: Option<String>,
    pub node: Option<String>,
    pub index: Option<i64>,
    pub name: Option<String>,
    /// a node's own encoders per family
    pub encoders: HashMap<String, String>,
}

fn device_node(d: &Device) -> Result<String, String> {
    match &d.node {
        Some(n) if !n.is_empty() => Ok(n.clone()),
        _ => Err("device.node must be a non-empty path".into()),
    }
}

fn device_index(d: &Device) -> Result<String, String> {
    match d.index {
        Some(i) if i >= 0 => Ok(i.to_string()),
        _ => Err("device.index must be a non-negative integer".into()),
    }
}

/// above any CPU number a kernel gives (Node and Rust then count the same)
const CPU_ID_LIMIT: u64 = 1 << 22;

/// String.prototype.trim
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// "0-3,8,10-11" -> 7; 0 when it is not a CPU list (cpuListCount)
pub fn cpu_list_count(list: &str) -> usize {
    let num = |t: &str| if !t.is_empty() && t.bytes().all(|c| c.is_ascii_digit()) { Some(t.parse::<u64>().unwrap_or(u64::MAX)) } else { None };
    let mut n = 0u64;
    for part in list.split(',') {
        let part = js_trim(part);
        let (lo, hi) = match part.split_once('-') {
            Some((a, b)) => match (num(a), num(b)) {
                (Some(a), Some(b)) => (a, b),
                _ => return 0,
            },
            None => match num(part) {
                Some(a) => (a, a),
                None => return 0,
            },
        };
        if hi < lo || hi >= CPU_ID_LIMIT {
            return 0;
        }
        n += hi - lo + 1;
    }
    n as usize
}

/// This process's path in one cgroup hierarchy (/proc/self/cgroup lines are
/// "id:controllers:path"), "" when it is not listed (cgroupPath)
fn cgroup_path<'a>(file: &'a str, wanted: impl Fn(&str, &str) -> bool) -> &'a str {
    for raw in file.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        let Some(a) = line.find(':') else { continue };
        let Some(b) = line[a + 1..].find(':').map(|i| a + 1 + i) else { continue };
        let path = &line[b + 1..];
        if path.starts_with('/') && wanted(&line[..a], &line[a + 1..b]) {
            return path;
        }
    }
    ""
}

/// root, then each folder down to this process's cgroup under it (cgroupDirs)
fn cgroup_dirs(root: &str, path: &str) -> Vec<String> {
    let mut dirs = vec![root.to_string()];
    let mut dir = root.to_string();
    for part in path.split('/').filter(|p| !p.is_empty()) {
        dir = format!("{dir}/{part}");
        dirs.push(dir.clone());
    }
    dirs
}

/// The smallest CPU limit (compose cpus: 2.5 -> 2.5) of this process's cgroup
/// and every cgroup above it that it can see, or None: cgroup v2 cpu.max, v1
/// cfs quota (cgroupCpuLimit; work_limits::cgroup_cpus reads only this one and the root)
pub fn cgroup_cpu_limit(read: &dyn Fn(&str) -> String) -> Option<f64> {
    use crate::viewer::js::number_str;
    let file = read("/proc/self/cgroup");
    let mut found = Vec::new();
    for d in cgroup_dirs("/sys/fs/cgroup", cgroup_path(&file, |id, controllers| id == "0" && controllers.is_empty())) {
        let v = read(&format!("{d}/cpu.max"));
        let mut parts = js_trim(&v).split_whitespace();
        let (q, p) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        if !q.is_empty() && q != "max" && number_str(q) > 0.0 && number_str(p) > 0.0 {
            found.push(number_str(q) / number_str(p));
        }
    }
    let v1 = cgroup_path(&file, |id, controllers| id != "0" && controllers.split(',').any(|c| c == "cpu"));
    for root in ["/sys/fs/cgroup/cpu", "/sys/fs/cgroup/cpu,cpuacct"] {
        for d in cgroup_dirs(root, v1) {
            let num = |f: &str| {
                let v = read(&format!("{d}/{f}"));
                let v = js_trim(&v);
                if v.is_empty() { f64::NAN } else { number_str(v) }
            };
            let (q, p) = (num("cpu.cfs_quota_us"), num("cpu.cfs_period_us"));
            if q > 0.0 && p > 0.0 {
                found.push(q / p);
            }
        }
    }
    found.into_iter().filter(|n| n.is_finite() && *n < 9_007_199_254_740_992.0).reduce(f64::min)
}

/// Cpus_allowed_list in /proc/self/status: the CPUs this process may run on (allowedCpus)
fn allowed_cpus(status: &str) -> usize {
    for line in status.split('\n') {
        let Some(list) = line.strip_prefix("Cpus_allowed_list:") else { continue };
        let list = js_trim(list);
        return if !list.is_empty() && !list.contains(char::is_whitespace) { cpu_list_count(list) } else { 0 };
    }
    0
}

/// The CPUs this process may use: its CPU affinity (a cpuset) and its
/// cgroup CPU limit rounded up, whichever is smaller; 0 when unknown (usableCpus)
pub fn usable_cpus(read: &dyn Fn(&str) -> String) -> usize {
    let allowed = allowed_cpus(&read("/proc/self/status"));
    match cgroup_cpu_limit(read) {
        None => allowed,
        Some(limit) => {
            let capped = (limit.ceil() as usize).max(1);
            if allowed > 0 { allowed.min(capped) } else { capped }
        }
    }
}

fn read_trimmed(p: &str) -> String {
    std::fs::read_to_string(p).map(|s| s.trim().to_string()).unwrap_or_default()
}

/// libx265 sizes its thread pool with libnuma (defaultX265Pools). Docker's
/// default seccomp profile blocks the calls libnuma makes (unless the
/// container has SYS_NICE), so x265 finds no CPUs and encodes without a pool,
/// about 3x slower. On Linux the pool is given: one thread per CPU this
/// process may use. 0: x265's own choice.
pub fn default_x265_pools(platform: &str, cpus: usize) -> usize {
    if platform == "linux" { cpus } else { 0 }
}

/// The Smallest (CPU only) profile: libx265 veryfast at CRF 27 with B-frames,
/// peaks capped at maxrate bit/s (None: no cap)
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Smallest {
    pub maxrate: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct EncodeArgs<'a> {
    pub codec: &'a str,
    pub encoder: &'a str,
    pub bitrate: Option<f64>,
    pub quality: Option<&'a str>,
    pub vaapi_device: Option<&'a str>,
    pub hw_frames: bool,
    pub device: Option<&'a Device>,
    pub hold_frames: i64,
    pub cpu_preset: Option<&'a str>,
    /// Smallest (CPU only): CRF 27, or a retry's bitrate under the original's
    pub smallest: Option<Smallest>,
    /// a clip given back the original's own timing (lead-in frames or
    /// samples no decoder outputs) is encoded without reordering
    pub keep_order: bool,
    /// libx265's thread pool size (None: this machine's, default_x265_pools)
    pub x265_pools: Option<usize>,
}

/// buildEncodeArgs (cpuPreset defaults to CPU_ENCODER_PRESET, as in Node)
pub fn build_encode_args(a: &EncodeArgs) -> Result<Vec<String>, String> {
    let from_env = std::env::var("CPU_ENCODER_PRESET").ok();
    let (x265, svt, aom) = cpu_preset(a.cpu_preset.or(from_env.as_deref()));
    require_family(a.codec)?;
    if let Some(s) = a.smallest {
        if a.codec != "h265" || a.encoder != "libx265" || a.quality.is_some() {
            return Err("Smallest (CPU only) is libx265 without a quality level".into());
        }
        if s.maxrate.is_some_and(|m| m == 0 || m > 9_007_199_254_740_991) {
            return Err("maxrate must be a positive safe integer or null".into());
        }
        if a.bitrate.is_some_and(|b| !(b.is_finite() && b > 0.0)) {
            return Err("bitrate must be a positive finite number".into());
        }
    } else if a.quality.is_none() && !a.bitrate.is_some_and(|b| b.is_finite() && b > 0.0) {
        return Err("bitrate must be a positive finite number".into());
    }
    if !encoder_belongs_to_family(a.codec, a.encoder) {
        return Err(format!("Encoder {} is not a {} candidate", a.encoder, a.codec));
    }
    if a.hold_frames < 0 {
        return Err("holdFrames must be a non-negative integer".into());
    }
    if a.hold_frames > 0 && a.hw_frames {
        return Err("Held lead-in frames need system-memory frames".into());
    }
    let hold: Vec<String> = if a.hold_frames > 0 { vec![format!("tpad=start={}:start_mode=clone", a.hold_frames)] } else { vec![] };
    let mut args: Vec<String> = Vec::new();
    let enc = a.encoder;
    if enc.ends_with("_vaapi") && !a.hw_frames {
        let node = match a.device {
            Some(d) => device_node(d)?,
            None => a.vaapi_device.unwrap_or("/dev/dri/renderD128").to_string(),
        };
        if node.is_empty() {
            return Err("vaapiDevice must be a non-empty path".into());
        }
        let mut chain = hold.clone();
        chain.push("format=nv12,hwupload".into());
        args.extend(["-vaapi_device".into(), node, "-vf".into(), chain.join(",")]);
    } else if !hold.is_empty() {
        args.extend(["-vf".into(), hold.join(",")]);
    }
    if let Some(d) = a.device {
        if enc.ends_with("_qsv") {
            args.extend(["-init_hw_device".into(), format!("qsv=qsvenc:hw_any,child_device={}", device_node(d)?)]);
        }
    }
    args.extend(["-c:v".into(), enc.into()]);
    if let Some(d) = a.device {
        if enc.ends_with("_nvenc") {
            args.extend(["-gpu".into(), device_index(d)?]);
        }
    }
    match (a.smallest, a.quality, a.bitrate) {
        (Some(s), _, None) => {
            args.extend(v(&["-crf", "27"]));
            if let Some(m) = s.maxrate {
                args.extend(["-maxrate".into(), m.to_string(), "-bufsize".into(), (2 * m).to_string()]);
            }
        }
        (Some(_), _, Some(b)) => args.extend(bitrate_args(enc, b)),
        (None, Some(q), _) => args.extend(quality_rate_args(a.codec, enc, q)?),
        (None, None, b) => args.extend(bitrate_args(enc, b.unwrap())),
    }
    if a.hw_frames {
    } else if enc.ends_with("_qsv") {
        args.extend(v(&["-pix_fmt", "nv12"]));
    } else if !enc.ends_with("_vaapi") {
        args.extend(v(&["-pix_fmt", "yuv420p"]));
    }
    if enc.ends_with("_amf") && a.quality.is_none() {
        args.extend(v(&["-rc", "vbr_peak"]));
    }
    args.extend(v(&["-force_key_frames", "expr:gte(t,n_forced*2)"]));
    if enc.ends_with("_nvenc") {
        args.extend(v(&["-forced-idr", "1"]));
    }
    if enc.ends_with("_qsv") {
        args.extend(v(&["-forced_idr", "1"]));
    }
    if enc == "libsvtav1" {
        args.extend(v(&["-svtav1-params", "keyint=2s"]));
    }
    if enc == "libx265" {
        args.extend(["-preset".into(), (if a.smallest.is_some() { "veryfast" } else { x265 }).into()]);
        let pools = a.x265_pools.unwrap_or_else(|| default_x265_pools(std::env::consts::OS, usable_cpus(&read_trimmed)));
        if pools > 0 {
            args.extend(["-x265-params".into(), format!("pools={pools}")]);
        }
    }
    if enc == "libsvtav1" {
        args.extend(["-preset".into(), svt.into()]);
    }
    if enc == "libaom-av1" {
        args.extend(["-cpu-used".into(), aom.into(), "-row-mt".into(), "1".into()]);
    }
    // B-frames only for Smallest (CPU only): shown at the original's own times
    // (its time base), with composition offsets that may be negative (ctts
    // version 1) and no edit list
    let reorder = a.smallest.is_some() && !a.keep_order;
    if a.codec == "h265" && !reorder {
        args.extend(v(&["-bf", "0"]));
    }
    args.extend(["-tag:v".into(), (if a.codec == "h265" { "hvc1" } else { "av01" }).into()]);
    // Keep source presentation times for every encoder, including VFR clips.
    args.extend(v(&["-fps_mode", "passthrough", "-enc_time_base", "demux"]));
    args.extend(v(&["-start_at_zero"]));
    if !reorder {
        args.extend(v(&["-avoid_negative_ts", "make_zero"]));
    }
    args.extend(v(&["-use_editlist", "0"]));
    if reorder {
        args.extend(v(&["-movflags", "+negative_cts_offsets"]));
    }
    Ok(args)
}

/// decodeAccelArgs(encoder, { platform, vaapiDevice, zeroCopy, device })
pub fn decode_accel_args(encoder: &str, platform: &str, vaapi_device: Option<&str>, zero_copy: bool, device: Option<&Device>) -> Result<Option<Vec<String>>, String> {
    let cuda = || -> Result<Vec<String>, String> { Ok(match device { Some(d) => vec!["-hwaccel_device".into(), device_index(d)?], None => vec![] }) };
    let vaapi = || -> Result<Vec<String>, String> {
        let node = match device { Some(d) => device_node(d)?, None => vaapi_device.unwrap_or("/dev/dri/renderD128").to_string() };
        Ok(vec!["-hwaccel".into(), "vaapi".into(), "-hwaccel_device".into(), node])
    };
    if zero_copy {
        if encoder.ends_with("_nvenc") {
            let mut a = v(&["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]);
            a.extend(cuda()?);
            return Ok(Some(a));
        }
        if encoder.ends_with("_vaapi") {
            let mut a = vaapi()?;
            a.extend(v(&["-hwaccel_output_format", "vaapi"]));
            return Ok(Some(a));
        }
        return Ok(None);
    }
    if encoder.ends_with("_nvenc") {
        let mut a = v(&["-hwaccel", "cuda"]);
        a.extend(cuda()?);
        return Ok(Some(a));
    }
    if encoder.ends_with("_videotoolbox") {
        return Ok(Some(v(&["-hwaccel", "videotoolbox"])));
    }
    if encoder.ends_with("_vaapi") {
        return Ok(Some(vaapi()?));
    }
    if encoder.ends_with("_qsv") || encoder.ends_with("_amf") {
        if platform == "win32" {
            return Ok(Some(v(&["-hwaccel", "d3d11va"])));
        }
        if platform == "linux" {
            return Ok(Some(vaapi()?));
        }
    }
    Ok(None)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Proof {
    pub codec: String,
    pub hardware: bool,
    pub usable: bool,
    pub reason: Option<String>,
    pub details: Option<String>,
    pub probe_args: Option<Vec<String>>,
}

fn process_failure(r: &super::process::ProcResult) -> Option<&'static str> {
    if r.timed_out {
        return Some("timeout");
    }
    if r.error.is_some() {
        return Some("runner error result");
    }
    if r.status != Some(0) {
        return Some("non-zero status");
    }
    None
}

/// probeCandidate: a short real MP4 encode with the encoder's own arguments.
pub fn probe_candidate(runner: &dyn Runner, ffmpeg: &str, platform: &str, family: &str, codec: &str, hardware: bool, timeout_ms: u64, vaapi_device: Option<&str>, device: Option<&Device>) -> Result<Proof, String> {
    require_family(family)?;
    let fail = |reason: &str, details: Option<String>| Proof { codec: codec.into(), hardware, usable: false, reason: Some(reason.into()), details, probe_args: None };
    let enc = match build_encode_args(&EncodeArgs { codec: family, encoder: codec, bitrate: Some(DEFAULT_PROBE_BITRATE), vaapi_device, device, ..Default::default() }) {
        Ok(a) => a,
        Err(e) => {
            if device.is_none() {
                return Err(e);
            }
            return Ok(fail("invalid device", Some(e)));
        }
    };
    let out = if platform == "win32" { "NUL" } else { "/dev/null" };
    let mut args = v(&["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=duration=0.5:size=640x360:rate=8", "-an", "-frames:v", "4"]);
    args.extend(enc);
    args.extend(["-f".into(), "mp4".into(), out.into()]);
    match runner.run(ffmpeg, &args, &RunOptions { timeout_ms: Some(timeout_ms), ..Default::default() }) {
        Ok(r) => {
            if let Some(reason) = process_failure(&r) {
                let d = if r.stderr.is_empty() { r.error.clone() } else { Some(r.stderr.clone()) };
                return Ok(fail(reason, d));
            }
            Ok(Proof { codec: codec.into(), hardware, usable: true, reason: None, details: None, probe_args: Some(args) })
        }
        Err(e) => Ok(fail("runner error", Some(e))),
    }
}

/// encoderIsAdvertised: the name as a whole word in `ffmpeg -encoders`.
pub fn encoder_is_advertised(output: &str, codec: &str) -> bool {
    output.lines().any(|l| l.split_whitespace().any(|w| w == codec))
}

pub fn device_candidates(family: &str, d: &Device, platform: &str) -> Vec<String> {
    if platform != "linux" {
        return vec![];
    }
    let p = if family == "h265" { "hevc" } else { "av1" };
    match (d.kind.as_str(), d.vendor.as_deref()) {
        ("dri", Some("intel")) => vec![format!("{p}_qsv"), format!("{p}_vaapi")],
        ("dri", Some("amd")) => vec![format!("{p}_vaapi")],
        ("nvidia", _) => vec![format!("{p}_nvenc")],
        _ => vec![],
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Selected {
    pub family: String,
    pub codec: String,
    pub hardware: bool,
    pub remote: bool,
    pub timed_out: bool,
    pub device: Option<Device>,
}

impl Selected {
    pub fn to_json(&self) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("family".into(), json!(self.family));
        m.insert("codec".into(), json!(self.codec));
        m.insert("hardware".into(), json!(self.hardware));
        if self.remote {
            m.insert("remote".into(), json!(true));
        }
        if let Some(d) = &self.device {
            m.insert("device".into(), json!({ "id": d.id, "kind": d.kind }));
        }
        if self.timed_out {
            m.insert("timedOut".into(), json!(true));
        }
        Value::Object(m)
    }
}

/// createEncoderPlanner
pub struct Planner<R: Runner> {
    pub runner: R,
    pub platform: String,
    pub ffmpeg: String,
    pub timeout_ms: u64,
    pub vaapi_device: String,
    advertised: Mutex<Option<String>>,
    proofs: Mutex<HashMap<String, Proof>>,
    selections: Mutex<HashMap<String, Selected>>,
    cpu_warned: Mutex<HashSet<String>>,
}

impl<R: Runner> Planner<R> {
    pub fn new(runner: R, platform: &str, ffmpeg: &str) -> Planner<R> {
        Planner { runner, platform: platform.into(), ffmpeg: ffmpeg.into(), timeout_ms: DEFAULT_PROBE_TIMEOUT_MS, vaapi_device: "/dev/dri/renderD128".into(), advertised: Mutex::new(None), proofs: Mutex::new(HashMap::new()), selections: Mutex::new(HashMap::new()), cpu_warned: Mutex::new(HashSet::new()) }
    }

    fn advertised_encoders(&self) -> Result<String, String> {
        if let Some(a) = self.advertised.lock().unwrap().clone() {
            return Ok(a);
        }
        let r = self.runner.run(&self.ffmpeg, &v(&["-hide_banner", "-encoders"]), &RunOptions { timeout_ms: Some(self.timeout_ms), ..Default::default() }).map_err(|e| format!("Encoder discovery failed: {e}"))?;
        if let Some(reason) = process_failure(&r) {
            return Err(format!("Encoder discovery failed: {reason}"));
        }
        let out = format!("{}\n{}", r.stdout, r.stderr);
        *self.advertised.lock().unwrap() = Some(out.clone());
        Ok(out)
    }

    fn prove(&self, family: &str, codec: &str, hardware: bool, device: Option<&Device>) -> Result<Proof, String> {
        let key = match device {
            Some(d) => format!("{family}:{codec}:{}", d.id),
            None => format!("{family}:{codec}"),
        };
        if let Some(p) = self.proofs.lock().unwrap().get(&key) {
            return Ok(p.clone());
        }
        let t = if hardware { self.timeout_ms } else { self.timeout_ms.max(CPU_PROBE_TIMEOUT_MS) };
        let p = probe_candidate(&self.runner, &self.ffmpeg, &self.platform, family, codec, hardware, t, Some(&self.vaapi_device), device)?;
        // a probe that only ran out of time is tried again next time
        if p.reason.as_deref() != Some("timeout") {
            self.proofs.lock().unwrap().insert(key, p.clone());
        }
        Ok(p)
    }

    fn select_from(&self, family: &str, candidates: &[(&str, bool)], key: &str) -> Result<Selected, String> {
        require_family(family)?;
        if let Some(s) = self.selections.lock().unwrap().get(key) {
            return Ok(s.clone());
        }
        let out = self.advertised_encoders()?;
        for &(codec, hw) in candidates {
            if !encoder_is_advertised(&out, codec) {
                continue;
            }
            if self.prove(family, codec, hw, None)?.usable {
                let s = Selected { family: family.into(), codec: codec.into(), hardware: hw, remote: false, timed_out: false, device: None };
                self.selections.lock().unwrap().insert(key.into(), s.clone());
                return Ok(s);
            }
        }
        Err(format!("No proven {family} encoder is available"))
    }

    pub fn select_cpu_fallback(&self, family: &str) -> Result<Selected, String> {
        let c: Vec<(&str, bool)> = cpu_candidates(family).iter().map(|c| (*c, false)).collect();
        self.select_from(family, &c, &format!("{family}:cpu"))
    }

    /// select(family, { probe })
    pub fn select(&self, family: &str, probe: bool) -> Result<Option<Selected>, String> {
        require_family(family)?;
        let key = format!("{family}:preferred");
        if !probe {
            return Ok(self.selections.lock().unwrap().get(&key).cloned());
        }
        let mut c: Vec<(&str, bool)> = hardware_candidates(family, &self.platform).iter().map(|c| (*c, true)).collect();
        c.extend(cpu_candidates(family).iter().map(|c| (*c, false)));
        self.select_from(family, &c, &key).map(Some)
    }

    /// selectFor(family, device, { probe })
    pub fn select_for(&self, family: &str, d: &Device, probe: bool) -> Result<Option<Selected>, String> {
        require_family(family)?;
        let short = |id: &str, kind: &str| Device { id: id.into(), kind: kind.into(), ..Default::default() };
        if d.kind == "node" {
            return Ok(Some(match d.encoders.get(family).filter(|e| !e.is_empty()) {
                None => {
                    let cpu = self.select_cpu_fallback(family)?;
                    Selected { family: family.into(), codec: cpu.codec, hardware: false, remote: false, timed_out: false, device: Some(short(&d.id, "node")) }
                }
                Some(e) => Selected { family: family.into(), codec: e.clone(), hardware: true, remote: true, timed_out: false, device: Some(Device { name: Some(d.name.clone().unwrap_or(d.id.clone())), ..short(&d.id, "node") }) },
            }));
        }
        if d.kind == "cpu" {
            if !probe && !self.selections.lock().unwrap().contains_key(&format!("{family}:cpu")) {
                return Ok(None);
            }
            let cpu = self.select_cpu_fallback(family)?;
            return Ok(Some(Selected { family: family.into(), codec: cpu.codec, hardware: false, remote: false, timed_out: false, device: Some(short("cpu", "cpu")) }));
        }
        let key = format!("{family}:device:{}", d.id);
        if let Some(s) = self.selections.lock().unwrap().get(&key) {
            return Ok(Some(s.clone()));
        }
        if !probe {
            return Ok(None);
        }
        let chosen = Device { id: d.id.clone(), kind: d.kind.clone(), node: d.node.clone(), index: d.index, ..Default::default() };
        let out = self.advertised_encoders()?;
        let mut timed_out = false;
        for codec in device_candidates(family, d, &self.platform) {
            if !encoder_is_advertised(&out, &codec) {
                continue;
            }
            let p = self.prove(family, &codec, true, Some(&chosen))?;
            if p.usable {
                let s = Selected { family: family.into(), codec, hardware: true, remote: false, timed_out: false, device: Some(chosen) };
                self.selections.lock().unwrap().insert(key, s.clone());
                return Ok(Some(s));
            }
            if p.reason.as_deref() == Some("timeout") {
                timed_out = true;
            }
        }
        let cpu = self.select_cpu_fallback(family)?;
        if timed_out {
            return Ok(Some(Selected { family: family.into(), codec: cpu.codec, hardware: false, remote: false, timed_out: true, device: Some(chosen) }));
        }
        if self.cpu_warned.lock().unwrap().insert(key.clone()) {
            eprintln!("[CONVERTER] {} cannot encode {}; its conversions use the CPU encoder.", d.name.clone().unwrap_or(d.id.clone()), if family == "h265" { "H.265" } else { "AV1" });
        }
        let s = Selected { family: family.into(), codec: cpu.codec, hardware: false, remote: false, timed_out: false, device: Some(chosen) };
        self.selections.lock().unwrap().insert(key, s.clone());
        Ok(Some(s))
    }
}

/// calculateInitialBitrate
pub fn calculate_initial_bitrate(codec: &str, target_bytes: f64, duration_seconds: f64, container_reserve: f64, telemetry_reserve: f64) -> Result<i64, String> {
    require_family(codec)?;
    for (n, x) in [("targetBytes", target_bytes), ("durationSeconds", duration_seconds)] {
        if !x.is_finite() || x <= 0.0 {
            return Err(format!("{n} must be a positive finite number"));
        }
    }
    for (n, x) in [("containerReserveBytes", container_reserve), ("telemetryReserveBytes", telemetry_reserve)] {
        if !x.is_finite() || x < 0.0 {
            return Err(format!("{n} must be a non-negative finite number"));
        }
    }
    let reserved = container_reserve + telemetry_reserve;
    if reserved >= target_bytes {
        return Err("Container and telemetry reserve must be smaller than targetBytes".into());
    }
    let calc = (((target_bytes - reserved) * 8.0) / duration_seconds).floor();
    Ok((bitrate_floor(codec) as f64).max(calc) as i64)
}

/// calculateRetryBitrate
pub fn calculate_retry_bitrate(current: f64, actual: f64, target: f64, codec: &str) -> Result<i64, String> {
    for (n, x) in [("currentBitrate", current), ("actualBytes", actual), ("targetBytes", target)] {
        if !x.is_finite() || x <= 0.0 {
            return Err(format!("{n} must be a positive finite number"));
        }
    }
    let calc = js_round(current * (target / actual));
    Ok(bitrate_floor(codec).max(calc))
}

/// decideSizeRetry: (retry, bitrate)
pub fn decide_size_retry(retry_count: i64, failure_reason: Option<&str>, codec: &str, encoder: &str, current: f64, actual: f64, target: f64) -> Result<(bool, Option<i64>), String> {
    if retry_count < 0 {
        return Err("retryCount must be a non-negative integer".into());
    }
    let limit = if encoder == "libaom-av1" { 2 } else { 1 };
    if failure_reason != Some("profile-size") || retry_count >= limit {
        return Ok((false, None));
    }
    Ok((true, Some(calculate_retry_bitrate(current, actual, target, codec)?)))
}

#[cfg(test)]
mod tests {
    //! test/leadIn.test.js (buildEncodeArgs and the hold), test/deviceArgs.test.js,
    //! and parity with the Node planner over every encoder and option.
    use super::*;
    use crate::converter::process::ProcResult;

    #[test]
    fn usable_cpus_cases() {
        // test/x265Pools.test.js checks the same cases against the Node planner
        let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!("testdata/usableCpusCases.json")).unwrap();
        for c in &cases {
            let files = c["files"].as_object().unwrap();
            let read = |p: &str| files.get(p).and_then(|v| v.as_str()).unwrap_or("").to_string();
            assert_eq!(usable_cpus(&read), c["cpus"].as_u64().unwrap() as usize, "{}", c["name"]);
        }
        assert_eq!(["0-11", "5", "0-3,8,10-11", "", "3-1", "0-", "a", "0-3 5", "4194303", "4194304", "9007199254740993-9007199254740994"].map(cpu_list_count), [12, 1, 7, 0, 0, 0, 0, 0, 1, 0, 0]);
    }

    #[test]
    fn libx265_gets_a_thread_pool_of_the_usable_cpus_on_linux() {
        assert_eq!((default_x265_pools("linux", 12), default_x265_pools("macos", 12), default_x265_pools("windows", 8), default_x265_pools("linux", 0)), (12, 0, 0, 0));
        let args = |enc: &str, pools: Option<usize>| build_encode_args(&EncodeArgs { codec: if enc.starts_with("lib") && enc != "libx265" { "av1" } else { "h265" }, encoder: enc, bitrate: Some(1e6), x265_pools: pools, ..Default::default() }).unwrap();
        let x = args("libx265", Some(8));
        let p = x.iter().position(|a| a == "-preset").unwrap();
        assert_eq!(&x[p..p + 4], &["-preset", "medium", "-x265-params", "pools=8"]);
        assert!(!args("libx265", Some(0)).iter().any(|a| a == "-x265-params"));
        assert!(!args("hevc_vaapi", Some(8)).iter().any(|a| a == "-x265-params"));
        assert!(!args("libsvtav1", Some(8)).iter().any(|a| a == "-x265-params"));
        let here = default_x265_pools(std::env::consts::OS, usable_cpus(&read_trimmed));
        assert_eq!(args("libx265", None).iter().any(|a| a == &format!("pools={here}")), here > 0);
    }

    #[test]
    fn a_lead_in_adds_one_clone_pad_in_front() {
        let families = [("h265", vec!["libx265", "hevc_nvenc", "hevc_qsv", "hevc_amf", "hevc_vaapi", "hevc_videotoolbox"]), ("av1", vec!["libsvtav1", "libaom-av1", "av1_nvenc", "av1_qsv", "av1_amf", "av1_vaapi", "av1_videotoolbox"])];
        let pad = "tpad=start=17:start_mode=clone";
        let dev = Device { id: "pci:0000:01:00.0".into(), kind: "dri".into(), node: Some("/dev/dri/renderD129".into()), index: Some(1), ..Default::default() };
        for (codec, list) in families {
            for enc in list {
                for (q, d) in [(None, None), (Some("balanced"), None), (None, Some(&dev))] {
                    let base = EncodeArgs { codec, encoder: enc, bitrate: Some(1_000_000.0), quality: q, device: d, ..Default::default() };
                    let before = build_encode_args(&base).unwrap();
                    assert!(!before.iter().any(|a| a.contains("tpad")));
                    let held = build_encode_args(&EncodeArgs { hold_frames: 17, ..base.clone() }).unwrap();
                    assert_eq!(held.iter().filter(|a| *a == "-vf").count(), 1, "{enc}");
                    let chain = held[held.iter().position(|a| a == "-vf").unwrap() + 1].clone();
                    if enc.ends_with("_vaapi") {
                        assert_eq!(chain, format!("{pad},format=nv12,hwupload"));
                    } else {
                        assert_eq!(chain, pad);
                        let rest: Vec<String> = held.iter().enumerate().filter(|(i, a)| **a != chain && !(*a == "-vf" && held.get(i + 1) == Some(&chain))).map(|(_, a)| a.clone()).collect();
                        assert_eq!(rest, before);
                    }
                }
            }
        }
        assert!(build_encode_args(&EncodeArgs { codec: "h265", encoder: "hevc_nvenc", bitrate: Some(1e6), hw_frames: true, hold_frames: 3, ..Default::default() }).unwrap_err().contains("system-memory"));
        assert!(build_encode_args(&EncodeArgs { codec: "h265", encoder: "libx265", bitrate: Some(1e6), hold_frames: -1, ..Default::default() }).is_err());
        assert!(build_encode_args(&EncodeArgs { codec: "h265", encoder: "libsvtav1", bitrate: Some(1e6), ..Default::default() }).is_err());
    }

    struct Fake(Vec<&'static str>);
    impl Runner for Fake {
        fn run(&self, _c: &str, args: &[String], _o: &RunOptions) -> Result<ProcResult, String> {
            if args.iter().any(|a| a == "-encoders") {
                return Ok(ProcResult { status: Some(0), stdout: " V....D libx265 x265\n V....D hevc_vaapi H.265/HEVC (VAAPI)\n V....D libsvtav1 SVT\n".into(), ..Default::default() });
            }
            let enc = &args[args.iter().position(|a| a == "-c:v").unwrap() + 1];
            Ok(ProcResult { status: Some(if self.0.contains(&enc.as_str()) { 0 } else { 1 }), ..Default::default() })
        }
    }

    #[test]
    fn the_planner_proves_hardware_first_then_falls_back_to_the_cpu() {
        let p = Planner::new(Fake(vec!["libx265", "hevc_vaapi", "libsvtav1"]), "linux", "ffmpeg");
        let s = p.select("h265", true).unwrap().unwrap();
        assert_eq!((s.codec.as_str(), s.hardware), ("hevc_vaapi", true));
        assert_eq!(p.select("h265", false).unwrap().unwrap().codec, "hevc_vaapi");
        let p2 = Planner::new(Fake(vec!["libx265"]), "linux", "ffmpeg");
        assert_eq!(p2.select("h265", true).unwrap().unwrap().codec, "libx265", "the VA-API probe failed");
        let amd = Device { id: "pci:0000:03:00.0".into(), kind: "dri".into(), vendor: Some("amd".into()), node: Some("/dev/dri/renderD128".into()), ..Default::default() };
        let s = p2.select_for("h265", &amd, true).unwrap().unwrap();
        assert_eq!((s.codec.as_str(), s.hardware), ("libx265", false), "a GPU that cannot encodes on the CPU");
        assert!(p2.select_for("av1", &Device { id: "pci:0000:04:00.0".into(), kind: "dri".into(), ..Default::default() }, false).unwrap().is_none());
        let node = Device { id: "node:abcdef012345@cpu".into(), kind: "node".into(), encoders: [("h265".to_string(), "hevc_nvenc".to_string())].into_iter().collect(), ..Default::default() };
        let s = p2.select_for("h265", &node, true).unwrap().unwrap();
        assert!(s.remote && s.codec == "hevc_nvenc");
        assert!(Planner::new(Fake(vec![]), "linux", "ffmpeg").select("av1", true).is_err());
    }

    #[test]
    fn bitrates() {
        assert_eq!(calculate_initial_bitrate("h265", 1_000_000.0, 10.0, 0.0, 0.0).unwrap(), 800_000);
        assert_eq!(calculate_initial_bitrate("h265", 100.0, 10.0, 0.0, 0.0).unwrap(), 250_000, "the floor");
        assert!(calculate_initial_bitrate("h265", 100.0, 10.0, 60.0, 40.0).is_err());
        assert_eq!(calculate_retry_bitrate(1_000_000.0, 2.0, 1.0, "av1").unwrap(), 500_000);
        assert_eq!(decide_size_retry(0, Some("profile-size"), "h265", "libx265", 1e6, 2.0, 1.0).unwrap(), (true, Some(500_000)));
        assert_eq!(decide_size_retry(1, Some("profile-size"), "h265", "libx265", 1e6, 2.0, 1.0).unwrap(), (false, None));
        assert_eq!(decide_size_retry(1, Some("profile-size"), "av1", "libaom-av1", 1e6, 2.0, 1.0).unwrap().0, true);
        assert_eq!(decide_size_retry(0, Some("not-smaller"), "h265", "libx265", 1e6, 2.0, 1.0).unwrap(), (false, None));
    }

    /// Every encoder, quality, device, hold and zero-copy choice against
    /// buildEncodeArgs / decodeAccelArgs of the Node planner
    /// (src/main/converter/encoderPlanner.js, removed), frozen in
    /// tests/fixtures/node-reference/planner-args.json with the script that asked it.
    /// Encode answers add the shared demux time-base rule to that frozen baseline.
    #[test]
    fn arguments_match_node() {
        let node: Vec<Value> = serde_json::from_value(crate::reference::json("planner-args.json")["answers"].clone()).unwrap();
        let encs = [("h265", vec!["libx265", "hevc_nvenc", "hevc_qsv", "hevc_amf", "hevc_vaapi", "hevc_videotoolbox"]), ("av1", vec!["libsvtav1", "libaom-av1", "av1_nvenc", "av1_qsv", "av1_amf", "av1_vaapi", "av1_videotoolbox"])];
        let dev = Device { node: Some("/dev/dri/renderD129".into()), index: Some(1), ..Default::default() };
        let mut mine: Vec<Value> = vec![];
        for (codec, list) in &encs {
            for enc in list {
                for q in [None, Some("high"), Some("balanced"), Some("small")] {
                    for d in [None, Some(&dev)] {
                        for hw in [false, true] {
                            for hold in [0, 5] {
                                for preset in ["", "fast", "faster"] {
                                    let r = build_encode_args(&EncodeArgs { codec, encoder: enc, bitrate: Some(1_234_567.5), quality: q, device: d, hw_frames: hw, hold_frames: hold, cpu_preset: Some(preset), vaapi_device: None, smallest: None, keep_order: false, x265_pools: None });
                                    mine.push(r.map(|a| json!(a)).unwrap_or(json!("error")));
                                }
                            }
                        }
                    }
                }
            }
        }
        for (_, list) in &encs {
            for enc in list {
                for platform in ["linux", "win32", "darwin"] {
                    for zc in [false, true] {
                        for d in [None, Some(&dev)] {
                            mine.push(json!(decode_accel_args(enc, platform, None, zc, d).unwrap()));
                        }
                    }
                }
            }
        }
        for (codec, enc, q) in [("h265", "libx265", None), ("h265", "libx265", Some("small")), ("h265", "hevc_vaapi", None), ("av1", "libsvtav1", None)] {
            for maxrate in [None, Some(0), Some(3_000_000)] {
                for bitrate in [None, Some(1_234_567.5), Some(0.0)] {
                    for keep_order in [false, true] {
                        for hold in [0, 5] {
                            for preset in ["", "faster"] {
                                let r = build_encode_args(&EncodeArgs { codec, encoder: enc, bitrate, quality: q, hold_frames: hold, cpu_preset: Some(preset), smallest: Some(Smallest { maxrate }), keep_order, ..Default::default() });
                                mine.push(r.map(|a| json!(a)).unwrap_or(json!("error")));
                            }
                        }
                    }
                }
            }
        }
        for enc in &encs[0].1 {
            for pools in [0, 4, 64] {
                mine.push(json!(build_encode_args(&EncodeArgs { codec: "h265", encoder: enc, bitrate: Some(1_234_567.5), x265_pools: Some(pools), ..Default::default() }).unwrap()));
            }
        }
        assert_eq!(mine.len(), node.len());
        for (i, (a, b)) in mine.iter().zip(&node).enumerate() {
            assert_eq!(a, b, "case {i}");
        }
    }
}
