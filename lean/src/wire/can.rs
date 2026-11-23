//! The CAN area on core: `CanCtx` on core's state (manager.db settings, the
//! hub, the audit log, TRUST_PROXY and the client address, the certificate's
//! fingerprint, the footage area's vehicles, scans, Recycle Bin and locks),
//! its routes through core's router, and the CAN Bridge uploads on core's
//! web port and device port (core's TLS, connection limits and timeouts).

use super::footage::car_of;
use super::{body_bytes, Server};
use crate::can::ctx::{CanCtx, Car, FootFile, Rec, Scan, Who};
use crate::can::routes::{Can, PortState, Req};
use crate::core::http::RawReq;
use crate::core::{Ctx as CoreCtx, HttpError, Reply};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Weak};

pub struct CoreCan {
    srv: Weak<Server>,
    state: Arc<crate::core::AppState>,
}

impl CoreCan {
    fn srv(&self) -> Option<Arc<Server>> {
        self.srv.upgrade()
    }
}

fn camera_of(rel: &str) -> Option<String> {
    let name = rel.rsplit('/').next()?;
    let stem = name.strip_suffix(".mp4")?;
    crate::can::search::ts_from(stem)?;
    stem.get(20..).map(String::from)
}

impl CanCtx for CoreCan {
    fn data_dir(&self) -> PathBuf {
        self.state.config.data.clone()
    }
    fn can_port(&self) -> u16 {
        self.state.config.can_port
    }
    fn setting(&self, key: &str) -> Result<Option<Value>, String> {
        self.state.setting(key).map_err(|e| e.to_string())
    }
    fn set_setting(&self, key: &str, value: Value) -> Result<(), String> {
        self.state.set_setting(key, &value).map_err(|e| e.to_string())
    }
    fn has_dashboards(&self) -> Result<bool, String> {
        use rusqlite::OptionalExtension;
        let c = self.state.db.reader();
        let hit = c.query_row("SELECT 1 FROM settings WHERE key LIKE 'dash:%' LIMIT 1", [], |_| Ok(())).optional();
        hit.map(|h| h.is_some()).map_err(|e| format!("manager.db: {e}"))
    }
    fn vehicles(&self) -> Vec<Car> {
        let Some(s) = self.srv() else { return Vec::new() };
        let app = s.app();
        app.vehicles.list().iter().map(|v| car_of(app, v)).collect()
    }
    fn vehicle(&self, id: &str) -> Option<Car> {
        let s = self.srv()?;
        let app = s.app();
        app.vehicle(id).map(|v| car_of(app, &v))
    }
    fn scan_of(&self, vid: &str) -> Option<Scan> {
        let s = self.srv()?;
        let st = s.app().state_of(vid)?;
        let files = st.file_list.iter().map(|f| FootFile { rel: f.rel.clone(), kind: f.kind.as_str().to_string(), camera: f.camera.clone().or_else(|| camera_of(&f.rel)) }).collect();
        let recordings = st.recordings.iter().map(super::footage::rec_of).collect::<Vec<Rec>>();
        Some(Scan {
            scanned: st.scanned,
            scanned_at: st.scanned_at,
            scanning: st.scanning,
            last_error: st.last_error.clone(),
            error_count: st.error_count,
            files,
            recordings,
            generation: st.generation,
        })
    }
    fn scan_head(&self, vid: &str) -> Option<Scan> {
        let s = self.srv()?;
        let st = s.app().state_of(vid)?;
        Some(Scan { scanned: st.scanned, scanned_at: st.scanned_at, scanning: st.scanning, last_error: st.last_error.clone(), error_count: st.error_count, files: Vec::new(), recordings: Vec::new(), generation: st.generation })
    }
    fn scan_generation(&self, vid: &str) -> Option<u64> {
        Some(self.srv()?.app().state_of(vid)?.generation)
    }
    fn rescan(&self, vid: &str) -> Result<(), String> {
        let s = self.srv().ok_or("stopping")?;
        s.app().scan_now(vid, false).map(|_| ()).map_err(|e| e.message)
    }
    fn bin_rels(&self, vid: &str) -> Result<Vec<String>, String> {
        let items = self.state.db.bin_items(Some(vid)).map_err(|e| e.to_string())?;
        Ok(items.into_iter().flat_map(|b| b.files.as_array().cloned().unwrap_or_default()).filter_map(|f| f["rel"].as_str().map(String::from)).collect())
    }
    fn protected_rels(&self, vid: &str) -> Result<Vec<String>, String> {
        Ok(self.state.db.protected_set(vid).map_err(|e| e.to_string())?.into_iter().collect())
    }
    fn share_healthy(&self, vid: &str) -> bool {
        self.srv().is_none_or(|s| s.app().vehicles.share(vid).is_none_or(|sh| sh.is_healthy()))
    }
    fn with_bin_lock(&self, vid: &str, f: &mut dyn FnMut()) {
        match self.srv() {
            Some(s) => crate::footage::bin::with_lock(s.app(), vid, f),
            None => f(),
        }
    }
    fn announce(&self, topic: &str) {
        self.state.announce(topic);
    }
    fn audit(&self, level: &str, line: &str) {
        match level {
            "warn" => self.state.audit.warn(line),
            "error" => self.state.audit.error(line),
            _ => self.state.audit.info(line),
        }
    }
    fn log(&self, level: &str, line: &str) {
        let s = self.state.logger.scope("can");
        match level {
            "warn" => s.warn(line),
            "error" => s.error(line),
            "debug" => s.debug(line),
            _ => s.info(line),
        }
    }
    fn telemetry(&self, real: &Path) -> Result<Value, String> {
        let size = std::fs::metadata(real).map_err(|e| e.to_string())?.len();
        let frames = crate::telemetry::read_records(real, size).map_err(|_| "unreadable".to_string())?;
        Ok(serde_json::json!({ "frames": frames.iter().map(|(t, b)| serde_json::json!([crate::can::json::n(*t), crate::can::trust::base64(b)])).collect::<Vec<_>>() }))
    }
    fn resolve_clip(&self, path: &str) -> Option<PathBuf> {
        let s = self.srv()?;
        let roots: Vec<PathBuf> = s.app().vehicles.list().into_iter().map(|v| v.root).collect();
        crate::media::resolve_inside(path, &roots)
    }
    fn hidden_path(&self, real: &Path) -> bool {
        crate::media::hidden_path(&real.to_string_lossy())
    }
    fn cert_fingerprint(&self) -> Option<String> {
        self.state.cert_fingerprint()
    }
    fn tls(&self) -> bool {
        self.state.tls.is_some()
    }
    fn tls_status(&self) -> Option<Value> {
        self.state.tls.as_ref()?.status().ok()
    }
    fn ca_pem(&self) -> Option<Vec<u8>> {
        self.state.tls.as_ref()?.ca_pem()
    }
    fn app_root(&self) -> PathBuf {
        self.state.config.app_root.clone()
    }
    fn web_secure(&self, encrypted: bool, forwarded_https: bool, from: &str) -> bool {
        encrypted || (forwarded_https && crate::core::client_addr::from_trusted_proxy(Some(from), &self.state.proxy))
    }
    fn local_address(&self, ip: &str) -> bool {
        crate::core::tls::ip_permitted(ip)
    }
    fn sentry_usb_record_view(&self, vid: &str) -> Result<Value, String> {
        // arrivalRef.view(v.id) (the CAN area adds canBackfill)
        self.srv().and_then(|s| s.arrival().map(|a| a.arrival.view(vid))).unwrap_or_else(|| Ok(serde_json::json!({})))
    }
    fn arrival_kick(&self) {
        if let Some(a) = self.srv().and_then(|s| s.arrival().cloned()) {
            a.arrival.kick();
        }
    }
    fn idle(&self) -> bool {
        !self.srv().and_then(|s| s.converter().map(|c| c.running())).unwrap_or(false)
    }
    fn client_key(&self, remote: &str) -> String {
        // (the web port: core worked it out as clientKey(req) does, TRUST_PROXY included)
        super::current().map(|w| w.client).unwrap_or_else(|| remote.to_string())
    }
}

