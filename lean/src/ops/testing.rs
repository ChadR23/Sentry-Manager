//! A fake of the rest of the server for the ops tests: an in-memory
//! manager.db, and what was announced, audited and logged.

use super::ctx::*;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

pub struct FakeCtx {
    pub db: Mutex<Connection>,
    pub data: PathBuf,
    pub announced: Mutex<Vec<String>>,
    pub audits: Mutex<Vec<(Level, String)>>,
    pub logs: Mutex<Vec<(String, Level, String)>>,
    pub vehicles: Mutex<Vec<VehicleInfo>>,
    pub converter: Mutex<ConverterInfo>,
    pub encoder: Mutex<Option<Encoder>>,
    pub gpus: Mutex<usize>,
    pub tls: Mutex<Option<TlsInfo>>,
    pub ffmpeg: Mutex<String>,
    pub identifiers: Mutex<Vec<String>>,
    /// the identifiers (read from manager.db) cannot be read
    pub identifiers_fail: std::sync::atomic::AtomicBool,
    pub diagnostics: Mutex<Value>,
    pub heartbeat: Mutex<Value>,
    pub shutdowns: Mutex<Vec<String>>,
    pub node_powers: Mutex<Vec<super::node_power::NodeRow>>,
    pub rapl_requests: Mutex<usize>,
    /// reads through `read_db` so far (a test can tell one has started)
    pub reads: std::sync::atomic::AtomicUsize,
}

impl FakeCtx {
    pub fn new() -> Arc<FakeCtx> {
        let dir = std::env::temp_dir().join(format!("lean-ops-{}-{}", std::process::id(), next()));
        FakeCtx::in_dir(dir)
    }

    pub fn in_dir(data: PathBuf) -> Arc<FakeCtx> {
        let db = Connection::open_in_memory().unwrap();
        super::store::ensure_schema(&db).unwrap();
        Arc::new(FakeCtx {
            db: Mutex::new(db),
            data,
            announced: Mutex::new(Vec::new()),
            audits: Mutex::new(Vec::new()),
            logs: Mutex::new(Vec::new()),
            vehicles: Mutex::new(Vec::new()),
            converter: Mutex::new(ConverterInfo::default()),
            encoder: Mutex::new(None),
            gpus: Mutex::new(0),
            tls: Mutex::new(None),
            ffmpeg: Mutex::new("/nonexistent/ffmpeg".into()),
            identifiers: Mutex::new(Vec::new()),
            identifiers_fail: Default::default(),
            // (null: ops::diag builds them, as in the server)
            diagnostics: Mutex::new(Value::Null),
            heartbeat: Mutex::new(Value::Null),
            node_powers: Mutex::new(Vec::new()),
            rapl_requests: Mutex::new(0),
            shutdowns: Mutex::new(Vec::new()),
            reads: Default::default(),
        })
    }

    pub fn announced(&self) -> Vec<String> {
        self.announced.lock().unwrap().clone()
    }

    pub fn audit_lines(&self) -> Vec<String> {
        self.audits.lock().unwrap().iter().map(|(_, l)| l.clone()).collect()
    }
}

fn next() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    N.fetch_add(1, Ordering::Relaxed)
}

impl OpsCtx for FakeCtx {
    fn db(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap()
    }
    fn read_db(&self) -> MutexGuard<'_, Connection> {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.db()
    }
    fn data_dir(&self) -> PathBuf {
        self.data.clone()
    }
    fn app_root(&self) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
    }
    fn audit(&self, level: Level, line: &str) {
        self.audits.lock().unwrap().push((level, line.to_string()));
    }
    fn log(&self, scope: &str, level: Level, line: &str) {
        self.logs.lock().unwrap().push((scope.to_string(), level, line.to_string()));
    }
    fn announce(&self, topic: &str) {
        self.announced.lock().unwrap().push(topic.to_string());
    }
    fn vehicles(&self) -> Vec<VehicleInfo> {
        self.vehicles.lock().unwrap().clone()
    }
    fn converter(&self) -> ConverterInfo {
        self.converter.lock().unwrap().clone()
    }
    fn select_encoder(&self) -> Option<Encoder> {
        self.encoder.lock().unwrap().clone()
    }
    fn detect_gpus(&self) -> Value {
        json!({ "gpus": [], "nvidia": null, "hints": [] })
    }
    fn usable_gpus(&self) -> usize {
        *self.gpus.lock().unwrap()
    }
    fn tls(&self) -> Option<TlsInfo> {
        self.tls.lock().unwrap().clone()
    }
    fn ffmpeg_path(&self) -> String {
        self.ffmpeg.lock().unwrap().clone()
    }
    fn ffprobe_path(&self) -> String {
        self.ffmpeg.lock().unwrap().replace("ffmpeg", "ffprobe")
    }
    fn ui_pack(&self) -> String {
        "original".into()
    }
    fn identifiers(&self) -> Result<Vec<String>, String> {
        if self.identifiers_fail.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("manager.db: database disk image is malformed".into());
        }
        Ok(self.identifiers.lock().unwrap().clone())
    }
    fn diagnostics(&self, _kind: &str) -> Value {
        self.diagnostics.lock().unwrap().clone()
    }
    fn heartbeat(&self) -> Value {
        self.heartbeat.lock().unwrap().clone()
    }
    fn shutdown(&self, reason: &str) {
        self.shutdowns.lock().unwrap().push(reason.to_string());
    }
    fn node_powers(&self) -> Vec<super::node_power::NodeRow> {
        self.node_powers.lock().unwrap().clone()
    }
    fn request_rapl(&self) {
        *self.rapl_requests.lock().unwrap() += 1;
    }
}
