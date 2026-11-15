//! sentry-lean: the lean backend's server.
//!
//! The environment is the Node server's (see src/core/config.rs for every
//! variable): PORT (9000), HOST (0.0.0.0), DATA_PATH (/data), APP_ROOT,
//! TLS_MODE, FOOTAGE_PATH and VEHICLE_NAME (the vehicle), TZ, ...
//!
//! Accounts, sessions and HTTPS come from core (the same manager.db and
//! /data/tls as Node): passwords only go over HTTPS. TLS_MODE=off serves
//! plain HTTP, only for running behind a reverse proxy that does HTTPS.

use axum::http::Method;
use sentry_lean::app::{slug, vehicle_name, App, Vehicle};
use sentry_lean::core::{self, Access, Reply};
use sentry_lean::{api, catalog::Catalog, thumbnails::Thumbnails};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// The first slice's routes (footage list, recordings, media, speeds), behind core's checks.
fn footage_routes(r: &mut core::Router, app: Arc<App>) {
    let gets = [
        "/api/vehicles",
        "/api/vehicles/:id/days",
        "/api/vehicles/:id/recordings",
        "/api/vehicles/:id/recordings/:rid",
        "/api/vehicles/:id/recordings/:rid/thumbnail",
        "/api/vehicles/:id/speeds",
        "/api/speeds/status",
    ];
    for p in gets {
        let a = app.clone();
        r.get(p, move |c| Ok(Reply::Raw(api::api(&a, &c.method, &c.path, &c.query, &c.headers, &[]))));
    }
    let a = app.clone();
    r.post("/api/vehicles/:id/scan", move |c| Ok(Reply::Raw(api::api(&a, &c.method, &c.path, &c.query, &c.headers, &[]))));
    for m in [Method::GET, Method::HEAD] {
        let a = app.clone();
        r.add(m, "/api/media", Access::SignedIn, move |c| Ok(Reply::Raw(api::api(&a, &c.method, &c.path, &c.query, &c.headers, &[]))));
    }
    // (index.js /api/studio/context, enough for the contract tools' discovery until the ui area has it)
    let a = app.clone();
    r.get("/api/studio/context", move |c| {
        let version = std::fs::read_to_string(a.app_root.join("version.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v["version"].as_str().filter(|s| !s.is_empty()).map(|s| format!("{s} (web)")))
            .unwrap_or_else(|| "web".into());
        let vehicles: Vec<serde_json::Value> =
            a.vehicles.iter().map(|v| serde_json::json!({ "id": v.id, "name": v.name, "root": v.root.to_string_lossy(), "timezone": v.timezone })).collect();
        let mut roots = vec![c.state.config.converted_dir().to_string_lossy().into_owned()];
        roots.extend(c.state.config.extra_roots.iter().cloned());
        Ok(Reply::json(serde_json::json!({ "version": version, "vehicles": vehicles, "outputRoots": roots })))
    });
    let a = app.clone();
    r.web(move |w| {
        let a = a.clone();
        Box::pin(async move { tokio::task::spawn_blocking(move || api::web(&a, &w.method, &w.headers, &w.path)).await.unwrap_or_else(|_| core::http::error_json(500, "Internal error", None, "")) })
    });
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let config = core::Config::from_env();
    let state = match core::AppState::open(config) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let cfg = &state.config;
    let data = cfg.data.clone();
    let catalog = Catalog::open(&data.join("lean-catalog.sqlite")).expect("catalog");
    let mut vehicles = Vec::new();
    if let Some(p) = &cfg.footage_path {
        let root = PathBuf::from(p);
        if root.is_absolute() && root.exists() {
            match vehicle_name(cfg.vehicle_name.as_deref().unwrap_or("My car")) {
                Some(name) => vehicles.push(Vehicle { id: slug(&name), name, timezone: cfg.tz.clone().unwrap_or_else(|| "UTC".into()), root }),
                None => state.log.warn("Could not create the vehicle from the environment: Give the vehicle a name."),
            }
        } else {
            state.log.warn(format!("FOOTAGE_PATH {p} is not there: no vehicle"));
        }
    }
    // (two at once, as the Node server's default)
    let thumbnails = Thumbnails::new(data.join("thumbnails"), cfg.ffmpeg.clone(), 2);
    let app = App::new(vehicles, catalog, cfg.app_root.clone(), thumbnails);
    // the viewer area (src/viewer): telemetry, the speed index, previews, places, drives, Studio
    sentry_lean::viewer::Viewer::start(sentry_lean::viewer::glue::AppCtx::new(app.clone(), data.clone()));
    for v in &app.vehicles {
        app.scan(&v.id, true);
    }
    // a light rescan every SCAN_INTERVAL_MINUTES (inventory.js: every sixth looks at every file)
    let every = app.clone();
    let minutes = if cfg.scan_interval_minutes.is_finite() && cfg.scan_interval_minutes > 0.0 { cfg.scan_interval_minutes } else { 15.0 };
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs_f64(minutes * 60.0));
        tick.tick().await;
        loop {
            tick.tick().await;
            for v in &every.vehicles {
                every.scan(&v.id, true);
            }
        }
    });
    {
        let a = app.clone();
        state.hooks.vehicle_exists.set(Arc::new(move |id: &str| a.vehicle(id).is_some()));
    }

    // the ops area's background work (startup self-check, snapshots, update check, opt-in reports)
    api::ops_of(&app).start();
    let mut router = core::router();
    footage_routes(&mut router, app);
    core::server::install(&state, router);
    core::server::sync_device_port(&state);

    // housekeeping (index.js): expired sessions go every minute
    let st = state.clone();
    tokio::spawn(async move {
        let mut t = tokio::time::interval(Duration::from_secs(60));
        loop {
            t.tick().await;
            st.db.prune_sessions();
        }
    });

    let st = state.clone();
    tokio::spawn(async move {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal");
        let which = tokio::select! { _ = tokio::signal::ctrl_c() => "SIGINT", _ = term.recv() => "SIGTERM" };
        st.log.info(format!("{which}: shutting down"));
        st.hub.close_all();
        let work: Vec<_> = std::mem::take(&mut *st.hooks.on_shutdown.lock().unwrap());
        for f in work {
            f();
        }
        st.log.info("Stopped cleanly");
        std::process::exit(0);
    });
    if let Err(e) = core::server::serve(state.clone()).await {
        state.log.error(format!("listen: {e}"));
        std::process::exit(1);
    }
}
