//! The ops area on core: `OpsCtx` on core's state (manager.db through core's
//! connection, the audit and app logs, the live-update hub, the footage
//! area's vehicles and shares, core's TLS), its routes and `/metrics`.

use super::{raw, Server};
use crate::core::http::RawReq;
use crate::core::{Ctx as CoreCtx, HttpError, Reply};
use crate::ops::ctx::*;
use axum::body::Body;
use axum::http::Response;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, MutexGuard, Weak};

pub struct CoreOps {
    srv: Weak<Server>,
    state: Arc<crate::core::AppState>,
}

/// One vehicle as ops sees it, from the footage area.
pub fn vehicle_info(srv: &Server, id: &str) -> Option<VehicleInfo> {
    let app = srv.app();
    let v = app.vehicle(id)?;
    let st = app.state_of(&v.id);
    let totals = st.as_ref().filter(|s| s.scanned).map(|s| crate::inventory::totals(&s.recordings, s.files, s.scanned_at.unwrap_or(0.0)));
    let status = app.vehicles.share(&v.id).map(|s| {
        let x = s.state();
        ShareStatus {
            healthy: x.healthy,
            writable: x.writable,
            read_only: x.read_only,
            free_bytes: x.free_bytes.map(|b| b as f64),
            total_bytes: x.total_bytes.map(|b| b as f64),
            last_error: x.last_error,
            hint: x.hint,
            warning: x.warning,
        }
    });
    let summary = crate::footage::routes::vehicle_summary(app, &v);
    let src = |k: &str| v.source.get(k).and_then(Value::as_str).map(String::from);
    let smb = v.is_smb();
    Some(VehicleInfo {
        id: v.id.clone(),
        name: v.name.clone(),
        roots: vec![v.root.to_string_lossy().into_owned(), app.studio_root(&v).to_string_lossy().into_owned()]
            .into_iter()
            .chain(src("path"))
            .collect(),
        source_type: src("type"),
        share: if smb { src("share") } else { None },
        username: if smb { src("username") } else { None },
        domain: if smb { src("domain") } else { None },
        status,
        footage_bytes: totals.as_ref().and_then(|t| t["bytes"].as_f64()),
        recordings: totals.as_ref().and_then(|t| t["recordings"].as_f64()),
        bin_bytes: Some(crate::footage::bin::bin_bytes(app, &v.id) as f64),
        days_left: summary["storage"]["daysLeft"].as_f64(),
        policy: crate::footage::policies::get(app, &v.id),
    })
}

impl CoreOps {
    fn srv(&self) -> Option<Arc<Server>> {
        self.srv.upgrade()
    }
}

