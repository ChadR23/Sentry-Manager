//! What the footage area needs from the rest of the server (PORT_PLAN.md:
//! areas are written against a small trait until `core/` lands; the
//! coordinator then implements it on core's state). `LocalCore` is the
//! stand-in until then: the manager database in DATA_PATH/manager.db with
//! the Node server's schema, logs on stderr, topics and jobs kept in memory
//! and the database.

use super::mdb::ManagerDb;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// An error a route answers with: `status` and `{ error: message }`, plus `code` when the
/// Node server exposes one (`confirmRequired`). A status of 500 is "Internal error".
#[derive(Debug, Clone, PartialEq)]
pub struct Fail {
    pub status: u16,
    pub message: String,
    pub code: Option<&'static str>,
}

impl Fail {
    pub fn new(status: u16, message: impl Into<String>) -> Fail {
        Fail { status, message: message.into(), code: None }
    }
    /// An error without a status of its own (Node: a plain Error reaching the router).
    pub fn internal(message: impl Into<String>) -> Fail {
        Fail { status: 0, message: message.into(), code: None }
    }
    /// index.js confirmRequired()
    pub fn confirm() -> Fail {
        Fail { status: 403, message: "Enter your password to confirm this change.".into(), code: Some("CONFIRM_PASSWORD") }
    }
    /// The answer as index.js sends it: { error[, code] } with the status (500 "Internal error" without one).
    pub fn body(&self) -> (u16, Value) {
        if self.status == 0 {
            return (500, serde_json::json!({ "error": "Internal error" }));
        }
        let mut v = serde_json::json!({ "error": if self.message.is_empty() { "Error" } else { &self.message } });
        if let Some(c) = self.code {
            v["code"] = Value::from(c);
        }
        (self.status, v)
    }
}

impl std::fmt::Display for Fail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<std::io::Error> for Fail {
    fn from(e: std::io::Error) -> Fail {
        Fail::internal(e.to_string())
    }
}

pub type Res<T> = Result<T, Fail>;

/// Who asks (core works it out: session, role, home network, a recent password).
#[derive(Debug, Clone)]
pub struct Caller {
    pub user: Option<String>,
    /// the client address the audit log names (clientAddress.js)
    pub client: String,
    /// index.js adminHere: an admin who may make admin changes from here
    pub admin_here: bool,
    /// auth.recentlyConfirmed: the password was given again lately
    pub confirmed: bool,
}

