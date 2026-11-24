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
pub(super) fn clean_path(raw: &str) -> Option<String> {
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
pub(super) fn unversion(mut p: String) -> (String, Option<String>) {
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
    let bytes = match super::body::collect(body, limit).await {
        Ok(b) => b,
        Err(super::body::BodyError::TooLarge) => return Err(HttpError::new(413, "Request body too large")),
        Err(super::body::BodyError::TimedOut) => return Err(HttpError::new(408, super::body::TIMED_OUT_TEXT)),
        Err(super::body::BodyError::Failed(e)) => return Err(HttpError::internal(e)),
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
        if !e.explicit {
            if let Some(f) = state.hooks.server_error.get() {
                f("Error", &e.message, &format!("    at {method} {raw_path}"));
            }
        }
    }
    let msg = if !e.explicit { "Internal error" } else if e.message.is_empty() { "Error" } else { e.message.as_str() };
    let mut r = error_json(e.status, msg, e.code.as_deref(), accept);
    for c in &e.set_cookie {
        if let Ok(v) = HeaderValue::from_str(c) {
            r.headers_mut().append(header::SET_COOKIE, v);
        }
    }
    if e.status == 408 {
        // (the rest of that body is not read: the connection closes)
        super::body::close_after(&mut r);
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
    let is_api = p.starts_with("/api/");
    // the session's user, its two-step state and (for an admin route) its role are read on a
    // blocking thread: the async workers run no SQLite. A read that fails, or the step itself, is a
    // 500: never signed out
    let session = state.auth.session_hash(&view);
    let (mut user, two_factor, role) = match session.clone() {
        None => (None, None, None),
        Some(h) => {
            let (st, home, admin_route) = (state.clone(), state.from_home(&client), is_api && !viewer_may(method.as_str(), &p));
            let read = tokio::task::spawn_blocking(move || -> Result<_, super::db::DbError> {
                let user = st.auth.user_of(&h)?;
                let two_factor = match user.as_deref() {
                    Some(u) => Some(st.two_factor_state(u, home)?),
                    None => None,
                };
                let role = match user.as_deref() {
                    Some(u) if admin_route => st.accounts.role_of(Some(u))?,
                    _ => None,
                };
                Ok((user, two_factor, role))
            })
            .await;
            match read {
                Ok(Ok(r)) => r,
                Ok(Err(e)) => return error_response(&state, &HttpError::from(e), &method, &raw_path, &accept),
                Err(e) => return error_response(&state, &HttpError::internal(format!("the session could not be read: {e}")), &method, &raw_path, &accept),
            }
        }
    };

    // a banned address: every sign-in step (and anything else without a session) is refused
    if is_api && p != "/api/auth/me" && (user.is_none() || BAN_STEPS.contains(&p.as_str())) && state.access.banned(&client).is_some() {
        return error_json(429, BANNED_TEXT, Some("BANNED"), &accept);
    }
    let mut setup_only = false;
    if let (Some(u), Some(two_factor)) = (user.clone(), two_factor) {
        match two_factor {
            "out" => {
                if let Some(h) = session.clone() {
                    // (refused either way; a session that stays is refused again while the rule holds)
                    let st = state.clone();
                    let gone = tokio::task::spawn_blocking(move || st.db.delete_session(&h).map_err(|e| e.to_string())).await;
                    if let Err(e) = gone.unwrap_or_else(|e| Err(e.to_string())) {
                        state.log.warn(format!("A session the two-step rule signed out could not be removed: {e}"));
                    }
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
    if user.is_some() {
        let h = session.clone();
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
                // (a write: it waits for another connection's write, so not on one of the two async workers;
                // when and where a session was last used is shown on the signed-in devices list)
                let (st, h, ip) = (state.clone(), h.clone(), client.clone());
                tokio::task::spawn_blocking(move || {
                    if let Err(e) = st.db.touch_session(&h, Some(&ip)) {
                        st.log.warn(format!("A session's last use could not be noted: {e}"));
                    }
                });
            }
        }
        if is_api && !viewer_may(method.as_str(), &p) {
            if role.as_deref() == Some("viewer") {
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

/// Connections open on the web port in all (more than a household's devices ever need).
const WEB_CONNECTIONS: usize = 1024;

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
    let slots = Arc::new(tokio::sync::Semaphore::new(WEB_CONNECTIONS));
    // past it, a connection is answered 503 too_many_connections (a CAN upload can arrive here)
    let refusing = Arc::new(tokio::sync::Semaphore::new(REFUSING));
    let warned: Arc<Warned> = Default::default();
    loop {
        let (sock, peer) = listener.accept().await?;
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            let why = Refusal { line: format!("Web port: {WEB_CONNECTIONS} connections open in all; answering 503 to {}", peer.ip()), answer: TOO_MANY_IN_ALL };
            refused_connection(&state, &refusing, &warned, sock, peer, why, "Web port");
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
pub fn device_port_wanted(state: &AppState) -> Result<bool, super::db::DbError> {
    Ok(state.db.get("can")?.is_some_and(|c| super::accounts::truthy(&c["enabled"])))
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

/// Connections one address may hold open on the device port for requests without a valid
/// CAN Bridge token (the 7th on is only served with one).
const PER_ADDRESS: usize = 6;
/// Connections one address may hold open on the device port when its requests carry a valid
/// CAN Bridge token (a bridge on LTE sends many uploads at once from one address).
pub const PER_ADDRESS_WITH_TOKEN: usize = 32;
/// Connections open on the device port in all.
const DEVICE_CONNECTIONS: usize = 256;
/// Connections on one port that are kept only to answer 503 (past a limit), in all; past
/// this many more are closed without an answer.
const REFUSING: usize = 64;
/// The most of a refused request's body that is read (and dropped) before it is answered:
/// the largest CAN upload request (16 MiB piece and 1 MiB to spare).
const REFUSED_BODY: usize = 17 * 1024 * 1024;

const TOO_MANY_FROM_ADDRESS: &str = "Too many connections from this address; try again in a few seconds.";
const TOO_MANY_IN_ALL: &str = "Too many connections to this server; try again in a few seconds.";

/// 503 too_many_connections with Retry-After: 5, the last answer on its connection.
fn too_many_connections(msg: &str) -> Res {
    let mut r = error_json(503, msg, Some("too_many_connections"), "");
    r.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("5"));
    super::body::close_after(&mut r);
    r
}

/// Reads a refused request's body and drops it (up to REFUSED_BODY, a minute at most, ended
/// by 10 s without a byte), so a client still sending is not reset before it reads the 503.
async fn drop_body(mut body: Body) {
    use http_body_util::BodyExt;
    let end = tokio::time::Instant::now() + Duration::from_secs(60);
    let mut n = 0usize;
    while n <= REFUSED_BODY {
        let by = end.min(tokio::time::Instant::now() + Duration::from_secs(10));
        match tokio::time::timeout_at(by, body.frame()).await {
            Ok(Some(Ok(f))) => n += f.data_ref().map_or(0, |d| d.len()),
            _ => break,
        }
    }
}

/// When each address was last named in the log for being refused (once a minute at most).
#[derive(Default)]
struct Warned(std::sync::Mutex<HashMap<std::net::IpAddr, tokio::time::Instant>>);

impl Warned {
    /// Whether `ip` may be named in the log now (then not again for a minute).
    fn once(&self, ip: std::net::IpAddr) -> bool {
        let now = tokio::time::Instant::now();
        let mut m = self.0.lock().unwrap();
        m.retain(|_, at| now.duration_since(*at) < Duration::from_secs(60));
        if m.contains_key(&ip) {
            return false;
        }
        m.insert(ip, now);
        true
    }
}

/// Why a request is answered 503: the line for the log and the answer's sentence.
#[derive(Clone)]
struct Refusal {
    line: String,
    answer: &'static str,
}

/// A refused request: its body read and dropped, the log line (once a minute per address),
/// then 503 too_many_connections. A request with `Expect: 100-continue` is answered without
/// reading its body: hyper then sends no 100 Continue and closes the connection after the
/// 503, so the client never sends the body (reading it would ask for all of it first).
async fn refuse(state: &AppState, warned: &Warned, ip: std::net::IpAddr, why: &Refusal, req: Request<Body>) -> Res {
    if !super::body::expects_continue(req.headers()) {
        drop_body(req.into_body()).await;
    }
    if warned.once(ip) {
        state.log.warn(why.line.clone());
    }
    too_many_connections(why.answer)
}

/// The TLS settings with HTTP/1.1 only (an answer's Connection: close then ends the connection).
fn http1_tls(state: &AppState) -> Option<Arc<rustls::ServerConfig>> {
    state.tls_config.read().unwrap().clone().map(|c| {
        let mut c = (*c).clone();
        c.alpn_protocols = vec![b"http/1.1".to_vec()];
        Arc::new(c)
    })
}

/// A connection taken past a connection limit: the TLS handshake (when it starts one) as for
/// any other, then each request on it answered 503 too_many_connections and the connection
/// closed. It holds a `REFUSING` permit, not one of the port's own.
fn serve_refused(state: Arc<AppState>, sock: tokio::net::TcpStream, peer: std::net::SocketAddr, why: Refusal, warned: Arc<Warned>, permit: tokio::sync::OwnedSemaphorePermit) {
    tokio::spawn(async move {
        let _permit = permit;
        let mut first = [0u8; 1];
        if !matches!(tokio::time::timeout(Duration::from_secs(15), sock.peek(&mut first)).await, Ok(Ok(1))) {
            return;
        }
        let svc = {
            let st = state.clone();
            hyper::service::service_fn(move |req: Request<hyper::body::Incoming>| {
                let (st, warned, why) = (st.clone(), warned.clone(), why.clone());
                async move { Ok::<_, std::convert::Infallible>(refuse(&st, &warned, peer.ip(), &why, req.map(Body::new)).await) }
            })
        };
        let mut b = hyper::server::conn::http1::Builder::new();
        b.timer(hyper_util::rt::TokioTimer::new()).header_read_timeout(Duration::from_secs(20));
        if first[0] == 0x16 {
            let Some(cfg) = http1_tls(&state) else { return };
            if let Ok(Ok(tls)) = tokio::time::timeout(Duration::from_secs(15), tokio_rustls::TlsAcceptor::from(cfg).accept(sock)).await {
                let _ = b.serve_connection(hyper_util::rt::TokioIo::new(tls), svc).await;
            }
        } else {
            let _ = b.serve_connection(hyper_util::rt::TokioIo::new(sock), svc).await;
        }
    });
}

/// A connection past a limit: answered 503 while fewer than `REFUSING` such are open, else
/// closed without an answer (both named in the log once a minute per address).
fn refused_connection(state: &Arc<AppState>, refusing: &Arc<tokio::sync::Semaphore>, warned: &Arc<Warned>, sock: tokio::net::TcpStream, peer: std::net::SocketAddr, why: Refusal, port: &str) {
    match refusing.clone().try_acquire_owned() {
        Ok(p) => serve_refused(state.clone(), sock, peer, why, warned.clone(), p),
        Err(_) => {
            if warned.once(peer.ip()) {
                state.log.warn(format!("{port}: {REFUSING} refused connections already waiting for their 503; closing {}'s without an answer", peer.ip()));
            }
            drop(sock);
        }
    }
}

/// One of an address's connections on the device port: given back when dropped, however
/// the connection ended (index.js: on the socket's 'close').
struct AddressSlot {
    open: Arc<std::sync::Mutex<HashMap<std::net::IpAddr, usize>>>,
    ip: std::net::IpAddr,
    /// which of the address's open connections this one was when it was taken (1 = the first)
    nth: usize,
}

impl AddressSlot {
    /// None when the address already holds `PER_ADDRESS_WITH_TOKEN`.
    fn take(open: &Arc<std::sync::Mutex<HashMap<std::net::IpAddr, usize>>>, ip: std::net::IpAddr) -> Option<AddressSlot> {
        let mut m = open.lock().unwrap();
        let n = m.entry(ip).or_insert(0);
        if *n >= PER_ADDRESS_WITH_TOKEN {
            return None;
        }
        *n += 1;
        Some(AddressSlot { open: open.clone(), ip, nth: *n })
    }
}

impl Drop for AddressSlot {
    fn drop(&mut self) {
        let mut m = self.open.lock().unwrap();
        if let Some(n) = m.get_mut(&self.ip) {
            *n -= 1;
            if *n == 0 {
                m.remove(&self.ip);
            }
        }
    }
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
    device_serve(state, listener).await
}

/// Whether a request's headers carry a valid CAN Bridge token (the CAN area's check).
async fn has_can_token(state: &AppState, h: HeaderMap) -> bool {
    let Some(f) = state.hooks.can_token_valid.get() else { return false };
    tokio::task::spawn_blocking(move || f(&h)).await.unwrap_or(false)
}

async fn device_serve(state: Arc<AppState>, listener: tokio::net::TcpListener) {
    let slots = Arc::new(tokio::sync::Semaphore::new(DEVICE_CONNECTIONS));
    let refusing = Arc::new(tokio::sync::Semaphore::new(REFUSING));
    let per_address: Arc<std::sync::Mutex<HashMap<std::net::IpAddr, usize>>> = Default::default();
    let warned: Arc<Warned> = Default::default();
    loop {
        let Ok((sock, peer)) = listener.accept().await else { continue };
        let ip = peer.ip();
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            let why = Refusal { line: format!("Device port: {DEVICE_CONNECTIONS} connections open in all; answering 503 to {ip}"), answer: TOO_MANY_IN_ALL };
            refused_connection(&state, &refusing, &warned, sock, peer, why, "Device port");
            continue;
        };
        let Some(slot) = AddressSlot::take(&per_address, ip) else {
            drop(permit);
            let why = Refusal { line: format!("Device port: {ip} already has {PER_ADDRESS_WITH_TOKEN} connections open; answering 503 to more"), answer: TOO_MANY_FROM_ADDRESS };
            refused_connection(&state, &refusing, &warned, sock, peer, why, "Device port");
            continue;
        };
        // past the address's first 6, each request is served only with a valid token
        let token_only = slot.nth > PER_ADDRESS;
        let st = state.clone();
        let warned = warned.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let _slot = slot;
            let why = Refusal { line: format!("Device port: {ip} already has {PER_ADDRESS} connections open; answering 503 to a request without a valid CAN Bridge token"), answer: TOO_MANY_FROM_ADDRESS };
            let svc = {
                let st = st.clone();
                move |encrypted: bool| {
                    let (st, warned, why) = (st.clone(), warned.clone(), why.clone());
                    hyper::service::service_fn(move |req: Request<hyper::body::Incoming>| {
                        let (st, warned, why) = (st.clone(), warned.clone(), why.clone());
                        async move {
                            let req = req.map(Body::new);
                            if token_only && !has_can_token(&st, req.headers().clone()).await {
                                return Ok::<_, std::convert::Infallible>(refuse(&st, &warned, ip, &why, req).await);
                            }
                            Ok(device_request(st, req, ConnInfo { peer: Some(peer), encrypted, device: true }).await)
                        }
                    })
                }
            };
            // (header_read_timeout also bounds a connection idle between requests: hyper starts
            // it when it waits for the next request's first line)
            let mut b = hyper::server::conn::http1::Builder::new();
            b.timer(hyper_util::rt::TokioTimer::new()).header_read_timeout(Duration::from_secs(20));
            // a connection that has not sent a request within 15 s is closed
            let mut first = [0u8; 1];
            if !matches!(tokio::time::timeout(Duration::from_secs(15), sock.peek(&mut first)).await, Ok(Ok(1))) {
            } else if st.tls.is_some() {
                if let Some(cfg) = http1_tls(&st) {
                    if let Ok(Ok(tls)) = tokio::time::timeout(Duration::from_secs(15), tokio_rustls::TlsAcceptor::from(cfg).accept(sock)).await {
                        let _ = b.serve_connection(hyper_util::rt::TokioIo::new(tls), svc(true)).await;
                    }
                }
            } else {
                let _ = b.serve_connection(hyper_util::rt::TokioIo::new(sock), svc(false)).await;
            }
        });
    }
}

/// Open or close the device port to match the setting (call after changing `can.enabled`).
pub fn sync_device_port(state: &Arc<AppState>) {
    let wanted = match device_port_wanted(state) {
        Ok(w) => w,
        Err(e) => {
            // (whether CAN uploads are on is not known: the port stays as it is)
            state.log.warn(format!("Device port left as it is: {e}"));
            return;
        }
    };
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

    // ---- the device port: a CAN Bridge that went away mid-upload (Wi-Fi or power lost)

    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    use tokio::time::Instant;

    /// A device port of its own (HTTPS off) on a free port, whose /api/can/logs reads the body
    /// as the CAN upload does and answers how much arrived, and whose /api/can/logs/long
    /// answers a byte a minute for 15 minutes. Its address, the warnings logged, the folder.
    async fn device_port(name: &str) -> (std::net::SocketAddr, Arc<Mutex<Vec<String>>>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("lean-device-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let env = [("DATA_PATH", dir.to_string_lossy().into_owned()), ("TLS_MODE", "off".into())];
        let config = crate::core::Config::from_map(env.into_iter().map(|(k, v)| (k.to_string(), v)).collect());
        let logger = super::super::log::Logger::with("info", 100, true, None, 1);
        // (only the device port's warnings: a new server also says how to make its account)
        let warnings: Arc<Mutex<Vec<String>>> = Default::default();
        let w = warnings.clone();
        logger.on_line(move |e| {
            if e.level == "warn" && e.message.starts_with("Device port") {
                w.lock().unwrap().push(e.message.clone());
            }
        });
        let st = AppState::open_with(config, logger).unwrap();
        let mut r = Router::new();
        r.raw("/api/can/logs", |q: RawReq| {
            Box::pin(async move {
                match super::super::body::collect(q.req.into_body(), 1024).await {
                    Ok(b) => text(200, &format!("got {}", b.len()), &[]),
                    Err(super::super::body::BodyError::TimedOut) => super::super::body::timed_out(""),
                    Err(e) => text(500, &format!("{e:?}"), &[]),
                }
            })
        });
        r.raw("/api/can/logs/long", |_q: RawReq| {
            Box::pin(async move {
                let s = futures_util::stream::unfold(0, |i| async move {
                    if i == 15 {
                        return None;
                    }
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    Some((Ok::<_, std::io::Error>(bytes::Bytes::from_static(b"x")), i + 1))
                });
                Response::builder().status(200).body(Body::from_stream(s)).unwrap()
            })
        });
        install(&st, r);
        // the one valid CAN Bridge token here: "good"
        st.hooks.can_token_valid.set(Arc::new(|h: &HeaderMap| h.get(header::AUTHORIZATION).is_some_and(|v| v == "Bearer good")));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(device_serve(st, listener));
        (addr, warnings, dir)
    }

    /// An upload whose body (of `length` bytes) starts with `sent` and then stops.
    async fn upload(addr: std::net::SocketAddr, length: usize, sent: &[u8]) -> TcpStream {
        upload_from([127, 0, 0, 1], addr, length, sent, None).await
    }

    /// The same from the address `from` (127.0.0.x), with `Authorization: Bearer <token>`.
    async fn upload_from(from: [u8; 4], addr: std::net::SocketAddr, length: usize, sent: &[u8], token: Option<&str>) -> TcpStream {
        let sock = tokio::net::TcpSocket::new_v4().unwrap();
        sock.bind((std::net::Ipv4Addr::from(from), 0).into()).unwrap();
        let mut s = sock.connect(addr).await.unwrap();
        let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
        s.write_all(format!("POST /api/can/logs HTTP/1.1\r\nHost: x\r\n{auth}Content-Length: {length}\r\n\r\n").as_bytes()).await.unwrap();
        s.write_all(sent).await.unwrap();
        s
    }

    /// Whether an answer is the 503 too_many_connections with Retry-After: 5, closing.
    fn too_many(a: &str) -> bool {
        let l = a.to_ascii_lowercase();
        a.starts_with("HTTP/1.1 503") && l.contains("\r\nretry-after: 5\r\n") && l.contains("\r\nconnection: close\r\n") && l.contains("content-type: application/json") && a.contains(r#""code":"too_many_connections""#) && a.contains(r#""error":"Too many connections"#)
    }

    /// Everything the server sends until it closes the connection (or nothing in an hour).
    async fn answer(s: &mut TcpStream) -> String {
        let mut got = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(3600), s.read_to_end(&mut got)).await;
        String::from_utf8_lossy(&got).into_owned()
    }

    #[tokio::test(start_paused = true)]
    async fn a_bridge_whose_uploads_stalled_is_answered_again() {
        let (addr, _, dir) = device_port("stalled").await;
        let mut stalled = Vec::new();
        for _ in 0..6 {
            stalled.push(upload(addr, 100, b"part").await);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        // the seventh (no token) is answered 503 while the six are open
        let mut seventh = upload(addr, 2, b"ok").await;
        let a = answer(&mut seventh).await;
        assert!(too_many(&a), "refused: {a:?}");
        // the six end (408) once they have sent nothing for 2 minutes: their connections close
        for s in &mut stalled {
            let a = answer(s).await;
            assert!(a.starts_with("HTTP/1.1 408"), "{a}");
        }
        let mut next = upload(addr, 2, b"ok").await;
        let a = answer(&mut next).await;
        assert!(a.starts_with("HTTP/1.1 200") && a.ends_with("got 2"), "a new upload is answered: {a:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(start_paused = true)]
    async fn a_body_that_sends_nothing_for_2_minutes_gets_408_and_the_connection_closes() {
        let (addr, _, dir) = device_port("silent").await;
        let mut s = upload(addr, 100, b"part").await;
        let began = Instant::now();
        let a = answer(&mut s).await;
        let took = began.elapsed();
        assert!(a.starts_with("HTTP/1.1 408"), "{a:?}");
        assert!(a.to_ascii_lowercase().contains("connection: close"), "{a}");
        assert!((Duration::from_secs(120)..Duration::from_secs(121)).contains(&took), "{took:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_but_steady_body_is_received_and_one_past_10_minutes_is_not() {
        let (addr, _, dir) = device_port("steady").await;
        // a byte a minute, 9 bytes: answered once it is all there
        let mut s = upload(addr, 9, b"").await;
        let began = Instant::now();
        for _ in 0..9 {
            tokio::time::sleep(Duration::from_secs(60)).await;
            s.write_all(b"x").await.unwrap();
        }
        let mut head = [0u8; 12];
        s.read_exact(&mut head).await.unwrap();
        assert_eq!(&head, b"HTTP/1.1 200", "after {:?}", began.elapsed());
        // a byte a minute, 20 bytes: 408 at 10 minutes
        let mut s = upload(addr, 20, b"").await;
        let began = Instant::now();
        let writer = tokio::spawn(async move {
            for _ in 0..20 {
                tokio::time::sleep(Duration::from_secs(60)).await;
                if s.write_all(b"x").await.is_err() {
                    break;
                }
            }
            s
        });
        let mut s = writer.await.unwrap();
        let a = answer(&mut s).await;
        assert!(a.starts_with("HTTP/1.1 408"), "{a:?}");
        assert!(began.elapsed() >= Duration::from_secs(600), "{:?}", began.elapsed());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(start_paused = true)]
    async fn a_long_answer_is_not_cut_off() {
        let (addr, _, dir) = device_port("long").await;
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(b"GET /api/can/logs/long HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await.unwrap();
        let began = Instant::now();
        let a = answer(&mut s).await;
        assert!(a.starts_with("HTTP/1.1 200"), "{a:?}");
        // (chunked: 15 chunks of "x", then the last chunk)
        assert_eq!(a.matches("1\r\nx\r\n").count(), 15, "{a:?}");
        assert!(a.ends_with("\r\n0\r\n\r\n"), "{a:?}");
        assert!(began.elapsed() >= Duration::from_secs(900), "{:?}", began.elapsed());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(start_paused = true)]
    async fn an_idle_connection_is_closed() {
        let (addr, _, dir) = device_port("idle").await;
        // after an answer, kept alive: closed when no next request starts within 20 s
        let mut s = TcpStream::connect(addr).await.unwrap();
        s.write_all(b"GET /nothing HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();
        let began = Instant::now();
        let a = answer(&mut s).await;
        assert!(a.starts_with("HTTP/1.1 404"), "{a:?}");
        assert!(began.elapsed() <= Duration::from_secs(21), "{:?}", began.elapsed());
        // nothing sent at all: closed after 15 s
        let mut s = TcpStream::connect(addr).await.unwrap();
        let began = Instant::now();
        assert_eq!(answer(&mut s).await, "");
        assert!(began.elapsed() <= Duration::from_secs(16), "{:?}", began.elapsed());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(start_paused = true)]
    async fn a_7th_connection_without_a_token_gets_503_with_retry_after() {
        let (addr, _, dir) = device_port("seventh").await;
        let mut held = Vec::new();
        for _ in 0..6 {
            held.push(upload(addr, 100, b"part").await);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        let began = Instant::now();
        let mut s = upload(addr, 2, b"ok").await;
        let a = answer(&mut s).await;
        assert!(too_many(&a), "{a:?}");
        assert!(began.elapsed() < Duration::from_secs(1), "answered at once: {:?}", began.elapsed());
        // a wrong token is no better
        let mut s = upload_from([127, 0, 0, 1], addr, 2, b"ok", Some("bad")).await;
        let a = answer(&mut s).await;
        assert!(too_many(&a), "{a:?}");
        // a request on it that has not sent its whole body yet is answered once it stops
        let mut s = upload(addr, 100, b"part").await;
        let a = answer(&mut s).await;
        assert!(too_many(&a), "{a:?}");
        drop(held);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(start_paused = true)]
    async fn with_a_valid_token_an_address_may_hold_32_connections() {
        let (addr, warnings, dir) = device_port("token32").await;
        let me = [127, 0, 0, 1];
        let mut held = Vec::new();
        for _ in 0..6 {
            held.push(upload(addr, 100, b"part").await);
        }
        // connections 7 to 32, each with the token: served (408 after 2 minutes, not a 503)
        for _ in 6..32 {
            held.push(upload_from(me, addr, 100, b"part", Some("good")).await);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        // the 33rd is answered 503, token or not
        let mut s = upload_from(me, addr, 2, b"ok", Some("good")).await;
        let a = answer(&mut s).await;
        assert!(too_many(&a), "{a:?}");
        assert_eq!(*warnings.lock().unwrap(), vec!["Device port: 127.0.0.1 already has 32 connections open; answering 503 to more".to_string()]);
        let began = Instant::now();
        for s in &mut held {
            let a = answer(s).await;
            assert!(a.starts_with("HTTP/1.1 408"), "{a}");
        }
        assert!(began.elapsed() >= Duration::from_secs(110), "{:?}", began.elapsed());
        // every slot was given back: 6 without a token and 26 with one are served again
        let mut again = Vec::new();
        for i in 0..32 {
            again.push(upload_from(me, addr, 2, b"ok", (i >= 6).then_some("good")).await);
        }
        for s in &mut again {
            let a = answer(s).await;
            assert!(a.starts_with("HTTP/1.1 200") && a.ends_with("got 2"), "{a:?}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(start_paused = true)]
    async fn past_256_connections_in_all_the_next_gets_503() {
        let (addr, warnings, dir) = device_port("all").await;
        let mut held = Vec::new();
        for host in 2..10u8 {
            for _ in 0..32 {
                held.push(upload_from([127, 0, 0, host], addr, 100, b"part", Some("good")).await);
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        let mut s = upload_from([127, 0, 0, 20], addr, 2, b"ok", Some("good")).await;
        let a = answer(&mut s).await;
        assert!(too_many(&a), "{a:?}");
        assert_eq!(*warnings.lock().unwrap(), vec!["Device port: 256 connections open in all; answering 503 to 127.0.0.20".to_string()]);
        drop(held);
        tokio::time::sleep(Duration::from_secs(1)).await;
        let mut s = upload_from([127, 0, 0, 20], addr, 2, b"ok", None).await;
        let a = answer(&mut s).await;
        assert!(a.starts_with("HTTP/1.1 200"), "slots given back: {a:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(start_paused = true)]
    async fn a_refused_address_is_logged_once_a_minute() {
        let (addr, warnings, dir) = device_port("refused").await;
        let mut held = Vec::new();
        for _ in 0..6 {
            held.push(upload(addr, 100, b"part").await);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        let refused = |n: usize| async move {
            for _ in 0..n {
                let mut s = upload(addr, 2, b"ok").await;
                let a = answer(&mut s).await;
                assert!(too_many(&a), "{a:?}");
            }
        };
        refused(3).await;
        let want = "Device port: 127.0.0.1 already has 6 connections open; answering 503 to a request without a valid CAN Bridge token";
        assert_eq!(*warnings.lock().unwrap(), vec![want.to_string()]);
        tokio::time::sleep(Duration::from_secs(61)).await;
        refused(2).await;
        assert_eq!(*warnings.lock().unwrap(), vec![want.to_string(), want.to_string()]);
        // another address is named on its own
        let mut s = upload_from([127, 0, 0, 3], addr, 2, b"ok", None).await;
        assert!(answer(&mut s).await.starts_with("HTTP/1.1 200"));
        drop(held);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// An upload from `from` that sends `Expect: 100-continue` and holds its body back.
    async fn expecting(from: [u8; 4], addr: std::net::SocketAddr, length: usize, token: Option<&str>) -> TcpStream {
        let sock = tokio::net::TcpSocket::new_v4().unwrap();
        sock.bind((std::net::Ipv4Addr::from(from), 0).into()).unwrap();
        let mut s = sock.connect(addr).await.unwrap();
        let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
        s.write_all(format!("POST /api/can/logs HTTP/1.1\r\nHost: x\r\n{auth}Content-Length: {length}\r\nExpect: 100-continue\r\n\r\n").as_bytes()).await.unwrap();
        s
    }

    #[tokio::test(start_paused = true)]
    async fn a_refused_upload_that_expects_100_continue_gets_its_503_before_its_body() {
        let (addr, _, dir) = device_port("expect").await;
        let me = [127, 0, 0, 1];
        let mut held = Vec::new();
        for _ in 0..6 {
            held.push(upload(addr, 100, b"part").await);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        // the 7th without a token: 503 at once, no 100 Continue, the body never asked for
        let began = Instant::now();
        let mut s = expecting(me, addr, 8 * 1024 * 1024, None).await;
        let a = answer(&mut s).await;
        assert!(too_many(&a) && !a.contains("100 Continue"), "{a:?}");
        assert!(began.elapsed() < Duration::from_secs(1), "answered at once: {:?}", began.elapsed());
        // the 33rd, token or not (a connection kept only to answer 503)
        for _ in 6..32 {
            held.push(upload_from(me, addr, 100, b"part", Some("good")).await);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        let began = Instant::now();
        let mut s = expecting(me, addr, 8 * 1024 * 1024, Some("good")).await;
        let a = answer(&mut s).await;
        assert!(too_many(&a) && !a.contains("100 Continue"), "{a:?}");
        assert!(began.elapsed() < Duration::from_secs(1), "answered at once: {:?}", began.elapsed());
        // a served one still gets 100 Continue, then sends its body
        let mut s = expecting([127, 0, 0, 3], addr, 2, None).await;
        let mut head = [0u8; 25];
        s.read_exact(&mut head).await.unwrap();
        assert_eq!(&head, b"HTTP/1.1 100 Continue\r\n\r\n");
        s.write_all(b"ok").await.unwrap();
        let mut ok = [0u8; 12];
        s.read_exact(&mut ok).await.unwrap();
        assert_eq!(&ok, b"HTTP/1.1 200");
        drop(held);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn versioned_paths() {
        assert_eq!(unversion("/v/abc123/web/app.js".into()), ("/web/app.js".into(), Some("abc123".into())));
        assert_eq!(unversion("/v/abc/api/jobs".into()), ("/v/abc/api/jobs".into(), None));
        assert_eq!(unversion("/v/assets/x.png".into()), ("/assets/x.png".into(), None));
    }
}
