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
    /// strings an anonymous report must not contain (index.js identifiers()):
    /// host names, account names, node names, place names, TLS host names
    fn identifiers(&self) -> Vec<String>;
    /// the diagnostics object of a report (index.js diagnostics(), its DIAG_KEYS)
    fn diagnostics(&self, kind: &str) -> Value;
    /// the heartbeat's raw numbers (index.js heartbeat(); normalised by ops)
    fn heartbeat(&self) -> Value;
    /// the whole server stops (a snapshot restore); the supervisor starts it again
    fn shutdown(&self, reason: &str);
    /// conversions in the queue (for metrics and the heartbeat)
    fn jobs_queued(&self) -> usize {
        0
    }
}
