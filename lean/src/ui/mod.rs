//! The ui area: everything that makes the browser pages work unchanged.
//! The pages stay as they are (`web/`, the Studio pages in `src/renderer`,
//! the interface packs); this serves them exactly as server/index.js does:
//! static files (ETag, 304, compression, the security headers and CSP),
//! versioned links (/v/<version>/…), the critical-update bar, the early-data
//! hint, the Studio translations, the /original switch, interface packs
//! (Settings → Interface), exports (server/exporter.js) and the settings
//! routes of the "Other" group (general settings, look, dashboards, work
//! limits).
//!
//! What it needs from core is the small trait in `ctx.rs`; `local.rs`
//! implements it for today's lean server.

pub mod ctx;
pub mod exporter;
pub mod html;
pub mod http;
pub mod js;
pub mod local;
pub mod packs;
pub mod settings;
pub mod translations;
pub mod zip;

use axum::body::Body;
use axum::http::{header, HeaderMap, HeaderValue, Method, Response, StatusCode};
use ctx::{Level, UiCtx};
use html::LONG_CACHE;
use http::{error, error_code, not_found, redirect, send_json, FileCache, Req, Res, ServeOpts};
use serde_json::{json, Map, Value};
use sha2::Digest;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const UI_COOKIE: &str = "sm_ui_original";
const ENCODER_PAGE: &str = "/studio/encoder.html";
const PREFETCH_WINDOW_MS: u64 = 2000;
const LOGIN_PAGES: [&str; 3] = ["login.html", "login-code.html", "login-two-factor.html"];
const PUBLIC_STATIC: [&str; 8] = ["/web/s6/login.css", "/login", "/web/login.js", "/web/shell.css", "/web/icon.png", "/login/code", "/web/login-code.js", "/web/login-two-factor.js"];

// ---- security headers (index.js securityHeaders)

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

/// The Content-Security-Policy for a path: the Studio pages (not the Encoder's) may
/// eval and draw the map; the main page draws an interface pack's map; the rest neither.
pub fn csp_for(raw_path: &str) -> String {
    let page = raw_path.split('?').next().unwrap_or("");
    if page.starts_with("/studio/") && page != ENCODER_PAGE {
        csp_with("'self' 'unsafe-eval'", &format!("'self' data: blob: {MAP_HOSTS}"), &format!("'self' {MAP_HOSTS}"))
    } else if page == "/" || page == "/index.html" {
        csp_with("'self'", &format!("'self' data: blob: {MAP_HOSTS}"), &format!("'self' {MAP_HOSTS}"))
    } else {
        csp_with("'self'", "'self' data: blob:", "'self'")
    }
}

/// securityHeaders on every answer of the main handler (an answer's own value wins, as
/// writeHead's do over setHeader's).
pub fn security_headers(raw_path: &str, h: &mut HeaderMap) {
    let set = |h: &mut HeaderMap, k: &'static str, v: &str| {
        if !h.contains_key(k) {
            if let Ok(v) = HeaderValue::from_str(v) {
                h.insert(k, v);
            }
        }
    };
    set(h, "x-content-type-options", "nosniff");
    set(h, "referrer-policy", "no-referrer");
    set(h, "x-frame-options", "SAMEORIGIN");
    set(h, "cross-origin-opener-policy", "same-origin");
    set(h, "cross-origin-resource-policy", "same-origin");
    set(h, "permissions-policy", "camera=(), microphone=(), geolocation=(), usb=(), serial=(), payment=(), fullscreen=(self)");
    set(h, "content-security-policy", &csp_for(raw_path));
}

/// /healthz: readable cross-origin (the plain-HTTP page checks the certificate with it).
pub fn healthz(head: bool) -> Res {
    Response::builder()
        .header(header::CONTENT_TYPE, "text/plain")
        .header(header::CACHE_CONTROL, "no-store")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .body(if head { Body::empty() } else { Body::from("ok") })
        .unwrap()
}

/// parseCookies (server/auth.js): the first of a repeated name wins.
pub fn parse_cookies(header: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for part in header.split(';') {
        let Some(i) = part.find('=') else { continue };
        if i == 0 {
            continue;
        }
        let name = part[..i].trim().to_string();
        let raw = part[i + 1..].trim();
        let value = crate::api::decode(raw, false).unwrap_or_else(|| raw.to_string());
        out.entry(name).or_insert(value);
    }
    out
}

// ---- configuration

