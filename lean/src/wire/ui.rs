//! The ui area on core: `UiCtx` on core's state (manager.db settings, the
//! hub, the audit and app logs, core's jobs, who asks from the request being
//! answered, the footage area's vehicles, the viewer's speed index, the CAN
//! area's car-data switch); its routes, the pack upload and every page.

use super::{as_who, body_bytes, current, Server, Who};
use crate::core::db::{JobUpdate, NewJob};
use crate::core::http::{ApiRaw, WebReq};
use crate::core::{Ctx as CoreCtx, HttpError, Reply};
use crate::ui::ctx::{Level, ReqInfo, UiCtx, VehicleRef};
use axum::http::Method;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

pub struct CoreUi {
    srv: Weak<Server>,
    state: Arc<crate::core::AppState>,
}

impl CoreUi {
    fn srv(&self) -> Option<Arc<Server>> {
        self.srv.upgrade()
    }
}

fn job_fields(fields: &Value) -> (Option<String>, Option<Value>) {
    (fields.get("detail").and_then(Value::as_str).map(String::from), fields.get("result").cloned())
}

impl UiCtx for CoreUi {
    fn setting(&self, key: &str) -> Result<Option<Value>, String> {
        self.state.setting(key).map_err(|e| e.to_string())
    }
    fn set_setting(&self, key: &str, value: &Value) -> Result<(), String> {
        self.state.set_setting(key, value).map_err(|e| e.to_string())
    }
    fn has_setting_prefix(&self, prefix: &str) -> Result<bool, String> {
        use rusqlite::OptionalExtension;
        let c = self.state.db.reader();
        let hit = c.query_row("SELECT 1 FROM settings WHERE substr(key, 1, ?1) = ?2 LIMIT 1", rusqlite::params![prefix.encode_utf16().count() as i64, prefix], |_| Ok(())).optional();
        hit.map(|h| h.is_some()).map_err(|e| format!("manager.db: {e}"))
    }
    fn announce(&self, topic: &str) {
        self.state.announce(topic);
    }
    fn audit(&self, level: Level, line: &str) {
        match level {
            Level::Info => self.state.audit.info(line),
            Level::Warn => self.state.audit.warn(line),
        }
    }
    fn log(&self, level: Level, scope: &str, line: &str) {
        let s = self.state.logger.scope(scope);
        match level {
            Level::Info => s.info(line),
            Level::Warn => s.warn(line),
        }
    }
    fn user(&self, _req: &ReqInfo) -> Option<String> {
        current().and_then(|w| w.user)
    }
    fn session_hash(&self, _req: &ReqInfo) -> Option<String> {
        current().and_then(|w| w.session_hash)
    }
    fn recently_confirmed(&self, _req: &ReqInfo) -> bool {
        current().is_some_and(|w| w.confirmed)
    }
    fn is_secure(&self, _req: &ReqInfo) -> bool {
        current().is_some_and(|w| w.secure)
    }
    fn client_key(&self, _req: &ReqInfo) -> String {
        current().map(|w| w.client).unwrap_or_default()
    }
    fn pending_code(&self, _req: &ReqInfo) -> bool {
        // (core sends a sign-in waiting for its code to /login/code before a page is asked for)
        false
    }
    fn setup_only(&self, _req: &ReqInfo) -> bool {
        // (core sends an account that must set up two-step sign-in to /login/two-factor first)
        false
    }
    fn job_start(&self, fields: Value) -> Result<Value, String> {
        let s = |k: &str| fields.get(k).and_then(Value::as_str).map(String::from);
        let id = self.state.jobs.start(NewJob { kind: s("type").unwrap_or_default(), vehicle_id: s("vehicleId"), title: s("title").unwrap_or_default(), detail: s("detail"), external_id: None });
        id.map(|id| json!(id)).map_err(|e| e.to_string())
    }
    fn job_update(&self, id: &Value, fields: Value) {
        let Some(id) = id.as_i64() else { return };
        let (detail, result) = job_fields(&fields);
        if let Err(e) = self.state.jobs.update(id, JobUpdate { status: fields.get("status").and_then(Value::as_str).map(String::from), detail, result, finished: false }) {
            self.state.logger.scope("export").warn(format!("Job {id} was not updated: {e}"));
        }
    }
    fn job_finish(&self, id: &Value, fields: Value) {
        let Some(id) = id.as_i64() else { return };
        let (detail, result) = job_fields(&fields);
        if let Err(e) = self.state.jobs.finish(id, fields.get("status").and_then(Value::as_str), detail, result) {
            self.state.logger.scope("export").warn(format!("The end of job {id} was not kept: {e}"));
        }
    }
    fn vehicle(&self, id: &str) -> Option<VehicleRef> {
        self.srv()?.app().vehicle(id).map(|v| VehicleRef { id: v.id, name: v.name })
    }
    fn resolve_footage(&self, p: &str) -> Option<(PathBuf, VehicleRef)> {
        let s = self.srv()?;
        let app = s.app();
        let roots: Vec<PathBuf> = app.vehicles.list().into_iter().map(|v| v.root).collect();
        let real = crate::media::resolve_inside(p, &roots)?;
        if crate::media::hidden_path(&real.to_string_lossy()) {
            return None;
        }
        let v = app.vehicles.vehicle_for_path(&real)?;
        Some((real, VehicleRef { id: v.id, name: v.name }))
    }
    fn speeds_for(&self, real: &Path) -> Option<Vec<Option<f64>>> {
        // index.js speedsFor: the speed index's clip(), for the vehicle the clip is in
        let s = self.srv()?;
        let viewer = s.viewer()?.clone();
        let v = s.app().vehicles.vehicle_for_path(real)?;
        let rel = real.strip_prefix(std::fs::canonicalize(&v.root).unwrap_or(v.root.clone())).ok()?.to_string_lossy().into_owned();
        let md = std::fs::metadata(real).ok()?;
        use std::os::unix::fs::MetadataExt;
        let mtime = crate::scanner::ms_of(md.mtime(), md.mtime_nsec());
        let sp = viewer.speed_index.clip(Some(&v.id), Some(&rel), real, md.len(), mtime);
        Some(sp.as_array()?.iter().map(Value::as_f64).collect())
    }
    fn viewer_car_data(&self) -> Result<Value, String> {
        match self.srv().and_then(|s| s.can().cloned()) {
            Some(can) => can.viewer_car_data(),
            None => Ok(json!({ "enabled": false })),
        }
    }
}

