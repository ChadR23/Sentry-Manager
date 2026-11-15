//! Core and the root supervisor (src/supervisor/): the supervisor's view of
//! the TLS manager (`supervisor::ctx::Tls`, supervisor.js's TlsManager and
//! exportForApp), and the app's side of the fd-3 link (index.js: shutdown on
//! disconnect or `shutdown`, `supervisor-log`, `rapl-reading`, `tls-updated`,
//! Let's Encrypt's tokens).

use super::log::LogTo;
use super::state::AppState;
use super::tls::{TlsManager, TlsSource};
use crate::supervisor::ctx::{AcmeHooks, Log, Tls, TlsFactory, TlsSetup};
use crate::supervisor::link::Link;
use crate::supervisor::mounter::BoxFuture;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

/// The TLS manager, as the supervisor uses it.
pub struct SupervisorTls(pub Arc<TlsManager>);

impl Tls for SupervisorTls {
    fn export_for_app(&self, dir: PathBuf) -> BoxFuture<'_, Result<(), String>> {
        let m = self.0.clone();
        Box::pin(async move { tokio::task::spawn_blocking(move || super::tls::export_for_app(&m, &dir).map(|_| ())).await.map_err(|e| e.to_string())? })
    }

    fn parse_hostnames(&self, joined: &str) -> Vec<String> {
        super::tls::parse_hostnames(joined).unwrap_or_default()
    }

    fn set_hostnames(&self, names: Vec<String>) -> BoxFuture<'_, Result<bool, String>> {
        let m = self.0.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || m.set_hostnames(&names).map(|(_, replaced)| replaced).map_err(|e| e.message)).await.map_err(|e| e.to_string())?
        })
    }

    fn has_acme(&self) -> bool {
        self.0.acme.is_some()
    }

    fn acme_pending(&self) -> Vec<(String, String)> {
        self.0.acme.as_ref().map(|a| a.pending_list()).unwrap_or_default()
    }

    fn start_acme(&self, hooks: AcmeHooks) {
        if let Some(a) = &self.0.acme {
            a.share_tokens(hooks.publish.clone(), hooks.unpublish.clone());
            a.start(hooks.on_change.clone(), hooks.delay.as_millis() as i64);
        }
    }
}

/// `new TlsManager({ dir, log, hostnames: parseHostnames(TLS_HOSTNAMES), certFile, keyFile, acme })` in supervisor.js.
pub fn tls_factory() -> TlsFactory {
    Arc::new(|setup: &TlsSetup, log: Log| {
        let to = LogTo::new(move |level, m| if level == "info" { (log.info)(m) } else { (log.warn)(m) });
        let hostnames = super::tls::parse_hostnames(&setup.hostnames).map_err(|e| e.message)?;
        let mut env: std::collections::HashMap<String, String> = std::env::vars().collect();
        match &setup.host {
            Some(h) => env.insert("HOST".into(), h.clone()),
            None => env.remove("HOST"),
        };
        let acme = match super::acme::config_from_env(&env) {
            Ok(a) => a,
            Err(e) => {
                to.warn(format!("Let's Encrypt is off: {e}"));
                None
            }
        };
        let m = TlsManager::new(setup.dir.clone(), Some(to), hostnames, setup.cert_file.clone(), setup.key_file.clone(), acme);
        Ok(Arc::new(SupervisorTls(Arc::new(m))) as Arc<dyn Tls>)
    })
}

/// The app's side of the link: what index.js does with `process.on('message')` and `'disconnect'`.
pub fn attach(state: &Arc<AppState>, link: Arc<Link>) {
    let _ = state.supervisor.set(link.clone());
    if let Some(TlsSource::Supervised(s)) = &state.tls {
        s.set_link(link.clone());
    }
    let mut rx = link.subscribe();
    let st = state.clone();
    tokio::spawn(async move {
        loop {
            let m: Value = match rx.recv().await {
                Ok(m) => m,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => return,
            };
            match m["type"].as_str().unwrap_or("") {
                "shutdown" => super::server::shutdown(&st, "supervisor asked"),
                "rapl-reading" => {
                    if let Some(f) = st.hooks.rapl_reading.get() {
                        f(&m);
                    }
                }
                "supervisor-log" => {
                    let level = match m["level"].as_str() {
                        Some("warn") => "warn",
                        Some("error") => "error",
                        _ => "info",
                    };
                    let text: String = super::accounts::js_string(m.get("message")).encode_utf16().take(4000).collect::<Vec<u16>>().pipe_utf16();
                    st.logger.write(level, "supervisor", &text, false);
                }
                "tls-updated" => {
                    let s2 = st.clone();
                    tokio::task::spawn_blocking(move || {
                        if let Err(e) = super::server::reload_tls(&s2) {
                            s2.log.warn(format!("Reloading the certificate failed: {e}"));
                        }
                    });
                }
                "acme-challenge" | "acme-challenge-done" => {
                    if let Some(TlsSource::Supervised(s)) = &st.tls {
                        s.on_message(&m);
                    }
                }
                _ => {}
            }
        }
    });
    let st = state.clone();
    tokio::spawn(async move {
        link.disconnected().await;
        super::server::shutdown(&st, "supervisor gone");
    });
}

trait Utf16 {
    fn pipe_utf16(self) -> String;
}
impl Utf16 for Vec<u16> {
    fn pipe_utf16(self) -> String {
        String::from_utf16_lossy(&self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The supervisor's factory makes the CA and exports the app's copy; the app's Supervised source serves it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn export_then_serve_from_the_copy() {
        if std::process::Command::new("openssl").arg("version").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("lean-sup-tls-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let lines = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let (a, b) = (lines.clone(), lines.clone());
        let log = Log { info: Arc::new(move |m| a.lock().unwrap().push(m)), warn: Arc::new(move |m| b.lock().unwrap().push(m)) };
        let setup = TlsSetup { dir: dir.join("tls"), hostnames: "nas.lan".into(), cert_file: None, key_file: None, host: None };
        let tls = tls_factory()(&setup, log).unwrap();
        assert!(!tls.has_acme());
        assert_eq!(tls.parse_hostnames("A.lan, a.lan"), vec!["a.lan"]);
        tls.export_for_app(dir.join("app")).await.unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(dir.join("app/server.key")).unwrap().permissions().mode() & 0o777, 0o600);
        for f in ["server.crt", "status.json", "ca.crt"] {
            assert!(dir.join("app").join(f).exists(), "{f}");
        }
        assert!(!dir.join("app/ca.key").exists());
        assert!(lines.lock().unwrap().iter().any(|l| l.contains("Issued the HTTPS certificate for localhost, 127.0.0.1, ::1, nas.lan")));
        let src = TlsSource::Supervised(super::super::tls::Supervised::new(dir.join("app")));
        let m = src.load().unwrap();
        assert!(super::super::tls::server_config(&m, true).is_ok());
        assert_eq!(src.status().unwrap()["mode"], "local-ca");
        assert!(src.ca_pem().is_some());
        // Let's Encrypt's tokens come from the supervisor
        if let TlsSource::Supervised(s) = &src {
            let t = "a".repeat(43);
            s.on_message(&serde_json::json!({ "type": "acme-challenge", "token": t, "keyAuthorization": format!("{t}.{}", "b".repeat(43)) }));
            assert!(src.challenge(&t).is_some());
            s.on_message(&serde_json::json!({ "type": "acme-challenge-done", "token": t }));
            assert!(src.challenge(&t).is_none());
        }
        assert!(tls.set_hostnames(vec!["8.8.8.8".into()]).await.unwrap_err().contains("public IP address"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
