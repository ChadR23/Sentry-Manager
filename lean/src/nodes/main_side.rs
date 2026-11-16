//! nodes.js, the main side: other Sentry Six Managers paired here encode
//! clips for this one. Each GPU of a node, and its CPU, is a lane in the
//! Encoder (device "node:<id>@<its device>"; "node:<id>" for a node of an
//! older version, which lists no devices): this server reads the clip from
//! the share, sends it over HTTPS with the device to encode it on, takes the
//! encoded file back and then writes the telemetry, verifies and saves it
//! as it does for its own GPUs. Nodes never get share passwords and never
//! touch footage.

use super::cancel::Cancel;
use super::client::{self, connect_pinned, request, Answer, Body, Options, Target};
use super::ctx::{Level, NodesCtx};
use super::pin::{accept_authority, Pin};
use super::{base64url, hmac_hex, is_local_device, jnum, normalize_code, pair_text, peer_str, peer_text, random_bytes, safe_int, same_hex, NodeError};
use crate::converter::contracts::{node_device_of, node_key_of};
use crate::ops::node_power::{clean_report, NodeRow};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

pub const SETTINGS_KEY: &str = "nodes";
pub const MAX_NODES: usize = 8;
pub const INFO_TTL_MS: i64 = 30_000;
const POWER_STALE_MS: i64 = 2 * INFO_TTL_MS + 15_000;
pub const POLL_MS: u64 = 1000;
const BUSY_WAIT_MS: i64 = 5 * 60_000;
const BUSY_POLL_MS: u64 = 3000;
const UPLOADS_AT_ONCE: usize = 2;
const QUEUE_WAIT_MS: i64 = 30 * 60_000;
const MAX_NODE_DEVICES: usize = 16;
const MAX_SLOTS: i64 = 8;

// ---- upload slots: clips uploaded to one node at once (for every Nodes of this process, as Node's module map)

struct SlotLine {
    busy: usize,
    line: VecDeque<u64>,
    next: u64,
}

fn upload_slots() -> &'static (Mutex<HashMap<String, SlotLine>>, Condvar) {
    static S: OnceLock<(Mutex<HashMap<String, SlotLine>>, Condvar)> = OnceLock::new();
    S.get_or_init(|| (Mutex::new(HashMap::new()), Condvar::new()))
}

/// A slot taken; dropped (or released) it frees the slot for the next in line.
pub struct UploadSlot {
    node: String,
    released: bool,
}

impl UploadSlot {
    pub fn release(mut self) {
        self.free();
    }
    fn free(&mut self) {
        if self.released {
            return;
        }
        self.released = true;
        let (m, cv) = upload_slots();
        let mut g = m.lock().unwrap();
        if let Some(s) = g.get_mut(&self.node) {
            s.busy -= 1;
        }
        cv.notify_all();
    }
}

impl Drop for UploadSlot {
    fn drop(&mut self) {
        self.free();
    }
}

/// takeUploadSlot(nodeId, signal): None when the signal was aborted while it
/// waited (a waiter that gives up leaves the line).
pub fn take_upload_slot(node: &str, signal: &Cancel) -> Option<UploadSlot> {
    let (m, cv) = upload_slots();
    let mut g = m.lock().unwrap();
    let s = g.entry(node.to_string()).or_insert(SlotLine { busy: 0, line: VecDeque::new(), next: 0 });
    s.next += 1;
    let me = s.next;
    s.line.push_back(me);
    let wake = signal.on_abort(|| {
        let (m, cv) = upload_slots();
        drop(m.lock().unwrap());
        cv.notify_all();
    });
    loop {
        let s = g.get_mut(node).unwrap();
        if signal.aborted() {
            s.line.retain(|x| *x != me);
            drop(g);
            cv.notify_all();
            signal.remove(wake);
            return None;
        }
        if s.busy < UPLOADS_AT_ONCE && s.line.front() == Some(&me) {
            s.line.pop_front();
            s.busy += 1;
            drop(g);
            cv.notify_all();
            signal.remove(wake);
            return Some(UploadSlot { node: node.to_string(), released: false });
        }
        g = cv.wait_timeout(g, Duration::from_millis(500)).unwrap().0;
    }
}

// ---- addresses

fn host_ok(h: &str) -> bool {
    let b = h.as_bytes();
    if b.is_empty() || b.len() > 253 {
        return false;
    }
    let edge = |c: u8| c.is_ascii_alphanumeric();
    edge(b[0]) && edge(b[b.len() - 1]) && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'.' || *c == b'-')
}

fn port_of(digits: Option<&str>) -> Option<u16> {
    match digits {
        None => Some(9000),
        Some(d) if (1..=5).contains(&d.len()) && d.bytes().all(|c| c.is_ascii_digit()) => d.parse::<u32>().ok().filter(|p| (1..=65535).contains(p)).map(|p| p as u16),
        Some(_) => None,
    }
}

/// parseAddress: "192.168.1.20", "nas.local:9000", "[fd00::5]:9443" -> (host, port).
pub fn parse_address(text: &Value) -> Option<(String, u16)> {
    let s = super::js_text(text);
    let mut v = super::js_trim(&s).to_string();
    for p in ["http://", "https://"] {
        if v.len() >= p.len() && v[..p.len()].eq_ignore_ascii_case(p) {
            v = v[p.len()..].to_string();
            break;
        }
    }
    if let Some(i) = v.find('/') {
        v.truncate(i);
    }
    let (host, port) = if let Some(rest) = v.strip_prefix('[') {
        let (inside, after) = rest.split_once(']')?;
        if inside.is_empty() || !inside.bytes().all(|c| c.is_ascii_hexdigit() || c == b':' || c == b'.') {
            return None;
        }
        let port = match after {
            "" => port_of(None),
            a => port_of(Some(a.strip_prefix(':')?)),
        }?;
        (inside.to_string(), port)
    } else {
        let (h, p) = match v.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (v.as_str(), None),
        };
        if h.is_empty() || h.contains('\n') {
            return None;
        }
        (h.to_string(), port_of(p)?)
    };
    if host.parse::<std::net::IpAddr>().is_err() && !host_ok(&host) {
        return None;
    }
    Some((host, port))
}

// ---- what is known of each node

/// One of a node's devices as it listed it.
#[derive(Debug, Clone, PartialEq)]
pub struct NodeDevice {
    pub id: String,
    pub kind: String,
    pub name: String,
    /// None: unknown (offline); Some((h265, av1))
    pub encoders: (Option<String>, Option<String>),
    pub slots: Option<i64>,
    pub busy: Option<i64>,
    pub encoding: Option<i64>,
    pub capacity: Option<i64>,
}

