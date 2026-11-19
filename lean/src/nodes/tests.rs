//! Ports of test/nodes.test.js, the nodes parts of server.test.js and
//! reportsHeartbeatNodes.test.js, and the parity runs with Node
//! (lean/parity/nodes.js). The end-to-end ones need openssl and ffmpeg with
//! libx264 and libx265 (and node for parity); they say "skipped" without.

use super::benchmark::{pick_samples, suggest, NodeBenchmark};
use super::cancel::Cancel;
use super::client::{request, Body, Options, Target};
use super::ctx::{Level, NodesCtx, Vehicle, WorkerRuntime};
use super::main_side::{parse_address, take_upload_slot, EncodeRequest, Nodes};
use super::picture::{compare_pictures, ffmpeg_decoder, judge_frames, DecodeOptions, RunDecode, Shifts, H, W};
use super::routes::{ApiOptions, NodesApi, Request};
use super::serve::{serve, Handler, Server};
use super::worker::{parse_job_settings, JobSettings, NodeWorker, Spawn, WorkerOptions};
use super::*;
use crate::converter::planner::{Device, Selected};
use crate::ops::ctx::Caller;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// ---- stand-ins

pub struct MemCtx {
    pub settings: Mutex<HashMap<String, Value>>,
    pub audits: Mutex<Vec<String>>,
    pub logs: Mutex<Vec<String>>,
    pub runtime: Mutex<Option<Arc<dyn WorkerRuntime>>>,
    pub vehicles: Mutex<Vec<Vehicle>>,
    pub authority: Mutex<Option<String>>,
    pub data: PathBuf,
    pub tls: bool,
}

impl MemCtx {
    pub fn new(data: &Path) -> Arc<MemCtx> {
        Arc::new(MemCtx { settings: Mutex::new(HashMap::new()), audits: Mutex::new(vec![]), logs: Mutex::new(vec![]), runtime: Mutex::new(None), vehicles: Mutex::new(vec![]), authority: Mutex::new(None), data: data.into(), tls: true })
    }
    pub fn get(&self, k: &str) -> Value {
        self.settings.lock().unwrap().get(k).cloned().unwrap_or(Value::Null)
    }
    pub fn set(&self, k: &str, v: Value) {
        self.settings.lock().unwrap().insert(k.into(), v);
    }
}

impl NodesCtx for MemCtx {
    fn setting(&self, key: &str) -> Option<Value> {
        self.settings.lock().unwrap().get(key).cloned()
    }
    fn set_setting(&self, key: &str, value: &Value) {
        self.settings.lock().unwrap().insert(key.into(), value.clone());
    }
    fn audit(&self, level: Level, line: &str) {
        self.audits.lock().unwrap().push(format!("{level:?} {line}"));
    }
    fn log(&self, _level: Level, line: &str) {
        self.logs.lock().unwrap().push(line.into());
    }
    fn hostname(&self) -> String {
        "garage-pc".into()
    }
    fn tls_available(&self) -> bool {
        self.tls
    }
    fn authority_pem(&self) -> Option<String> {
        self.authority.lock().unwrap().clone()
    }
    fn vehicles(&self) -> Vec<Vehicle> {
        self.vehicles.lock().unwrap().clone()
    }
    fn data_path(&self) -> PathBuf {
        self.data.clone()
    }
    fn runtime(&self) -> Option<Arc<dyn WorkerRuntime>> {
        self.runtime.lock().unwrap().clone()
    }
}

fn sel(family: &str, codec: &str, hardware: bool, device: Option<Device>) -> Selected {
    Selected { family: family.into(), codec: codec.into(), hardware, remote: false, timed_out: false, device }
}

fn soft(family: &str) -> &'static str {
    if family == "h265" { "libx265" } else { "libsvtav1" }
}

/// startWorker's runtime: software encoders, no device list (an older node).
struct SoftRuntime;
impl WorkerRuntime for SoftRuntime {
    fn select_encoder(&self, f: &str) -> Result<Option<Selected>, String> {
        Ok(Some(sel(f, soft(f), false, None)))
    }
    fn cpu_encoder(&self, f: &str) -> Result<Selected, String> {
        Ok(sel(f, soft(f), false, None))
    }
}

fn node_gpu() -> Device {
    Device { id: "pci:0000:03:00.0".into(), kind: "dri".into(), vendor: Some("intel".into()), name: Some("Intel Arc A380".into()), node: Some("/dev/dri/renderD129".into()), index: None, ..Default::default() }
}
fn node_cpu() -> Device {
    Device { id: "cpu".into(), kind: "cpu".into(), name: Some("CPU (software encoder)".into()), ..Default::default() }
}

/// deviceRuntime: an Intel GPU (H.265 over VA-API, no AV1) and the CPU.
#[derive(Default)]
struct DeviceRuntime {
    asked: Mutex<Vec<(String, String)>>,
    gpu: bool,
}
impl WorkerRuntime for DeviceRuntime {
    fn select_encoder(&self, f: &str) -> Result<Option<Selected>, String> {
        if self.gpu {
            return Ok(Some(sel(f, "hevc_vaapi", true, Some(Device { node: Some("/dev/dri/renderD128".into()), ..Default::default() }))));
        }
        Ok(Some(sel(f, soft(f), false, None)))
    }
    fn cpu_encoder(&self, f: &str) -> Result<Selected, String> {
        Ok(sel(f, soft(f), false, None))
    }
    fn local_devices(&self) -> Option<Result<Vec<Device>, String>> {
        Some(Ok(vec![node_gpu(), node_cpu()]))
    }
    fn select_encoder_for(&self, f: &str, d: &Device, probe: bool) -> Option<Result<Option<Selected>, String>> {
        if probe {
            self.asked.lock().unwrap().push((f.into(), d.id.clone()));
        }
        let short = Device { id: d.id.clone(), kind: d.kind.clone(), node: d.node.clone(), ..Default::default() };
        Some(Ok(Some(if f == "h265" && d.id == node_gpu().id { sel(f, "hevc_vaapi", true, Some(short)) } else { sel(f, soft(f), false, Some(short)) })))
    }
}

/// A worker that has no GPU here: VA-API arguments are recorded, then run with libx265.
fn gpu_stand_in(seen: Arc<Mutex<Vec<Vec<String>>>>) -> Spawn {
    Arc::new(move |cmd: &str, args: &[String]| {
        seen.lock().unwrap().push(args.to_vec());
        let mut out = Vec::new();
        let mut i = 0;
        while i < args.len() {
            let a = &args[i];
            if ["-hwaccel", "-hwaccel_device", "-vaapi_device"].contains(&a.as_str()) {
                i += 2;
                continue;
            }
            if a == "-vf" && args.get(i + 1).map(String::as_str) == Some("format=nv12,hwupload") {
                i += 2;
                continue;
            }
            out.push(if a == "hevc_vaapi" { "libx265".to_string() } else { a.clone() });
            i += 1;
        }
        Command::new(cmd).args(out).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn()
    })
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("sm-nodes-{name}-{}-{}", std::process::id(), hex(&random_bytes(4))));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn ok(cmd: &str, args: &[&str]) -> bool {
    Command::new(cmd).args(args).output().is_ok_and(|o| o.status.success())
}

fn has_tools() -> bool {
    ok("openssl", &["version"]) && ok("ffmpeg", &["-version"]) && ok("ffprobe", &["-version"])
}

/// A certificate authority and a certificate it issued for 127.0.0.1 (as TlsManager makes).
pub struct Material {
    pub key: Vec<u8>,
    pub cert: Vec<u8>,
    pub ca: String,
}

