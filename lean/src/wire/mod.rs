//! The integrated server: every area served through core.
//!
//! Core's `AppState` and `Router` are the one entry point (core/README.md).
//! This module makes each area on core's state, implements each area's
//! small context trait on it (`footage.rs`, `ops.rs`, `viewer.rs`, `ui.rs`,
//! `can.rs`), wires the hooks the areas have on one another, and puts every
//! route of the Node server's router into core's router (`routes.rs`, made
//! from docs/api-contract.json), each answered by its area.
//!
//! Who asks (the session's user, the client address, HTTPS, a recent
//! password) comes from core's checks: the footage, ops and CAN areas take it
//! as a value; the viewer and ui areas ask their context, which reads it from
//! the request this thread is answering (`Who`, set around each call).

pub mod arrival;
pub mod can;
pub mod converter;
pub mod footage;
pub mod ops;
pub mod routes;
pub mod ui;
pub mod viewer;

use crate::app::App;
use crate::core::http::{accepts_compression, ApiRaw, RawReq, Res};
use crate::core::{Access, AppState, Ctx, HttpError, Reply, Router};
use axum::body::Body;
use axum::http::{header, HeaderValue, Method, Response};
use futures_util::FutureExt;
use http_body_util::BodyExt;
use serde_json::json;
use std::cell::RefCell;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// Which area answers a route of routes.rs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Area {
    Ops,
    Ui,
    Viewer,
    Can,
    Footage,
    /// the first slice's day and recording lists (api.rs)
    Slice,
    Converter,
    /// not ported yet
    None,
}

/// Every area on core's state.
pub struct Server {
    pub state: Arc<AppState>,
    pub rt: tokio::runtime::Handle,
    app: OnceLock<Arc<App>>,
    ops: OnceLock<Arc<crate::ops::Ops>>,
    viewer: OnceLock<Arc<crate::viewer::Viewer>>,
    ui: OnceLock<Arc<crate::ui::Ui>>,
    can: OnceLock<Arc<crate::can::routes::Can>>,
    converter: OnceLock<Arc<converter::Conv>>,
    arrival: OnceLock<Arc<crate::arrival::Area>>,
}

impl Server {
    pub fn arrival(&self) -> Option<&Arc<crate::arrival::Area>> {
        self.arrival.get()
    }
    pub fn converter(&self) -> Option<&Arc<converter::Conv>> {
        self.converter.get()
    }
    pub fn app(&self) -> &Arc<App> {
        self.app.get().expect("footage area")
    }
    pub fn ops(&self) -> Option<&Arc<crate::ops::Ops>> {
        self.ops.get()
    }
    pub fn viewer(&self) -> Option<&Arc<crate::viewer::Viewer>> {
        self.viewer.get()
    }
    pub fn ui(&self) -> Option<&Arc<crate::ui::Ui>> {
        self.ui.get()
    }
    pub fn can(&self) -> Option<&Arc<crate::can::routes::Can>> {
        self.can.get()
    }
}

// ---- who asks (the request this thread answers)

/// What core worked out about the request being answered.
#[derive(Clone, Debug, Default)]
pub struct Who {
    pub user: Option<String>,
    pub client: String,
    /// isSecure(req)
    pub secure: bool,
    /// auth.recentlyConfirmed
    pub confirmed: bool,
    pub session_hash: Option<String>,
}

impl Who {
    pub fn of(c: &Ctx) -> Who {
        let view = c.view();
        Who {
            user: c.user.clone(),
            client: c.client.clone(),
            secure: c.secure,
            confirmed: c.state.auth.recently_confirmed(&view),
            session_hash: c.state.auth.session_hash(&view),
        }
    }
    /// index.js by(req, user)
    pub fn by(&self) -> String {
        format!("{} from {}", self.user.as_deref().filter(|u| !u.is_empty()).unwrap_or("someone"), self.client)
    }
}

thread_local! {
    static CURRENT: RefCell<Option<Who>> = const { RefCell::new(None) };
}

struct Scope;
impl Drop for Scope {
    fn drop(&mut self) {
        CURRENT.with(|c| *c.borrow_mut() = None);
    }
}

/// Run `f` as the answer to the request of `who` (the viewer's and ui's contexts read it).
pub fn as_who<T>(who: Who, f: impl FnOnce() -> T) -> T {
    CURRENT.with(|c| *c.borrow_mut() = Some(who));
    let _scope = Scope;
    f()
}

/// The request this thread is answering, if any.
pub fn current() -> Option<Who> {
    CURRENT.with(|c| c.borrow().clone())
}

// ---- answers