impl NodeDevice {
    fn encoders_json(&self) -> Value {
        json!({ "h265": self.encoders.0, "av1": self.encoders.1 })
    }
}

/// info.get(id): { at, online, encoders, slots, busy, name, error, devices, hardware }
#[derive(Debug, Clone)]
pub struct Info {
    pub at: i64,
    pub online: bool,
    pub error: Option<String>,
    pub name: Option<String>,
    /// {} offline, { h265, av1 } online
    pub encoders: Value,
    pub slots: Option<i64>,
    pub busy: Option<i64>,
    pub encoding: Option<i64>,
    pub devices: Option<Vec<NodeDevice>>,
    pub hardware: Value,
}

fn clean_encoder(v: &Value) -> Option<String> {
    v.as_str().filter(|s| (2..=32).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')).map(String::from)
}

fn count(v: &Value, max: i64) -> Option<i64> {
    safe_int(v).filter(|n| *n >= 0 && *n <= max)
}

/// parseDevices: a node's own devices as it lists them (None: an older node).
pub fn parse_devices(value: &Value) -> Option<Vec<NodeDevice>> {
    let a = value.as_array()?;
    let mut list: Vec<NodeDevice> = Vec::new();
    for d in a.iter().take(MAX_NODE_DEVICES) {
        let Some(id) = d["id"].as_str().filter(|id| is_local_device(id)) else { continue };
        if !d.is_object() || list.iter().any(|x| x.id == id) {
            continue;
        }
        let enc = if d["encoders"].is_null() { json!({}) } else { d["encoders"].clone() };
        let kind = if id == "cpu" {
            "cpu".to_string()
        } else {
            d["kind"].as_str().filter(|k| (2..=16).contains(&k.len()) && k.bytes().all(|c| c.is_ascii_lowercase())).unwrap_or("gpu").to_string()
        };
        let name = Some(peer_text(&d["name"], 64)).filter(|n| !n.is_empty()).unwrap_or_else(|| if id == "cpu" { "CPU".into() } else { id.to_string() });
        list.push(NodeDevice {
            id: id.into(),
            kind,
            name,
            encoders: (clean_encoder(&enc["h265"]), clean_encoder(&enc["av1"])),
            slots: count(&d["slots"], MAX_SLOTS),
            busy: count(&d["busy"], 10_000),
            encoding: count(&d["encoding"], 10_000),
            capacity: count(&d["capacity"], 10_000),
        });
    }
    (!list.is_empty()).then_some(list)
}

/// parseHardware: a node's hardware as it names it (Null: an older node).
pub fn parse_hardware(value: &Value) -> Value {
    if !value.is_object() {
        return Value::Null;
    }
    let mut devices: Vec<Value> = Vec::new();
    for d in value["devices"].as_array().map(|a| &a[..a.len().min(MAX_NODE_DEVICES)]).unwrap_or(&[]) {
        let Some(id) = d["id"].as_str().filter(|id| is_local_device(id)) else { continue };
        if devices.iter().any(|x| x["id"] == json!(id)) {
            continue;
        }
        let name = peer_text(&d["name"], 160);
        devices.push(json!({ "id": id, "name": if name.is_empty() { Value::Null } else { json!(name) } }));
    }
    let cpu = peer_text(&value["cpu"], 160);
    let gpus: Vec<Value> = value["gpus"].as_array().map(|a| &a[..a.len().min(MAX_NODE_DEVICES)]).unwrap_or(&[]).iter().map(|g| peer_text(g, 160)).filter(|g| !g.is_empty()).map(Value::String).collect();
    json!({ "cpu": if cpu.is_empty() { Value::Null } else { json!(cpu) }, "gpus": gpus, "devices": devices })
}

/// the device a whole-node lane, a plain number and the benchmark use: its first GPU, else its CPU
fn default_device_of(devices: Option<&Vec<NodeDevice>>) -> Option<String> {
    let d = devices?;
    d.iter().find(|x| x.id != "cpu").map(|x| x.id.clone()).or_else(|| (!d.is_empty()).then(|| "cpu".to_string()))
}

fn listed_of(devices: &[NodeDevice]) -> Value {
    Value::Array(devices.iter().map(|d| json!({ "id": d.id, "kind": d.kind, "name": d.name })).collect())
}

/// A node's devices as kept with it (an offline node keeps its rows).
fn stored_devices(node: &Value) -> Option<Vec<NodeDevice>> {
    let a = node["devices"].as_array()?;
    Some(a.iter().map(|d| NodeDevice {
        id: super::js_text(&d["id"]),
        kind: d["kind"].as_str().unwrap_or("").to_string(),
        name: d["name"].as_str().unwrap_or("").to_string(),
        encoders: (None, None),
        slots: None,
        busy: None,
        encoding: None,
        capacity: None,
    }).collect())
}

/// What the converter asks a node to encode (the converter's remoteEncode request).
#[derive(Debug, Clone)]
pub struct EncodeRequest {
    /// the lane: "node:<id>@<device>" or "node:<id>"
    pub device: String,
    pub source: PathBuf,
    pub target: PathBuf,
    pub codec: String,
    pub bitrate: Option<f64>,
    pub quality: Option<String>,
    pub hold_frames: i64,
    pub duration_us: Option<f64>,
    pub benchmark: bool,
}

/// What a remote encode tells the converter, as ffmpeg's process would.
#[derive(Debug, Clone, PartialEq)]
pub enum ChildEvent {
    /// -progress lines ("out_time_us=…\nfps=…\nspeed=…x\nprogress=continue\n", "queued=1\n")
    Stdout(String),
    /// the end: code 0 (the encoded file is at the target), 1 (failed: encode it here), or None with the signal of a kill
    Close { code: Option<i32>, signal: Option<String> },
}

struct EncodeShared {
    closed: AtomicBool,
    tx: Mutex<Option<mpsc::Sender<ChildEvent>>>,
    controller: Cancel,
    upload: Mutex<Option<(Cancel, Arc<AtomicBool>)>>,
    job_id: Mutex<Option<String>>,
    target: Target,
    node_id: String,
    benchmark: bool,
    nodes: Nodes,
}

impl EncodeShared {
    fn emit(&self, text: String) {
        if self.closed.load(Ordering::SeqCst) {
            return;
        }
        if let Some(tx) = &*self.tx.lock().unwrap() {
            let _ = tx.send(ChildEvent::Stdout(text));
        }
    }
    fn close(&self, code: Option<i32>, signal: Option<&str>) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        if !self.benchmark {
            self.nodes.work(&self.node_id, -1);
        }
        if let Some(tx) = self.tx.lock().unwrap().take() {
            let _ = tx.send(ChildEvent::Close { code, signal: signal.map(String::from) });
        }
    }
    /// the node deletes the clip and its encoded file
    fn forget(&self) {
        let Some(id) = self.job_id.lock().unwrap().take() else { return };
        let path = format!("/node/v1/jobs/{id}");
        let _ = request(&self.target, Options { method: "DELETE", ..Options::get(&path, 10_000) });
    }
}