impl OpsCtx for CoreOps {
    fn db(&self) -> MutexGuard<'_, Connection> {
        self.state.db.conn()
    }
    fn data_dir(&self) -> PathBuf {
        self.state.config.data.clone()
    }
    fn app_root(&self) -> PathBuf {
        self.state.config.app_root.clone()
    }
    fn audit(&self, level: Level, line: &str) {
        match level {
            Level::Debug | Level::Info => self.state.audit.info(line),
            Level::Warn => self.state.audit.warn(line),
            Level::Error => self.state.audit.error(line),
        }
    }
    fn log(&self, scope: &str, level: Level, line: &str) {
        let s = self.state.logger.scope(scope);
        match level {
            Level::Debug => s.debug(line),
            Level::Info => s.info(line),
            Level::Warn => s.warn(line),
            Level::Error => s.error(line),
        }
    }
    fn announce(&self, topic: &str) {
        self.state.announce(topic);
    }
    fn vehicles(&self) -> Vec<VehicleInfo> {
        let Some(srv) = self.srv() else { return Vec::new() };
        srv.app().vehicles.list().iter().filter_map(|v| vehicle_info(&srv, &v.id)).collect()
    }
    fn converter(&self) -> ConverterInfo {
        // (the converter's runtime is not in this server yet: as Node while it starts)
        ConverterInfo { ready: false, error: Some("CONVERTER_STARTING".into()), ..Default::default() }
    }
    fn select_encoder(&self) -> Option<Encoder> {
        None
    }
    fn detect_gpus(&self) -> Value {
        json!({ "gpus": [], "nvidia": [], "hints": [] })
    }
    fn usable_gpus(&self) -> usize {
        0
    }
    fn tls(&self) -> Option<TlsInfo> {
        let error = self.state.tls.as_ref().and_then(|t| match t.status() {
            Ok(s) => s["error"].as_str().filter(|e| !e.is_empty()).map(String::from),
            Err(e) => Some(e),
        });
        Some(TlsInfo { mode: self.tls_mode(), trust_proxy: self.state.config.trust_proxy, error, detail: None })
    }
    fn ffmpeg_path(&self) -> String {
        self.state.config.ffmpeg.clone()
    }
    fn ffprobe_path(&self) -> String {
        self.state.config.ffprobe.clone()
    }
    fn ui_pack(&self) -> String {
        self.srv().and_then(|s| s.ui().and_then(|u| u.packs.active())).unwrap_or_else(|| "original".into())
    }
    fn identifiers(&self) -> Vec<String> {
        let mut ids = vec![std::fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default().trim().to_string(), self.state.config.data.to_string_lossy().into_owned()];
        for (name, _) in self.state.db.list_users() {
            ids.push(name);
        }
        for v in self.vehicles() {
            ids.push(v.id);
            ids.push(v.name);
            ids.extend(v.roots);
        }
        if let Some(Value::Array(places)) = self.state.db.get("places") {
            ids.extend(places.iter().filter_map(|p| p["name"].as_str().map(String::from)));
        }
        ids.extend(crate::core::tls::parse_hostnames(&self.state.config.tls_hostnames).unwrap_or_default());
        ids.into_iter().filter(|s| s.encode_utf16().count() >= 3).collect()
    }
    fn diagnostics(&self, _kind: &str) -> Value {
        json!({ "system": self.system_summary(false) })
    }
    fn heartbeat(&self) -> Value {
        let list = self.vehicles();
        let sum = |f: &dyn Fn(&VehicleInfo) -> Option<f64>| list.iter().map(|v| f(v).unwrap_or(0.0)).sum::<f64>();
        let (platform, arch) = crate::ops::build::platform_arch();
        let (os, docker) = crate::ops::build::host_info();
        let can = self.state.db.get("can").is_some_and(|c| c["enabled"] == json!(true));
        json!({
            "platform": platform, "arch": arch, "host": { "os": os, "docker": docker },
            "vehicles": list.len(), "footageBytes": sum(&|v| v.footage_bytes), "recordings": sum(&|v| v.recordings),
            "converting": false, "jobsQueued": 0, "features": { "can": can, "sentryUsbPaired": false, "gpu": false }
        })
    }
    fn shutdown(&self, reason: &str) {
        crate::core::server::shutdown(&self.state, reason);
    }
    fn tls_mode(&self) -> String {
        self.state.config.tls_mode.clone()
    }
    fn supervised(&self) -> bool {
        self.state.config.supervised
    }
    fn log_search(&self, from_ms: i64, min_level: Level, limit: usize) -> Vec<LogLine> {
        let level = |l: &str| match l {
            "debug" => Level::Debug,
            "warn" => Level::Warn,
            "error" => Level::Error,
            _ => Level::Info,
        };
        let q = crate::core::log::Search { from: Some(from_ms), to: None, text: String::new(), min_level: min_level.name().to_string(), limit };
        self.state.logger.search(&q).into_iter().map(|e| LogLine { at: e.at, level: level(&e.level), scope: e.scope.clone(), message: e.message.clone() }).collect()
    }
    fn system_summary(&self, placeholders: bool) -> Value {
        let (platform, arch) = crate::ops::build::platform_arch();
        let build = crate::ops::build::read_build_info(&self.state.config.app_root);
        json!({
            "made": crate::ops::js::iso(crate::ops::store::now_ms()), "version": build, "node": null, "platform": format!("{platform} {arch}"),
            "supervised": self.supervised(), "tlsMode": self.tls_mode(), "trustProxy": self.state.config.trust_proxy, "timezone": self.state.config.tz,
            "gpus": self.detect_gpus(), "converter": { "ready": false },
            "vehicles": self.vehicles().iter().enumerate().map(|(i, v)| {
                let st = v.status.clone().unwrap_or_default();
                json!({ "vehicle": if placeholders { format!("<vehicle-{}>", i + 1) } else { v.name.clone() }, "type": v.source_type, "healthy": st.healthy, "writable": st.writable, "freeBytes": st.free_bytes, "totalBytes": st.total_bytes, "recordings": v.recordings, "policy": v.policy })
            }).collect::<Vec<_>>(),
            "uiPack": self.ui_pack()
        })
    }
}

pub fn make(srv: &Arc<Server>) -> Arc<crate::ops::Ops> {
    let ctx = Arc::new(CoreOps { srv: Arc::downgrade(srv), state: srv.state.clone() });
    crate::ops::Ops::new(ctx, Arc::new(crate::ops::net::Https), crate::ops::Ops::process_env())
}

fn to_res(reply: crate::ops::Reply) -> crate::core::http::Res {
    let mut b = Response::builder().status(reply.status);
    for (k, v) in &reply.headers {
        b = b.header(k.as_str(), v.as_str());
    }
    b.body(Body::from(reply.body)).unwrap()
}

/// An ops route for core's router.
pub fn answer(srv: &Arc<Server>, c: &mut CoreCtx) -> Result<Reply, HttpError> {
    let Some(ops) = srv.ops() else { return Err(HttpError::not_found()) };
    let body = c.body.clone().unwrap_or(Value::Null);
    let caller = Caller { user: c.user.clone(), client: c.client.clone(), confirmed: c.state.auth.recently_confirmed(&c.view()), https: c.secure };
    let auth = c.headers.get(axum::http::header::AUTHORIZATION).and_then(|v| v.to_str().ok()).map(String::from);
    let r = crate::ops::Request { method: c.method.as_str(), path: &c.raw_path, query: &c.query, body: &body, caller: &caller, authorization: auth.as_deref() };
    match ops.handle(&r) {
        Some(reply) => raw(to_res(reply), c),
        None => Err(HttpError::not_found()),
    }
}

/// GET /metrics with its own token (before core's checks, as index.js).
pub fn metrics(srv: &Arc<Server>, q: &RawReq) -> crate::core::http::Res {
    let Some(ops) = srv.ops() else { return crate::core::http::error_json(404, "Not found", None, "") };
    let path = q.req.uri().path().to_string();
    let query = std::collections::HashMap::new();
    let caller = Caller { user: None, client: q.client.clone(), confirmed: false, https: q.secure };
    let auth = q.req.headers().get(axum::http::header::AUTHORIZATION).and_then(|v| v.to_str().ok()).map(String::from);
    let r = crate::ops::Request { method: q.req.method().as_str(), path: &path, query: &query, body: &Value::Null, caller: &caller, authorization: auth.as_deref() };
    match ops.handle(&r) {
        Some(reply) => to_res(reply),
        None => crate::core::http::error_json(404, "Not found", None, ""),
    }
}