pub fn certs(dir: &Path, name: &str) -> Material {
    let d = dir.join(name);
    std::fs::create_dir_all(&d).unwrap();
    let run = |args: &[&str]| assert!(Command::new("openssl").args(args).current_dir(&d).output().unwrap().status.success(), "openssl {args:?}");
    run(&["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "30", "-subj", &format!("/CN={name} CA"),
        "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
    run(&["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=127.0.0.1"]);
    std::fs::write(d.join("ext"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\n").unwrap();
    run(&["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "30", "-extfile", "ext"]);
    Material { key: std::fs::read(d.join("server.key")).unwrap(), cert: std::fs::read(d.join("server.crt")).unwrap(), ca: std::fs::read_to_string(d.join("ca.crt")).unwrap() }
}

pub struct W8 {
    pub worker: NodeWorker,
    pub server: Server,
    pub ctx: Arc<MemCtx>,
    pub port: u16,
    pub seen: Arc<Mutex<Vec<Vec<String>>>>,
}

impl W8 {
    fn close(&self) {
        self.server.close();
        self.worker.close();
    }
}

fn start_worker_on(dir: &Path, m: &Material, port: u16, ctx: Arc<MemCtx>, runtime: Arc<dyn WorkerRuntime>, devices: bool) -> W8 {
    *ctx.runtime.lock().unwrap() = Some(runtime);
    *ctx.authority.lock().unwrap() = Some(m.ca.clone());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let spawn = devices.then(|| gpu_stand_in(seen.clone()));
    let worker = NodeWorker::new(ctx.clone(), WorkerOptions { work_dir: dir.join("work"), name: Some("garage-pc".into()), spawn });
    let w = worker.clone();
    let handler: Handler = Arc::new(move |r| w.handle(r).unwrap_or_else(|| super::worker::WorkerReply::json(404, &json!({}))));
    let mut server = None;
    for _ in 0..100 {
        match serve(&m.cert, &m.key, port, handler.clone()) {
            Ok(s) => {
                server = Some(s);
                break;
            }
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    let server = server.expect("listening");
    let port = server.port;
    W8 { worker, server, ctx, port, seen }
}

fn start_worker(dir: &Path, m: &Material) -> W8 {
    start_worker_on(dir, m, 0, MemCtx::new(dir), Arc::new(SoftRuntime), false)
}

fn start_device_worker(dir: &Path, m: &Material, port: u16, ctx: Arc<MemCtx>) -> W8 {
    start_worker_on(dir, m, port, ctx, Arc::new(DeviceRuntime::default()), true)
}

fn main_nodes(dir: &Path) -> (Nodes, Arc<MemCtx>) {
    let ctx = MemCtx::new(dir);
    (Nodes::new(ctx.clone(), Some("main-nas".into()), Some(100)), ctx)
}

fn clip(dir: &Path, name: &str, seconds: u32) -> PathBuf {
    let p = dir.join(name);
    let out = Command::new("ffmpeg").args(["-v", "error", "-y", "-f", "lavfi", "-i", &format!("testsrc2=size=320x240:rate=12:duration={seconds}"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "12"]).arg(&p).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    p
}

fn codec_of(p: &Path) -> String {
    let o = Command::new("ffprobe").args(["-v", "error", "-select_streams", "v", "-show_entries", "stream=codec_name", "-of", "csv=p=0"]).arg(p).output().unwrap();
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

fn raw(port: u16, token: Option<&str>, method: &str, path: &str, headers: Vec<(String, String)>, body: Option<Vec<u8>>) -> (u16, Value) {
    let t = Target { host: "127.0.0.1".into(), port, token: token.map(String::from), pin: None };
    let a = request(&t, Options { method, headers, body: body.map(Body::Bytes).unwrap_or(Body::None), ..Options::get(path, 30_000) }).unwrap();
    (a.status, a.json)
}

fn work_files(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir.join("work")).map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default()
}

fn wait_empty(dir: &Path) {
    for _ in 0..100 {
        if work_files(dir).is_empty() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn enc(device: &str, source: &Path, target: &Path) -> EncodeRequest {
    EncodeRequest { device: device.into(), source: source.into(), target: target.into(), codec: "h265".into(), bitrate: Some(400_000.0), quality: None, hold_frames: 0, duration_us: Some(2e6), benchmark: false }
}

fn encode_code(nodes: &Nodes, r: EncodeRequest) -> Option<i32> {
    nodes.encode(r).unwrap().wait().0
}

// ---- the unit tests

#[test]
fn addresses_host_and_port_nothing_else() {
    assert_eq!(parse_address(&json!("192.168.1.30")), Some(("192.168.1.30".into(), 9000)));
    assert_eq!(parse_address(&json!("https://nas.local:9443/")), Some(("nas.local".into(), 9443)));
    assert_eq!(parse_address(&json!("[fd00::5]:9001")), Some(("fd00::5".into(), 9001)));
    for bad in ["", "a b", "host:99999", "user@host", "host;rm -rf /"] {
        assert_eq!(parse_address(&json!(bad)), None, "{bad}");
    }
}

#[test]
fn encode_settings_are_fixed_choices() {
    let p = |v: Value| parse_job_settings(Some(&v.to_string()));
    assert_eq!(p(json!({ "codec": "h265", "bitrate": 3_000_000, "holdFrames": 2 })), Some(JobSettings { codec: "h265".into(), bitrate: Some(3_000_000), quality: None, hold_frames: 2, duration_us: None, device: None }));
    assert_eq!(p(json!({ "codec": "h265", "bitrate": 3_000_000, "holdFrames": 2 })).unwrap().to_json(), json!({ "codec": "h265", "bitrate": 3_000_000, "quality": null, "holdFrames": 2, "durationUs": null }));
    assert_eq!(p(json!({ "codec": "av1", "quality": "balanced" })).unwrap().quality.as_deref(), Some("balanced"));
    for bad in [json!({ "codec": "h264", "bitrate": 3e6 }), json!({ "codec": "h265" }), json!({ "codec": "h265", "bitrate": 3e6, "quality": "high" }), json!({ "codec": "h265", "bitrate": 10 }),
        json!({ "codec": "h265", "quality": "max" }), json!({ "codec": "h265", "bitrate": 3e6, "args": ["-f", "lavfi"] }), json!({ "codec": "h265", "bitrate": 3e6, "holdFrames": -1 })] {
        assert_eq!(p(bad.clone()), None, "{bad}");
    }
    assert_eq!(parse_job_settings(Some("nope")), None);
    // the device: one of the node's own, and nothing else
    assert_eq!(p(json!({ "codec": "h265", "bitrate": 3e6, "device": "cpu" })).unwrap().device.as_deref(), Some("cpu"));
    assert_eq!(p(json!({ "codec": "h265", "bitrate": 3e6, "device": "pci:0000:03:00.0" })).unwrap().device.as_deref(), Some("pci:0000:03:00.0"));
    for d in [json!("node:abcdefabcdef"), json!("pci:0000:03:00.8"), json!("/dev/dri/renderD128"), json!("nvidia0"), json!("CPU"), json!(""), json!(7), json!(["cpu"])] {
        assert_eq!(p(json!({ "codec": "h265", "bitrate": 3e6, "device": d })), None, "{d}");
    }
}

fn seeded(ctx: &MemCtx, nodes: Value) {
    ctx.set("nodes", nodes);
}

#[test]
fn a_node_can_be_renamed_empty_names_refused() {
    let dir = tmp("rename");
    let (nodes, ctx) = main_nodes(&dir);
    seeded(&ctx, json!([{ "id": "abcdefghijkl", "name": "garage-pc", "host": "10.0.0.5", "port": 9000, "token": "t".repeat(43), "pin": { "fingerprint": "00" } }]));
    let (prev, name) = nodes.rename("abcdefghijkl", &json!("  Garage 4070 Ti\n")).unwrap().unwrap();
    assert_eq!((prev, name.as_str()), (json!("garage-pc"), "Garage 4070 Ti"));
    assert_eq!(ctx.get("nodes")[0]["name"], json!("Garage 4070 Ti"));
    assert_eq!(ctx.get("nodes")[0]["token"], json!("t".repeat(43)));
    for bad in [json!("   "), json!(5), json!(["x"]), json!({ "name": "x" }), Value::Null] {
        assert_eq!(nodes.rename("abcdefghijkl", &bad).unwrap_err().message, "Enter a name.");
    }
    assert_eq!(ctx.get("nodes")[0]["name"], json!("Garage 4070 Ti"));
    assert!(nodes.rename("nope", &json!("x")).unwrap().is_none());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_removed_vehicle_leaves_every_node_list() {
    let dir = tmp("cars");
    let (nodes, ctx) = main_nodes(&dir);
    let node = |id: &str, cars: Value| {
        let mut n = json!({ "id": id, "name": id, "host": "10.0.0.5", "port": 9000, "token": "t".repeat(43), "pin": { "fingerprint": "00" } });
        if !cars.is_null() {
            n["cars"] = cars;
        }
        n
    };
    seeded(&ctx, json!([node("aaaaaaaaaaaa", json!(["car-a", "car-b"])), node("bbbbbbbbbbbb", json!(["car-b"])), node("cccccccccccc", Value::Null)]));
    nodes.forget_car("car-b");
    let cars: Vec<Value> = ctx.get("nodes").as_array().unwrap().iter().map(|n| n.get("cars").cloned().unwrap_or(Value::Null)).collect();
    assert_eq!(cars, vec![json!(["car-a"]), json!([]), Value::Null]);
    assert_eq!(nodes.car_lists().into_iter().collect::<Vec<_>>(), vec![("node:aaaaaaaaaaaa".to_string(), vec!["car-a".to_string()])]);
    // the converter's priorities: each vehicle's TeslaCam folder
    *ctx.vehicles.lock().unwrap() = vec![Vehicle { id: "car-a".into(), studio_root: Some("/cars/a/TeslaCam".into()) }];
    let p = super::lanes::RemoteNodes::priorities(&nodes);
    assert_eq!(p.into_iter().collect::<Vec<_>>(), vec![("node:aaaaaaaaaaaa".to_string(), vec!["/cars/a/TeslaCam".to_string()])]);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_node_can_be_marked_trusted() {
    let dir = tmp("trusted");
    let (nodes, ctx) = main_nodes(&dir);
    seeded(&ctx, json!([{ "id": "abcdefghijkl", "name": "garage-pc", "host": "10.0.0.5", "port": 9000, "token": "t".repeat(43), "pin": { "fingerprint": "00" } }]));
    assert!(!nodes.trusted("node:abcdefghijkl"), "off by default");
    assert_eq!(nodes.set_trusted("abcdefghijkl", &json!(true)), Some(true));
    assert!(nodes.trusted("node:abcdefghijkl"));
    assert!(nodes.trusted("node:abcdefghijkl@cpu"), "any lane of the node");
    assert_eq!(nodes.set_trusted("abcdefghijkl", &json!("yes")), Some(false), "only true trusts it");
    assert!(!nodes.trusted("abcdefghijkl"));
    assert_eq!(nodes.set_trusted("nope", &json!(true)), None);
    assert!(!nodes.trusted("node:nope"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn upload_slots_a_waiter_that_gives_up_leaves_the_line() {
    let id = format!("slot-test-{}", hex(&random_bytes(4)));
    let hold = [take_upload_slot(&id, &Cancel::new()).unwrap(), take_upload_slot(&id, &Cancel::new()).unwrap()];
    let quitters = [Cancel::new(), Cancel::new()];
    let gave_up: Vec<_> = quitters.iter().map(|c| {
        let (id, c) = (id.clone(), c.clone());
        std::thread::spawn(move || take_upload_slot(&id, &c).is_none())
    }).collect();
    std::thread::sleep(Duration::from_millis(50));
    for c in &quitters {
        c.abort();
    }
    assert!(gave_up.into_iter().all(|h| h.join().unwrap()));
    let waiting = {
        let id = id.clone();
        std::thread::spawn(move || take_upload_slot(&id, &Cancel::new()).map(|s| s.release()).is_some())
    };
    std::thread::sleep(Duration::from_millis(50));
    for s in hold {
        s.release();
    }
    assert!(waiting.join().unwrap(), "the other job's clip got its upload slot");
    // and never more than two at once, however many wait
    let most = Arc::new(Mutex::new((0, 0)));
    let hs: Vec<_> = (0..6).map(|_| {
        let (id, most) = (id.clone(), most.clone());
        std::thread::spawn(move || {
            let s = take_upload_slot(&id, &Cancel::new()).unwrap();
            {
                let mut m = most.lock().unwrap();
                m.0 += 1;
                m.1 = m.1.max(m.0);
            }
            std::thread::sleep(Duration::from_millis(30));
            most.lock().unwrap().0 -= 1;
            s.release();
        })
    }).collect();
    for h in hs {
        h.join().unwrap();
    }
    assert_eq!(most.lock().unwrap().1, 2);
}

#[test]
fn benchmark_suggests_the_lightest_level_within_5_percent() {
    assert_eq!(suggest(&[(1, 4.0), (2, 7.8), (4, 8.0)]), Some(2));
    assert_eq!(suggest(&[(1, 4.0), (2, 6.0)]), Some(2));
    assert_eq!(suggest(&[(1, 0.0)]), None);
}

#[test]
fn benchmark_samples_are_h264_tesla_clips_newest_first_one_camera_each() {
    let dir = tmp("samples");
    let recent = dir.join("RecentClips");
    std::fs::create_dir_all(&recent).unwrap();
    for n in ["2026-10-20_10-00-00-front.mp4", "2026-10-21_10-00-00-front.mp4", "2026-10-21_10-00-00-back.mp4", "notes.txt", "2026-10-21_10-00-00-front.mov"] {
        std::fs::write(recent.join(n), vec![0u8; 2048]).unwrap();
    }
    let codec = |p: &Path| Some(if p.to_string_lossy().contains("10-20") { "h265" } else { "h264" }.to_string());
    let (files, converted) = pick_samples(&dir, 4, &codec, 1024, 5000);
    let names: Vec<String> = files.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
    assert_eq!(names, vec!["2026-10-21_10-00-00-front.mp4", "2026-10-21_10-00-00-back.mp4"]);
    assert!(!converted);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn benchmark_originals_past_hundreds_of_converted_clips() {
    let dir = tmp("samples2");
    let recent = dir.join("RecentClips");
    let saved = dir.join("SavedClips").join("2026-01-01_00-00-00");
    std::fs::create_dir_all(&recent).unwrap();
    std::fs::create_dir_all(&saved).unwrap();
    for n in 0..600 {
        std::fs::write(recent.join(format!("2026-10-{:02}_10-{:02}-00-front.mp4", 1 + n / 60, n % 60)), vec![0u8; 2048]).unwrap();
    }
    std::fs::write(saved.join("2026-01-01_00-00-00-back.mp4"), vec![0u8; 2048]).unwrap();
    let codec = |p: &Path| Some(if p.to_string_lossy().ends_with("-back.mp4") { "h264" } else { "h265" }.to_string());
    let (files, converted) = pick_samples(&dir, 4, &codec, 1024, 5000);
    assert_eq!(files.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect::<Vec<_>>(), vec!["2026-01-01_00-00-00-back.mp4"]);
    assert!(!converted);
    let (none, conv) = pick_samples(&dir, 4, &|_| Some("h265".into()), 1024, 5000);
    assert_eq!(none.len(), 4);
    assert!(conv, "converted clips stand in when no original is left");
    let _ = std::fs::remove_dir_all(dir);
}

fn frames(n: usize, f: impl Fn(usize, usize, usize) -> i64) -> Vec<u8> {
    let mut out = Vec::with_capacity(n * W * H);
    for k in 0..n {
        for i in 0..W * H {
            out.push((f(k, i % W, i / W) & 255) as u8);
        }
    }
    out
}

#[test]
fn picture_check_real_encodes_pass_shifted_black_frozen_or_other_do_not() {
    let moving = |k: usize, x: usize, y: usize| (x * 3 + y * 2 + k * 5) as i64 + ((x * y + k) % 7) as i64;
    let src = frames(60, moving);
    assert_eq!(judge_frames(&src, &src, Shifts::default())["ok"], json!(true));
    let shifted = frames(60, |k, x, y| moving(k + 6, x, y));
    let r = judge_frames(&src, &shifted, Shifts::default());
    assert_eq!(r["ok"], json!(true));
    assert_eq!(r["shift"], json!(-6));
    assert_eq!(judge_frames(&src, &frames(60, |_, _, _| 0), Shifts::default())["ok"], json!(false), "black");
    assert_eq!(judge_frames(&src, &frames(60, |_, x, y| moving(0, x, y)), Shifts::default())["ok"], json!(false), "one frame frozen");
    assert_eq!(judge_frames(&src, &frames(60, |k, x, y| ((y * 7 + k * 3) ^ x) as i64), Shifts::default())["ok"], json!(false), "other footage");
    assert_eq!(judge_frames(&src, &[], Shifts::default()), json!({ "ok": false, "reason": "no-frames" }));
}

#[test]
fn picture_check_on_a_still_scene_ties_go_to_the_expected_offset() {
    let base: Vec<i64> = (0..W * H).map(|i| ((i / W) * 2 + (i % W)) as i64 % 256).collect();
    let mut seed: u64 = 7;
    let mut rnd = move || {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) as f64 / (1u64 << 31) as f64
    };
    let fps = 36.0;
    let mut failed = 0;
    for _ in 0..5 {
        let mut make = |n: usize| -> Vec<u8> { (0..n * W * H).map(|j| (base[j % (W * H)] + ((rnd() - 0.5) * 6.0).round() as i64).clamp(0, 255) as u8).collect() };
        let (a, b) = (make((60.0 * fps) as usize / 6), make((60.0 * fps) as usize / 6));
        if judge_frames(&a, &b, Shifts::default())["ok"] != json!(true) {
            failed += 1;
        }
    }
    assert_eq!(failed, 0);
}

#[test]
fn the_picture_check_decodes_on_the_gpu_and_on_the_cpu_when_that_fails() {
    let calls: Arc<Mutex<Vec<Vec<String>>>> = Arc::new(Mutex::new(vec![]));
    let ok_on_gpu = Arc::new(Mutex::new(true));
    let run: RunDecode = {
        let (calls, ok_on_gpu) = (calls.clone(), ok_on_gpu.clone());
        Arc::new(move |args: &[String], _limit, _c: &Cancel| {
            calls.lock().unwrap().push(args.to_vec());
            let gpu = args.iter().any(|a| a == "-hwaccel");
            if gpu && !*ok_on_gpu.lock().unwrap() { Err("DECODE_FAILED".into()) } else { Ok(vec![0u8; 4]) }
        })
    };
    let accel: Arc<dyn Fn() -> Option<Vec<String>> + Send + Sync> = Arc::new(|| Some(vec!["-hwaccel".into(), "vaapi".into(), "-hwaccel_device".into(), "/dev/dri/renderD128".into()]));
    let decode = ffmpeg_decoder(run.clone(), Some(accel.clone()));
    let o = DecodeOptions { width: 2, height: 2, ..Default::default() };
    assert_eq!(decode(Path::new("a.mp4"), o, &Cancel::new()).unwrap().len(), 4);
    {
        let c = calls.lock().unwrap();
        assert_eq!(c.len(), 1);
        let hw = c[0].iter().position(|a| a == "-hwaccel").unwrap();
        assert!(hw < c[0].iter().position(|a| a == "-i").unwrap(), "decode arguments go before the input");
    }
    *ok_on_gpu.lock().unwrap() = false;
    calls.lock().unwrap().clear();
    assert_eq!(decode(Path::new("a.mp4"), o, &Cancel::new()).unwrap().len(), 4);
    assert_eq!(calls.lock().unwrap().iter().map(|a| a.contains(&"-hwaccel".to_string())).collect::<Vec<_>>(), vec![true, false], "the CPU decodes it again");
    calls.lock().unwrap().clear();
    ffmpeg_decoder(run, Some(Arc::new(|| None)))(Path::new("a.mp4"), o, &Cancel::new()).unwrap();
    assert_eq!(calls.lock().unwrap().iter().map(|a| a.contains(&"-hwaccel".to_string())).collect::<Vec<_>>(), vec![false], "no GPU: the CPU");
}

#[test]
fn picture_check_with_real_ffmpeg_a_genuine_encode_passes_a_black_one_does_not() {
    if !has_tools() {
        eprintln!("skipped: needs ffmpeg");
        return;
    }
    let dir = tmp("picture");
    let source = clip(&dir, "src.mp4", 2);
    let enc = |name: &str, vf: Option<&str>| {
        let out = dir.join(name);
        let mut c = Command::new("ffmpeg");
        c.args(["-v", "error", "-y", "-i"]).arg(&source);
        if let Some(v) = vf {
            c.args(["-vf", v]);
        }
        assert!(c.args(["-c:v", "libx265", "-b:v", "300k", "-x265-params", "log-level=error", "-an"]).arg(&out).output().unwrap().status.success());
        out
    };
    let decode = ffmpeg_decoder(super::picture::ffmpeg_runner("ffmpeg".into(), Duration::from_secs(600)), None);
    let mut r = || 0.5;
    assert_eq!(compare_pictures(&source, &enc("good.mp4", None), &Cancel::new(), &decode, None, &mut r)["ok"], json!(true));
    assert_eq!(compare_pictures(&source, &enc("black.mp4", Some("drawbox=t=fill:c=black")), &Cancel::new(), &decode, None, &mut r)["ok"], json!(false));
    let missing = compare_pictures(&source, &dir.join("missing.mp4"), &Cancel::new(), &decode, None, &mut r);
    assert_eq!(missing["reason"], json!("decode-failed"));
    // a long clip: three stretches; a fake with the right pictures only at first fails
    let long = clip(&dir, "long.mp4", 30);
    let good = {
        let out = dir.join("long-good.mp4");
        assert!(Command::new("ffmpeg").args(["-v", "error", "-y", "-i"]).arg(&long).args(["-c:v", "libx265", "-b:v", "300k", "-x265-params", "log-level=error:keyint=60", "-an"]).arg(&out).output().unwrap().status.success());
        out
    };
    for edge in [0.0, 0.5, 0.999] {
        let mut e = move || edge;
        let v = compare_pictures(&long, &good, &Cancel::new(), &decode, Some(30.0), &mut e);
        assert_eq!(v["ok"], json!(true), "{v}");
        assert_eq!(v["sampled"], json!(3));
    }
    let fake = {
        let out = dir.join("long-fake.mp4");
        assert!(Command::new("ffmpeg").args(["-v", "error", "-y", "-i"]).arg(&long).args(["-vf", "drawbox=enable=gte(t\\,10):t=fill:c=black", "-c:v", "libx265", "-b:v", "300k", "-x265-params", "log-level=error", "-an"]).arg(&out).output().unwrap().status.success());
        out
    };
    let mut e = || 0.3;
    assert_eq!(compare_pictures(&long, &fake, &Cancel::new(), &decode, Some(30.0), &mut e)["ok"], json!(false));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn encode_with_gpu_only_by_default_the_cpu_too_when_chosen_or_the_cpu_alone() {
    let dir = tmp("use");
    let ctx = MemCtx::new(&dir);
    *ctx.runtime.lock().unwrap() = Some(Arc::new(DeviceRuntime { gpu: true, ..Default::default() }));
    let worker = NodeWorker::new(ctx.clone(), WorkerOptions { work_dir: dir.join("work"), name: None, spawn: None });
    let encoders = || worker.attempts("h265", 0, None).unwrap().into_iter().map(|a| a.encoder).collect::<Vec<_>>();
    assert_eq!(worker.status()["use"], json!("gpu"));
    assert!(!encoders().contains(&"libx265".to_string()), "a GPU clip that fails goes back to the main");
    assert!(encoders().iter().all(|e| e == "hevc_vaapi"));
    worker.set_enabled(true, Some(&json!(2)), Some(&json!("gpu-cpu"))).unwrap();
    assert_eq!(encoders().last().unwrap(), "libx265");
    worker.set_enabled(true, Some(&json!(2)), Some(&json!("cpu"))).unwrap();
    assert_eq!(encoders(), vec!["libx265"]);
    worker.set_enabled(true, Some(&json!(2)), Some(&json!("gpu"))).unwrap();
    *ctx.runtime.lock().unwrap() = Some(Arc::new(DeviceRuntime::default()));
    assert_eq!(encoders(), vec!["libx265"], "no GPU: the CPU");
    assert_eq!(worker.set_enabled(true, Some(&json!(2)), Some(&json!("npu"))).unwrap_err().message, "Encode with: gpu, gpu-cpu or cpu.");
    worker.close();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_node_encodes_on_the_device_asked_for() {
    let dir = tmp("devices");
    let ctx = MemCtx::new(&dir);
    *ctx.runtime.lock().unwrap() = Some(Arc::new(DeviceRuntime::default()));
    let worker = NodeWorker::new(ctx.clone(), WorkerOptions { work_dir: dir.join("work"), name: None, spawn: None });
    let on_gpu = worker.attempts("h265", 0, Some(&node_gpu().id)).unwrap();
    assert_eq!(on_gpu.iter().map(|a| (a.encoder.as_str(), a.decode.clone())).collect::<Vec<_>>(), vec![
        ("hevc_vaapi", vec!["-hwaccel".to_string(), "vaapi".into(), "-hwaccel_device".into(), "/dev/dri/renderD129".into()]),
        ("hevc_vaapi", vec![]),
    ]);
    assert_eq!(on_gpu[0].device.as_ref().unwrap().node.as_deref(), Some("/dev/dri/renderD129"));
    assert_eq!(worker.attempts("h265", 0, Some("cpu")).unwrap().into_iter().map(|a| a.encoder).collect::<Vec<_>>(), vec!["libx265"]);
    assert!(worker.attempts("av1", 0, Some(&node_gpu().id)).unwrap_err().message.contains("cannot encode"));
    assert_eq!(worker.attempts("h265", 0, Some("pci:0000:09:00.0")).unwrap_err().message, "No such device here.");
    assert_eq!(worker.attempts("h265", 0, None).unwrap().into_iter().map(|a| a.encoder).collect::<Vec<_>>(), vec!["libx265"]);
    let devices = worker.devices().unwrap();
    assert_eq!(devices.iter().map(|d| (d.id.clone(), d.kind.clone(), d.name.clone(), d.h265.clone(), d.av1.clone())).collect::<Vec<_>>(), vec![
        (node_gpu().id, "dri".into(), "Intel Arc A380".into(), Some("hevc_vaapi".into()), None),
        ("cpu".into(), "cpu".into(), "CPU (software encoder)".into(), Some("libx265".into()), Some("libsvtav1".into())),
    ]);
    worker.close();
    let plain = MemCtx::new(&dir);
    *plain.runtime.lock().unwrap() = Some(Arc::new(SoftRuntime));
    let w2 = NodeWorker::new(plain, WorkerOptions { work_dir: dir.join("work2"), name: None, spawn: None });
    assert!(w2.devices().is_none(), "a converter that lists no devices: none");
    w2.close();
    let _ = std::fs::remove_dir_all(dir);
}

fn caller(confirmed: bool) -> Caller {
    Caller { user: Some("admin".into()), client: "10.0.0.2".into(), confirmed, https: true }
}

#[test]
fn nodes_a_change_refused_part_way_saves_none_of_it_a_removed_vehicle_leaves_every_node_list() {
    let dir = tmp("put");
    let ctx = MemCtx::new(&dir);
    // (nobody answers on port 1: the node is just offline)
    ctx.set("nodes", json!([{ "id": "abcdefghijkl", "name": "garage-pc", "host": "127.0.0.1", "port": 1, "token": "t".repeat(43), "pin": { "fingerprint": "00" } }]));
    *ctx.vehicles.lock().unwrap() = vec![Vehicle { id: "daily-driver".into(), studio_root: None }];
    let api = NodesApi::new(ctx.clone(), ApiOptions { work_dir: Some(dir.join("work")), bench_dir: None, poll_ms: None, spawn: None });
    let c = caller(true);
    let put = |body: Value| api.handle(&Request { method: "PUT", path: "/api/nodes/abcdefghijkl", body: &body, caller: &c }).unwrap();
    assert_eq!(put(json!({ "name": "Shop PC", "trusted": "yes" })).status, 400);
    assert_eq!(put(json!({ "name": "Shop PC", "cars": "daily-driver" })).status, 400);
    assert_eq!(ctx.get("nodes")[0]["name"], json!("garage-pc"), "not renamed by a refused request");
    for body in [json!({ "name": 5 }), json!({ "name": ["x"] }), json!({ "name": "   " }), json!({ "trusted": "yes" }), json!({ "cars": "daily-driver" }), json!({ "cars": [7] })] {
        assert_eq!(put(body.clone()).status, 400, "{body}");
    }
    assert_eq!(ctx.get("nodes")[0]["name"], json!("garage-pc"));
    // trusted asks for the password
    let unconfirmed = caller(false);
    let r = api.handle(&Request { method: "PUT", path: "/api/nodes/abcdefghijkl", body: &json!({ "trusted": true }), caller: &unconfirmed }).unwrap();
    assert_eq!((r.status, r.body.clone()), (403, json!({ "error": "Enter your password to confirm this change.", "code": "CONFIRM_PASSWORD" })));
    let saved = put(json!({ "name": "Shop PC", "cars": ["daily-driver", "gone-car"] }));
    assert_eq!(saved.status, 200);
    assert_eq!(saved.body, json!({ "ok": true, "name": "Shop PC", "cars": ["daily-driver"] }));
    assert_eq!(ctx.get("nodes")[0]["name"], json!("Shop PC"));
    assert!(ctx.audits.lock().unwrap().iter().any(|l| l == "Info Node \"garage-pc\" renamed \"Shop PC\": admin from 10.0.0.2"));
    api.forget_vehicle("daily-driver");
    assert_eq!(ctx.get("nodes")[0]["cars"], json!([]));
    // the Nodes page answers without waiting for the offline node's full timeout
    let began = Instant::now();
    let page = api.handle(&Request { method: "GET", path: "/api/nodes", body: &Value::Null, caller: &c }).unwrap();
    assert_eq!(page.status, 200);
    assert!(began.elapsed() < Duration::from_secs(5));
    assert_eq!(page.body["nodes"][0]["address"], json!("127.0.0.1:1"));
    assert!(page.body["nodes"][0].get("pairedAt").is_none(), "undefined is left out, as JSON.stringify does");
    assert_eq!(page.body["worker"]["available"], json!(true));
    // the other routes' refusals
    let call = |m: &str, p: &str, body: Value| api.handle(&Request { method: m, path: p, body: &body, caller: &c }).unwrap();
    assert_eq!(call("DELETE", "/api/nodes/nope", Value::Null).body, json!({ "error": "No such node." }));
    assert_eq!(call("POST", "/api/nodes/nope/benchmark", json!({})).status, 404);
    assert_eq!(call("POST", "/api/nodes/nope/slots", json!({ "slots": 2 })).body, json!({ "error": "No such node." }));
    assert_eq!(call("POST", "/api/nodes/abcdefghijkl/slots", json!({ "slots": 9 })).body, json!({ "error": "Clips at once: 1 to 8." }));
    assert_eq!(call("POST", "/api/nodes/abcdefghijkl/slots", json!({ "slots": 2 })).status, 502, "the node is offline");
    assert_eq!(call("POST", "/api/nodes", json!({ "address": "a b", "code": "x" })).body, json!({ "error": "Enter the node's address, like 192.168.1.30 or nas.local:9000." }));
    assert_eq!(call("POST", "/api/nodes", json!({ "address": "127.0.0.1:1", "code": "AAAA-BBBB" })).body, json!({ "error": "Enter the 12-character pairing code shown on the node." }));
    assert_eq!(call("POST", "/api/nodes", json!({ "address": "127.0.0.1:1", "code": "AAAA-BBBB-CCCC" })).body, json!({ "error": "That node is already paired." }));
    assert_eq!(call("POST", "/api/nodes", json!({ "address": "127.0.0.1:2", "code": "AAAA-BBBB-CCCC" })).body, json!({ "error": "Could not reach the node (ECONNREFUSED)." }));
    assert_eq!(call("DELETE", "/api/nodes/worker/mains/zz", Value::Null).body, json!({ "error": "No such main server." }));
    assert_eq!(call("GET", "/api/nodes/abcdefghijkl/benchmark", Value::Null).body, json!({ "benchmark": null }));
    let pair = call("POST", "/api/nodes/worker/pair", Value::Null);
    assert!(pair.body["pairing"]["code"].is_string());
    assert_eq!(call("DELETE", "/api/nodes/worker/pair", Value::Null).body["pairing"], Value::Null);
    assert_eq!(call("POST", "/api/nodes/worker", json!({ "enabled": false })).body["enabled"], json!(false));
    assert_eq!(call("POST", "/api/nodes/worker", json!({ "enabled": true, "slots": 9 })).body, json!({ "error": "Clips at once: 1 to 8." }));
    assert_eq!(call("DELETE", "/api/nodes/abcdefghijkl", Value::Null).body, json!({ "ok": true }));
    assert!(ctx.audits.lock().unwrap().iter().any(|l| l == "Info Node \"Shop PC\" removed: admin from 10.0.0.2"));
    assert_eq!(super::routes::access("POST", "/api/nodes/worker/pair"), Some(super::routes::Access::AdminConfirmed));
    assert_eq!(super::routes::access("PUT", "/api/nodes/x"), Some(super::routes::Access::AdminConfirmed));
    assert_eq!(super::routes::access("GET", "/node/v1/info"), Some(super::routes::Access::NodeToken));
    api.close();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn without_its_own_https_a_server_cannot_be_a_node() {
    let dir = tmp("notls");
    let ctx = Arc::new(MemCtx { tls: false, ..Arc::try_unwrap(MemCtx::new(&dir)).ok().unwrap() });
    let api = NodesApi::new(ctx, ApiOptions { work_dir: Some(dir.join("work")), bench_dir: None, poll_ms: None, spawn: None });
    let c = caller(true);
    for (m, p) in [("POST", "/api/nodes/worker"), ("POST", "/api/nodes/worker/pair")] {
        let r = api.handle(&Request { method: m, path: p, body: &json!({ "enabled": true }), caller: &c }).unwrap();
        assert_eq!((r.status, r.body), (409, json!({ "error": "This server runs without its own HTTPS (TLS_MODE=off), so it cannot be a node." })));
    }
    let mut empty: &[u8] = &[];
    let reply = api.node_v1(true, &mut super::worker::WorkerRequest { method: "GET", path: "/node/v1/info", headers: &[], address: "1.2.3.4", served_cert: None, body: &mut empty }).unwrap();
    assert_eq!((reply.status, reply.body_json()), (404, json!({ "error": "Not found" })));
    reply.delivered();
    let _ = std::fs::remove_dir_all(dir);
}

// ---- end to end (openssl, ffmpeg)

#[test]
fn pairing_a_changed_certificate_tokens_and_a_real_remote_encode() {
    if !has_tools() {
        eprintln!("skipped: needs openssl and ffmpeg");
        return;
    }
    let dir = tmp("pairing");
    let material = certs(&dir, "worker-tls");
    let mut w = start_worker(&dir, &material);
    let (nodes, main_ctx) = main_nodes(&dir);
    let addr = json!(format!("127.0.0.1:{}", w.port));
    // nothing answers until node mode is on and a code is shown
    assert!(nodes.add(&addr, &json!("AAAA-BBBB-CCCC")).unwrap_err().message.contains("not set up as a node"));
    let pairing = w.worker.start_pairing()["pairing"].clone();
    let code = pairing["code"].as_str().unwrap().to_string();
    assert!(code.len() == 14 && code.chars().enumerate().all(|(i, c)| if i == 4 || i == 9 { c == '-' } else { "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".contains(c) }));
    assert_eq!(nodes.add(&addr, &json!("AAAA-BBBB-CCCC")).unwrap_err().message, "Wrong pairing code.");
    // a machine in between (another certificate) cannot pair, even with the code
    let forged = json!({ "name": "evil", "proof": hmac_hex(&normalize_code(&json!(code)), &pair_text::main(&"00".repeat(32), "evil")) });
    assert_eq!(raw(w.port, None, "POST", "/node/v1/pair", vec![("Content-Type".into(), "application/json".into())], Some(forged.to_string().into_bytes())).0, 403);
    let node = nodes.add(&addr, &json!(code.to_lowercase().replace('-', " "))).unwrap();
    let id = node["id"].as_str().unwrap().to_string();
    assert!(id.len() == 12 && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
    assert!(node["pin"]["authority"].is_string(), "the worker's authority is pinned too");
    assert_eq!(w.worker.status()["pairing"], Value::Null, "the code is used up");
    assert_eq!(w.worker.status()["mains"].as_array().unwrap().len(), 1);
    let token = node["token"].as_str().unwrap().to_string();
    assert!(!w.ctx.get("nodeWorker").to_string().contains(&token), "the worker keeps only a hash of the token");
    assert!(w.ctx.audits.lock().unwrap().iter().any(|l| l == "Info Paired with main server \"main-nas\" at 127.0.0.1"));
    assert_eq!(main_ctx.get("nodes")[0]["name"], json!("garage-pc"));

    let lanes = nodes.list();
    assert_eq!(lanes[0]["encoders"], json!({ "h265": "libx265", "av1": "libsvtav1" }));
    assert_eq!(lanes[0]["id"], json!(format!("node:{id}")));
    // without the token, or with a wrong one: refused
    assert_eq!(raw(w.port, None, "GET", "/node/v1/info", vec![], None), (401, json!({ "error": "Not paired." })));
    assert_eq!(raw(w.port, Some(&"x".repeat(43)), "GET", "/node/v1/info", vec![], None).0, 401);

    // a real clip goes there and comes back encoded
    let source = clip(&dir, "clip.mp4", 2);
    let target = dir.join("out.mp4");
    let mut progress = String::new();
    let (code0, _) = nodes.encode(enc(&format!("node:{id}"), &source, &target)).unwrap().wait_with(|s| progress.push_str(s));
    assert_eq!(code0, Some(0), "{:?}", main_ctx.logs.lock().unwrap());
    assert!(progress.contains("progress=end"));
    assert_eq!(codec_of(&target), "hevc");
    wait_empty(&dir);
    assert!(work_files(&dir).is_empty(), "the worker keeps nothing");
    // the output is written new: an existing file is never overwritten
    assert_eq!(encode_code(&nodes, enc(&format!("node:{id}"), &source, &target)), Some(1));
    // cancelled midway: the worker stops and deletes its files
    let target2 = dir.join("out2.mp4");
    let child = nodes.encode(enc(&format!("node:{id}"), &source, &target2)).unwrap();
    std::thread::sleep(Duration::from_millis(30));
    child.kill("SIGTERM");
    assert_eq!(child.wait(), (None, Some("SIGTERM".into())));
    wait_empty(&dir);
    assert!(!target2.exists());
    assert!(work_files(&dir).is_empty());
    // cancelled once the whole clip is on the node, before its answer: the job is deleted there
    let target3 = dir.join("out3.mp4");
    let full = std::fs::metadata(&source).unwrap().len();
    let child = nodes.encode(enc(&format!("node:{id}"), &source, &target3)).unwrap();
    let began = Instant::now();
    while began.elapsed() < Duration::from_secs(20) {
        let arrived = work_files(&dir).iter().any(|f| f.ends_with("-in.mp4") && std::fs::metadata(dir.join("work").join(f)).map(|m| m.len() == full).unwrap_or(false));
        if arrived {
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    child.kill("SIGTERM");
    child.wait();
    wait_empty(&dir);
    assert!(!target3.exists());
    assert!(work_files(&dir).is_empty(), "a job cancelled before its id came back is deleted on the node");

    // the node is reset with a new certificate authority: refused before any request
    let port = w.port;
    w.close();
    let other = certs(&dir, "impostor-tls");
    let wctx = w.ctx.clone();
    w = start_worker_on(&dir, &other, port, wctx.clone(), Arc::new(SoftRuntime), false);
    let i = nodes.refresh(&id).unwrap();
    assert!(!i.online && i.error.as_deref().unwrap().contains("different certificate"), "{:?}", i.error);
    assert_eq!(encode_code(&nodes, enc(&format!("node:{id}"), &source, &dir.join("out4.mp4"))), Some(1));
    // its own authority again (a renewed certificate is accepted too); revoked: the token stops working
    w.close();
    w = start_worker_on(&dir, &material, port, wctx, Arc::new(SoftRuntime), false);
    assert!(nodes.refresh(&id).unwrap().online);
    let main_id = w.worker.status()["mains"][0]["id"].as_str().unwrap().to_string();
    w.worker.revoke(&main_id);
    assert!(!nodes.refresh(&id).unwrap().online);
    w.close();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_renewed_certificate_from_the_pinned_authority_is_accepted() {
    if !has_tools() {
        eprintln!("skipped: needs openssl");
        return;
    }
    let dir = tmp("renew");
    let m = certs(&dir, "a");
    let d = dir.join("a");
    // a second certificate from the same authority (and key: a renewal)
    std::fs::write(d.join("ext"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\n").unwrap();
    assert!(Command::new("openssl").args(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "renewed.crt", "-days", "20", "-extfile", "ext"]).current_dir(&d).output().unwrap().status.success());
    let renewed = super::pin::der_of(&std::fs::read(d.join("renewed.crt")).unwrap()).unwrap();
    let first = super::pin::der_of(&m.cert).unwrap();
    let pin = super::pin::Pin { fingerprint: cert_fingerprint(&first), authority: super::pin::accept_authority(&json!(m.ca), &first) };
    assert!(pin.authority.is_some());
    assert!(super::pin::pin_matches(&pin, &renewed, &cert_fingerprint(&renewed).unwrap(), now_ms()));
    assert!(!super::pin::pin_matches(&super::pin::Pin { authority: None, ..pin.clone() }, &renewed, &cert_fingerprint(&renewed).unwrap(), now_ms()));
    // an authority that did not issue it is not kept, and the leaf itself is no authority
    let other = certs(&dir, "b");
    assert!(super::pin::accept_authority(&json!(other.ca), &first).is_none());
    assert!(super::pin::accept_authority(&json!(String::from_utf8(m.cert.clone()).unwrap()), &first).is_none());
    // not yet valid / expired: refused
    assert!(!super::pin::pin_matches(&super::pin::Pin { fingerprint: None, ..pin.clone() }, &renewed, "x", now_ms() + 40 * 86_400_000));
    let _ = std::fs::remove_dir_all(dir);
}

fn rogue_server(m: &Material) -> u16 {
    use rustls::pki_types::pem::PemObject;
    let certs: Vec<rustls::pki_types::CertificateDer<'static>> = rustls::pki_types::CertificateDer::pem_slice_iter(&m.cert).collect::<Result<_, _>>().unwrap();
    let key = rustls::pki_types::PrivateKeyDer::from_pem_slice(&m.key).unwrap();
    let cfg = Arc::new(rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider())).with_safe_default_protocol_versions().unwrap().with_no_client_auth().with_single_cert(certs, key).unwrap());
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            let cfg = cfg.clone();
            std::thread::spawn(move || {
                use std::io::Write;
                let mut t = rustls::StreamOwned::new(rustls::ServerConnection::new(cfg).unwrap(), s);
                if t.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"name\":\"").is_err() {
                    return;
                }
                let chunk = vec![b'x'; 16 * 1024];
                let began = Instant::now();
                while began.elapsed() < Duration::from_secs(30) {
                    if t.write_all(&chunk).and_then(|_| t.flush()).is_err() {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            });
        }
    });
    port
}

#[test]
fn the_worker_refuses_anything_but_an_mp4_limits_wrong_codes_per_address_and_a_node_cannot_hang_the_main() {
    if !has_tools() {
        eprintln!("skipped: needs openssl and ffmpeg");
        return;
    }
    let dir = tmp("refuse");
    let material = certs(&dir, "worker-tls");
    let w = start_worker(&dir, &material);
    let (nodes, _) = main_nodes(&dir);
    let addr = json!(format!("127.0.0.1:{}", w.port));
    let code = w.worker.start_pairing()["pairing"]["code"].as_str().unwrap().to_string();
    for _ in 0..3 {
        assert_eq!(nodes.add(&addr, &json!("AAAA-BBBB-CCCC")).unwrap_err().message, "Wrong pairing code.");
    }
    assert_eq!(nodes.add(&addr, &json!(code)).unwrap_err().message, "Too many wrong pairing codes from this address.");
    assert!(w.worker.status()["pairing"].is_object(), "the code was not cancelled for everyone");
    assert_eq!(w.ctx.audits.lock().unwrap().iter().filter(|l| *l == "Warn Node pairing refused (wrong code or a different certificate) from 127.0.0.1").count(), 3);

    // a DASH manifest (which could point ffmpeg at the node's own files) is refused
    w.worker.cancel_pairing();
    let token = base64url(&random_bytes(32));
    let mut s = w.ctx.get("nodeWorker");
    s["enabled"] = json!(true);
    s["mains"] = json!([{ "id": "aaaaaaaaaaaa", "name": "m", "tokenHash": sha256_hex(token.as_bytes()), "pairedAt": 1 }]);
    w.ctx.set("nodeWorker", s);
    let manifest = b"<?xml version=\"1.0\"?><MPD><Period><AdaptationSet><Representation><BaseURL>file:///etc/hostname</BaseURL></Representation></AdaptationSet></Period></MPD>".to_vec();
    let job = json!({ "codec": "h265", "bitrate": 400000 }).to_string();
    assert_eq!(raw(w.port, Some(&token), "POST", "/node/v1/jobs", vec![("X-Node-Job".into(), job.clone())], Some(manifest)), (415, json!({ "error": "Not an MP4 clip." })));
    assert_eq!(raw(w.port, Some(&token), "POST", "/node/v1/jobs", vec![], Some(b"x".to_vec())), (400, json!({ "error": "Bad encode settings." })));
    assert_eq!(raw(w.port, Some(&token), "POST", "/node/v1/jobs", vec![("X-Node-Job".into(), job.clone())], None), (411, json!({ "error": "The clip size is needed." })));
    assert_eq!(raw(w.port, Some(&token), "GET", "/node/v1/jobs/0123456789abcdef0123456789abcdef", vec![], None), (404, json!({ "error": "No such job." })));
    assert_eq!(raw(w.port, Some(&token), "POST", "/node/v1/slots", vec![], Some(b"{".to_vec())), (400, json!({ "error": "Bad JSON." })));
    assert_eq!(raw(w.port, Some(&token), "POST", "/node/v1/slots", vec![], Some(json!({ "slots": 3 }).to_string().into_bytes())), (200, json!({ "slots": 3 })));
    assert!(w.ctx.audits.lock().unwrap().iter().any(|l| l == "Info Main server \"m\" set this node to 3 clips at once"));
    assert!(work_files(&dir).is_empty());

    // a "node" that answers with an endless body: refused, and quickly
    let fake = certs(&dir, "rogue-tls");
    let port = rogue_server(&fake);
    let fp = cert_fingerprint(&super::pin::der_of(&fake.cert).unwrap()).unwrap();
    let (victim, vctx) = main_nodes(&dir);
    vctx.set("nodes", json!([{ "id": "roguerogue12", "name": "rogue", "host": "127.0.0.1", "port": port, "token": "t".repeat(43), "pin": { "fingerprint": fp, "authority": null }, "pairedAt": 1 }]));
    let began = Instant::now();
    let info = victim.refresh("roguerogue12").unwrap();
    assert!(!info.online);
    assert!(info.error.as_deref().unwrap().contains("too much"), "{:?}", info.error);
    assert!(began.elapsed() < Duration::from_secs(5), "it did not hang");
    // and too many wrong tokens from one address: refused for a while
    for _ in 0..20 {
        raw(w.port, Some(&"y".repeat(43)), "GET", "/node/v1/info", vec![], None);
    }
    assert_eq!(raw(w.port, Some(&token), "GET", "/node/v1/info", vec![], None), (429, json!({ "error": "Too many refused requests." })));
    w.close();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn clips_sent_ahead_wait_on_the_node_for_a_free_slot_and_all_convert() {
    if !has_tools() {
        eprintln!("skipped: needs openssl and ffmpeg");
        return;
    }
    let dir = tmp("queue");
    let material = certs(&dir, "worker-tls");
    let w = start_worker(&dir, &material);
    let (nodes, _) = main_nodes(&dir);
    let code = w.worker.start_pairing()["pairing"]["code"].as_str().unwrap().to_string();
    let node = nodes.add(&json!(format!("127.0.0.1:{}", w.port)), &json!(code)).unwrap();
    w.worker.set_enabled(true, Some(&json!(1)), None).unwrap();
    let token = node["token"].as_str().unwrap().to_string();
    let source = clip(&dir, "clip.mp4", 2);
    let id = format!("node:{}", node["id"].as_str().unwrap());
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let most = Arc::new(Mutex::new((0i64, 0i64)));
    let watch = {
        let (stop, most, port, token) = (stop.clone(), most.clone(), w.port, token.clone());
        std::thread::spawn(move || {
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                let (st, j) = raw(port, Some(&token), "GET", "/node/v1/info", vec![], None);
                if st == 200 {
                    let mut m = most.lock().unwrap();
                    m.0 = m.0.max(j["busy"].as_i64().unwrap());
                    m.1 = m.1.max(j["encoding"].as_i64().unwrap());
                    assert_eq!(j["capacity"], json!(16));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        })
    };
    let runs: Vec<_> = (0..3).map(|n| {
        let (nodes, r) = (nodes.clone(), enc(&id, &source, &dir.join(format!("out-{n}.mp4"))));
        std::thread::spawn(move || {
            let mut queued = false;
            let (c, _) = nodes.encode(r).unwrap().wait_with(|s| queued |= s.contains("queued=1"));
            (c, queued)
        })
    }).collect();
    let results: Vec<(Option<i32>, bool)> = runs.into_iter().map(|h| h.join().unwrap()).collect();
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    watch.join().unwrap();
    assert!(results.iter().all(|r| r.0 == Some(0)));
    let m = *most.lock().unwrap();
    assert!(m.0 >= 2, "clips waited on the node ({} held at once)", m.0);
    assert_eq!(m.1, 1, "never more encodes than its slots");
    assert!(results.iter().any(|r| r.1), "a waiting clip tells the main it is still alive");
    wait_empty(&dir);
    assert!(work_files(&dir).is_empty());
    w.close();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_nodes_gpus_and_cpu_a_lane_each_slots_per_device_a_real_encode_on_each() {
    if !has_tools() {
        eprintln!("skipped: needs openssl and ffmpeg");
        return;
    }
    let dir = tmp("lanes");
    let material = certs(&dir, "worker-tls");
    let mut w = start_device_worker(&dir, &material, 0, MemCtx::new(&dir));
    let (nodes, main_ctx) = main_nodes(&dir);
    let code = w.worker.start_pairing()["pairing"]["code"].as_str().unwrap().to_string();
    let node = nodes.add(&json!(format!("127.0.0.1:{}", w.port)), &json!(code)).unwrap();
    let nid = node["id"].as_str().unwrap().to_string();
    let token = node["token"].as_str().unwrap().to_string();
    let gpu = node_gpu().id;
    let gpu_lane = format!("node:{nid}@{gpu}");
    let cpu_lane = format!("node:{nid}@cpu");

    let (_, info) = raw(w.port, Some(&token), "GET", "/node/v1/info", vec![], None);
    assert_eq!(info["defaultDevice"], json!(gpu));
    let rows: Vec<Value> = info["devices"].as_array().unwrap().iter().map(|d| json!([d["id"], d["kind"], d["name"], d["encoders"], d["slots"], d["capacity"]])).collect();
    assert_eq!(rows, vec![json!([gpu, "dri", "Intel Arc A380", { "h265": "hevc_vaapi", "av1": null }, 2, 17]), json!(["cpu", "cpu", "CPU (software encoder)", { "h265": "libx265", "av1": "libsvtav1" }, 0, 15])]);
    assert_eq!(info["slots"], json!(2));

    let lanes = nodes.list();
    let view: Vec<Value> = lanes.iter().map(|l| json!([l["id"], l["kind"], l["nodeId"], l["nodeName"], l["deviceName"], l["name"], l["isDefault"], l["online"], l["encoders"]])).collect();
    assert_eq!(view, vec![
        json!([gpu_lane, "node", nid, "garage-pc", "Intel Arc A380", "garage-pc · Intel Arc A380", true, true, { "h265": "hevc_vaapi", "av1": null }]),
        json!([cpu_lane, "node", nid, "garage-pc", "CPU (software encoder)", "garage-pc · CPU (software encoder)", false, true, { "h265": "libx265", "av1": "libsvtav1" }]),
    ]);
    assert!(lanes.iter().all(|l| crate::converter::contracts::is_device_id(l["id"].as_str().unwrap())));

    nodes.set_slots(&format!("node:{nid}"), &json!({ gpu_lane.clone(): 1, cpu_lane.clone(): 1 })).unwrap();
    assert_eq!(w.ctx.get("nodeWorker")["deviceSlots"], json!({ gpu.clone(): 1, "cpu": 1 }));
    assert_eq!(nodes.list().iter().map(|l| l["slots"].clone()).collect::<Vec<_>>(), vec![json!(1), json!(1)]);
    nodes.set_slots(&nid, &json!(3)).unwrap();
    assert_eq!(w.ctx.get("nodeWorker")["deviceSlots"], json!({ gpu.clone(): 3, "cpu": 1 }), "a number: its default device");
    nodes.set_slots(&cpu_lane, &json!(2)).unwrap();
    assert_eq!(w.ctx.get("nodeWorker")["deviceSlots"], json!({ gpu.clone(): 3, "cpu": 2 }));
    nodes.set_slots(&format!("node:{nid}"), &json!({ gpu_lane.clone(): 1, cpu_lane.clone(): 1 })).unwrap();
    for slots in [json!({ "pci:0000:09:00.0": 1 }), json!({ "cpu": 9 }), json!({ "cpu": -1 }), json!({})] {
        let (st, j) = raw(w.port, Some(&token), "POST", "/node/v1/slots", vec![], Some(json!({ "slots": slots }).to_string().into_bytes()));
        assert_eq!((st, j), (400, json!({ "error": "Clips at once per device of this node: 0 to 8." })), "{slots}");
    }
    let source = clip(&dir, "clip.mp4", 2);
    let bytes = std::fs::read(&source).unwrap();
    for device in ["pci:0000:09:00.0", "node:abcdefabcdef", "cuda0"] {
        let (st, _) = raw(w.port, Some(&token), "POST", "/node/v1/jobs", vec![("X-Node-Job".into(), json!({ "codec": "h265", "bitrate": 400_000, "device": device }).to_string())], Some(bytes.clone()));
        assert_eq!(st, 400, "{device}");
    }
    assert!(work_files(&dir).is_empty(), "nothing kept of a refused clip");

    let on = |lane: &str, name: &str| encode_code(&nodes, enc(lane, &source, &dir.join(name)));
    w.seen.lock().unwrap().clear();
    assert_eq!(on(&gpu_lane, "gpu.mp4"), Some(0), "{:?}", main_ctx.logs.lock().unwrap());
    assert_eq!(codec_of(&dir.join("gpu.mp4")), "hevc");
    {
        let seen = w.seen.lock().unwrap();
        let first = &seen[0];
        let after = |k: &str| first.iter().position(|a| a == k).map(|i| first[i + 1].clone());
        assert!(first.contains(&"hevc_vaapi".to_string()) && after("-vaapi_device").as_deref() == Some("/dev/dri/renderD129") && after("-hwaccel_device").as_deref() == Some("/dev/dri/renderD129"), "{first:?}");
    }
    w.seen.lock().unwrap().clear();
    assert_eq!(on(&cpu_lane, "cpu.mp4"), Some(0));
    assert!(w.seen.lock().unwrap().iter().all(|a| a.contains(&"libx265".to_string()) && !a.contains(&"-vaapi_device".to_string()) && !a.contains(&"-hwaccel".to_string())));
    w.seen.lock().unwrap().clear();
    assert_eq!(on(&format!("node:{nid}"), "whole.mp4"), Some(0));
    assert!(w.seen.lock().unwrap()[0].contains(&"hevc_vaapi".to_string()), "a whole-node lane: its default device");
    let mut av1 = enc(&gpu_lane, &source, &dir.join("av1.mp4"));
    av1.codec = "av1".into();
    assert_eq!(encode_code(&nodes, av1), Some(1), "that GPU cannot: the clip comes back");

    // each device converts no more than its own slots, at the same time as the other
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let most = Arc::new(Mutex::new(HashMap::<String, i64>::new()));
    let watch = {
        let (stop, most, port, token) = (stop.clone(), most.clone(), w.port, token.clone());
        std::thread::spawn(move || {
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                let (_, j) = raw(port, Some(&token), "GET", "/node/v1/info", vec![], None);
                for d in j["devices"].as_array().cloned().unwrap_or_default() {
                    let mut m = most.lock().unwrap();
                    let e = m.entry(d["id"].as_str().unwrap().to_string()).or_insert(0);
                    *e = (*e).max(d["encoding"].as_i64().unwrap_or(0));
                }
                std::thread::sleep(Duration::from_millis(30));
            }
        })
    };
    let runs: Vec<_> = [&gpu_lane, &gpu_lane, &gpu_lane, &cpu_lane, &cpu_lane].iter().enumerate().map(|(n, lane)| {
        let (nodes, r) = (nodes.clone(), enc(lane, &source, &dir.join(format!("many-{n}.mp4"))));
        std::thread::spawn(move || encode_code(&nodes, r))
    }).collect();
    let codes: Vec<Option<i32>> = runs.into_iter().map(|h| h.join().unwrap()).collect();
    stop.store(true, std::sync::atomic::Ordering::SeqCst);
    watch.join().unwrap();
    assert!(codes.iter().all(|c| *c == Some(0)), "{codes:?}");
    assert!(most.lock().unwrap().values().all(|n| *n <= 1), "{:?}", most.lock().unwrap());

    // an older main (no device in the job): encoded as before
    let (st, j) = raw(w.port, Some(&token), "POST", "/node/v1/jobs", vec![("X-Node-Job".into(), json!({ "codec": "h265", "bitrate": 400_000 }).to_string())], Some(bytes.clone()));
    assert_eq!(st, 200);
    let jid = j["id"].as_str().unwrap().to_string();
    let mut state = String::new();
    for _ in 0..300 {
        std::thread::sleep(Duration::from_millis(100));
        state = raw(w.port, Some(&token), "GET", &format!("/node/v1/jobs/{jid}"), vec![], None).1["state"].as_str().unwrap_or("").to_string();
        if state == "done" || state == "failed" {
            break;
        }
    }
    assert_eq!(state, "done");
    assert_eq!(raw(w.port, Some(&token), "GET", &format!("/node/v1/jobs/{jid}/nope"), vec![], None).0, 404);
    assert_eq!(raw(w.port, Some(&token), "PUT", &format!("/node/v1/jobs/{jid}"), vec![], None), (405, json!({ "error": "Not allowed." })));
    assert_eq!(raw(w.port, Some(&token), "DELETE", &format!("/node/v1/jobs/{jid}"), vec![], None), (200, json!({ "ok": true })));

    // the node goes away: its lanes stay (offline, no encoders), here and after a restart
    let port = w.port;
    w.close();
    assert!(!nodes.refresh(&nid).unwrap().online);
    let offline: Vec<Value> = nodes.list().iter().map(|l| json!([l["id"], l["online"], l["encoders"]])).collect();
    assert_eq!(offline, vec![json!([gpu_lane, false, { "h265": null, "av1": null }]), json!([cpu_lane, false, { "h265": null, "av1": null }])]);
    let restarted = Nodes::new(main_ctx.clone(), Some("main-nas".into()), Some(100));
    let again: Vec<Value> = restarted.list().iter().map(|l| json!([l["id"], l["online"], l["isDefault"]])).collect();
    assert_eq!(again, vec![json!([gpu_lane, false, true]), json!([cpu_lane, false, false])]);
    // (reportsHeartbeatNodes: nodes.hardware() names its devices from what was kept)
    assert_eq!(restarted.hardware()[0]["devices"], json!([{ "id": gpu, "kind": "dri", "name": "Intel Arc A380" }, { "id": "cpu", "kind": "cpu", "name": "CPU (software encoder)" }]));
    let wctx = w.ctx.clone();
    w = start_device_worker(&dir, &material, port, wctx);
    assert!(restarted.refresh(&nid).unwrap().online);
    assert_eq!(restarted.list().iter().map(|l| json!([l["id"], l["online"]])).collect::<Vec<_>>(), vec![json!([gpu_lane, true]), json!([cpu_lane, true])]);
    // trust and Vehicles first are the node's, whichever lane asks; the page's view
    restarted.set_trusted(&nid, &json!(true));
    assert!(restarted.trusted(&gpu_lane) && restarted.trusted(&cpu_lane));
    let v = restarted.overview();
    assert_eq!(v[0]["defaultLane"], json!(gpu_lane));
    assert_eq!(v[0]["defaultDeviceName"], json!("Intel Arc A380"));
    assert_eq!(v[0]["slots"], json!(2));
    w.close();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn an_older_node_is_one_lane_and_gets_the_old_single_number() {
    if !has_tools() {
        eprintln!("skipped: needs openssl and ffmpeg");
        return;
    }
    let dir = tmp("older");
    let material = certs(&dir, "worker-tls");
    let w = start_worker(&dir, &material);
    let (nodes, _) = main_nodes(&dir);
    let code = w.worker.start_pairing()["pairing"]["code"].as_str().unwrap().to_string();
    let node = nodes.add(&json!(format!("127.0.0.1:{}", w.port)), &json!(code)).unwrap();
    let nid = node["id"].as_str().unwrap().to_string();
    let lanes = nodes.list();
    assert_eq!(lanes.iter().map(|l| json!([l["id"], l["name"], l["nodeId"]])).collect::<Vec<_>>(), vec![json!([format!("node:{nid}"), "garage-pc (node)", nid])]);
    let o = nodes.overview();
    assert_eq!(o[0]["devices"], Value::Null);
    assert_eq!(o[0]["defaultLane"], json!(format!("node:{nid}")));
    nodes.set_slots(&format!("node:{nid}"), &json!(4)).unwrap();
    assert_eq!(w.worker.status()["slots"], json!(4));
    assert!(nodes.set_slots(&format!("node:{nid}"), &json!({ "cpu": 1 })).unwrap_err().message.contains("per device of this node"));
    assert_eq!(nodes.set_slots(&nid, &json!(9)).unwrap_err().message, "Clips at once: 1 to 8.");
    let source = clip(&dir, "clip.mp4", 2);
    assert_eq!(encode_code(&nodes, enc(&format!("node:{nid}"), &source, &dir.join("out.mp4"))), Some(0));
    assert_eq!(codec_of(&dir.join("out.mp4")), "hevc");
    w.close();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn benchmark_real_clips_lent_to_a_real_node_encodes_deleted_footage_untouched() {
    if !has_tools() {
        eprintln!("skipped: needs openssl and ffmpeg");
        return;
    }
    let dir = tmp("bench");
    let material = certs(&dir, "worker-tls");
    let w = start_worker(&dir, &material);
    let (nodes, main_ctx) = main_nodes(&dir);
    let code = w.worker.start_pairing()["pairing"]["code"].as_str().unwrap().to_string();
    let node = nodes.add(&json!(format!("127.0.0.1:{}", w.port)), &json!(code)).unwrap();
    let nid = node["id"].as_str().unwrap().to_string();
    let tesla = dir.join("footage").join("TeslaCam").join("RecentClips");
    std::fs::create_dir_all(&tesla).unwrap();
    for cam in ["front", "back"] {
        let p = clip(&dir, &format!("{cam}.mp4"), 2);
        std::fs::rename(p, tesla.join(format!("2026-10-24_10-00-00-{cam}.mp4"))).unwrap();
    }
    let stamp = |d: &Path| {
        let mut v: Vec<(String, std::time::SystemTime)> = std::fs::read_dir(d).unwrap().flatten().map(|e| (e.file_name().to_string_lossy().into_owned(), e.metadata().unwrap().modified().unwrap())).collect();
        v.sort();
        v
    };
    let before = stamp(&tesla);
    *main_ctx.vehicles.lock().unwrap() = vec![Vehicle { id: "car".into(), studio_root: Some(dir.join("footage").join("TeslaCam")) }];
    let work = dir.join("bench");
    let bench = NodeBenchmark::new(nodes.clone(), main_ctx.clone(), work.clone(), Some(1024), Some(vec![1, 2]));
    bench.start(&nid, "h265").unwrap();
    assert_eq!(bench.start(&nid, "h265").unwrap_err(), (409, "A node benchmark is already running.".to_string()));
    for _ in 0..600 {
        if bench.view(&nid)["state"] != json!("running") {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let r = bench.view(&nid);
    assert_eq!(r["state"], json!("done"), "{r}");
    assert_eq!(r["results"].as_array().unwrap().iter().map(|x| x["level"].clone()).collect::<Vec<_>>(), vec![json!(1), json!(2)]);
    assert!(r["results"].as_array().unwrap().iter().all(|x| x["clipsPerMinute"].as_f64().unwrap() > 0.0 && x["failed"] == json!(0)));
    assert!([json!(1), json!(2)].contains(&r["suggested"]));
    assert_eq!(r["samples"], json!(2));
    assert!(std::fs::read_dir(&work).unwrap().next().is_none(), "every encode was deleted");
    assert_eq!(stamp(&tesla), before, "the footage is untouched");
    nodes.set_slots(&nid, &json!(3)).unwrap();
    assert_eq!(w.worker.status()["slots"], json!(3));
    w.close();
    let _ = std::fs::remove_dir_all(dir);
}

// ---- parity with Node's helper server (frozen)
//
// lean/parity/nodes.js sent the same requests to Node's worker
// (server/nodeWorker.js), paired by Node's main (server/nodes.js): the
// pairing refusals, a pairing, tokens, info, slots, jobs, a real encode, its
// output, deletes and the throttle, each answer normalised where it is the
// moment's; then the main's own view: its lanes, an encode there, a cancel,
// Use 3 and its refusal of 9. Node's answers are frozen in
// tests/fixtures/node-reference/nodes-worker.json. The Rust worker, paired
// by the Rust main, must answer them the same.

/// One HTTPS/1.1 request to the worker on 127.0.0.1 (its certificate checked
/// against `ca`), as nodes.js's call(): { status, type, length, json, bytes }.
fn call(port: u16, ca: &str, method: &str, path: &str, token: Option<&str>, headers: &[(&str, String)], body: Option<&[u8]>, chunked: bool) -> Value {
    use rustls::pki_types::pem::PemObject;
    use std::io::{Read, Write};
    let mut roots = rustls::RootCertStore::empty();
    for c in rustls::pki_types::CertificateDer::pem_slice_iter(ca.as_bytes()) {
        roots.add(c.unwrap()).unwrap();
    }
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider())).with_safe_default_protocol_versions().unwrap().with_root_certificates(roots).with_no_client_auth();
    let name = rustls::pki_types::ServerName::IpAddress(std::net::IpAddr::from([127, 0, 0, 1]).into());
    let conn = rustls::ClientConnection::new(Arc::new(config), name).unwrap();
    let Ok(tcp) = std::net::TcpStream::connect(("127.0.0.1", port)) else { return json!({ "status": 0, "error": "ECONNREFUSED" }) };
    tcp.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
    let mut tls = rustls::StreamOwned::new(conn, tcp);
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    if let Some(t) = token {
        head.push_str(&format!("Authorization: Bearer {t}\r\n"));
    }
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    match (body, chunked) {
        (Some(b), false) => head.push_str(&format!("Content-Length: {}\r\n", b.len())),
        (Some(_), true) => head.push_str("Transfer-Encoding: chunked\r\n"),
        (None, _) => {}
    }
    head.push_str("\r\n");
    let mut out = head.into_bytes();
    if let Some(b) = body {
        if chunked {
            out.extend(format!("{:x}\r\n", b.len()).as_bytes());
            out.extend(b);
            out.extend(b"\r\n0\r\n\r\n");
        } else {
            out.extend(b);
        }
    }
    if tls.write_all(&out).and_then(|_| tls.flush()).is_err() {
        return json!({ "status": 0, "error": "EPIPE" });
    }
    let mut raw = Vec::new();
    let _ = tls.read_to_end(&mut raw);
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").expect("an HTTP answer");
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let mut data = raw[split + 4..].to_vec();
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
    let hs: HashMap<String, String> = lines.filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))).collect();
    if hs.get("transfer-encoding").is_some_and(|t| t.contains("chunked")) {
        let mut plain = Vec::new();
        let mut rest = &data[..];
        while let Some(i) = rest.windows(2).position(|w| w == b"\r\n") {
            let n = usize::from_str_radix(String::from_utf8_lossy(&rest[..i]).split(';').next().unwrap().trim(), 16).unwrap_or(0);
            if n == 0 {
                break;
            }
            plain.extend(&rest[i + 2..i + 2 + n]);
            rest = &rest[i + 2 + n + 2..];
        }
        data = plain;
    }
    let length = hs.get("content-length").and_then(|l| l.parse::<i64>().ok()).unwrap_or(-1);
    let parsed = serde_json::from_slice::<Value>(&data).unwrap_or(Value::Null);
    json!({ "status": status, "type": hs.get("content-type"), "length": length, "json": parsed, "bytes": data.len() })
}

/// nodes.js's normal(): what is the moment's, not the server's (ids, numbers that move).
fn normal(v: &Value) -> Value {
    match v {
        Value::String(t) if t.len() == 32 && t.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) => json!("<id>"),
        Value::Array(a) => Value::Array(a.iter().map(normal).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| {
            let moving = ["outTimeUs", "fps", "speed", "outputBytes", "pairedAt", "lastSeenAt", "at"].contains(&k.as_str());
            let typeof_ = |x: &Value| json!(match x { Value::Number(_) => "number", Value::String(_) => "string", Value::Bool(_) => "boolean", _ => "object" });
            (k.clone(), if moving { if x.is_null() { Value::Null } else { typeof_(x) } } else { normal(x) })
        }).collect()),
        other => other.clone(),
    }
}

/// nodes.js's script(), on the Rust worker with the Rust main.
fn worker_script(port: u16, ca: &str, code: &str, clip: &Path, dir: &Path) -> Value {
    let mut out: Vec<Value> = vec![];
    let note = |out: &mut Vec<Value>, name: &str, r: &Value| out.push(json!({ "name": name, "status": r["status"], "type": r["type"], "json": normal(&r["json"]) }));
    let j = || vec![("Content-Type", "application/json".to_string())];
    let c = |m: &str, p: &str, t: Option<&str>, h: &[(&str, String)], b: Option<&[u8]>| call(port, ca, m, p, t, h, b, false);
    note(&mut out, "pair GET", &c("GET", "/node/v1/pair", None, &[], None));
    note(&mut out, "pair bad JSON", &c("POST", "/node/v1/pair", None, &j(), Some(b"not json")));
    note(&mut out, "pair too large", &c("POST", "/node/v1/pair", None, &j(), Some(json!({ "name": "x".repeat(5000) }).to_string().as_bytes())));
    note(&mut out, "pair empty", &c("POST", "/node/v1/pair", None, &j(), Some(b"{}")));
    note(&mut out, "pair no proof", &c("POST", "/node/v1/pair", None, &j(), Some(json!({ "name": "m", "proof": 5 }).to_string().as_bytes())));
    let wrong = hmac_hex("AAAABBBBCCCC", &pair_text::main(&"00".repeat(32), "m"));
    note(&mut out, "pair wrong", &c("POST", "/node/v1/pair", None, &j(), Some(json!({ "name": "m", "proof": wrong }).to_string().as_bytes())));
    // the main pairs
    let (nodes, _main_ctx) = main_nodes(dir);
    let mut main = serde_json::Map::new();
    let node = match nodes.add(&json!(format!("127.0.0.1:{port}")), &json!(code)) {
        Ok(n) => n,
        Err(e) => return json!({ "out": out, "main": { "error": e.message } }),
    };
    let nid = node["id"].as_str().unwrap().to_string();
    main.insert("paired".into(), json!(nid.len() == 12 && nid.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())));
    main.insert("name".into(), node["name"].clone());
    main.insert("authority".into(), json!(node["pin"]["authority"].as_str().is_some_and(|a| !a.is_empty())));
    let token = node["token"].as_str().unwrap().to_string();
    let t = Some(token.as_str());
    note(&mut out, "pair again", &c("POST", "/node/v1/pair", None, &j(), Some(b"{}")));
    note(&mut out, "info without token", &c("GET", "/node/v1/info", None, &[], None));
    note(&mut out, "info wrong token", &c("GET", "/node/v1/info", Some(&"x".repeat(43)), &[], None));
    note(&mut out, "info malformed token", &c("GET", "/node/v1/info", Some("short"), &[], None));
    note(&mut out, "info", &c("GET", "/node/v1/info", t, &[], None));
    note(&mut out, "info POST", &c("POST", "/node/v1/info", t, &[], Some(b"")));
    for (name, body) in [("slots 3", json!({ "slots": 3 }).to_string()), ("slots 9", json!({ "slots": 9 }).to_string()), ("slots text", json!({ "slots": "3" }).to_string()), ("slots per device", json!({ "slots": { "cpu": 1 } }).to_string()), ("slots bad JSON", "{".to_string()), ("slots empty", String::new())] {
        note(&mut out, name, &c("POST", "/node/v1/slots", t, &j(), Some(body.as_bytes())));
    }
    let bytes = std::fs::read(clip).unwrap();
    let job = |s: Value| vec![("X-Node-Job", s.to_string())];
    note(&mut out, "job no settings", &c("POST", "/node/v1/jobs", t, &[], Some(&bytes)));
    note(&mut out, "job bad settings", &c("POST", "/node/v1/jobs", t, &job(json!({ "codec": "h264", "bitrate": 3e6 as i64 })), Some(&bytes)));
    note(&mut out, "job ffmpeg args", &c("POST", "/node/v1/jobs", t, &job(json!({ "codec": "h265", "bitrate": 3e6 as i64, "args": ["-f", "lavfi"] })), Some(&bytes)));
    note(&mut out, "job without length", &call(port, ca, "POST", "/node/v1/jobs", t, &job(json!({ "codec": "h265", "bitrate": 400000 })), Some(&bytes), true));
    note(&mut out, "job unknown device", &c("POST", "/node/v1/jobs", t, &job(json!({ "codec": "h265", "bitrate": 400000, "device": "pci:0000:09:00.0" })), Some(&bytes)));
    note(&mut out, "job cpu without devices", &c("POST", "/node/v1/jobs", t, &job(json!({ "codec": "h265", "bitrate": 400000, "device": "cpu" })), Some(&bytes)));
    note(&mut out, "job manifest", &c("POST", "/node/v1/jobs", t, &job(json!({ "codec": "h265", "bitrate": 400000 })), Some(b"<?xml version=\"1.0\"?><MPD></MPD>")));
    let sent = c("POST", "/node/v1/jobs", t, &job(json!({ "codec": "h265", "bitrate": 400000, "holdFrames": 0, "durationUs": 2000000 })), Some(&bytes));
    note(&mut out, "job", &sent);
    let id = sent["json"]["id"].as_str().unwrap_or("").to_string();
    let mut last = Value::Null;
    for _ in 0..600 {
        std::thread::sleep(Duration::from_millis(50));
        last = c("GET", &format!("/node/v1/jobs/{id}"), t, &[], None);
        if matches!(last["json"]["state"].as_str(), Some("done") | Some("failed")) {
            break;
        }
    }
    note(&mut out, "job done", &last);
    let output = c("GET", &format!("/node/v1/jobs/{id}/output"), t, &[], None);
    out.push(json!({ "name": "job output", "status": output["status"], "type": output["type"], "whole": output["length"] == output["bytes"] && output["bytes"].as_u64().unwrap_or(0) > 0 }));
    note(&mut out, "job PATCH", &c("PATCH", &format!("/node/v1/jobs/{id}"), t, &[], None));
    note(&mut out, "job delete", &c("DELETE", &format!("/node/v1/jobs/{id}"), t, &[], None));
    note(&mut out, "job gone", &c("GET", &format!("/node/v1/jobs/{id}"), t, &[], None));
    note(&mut out, "job bad id", &c("GET", "/node/v1/jobs/zz", t, &[], None));
    note(&mut out, "other path", &c("GET", "/node/v1/other", t, &[], None));
    note(&mut out, "info after", &c("GET", "/node/v1/info", t, &[], None));

    // the main: lanes, a real encode, a cancel, Use 3
    let lanes: Vec<Value> = nodes.list().into_iter().map(|mut l| {
        l["id"] = json!(l["id"].as_str().unwrap().replace(&nid, "<node>"));
        l["nodeId"] = json!("<node>");
        l
    }).collect();
    main.insert("lanes".into(), json!(lanes));
    let (code, _) = nodes.encode(enc(&format!("node:{nid}"), clip, &dir.join("rust-main.mp4"))).unwrap().wait();
    main.insert("encode".into(), json!(code));
    main.insert("codec".into(), json!(codec_of(&dir.join("rust-main.mp4"))));
    let mut r = enc(&format!("node:{nid}"), clip, &dir.join("rust-cancel.mp4"));
    r.duration_us = None;
    let child = nodes.encode(r).unwrap();
    std::thread::sleep(Duration::from_millis(30));
    child.kill("SIGTERM");
    main.insert("cancel".into(), json!(child.wait().1));
    let until = Instant::now() + Duration::from_secs(10);
    let mut freed = false;
    while Instant::now() < until {
        if let Some(i) = nodes.refresh(&nid) {
            if i.online && i.busy == Some(0) && i.encoding == Some(0) {
                freed = true;
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    main.insert("freed".into(), json!(freed));
    nodes.set_slots(&nid, &json!(3)).unwrap();
    main.insert("slots".into(), nodes.overview()[0]["slots"].clone());
    let mut o = nodes.overview()[0].clone();
    for (k, v) in [("id", "<node>"), ("address", "<address>"), ("fingerprint", "<fp>"), ("defaultLane", "node:<node>")] {
        o[k] = json!(v);
    }
    main.insert("overview".into(), normal(&o));
    main.insert("refused".into(), match nodes.set_slots(&nid, &json!(9)) { Ok(_) => Value::Null, Err(e) => json!(e.message) });
    // the throttle: twenty wrong tokens from one address, then even the right one waits
    for _ in 0..20 {
        c("GET", "/node/v1/info", Some(&"y".repeat(43)), &[], None);
    }
    note(&mut out, "throttled", &c("GET", "/node/v1/info", t, &[], None));
    json!({ "out": out, "main": main })
}

#[test]
fn parity_the_rust_worker_answers_as_nodes_worker_answered() {
    if !has_tools() {
        eprintln!("skipped: needs openssl and ffmpeg");
        return;
    }
    let dir = tmp("parity-b");
    let m = certs(&dir, "rust-tls");
    let w = start_worker(&dir, &m);
    let code = w.worker.start_pairing()["pairing"]["code"].as_str().unwrap().to_string();
    let source = clip(&dir, "clip.mp4", 2);
    let theirs = crate::reference::answer("nodes-worker", &[], &json!("script"));
    let mine = worker_script(w.port, &m.ca, &code, &source, &dir);
    let (a, b) = (theirs["out"].as_array().unwrap(), mine["out"].as_array().unwrap());
    assert_eq!(a.len(), 35);
    let mut differences = vec![];
    for i in 0..a.len().max(b.len()) {
        if a.get(i) != b.get(i) {
            differences.push(format!("node {}\nrust {}", a.get(i).unwrap_or(&Value::Null), b.get(i).unwrap_or(&Value::Null)));
        }
    }
    for k in ["paired", "name", "authority", "lanes", "encode", "codec", "cancel", "slots", "overview", "refused"] {
        if theirs["main"][k] != mine["main"][k] {
            differences.push(format!("main {k}: node {} rust {}", theirs["main"][k], mine["main"][k]));
        }
    }
    assert_eq!(theirs["main"]["freed"], json!(true));
    assert_eq!(mine["main"]["freed"], json!(true), "the slot is freed after the cancel");
    assert!(differences.is_empty(), "{} difference(s):\n{}", differences.len(), differences.join("\n"));
    wait_empty(&dir);
    assert!(work_files(&dir).is_empty());
    w.close();
    let _ = std::fs::remove_dir_all(dir);
}
