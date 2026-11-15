//! The request handler and the listeners (index.js handler and "listen"):
//! HTTPS and plain HTTP on one port (a TLS handshake starts with 0x16; plain
//! HTTP only answers /healthz and Let's Encrypt's check and redirects
//! everything else to HTTPS, so no password or footage ever goes over it),
//! HTTP/2 with HTTP/1.1, and the device port (CAN_PORT) while CAN uploads are on.

use super::accounts::{encode_uri_component, viewer_may};
use super::client_addr::{client_address, from_trusted_proxy};
use super::events;
use super::http::{error_json, security_headers, send_json, status, ConnInfo, Ctx, Handler, HttpError, RawReq, Reply, Res, Router, WebReq, RESERVED_RAW};
use super::state::AppState;
use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, Method, Request, Response};
use http_body_util::BodyExt;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

pub const BANNED_TEXT: &str = "Too many failed attempts from this address, so it is blocked for a while. Try again later.";
pub const TWO_FACTOR_OUTSIDE_TEXT: &str = "This account has no two-step sign-in, so it can only sign in from the home network. Sign in at home and turn it on under Account (two-step sign-in), then you can sign in from anywhere.";
pub const TWO_FACTOR_EVERYONE_TEXT: &str = "Every account needs two-step sign-in, and this one has none yet. Sign in once from the home network to set it up.";
pub const HOME_ONLY_CHANGES_TEXT: &str = "Changes that need an admin can only be made from the home network (Settings → Security). Viewing works from anywhere.";
pub const HOME_ONLY_PAGES_TEXT: &str = "From outside the home network, admin accounts can only watch (Settings → Security). Settings and the other admin pages open at home.";
pub const TWO_FACTOR_SETUP_TEXT: &str = "Turn on two-step sign-in first: every account needs it (Settings → Security).";
pub const UI_COOKIE: &str = "sm_ui_original";

const PUBLIC_STATIC: [&str; 8] = ["/web/s6/login.css", "/login", "/web/login.js", "/web/shell.css", "/web/icon.png", "/login/code", "/web/login-code.js", "/web/login-two-factor.js"];
const BAN_STEPS: [&str; 5] = ["/api/auth/login", "/api/auth/2fa/code", "/api/auth/setup", "/api/auth/confirm", "/api/auth/password"];
const SETUP_ONLY_API: [&str; 6] = ["GET /api/auth/me", "GET /api/auth/2fa", "POST /api/auth/2fa/start", "POST /api/auth/2fa/enable", "POST /api/auth/confirm", "POST /api/auth/logout"];

fn hval(h: &HeaderMap, k: &str) -> String {
    h.get(k).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()).unwrap_or_default()
}

/// isSecure(req): TLS on this connection, or a trusted proxy says it was HTTPS.
pub fn is_secure(state: &AppState, conn: &ConnInfo, headers: &HeaderMap) -> bool {
    if conn.encrypted {
        return true;
    }
    from_trusted_proxy(conn.peer_ip().as_deref(), &state.proxy) && hval(headers, "x-forwarded-proto").split(',').next().unwrap_or("").trim().to_lowercase() == "https"
}

/// The Host header, if it is a plain host[:port] (and trusted, when TRUSTED_HOSTS is set).
pub fn clean_host(state: &AppState, conn: &ConnInfo, headers: &HeaderMap, authority: Option<&str>) -> Option<String> {
    let fwd = if from_trusted_proxy(conn.peer_ip().as_deref(), &state.proxy) { hval(headers, "x-forwarded-host") } else { String::new() };
    let host = hval(headers, "host");
    let raw_all = if !fwd.is_empty() { fwd } else if !host.is_empty() { host } else { authority.unwrap_or("").to_string() };
    let raw = raw_all.split(',').next().unwrap_or("").trim().to_string();
    if raw.is_empty() || raw.len() > 300 || !raw.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'[' | b']' | b':')) {
        return None;
    }
    if !state.config.trusted_hosts.is_empty() {
        let mut name = raw.clone();
        if let Some(i) = name.rfind(':') {
            if !name[i + 1..].is_empty() && name[i + 1..].bytes().all(|b| b.is_ascii_digit()) {
                name.truncate(i);
            }
        }
        let name = name.trim_start_matches('[').trim_end_matches(']').to_lowercase();
        if !state.config.trusted_hosts.contains(&name) {
            return None;
        }
    }
    Some(raw)
}

