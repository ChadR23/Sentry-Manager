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
use http_body_util::BodyExt;
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
    fn setting(&self, key: &str) -> Option<Value> {
        self.state.setting(key)
    }
    fn set_setting(&self, key: &str, value: Value) {
        self.state.set_setting(key, &value);
    }
    fn has_dashboards(&self) -> bool {
        let c = self.state.db.conn();
        c.query_row("SELECT 1 FROM settings WHERE key LIKE 'dash:%' LIMIT 1", [], |_| Ok(())).is_ok()
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
            generation: Arc::as_ptr(&st.recordings) as u64,
        })
    }
    fn rescan(&self, vid: &str) -> Result<(), String> {
        let s = self.srv().ok_or("stopping")?;
        s.app().scan_now(vid, false).map(|_| ()).map_err(|e| e.message)
    }
    fn bin_rels(&self, vid: &str) -> Vec<String> {
        self.state.db.bin_items(Some(vid)).into_iter().flat_map(|b| b.files.as_array().cloned().unwrap_or_default()).filter_map(|f| f["rel"].as_str().map(String::from)).collect()
    }
    fn protected_rels(&self, vid: &str) -> Vec<String> {
        self.state.db.protected_set(vid).into_iter().collect()
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
    fn web_secure(&self, encrypted: bool, forwarded_https: bool, from: &str) -> bool {
        encrypted || (forwarded_https && crate::core::client_addr::from_trusted_proxy(Some(from), &self.state.proxy))
    }
    fn local_address(&self, ip: &str) -> bool {
        crate::core::tls::ip_permitted(ip)
    }
    fn sentry_usb_record_view(&self, vid: &str) -> Value {
        // arrivalRef.view(v.id) (the CAN area adds canBackfill)
        self.srv().and_then(|s| s.arrival().map(|a| a.arrival.view(vid))).unwrap_or_else(|| serde_json::json!({}))
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

fn who_of(c: &CoreCtx) -> Who {
    let w = super::Who::of(c);
    Who {
        by: w.by(),
        owner: c.user.clone().filter(|u| !u.is_empty()).unwrap_or_else(|| c.client.clone()),
        admin_here: c.user.as_deref().is_some_and(|u| c.state.admin_here(&c.client, u)),
    }
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
        who: who_of(c),
        confirmed: c.state.auth.recently_confirmed(&c.view()),
        closed: Arc::new(AtomicBool::new(false)),
    };
    match super::as_who(super::Who::of(c), || can.handle(&req)) {
        Some(res) => super::raw(res, c),
        None => Err(HttpError::not_found()),
    }
}

/// The CAN Bridge upload API (/api/can/logs…), on the web port and the device port: its own
/// token, before core's checks.
pub async fn upload(srv: Arc<Server>, q: RawReq) -> crate::core::http::Res {
    let Some(can) = srv.can().cloned() else { return crate::core::http::error_json(404, "Not found", Some("off"), "") };
    let (parts, body) = q.req.into_parts();
    let path = parts.uri.path().to_string();
    let limit = (crate::can::logs::MAX_CHUNK + 1024 * 1024) as usize;
    let body = match http_body_util::Limited::new(body, limit).collect().await {
        Ok(b) => b.to_bytes(),
        Err(_) => return crate::can::routes::json_res(413, &serde_json::json!({ "error": "That file is too large.", "code": "error" })),
    };
    let device = q.conn.device;
    let remote = q.conn.peer_ip().unwrap_or_default();
    let who = super::Who { client: q.client.clone(), secure: q.secure, ..Default::default() };
    let query = parts.uri.query().map(|qs| {
        qs.split('&').filter(|p| !p.is_empty()).map(|p| {
            let (k, v) = p.split_once('=').unwrap_or((p, ""));
            (crate::api::decode(k, true).unwrap_or_default(), crate::api::decode(v, true).unwrap_or_default())
        }).collect()
    }).unwrap_or_default();
    let req = Req {
        method: parts.method,
        path: path.clone(),
        query,
        headers: parts.headers,
        body,
        remote,
        local_port: if device { srv.state.config.can_port } else { srv.state.config.port },
        encrypted: q.conn.encrypted,
        who: Default::default(),
        confirmed: false,
        closed: Arc::new(AtomicBool::new(false)),
    };
    tokio::task::spawn_blocking(move || super::as_who(who, || can.upload(&req, &path))).await.unwrap_or_else(|_| crate::core::http::error_json(500, "Internal error", None, ""))
}
