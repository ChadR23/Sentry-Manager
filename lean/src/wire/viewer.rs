//! The viewer area on core: `viewer::ctx::Ctx` on core's state (manager.db
//! settings, the hub, the audit log naming who asked, ops' notifications for
//! the archive gaps, the CAN area's keys, the footage area's vehicles and
//! scans); its routes through core's router.

use super::{as_who, body_bytes, current, Server, Who};
use crate::core::{Ctx as CoreCtx, HttpError, Reply};
use crate::inventory::Recording;
use crate::viewer::ctx::{Ctx, Files, VehicleRef};
use serde_json::Value;
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Weak};

pub struct CoreViewer {
    srv: Weak<Server>,
    state: Arc<crate::core::AppState>,
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
        st.scanned_at?;
        Some(st.file_list.clone())
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
    fn has_can(&self, id: &str) -> Option<Box<dyn Fn(Vec<String>, Option<&str>) -> bool>> {
        let s = self.srv()?;
        let can = s.can()?.clone();
        let v = s.app().vehicle(id)?;
        let f = can.has_can(&super::footage::car_of(s.app(), &v));
        Some(Box::new(move |rels: Vec<String>, start: Option<&str>| f(&crate::can::ctx::Rec { id: String::new(), clip_rels: rels, start_key: start.map(String::from) })))
    }
    fn sentry_usb_pi(&self, id: &str) -> Option<crate::viewer::archive_gap::Pi> {
        // index.js sentryUsbFor: the range Sentry USB is still copying (sentryUsb.now)
        let can = self.srv()?.can().cloned()?;
        let n = can.usb.now(id);
        let (first, last) = n.range.filter(|_| n.transferring)?;
        let stamp = crate::viewer::archive_gap::stamp_sec;
        Some(crate::viewer::archive_gap::Pi { overdue: n.overdue, first_s: stamp(&first).unwrap_or(f64::NAN), last_s: stamp(&last) })
    }
    fn snapshots(&self, id: &str) -> Option<crate::viewer::archive_gap::Snaps> {
        // sentryUsb.snapshots(vid): snapshotInfo of the last status
        let can = self.srv()?.can().cloned()?;
        let st = can.usb.get(id)?;
        let snaps = st.snapshots.as_ref()?;
        let interval = st.snapshot_interval_s.unwrap_or(crate::can::sentry_usb::DEFAULT_INTERVAL_S);
        let gaps = crate::can::sentry_usb::snapshot_gaps(snaps, interval).into_iter().map(|g| (g.from_unix as f64, g.to_unix as f64, g.seconds as f64, g.lost_to_unix.map(|x| x as f64))).collect();
        Some(crate::viewer::archive_gap::Snaps { interval_s: interval as f64, gaps })
    }
    fn car_files(&self, id: &str) -> Option<crate::viewer::archive_gap::CarFilesIn> {
        // sentryUsb.carFiles(vid): the list, the file's time, and when the Pi last archived
        let can = self.srv()?.can().cloned()?;
        let cf = can.usb.car_files(id)?;
        let archived = crate::can::sentry_usb::archived_since(can.usb.get(id).as_ref()).map(|x| x as f64);
        Some(crate::viewer::archive_gap::CarFilesIn { list: cf.list.clone(), error: cf.error.clone(), file_unix: (cf.mtime / 1000.0).floor(), archived_unix: archived })
    }
    fn binned(&self, id: &str) -> Option<Vec<String>> {
        Some(self.state.db.bin_items(Some(id)).into_iter().flat_map(|b| b.files.as_array().cloned().unwrap_or_default()).filter_map(|f| f["rel"].as_str().map(String::from)).collect())
    }
    fn deleted_clips(&self, id: &str) -> Option<Vec<String>> {
        let s = self.srv()?;
        Some(crate::footage::deleted_clips::list(s.app().core.db(), id, crate::footage::js::now()))
    }
    fn encoded(&self, id: &str) -> HashSet<String> {
        let Some(s) = self.srv() else { return HashSet::new() };
        s.app().state_of(id).map(|st| st.codecs.iter().filter(|(_, c)| matches!(c, Some("h265") | Some("av1"))).map(|(r, _)| r.to_string()).collect()).unwrap_or_default()
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
    crate::viewer::Viewer::start(Arc::new(CoreViewer { srv: Arc::downgrade(srv), state: srv.state.clone() }))
}

/// A viewer route for core's router.
pub fn answer(srv: &Arc<Server>, c: &mut CoreCtx) -> Result<Reply, HttpError> {
    if c.path == "/api/studio/trashFolder" {
        return trash_folder(srv, c);
    }
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

/// POST /api/studio/trashFolder (index.js): Studio's "delete folder" (the trash icon on an
/// event) moves the recordings in that folder to the Recycle Bin, through the footage area,
/// in Node's order: the path confined to `allowed` (the vehicles' folders and the output
/// folders, the deny list, never the bin), the vehicle it is in, a scan when there is none
/// yet, the recordings in that folder or below, then the bin's own checks (the share
/// writable, protected, in a conversion's hands).
pub fn trash_folder(srv: &Arc<Server>, c: &mut CoreCtx) -> Result<Reply, HttpError> {
    let Some(viewer) = srv.viewer().cloned() else { return Err(HttpError::not_found()) };
    let body = c.body.clone().unwrap_or(Value::Null);
    let guard = crate::viewer::studio::allowed(viewer.ctx.as_ref());
    let real = crate::viewer::studio::confined(&guard, &body).map_err(|(s, m)| HttpError::new(s, m))?;
    let app = srv.app().clone();
    // vehicleForReal: the share's real folder first, then the one it is named by
    let found = app.vehicles.list().into_iter().find_map(|v| {
        let real_root = std::fs::canonicalize(&v.root).unwrap_or_else(|_| v.root.clone());
        if crate::footage::vehicles::is_inside(&real, &real_root) {
            return Some((v, real_root));
        }
        if crate::footage::vehicles::is_inside(&real, &v.root) {
            let r = v.root.clone();
            return Some((v, r));
        }
        None
    });
    let Some((v, root)) = found else { return Err(HttpError::new(403, "Not inside a vehicle share.")) };
    // (as the footage area's errors reach core: a status under 500 with its text)
    let fail = |f: crate::footage::ctx::Fail| {
        let (status, body) = f.body();
        if status >= 500 {
            return HttpError::internal(f.message);
        }
        let mut e = HttpError::new(status, body["error"].as_str().unwrap_or("Error"));
        if let Some(code) = body["code"].as_str() {
            e = e.code(code);
        }
        e
    };
    if !app.state_of(&v.id).is_some_and(|s| s.scanned) {
        app.scan_now(&v.id, false).map_err(fail)?;
    }
    let rel = real.strip_prefix(&root).map(|r| r.to_string_lossy().into_owned()).unwrap_or_default();
    let below = format!("{rel}/");
    let ids: Vec<String> = app
        .state_of(&v.id)
        .map(|s| s.recordings.iter().filter(|x| x.folder == rel || x.folder.starts_with(&below)).map(|x| x.id.clone()).collect())
        .unwrap_or_default();
    if ids.is_empty() {
        return Ok(Reply::json(serde_json::json!({ "success": false, "error": "Nothing to move to the Recycle Bin in that folder." })));
    }
    let out = crate::footage::bin::trash(&app, &v.id, &ids, "manual").map_err(fail)?;
    srv.state.announce("inventory");
    srv.state.announce("bin");
    Ok(Reply::json(if !out.skipped.is_empty() && out.moved.is_empty() {
        let error = match out.skipped[0].reason {
            "protected" => "This recording is protected.",
            "converting" => "This recording is being converted right now.",
            _ => "Could not move it to the Recycle Bin.",
        };
        serde_json::json!({ "success": false, "error": error })
    } else {
        serde_json::json!({ "success": true })
    }))
}