fn redirect(status_code: u16, location: &str, cookie: Option<&str>) -> Res {
    let mut b = Response::builder().status(status_code).header(header::LOCATION, location);
    if let Some(c) = cookie {
        b = b.header(header::SET_COOKIE, c);
    }
    b.body(Body::empty()).unwrap()
}

fn text(status_code: u16, body: &str, extra: &[(&str, &str)]) -> Res {
    let mut b = Response::builder().status(status_code).header(header::CONTENT_TYPE, "text/plain");
    for (k, v) in extra {
        b = b.header(*k, *v);
    }
    b.body(Body::from(body.to_string())).unwrap()
}

/// Let's Encrypt's HTTP-01 check: only the exact tokens of a pending order.
fn acme_answer(state: &AppState, method: &Method, path: &str) -> Option<Res> {
    let tls = state.tls.as_ref()?;
    if (method != Method::GET && method != Method::HEAD) || !path.starts_with(super::acme::CHALLENGE_PREFIX) {
        return None;
    }
    let ka = tls.challenge(&path[super::acme::CHALLENGE_PREFIX.len()..])?;
    let len = ka.len().to_string();
    Some(
        Response::builder()
            .status(200)
            .header(header::CONTENT_TYPE, "text/plain")
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::CONTENT_LENGTH, len)
            .body(if method == Method::HEAD { Body::empty() } else { Body::from(ka) })
            .unwrap(),
    )
}

/// One decoded, normalized path for every decision (no %2F tricks).
fn clean_path(raw: &str) -> Option<String> {
    let p = crate::api::decode(raw, false)?;
    if p.contains('\0') || p.contains('\\') || p.contains("//") || p.split('/').any(|s| s == "." || s == "..") || !p.starts_with('/') {
        return None;
    }
    Some(p)
}

fn query_map(q: Option<&str>) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for pair in q.unwrap_or("").split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        out.insert(crate::api::decode(k, true).unwrap_or_default(), crate::api::decode(v, true).unwrap_or_default());
    }
    out
}

/// /v/<version>/<path> (VERSIONED in index.js): (path, version)
fn unversion(mut p: String) -> (String, Option<String>) {
    if p.starts_with("/v/assets/") {
        p = p[2..].to_string();
    }
    if let Some(rest) = p.strip_prefix("/v/") {
        if let Some(i) = rest.find('/') {
            let (v, tail) = (&rest[..i], &rest[i..]);
            if (1..=40).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') && !tail.starts_with("/api/") && !tail.starts_with("/v/") {
                return (tail.to_string(), Some(v.to_string()));
            }
        }
    }
    (p, None)
}

async fn read_json(body: Body, limit: usize) -> Result<Option<serde_json::Value>, HttpError> {
    let limited = http_body_util::Limited::new(body, limit);
    let bytes = match limited.collect().await {
        Ok(c) => c.to_bytes(),
        Err(e) => {
            if e.downcast_ref::<http_body_util::LengthLimitError>().is_some() {
                return Err(HttpError::new(413, "Request body too large"));
            }
            return Err(HttpError::internal(e.to_string()));
        }
    };
    let text = String::from_utf8_lossy(&bytes);
    if text.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&text).map(Some).map_err(|_| HttpError::new(400, "Invalid JSON"))
}

fn reply_response(r: Reply, accept: &str) -> Res {
    match r {
        Reply::Json(v, headers) => {
            let mut res = send_json(200, &v, accept);
            for (k, val) in headers {
                res.headers_mut().append(k, val);
            }
            res
        }
        Reply::Raw(res) => res,
    }
}