/// The encode's handle: its events, and kill.
pub struct RemoteChild {
    pub events: mpsc::Receiver<ChildEvent>,
    pub killer: RemoteKill,
}

#[derive(Clone)]
pub struct RemoteKill(Arc<EncodeShared>);

impl RemoteKill {
    /// child.kill(signal): a clip that is all sent is let through (the node's
    /// answer holds the job's id, and without it the job could not be deleted there).
    pub fn kill(&self, signal: &str) -> bool {
        let s = self.0.clone();
        s.controller.abort();
        if let Some((c, sent)) = &*s.upload.lock().unwrap() {
            if !sent.load(Ordering::SeqCst) {
                c.abort();
            }
        }
        let f = s.clone();
        std::thread::spawn(move || f.forget());
        s.close(None, Some(signal));
        true
    }
}

impl RemoteChild {
    pub fn kill(&self, signal: &str) -> bool {
        self.killer.kill(signal)
    }
    /// Waits for the end: (code, signal); the progress lines are passed to `on_stdout`.
    pub fn wait_with(&self, mut on_stdout: impl FnMut(&str)) -> (Option<i32>, Option<String>) {
        while let Ok(e) = self.events.recv() {
            match e {
                ChildEvent::Stdout(s) => on_stdout(&s),
                ChildEvent::Close { code, signal } => return (code, signal),
            }
        }
        (None, None)
    }
    pub fn wait(&self) -> (Option<i32>, Option<String>) {
        self.wait_with(|_| {})
    }
}

struct Pending {
    done: Mutex<Option<Info>>,
    cv: Condvar,
}

struct NInner {
    ctx: Arc<dyn NodesCtx>,
    name: String,
    poll_ms: u64,
    info: Mutex<HashMap<String, Info>>,
    last_moved: Mutex<HashMap<String, i64>>,
    powers: Mutex<HashMap<String, (i64, Value)>>,
    working: Mutex<HashMap<String, i64>>,
    refreshing: Mutex<HashMap<String, Arc<Pending>>>,
    saving: Mutex<()>,
}

/// createNodes({ db, log, audit, name, pollMs, onPower })
#[derive(Clone)]
pub struct Nodes(Arc<NInner>);

fn sleep_or_abort(ms: u64, c: &Cancel) {
    let end = std::time::Instant::now() + Duration::from_millis(ms);
    while std::time::Instant::now() < end && !c.aborted() {
        std::thread::sleep(Duration::from_millis(ms.min(20)));
    }
}

fn valid_job_id(v: &Value) -> Option<String> {
    v.as_str().filter(|s| s.len() == 32 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))).map(String::from)
}

impl Nodes {
    pub fn new(ctx: Arc<dyn NodesCtx>, name: Option<String>, poll_ms: Option<u64>) -> Nodes {
        let name = name.unwrap_or_else(|| ctx.hostname());
        Nodes(Arc::new(NInner {
            ctx,
            name,
            poll_ms: poll_ms.unwrap_or(POLL_MS),
            info: Mutex::new(HashMap::new()),
            last_moved: Mutex::new(HashMap::new()),
            powers: Mutex::new(HashMap::new()),
            working: Mutex::new(HashMap::new()),
            refreshing: Mutex::new(HashMap::new()),
            saving: Mutex::new(()),
        }))
    }

    fn now(&self) -> i64 {
        self.0.ctx.now_ms()
    }

    fn work(&self, id: &str, by: i64) {
        let mut w = self.0.working.lock().unwrap();
        let n = w.get(id).copied().unwrap_or(if by < 0 { 1 } else { 0 });
        w.insert(id.into(), (n + by).max(0));
    }

    /// The paired nodes as stored (each with an id and a token).
    pub fn stored(&self) -> Vec<Value> {
        let v = self.0.ctx.setting(SETTINGS_KEY).unwrap_or_else(|| json!([]));
        v.as_array().map(|a| a.iter().filter(|n| n["id"].is_string() && n["token"].is_string()).cloned().collect()).unwrap_or_default()
    }

    fn save(&self, list: &[Value]) {
        self.0.ctx.set_setting(SETTINGS_KEY, &Value::Array(list.to_vec()));
    }

    fn by_id(&self, id: &str) -> Option<Value> {
        self.stored().into_iter().find(|n| n["id"].as_str() == Some(id))
    }

    /// stored().map(n => n.id === id ? change(n) : n), saved
    fn update(&self, id: &str, change: impl Fn(&mut Map<String, Value>)) {
        let _g = self.0.saving.lock().unwrap();
        let list: Vec<Value> = self.stored().into_iter().map(|mut n| {
            if n["id"].as_str() == Some(id) {
                if let Some(o) = n.as_object_mut() {
                    change(o);
                }
            }
            n
        }).collect();
        self.save(&list);
    }

    fn target(node: &Value) -> Target {
        Target {
            host: super::js_text(&node["host"]),
            port: safe_int(&node["port"]).filter(|p| (1..=65535).contains(p)).unwrap_or(9000) as u16,
            token: node["token"].as_str().map(String::from),
            pin: Pin::from_json(&node["pin"]),
        }
    }

    fn note_power(&self, id: &str, json: &Value) {
        let power = clean_report(&json["power"]);
        if power.is_null() {
            self.0.powers.lock().unwrap().remove(id);
            return;
        }
        let at = self.now();
        let w = power["totalW"].as_f64();
        self.0.powers.lock().unwrap().insert(id.into(), (at, power));
        let encoding = self.0.working.lock().unwrap().get(id).copied().unwrap_or(0) > 0;
        self.0.ctx.node_power(id, at, w, encoding);
    }

