//! nodeWorker.js: another Sentry Six Manager (the main) sends this one clips
//! to encode and takes the encoded files back. Only the encode runs here;
//! the main reads the share, writes the telemetry, verifies and saves.
//!
//! Pairing: a one-time code (10 minutes, one use, 20 wrong tries in all, 3
//! from one address). The main proves it knows the code with an HMAC over
//! the fingerprint of the certificate it saw on this connection; this
//! server answers with a random token and an HMAC proving it knows it too.
//! Only the token's SHA-256 is kept here.

use super::ctx::{Level, NodesCtx, WorkerRuntime};
use super::{base64url, cert_fingerprint, hex, hmac_hex, is_local_device, js_text, new_pairing_code, normalize_code, pair_text, peer_str, peer_text, random_bytes, safe_int, same_hex, sha256_hex};
use crate::converter::contracts::QUALITY_LEVELS;
use crate::converter::planner::{self, Device, EncodeArgs, Selected};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

pub const SETTINGS_KEY: &str = "nodeWorker";
const PAIR_TTL_MS: i64 = 10 * 60_000;
const PAIR_TRIES: u32 = 20;
const PAIR_TRIES_PER_ADDRESS: u32 = 3;
pub const MAX_CLIP_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_SLOTS: i64 = 8;
const DEFAULT_SLOTS: i64 = 2;
const DONE_TTL_MS: i64 = 10 * 60_000;
const STALL_MS: u64 = 10 * 60_000;
const ORPHAN_MS: i64 = 5 * 60_000;
const USES: [&str; 3] = ["gpu", "gpu-cpu", "cpu"];
pub const QUEUE: i64 = 15;
const MAX_HELD: usize = 64;
const MAX_DEVICES: usize = 16;
const DEVICES_TTL_MS: i64 = 30_000;
const DEFAULT_POOL: &str = "*";
const DISK_SPARE: u64 = 2 * 1024 * 1024 * 1024;
const BAD_TOKEN_LIMIT: usize = 20;
const BAD_TOKEN_WINDOW_MS: i64 = 10 * 60_000;
const HARDWARE_TTL_MS: i64 = 10 * 60_000;

/// The encode settings a main may ask for (parseJobSettings).
#[derive(Debug, Clone, PartialEq)]
pub struct JobSettings {
    pub codec: String,
    pub bitrate: Option<i64>,
    pub quality: Option<String>,
    pub hold_frames: i64,
    pub duration_us: Option<i64>,
    pub device: Option<String>,
}

impl JobSettings {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("codec".into(), json!(self.codec));
        m.insert("bitrate".into(), json!(self.bitrate));
        m.insert("quality".into(), json!(self.quality));
        m.insert("holdFrames".into(), json!(self.hold_frames));
        m.insert("durationUs".into(), json!(self.duration_us));
        if let Some(d) = &self.device {
            m.insert("device".into(), json!(d));
        }
        Value::Object(m)
    }
}

fn present(v: Option<&Value>) -> bool {
    v.is_some_and(|x| !x.is_null())
}

/// parseJobSettings(raw): fixed choices only, never ffmpeg arguments.
pub fn parse_job_settings(raw: Option<&str>) -> Option<JobSettings> {
    let value: Value = serde_json::from_str(raw.unwrap_or("")).ok()?;
    let o = value.as_object()?;
    if o.keys().any(|k| !["codec", "bitrate", "quality", "holdFrames", "durationUs", "device"].contains(&k.as_str())) {
        return None;
    }
    let codec = o.get("codec")?.as_str().filter(|c| *c == "h265" || *c == "av1")?;
    let (hb, hq) = (present(o.get("bitrate")), present(o.get("quality")));
    if hb == hq {
        return None;
    }
    let bitrate = if hb {
        Some(safe_int(&o["bitrate"]).filter(|b| (50_000..=200_000_000).contains(b))?)
    } else {
        None
    };
    let quality = if hq {
        Some(o["quality"].as_str().filter(|q| QUALITY_LEVELS.contains(q))?.to_string())
    } else {
        None
    };
    let hold_frames = match o.get("holdFrames") {
        None | Some(Value::Null) => 0,
        Some(v) => safe_int(v).filter(|h| (0..=600).contains(h))?,
    };
    let duration_us = match o.get("durationUs") {
        None | Some(Value::Null) => None,
        Some(v) => Some(safe_int(v).filter(|d| *d > 0 && (*d as f64) < 24.0 * 3600e6)?),
    };
    let device = match o.get("device") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if is_local_device(s) => Some(s.clone()),
        Some(_) => return None,
    };
    Some(JobSettings { codec: codec.into(), bitrate, quality, hold_frames, duration_us, device })
}

/// The worker's settings as nodeWorker.js settings() reads them.
#[derive(Debug, Clone)]
pub struct Settings {
    pub enabled: bool,
    pub slots: i64,
    pub use_: String,
    pub device_slots: IndexMap<String, i64>,
    pub mains: Vec<Value>,
}

impl Settings {
    fn to_json(&self) -> Value {
        let mut ds = Map::new();
        for (k, v) in &self.device_slots {
            ds.insert(k.clone(), json!(v));
        }
        json!({ "enabled": self.enabled, "slots": self.slots, "use": self.use_, "deviceSlots": ds, "mains": self.mains })
    }
}

/// One clip held for a main.
struct JobData {
    id: String,
    main_id: String,
    main_name: String,
    state: &'static str,
    input: PathBuf,
    output: PathBuf,
    out_time_us: Option<i64>,
    fps: Option<f64>,
    speed: Option<f64>,
    encoder: Option<String>,
    error: Option<String>,
    output_bytes: Option<u64>,
    seen_at: i64,
    ended_at: i64,
    input_bytes: u64,
    device: Option<String>,
    settings_used: Option<JobSettings>,
    benchmark: bool,
    child: Option<Arc<Mutex<Child>>>,
}

struct Job {
    stopped: AtomicBool,
    d: Mutex<JobData>,
}

impl Job {
    fn pool(&self) -> String {
        let d = self.d.lock().unwrap();
        d.settings_used.as_ref().and_then(|s| s.device.clone()).or_else(|| d.device.clone()).unwrap_or_else(|| DEFAULT_POOL.into())
    }
    fn state(&self) -> &'static str {
        self.d.lock().unwrap().state
    }
}

struct Pairing {
    code: String,
    expires_at: i64,
    tries: u32,
    by_address: HashMap<String, u32>,
}

#[derive(Default)]
struct State {
    pairing: Option<Pairing>,
    jobs: IndexMap<String, Arc<Job>>,
    waiting: Vec<Arc<Job>>,
    bad_tokens: HashMap<String, Vec<i64>>,
}

/// One of this server's own devices as listed to a main.
#[derive(Debug, Clone)]
pub struct WorkerDevice {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub device: Device,
    pub h265: Option<String>,
    pub av1: Option<String>,
}

