//! AppState: what every area gets from core (see core/README.md).

use super::access::Access;
use super::accounts::Accounts;
use super::activity::{Jobs, Notifications};
use super::auth::Auth;
use super::client_addr::{proxy_matcher, Proxy};
use super::config::Config;
use super::db::Db;
use super::events::Hub;
use super::log::{Logger, Scope};
use super::tls::{TlsManager, TlsSource};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

/// A function another area provides later (None until it is set).
pub struct Hook<T: ?Sized>(RwLock<Option<Arc<T>>>);

impl<T: ?Sized> Default for Hook<T> {
    fn default() -> Self {
        Hook(RwLock::new(None))
    }
}

impl<T: ?Sized> Hook<T> {
    pub fn set(&self, f: Arc<T>) {
        *self.0.write().unwrap() = Some(f);
    }
    pub fn get(&self) -> Option<Arc<T>> {
        self.0.read().unwrap().clone()
    }
}

/// What core's own routes need from other areas. Each area sets its hooks when it is wired in.
#[derive(Default)]
pub struct Hooks {
    /// footage: whether a vehicle id exists (index.js vehicleOr404). Unset: no vehicles.
    pub vehicle_exists: Hook<dyn Fn(&str) -> bool + Send + Sync>,
    /// converter: the external ids (`converter:<id>`) of conversions still going (waiting, paused), kept by Clear jobs
    pub conversions_active: Hook<dyn Fn() -> Vec<String> + Send + Sync>,
    /// converter: give rows of conversions the converter no longer runs their real end (settleConversionRows)
    pub settle_conversions: Hook<dyn Fn() + Send + Sync>,
    /// ops: whether this build can send reports (/api/auth/me on the first-run page). Unset: unless REPORTS=off.
    pub reports_configured: Hook<dyn Fn() -> bool + Send + Sync>,
    /// ops: the first-run page's reporting choice (share, anonymous) -> Ok((before, after)) as { share, anonymous }
    pub reports_setup: Hook<dyn Fn(bool, bool) -> Result<(serde_json::Value, serde_json::Value), String> + Send + Sync>,
    /// ui: the page-start learning of web/prefetch.js (session hash, path + search, headers) for signed-in GETs under /api/
    pub note_start_call: Hook<dyn Fn(&str, &str, &axum::http::HeaderMap) + Send + Sync>,
    /// ops: a 500's crash note (reports.noteCrash from the error path: name, message, stack)
    pub server_error: Hook<dyn Fn(&str, &str, &str) + Send + Sync>,
    /// ops: a `rapl-reading` from the supervisor (stats.setRapl)
    pub rapl_reading: Hook<dyn Fn(&serde_json::Value) + Send + Sync>,
    /// shutdown work of the areas, run in order before the process ends
    pub on_shutdown: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
}

pub struct AppState {
    pub config: Config,
    pub db: Arc<Db>,
    pub logger: Arc<Logger>,
    /// scope "server"
    pub log: Scope,
    /// scope "audit": who did what (security-relevant actions only, never secrets)
    pub audit: Scope,
    pub auth: Auth,
    pub accounts: Accounts,
    pub access: Access,
    pub hub: Arc<Hub>,
    pub jobs: Jobs,
    pub notes: Arc<Notifications>,
    pub proxy: Proxy,
    pub tls: Option<TlsSource>,
    pub hooks: Hooks,
    /// the TLS configuration in use (swapped when the certificate changes)
    pub tls_config: RwLock<Option<Arc<rustls::ServerConfig>>>,
    /// session hash -> when its "last used" was last written
    pub(crate) seen_at: Mutex<HashMap<String, i64>>,
    /// the device port's listener (open while CAN uploads are on)
    pub(crate) device_port: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// every area's routes (server::install sets it once, before listening)
    pub(crate) router: std::sync::OnceLock<Arc<super::http::Router>>,
    /// the link to the root supervisor (fd 3), when it started this app: footage's IpcMounter, ops' rapl_on
    pub supervisor: std::sync::OnceLock<Arc<crate::supervisor::link::Link>>,
}

impl AppState {
    /// Open the database, the logs and the accounts as index.js main() does (in that order).
    pub fn open(config: Config) -> Result<Arc<AppState>, String> {
        let logger = Logger::new(&config.log_level, Some(config.log_file()));
        AppState::open_with(config, logger)
    }

