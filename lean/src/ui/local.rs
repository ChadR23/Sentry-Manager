//! UiCtx for today's lean server, until core lands: one local admin (there are
//! no accounts yet, so the server only listens on loopback), the settings in
//! a table of the same shape as manager.db's (`DATA_PATH/lean-settings.sqlite`),
//! jobs kept in memory, live updates and audit lines written to the log.

use super::ctx::{Level, ReqInfo, UiCtx, VehicleRef};
use crate::app::App;
use crate::media;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub struct LocalCtx {
    app: Arc<App>,
    data: PathBuf,
    db: Mutex<Connection>,
    jobs: Mutex<Vec<Value>>,
}

impl LocalCtx {
    pub fn open(app: Arc<App>, data: &Path) -> rusqlite::Result<LocalCtx> {
        let db = Connection::open(data.join("lean-settings.sqlite"))?;
        db.execute_batch("PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")?;
        Ok(LocalCtx { app, data: data.to_path_buf(), db: Mutex::new(db), jobs: Mutex::new(Vec::new()) })
    }

    /// The jobs the ui area started (there is no /api/jobs here yet).
    pub fn jobs(&self) -> Vec<Value> {
        self.jobs.lock().unwrap().clone()
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl UiCtx for LocalCtx {
    fn setting(&self, key: &str) -> Option<Value> {
        let db = self.db.lock().unwrap();
        let v: Option<String> = db.query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0)).optional().ok().flatten();
        v.and_then(|s| serde_json::from_str(&s).ok())
    }

    fn set_setting(&self, key: &str, value: &Value) {
        let db = self.db.lock().unwrap();
        let _ = db.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value.to_string()]);
    }

    fn has_setting_prefix(&self, prefix: &str) -> bool {
        let db = self.db.lock().unwrap();
        db.query_row("SELECT 1 FROM settings WHERE substr(key, 1, ?) = ? LIMIT 1", params![prefix.len() as i64, prefix], |_| Ok(())).optional().ok().flatten().is_some()
    }

    fn announce(&self, topic: &str) {
        eprintln!("live update: {topic} (no /api/events here yet)");
    }

    fn audit(&self, level: Level, line: &str) {
        eprintln!("audit {}: {line}", if level == Level::Warn { "warn" } else { "info" });
    }

    fn log(&self, level: Level, scope: &str, line: &str) {
        eprintln!("{scope} {}: {line}", if level == Level::Warn { "warn" } else { "info" });
    }

    fn user(&self, _req: &ReqInfo) -> Option<String> {
        Some("local".into())
    }

    fn session_hash(&self, _req: &ReqInfo) -> Option<String> {
        Some("local".into())
    }

    fn recently_confirmed(&self, _req: &ReqInfo) -> bool {
        // (no passwords yet: the server only listens on this machine)
        true
    }

    fn is_secure(&self, _req: &ReqInfo) -> bool {
        false
    }

    fn client_key(&self, req: &ReqInfo) -> String {
        req.peer.map_or_else(|| "127.0.0.1".into(), |p| p.ip().to_string())
    }

    fn pending_code(&self, _req: &ReqInfo) -> bool {
        false
    }

    fn setup_only(&self, _req: &ReqInfo) -> bool {
        false
    }

    fn job_start(&self, fields: Value) -> Value {
        let mut jobs = self.jobs.lock().unwrap();
        let id = json!(jobs.len() + 1);
        let mut j = fields;
        j["id"] = id.clone();
        j["status"] = json!("running");
        j["startedAt"] = json!(now_ms());
        jobs.push(j);
        id
    }

    fn job_update(&self, id: &Value, fields: Value) {
        if let Some(j) = self.jobs.lock().unwrap().iter_mut().find(|j| j["id"] == *id) {
            if let Value::Object(f) = fields {
                for (k, v) in f {
                    j[k.as_str()] = v;
                }
            }
        }
    }

    fn job_finish(&self, id: &Value, fields: Value) {
        if let Some(j) = self.jobs.lock().unwrap().iter_mut().find(|j| j["id"] == *id) {
            j["status"] = json!("done");
            if let Value::Object(f) = fields {
                for (k, v) in f {
                    j[k.as_str()] = v;
                }
            }
            j["finishedAt"] = json!(now_ms());
        }
    }

    fn vehicle(&self, id: &str) -> Option<VehicleRef> {
        self.app.vehicle(id).map(|v| VehicleRef { id: v.id.clone(), name: v.name.clone() })
    }

    fn resolve_footage(&self, p: &str) -> Option<(PathBuf, VehicleRef)> {
        let roots: Vec<PathBuf> = self.app.vehicles.iter().map(|v| v.root.clone()).collect();
        let real = media::resolve_inside(p, &roots)?;
        if media::hidden_path(&real.to_string_lossy()) {
            return None;
        }
        let v = self.app.vehicles.iter().find(|v| std::fs::canonicalize(&v.root).is_ok_and(|r| real.starts_with(r)))?;
        Some((real, VehicleRef { id: v.id.clone(), name: v.name.clone() }))
    }

    fn speeds_for(&self, real: &Path) -> Option<Vec<Option<f64>>> {
        let size = std::fs::metadata(real).ok()?.len();
        let (speeds, _) = crate::speeds::read_clip(real, size);
        let v: Value = serde_json::from_str(&speeds?).ok()?;
        Some(v.as_array()?.iter().map(Value::as_f64).collect())
    }

    /// index.js viewerCarData: saved, else on when the server has CAN Bridge logs, a token or saved dashboards.
    fn viewer_car_data(&self) -> Value {
        if let Some(Value::Bool(b)) = self.setting("viewerCarData").as_ref().and_then(|c| c.get("enabled")) {
            return json!({ "enabled": b });
        }
        let can_logs = std::fs::read_dir(self.data.join("can"))
            .map(|rd| {
                rd.flatten().any(|d| {
                    d.file_type().is_ok_and(|t| t.is_dir())
                        && std::fs::read_dir(d.path()).is_ok_and(|f| f.flatten().any(|f| f.file_name().to_string_lossy().ends_with(".log.xz")))
                })
            })
            .unwrap_or(false);
        let can = self.setting("can");
        let tokens = can.as_ref().is_some_and(|c| c.get("tokens").and_then(Value::as_array).is_some_and(|t| !t.is_empty()) || (c.get("tokenHash").is_some_and(super::js::truthy) && !c.get("tokens").is_some_and(Value::is_array)));
        let dashboards = self.has_setting_prefix("dash:");
        let enabled = can_logs || tokens || dashboards;
        self.set_setting("viewerCarData", &json!({ "enabled": enabled, "at": now_ms(), "migrated": true }));
        json!({ "enabled": enabled })
    }
}
