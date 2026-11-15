//! `Ctx` on today's `App`, until core lands. Settings live in
//! DATA_PATH/lean-settings.json (core will keep them in manager.db, as
//! server/db.js does); live updates have no hub yet, so `announce` only
//! counts them.

use super::ctx::{Ctx, Files, VehicleRef};
use crate::app::App;
use crate::inventory::Recording;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub struct AppCtx {
    pub app: Arc<App>,
    data: PathBuf,
    settings: Mutex<Map<String, Value>>,
    files: Mutex<HashMap<String, (f64, Files)>>,
    /// topics announced (for the tests; core's hub sends them to /api/events)
    pub announced: Mutex<Vec<String>>,
}

impl AppCtx {
    pub fn new(app: Arc<App>, data: PathBuf) -> Arc<AppCtx> {
        let settings = std::fs::read_to_string(data.join("lean-settings.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default();
        Arc::new(AppCtx { app, data, settings: Mutex::new(settings), files: Mutex::new(HashMap::new()), announced: Mutex::new(Vec::new()) })
    }
}

impl Ctx for AppCtx {
    fn data_dir(&self) -> PathBuf {
        self.data.clone()
    }
    fn app_root(&self) -> PathBuf {
        self.app.app_root.clone()
    }
    fn vehicles(&self) -> Vec<VehicleRef> {
        self.app.vehicles.iter().map(|v| VehicleRef { id: v.id.clone(), name: v.name.clone(), timezone: v.timezone.clone(), root: v.root.clone() }).collect()
    }
    fn studio_root(&self, id: &str) -> Option<PathBuf> {
        self.app.vehicle(id).map(|v| self.app.studio_root(v))
    }
    fn files(&self, id: &str) -> Option<Files> {
        let stamp = self.scan_stamp(id)?;
        if let Some((s, f)) = self.files.lock().unwrap().get(id) {
            if *s == stamp {
                return Some(f.clone());
            }
        }
        let prev = self.app.catalog.previous(id).ok()?;
        let f: Files = Arc::new(prev.files);
        self.files.lock().unwrap().insert(id.to_string(), (stamp, f.clone()));
        Some(f)
    }
    fn recordings(&self, id: &str) -> Option<Arc<Vec<Recording>>> {
        self.app.state_of(id).filter(|s| s.scanned).map(|s| s.recordings)
    }
    fn scanning(&self, id: &str) -> bool {
        self.app.state_of(id).is_some_and(|s| s.scanning)
    }
    fn scan_stamp(&self, id: &str) -> Option<f64> {
        self.app.state_of(id).filter(|s| s.scanned).and_then(|s| s.scanned_at)
    }
    fn setting(&self, key: &str) -> Option<Value> {
        self.settings.lock().unwrap().get(key).cloned()
    }
    fn set_setting(&self, key: &str, value: Value) {
        let mut s = self.settings.lock().unwrap();
        s.insert(key.to_string(), value);
        let tmp = self.data.join("lean-settings.json.tmp");
        if std::fs::write(&tmp, Value::Object(s.clone()).to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, self.data.join("lean-settings.json"));
        }
    }
    fn announce(&self, topic: &str) {
        let mut a = self.announced.lock().unwrap();
        if a.len() >= 100 {
            a.remove(0);
        }
        a.push(topic.to_string());
    }
    fn audit(&self, line: &str) {
        eprintln!("audit: {line}");
    }
}