    pub fn open_with(config: Config, logger: Arc<Logger>) -> Result<Arc<AppState>, String> {
        let log = logger.scope("server");
        std::fs::create_dir_all(&config.data).map_err(|e| format!("DATA_PATH {}: {e}", config.data.display()))?;
        let db = Arc::new(Db::open(&config.db_file()).map_err(|e| format!("manager.db: {e}"))?);
        // the old Sentry USB pairing link's data: gone (as Node)
        {
            let c = db.conn();
            let _ = c.execute("DELETE FROM settings WHERE key = 'sentryusb' OR key LIKE 'sentryusb-%'", []);
            let _ = c.execute("DROP TABLE IF EXISTS sentryusb_audit", []);
        }
        let _ = std::fs::remove_dir_all(config.data.join("sentryusb"));
        let auth = Auth::new(db.clone(), logger.scope("auth"), Some(config.setup_file()));
        let accounts = Accounts::new(db.clone());
        auth.bootstrap(config.ui_username.as_deref(), config.ui_password.as_deref());
        let hub = Hub::new();
        let jobs = Jobs::new(db.clone(), hub.clone());
        let stopped = jobs.interrupt_leftovers();
        if stopped > 0 {
            log.info(format!("{stopped} job(s) were stopped by the restart; Jobs shows them as interrupted"));
        }
        let notes = Notifications::new(db.clone(), hub.clone());
        let audit = logger.scope("audit");
        let access = Access::new(db.clone(), Some(audit.clone()));
        let proxy = Proxy { trust_proxy: config.trust_proxy, trusted: proxy_matcher(config.trusted_proxies.as_deref())? };
        // the support chat is gone; its ticket is not kept
        if db.get("supportTicket").is_some_and(|v| !v.is_null()) {
            db.set("supportTicket", &serde_json::Value::Null);
        }
        let tls = if !config.tls_on() {
            None
        } else if config.supervised && config.sentry_tls_dir.is_some() {
            Some(TlsSource::Supervised(super::tls::Supervised::new(config.sentry_tls_dir.clone().unwrap())))
        } else {
            let hostnames = super::tls::parse_hostnames(&config.tls_hostnames).map_err(|e| e.message)?;
            let acme = match super::acme::config_from_env(&config.env) {
                Ok(a) => a,
                Err(e) => {
                    logger.scope("tls").error(format!("{e} Let's Encrypt is off."));
                    None
                }
            };
            Some(TlsSource::Local(TlsManager::new(config.tls_dir(), Some(logger.scope("tls").into()), hostnames, config.tls_cert_file.clone(), config.tls_key_file.clone(), acme)))
        };
        Ok(Arc::new(AppState {
            config,
            db,
            logger,
            log,
            audit,
            auth,
            accounts,
            access,
            hub,
            jobs,
            notes,
            proxy,
            tls,
            hooks: Hooks::default(),
            tls_config: RwLock::new(None),
            seen_at: Mutex::new(HashMap::new()),
            device_port: Mutex::new(None),
            router: std::sync::OnceLock::new(),
            supervisor: std::sync::OnceLock::new(),
        }))
    }

    pub fn router(&self) -> Arc<super::http::Router> {
        self.router.get().cloned().unwrap_or_default()
    }

    /// Something changed: open pages hear of it within 400 ms (topics: bin, can, carData, interface, inventory, jobs, notifications, vehicles).
    pub fn announce(&self, topic: &str) {
        self.hub.announce(topic);
    }

    /// A setting (db.js get); None when missing or not JSON.
    pub fn setting(&self, key: &str) -> Option<serde_json::Value> {
        self.db.get(key)
    }

    pub fn set_setting(&self, key: &str, value: &serde_json::Value) {
        self.db.set(key, value);
    }

    /// Whether this address is on the home network (Settings → Security).
    pub fn from_home(&self, client: &str) -> bool {
        self.access.is_home(client)
    }

    /// An admin outside the home network with "admin pages only at home" on counts as a viewer there.
    pub fn role_for(&self, client: &str, user: &str) -> Option<String> {
        let role = self.accounts.role_of(Some(user));
        if role.as_deref() == Some("admin") && super::accounts::truthy(&self.access.get()["homeOnly"]["adminPages"]) && !self.from_home(client) {
            return Some("viewer".into());
        }
        role
    }

    /// An admin who may make admin changes from where this request comes.
    pub fn admin_here(&self, client: &str, user: &str) -> bool {
        if !self.accounts.is_admin(user) {
            return false;
        }
        let rules = self.access.get()["homeOnly"].clone();
        !((super::accounts::truthy(&rules["adminChanges"]) || super::accounts::truthy(&rules["adminPages"])) && !self.from_home(client))
    }

    /// The two-step rules for a signed-in account here: "ok", "out" (signed out) or "setup" (only setting it up is open).
    pub fn two_factor_state(&self, user: &str, home: bool) -> &'static str {
        let rules = self.access.get()["twoFactor"].clone();
        let (outside, everyone) = (super::accounts::truthy(&rules["outside"]), super::accounts::truthy(&rules["everyone"]));
        if user.is_empty() || (!outside && !everyone) || self.accounts.two_factor_on(user) {
            return "ok";
        }
        if !home {
            return "out";
        }
        if everyone { "setup" } else { "ok" }
    }

    /// The certificate's fingerprint (the sign-in page shows it).
    pub fn cert_fingerprint(&self) -> Option<String> {
        self.tls.as_ref()?.status().ok()?["certificate"]["fingerprint"].as_str().map(String::from)
    }
}