#[derive(Default)]
struct DeviceCache {
    at: i64,
    list: Option<Vec<WorkerDevice>>,
}

/// An encode attempt: the encoder, its device, its decode arguments.
#[derive(Debug, Clone, PartialEq)]
pub struct Attempt {
    pub encoder: String,
    pub device: Option<Device>,
    pub decode: Vec<String>,
    pub hold_frames: i64,
}

pub type Spawn = Arc<dyn Fn(&str, &[String]) -> io::Result<Child> + Send + Sync>;

pub struct WorkerOptions {
    pub work_dir: PathBuf,
    /// os.hostname() unless given
    pub name: Option<String>,
    /// how ffmpeg is started (tests put a stand-in in front)
    pub spawn: Option<Spawn>,
}

struct Inner {
    ctx: Arc<dyn NodesCtx>,
    work_dir: PathBuf,
    name: String,
    spawn: Spawn,
    state: Mutex<State>,
    devices: Mutex<DeviceCache>,
    listing: Mutex<()>,
    known: Mutex<HashMap<String, Option<String>>>,
    hardware: Mutex<Option<(i64, Option<String>, Value)>>,
    closed: AtomicBool,
}

#[derive(Clone)]
pub struct NodeWorker(Arc<Inner>);

/// An error with a status (thrown with Object.assign(new Error, { status })).
#[derive(Debug, Clone)]
pub struct WorkerError {
    pub status: Option<u16>,
    pub message: String,
}

fn status_err(status: u16, message: &str) -> WorkerError {
    WorkerError { status: Some(status), message: message.into() }
}

fn plain_err(message: impl Into<String>) -> WorkerError {
    WorkerError { status: None, message: message.into() }
}

pub fn default_spawn(ffmpeg: String) -> Spawn {
    Arc::new(move |_cmd: &str, args: &[String]| {
        let mut c = Command::new(&ffmpeg);
        c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        // (NVIDIA GPUs by their PCI order, as nvidia-smi numbers them)
        if crate::converter::process::cuda_by_index(args) {
            c.env("CUDA_DEVICE_ORDER", "PCI_BUS_ID");
        }
        c.spawn()
    })
}

/// A request from a main, as core received it over HTTPS.
pub struct WorkerRequest<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub headers: &'a [(String, String)],
    /// the client's address (index.js clientKey), for the audit log and the throttle
    pub address: &'a str,
    /// the DER of the certificate this connection was served with (what the main saw)
    pub served_cert: Option<&'a [u8]>,
    pub body: &'a mut (dyn Read + Send),
}

impl WorkerRequest<'_> {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

pub enum ReplyBody {
    Bytes(Vec<u8>),
    /// the encoded file, `len` bytes
    File(File, u64),
    /// nothing is answered: the connection is closed (Node leaves such a request unanswered)
    Close,
}

/// An answer to a main. `delivered()` must be called once the whole answer
/// was written: an answer dropped unsent stops the job it names (the main
/// never got the job's id, so it could never ask for it or delete it).
pub struct WorkerReply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: ReplyBody,
    unsent: Option<(Weak<Inner>, String)>,
}

impl WorkerReply {
    pub fn json(status: u16, v: &Value) -> WorkerReply {
        let text = v.to_string().into_bytes();
        WorkerReply {
            status,
            headers: vec![("Content-Type".into(), "application/json; charset=utf-8".into()), ("Cache-Control".into(), "no-store".into()), ("Content-Length".into(), text.len().to_string())],
            body: ReplyBody::Bytes(text),
            unsent: None,
        }
    }
    fn error(status: u16, message: &str) -> WorkerReply {
        WorkerReply::json(status, &json!({ "error": message }))
    }
    pub fn delivered(mut self) {
        self.unsent = None;
    }
    pub fn body_json(&self) -> Value {
        match &self.body {
            ReplyBody::Bytes(b) => serde_json::from_slice(b).unwrap_or(Value::Null),
            _ => Value::Null,
        }
    }
}

impl Drop for WorkerReply {
    fn drop(&mut self) {
        if let Some((w, id)) = self.unsent.take() {
            if let Some(inner) = w.upgrade() {
                NodeWorker(inner).stop_by_id(&id);
            }
        }
    }
}

fn read_json_body(r: &mut dyn Read, limit: usize) -> Result<Value, WorkerError> {
    let mut data = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = r.read(&mut buf).map_err(|e| plain_err(e.to_string()))?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&buf[..n]);
        if data.len() > limit {
            return Err(status_err(413, "Too large."));
        }
    }
    let text = String::from_utf8_lossy(&data);
    let text = if text.is_empty() { "null".into() } else { text };
    serde_json::from_str(&text).map_err(|_| status_err(400, "Bad JSON."))
}

/// An MP4 starts with its ftyp box.
fn is_mp4(file: &Path) -> bool {
    let mut head = [0u8; 8];
    match File::open(file).and_then(|mut f| f.read_exact(&mut head)) {
        Ok(()) => &head[4..8] == b"ftyp" && u32::from_be_bytes([head[0], head[1], head[2], head[3]]) >= 8,
        Err(_) => false,
    }
}

/// diskSpace(workDir).free: the space a non-root user may still use.
fn disk_free(dir: &Path) -> io::Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).map_err(io::Error::other)?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let unit = if s.f_frsize > 0 { s.f_frsize as u64 } else { s.f_bsize as u64 };
    Ok(s.f_bavail as u64 * unit)
}

