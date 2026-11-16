//! What the arrival checksums need from core, the footage area and the
//! Sentry USB link, until those land (PORT_PLAN.md: "<area>/ctx.rs"). The
//! integrator implements this on core's AppState (see README.md here).

use std::path::PathBuf;

/// A vehicle as vehicles.js lists it (only what this area reads).
#[derive(Clone, Debug)]
pub struct Car {
    pub id: String,
    pub name: String,
    /// v.timezone ("" when the vehicle has none: UTC)
    pub timezone: String,
}

/// One file of the inventory's last scan (scanner.js FileEntry), as
/// arrivalChecksums reads it. Times in Node's milliseconds
/// (`sec * 1000 + nsec / 1e6`, `crate::scanner::ms_of`).
#[derive(Clone, Debug)]
pub struct ArrivedFile {
    /// the path from the vehicle's folder, forward slashes
    pub rel: String,
    /// kind === 'clip'
    pub clip: bool,
    pub size: u64,
    pub mtime_ms: f64,
    pub ctime_ms: f64,
    /// when it reached the share (statx birth time); 0 where the filesystem has none
    pub birthtime_ms: f64,
}

/// inventory.get(vid): the files of the last scan (every kind: a file not
/// in here is gone, and its index entry goes) and whether a scan runs now.
#[derive(Clone, Debug, Default)]
pub struct InventoryView {
    pub files: Vec<ArrivedFile>,
    pub scanning: bool,
}

/// inventory.codecs(vid) entries: the codec read for that size and time.
#[derive(Clone, Debug)]
pub struct KnownCodec {
    pub size: u64,
    pub mtime_ms: f64,
    pub codec: Option<String>,
}

pub trait ArrivalCtx: Send + Sync + 'static {
    /// vehicles.list()
    fn vehicles(&self) -> Vec<Car>;
    /// vehicles.get(id)
    fn vehicle(&self, id: &str) -> Option<Car> {
        self.vehicles().into_iter().find(|v| v.id == id)
    }
    /// vehicles.rootOf(v): the vehicle's folder (the source root of its clips)
    fn root_of(&self, vid: &str) -> PathBuf;
    /// vehicles.vehicleForPath(p): the id of the vehicle whose folder holds p
    fn vehicle_for_path(&self, path: &str) -> Option<String>;
    /// inventory.get(vid), None before the first scan
    fn inventory(&self, vid: &str) -> Option<InventoryView>;
    /// inventory.codecs(vid).get(rel): the codec known for that size and time
    fn codec(&self, _vid: &str, _rel: &str) -> Option<KnownCodec> {
        None
    }
    /// sentryUsb.holds(abs): the clip is in the range Sentry USB is still
    /// copying (`holds.rs` has the rule on the status file)
    fn holds(&self, _abs: &str) -> bool {
        false
    }
    /// busyPaths(): absolute paths a conversion has in hand
    fn busy_paths(&self) -> Vec<String> {
        Vec::new()
    }
    /// idle(): no conversion or benchmark runs (index.js: `!speedIndexBusy()`)
    fn idle(&self) -> bool {
        true
    }
    /// olderOf(vid): the "Record checksums for older clips" setting,
    /// `(db.get('sentry-usb-record', {}) || {})[vid]?.older !== false`
    fn older_of(&self, vid: &str) -> bool;
    /// Stores { older } for the vehicle in the `sentry-usb-record` setting
    /// (`rec[vid] = { ...(rec[vid] || {}), older }`).
    fn set_older(&self, _vid: &str, _older: bool) {}
    /// Removes the vehicle's entry from the `sentry-usb-record` setting.
    fn forget_setting(&self, _vid: &str) {}
    /// The day (YYYY-MM-DD) of `ms` in a time zone, as
    /// `Intl.DateTimeFormat('en-CA', { timeZone })` formats it; None for a
    /// zone Node does not know (the caller then takes the UTC day).
    fn day_in(&self, ms: f64, tz: &str) -> Option<String> {
        super::js::day_in_zone(ms, tz)
    }
    /// audit.info
    fn audit(&self, _line: &str) {}
    /// the 'sentry-usb' log scope
    fn log_warn(&self, line: &str) {
        eprintln!("{line}");
    }
    fn log_debug(&self, _line: &str) {}
    /// the 'converter' log scope: the record's own lines ("info" / "warn")
    /// and the before-replace hook's error line ("error")
    fn log_converter(&self, level: &str, line: &str) {
        eprintln!("{level}: {line}");
    }
}
