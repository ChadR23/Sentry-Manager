//! The footage area on core: `footage::ctx::Ctx` on core's state (manager.db,
//! announce, audit, logs, jobs, the supervisor's mounter) with its hooks into
//! the CAN area (car, CAN tags, CAN logs that go with footage, Sentry USB) and
//! ops (share alerts, savings); its routes through core's router.

use super::{raw, Server};
use crate::app::App;
use crate::core::db::NewJob;
use crate::core::{Ctx as CoreCtx, HttpError, Reply};
use crate::footage::ctx::{Caller, Ctx, Level, Mounter, SupervisorMounter};
use crate::footage::mdb::ManagerDb;
use crate::footage::vehicles::{Options, Vehicles};
use crate::inventory::Recording;
use crate::media;
use crate::thumbnails::Thumbnails;
use axum::http::{Method, StatusCode};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock, Weak};

pub struct FootageCtx {
    srv: Weak<Server>,
    mdb: ManagerDb,
    data: PathBuf,
    mounter: OnceLock<Arc<dyn Mounter>>,
}

impl FootageCtx {
    fn srv(&self) -> Option<Arc<Server>> {
        self.srv.upgrade()
    }
}

/// The car of a vehicle as the CAN area sees it.
pub fn car_of(app: &App, v: &crate::footage::vehicles::Vehicle) -> crate::can::ctx::Car {
    crate::can::ctx::Car {
        id: v.id.clone(),
        name: v.name.clone(),
        timezone: v.timezone.clone(),
        root: Some(v.root.clone()),
        studio_root: Some(app.studio_root(v)),
        car: v.raw.get("car").filter(|c| !c.is_null()).cloned(),
    }
}

/// A recording as the CAN area's tags read it.
pub fn rec_of(r: &Recording) -> crate::can::ctx::Rec {
    crate::can::ctx::Rec { id: r.id.clone(), clip_rels: r.clip_rels().map(String::from).collect(), start_key: r.start_key.clone() }
}

fn scope_log(state: &crate::core::AppState, scope: &str, level: Level, line: &str) {
    let s = state.logger.scope(scope);
    match level {
        Level::Info => s.info(line),
        Level::Warn => s.warn(line),
        Level::Error => s.error(line),
    }
}