pub fn make(srv: &Arc<Server>) -> Arc<crate::ui::Ui> {
    let cfg = &srv.state.config;
    let ctx = Arc::new(CoreUi { srv: Arc::downgrade(srv), state: srv.state.clone() });
    crate::ui::Ui::new(crate::ui::UiConfig::from_env(cfg.app_root.clone(), cfg.data.clone()), ctx)
}

fn ui_req(c: &CoreCtx, body: bytes::Bytes) -> crate::ui::http::Req {
    crate::ui::http::Req {
        method: c.method.clone(),
        raw_path: c.raw_path.clone(),
        search: c.raw_query.as_ref().map(|q| format!("?{q}")).unwrap_or_default(),
        query: c.query.clone(),
        headers: c.headers.clone(),
        body,
        peer: c.conn.peer,
    }
}

/// A ui route for core's router.
pub fn answer(srv: &Arc<Server>, c: &mut CoreCtx) -> Result<Reply, HttpError> {
    let Some(ui) = srv.ui().cloned() else { return Err(HttpError::not_found()) };
    let req = ui_req(c, body_bytes(c));
    match as_who(Who::of(c), || ui.api(&req, &c.path)) {
        Some(res) => super::raw(res, c),
        None => Err(HttpError::not_found()),
    }
}

/// POST /api/ui-packs/upload: the .zip as the raw body (index.js: Use POST, the password
/// again, then the body up to MAX_UI_PACK_BYTES).
pub async fn upload(srv: Arc<Server>, a: ApiRaw) -> crate::core::http::Res {
    let Some(ui) = srv.ui().cloned() else { return crate::core::http::error_json(404, "Not found", None, "") };
    let c = a.ctx;
    let who = Who::of(&c);
    let max = crate::ui::packs::MAX_ZIP_BYTES as usize;
    let mut body = bytes::Bytes::new();
    if c.method == Method::POST && who.confirmed {
        let declared = c.headers.get(axum::http::header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
        if declared.is_some_and(|d| d > max as u64) {
            return crate::core::http::error_json(413, "That file is too large.", None, c.accept_encoding());
        }
        body = match crate::core::body::collect(a.body, max).await {
            Ok(b) => b,
            Err(crate::core::body::BodyError::TimedOut) => return crate::core::body::timed_out(c.accept_encoding()),
            Err(_) => return crate::core::http::error_json(413, "That file is too large.", None, c.accept_encoding()),
        };
    }
    tokio::task::spawn_blocking(move || {
        let req = ui_req(&c, body);
        as_who(who, || ui.api(&req, "/api/ui-packs/upload")).unwrap_or_else(|| crate::core::http::error_json(404, "Not found", None, ""))
    })
    .await
    .unwrap_or_else(|_| crate::core::http::error_json(500, "Internal error", None, ""))
}

/// A page or file (after core's sign-in checks and redirects).
pub fn page(srv: &Arc<Server>, w: WebReq) -> crate::core::http::Res {
    let Some(ui) = srv.ui().cloned() else { return crate::core::http::error_json(404, "Not found", None, "") };
    let view = crate::core::auth::ReqView { secure: w.secure, cookie: w.headers.get("cookie").and_then(|v| v.to_str().ok()).unwrap_or(""), agent: "" };
    let who = Who { user: w.user.clone(), client: w.client.clone(), secure: w.secure, confirmed: w.state.auth.recently_confirmed(&view), session_hash: w.session_hash.clone() };
    let req = crate::ui::http::Req {
        method: w.method.clone(),
        raw_path: w.path.clone(),
        search: w.raw_query.as_ref().map(|q| format!("?{q}")).unwrap_or_default(),
        query: w.query.clone(),
        headers: w.headers.clone(),
        body: bytes::Bytes::new(),
        peer: None,
    };
    as_who(who, || {
        let long_cache = w.version.as_deref().is_some_and(|v| v == ui.asset_version(&req));
        ui.page(&req, &crate::ui::Unversioned { path: w.path.clone(), version: w.version.clone(), long_cache })
    })
}
