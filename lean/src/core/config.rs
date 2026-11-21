//! The environment, read once at start, with the Node server's names and
//! defaults (server/index.js, server/supervisor.js, server/acme.js).
//!
//! | Variable | Default | Used for |
//! | --- | --- | --- |
//! | `APP_ROOT` | the repository | `web/`, `src/`, `assets/`, `version.json` |
//! | `DATA_PATH` | `/data` | `manager.db`, `logs/`, `tls/`, `setup-code.txt`, `converted/`, ... |
//! | `RUN_DIR` | `/run/sentry-six-manager` | root-only SMB credentials (supervisor) |
//! | `FOOTAGE_ROOT` | `/footage` | where shares are mounted |
//! | `FOOTAGE_PATH`, `VEHICLE_NAME` | none | the vehicle from the environment (vehicles.js) |
//! | `FOLDER_ROOTS`, `EXTRA_ROOTS` | none | `:`-separated extra folder and output roots |
//! | `PORT` | `9000` | HTTPS (and the plain-HTTP redirect) on one port |
//! | `CAN_PORT` | `10000` | the device port (CAN Bridge uploads), open only while uploads are on |
//! | `HOST` | `0.0.0.0` | listen address |
//! | `TLS_MODE` | `auto` | `off`: plain HTTP only (behind a reverse proxy that does HTTPS) |
//! | `TLS_HOSTNAMES` | none | extra names for the server certificate |
//! | `TLS_CERT_FILE`, `TLS_KEY_FILE` | none | your own certificate instead of the app's CA |
//! | `TLS_ACME_DOMAIN`, `TLS_ACME_EMAIL`, `TLS_ACME_STAGING`, `TLS_ACME_DIRECTORY`, `TLS_ACME_CA_FILE` | none | Let's Encrypt (acme.rs) |
//! | `TRUST_PROXY` | off (`true` turns it on) | believe X-Forwarded-For/-Proto/-Host from a trusted proxy |
//! | `TRUSTED_PROXIES` | the local network | which connections are trusted proxies |
//! | `TRUSTED_HOSTS` | any | allowed Host names (else 421) |
//! | `SENTRY_SUPERVISED`, `SENTRY_TLS_DIR` | off | run under the root supervisor (TLS files exported by it) |
//! | `SENTRY_APP_TLS_DIR` | `/run/sentry-app/tls` | supervisor side of that export |
//! | `PUID`, `PGID` | `1000` (supervisor) | the app's user |
//! | `LOG_LEVEL` | `info` | debug, info, warn, error |
//! | `UI_USERNAME`, `UI_PASSWORD` | `admin`, none | the first account, made at start when there is none |
//! | `FFMPEG_PATH`, `FFPROBE_PATH` | `ffmpeg`, `ffprobe` | tools |
//! | `TZ` | the system's | time zone |
//! | `SCAN_INTERVAL_MINUTES` | `15` | background rescans |
//! | `DEFAULT_UI` | `sentry-six` | the interface pack shown first |
//! | `SCRUB_PREPARE_DAYS` | `2` | scrub previews made ahead |
//! | `UPDATE_CHECK` | on (`off`/`false`/`0`/`no` turn it off) | image update checks |
//! | `APP_VERSION` | none | the version in the interface zip |
//! | `EXPORT_ENCODER` | gpu | `cpu` keeps exports on the CPU |
//! | `REPORTS`, `REPORTS_URL`, `REPORTS_PUBLIC_KEY` | built in | the opt-in reports (reportsConfig.js) |
//! | `SMB_*`, `UI_PASSWORD_FILE` | none | the supervisor's share from the environment |
//! | `CPU_ENCODER_PRESET`, `SENTRY_NOREPLACE_RENAME` | none | converter |

use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Config {
    pub app_root: PathBuf,
    pub data: PathBuf,
    pub run_dir: PathBuf,
    pub footage_root: PathBuf,
    pub port: u16,
    pub can_port: u16,
    pub host: String,
    pub ffmpeg: String,
    pub ffprobe: String,
    /// "auto" or "off" (lower-cased)
    pub tls_mode: String,
    pub trust_proxy: bool,
    pub trusted_proxies: Option<String>,
    pub supervised: bool,
    pub sentry_tls_dir: Option<PathBuf>,
    pub trusted_hosts: Vec<String>,
    pub log_level: String,
    pub tls_hostnames: String,
    pub tls_cert_file: Option<String>,
    pub tls_key_file: Option<String>,
    pub ui_username: Option<String>,
    pub ui_password: Option<String>,
    pub tz: Option<String>,
    pub scan_interval_minutes: f64,
    pub app_version: Option<String>,
    pub folder_roots: Vec<String>,
    pub extra_roots: Vec<String>,
    pub footage_path: Option<String>,
    pub vehicle_name: Option<String>,
    pub default_ui: String,
    pub update_check: bool,
    /// every variable as it was at start (for the areas: ACME, reports, SMB, ...)
    pub env: HashMap<String, String>,
}

/// path.resolve: absolute from the working directory, with `.` and `..` worked out.
pub fn resolve(p: &str) -> PathBuf {
    let base = if Path::new(p).is_absolute() { PathBuf::new() } else { std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")) };
    let mut out = PathBuf::from("/");
    for c in base.join(p).components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::Normal(s) => out.push(s),
            _ => {}
        }
    }
    out
}

impl Config {
    pub fn from_env() -> Config {
        Config::from_map(std::env::vars().collect())
    }