    /// refresh(node): asks the node for /node/v1/info (8 s).
    fn refresh_now(&self, node: &Value) -> Info {
        let id = node["id"].as_str().unwrap_or("").to_string();
        let before = self.0.info.lock().unwrap().get(&id).cloned();
        let result: Result<(), NodeError> = (|| {
            let r = request(&Nodes::target(node), Options::get("/node/v1/info", 8000))?;
            if r.status != 200 || !crate::ops::js::truthy(&r.json) {
                let e = peer_text(&r.json["error"], 160);
                return Err(NodeError::new(if e.is_empty() { format!("HTTP {}", r.status) } else { e }, 502, "NODE_ERROR"));
            }
            let j = &r.json;
            let enc = &j["encoders"];
            let devices = parse_devices(&j["devices"]);
            let info = Info {
                at: self.now(),
                online: true,
                error: None,
                name: Some(match j["name"].as_str() {
                    Some(n) => peer_str(n, 64),
                    None => super::js_text(&node["name"]),
                }),
                encoders: json!({ "h265": clean_encoder(&enc["h265"]), "av1": clean_encoder(&enc["av1"]) }),
                slots: safe_int(&j["slots"]).map(|s| s.clamp(1, MAX_SLOTS)),
                busy: safe_int(&j["busy"]),
                encoding: safe_int(&j["encoding"]),
                devices: devices.clone(),
                hardware: parse_hardware(&j["hardware"]),
            };
            self.0.info.lock().unwrap().insert(id.clone(), info);
            self.note_power(&id, j);
            // remembered with the node when they change, for when it does not answer
            let _g = self.0.saving.lock().unwrap();
            if let Some(current) = self.by_id(&id) {
                let now_listed = devices.as_deref().map(listed_of).unwrap_or(Value::Null);
                let kept = current.get("devices").cloned().filter(|d| crate::ops::js::truthy(d)).unwrap_or(Value::Null);
                if kept.to_string() != now_listed.to_string() {
                    let list: Vec<Value> = self.stored().into_iter().map(|mut n| {
                        if n["id"].as_str() == Some(&id) {
                            if let Some(o) = n.as_object_mut() {
                                o.shift_remove("devices");
                                if !now_listed.is_null() {
                                    o.insert("devices".into(), now_listed.clone());
                                }
                            }
                        }
                        n
                    }).collect();
                    self.save(&list);
                }
            }
            Ok(())
        })();
        if let Err(e) = result {
            // offline: its devices as last known, so their lanes stay
            let known = before.as_ref().and_then(|b| b.devices.clone()).or_else(|| self.by_id(&id).and_then(|n| stored_devices(&n)));
            let info = Info { at: self.now(), online: false, error: Some(e.message), name: None, encoders: json!({}), slots: None, busy: None, encoding: None, devices: known, hardware: before.map(|b| b.hardware).unwrap_or(Value::Null) };
            self.0.info.lock().unwrap().insert(id.clone(), info);
        }
        self.0.info.lock().unwrap().get(&id).cloned().unwrap()
    }

    /// A refresh in the background (one at a time per node): its result to wait for.
    fn start_refresh(&self, node: &Value) -> Arc<Pending> {
        let id = node["id"].as_str().unwrap_or("").to_string();
        let mut r = self.0.refreshing.lock().unwrap();
        if let Some(p) = r.get(&id) {
            return p.clone();
        }
        let p = Arc::new(Pending { done: Mutex::new(None), cv: Condvar::new() });
        r.insert(id.clone(), p.clone());
        drop(r);
        let me = self.clone();
        let node = node.clone();
        let pending = p.clone();
        std::thread::spawn(move || {
            let info = me.refresh_now(&node);
            me.0.refreshing.lock().unwrap().remove(&id);
            *pending.done.lock().unwrap() = Some(info);
            pending.cv.notify_all();
        });
        p
    }

    fn wait(p: &Pending, limit: Option<Duration>) -> Option<Info> {
        let mut g = p.done.lock().unwrap();
        match limit {
            None => {
                while g.is_none() {
                    g = p.cv.wait(g).unwrap();
                }
            }
            Some(d) => {
                let end = std::time::Instant::now() + d;
                while g.is_none() {
                    let left = end.saturating_duration_since(std::time::Instant::now());
                    if left.is_zero() {
                        break;
                    }
                    g = p.cv.wait_timeout(g, left).unwrap().0;
                }
            }
        }
        g.clone()
    }

    /// fresh(node): what is known, asked again after 30 s (waited for only when nothing is known).
    fn fresh(&self, node: &Value, wait: bool) -> Option<Info> {
        let id = node["id"].as_str().unwrap_or("");
        let known = self.0.info.lock().unwrap().get(id).cloned();
        if let Some(k) = &known {
            if self.now() - k.at < INFO_TTL_MS {
                return known;
            }
        }
        let p = self.start_refresh(node);
        if known.is_some() || !wait {
            return known;
        }
        Nodes::wait(&p, None)
    }

    /// refresh(id) as nodes.js exports it: None when there is no such node.
    pub fn refresh(&self, id: &str) -> Option<Info> {
        let node = self.by_id(id)?;
        Some(self.refresh_now(&node))
    }

    pub fn has(&self, id: &str) -> bool {
        self.by_id(id).is_some()
    }

    /// The paired nodes as encoding devices for the converter's lanes.
    pub fn list(&self) -> Vec<Value> {
        let nodes = self.stored();
        let infos: Vec<Option<Info>> = std::thread::scope(|s| {
            let hs: Vec<_> = nodes.iter().map(|n| s.spawn(|| self.fresh(n, true))).collect();
            hs.into_iter().map(|h| h.join().ok().flatten()).collect()
        });
        let mut out = Vec::new();
        for (node, i) in nodes.iter().zip(infos) {
            let Some(i) = i else { continue };
            let (nid, nname) = (super::js_text(&node["id"]), node["name"].clone());
            let name_text = crate::ops::js::to_string(&nname);
            let online = i.online;
            let Some(devices) = &i.devices else {
                out.push(json!({
                    "id": format!("node:{nid}"), "kind": "node", "nodeId": nid, "nodeName": nname, "deviceName": null, "name": format!("{name_text} (node)"),
                    "node": null, "index": null, "pci": null, "slots": i.slots,
                    "online": online, "encoders": if online { i.encoders.clone() } else { json!({ "h265": null, "av1": null }) }
                }));
                continue;
            };
            let fallback = default_device_of(Some(devices));
            for d in devices {
                out.push(json!({
                    "id": format!("node:{nid}@{}", d.id), "kind": "node", "nodeId": nid, "nodeName": nname,
                    "deviceId": d.id, "deviceKind": d.kind, "deviceName": d.name, "name": format!("{name_text} · {}", d.name),
                    "isDefault": Some(&d.id) == fallback.as_ref(),
                    "node": null, "index": null, "pci": null, "slots": d.slots,
                    "online": online, "encoders": if online { d.encoders_json() } else { json!({ "h265": null, "av1": null }) }
                }));
            }
        }
        out
    }

    /// Each paired node's power for "All servers": [{ id, name, online, power }]. Never waits.
    pub fn power(&self) -> Vec<Value> {
        let t = self.now();
        self.stored().iter().map(|node| {
            self.fresh(node, false);
            let id = super::js_text(&node["id"]);
            let online = self.0.info.lock().unwrap().get(&id).is_some_and(|i| i.online);
            let p = self.0.powers.lock().unwrap().get(&id).cloned();
            let power = match p {
                Some((at, power)) if online && t - at <= POWER_STALE_MS => power,
                _ => Value::Null,
            };
            json!({ "id": id, "name": node["name"], "online": online, "power": power })
        }).collect()
    }

