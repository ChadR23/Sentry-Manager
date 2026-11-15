//! The CAN area on today's lean server, until core/ lands: CanCtx on the
//! lean App (its vehicles, its last scans, its telemetry reader), settings in
//! DATA_PATH/lean-settings.json (the keys Node keeps in manager.db), a fixed
//! local admin (the lean server listens on loopback only, see README.md), and
//! live updates / audit lines written to the log. The coordinator replaces
//! this with core's AppState.

use super::ctx::{CanCtx, Car, FootFile, Rec, Scan, Who};
use super::routes::{Can, Req, Res};
use crate::app::App;
use axum::body::Bytes;
use axum::http::{HeaderMap, Method};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};

pub struct LeanCtx {
    app: Arc<App>,
    data: PathBuf,
    settings: Mutex<Map<String, Value>>,
}

impl LeanCtx {
    fn file(&self) -> PathBuf {
        self.data.join("lean-settings.json")
    }
}

fn camera_of(rel: &str) -> Option<String> {
    let name = rel.rsplit('/').next()?;
    let stem = name.strip_suffix(".mp4")?;
    super::search::ts_from(stem)?;
    stem.get(20..).map(String::from)
}

impl CanCtx for LeanCtx {
    fn data_dir(&self) -> PathBuf {
        self.data.clone()
    }
    fn can_port(&self) -> u16 {
        std::env::var("CAN_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(10000)
    }
    fn setting(&self, key: &str) -> Option<Value> {
        self.settings.lock().unwrap().get(key).cloned()
    }
    fn set_setting(&self, key: &str, value: Value) {
        let mut s = self.settings.lock().unwrap();
        s.insert(key.to_string(), value);
        let _ = super::format::write_atomic(&self.file(), super::json::stringify(&Value::Object(s.clone())).as_bytes());
    }
    fn vehicles(&self) -> Vec<Car> {
        self.app.vehicles.iter().map(|v| Car { id: v.id.clone(), name: v.name.clone(), timezone: v.timezone.clone(), root: Some(v.root.clone()), studio_root: Some(self.app.studio_root(v)), car: None }).collect()
    }
    fn scan_of(&self, vid: &str) -> Option<Scan> {
        let st = self.app.state_of(vid)?;
        let mut files = Vec::new();
        let recordings = st
            .recordings
            .iter()
            .map(|r| {
                for (rel, _) in &r.files {
                    let cam = camera_of(rel);
                    files.push(FootFile { rel: rel.clone(), kind: if cam.is_some() { "clip".into() } else { "other".into() }, camera: cam });
                }
                Rec { id: r.id.clone(), clip_rels: r.clip_rels.clone(), start_key: r.start_key.clone() }
            })
            .collect();
        Some(Scan { scanned: st.scanned, scanned_at: st.scanned_at, scanning: st.scanning, last_error: st.last_error.clone(), error_count: st.error_count, files, recordings, generation: Arc::as_ptr(&st.recordings) as u64 })
    }
    fn rescan(&self, vid: &str) -> Result<(), String> {
        self.app.scan(vid, false);
        Ok(())
    }
    fn announce(&self, topic: &str) {
        let _ = topic;
    }
    fn audit(&self, level: &str, line: &str) {
        eprintln!("[audit] {}: {}", level, line);
    }
    fn telemetry(&self, real: &Path) -> Result<Value, String> {
        let size = std::fs::metadata(real).map_err(|e| e.to_string())?.len();
        let frames = crate::telemetry::read_records(real, size).map_err(|_| "unreadable".to_string())?;
        Ok(serde_json::json!({ "frames": frames.iter().map(|(t, b)| serde_json::json!([super::json::n(*t), super::trust::base64(b)])).collect::<Vec<_>>() }))
    }
    fn resolve_clip(&self, path: &str) -> Option<PathBuf> {
        let roots: Vec<PathBuf> = self.app.vehicles.iter().map(|v| v.root.clone()).collect();
        crate::media::resolve_inside(path, &roots)
    }
    fn hidden_path(&self, real: &Path) -> bool {
        crate::media::hidden_path(&real.to_string_lossy())
    }
}

static CAN: OnceLock<Arc<Can>> = OnceLock::new();

/// The area, made (and its background started) the first time.
pub fn instance(app: &Arc<App>) -> Arc<Can> {
    CAN.get_or_init(|| {
        let data = PathBuf::from(std::env::var("DATA_PATH").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/data".into()));
        let settings = super::util::read_json(&data.join("lean-settings.json")).and_then(|v| v.as_object().cloned()).unwrap_or_default();
        let ctx: Arc<dyn CanCtx> = Arc::new(LeanCtx { app: app.clone(), data, settings: Mutex::new(settings) });
        let can = Can::new(ctx);
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            let host = std::env::var("HOST").ok().and_then(|h| h.parse().ok()).unwrap_or(std::net::IpAddr::from([127, 0, 0, 1]));
            super::port::attach(&can, rt, host);
        }
        can.start();
        can
    })
    .clone()
}

/// A request to the CAN routes from api.rs (None: not one of them).
pub fn handle(app: &Arc<App>, method: &Method, raw_path: &str, query: &HashMap<String, String>, headers: &HeaderMap, body: Bytes) -> Option<Res> {
    let can = instance(app);
    let req = Req {
        method: method.clone(),
        path: raw_path.to_string(),
        query: query.clone(),
        headers: headers.clone(),
        body,
        remote: "127.0.0.1".into(),
        local_port: std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(9000),
        encrypted: false,
        who: Who { by: "admin from 127.0.0.1".into(), owner: "admin".into(), admin_here: true },
        confirmed: true,
        closed: Arc::new(AtomicBool::new(false)),
    };
    can.handle(&req)
}

/// Whether a path is one of the CAN area's (its body is read for it).
pub fn owns(path: &str) -> bool {
    path.starts_with("/api/can/") || path == "/api/can/logs" || path == "/api/sentryusb" || (path.starts_with("/api/vehicles/") && path.contains("/sentry-usb"))
}