fn error_response(state: &AppState, e: &HttpError, method: &Method, raw_path: &str, accept: &str) -> Res {
    if e.status >= 500 {
        state.log.error(format!("{method} {raw_path}: {}", e.message));
    }
    let msg = if !e.explicit { "Internal error" } else if e.message.is_empty() { "Error" } else { e.message.as_str() };
    let mut r = error_json(e.status, msg, e.code.as_deref(), accept);
    for c in &e.set_cookie {
        if let Ok(v) = HeaderValue::from_str(c) {
            r.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    r
}

/// The path as `new URL(req.url, 'http://localhost').pathname` gives it: `\` is `/`, and dot
/// segments (also written %2e) are worked out. Every decision in Node starts from this.
pub fn whatwg_path(raw: &str) -> String {
    let p = raw.replace('\\', "/");
    let body = p.strip_prefix('/').unwrap_or(&p);
    let parts: Vec<&str> = body.split('/').collect();
    let mut out: Vec<&str> = Vec::new();
    let n = parts.len();
    for (i, s) in parts.iter().enumerate() {
        let l = s.to_ascii_lowercase();
        let last = i + 1 == n;
        if matches!(l.as_str(), ".." | ".%2e" | "%2e." | "%2e%2e") {
            out.pop();
            if last {
                out.push("");
            }
        } else if matches!(l.as_str(), "." | "%2e") {
            if last {
                out.push("");
            }
        } else {
            out.push(s);
        }
    }
    format!("/{}", out.join("/"))
}

/// The whole request handler.
pub async fn dispatch(state: Arc<AppState>, mut req: Request<Body>, conn: ConnInfo) -> Res {
    let path = req.uri().path();
    if path.contains('\\') || path.split('/').any(|s| s == "." || s == ".." || s.to_ascii_lowercase().contains("%2e")) {
        let fixed = whatwg_path(path);
        let pq = match req.uri().query() {
            Some(q) => format!("{fixed}?{q}"),
            None => fixed,
        };
        let mut parts = req.uri().clone().into_parts();
        if let Ok(v) = pq.parse() {
            parts.path_and_query = Some(v);
            if let Ok(u) = axum::http::Uri::from_parts(parts) {
                *req.uri_mut() = u;
            }
        }
    }
    let raw_path = req.uri().path().to_string();
    let mut res = handle(state, req, conn).await;
    // securityHeaders first in Node: a handler's own header of the same name wins
    let mut sec = HeaderMap::new();
    security_headers(&mut sec, &raw_path);
    for (k, v) in sec.iter() {
        if !res.headers().contains_key(k) {
            res.headers_mut().insert(k.clone(), v.clone());
        }
    }
    res
}

async fn handle(state: Arc<AppState>, req: Request<Body>, conn: ConnInfo) -> Res {
    let router = state.router();
    let method = req.method().clone();
    let headers = req.headers().clone();
    let accept = hval(&headers, "accept-encoding");
    let raw_path = req.uri().path().to_string();
    let raw_query = req.uri().query().map(String::from);
    let authority = req.uri().authority().map(|a| a.to_string());
    let client = client_address(conn.peer_ip().as_deref(), &headers, &state.proxy);
    let secure = is_secure(&state, &conn, &headers);

    // tokens of their own, before any other check: /metrics, CAN uploads, nodes
    if let Some(f) = router.raw_for(&raw_path) {
        return f(RawReq { state: state.clone(), req, conn, client, secure }).await;
    }
    if RESERVED_RAW.iter().any(|r| if r.ends_with('/') { raw_path.starts_with(r) } else { raw_path == *r }) {
        // (CAN uploads without the can area: as Node answers while they are off)
        let off = raw_path == "/api/can/logs" || raw_path.starts_with("/api/can/logs/");
        return error_json(404, "Not found", off.then_some("off"), &accept);
    }
    if let Some(r) = acme_answer(&state, &method, &raw_path) {
        return r;
    }
    if raw_path == "/healthz" {
        // readable cross-origin: the plain-HTTP page checks with it whether this device trusts the certificate
        return text(200, "ok", &[("cache-control", "no-store"), ("cross-origin-resource-policy", "cross-origin")]);
    }
    let Some(req_host) = clean_host(&state, &conn, &headers, authority.as_deref()) else { return error_json(421, "Unknown host name.", None, &accept) };
    let Some(p) = clean_path(&raw_path) else { return error_json(400, "Bad request", None, &accept) };
    let (p, version) = unversion(p);
    let query = query_map(raw_query.as_deref());
    let cookie_header = hval(&headers, "cookie");
    let view = super::auth::ReqView { secure, cookie: &cookie_header, agent: "" };
    let mut user = state.auth.user(&view);
    let is_api = p.starts_with("/api/");

    // a banned address: every sign-in step (and anything else without a session) is refused
    if is_api && p != "/api/auth/me" && (user.is_none() || BAN_STEPS.contains(&p.as_str())) && state.access.banned(&client).is_some() {
        return error_json(429, BANNED_TEXT, Some("BANNED"), &accept);
    }
    let mut setup_only = false;
    if let Some(u) = user.clone() {
        match state.two_factor_state(&u, state.from_home(&client)) {
            "out" => {
                if let Some(h) = state.auth.session_hash(&view) {
                    state.db.delete_session(&h);
                }
                state.audit.warn(format!("Signed out (no two-step sign-in, outside the home network): {u} from {client}"));
                if is_api {
                    let everyone = super::accounts::truthy(&state.access.get()["twoFactor"]["everyone"]);
                    return error_json(401, if everyone { TWO_FACTOR_EVERYONE_TEXT } else { TWO_FACTOR_OUTSIDE_TEXT }, Some("TWO_FACTOR_REQUIRED"), &accept);
                }
                user = None;
            }
            "setup" => {
                setup_only = true;
                if is_api && !SETUP_ONLY_API.contains(&format!("{method} {p}").as_str()) {
                    return error_json(403, TWO_FACTOR_SETUP_TEXT, Some("TWO_FACTOR_SETUP"), &accept);
                }
            }
            _ => {}
        }
    }
    if let Some(u) = user.clone() {
        let h = state.auth.session_hash(&view);
        let now = super::db::now_ms();
        if let Some(h) = &h {
            if is_api && method == Method::GET {
                if let Some(f) = state.hooks.note_start_call.get() {
                    let search = raw_query.as_ref().map(|q| format!("?{q}")).unwrap_or_default();
                    f(h, &format!("{p}{search}"), &headers);
                }
            }
            let due = {
                let mut seen = state.seen_at.lock().unwrap();
                if seen.get(h).is_some_and(|t| *t > now - 60_000) {
                    false
                } else {
                    seen.insert(h.clone(), now);
                    if seen.len() > 5000 {
                        seen.clear();
                    }
                    true
                }
            };
            if due {
                state.db.touch_session(h, Some(&client));
            }
        }
        if is_api && !viewer_may(method.as_str(), &p) {
            if state.accounts.role_of(Some(&u)).as_deref() == Some("viewer") {
                return error_json(403, "This account can only watch footage. An admin account can do this.", None, &accept);
            }
            let rules = state.access.get()["homeOnly"].clone();
            let pages = super::accounts::truthy(&rules["adminPages"]);
            let changes = super::accounts::truthy(&rules["adminChanges"]);
            if (pages || (changes && method != Method::GET && method != Method::HEAD)) && !state.from_home(&client) {
                return error_json(403, if pages { HOME_ONLY_PAGES_TEXT } else { HOME_ONLY_CHANGES_TEXT }, Some("HOME_NETWORK_ONLY"), &accept);
            }
        }
    }
    let public_static = PUBLIC_STATIC.contains(&p.as_str()) || (p.starts_with("/web/fonts/") && !p[11..].contains('/'));

    if is_api {
        let m = router.find(&method, &raw_path);
        let is_events = p == "/api/events";
        let by_hand = if m.is_none() { router.api_raw_for(&p) } else { None };
        if m.is_none() && !is_events && by_hand.is_none() {
            return error_json(404, "Not found", None, &accept);
        }
        let public = m.as_ref().is_some_and(|(r, _)| r.access == super::http::Access::Public);
        if user.is_none() && !public {
            return error_json(401, "Sign in first.", None, &accept);
        }
        if method != Method::GET && method != Method::HEAD {
            if headers.get("x-requested-with").map(|v| v.as_bytes()) != Some(b"sentry-six-manager") {
                return error_json(403, "Missing X-Requested-With header.", None, &accept);
            }
            let origin = hval(&headers, "origin");
            if !origin.is_empty() && origin != "null" {
                let origin_host = origin.parse::<axum::http::Uri>().ok().filter(|u| u.scheme().is_some()).and_then(|u| u.authority().map(|a| a.as_str().to_lowercase()));
                if origin_host.as_deref() != Some(req_host.to_lowercase().as_str()) {
                    return error_json(403, "Cross-site request refused.", None, &accept);
                }
            }
        }
        if is_events {
            let Some(sub) = state.hub.subscribe() else { return error_json(503, "Too many open connections.", None, &accept) };
            return Response::builder()
                .status(200)
                .header(header::CONTENT_TYPE, "text/event-stream")
                .header(header::CACHE_CONTROL, "no-store")
                .header("x-accel-buffering", "no")
                .body(events::stream_body(sub))
                .unwrap();
        }
        if let Some(f) = by_hand {
            let ctx = Ctx { state: state.clone(), method: method.clone(), raw_path: raw_path.clone(), path: p, params: HashMap::new(), query, raw_query, headers, body: None, user, conn, client, secure };
            return f(super::http::ApiRaw { ctx, body: req.into_body() }).await;
        }
        let (route, params) = m.unwrap();
        let route = route.clone();
        let body = if method == Method::GET {
            None
        } else {
            match read_json(req.into_body(), route.body_limit).await {
                Ok(b) => b,
                Err(e) => return error_response(&state, &e, &method, &raw_path, &accept),
            }
        };
        let mut ctx = Ctx { state: state.clone(), method: method.clone(), raw_path: raw_path.clone(), path: p, params, query, raw_query, headers, body, user, conn, client, secure };
        let out = match route.handler {
            Handler::Blocking(f) => match tokio::task::spawn_blocking(move || f(&mut ctx)).await {
                Ok(r) => r,
                Err(e) => Err(HttpError::internal(format!("handler failed: {e}"))),
            },
            Handler::Async(f) => f(ctx).await,
        };
        return match out {
            Ok(r) => reply_response(r, &accept),
            Err(e) => error_response(&state, &e, &method, &raw_path, &accept),
        };
    }

    // /original: this browser shows the built-in interface from now on (a cookie), whatever pack is chosen
    if p == "/original" {
        let off = query.get("off").map(String::as_str) == Some("1");
        let cookie = format!(
            "{UI_COOKIE}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{}",
            if off { "" } else { "1" },
            if off { 0 } else { 365 * 86400 },
            if secure { "; Secure" } else { "" }
        );
        let mut r = redirect(302, "/#/settings/interface", Some(&cookie));
        r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        return r;
    }
    let html = p.to_lowercase().ends_with(".html") || p.to_lowercase().ends_with(".htm");
    if setup_only && !public_static && p != "/login/two-factor" && (p == "/" || html || p.starts_with("/studio")) {
        let mut r = redirect(302, "/login/two-factor", None);
        r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        return r;
    }
    if user.is_none() && !public_static {
        let pending = super::auth::parse_cookies(&cookie_header).get("sm_pending").cloned().filter(|t| (20..=80).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'));
        let to = if state.accounts.pending_user(pending.as_deref()).is_some() { "/login/code" } else { "/login" };
        let search = raw_query.as_ref().filter(|q| !q.is_empty()).map(|q| format!("?{q}")).unwrap_or_default();
        let next = if p == "/" { String::new() } else { format!("?next={}", encode_uri_component(&format!("{p}{search}"))) };
        return redirect(302, &format!("{to}{next}"), None);
    }
    let Some(web) = router.web.clone() else { return error_json(404, "Not found", None, &accept) };
    let session_hash = state.auth.session_hash(&view);
    web(WebReq { state: state.clone(), method, headers, path: p, raw_query, query, version, user, session_hash, secure, client }).await
}

/// The plain-HTTP side of the HTTPS port: /healthz, Let's Encrypt's check, else a redirect to HTTPS.
pub fn plain_redirect(state: &AppState, req: &Request<Body>, conn: &ConnInfo) -> Res {
    let path = &whatwg_path(req.uri().path());
    if path == "/healthz" {
        return text(200, "ok", &[]);
    }
    if let Some(r) = acme_answer(state, req.method(), path) {
        return r;
    }
    let target = clean_host(state, conn, req.headers(), req.uri().authority().map(|a| a.as_str())).unwrap_or_else(|| format!("localhost:{}", state.config.port));
    let search = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    let mut r = redirect(308, &format!("https://{target}{path}{search}"), None);
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

fn service(state: Arc<AppState>, conn: ConnInfo, plain_only: bool) -> impl hyper::service::Service<Request<hyper::body::Incoming>, Response = Res, Error = std::convert::Infallible, Future = futures_util::future::BoxFuture<'static, Result<Res, std::convert::Infallible>>> + Clone {
    hyper::service::service_fn(move |req: Request<hyper::body::Incoming>| {
        let state = state.clone();
        let conn = conn.clone();
        let fut: futures_util::future::BoxFuture<'static, Result<Res, std::convert::Infallible>> = Box::pin(async move {
            let req = req.map(Body::new);
            if plain_only {
                return Ok(plain_redirect(&state, &req, &conn));
            }
            Ok(dispatch(state, req, conn).await)
        });
        fut
    })
}

fn auto_builder() -> hyper_util::server::conn::auto::Builder<hyper_util::rt::TokioExecutor> {
    let mut b = hyper_util::server::conn::auto::Builder::new(hyper_util::rt::TokioExecutor::new());
    b.http1().timer(hyper_util::rt::TokioTimer::new()).header_read_timeout(Duration::from_secs(120));
    b
}

/// Load (or make) the certificate and put it in use.
pub fn reload_tls(state: &AppState) -> Result<(), String> {
    let Some(tls) = &state.tls else { return Ok(()) };
    let m = tls.load()?;
    let cfg = super::tls::server_config(&m, true)?;
    *state.tls_config.write().unwrap() = Some(cfg);
    Ok(())
}

/// Listen on PORT: HTTPS with plain HTTP redirected, or plain HTTP only with TLS_MODE=off.
pub async fn serve(state: Arc<AppState>) -> std::io::Result<()> {
    let host = state.config.host.clone();
    let port = state.config.port;
    let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
    if state.tls.is_none() {
        state.log.warn(format!("Sentry Six Manager on http://{host}:{port} WITHOUT HTTPS (TLS_MODE=off): only use this behind a reverse proxy that does HTTPS."));
        loop {
            let (sock, peer) = listener.accept().await?;
            let st = state.clone();
            tokio::spawn(async move {
                let conn = ConnInfo { peer: Some(peer), encrypted: false, device: false };
                let mut b = hyper::server::conn::http1::Builder::new();
                b.timer(hyper_util::rt::TokioTimer::new()).header_read_timeout(Duration::from_secs(120));
                let _ = b.serve_connection(hyper_util::rt::TokioIo::new(sock), service(st, conn, false)).await;
            });
        }
    }
    reload_tls(&state).map_err(std::io::Error::other)?;
    // renew before it expires (checked daily); Let's Encrypt says when it changed
    {
        let st = state.clone();
        tokio::spawn(async move {
            let mut t = tokio::time::interval(Duration::from_secs(24 * 3600));
            t.tick().await;
            loop {
                t.tick().await;
                let s2 = st.clone();
                let r = tokio::task::spawn_blocking(move || reload_tls(&s2)).await;
                if let Ok(Err(e)) = r {
                    st.log.warn(format!("HTTPS certificate check failed: {e}"));
                }
            }
        });
        if let Some(super::tls::TlsSource::Local(m)) = &state.tls {
            if let Some(a) = &m.acme {
                let st = state.clone();
                a.start(
                    Arc::new(move |changed| {
                        if changed {
                            let s2 = st.clone();
                            tokio::task::spawn_blocking(move || {
                                if let Err(e) = reload_tls(&s2) {
                                    s2.log.warn(format!("HTTPS certificate check failed: {e}"));
                                }
                            });
                        }
                    }),
                    3000,
                );
            }
        }
    }
    state.log.info(format!("Sentry Six Manager on https://{host}:{port} (lean)"));
    // more open connections than a household's devices ever need are refused
    let slots = Arc::new(tokio::sync::Semaphore::new(1024));
    loop {
        let (sock, peer) = listener.accept().await?;
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            drop(sock);
            continue;
        };
        let st = state.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let mut first = [0u8; 1];
            match tokio::time::timeout(Duration::from_secs(15), sock.peek(&mut first)).await {
                Ok(Ok(1)) => {}
                _ => return,
            }
            if first[0] == 0x16 {
                let Some(cfg) = st.tls_config.read().unwrap().clone() else { return };
                let Ok(Ok(tls)) = tokio::time::timeout(Duration::from_secs(15), tokio_rustls::TlsAcceptor::from(cfg).accept(sock)).await else { return };
                let conn = ConnInfo { peer: Some(peer), encrypted: true, device: false };
                let _ = auto_builder().serve_connection(hyper_util::rt::TokioIo::new(tls), service(st, conn, false)).await;
            } else {
                let conn = ConnInfo { peer: Some(peer), encrypted: false, device: false };
                let mut b = hyper::server::conn::http1::Builder::new();
                b.timer(hyper_util::rt::TokioTimer::new()).header_read_timeout(Duration::from_secs(20));
                let _ = b.serve_connection(hyper_util::rt::TokioIo::new(sock), service(st, conn, true)).await;
            }
        });
    }
}