    /// power() as ops' NodeRow (OpsCtx::node_powers).
    pub fn power_rows(&self) -> Vec<NodeRow> {
        self.power().into_iter().map(|v| NodeRow { id: super::js_text(&v["id"]), name: crate::ops::js::to_string(&v["name"]), online: v["online"] == json!(true), power: v["power"].clone() }).collect()
    }

    /// Each paired node's hardware as it last named it, for the heartbeat. Never waits.
    pub fn hardware(&self) -> Vec<Value> {
        self.stored().iter().map(|node| {
            self.fresh(node, false);
            let id = super::js_text(&node["id"]);
            let i = self.0.info.lock().unwrap().get(&id).cloned();
            let devices = i.as_ref().and_then(|i| i.devices.clone()).or_else(|| stored_devices(node));
            json!({ "id": id, "hardware": i.map(|i| i.hardware).unwrap_or(Value::Null),
                "devices": devices.map(|d| listed_of(&d)).unwrap_or(Value::Null) })
        }).collect()
    }

    /// What the Nodes page shows (a node slow to answer is shown as last known after 1.5 s).
    pub fn overview(&self) -> Vec<Value> {
        let nodes = self.stored();
        let pending: Vec<Arc<Pending>> = nodes.iter().map(|n| self.start_refresh(n)).collect();
        let end = std::time::Instant::now() + Duration::from_millis(1500);
        for p in &pending {
            Nodes::wait(p, Some(end.saturating_duration_since(std::time::Instant::now())));
        }
        nodes.iter().map(|node| {
            let id = super::js_text(&node["id"]);
            let i = self.0.info.lock().unwrap().get(&id).cloned();
            let devices = i.as_ref().and_then(|i| i.devices.clone());
            let fallback = default_device_of(devices.as_ref());
            let slots = match &devices {
                Some(d) => json!(d.iter().map(|x| x.slots.unwrap_or(0)).sum::<i64>()),
                None => json!(i.as_ref().and_then(|i| i.slots)),
            };
            let online = i.as_ref().is_some_and(|i| i.online);
            let port = safe_int(&node["port"]);
            let host = super::js_text(&node["host"]);
            let mut o = Map::new();
            o.insert("id".into(), node["id"].clone());
            o.insert("name".into(), node["name"].clone());
            o.insert("address".into(), json!(if port == Some(9000) { host } else { format!("{host}:{}", crate::ops::js::to_string(&node["port"])) }));
            if let Some(p) = node.get("pairedAt") {
                o.insert("pairedAt".into(), p.clone());
            }
            o.insert("online".into(), json!(online));
            o.insert("error".into(), if online { Value::Null } else { json!(i.as_ref().and_then(|i| i.error.clone()).filter(|e| !e.is_empty())) });
            o.insert("encoders".into(), i.as_ref().map(|i| i.encoders.clone()).unwrap_or_else(|| json!({})));
            o.insert("slots".into(), slots);
            o.insert("busy".into(), json!(i.as_ref().and_then(|i| i.busy)));
            o.insert("encoding".into(), json!(i.as_ref().and_then(|i| i.encoding)));
            o.insert("devices".into(), match &devices {
                Some(d) => Value::Array(d.iter().map(|x| json!({ "id": x.id, "lane": format!("node:{id}@{}", x.id), "kind": x.kind, "name": x.name, "encoders": x.encoders_json(), "slots": x.slots, "isDefault": Some(&x.id) == fallback.as_ref() })).collect()),
                None => Value::Null,
            });
            o.insert("defaultLane".into(), json!(match (&devices, &fallback) {
                (Some(_), Some(f)) => format!("node:{id}@{f}"),
                (Some(_), None) => format!("node:{id}@undefined"),
                _ => format!("node:{id}"),
            }));
            o.insert("defaultDeviceName".into(), match &devices {
                Some(d) => json!(d.iter().find(|x| Some(&x.id) == fallback.as_ref()).map(|x| x.name.clone()).filter(|n| !n.is_empty())),
                None => Value::Null,
            });
            o.insert("fingerprint".into(), json!(node["pin"]["fingerprint"].as_str().filter(|f| !f.is_empty())));
            o.insert("cars".into(), if node["cars"].is_array() { node["cars"].clone() } else { json!([]) });
            o.insert("trusted".into(), json!(node["trusted"] == json!(true)));
            Value::Object(o)
        }).collect()
    }

