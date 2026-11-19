//! Router and answers (server/http.js and the request handler of index.js):
//! routes as `METHOD /api/x/:id` matched on the raw path exactly as Node's
//! Router (its pattern is a regular expression, `:name` is one segment),
//! access levels, the JSON error shape `{ "error": ... }` (plus `code` where
//! Node exposes one), gzip for JSON over 1 KB, and the security headers.

use super::state::AppState;
use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, Response, StatusCode};
use futures_util::future::BoxFuture;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

pub type Res = Response<Body>;

/// A JSON number as JSON.stringify writes it (integers without ".0"; NaN and infinities as null).
pub fn num(x: f64) -> Value {
    if !x.is_finite() {
        Value::Null
    } else if x.fract() == 0.0 && x.abs() < 9.007_199_254_740_992e15 {
        json!(x as i64)
    } else {
        json!(x)
    }
}

/// String(x) for a number.
pub fn num_text(x: f64) -> String {
    if x.is_nan() {
        "NaN".into()
    } else if x.is_infinite() {
        if x > 0.0 { "Infinity".into() } else { "-Infinity".into() }
    } else if x.fract() == 0.0 && x.abs() < 1e21 {
        format!("{}", x as i128)
    } else {
        format!("{x}")
    }
}

pub fn js_number_text(n: &serde_json::Number) -> String {
    match n.as_i64() {
        Some(i) => i.to_string(),
        None => num_text(n.as_f64().unwrap_or(f64::NAN)),
    }
}

/// JavaScript's Number(string).
pub fn js_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (p, r) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(d) = t.strip_prefix(p) {
            return u64::from_str_radix(d, r).map(|n| n as f64).unwrap_or(f64::NAN);
        }
    }
    if !t.bytes().all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-')) || t.contains("inf") {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number(x) || d`: NaN and 0 give the default.
pub fn number_or(s: Option<&String>, d: f64) -> f64 {
    let n = s.map_or(f64::NAN, |s| js_number(s));
    if n.is_nan() || n == 0.0 {
        d
    } else {
        n
    }
}

/// An error answer, as Node's HttpError (and errors with a `status`).
#[derive(Debug, Clone)]
pub struct HttpError {
    pub status: u16,
    pub message: String,
    /// sent as `code` (Node: `expose && code`)
    pub code: Option<String>,
    /// false: an unexpected failure, answered as 500 "Internal error" and logged
    pub explicit: bool,
    /// Set-Cookie values the answer carries anyway (Node sets them before it throws)
    pub set_cookie: Vec<String>,
}

impl HttpError {
    pub fn new(status: u16, message: impl Into<String>) -> HttpError {
        HttpError { status, message: message.into(), code: None, explicit: true, set_cookie: Vec::new() }
    }
    pub fn with_cookie(mut self, c: &str) -> HttpError {
        self.set_cookie.push(c.to_string());
        self
    }
    pub fn code(mut self, code: &str) -> HttpError {
        self.code = Some(code.into());
        self
    }
    pub fn internal(message: impl Into<String>) -> HttpError {
        HttpError { status: 500, message: message.into(), code: None, explicit: false, set_cookie: Vec::new() }
    }
    pub fn not_found() -> HttpError {
        HttpError::new(404, "Not found")
    }
}

impl From<super::auth::Refusal> for HttpError {
    fn from(r: super::auth::Refusal) -> HttpError {
        // (a 500 refusal is the database failing: logged, answered "Internal error")
        if r.status >= 500 {
            return HttpError::internal(r.message);
        }
        HttpError::new(r.status, r.message)
    }
}

/// manager.db failing: 500 "Internal error", logged with what failed.
impl From<super::db::DbError> for HttpError {
    fn from(e: super::db::DbError) -> HttpError {
        HttpError::internal(e.to_string())
    }
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}", self.status, self.message)
    }
}

/// What a handler answers: JSON (sent as sendJson does, with any extra headers such as Set-Cookie), or a whole response.
pub enum Reply {
    Json(Value, Vec<(HeaderName, HeaderValue)>),
    Raw(Res),
}

