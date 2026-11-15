//! sentry-lean: the lean backend's server.
//!
//! Environment (the Node server's names):
//!   PORT (9000), HOST (127.0.0.1), DATA_PATH (/data), APP_ROOT (/app: web/, src/, assets/),
//!   FOOTAGE_PATH and VEHICLE_NAME (the vehicle), TZ (its time zone, and the day of
//!   files named without a time), FFMPEG_PATH (ffmpeg: thumbnails made from clips,
//!   none without it).
//!
//! There are no accounts yet, so it only listens on this machine (loopback)
//! unless LEAN_NO_AUTH_ANYWHERE=1 says otherwise. When accounts come they
//! come with HTTPS: passwords never go over plain HTTP.

use sentry_lean::app::{slug, vehicle_name, App, Vehicle};
use sentry_lean::{api, catalog::Catalog, thumbnails::Thumbnails};
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::time::Duration;

fn env(name: &str, default: &str) -> String {
    std::env::var(name).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_string())
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let port: u16 = env("PORT", "9000").parse().expect("PORT");
    let host: IpAddr = env("HOST", "127.0.0.1").parse().expect("HOST must be an IP address");
    if !host.is_loopback() && env("LEAN_NO_AUTH_ANYWHERE", "") != "1" {
        eprintln!("sentry-lean has no sign-in yet: it listens on this machine only (HOST=127.0.0.1). Set LEAN_NO_AUTH_ANYWHERE=1 to listen on {host} anyway.");
        std::process::exit(2);
    }
    let data = PathBuf::from(env("DATA_PATH", "/data"));
    std::fs::create_dir_all(&data).expect("DATA_PATH");
    let catalog = Catalog::open(&data.join("lean-catalog.sqlite")).expect("catalog");
    let mut vehicles = Vec::new();
    if let Ok(p) = std::env::var("FOOTAGE_PATH") {
        let root = PathBuf::from(&p);
        if root.is_absolute() && root.exists() {
            match vehicle_name(&env("VEHICLE_NAME", "My car")) {
                Some(name) => vehicles.push(Vehicle { id: slug(&name), name, timezone: env("TZ", "UTC"), root }),
                None => eprintln!("Could not create the vehicle from the environment: Give the vehicle a name."),
            }
        } else {
            eprintln!("FOOTAGE_PATH {p} is not there: no vehicle");
        }
    }
    // (two at once, as the Node server's default)
    let thumbnails = Thumbnails::new(data.join("thumbnails"), env("FFMPEG_PATH", "ffmpeg"), 2);
    let app = App::new(vehicles, catalog, PathBuf::from(env("APP_ROOT", "/app")), thumbnails);
    // the viewer area (src/viewer): telemetry, the speed index, previews, places, drives, Studio
    sentry_lean::viewer::Viewer::start(sentry_lean::viewer::glue::AppCtx::new(app.clone(), data.clone()));
    for v in &app.vehicles {
        app.scan(&v.id, true);
    }
    // a light rescan every 15 minutes (inventory.js: every sixth looks at every file)
    let every = app.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(15 * 60));
        tick.tick().await;
        loop {
            tick.tick().await;
            for v in &every.vehicles {
                every.scan(&v.id, true);
            }
        }
    });

    // the ops area's background work (startup self-check, snapshots, update check, opt-in reports)
    api::ops_of(&app).start();
    let router = axum::Router::new().fallback(api::handle).with_state(app);
    let addr = SocketAddr::new(host, port);
    let listener = tokio::net::TcpListener::bind(addr).await.expect("listen");
    eprintln!("sentry-lean on http://{addr} (no sign-in: this machine only)");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal");
            tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
        })
        .await
        .expect("serve");
}
