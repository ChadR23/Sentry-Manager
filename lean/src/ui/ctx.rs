//! What the ui area needs from core (PORT_PLAN.md: an area defines the few
//! things it needs as a small trait; the coordinator implements it on core's
//! AppState). `local.rs` implements it for today's lean server, which has no
//! accounts yet.

use axum::http::HeaderMap;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// One log or audit line's level.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
}

/// A vehicle as the exporter needs it.
#[derive(Debug, Clone)]
pub struct VehicleRef {
    pub id: String,
    pub name: String,
}

/// What a request carries that the ctx needs to answer for it (cookies,
/// forwarded headers, the peer address).
pub struct ReqInfo<'a> {
    pub headers: &'a HeaderMap,
    pub peer: Option<std::net::SocketAddr>,
}

pub trait UiCtx: Send + Sync + 'static {
    // ---- the settings table of manager.db (server/db.js get / set)
    /// db.get(key): the saved value, or None when there is none.
    fn setting(&self, key: &str) -> Option<Value>;
    /// db.set(key, value)
    fn set_setting(&self, key: &str, value: &Value);
    /// Whether any setting's key starts with `prefix` (index.js hasDashboards: `dash:%`).
    fn has_setting_prefix(&self, prefix: &str) -> bool;

    // ---- live updates, logs and the audit log
    /// announce(topic): the /api/events hub batches it (400 ms) to every open page.
    fn announce(&self, topic: &str);
    /// logger.scope('audit') at this level.
    fn audit(&self, level: Level, line: &str);
    /// logger.scope(scope) at this level.
    fn log(&self, level: Level, scope: &str, line: &str);

    // ---- who is asking (server/auth.js, accounts.js, access.js)
    /// The signed-in account's name, or None (auth.user).
    fn user(&self, req: &ReqInfo) -> Option<String>;
    /// The session's hash (auth.sessionHash), for the early-data learning.
    fn session_hash(&self, req: &ReqInfo) -> Option<String>;
    /// Whether the password was entered again a moment ago (auth.recentlyConfirmed).
    fn recently_confirmed(&self, req: &ReqInfo) -> bool;
    /// Whether the request came over HTTPS (auth.isSecure): cookies get Secure.
    fn is_secure(&self, req: &ReqInfo) -> bool;
    /// The client's address as the audit lines name it (clientKey).
    fn client_key(&self, req: &ReqInfo) -> String;
    /// A sign-in waiting for its two-step code (accounts.pendingUser(pendingToken(req))).
    fn pending_code(&self, req: &ReqInfo) -> bool;
    /// Every account needs two-step sign-in and this one has none yet (twoFactorState 'setup').
    fn setup_only(&self, req: &ReqInfo) -> bool;

    // ---- the jobs list (server/jobs.js)
    /// jobs.start({ type, vehicleId, title, detail }): its id.
    fn job_start(&self, fields: Value) -> Value;
    /// jobs.update(id, fields)
    fn job_update(&self, id: &Value, fields: Value);
    /// jobs.finish(id, fields)
    fn job_finish(&self, id: &Value, fields: Value);

    // ---- footage (studioReadable, vehicleForReal, speedIndex)
    /// The vehicle with this id.
    fn vehicle(&self, id: &str) -> Option<VehicleRef>;
    /// A path the pages name, as a real path inside a vehicle's footage and not
    /// hidden (studioReadable.resolve + hiddenPath), with the vehicle it is in.
    fn resolve_footage(&self, p: &str) -> Option<(PathBuf, VehicleRef)>;
    /// The speed (m/s) of each second of a clip, from the speed index.
    fn speeds_for(&self, real: &Path) -> Option<Vec<Option<f64>>>;
    /// Whether the Viewer shows car data at all (index.js viewerCarData: CAN area).
    fn viewer_car_data(&self) -> Value;
    /// The background work limits changed (Settings → Advanced): apply them.
    fn work_limits_changed(&self, _limits: &Value) {}
}
