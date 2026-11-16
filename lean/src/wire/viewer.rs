//! The viewer area on core: `viewer::ctx::Ctx` on core's state (manager.db
//! settings, the hub, the audit log naming who asked, ops' notifications for
//! the archive gaps, the CAN area's keys, the footage area's vehicles and
//! scans); its routes through core's router.

use super::{as_who, body_bytes, current, Server, Who};
use crate::core::{Ctx as CoreCtx, HttpError, Reply};
use crate::inventory::Recording;
use crate::viewer::ctx::{Ctx, Files, VehicleRef};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};

pub struct CoreViewer {
    srv: Weak<Server>,
    state: Arc<crate::core::AppState>,
    /// the last scan's files by rel, per vehicle, with the scan they come from
    files: Mutex<HashMap<String, (f64, Files)>>,
}

impl CoreViewer {
    fn srv(&self) -> Option<Arc<Server>> {
        self.srv.upgrade()
    }
}

impl Ctx for CoreViewer {
    fn data_dir(&self) -> PathBuf {
        self.state.config.data.clone()
    }
    fn app_root(&self) -> PathBuf {
        self.state.config.app_root.clone()
    }
    fn vehicles(&self) -> Vec<VehicleRef> {
        let Some(s) = self.srv() else { return Vec::new() };
        s.app().vehicles.list().into_iter().map(|v| VehicleRef { id: v.id, name: v.name, timezone: v.timezone, root: v.root }).collect()
    }
    fn vehicle(&self, id: &str) -> Option<VehicleRef> {
        let v = self.srv()?.app().vehicle(id)?;
        Some(VehicleRef { id: v.id, name: v.name, timezone: v.timezone, root: v.root })
    }
    fn studio_root(&self, id: &str) -> Option<PathBuf> {
        let s = self.srv()?;
        let app = s.app();
        app.vehicle(id).map(|v| app.studio_root(&v))
    }
    fn files(&self, id: &str) -> Option<Files> {
        let s = self.srv()?;
        let st = s.app().state_of(id).filter(|st| st.scanned)?;
        let stamp = st.scanned_at?;
        let mut cache = self.files.lock().unwrap();
        if let Some((at, f)) = cache.get(id) {
            if *at == stamp && f.len() == st.file_list.len() {
                return Some(f.clone());
            }
        }
        let f: Files = Arc::new(st.file_list.iter().map(|e| (e.rel.clone(), e.clone())).collect());
        cache.insert(id.to_string(), (stamp, f.clone()));
        Some(f)
    }
    fn recordings(&self, id: &str) -> Option<Arc<Vec<Recording>>> {
        self.srv()?.app().state_of(id).filter(|s| s.scanned).map(|s| s.recordings)
    }
    fn scanning(&self, id: &str) -> bool {
        self.srv().is_some_and(|s| s.app().state_of(id).is_some_and(|s| s.scanning))
    }
    fn scan_stamp(&self, id: &str) -> Option<f64> {
        self.srv()?.app().state_of(id).filter(|s| s.scanned).and_then(|s| s.scanned_at)
    }
    fn setting(&self, key: &str) -> Option<Value> {
        self.state.setting(key)
    }
    fn set_setting(&self, key: &str, value: Value) {
        self.state.set_setting(key, &value);
    }
    fn announce(&self, topic: &str) {
        self.state.announce(topic);
    }
    fn audit(&self, line: &str) {
        self.state.audit.info(line);
    }
    fn busy(&self) -> bool {
        // index.js speedIndexBusy: a conversion runs (the benchmark is not ported)
        self.srv().and_then(|s| s.converter().map(|c| c.running())).unwrap_or(false)
    }
    fn refuse_admin(&self, _headers: &axum::http::HeaderMap) -> Option<(u16, String)> {
        // (core refused a watch-only account, or an admin away from home where that is the
        // rule, before the route ran: accounts.js viewerMay, access.js)
        None
    }
    fn who(&self) -> String {
        current().map(|w| w.by()).unwrap_or_else(|| "someone from ?".into())
    }
    fn extra_roots(&self) -> Vec<PathBuf> {
        self.state.config.extra_roots.iter().map(PathBuf::from).collect()
    }
    fn can_keys(&self, id: &str) -> Vec<String> {
        self.srv().and_then(|s| s.can().map(|c| c.keys_for(id))).unwrap_or_default()
    }
    fn encoded(&self, id: &str) -> HashSet<String> {
        let Some(s) = self.srv() else { return HashSet::new() };
        s.app().state_of(id).map(|st| st.codecs.iter().filter(|(_, c)| matches!(c.as_deref(), Some("h265") | Some("av1"))).map(|(r, _)| r.clone()).collect()).unwrap_or_default()
    }
    fn open_notes(&self, id: &str, kind: &str) -> Vec<String> {
        let Some(ops) = self.srv().and_then(|s| s.ops().cloned()) else { return Vec::new() };
        ops.notes.list(true, Some(id)).into_iter().filter(|n| n["kind"].as_str() == Some(kind)).filter_map(|n| n["dedupeKey"].as_str().map(String::from)).collect()
    }
    fn raise_note(&self, note: &Value) -> bool {
        let Some(ops) = self.srv().and_then(|s| s.ops().cloned()) else { return false };
        let s = |k: &str| note.get(k).and_then(Value::as_str).map(String::from);
        let n = crate::ops::store::Note {
            kind: s("kind").unwrap_or_default(),
            level: s("level").unwrap_or_else(|| "warning".into()),
            vehicle_id: s("vehicleId"),
            title: s("title").unwrap_or_default(),
            message: s("message"),
            dedupe_key: s("dedupeKey"),
        };
        ops.notes.raise(&n).is_some()
    }
    fn resolve_note(&self, dedupe_key: &str) {
        if let Some(ops) = self.srv().and_then(|s| s.ops().cloned()) {
            ops.notes.resolve(dedupe_key);
        }
    }
    fn ffmpeg(&self) -> String {
        self.state.config.ffmpeg.clone()
    }
    fn ffprobe(&self) -> Option<String> {
        Some(self.state.config.ffprobe.clone())
    }
}

pub fn make(srv: &Arc<Server>) -> Arc<crate::viewer::Viewer> {
    crate::viewer::Viewer::start(Arc::new(CoreViewer { srv: Arc::downgrade(srv), state: srv.state.clone(), files: Mutex::new(HashMap::new()) }))
}

/// A viewer route for core's router.
pub fn answer(srv: &Arc<Server>, c: &mut CoreCtx) -> Result<Reply, HttpError> {
    let Some(viewer) = srv.viewer().cloned() else { return Err(HttpError::not_found()) };
    let body = body_bytes(c);
    let req = crate::viewer::routes::Req { method: &c.method, path: &c.path, query: &c.query, headers: &c.headers, body: &body };
    match as_who(Who::of(c), || viewer.route(&req)) {
        Some(res) => super::raw(res, c),
        None => Err(HttpError::not_found()),
    }
}

/// /api/scrub (answered by hand, after core's checks).
pub fn scrub(srv: &Arc<Server>, c: &CoreCtx) -> crate::core::http::Res {
    let Some(viewer) = srv.viewer().cloned() else { return crate::core::http::error_json(404, "Not found", None, "") };
    let req = crate::viewer::routes::Req { method: &c.method, path: "/api/scrub", query: &c.query, headers: &c.headers, body: &[] };
    as_who(Who::of(c), || viewer.route(&req)).unwrap_or_else(|| crate::core::http::error_json(404, "Not found", None, ""))
}