/// http.js sendJson's gzip for an area's buffered JSON answer: over 1 KB (UTF-16 units),
/// when the browser takes br or gzip.
pub fn gzip_json(res: Res, accept: &str) -> Res {
    let json = res.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|t| t.starts_with("application/json"));
    if !json || res.headers().contains_key(header::CONTENT_ENCODING) || !accepts_compression(accept) {
        return res;
    }
    // (only a body already in memory; a stream goes as it is)
    if hyper::body::Body::size_hint(res.body()).exact().is_none() {
        return res;
    }
    let (mut parts, body) = res.into_parts();
    let bytes = match body.collect().now_or_never() {
        Some(Ok(c)) => c.to_bytes(),
        _ => return Response::from_parts(parts, Body::empty()),
    };
    if String::from_utf8_lossy(&bytes).encode_utf16().count() <= 1024 {
        return Response::from_parts(parts, Body::from(bytes));
    }
    use std::io::Write;
    let mut z = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(4));
    let _ = z.write_all(&bytes);
    let zipped = z.finish().unwrap_or_default();
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    parts.headers.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    Response::from_parts(parts, Body::from(zipped))
}

fn raw(res: Res, c: &Ctx) -> Result<Reply, HttpError> {
    Ok(Reply::Raw(gzip_json(res, c.accept_encoding())))
}

/// The body core read, as bytes again for the areas that read their own (None: empty).
pub fn body_bytes(c: &Ctx) -> bytes::Bytes {
    match &c.body {
        Some(v) => bytes::Bytes::from(serde_json::to_vec(v).unwrap_or_default()),
        None => bytes::Bytes::new(),
    }
}

// ---- making it

/// Every area on `state`, their hooks wired, and their routes in `r`. Call inside the runtime.
pub fn build(state: Arc<AppState>, r: &mut Router) -> Arc<Server> {
    let srv = Arc::new(Server {
        state: state.clone(),
        rt: tokio::runtime::Handle::current(),
        app: OnceLock::new(),
        ops: OnceLock::new(),
        viewer: OnceLock::new(),
        ui: OnceLock::new(),
        can: OnceLock::new(),
        converter: OnceLock::new(),
        arrival: OnceLock::new(),
    });
    // footage first: every other area reads its vehicles and scans
    let _ = srv.app.set(footage::make(&srv));
    let _ = srv.ops.set(ops::make(&srv));
    let _ = srv.viewer.set(viewer::make(&srv));
    let _ = srv.can.set(can::make(&srv));
    let _ = srv.ui.set(ui::make(&srv));
    // (before the converter: its hook records the original's checksum before a replace)
    let _ = srv.arrival.set(arrival::make(&srv));
    if let Some(c) = converter::make(&srv) {
        let _ = srv.converter.set(c);
    }
    hooks(&srv);
    register(&srv, r);
    srv
}

/// Start the areas' background work: shares and scans, policies, the viewer's passes, ops' checks.
pub fn start(srv: &Arc<Server>) {
    let app = srv.app().clone();
    crate::footage::routes::wire(&app);
    app.vehicles.bootstrap_from_env();
    app.vehicles.start_all();
    // a light rescan of every healthy share every SCAN_INTERVAL_MINUTES (inventory.js: every sixth looks at every file)
    let minutes = srv.state.config.scan_interval_minutes;
    let minutes = if minutes.is_finite() && minutes > 0.0 { minutes } else { 15.0 };
    let every = app.clone();
    srv.rt.spawn(async move {
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
    // the cleanup policies whose time has come, every minute
    let policies = app.clone();
    srv.rt.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        tick.tick().await;
        loop {
            tick.tick().await;
            let a = policies.clone();
            let _ = tokio::task::spawn_blocking(move || {
                crate::footage::policies::tick(&a, chrono::Local::now());
                a.core.announce("bin");
            })
            .await;
        }
    });
    if let Some(ops) = srv.ops() {
        ops.start();
    }
    if let Some(can) = srv.can() {
        can.start();
    }
    if let Some(conv) = srv.converter() {
        converter::start(srv, conv);
    }
    if let Some(a) = srv.arrival() {
        a.start();
    }
    // index.js onScanned: after each finished scan, Sentry USB's status read again, then the
    // arrival checksums kicked
    let s = srv.clone();
    std::thread::Builder::new()
        .name("scan-watch".into())
        .spawn(move || {
            let mut seen: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
            loop {
                std::thread::sleep(Duration::from_millis(500));
                let app = s.app();
                for v in app.vehicles.list() {
                    let Some(at) = app.state_of(&v.id).filter(|st| st.scanned).and_then(|st| st.scanned_at) else { continue };
                    if seen.insert(v.id.clone(), at) != Some(at) {
                        if let Some(can) = s.can() {
                            can.usb.fresh(&v.id);
                        }
                        if let Some(a) = s.arrival() {
                            a.scanned();
                        }
                    }
                }
            }
        })
        .ok();
}