impl Ctx for FootageCtx {
    fn db(&self) -> &ManagerDb {
        &self.mdb
    }
    fn data_dir(&self) -> PathBuf {
        self.data.clone()
    }
    fn announce(&self, topic: &str) {
        if let Some(s) = self.srv() {
            s.state.announce(topic);
        }
    }
    fn audit(&self, level: Level, line: &str) {
        if let Some(s) = self.srv() {
            match level {
                Level::Info => s.state.audit.info(line),
                Level::Warn => s.state.audit.warn(line),
                Level::Error => s.state.audit.error(line),
            }
        }
    }
    fn log(&self, scope: &str, level: Level, line: &str) {
        if let Some(s) = self.srv() {
            scope_log(&s.state, scope, level, line);
        }
    }
    fn job_start(&self, typ: &str, vehicle_id: Option<&str>, title: &str) -> i64 {
        let Some(s) = self.srv() else { return 0 };
        s.state.jobs.start(NewJob { kind: typ.into(), vehicle_id: vehicle_id.map(String::from), title: title.into(), detail: None, external_id: None })
    }
    fn job_finish(&self, id: i64, status: &str, detail: &str, result: Option<Value>) {
        if let Some(s) = self.srv() {
            s.state.jobs.finish(id, Some(status), Some(detail.to_string()), result);
        }
    }
    fn busy_paths(&self) -> std::collections::HashSet<PathBuf> {
        self.srv().and_then(|s| s.converter().map(|c| c.busy_paths().into_iter().map(PathBuf::from).collect())).unwrap_or_default()
    }
    fn mounter(&self) -> Option<Arc<dyn Mounter>> {
        self.mounter.get().cloned()
    }
    fn on_deleted(&self, vehicle_id: &str, item: &Value) {
        let Some(can) = self.srv().and_then(|s| s.can().cloned()) else { return };
        let rels: Vec<String> = item["files"].as_array().map(|f| f.iter().filter_map(|x| x["rel"].as_str().map(String::from)).collect()).unwrap_or_default();
        can.prune.footage_gone(vehicle_id, &rels);
    }
    fn share_status(&self, vehicle_id: &str, _status: &Value) {
        let Some(s) = self.srv() else { return };
        let Some(ops) = s.ops().cloned() else { return };
        if let Some(v) = super::ops::vehicle_info(&s, vehicle_id) {
            ops.notes.sync_share(&v, v.status.as_ref());
        }
    }
    fn saved(&self, vehicle_id: &str) -> Value {
        match self.srv() {
            Some(s) => crate::ops::power::for_vehicle(&s.state.db.reader(), vehicle_id),
            None => json!({ "bytes": 0, "clips": 0 }),
        }
    }
    fn reset_saved(&self, vehicle_id: &str) {
        if let Some(s) = self.srv() {
            crate::ops::power::reset(&s.state.db.conn(), vehicle_id);
        }
    }
    fn car_summary(&self, vehicle: &Value) -> Value {
        let Some(s) = self.srv() else { return Value::Null };
        let (Some(can), Some(id)) = (s.can().cloned(), vehicle["id"].as_str()) else { return Value::Null };
        let app = s.app();
        match app.vehicle(id) {
            Some(v) => can.car_summary(&car_of(app, &v)),
            None => Value::Null,
        }
    }
    fn can_with(&self, vehicle_id: &str, rels: &[String], until: Option<f64>) -> Option<Value> {
        // index.js canWith: deleteWith as a dry run; null when no key is mapped to the car
        let can = self.srv()?.can()?.clone();
        let r = can.prune.delete_with(vehicle_id, rels, until, "", true);
        let skip = r["skip"].as_str();
        if r.is_null() || matches!(skip, Some("no CAN Bridge key is mapped to this car" | "no such car")) {
            return None;
        }
        let mut out = json!({ "logs": r.get("logs").filter(|x| !x.is_null()).cloned().unwrap_or(json!(0)), "kept": r.get("kept").filter(|x| !x.is_null()).cloned().unwrap_or(json!(0)) });
        if let Some(sk) = skip {
            out["skip"] = json!(sk);
        }
        Some(out)
    }
    fn can_delete_with(&self, vehicle_id: &str, rels: &[String], until: Option<f64>, by: &str) -> Option<Value> {
        let can = self.srv()?.can()?.clone();
        Some(can.prune.delete_with(vehicle_id, rels, until, by, false))
    }
    fn vehicle_removed(&self, vehicle_id: &str) {
        let Some(s) = self.srv() else { return };
        crate::ops::power::forget(&s.state.db.conn(), vehicle_id);
        // archiveGapRef.forget, driveData.forget
        if let Some(v) = s.viewer() {
            v.archive.forget(vehicle_id);
            v.drive_data.forget(vehicle_id);
        }
        if let Some(can) = s.can() {
            can.usb.forget(vehicle_id);
        }
        if let Some(n) = s.nodes() {
            n.forget_vehicle(vehicle_id);
        }
        // arrivalRef.forget and the vehicle's sentry-usb-record entry
        if let Some(a) = s.arrival() {
            let ctx = super::arrival::CoreArrival::new(&s);
            crate::arrival::routes::vehicle_removed(&a.arrival, &ctx, vehicle_id);
        }
    }
    fn has_can(&self, vehicle_id: &str) -> Option<Box<dyn Fn(&Recording) -> bool>> {
        let s = self.srv()?;
        let can = s.can()?.clone();
        let v = s.app().vehicle(vehicle_id)?;
        let f = can.has_can(&car_of(s.app(), &v));
        Some(Box::new(move |r: &Recording| f(&rec_of(r))))
    }
    fn sentry_usb(&self, vehicle_id: &str) -> Value {
        match self.srv().and_then(|s| s.can().cloned()) {
            Some(can) => can.usb.api(vehicle_id),
            None => json!({ "present": false }),
        }
    }
}