// ---- the device port (CAN_PORT): only /api/can/logs…, while CAN uploads are on

/// Whether the device port should listen (the `can` setting's `enabled`).
pub fn device_port_wanted(state: &AppState) -> bool {
    state.db.get("can").is_some_and(|c| super::accounts::truthy(&c["enabled"]))
}

async fn device_request(state: Arc<AppState>, req: Request<Body>, conn: ConnInfo) -> Res {
    let p = req.uri().path().to_string();
    let accept = hval(req.headers(), "accept-encoding");
    if p == "/api/can/logs" || p.starts_with("/api/can/logs/") {
        if let Some(f) = state.router().raw_for(&p) {
            let client = client_address(conn.peer_ip().as_deref(), req.headers(), &state.proxy);
            let secure = is_secure(&state, &conn, req.headers());
            return f(RawReq { state: state.clone(), req, conn, client, secure }).await;
        }
    }
    let mut r = error_json(404, "Not found", None, &accept);
    security_headers(r.headers_mut(), &p);
    r
}

async fn device_listen(state: Arc<AppState>) {
    let (host, port) = (state.config.host.clone(), state.config.can_port);
    let listener = match tokio::net::TcpListener::bind((host.as_str(), port)).await {
        Ok(l) => l,
        Err(e) => {
            state.log.warn(format!("Device port: {e}"));
            return;
        }
    };
    let scheme = if state.tls.is_some() { "https" } else { "http" };
    state.log.info(format!("Device port on {scheme}://{host}:{port} (CAN Bridge uploads at /api/can/logs)"));
    let slots = Arc::new(tokio::sync::Semaphore::new(256));
    let per_address: Arc<std::sync::Mutex<HashMap<std::net::IpAddr, usize>>> = Default::default();
    loop {
        let Ok((sock, peer)) = listener.accept().await else { continue };
        let Ok(permit) = slots.clone().try_acquire_owned() else { continue };
        {
            let mut m = per_address.lock().unwrap();
            let n = m.entry(peer.ip()).or_insert(0);
            if *n >= 6 {
                continue;
            }
            *n += 1;
        }
        let st = state.clone();
        let pa = per_address.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let svc = {
                let st = st.clone();
                move |encrypted: bool| {
                    let st = st.clone();
                    hyper::service::service_fn(move |req: Request<hyper::body::Incoming>| {
                        let st = st.clone();
                        async move { Ok::<_, std::convert::Infallible>(device_request(st, req.map(Body::new), ConnInfo { peer: Some(peer), encrypted, device: true }).await) }
                    })
                }
            };
            let mut b = hyper::server::conn::http1::Builder::new();
            b.timer(hyper_util::rt::TokioTimer::new()).header_read_timeout(Duration::from_secs(20));
            // a connection that has not sent a request within 15 s is closed
            let mut first = [0u8; 1];
            if !matches!(tokio::time::timeout(Duration::from_secs(15), sock.peek(&mut first)).await, Ok(Ok(1))) {
            } else if st.tls.is_some() {
                let cfg = st.tls_config.read().unwrap().clone().map(|c| {
                    let mut c = (*c).clone();
                    c.alpn_protocols = vec![b"http/1.1".to_vec()];
                    Arc::new(c)
                });
                if let Some(cfg) = cfg {
                    if let Ok(Ok(tls)) = tokio::time::timeout(Duration::from_secs(15), tokio_rustls::TlsAcceptor::from(cfg).accept(sock)).await {
                        let _ = b.serve_connection(hyper_util::rt::TokioIo::new(tls), svc(true)).await;
                    }
                }
            } else {
                let _ = b.serve_connection(hyper_util::rt::TokioIo::new(sock), svc(false)).await;
            }
            let mut m = pa.lock().unwrap();
            if let Some(n) = m.get_mut(&peer.ip()) {
                *n -= 1;
                if *n == 0 {
                    m.remove(&peer.ip());
                }
            }
        });
    }
}

