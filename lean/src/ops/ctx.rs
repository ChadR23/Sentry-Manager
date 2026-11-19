//! What the ops area needs from the rest of the server (core, footage, the
//! converter), as one small trait. Until core lands, `ops::lean` implements
//! it on the first slice's `App` with its own `manager.db`; the coordinator
//! implements it on core's `AppState` when the areas are merged.
//!
//! Everything here is plain data: the handlers in `ops/` are testable with a
//! fake (`ops::testing::FakeCtx`) and without HTTP.

use rusqlite::Connection;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::MutexGuard;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

/// Who asks, as core worked it out: the account, the client address
/// (`clientKey(req)`), whether the password was confirmed lately
/// (`auth.recentlyConfirmed`) and whether the request came over HTTPS.
#[derive(Clone, Debug, Default)]
pub struct Caller {
    pub user: Option<String>,
    pub client: String,
    pub confirmed: bool,
    pub https: bool,
}

impl Caller {
    /// index.js `by(req, user)`: "name from address", for audit lines.
    pub fn by(&self) -> String {
        format!("{} from {}", self.user.as_deref().unwrap_or("someone"), self.client)
    }
}

/// A vehicle's share as `vehicles.share(id).status()` reports it.
#[derive(Clone, Debug, Default)]
pub struct ShareStatus {
    pub healthy: bool,
    /// None: not known yet (Node's undefined/null)
    pub writable: Option<bool>,
    pub read_only: bool,
    pub free_bytes: Option<f64>,
    pub total_bytes: Option<f64>,
    pub last_error: Option<String>,
    pub hint: Option<String>,
    pub warning: Option<String>,
}

/// One vehicle as ops needs it.
#[derive(Clone, Debug, Default)]
pub struct VehicleInfo {
    pub id: String,
    pub name: String,
    /// `vehicles.rootOf(v)`, `vehicles.studioRoot(v)`, `v.source.path`
    pub roots: Vec<String>,
    /// `v.source.type` ('path' or 'smb')
    pub source_type: Option<String>,
    /// `v.source.share`, `.username`, `.domain` (SMB only)
    pub share: Option<String>,
    pub username: Option<String>,
    pub domain: Option<String>,
    /// None: the vehicle has no share object (Node: `vehicles.share(id)` missing)
    pub status: Option<ShareStatus>,
    /// `inventory.totals(id)`: bytes and recordings, when scanned
    pub footage_bytes: Option<f64>,
    pub recordings: Option<f64>,
    /// `bin.binBytes(id)`
    pub bin_bytes: Option<f64>,
    /// `storageOf(v)?.daysLeft`
    pub days_left: Option<f64>,
    /// `policies.get(id)`
    pub policy: Value,
    /// `inventory.totals(id).minutes` (the heartbeat's footageSeconds)
    pub footage_minutes: Option<f64>,
    /// `db.binItems(id).length` (diagnostics counts)
    pub bin_items: Option<f64>,
}

/// The converter as ops sees it (`host.runtime`).
#[derive(Clone, Debug, Default)]
pub struct ConverterInfo {
    /// the runtime is up
    pub ready: bool,
    /// `host.runtime.capabilities`
    pub capabilities: Value,
    /// `host.lastError.code`
    pub error: Option<String>,
    /// `rt.encodingNow()`: something converts right now
    pub encoding_now: bool,
    /// a conversion is running (`converterRunning()`)
    pub running: bool,
    /// `host.helperAvailable`
    pub native_helper: bool,
}

/// The encoder a health check found (`rt.selectEncoder('h265')`).
#[derive(Clone, Debug)]
pub struct Encoder {
    pub codec: String,
    pub hardware: bool,
}

/// HTTPS as the health check reports it (`tls()` in index.js).
#[derive(Clone, Debug, Default)]
pub struct TlsInfo {
    pub mode: String,
    pub trust_proxy: bool,
    pub error: Option<String>,
    pub detail: Option<String>,
}

