//! The CAN area's routes (server/index.js, "CAN Bridge logs" to the CAN
//! downloads, the Sentry USB routes, and the CAN Bridge upload API on the web
//! port and the device port), and the services they share, wired as the Node
//! server wires them. Access (signed-in, admin, the password asked again) is
//! the core's: each request says whether it is confirmed (requireConfirmed).

use super::calc;
use super::ctx::{CanCtx, Car, Rec, Who};
use super::index::{self, CanIndex};
use super::json::{self, n};
use super::logs::{self, parse_name, CanError, CanLogs};
use super::models;
use super::prune::{self, CanPrune};
use super::reader;
use super::search::{self, CanSearch, IdsQuery, SearchQueue, SignalQuery};
use super::sentry_usb::SentryUsb;
use super::sync_service::CanSync;
use super::tags::CanTags;
use super::trust::CanTrust;
use super::tz;
use super::util;
use super::zip;
use axum::body::{Body, Bytes};
use axum::http::{header, HeaderMap, HeaderValue, Method, Response};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

pub type Res = Response<Body>;

/// A request as the CAN routes need it.
pub struct Req {
    pub method: Method,
    /// the raw path (not decoded)
    pub path: String,
    pub query: HashMap<String, String>,
    pub headers: HeaderMap,
    pub body: Bytes,
    /// the connection's own address
    pub remote: String,
    /// the port the request came in on (CAN_PORT: the device port)
    pub local_port: u16,
    /// an encrypted connection
    pub encrypted: bool,
    pub who: Who,
    /// the password was asked again recently (requireConfirmed)
    pub confirmed: bool,
    /// set when the client went away (a search then stops)
    pub closed: Arc<AtomicBool>,
}

pub fn json_res(status: u16, v: &Value) -> Res {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(json::stringify(v)))
        .unwrap()
}
fn ok(v: Value) -> Res {
    json_res(200, &v)
}

/// An HttpError: { error }, plus a code when it is one the pages read.
pub struct HttpError(pub u16, pub String, pub Option<&'static str>);
type R = Result<Res, HttpError>;
fn he(status: u16, msg: impl Into<String>) -> HttpError {
    HttpError(status, msg.into(), None)
}
fn confirmed(req: &Req) -> Result<(), HttpError> {
    if req.confirmed {
        Ok(())
    } else {
        Err(HttpError(403, "Enter your password to confirm this change.".into(), Some("CONFIRM_PASSWORD")))
    }
}
fn body_json(req: &Req) -> Result<Value, HttpError> {
    let t = String::from_utf8_lossy(&req.body);
    if t.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&t).map_err(|_| he(400, "Invalid JSON"))
}
fn q<'a>(req: &'a Req, k: &str) -> Option<&'a str> {
    req.query.get(k).map(|s| s.as_str())
}

// ---- streamed bodies: a channel from a worker thread
struct ChanStream(tokio::sync::mpsc::Receiver<Bytes>);
impl futures_core::Stream for ChanStream {
    type Item = Result<Bytes, std::io::Error>;
    fn poll_next(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Option<Self::Item>> {
        self.0.poll_recv(cx).map(|o| o.map(Ok))
    }
}

/// A writer into a response body: blocks while the reader is slow, ends the download once it took
/// nothing for `stall` (stopWhenStalled), fails once the reader has gone.
pub struct BodyWriter {
    tx: tokio::sync::mpsc::Sender<Bytes>,
    buf: Vec<u8>,
    stall: Duration,
}
impl BodyWriter {
    fn send(&mut self, b: Bytes) -> std::io::Result<()> {
        let mut item = b;
        let start = std::time::Instant::now();
        loop {
            match self.tx.try_send(item) {
                Ok(()) => return Ok(()),
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => return Err(std::io::Error::other("the reader went away")),
                Err(tokio::sync::mpsc::error::TrySendError::Full(x)) => {
                    if start.elapsed() >= self.stall {
                        return Err(std::io::Error::other("the reader stopped taking data"));
                    }
                    item = x;
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        }
    }
}
impl std::io::Write for BodyWriter {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.buf.extend_from_slice(b);
        if self.buf.len() >= 64 * 1024 {
            let chunk = Bytes::from(std::mem::take(&mut self.buf));
            self.send(chunk)?;
        }
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        if !self.buf.is_empty() {
            let chunk = Bytes::from(std::mem::take(&mut self.buf));
            self.send(chunk)?;
        }
        Ok(())
    }
}
impl Drop for BodyWriter {
    fn drop(&mut self) {
        let _ = std::io::Write::flush(self);
    }
}

fn streamed(stall: Duration) -> (BodyWriter, Body) {
    let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(16);
    (BodyWriter { tx, buf: Vec::new(), stall }, Body::from_stream(ChanStream(rx)))
}

fn attachment(name: &str) -> String {
    let clean: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '_' }).collect();
    format!("attachment; filename=\"{}\"", clean)
}

fn csv_cell(v: &CellV) -> String {
    let (mut t, is_num) = match v {
        CellV::S(s) => (s.clone(), false),
        CellV::N(x) => (json::num_str(*x), true),
        CellV::E => (String::new(), false),
    };
    if !is_num && t.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        t = format!("'{}", t);
    }
    if t.contains(['"', ',', '\n', '\r']) {
        format!("\"{}\"", t.replace('"', "\"\""))
    } else {
        t
    }
}
#[derive(Clone)]
enum CellV {
    S(String),
    N(f64),
    E,
}
fn csv_line(cells: &[CellV]) -> String {
    format!("{}\n", cells.iter().map(csv_cell).collect::<Vec<_>>().join(","))
}
fn s(x: &str) -> CellV {
    CellV::S(x.to_string())
}
fn iso_of(ms: f64) -> String {
    if ms.is_finite() { tz::iso(ms.floor() as i64) } else { String::new() }
}

const CAN_EVERY_AT_ONCE: usize = 2;
const CAN_EVERY_WAITING: usize = 8;
const CAN_DECODED_HOURS: f64 = 24.0;
const CAN_DECODED_ROWS: usize = 5_000_000;
const CAN_HEARTBEAT_MS: f64 = 60_000.0;
const CAN_STALL: Duration = Duration::from_secs(60);
/// GET /api/can/now: an answer is worked out at most this often (a Stream Deck asks once per key every few seconds)
const NOW_TTL_MS: f64 = 3000.0;

/// String(authorization).replace(/^Bearer\s+/i, '')
fn strip_bearer(h: &str) -> String {
    if h.get(..6).is_some_and(|p| p.eq_ignore_ascii_case("bearer")) {
        let rest = &h[6..];
        let t = rest.trim_start_matches(super::now::js_space);
        if t.len() < rest.len() {
            return t.to_string();
        }
    }
    h.to_string()
}

/// crypto.timingSafeEqual for buffers of the same length
fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

struct Every {
    running: usize,
    waiting: usize,
    ready: Vec<(String, Arc<(Vec<u8>, Vec<u8>)>)>,
}

/// The device port's state (canPort.state()).
#[derive(Clone)]
pub struct PortState {
    pub listening: bool,
    pub error: Option<String>,
    pub port: u16,
}

pub struct Can {
    pub ctx: Arc<dyn CanCtx>,
    pub logs: Arc<CanLogs>,
    pub trust: Arc<CanTrust>,
    pub index: Arc<CanIndex>,
    pub search: Arc<CanSearch>,
    pub queue: Arc<SearchQueue>,
    pub prune: Arc<CanPrune>,
    pub sync: Arc<CanSync>,
    pub tags: CanTags,
    pub usb: Arc<SentryUsb>,
    bad_tries: Mutex<indexmap::IndexMap<String, (u32, f64)>>,
    pace: Mutex<HashMap<String, (u32, f64)>>,
    every: Mutex<Every>,
    every_cv: Condvar,
    stamps: Mutex<HashMap<String, (u64, Arc<Vec<String>>)>>,
    pub port_state: Mutex<PortState>,
    /// the device port's wish changed: (re)open or close it
    pub on_port: Mutex<Option<Box<dyn Fn(bool) + Send + Sync>>>,
    progress_due: AtomicBool,
    /// GET /api/can/now's answers, a few seconds each: "<keys>|<units>" -> (when, answer)
    now_cache: Mutex<indexmap::IndexMap<String, (f64, Option<Value>)>>,
}

fn can_index_dir(ctx: &dyn CanCtx) -> PathBuf {
    ctx.data_dir().join("can-index")
}

impl Can {
    pub fn new(ctx: Arc<dyn CanCtx>) -> Arc<Can> {
        let data = ctx.data_dir();
        let can_dir = data.join("can");
        let fb_dir = data.clone();
        let logs = CanLogs::new(can_dir.clone(), Box::new(move || util::free_bytes(&fb_dir).unwrap_or(f64::INFINITY)), Box::new(util::now_ms));
        let c1 = ctx.clone();
        let trust = CanTrust::with_log(can_dir.clone(), Box::new(util::now_ms), Box::new(move |lvl, line| c1.log(lvl, line)));
        Arc::new_cyclic(|me: &std::sync::Weak<Can>| {
            let mut idx = CanIndex::new(can_dir.clone(), can_index_dir(&*ctx));
            let c2 = ctx.clone();
            idx.idle = Box::new(move || c2.idle());
            let w = me.clone();
            idx.profile_of = Box::new(move |index, key| w.upgrade().map(|c| c.car_for_key_with(index, key).profile).unwrap_or_else(|| models::DEFAULT_PROFILE.into()));
            let t2 = trust.clone();
            idx.usable = Box::new(move |k, name| t2.usable(k, name));
            let w = me.clone();
            idx.on_indexed = Box::new(move |key, from, to| {
                // index.js onIndexed: the archive gap check forgets what it read of these minutes
                // and checks that key's cars again a little later (CAN driving with no footage)
                if let Some(viewer) = crate::viewer::get() {
                    viewer.archive.indexed(key, from, to);
                    for v in viewer.ctx.vehicles() {
                        if viewer.ctx.can_keys(&v.id).iter().any(|k| k == key) {
                            viewer.archive.soon(&v.id);
                        }
                    }
                }
                if let (Some(c), Some(f), Some(t)) = (w.upgrade(), from, to) {
                    c.sync.indexed(key, f, t);
                }
            });
            let w = me.clone();
            idx.on_progress = Box::new(move |_| {
                if let Some(c) = w.upgrade() {
                    c.progress_due.store(true, Ordering::SeqCst);
                }
            });
            let c3 = ctx.clone();
            idx.log = Box::new(move |lvl, line| c3.log(lvl, line));
            let index = Arc::new(idx);
            let search = Arc::new(CanSearch::new(can_index_dir(&*ctx)));
            let w = me.clone();
            let w2 = me.clone();
            let prune = Arc::new(CanPrune::new(
                ctx.clone(),
                logs.clone(),
                trust.clone(),
                Box::new(move |key, name| {
                    if let Some(c) = w.upgrade() {
                        c.drop_log(key, name);
                    }
                }),
                Box::new(move |_| {
                    if let Some(c) = w2.upgrade() {
                        c.ctx.announce("can");
                    }
                }),
            ));
            let ix = index.clone();
            let w = me.clone();
            let mut sync = CanSync::new(
                can_index_dir(&*ctx),
                ctx.clone(),
                Box::new(move |keys, from, to| {
                    let names: HashSet<String> = super::sync::NAMES.iter().map(|s| s.to_string()).collect();
                    ix.series(keys, from, to, Some(&names))
                }),
                Box::new(move |vid| w.upgrade().map(|c| c.keys_for(vid)).unwrap_or_default()),
            );
            let c4 = ctx.clone();
            let ix2 = index.clone();
            sync.idle = Box::new(move || c4.idle() && !ix2.status().running);
            let mut usb = SentryUsb::new(ctx.clone());
            let c5 = ctx.clone();
            usb.on_change = Box::new(move |_| c5.announce("inventory"));
            Can {
                ctx: ctx.clone(),
                logs: logs.clone(),
                trust: trust.clone(),
                index,
                search,
                queue: SearchQueue::new(4),
                prune,
                sync: Arc::new(sync),
                tags: CanTags::default(),
                usb: Arc::new(usb),
                bad_tries: Mutex::new(indexmap::IndexMap::new()),
                pace: Mutex::new(HashMap::new()),
                every: Mutex::new(Every { running: 0, waiting: 0, ready: Vec::new() }),
                every_cv: Condvar::new(),
                stamps: Mutex::new(HashMap::new()),
                port_state: Mutex::new(PortState { listening: false, error: None, port: ctx.can_port() }),
                on_port: Mutex::new(None),
                progress_due: AtomicBool::new(false),
                now_cache: Mutex::new(indexmap::IndexMap::new()),
            }
        })
    }

