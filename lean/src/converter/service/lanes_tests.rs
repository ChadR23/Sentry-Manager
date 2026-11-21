//! test/lanes.test.js (with test/fixtures/lanesHarness.js): which GPU each
//! clip encodes on, how many run at once per GPU, lanes changed live, the
//! decode tiers per GPU, and the runtime's device list. ffmpeg is a small
//! shell script the test controls (hold an encode, finish it, fail it); the
//! encoder planner is the real one over a fake probe runner.

use super::super::devices::{Discovery, Encoders, Registry};
use super::super::planner::{Device, Planner, Selected};
use super::super::process::{ProcResult, RunOptions, Runner};
use super::super::runtime::{Converter, RuntimeOptions};
use super::super::testutil::{tempdir, TempDir};
use super::tools::{Inspected, Tools, VerifyRequest};
use super::Service;
use crate::converter::error::{CError, CResult};
use crate::converter::timeline::Timeline;
use crate::converter::verifier::Verdict;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub fn arc() -> Value {
    json!({ "id": "pci:0000:03:00.0", "kind": "dri", "vendor": "intel", "name": "Intel Arc A380", "node": "/dev/dri/renderD129", "index": null, "pci": "0000:03:00.0" })
}
pub fn uhd() -> Value {
    json!({ "id": "pci:0000:00:02.0", "kind": "dri", "vendor": "intel", "name": "Intel UHD Graphics 770", "node": "/dev/dri/renderD128", "index": null, "pci": "0000:00:02.0" })
}
pub fn t400() -> Value {
    json!({ "id": "pci:0000:01:00.0", "kind": "nvidia", "vendor": "nvidia", "name": "NVIDIA T400", "node": null, "index": 0, "pci": "0000:01:00.0" })
}
pub fn cpu() -> Value {
    super::super::devices::cpu_device()
}
const MISSING: &str = "pci:0000:09:00.0";
const ADVERTISED: [&str; 8] = ["libx265", "libsvtav1", "hevc_nvenc", "av1_nvenc", "hevc_qsv", "av1_qsv", "hevc_vaapi", "av1_vaapi"];
const ARC_NODE: &str = "/dev/dri/renderD129";
const UHD_NODE: &str = "/dev/dri/renderD128";

/// gpuOf(args): a render node, an NVIDIA index or none
pub fn gpu_of(args: &[String]) -> Option<String> {
    let at = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
    if let Some(g) = at("-gpu") {
        return Some(format!("nvidia{g}"));
    }
    if let Some(d) = at("-init_hw_device") {
        if let Some(c) = d.split(',').find_map(|p| p.strip_prefix("child_device=")) {
            return Some(c.to_string());
        }
    }
    at("-vaapi_device")
}

pub type Works = Arc<dyn Fn(&str, &[String]) -> Option<bool> + Send + Sync>;

/// desktopWorks: QSV on the Arc and (H.265 only) on the UHD 770, also the
/// default GPU without device arguments; NVENC on the T400. No VA-API.
pub fn desktop_works() -> Works {
    Arc::new(|encoder: &str, args: &[String]| {
        if encoder.starts_with("lib") {
            return Some(true);
        }
        let gpu = gpu_of(args);
        if encoder.ends_with("_qsv") {
            if gpu.as_deref() == Some(ARC_NODE) {
                return Some(true);
            }
            if gpu.as_deref() == Some(UHD_NODE) || gpu.is_none() {
                return Some(encoder == "hevc_qsv");
            }
            return Some(false);
        }
        if encoder.ends_with("_nvenc") {
            return Some(gpu.as_deref() == Some("nvidia0"));
        }
        Some(false)
    })
}

/// The probe runner the planner uses (None from `works`: a timeout).
pub struct FakeProbe {
    pub works: Works,
    pub calls: AtomicUsize,
    /// what ffmpeg -encoders lists (ADVERTISED when None)
    pub advertised: Option<Vec<String>>,
}
impl Runner for FakeProbe {
    fn run(&self, _c: &str, args: &[String], _o: &RunOptions) -> Result<ProcResult, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if args.iter().any(|a| a == "-encoders") {
            let list: Vec<String> = self.advertised.clone().unwrap_or_else(|| ADVERTISED.iter().map(|s| s.to_string()).collect());
            return Ok(ProcResult { status: Some(0), stdout: list.iter().map(|n| format!(" V..... {n}  x")).collect::<Vec<_>>().join("\n"), ..Default::default() });
        }
        let enc = args.iter().position(|a| a == "-c:v").and_then(|i| args.get(i + 1)).cloned().unwrap_or_default();
        Ok(match (self.works)(&enc, args) {
            None => ProcResult { status: None, timed_out: true, ..Default::default() },
            Some(true) => ProcResult { status: Some(0), ..Default::default() },
            Some(false) => ProcResult { status: Some(1), stderr: "not here".into(), ..Default::default() },
        })
    }
}

impl Runner for Arc<FakeProbe> {
    fn run(&self, c: &str, a: &[String], o: &RunOptions) -> Result<ProcResult, String> {
        (**self).run(c, a, o)
    }
}

fn sample_timeline() -> Timeline {
    static T: OnceLock<Timeline> = OnceLock::new();
    T.get_or_init(|| {
        let d = std::env::temp_dir().join(format!("lean-lanes-clip-{}.mp4", std::process::id()));
        let r = std::process::Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=12:duration=0.5", "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", "-use_editlist", "0"]).arg(&d).output().unwrap();
        assert!(r.status.success());
        let t = crate::converter::timeline::extract(&fs::read(&d).unwrap()).unwrap();
        let _ = fs::remove_file(&d);
        t
    })
    .clone()
}