    /// Pairs with a node that is showing a pairing code.
    pub fn add(&self, address: &Value, code: &Value) -> Result<Value, NodeError> {
        let Some((host, port)) = parse_address(address) else { return Err(NodeError::bad("Enter the node's address, like 192.168.1.30 or nas.local:9000.")) };
        let key = normalize_code(code);
        if key.chars().count() != 12 {
            return Err(NodeError::bad("Enter the 12-character pairing code shown on the node."));
        }
        let nodes = self.stored();
        if nodes.len() >= MAX_NODES {
            return Err(NodeError::bad(format!("At most {MAX_NODES} nodes.")));
        }
        if nodes.iter().any(|n| n["host"].as_str() == Some(&host) && safe_int(&n["port"]) == Some(port as i64)) {
            return Err(NodeError::bad("That node is already paired."));
        }
        // pairing: no pin yet; the code proves both sides saw the same certificate
        let probe = connect_pinned(&host, port, None, 10_000)?;
        let _ = probe.tcp.shutdown(std::net::Shutdown::Both);
        let my_name = super::js_slice(&self.0.name, 64);
        let proof = hmac_hex(&key, &pair_text::main(&probe.fingerprint, &my_name));
        let draft = Target { host: host.clone(), port, token: None, pin: None };
        let body = serde_json::to_vec(&json!({ "name": my_name, "proof": proof })).unwrap();
        let r = request(&draft, Options {
            method: "POST", path: "/node/v1/pair", pin: Some(Pin { fingerprint: Some(probe.fingerprint.clone()), authority: None }),
            headers: vec![("Content-Type".into(), "application/json".into())], body: Body::Bytes(body), timeout_ms: 15_000, deadline_ms: None, on_response: None, cancel: None,
        })?;
        if r.status == 404 {
            return Err(NodeError::new("That server is not set up as a node: on its Nodes page, show a pairing code first.", 409, "NODE_ERROR"));
        }
        if r.status != 200 {
            let e = peer_text(&r.json["error"], 160);
            return Err(NodeError::new(if e.is_empty() { format!("The node refused ({}).", r.status) } else { e }, if r.status == 403 { 403 } else { 502 }, "NODE_ERROR"));
        }
        let token = r.json["token"].as_str().filter(|t| t.len() == 43 && t.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'));
        let verified = token.is_some_and(|t| r.json["proof"].as_str().is_some_and(|p| same_hex(p, &hmac_hex(&key, &pair_text::worker(&probe.fingerprint, t)))));
        if !verified {
            return Err(NodeError::new("The node's answer could not be verified, so it was not paired.", 502, "NODE_ERROR"));
        }
        let token = token.unwrap().to_string();
        // its certificate authority, when it issued the certificate seen now
        let authority = accept_authority(&r.json["authority"], &probe.raw);
        let mut id: String = base64url(&random_bytes(9)).to_lowercase().chars().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect();
        while id.len() < 12 {
            id.push('0');
        }
        id.truncate(12);
        let name = Some(peer_text(&r.json["name"], 64)).filter(|n| !n.is_empty()).unwrap_or_else(|| host.clone());
        let node = json!({ "id": id, "name": name, "host": host, "port": port, "token": token, "pin": { "fingerprint": probe.fingerprint, "authority": authority }, "pairedAt": self.now() });
        {
            let _g = self.0.saving.lock().unwrap();
            let mut list = self.stored();
            list.push(node.clone());
            self.save(&list);
        }
        self.refresh_now(&node);
        Ok(node)
    }

    /// A name of your own for the node: Ok(None) when there is no such node.
    pub fn rename(&self, id: &str, new_name: &Value) -> Result<Option<(Value, String)>, NodeError> {
        let Some(node) = self.by_id(id) else { return Ok(None) };
        let Some(s) = new_name.as_str() else { return Err(NodeError::bad("Enter a name.")) };
        let clean = peer_str(s, 64);
        if clean.is_empty() {
            return Err(NodeError::bad("Enter a name."));
        }
        self.update(id, |o| {
            o.insert("name".into(), json!(clean));
        });
        Ok(Some((node["name"].clone(), clean)))
    }

    /// The vehicles a node converts for first, in order (at most 64).
    pub fn set_cars(&self, id: &str, cars: &Value) -> Result<Option<Vec<String>>, NodeError> {
        if self.by_id(id).is_none() {
            return Ok(None);
        }
        let ok = |c: &Value| c.as_str().is_some_and(|s| {
            let b = s.as_bytes();
            !b.is_empty() && b.len() <= 64 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
        });
        let Some(a) = cars.as_array().filter(|a| a.len() <= 64 && a.iter().all(ok)) else { return Err(NodeError::bad("A list of vehicles, at most 64.")) };
        let mut list: Vec<String> = Vec::new();
        for c in a {
            let c = c.as_str().unwrap().to_string();
            if !list.contains(&c) {
                list.push(c);
            }
        }
        let v = json!(list);
        self.update(id, |o| {
            o.insert("cars".into(), v.clone());
        });
        Ok(Some(list))
    }

    /// Trusted: its encodes skip the picture check here. None when there is no such node.
    pub fn set_trusted(&self, id: &str, trusted: &Value) -> Option<bool> {
        self.by_id(id)?;
        let t = trusted == &json!(true);
        self.update(id, |o| {
            o.insert("trusted".into(), json!(t));
        });
        Some(t)
    }

    /// The node of any lane ("node:<id>@<device>", "node:<id>" or a plain id).
    pub fn node_id_of(id: &str) -> String {
        match node_key_of(id) {
            Some(k) => k["node:".len()..].to_string(),
            None => id.split('@').next().unwrap_or("").to_string(),
        }
    }

    pub fn trusted(&self, id: &str) -> bool {
        self.by_id(&Nodes::node_id_of(id)).is_some_and(|n| n["trusted"] == json!(true))
    }

    /// A vehicle removed: out of every node's Vehicles first list.
    pub fn forget_car(&self, car: &str) {
        let _g = self.0.saving.lock().unwrap();
        let all = self.stored();
        let has = |n: &Value| n["cars"].as_array().is_some_and(|a| a.iter().any(|c| c.as_str() == Some(car)));
        if !all.iter().any(has) {
            return;
        }
        let list: Vec<Value> = all.into_iter().map(|mut n| {
            if has(&n) {
                let kept: Vec<Value> = n["cars"].as_array().unwrap().iter().filter(|c| c.as_str() != Some(car)).cloned().collect();
                n.as_object_mut().unwrap().insert("cars".into(), Value::Array(kept));
            }
            n
        }).collect();
        self.save(&list);
    }

    /// { 'node:<id>': [vehicle id, ...] } for the nodes that have a list.
    pub fn car_lists(&self) -> IndexMap<String, Vec<String>> {
        self.stored().iter().filter_map(|n| {
            let a = n["cars"].as_array().filter(|a| !a.is_empty())?;
            Some((format!("node:{}", super::js_text(&n["id"])), a.iter().map(super::js_text).collect()))
        }).collect()
    }

    pub fn remove(&self, id: &str) -> Option<Value> {
        let node = self.by_id(id)?;
        {
            let _g = self.0.saving.lock().unwrap();
            let list: Vec<Value> = self.stored().into_iter().filter(|n| n["id"].as_str() != Some(id)).collect();
            self.save(&list);
        }
        self.0.info.lock().unwrap().remove(id);
        self.0.powers.lock().unwrap().remove(id);
        self.0.working.lock().unwrap().remove(id);
        Some(node)
    }

    fn known_devices(&self, node: &Value) -> Option<Vec<NodeDevice>> {
        let id = super::js_text(&node["id"]);
        self.0.info.lock().unwrap().get(&id).and_then(|i| i.devices.clone()).or_else(|| stored_devices(node))
    }

    /// The converter's remoteEncode: sends `source` to the node, follows its
    /// progress and writes the encoded file to `target` (created new).
    pub fn encode(&self, req: EncodeRequest) -> Result<RemoteChild, NodeError> {
        let Some(node) = self.by_id(&Nodes::node_id_of(&req.device)) else { return Err(NodeError::new("No such node.", 404, "NODE_ERROR")) };
        let node_id = super::js_text(&node["id"]);
        let on_device = node_device_of(&req.device).map(String::from).or_else(|| default_device_of(self.known_devices(&node).as_ref()));
        let (tx, rx) = mpsc::channel();
        if !req.benchmark {
            self.work(&node_id, 1);
        }
        let shared = Arc::new(EncodeShared {
            closed: AtomicBool::new(false),
            tx: Mutex::new(Some(tx)),
            controller: Cancel::new(),
            upload: Mutex::new(None),
            job_id: Mutex::new(None),
            target: Nodes::target(&node),
            node_id: node_id.clone(),
            benchmark: req.benchmark,
            nodes: self.clone(),
        });
        let me = self.clone();
        let s = shared.clone();
        let node_name = crate::ops::js::to_string(&node["name"]);
        std::thread::spawn(move || {
            match me.run_encode(&s, &node, &req, on_device) {
                Ok(true) => {
                    s.forget();
                    s.close(Some(0), None);
                }
                Ok(false) => {}
                Err(e) => {
                    if s.closed.load(Ordering::SeqCst) {
                        return;
                    }
                    if e.code != "CANCELLED" {
                        me.0.ctx.log(Level::Warn, &format!("Node {node_name}: {}", e.message));
                    }
                    let f = s.clone();
                    std::thread::spawn(move || f.forget());
                    s.close(Some(1), None);
                }
            }
        });
        Ok(RemoteChild { events: rx, killer: RemoteKill(shared) })
    }

    /// The encode itself: Ok(true) done, Ok(false) cancelled (kill already closed it).
    fn run_encode(&self, s: &Arc<EncodeShared>, node: &Value, req: &EncodeRequest, on_device: Option<String>) -> Result<bool, NodeError> {
        let controller = &s.controller;
        let node_id = &s.node_id;
        let size = std::fs::metadata(&req.source).map_err(|e| NodeError::new(format!("{}: {}", client::errno_name(&e), e), 500, "NODE_ERROR"))?.len();
        let mut settings = Map::new();
        settings.insert("codec".into(), json!(req.codec));
        settings.insert("holdFrames".into(), json!(req.hold_frames));
        match req.quality.as_deref().filter(|q| !q.is_empty()) {
            Some(q) => {
                settings.insert("quality".into(), json!(q));
            }
            None => {
                if let Some(b) = req.bitrate {
                    settings.insert("bitrate".into(), jnum(b));
                }
            }
        }
        if let Some(d) = req.duration_us.filter(|d| *d != 0.0 && d.is_finite()) {
            settings.insert("durationUs".into(), jnum(d));
        }
        if let Some(d) = &on_device {
            settings.insert("device".into(), json!(d));
        }
        let settings = Value::Object(settings).to_string();
        let target = &s.target;
        let wait_until = self.now() + BUSY_WAIT_MS;
        let sent: Answer;
        loop {
            let free = match request(target, Options { cancel: Some(controller), ..Options::get("/node/v1/info", 10_000) }) {
                Ok(a) => Some(a),
                Err(e) if e.code == "CANCELLED" => return Err(e),
                Err(_) => None,
            };
            // unreachable: fail over at once (only a node that answers "busy" is waited for)
            let free = match free {
                Some(f) if f.status == 200 => f,
                other => {
                    let e = other.map(|f| peer_text(&f.json["error"], 160)).unwrap_or_default();
                    return Err(NodeError::new(if e.is_empty() { "Could not reach the node.".into() } else { e }, 502, "NODE_UNREACHABLE"));
                }
            };
            if !req.benchmark {
                self.note_power(node_id, &free.json);
            }
            let mut state = if crate::ops::js::truthy(&free.json) { free.json.clone() } else { json!({}) };
            if let Some(dev) = &on_device {
                let listed = state["devices"].as_array().and_then(|a| a.iter().find(|d| d["id"].as_str() == Some(dev)).cloned());
                match listed {
                    Some(l) => state = l,
                    None => return Err(NodeError::new("The node no longer has that device.", 502, "NODE_DEVICE_GONE")),
                }
            }
            let capacity = safe_int(&state["capacity"]).or_else(|| safe_int(&state["slots"]));
            let busy = !req.benchmark && capacity.is_some() && safe_int(&state["busy"]).is_some_and(|b| b >= capacity.unwrap());
            if !busy {
                if controller.aborted() {
                    return Ok(false);
                }
                let Some(slot) = take_upload_slot(node_id, controller) else { return Ok(false) };
                let upload = Cancel::new();
                let done = Arc::new(AtomicBool::new(false));
                *s.upload.lock().unwrap() = Some((upload.clone(), done.clone()));
                let file = std::fs::File::open(&req.source);
                let mut headers = vec![("Content-Type".to_string(), "video/mp4".to_string()), ("Content-Length".to_string(), size.to_string()), ("X-Node-Job".to_string(), settings.clone())];
                if req.benchmark {
                    headers.push(("X-Node-Benchmark".into(), "1".into()));
                }
                let result = match file {
                    Err(e) => Err(NodeError::new(format!("The node connection failed ({}).", client::errno_name(&e)), 502, "NODE_UNREACHABLE")),
                    Ok(f) => {
                        let d = done.clone();
                        request(target, Options {
                            method: "POST", path: "/node/v1/jobs", headers, cancel: Some(&upload), timeout_ms: 60_000, deadline_ms: Some(30 * 60_000), pin: None, on_response: None,
                            body: Body::Reader { reader: Box::new(f), on_end: Some(Box::new(move || d.store(true, Ordering::SeqCst))) },
                        })
                    }
                };
                slot.release();
                *s.upload.lock().unwrap() = None;
                let answer = match result {
                    Err(e) if e.code == "CANCELLED" => return Err(e),
                    other => other,
                };
                let status = answer.as_ref().map(|a| a.status).unwrap_or(0);
                if controller.aborted() {
                    // cancelled while the node answered: delete what it accepted
                    if let Ok(a) = &answer {
                        if a.status == 200 {
                            if let Some(id) = valid_job_id(&a.json["id"]) {
                                *s.job_id.lock().unwrap() = Some(id);
                                s.forget();
                            }
                        }
                    }
                    return Ok(false);
                }
                match answer {
                    Ok(a) if status != 503 => {
                        sent = a;
                        break;
                    }
                    Err(e) if self.now() >= wait_until => return Err(e),
                    _ => {}
                }
            }
            if self.now() >= wait_until {
                return Err(NodeError::new("All of the node's slots stayed busy.", 503, "NODE_BUSY"));
            }
            sleep_or_abort(BUSY_POLL_MS, controller);
            if controller.aborted() {
                return Ok(false);
            }
        }
        let Some(job_id) = valid_job_id(&sent.json["id"]).filter(|_| sent.status == 200) else {
            let e = peer_text(&sent.json["error"], 160);
            return Err(NodeError::new(if e.is_empty() { format!("The node refused the clip ({}).", sent.status) } else { e }, 502, "NODE_ERROR"));
        };
        *s.job_id.lock().unwrap() = Some(job_id.clone());
        let mut last_out: i64 = -1;
        let queued_since = self.now();
        let job_path = format!("/node/v1/jobs/{job_id}");
        loop {
            sleep_or_abort(self.0.poll_ms, controller);
            if controller.aborted() {
                return Ok(false);
            }
            // its power at the usual info cadence while it converts (the job's energy)
            if !req.benchmark {
                let at = self.0.info.lock().unwrap().get(node_id).map(|i| i.at).unwrap_or(0);
                if self.now() - at >= INFO_TTL_MS {
                    self.fresh(node, false);
                }
            }
            let st = request(target, Options { cancel: Some(controller), ..Options::get(&job_path, 15_000) })?;
            if st.status != 200 || !crate::ops::js::truthy(&st.json) {
                let e = peer_text(&st.json["error"], 160);
                return Err(NodeError::new(if e.is_empty() { format!("The node lost the clip ({}).", st.status) } else { e }, 502, "NODE_ERROR"));
            }
            let j = &st.json;
            let out = safe_int(&j["outTimeUs"]);
            let moved = out.is_some_and(|o| o > last_out);
            let state = j["state"].as_str().unwrap_or("");
            if moved || state == "done" {
                self.0.last_moved.lock().unwrap().insert(node_id.clone(), self.now());
                if moved {
                    last_out = out.unwrap();
                }
                let mut lines = vec![format!("out_time_us={}", last_out.max(0))];
                if let Some(f) = j["fps"].as_f64().filter(|f| f.is_finite()) {
                    lines.push(format!("fps={}", crate::ops::js::num_text(f)));
                }
                if let Some(sp) = j["speed"].as_f64().filter(|f| f.is_finite()) {
                    lines.push(format!("speed={}x", crate::ops::js::num_text(sp)));
                }
                lines.push(format!("progress={}", if state == "done" { "end" } else { "continue" }));
                s.emit(format!("{}\n", lines.join("\n")));
            }
            if state == "queued" {
                let moved_at = self.0.last_moved.lock().unwrap().get(node_id).copied().unwrap_or(0);
                if self.now() - queued_since.max(moved_at) > QUEUE_WAIT_MS {
                    return Err(NodeError::new("The node stopped converting the clips waiting on it.", 503, "NODE_BUSY"));
                }
                s.emit("queued=1\n".into());
                continue;
            }
            if state == "failed" {
                return Err(NodeError::new("The node could not encode the clip.", 502, "NODE_ERROR"));
            }
            if state == "done" {
                break;
            }
        }
        // the encoded file, written new (never over an existing file)
        let out_path = req.target.clone();
        request(target, Options {
            cancel: Some(controller), deadline_ms: Some(30 * 60_000),
            on_response: Some(Box::new(move |head, body| {
                let expected = head.header("content-length").and_then(|v| v.parse::<u64>().ok());
                // a node cannot fill this server's disk: never past twice the original
                let limit = size * 2 + 1024 * 1024;
                let large = || NodeError::new("The node sent back a file far larger than the clip.", 502, "NODE_ERROR");
                if expected.is_some_and(|e| e > limit) {
                    return Err(large());
                }
                use std::io::Write;
                use std::os::unix::fs::OpenOptionsExt;
                let mut out = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&out_path)
                    .map_err(|e| NodeError::new(format!("{}: {e}", client::errno_name(&e)), 500, "NODE_ERROR"))?;
                let mut written: u64 = 0;
                let mut buf = vec![0u8; 256 * 1024];
                loop {
                    let n = body.read(&mut buf).map_err(client::stream_error)?;
                    if n == 0 {
                        break;
                    }
                    written += n as u64;
                    if written > limit {
                        return Err(large());
                    }
                    out.write_all(&buf[..n]).map_err(|e| NodeError::new(format!("{}: {e}", client::errno_name(&e)), 500, "NODE_ERROR"))?;
                }
                out.flush().map_err(|e| NodeError::new(e.to_string(), 500, "NODE_ERROR"))?;
                if expected.is_some_and(|e| e != written) {
                    return Err(NodeError::new("The encoded file did not arrive whole.", 502, "NODE_ERROR"));
                }
                Ok(written)
            })),
            ..Options::get(&format!("{job_path}/output"), 60_000)
        })?;
        Ok(true)
    }