    /// The background work the Node server starts: the index after 20 s, the checks after 15 s
    /// and every 5 minutes, stale uploads every hour, the prune sweep after 10 minutes and hourly,
    /// the Sentry USB poll every minute, the progress announcements at most once a second.
    pub fn start(self: &Arc<Self>) {
        self.viewer_car_data();
        let me = self.clone();
        std::thread::spawn(move || {
            let t0 = std::time::Instant::now();
            let (mut judged, mut indexed, mut swept) = (false, false, false);
            let mut last = [t0; 5];
            loop {
                std::thread::sleep(Duration::from_millis(250));
                let el = t0.elapsed();
                if me.progress_due.swap(false, Ordering::SeqCst) {
                    me.ctx.announce("can");
                }
                me.prune.tick();
                if !judged && el >= Duration::from_secs(15) || judged && last[0].elapsed() >= Duration::from_secs(300) {
                    judged = true;
                    last[0] = std::time::Instant::now();
                    me.judge_pending();
                }
                if !indexed && el >= Duration::from_secs(20) {
                    indexed = true;
                    me.index.kick();
                }
                if last[1].elapsed() >= Duration::from_secs(3600) {
                    last[1] = std::time::Instant::now();
                    me.logs.clean_stale(2.0 * 24.0 * 3600_000.0);
                }
                if !swept && el >= Duration::from_secs(600) || swept && last[2].elapsed() >= Duration::from_secs(3600) {
                    swept = true;
                    last[2] = std::time::Instant::now();
                    me.prune.sweep();
                }
                if last[3].elapsed() >= Duration::from_secs(60) || el < Duration::from_millis(300) {
                    last[3] = std::time::Instant::now();
                    me.usb.poll();
                }
            }
        });
        if self.port_wanted() {
            self.sync_port();
        }
    }

    // ---- which car each key is
    pub fn can_map(&self) -> Map<String, Value> {
        self.ctx.setting("can-vehicles").filter(|v| json::truthy(Some(v))).and_then(|v| v.as_object().cloned()).unwrap_or_default()
    }
    /// canKeysFor(vid): the keys the Viewer reads for a car (mapped to it, or unmapped with one car).
    pub fn keys_for(&self, vid: &str) -> Vec<String> {
        let map = self.can_map();
        let keys = util::subdirs(&can_index_dir(&*self.ctx));
        let single = self.ctx.vehicles().len() == 1;
        keys.into_iter().filter(|k| map.get(k).and_then(|v| v.as_str()) == Some(vid) || (!json::truthy(map.get(k)) && single)).collect()
    }
    fn car_of_key(&self, key: &str) -> Option<Car> {
        let map = self.can_map();
        let vid = map.get(key).filter(|v| json::truthy(Some(v))).map(|v| logs::js_string(v));
        let list = self.ctx.vehicles();
        match vid {
            Some(id) => list.into_iter().find(|v| v.id == id),
            None if list.len() == 1 => list.into_iter().next(),
            None => None,
        }
    }
    fn detected_car_of(&self, index: &CanIndex, vid: &str) -> Option<Value> {
        let mut best: Option<Value> = None;
        for k in self.keys_for(vid) {
            if let Some(c) = index.car_of(&k) {
                let seen = |v: &Value| v.get("seenAt").and_then(|x| x.as_f64()).unwrap_or(0.0);
                if best.as_ref().is_none_or(|b| seen(&c) > seen(b)) {
                    best = Some(c);
                }
            }
        }
        best
    }
    fn car_for_key_with(&self, index: &CanIndex, key: &str) -> models::Resolved {
        let v = self.car_of_key(key);
        let own = index.car_of(key).or_else(|| v.as_ref().and_then(|v| self.detected_car_of(index, &v.id)));
        let det = own.as_ref().and_then(models::vin_of_json);
        models::resolve_car(v.as_ref().and_then(|v| v.car.as_ref()), det.as_ref())
    }
    /// carSummary(v): the vehicle's `car` in GET /api/vehicles.
    pub fn car_summary(&self, v: &Car) -> Value {
        let det = self.detected_car_of(&self.index, &v.id);
        let (model, generation) = models::normalize_car(v.car.as_ref());
        let vin = det.as_ref().and_then(models::vin_of_json);
        let mut o = Map::new();
        o.insert("setting".into(), json!({ "model": model, "generation": generation }));
        o.insert(
            "detected".into(),
            det.as_ref().map_or(Value::Null, |d| json!({ "model": d.get("model"), "year": d.get("year"), "plant": d.get("plant"), "via": d.get("via"), "vin": d.get("vin").and_then(|x| x.as_str()).and_then(models::mask_vin), "seenAt": d.get("seenAt") })),
        );
        if let Value::Object(r) = models::resolve_car(v.car.as_ref(), vin.as_ref()).to_json() {
            for (k, x) in r {
                o.insert(k, x);
            }
        }
        Value::Object(o)
    }
    /// The green "CAN" tag: a test for the recordings of a car.
    pub fn has_can(&self, v: &Car) -> impl Fn(&Rec) -> bool {
        let keys = self.keys_for(&v.id);
        let ix = self.index.clone();
        self.tags.for_vehicle(v, &keys, self.index.generation(), &move |k| ix.minute_times(k, f64::NEG_INFINITY, f64::INFINITY))
    }

    // ---- the upload config ('can')
    fn can_cfg(&self) -> (bool, Value, Vec<Value>) {
        let c = self.ctx.setting("can").filter(|v| json::truthy(Some(v))).unwrap_or(json!({ "enabled": false }));
        let enabled = json::truthy(c.get("enabled"));
        let at = c.get("at").cloned().unwrap_or(Value::Null);
        if json::truthy(c.get("tokenHash")) && !c.get("tokens").is_some_and(|t| t.is_array()) {
            let t = json!({ "id": "first", "hash": c["tokenHash"], "vehicleId": null, "key": null, "label": "First token", "createdAt": if json::truthy(Some(&at)) { at.clone() } else { Value::Null }, "lastUsedAt": null });
            return (enabled, at, vec![t]);
        }
        (enabled, at, c.get("tokens").and_then(|t| t.as_array()).cloned().unwrap_or_default())
    }
    fn save_can_cfg(&self, enabled: bool, at: &Value, tokens: &[Value]) {
        self.ctx.set_setting("can", json!({ "enabled": enabled, "at": if json::truthy(Some(at)) { at.clone() } else { Value::Null }, "tokens": tokens }));
    }
    fn port_wanted(&self) -> bool {
        self.ctx.setting("can").is_some_and(|c| json::truthy(c.get("enabled")))
    }
    fn sync_port(&self) {
        let on = self.port_wanted();
        if let Some(f) = self.on_port.lock().unwrap().as_ref() {
            f(on);
        }
    }

    fn has_can_logs(&self) -> bool {
        let root = self.ctx.data_dir().join("can");
        util::subdirs(&root).iter().any(|d| util::names(&root.join(d)).unwrap_or_default().iter().any(|f| f.ends_with(".log.xz")))
    }
    /// viewerCarData(): { enabled }, turned on once for a server that already has CAN data.
    pub fn viewer_car_data(&self) -> Value {
        if let Some(c) = self.ctx.setting("viewerCarData") {
            if let Some(b) = c.get("enabled").and_then(|e| e.as_bool()) {
                return json!({ "enabled": b });
            }
        }
        let mut why = Vec::new();
        if self.has_can_logs() {
            why.push("CAN Bridge logs");
        }
        if !self.can_cfg().2.is_empty() {
            why.push("a CAN Bridge token");
        }
        if self.ctx.has_dashboards() {
            why.push("saved car-data dashboards");
        }
        self.ctx.set_setting("viewerCarData", json!({ "enabled": !why.is_empty(), "at": n(util::now_ms()), "migrated": true }));
        if !why.is_empty() {
            self.ctx.log("info", &format!("Car data in the Viewer: on (this server has {})", why.join(", ")));
        }
        json!({ "enabled": !why.is_empty() })
    }

    // ---- trust and the index
    fn judge(self: &Arc<Self>, key: &str, name: &str) -> Value {
        let before = self.trust.record(key, name);
        let rec = self.trust.check(key, name);
        let st = rec.get("status").and_then(|s| s.as_str());
        if !rec.as_object().is_none_or(|m| m.is_empty()) && st != Some("waiting") {
            self.index.kick();
        }
        if st.is_some() && (rec.get("status") != before.as_ref().and_then(|b| b.get("status")) || rec.get("reason") != before.as_ref().and_then(|b| b.get("reason"))) {
            self.ctx.announce("can");
        }
        rec
    }
    fn judge_pending(self: &Arc<Self>) {
        for (key, name) in self.trust.pending() {
            self.judge(&key, &name);
        }
    }
    /// dropCanLog: a log's data taken out of the index, and the sync told.
    fn drop_log(&self, key: &str, name: &str) {
        self.index.remove_log(key, name);
        if let Some(nm) = parse_name(name) {
            self.sync.indexed(key, (nm.started_at - 2 * 60_000) as f64, (nm.started_at + 30 * 60_000) as f64);
        }
    }

    fn vehicle_or_404(&self, id: &str) -> Result<Car, HttpError> {
        self.ctx.vehicle(id).ok_or_else(|| he(404, "No such vehicle."))
    }

    /// canClipOf: the car, its CAN keys and the clip's start in UTC, for a clip file.
    fn clip_of(&self, p: &str) -> Result<(Car, Vec<String>, f64), HttpError> {
        let sep = std::path::MAIN_SEPARATOR;
        let v = self
            .ctx
            .vehicles()
            .into_iter()
            .find(|x| x.root.as_ref().is_some_and(|r| {
                let r = r.to_string_lossy();
                p == r || p.starts_with(&format!("{}{}", r, sep))
            }))
            .ok_or_else(|| he(404, "Not a clip of a vehicle."))?;
        let base = p.rsplit('/').next().unwrap_or(p);
        let start = prune::start_of(&v, base).ok_or_else(|| he(400, "Not a TeslaCam clip name."))?;
        let keys = self.keys_for(&v.id);
        Ok((v, keys, start))
    }

    fn sync_of(self: &Arc<Self>, v: &Car, keys: &[String], p: &str, start: f64) -> Value {
        let Some(real) = self.ctx.resolve_clip(p) else { return Value::Null };
        if self.ctx.hidden_path(&real) {
            return Value::Null;
        }
        self.sync.for_clip(v, keys, &real, start).unwrap_or(Value::Null)
    }

    /// The routes this area answers; None for any other.
    pub fn handle(self: &Arc<Self>, req: &Req) -> Option<Res> {
        let path = req.path.split('?').next().unwrap_or("");
        if path == "/api/can/logs" || path.starts_with("/api/can/logs/") {
            return Some(self.upload(req, path));
        }
        let seg: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        let get = req.method == Method::GET;
        let post = req.method == Method::POST;
        let del = req.method == Method::DELETE;
        let dec = |s: &str| crate::api::decode(s, false);
        let r: R = match seg.as_slice() {
            ["api", "can", "signals"] if get => self.signals(req),
            ["api", "can", "clip"] if get => self.clip(req),
            ["api", "can", "vehicle-signals"] if get => self.vehicle_signals(req),
            ["api", "can", "search"] if get => self.search_run(req, false),
            ["api", "can", "id-events"] if get => self.search_run(req, true),
            ["api", "can", "raw"] if get => self.raw(req),
            ["api", "can", "vehicle-map"] if post => self.vehicle_map(req),
            ["api", "can", "settings"] if get => Ok(ok(self.settings())),
            ["api", "can", "viewer-car-data"] if post => self.set_viewer_car_data(req),
            ["api", "can", "keep"] if post => self.keep(req),
            ["api", "can", "enable"] if post => self.enable(req),
            ["api", "can", "disable"] if post => self.disable(req),
            ["api", "sentryusb"] if get => Ok(ok(self.sentryusb())),
            ["api", "can", "tokens"] if post => self.new_token(req),
            ["api", "can", "tokens", id] if del => match dec(id) {
                Some(id) => self.revoke(req, &id),
                None => return None,
            },
            ["api", "can", "pairing", key, what] if post => match dec(key) {
                Some(key) => self.pairing(req, &key, what),
                None => return None,
            },
            ["api", "can", "files"] if get => Ok(ok(self.files(req))),
            ["api", "can", "files", name] if del => match dec(name) {
                Some(name) => self.delete_file(req, &name),
                None => return None,
            },
            ["api", "can", "files", name, "use"] if post => match dec(name) {
                Some(name) => self.use_file(req, &name),
                None => return None,
            },
            ["api", "can", "files", name, "download"] if get => match dec(name) {
                Some(name) => self.download(req, &name),
                None => return None,
            },
            ["api", "can", "files", name, "candump"] if get => match dec(name) {
                Some(name) => self.candump(req, &name),
                None => return None,
            },
            ["api", "can", "export", "bundle"] if get => self.bundle(req),
            ["api", "can", "export", "decoded"] if get => self.decoded(req),
            ["api", "can", "export", "new-ids"] if get => self.new_ids(req),
            ["api", "vehicles", id, "sentry-usb"] if get => match dec(id) {
                Some(id) => self.sentry_usb_view(req, &id),
                None => return None,
            },
            ["api", "vehicles", id, "sentry-usb", "record"] if post => match dec(id) {
                Some(id) => self.sentry_usb_record(req, &id),
                None => return None,
            },
            ["api", "can", "stream-deck"] if get => self.deck_get(req),
            ["api", "can", "stream-deck"] if post => self.deck_make(req),
            ["api", "can", "stream-deck"] if del => self.deck_off(req),
            ["api", "can", "stream-deck", "plugin"] if get => self.deck_plugin(req),
            _ => return None,
        };
        Some(match r {
            Ok(res) => res,
            Err(HttpError(status, msg, code)) => {
                let mut o = Map::new();
                o.insert("error".into(), json!(msg));
                if let Some(c) = code {
                    o.insert("code".into(), json!(c));
                }
                json_res(status, &Value::Object(o))
            }
        })
    }