/// The service's tools: every clip H.264, every encode verified ok or not as
/// the test says, the encoder chosen by the real planner.
pub struct FakeTools {
    pub planner: Arc<Planner<Arc<FakeProbe>>>,
    pub ffmpeg: String,
    pub verify_ok: bool,
    /// the snapshot registry a passing verdict records its snapshot in
    pub registry: OnceLock<Arc<crate::converter::snapshot::Registry>>,
    pub verified: Mutex<Vec<String>>,
}
impl Tools for FakeTools {
    fn inspect_video(&self, _s: &str, _c: &Arc<AtomicBool>) -> CResult<Inspected> {
        Ok(Inspected { codec: "h264".into(), duration_seconds: 2.0 })
    }
    fn read_timeline(&self, _s: &str, _c: &AtomicBool) -> CResult<Timeline> {
        Ok(sample_timeline())
    }
    fn write_telemetry(&self, _codec: &str, _p: &str, _t: &Timeline, _c: &AtomicBool) -> CResult<()> {
        Ok(())
    }
    fn verify(&self, _r: &VerifyRequest) -> Verdict {
        self.verified.lock().unwrap().push(_r.candidate.to_string());
        let fail = Verdict { ok: false, reason: Some("decode-failed"), retryable: false, source_bytes: None, output_bytes: None, details: json!({}), publication_artifact: None };
        if !self.verify_ok || fs::read(_r.candidate).map_or(true, |b| b.is_empty() || b == b"bad") {
            return fail;
        }
        // a passing verdict: the candidate adopted into a snapshot, as the verifier does
        let bytes = fs::read(_r.candidate).unwrap();
        let sha = crate::converter::tesla_sei::hex(&<sha2::Sha256 as sha2::Digest>::digest(&bytes));
        let Some(reg) = self.registry.get() else { return fail };
        let Ok(mut snap) = reg.create(&bytes, &sha, Some(Path::new(_r.candidate)), true) else { return fail };
        if snap.transfer().is_err() {
            return fail;
        }
        let artifact = crate::converter::snapshot::Artifact { path: snap.path.to_string_lossy().into_owned(), token: snap.token.clone(), sha256: sha, size: bytes.len() as u64 };
        Verdict { ok: true, reason: None, retryable: false, source_bytes: Some(4000), output_bytes: Some(bytes.len() as u64), details: json!({}), publication_artifact: Some(artifact) }
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
    fn select_for(&self, codec: &str, d: &Device) -> CResult<Selected> {
        match self.planner.select_for(codec, d, true) {
            Ok(Some(s)) => Ok(s),
            Ok(None) => self.select_cpu_fallback(codec),
            Err(e) => Err(CError::new("ENCODER_UNAVAILABLE", e)),
        }
    }
    fn ffmpeg_path(&self) -> &str {
        &self.ffmpeg
    }
}

const SCRIPT: &str = r#"#!/bin/sh
CTL="$(dirname "$0")"
for last; do :; done
printf '%s\n' "$@" > "$CTL/spawned/$$.tmp" && mv "$CTL/spawned/$$.tmp" "$CTL/spawned/$$"
trap 'touch "$CTL/done/$$"; exit 143' TERM
if [ -e "$CTL/hold" ]; then
  while [ ! -e "$CTL/release/$$" ] && [ ! -e "$CTL/release-all" ]; do sleep 0.01; done
fi
code=0
if [ -e "$CTL/fail-if" ]; then
  pat="$(cat "$CTL/fail-if")"
  case "$*" in *"$pat"*) code=1 ;; esac
fi
printf 'fps=100\nprogress=end\n'
[ "$code" = 0 ] && printf 'encoded' > "$last"
touch "$CTL/done/$$"
exit $code
"#;

pub struct Spawned {
    pub pid: String,
    pub args: Vec<String>,
    pub gpu: Option<String>,
}

pub struct Harness {
    pub dir: TempDir,
    pub conv: Converter,
    pub ctl: PathBuf,
    pub probe: Arc<FakeProbe>,
    pub resolved: Arc<Mutex<Vec<String>>>,
}

pub struct HarnessOptions {
    pub clips: usize,
    pub devices: Vec<Value>,
    pub works: Works,
    pub hold: bool,
    pub default_device: Option<Option<String>>,
    pub verify_ok: bool,
    pub nodes: Option<Arc<dyn super::lanes::NodeLanes>>,
    pub compare: Option<Arc<dyn Fn(&str, &str, &Arc<AtomicBool>, Option<f64>) -> Value + Send + Sync>>,
}

impl Default for HarnessOptions {
    fn default() -> Self {
        HarnessOptions { clips: 6, devices: vec![arc(), uhd(), cpu()], works: desktop_works(), hold: true, default_device: None, verify_ok: false, nodes: None, compare: None }
    }
}

fn clip_name(i: usize) -> String {
    format!("2026-10-20_07-{:02}-{:02}-front.mp4", 10 + i / 60, i % 60)
}