pub struct UiConfig {
    pub app_root: PathBuf,
    pub data: PathBuf,
    /// DEFAULT_UI (sentry-six): the interface everyone gets until an admin chooses one; None for Original
    pub default_ui: Option<String>,
    /// APP_VERSION (named in the original interface's ui.json)
    pub app_version: String,
    pub ffmpeg: String,
    pub ffprobe: Option<String>,
    /// EXPORT_ENCODER != cpu
    pub export_gpu: bool,
    /// BUILD_INFO.json's sha: the version of /v/<version>/ links (else this start)
    pub build_sha: Option<String>,
}

impl UiConfig {
    /// From the Node server's environment names.
    pub fn from_env(app_root: PathBuf, data: PathBuf) -> UiConfig {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let ui = env("DEFAULT_UI").unwrap_or_else(|| "sentry-six".into()).trim().to_lowercase();
        let build = std::fs::read_to_string(app_root.join("BUILD_INFO.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
        let sha = build.as_ref().and_then(|b| b.get("sha")).filter(|s| js::truthy(s)).map(js::string);
        UiConfig {
            default_ui: if ui == "original" { None } else { Some(ui) },
            app_version: env("APP_VERSION").unwrap_or_default(),
            ffmpeg: env("FFMPEG_PATH").unwrap_or_else(|| "ffmpeg".into()),
            ffprobe: env("FFPROBE_PATH"),
            export_gpu: std::env::var("EXPORT_ENCODER").ok().as_deref() != Some("cpu"),
            build_sha: sha,
            app_root,
            data,
        }
    }
}

// ---- the early data of the main page (web/prefetch.js)

struct Learning {
    key: String,
    until: std::time::Instant,
    urls: Vec<String>,
    serial: u64,
}

#[derive(Default)]
struct Prefetch {
    learning: HashMap<String, Learning>,
    /// `${user}|${version}` -> (last, hints), oldest first
    learnt: Vec<(String, Vec<String>, Vec<String>)>,
    /// openings a newer one replaced before their window ended (their timers still save them)
    retired: HashMap<u64, Learning>,
    serial: u64,
}

/// A path without its /v/<version>/ prefix, and whether it may be kept a year.
pub struct Unversioned {
    pub path: String,
    pub version: Option<String>,
    pub long_cache: bool,
}

pub struct Ui {
    pub cfg: UiConfig,
    ctx: Arc<dyn UiCtx>,
    pub packs: packs::Packs,
    files: FileCache,
    translations: translations::Translations,
    pub exporter: Arc<exporter::Exporter>,
    boot_id: String,
    prefetch: Arc<Mutex<Prefetch>>,
    original_zip: Mutex<Option<Arc<Vec<u8>>>>,
    resources: settings::Resources,
    work: Mutex<Value>,
}

fn list_of(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

impl Ui {
    pub fn new(cfg: UiConfig, ctx: Arc<dyn UiCtx>) -> Arc<Ui> {
        let builtin = [cfg.app_root.join("ui-packs"), cfg.app_root.join("examples").join("ui-packs")].into_iter().find(|d| d.exists());
        let packs = packs::Packs::new(cfg.data.join("ui-packs"), ctx.clone(), builtin.as_deref(), cfg.default_ui.clone());
        if let Err(e) = packs.tidy() {
            ctx.log(Level::Warn, "ui", &format!("UI packs folder: {e}"));
        }
        let exporter = exporter::Exporter::new(
            exporter::ExporterCfg {
                dir: cfg.data.join("exports"),
                ffmpeg: cfg.ffmpeg.clone(),
                ffprobe: cfg.ffprobe.clone(),
                gpu: cfg.export_gpu,
                gpu_encoders: exporter::GPU_ENCODERS.iter().map(|s| s.to_string()).collect(),
            },
            ctx.clone(),
        );
        if let Err(e) = exporter.tidy() {
            ctx.log(Level::Warn, "export", &format!("Exports folder: {e}"));
        }
        let every = exporter.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(3600));
            let _ = every.tidy();
        });
        let mut prefetch = Prefetch::default();
        if let Some(Value::Object(m)) = ctx.setting("prefetch") {
            for (k, v) in m {
                prefetch.learnt.push((k, list_of(v.get("last")), list_of(v.get("hints"))));
            }
        }
        let boot_id = cfg.build_sha.clone().unwrap_or_else(|| format!("start-{}", chrono::Utc::now().timestamp_millis()));
        // (index.js works out once at start whether the Viewer shows car data)
        ctx.viewer_car_data();
        let resources = settings::detect_resources();
        let work = settings::pick_limits(&resources, ctx.setting("work-limits").as_ref());
        Arc::new(Ui {
            translations: translations::Translations::new(cfg.app_root.join("src/renderer/scripts/data/translations.js")),
            cfg,
            ctx,
            packs,
            files: FileCache::default(),
            exporter,
            boot_id,
            prefetch: Arc::new(Mutex::new(prefetch)),
            original_zip: Mutex::new(None),
            resources,
            work: Mutex::new(work),
        })
    }

