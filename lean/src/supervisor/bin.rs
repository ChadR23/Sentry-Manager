//! sentry-lean-supervisor: the container's entrypoint (under tini), the port
//! of `server/supervisor.js`. It starts `sentry-lean` from the same folder as
//! PUID:PGID and serves its mount requests.
//!
//!   sentry-lean-supervisor               run the supervisor
//!   sentry-lean-supervisor healthcheck   GET /healthz on 127.0.0.1:PORT (Docker HEALTHCHECK)

use sentry_lean::supervisor::{healthcheck, Config, Supervisor};

fn main() {
    let arg = std::env::args().nth(1);
    if arg.as_deref() == Some("healthcheck") {
        let port = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(9000);
        std::process::exit(if healthcheck(port) { 0 } else { 1 });
    }
    if let Some(a) = arg {
        eprintln!("usage: sentry-lean-supervisor [healthcheck] (unknown argument {a:?})");
        std::process::exit(2);
    }
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
    let code = rt.block_on(async {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        use tokio::signal::unix::{signal, SignalKind};
        for (kind, num) in [(SignalKind::terminate(), libc::SIGTERM), (SignalKind::interrupt(), libc::SIGINT)] {
            let mut s = signal(kind).expect("signal");
            let tx = tx.clone();
            tokio::spawn(async move {
                while s.recv().await.is_some() {
                    let _ = tx.send(num);
                }
            });
        }
        // the HTTPS certificate authority and Let's Encrypt: core's (core/supervised.rs)
        Supervisor::new(Config::from_env(), Some(sentry_lean::core::supervised::tls_factory())).run(rx).await
    });
    std::process::exit(code);
}