pub fn make(srv: &Arc<Server>) -> Arc<Can> {
    let ctx: Arc<dyn CanCtx> = Arc::new(CoreCan { srv: Arc::downgrade(srv), state: srv.state.clone() });
    let can = Can::new(ctx);
    // the device port is core's (TLS when the server has it, 6 connections an address, 256 in
    // all, 15 s to the first bytes, 20 s for the headers): opened and closed with the uploads
    let (st, rt) = (srv.state.clone(), srv.rt.clone());
    let weak = Arc::downgrade(&can);
    *can.on_port.lock().unwrap() = Some(Box::new(move |on: bool| {
        let _guard = rt.enter();
        crate::core::server::sync_device_port(&st);
        if let Some(can) = weak.upgrade() {
            *can.port_state.lock().unwrap() = PortState { listening: on, error: None, port: st.config.can_port };
        }
    }));
    can
}

fn who_of(c: &CoreCtx) -> Result<Who, HttpError> {
    let w = super::Who::of(c);
    let admin_here = match c.user.as_deref() {
        Some(u) => c.state.admin_here(&c.client, u)?,
        None => false,
    };
    Ok(Who { by: w.by(), owner: c.user.clone().filter(|u| !u.is_empty()).unwrap_or_else(|| c.client.clone()), admin_here })
}