/// The vehicles, the catalog in manager.db, the scans: the App every area reads.
pub fn make(srv: &Arc<Server>) -> Arc<App> {
    let st = &srv.state;
    let cfg = &st.config;
    let ctx = Arc::new(FootageCtx { srv: Arc::downgrade(srv), mdb: ManagerDb::of_core(st.db.clone()), data: cfg.data.clone(), mounter: OnceLock::new() });
    let options = Options::from_env(&cfg.data, &cfg.app_root);
    // SMB vehicles: the root supervisor's mounter over its channel when it started us, else a
    // local one, as index.js (createIpcMounter / createLocalMounter: PUID / PGID, RUN_DIR)
    let inner: Arc<dyn crate::supervisor::mounter::Mounter> = match st.supervisor.get() {
        Some(link) => Arc::new(crate::supervisor::link::IpcMounter::new(link.clone(), options.footage_root.clone())),
        None => {
            let id = |k: &str, own: u32| cfg.env.get(k).and_then(|v| v.parse().ok()).unwrap_or(own);
            let (uid, gid) = (id("PUID", unsafe { libc::getuid() }), id("PGID", unsafe { libc::getgid() }));
            Arc::new(crate::supervisor::mounter::LocalMounter::new(options.footage_root.clone(), cfg.run_dir.clone(), uid, gid))
        }
    };
    let _ = ctx.mounter.set(Arc::new(SupervisorMounter::new(inner, srv.rt.clone())));
    let core: Arc<dyn Ctx> = ctx;
    let vehicles = Vehicles::new(core.clone(), options);
    let catalog = crate::catalog::Catalog::open(&cfg.db_file()).expect("manager.db (footage catalog)");
    // (as many at once as the thumbnails work limit, clip strips included; two before the Viewer starts)
    let thumbnails = Thumbnails::with_slots(cfg.data.join("thumbnails"), cfg.ffmpeg.clone(), crate::thumbnails::server_slots());
    App::new(vehicles, core, catalog, cfg.app_root.clone(), thumbnails)
}

/// A footage route (footage/routes.rs) for core's router.
pub fn answer(srv: &Arc<Server>, c: &mut CoreCtx) -> Result<Reply, HttpError> {
    let app = srv.app();
    // (router.js: each part decoded; core matched the route, so each does)
    let parts: Vec<String> = c.raw_path.trim_start_matches("/api/").split('/').map(|s| crate::api::decode(s, false).unwrap_or_default()).collect();
    let refs: Vec<&str> = parts.iter().map(String::as_str).collect();
    let m = if c.method == Method::HEAD { "GET".to_string() } else { c.method.as_str().to_string() };
    let user = c.user.clone();
    let who = Caller {
        admin_here: user.as_deref().is_some_and(|u| c.state.admin_here(&c.client, u)),
        confirmed: c.state.auth.recently_confirmed(&c.view()),
        user,
        client: c.client.clone(),
    };
    let Some(out) = crate::footage::routes::handle(app, &who, &m, &refs, &c.query, c.body.as_ref()) else { return Err(HttpError::not_found()) };
    match out {
        Ok(crate::footage::routes::Reply::Json(v)) => Ok(Reply::json(v)),
        Ok(crate::footage::routes::Reply::Thumbnail { file, clip }) => {
            let roots: Vec<PathBuf> = app.vehicles.list().into_iter().map(|v| v.root).collect();
            let res = if !clip {
                media::send_media(&c.method, &c.headers, &file, &roots)
            } else {
                match app.thumbnails.for_clip(&file) {
                    Ok(Some(t)) => media::send_media(&c.method, &c.headers, &t, std::slice::from_ref(&app.thumbnails.dir)),
                    Ok(None) => crate::api::json_response(StatusCode::NOT_FOUND, &json!({ "error": "No thumbnail" })),
                    Err(e) => return Err(HttpError::internal(e.to_string())),
                }
            };
            raw(res, c)
        }
        Err(f) => Err(http_error(f)),
    }
}

/// The footage area's error as it reaches a person: its status and text under 500, and 503 (the
/// footage cannot be reached right now, which they can act on); any other a plain internal error.
pub(super) fn http_error(f: crate::footage::ctx::Fail) -> HttpError {
    let (status, v) = f.body();
    if status >= 500 && status != 503 {
        return HttpError::internal(f.message);
    }
    let mut e = HttpError::new(status, v["error"].as_str().unwrap_or("Error"));
    if let Some(code) = v["code"].as_str() {
        e = e.code(code);
    }
    e
}

#[cfg(test)]
mod http_error_tests {
    use super::http_error;
    use crate::footage::ctx::Fail;

    #[test]
    fn a_footage_error_keeps_its_status_and_text_under_500_and_at_503() {
        let unread = http_error(Fail::new(503, "Car: the footage folder could not be read."));
        assert_eq!((unread.status, unread.message.as_str(), unread.explicit), (503, "Car: the footage folder could not be read.", true));
        let missing = http_error(Fail::new(404, "No such vehicle."));
        assert_eq!((missing.status, missing.message.as_str()), (404, "No such vehicle."));
        let internal = http_error(Fail::new(500, "a stack trace"));
        assert_eq!((internal.status, internal.explicit), (500, false), "answered as Internal error, its text only logged");
    }
}