fn hooks(srv: &Arc<Server>) {
    let st = &srv.state;
    let s = srv.clone();
    st.hooks.vehicle_exists.set(Arc::new(move |id: &str| s.app().vehicle(id).is_some()));
    if let Some(ops) = srv.ops().cloned() {
        // the supervisor's RAPL readings (stats.setRapl), a 500's crash note, a panic's
        let o = ops.clone();
        st.hooks.rapl_reading.set(Arc::new(move |m: &serde_json::Value| o.rapl_reading(m)));
        let o = ops.clone();
        st.hooks.server_error.set(Arc::new(move |name: &str, message: &str, stack: &str| o.note_server_error(name, message, stack)));
        let o = ops.clone();
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let message = info.payload().downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| info.payload().downcast_ref::<String>().cloned()).unwrap_or_else(|| "panic".into());
            let at = info.location().map(|l| format!("    at {}:{}:{}", l.file(), l.line(), l.column())).unwrap_or_default();
            o.note_crash("Panic", &message, &at);
            default(info);
        }));
        let o = ops.clone();
        st.hooks.reports_configured.set(Arc::new(move || o.reports.status()["configured"] == json!(true)));
        let o = ops.clone();
        st.hooks.reports_setup.set(Arc::new(move |share: bool, anonymous: bool| o.reports.set_settings(&json!({ "share": share, "anonymous": anonymous })).map_err(|e| e.message)));
    }
    if let Some(ui) = srv.ui().cloned() {
        st.hooks.note_start_call.set(Arc::new(move |h: &str, path_and_search: &str, headers: &axum::http::HeaderMap| {
            let (p, q) = path_and_search.split_once('?').map_or((path_and_search, String::new()), |(p, q)| (p, format!("?{q}")));
            ui.note_start_call(h, p, &q, headers);
        }));
    }
    let s = srv.clone();
    st.hooks.on_shutdown.lock().unwrap().push(Box::new(move || {
        if let Some(ui) = s.ui() {
            ui.exporter.stop();
        }
        if let Some(v) = s.viewer() {
            v.speed_index.stop();
        }
        if let Some(ops) = s.ops() {
            ops.stop();
        }
        if let Some(conv) = s.converter() {
            conv.runtime.shutdown();
        }
        if let Some(a) = s.arrival() {
            a.arrival.stop();
        }
        if let Some(app) = s.app.get() {
            app.vehicles.stop_all();
        }
    }));
}

/// Every route of routes.rs into core's router, and the paths answered by hand.
fn register(srv: &Arc<Server>, r: &mut Router) {
    for (m, p, area) in routes::ROUTES {
        let method: Method = m.parse().expect("method");
        let s = srv.clone();
        r.add(method, p, Access::SignedIn, move |c: &mut Ctx| answer(&s, area, c));
    }
    // index.js answers these by hand, after the sign-in and CSRF checks
    let s = srv.clone();
    r.api_raw("/api/media", move |a: ApiRaw| {
        let s = s.clone();
        Box::pin(async move {
            let c = a.ctx;
            tokio::task::spawn_blocking(move || crate::api::media_route(s.app(), &c.method, &c.headers, &c.query)).await.unwrap_or_else(|_| internal())
        })
    });
    let s = srv.clone();
    r.api_raw("/api/scrub", move |a: ApiRaw| {
        let s = s.clone();
        Box::pin(async move {
            let mut c = a.ctx;
            if c.method != Method::HEAD {
                c.method = Method::GET;
            }
            tokio::task::spawn_blocking(move || viewer::scrub(&s, &c)).await.unwrap_or_else(|_| internal())
        })
    });
    let s = srv.clone();
    r.api_raw("/api/converter/events", move |a: ApiRaw| {
        let s = s.clone();
        Box::pin(async move { converter::events(s, a).await })
    });
    let s = srv.clone();
    r.api_raw("/api/ui-packs/upload", move |a: ApiRaw| {
        let s = s.clone();
        Box::pin(async move { ui::upload(s, a).await })
    });
    // their own tokens, before core's checks
    let s = srv.clone();
    r.raw("/metrics", move |q: RawReq| {
        let s = s.clone();
        Box::pin(async move { tokio::task::spawn_blocking(move || ops::metrics(&s, &q)).await.unwrap_or_else(|_| internal()) })
    });
    for p in ["/api/can/logs", "/api/can/logs/"] {
        let s = srv.clone();
        r.raw(p, move |q: RawReq| {
            let s = s.clone();
            Box::pin(async move { can::upload(s, q).await })
        });
    }
    // pages and files
    let s = srv.clone();
    r.web(move |w| {
        let s = s.clone();
        Box::pin(async move { tokio::task::spawn_blocking(move || ui::page(&s, w)).await.unwrap_or_else(|_| internal()) })
    });
}

fn internal() -> Res {
    crate::core::http::error_json(500, "Internal error", None, "")
}

fn answer(srv: &Arc<Server>, area: Area, c: &mut Ctx) -> Result<Reply, HttpError> {
    let not_here = || HttpError::new(404, "Not found");
    match area {
        Area::Ops => ops::answer(srv, c),
        Area::Footage => footage::answer(srv, c),
        Area::Slice => crate::api::slice_route(srv.app(), &c.method, &c.raw_path, &c.query, &c.headers).map_or_else(|| Err(not_here()), |res| raw(res, c)),
        Area::Viewer => viewer::answer(srv, c),
        Area::Ui => ui::answer(srv, c),
        Area::Can => can::answer(srv, c),
        Area::Converter => converter::invoke(srv, c),
        Area::None => Err(HttpError::new(501, "Not in this server yet.")),
    }
}