impl Harness {
    pub fn new(o: HarnessOptions) -> Harness {
        let dir = tempdir().unwrap();
        let ctl = dir.path().join("ctl");
        for d in ["spawned", "done", "release"] {
            fs::create_dir_all(ctl.join(d)).unwrap();
        }
        let ffmpeg = ctl.join("ffmpeg");
        fs::write(&ffmpeg, SCRIPT).unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&ffmpeg, fs::Permissions::from_mode(0o755)).unwrap();
        if o.hold {
            fs::write(ctl.join("hold"), "").unwrap();
        }
        let rc = dir.path().join("footage/RecentClips");
        fs::create_dir_all(&rc).unwrap();
        for i in 0..o.clips {
            fs::write(rc.join(clip_name(i)), vec![0u8; 4000]).unwrap();
        }
        for d in ["data", "temp", "out"] {
            fs::create_dir_all(dir.path().join(d)).unwrap();
        }
        let probe = Arc::new(FakeProbe { works: o.works.clone(), calls: AtomicUsize::new(0), advertised: None });
        let planner = Arc::new(Planner::new(probe.clone(), "linux", "ffmpeg"));
        let tools = Arc::new(FakeTools { planner: planner.clone(), ffmpeg: ffmpeg.to_string_lossy().to_string(), verify_ok: o.verify_ok, registry: OnceLock::new(), verified: Mutex::new(vec![]) });
        let tools2 = tools.clone();
        let devices = o.devices.clone();
        let resolved = Arc::new(Mutex::new(vec![]));
        let r2 = resolved.clone();
        let default = o.default_device.clone().unwrap_or_else(|| devices.iter().any(|d| d["id"] == uhd()["id"]).then(|| uhd()["id"].as_str().unwrap().to_string()));
        let dev2 = devices.clone();
        let mut ro = RuntimeOptions::new(dir.path().join("data"), dir.path().join("temp"), &ffmpeg.to_string_lossy(), "ffprobe");
        ro.tools = Some(tools);
        ro.encoders = Some(planner);
        let mut disc = Discovery::new(None);
        let dev3 = devices.clone();
        disc.fixed = Some(Arc::new(move || dev3.clone()));
        ro.discovery = Some(disc);
        let (nodes, compare) = (o.nodes.clone(), o.compare.clone());
        ro.tune = Some(Box::new(move |so| {
            if let Some(n) = nodes {
                let n2 = n.clone();
                so.set_node_slots = Some(Arc::new(move |id: &str, s: &Value| n2.set_slots(id, s)));
                so.remote_nodes = Some(n);
            }
            so.compare_picture = compare;
            so.resolve_device = Some(Arc::new(move |id: &str| {
                r2.lock().unwrap().push(id.to_string());
                dev2.iter().find(|d| d["id"] == id).cloned()
            }));
            so.default_device = Some(Arc::new(move |_c: &str| default.clone()));
            so.encode_stall_ms = 60_000;
        }));
        let conv = Converter::open(ro).unwrap();
        let _ = tools2.registry.set(conv.registry.clone());
        conv.start().unwrap();
        Harness { dir, conv, ctl, probe, resolved }
    }

    pub fn service(&self) -> &Service {
        &self.conv.service
    }

    pub fn config(&self, over: Value) -> Value {
        let mut c = json!({
            "sourceRoot": self.dir.path().join("footage"), "destinationRoot": self.dir.path().join("out"),
            "codec": "h265", "profileId": "custom", "bitrateKbps": 250, "networkMode": "direct", "outputMode": "separate",
            "includedGroups": ["RecentClips", "SavedClips", "SentryClips"], "groupOrder": ["SavedClips", "SentryClips", "RecentClips"],
            "replacementConfirmed": false, "concurrency": 1, "verifyMode": "quick"
        });
        for (k, v) in over.as_object().unwrap() {
            c[k] = v.clone();
        }
        c
    }

    /// every encode started (the script's own records)
    pub fn spawned(&self) -> Vec<Spawned> {
        let mut out: Vec<Spawned> = fs::read_dir(self.ctl.join("spawned"))
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| !n.ends_with(".tmp"))
            .filter_map(|pid| {
                let text = fs::read_to_string(self.ctl.join("spawned").join(&pid)).ok()?;
                let args: Vec<String> = text.lines().map(str::to_string).collect();
                Some(Spawned { gpu: gpu_of(&args), pid, args })
            })
            .collect();
        out.sort_by_key(|s| fs::metadata(self.ctl.join("spawned").join(&s.pid)).and_then(|m| m.modified()).ok());
        out
    }

    pub fn held(&self) -> Vec<Spawned> {
        self.spawned().into_iter().filter(|s| !self.ctl.join("done").join(&s.pid).exists()).collect()
    }

    pub fn finish(&self, s: &Spawned) {
        fs::write(self.ctl.join("release").join(&s.pid), "").unwrap();
    }

    pub fn finish_all(&self) {
        for s in self.held() {
            self.finish(&s);
        }
    }

    /// encodes running now, per lane (device id, or 'default')
    pub fn running(&self) -> HashMap<String, usize> {
        let mut m = HashMap::new();
        for live in self.service().active_encodes() {
            let k = live["deviceId"].as_str().unwrap_or("default").to_string();
            *m.entry(k).or_insert(0) += 1;
        }
        m
    }

    pub fn finish_job(&self, id: &str) -> Value {
        fs::write(self.ctl.join("release-all"), "").unwrap();
        self.service().when_idle(id).unwrap();
        let _ = fs::remove_file(self.ctl.join("release-all"));
        self.service().get(id).unwrap()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = fs::write(self.ctl.join("release-all"), "");
        if let Ok(list) = self.conv.service.list() {
            for j in list {
                if !["completed", "failed", "cancelled"].contains(&j["state"].as_str().unwrap_or("")) {
                    let _ = self.conv.service.cancel(j["id"].as_str().unwrap_or(""));
                }
            }
        }
        self.conv.shutdown();
        // (a job thread's last write may land after when_idle: let it, then remove the folder)
        std::thread::sleep(Duration::from_millis(300));
        let _ = fs::remove_dir_all(self.dir.path());
    }
}