    // ---- the Viewer
    fn signals(self: &Arc<Self>, req: &Req) -> R {
        let (_, keys, _) = self.clip_of(q(req, "path").unwrap_or(""))?;
        Ok(ok(json!({ "signals": self.index.signals(&keys) })))
    }

    fn clip(self: &Arc<Self>, req: &Req) -> R {
        let p = q(req, "path").unwrap_or("");
        let (v, keys, named) = self.clip_of(p)?;
        let every = q(req, "signals") == Some("*");
        let names: Vec<String> = if every {
            Vec::new()
        } else {
            q(req, "signals").unwrap_or("").split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty() && x.len() <= 80 && x.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')).take(64).collect()
        };
        if (!every && names.is_empty()) || keys.is_empty() {
            return Ok(ok(json!({ "start": n(named), "series": {} })));
        }
        let sync = self.sync_of(&v, &keys, p, named);
        let start = json::round((named + sync.get("offsetMs").and_then(|x| x.as_f64()).unwrap_or(0.0)) * 10.0) / 10.0;
        let series_json = |s: &indexmap::IndexMap<String, Vec<(f64, f64)>>| Value::Object(s.iter().map(|(k, p)| (k.clone(), Value::Array(p.iter().map(|x| json!([n(x.0), n(x.1)])).collect()))).collect());
        if !every {
            let set: HashSet<String> = names.into_iter().collect();
            let (series, trust) = self.index.clip_data(&keys, start - 2000.0, start + 70_000.0, Some(&set), 0.0, false, None);
            return Ok(ok(json!({ "start": n(start), "sync": sync, "trust": trust, "series": series_json(&series) })));
        }
        let step = index::CLIP_STEP_MS.max(5000f64.min(json::round(q(req, "step").map(json::str_number).filter(|x| *x != 0.0 && !x.is_nan()).unwrap_or(index::CLIP_STEP_MS))));
        let cols = q(req, "cols") == Some("1");
        let id = format!("{}|{}|{}|{}|{}|{}", keys.join(","), json::num_str(start), json::stringify(&sync), json::num_str(step), if cols { "c" } else { "p" }, self.index.generation());
        let cached = self.every.lock().unwrap().ready.iter().find(|x| x.0 == id).map(|x| x.1.clone());
        let body = match cached {
            Some(b) => b,
            None => {
                {
                    let mut e = self.every.lock().unwrap();
                    if e.running >= CAN_EVERY_AT_ONCE {
                        if e.waiting >= CAN_EVERY_WAITING {
                            return Err(he(429, "The car data is busy: try again in a moment."));
                        }
                        e.waiting += 1;
                        while e.running >= CAN_EVERY_AT_ONCE {
                            e = self.every_cv.wait(e).unwrap();
                        }
                        e.waiting -= 1;
                    }
                    e.running += 1;
                }
                let answer = if cols {
                    let mut changing = Vec::new();
                    let (series, trust) = self.index.clip_data(&keys, start - 2000.0, start + 70_000.0, None, step, true, Some(&mut changing));
                    let base = json::round(start);
                    let mut out = Map::new();
                    for (name, pts) in &series {
                        let mut dt = Vec::with_capacity(pts.len());
                        let mut val = Vec::with_capacity(pts.len());
                        let mut prev = base;
                        for p in pts {
                            let d = json::round(p.0 - prev);
                            prev += d;
                            dt.push(n(d));
                            val.push(n(p.1));
                        }
                        out.insert(name.clone(), json!([dt, val]));
                    }
                    json!({ "start": n(start), "sync": sync, "trust": trust, "step": n(step), "base": n(base), "changing": changing, "cols": out })
                } else {
                    let (series, trust) = self.index.clip_data(&keys, start - 2000.0, start + 70_000.0, None, step, false, None);
                    json!({ "start": n(start), "sync": sync, "trust": trust, "series": series_json(&series) })
                };
                let text = json::stringify(&answer).into_bytes();
                let gz = {
                    use std::io::Write;
                    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(4));
                    e.write_all(&text).unwrap();
                    e.finish().unwrap()
                };
                let b = Arc::new((text, gz));
                let mut e = self.every.lock().unwrap();
                e.running -= 1;
                self.every_cv.notify_one();
                e.ready.push((id, b.clone()));
                while e.ready.len() > 4 {
                    e.ready.remove(0);
                }
                b
            }
        };
        let gz = req.headers.get(header::ACCEPT_ENCODING).and_then(|h| h.to_str().ok()).is_some_and(|h| h.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| w == "gzip"));
        let mut r = Response::builder().status(200).header(header::CONTENT_TYPE, "application/json; charset=utf-8").header(header::CACHE_CONTROL, "no-store");
        if gz {
            r = r.header(header::CONTENT_ENCODING, "gzip");
        }
        Ok(r.header(header::VARY, "Accept-Encoding").body(Body::from(if gz { body.1.clone() } else { body.0.clone() })).unwrap())
    }

    fn vehicle_signals(&self, req: &Req) -> R {
        let v = self.vehicle_or_404(q(req, "vehicle").unwrap_or(""))?;
        Ok(ok(json!({ "signals": self.index.signals(&self.keys_for(&v.id)) })))
    }

    fn raw(self: &Arc<Self>, req: &Req) -> R {
        let p = q(req, "path").unwrap_or("");
        let (v, keys, named) = self.clip_of(p)?;
        let sync = if keys.is_empty() { Value::Null } else { self.sync_of(&v, &keys, p, named) };
        let start = json::round((named + sync.get("offsetMs").and_then(|x| x.as_f64()).unwrap_or(0.0)) * 10.0) / 10.0;
        let ms = |x: Option<&str>, d: f64| match x {
            Some(t) if !t.is_empty() => {
                let v = json::str_number(t);
                if v.is_finite() { v.clamp(-120_000.0, 180_000.0) } else { d }
            }
            _ => d,
        };
        let from = start + ms(q(req, "from"), -2000.0);
        let to = start + ms(q(req, "to"), 70_000.0);
        let ids = if !keys.is_empty() && to >= from { self.index.raw(&keys, from, to) } else { Vec::new() };
        if json::truthy(q(req, "probe").map(|s| Value::String(s.into())).as_ref()) {
            return Ok(ok(json!({ "start": n(start), "count": ids.len() })));
        }
        Ok(ok(json!({ "start": n(start), "sync": sync, "from": n(from), "to": n(to), "ids": ids })))
    }

    fn search_run(self: &Arc<Self>, req: &Req, ids: bool) -> R {
        let v = self.vehicle_or_404(q(req, "vehicle").unwrap_or(""))?;
        let keys = self.keys_for(&v.id);
        let zone = if v.timezone.is_empty() { "UTC".to_string() } else { v.timezone.clone() };
        let z2 = zone.clone();
        let to_utc = move |y, mo, d, h, mi, s| tz::zoned_to_utc(y, mo, d, h, mi, s, &z2) as f64;
        let when = |k: &str, end: bool| search::parse_when(q(req, k), &to_utc, end).map_err(|e| he(e.status, e.message));
        let resume = q(req, "resume").filter(|s| !s.is_empty()).map(String::from);
        enum Ask {
            S(SignalQuery),
            I(IdsQuery),
        }
        let ask = if !ids {
            Ask::S(if resume.is_some() {
                SignalQuery { signal: None, op: None, value: None, from: None, to: None, limit: None, all: false, resume }
            } else {
                SignalQuery {
                    signal: q(req, "signal").map(String::from),
                    op: q(req, "op").map(String::from),
                    value: q(req, "value").map(String::from),
                    from: when("from", false)?,
                    to: when("to", true)?,
                    limit: q(req, "limit").map(String::from),
                    all: matches!(q(req, "all"), Some("1") | Some("true")),
                    resume: None,
                }
            })
        } else {
            Ask::I(if resume.is_some() {
                IdsQuery { from: None, to: None, before: None, gap: None, id: None, limit: None, resume }
            } else {
                IdsQuery { from: when("from", false)?, to: when("to", true)?, before: when("before", false)?, gap: q(req, "gap").map(String::from), id: q(req, "id").filter(|s| !s.is_empty()).map(String::from), limit: q(req, "limit").map(String::from), resume: None }
            })
        };
        let owner = if req.who.owner.is_empty() { self.ctx.client_key(&req.remote) } else { req.who.owner.clone() };
        let ticket = Arc::new(self.queue.enter(&owner).map_err(|e| he(e.status, e.message))?);
        // the page closed: the search stops
        let closed = req.closed.clone();
        let done = Arc::new(AtomicBool::new(false));
        let watch = std::thread::spawn({
            let (t, done) = (ticket.clone(), done.clone());
            move || loop {
                if closed.load(Ordering::SeqCst) {
                    t.cancel("Stopped: the page closed.");
                    return;
                }
                if done.load(Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let r = self.queue.run(&ticket, |stop| match &ask {
            Ask::S(sq) => self.search.signal(&keys, sq, stop),
            Ask::I(iq) => self.search.ids(&keys, iq, stop),
        });
        done.store(true, Ordering::SeqCst);
        let _ = watch.join();
        let mut out = r.map_err(|e| he(e.status, e.message))?;
        let stamps = self.stamps_of(&v);
        let add = |m: &mut Value| {
            if let Some(at) = m.get("at").and_then(|a| a.as_f64()).filter(|a| a.is_finite()) {
                m["localTime"] = json!(search::local_time(at, &zone));
                m["footage"] = search::footage_at(stamps.as_deref().map(|x| x.as_slice()), at, &zone);
            }
        };
        for list in ["matches", "appeared", "stopped"] {
            if let Some(Value::Array(a)) = out.get_mut(list) {
                for m in a.iter_mut() {
                    add(m);
                }
            }
        }
        // ("first" is the same match as matches[0], with the clip too)
        if let Some(first) = out.get("matches").and_then(|m| m.get(0)).cloned() {
            if out.get("first").is_some_and(|f| !f.is_null()) {
                out["first"] = first;
            }
        }
        let mut o = Map::new();
        o.insert("vehicle".into(), json!(v.id));
        o.insert("timezone".into(), json!(zone));
        o.insert("keys".into(), json!(keys));
        if let Value::Object(m) = out {
            for (k, x) in m {
                o.insert(k, x);
            }
        }
        Ok(ok(Value::Object(o)))
    }

    fn stamps_of(&self, v: &Car) -> Option<Arc<Vec<String>>> {
        let scan = self.ctx.scan_of(&v.id)?;
        let mut st = self.stamps.lock().unwrap();
        if let Some((g, s)) = st.get(&v.id) {
            if *g == scan.generation {
                return Some(s.clone());
            }
        }
        let s = Arc::new(search::clip_stamps(scan.recordings.iter().flat_map(|r| r.clip_rels.iter().map(|x| x.as_str()))));
        st.insert(v.id.clone(), (scan.generation, s.clone()));
        Some(s)
    }

    fn vehicle_map(self: &Arc<Self>, req: &Req) -> R {
        confirmed(req)?;
        let body = body_json(req)?;
        let key = body.get("key").map(|k| json::js_str(Some(k))).filter(|k| !k.is_empty() && body.get("key").is_some_and(|x| !x.is_null())).unwrap_or_default();
        if !logs::valid_key(&key) {
            return Err(he(400, "Give the CAN Bridge car key."));
        }
        let vid = match body.get("vehicleId").filter(|v| json::truthy(Some(v))) {
            Some(id) => Some(self.vehicle_or_404(&logs::js_string(id))?.id),
            None => None,
        };
        let mut map = self.can_map();
        match &vid {
            Some(id) => {
                map.insert(key.clone(), json!(id));
            }
            None => {
                map.shift_remove(&key);
            }
        }
        self.ctx.set_setting("can-vehicles", Value::Object(map.clone()));
        self.ctx.audit("info", &format!("CAN car {} is {}: {}", key, vid.as_deref().unwrap_or("no vehicle"), req.who.by));
        self.index.kick();
        Ok(ok(json!({ "map": map })))
    }

    // ---- the Nerd settings
    pub fn settings(&self) -> Value {
        let (enabled, at, tokens) = self.can_cfg();
        let (bytes, count, log_keys) = self.logs.summary();
        let mut keys: Vec<String> = log_keys;
        for t in &tokens {
            if let Some(k) = t.get("key").filter(|k| json::truthy(Some(k))).and_then(|k| k.as_str()) {
                if !keys.iter().any(|x| x == k) {
                    keys.push(k.to_string());
                }
            }
        }
        keys.sort();
        keys.dedup();
        let ps = self.port_state.lock().unwrap().clone();
        json!({
            "enabled": enabled, "since": if json::truthy(Some(&at)) { at } else { Value::Null }, "logs": count, "bytes": n(bytes),
            "port": { "listening": ps.listening, "error": ps.error, "port": ps.port, "https": self.ctx.tls() },
            "keys": keys, "map": self.can_map(), "vehicles": self.ctx.vehicles().iter().map(|v| json!({ "id": v.id, "name": v.name })).collect::<Vec<_>>(),
            "index": self.index.status().to_json(),
            "tokens": tokens.iter().map(|t| json!({ "id": t.get("id"), "label": t.get("label"), "vehicleId": t.get("vehicleId"), "key": t.get("key"), "createdAt": t.get("createdAt"), "lastUsedAt": t.get("lastUsedAt") })).collect::<Vec<_>>(),
            "trust": keys.iter().map(|k| self.trust.summary(k)).collect::<Vec<_>>(),
            "keep": self.prune.status(),
            "viewerCarData": self.viewer_car_data()
        })
    }

    fn set_viewer_car_data(&self, req: &Req) -> R {
        let body = body_json(req)?;
        let Some(on) = body.get("enabled").and_then(|e| e.as_bool()) else { return Err(he(400, "Send { \"enabled\": true | false }.")) };
        self.ctx.set_setting("viewerCarData", json!({ "enabled": on, "at": n(util::now_ms()) }));
        self.ctx.audit("info", &format!("Car data in the Viewer turned {}: {}", if on { "on" } else { "off" }, req.who.by));
        self.ctx.announce("carData");
        Ok(ok(self.viewer_car_data()))
    }

    fn keep(&self, req: &Req) -> R {
        confirmed(req)?;
        let body = body_json(req)?;
        let okay = ["withFootage", "deleteUnlinked"].iter().any(|k| body.get(*k).is_some_and(|v| v.is_boolean())) || body.get("unlinkedDays").is_some();
        let days = body.get("unlinkedDays");
        let days_ok = days.is_none_or(|d| d.as_f64().is_some_and(|x| x.fract() == 0.0 && (1.0..=365.0).contains(&x)));
        if !okay || !days_ok {
            return Err(he(400, "Send { \"withFootage\": true | false, \"deleteUnlinked\": true | false, \"unlinkedDays\": 1-365 } (any of them)."));
        }
        let out = self.prune.set(&body);
        let (wf, du, ud) = (json::truthy(out.get("withFootage")), json::truthy(out.get("deleteUnlinked")), json::num_str(out["unlinkedDays"].as_f64().unwrap_or(7.0)));
        self.ctx.audit(
            "warn",
            &format!(
                "CAN logs: {}; {}: {}",
                if wf { "deleted with their footage" } else { "not deleted with their footage" },
                if du { format!("deleted when not linked to footage after {} days", ud) } else { "kept when not linked to footage".into() },
                req.who.by
            ),
        );
        self.ctx.announce("can");
        Ok(ok(out))
    }

    fn new_token_entry(&self, tokens: &mut Vec<Value>, vehicle_id: Option<&Value>, label: Option<&Value>) -> Result<(String, Value), HttpError> {
        let token = util::base64url(&util::random(32));
        let v = match vehicle_id.filter(|v| json::truthy(Some(v))) {
            Some(id) => Some(self.vehicle_or_404(&logs::js_string(id))?),
            None => {
                let l = self.ctx.vehicles();
                if l.len() == 1 { l.into_iter().next() } else { None }
            }
        };
        let known: Vec<String> = v.as_ref().map(|v| self.prune.keys_of(&v.id)).unwrap_or_default();
        let lab = label.filter(|x| json::truthy(Some(x))).map(|x| logs::js_string(x)).unwrap_or_default();
        let lab: String = lab.chars().map(|c| if (c as u32) < 0x20 { ' ' } else { c }).collect();
        let lab = util::utf16_slice(lab.trim(), 40);
        let lab = if lab.is_empty() { format!("{} CAN Bridge", v.as_ref().map(|v| v.name.as_str()).unwrap_or("Car")) } else { lab };
        let entry = json!({
            "id": util::hex(&util::random(6)), "hash": util::sha256_hex(token.as_bytes()), "vehicleId": v.as_ref().map(|v| v.id.clone()),
            "key": if known.len() == 1 { Value::String(known[0].clone()) } else { Value::Null }, "label": lab, "createdAt": n(util::now_ms()), "lastUsedAt": null
        });
        if tokens.len() >= 20 {
            return Err(he(400, "There are 20 tokens already: revoke some first."));
        }
        tokens.push(entry.clone());
        Ok((token, entry))
    }

    fn enable(&self, req: &Req) -> R {
        confirmed(req)?;
        let body = body_json(req)?;
        let (_, at, mut tokens) = self.can_cfg();
        let at = if json::truthy(Some(&at)) { at } else { n(util::now_ms()) };
        let made = if tokens.is_empty() { Some(self.new_token_entry(&mut tokens, body.get("vehicleId"), None)?) } else { None };
        self.save_can_cfg(true, &at, &tokens);
        self.ctx.audit("warn", &format!("CAN Bridge uploads turned on{}: {}", made.as_ref().map(|m| format!(" (token \"{}\")", m.1["label"].as_str().unwrap_or(""))).unwrap_or_default(), req.who.by));
        self.sync_port();
        Ok(ok(json!({ "enabled": true, "token": made.as_ref().map(|m| m.0.clone()), "tokenId": made.as_ref().map(|m| m.1["id"].clone()), "fingerprint": self.ctx.cert_fingerprint(), "port": self.ctx.can_port() })))
    }

    fn disable(&self, req: &Req) -> R {
        confirmed(req)?;
        let (_, at, tokens) = self.can_cfg();
        self.save_can_cfg(false, &at, &tokens);
        self.ctx.audit("warn", &format!("CAN Bridge uploads turned off: {}", req.who.by));
        self.sync_port();
        Ok(ok(json!({ "enabled": false })))
    }

    fn new_token(&self, req: &Req) -> R {
        confirmed(req)?;
        let body = body_json(req)?;
        let (enabled, at, mut tokens) = self.can_cfg();
        let (token, entry) = self.new_token_entry(&mut tokens, body.get("vehicleId"), body.get("label"))?;
        self.save_can_cfg(enabled, &at, &tokens);
        self.ctx.audit("warn", &format!("CAN Bridge token \"{}\" made: {}", entry["label"].as_str().unwrap_or(""), req.who.by));
        Ok(ok(json!({ "token": token, "id": entry["id"], "fingerprint": self.ctx.cert_fingerprint(), "port": self.ctx.can_port() })))
    }

    fn revoke(&self, req: &Req, id: &str) -> R {
        confirmed(req)?;
        let (enabled, at, tokens) = self.can_cfg();
        let Some(t) = tokens.iter().find(|x| x.get("id").and_then(|i| i.as_str()) == Some(id)).cloned() else { return Err(he(404, "No such token.")) };
        let rest: Vec<Value> = tokens.into_iter().filter(|x| x.get("id").and_then(|i| i.as_str()) != Some(id)).collect();
        self.save_can_cfg(enabled, &at, &rest);
        self.ctx.audit("warn", &format!("CAN Bridge token \"{}\" revoked: {}", t.get("label").map(|l| json::js_str(Some(l))).unwrap_or_default(), req.who.by));
        Ok(ok(json!({ "ok": true })))
    }

    // ---- Live CAN stats for a Stream Deck (now.rs): GET /api/can/now with its own read-only
    // token, made here (admins, the Nerd panel). Off until a link is made.

    /// What the plugin pins (the link's pin=): the local certificate authority while the server's
    /// certificate comes from it, else the server's own certificate; none with a certificate every
    /// computer already trusts (Let's Encrypt) or without HTTPS of its own.
    fn deck_pin(&self) -> Value {
        let Some(st) = self.ctx.tls_status().filter(|s| json::truthy(Some(s))) else { return Value::Null };
        let fp_of = |v: &Value| v.get("fingerprint").filter(|f| json::truthy(Some(f))).map(|f| logs::js_string(f).replace(':', "").to_lowercase());
        let mode = st.get("mode").and_then(|m| m.as_str());
        if mode == Some("acme") && st.get("serving").and_then(|m| m.as_str()) == Some("acme") {
            return Value::Null;
        }
        if mode == Some("own") {
            return st.get("certificate").and_then(fp_of).map_or(Value::Null, |h| Value::String(format!("cert:{}", h)));
        }
        st.get("ca").and_then(fp_of).map_or(Value::Null, |h| Value::String(format!("ca:{}", h)))
    }
    fn deck_admin(req: &Req, what: &str) -> Result<(), HttpError> {
        if req.who.admin_here {
            Ok(())
        } else {
            Err(he(403, format!("Only an admin can {} the Stream Deck {}.", what, if what == "download" { "plugin" } else { "link" })))
        }
    }
    fn deck_get(&self, req: &Req) -> R {
        Self::deck_admin(req, "manage")?;
        let cfg = self.ctx.setting("can-now").unwrap_or(Value::Null);
        let at = cfg.get("at").filter(|a| json::truthy(Some(a))).cloned().unwrap_or(Value::Null);
        Ok(ok(json!({ "enabled": json::truthy(cfg.get("tokenHash")), "at": at, "pin": self.deck_pin(), "stats": super::now::stats_list() })))
    }
    fn deck_make(&self, req: &Req) -> R {
        Self::deck_admin(req, "manage")?;
        let token = util::base64url(&util::random(24));
        self.ctx.set_setting("can-now", json!({ "tokenHash": util::sha256_hex(token.as_bytes()), "at": n(util::now_ms()) }));
        self.now_cache.lock().unwrap().clear();
        self.ctx.audit("warn", &format!("Stream Deck link made (new token; any older link stops working): {}", req.who.by));
        Ok(ok(json!({ "enabled": true, "token": token, "pin": self.deck_pin(), "stats": super::now::stats_list() })))
    }
    fn deck_off(&self, req: &Req) -> R {
        Self::deck_admin(req, "manage")?;
        self.ctx.set_setting("can-now", Value::Null);
        self.now_cache.lock().unwrap().clear();
        self.ctx.audit("warn", &format!("Stream Deck link turned off: {}", req.who.by));
        Ok(ok(json!({ "enabled": false })))
    }
    /// The Stream Deck plugin (assets/streamdeck), zipped as the .streamDeckPlugin file Stream Deck installs.
    fn deck_plugin(&self, req: &Req) -> R {
        Self::deck_admin(req, "download")?;
        let root = self.ctx.app_root().join("assets").join("streamdeck");
        let mut files: Vec<String> = Vec::new();
        let mut todo = vec!["com.sentrysix.canstats.sdPlugin".to_string()];
        let fail = |e: std::io::Error| {
            self.ctx.log("error", &format!("{} {}: {}", req.method, req.path, e));
            he(500, "Internal error")
        };
        while !todo.is_empty() {
            let rel = todo.remove(0);
            let mut list: Vec<(String, bool)> = Vec::new();
            for e in std::fs::read_dir(root.join(&rel)).map_err(fail)? {
                let e = e.map_err(fail)?;
                let dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                list.push((e.file_name().to_string_lossy().into_owned(), dir));
            }
            list.sort();
            for (name, dir) in list {
                if dir {
                    todo.push(format!("{}/{}", rel, name));
                } else {
                    files.push(format!("{}/{}", rel, name));
                }
            }
        }
        files.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let mut entries = Vec::new();
        for name in files {
            let data = std::fs::read(root.join(&name)).map_err(fail)?;
            entries.push(crate::ui::zip::Entry { name, data });
        }
        let zip = crate::ui::zip::write_zip(&entries);
        Ok(Response::builder()
            .status(200)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(header::CONTENT_LENGTH, zip.len())
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::CONTENT_DISPOSITION, attachment("Sentry Six CAN Stats.streamDeckPlugin"))
            .body(Body::from(zip))
            .unwrap())
    }

    /// GET /api/can/now[/<stat>][?token=…&car=…&units=mi|km]: the newest CAN values, or one as
    /// plain text; before core's checks (its own token, no cookies). JSON answers are not gzipped
    /// here (the caller does, as sendJson).
    pub fn now_answer(&self, method: &Method, raw_path: &str, raw_query: Option<&str>, authorization: Option<&str>) -> Res {
        let mut res = self.now_inner(method, raw_path, raw_query, authorization);
        // read by the Stream Deck plugin from its own origin: allowed, as only the token lets it in (no cookies)
        res.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
        res
    }
    fn now_inner(&self, method: &Method, raw_path: &str, raw_query: Option<&str>, authorization: Option<&str>) -> Res {
        let err = |status: u16, msg: &str| json_res(status, &json!({ "error": msg }));
        let text = |status: u16, body: String| {
            Response::builder().status(status).header(header::CONTENT_TYPE, "text/plain; charset=utf-8").header(header::CACHE_CONTROL, "no-store").body(Body::from(body)).unwrap()
        };
        let cfg = self.ctx.setting("can-now").unwrap_or(Value::Null);
        if !json::truthy(cfg.get("tokenHash")) {
            return err(404, "Not found");
        }
        if *method != Method::GET && *method != Method::HEAD {
            return err(405, "GET only");
        }
        // the local certificate authority's certificate (public, no token): the plugin fetches it
        // once and keeps it only when its fingerprint is the link's pin
        if raw_path == "/api/can/now/ca.crt" {
            let Some(pem) = self.ctx.ca_pem().filter(|p| !p.is_empty()) else { return err(404, "No local certificate authority.") };
            return Response::builder().status(200).header(header::CONTENT_TYPE, "application/x-x509-ca-cert").header(header::CACHE_CONTROL, "no-store").body(Body::from(pem)).unwrap();
        }
        let param = |k: &str| -> Option<String> {
            raw_query?.split('&').filter(|p| !p.is_empty()).find_map(|p| {
                let (a, b) = p.split_once('=').unwrap_or((p, ""));
                (crate::api::decode(a, true).as_deref() == Some(k)).then(|| crate::api::decode(b, true).unwrap_or_default())
            })
        };
        let bearer = strip_bearer(authorization.unwrap_or(""));
        let given = if bearer.is_empty() { param("token").unwrap_or_default() } else { bearer };
        let want_hash = match cfg.get("tokenHash") {
            Some(Value::String(h)) => h.clone(),
            _ => return err(500, "Internal error"),
        };
        let hash = util::sha256_hex(given.as_bytes());
        if !given.is_empty() && hash.len() != want_hash.len() {
            // (crypto.timingSafeEqual throws on buffers of different lengths)
            return err(500, "Internal error");
        }
        if given.is_empty() || !same_bytes(hash.as_bytes(), want_hash.as_bytes()) {
            return text(401, "Token required (Nerd panel → Stream Deck)".into());
        }
        let km = param("units").as_deref() == Some("km");
        let units = if km { "km" } else { "mi" };
        // which car: its vehicle's id or name, or a CAN key; else the one with the newest data
        let want = param("car").unwrap_or_default().trim_matches(super::now::js_space).to_lowercase();
        let mut keys = util::subdirs(&can_index_dir(&*self.ctx));
        if !want.is_empty() {
            keys.retain(|k| {
                if k.to_lowercase() == want {
                    return true;
                }
                let car = self.car_of_key(k);
                [car.as_ref().map(|c| c.id.clone()), car.as_ref().map(|c| c.name.clone())].iter().any(|x| x.clone().unwrap_or_default().to_lowercase() == want)
            });
        }
        let id = format!("{}|{}", keys.join(","), units);
        let hit = self.now_cache.lock().unwrap().get(&id).cloned();
        let hit = match hit {
            Some(h) if util::now_ms() - h.0 <= NOW_TTL_MS => h,
            _ => {
                let mut best: Option<super::now::Latest> = None;
                for key in &keys {
                    if let Some(got) = super::now::latest_stats(&*self.index, key, km, util::now_ms()) {
                        if best.as_ref().is_none_or(|b| got.at > b.at) {
                            best = Some(got);
                        }
                    }
                }
                let answer = best.map(|b| {
                    let car = self.car_of_key(&b.key).map(|c| c.name).filter(|nm| !nm.is_empty());
                    let mut stats = Map::new();
                    for s in &b.stats {
                        stats.insert(s.id.to_string(), json!({ "label": s.label, "value": s.value.clone(), "unit": s.unit.clone(), "text": s.text.clone() }));
                    }
                    json!({ "car": car, "at": tz::iso(b.at as i64), "ageSec": n(b.age_sec), "stale": b.stale, "units": units, "stats": stats })
                });
                let h = (util::now_ms(), answer);
                let mut cache = self.now_cache.lock().unwrap();
                cache.insert(id, h.clone());
                while cache.len() > 16 {
                    cache.shift_remove_index(0);
                }
                h
            }
        };
        let tail = raw_path["/api/can/now".len()..].strip_prefix('/').unwrap_or(&raw_path["/api/can/now".len()..]);
        let tail = tail.strip_suffix(".txt").unwrap_or(tail);
        let Some(stat) = crate::api::decode(tail, false) else {
            self.ctx.log("error", &format!("{} {}: URIError: URI malformed", method, raw_path));
            return err(500, "Internal error");
        };
        let stat = if stat.is_empty() { param("stat").unwrap_or_default() } else { stat };
        if !stat.is_empty() {
            let ids = super::now::stat_ids();
            if !ids.contains(&stat.as_str()) {
                return err(404, &format!("No stat \"{}\". Stats: {}", util::utf16_slice(&stat, 40), ids.join(", ")));
            }
            // plain text for a Stream Deck key: the value with its unit, "—" without one
            let t = hit.1.as_ref().and_then(|a| a["stats"].get(&stat)).and_then(|s| s.get("text")).and_then(|t| t.as_str()).map(String::from);
            return text(200, t.unwrap_or_else(|| "—".into()));
        }
        match hit.1 {
            None => json_res(200, &json!({ "car": null, "at": null, "stale": true, "units": units, "stats": {} })),
            Some(a) => json_res(200, &a),
        }
    }

    fn pairing(self: &Arc<Self>, req: &Req, key: &str, what: &str) -> R {
        if !matches!(what, "trust" | "forget" | "could-not-sign") {
            return Err(he(404, "Not found"));
        }
        confirmed(req)?;
        if !logs::valid_key(key) {
            return Err(he(400, "Not a car key."));
        }
        let body = body_json(req)?;
        match what {
            "trust" => {
                let fp = body.get("fingerprint").filter(|f| json::truthy(Some(f))).map(|f| logs::js_string(f)).unwrap_or_default();
                let out = self.trust.trust_key(key, &fp).map_err(|(s, m)| he(s, m))?;
                self.ctx.audit("warn", &format!("CAN Bridge {}: key {} trusted: {}", key, out["pin"]["fingerprint"].as_str().unwrap_or("undefined"), req.who.by));
                self.ctx.announce("can");
                self.index.kick();
                Ok(ok(out))
            }
            "forget" => {
                let out = self.trust.forget_pin(key);
                self.ctx.audit("warn", &format!("CAN Bridge {}: pairing forgotten: {}", key, req.who.by));
                self.ctx.announce("can");
                Ok(ok(out))
            }
            _ => {
                let Some(on) = body.get("use").and_then(|u| u.as_bool()) else { return Err(he(400, "Send { \"use\": true | false }.")) };
                let names = self.trust.set_override_could_not_sign(key, on);
                self.ctx.audit(
                    "warn",
                    &format!(
                        "CAN Bridge {}: {} log{} the bridge could not sign {}{}: {}",
                        key,
                        names.len(),
                        if names.len() == 1 { "" } else { "s" },
                        if on { "used anyway" } else { "no longer used" },
                        if names.is_empty() { String::new() } else { format!(" ({}{})", names[0], if names.len() > 1 { format!(" to {}", names[names.len() - 1]) } else { String::new() }) },
                        req.who.by
                    ),
                );
                if !on {
                    for nm in &names {
                        self.drop_log(key, nm);
                    }
                }
                self.index.kick();
                self.ctx.announce("can");
                Ok(ok(json!({ "changed": names.len(), "names": names, "summary": self.trust.summary(key) })))
            }
        }
    }

    fn use_file(self: &Arc<Self>, req: &Req, name: &str) -> R {
        confirmed(req)?;
        let body = body_json(req)?;
        let nm = parse_name(name).filter(|x| !x.sidecar).ok_or_else(|| he(400, "Not a CAN log name."))?;
        let on = body.get("use") == Some(&Value::Bool(true));
        self.trust.set_override(&nm.vehicle_key, name, on).map_err(|(s, m)| he(s, m))?;
        self.ctx.audit("warn", &format!("CAN log {} {}: {}", name, if on { "used despite failing its check" } else { "no longer used" }, req.who.by));
        if !on {
            self.drop_log(&nm.vehicle_key, name);
        }
        self.index.kick();
        self.ctx.announce("can");
        Ok(ok(json!({ "ok": true })))
    }

    fn files(&self, req: &Req) -> Value {
        let lim = q(req, "limit").map(json::str_number).filter(|x| *x != 0.0 && !x.is_nan()).unwrap_or(200.0);
        let mut out = self.logs.list(lim);
        let mut pairs: HashMap<String, Option<HashMap<String, &'static str>>> = HashMap::new();
        if let Some(Value::Array(list)) = out.get_mut("logs") {
            for l in list.iter_mut() {
                let key = l["vehicleKey"].as_str().unwrap_or("").to_string();
                let name = l["name"].as_str().unwrap_or("").to_string();
                let check = match self.trust.record(&key, &name) {
                    Some(r) => json!({
                        "status": r.get("status"), "kind": r.get("kind").filter(|v| json::truthy(Some(v))), "reason": r.get("reason").filter(|v| json::truthy(Some(v))),
                        "index": r.get("index"), "override": json::truthy(r.get("override")), "chainNote": r.get("chainNote").filter(|v| json::truthy(Some(v)))
                    }),
                    None => json!({ "status": "waiting", "reason": null }),
                };
                l["check"] = check;
                if !pairs.contains_key(&key) {
                    pairs.insert(key.clone(), self.prune.pairing(&key));
                }
                l["footage"] = pairs[&key].as_ref().and_then(|p| p.get(&name)).map(|x| json!(x)).unwrap_or(Value::Null);
            }
        }
        out
    }

    fn delete_file(self: &Arc<Self>, req: &Req, name: &str) -> R {
        confirmed(req)?;
        self.logs.remove(name).map_err(|e| he(e.status, e.message))?;
        if let Some(nm) = parse_name(name) {
            self.drop_log(&nm.vehicle_key, name);
            self.trust.deleted(&nm.vehicle_key, name);
        }
        self.ctx.audit("info", &format!("CAN log deleted: {}: {}", name, req.who.by));
        self.ctx.announce("can");
        Ok(ok(json!({ "ok": true })))
    }

    // ---- downloads
    /// canFileOf: a finished CAN file of the data folder, only by a name canLogs accepts, never a link.
    fn can_file_of(&self, name: &str) -> Option<(PathBuf, u64, f64, logs::Name)> {
        let nm = parse_name(name)?;
        let dir = self.ctx.data_dir().join("can").join(&nm.vehicle_key);
        let file = dir.join(name);
        if file.parent() != Some(dir.as_path()) {
            return None;
        }
        let st = std::fs::symlink_metadata(&file).ok()?;
        st.is_file().then(|| (file, st.len(), util::mtime_ms(&st), nm))
    }

    fn download(&self, req: &Req, name: &str) -> R {
        let Some((file, size, _, nm)) = self.can_file_of(name) else {
            return Err(if parse_name(name).is_some() { he(404, "No such CAN file.") } else { he(400, "That is not a CAN Bridge log name.") });
        };
        self.ctx.audit("info", &format!("CAN file downloaded: {}: {}", name, req.who.by));
        let (mut w, body) = streamed(Duration::from_secs(600));
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            let Ok(mut f) = std::fs::File::open(&file) else { return };
            let mut buf = vec![0u8; 256 * 1024];
            let mut left = size;
            while left > 0 {
                let Ok(k) = f.read(&mut buf) else { return };
                if k == 0 {
                    return;
                }
                let k = (k as u64).min(left) as usize;
                if w.write_all(&buf[..k]).is_err() {
                    return;
                }
                left -= k as u64;
            }
            let _ = w.flush();
        });
        Ok(Response::builder()
            .status(200)
            .header(header::CONTENT_TYPE, if nm.sidecar { "application/json" } else { "application/x-xz" })
            .header(header::CONTENT_LENGTH, size)
            .header(header::CACHE_CONTROL, "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .header(header::CONTENT_DISPOSITION, attachment(name))
            .body(body)
            .unwrap())
    }

    /// canCandumpText: a log's candump text to a sink; what goes wrong after the text started ends it with a # line.
    fn candump_text(file: &Path, opts: &reader::Opts, max_bytes: Option<u64>, put: &mut dyn FnMut(&[u8]) -> std::io::Result<()>, first: Option<Vec<u8>>, skip_first: bool) -> std::io::Result<()> {
        let mut sent = 0u64;
        let mut found = reader::Found::default();
        let mut err: Option<std::io::Error> = None;
        let mut cut = false;
        let mut seen_first = !skip_first;
        let _ = first;
        let mut on_chunk = |c: &[u8]| -> bool {
            if !seen_first {
                seen_first = true;
            }
            if let Some(max) = max_bytes {
                if sent + c.len() as u64 > max {
                    let room = max - sent;
                    let at = if room > 0 { c[..room as usize].iter().rposition(|&b| b == b'\n').map_or(0, |p| p + 1) } else { 0 };
                    if at > 0 {
                        if let Err(e) = put(&c[..at]) {
                            err = Some(e);
                            return false;
                        }
                    }
                    let note = format!("\n# Sentry Six Manager: cut here: this bundle holds at most {} bytes of this log's candump text; download the log alone (\"candump .log\") for all of it\n", max);
                    if let Err(e) = put(note.as_bytes()) {
                        err = Some(e);
                    }
                    cut = true;
                    return false;
                }
            }
            sent += c.len() as u64;
            if let Err(e) = put(c) {
                err = Some(e);
                return false;
            }
            true
        };
        let r = reader::read_chunks(file, opts, &mut found, &mut on_chunk);
        if let Some(e) = err {
            return Err(e);
        }
        if cut {
            return Ok(());
        }
        match r {
            Ok(()) => {
                if let Some(t) = found.truncated {
                    put(format!("\n# Sentry Six Manager: this log ends early: {}\n", t.replace(['\r', '\n'], " ")).as_bytes())?;
                }
            }
            Err(e) if e.retry => return Err(std::io::Error::other(e.message)),
            Err(e) => put(format!("\n# Sentry Six Manager: could not read this log as candump text: {}\n", e.message.replace(['\r', '\n'], " ")).as_bytes())?,
        }
        Ok(())
    }

    fn candump(&self, req: &Req, name: &str) -> R {
        let nm = parse_name(name).filter(|x| !x.sidecar).ok_or_else(|| he(400, "That is not a CAN Bridge log name."))?;
        let _ = nm;
        let (file, ..) = self.can_file_of(name).ok_or_else(|| he(404, "No such CAN file."))?;
        let opts = reader::Opts { download: true, slot_wait: Some(Duration::from_secs(30)), ..Default::default() };
        // the first text before the answer: a log that cannot be read at all is an error
        let (tx, rx) = std::sync::mpsc::channel::<Result<(Option<Vec<u8>>, Option<String>), reader::LogError>>();
        let (mut w, body) = streamed(CAN_STALL);
        let f2 = file.clone();
        std::thread::spawn(move || {
            use std::io::Write;
            let mut found = reader::Found::default();
            let mut first_sent = false;
            let mut failed: Option<std::io::Error> = None;
            let mut tx = Some(tx);
            let r = reader::read_chunks(&f2, &opts, &mut found, |c| {
                if !first_sent {
                    first_sent = true;
                    if let Some(t) = tx.take() {
                        let _ = t.send(Ok((Some(c.to_vec()), None)));
                    }
                    return w.write_all(c).is_ok();
                }
                if let Err(e) = w.write_all(c) {
                    failed = Some(e);
                    return false;
                }
                true
            });
            match r {
                Err(e) => {
                    if let Some(t) = tx.take() {
                        let _ = t.send(Err(e));
                    } else if !e.retry {
                        let _ = w.write_all(format!("\n# Sentry Six Manager: could not read this log as candump text: {}\n", e.message.replace(['\r', '\n'], " ")).as_bytes());
                    }
                }
                Ok(()) => {
                    if let Some(t) = tx.take() {
                        let _ = t.send(Ok((None, found.truncated.clone())));
                        if found.truncated.is_some() {
                            return;
                        }
                    } else if failed.is_none() {
                        if let Some(t) = found.truncated {
                            let _ = w.write_all(format!("\n# Sentry Six Manager: this log ends early: {}\n", t.replace(['\r', '\n'], " ")).as_bytes());
                        }
                    }
                }
            }
            let _ = w.flush();
        });
        match rx.recv() {
            Ok(Err(e)) => {
                return Err(he(
                    if e.retry { 503 } else { 422 },
                    if e.busy {
                        "Another CAN log is being turned into candump text; try again in a minute.".to_string()
                    } else if e.retry {
                        "The log cannot be read just now; try again.".to_string()
                    } else {
                        format!("This log cannot be turned into candump text: {}", e.message)
                    },
                ))
            }
            Ok(Ok((None, Some(t)))) => return Err(he(422, format!("This log cannot be turned into candump text: xz could not read it: {}", t))),
            _ => {}
        }
        self.ctx.audit("info", &format!("CAN file downloaded as candump text: {}: {}", name, req.who.by));
        Ok(Response::builder()
            .status(200)
            .header(header::CONTENT_TYPE, "text/plain; charset=us-ascii")
            .header(header::CACHE_CONTROL, "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .header(header::CONTENT_DISPOSITION, attachment(name.strip_suffix(".xz").unwrap_or(name)))
            .body(body)
            .unwrap())
    }

    fn key_or_400(k: Option<&str>) -> Result<String, HttpError> {
        let key = k.unwrap_or("").to_string();
        if !logs::valid_key(&key) {
            return Err(he(400, "Give a CAN Bridge car key."));
        }
        Ok(key)
    }
    fn zone_of_key(&self, key: &str) -> String {
        self.car_of_key(key).map(|v| v.timezone).filter(|z| !z.is_empty()).unwrap_or_else(|| "UTC".into())
    }
    /// canRange: from/to of a query, both needed, in order, at most max_ms apart.
    fn range(&self, key: &str, req: &Req, max_ms: f64, what: &str) -> Result<(f64, f64), HttpError> {
        let zone = self.zone_of_key(key);
        let to_utc = |y, mo, d, h, mi, s| tz::zoned_to_utc(y, mo, d, h, mi, s, &zone) as f64;
        let from = search::parse_when(q(req, "from"), &to_utc, false).map_err(|e| he(400, e.message))?;
        let to = search::parse_when(q(req, "to"), &to_utc, true).map_err(|e| he(400, e.message))?;
        let (Some(from), Some(to)) = (from, to) else { return Err(he(400, "Give a start and an end (from, to).")) };
        if to < from {
            return Err(he(400, "The end is before the start."));
        }
        if to - from > max_ms {
            let span = if max_ms >= 86_400_000.0 { format!("{} days", json::num_str(json::round(max_ms / 86_400_000.0))) } else { format!("{} hours", json::num_str(json::round(max_ms / 3_600_000.0))) };
            return Err(he(400, format!("{} can cover at most {}.", what, span)));
        }
        Ok((from, to))
    }

    fn candump_estimate(file: &Path, size: u64, format: Option<&str>) -> u64 {
        let side = util::read_json(Path::new(&format!("{}.json", file.display())));
        if let Some(fr) = side.as_ref().and_then(|s| s.get("frames")).and_then(json::safe_int).filter(|x| *x >= 0) {
            return fr as u64 * 64 + 64 * 1024;
        }
        let fmt = side.as_ref().and_then(|s| s.get("format")).and_then(|f| f.as_str()).or(format);
        size * if fmt == Some(reader::FORMAT_COLUMNS) { 40 } else { 16 } + 64 * 1024
    }

    fn bundle(&self, req: &Req) -> R {
        let key = Self::key_or_400(q(req, "key"))?;
        let (from, to) = self.range(&key, req, f64::INFINITY, "A bundle")?;
        let dir = self.ctx.data_dir().join("can").join(&key);
        let mut logs: Vec<(String, logs::Name)> = util::names(&dir).unwrap_or_default().into_iter().filter_map(|nm| parse_name(&nm).filter(|x| !x.sidecar && x.vehicle_key == key).map(|x| (nm, x))).collect();
        logs.sort_by(|a, b| a.1.started_at.cmp(&b.1.started_at).then(a.1.seq.cmp(&b.1.seq)));
        let inside: Vec<&(String, logs::Name)> = logs.iter().filter(|x| x.1.started_at as f64 >= from && ((x.1.started_at as f64) < to || x.1.started_at as f64 == from)).collect();
        let before = logs.iter().filter(|x| (x.1.started_at as f64) < from && x.1.started_at as f64 >= from - 30.0 * 60_000.0).next_back();
        let mut picked: Vec<&(String, logs::Name)> = Vec::new();
        if let Some(b) = before {
            picked.push(b);
        }
        picked.extend(inside);
        if picked.is_empty() {
            return Err(he(404, "No logs of this car key in that time."));
        }
        let with_text = matches!(q(req, "candump"), Some("1") | Some("true"));
        let mut entries: Vec<zip::Entry> = Vec::new();
        let mut manifest = Vec::new();
        let (mut total, mut text_bytes) = (0u64, 0u64);
        let mut files = 0usize;
        for (nm, n_) in &picked {
            let mut format: Option<Value> = None;
            for name in [nm.clone(), format!("{}.json", nm)] {
                let Some((file, size, mtime, f)) = self.can_file_of(&name) else { continue };
                total += size + 200;
                files += 1;
                if f.sidecar {
                    if let Some(v) = util::read_json(&file) {
                        format = Some(v.get("format").cloned().unwrap_or(Value::Null));
                    }
                }
                entries.push(zip::Entry { name: format!("{}/{}", key, name), mtime: Some(mtime), source: zip::Source::Sized(size, Box::new(LazyFile(file, None))) });
            }
            let log = self.can_file_of(nm);
            if let (true, Some((file, size, mtime, _))) = (with_text, &log) {
                let fmt = format.as_ref().and_then(|f| f.as_str());
                let most = Self::candump_estimate(file, *size, fmt);
                text_bytes += most + 400;
                files += 1;
                let f = file.clone();
                entries.push(zip::Entry {
                    name: format!("{}/{}", key, nm.strip_suffix(".xz").unwrap_or(nm)),
                    mtime: Some(*mtime),
                    source: zip::Source::Stream(Some(most + 400), Box::new(move |put| Self::candump_text(&f, &reader::Opts { download: true, ..Default::default() }, Some(most), put, None, false))),
                });
            }
            let rec = self.trust.record(&key, nm);
            let mut m = Map::new();
            m.insert("name".into(), json!(nm));
            m.insert("startedAt".into(), json!(iso_of(n_.started_at as f64)));
            m.insert("bytes".into(), log.as_ref().map(|l| json!(l.1)).unwrap_or(Value::Null));
            m.insert("sidecar".into(), json!(self.can_file_of(&format!("{}.json", nm)).is_some()));
            m.insert("format".into(), format.as_ref().and_then(|f| f.as_str()).map(|s| json!(util::utf16_slice(s, 64))).unwrap_or(Value::Null));
            m.insert("check".into(), rec.as_ref().and_then(|r| r.get("status")).filter(|s| json::truthy(Some(s))).cloned().unwrap_or(json!("waiting")));
            if let Some(reason) = rec.as_ref().and_then(|r| r.get("reason")).filter(|s| json::truthy(Some(s))) {
                m.insert("reason".into(), reason.clone());
            }
            manifest.push(Value::Object(m));
        }
        if q(req, "check").is_some_and(|c| !c.is_empty()) {
            let mut o = Map::new();
            o.insert("logs".into(), json!(picked.len()));
            o.insert("files".into(), json!(files));
            o.insert("bytes".into(), json!(total));
            if with_text {
                o.insert("candumpBytes".into(), json!(text_bytes));
            }
            o.insert("from".into(), n(from));
            o.insert("to".into(), n(to));
            return Ok(ok(Value::Object(o)));
        }
        let stamp = |ms: f64| iso_of(ms)[..16].chars().filter(|c| *c != '-' && *c != ':').collect::<String>();
        let file = format!("can-{}-{}-to-{}.zip", key, stamp(from), stamp(to));
        self.ctx.audit("info", &format!("CAN bundle downloaded: {} {} to {} ({} logs): {}", key, iso_of(from), iso_of(to), picked.len(), req.who.by));
        let ids: Arc<Mutex<Option<Vec<index::IdSum>>>> = Arc::new(Mutex::new(None));
        let ix = self.index.clone();
        let k2 = key.clone();
        let ids_of = {
            let ids = ids.clone();
            move || -> Vec<index::IdSum> {
                let mut g = ids.lock().unwrap();
                if g.is_none() {
                    *g = Some(ix.id_summary(&k2, from, to, &|| false));
                }
                g.clone().unwrap()
            }
        };
        let ids_csv = {
            let f = ids_of.clone();
            move || {
                let list = f();
                let mut out = csv_line(&["bus", "id_hex", "message", "unknown", "frames", "hz", "first_seen_utc", "last_seen_utc", "minutes_seen"].map(s));
                for e in list {
                    out.push_str(&csv_line(&[
                        s(&e.bus),
                        s(&format!("0x{}", e.id)),
                        s(e.name.as_deref().unwrap_or("unknown")),
                        s(if e.name.is_some() { "" } else { "UNKNOWN" }),
                        CellV::N(e.frames),
                        CellV::N(e.hz),
                        s(&iso_of(e.first_seen)),
                        s(&iso_of(e.last_seen)),
                        CellV::N(e.minutes as f64),
                    ]));
                }
                out.into_bytes()
            }
        };
        let k3 = key.clone();
        let manifest_json = move || {
            let list = ids_of();
            let v = json!({
                "vehicleKey": k3, "from": iso_of(from), "to": iso_of(to), "madeAt": iso_of(util::now_ms()), "logs": manifest,
                "ids": { "count": list.len(), "unknown": list.iter().filter(|e| e.name.is_none()).count() },
                "note": format!("The .log.xz files are exactly as the CAN Bridge uploaded them and signed them (xz; \"format\" says which: canbridge-candump-xz/1 is candump text, canbridge-columns-xz/2 the same lines as columns, which only Sentry Six Manager and the CAN Bridge's tools/columns-to-candump.js read).{} ids.csv is every CAN id seen in the range, from the index (frames per minute); \"unknown\" ones are not in the DBC set this server decodes the car with (its model's: model3dbc with opendbc's and the firmware overrides for a Model 3/Y, docs/can-bridge-api.md).", if with_text { " Each .log beside it is that log as candump text, made from it for this download (not signed: check the .log.xz)." } else { "" })
            });
            format!("{}\n", json::pretty(&v)).into_bytes()
        };
        entries.push(zip::Entry { name: "ids.csv".into(), mtime: Some(util::now_ms()), source: zip::Source::Make(Box::new(ids_csv)) });
        entries.push(zip::Entry { name: "manifest.json".into(), mtime: Some(util::now_ms()), source: zip::Source::Make(Box::new(manifest_json)) });
        let (w, body) = streamed(if with_text { CAN_STALL } else { Duration::from_secs(600) });
        let c = self.ctx.clone();
        std::thread::spawn(move || {
            if let Err(e) = zip::stream_zip(w, entries) {
                c.log("warn", &format!("CAN bundle {}: {}", file, e));
            }
        });
        let fname = format!("can-{}-{}-to-{}.zip", key, stamp(from), stamp(to));
        Ok(Response::builder()
            .status(200)
            .header(header::CONTENT_TYPE, "application/zip")
            .header(header::CACHE_CONTROL, "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .header(header::CONTENT_DISPOSITION, attachment(&fname))
            .body(body)
            .unwrap())
    }

    fn decoded(&self, req: &Req) -> R {
        let key = Self::key_or_400(q(req, "key"))?;
        let (from, to) = self.range(&key, req, CAN_DECODED_HOURS * 3_600_000.0, "A decoded export")?;
        let only: Option<Vec<String>> = q(req, "signals").filter(|s| !s.is_empty()).map(|s| {
            let mut v: Vec<String> = Vec::new();
            for x in s.split(',').map(|x| x.trim()).filter(|x| (!x.is_empty() && x.len() <= 80 && x.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')) || calc::is_calc(x)) {
                if !v.iter().any(|y| y == x) {
                    v.push(x.to_string());
                }
            }
            v.truncate(200);
            v
        });
        let every = q(req, "mode") == Some("every") || (only.is_some() && q(req, "mode") != Some("changes"));
        let meta = self.index.signals(std::slice::from_ref(&key));
        let only_set: Option<HashSet<String>> = only.as_ref().map(|v| v.iter().cloned().collect());
        let make_plan = || {
            let o = only_set.clone();
            match o {
                Some(set) => calc::plan(Some(&move |id: &str| set.contains(id))),
                None => calc::plan(None),
            }
        };
        if q(req, "check").is_some_and(|c| !c.is_empty()) {
            let times = self.index.minute_times(&key, from, to);
            let mut picks: Vec<f64> = Vec::new();
            for f in [0.0, 0.5, 1.0] {
                if times.is_empty() {
                    break;
                }
                let t = times[(times.len() - 1).min((f * (times.len() - 1) as f64).floor() as usize)];
                if !picks.contains(&t) {
                    picks.push(t);
                }
            }
            let mut rows = 0usize;
            for &t in &picks {
                if let Some(d) = self.index.read_minute(&key, &index::minute_key(t), false).as_ref() {
                    let mut plan = make_plan();
                    rows += decoded_rows(d, t, f64::NEG_INFINITY, f64::INFINITY, only_set.as_ref(), every, &mut HashMap::new(), plan.as_mut()).len();
                }
            }
            let est = if picks.is_empty() { 0.0 } else { json::round(rows as f64 / picks.len() as f64 * times.len() as f64) };
            let signals = match &only {
                Some(v) => v.iter().filter(|x| meta.contains_key(*x) || calc::is_calc(x)).count(),
                None => meta.len() + calc::point_count(),
            };
            return Ok(ok(json!({ "ok": true, "from": n(from), "to": n(to), "signals": signals, "mode": if every { "every" } else { "changes" }, "minutes": times.len(), "estimatedRows": n(est), "rowLimit": CAN_DECODED_ROWS, "willStop": est > CAN_DECODED_ROWS as f64 })));
        }
        let stamp = |ms: f64| iso_of(ms)[..16].chars().filter(|c| *c != '-' && *c != ':').collect::<String>();
        let file = format!("can-{}-decoded-{}-to-{}.csv", key, stamp(from), stamp(to));
        let gz = req.headers.get(header::ACCEPT_ENCODING).and_then(|h| h.to_str().ok()).is_some_and(|h| h.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| w == "gzip"));
        self.ctx.audit("info", &format!("CAN decoded export: {} {} to {}: {}", key, iso_of(from), iso_of(to), req.who.by));
        let (w, body) = streamed(Duration::from_secs(600));
        let ix = self.index.clone();
        let mut plan = make_plan();
        std::thread::spawn(move || {
            use std::io::Write;
            let mut out: Box<dyn Write> = if gz { Box::new(flate2::write::GzEncoder::new(w, flate2::Compression::new(4))) } else { Box::new(w) };
            let r = (|| -> std::io::Result<()> {
                out.write_all(csv_line(&["timestamp_utc", "signal", "value", "unit", "value_name"].map(s)).as_bytes())?;
                let mut rows = 0usize;
                let mut last: HashMap<String, (f64, f64)> = HashMap::new();
                'outer: for t in ix.minute_times(&key, from, to) {
                    let Some(d) = ix.read_minute(&key, &index::minute_key(t), false).as_ref().clone() else { continue };
                    let mut chunk = String::new();
                    for (at, name, v) in decoded_rows(&d, t, from, to, only_set.as_ref(), every, &mut last, plan.as_mut()) {
                        if rows >= CAN_DECODED_ROWS {
                            chunk.push_str(&format!("# stopped at {} rows: export a shorter time, or fewer signals\n", CAN_DECODED_ROWS));
                            out.write_all(chunk.as_bytes())?;
                            break 'outer;
                        }
                        let (unit, vname) = if calc::is_calc(&name) {
                            (calc::calc_unit(&name).to_string(), CellV::E)
                        } else {
                            let m = meta.get(&name);
                            let unit = m.and_then(|m| m.get("unit")).filter(|u| json::truthy(Some(u))).map(|u| logs::js_string(u)).unwrap_or_default();
                            let vn = match &v {
                                calc::V::Num(x) => m.and_then(|m| m.get("values")).and_then(|vs| vs.get(json::num_str(*x))).map(|x| CellV::S(logs::js_string(x))).unwrap_or(CellV::E),
                                calc::V::Str(_) => CellV::E,
                            };
                            (unit, vn)
                        };
                        let val = match &v {
                            calc::V::Num(x) => CellV::N(*x),
                            calc::V::Str(t) => CellV::S(t.clone()),
                        };
                        chunk.push_str(&csv_line(&[s(&iso_of(at)), s(&name), val, s(&unit), vname]));
                        rows += 1;
                    }
                    if !chunk.is_empty() {
                        out.write_all(chunk.as_bytes())?;
                    }
                }
                out.flush()
            })();
            let _ = r;
            drop(out);
        });
        let mut b = Response::builder()
            .status(200)
            .header(header::CONTENT_TYPE, "text/csv; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .header(header::CONTENT_DISPOSITION, attachment(&file));
        if gz {
            b = b.header(header::CONTENT_ENCODING, "gzip");
        }
        Ok(b.header(header::VARY, "Accept-Encoding").body(body).unwrap())
    }

    fn new_ids(&self, req: &Req) -> R {
        let key = Self::key_or_400(q(req, "key"))?;
        let zone = self.zone_of_key(&key);
        let to_utc = |y, mo, d, h, mi, s| tz::zoned_to_utc(y, mo, d, h, mi, s, &zone) as f64;
        let since = search::parse_when(q(req, "since"), &to_utc, false).map_err(|e| he(400, e.message))?.ok_or_else(|| he(400, "Give the date to look from (since)."))?;
        let closed = req.closed.clone();
        let out = self.index.new_ids(&key, since, 1000, &move || closed.load(Ordering::SeqCst)).map_err(|(s, m)| he(s, m))?;
        let profile = self.index.profile_for(&key);
        let rows: Vec<Value> = out["appeared"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| {
                let id = x["id"].as_str().unwrap_or("");
                let (bus, hex) = id.split_once(':').unwrap_or((id, ""));
                let name = self.index.message_name(id, None, &[], &profile);
                let at = x["at"].as_f64().unwrap_or(f64::NAN);
                json!({ "key": id, "bus": bus, "id": hex, "name": name, "unknown": name.is_none(), "firstSeen": x["at"], "lastSeen": x["lastSeen"], "minutesSeen": x["seenMinutes"], "localTime": search::local_time(at, &zone) })
            })
            .collect();
        if q(req, "format") != Some("csv") {
            return Ok(ok(json!({ "key": key, "since": n(since), "timezone": zone, "ids": rows, "count": out["appearedCount"], "idCount": out["idCount"], "complete": out["complete"], "scannedMinutes": out["scannedMinutes"], "totalMinutes": out["totalMinutes"] })));
        }
        let day: String = q(req, "since").unwrap_or("").chars().take(10).filter(|c| c.is_ascii_digit() || *c == '-').collect();
        let mut text = csv_line(&["bus", "id_hex", "message", "unknown", "first_seen_utc", "last_seen_utc", "minutes_seen"].map(s));
        for x in &rows {
            let name = x["name"].as_str();
            text.push_str(&csv_line(&[
                s(x["bus"].as_str().unwrap_or("")),
                s(&format!("0x{}", x["id"].as_str().unwrap_or(""))),
                s(name.unwrap_or("unknown")),
                s(if name.is_none() { "UNKNOWN" } else { "" }),
                s(&iso_of(x["firstSeen"].as_f64().unwrap_or(f64::NAN))),
                s(&iso_of(x["lastSeen"].as_f64().unwrap_or(f64::NAN))),
                CellV::N(x["minutesSeen"].as_f64().unwrap_or(f64::NAN)),
            ]));
        }
        let count = out["appearedCount"].as_u64().unwrap_or(0) as usize;
        if count > rows.len() {
            text.push_str(&format!("# the first {} of {}\n", rows.len(), count));
        }
        Ok(Response::builder()
            .status(200)
            .header(header::CONTENT_TYPE, "text/csv; charset=utf-8")
            .header(header::CACHE_CONTROL, "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .header(header::CONTENT_DISPOSITION, attachment(&format!("can-{}-new-ids-since-{}.csv", key, day)))
            .body(Body::from(text))
            .unwrap())
    }

    // ---- Sentry USB
    fn sentryusb(&self) -> Value {
        let mut out = Vec::new();
        for v in self.ctx.vehicles() {
            self.usb.fresh(&v.id);
            if let Some(d) = self.usb.device(&v.id) {
                out.push(json!({ "vehicle": { "id": v.id, "name": v.name }, "error": d["error"], "info": d["info"], "readAt": d["readAt"] }));
            }
        }
        json!({ "devices": out, "now": n(util::now_ms()) })
    }

    fn usb_view(&self, v: &Car, req: &Req) -> Value {
        let mut view = self.usb.api(&v.id);
        let mut record = self.ctx.sentry_usb_record_view(&v.id);
        if let Value::Object(m) = &mut record {
            m.insert("canBackfill".into(), json!(req.who.admin_here));
        }
        if let Value::Object(m) = &mut view {
            m.insert("record".into(), record);
        }
        // missed snapshots that count: the ones that cost footage
        if let Some(missed) = view.get("snapshots").and_then(|s| s.get("missed")).and_then(|m| m.as_array()).cloned() {
            let costly: HashSet<i64> = self.ctx.costly_snapshot_starts(&v.id).into_iter().map(|x| x as i64).collect();
            let kept: Vec<Value> = missed.iter().filter(|g| g.get("from").and_then(|f| f.as_f64()).is_some_and(|f| costly.contains(&(f as i64)))).cloned().collect();
            let idle = missed.len() - kept.len();
            let snaps = view["snapshots"].as_object_mut().unwrap();
            snaps.insert("missed".into(), Value::Array(kept));
            snaps.insert("missedIdle".into(), json!(idle));
        }
        view
    }

    fn sentry_usb_view(&self, req: &Req, id: &str) -> R {
        let v = self.vehicle_or_404(id)?;
        self.usb.fresh(&v.id);
        let mut view = self.usb_view(&v, req);
        if view.get("transfer").is_some_and(|t| !t.is_null()) && view.get("state").and_then(|s| s.as_str()) == Some("transferring") {
            view["transfer"]["arrived"] = self.usb.arrived(&v.id);
        }
        Ok(ok(view))
    }

    fn sentry_usb_record(&self, req: &Req, id: &str) -> R {
        let v = self.vehicle_or_404(id)?;
        let body = body_json(req)?;
        let Some(older) = body.get("older").and_then(|o| o.as_bool()) else {
            return Err(he(400, "Send { \"older\": true } or { \"older\": false }: every clip is recorded, newest first, unless older clips are turned off."));
        };
        let mut rec = self.ctx.setting("sentry-usb-record").and_then(|r| r.as_object().cloned()).unwrap_or_default();
        let mut mine = rec.get(&v.id).and_then(|r| r.as_object().cloned()).unwrap_or_default();
        mine.insert("older".into(), json!(older));
        rec.insert(v.id.clone(), Value::Object(mine));
        self.ctx.set_setting("sentry-usb-record", Value::Object(rec));
        self.ctx.arrival_kick();
        self.ctx.audit("info", &format!("Checksum record of \"{}\": older clips {}: {}", v.name, if older { "on" } else { "off" }, req.who.by));
        Ok(ok(self.usb_view(&v, req)))
    }

    // ---- the CAN Bridge upload API (can-token)
    fn secure(&self, req: &Req) -> bool {
        let fwd = req.headers.get("x-forwarded-proto").and_then(|h| h.to_str().ok()).is_some_and(|h| h.split(',').next().unwrap_or("").trim().eq_ignore_ascii_case("https"));
        let web = self.ctx.web_secure(req.encrypted, fwd, &req.remote);
        if req.local_port != self.ctx.can_port() {
            return web;
        }
        if req.encrypted {
            return true;
        }
        let from = req.remote.trim_start_matches("::ffff:").to_string();
        !from.is_empty() && self.ctx.local_address(&from) && web
    }

    fn fail(status: u16, code: &str, error: &str, received: Option<f64>) -> Res {
        let mut o = Map::new();
        o.insert("error".into(), json!(error));
        o.insert("code".into(), json!(code));
        if let Some(r) = received {
            o.insert("received".into(), n(r));
        }
        json_res(status, &Value::Object(o))
    }

    fn token_of(&self, req: &Req, tokens: &[Value]) -> Option<Value> {
        let auth = req.headers.get(header::AUTHORIZATION).and_then(|h| h.to_str().ok()).unwrap_or("");
        let given = {
            let b = auth.as_bytes();
            if b.len() >= 6 && auth[..6].eq_ignore_ascii_case("bearer") && b.get(6).is_some_and(|c| c.is_ascii_whitespace()) {
                auth[6..].trim_start_matches(|c: char| c.is_whitespace())
            } else {
                auth
            }
        };
        if given.is_empty() || given.encode_utf16().count() > 200 {
            return None;
        }
        let h = util::sha256_hex(given.as_bytes());
        let mut found = None;
        for t in tokens {
            if let Some(th) = t.get("hash").and_then(|x| x.as_str()).filter(|x| x.len() == 64) {
                let mut diff = 0u8;
                for (a, b) in th.bytes().zip(h.bytes()) {
                    diff |= a ^ b;
                }
                if diff == 0 {
                    found = Some(t.clone());
                }
            }
        }
        found
    }

    /// claimToken/bindToken: the car key a token is for (tied now when it is not yet).
    fn claim(&self, tok_id: &str, key: &str, bind: bool) -> Option<String> {
        let (enabled, at, mut tokens) = self.can_cfg();
        let t = tokens.iter_mut().find(|x| x.get("id").and_then(|i| i.as_str()) == Some(tok_id))?;
        if !json::truthy(t.get("key")) {
            t["key"] = json!(key);
            self.ctx.log("info", &format!("CAN Bridge token \"{}\" is now for car key {}", t.get("label").map(|l| json::js_str(Some(l))).unwrap_or_default(), key));
            if let Some(vid) = t.get("vehicleId").filter(|v| json::truthy(Some(v))).cloned() {
                let mut map = self.can_map();
                if !json::truthy(map.get(key)) {
                    map.insert(key.to_string(), vid);
                    self.ctx.set_setting("can-vehicles", Value::Object(map));
                }
            }
            if !bind {
                let k = t["key"].as_str().map(String::from);
                self.save_can_cfg(enabled, &at, &tokens);
                return k;
            }
        }
        if bind {
            t["lastUsedAt"] = n(util::now_ms());
            let k = t["key"].as_str().map(String::from);
            self.save_can_cfg(enabled, &at, &tokens);
            return k;
        }
        t.get("key").and_then(|k| k.as_str()).map(String::from)
    }

    pub fn upload(self: &Arc<Self>, req: &Req, raw_path: &str) -> Res {
        let (enabled, _, tokens) = self.can_cfg();
        if !enabled || tokens.is_empty() {
            return Self::fail(404, "off", "Not found", None);
        }
        if !self.secure(req) {
            return Self::fail(403, "https_only", "CAN logs are only taken over HTTPS.", None);
        }
        let ip = if req.local_port == self.ctx.can_port() { if req.remote.is_empty() { "?".into() } else { req.remote.clone() } } else { self.ctx.client_key(&req.remote) };
        let now = util::now_ms();
        let Some(tok) = self.token_of(req, &tokens) else {
            let mut b = self.bad_tries.lock().unwrap();
            if b.get(&ip).is_some_and(|x| x.1 > now && x.0 >= 20) {
                return Self::fail(429, "slow_down", "Too many wrong tokens from this address; try again later.", None);
            }
            let fresh = b.get(&ip).is_none_or(|x| x.1 < now);
            let v = if fresh { (1, now + 600_000.0) } else { let x = b[&ip]; (x.0 + 1, x.1) };
            b.insert(ip.clone(), v);
            if b.len() > 5000 {
                b.shift_remove_index(0);
            }
            let mut r = Self::fail(401, "bad_token", "A valid CAN Bridge token is needed.", None);
            r.headers_mut().insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
            return r;
        };
        let tok_id = tok.get("id").map(|i| json::js_str(Some(i))).unwrap_or_default();
        {
            let mut p = self.pace.lock().unwrap();
            let e = p.entry(tok_id.clone()).or_insert((0, 0.0));
            if e.1 < now {
                *e = (1, now + 600_000.0);
            } else {
                e.0 += 1;
                if e.0 > 1200 {
                    return Self::fail(429, "slow_down", "Too many requests with this token; try again later.", None);
                }
            }
        }
        let sub = &raw_path["/api/can/logs".len()..];
        if req.method == Method::GET && sub == "/ping" {
            return ok(json!({ "ok": true, "api": 1, "vehicleKey": tok.get("key").filter(|k| json::truthy(Some(k))), "maxChunk": logs::MAX_CHUNK, "maxFile": logs::MAX_FILE, "maxSidecar": logs::MAX_SIDECAR, "formats": reader::FORMATS }));
        }
        if req.method == Method::POST && sub == "/status" {
            if req.body.len() > 1024 * 1024 {
                return Self::fail(413, "error", "That file is too large.", None);
            }
            let text = String::from_utf8_lossy(&req.body);
            let body: Value = match if text.is_empty() { Ok(json!({})) } else { serde_json::from_str(&text) } {
                Ok(v) => v,
                Err(_) => return Self::fail(400, "bad_request", "Send JSON: { \"names\": [...] }.", None),
            };
            let mut key = tok.get("key").filter(|k| json::truthy(Some(k))).and_then(|k| k.as_str()).map(String::from);
            if key.is_none() {
                if let Some(Value::Array(names)) = body.get("names") {
                    let mut keys: Vec<String> = Vec::new();
                    for x in names {
                        if let Some(nm) = parse_name(&logs::js_string(x)) {
                            if !keys.contains(&nm.vehicle_key) {
                                keys.push(nm.vehicle_key);
                            }
                        }
                    }
                    if keys.len() > 1 {
                        return Self::fail(400, "mixed_cars", "A token is for one car: ask about one car key's files.", None);
                    }
                    if keys.len() == 1 {
                        key = self.claim(&tok_id, &keys[0], false);
                    }
                }
            }
            return match self.logs.status(body.get("names"), Some(key.as_deref().unwrap_or("\u{0}none"))) {
                Ok(v) => ok(v),
                Err(e) => Self::fail_err(e),
            };
        }
        let name = if let Some(rest) = sub.strip_prefix('/') {
            match crate::api::decode(rest, false) {
                Some(n_) => n_,
                None => return Self::fail(400, "bad_name", "That is not a CAN Bridge log name.", None),
            }
        } else {
            String::new()
        };
        let parsed = parse_name(&name);
        if let (true, Some(nm)) = (req.method == Method::POST, parsed) {
            let key = self.claim(&tok_id, &nm.vehicle_key, false);
            if key.as_deref() != Some(nm.vehicle_key.as_str()) {
                return Self::fail(403, "wrong_car", &format!("This token is for car key {}, not {}.", key.unwrap_or_else(|| "null".into()), nm.vehicle_key), None);
            }
            let num = |h: &str| -> f64 {
                match req.headers.get(h).and_then(|v| v.to_str().ok()) {
                    None | Some("") => f64::NAN,
                    Some(v) => json::str_number(v),
                }
            };
            if req.body.len() as u64 > logs::MAX_CHUNK {
                return Self::fail(413, "error", "That file is too large.", None);
            }
            let sha = req.headers.get("upload-sha256").and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
            return match self.logs.receive(&name, &req.body, num("upload-offset"), num("upload-length"), &sha) {
                Ok(out) => {
                    self.claim(&tok_id, &nm.vehicle_key, true);
                    let complete = out.get("complete") == Some(&Value::Bool(true));
                    if complete && !json::truthy(out.get("already")) {
                        self.ctx.log("info", &format!("CAN Bridge: received {} ({} bytes)", name, json::num_str(out["length"].as_f64().unwrap_or(0.0))));
                        self.ctx.announce("can");
                        let me = self.clone();
                        let (k, l) = (nm.vehicle_key.clone(), name.trim_end_matches(".json").to_string());
                        let l = if name.ends_with(".json") { name[..name.len() - 5].to_string() } else { l };
                        std::thread::spawn(move || {
                            me.judge(&k, &l);
                        });
                    }
                    json_res(if complete { 201 } else { 200 }, &out)
                }
                Err(e) => Self::fail_err(e),
            };
        }
        Self::fail(404, "not_found", "Not found", None)
    }

    fn fail_err(e: CanError) -> Res {
        Self::fail(e.status, if e.code.is_empty() { "error" } else { &e.code }, &e.message, e.received)
    }
}

/// A file opened when the zip comes to it.
struct LazyFile(PathBuf, Option<std::fs::File>);
impl std::io::Read for LazyFile {
    fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
        if self.1.is_none() {
            self.1 = Some(std::fs::File::open(&self.0)?);
        }
        self.1.as_mut().unwrap().read(b)
    }
}


/// decodedRows: the rows a decoded export writes for one minute.
fn decoded_rows(d: &super::format::Minute, t: f64, from: f64, to: f64, only: Option<&HashSet<String>>, every: bool, last: &mut HashMap<String, (f64, f64)>, plan: Option<&mut calc::Plan>) -> Vec<(f64, String, calc::V)> {
    let read: Option<HashSet<String>> = match (&plan, only) {
        (Some(p), o) => Some(o.cloned().unwrap_or_default().into_iter().chain(p.inputs.iter().map(|s| s.to_string())).collect()),
        (None, o) => o.cloned(),
    };
    // (as Node: with a plan and no list, only the plan's inputs are read)
    let mut pts: Vec<(f64, String, f64)> = Vec::new();
    for (name, list) in &d.signals {
        if read.as_ref().is_some_and(|r| !r.contains(name)) {
            continue;
        }
        for (ms, v) in list {
            let at = t + ms;
            if at < from || at > to {
                continue;
            }
            if let Some(l) = last.get_mut(name) {
                if !every && l.0 == *v && at - l.1 < CAN_HEARTBEAT_MS {
                    continue;
                }
                *l = (*v, at);
            } else {
                last.insert(name.clone(), (*v, at));
            }
            pts.push((at, name.clone(), *v));
        }
    }
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then_with(|| if a.1 < b.1 { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater }));
    let sorted: Vec<(f64, String, calc::V)> = pts.into_iter().map(|(a, b, c)| (a, b, calc::V::Num(c))).collect();
    let Some(plan) = plan else { return sorted };
    let cps = calc::points(&sorted, plan, every, CAN_HEARTBEAT_MS);
    let kept: Vec<(f64, String, calc::V)> = match only {
        Some(o) => sorted.into_iter().filter(|p| o.contains(&p.1)).collect(),
        None => sorted,
    };
    if cps.is_empty() {
        return kept;
    }
    let mut all: Vec<(f64, String, calc::V)> = kept.into_iter().chain(cps).collect();
    all.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then_with(|| if a.1 < b.1 { std::cmp::Ordering::Less } else { std::cmp::Ordering::Greater }));
    all
}

