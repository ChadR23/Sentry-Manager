//! sentry-lean: the lean backend's server.
//!
//! The environment is the Node server's (see src/core/config.rs for every
//! variable): PORT (9000), HOST (0.0.0.0), DATA_PATH (/data), APP_ROOT,
//! TLS_MODE, FOOTAGE_PATH and VEHICLE_NAME (the vehicle), TZ, ...
//! FOOTAGE_PATH or SMB_SHARE and VEHICLE_NAME make the vehicle on a first start; the
//! vehicles are kept in DATA_PATH/manager.db.
//!
//! Accounts, sessions and HTTPS come from core (the same manager.db and
//! /data/tls as Node): passwords only go over HTTPS. TLS_MODE=off serves
//! plain HTTP, only for running behind a reverse proxy that does HTTPS.

use axum::http::Method;
use sentry_lean::app::App;
use sentry_lean::core::{self, Access, Reply};
use sentry_lean::footage::{self, ctx::{Ctx, LocalCore, SupervisorMounter}, vehicles::{Options, Vehicles}};
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
            a.vehicles.list().iter().map(|v| serde_json::json!({ "id": v.id, "name": v.name, "root": v.root.to_string_lossy(), "timezone": v.timezone })).collect();
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

fn main() {
    // before any thread: as the top of server/index.js, and the supervisor's channel (fd 3)
    sentry_lean::supervisor::link::drop_malloc_arena_max();
    let fd = sentry_lean::supervisor::ipc::take_from_env();
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("runtime").block_on(run(fd));
}

async fn run(fd: Option<std::os::fd::OwnedFd>) {
    let link = sentry_lean::supervisor::link::Link::from_fd(fd).map(Arc::new);
    let mut config = core::Config::from_env();
    // (Node: supervised only with SENTRY_SUPERVISED=1 and a channel to the supervisor)
    config.supervised &= link.is_some();
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
    let app_root = cfg.app_root.clone();
    // (the manager database, logs and jobs: footage/ctx.rs LocalCore until core/ lands)
    let local = Arc::new(LocalCore::open(&data).expect("manager database"));
    let options = Options::from_env(&data, &app_root);
    // SMB vehicles are mounted by a local mounter, as index.js does when it runs without the
    // root supervisor (createLocalMounter: PUID / PGID, credentials in RUN_DIR); with the
    // supervisor, core passes its IpcMounter here instead (src/supervisor/README.md)
    let uid = std::env::var("PUID").ok().and_then(|v| v.parse().ok()).unwrap_or(unsafe { libc::getuid() });
    let gid = std::env::var("PGID").ok().and_then(|v| v.parse().ok()).unwrap_or(unsafe { libc::getgid() });
    let mounter = sentry_lean::supervisor::mounter::LocalMounter::new(options.footage_root.clone(), PathBuf::from(std::env::var("RUN_DIR").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "/run/sentry-six-manager".into())), uid, gid);
    local.set_mounter(Arc::new(SupervisorMounter::new(Arc::new(mounter), tokio::runtime::Handle::current())));
    let core: Arc<dyn Ctx> = local;
    let vehicles = Vehicles::new(core.clone(), options);
    // (two at once, as the Node server's default)
    let thumbnails = Thumbnails::new(data.join("thumbnails"), cfg.ffmpeg.clone(), 2);
    let app = App::new(vehicles, core, catalog, app_root, thumbnails);
    // the viewer area (src/viewer): telemetry, the speed index, previews, places, drives, Studio
    sentry_lean::viewer::Viewer::start(sentry_lean::viewer::glue::AppCtx::new(app.clone(), data.clone()));
    // share events: a share that is healthy settles its Recycle Bin and is scanned (the first
    // scan resumes from the catalog); then the vehicle of FOOTAGE_PATH / SMB_SHARE on a first
    // start, and every vehicle's share
    footage::routes::wire(&app);
    app.vehicles.bootstrap_from_env();
    app.vehicles.start_all();
    // a light rescan of every healthy share every SCAN_INTERVAL_MINUTES (15; inventory.js:
    // every sixth looks at every file)
    let every = app.clone();
    let minutes = if cfg.scan_interval_minutes.is_finite() && cfg.scan_interval_minutes > 0.0 { cfg.scan_interval_minutes } else { 15.0 };
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs_f64(minutes * 60.0));
        tick.tick().await;
        loop {
            tick.tick().await;
            for v in every.vehicles.list() {
                if every.vehicles.share(&v.id).is_some_and(|s| s.is_healthy()) {
                    every.scan(&v.id, true);
                }
            }
        }
    });
    {
        let a = app.clone();
        state.hooks.vehicle_exists.set(Arc::new(move |id: &str| a.vehicle(id).is_some()));
    }
    // the cleanup policies whose time has come, every minute
    let policies = app.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        tick.tick().await;
        loop {
            tick.tick().await;
            let a = policies.clone();
            let _ = tokio::task::spawn_blocking(move || {
                footage::policies::tick(&a, chrono::Local::now());
                a.core.announce("bin");
            })
            .await;
        }
    });

    // the ops area's background work (startup self-check, snapshots, update check, opt-in reports)
    api::ops_of(&app).start();
    let mut router = core::router();
    footage_routes(&mut router, app);
    core::server::install(&state, router);
    if let Some(l) = link {
        core::supervised::attach(&state, l);
    }
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
        core::server::shutdown(&st, which);
    });
    if let Err(e) = core::server::serve(state.clone()).await {
        state.log.error(format!("listen: {e}"));
        std::process::exit(1);
    }
}