/// A CAN route for core's router.
pub fn answer(srv: &Arc<Server>, c: &mut CoreCtx) -> Result<Reply, HttpError> {
    let Some(can) = srv.can().cloned() else { return Err(HttpError::not_found()) };
    let req = Req {
        method: c.method.clone(),
        path: c.raw_path.clone(),
        query: c.query.clone(),
        headers: c.headers.clone(),
        body: body_bytes(c),
        remote: c.conn.peer_ip().unwrap_or_default(),
        local_port: c.state.config.port,
        encrypted: c.conn.encrypted,
        who: who_of(c)?,
        confirmed: c.state.auth.recently_confirmed(&c.view()),
        closed: Arc::new(AtomicBool::new(false)),
    };
    match super::as_who(super::Who::of(c), || can.handle(&req)) {
        Some(res) => super::raw(res, c),
        None => Err(HttpError::not_found()),
    }
}

/// Live CAN stats for a Stream Deck (/api/can/now…): only with the token made in the Nerd
/// panel; read-only, no cookies, before core's checks (index.js answers it before them too).
pub async fn now(srv: Arc<Server>, q: RawReq) -> crate::core::http::Res {
    let Some(can) = srv.can().cloned() else { return crate::core::http::error_json(404, "Not found", None, "") };
    let method = q.req.method().clone();
    let path = q.req.uri().path().to_string();
    let query = q.req.uri().query().map(String::from);
    let headers = q.req.headers().clone();
    let auth = headers.get(axum::http::header::AUTHORIZATION).and_then(|v| v.to_str().ok()).map(String::from);
    let accept = headers.get(axum::http::header::ACCEPT_ENCODING).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let res = tokio::task::spawn_blocking(move || can.now_answer(&method, &path, query.as_deref(), auth.as_deref())).await;
    match res {
        Ok(r) => super::gzip_json(r, &accept),
        Err(_) => crate::core::http::error_json(500, "Internal error", None, &accept),
    }
}

/// The CAN Bridge upload API (/api/can/logs…), on the web port and the device port: its own
/// token, before core's checks.
pub async fn upload(srv: Arc<Server>, q: RawReq) -> crate::core::http::Res {
    let Some(can) = srv.can().cloned() else { return crate::core::http::error_json(404, "Not found", Some("off"), "") };
    let device = q.conn.device;
    let at = UploadAt {
        remote: q.conn.peer_ip().unwrap_or_default(),
        local_port: if device { srv.state.config.can_port } else { srv.state.config.port },
        encrypted: q.conn.encrypted,
        client: q.client.clone(),
        secure: q.secure,
    };
    serve_upload(can, q.req, at).await
}