    /// `process.env.X || default`: an empty value counts as unset.
    pub fn from_map(env: HashMap<String, String>) -> Config {
        let get = |k: &str| env.get(k).filter(|v| !v.is_empty()).cloned();
        let or = |k: &str, d: &str| get(k).unwrap_or_else(|| d.to_string());
        let list = |k: &str| get(k).map(|v| v.split(':').filter(|s| !s.is_empty()).map(String::from).collect()).unwrap_or_default();
        let default_root = std::env::current_exe()
            .ok()
            .and_then(|e| e.ancestors().find(|a| a.join("version.json").is_file() && a.join("web").is_dir()).map(Path::to_path_buf))
            .unwrap_or_else(|| PathBuf::from("/app"));
        let num = |k: &str, d: f64| get(k).map(|v| v.trim().parse::<f64>().unwrap_or(f64::NAN)).unwrap_or(d);
        Config {
            app_root: get("APP_ROOT").map(|p| resolve(&p)).unwrap_or(default_root),
            data: resolve(&or("DATA_PATH", "/data")),
            run_dir: resolve(&or("RUN_DIR", "/run/sentry-six-manager")),
            footage_root: resolve(&or("FOOTAGE_ROOT", "/footage")),
            port: num("PORT", 9000.0) as u16,
            can_port: num("CAN_PORT", 10000.0) as u16,
            host: or("HOST", "0.0.0.0"),
            ffmpeg: or("FFMPEG_PATH", "ffmpeg"),
            ffprobe: or("FFPROBE_PATH", "ffprobe"),
            tls_mode: or("TLS_MODE", "auto").to_lowercase(),
            trust_proxy: env.get("TRUST_PROXY").is_some_and(|v| v == "true"),
            trusted_proxies: get("TRUSTED_PROXIES"),
            supervised: env.get("SENTRY_SUPERVISED").is_some_and(|v| v == "1"),
            sentry_tls_dir: get("SENTRY_TLS_DIR").map(PathBuf::from),
            trusted_hosts: or("TRUSTED_HOSTS", "")
                .split(|c: char| c.is_whitespace() || c == ',')
                .filter(|s| !s.is_empty())
                .map(|h| h.to_lowercase())
                .collect(),
            log_level: or("LOG_LEVEL", "info"),
            tls_hostnames: or("TLS_HOSTNAMES", ""),
            tls_cert_file: get("TLS_CERT_FILE"),
            tls_key_file: get("TLS_KEY_FILE"),
            ui_username: get("UI_USERNAME"),
            ui_password: get("UI_PASSWORD"),
            tz: get("TZ"),
            scan_interval_minutes: num("SCAN_INTERVAL_MINUTES", 15.0),
            app_version: get("APP_VERSION"),
            folder_roots: list("FOLDER_ROOTS"),
            extra_roots: list("EXTRA_ROOTS"),
            footage_path: get("FOOTAGE_PATH"),
            vehicle_name: get("VEHICLE_NAME"),
            default_ui: or("DEFAULT_UI", "sentry-six").trim().to_lowercase(),
            update_check: !matches!(or("UPDATE_CHECK", "").to_lowercase().as_str(), "off" | "false" | "0" | "no"),
            env,
        }
    }

    /// The DATA folder's layout (index.js).
    pub fn db_file(&self) -> PathBuf {
        self.data.join("manager.db")
    }
    pub fn log_file(&self) -> PathBuf {
        self.data.join("logs").join("manager.log")
    }
    pub fn tls_dir(&self) -> PathBuf {
        self.data.join("tls")
    }
    pub fn setup_file(&self) -> PathBuf {
        self.data.join("setup-code.txt")
    }
    pub fn converted_dir(&self) -> PathBuf {
        self.data.join("converted")
    }
    pub fn snapshots_dir(&self) -> PathBuf {
        self.data.join("snapshots")
    }
    pub fn web(&self) -> PathBuf {
        self.app_root.join("web")
    }
    pub fn src(&self) -> PathBuf {
        self.app_root.join("src")
    }
    pub fn tls_on(&self) -> bool {
        self.tls_mode != "off"
    }
    /// A variable as it was at start (empty counts as unset).
    pub fn var(&self, k: &str) -> Option<&str> {
        self.env.get(k).map(String::as_str).filter(|v| !v.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_as_node() {
        let c = Config::from_map(Default::default());
        assert_eq!(c.port, 9000);
        assert_eq!(c.can_port, 10000);
        assert_eq!(c.host, "0.0.0.0");
        assert_eq!(c.data, PathBuf::from("/data"));
        assert_eq!(c.db_file(), PathBuf::from("/data/manager.db"));
        assert_eq!(c.log_file(), PathBuf::from("/data/logs/manager.log"));
        assert_eq!(c.tls_mode, "auto");
        assert!(!c.trust_proxy);
        assert!(c.update_check);
    }

    #[test]
    fn values() {
        let m = [("PORT", "18443"), ("TLS_MODE", "OFF"), ("TRUST_PROXY", "true"), ("TRUSTED_HOSTS", "NAS.lan, other"), ("DATA_PATH", "/x/../y"), ("UPDATE_CHECK", "No")];
        let c = Config::from_map(m.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect());
        assert_eq!(c.port, 18443);
        assert!(!c.tls_on());
        assert!(c.trust_proxy);
        assert_eq!(c.trusted_hosts, vec!["nas.lan", "other"]);
        assert_eq!(c.data, PathBuf::from("/y"));
        assert!(!c.update_check);
    }
}