impl Caller {
    /// index.js by(req, user)
    pub fn by(&self) -> String {
        format!("{} from {}", self.user.as_deref().unwrap_or("someone"), self.client)
    }
    /// index.js requireConfirmed
    pub fn require_confirmed(&self) -> Res<()> {
        if self.confirmed { Ok(()) } else { Err(Fail::confirm()) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

/// What a mount or unmount call answered (mounter.js): exit code and output,
/// `not_found` when there is no mount command, `timed_out` when it hung.
#[derive(Debug, Clone, Default)]
pub struct MountResult {
    pub code: i32,
    pub output: String,
    pub not_found: bool,
    pub timed_out: bool,
}

/// The root supervisor's mount calls (mounter.js; the supervisor area ports them).
pub trait Mounter: Send + Sync {
    /// Mount an SMB source (a normalized smb.rs Smb as JSON) at <footage root>/<id>.
    fn mount(&self, id: &str, smb: &Value) -> MountResult;
    fn unmount(&self, id: &str, lazy: bool) -> MountResult;
    fn forget(&self, id: &str);
    /// Where <id> is mounted.
    fn target(&self, id: &str) -> PathBuf;
}

pub trait Ctx: Send + Sync {
    /// The manager database (server/db.js schema): settings, protected, bin_items.
    fn db(&self) -> &ManagerDb;
    /// DATA_PATH: the footage check keeps its results in <data>/integrity.
    fn data_dir(&self) -> PathBuf;
    /// A live-update topic for /api/events (batched by core).
    fn announce(&self, topic: &str);
    /// A line in the audit log (logger.scope('audit')).
    fn audit(&self, level: Level, line: &str);
    /// A line in the server log under a scope ('bin', 'policies', 'share:<id>', ...).
    fn log(&self, scope: &str, level: Level, line: &str);
    /// jobs.start: the id of a new running job.
    fn job_start(&self, typ: &str, vehicle_id: Option<&str>, title: &str) -> i64;
    /// jobs.finish
    fn job_finish(&self, id: i64, status: &str, detail: &str, result: Option<Value>);
    /// The clips a conversion has in hand right now, as absolute paths (index.js busyPaths).
    fn busy_paths(&self) -> HashSet<PathBuf> {
        HashSet::new()
    }
    /// The supervisor's mounter (None: an SMB vehicle cannot be mounted here).
    fn mounter(&self) -> Option<Arc<dyn Mounter>> {
        None
    }
    /// A bin item was deleted for good (canPrune footageGone).
    fn on_deleted(&self, _vehicle_id: &str, _item: &Value) {}
    /// A share's status changed (notifications syncShare).
    fn share_status(&self, _vehicle_id: &str, _status: &Value) {}
    /// Space saved by conversions (savings.js forVehicle).
    fn saved(&self, _vehicle_id: &str) -> Value {
        serde_json::json!({ "bytes": 0, "clips": 0 })
    }
    /// Space saved starts over for a vehicle (savings.js reset).
    fn reset_saved(&self, _vehicle_id: &str) {}
    /// The car a vehicle is (index.js withCar's `car`), from the CAN area.
    fn car_summary(&self, _vehicle: &Value) -> Value {
        Value::Null
    }
    /// The CAN logs footage would take with it (index.js canWith), None: no key mapped.
    fn can_with(&self, _vehicle_id: &str, _rels: &[String], _until: Option<f64>) -> Option<Value> {
        None
    }
    /// "Also delete its CAN data" for moved recordings (canPrune deleteWith).
    fn can_delete_with(&self, _vehicle_id: &str, _rels: &[String], _until: Option<f64>, _by: &str) -> Option<Value> {
        None
    }
    /// A vehicle was removed: the other areas forget it (savings, archive gaps, Sentry USB, nodes).
    fn vehicle_removed(&self, _vehicle_id: &str) {}
}

/// The stand-in core (see the top of this file).
pub struct LocalCore {
    db: ManagerDb,
    data: PathBuf,
    pub topics: Mutex<Vec<String>>,
    pub audits: Mutex<Vec<String>>,
    quiet: bool,
}

impl LocalCore {
    pub fn open(data: &Path) -> rusqlite::Result<LocalCore> {
        Ok(LocalCore { db: ManagerDb::open(&data.join("manager.db"))?, data: data.to_path_buf(), topics: Mutex::new(Vec::new()), audits: Mutex::new(Vec::new()), quiet: false })
    }
    /// In memory, no log lines (tests).
    pub fn memory() -> LocalCore {
        let data = std::env::temp_dir().join(format!("lean-core-{}-{}", std::process::id(), super::random_hex(4)));
        LocalCore { db: ManagerDb::memory(), data, topics: Mutex::new(Vec::new()), audits: Mutex::new(Vec::new()), quiet: true }
    }
}

impl Ctx for LocalCore {
    fn db(&self) -> &ManagerDb {
        &self.db
    }
    fn data_dir(&self) -> PathBuf {
        self.data.clone()
    }
    fn announce(&self, topic: &str) {
        let mut t = self.topics.lock().unwrap();
        if t.len() > 1000 {
            t.clear();
        }
        t.push(topic.to_string());
    }
    fn audit(&self, level: Level, line: &str) {
        self.audits.lock().unwrap().push(line.to_string());
        self.log("audit", level, line);
    }
    fn log(&self, scope: &str, level: Level, line: &str) {
        if !self.quiet {
            eprintln!("[{scope}] {}{line}", match level { Level::Info => "", Level::Warn => "warning: ", Level::Error => "error: " });
        }
    }
    fn job_start(&self, typ: &str, vehicle_id: Option<&str>, title: &str) -> i64 {
        self.db.job_start(typ, vehicle_id, title)
    }
    fn job_finish(&self, id: i64, status: &str, detail: &str, result: Option<Value>) {
        self.db.job_finish(id, status, detail, result.as_ref());
    }
}
