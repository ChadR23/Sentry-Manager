//! What the viewer area needs from the rest of the server (core, footage),
//! as a small trait: the coordinator implements it on core's state when the
//! areas are merged. Until then `glue.rs` implements it on today's `App`.

use crate::inventory::Recording;
use crate::scanner::FileEntry;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

/// A vehicle as the viewer sees it (vehicles.js: id, name, timezone, rootOf(v)).
#[derive(Debug, Clone)]
pub struct VehicleRef {
    pub id: String,
    pub name: String,
    pub timezone: String,
    pub root: PathBuf,
}

/// The scan's files of a vehicle, by rel (inventory.get(id).files).
pub type Files = Arc<HashMap<String, FileEntry>>;

pub trait Ctx: Send + Sync + 'static {
    /// DATA_PATH
    fn data_dir(&self) -> PathBuf;
    /// APP_ROOT (version.json)
    fn app_root(&self) -> PathBuf;
    fn vehicles(&self) -> Vec<VehicleRef>;
    fn vehicle(&self, id: &str) -> Option<VehicleRef> {
        self.vehicles().into_iter().find(|v| v.id == id)
    }
    /// vehicles.studioRoot(v): the TeslaCam folder inside the share
    fn studio_root(&self, id: &str) -> Option<PathBuf>;
    /// the last scan's files (None before the first scan)
    fn files(&self, id: &str) -> Option<Files>;
    /// the last scan's recordings, newest first
    fn recordings(&self, id: &str) -> Option<Arc<Vec<Recording>>>;
    fn scanning(&self, id: &str) -> bool;
    /// changes each time a scan of the vehicle finished (inventory onScanned)
    fn scan_stamp(&self, id: &str) -> Option<f64>;
    /// a setting from manager.db (db.get(key)); None when not set
    fn setting(&self, key: &str) -> Option<Value>;
    fn set_setting(&self, key: &str, value: Value);
    /// the live-update hub (/api/events `changed` topics)
    fn announce(&self, topic: &str);
    /// an audit line (audit.info)
    fn audit(&self, line: &str);
    /// a conversion or the benchmark runs (index.js speedIndexBusy): background reading waits
    fn busy(&self) -> bool {
        false
    }
    /// None when the caller may use an admin route, else the refusal (status, message);
    /// core's accounts and access rules decide (there is one local admin until then)
    fn refuse_admin(&self, _headers: &axum::http::HeaderMap) -> Option<(u16, String)> {
        None
    }
    /// who made a change, for an audit line (index.js by(req, user))
    fn who(&self) -> String {
        "local".into()
    }
    /// EXTRA_ROOTS
    fn extra_roots(&self) -> Vec<PathBuf> {
        std::env::var("EXTRA_ROOTS").unwrap_or_default().split(':').filter(|s| !s.is_empty()).map(PathBuf::from).collect()
    }
    /// the CAN Bridge keys of a car (canKeysFor); none until the CAN area lands
    fn can_keys(&self, _id: &str) -> Vec<String> {
        Vec::new()
    }
    /// the clips the converter rewrote (H.265 / AV1): their file times say nothing of the archive
    fn encoded(&self, _id: &str) -> std::collections::HashSet<String> {
        std::collections::HashSet::new()
    }
    /// the dedupe keys of a car's open notifications of a kind (notes.list({ open, vehicleId }))
    fn open_notes(&self, _id: &str, _kind: &str) -> Vec<String> {
        Vec::new()
    }
    /// raise or update a notification; false when it is muted (or there are none yet)
    fn raise_note(&self, _note: &Value) -> bool {
        false
    }
    fn resolve_note(&self, _dedupe_key: &str) {}
    /// ffmpeg and ffprobe (FFMPEG_PATH, FFPROBE_PATH)
    fn ffmpeg(&self) -> String {
        std::env::var("FFMPEG_PATH").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "ffmpeg".into())
    }
    fn ffprobe(&self) -> Option<String> {
        Some(std::env::var("FFPROBE_PATH").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "ffprobe".into()))
    }
}