    fn web(&self) -> PathBuf {
        self.cfg.app_root.join("web")
    }

    fn by(&self, req: &Req) -> String {
        format!("{} from {}", self.ctx.user(&req.info()).unwrap_or_else(|| "someone".into()), self.ctx.client_key(&req.info()))
    }

    /// This browser opened /original: the built-in interface there.
    pub fn original_only(&self, req: &Req) -> bool {
        parse_cookies(req.header("cookie").unwrap_or("")).get(UI_COOKIE).map(String::as_str) == Some("1")
    }

    /// The version in /v/<version>/ links: this build and the interface this browser is shown.
    pub fn asset_version(&self, req: &Req) -> String {
        let which = if self.original_only(req) { "original".to_string() } else { self.packs.active().unwrap_or_else(|| "builtin".into()) };
        let digest = sha2::Sha256::digest(format!("{}|{which}", self.boot_id).as_bytes());
        base64url(&digest).chars().take(12).collect()
    }

    /// /v/<version>/<path> is <path>, kept a year when the version is the current one.
    pub fn strip_version(&self, req: &Req, p: &str) -> Unversioned {
        let mut p = p.to_string();
        // a versioned Studio page's ../../assets/… lands on /v/assets/…
        if p.starts_with("/v/assets/") {
            p = p[2..].to_string();
        }
        if let Some(rest) = p.strip_prefix("/v/") {
            if let Some(slash) = rest.find('/') {
                let v = &rest[..slash];
                let inner = &rest[slash..];
                let ok = !v.is_empty() && v.len() <= 40 && v.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-');
                if ok && !inner.starts_with("/api/") && !inner.starts_with("/v/") {
                    let long = v == self.asset_version(req);
                    return Unversioned { path: inner.to_string(), version: Some(v.to_string()), long_cache: long };
                }
            }
        }
        Unversioned { path: p, version: None, long_cache: false }
    }

    // ---- early data