/// Where an upload request came in (its connection, as core worked it out).
#[derive(Clone, Debug, Default)]
pub struct UploadAt {
    /// the connection's own address
    pub remote: String,
    /// the port it came in on (CAN_PORT: the device port)
    pub local_port: u16,
    pub encrypted: bool,
    /// the client's address (TRUST_PROXY) and whether core counts the request as HTTPS
    pub client: String,
    pub secure: bool,
}

/// One upload API request to `can`: the body read (at most a chunk and 1 MiB), then answered.
/// With `Expect: 100-continue`, every check the headers decide is made first: a refusal (or
/// `201` `already` for a file all here) is answered without reading the body, so hyper sends
/// no 100 Continue and the bridge never sends the piece; the connection then closes.
pub async fn serve_upload(can: Arc<Can>, req: axum::http::Request<axum::body::Body>, at: UploadAt) -> crate::core::http::Res {
    let (parts, body) = req.into_parts();
    let path = parts.uri.path().to_string();
    let limit = (crate::can::logs::MAX_CHUNK + 1024 * 1024) as usize;
    let too_large = || crate::can::routes::json_res(413, &serde_json::json!({ "error": "That file is too large.", "code": "error" }));
    let internal = || crate::can::routes::json_res(500, &serde_json::json!({ "error": "Internal error", "code": "server_error" }));
    let who = super::Who { client: at.client.clone(), secure: at.secure, ..Default::default() };
    let query = parts.uri.query().map(|qs| {
        qs.split('&').filter(|p| !p.is_empty()).map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (crate::api::decode(k, true).unwrap_or_default(), crate::api::decode(v, true).unwrap_or_default())
        }).collect()
    }).unwrap_or_default();
    let expect = crate::core::body::expects_continue(&parts.headers);
    let mut req = Req {
        method: parts.method,
        path: path.clone(),
        query,
        headers: parts.headers,
        body: Default::default(),
        remote: at.remote,
        local_port: at.local_port,
        encrypted: at.encrypted,
        who: Default::default(),
        confirmed: false,
        closed: Arc::new(AtomicBool::new(false)),
    };
    let mut gate = None;
    if expect {
        let early = |mut r: crate::core::http::Res| {
            crate::core::body::close_after(&mut r);
            r
        };
        let declared = req.headers.get(axum::http::header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<u64>().ok());
        if declared.is_some_and(|l| l > limit as u64) {
            return early(too_large());
        }
        let (c, w, p) = (can.clone(), who.clone(), path.clone());
        let Ok((back, head)) = tokio::task::spawn_blocking(move || {
            let head = super::as_who(w, || c.upload_head(&req, &p, declared));
            (req, head)
        })
        .await
        else {
            return early(internal());
        };
        req = back;
        match head {
            Ok(g) => gate = Some(g),
            Err(r) => return early(r),
        }
    }
    // (a bridge that lost Wi-Fi or power mid-upload sends nothing more: 408 after 2 minutes,
    // and its connection closes, instead of holding the connection for ever)
    req.body = match crate::core::body::collect(body, limit).await {
        Ok(b) => b,
        Err(crate::core::body::BodyError::TimedOut) => {
            let mut r = crate::can::routes::json_res(408, &serde_json::json!({ "error": crate::core::body::TIMED_OUT_TEXT, "code": "timed_out" }));
            crate::core::body::close_after(&mut r);
            return r;
        }
        Err(_) => return too_large(),
    };
    tokio::task::spawn_blocking(move || {
        super::as_who(who, || match gate {
            Some(g) => can.upload_gated(&req, &path, g),
            None => can.upload(&req, &path),
        })
    })
    .await
    .unwrap_or_else(|_| internal())
}