impl Reply {
    pub fn json(v: Value) -> Reply {
        Reply::Json(v, Vec::new())
    }
    pub fn cookie(self, set_cookie: &str) -> Reply {
        self.header(header::SET_COOKIE, set_cookie)
    }
    pub fn header(self, name: HeaderName, value: &str) -> Reply {
        match self {
            Reply::Json(v, mut h) => {
                if let Ok(val) = HeaderValue::from_str(value) {
                    h.push((name, val));
                }
                Reply::Json(v, h)
            }
            Reply::Raw(mut r) => {
                if let Ok(val) = HeaderValue::from_str(value) {
                    r.headers_mut().append(name, val);
                }
                Reply::Raw(r)
            }
        }
    }
    /// A text download (logs): 200, text/plain, no-store, nosniff, attachment.
    pub fn text_download(text: String, file_name: &str) -> Result<Reply, HttpError> {
        // (a name that is not a valid header: Node's writeHead throws, so 500)
        let disposition = HeaderValue::from_str(&format!("attachment; filename=\"{file_name}\"")).map_err(|e| HttpError::internal(e.to_string()))?;
        Ok(Reply::Raw(
            Response::builder()
                .status(200)
                .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
                .header(header::CACHE_CONTROL, "no-store")
                .header("X-Content-Type-Options", "nosniff")
                .header(header::CONTENT_DISPOSITION, disposition)
                .body(Body::from(text))
                .unwrap(),
        ))
    }
}

/// Whether this answer goes gzipped (http.js encodingFor: br or gzip accepted).
pub fn accepts_compression(accept: &str) -> bool {
    let word = |w: &str| {
        accept.match_indices(w).any(|(i, _)| {
            let before = accept[..i].chars().next_back().is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
            let after = accept[i + w.len()..].chars().next().is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
            before && after
        })
    };
    word("br") || word("gzip")
}

/// sendJson: JSON over 1 KB goes gzipped when the browser accepts it.
pub fn send_json(status: u16, body: &Value, accept_encoding: &str) -> Res {
    let data = body.to_string();
    let b = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store");
    if data.encode_utf16().count() > 1024 && accepts_compression(accept_encoding) {
        use std::io::Write;
        let mut z = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::new(4));
        let _ = z.write_all(data.as_bytes());
        let zipped = z.finish().unwrap_or_default();
        return b.header(header::CONTENT_ENCODING, "gzip").header(header::VARY, "Accept-Encoding").body(Body::from(zipped)).unwrap();
    }
    b.body(Body::from(data)).unwrap()
}

pub fn error_json(status: u16, msg: &str, code: Option<&str>, accept: &str) -> Res {
    let mut v = json!({ "error": msg });
    if let Some(c) = code {
        v["code"] = json!(c);
    }
    send_json(status, &v, accept)
}

const MAP_HOSTS: &str = "https://tiles.openfreemap.org https://*.google.com";
fn csp_with(script: &str, img: &str, connect: &str) -> String {
    [
        "default-src 'self'".to_string(),
        format!("script-src {script}"),
        "style-src 'self' 'unsafe-inline'".into(),
        format!("img-src {img}"),
        "media-src 'self' blob:".into(),
        "font-src 'self' data:".into(),
        format!("connect-src {connect}"),
        "worker-src 'self' blob:".into(),
        "frame-src 'self'".into(),
        "frame-ancestors 'self'".into(),
        "object-src 'none'".into(),
        "base-uri 'self'".into(),
        "form-action 'self'".into(),
    ]
    .join("; ")
}
pub const ENCODER_PAGE: &str = "/studio/encoder.html";

/// index.js securityHeaders (no HSTS: see there).
pub fn security_headers(h: &mut HeaderMap, pathname: &str) {
    let set = |h: &mut HeaderMap, k: &'static str, v: String| {
        if let Ok(v) = HeaderValue::from_str(&v) {
            h.insert(HeaderName::from_static(k), v);
        }
    };
    set(h, "x-content-type-options", "nosniff".into());
    set(h, "referrer-policy", "no-referrer".into());
    set(h, "x-frame-options", "SAMEORIGIN".into());
    set(h, "cross-origin-opener-policy", "same-origin".into());
    set(h, "cross-origin-resource-policy", "same-origin".into());
    set(h, "permissions-policy", "camera=(), microphone=(), geolocation=(), usb=(), serial=(), payment=(), fullscreen=(self)".into());
    let page = pathname.split('?').next().unwrap_or("");
    let img_maps = format!("'self' data: blob: {MAP_HOSTS}");
    let connect_maps = format!("'self' {MAP_HOSTS}");
    let csp = if page.starts_with("/studio/") && page != ENCODER_PAGE {
        csp_with("'self' 'unsafe-eval'", &img_maps, &connect_maps)
    } else if page == "/" || page == "/index.html" {
        csp_with("'self'", &img_maps, &connect_maps)
    } else {
        csp_with("'self'", "'self' data: blob:", "'self'")
    };
    set(h, "content-security-policy", csp);
}