pub trait OpsCtx: Send + Sync + 'static {
    /// manager.db (same schema as server/db.js), one connection, locked.
    fn db(&self) -> MutexGuard<'_, Connection>;
    /// manager.db for a read only (the server's reading connection).
    fn read_db(&self) -> MutexGuard<'_, Connection> {
        self.db()
    }
    /// PRAGMA quick_check's first line (the server runs it on a connection of its own).
    fn quick_check(&self) -> Result<String, String> {
        self.read_db().query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())
    }
    /// DATA_PATH
    fn data_dir(&self) -> PathBuf;
    /// APP_ROOT (BUILD_INFO.json, CRITICAL_UPDATE.txt)
    fn app_root(&self) -> PathBuf;
    /// a line in the audit log (`audit.info` / `audit.warn`)
    fn audit(&self, level: Level, line: &str);
    /// a line in the server log under `scope`
    fn log(&self, scope: &str, level: Level, line: &str);
    /// the live-update hub (`announce(topic)`: batched every 400 ms by core)
    fn announce(&self, topic: &str);
    fn vehicles(&self) -> Vec<VehicleInfo>;
    fn converter(&self) -> ConverterInfo;
    /// the encoder test of the health check; None: no encoder passed (or no runtime)
    fn select_encoder(&self) -> Option<Encoder>;
    /// `detectGpus()`: { gpus, nvidia, hints } (converter area)
    fn detect_gpus(&self) -> Value;
    /// `usableGpus(detectGpus())`: how many GPUs this container can encode on
    fn usable_gpus(&self) -> usize;
    fn tls(&self) -> Option<TlsInfo>;
    /// ffmpeg and ffprobe as the server runs them
    fn ffmpeg_path(&self) -> String;
    fn ffprobe_path(&self) -> String;
    /// the interface pack in use (`uiPacks.active()`)
    fn ui_pack(&self) -> String;
    /// strings an anonymous report must not contain that only other areas
    /// know: account names (core), place names and labels (viewer),
    /// FOOTAGE_ROOT. Ops adds the host name, DATA, the vehicles' names, ids,
    /// roots and shares, the paired nodes and the TLS host names itself
    /// (ops::diag::identifiers, index.js reportIdentifiers). An error when they
    /// cannot be read: no anonymous report is made without them.
    fn identifiers(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    /// A test hook only: when Ops runs, the report's diagnostics are built by
    /// ops::diag::diagnostics from the calls below. Null: build them.
    fn diagnostics(&self, _kind: &str) -> Value {
        Value::Null
    }
    /// A test hook only, as `diagnostics` (ops::diag::heartbeat builds the real one).
    fn heartbeat(&self) -> Value {
        Value::Null
    }
    /// the whole server stops (a snapshot restore); the supervisor starts it again
    fn shutdown(&self, reason: &str);
    /// conversions in the queue (for metrics and the heartbeat)
    fn jobs_queued(&self) -> usize {
        0
    }
    /// TLS_MODE (auto | off), core's
    fn tls_mode(&self) -> String {
        std::env::var("TLS_MODE").map(|s| s.to_lowercase()).ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "auto".into())
    }
    /// run by the root supervisor (SENTRY_SUPERVISED=1 and its IPC channel)
    fn supervised(&self) -> bool {
        false
    }
    /// mountSpec.js VERSIONS and DEFAULT_VERSION (supervisor area). Note the
    /// key order: "3" is an integer-like key, so JSON.stringify puts it first.
    fn smb_versions(&self) -> (Value, Value) {
        let mut m = serde_json::Map::new();
        for (k, v) in [("3", "SMB 3.0 or newer (best the server offers)"), ("3.1.1", "SMB 3.1.1 (recommended)"), ("3.02", "SMB 3.02"), ("3.0", "SMB 3.0")] {
            m.insert(k.into(), Value::String(v.into()));
        }
        (Value::Object(m), Value::String("3.1.1".into()))
    }
    /// log.js search: lines from `from_ms` at `min_level` or above, oldest first
    fn log_search(&self, _from_ms: i64, _min_level: Level, _limit: usize) -> Vec<LogLine> {
        Vec::new()
    }
    /// index.js systemSummary(): the set-up in short; `placeholders` names the
    /// vehicles <vehicle-1>, <vehicle-2>, ... (the support bundle)
    fn system_summary(&self, _placeholders: bool) -> Value {
        Value::Null
    }
    /// encoderStats.js encoderBlock for /api/stats (converter area): the
    /// running job's clips, workers and energy, from the stats `snapshot` and
    /// `energy` (Stats::energy(): byJob with each job's baseline); null while idle
    fn encoder_block(&self, _snapshot: &Value, _energy: &Value) -> Value {
        Value::Null
    }

    // ---- the server monitor (/api/stats) and what it needs from others

    /// every paired node's power (nodes.js power(): id, name, online and its
    /// checked report, node_power::clean_report) for "All servers"
    fn node_powers(&self) -> Vec<super::node_power::NodeRow> {
        Vec::new()
    }
    /// every running ffmpeg (a benchmark's too): pid and encoder, to name processes and GPU clients
    fn active_encodes(&self) -> Vec<super::stats::ActiveEncode> {
        Vec::new()
    }
    /// where a conversion job stands (encoderStats.js jobProgress): (clips, savedB)
    fn job_progress(&self, _job: &str) -> Option<(f64, f64)> {
        None
    }
    /// a conversion or a benchmark runs: the monitor keeps sampling without a page
    fn stats_busy(&self) -> bool {
        self.converter().running
    }
    /// asks the root supervisor for RAPL readings (`{ type: 'rapl', on: true }`
    /// on the link); its `rapl-reading` answers go to `Ops::rapl_reading`
    fn request_rapl(&self) {}

    // ---- the report's diagnostics and heartbeat (index.js reportDiagnostics, reportHeartbeat)

    /// db.jobs({ limit }): the newest jobs, each { type, status, title, detail, startedAt, finishedAt } (core)
    fn recent_jobs(&self, _limit: usize) -> Vec<Value> {
        Vec::new()
    }
    /// access.get(): the home network and access settings (core)
    fn access_settings(&self) -> Value {
        Value::Null
    }
    /// placeList().length (viewer)
    fn places_count(&self) -> usize {
        0
    }
    /// Sentry USB info files on the shares: (version, written as unix seconds) (can area)
    fn sentry_usb_infos(&self) -> Vec<(Value, f64)> {
        Vec::new()
    }
    /// canIndex.status() (can area)
    fn can_status(&self) -> Value {
        serde_json::json!({})
    }
    /// each vehicle's model label (carSummary(v).modelLabel), in vehicles() order (can area)
    fn car_models(&self) -> Vec<Option<String>> {
        self.vehicles().iter().map(|_| None).collect()
    }
    /// clips that arrived since `since_ms`, all vehicles: (sentry, dashcam) (footage)
    fn clips_arrived(&self, _since_ms: i64) -> (f64, f64) {
        (0.0, 0.0)
    }
    /// the distance driven in all the footage, in metres (viewer: the speed index)
    fn driven_metres(&self) -> f64 {
        0.0
    }
    /// convertStats.js heartbeatHardware: { cpu, gpus, convert, nodes } (converter area)
    fn heartbeat_hardware(&self) -> Value {
        let gpus: Vec<Value> = super::gpu::usable_gpus(&self.detect_gpus()).iter().map(|g| g["name"].clone()).collect();
        serde_json::json!({ "cpu": super::diag::cpu_model(), "gpus": gpus, "convert": { "fps": null, "encoder": null, "device": null, "api": null, "codec": null }, "nodes": [] })
    }
    /// TRUST_PROXY (core)
    fn trust_proxy(&self) -> bool {
        false
    }
}

/// One log line (log.js).
#[derive(Clone, Debug)]
pub struct LogLine {
    pub at: i64,
    pub level: Level,
    pub scope: String,
    pub message: String,
}

impl Level {
    pub fn name(self) -> &'static str {
        match self {
            Level::Debug => "debug",
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
        }
    }
}