    /// Sets how many clips the node converts at once: a number (its default
    /// device, or the whole node of an older version), or { lane or device id: 0..8 }.
    pub fn set_slots(&self, id: &str, slots: &Value) -> Result<Option<Info>, NodeError> {
        let Some(node) = self.by_id(&Nodes::node_id_of(id)) else { return Err(NodeError::new("No such node.", 404, "NODE_ERROR")) };
        let body = if let Some(o) = slots.as_object() {
            let entries: Vec<(String, &Value)> = o.iter().map(|(k, n)| (node_device_of(k).map(String::from).unwrap_or_else(|| k.clone()), n)).collect();
            if entries.is_empty() || entries.len() > MAX_NODE_DEVICES || entries.iter().any(|(k, n)| !is_local_device(k) || safe_int(n).is_none_or(|n| !(0..=MAX_SLOTS).contains(&n))) {
                return Err(NodeError::bad("Clips at once per device: 0 to 8."));
            }
            let mut m = Map::new();
            for (k, n) in entries {
                m.insert(k, json!(safe_int(n).unwrap()));
            }
            json!({ "slots": m })
        } else {
            let Some(n) = safe_int(slots).filter(|n| (1..=MAX_SLOTS).contains(n)) else { return Err(NodeError::bad("Clips at once: 1 to 8.")) };
            let on = node_device_of(id).map(String::from).or_else(|| default_device_of(self.known_devices(&node).as_ref()));
            match on {
                Some(d) => json!({ "slots": { d: n } }),
                None => json!({ "slots": n }),
            }
        };
        let r = request(&Nodes::target(&node), Options {
            method: "POST", headers: vec![("Content-Type".into(), "application/json".into())], body: Body::Bytes(body.to_string().into_bytes()),
            ..Options::get("/node/v1/slots", 10_000)
        })?;
        if r.status != 200 {
            let e = peer_text(&r.json["error"], 160);
            return Err(NodeError::new(if e.is_empty() { format!("The node refused ({}).", r.status) } else { e }, 502, "NODE_ERROR"));
        }
        self.refresh_now(&node);
        Ok(self.0.info.lock().unwrap().get(&super::js_text(&node["id"])).cloned())
    }
}

impl Info {
    /// The info as the tests and the page read it.
    pub fn to_json(&self) -> Value {
        json!({ "at": self.at, "online": self.online, "error": self.error, "name": self.name, "encoders": self.encoders, "slots": self.slots, "busy": self.busy, "encoding": self.encoding,
            "devices": self.devices.as_ref().map(|d| d.iter().map(|x| json!({ "id": x.id, "kind": x.kind, "name": x.name, "encoders": x.encoders_json(), "slots": x.slots })).collect::<Vec<_>>()), "hardware": self.hardware })
    }
}