/// Who may call a route.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// no session needed (`{ public: true }` in index.js)
    Public,
    /// a signed-in session; watch-only accounts are further limited by viewer_may (the "admin" routes of the contract)
    SignedIn,
}

/// The connection a request came on.
#[derive(Debug, Clone)]
pub struct ConnInfo {
    pub peer: Option<std::net::SocketAddr>,
    /// TLS on this connection
    pub encrypted: bool,
    /// it came in on the device port (CAN_PORT), not the web port
    pub device: bool,
}

impl ConnInfo {
    pub fn peer_ip(&self) -> Option<String> {
        self.peer.map(|p| p.ip().to_string())
    }
}

/// One API request, for a handler.
pub struct Ctx {
    pub state: Arc<AppState>,
    pub method: Method,
    /// the path as it came (routes match on it)
    pub raw_path: String,
    /// decoded and checked (no `..`, `//`, NUL or backslash)
    pub path: String,
    pub params: HashMap<String, String>,
    /// Object.fromEntries(url.searchParams): the last of a repeated key wins
    pub query: HashMap<String, String>,
    pub raw_query: Option<String>,
    pub headers: HeaderMap,
    /// the JSON body (None: none sent, as `undefined` in Node)
    pub body: Option<Value>,
    pub user: Option<String>,
    pub conn: ConnInfo,
    /// the client address (clientAddress.js), worked out once
    pub client: String,
    pub secure: bool,
}

impl Ctx {
    pub fn header(&self, name: &str) -> &str {
        self.headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("")
    }
    pub fn view(&self) -> super::auth::ReqView<'_> {
        super::auth::ReqView { secure: self.secure, cookie: self.header("cookie"), agent: self.header("user-agent") }
    }
    /// The signed-in user (routes that are not public always have one).
    pub fn user(&self) -> &str {
        self.user.as_deref().unwrap_or("")
    }
    /// `${user || 'someone'} from ${clientKey(req)}` for the audit log.
    pub fn by(&self, user: Option<&str>) -> String {
        format!("{} from {}", user.filter(|u| !u.is_empty()).unwrap_or("someone"), self.client)
    }
    /// A field of the JSON body.
    pub fn field(&self, k: &str) -> Option<&Value> {
        self.body.as_ref().and_then(|b| b.get(k))
    }
    /// String(body?.k || '')
    pub fn field_str(&self, k: &str) -> String {
        match self.field(k) {
            Some(v) if super::accounts::truthy(v) => super::accounts::js_string(Some(v)),
            _ => String::new(),
        }
    }
    /// The password window (auth.recentlyConfirmed) or 403 CONFIRM_PASSWORD.
    pub fn require_confirmed(&self) -> Result<(), HttpError> {
        if self.state.auth.recently_confirmed(&self.view()) {
            Ok(())
        } else {
            Err(HttpError::new(403, "Enter your password to confirm this change.").code("CONFIRM_PASSWORD"))
        }
    }
    pub fn accept_encoding(&self) -> &str {
        self.header("accept-encoding")
    }
}

pub type BlockingFn = dyn Fn(&mut Ctx) -> Result<Reply, HttpError> + Send + Sync;
pub type AsyncFn = dyn Fn(Ctx) -> BoxFuture<'static, Result<Reply, HttpError>> + Send + Sync;

#[derive(Clone)]
pub enum Handler {
    /// runs on a blocking thread (database, files, scrypt)
    Blocking(Arc<BlockingFn>),
    /// runs on the async threads (streams, waiting)
    Async(Arc<AsyncFn>),
}

#[derive(Clone)]
pub struct Route {
    pub method: Method,
    pub pattern: String,
    re: Regex,
    keys: Vec<String>,
    pub access: Access,
    pub handler: Handler,
    /// the JSON body limit (index.js: 256 KB under /api/converter/, else 1 MB)
    pub body_limit: usize,
}