    /// noteStartCall: a fetch() the main page made in its first two seconds (every signed-in GET under /api/).
    pub fn note_api_call(&self, req: &Req, p: &str) {
        if req.method != Method::GET {
            return;
        }
        let info = req.info();
        if self.ctx.user(&info).is_none() {
            return;
        }
        let Some(h) = self.ctx.session_hash(&info) else { return };
        let mut g = self.prefetch.lock().unwrap();
        let Some(l) = g.learning.get_mut(&h) else { return };
        if std::time::Instant::now() > l.until || l.urls.len() >= 20 {
            return;
        }
        if req.header("sec-fetch-dest") != Some("empty") {
            return;
        }
        for skip in ["/api/events", "/api/media", "/api/scrub", "/api/converter/events"] {
            if let Some(rest) = p.strip_prefix(skip) {
                if !rest.bytes().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == b'_') {
                    return;
                }
            }
        }
        let u = format!("{p}{}", req.search);
        if !l.urls.contains(&u) {
            l.urls.push(u);
        }
    }

    fn start_learning(&self, h: Option<String>, key: String) {
        let Some(h) = h else { return };
        let serial = {
            let mut g = self.prefetch.lock().unwrap();
            g.serial += 1;
            let serial = g.serial;
            if let Some(old) = g.learning.insert(h.clone(), Learning { key, until: std::time::Instant::now() + std::time::Duration::from_millis(PREFETCH_WINDOW_MS), urls: Vec::new(), serial }) {
                g.retired.insert(old.serial, old);
            }
            serial
        };
        let state = self.prefetch.clone();
        let ctx = self.ctx.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(PREFETCH_WINDOW_MS + 100));
            let mut g = state.lock().unwrap();
            let l = if g.learning.get(&h).is_some_and(|l| l.serial == serial) { g.learning.remove(&h) } else { g.retired.remove(&serial) };
            let Some(l) = l else { return };
            let (key, urls) = (l.key, l.urls);
            let had = g.learnt.iter().position(|e| e.0 == key);
            // only what the last two openings both asked for
            let hints: Vec<String> = match had {
                Some(i) => urls.iter().filter(|u| g.learnt[i].1.contains(u)).cloned().collect(),
                None => Vec::new(),
            };
            let same_set = |a: &Vec<String>, b: &Vec<String>| a.len() == b.len() && a.iter().all(|u| b.contains(u));
            let same = had.is_some_and(|i| same_set(&g.learnt[i].2, &hints) && same_set(&g.learnt[i].1, &urls));
            if let Some(i) = had {
                g.learnt.remove(i);
            }
            g.learnt.push((key, urls, hints));
            if g.learnt.len() > 200 {
                g.learnt.remove(0);
            }
            if !same {
                let mut m = Map::new();
                for (k, last, hints) in &g.learnt {
                    m.insert(k.clone(), json!({ "last": last, "hints": hints }));
                }
                ctx.set_setting("prefetch", &Value::Object(m));
            }
        });
    }

    fn hints(&self, key: &str) -> Vec<String> {
        self.prefetch.lock().unwrap().learnt.iter().find(|e| e.0 == key).map(|e| e.2.clone()).unwrap_or_default()
    }

    // ---- pages and files

    /// The page side of the handler, after /api/: /original, the sign-in redirects, the
    /// shell pages, /web/, /studio/, /shared/ and /assets/.
    pub fn page(&self, req: &Req, u: &Unversioned) -> Res {
        let p = u.path.as_str();
        let info = req.info();
        let h = &req.headers;
        if p == "/original" {
            let off = req.query.get("off").map(String::as_str) == Some("1");
            let cookie = format!(
                "{UI_COOKIE}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}{}",
                if off { "" } else { "1" },
                if off { 0 } else { 365 * 86400 },
                if self.ctx.is_secure(&info) { "; Secure" } else { "" }
            );
            return redirect(StatusCode::FOUND, "/#/settings/interface", &[("Set-Cookie", cookie), ("Cache-Control", "no-store".into())]);
        }
        let public_static = PUBLIC_STATIC.contains(&p) || p.strip_prefix("/web/fonts/").is_some_and(|r| !r.contains('/'));
        let user = self.ctx.user(&info);
        if user.is_some() && self.ctx.setup_only(&info) && !public_static && p != "/login/two-factor" && (p == "/" || is_html(p) || p.starts_with("/studio")) {
            return redirect(StatusCode::FOUND, "/login/two-factor", &[("Cache-Control", "no-store".into())]);
        }
        if user.is_none() && !public_static {
            let where_ = if self.ctx.pending_code(&info) { "/login/code" } else { "/login" };
            let next = if p == "/" { String::new() } else { format!("?next={}", exporter::encode_uri_component(&format!("{p}{}", req.search))) };
            return redirect(StatusCode::FOUND, &format!("{where_}{next}"), &[]);
        }
        let web = self.web();
        let renderer = self.cfg.app_root.join("src").join("renderer");
        match p {
            "/" | "/index.html" => {
                let key = format!("{}|{}", user.clone().unwrap_or_else(|| "null".into()), self.asset_version(req));
                self.start_learning(self.ctx.session_hash(&info), key.clone());
                let hints = self.hints(&key);
                return self.ui(req, u, "web", &web, "index.html", Some(Arc::new(move |html: &str| html::with_prefetch(html, &hints))), None);
            }
            "/login" => return self.ui(req, u, "web", &web, "login.html", None, None),
            "/login/code" => return self.ui(req, u, "web", &web, "login-code.html", None, None),
            "/login/two-factor" => return self.ui(req, u, "web", &web, "login-two-factor.html", None, None),
            // always the built-in one: an interface pack cannot replace the bar
            "/web/critical.js" => return self.serve(req, u, &web, "critical.js", ServeParts::default()),
            "/studio" | "/studio/" => return redirect(StatusCode::FOUND, &format!("/studio/index.html{}", req.search), &[]),
            _ => {}
        }
        if let Some(rel) = p.strip_prefix("/web/") {
            let cache = if p.contains("/fonts/") { "public, max-age=604800" } else { "no-cache" };
            return self.ui(req, u, "web", &web, rel, None, Some(cache.into()));
        }
        if p == "/studio/index.html" && req.query.get("embed").map(String::as_str) == Some("encoder") {
            return redirect(StatusCode::FOUND, &format!("{ENCODER_PAGE}{}", req.search), &[]);
        }
        if p == "/studio/scripts/data/translations.js" {
            return match self.translations.module() {
                Ok((body, etag)) => http::send_text(req, &body, "text/javascript; charset=utf-8", &etag, u.long_cache.then_some(LONG_CACHE)),
                Err(e) => self.internal(req, &e),
            };
        }
        if let Some(lang) = studio_lang(p) {
            return match self.translations.language(lang) {
                Ok(Some((body, etag))) => http::send_text(req, &body, "application/json; charset=utf-8", &etag, None),
                Ok(None) => not_found(h),
                Err(e) => self.internal(req, &e),
            };
        }
        if let Some(rel) = p.strip_prefix("/studio/") {
            let transform: Option<PageTransform> = match rel {
                "index.html" => Some(Arc::new(html::studio_html)),
                "encoder.html" => {
                    let skeleton = std::fs::read_to_string(web.join("encoderSkeleton.css")).ok();
                    Some(Arc::new(move |h: &str| html::encoder_html(h, skeleton.as_deref())))
                }
                _ => None,
            };
            let cache = rel.starts_with("fonts/").then(|| "public, max-age=604800".to_string());
            return self.ui(req, u, "studio", &renderer, rel, transform, cache);
        }
        if let Some(rel) = p.strip_prefix("/shared/") {
            return self.serve(req, u, &self.cfg.app_root.join("src").join("shared"), rel, ServeParts::default());
        }
        if let Some(rel) = p.strip_prefix("/assets/") {
            return self.serve(req, u, &self.cfg.app_root.join("assets"), rel, ServeParts::default());
        }
        not_found(h)
    }

    fn internal(&self, req: &Req, e: &str) -> Res {
        self.ctx.log(Level::Warn, "server", &format!("{} {}: {e}", req.method, req.raw_path));
        error(&req.headers, StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
    }

    /// The options of one serveFile call, with versionedScript applied.
    fn opts(&self, u: &Unversioned, p: &str, parts: &ServeParts) -> ServeOpts {
        let script_version = u.version.as_ref().filter(|_| is_script(p));
        let mut o = ServeOpts { transform: parts.transform.clone().map(|t| Box::new(move |s: &str| t(s)) as http::Transform), transform_key: None, cache: parts.cache.clone() };
        if let (Some(v), None) = (script_version, &parts.transform) {
            let v = v.clone();
            o.transform_key = Some(v.clone());
            o.transform = Some(Box::new(move |js: &str| html::version_script_links(js, &v)));
            o.cache = Some(if u.long_cache { LONG_CACHE.into() } else { "no-cache".into() });
        }
        o
    }

    /// serve: a built-in file (kept a year when its version is the current one).
    fn serve(&self, req: &Req, u: &Unversioned, root: &Path, rel: &str, mut parts: ServeParts) -> Res {
        if u.long_cache {
            parts.cache = Some(LONG_CACHE.into());
        }
        let o = self.opts(u, &u.path, &parts);
        self.files.serve_file(req, root, rel, o).unwrap_or_else(|| not_found(&req.headers))
    }

    /// ui: the chosen interface's file first, else the built-in one; pages rewritten.
    fn ui(&self, req: &Req, u: &Unversioned, kind: &str, root: &Path, rel: &str, inner: Option<PageTransform>, cache: Option<String>) -> Res {
        let p = u.path.as_str();
        let mut parts = ServeParts { transform: inner.clone(), cache };
        if is_html(rel) {
            let version = self.asset_version(req);
            let page_dir = if p.ends_with('/') { p.to_string() } else { format!("{}/", html::posix_dirname(p)).replace("//", "/") };
            // sign-in pages have no authenticated status yet
            let critical = !LOGIN_PAGES.contains(&rel);
            parts.transform = Some(Arc::new(move |h: &str| {
                let page = match &inner {
                    Some(t) => t(h),
                    None => h.to_string(),
                };
                html::version_links(&if critical { html::with_critical_bar(&page) } else { page }, &page_dir, &version)
            }));
        }
        let own = if self.original_only(req) { None } else { self.packs.root(kind) };
        if let Some(own) = own {
            let own_parts = ServeParts { transform: parts.transform.clone(), cache: Some(if u.long_cache { LONG_CACHE.into() } else { "no-cache".into() }) };
            let o = self.opts(u, p, &own_parts);
            if let Some(r) = self.files.serve_file(req, &own, rel, o) {
                return r;
            }
        }
        self.serve(req, u, root, rel, parts)
    }

    // ---- API

    /// The ui area's API routes; None when the path is not one of them.
    pub fn api(&self, req: &Req, p: &str) -> Option<Res> {
        let seg: Vec<&str> = req.raw_path.trim_start_matches("/api/").split('/').collect();
        let m = &req.method;
        let mine = matches!(
            (m.as_str(), seg.as_slice()),
            ("GET", ["ui-packs"])
                | ("PUT", ["ui-packs", "active"])
                | ("DELETE", ["ui-packs", _])
                | ("GET", ["ui-packs", "original.zip"])
                | (_, ["ui-packs", "upload"])
                | ("POST", ["vehicles", _, "exports"])
                | ("POST" | "GET", ["exports"])
                | ("GET" | "DELETE", ["exports", _])
                | ("GET", ["exports", _, "file"])
                | ("GET", ["settings"])
                | ("PUT", ["settings", "appearance"])
                | ("GET" | "PUT", ["settings", "work-limits"])
                | ("GET" | "PUT", ["dashboards"])
        );
        // (the upload is answered by hand: any method reaches it, as on the Node server)
        if !mine {
            return None;
        }
        let h = &req.headers;
        let info = req.info();
        let Some(user) = self.ctx.user(&info) else { return Some(error(h, StatusCode::UNAUTHORIZED, "Sign in first.")) };
        if m != Method::GET && m != Method::HEAD {
            if req.header("x-requested-with") != Some("sentry-six-manager") {
                return Some(error(h, StatusCode::FORBIDDEN, "Missing X-Requested-With header."));
            }
            if let Some(origin) = req.header("origin").filter(|o| *o != "null") {
                let origin_host = origin.split_once("://").map(|(_, r)| r.split(['/', '?', '#']).next().unwrap_or("").to_lowercase());
                let host = req.header("host").map(str::to_lowercase);
                if origin_host.is_none() || origin_host != host {
                    return Some(error(h, StatusCode::FORBIDDEN, "Cross-site request refused."));
                }
            }
        }
        if p == "/api/ui-packs/upload" {
            return Some(self.upload(req));
        }
        // the route's parameters, decoded (a bad escape: no route)
        let param = |i: usize| crate::api::decode(seg[i], false);
        if seg.iter().skip(1).any(|s| crate::api::decode(s, false).is_none()) {
            return Some(not_found(h));
        }
        let body = if m == Method::GET {
            None
        } else {
            match read_json(req) {
                Ok(b) => b,
                Err(r) => return Some(r),
            }
        };
        let ok = |v: Value| send_json(h, StatusCode::OK, &v);
        let bad = |msg: &str| error(h, StatusCode::BAD_REQUEST, msg);
        Some(match (m.as_str(), seg.as_slice()) {
            ("GET", ["ui-packs"]) => ok(json!({ "active": self.packs.active(), "packs": self.packs.list(), "original": self.original_only(req) })),
            ("PUT", ["ui-packs", "active"]) => {
                let id = body.as_ref().and_then(|b| b.as_object()).and_then(|b| b.get("id")).cloned().unwrap_or(Value::Null);
                if !id.is_null() && !id.is_string() {
                    return Some(bad("Choose an interface."));
                }
                // a pack's scripts run as whoever signs in: the password again
                if !id.is_null() && !self.ctx.recently_confirmed(&info) {
                    return Some(confirm_required(h));
                }
                let before = self.packs.active();
                let now = match self.packs.set_active(id.as_str()) {
                    Ok(n) => n,
                    Err(e) => return Some(bad(&e.0)),
                };
                let mut res = ok(json!({ "ok": true, "active": now }));
                // and this browser leaves /original, to see the choice
                if self.original_only(req) {
                    let c = format!("{UI_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{}", if self.ctx.is_secure(&info) { "; Secure" } else { "" });
                    res.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&c).unwrap());
                }
                if now != before {
                    self.ctx.announce("interface");
                    match &now {
                        Some(n) => self.ctx.audit(Level::Warn, &format!("Interface: \"{}\" ({n}), for everyone: {}", self.packs.name_of(n).unwrap_or_else(|| "undefined".into()), self.by(req))),
                        None => self.ctx.audit(Level::Info, &format!("Interface: the built-in one, for everyone: {}", self.by(req))),
                    }
                }
                res
            }
            ("GET", ["ui-packs", "original.zip"]) => {
                let zip = {
                    let mut g = self.original_zip.lock().unwrap();
                    g.get_or_insert_with(|| Arc::new(packs::original_pack(&self.web(), &self.cfg.app_root.join("src").join("renderer"), &self.cfg.app_version))).clone()
                };
                Response::builder()
                    .header(header::CONTENT_TYPE, "application/zip")
                    .header(header::CONTENT_DISPOSITION, "attachment; filename=\"sentry-six-manager-interface.zip\"")
                    .header(header::CONTENT_LENGTH, zip.len())
                    .header(header::CACHE_CONTROL, "no-store")
                    .body(Body::from((*zip).clone()))
                    .unwrap()
            }
            ("DELETE", ["ui-packs", _]) => {
                let id = param(2).unwrap();
                let name = self.packs.name_of(&id).unwrap_or_else(|| "undefined".into());
                let was_active = self.packs.active().as_deref() == Some(id.as_str());
                if let Err(e) = self.packs.remove(&id) {
                    return Some(bad(&e.0));
                }
                if was_active {
                    self.ctx.announce("interface");
                }
                self.ctx.audit(Level::Info, &format!("Interface \"{name}\" ({id}) deleted: {}", self.by(req)));
                ok(json!({ "ok": true, "active": self.packs.active() }))
            }
            ("POST", ["vehicles", _, "exports"]) => {
                let Some(v) = self.ctx.vehicle(&param(2).unwrap()) else { return Some(error(h, StatusCode::NOT_FOUND, "No such vehicle.")) };
                match self.exporter.start(&v, body.as_ref().unwrap_or(&Value::Null)) {
                    Ok(x) => ok(x),
                    Err(e) => bad(&e.0),
                }
            }
            ("POST", ["exports"]) => {
                let b = body.clone().unwrap_or(Value::Null);
                let owner = exporter::first_file(&b).and_then(|f| self.ctx.resolve_footage(&f));
                let Some((_, v)) = owner else { return Some(bad("These clips are not in any vehicle's footage.")) };
                match self.exporter.start(&v, &b) {
                    Ok(x) => ok(x),
                    Err(e) => bad(&e.0),
                }
            }
            ("GET", ["exports"]) => ok(json!({ "exports": self.exporter.list(req.query.get("vehicle").filter(|v| !v.is_empty()).map(String::as_str)) })),
            ("GET", ["exports", _]) => match self.exporter.get(&param(1).unwrap()) {
                Some(x) => ok(x),
                None => error(h, StatusCode::NOT_FOUND, "No such export (exports are kept for a day)."),
            },
            ("DELETE", ["exports", _]) => ok(json!({ "ok": self.exporter.cancel(&param(1).unwrap()) })),
            ("GET", ["exports", _, "file"]) => {
                let Some((file, name)) = self.exporter.file(&param(1).unwrap()) else {
                    return Some(error(h, StatusCode::NOT_FOUND, "This export is not ready, or it was removed after a day."));
                };
                let Ok(f) = std::fs::File::open(&file) else { return Some(self.internal(req, "export file")) };
                let size = f.metadata().map(|m| m.len()).unwrap_or(0);
                let b = Response::builder()
                    .header(header::CONTENT_TYPE, "video/mp4")
                    .header(header::CONTENT_LENGTH, size)
                    .header(header::CACHE_CONTROL, "no-store")
                    .header("X-Content-Type-Options", "nosniff")
                    .header(header::CONTENT_DISPOSITION, exporter::disposition(&name));
                if req.head() {
                    b.body(Body::empty()).unwrap()
                } else {
                    b.body(Body::from_stream(tokio_util::io::ReaderStream::new(tokio::fs::File::from_std(f)))).unwrap()
                }
            }
            ("GET", ["settings"]) => ok(settings::settings(self.ctx.setting("appearance"), self.ctx.setting("power"))),
            ("PUT", ["settings", "appearance"]) => match settings::put_appearance(self.ctx.setting("appearance"), body.as_ref()) {
                Ok(next) => {
                    self.ctx.set_setting("appearance", &next);
                    ok(next)
                }
                Err(()) => self.internal(req, "appearance: not an object"),
            },
            ("GET", ["settings", "work-limits"]) => ok(self.work.lock().unwrap().clone()),
            ("PUT", ["settings", "work-limits"]) => match settings::parse_override(body.as_ref()) {
                Ok(next) => {
                    let next = Value::Object(next);
                    self.ctx.set_setting("work-limits", &next);
                    let view = settings::pick_limits(&self.resources, Some(&next));
                    *self.work.lock().unwrap() = view.clone();
                    self.ctx.work_limits_changed(&view["limits"]);
                    let what = next.as_object().filter(|o| !o.is_empty()).map_or("automatic".to_string(), |o| o.iter().map(|(k, v)| format!("{k} {v}")).collect::<Vec<_>>().join(", "));
                    self.ctx.audit(Level::Info, &format!("Background work limits set to {what}: {}", self.by(req)));
                    ok(view)
                }
                Err(e) => bad(&e),
            },
            ("GET", ["dashboards"]) => ok(settings::dashboards(self.ctx.setting(&format!("dash:{user}")), self.ctx.viewer_car_data())),
            ("PUT", ["dashboards"]) => match settings::clean_boards(body.as_ref()) {
                Ok(clean) => {
                    self.ctx.set_setting(&format!("dash:{user}"), &clean);
                    ok(clean)
                }
                Err(e) => bad(&e),
            },
            _ => not_found(h),
        })
    }

    /// POST /api/ui-packs/upload: the .zip as the raw body, its name in X-File-Name.
    fn upload(&self, req: &Req) -> Res {
        let h = &req.headers;
        if req.method != Method::POST {
            return error(h, StatusCode::METHOD_NOT_ALLOWED, "Use POST.");
        }
        // a pack's scripts run as whoever signs in: the password again
        if !self.ctx.recently_confirmed(&req.info()) {
            return confirm_required(h);
        }
        if req.body.len() as u64 > packs::MAX_ZIP_BYTES {
            return error(h, StatusCode::PAYLOAD_TOO_LARGE, "That file is too large.");
        }
        let file_name = crate::api::decode(req.header("x-file-name").unwrap_or(""), false).unwrap_or_default();
        match self.packs.install(&req.body, &file_name) {
            Ok(pack) => {
                self.ctx.audit(Level::Warn, &format!("Interface \"{}\" ({}) uploaded, {} files: {}", pack["name"].as_str().unwrap_or(""), pack["id"].as_str().unwrap_or(""), pack["files"], self.by(req)));
                send_json(h, StatusCode::OK, &json!({ "ok": true, "pack": pack }))
            }
            Err(e) => error(h, StatusCode::BAD_REQUEST, &e.0),
        }
    }
}

