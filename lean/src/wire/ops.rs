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
        footage_minutes: totals.as_ref().and_then(|t| t["minutes"].as_f64()),
        bin_items: Some(srv.state.db.bin_items(Some(&v.id)).len() as f64),
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
        let Some(conv) = self.srv().and_then(|s| s.converter().cloned()) else {
            return ConverterInfo { ready: false, error: Some("CONVERTER_STARTING".into()), ..Default::default() };
        };
        let running = conv.jobs.lock().unwrap().values().any(|st| super::converter::RUNNING.contains(&st.as_str()));
        ConverterInfo {
            ready: true,
            // (runtime.js capabilities: the staging manager's, with destinationContainment)
            capabilities: {
                let mut c = conv.runtime.staging.capabilities();
                c["destinationContainment"] = json!("pathname-revalidated-non-atomic");
                c
            },
            error: None,
            encoding_now: conv.runtime.encoding_now(),
            running,
            // (renameat2(RENAME_NOREPLACE) is called directly: no helper program is needed)
            native_helper: true,
        }
    }
    fn select_encoder(&self) -> Option<Encoder> {
        // rt.selectEncoder('h265'): the planner's test encodes, the choice kept (encoderPlanner.js)
        let srv = self.srv()?;
        let s = srv.planner().select("h265", true).ok().flatten()?;
        Some(Encoder { codec: s.codec, hardware: s.hardware })
    }
    fn detect_gpus(&self) -> Value {
        crate::ops::gpu::detect_gpus(&crate::ops::gpu::DetectOptions::default(), &crate::ops::gpu::run)
    }
    fn usable_gpus(&self) -> usize {
        crate::ops::gpu::usable_gpus(&self.detect_gpus()).len()
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
        // (what only other areas know: account names, place names and labels, FOOTAGE_ROOT;
        // ops::diag::identifiers adds the rest)
        let mut ids: Vec<String> = self.state.db.list_users().into_iter().map(|(n, _)| n).collect();
        if let Some(Value::Array(places)) = self.state.db.get("places") {
            for p in places {
                for k in ["name", "label"] {
                    if let Some(x) = p[k].as_str() {
                        ids.push(x.to_string());
                    }
                }
            }
        }
        if let Some(r) = self.state.config.env.get("FOOTAGE_ROOT").filter(|r| !r.is_empty()) {
            ids.push(r.clone());
        }
        ids
    }
    fn jobs_queued(&self) -> usize {
        self.srv().and_then(|s| s.converter().map(|c| c.jobs.lock().unwrap().values().filter(|st| st.as_str() == "waiting").count())).unwrap_or(0)
    }
    fn shutdown(&self, reason: &str) {
        crate::core::server::shutdown(&self.state, reason);
    }
    fn active_encodes(&self) -> Vec<crate::ops::stats::ActiveEncode> {
        let Some(conv) = self.srv().and_then(|s| s.converter().cloned()) else { return Vec::new() };
        conv.runtime.active_encodes().iter().filter_map(|e| Some(crate::ops::stats::ActiveEncode { pid: e["pid"].as_i64()?, encoder: e["encoder"].as_str().map(String::from) })).collect()
    }
    fn job_progress(&self, job: &str) -> Option<(f64, f64)> {
        let conv = self.srv()?.converter()?.clone();
        let s = conv.runtime.service.get(job).ok()?;
        Some(super::converter::job_progress(&s))
    }
    fn request_rapl(&self) {
        if let Some(link) = self.state.supervisor.get() {
            link.rapl_on();
        }
    }
    fn recent_jobs(&self, limit: usize) -> Vec<Value> {
        self.state.db.jobs(limit as i64, None).into_iter().map(|j| json!({ "type": j.kind, "status": j.status, "title": j.title, "detail": j.detail, "startedAt": j.started_at, "finishedAt": j.finished_at })).collect()
    }
    fn access_settings(&self) -> Value {
        self.state.access.get()
    }
    fn places_count(&self) -> usize {
        self.state.db.get("places").and_then(|p| p.as_array().map(|a| a.len())).unwrap_or(0)
    }
    fn can_status(&self) -> Value {
        self.srv().and_then(|s| s.can().map(|c| c.index.status().to_json())).unwrap_or_else(|| json!({}))
    }
    fn car_models(&self) -> Vec<Option<String>> {
        let Some(s) = self.srv() else { return Vec::new() };
        let app = s.app();
        app.vehicles.list().iter().map(|v| s.can().and_then(|c| c.car_summary(&super::footage::car_of(app, v))["modelLabel"].as_str().map(String::from))).collect()
    }
    fn clips_arrived(&self, since_ms: i64) -> (f64, f64) {
        let Some(s) = self.srv() else { return (0.0, 0.0) };
        let app = s.app();
        let (mut a, mut b) = (0.0, 0.0);
        for v in app.vehicles.list() {
            if let Some(st) = app.state_of(&v.id) {
                let (x, y) = crate::inventory::arrived_clips(&st.file_list, since_ms as f64);
                a += x as f64;
                b += y as f64;
            }
        }
        (a, b)
    }
    fn node_powers(&self) -> Vec<crate::ops::node_power::NodeRow> {
        self.srv().and_then(|s| s.nodes().map(|n| n.nodes.power_rows())).unwrap_or_default()
    }
    fn heartbeat_hardware(&self) -> Value {
        // convertStats.js heartbeatHardware: the CPU, the usable GPUs, the conversion speed, the paired nodes
        let Some(s) = self.srv() else { return Value::Null };
        let nodes = s.nodes().map(|n| n.nodes.hardware()).unwrap_or_default();
        let cpu = crate::ops::diag::cpu_model();
        match s.converter() {
            Some(c) => crate::converter::stats::heartbeat_hardware(&self.detect_gpus(), cpu.as_deref(), &c.convert_stats, &nodes, 8),
            None => {
                let gpus: Vec<Value> = crate::ops::gpu::usable_gpus(&self.detect_gpus()).iter().map(|g| g["name"].clone()).collect();
                json!({ "cpu": cpu, "gpus": gpus, "convert": { "fps": null, "encoder": null, "device": null, "api": null, "codec": null }, "nodes": nodes })
            }
        }
    }
    fn encoder_block(&self, snapshot: &Value, energy: &Value) -> Value {
        self.srv().and_then(|s| s.converter().map(|c| c.runtime.encoder_block(snapshot, energy))).unwrap_or(Value::Null)
    }
    fn trust_proxy(&self) -> bool {
        self.state.config.trust_proxy
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
            "gpus": self.detect_gpus(), "converter": { "ready": self.converter().ready },
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