/// A request that core does not check (tokens of their own: /metrics, CAN uploads, nodes): the whole request.
pub struct RawReq {
    pub state: Arc<AppState>,
    pub req: axum::http::Request<Body>,
    pub conn: ConnInfo,
    pub client: String,
    pub secure: bool,
}

pub type RawFn = dyn Fn(RawReq) -> BoxFuture<'static, Res> + Send + Sync;

/// A page or file request after the sign-in checks (the ui area answers these).
pub struct WebReq {
    pub state: Arc<AppState>,
    pub method: Method,
    pub headers: HeaderMap,
    /// decoded path, with /v/<version>/ taken off
    pub path: String,
    pub raw_query: Option<String>,
    pub query: HashMap<String, String>,
    /// the version of a /v/<version>/ path
    pub version: Option<String>,
    pub user: Option<String>,
    pub session_hash: Option<String>,
    pub secure: bool,
    pub client: String,
}

pub type WebFn = dyn Fn(WebReq) -> BoxFuture<'static, Res> + Send + Sync;

/// An API path index.js answers by hand after the sign-in and CSRF checks, for any method
/// (/api/media, /api/scrub, /api/converter/events, /api/ui-packs/upload): the checked
/// request (`body` is None in `ctx`) and the body as it came.
pub struct ApiRaw {
    pub ctx: Ctx,
    pub body: Body,
}

pub type ApiRawFn = dyn Fn(ApiRaw) -> BoxFuture<'static, Res> + Send + Sync;

/// The routes of every area, and the special paths.
#[derive(Clone, Default)]
pub struct Router {
    pub routes: Vec<Route>,
    /// exact paths and prefixes (ending in `/`) answered before any check; see RESERVED
    pub raw: Vec<(String, Arc<RawFn>)>,
    pub web: Option<Arc<WebFn>>,
    /// decoded API paths answered by hand (see ApiRaw), before the router's routes
    pub api_raw: Vec<(String, Arc<ApiRawFn>)>,
}

/// The paths core answers 404 for when no area has claimed them (index.js answers them before the host and session checks).
pub const RESERVED_RAW: [&str; 4] = ["/metrics", "/api/can/logs", "/api/can/logs/", "/node/v1/"];

fn compile(pattern: &str) -> (Regex, Vec<String>) {
    let mut keys = Vec::new();
    let mut out = String::from("^");
    let b = pattern.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b':' && i + 1 < b.len() && (b[i + 1].is_ascii_alphanumeric() || b[i + 1] == b'_') {
            let mut j = i + 1;
            while j < b.len() && (b[j].is_ascii_alphanumeric() || b[j] == b'_') {
                j += 1;
            }
            keys.push(pattern[i + 1..j].to_string());
            out.push_str("([^/]+)");
            i = j;
        } else {
            // the rest is a JavaScript regular expression in Node: the same in this one
            out.push(b[i] as char);
            i += 1;
        }
    }
    out.push('$');
    (Regex::new(&out).expect("route pattern"), keys)
}

impl Router {
    pub fn new() -> Router {
        Router::default()
    }

    fn push(&mut self, method: Method, pattern: &str, access: Access, handler: Handler) {
        let (re, keys) = compile(pattern);
        let body_limit = if pattern.starts_with("/api/converter/") { 256 * 1024 } else { 1024 * 1024 };
        self.routes.push(Route { method, pattern: pattern.to_string(), re, keys, access, handler, body_limit });
    }

    /// A route whose handler runs on a blocking thread.
    pub fn add(&mut self, method: Method, pattern: &str, access: Access, f: impl Fn(&mut Ctx) -> Result<Reply, HttpError> + Send + Sync + 'static) -> &mut Self {
        self.push(method, pattern, access, Handler::Blocking(Arc::new(f)));
        self
    }

    /// A route whose handler is async (streams, long waits).
    pub fn add_async(&mut self, method: Method, pattern: &str, access: Access, f: impl Fn(Ctx) -> BoxFuture<'static, Result<Reply, HttpError>> + Send + Sync + 'static) -> &mut Self {
        self.push(method, pattern, access, Handler::Async(Arc::new(f)));
        self
    }

    /// GET, signed in.
    pub fn get(&mut self, pattern: &str, f: impl Fn(&mut Ctx) -> Result<Reply, HttpError> + Send + Sync + 'static) -> &mut Self {
        self.add(Method::GET, pattern, Access::SignedIn, f)
    }

