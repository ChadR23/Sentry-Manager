//! What the CAN area needs from the rest of the server (PORT_PLAN.md: an
//! area defines it as a small trait; the coordinator implements it on core's
//! AppState). Everything here is read-only for the CAN area except the
//! settings it owns ('can', 'can-vehicles', 'can-keep', 'can-prune:<vid>',
//! 'viewerCarData', 'sentry-usb-record'), the live-update topics it sends
//! ('can', 'carData') and the audit lines it writes.

use serde_json::Value;
use std::path::PathBuf;

/// A vehicle as the CAN area sees it.
#[derive(Debug, Clone)]
pub struct Car {
    pub id: String,
    pub name: String,
    /// IANA zone ('' is UTC)
    pub timezone: String,
    /// the vehicle's folder (vehicles.rootOf)
    pub root: Option<PathBuf>,
    /// the folder holding RecentClips/ (vehicles.studioRoot)
    pub studio_root: Option<PathBuf>,
    /// the "Car model" setting (v.car)
    pub car: Option<Value>,
}

/// One file of a vehicle's last scan (inventory.get(vid).files).
#[derive(Debug, Clone)]
pub struct FootFile {
    pub rel: String,
    /// 'clip' for a clip
    pub kind: String,
    pub camera: Option<String>,
}

/// One recording (inventory.get(vid).recordings).
#[derive(Debug, Clone)]
pub struct Rec {
    pub id: String,
    pub clip_rels: Vec<String>,
    pub start_key: Option<String>,
}

/// What the last scan of a vehicle says (inventory.get(vid)).
#[derive(Debug, Clone, Default)]
pub struct Scan {
    /// false before the first scan (no files yet)
    pub scanned: bool,
    pub scanned_at: Option<f64>,
    pub scanning: bool,
    pub last_error: Option<String>,
    pub error_count: usize,
    pub files: Vec<FootFile>,
    pub recordings: Vec<Rec>,
    /// changes whenever the scan's results change (Node compares the arrays by identity)
    pub generation: u64,
}

/// Who asked, for the audit lines and the per-user search queue.
#[derive(Debug, Clone, Default)]
pub struct Who {
    /// by(req, user): "admin from 192.168.1.5" and so on
    pub by: String,
    /// the user (or the client's address without one): one search each
    pub owner: String,
    /// an admin at home (adminHere): may change the Sentry USB record setting
    pub admin_here: bool,
}