/// Number.parseFloat
fn parse_float(s: &str) -> f64 {
    let t = super::js_trim(s);
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    if t[i..].starts_with("Infinity") {
        return if b.first() == Some(&b'-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut any = i > start;
    if i < b.len() && b[i] == b'.' {
        let mut j = i + 1;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > i + 1 || any {
            any = any || j > i + 1;
            i = j;
        }
    }
    if !any {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        let k = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        if j > k {
            i = j;
        }
    }
    t[..i].parse().unwrap_or(f64::NAN)
}

/// the device clips without a device go to: the first GPU, else the CPU
fn default_device_of(list: Option<&Vec<WorkerDevice>>) -> String {
    list.and_then(|l| l.iter().find(|d| d.id != "cpu")).map(|d| d.id.clone()).unwrap_or_else(|| "cpu".into())
}

fn device_json(d: &Device) -> Value {
    json!({ "id": d.id, "kind": d.kind, "vendor": d.vendor, "name": d.name, "node": d.node, "index": d.index })
}

impl NodeWorker {
    pub fn new(ctx: Arc<dyn NodesCtx>, o: WorkerOptions) -> NodeWorker {
        // a fresh work folder on every start: files left by a restart are gone
        let _ = std::fs::remove_dir_all(&o.work_dir);
        let _ = std::fs::create_dir_all(&o.work_dir);
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&o.work_dir, std::fs::Permissions::from_mode(0o700));
        }
        let name = o.name.unwrap_or_else(|| ctx.hostname());
        let spawn = o.spawn.unwrap_or_else(|| default_spawn(ctx.ffmpeg_path()));
        let inner = Arc::new(Inner {
            ctx,
            work_dir: o.work_dir,
            name,
            spawn,
            state: Mutex::new(State::default()),
            devices: Mutex::new(DeviceCache::default()),
            listing: Mutex::new(()),
            known: Mutex::new(HashMap::new()),
            hardware: Mutex::new(None),
            closed: AtomicBool::new(false),
        });
        // finished or failed jobs the main never collected, and orphans
        let weak = Arc::downgrade(&inner);
        std::thread::spawn(move || loop {
            for _ in 0..600 {
                std::thread::sleep(Duration::from_millis(100));
                match weak.upgrade() {
                    Some(i) if !i.closed.load(Ordering::SeqCst) => {}
                    _ => return,
                }
            }
            let Some(i) = weak.upgrade() else { return };
            NodeWorker(i).sweep();
        });
        NodeWorker(inner)
    }

    fn ctx(&self) -> &dyn NodesCtx {
        &*self.0.ctx
    }

    fn now(&self) -> i64 {
        self.ctx().now_ms()
    }

    pub fn settings(&self) -> Settings {
        let s = self.ctx().setting(SETTINGS_KEY).filter(|v| v.is_object()).unwrap_or_else(|| json!({}));
        let slots = safe_int(&s["slots"]).filter(|n| (1..=MAX_SLOTS).contains(n)).unwrap_or(DEFAULT_SLOTS);
        let use_ = s["use"].as_str().filter(|u| USES.contains(u)).unwrap_or("gpu").to_string();
        let mut device_slots = IndexMap::new();
        if let Some(o) = s["deviceSlots"].as_object() {
            for (k, v) in o {
                if let Some(n) = safe_int(v).filter(|n| (0..=MAX_SLOTS).contains(n)) {
                    if is_local_device(k) {
                        device_slots.insert(k.clone(), n);
                    }
                }
            }
        }
        let mains = s["mains"].as_array().map(|a| a.iter().filter(|m| m["tokenHash"].is_string()).cloned().collect()).unwrap_or_default();
        Settings { enabled: s["enabled"] == json!(true), slots, use_, device_slots, mains }
    }

    fn save(&self, s: &Settings) {
        self.ctx().set_setting(SETTINGS_KEY, &s.to_json());
    }

    // ---- what the Nodes page shows and changes

    pub fn status(&self) -> Value {
        let s = self.settings();
        let now = self.now();
        let st = self.0.state.lock().unwrap();
        let busy = running(&st, None);
        let pairing = st.pairing.as_ref().filter(|p| p.expires_at > now).map(|p| json!({ "code": p.code, "expiresAt": p.expires_at })).unwrap_or(Value::Null);
        let mains: Vec<Value> = s.mains.iter().map(|m| {
            let or_null = |v: &Value| if crate::ops::js::truthy(v) { v.clone() } else { Value::Null };
            let mut o = Map::new();
            o.insert("id".into(), m["id"].clone());
            o.insert("name".into(), m["name"].clone());
            o.insert("address".into(), or_null(&m["address"]));
            if m.get("pairedAt").is_some() {
                o.insert("pairedAt".into(), m["pairedAt"].clone());
            }
            o.insert("lastSeenAt".into(), or_null(&m["lastSeenAt"]));
            // (JSON.stringify leaves out what is undefined)
            if m.get("id").is_none() {
                o.shift_remove("id");
            }
            if m.get("name").is_none() {
                o.shift_remove("name");
            }
            Value::Object(o)
        }).collect();
        json!({ "enabled": s.enabled, "slots": s.slots, "use": s.use_, "busy": busy, "pairing": pairing, "mains": mains })
    }

    /// setEnabled(enabled, slots, use): `slots` / `use` None when not given.
    pub fn set_enabled(&self, enabled: bool, slots: Option<&Value>, use_: Option<&Value>) -> Result<Value, WorkerError> {
        let s = self.settings();
        let mut next = s.clone();
        next.enabled = enabled;
        if let Some(u) = use_ {
            match u.as_str().filter(|x| USES.contains(x)) {
                Some(x) => next.use_ = x.into(),
                None => return Err(status_err(400, "Encode with: gpu, gpu-cpu or cpu.")),
            }
        }
        if let Some(n) = slots {
            match safe_int(n).filter(|n| (1..=MAX_SLOTS).contains(n)) {
                Some(x) => next.slots = x,
                None => return Err(status_err(400, &format!("Clips at once: 1 to {MAX_SLOTS}."))),
            }
        }
        if !next.enabled {
            let jobs: Vec<Arc<Job>> = {
                let mut st = self.0.state.lock().unwrap();
                st.pairing = None;
                st.jobs.values().cloned().collect()
            };
            for j in jobs {
                self.stop_job(&j);
            }
        }
        self.save(&next);
        self.pump();
        Ok(self.status())
    }

    /// A new one-time code (replaces any earlier one). Worker mode turns on.
    pub fn start_pairing(&self) -> Value {
        let s = self.settings();
        if !s.enabled {
            let mut n = s.clone();
            n.enabled = true;
            self.save(&n);
        }
        let expires_at = self.now() + PAIR_TTL_MS;
        self.0.state.lock().unwrap().pairing = Some(Pairing { code: new_pairing_code(), expires_at, tries: 0, by_address: HashMap::new() });
        self.status()
    }

    pub fn cancel_pairing(&self) -> Value {
        self.0.state.lock().unwrap().pairing = None;
        self.status()
    }

    /// revoke(id): the main removed, its jobs stopped; None when unknown.
    pub fn revoke(&self, id: &str) -> Option<Value> {
        let s = self.settings();
        let main = s.mains.iter().find(|m| m["id"].as_str() == Some(id))?.clone();
        let mut n = s.clone();
        n.mains.retain(|m| m["id"].as_str() != Some(id));
        self.save(&n);
        let jobs: Vec<Arc<Job>> = self.0.state.lock().unwrap().jobs.values().cloned().collect();
        for j in jobs {
            if j.d.lock().unwrap().main_id == id {
                self.stop_job(&j);
            }
        }
        Some(main)
    }

    pub fn close(&self) {
        self.0.closed.store(true, Ordering::SeqCst);
        let jobs: Vec<Arc<Job>> = self.0.state.lock().unwrap().jobs.values().cloned().collect();
        for j in jobs {
            self.stop_job(&j);
        }
    }

    // ---- jobs

    fn stop_job(&self, job: &Arc<Job>) {
        if job.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        let id = job.d.lock().unwrap().id.clone();
        {
            let mut st = self.0.state.lock().unwrap();
            st.waiting.retain(|j| !Arc::ptr_eq(j, job));
            st.jobs.shift_remove(&id);
        }
        let (child, input, output) = {
            let d = job.d.lock().unwrap();
            (d.child.clone(), d.input.clone(), d.output.clone())
        };
        if let Some(c) = child {
            let _ = c.lock().unwrap().kill();
        }
        let _ = std::fs::remove_file(input);
        let _ = std::fs::remove_file(output);
    }

    fn stop_by_id(&self, id: &str) {
        let job = self.0.state.lock().unwrap().jobs.get(id).cloned();
        if let Some(j) = job {
            self.stop_job(&j);
        }
    }

    fn sweep(&self) {
        let now = self.now();
        let jobs: Vec<Arc<Job>> = self.0.state.lock().unwrap().jobs.values().cloned().collect();
        for j in jobs {
            let (state, ended, seen) = {
                let d = j.d.lock().unwrap();
                (d.state, d.ended_at, d.seen_at)
            };
            if (state == "done" || state == "failed") && now - ended > DONE_TTL_MS {
                self.stop_job(&j);
            } else if (state == "encoding" || state == "queued") && now - seen > ORPHAN_MS {
                self.stop_job(&j);
            }
        }
    }

    /// Clips at once per device, as the main set them; a device it never
    /// set: the default device has the old single number, the others are off.
    fn slots_for(&self, pool: &str, s: &Settings) -> i64 {
        if pool == DEFAULT_POOL {
            return s.slots;
        }
        if let Some(n) = s.device_slots.get(pool) {
            return *n;
        }
        let cache = self.0.devices.lock().unwrap();
        if pool == default_device_of(cache.list.as_ref()) {
            s.slots
        } else {
            0
        }
    }

    /// Starts waiting clips while their device has a free slot, oldest first.
    fn pump(&self) {
        let s = self.settings();
        let mut start = Vec::new();
        {
            let mut st = self.0.state.lock().unwrap();
            let mut at = 0;
            while at < st.waiting.len() {
                let next = st.waiting[at].clone();
                if next.stopped.load(Ordering::SeqCst) {
                    st.waiting.remove(at);
                    continue;
                }
                let pool = next.pool();
                let limit = if next.d.lock().unwrap().benchmark { MAX_SLOTS } else { self.slots_for(&pool, &s) };
                if encoding(&st, Some(&pool)) as i64 >= limit {
                    at += 1;
                    continue;
                }
                st.waiting.remove(at);
                next.d.lock().unwrap().state = "encoding";
                start.push(next);
            }
        }
        for job in start {
            let w = self.clone();
            std::thread::spawn(move || {
                w.encode(&job);
                w.pump();
            });
        }
    }

    // ---- this server's own devices (its GPUs and its CPU, never its nodes)

    fn list_devices(&self) -> Option<Vec<WorkerDevice>> {
        let rt = self.ctx().runtime()?;
        let found = rt.local_devices()?;
        let found = found.unwrap_or_default();
        let mut list: Vec<Device> = found.into_iter().filter(|d| is_local_device(&d.id)).take(MAX_DEVICES).collect();
        if !list.iter().any(|d| d.id == "cpu") {
            list.push(Device { id: "cpu".into(), kind: "cpu".into(), name: Some("CPU (software encoder)".into()), ..Default::default() });
        }
        // a GPU is not test-encoded while it converts (it could fail for being busy)
        let probe = encoding(&self.0.state.lock().unwrap(), None) == 0 && !rt.encoding_now();
        let out = list.into_iter().map(|device| {
            let mut enc: [Option<String>; 2] = [None, None];
            for (i, family) in ["h265", "av1"].iter().enumerate() {
                let key = format!("{}:{family}", device.id);
                let chosen: Result<Option<Selected>, String> = if device.id == "cpu" {
                    rt.cpu_encoder(family).map(Some)
                } else {
                    rt.select_encoder_for(family, &device, probe).unwrap_or(Ok(None))
                };
                match chosen {
                    Ok(Some(c)) if !c.timed_out => {
                        let v = (device.id == "cpu" || c.hardware).then(|| c.codec.clone()).filter(|c| !c.is_empty());
                        self.0.known.lock().unwrap().insert(key.clone(), v);
                    }
                    Ok(_) => {}
                    Err(_) => {
                        self.0.known.lock().unwrap().insert(key.clone(), None);
                    }
                }
                enc[i] = self.0.known.lock().unwrap().get(&key).cloned().flatten();
            }
            let kind = if device.id == "cpu" {
                "cpu".to_string()
            } else {
                Some(peer_text(&json!(device.kind), 64)).filter(|k| !k.is_empty()).unwrap_or_else(|| "gpu".into())
            };
            let name = Some(peer_text(&json!(device.name), 64)).filter(|n| !n.is_empty()).unwrap_or_else(|| device.id.clone());
            let [h265, av1] = enc;
            WorkerDevice { id: device.id.clone(), kind, name, device, h265, av1 }
        }).collect();
        Some(out)
    }

    /// devices(): the listing, reused for 30 s; one listing at a time.
    pub fn devices(&self) -> Option<Vec<WorkerDevice>> {
        {
            let c = self.0.devices.lock().unwrap();
            if c.list.is_some() && self.now() - c.at < DEVICES_TTL_MS {
                return c.list.clone();
            }
        }
        let _one = self.0.listing.lock().unwrap();
        {
            let c = self.0.devices.lock().unwrap();
            if c.list.is_some() && self.now() - c.at < DEVICES_TTL_MS {
                return c.list.clone();
            }
        }
        let list = self.list_devices();
        let mut c = self.0.devices.lock().unwrap();
        *c = DeviceCache { at: self.now(), list: list.clone() };
        list
    }

    fn hardware_of(&self, list: &[WorkerDevice]) -> Option<Value> {
        let now = self.now();
        let (cpu, found) = {
            let mut g = self.0.hardware.lock().unwrap();
            match &*g {
                Some((at, cpu, found)) if now - at < HARDWARE_TTL_MS => (cpu.clone(), found.clone()),
                _ => {
                    let (cpu, found) = self.ctx().own_gpus()?;
                    *g = Some((now, cpu.clone(), found.clone()));
                    (cpu, found)
                }
            }
        };
        let gpus: Vec<Value> = crate::ops::gpu::usable_gpus(&found).iter().map(|g| g["name"].clone()).collect();
        let devices: Vec<Value> = list.iter().map(|d| {
            let name = if d.id == "cpu" {
                json!(cpu)
            } else {
                let dev = if d.device.kind == "nvidia" && d.device.index.is_some() { d.device.index.map(|i| format!("nvidia{i}")) } else { d.device.node.clone() };
                json!(crate::ops::gpu::encode_gpu_name(&found, dev.as_deref(), None, d.device.vendor.as_deref()))
            };
            json!({ "id": d.id, "name": name })
        }).collect();
        Some(json!({ "cpu": cpu, "gpus": gpus, "devices": devices }))
    }

    /// GET /node/v1/info
    pub fn info(&self) -> Value {
        let rt = self.ctx().runtime();
        let s = self.settings();
        let mut encoders = Map::new();
        for family in ["h265", "av1"] {
            let chosen = match &rt {
                None => None,
                Some(r) if s.use_ == "cpu" => r.cpu_encoder(family).ok(),
                Some(r) => r.select_encoder(family).ok().flatten(),
            };
            encoders.insert(family.into(), chosen.map(|c| json!(c.codec)).unwrap_or(Value::Null));
        }
        let list = self.devices();
        let st = self.0.state.lock().unwrap();
        let mut out = Map::new();
        out.insert("name".into(), json!(self.0.name));
        out.insert("encoders".into(), Value::Object(encoders));
        out.insert("slots".into(), json!(s.slots));
        out.insert("use".into(), json!(s.use_));
        out.insert("busy".into(), json!(running(&st, None)));
        out.insert("encoding".into(), json!(encoding(&st, None)));
        out.insert("capacity".into(), json!(s.slots + QUEUE));
        drop(st);
        if let Some(p) = self.ctx().own_power() {
            out.insert("power".into(), p);
        }
        if let Some(h) = self.hardware_of(list.as_deref().unwrap_or(&[])) {
            out.insert("hardware".into(), h);
        }
        if let Some(list) = &list {
            out.insert("defaultDevice".into(), json!(default_device_of(Some(list))));
            let st = self.0.state.lock().unwrap();
            let devs: Vec<Value> = list.iter().map(|d| {
                let slots = self.slots_for(&d.id, &s);
                json!({ "id": d.id, "kind": d.kind, "name": d.name, "encoders": { "h265": d.h265, "av1": d.av1 }, "slots": slots,
                    "busy": running(&st, Some(&d.id)), "encoding": encoding(&st, Some(&d.id)), "capacity": slots + QUEUE })
            }).collect();
            out.insert("devices".into(), Value::Array(devs));
        }
        Value::Object(out)
    }

    /// Encode attempts, fastest first (attemptsFor).
    pub fn attempts(&self, codec: &str, hold_frames: i64, device_id: Option<&str>) -> Result<Vec<Attempt>, WorkerError> {
        let Some(rt) = self.ctx().runtime() else { return Err(status_err(503, "The converter is starting.")) };
        let platform = rt.platform();
        let with_hold = |list: Vec<(String, Option<Device>, Vec<String>)>| list.into_iter().map(|(encoder, device, decode)| Attempt { encoder, device, decode, hold_frames }).collect();
        if let Some(id) = device_id {
            return self.device_attempts(&*rt, codec, id, &platform).map(with_hold);
        }
        let use_ = self.settings().use_;
        let mut list = Vec::new();
        let selected = if use_ != "cpu" { rt.select_encoder(codec).ok().flatten() } else { None };
        let gpu = selected.as_ref().is_some_and(|s| s.hardware);
        if gpu {
            let s = selected.unwrap();
            let accel = planner::decode_accel_args(&s.codec, &platform, None, false, s.device.as_ref()).map_err(plain_err)?;
            if let Some(a) = accel {
                list.push((s.codec.clone(), s.device.clone(), a));
            }
            list.push((s.codec.clone(), s.device.clone(), vec![]));
        }
        if !gpu || use_ == "gpu-cpu" {
            let cpu = rt.cpu_encoder(codec).map_err(plain_err)?;
            list.push((cpu.codec, None, vec![]));
        }
        Ok(with_hold(list))
    }

    fn device_attempts(&self, rt: &dyn WorkerRuntime, codec: &str, device_id: &str, platform: &str) -> Result<Vec<(String, Option<Device>, Vec<String>)>, WorkerError> {
        if device_id == "cpu" {
            let cpu = rt.cpu_encoder(codec).map_err(plain_err)?;
            return Ok(vec![(cpu.codec, None, vec![])]);
        }
        let listed = self.devices().unwrap_or_default().into_iter().find(|d| d.id == device_id);
        let Some(listed) = listed else { return Err(status_err(400, "No such device here.")) };
        let Some(selected) = rt.select_encoder_for(codec, &listed.device, true) else { return Err(status_err(400, "No such device here.")) };
        let selected = selected.map_err(plain_err)?;
        let Some(s) = selected.filter(|s| s.hardware) else { return Err(plain_err(format!("{} cannot encode {codec}", listed.name))) };
        let mut list = Vec::new();
        if let Some(a) = planner::decode_accel_args(&s.codec, platform, None, false, s.device.as_ref()).map_err(plain_err)? {
            list.push((s.codec.clone(), s.device.clone(), a));
        }
        list.push((s.codec.clone(), s.device.clone(), vec![]));
        Ok(list)
    }

    /// runFfmpeg: Ok(true) when the encode finished, Ok(false) when it failed
    /// (the next attempt is tried), Err when its arguments could not be built.
    fn run_ffmpeg(&self, job: &Arc<Job>, attempt: &Attempt, s: &JobSettings) -> Result<bool, String> {
        if job.stopped.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let encode_args = planner::build_encode_args(&EncodeArgs {
            codec: &s.codec,
            encoder: &attempt.encoder,
            bitrate: s.bitrate.map(|b| b as f64),
            quality: s.quality.as_deref(),
            device: attempt.device.as_ref(),
            hold_frames: attempt.hold_frames.max(0),
            ..Default::default()
        })?;
        let (input, output, input_bytes, main_name) = {
            let d = job.d.lock().unwrap();
            (d.input.clone(), d.output.clone(), d.input_bytes, d.main_name.clone())
        };
        let mut args: Vec<String> = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"].iter().map(|x| x.to_string()).collect();
        args.extend(attempt.decode.iter().cloned());
        args.extend(["-protocol_whitelist", "file", "-f", "mov", "-i"].iter().map(|x| x.to_string()));
        args.push(input.to_string_lossy().into_owned());
        args.extend(encode_args);
        args.extend(["-an", "-sn", "-dn"].iter().map(|x| x.to_string()));
        if let Some(d) = s.duration_us {
            args.extend(["-t".to_string(), ((d as f64 / 1e6).ceil() as i64 + 5).to_string()]);
        }
        args.extend(["-fs".to_string(), (input_bytes * 2 + 1024 * 1024).to_string()]);
        args.extend(["-progress", "pipe:1", "-nostats", "-f", "mp4"].iter().map(|x| x.to_string()));
        args.push(output.to_string_lossy().into_owned());
        let ffmpeg = self.ctx().ffmpeg_path();
        let mut child = match (self.0.spawn)(&ffmpeg, &args) {
            Ok(c) => c,
            Err(_) => return Ok(false),
        };
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let child = Arc::new(Mutex::new(child));
        {
            let mut d = job.d.lock().unwrap();
            d.child = Some(child.clone());
            d.encoder = Some(attempt.encoder.clone());
        }
        // stopped while it started: no encode runs on
        if job.stopped.load(Ordering::SeqCst) {
            let _ = child.lock().unwrap().kill();
        }
        // the stall watch: killed after STALL_MS without a progress line
        let last = Arc::new(Mutex::new(std::time::Instant::now()));
        let errors = Arc::new(Mutex::new(String::new()));
        let err_thread = stderr.map(|mut e| {
            let errors = errors.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                while let Ok(n) = e.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let mut g = errors.lock().unwrap();
                    g.push_str(&String::from_utf8_lossy(&buf[..n]));
                    let keep: String = tail_units(&g, 400);
                    *g = keep;
                }
            })
        });
        let out_thread = stdout.map(|o| {
            let job = job.clone();
            let last = last.clone();
            std::thread::spawn(move || {
                let r = BufReader::new(o);
                for line in r.split(b'\n') {
                    let Ok(line) = line else { break };
                    *last.lock().unwrap() = std::time::Instant::now();
                    let line = String::from_utf8_lossy(&line);
                    let line = line.strip_suffix('\r').unwrap_or(&line);
                    let Some(eq) = line.find('=') else { continue };
                    let (key, value) = (&line[..eq], super::js_trim(&line[eq + 1..]));
                    let mut d = job.d.lock().unwrap();
                    match key {
                        "out_time_us" | "out_time_ms" => {
                            let n = crate::ops::js::number_str(value);
                            if n.is_finite() && n.fract() == 0.0 && n >= 0.0 && n <= 9_007_199_254_740_991.0 {
                                d.out_time_us = Some(n as i64);
                            }
                        }
                        "fps" => {
                            let n = crate::ops::js::number_str(value);
                            if n.is_finite() && n >= 0.0 {
                                d.fps = Some(n);
                            }
                        }
                        "speed" => {
                            let n = parse_float(value);
                            d.speed = n.is_finite().then_some(n);
                        }
                        _ => {}
                    }
                }
            })
        });
        let status = loop {
            if let Ok(Some(st)) = child.lock().unwrap().try_wait() {
                break st;
            }
            if last.lock().unwrap().elapsed() > Duration::from_millis(STALL_MS) {
                let _ = child.lock().unwrap().kill();
            }
            std::thread::sleep(Duration::from_millis(25));
        };
        if let Some(t) = out_thread {
            let _ = t.join();
        }
        if let Some(t) = err_thread {
            let _ = t.join();
        }
        job.d.lock().unwrap().child = None;
        let ok = status.success();
        if !ok && !job.stopped.load(Ordering::SeqCst) {
            let text = errors.lock().unwrap().clone();
            let mut cleaned = String::new();
            let mut in_ctl = false;
            for c in text.chars() {
                let u = c as u32;
                if u <= 0x1f || (0x7f..=0x9f).contains(&u) {
                    if !in_ctl {
                        cleaned.push(' ');
                    }
                    in_ctl = true;
                } else {
                    cleaned.push(c);
                    in_ctl = false;
                }
            }
            let trimmed = super::js_trim(&cleaned);
            let why = tail_units(trimmed, 200);
            let why = if why.is_empty() { format!("exit {}", status.code().map(|c| c.to_string()).unwrap_or_else(|| "null".into())) } else { why };
            self.ctx().log(Level::Warn, &format!("Node: {}{} could not encode a clip from {main_name}: {why}", attempt.encoder, if attempt.decode.is_empty() { "" } else { " (GPU decode)" }));
        }
        Ok(ok)
    }

    fn encode(&self, job: &Arc<Job>) {
        let (settings, output, input, main_name) = {
            let mut d = job.d.lock().unwrap();
            d.state = "encoding";
            (d.settings_used.clone().expect("a queued job has its settings"), d.output.clone(), d.input.clone(), d.main_name.clone())
        };
        let result: Result<(), String> = (|| {
            let attempts = self.attempts(&settings.codec, settings.hold_frames, settings.device.as_deref()).map_err(|e| e.message)?;
            for attempt in attempts {
                if job.stopped.load(Ordering::SeqCst) {
                    return Ok(());
                }
                let _ = std::fs::remove_file(&output);
                if job.stopped.load(Ordering::SeqCst) {
                    return Ok(());
                }
                if self.run_ffmpeg(job, &attempt, &settings)? {
                    let size = std::fs::metadata(&output).map_err(|e| e.to_string())?.len();
                    let mut d = job.d.lock().unwrap();
                    d.output_bytes = Some(size);
                    d.state = "done";
                    d.ended_at = self.now();
                    drop(d);
                    let _ = std::fs::remove_file(&input);
                    return Ok(());
                }
            }
            Err("every encoder failed".into())
        })();
        if let Err(message) = result {
            if job.stopped.load(Ordering::SeqCst) {
                return;
            }
            {
                let mut d = job.d.lock().unwrap();
                d.state = "failed";
                d.error = Some("encode-failed".into());
                d.ended_at = self.now();
            }
            self.ctx().log(Level::Warn, &format!("Node: a clip from {main_name} could not be encoded ({message})"));
            let _ = std::fs::remove_file(&input);
            let _ = std::fs::remove_file(&output);
        }
    }

    fn receive(&self, r: &mut WorkerRequest, main_id: &str, main_name: &str) -> WorkerReply {
        let Some(settings_used) = parse_job_settings(r.header("x-node-job")) else { return WorkerReply::error(400, "Bad encode settings.") };
        let length = r.header("content-length").map(crate::ops::js::number_str).unwrap_or(0.0);
        if !(length.is_finite() && length.fract() == 0.0 && length > 0.0 && length <= 9_007_199_254_740_991.0) {
            return WorkerReply::error(411, "The clip size is needed.");
        }
        let length = length as u64;
        if length > MAX_CLIP_BYTES {
            return WorkerReply::error(413, "Clip too large.");
        }
        let benchmark = r.header("x-node-benchmark") == Some("1");
        if let Some(dev) = &settings_used.device {
            if !self.devices().unwrap_or_default().iter().any(|d| &d.id == dev) {
                return WorkerReply::error(400, "No such device on this node.");
            }
        }
        let pool = settings_used.device.clone().unwrap_or_else(|| DEFAULT_POOL.into());
        let s = self.settings();
        let slots = if benchmark { MAX_SLOTS } else { self.slots_for(&pool, &s) };
        if slots == 0 {
            return WorkerReply::error(503, "That device is set to Off on this node.");
        }
        let limit = if benchmark { MAX_SLOTS } else { slots + QUEUE };
        let id = hex(&random_bytes(16));
        let job = Arc::new(Job {
            stopped: AtomicBool::new(false),
            d: Mutex::new(JobData {
                id: id.clone(), main_id: main_id.into(), main_name: main_name.into(), state: "receiving",
                input: self.0.work_dir.join(format!("{id}-in.mp4")), output: self.0.work_dir.join(format!("{id}-out.mp4")),
                out_time_us: None, fps: None, speed: None, encoder: None, error: None, output_bytes: None,
                seen_at: self.now(), ended_at: 0, input_bytes: length, device: settings_used.device.clone(),
                settings_used: None, benchmark, child: None,
            }),
        });
        {
            let mut st = self.0.state.lock().unwrap();
            let held = st.jobs.values().filter(|j| j.pool() == pool).count() as i64;
            if running(&st, Some(&pool)) as i64 >= limit || held >= limit + slots || st.jobs.len() >= MAX_HELD {
                return WorkerReply::error(503, "All of this node's slots are busy.");
            }
            // room for the clip and its encode, and some to spare for this server
            if let Ok(free) = disk_free(&self.0.work_dir) {
                if free < length.saturating_mul(3).saturating_add(DISK_SPARE) {
                    return WorkerReply::error(507, "This node is short of disk space.");
                }
            }
            st.jobs.insert(id.clone(), job.clone());
        }
        let input = job.d.lock().unwrap().input.clone();
        let file = {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&input)
        };
        let mut received: u64 = 0;
        let whole = match file {
            Err(_) => false,
            Ok(mut f) => {
                let mut buf = vec![0u8; 256 * 1024];
                let mut ok = true;
                while received < length {
                    if job.stopped.load(Ordering::SeqCst) {
                        ok = false;
                        break;
                    }
                    let want = ((length - received) as usize).min(buf.len());
                    match r.body.read(&mut buf[..want]) {
                        Ok(0) => break,
                        Ok(n) => {
                            if f.write_all(&buf[..n]).is_err() {
                                ok = false;
                                break;
                            }
                            received += n as u64;
                        }
                        Err(_) => {
                            ok = false;
                            break;
                        }
                    }
                }
                ok && f.flush().is_ok() && received == length
            }
        };
        if job.stopped.load(Ordering::SeqCst) {
            // stopped while it arrived (revoked, node mode off): no answer, as Node
            return WorkerReply { status: 0, headers: vec![], body: ReplyBody::Close, unsent: None };
        }
        if !whole {
            self.stop_job(&job);
            return WorkerReply::error(400, "The clip did not arrive whole.");
        }
        if !is_mp4(&input) {
            self.stop_job(&job);
            return WorkerReply::error(415, "Not an MP4 clip.");
        }
        let mut reply = WorkerReply::json(200, &json!({ "id": id }));
        reply.unsent = Some((Arc::downgrade(&self.0), id.clone()));
        {
            let mut d = job.d.lock().unwrap();
            d.settings_used = Some(settings_used);
            d.benchmark = benchmark;
            d.state = "queued";
        }
        self.0.state.lock().unwrap().waiting.push(job);
        self.pump();
        reply
    }

    fn throttled(&self, address: &str) -> bool {
        let since = self.now() - BAD_TOKEN_WINDOW_MS;
        let mut st = self.0.state.lock().unwrap();
        let list: Vec<i64> = st.bad_tokens.get(address).cloned().unwrap_or_default().into_iter().filter(|t| *t > since).collect();
        let n = list.len();
        st.bad_tokens.insert(address.into(), list);
        n >= BAD_TOKEN_LIMIT
    }

    fn note_bad_token(&self, address: &str) {
        let now = self.now();
        let mut st = self.0.state.lock().unwrap();
        let mut list = st.bad_tokens.get(address).cloned().unwrap_or_default();
        list.push(now);
        let cut = list.len().saturating_sub(BAD_TOKEN_LIMIT);
        st.bad_tokens.insert(address.into(), list.split_off(cut));
        if st.bad_tokens.len() > 1000 {
            st.bad_tokens.clear();
        }
    }

    fn authenticate(&self, r: &WorkerRequest) -> Option<Value> {
        let header = r.header("authorization").unwrap_or("");
        let token = header.strip_prefix("Bearer ")?;
        if token.len() != 43 || !token.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
            return None;
        }
        let hash = sha256_hex(token.as_bytes());
        self.settings().mains.into_iter().find(|m| m["tokenHash"].as_str().is_some_and(|h| same_hex(h, &hash)))
    }

    fn pair(&self, r: &mut WorkerRequest) -> Result<WorkerReply, WorkerError> {
        if r.method != "POST" {
            return Ok(WorkerReply::error(405, "Use POST."));
        }
        let now = self.now();
        {
            let mut st = self.0.state.lock().unwrap();
            let live = st.pairing.as_ref().is_some_and(|p| p.expires_at > now);
            if !self.settings().enabled || !live {
                st.pairing = None;
                return Ok(WorkerReply::error(403, "This server is not waiting to be paired. Show a pairing code under Nodes first."));
            }
            if st.pairing.as_ref().and_then(|p| p.by_address.get(r.address)).copied().unwrap_or(0) >= PAIR_TRIES_PER_ADDRESS {
                return Ok(WorkerReply::error(429, "Too many wrong pairing codes from this address."));
            }
        }
        let body = read_json_body(r.body, 4096)?;
        let main_name = body["name"].as_str().map(|n| peer_str(n, 64)).unwrap_or_default();
        let fingerprint = r.served_cert.and_then(cert_fingerprint);
        let (Some(fingerprint), Some(proof)) = (fingerprint.filter(|_| !main_name.is_empty()), body["proof"].as_str()) else {
            return Ok(WorkerReply::error(400, "Bad pairing request."));
        };
        let mut st = self.0.state.lock().unwrap();
        // (the code shown now: one shown again while this request was read replaces it)
        let Some(p) = st.pairing.as_mut() else {
            return Ok(WorkerReply::error(403, "This server is not waiting to be paired. Show a pairing code under Nodes first."));
        };
        let code = normalize_code(&json!(p.code));
        if !same_hex(proof, &hmac_hex(&code, &pair_text::main(&fingerprint, &main_name))) {
            p.tries += 1;
            *p.by_address.entry(r.address.to_string()).or_insert(0) += 1;
            let tries = p.tries;
            self.ctx().audit(Level::Warn, &format!("Node pairing refused (wrong code or a different certificate) from {}", r.address));
            if tries >= PAIR_TRIES {
                st.pairing = None;
            }
            return Ok(WorkerReply::error(403, "Wrong pairing code."));
        }
        st.pairing = None;
        drop(st);
        let token = base64url(&random_bytes(32));
        let s = self.settings();
        let main = json!({ "id": hex(&random_bytes(6)), "name": main_name, "address": r.address, "tokenHash": sha256_hex(token.as_bytes()), "pairedAt": now });
        let mut n = s.clone();
        n.enabled = true;
        n.mains.push(main);
        let cut = n.mains.len().saturating_sub(16);
        n.mains = n.mains.split_off(cut);
        self.save(&n);
        self.ctx().audit(Level::Info, &format!("Paired with main server \"{main_name}\" at {}", r.address));
        let ca = self.ctx().authority_pem();
        Ok(WorkerReply::json(200, &json!({ "name": self.0.name, "token": token, "proof": hmac_hex(&code, &pair_text::worker(&fingerprint, &token)), "authority": ca })))
    }

    /// handle(req, res, p, address): /node/v1/... (None: not a node path).
    pub fn handle(&self, r: &mut WorkerRequest) -> Option<WorkerReply> {
        if !r.path.starts_with("/node/v1/") {
            return None;
        }
        Some(match self.handle_inner(r) {
            Ok(reply) => reply,
            Err(e) => match e.status {
                Some(s) => WorkerReply::error(s, &e.message),
                None => WorkerReply::error(500, "Node error."),
            },
        })
    }

    fn handle_inner(&self, r: &mut WorkerRequest) -> Result<WorkerReply, WorkerError> {
        if !self.settings().enabled {
            return Ok(WorkerReply::error(404, "Not found"));
        }
        if r.path == "/node/v1/pair" {
            return self.pair(r);
        }
        if self.throttled(r.address) {
            return Ok(WorkerReply::error(429, "Too many refused requests."));
        }
        let Some(main) = self.authenticate(r) else {
            self.note_bad_token(r.address);
            return Ok(WorkerReply::error(401, "Not paired."));
        };
        let main_id = js_text(&main["id"]);
        let main_name = main["name"].as_str().map(String::from).unwrap_or_else(|| crate::ops::js::to_string(&main["name"]));
        let now = self.now();
        if now - safe_int(&main["lastSeenAt"]).unwrap_or(0) > 60_000 {
            let mut s = self.settings();
            for m in s.mains.iter_mut() {
                if m["id"] == main["id"] {
                    if let Some(o) = m.as_object_mut() {
                        o.insert("lastSeenAt".into(), json!(now));
                        o.insert("address".into(), json!(r.address));
                    }
                }
            }
            self.save(&s);
        }
        let (m, p) = (r.method, r.path);
        if p == "/node/v1/info" && m == "GET" {
            return Ok(WorkerReply::json(200, &self.info()));
        }
        if p == "/node/v1/jobs" && m == "POST" {
            return Ok(self.receive(r, &main_id, &main_name));
        }
        if p == "/node/v1/slots" && m == "POST" {
            let body = read_json_body(r.body, 4096)?;
            if let Some(obj) = body["slots"].as_object() {
                let list = self.devices().unwrap_or_default();
                let bad = obj.is_empty() || obj.len() > MAX_DEVICES || obj.iter().any(|(id, n)| !list.iter().any(|d| &d.id == id) || safe_int(n).is_none_or(|n| !(0..=MAX_SLOTS).contains(&n)));
                if bad {
                    return Ok(WorkerReply::error(400, &format!("Clips at once per device of this node: 0 to {MAX_SLOTS}.")));
                }
                let mut s = self.settings();
                for (id, n) in obj {
                    s.device_slots.insert(id.clone(), safe_int(n).unwrap());
                }
                self.save(&s);
                self.pump();
                let named: Vec<String> = obj.iter().map(|(id, n)| format!("{} {}", list.iter().find(|d| &d.id == id).map(|d| d.name.as_str()).unwrap_or(""), safe_int(n).unwrap())).collect();
                self.ctx().audit(Level::Info, &format!("Main server \"{main_name}\" set this node's clips at once: {}", named.join(", ")));
                let mut ds = Map::new();
                for (k, v) in &s.device_slots {
                    ds.insert(k.clone(), json!(v));
                }
                return Ok(WorkerReply::json(200, &json!({ "slots": ds })));
            }
            let Some(n) = safe_int(&body["slots"]).filter(|n| (1..=MAX_SLOTS).contains(n)) else {
                return Ok(WorkerReply::error(400, &format!("Clips at once: 1 to {MAX_SLOTS}.")));
            };
            let mut s = self.settings();
            s.slots = n;
            self.save(&s);
            self.pump();
            self.ctx().audit(Level::Info, &format!("Main server \"{main_name}\" set this node to {n} clips at once"));
            return Ok(WorkerReply::json(200, &json!({ "slots": n })));
        }
        let rest = p.strip_prefix("/node/v1/jobs/").unwrap_or("");
        let (jid, output) = match rest.strip_suffix("/output") {
            Some(x) => (x, true),
            None => (rest, false),
        };
        let valid = jid.len() == 32 && jid.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
        let job = if valid { self.0.state.lock().unwrap().jobs.get(jid).cloned() } else { None };
        let Some(job) = job.filter(|j| j.d.lock().unwrap().main_id == main_id) else {
            return Ok(WorkerReply::error(404, "No such job."));
        };
        job.d.lock().unwrap().seen_at = now;
        if !output && m == "GET" {
            let d = job.d.lock().unwrap();
            let v = json!({ "id": d.id, "state": d.state, "outTimeUs": d.out_time_us, "fps": d.fps.map(super::jnum), "speed": d.speed.map(super::jnum),
                "encoder": d.encoder, "error": d.error, "outputBytes": d.output_bytes.filter(|b| *b > 0) });
            return Ok(WorkerReply::json(200, &v));
        }
        if !output && m == "DELETE" {
            self.stop_job(&job);
            return Ok(WorkerReply::json(200, &json!({ "ok": true })));
        }
        if output && m == "GET" {
            if job.state() != "done" {
                return Ok(WorkerReply::error(409, "Not encoded yet."));
            }
            let path = job.d.lock().unwrap().output.clone();
            let f = File::open(&path).map_err(|e| plain_err(e.to_string()))?;
            let len = f.metadata().map_err(|e| plain_err(e.to_string()))?.len();
            return Ok(WorkerReply {
                status: 200,
                headers: vec![("Content-Type".into(), "video/mp4".into()), ("Content-Length".into(), len.to_string()), ("Cache-Control".into(), "no-store".into())],
                body: ReplyBody::File(f, len),
                unsent: None,
            });
        }
        Ok(WorkerReply::error(405, "Not allowed."))
    }

    /// The jobs held now (for tests).
    pub fn held(&self) -> usize {
        self.0.state.lock().unwrap().jobs.len()
    }
}

/// the last n UTF-16 units of s (slice(-n))
fn tail_units(s: &str, n: usize) -> String {
    let mut units = 0;
    let mut start = s.len();
    for (i, c) in s.char_indices().rev() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        start = i;
    }
    s[start..].to_string()
}

fn running(st: &State, pool: Option<&str>) -> usize {
    st.jobs.values().filter(|j| matches!(j.state(), "receiving" | "queued" | "encoding") && pool.is_none_or(|p| j.pool() == p)).count()
}

fn encoding(st: &State, pool: Option<&str>) -> usize {
    st.jobs.values().filter(|j| j.state() == "encoding" && pool.is_none_or(|p| j.pool() == p)).count()
}

pub(crate) fn device_value(d: &Device) -> Value {
    device_json(d)
}