type PageTransform = Arc<dyn Fn(&str) -> String + Send + Sync>;

#[derive(Default, Clone)]
struct ServeParts {
    transform: Option<PageTransform>,
    cache: Option<String>,
}

fn is_html(p: &str) -> bool {
    let l = p.to_ascii_lowercase();
    l.ends_with(".html") || l.ends_with(".htm")
}

fn is_script(p: &str) -> bool {
    let l = p.to_ascii_lowercase();
    l.ends_with(".js") || l.ends_with(".mjs")
}

/// /^\/studio\/i18n\/([a-z]{2,3}(?:-[A-Za-z]{2,4})?)\.json$/
fn studio_lang(p: &str) -> Option<&str> {
    let l = p.strip_prefix("/studio/i18n/")?.strip_suffix(".json")?;
    let (a, b) = match l.split_once('-') {
        Some((a, b)) => (a, Some(b)),
        None => (l, None),
    };
    let ok_a = (2..=3).contains(&a.len()) && a.bytes().all(|c| c.is_ascii_lowercase());
    let ok_b = b.map_or(true, |b| (2..=4).contains(&b.len()) && b.bytes().all(|c| c.is_ascii_alphabetic()));
    (ok_a && ok_b).then_some(l)
}

fn confirm_required(h: &HeaderMap) -> Res {
    error_code(h, StatusCode::FORBIDDEN, "Enter your password to confirm this change.", "CONFIRM_PASSWORD")
}

/// readJson: nothing (or only white space) is no body; anything else must be JSON.
fn read_json(req: &Req) -> Result<Option<Value>, Res> {
    if req.body.len() > 1024 * 1024 {
        return Err(error(&req.headers, StatusCode::PAYLOAD_TOO_LARGE, "Request body too large"));
    }
    let text = String::from_utf8_lossy(&req.body);
    if packs::js_trim(&text).is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&text).map(Some).map_err(|_| error(&req.headers, StatusCode::BAD_REQUEST, "Invalid JSON"))
}

/// base64url without padding
pub fn base64url(b: &[u8]) -> String {
    const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        if c.len() > 1 {
            out.push(A[(n >> 6) as usize & 63] as char);
        }
        if c.len() > 2 {
            out.push(A[n as usize & 63] as char);
        }
    }
    out
}
