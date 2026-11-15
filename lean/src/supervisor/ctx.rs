//! What the supervisor needs from core (PORT_PLAN.md: an area defines what it
//! needs as a small trait). Here that is only the HTTPS certificate authority
//! and Let's Encrypt (`server/tls.js` TlsManager, `exportForApp`,
//! `parseHostnames`, `acmeConfigFromEnv`), which are core's to port. Until
//! core implements `TlsFactory`, the supervisor runs without it (see
//! `Supervisor::tls`), as Node does when its HTTPS setup fails.

use super::mounter::BoxFuture;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// What `new TlsManager({...})` is given in supervisor.js.
#[derive(Clone, Debug)]
pub struct TlsSetup {
    /// DATA/tls (root only)
    pub dir: PathBuf,
    /// TLS_HOSTNAMES as given (to be parsed with parseHostnames)
    pub hostnames: String,
    pub cert_file: Option<String>,
    pub key_file: Option<String>,
    /// HOST, passed with the ACME settings
    pub host: Option<String>,
}

/// The hooks `tls.startAcme` is given.
#[derive(Clone)]
pub struct AcmeHooks {
    pub delay: Duration,
    /// a token to answer at /.well-known/acme-challenge/<token>
    pub publish: Arc<dyn Fn(String, String) + Send + Sync>,
    pub unpublish: Arc<dyn Fn(String) + Send + Sync>,
    /// after an order: `certChanged`
    pub on_change: Arc<dyn Fn(bool) + Send + Sync>,
}

/// The supervisor's view of TlsManager.
pub trait Tls: Send + Sync {
    /// `exportForApp(tls, dir)`: write server.crt, server.key, ca.crt and
    /// status.json into `dir` (fresh temp files, never through a link).
    /// The supervisor then makes them root:PGID, 0640 for the key.
    fn export_for_app(&self, dir: PathBuf) -> BoxFuture<'_, Result<(), String>>;
    /// `parseHostnames(list.join(','))`
    fn parse_hostnames(&self, joined: &str) -> Vec<String>;
    /// `tls.setHostnames(names)`: Ok(caReplaced)
    fn set_hostnames(&self, names: Vec<String>) -> BoxFuture<'_, Result<bool, String>>;
    /// Is Let's Encrypt configured (`tls.acme`)?
    fn has_acme(&self) -> bool;
    /// `tls.acme.pending`: (token, keyAuthorization) still waiting for their check
    fn acme_pending(&self) -> Vec<(String, String)>;
    /// `tls.startAcme(hooks)`
    fn start_acme(&self, hooks: AcmeHooks);
}

/// The supervisor's log, handed to the TLS manager (`log: { info: log, warn }`):
/// lines go to the console and to the app's Logs.
#[derive(Clone)]
pub struct Log {
    pub info: Arc<dyn Fn(String) + Send + Sync>,
    pub warn: Arc<dyn Fn(String) + Send + Sync>,
}

/// Builds the TLS manager (`new TlsManager(...)`, with `acmeConfigFromEnv`
/// inside: its failure is a `warn("Let's Encrypt is off: ...")`, not an error).
/// `Err` is logged as "HTTPS setup failed: ...".
pub type TlsFactory = Arc<dyn Fn(&TlsSetup, Log) -> Result<Arc<dyn Tls>, String> + Send + Sync>;