pub trait CanCtx: Send + Sync + 'static {
    /// DATA_PATH
    fn data_dir(&self) -> PathBuf;
    /// CAN_PORT (10000)
    fn can_port(&self) -> u16 {
        10000
    }
    /// db.get(key): None when not set, an error when it cannot be read
    fn setting(&self, key: &str) -> Result<Option<Value>, String>;
    /// db.set(key, value): an error when it was not kept
    fn set_setting(&self, key: &str, value: Value) -> Result<(), String>;
    /// a saved car-data dashboard of any account ('dash:%' in the settings)
    fn has_dashboards(&self) -> Result<bool, String> {
        Ok(false)
    }
    fn vehicles(&self) -> Vec<Car>;
    fn vehicle(&self, id: &str) -> Option<Car> {
        self.vehicles().into_iter().find(|v| v.id == id)
    }
    fn scan_of(&self, vid: &str) -> Option<Scan>;
    /// scan_of without its files and recordings (empty here): whether and how it scanned
    fn scan_head(&self, vid: &str) -> Option<Scan> {
        self.scan_of(vid).map(|s| Scan { files: Vec::new(), recordings: Vec::new(), ..s })
    }
    /// Scan::generation without copying the scan
    fn scan_generation(&self, vid: &str) -> Option<u64> {
        self.scan_of(vid).map(|s| s.generation)
    }
    /// inventory.scan(vid), waiting for it
    fn rescan(&self, vid: &str) -> Result<(), String>;
    /// the files of the vehicle's Recycle Bin items (rels); an error when they cannot be read
    fn bin_rels(&self, vid: &str) -> Result<Vec<String>, String> {
        let _ = vid;
        Ok(Vec::new())
    }
    /// the protected clips (rels); an error when they cannot be read
    fn protected_rels(&self, vid: &str) -> Result<Vec<String>, String> {
        let _ = vid;
        Ok(Vec::new())
    }
    /// the vehicle's share is reachable (vehicles.share(vid).isHealthy(); true without a share)
    fn share_healthy(&self, vid: &str) -> bool {
        let _ = vid;
        true
    }
    /// run f under the Recycle Bin's lock of a vehicle
    fn with_bin_lock(&self, vid: &str, f: &mut dyn FnMut()) {
        let _ = vid;
        f()
    }
    /// announce(topic) on /api/events
    fn announce(&self, topic: &str);
    /// audit.info / audit.warn
    fn audit(&self, level: &str, line: &str);
    /// the server log
    fn log(&self, level: &str, line: &str) {
        eprintln!("[can] {}: {}", level, line);
    }
    /// no conversion runs (the indexer waits otherwise)
    fn idle(&self) -> bool {
        true
    }
    /// GET /api/telemetry's body for a clip (the sync reads its frames)
    fn telemetry(&self, real: &std::path::Path) -> Result<Value, String> {
        let _ = real;
        Err("no telemetry".into())
    }
    /// studioReadable.resolve(path): the real path of a clip the pages may read, or None
    fn resolve_clip(&self, path: &str) -> Option<PathBuf> {
        std::fs::canonicalize(path).ok()
    }
    /// hiddenPath(real)
    fn hidden_path(&self, real: &std::path::Path) -> bool {
        let _ = real;
        false
    }
    /// the server certificate's SHA-256 fingerprint (null without HTTPS)
    fn cert_fingerprint(&self) -> Option<String> {
        None
    }
    /// tlsSource.status() (None without HTTPS of its own, or when it cannot be read)
    fn tls_status(&self) -> Option<Value> {
        None
    }
    /// tlsSource.caPem(): the local certificate authority's certificate (None with an own certificate)
    fn ca_pem(&self) -> Option<Vec<u8>> {
        None
    }
    /// APP_ROOT (assets/streamdeck: the Stream Deck plugin)
    fn app_root(&self) -> PathBuf {
        PathBuf::from(".")
    }
    /// the server has its own HTTPS (tlsSource)
    fn tls(&self) -> bool {
        false
    }
    /// isSecure(req) on the web port: an encrypted connection, or a trusted proxy's X-Forwarded-Proto
    fn web_secure(&self, encrypted: bool, forwarded_https: bool, from: &str) -> bool {
        let _ = from;
        encrypted || forwarded_https
    }
    /// an address on the local network (tls.js ipPermitted), for the device port's forwarded https
    fn local_address(&self, ip: &str) -> bool {
        let ip = ip.trim_start_matches("::ffff:");
        ip.starts_with("127.") || ip == "::1" || ip.starts_with("10.") || ip.starts_with("192.168.") || {
            let mut p = ip.split('.');
            p.next() == Some("172") && p.next().and_then(|x| x.parse::<u8>().ok()).is_some_and(|x| (16..=31).contains(&x))
        }
    }
    /// clientKey(req) for the web port
    fn client_key(&self, remote: &str) -> String {
        remote.to_string()
    }
    /// sentryUsb.holds etc. live with the footage area; the CAN area reads the files itself
    /// (an error when the record's setting cannot be read)
    fn sentry_usb_record_view(&self, vid: &str) -> Result<Value, String> {
        let _ = vid;
        Ok(serde_json::json!({}))
    }
    /// archiveGap.forDays(vid): the missed snapshots that cost footage (Unix ms of their start)
    fn costly_snapshot_starts(&self, vid: &str) -> Vec<f64> {
        let _ = vid;
        Vec::new()
    }
    /// arrival checksums: kick after the record setting changed
    fn arrival_kick(&self) {}
}