pub fn until(f: impl Fn() -> bool) -> bool {
    let end = Instant::now() + Duration::from_secs(10);
    while Instant::now() < end {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    false
}

fn counts(pairs: &[(&str, usize)]) -> HashMap<String, usize> {
    pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}

/// `n` encodes held here and the service listing `want`. Waits for both: a child marks itself held
/// before the service lists it, and the service lists a clip before its child is held.
fn settled(h: &Harness, n: usize, want: &HashMap<String, usize>) -> bool {
    until(|| h.held().len() == n && h.running() == *want)
}

/// None of these released encodes is held any more.
fn gone(h: &Harness, pids: &[String]) -> bool {
    h.held().iter().all(|s| !pids.contains(&s.pid))
}

/// Releases every held encode and returns their pids.
fn release_all_held(h: &Harness) -> Vec<String> {
    h.held()
        .into_iter()
        .map(|s| {
            h.finish(&s);
            s.pid
        })
        .collect()
}

fn id_of(v: Value) -> String {
    v["id"].as_str().unwrap().to_string()
}

fn every_clip_encoded(h: &Harness, job: &Value, n: usize) {
    assert_eq!(job["items"].as_array().unwrap().len(), n);
    assert!(job["items"].as_array().unwrap().iter().all(|i| i["state"] != "queued" && i["state"] != "processing"), "{job}");
    let _ = h;
}

fn ok_ffmpeg() -> bool {
    std::process::Command::new("ffmpeg").arg("-version").output().is_ok_and(|o| o.status.success())
}

#[test]
fn each_lane_gets_its_own_workers_on_its_own_gpu() {
    if !ok_ffmpeg() {
        return;
    }
    let h = Harness::new(HarnessOptions { clips: 12, ..Default::default() });
    let (a, u) = (id_of(arc()), id_of(uhd()));
    let id = h.service().start(&h.config(json!({ "lanes": [{ "device": a, "concurrency": 3 }, { "device": u, "concurrency": 1 }] }))).unwrap();
    let want = counts(&[(&a, 3), (&u, 1)]);
    assert!(settled(&h, 4, &want), "four encodes at once: {:?}", h.running());
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(h.held().len(), 4);
    assert_eq!(h.running(), want);
    let held = h.held();
    let on_arc: Vec<&Spawned> = held.iter().filter(|s| s.gpu.as_deref() == Some(ARC_NODE)).collect();
    assert_eq!(on_arc.len(), 3);
    assert_eq!(held.iter().filter(|s| s.gpu.as_deref() == Some(UHD_NODE)).count(), 1);
    let args = &on_arc[0].args;
    let i = args.iter().position(|x| x == "-init_hw_device").unwrap();
    let j = args.iter().position(|x| x == "-c:v").unwrap();
    assert_eq!(&args[i..j + 2], &["-init_hw_device", "qsv=qsvenc:hw_any,child_device=/dev/dri/renderD129", "-c:v", "hevc_qsv"]);
    assert_eq!(&args[5..9], &["-hwaccel", "vaapi", "-hwaccel_device", "/dev/dri/renderD129"], "decoded on the same GPU");
    let live = h.service().active_encodes();
    assert!(live.iter().filter(|e| e["deviceId"] == a.as_str()).all(|e| e["device"] == ARC_NODE && e["encoder"] == "hevc_qsv" && e["decode"] == "gpu"));
    assert!(live.iter().filter(|e| e["deviceId"] == u.as_str()).all(|e| e["device"] == UHD_NODE));
    assert_eq!(h.service().get(&id).unwrap()["config"]["concurrency"], 4);
    assert_eq!(h.service().set_concurrency(&id, &json!(0)).unwrap_err().code.as_deref(), Some("INVALID_CONCURRENCY"));
    assert_eq!(h.service().set_lanes(&id, &json!([{ "device": "/dev/dri/renderD128", "concurrency": 1 }])).unwrap_err().code.as_deref(), Some("INVALID_LANES"));
    let done = h.finish_job(&id);
    assert_eq!(done["state"], "completed");
    every_clip_encoded(&h, &done, 12);
    assert_eq!(h.service().set_lanes(&id, &json!([{ "device": a, "concurrency": 1 }])).unwrap_err().code.as_deref(), Some("JOB_NOT_ACTIVE"));
}

#[test]
fn lanes_change_live_higher_starts_now_removed_finishes_first() {
    if !ok_ffmpeg() {
        return;
    }
    let h = Harness::new(HarnessOptions { clips: 24, ..Default::default() });
    let (a, u) = (id_of(arc()), id_of(uhd()));
    let id = h.service().start(&h.config(json!({ "lanes": [{ "device": a, "concurrency": 1 }, { "device": u, "concurrency": 1 }] }))).unwrap();
    assert!(until(|| h.held().len() == 2));
    let job = h.service().set_lanes(&id, &json!([{ "device": a, "concurrency": 3 }, { "device": u, "concurrency": 1 }])).unwrap();
    assert_eq!(job["config"]["concurrency"], 4);
    assert!(settled(&h, 4, &counts(&[(&a, 3), (&u, 1)])), "{:?}", h.running());
    let job = h.service().set_lanes(&id, &json!([{ "device": a, "concurrency": 0 }, { "device": u, "concurrency": 2 }])).unwrap();
    assert_eq!(job["config"]["lanes"], json!([{ "device": u, "concurrency": 2 }]));
    assert_eq!(job["config"]["concurrency"], 2);
    assert!(settled(&h, 5, &counts(&[(&a, 3), (&u, 2)])), "{:?}", h.running());
    let arc_encodes = h.spawned().iter().filter(|s| s.gpu.as_deref() == Some(ARC_NODE)).count();
    let released = release_all_held(&h);
    assert!(until(|| gone(&h, &released) && h.held().len() == 2 && h.running() == counts(&[(&u, 2)])), "{:?}", h.running());
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(h.running(), counts(&[(&u, 2)]), "only the UHD converts now");
    assert_eq!(h.spawned().iter().filter(|s| s.gpu.as_deref() == Some(ARC_NODE)).count(), arc_encodes, "the Arc took no new clip");
    h.service().set_lanes(&id, &json!([{ "device": u, "concurrency": 1 }])).unwrap();
    let released = release_all_held(&h);
    assert!(until(|| gone(&h, &released) && h.held().len() == 1 && h.running() == counts(&[(&u, 1)])), "{:?}", h.running());
    // (the worker that stays takes the next clip; the other retires)
    for _ in 0..10 {
        std::thread::sleep(Duration::from_millis(30));
        assert!(h.held().len() <= 1, "never two at once on the UHD now");
    }
    assert!(until(|| h.held().len() == 1));
    let done = h.finish_job(&id);
    assert_eq!(done["state"], "completed");
    every_clip_encoded(&h, &done, 24);
    assert_eq!(done["config"]["lanes"], json!([{ "device": u, "concurrency": 1 }]));
}

#[test]
fn set_lanes_on_a_job_without_lanes_and_the_default_gpu_never_runs_more_than_set() {
    if !ok_ffmpeg() {
        return;
    }
    let h = Harness::new(HarnessOptions { clips: 12, ..Default::default() });
    let (a, u) = (id_of(arc()), id_of(uhd()));
    let id = h.service().start(&h.config(json!({ "concurrency": 2 }))).unwrap();
    assert!(settled(&h, 2, &counts(&[("default", 2)])), "{:?}", h.running());
    assert!(h.held().iter().all(|s| s.gpu.is_none() && !s.args.iter().any(|x| x == "-init_hw_device")), "the default path names no GPU");
    assert_eq!(h.service().set_lanes(&id, &json!([{ "device": a, "concurrency": 0 }])).unwrap_err().code.as_deref(), Some("INVALID_LANES"));
    h.service().set_lanes(&id, &json!([{ "device": a, "concurrency": 2 }])).unwrap();
    assert!(settled(&h, 4, &counts(&[("default", 2), (&a, 2)])), "{:?}", h.running());
    let released = release_all_held(&h);
    assert!(until(|| gone(&h, &released) && h.running() == counts(&[(&a, 2)]) && h.held().len() == 2), "{:?}", h.running());
    let done = h.finish_job(&id);
    assert_eq!(done["state"], "completed");
    assert_eq!(done["config"]["lanes"], json!([{ "device": a, "concurrency": 2 }]));

    // lanes for the GPU a job without lanes runs on
    let h = Harness::new(HarnessOptions { clips: 20, ..Default::default() });
    let on_uhd = || h.held().iter().filter(|s| s.gpu.is_none() || s.gpu.as_deref() == Some(UHD_NODE)).count();
    let id = h.service().start(&h.config(json!({ "concurrency": 3 }))).unwrap();
    assert!(settled(&h, 3, &counts(&[("default", 3)])), "{:?}", h.running());
    h.service().set_lanes(&id, &json!([{ "device": u, "concurrency": 3 }, { "device": a, "concurrency": 1 }])).unwrap();
    let want = counts(&[("default", 3), (&a, 1)]);
    assert!(settled(&h, 4, &want), "the Arc starts at once: {:?}", h.running());
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(h.running(), want);
    assert_eq!(on_uhd(), 3);
    let held_on = |gpu: Option<&str>| h.held().iter().filter(|s| s.gpu.as_deref() == gpu).count();
    for lane in 1..=3 {
        let old = h.held().into_iter().find(|s| s.gpu.is_none()).unwrap();
        h.finish(&old);
        let mut want = counts(&[(&u, lane), (&a, 1)]);
        if lane < 3 {
            want.insert("default".into(), 3 - lane);
        }
        // (the released encode gone and its slot taken on the UHD lane, as held here and as the service lists it)
        assert!(
            until(|| gone(&h, &[old.pid.clone()]) && held_on(Some(UHD_NODE)) == lane && held_on(None) == 3 - lane && h.running() == want),
            "{lane} on the UHD lane: {:?}",
            h.running()
        );
        std::thread::sleep(Duration::from_millis(30));
        assert_eq!(on_uhd(), 3, "never more than 3 on the UHD");
        assert_eq!(h.running(), want);
    }
    assert_eq!(h.finish_job(&id)["state"], "completed");
}

#[test]
fn one_number_for_a_job_with_lanes() {
    if !ok_ffmpeg() {
        return;
    }
    let (a, u, t) = (id_of(arc()), id_of(uhd()), id_of(t400()));
    // the T400 is gone: the Arc's lane gets the number
    let h = Harness::new(HarnessOptions { clips: 12, ..Default::default() });
    let id = h.service().start(&h.config(json!({ "lanes": [{ "device": a, "concurrency": 2 }, { "device": t, "concurrency": 2 }] }))).unwrap();
    assert!(until(|| h.held().len() == 2));
    let job = h.service().set_concurrency(&id, &json!(3)).unwrap();
    assert_eq!(job["config"]["lanes"], json!([{ "device": a, "concurrency": 3 }]));
    assert_eq!(job["config"]["concurrency"], 3);
    assert!(settled(&h, 3, &counts(&[(&a, 3)])), "{:?}", h.running());
    assert_eq!(h.finish_job(&id)["state"], "completed");
    drop(h);
    // both GPUs here: no lanes, the UHD (the default GPU) never runs more than 2
    let two = Harness::new(HarnessOptions { clips: 12, ..Default::default() });
    let id = two.service().start(&two.config(json!({ "lanes": [{ "device": u, "concurrency": 1 }, { "device": a, "concurrency": 2 }] }))).unwrap();
    assert!(until(|| two.held().len() == 3));
    let job = two.service().set_concurrency(&id, &json!(2)).unwrap();
    assert!(job["config"].get("lanes").is_none());
    assert_eq!(job["config"]["concurrency"], 2);
    let want = counts(&[(&u, 1), (&a, 2), ("default", 1)]);
    assert!(settled(&two, 4, &want), "{:?}", two.running());
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(two.running(), want);
    for s in two.held().into_iter().filter(|s| s.gpu.is_some()) {
        two.finish(&s);
    }
    assert!(until(|| two.running() == counts(&[("default", 2)])), "{:?}", two.running());
    let done = two.finish_job(&id);
    assert_eq!(done["state"], "completed");
    assert!(done["config"].get("lanes").is_none());
}

#[test]
fn a_lane_whose_gpu_is_missing_is_skipped_and_with_none_found_the_job_runs_as_before() {
    if !ok_ffmpeg() {
        return;
    }
    let h = Harness::new(HarnessOptions { clips: 8, devices: vec![arc(), cpu()], ..Default::default() });
    let a = id_of(arc());
    let id = h.service().start(&h.config(json!({ "lanes": [{ "device": a, "concurrency": 1 }, { "device": MISSING, "concurrency": 3 }] }))).unwrap();
    assert!(settled(&h, 1, &counts(&[(&a, 1)])), "{:?}", h.running());
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(h.running(), counts(&[(&a, 1)]));
    assert_eq!(h.service().get(&id).unwrap()["config"]["concurrency"], 4);
    assert_eq!(h.service().slots_of(&id), Some(1));
    assert_eq!(h.service().slots_of("no-such-job"), None);
    h.service().set_lanes(&id, &json!([{ "device": MISSING, "concurrency": 2 }])).unwrap();
    for s in h.held() {
        h.finish(&s);
    }
    assert!(until(|| h.held().len() == 2 && h.running() == counts(&[("default", 2)])), "{:?}", h.running());
    assert_eq!(h.service().slots_of(&id), Some(2));
    assert!(h.held().iter().all(|s| s.gpu.is_none()));
    assert_eq!(h.finish_job(&id)["state"], "completed");
}

#[test]
fn a_job_without_lanes_keeps_its_arguments_and_one_gpus_broken_decode_stays_its_own() {
    if !ok_ffmpeg() {
        return;
    }
    // the default GPU encodes through QSV, decoded with VA-API on renderD128
    let h = Harness::new(HarnessOptions { clips: 1, hold: false, ..Default::default() });
    let id = h.service().start(&h.config(json!({ "concurrency": 1 }))).unwrap();
    assert_eq!(h.finish_job(&id)["state"], "completed");
    let args = &h.spawned()[0].args;
    assert_eq!(&args[..10], &["-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-hwaccel", "vaapi", "-hwaccel_device", "/dev/dri/renderD128", "-i"]);
    assert_eq!(&args[11..13], &["-c:v", "hevc_qsv"]);
    assert!(h.resolved.lock().unwrap().is_empty(), "no device is looked up");
    drop(h);
    // NVIDIA as the default: zero-copy decode, no GPU index
    let works: Works = Arc::new(|e: &str, _a: &[String]| Some(e == "hevc_nvenc" || e.starts_with("lib")));
    let h = Harness::new(HarnessOptions { clips: 1, hold: false, works, ..Default::default() });
    let id = h.service().start(&h.config(json!({ "concurrency": 1 }))).unwrap();
    h.finish_job(&id);
    let args = &h.spawned()[0].args;
    assert_eq!(&args[..9], &["-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-hwaccel", "cuda", "-hwaccel_output_format", "cuda"]);
    assert_eq!(&args[11..13], &["-c:v", "hevc_nvenc"]);
    assert!(!args.iter().any(|a| a == "-gpu" || a == "-hwaccel_device"));
    drop(h);
    // decoding on the Arc fails; the UHD keeps decoding on its GPU
    let h = Harness::new(HarnessOptions { clips: 6, hold: false, ..Default::default() });
    fs::write(h.ctl.join("fail-if"), format!("-hwaccel_device {ARC_NODE}")).unwrap();
    let (a, u) = (id_of(arc()), id_of(uhd()));
    let id = h.service().start(&h.config(json!({ "lanes": [{ "device": a, "concurrency": 1 }, { "device": u, "concurrency": 1 }] }))).unwrap();
    let done = h.finish_job(&id);
    every_clip_encoded(&h, &done, 6);
    let all = h.spawned();
    let on_arc: Vec<&Spawned> = all.iter().filter(|s| s.gpu.as_deref() == Some(ARC_NODE)).collect();
    let on_uhd: Vec<&Spawned> = all.iter().filter(|s| s.gpu.as_deref() == Some(UHD_NODE)).collect();
    assert!(on_arc.len() >= 2 && !on_uhd.is_empty());
    assert!(on_arc[0].args.iter().any(|x| x == "-hwaccel"), "tried with GPU decoding first");
    assert!(on_arc[2..].iter().all(|s| !s.args.iter().any(|x| x == "-hwaccel")), "then the Arc decodes on the CPU");
    assert!(on_uhd.iter().all(|s| s.args.iter().any(|x| x == "-hwaccel") && s.args.iter().any(|x| x == UHD_NODE)));
}

#[test]
fn a_gpu_that_cannot_encode_the_codec_uses_the_cpu_encoder_for_its_lane() {
    if !ok_ffmpeg() {
        return;
    }
    let h = Harness::new(HarnessOptions { clips: 4, ..Default::default() });
    let (a, u) = (id_of(arc()), id_of(uhd()));
    let id = h.service().start(&h.config(json!({ "codec": "av1", "lanes": [{ "device": u, "concurrency": 1 }, { "device": a, "concurrency": 1 }] }))).unwrap();
    assert!(until(|| h.held().len() == 2 && h.service().active_encodes().len() == 2));
    let live = h.service().active_encodes();
    let on = |d: &str| live.iter().find(|e| e["deviceId"] == d).cloned().unwrap();
    let (lu, la) = (on(&u), on(&a));
    assert_eq!(json!([lu["encoder"], lu["hardware"], lu["device"], lu["decode"]]), json!(["libsvtav1", false, null, "cpu"]));
    assert_eq!(json!([la["encoder"], la["hardware"], la["device"]]), json!(["av1_qsv", true, ARC_NODE]));
    assert_eq!(h.finish_job(&id)["state"], "completed");
}

// ---- the runtime's device list

fn registry(devices: Vec<Value>, works: Works) -> (Registry, Arc<FakeProbe>) {
    let probe = Arc::new(FakeProbe { works, calls: AtomicUsize::new(0), advertised: None });
    let planner: Arc<dyn Encoders> = Arc::new(Planner::new(probe.clone(), "linux", "ffmpeg"));
    let mut d = Discovery::new(None);
    d.fixed = Some(Arc::new(move || devices.clone()));
    (Registry::new(d, planner), probe)
}

#[test]
fn a_device_list_without_the_paired_nodes_is_an_error_and_never_kept_as_the_list() {
    let (mut r, _) = registry(vec![uhd(), cpu()], desktop_works());
    let unreadable = Arc::new(AtomicBool::new(true));
    let u = unreadable.clone();
    let node = json!({ "id": "node:abcdefabcdef@cpu", "kind": "node", "nodeId": "abcdefabcdef", "name": "garage · CPU", "slots": 1, "online": true, "encoders": { "h265": "libx265", "av1": null } });
    r.remote_nodes = Some(Arc::new(move || if u.load(Ordering::SeqCst) { Err("Internal error".into()) } else { Ok(vec![node.clone()]) }));
    assert!(r.devices().is_err(), "not this server's devices alone, answered as the list");
    assert!(r.recent().is_err());
    assert_eq!(r.resolve_device(uhd()["id"].as_str().unwrap()), Some(uhd()), "a job still finds this server's own devices");
    let r = Arc::new(r);
    let auto = crate::converter::runtime::auto_devices(r.clone())().unwrap();
    assert_eq!(auto.iter().map(|d| d["id"].clone()).collect::<Vec<_>>(), [uhd()["id"].clone(), cpu()["id"].clone()], "automatic jobs keep this server's own devices");
    unreadable.store(false, Ordering::SeqCst);
    let ids: Vec<Value> = r.recent().unwrap().iter().map(|d| d["id"].clone()).collect();
    assert!(ids.contains(&json!("node:abcdefabcdef@cpu")), "the failed look-up kept nothing: {ids:?}");
}

#[test]
fn devices_list_each_device_with_its_proved_encoder_and_the_default_device() {
    let (r, probe) = registry(vec![uhd(), arc(), t400(), cpu()], desktop_works());
    assert_eq!(probe.calls.load(Ordering::SeqCst), 0, "nothing is probed until something asks");
    let out = r.devices().unwrap();
    let got: Vec<Value> = out["devices"].as_array().unwrap().iter().map(|d| json!([d["id"], d["name"], d["encoders"]])).collect();
    assert_eq!(got, vec![
        json!([uhd()["id"], uhd()["name"], { "h265": "hevc_qsv", "av1": null }]),
        json!([arc()["id"], arc()["name"], { "h265": "hevc_qsv", "av1": "av1_qsv" }]),
        json!([t400()["id"], t400()["name"], { "h265": "hevc_nvenc", "av1": "av1_nvenc" }]),
        json!(["cpu", cpu()["name"], { "h265": "libx265", "av1": "libsvtav1" }]),
    ]);
    assert_eq!(out["devices"][1]["node"], ARC_NODE);
    assert_eq!(out["defaultDevice"], uhd()["id"]);
    assert_eq!(out["defaultDevices"], json!({ "h265": uhd()["id"], "av1": "cpu" }));
    let probed = probe.calls.load(Ordering::SeqCst);
    r.devices().unwrap();
    assert_eq!(probe.calls.load(Ordering::SeqCst), probed, "later calls are instant");
    assert_eq!(r.lookups.load(Ordering::SeqCst), 2, "looked up again each time");
    assert_eq!(r.resolve_device(arc()["id"].as_str().unwrap()), Some(arc()));
    assert_eq!(r.resolve_device("/dev/dri/renderD129"), None, "never a node path");
    assert_eq!(r.resolve_device(MISSING), None);

    let works: Works = { let d = desktop_works(); Arc::new(move |e: &str, a: &[String]| if e.ends_with("_nvenc") { Some(true) } else { d(e, a) }) };
    let (r, _) = registry(vec![arc(), t400(), cpu()], works);
    assert_eq!(r.devices().unwrap()["defaultDevice"], t400()["id"], "NVENC without a device is index 0");
    let (r, probe) = registry(vec![cpu()], Arc::new(|e: &str, _a: &[String]| Some(e.starts_with("lib"))));
    let mut c = cpu();
    c["encoders"] = Value::Null;
    assert_eq!(r.devices().unwrap(), json!({ "devices": [c], "defaultDevice": null, "defaultDevices": null }));
    assert_eq!(probe.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn devices_with_one_gpu_test_nothing_and_a_busy_or_slow_gpu_is_not_ruled_out() {
    let (r, probe) = registry(vec![uhd(), cpu()], desktop_works());
    let (mut a, mut b) = (uhd(), cpu());
    a["encoders"] = Value::Null;
    b["encoders"] = Value::Null;
    assert_eq!(r.devices().unwrap(), json!({ "devices": [a, b], "defaultDevice": null, "defaultDevices": null }));
    assert_eq!(probe.calls.load(Ordering::SeqCst), 0);

    let (r, probe) = registry(vec![uhd(), arc(), cpu()], desktop_works());
    let busy = Arc::new(AtomicBool::new(true));
    let b2 = busy.clone();
    *r.encoding_now.lock().unwrap() = Some(Arc::new(move || b2.load(Ordering::SeqCst)));
    let out = r.devices().unwrap();
    assert_eq!(probe.calls.load(Ordering::SeqCst), 0, "a GPU converting now is not tested");
    assert_eq!(out["devices"].as_array().unwrap().iter().map(|d| d["encoders"].clone()).collect::<Vec<_>>(), vec![json!({}), json!({}), json!({})]);
    assert_eq!(out["defaultDevices"], json!({ "h265": null, "av1": null }));
    busy.store(false, Ordering::SeqCst);
    let out = r.devices().unwrap();
    assert_eq!(out["devices"].as_array().unwrap().iter().map(|d| d["encoders"].clone()).collect::<Vec<_>>(), vec![json!({ "h265": "hevc_qsv", "av1": null }), json!({ "h265": "hevc_qsv", "av1": "av1_qsv" }), json!({ "h265": "libx265", "av1": "libsvtav1" })]);

    let slow = Arc::new(AtomicBool::new(true));
    let s2 = slow.clone();
    let d = desktop_works();
    let works: Works = Arc::new(move |e: &str, a: &[String]| {
        if s2.load(Ordering::SeqCst) && e == "hevc_qsv" && a.iter().any(|x| x == &format!("qsv=qsvenc:hw_any,child_device={ARC_NODE}")) {
            None
        } else {
            d(e, a)
        }
    });
    let (r, _) = registry(vec![uhd(), arc(), cpu()], works);
    assert_eq!(r.devices().unwrap()["devices"][1]["encoders"], json!({ "av1": "av1_qsv" }), "H.265 on the Arc: not known yet");
    slow.store(false, Ordering::SeqCst);
    assert_eq!(r.devices().unwrap()["devices"][1]["encoders"], json!({ "h265": "hevc_qsv", "av1": "av1_qsv" }));
}

#[test]
fn the_default_device_per_codec_and_nvenc_only_when_one_nvidia_gpu_can() {
    let mut arc0 = arc();
    arc0["node"] = json!(UHD_NODE);
    let node = UHD_NODE.to_string();
    let works: Works = Arc::new(move |e: &str, a: &[String]| {
        if e.starts_with("lib") {
            return Some(true);
        }
        let g = gpu_of(a);
        if e.ends_with("_qsv") {
            return Some(g.is_none() || g.as_deref() == Some(node.as_str()));
        }
        Some(e == "hevc_nvenc" && (g.is_none() || g.as_deref() == Some("nvidia0")))
    });
    let (r, _) = registry(vec![arc0.clone(), t400(), cpu()], works);
    let out = r.devices().unwrap();
    assert_eq!(out["defaultDevices"], json!({ "h265": t400()["id"], "av1": arc0["id"] }));
    let mut rtx = t400();
    rtx["id"] = json!("pci:0000:02:00.0");
    rtx["pci"] = json!("0000:02:00.0");
    rtx["index"] = json!(1);
    let (r, _) = registry(vec![t400(), rtx.clone(), cpu()], Arc::new(|e: &str, _a: &[String]| Some(e.starts_with("lib") || e == "hevc_nvenc")));
    assert_eq!(r.devices().unwrap()["defaultDevices"]["h265"], Value::Null);
    let (r, _) = registry(vec![t400(), rtx.clone(), cpu()], Arc::new(|e: &str, a: &[String]| Some(e.starts_with("lib") || (e == "hevc_nvenc" && gpu_of(a).as_deref() != Some("nvidia0")))));
    assert_eq!(r.devices().unwrap()["defaultDevices"]["h265"], rtx["id"]);
}

#[test]
fn lanes_find_their_gpus_with_one_lookup_and_callers_share_it() {
    let calls = Arc::new(AtomicUsize::new(0));
    let c2 = calls.clone();
    let probe = Arc::new(FakeProbe { works: Arc::new(|e: &str, _a: &[String]| Some(e.starts_with("lib"))), calls: AtomicUsize::new(0), advertised: None });
    let mut d = Discovery::new(None);
    let slow = Arc::new(AtomicBool::new(true));
    let s2 = slow.clone();
    d.fixed = Some(Arc::new(move || {
        c2.fetch_add(1, Ordering::SeqCst);
        if s2.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(2_200));
        }
        vec![uhd(), arc(), cpu()]
    }));
    let r = Arc::new(Registry::new(d, Arc::new(Planner::new(probe, "linux", "ffmpeg"))));
    let found: Vec<Option<Value>> = [uhd()["id"].clone(), arc()["id"].clone(), json!("cpu")].iter().map(|id| r.resolve_device(id.as_str().unwrap())).collect();
    assert_eq!(found, vec![Some(uhd()), Some(arc()), Some(cpu())]);
    assert_eq!(calls.load(Ordering::SeqCst), 1, "one lookup for the three lanes");
    slow.store(false, Ordering::SeqCst);
    calls.store(0, Ordering::SeqCst);
    std::thread::scope(|s| {
        let r1 = r.clone();
        let r2 = r.clone();
        let r3 = r.clone();
        s.spawn(move || r1.devices().unwrap());
        s.spawn(move || r2.devices().unwrap());
        s.spawn(move || r3.resolve_device(arc()["id"].as_str().unwrap()));
    });
    assert!(calls.load(Ordering::SeqCst) <= 2);
    let _ = Path::new("");
}

#[test]
fn smallest_encodes_every_clip_with_libx265_here_never_on_its_gpu_lanes() {
    if !ok_ffmpeg() {
        return;
    }
    let h = Harness::new(HarnessOptions { clips: 4, hold: false, verify_ok: true, ..Default::default() });
    let (a, u) = (id_of(arc()), id_of(uhd()));
    let smallest = |over: Value| {
        let mut c = h.config(over);
        c.as_object_mut().unwrap().remove("bitrateKbps");
        c
    };
    assert!(h.service().start(&smallest(json!({ "profileId": "smallest", "codec": "av1" }))).is_err(), "H.265 only");
    let id = h.service().start(&smallest(json!({ "profileId": "smallest", "concurrency": 2, "lanes": [{ "device": a, "concurrency": 1 }, { "device": u, "concurrency": 1 }] }))).unwrap();
    let done = h.finish_job(&id);
    assert_eq!(done["state"], "completed");
    every_clip_encoded(&h, &done, 4);
    let spawned = h.spawned();
    assert_eq!(spawned.len(), 4);
    for s in &spawned {
        let at = |k: &str| s.args.iter().position(|x| x == k).unwrap();
        assert_eq!(s.args[at("-c:v") + 1], "libx265");
        // 4,000 bytes in 2 s: 16 kbit/s, so 9.6 kbit/s at most
        assert_eq!(&s.args[at("-crf")..at("-crf") + 6], &["-crf", "27", "-maxrate", "9600", "-bufsize", "19200"]);
        assert!(!s.args.iter().any(|x| x == "-bf") && s.args.iter().any(|x| x == "+negative_cts_offsets"));
        assert_eq!(s.gpu, None, "{:?}", s.args);
    }
}

#[test]
fn a_running_smallest_job_refuses_lanes() {
    if !ok_ffmpeg() {
        return;
    }
    let h = Harness::new(HarnessOptions { clips: 2, ..Default::default() });
    let mut c = h.config(json!({ "profileId": "smallest" }));
    c.as_object_mut().unwrap().remove("bitrateKbps");
    let id = h.service().start(&c).unwrap();
    assert!(until(|| h.held().len() == 1), "one encode at once");
    let refused = h.service().set_lanes(&id, &json!([{ "device": id_of(arc()), "concurrency": 1 }])).unwrap_err();
    assert_eq!(refused.code.as_deref(), Some("INVALID_LANES"));
    let job = h.service().set_concurrency(&id, &json!(2)).unwrap();
    assert_eq!((&job["config"]["concurrency"], job["config"].get("lanes")), (&json!(2), None));
    assert_eq!(h.finish_job(&id)["state"], "completed");
}