    /// POST, signed in.
    pub fn post(&mut self, pattern: &str, f: impl Fn(&mut Ctx) -> Result<Reply, HttpError> + Send + Sync + 'static) -> &mut Self {
        self.add(Method::POST, pattern, Access::SignedIn, f)
    }

    /// A special path (exact, or a prefix ending in `/`) answered before the host and session checks.
    pub fn raw(&mut self, path: &str, f: impl Fn(RawReq) -> BoxFuture<'static, Res> + Send + Sync + 'static) -> &mut Self {
        self.raw.push((path.to_string(), Arc::new(f)));
        self
    }

    /// An API path answered by hand after the sign-in and CSRF checks, any method (see ApiRaw).
    pub fn api_raw(&mut self, path: &str, f: impl Fn(ApiRaw) -> BoxFuture<'static, Res> + Send + Sync + 'static) -> &mut Self {
        self.api_raw.push((path.to_string(), Arc::new(f)));
        self
    }

    pub fn api_raw_for(&self, path: &str) -> Option<Arc<ApiRawFn>> {
        self.api_raw.iter().find(|(p, _)| p == path).map(|(_, f)| f.clone())
    }

    /// Pages and files (after the sign-in checks).
    pub fn web(&mut self, f: impl Fn(WebReq) -> BoxFuture<'static, Res> + Send + Sync + 'static) -> &mut Self {
        self.web = Some(Arc::new(f));
        self
    }

    /// http.js Router.match: the first route of this method whose pattern matches; params decoded
    /// (a param that does not decode: no match at all).
    pub fn find(&self, method: &Method, raw_path: &str) -> Option<(&Route, HashMap<String, String>)> {
        for r in &self.routes {
            if &r.method != method {
                continue;
            }
            let Some(m) = r.re.captures(raw_path) else { continue };
            let mut params = HashMap::new();
            for (i, k) in r.keys.iter().enumerate() {
                let v = crate::api::decode(m.get(i + 1).map_or("", |x| x.as_str()), false)?;
                params.insert(k.clone(), v);
            }
            return Some((r, params));
        }
        None
    }

    pub fn raw_for(&self, path: &str) -> Option<Arc<RawFn>> {
        self.raw.iter().find(|(p, _)| if p.ends_with('/') { path.starts_with(p.as_str()) } else { path == p }).map(|(_, f)| f.clone())
    }
}

pub fn status(s: u16) -> StatusCode {
    StatusCode::from_u16(s).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_as_node() {
        let mut r = Router::new();
        r.get("/api/security/ca.crt", |_| Ok(Reply::json(json!(1))));
        r.get("/api/accounts/:name", |_| Ok(Reply::json(json!(2))));
        assert!(r.find(&Method::GET, "/api/security/ca.crt").is_some());
        // a dot in a Node pattern is any character
        assert!(r.find(&Method::GET, "/api/security/caXcrt").is_some());
        let (_, p) = r.find(&Method::GET, "/api/accounts/a%20b").unwrap();
        assert_eq!(p["name"], "a b");
        assert!(r.find(&Method::GET, "/api/accounts/%zz").is_none());
        assert!(r.find(&Method::GET, "/api/accounts/a/b").is_none());
        assert!(r.find(&Method::HEAD, "/api/accounts/x").is_none());
    }

    #[test]
    fn numbers() {
        assert_eq!(num(3.0), json!(3));
        assert_eq!(num(0.5), json!(0.5));
        assert_eq!(num(f64::NAN), Value::Null);
        assert_eq!(num_text(24.0), "24");
        assert_eq!(js_number(" 12 "), 12.0);
        assert!(js_number("abc").is_nan());
        assert_eq!(number_or(Some(&"0".to_string()), 300.0), 300.0);
        assert_eq!(number_or(None, 300.0), 300.0);
    }

    #[test]
    fn gzip_only_big_and_accepted() {
        let small = send_json(200, &json!({ "a": 1 }), "gzip");
        assert!(small.headers().get("content-encoding").is_none());
        let big = json!({ "a": "x".repeat(2000) });
        assert_eq!(send_json(200, &big, "gzip, deflate, br").headers()["content-encoding"], "gzip");
        assert!(send_json(200, &big, "identity").headers().get("content-encoding").is_none());
        assert!(send_json(200, &big, "xgzip").headers().get("content-encoding").is_none());
    }
}