/// Open or close the device port to match the setting (call after changing `can.enabled`).
pub fn sync_device_port(state: &Arc<AppState>) {
    let wanted = device_port_wanted(state);
    let mut h = state.device_port.lock().unwrap();
    if wanted && h.as_ref().is_none_or(|j| j.is_finished()) {
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            *h = Some(rt.spawn(device_listen(state.clone())));
        }
    } else if !wanted {
        if let Some(j) = h.take() {
            j.abort();
            state.log.info("Device port closed (CAN uploads are off)");
        }
    }
}

/// index.js shutdown(signal): every live stream ends, the areas' shutdown work runs, the process exits 0.
pub fn shutdown(state: &AppState, why: &str) {
    static STOPPING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STOPPING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    state.log.info(format!("{why}: shutting down"));
    state.hub.close_all();
    let work: Vec<_> = std::mem::take(&mut *state.hooks.on_shutdown.lock().unwrap());
    for f in work {
        f();
    }
    state.log.info("Stopped cleanly");
    std::process::exit(0);
}

/// The router every request goes through (set once, before listening).
pub fn install(state: &Arc<AppState>, router: Router) {
    let _ = state.router.set(Arc::new(router));
}

pub fn not_found_status() -> axum::http::StatusCode {
    status(404)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_as_whatwg_url() {
        // values from new URL(p, 'http://localhost').pathname
        for (p, want) in [("/web/%2e%2e/x", "/x"), ("/a/.", "/a/"), ("/a/..", "/"), ("/..", "/"), ("/a\\b", "/a/b"), ("/a/%2E/b", "/a/b"), ("/a//b/../c", "/a//c"), ("/", "/"), ("/x", "/x")] {
            assert_eq!(whatwg_path(p), want, "{p}");
        }
    }

    #[test]
    fn versioned_paths() {
        assert_eq!(unversion("/v/abc123/web/app.js".into()), ("/web/app.js".into(), Some("abc123".into())));
        assert_eq!(unversion("/v/abc/api/jobs".into()), ("/v/abc/api/jobs".into(), None));
        assert_eq!(unversion("/v/assets/x.png".into()), ("/assets/x.png".into(), None));
    }
}
