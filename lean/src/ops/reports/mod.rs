//! Feedback and diagnostics for the developers (server/reports.js,
//! reportsConfig.js; docs/reports-api.md, docs/security.md).
//!
//! OPT-IN ONLY. Nothing leaves this server unless an admin presses Send for
//! one feedback message or one support report, or turns on "Share
//! diagnostics with the developers" (then a report after a crash, a daily
//! health summary and an hourly heartbeat of numbers). Turning it off stops
//! that and drops the automatic reports still waiting.
//!
//! Where they go: only the developers' private receiver,
//! https://reports.skittles.live (REPORTS_URL may name another https://
//! one; plain http only to localhost under NODE_ENV=test, for the tests'
//! local fake receiver). Each report is cleaned (scrub.rs), sealed to the
//! receiver's key before it leaves this process, signed with the install's
//! own key (data/reports/install-key.pem; anonymous ones with anon-key.pem),
//! and stamped with a small proof of work. A report that cannot go now waits
//! sealed in data/reports/outbox (at most 20, 50 MB, 7 days).

pub mod protocol;
pub mod scrub;

use super::ctx::{Level, OpsCtx};
use super::js::{iso, truthy};
use super::net::{HttpReq, HttpRes, Transport};
use super::store::{self, DbError, DbResult};
use ed25519_dalek::SigningKey;
use protocol::{self as p, ReceiverKey};
use rand_core::{OsRng, RngCore};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const DEFAULT_ENDPOINT: &str = "https://reports.skittles.live";
/// The receiver's public keys, newest first (reportsConfig.js RECEIVER_KEYS).
pub const RECEIVER_KEYS: [(&str, &str, &str); 1] = [("208993f9bb2c38d1", "vwM+s1D0pRqmxCJn8usIqDpkRp1yWIi61FptVfk88Sg=", "cy6caX77BNO5cPuE1GA6d/D68zl2zwXZL2HV4G8AA/k=")];

pub const OUTBOX_MAX: usize = 20;
pub const OUTBOX_BYTES: u64 = 50 * 1024 * 1024;
pub const OUTBOX_DAYS: i64 = 7;
const TIMEOUT_MS: u64 = 20_000;
const CONFIG_TTL_MS: i64 = 10 * 60_000;
pub const MAX_BITS: u32 = 26;
pub const MANUAL_PER_HOUR: usize = 5;
const SENT_REFS_KEPT: usize = 20;
const DAY_MS: i64 = 86_400_000;
pub const HEARTBEAT_FIRST_MS: i64 = 35_000;
const HEARTBEAT_FIRST_JITTER_MS: i64 = 25_000;
pub const HEARTBEAT_EVERY_MS: i64 = 3_600_000;
const HEARTBEAT_JITTER_MS: i64 = 4 * 60_000;
pub const NOT_SET_UP: &str = "Reporting isn't set up in this build.";

fn auto_kind(k: &str) -> bool {
    matches!(k, "crash" | "daily" | "heartbeat")
}

/// A refusal with its status (and a code the page reads).
#[derive(Debug, Clone, PartialEq)]
pub struct ReportError {
    pub status: u16,
    pub message: String,
    pub code: Option<&'static str>,
}

fn err(status: u16, message: impl Into<String>) -> ReportError {
    ReportError { status, message: message.into(), code: None }
}

/// (manager.db failed: a 500, its text in the log)
impl From<DbError> for ReportError {
    fn from(e: DbError) -> ReportError {
        err(500, e.to_string())
    }
}

// ---- the endpoint and keys (reportsConfig.js)

#[derive(Clone, Debug)]
pub struct Config {
    pub endpoint: String,
    pub keys: Vec<ReceiverKey>,
    pub from_env_url: bool,
    pub from_env_key: bool,
    pub off: bool,
    pub error: Option<String>,
}

fn is_off(v: &str) -> bool {
    matches!(v.to_ascii_lowercase().as_str(), "off" | "false" | "0" | "no")
}

/// An endpoint as used: https://host[:port][/path] without a trailing slash;
/// http only for localhost under NODE_ENV=test.
pub fn check_endpoint(value: &str, env: &HashMap<String, String>) -> Result<String, String> {
    let v = value.trim();
    let not_address = || "REPORTS_URL is not an address.".to_string();
    let (scheme, rest) = v.split_once("://").ok_or_else(not_address)?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme.is_empty() || !scheme.as_bytes()[0].is_ascii_alphabetic() || !scheme.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'-' | b'.')) {
        return Err(not_address());
    }
    let (authority, path) = match rest.find(['/', '?', '#']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if authority.is_empty() {
        return Err(not_address());
    }
    let has_user = authority.contains('@');
    let host_port = authority.rsplit('@').next().unwrap().to_ascii_lowercase();
    let host = if host_port.starts_with('[') { host_port.split(']').next().map(|h| format!("{h}]")).unwrap_or_default() } else { host_port.split(':').next().unwrap_or("").to_string() };
    let port = host_port.strip_prefix(&host).and_then(|r| r.strip_prefix(':')).filter(|p| !p.is_empty());
    if port.is_some_and(|p| !p.bytes().all(|c| c.is_ascii_digit()) || p.parse::<u32>().map_or(true, |n| n > 65535)) {
        return Err(not_address());
    }
    let default_port = match scheme.as_str() {
        "https" => Some("443"),
        "http" => Some("80"),
        _ => None,
    };
    let test_local = scheme == "http" && env.get("NODE_ENV").map(String::as_str) == Some("test") && ["127.0.0.1", "localhost", "[::1]"].contains(&host.as_str());
    if scheme != "https" && !test_local {
        return Err("REPORTS_URL must be https://.".into());
    }
    let (path_only, query_hash) = match path.find(['?', '#']) {
        Some(i) => (&path[..i], &path[i..]),
        None => (path, ""),
    };
    // ("?" or "#" alone is an empty query or hash, as URL reads it)
    if has_user || query_hash.len() > 1 {
        return Err("REPORTS_URL takes no user name, query or #.".into());
    }
    let port_text = match port {
        Some(p) if Some(p.trim_start_matches('0')) != default_port.map(|d| d.trim_start_matches('0')) => format!(":{}", p.parse::<u32>().unwrap()),
        _ => String::new(),
    };
    let path_clean = path_only.trim_end_matches('/');
    Ok(format!("{scheme}://{host}{port_text}{path_clean}"))
}

pub fn reports_config(env: &HashMap<String, String>) -> Config {
    let mut out = Config { endpoint: DEFAULT_ENDPOINT.into(), keys: Vec::new(), from_env_url: false, from_env_key: false, off: false, error: None };
    let r = (|| -> Result<(), String> {
        if let Some(u) = env.get("REPORTS_URL").filter(|s| !s.is_empty()) {
            out.endpoint = check_endpoint(u, env)?;
            out.from_env_url = true;
        }
        if is_off(env.get("REPORTS").map(String::as_str).unwrap_or("")) {
            out.off = true;
            return Ok(());
        }
        match env.get("REPORTS_PUBLIC_KEY").filter(|s| !s.is_empty()) {
            Some(line) => {
                out.keys = p::parse_key_line(line)?;
                out.from_env_key = true;
            }
            None => {
                out.keys = RECEIVER_KEYS.iter().map(|(kid, pubk, sign)| p::normalize_key(Some(kid), pubk, Some(sign))).collect::<Result<_, _>>()?;
            }
        }
        Ok(())
    })();
    if let Err(e) = r {
        out.error = Some(e);
        out.keys = Vec::new();
    }
    out
}

/// The receiver's answer as an object ({} for anything else).
fn obj(b: &[u8]) -> Value {
    match serde_json::from_slice::<Value>(b) {
        Ok(v) if v.is_object() => v,
        _ => json!({}),
    }
}

/// The proof of work, as a hook so a test can do something while it runs.
pub type PowFn = Arc<dyn Fn(&[u8; 32], &str, u32) -> Result<String, String> + Send + Sync>;
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

struct Remote {
    endpoint: String,
    at: i64,
    data: Value,
}

struct Preview {
    payload: Value,
    until: i64,
}

#[derive(Default)]
struct Sched {
    started: bool,
    hb_next_at: Option<i64>,
}

pub struct Reports {
    ctx: Arc<dyn OpsCtx>,
    env: HashMap<String, String>,
    cfg: Config,
    pub configured: bool,
    off_text: String,
    dir: PathBuf,
    outbox_dir: PathBuf,
    crash_file: PathBuf,
    build_info: Value,
    transport: Arc<dyn Transport>,
    pub pow: Mutex<PowFn>,
    clock: Clock,
    previews: Mutex<Vec<(String, Preview)>>,
    remote: Mutex<Option<Remote>>,
    clock_offset: Mutex<i64>,
    flushing: Mutex<()>,
    sched: Mutex<Sched>,
    sources: std::sync::OnceLock<Sources>,
    /// what manager.db could not give the timers lately: logged once until it can
    unread: crate::core::db::LogOnce,
}

/// Where a report's diagnostics, heartbeat and identifiers come from: set by
/// `Ops` (ops::diag); without them, the context's test hooks answer.
pub struct Sources {
    pub diagnostics: Box<dyn Fn(&str) -> Value + Send + Sync>,
    pub heartbeat: Box<dyn Fn() -> Result<Value, String> + Send + Sync>,
    pub identifiers: Box<dyn Fn() -> Result<Vec<String>, String> + Send + Sync>,
}

fn rand_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn random() -> f64 {
    (OsRng.next_u64() >> 11) as f64 / (1u64 << 53) as f64
}

fn jitter(ms: i64) -> i64 {
    ((random() * 2.0 - 1.0) * ms as f64).round() as i64
}

fn backoff(n: i64) -> i64 {
    let base = (60_000.0 * 2f64.powi(n.min(10) as i32)).min(6.0 * 3_600_000.0);
    (base * (0.8 + random() * 0.4)) as i64
}

fn ensure_dir(d: &Path) {
    use std::os::unix::fs::DirBuilderExt;
    let _ = fs::DirBuilder::new().recursive(true).mode(0o700).create(d);
    let _ = fs::set_permissions(d, fs::Permissions::from_mode(0o700));
}

fn write_private(file: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(file)?;
    f.write_all(data)?;
    Ok(())
}

/// Node's PKCS#8 for an Ed25519 key: this prefix and the 32-byte seed.
const ED25519_PKCS8_PREFIX: [u8; 16] = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

pub fn key_to_pem(k: &SigningKey) -> String {
    let mut der = ED25519_PKCS8_PREFIX.to_vec();
    der.extend_from_slice(&k.to_bytes());
    let b = p::b64(&der);
    format!("-----BEGIN PRIVATE KEY-----\n{b}\n-----END PRIVATE KEY-----\n")
}

pub fn key_from_pem(text: &str) -> Option<SigningKey> {
    use ed25519_dalek::pkcs8::DecodePrivateKey;
    SigningKey::from_pkcs8_pem(text).ok()
}

/// String(x ?? '').trim() as the report builder takes text.
fn text_of(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(v) => super::js::to_string(v).trim().to_string(),
    }
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// str.slice(0, n) in UTF-16 units.
fn cut(s: &str, n: usize) -> String {
    super::power::js_slice(s, n)
}

impl Reports {
    pub fn new(ctx: Arc<dyn OpsCtx>, env: HashMap<String, String>, build_info: Value, transport: Arc<dyn Transport>, clock: Option<Clock>) -> Arc<Reports> {
        let cfg = reports_config(&env);
        if let Some(e) = &cfg.error {
            ctx.log("reports", Level::Warn, &format!("Reports: {e} Reporting is off."));
        }
        let dir = ctx.data_dir().join("reports");
        Arc::new(Reports {
            configured: !cfg.keys.is_empty(),
            off_text: if cfg.off { "Reporting is turned off on this server (REPORTS=off).".into() } else { NOT_SET_UP.into() },
            outbox_dir: dir.join("outbox"),
            crash_file: dir.join("crashes.json"),
            dir,
            cfg,
            env,
            ctx,
            build_info,
            transport,
            pow: Mutex::new(Arc::new(|h, n, b| p::solve_pow(h, n, b))),
            clock: clock.unwrap_or_else(|| Arc::new(store::now_ms)),
            previews: Mutex::new(Vec::new()),
            remote: Mutex::new(None),
            clock_offset: Mutex::new(0),
            flushing: Mutex::new(()),
            sched: Mutex::new(Sched::default()),
            sources: std::sync::OnceLock::new(),
            unread: crate::core::db::LogOnce::default(),
        })
    }

    /// The environment names reports.js reads, from the process.
    pub fn process_env() -> HashMap<String, String> {
        ["REPORTS", "REPORTS_URL", "REPORTS_PUBLIC_KEY", "NODE_ENV"].iter().filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v))).collect()
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    fn not_set_up(&self) -> ReportError {
        ReportError { status: 409, message: self.off_text.clone(), code: Some("NOT_SET_UP") }
    }

    /// The settings over their defaults; an error when they cannot be read (never taken as "not
    /// anonymous").
    pub fn settings(&self) -> DbResult<Value> {
        let mut s = json!({ "share": false, "anonymous": false });
        if let Some(Value::Object(o)) = store::get(&self.ctx.read_db(), "reports-settings")? {
            for (k, v) in o {
                s[k] = v;
            }
        }
        Ok(s)
    }

    fn state(&self) -> DbResult<Value> {
        Ok(match store::get(&self.ctx.read_db(), "reports-state")? {
            Some(v) if truthy(&v) => v,
            _ => json!({}),
        })
    }

    /// `patch` over the kept state (one that could not be read is never written over).
    fn set_state(&self, patch: Value) -> DbResult<()> {
        let mut s = self.state()?;
        if !s.is_object() {
            s = json!({});
        }
        for (k, v) in patch.as_object().unwrap() {
            s[k] = v.clone();
        }
        store::set(&self.ctx.db(), "reports-state", &s)
    }

    pub fn install_id(&self) -> DbResult<String> {
        let id = self.state()?["installId"].as_str().unwrap_or("").to_string();
        if id.len() == 32 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
            return Ok(id);
        }
        let id = rand_hex(16);
        self.set_state(json!({ "installId": id }))?;
        Ok(id)
    }

    /// For a timer: the state when sharing is on; None when it is off, and when manager.db
    /// cannot give them (nothing goes then; logged once until it can).
    fn shared(&self, what: &str) -> Option<Value> {
        let r = self.settings().and_then(|s| if truthy(&s["share"]) { self.state().map(Some) } else { Ok(None) });
        if let (true, Err(e)) = (self.unread.first(what, r.is_err()), &r) {
            self.ctx.log("reports", Level::Warn, &format!("Reports: the {what} waits until manager.db can be read: {e}"));
        }
        r.ok().flatten()
    }

    /// The install's signing key (or the anonymous one), made once, mode 600.
    fn signing_key(&self, anonymous: bool) -> SigningKey {
        ensure_dir(&self.dir);
        let file = self.dir.join(if anonymous { "anon-key.pem" } else { "install-key.pem" });
        if let Some(k) = fs::read_to_string(&file).ok().and_then(|t| key_from_pem(&t)) {
            return k;
        }
        let k = SigningKey::generate(&mut OsRng);
        let _ = write_private(&file, key_to_pem(&k).as_bytes());
        let _ = fs::set_permissions(&file, fs::Permissions::from_mode(0o600));
        k
    }

    pub fn endpoint(&self) -> DbResult<String> {
        if self.cfg.from_env_url {
            return Ok(self.cfg.endpoint.clone());
        }
        if let Some(u) = self.state()?["moved"]["url"].as_str().filter(|s| !s.is_empty()) {
            if let Ok(e) = check_endpoint(u, &self.env) {
                return Ok(e);
            }
        }
        Ok(self.cfg.endpoint.clone())
    }

    // ---- the outbox: sealed envelopes only

    pub fn outbox(&self) -> Vec<Value> {
        let Ok(rd) = fs::read_dir(&self.outbox_dir) else { return Vec::new() };
        let mut out = Vec::new();
        for e in rd.filter_map(|e| e.ok()) {
            let n = e.file_name().to_string_lossy().into_owned();
            let ok = n.len() == 29 && n.ends_with(".json") && n[..24].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
            if !ok {
                continue;
            }
            let file = self.outbox_dir.join(&n);
            match fs::read(&file).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).filter(|v| v.is_object()) {
                Some(mut v) => {
                    v["bytes"] = json!(fs::metadata(&file).map(|m| m.len()).unwrap_or(0));
                    out.push(v);
                }
                None => {
                    let _ = fs::remove_file(&file);
                }
            }
        }
        out.sort_by(|a, b| a["createdAt"].as_f64().unwrap_or(0.0).partial_cmp(&b["createdAt"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
        out
    }

    fn entry_file(&self, e: &Value) -> PathBuf {
        self.outbox_dir.join(format!("{}.json", e["id"].as_str().unwrap_or("")))
    }

    fn save_entry(&self, e: &Value) {
        ensure_dir(&self.outbox_dir);
        let mut keep = e.clone();
        if let Some(o) = keep.as_object_mut() {
            o.remove("file");
            o.remove("bytes");
        }
        let file = self.entry_file(e);
        let tmp = PathBuf::from(format!("{}.tmp", file.display()));
        if write_private(&tmp, keep.to_string().as_bytes()).is_ok() {
            let _ = fs::rename(&tmp, &file);
        }
    }

    fn drop_entry(&self, e: &Value) {
        let _ = fs::remove_file(self.entry_file(e));
    }

    /// The outbox within its caps: older than 7 days out; only the newest
    /// heartbeat; then, over 20 reports or 50 MB, that heartbeat first, then the oldest.
    pub fn trim_outbox(&self) -> Vec<Value> {
        let now = self.now();
        let old = |e: &Value| now - e["createdAt"].as_f64().unwrap_or(0.0) as i64 > OUTBOX_DAYS * DAY_MS;
        let mut list = self.outbox();
        for e in list.iter().filter(|e| old(e)) {
            self.drop_entry(e);
        }
        list.retain(|e| !old(e));
        let beats: Vec<usize> = list.iter().enumerate().filter(|(_, e)| e["kind"] == "heartbeat").map(|(i, _)| i).collect();
        if let Some((last, rest)) = beats.split_last() {
            for i in rest {
                self.drop_entry(&list[*i]);
            }
            let keep_id = list[*last]["id"].clone();
            list.retain(|e| e["kind"] != "heartbeat" || e["id"] == keep_id);
        }
        let mut bytes: u64 = list.iter().map(|e| e["bytes"].as_u64().unwrap_or(0)).sum();
        while list.len() > OUTBOX_MAX || bytes > OUTBOX_BYTES {
            let i = list.iter().position(|e| e["kind"] == "heartbeat").unwrap_or(0);
            let e = list.remove(i);
            bytes -= e["bytes"].as_u64().unwrap_or(0);
            self.drop_entry(&e);
        }
        list
    }

    fn keep_for_later(&self, e: &Value) {
        if !self.entry_file(e).exists() {
            return;
        }
        self.save_entry(e);
        if e["kind"] == "heartbeat" {
            self.trim_outbox();
        }
    }

    /// The outcome kept for the page (one not kept is logged once until one is).
    fn note_outcome(&self, e: &Value, sent: Option<&Value>, error: Option<&str>) {
        let r = self.keep_outcome(e, sent, error);
        if let (true, Err(err)) = (self.unread.first("outcome", r.is_err()), &r) {
            self.ctx.log("reports", Level::Warn, &format!("Reports: how a report went is not kept until manager.db can be written: {err}"));
        }
    }

    fn keep_outcome(&self, e: &Value, sent: Option<&Value>, error: Option<&str>) -> DbResult<()> {
        if e["kind"] == "heartbeat" {
            let prev = self.state()?["lastHeartbeat"].clone();
            let v = match sent {
                Some(s) => json!({ "at": s["at"], "error": null }),
                None => json!({ "at": if truthy(&prev["at"]) { prev["at"].clone() } else { Value::Null }, "error": error.map(|m| json!({ "at": self.now(), "message": m })) }),
            };
            return self.set_state(json!({ "lastHeartbeat": v }));
        }
        let Some(sent) = sent else {
            return self.set_state(json!({ "lastError": { "at": self.now(), "message": error } }));
        };
        let mut patch = json!({ "lastSent": sent, "lastError": null });
        let st = self.state()?;
        if truthy(&sent["ref"]) {
            let mut refs = vec![json!({ "at": sent["at"], "kind": e["kind"], "ref": sent["ref"], "anonymous": truthy(&e["anonymous"]) })];
            refs.extend(st["sentRefs"].as_array().cloned().unwrap_or_default());
            refs.truncate(SENT_REFS_KEPT);
            patch["sentRefs"] = json!(refs);
        } else if let Some(r) = st.get("sentRefs") {
            patch["sentRefs"] = r.clone();
        }
        self.set_state(patch)
    }

    fn transport(&self, method: &str, url: &str, body: Option<Vec<u8>>) -> Result<HttpRes, String> {
        let mut headers = vec![("User-Agent".to_string(), "sentry-six-manager-reports".to_string()), ("Accept".to_string(), "application/json".to_string())];
        if body.is_some() {
            headers.push(("Content-Type".into(), "application/json".into()));
        }
        self.transport.request(&HttpReq { method: method.into(), url: url.into(), headers, body, timeout_ms: TIMEOUT_MS, follow_redirects: false, max_body: 256 * 1024, too_much: "The receiver answered too much.".into() })
    }

    // ---- the receiver's settings (GET /v1/config), and a signed move

    /// Err: (message, retry)
    pub fn remote_config(&self, force: bool) -> Result<Value, String> {
        let ep = self.endpoint().map_err(|e| e.to_string())?;
        if !force {
            if let Some(r) = self.remote.lock().unwrap().as_ref() {
                if r.endpoint == ep && self.now() - r.at < CONFIG_TTL_MS {
                    return Ok(r.data.clone());
                }
            }
        }
        let res = self.transport("GET", &format!("{ep}/v1/config"), None)?;
        if res.status != 200 {
            return Err(format!("The receiver answered {} for its settings.", res.status));
        }
        let data = obj(&res.body);
        if !data["difficulty"].as_f64().is_some_and(|d| d.fract() == 0.0 && d >= 0.0) {
            return Err("The receiver sent no difficulty.".into());
        }
        if let Some(t) = data["time"].as_f64().filter(|t| t.is_finite()) {
            let off = t as i64 - self.now();
            *self.clock_offset.lock().unwrap() = if off.abs() > 60_000 { off } else { 0 };
        }
        if truthy(&data["moved"]) && !self.cfg.from_env_url {
            let prev_at = self.state().map_err(|e| e.to_string())?["moved"]["at"].as_f64();
            let signed = p::verify_moved(&data["moved"], &self.cfg.keys);
            if signed && !prev_at.is_some_and(|a| a >= data["moved"]["at"].as_f64().unwrap_or(f64::NAN)) {
                match check_endpoint(data["moved"]["url"].as_str().unwrap_or(""), &self.env) {
                    Ok(url) if url != ep => {
                        self.set_state(json!({ "moved": { "url": url, "at": data["moved"]["at"] } })).map_err(|e| e.to_string())?;
                        self.ctx.log("reports", Level::Warn, &format!("Reports: the receiver moved to {url} (signed by its key)"));
                        *self.remote.lock().unwrap() = None;
                        return self.remote_config(true);
                    }
                    Ok(_) => {}
                    Err(e) => self.ctx.log("reports", Level::Warn, &format!("Reports: a move notice was ignored: {e}")),
                }
            } else if !signed {
                self.ctx.log("reports", Level::Warn, "Reports: a move notice with no valid signature was ignored");
            }
        }
        *self.remote.lock().unwrap() = Some(Remote { endpoint: ep, at: self.now(), data: data.clone() });
        Ok(data)
    }

    /// One delivery attempt: { result: sent | retry | dropped, ... }.
    fn deliver(&self, e: &mut Value, again: bool) -> Result<Value, String> {
        let conf = self.remote_config(!again)?;
        let bits = conf["difficulty"].as_f64().unwrap_or(0.0);
        if bits > f64::from(MAX_BITS) {
            return Err(format!("The receiver asks for a proof of work of {bits} bits (more than {MAX_BITS})."));
        }
        let bits = bits as u32;
        let ts = self.now() + *self.clock_offset.lock().unwrap();
        let mut n = [0u8; 16];
        OsRng.fill_bytes(&mut n);
        let nonce = p::b64(&n);
        let env0 = e["env"].clone();
        let pow = self.pow.lock().unwrap().clone();
        let stamp = pow(&p::envelope_hash(&env0), &nonce, bits)?;
        // sharing turned off meanwhile: an automatic report does not go after all
        if auto_kind(e["kind"].as_str().unwrap_or("")) && !truthy(&self.settings().map_err(|e| e.to_string())?["share"]) {
            self.drop_entry(e);
            return Ok(json!({ "result": "dropped", "message": "Sharing is off." }));
        }
        let body = p::sign(&env0, &self.signing_key(truthy(&e["anonymous"])), ts, &nonce, &stamp, bits);
        let res = self.transport("POST", &format!("{}/v1/report", self.endpoint().map_err(|e| e.to_string())?), Some(body.to_string().into_bytes()))?;
        let d = obj(&res.body);
        if res.status == 202 && truthy(&d["ok"]) {
            self.drop_entry(e);
            let s20 = |v: &Value, n: usize| v.as_str().map(|s| json!(cut(s, n))).unwrap_or(Value::Null);
            let sent = json!({ "at": self.now(), "kind": e["kind"], "ref": s20(&d["ref"], 20), "id": s20(&d["id"], 40) });
            self.note_outcome(e, Some(&sent), None);
            if e["kind"] != "heartbeat" {
                let r = sent["ref"].as_str().map(|r| format!(" ({r})")).unwrap_or_default();
                self.ctx.log("reports", Level::Info, &format!("Reports: {} report sent{r}", e["kind"].as_str().unwrap_or("")));
            }
            let mut out = json!({ "result": "sent" });
            for (k, v) in sent.as_object().unwrap() {
                out[k] = v.clone();
            }
            return Ok(out);
        }
        if res.status == 400 && (d["code"] == "POW" || d["code"] == "TIME") && again {
            *self.remote.lock().unwrap() = None;
            if let Some(t) = d["time"].as_f64().filter(|t| t.is_finite()) {
                *self.clock_offset.lock().unwrap() = t as i64 - self.now();
            }
            return self.deliver(e, false);
        }
        if res.status == 429 || res.status >= 500 || res.status == 408 {
            let ra = res.header("retry-after").map(super::js::number_str).filter(|x| x.is_finite() && *x != 0.0);
            let rd = Some(super::js::number(&d["retryAfter"])).filter(|x| x.is_finite() && *x != 0.0 && !d["retryAfter"].is_null());
            let wait = ra.or(rd).unwrap_or(0.0).clamp(60.0, 6.0 * 3600.0);
            let attempts = e["attempts"].as_i64().unwrap_or(0) + 1;
            e["attempts"] = json!(attempts);
            e["nextAt"] = json!(self.now() + ((wait * 1000.0) as i64).max(backoff(attempts)));
            self.keep_for_later(e);
            let msg = if res.status == 429 { "The receiver is busy (too many reports): it will be tried again later.".to_string() } else { format!("The receiver answered {}: it will be tried again later.", res.status) };
            self.note_outcome(e, None, Some(&msg));
            return Ok(json!({ "result": "retry", "status": res.status, "message": msg }));
        }
        self.drop_entry(e);
        let detail = if truthy(&d["error"]) { format!(": {}", cut(&super::js::to_string(&d["error"]), 160)) } else { String::new() };
        let msg = format!("The receiver refused the report ({}{detail}).", res.status);
        self.note_outcome(e, None, Some(&msg));
        self.ctx.log("reports", Level::Warn, &format!("Reports: {msg}"));
        Ok(json!({ "result": "dropped", "status": res.status, "message": msg }))
    }

    fn attempt(&self, e: &mut Value) -> Value {
        match self.deliver(e, true) {
            Ok(v) => v,
            Err(m) => {
                let attempts = e["attempts"].as_i64().unwrap_or(0) + 1;
                e["attempts"] = json!(attempts);
                e["nextAt"] = json!(self.now() + backoff(attempts));
                self.keep_for_later(e);
                let msg = format!("Could not reach the receiver ({}): it will be tried again later.", cut(&m, 160));
                self.note_outcome(e, None, Some(&msg));
                json!({ "result": "retry", "message": msg })
            }
        }
    }

    /// Every waiting report that is due (one pass at a time).
    pub fn flush(&self, all: bool) -> Vec<Value> {
        if !self.configured {
            return Vec::new();
        }
        let _one = self.flushing.lock().unwrap();
        // (sharing not known now: what waits stays for later; logged once until it can be read)
        let settings = self.settings();
        if let (true, Err(e)) = (self.unread.first("flush", settings.is_err()), &settings) {
            self.ctx.log("reports", Level::Warn, &format!("Reports: what waits to be sent stays until manager.db can be read: {e}"));
        }
        let Ok(settings) = settings else { return Vec::new() };
        let mut out = Vec::new();
        for mut e in self.trim_outbox() {
            if auto_kind(e["kind"].as_str().unwrap_or("")) && !truthy(&settings["share"]) {
                self.drop_entry(&e);
                continue;
            }
            if !all && e["nextAt"].as_f64().unwrap_or(0.0) as i64 > self.now() {
                continue;
            }
            out.push(self.attempt(&mut e));
        }
        out
    }

    // ---- building a report

    fn build_block(&self) -> Value {
        let b = &self.build_info;
        let sha = b["sha"].as_str().filter(|s| (7..=64).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
        let st = |v: &Value, n: usize| v.as_str().filter(|s| !s.is_empty()).map(|s| json!(cut(s, n))).unwrap_or(Value::Null);
        let build = b["build"].as_f64().filter(|n| n.fract() == 0.0 && *n > 0.0 && *n <= 9_007_199_254_740_991.0).map(|n| json!(n as i64)).unwrap_or(Value::Null);
        json!({ "build": build, "sha": sha, "builtAt": st(&b["builtAt"], 40), "tag": st(&b["tag"], 120) })
    }

    fn identifiers(&self) -> Result<Vec<String>, ReportError> {
        let mut ids = vec![self.install_id()?];
        let more = match self.sources.get() {
            Some(s) => (s.identifiers)(),
            None => self.ctx.identifiers(),
        };
        // (no anonymous report without all of what it must leave out)
        ids.extend(more.map_err(|e| err(500, format!("What an anonymous report leaves out could not be read: {e}")))?);
        Ok(ids)
    }

    /// Where diagnostics, the heartbeat and the identifiers come from (once).
    pub fn set_sources(&self, s: Sources) {
        let _ = self.sources.set(s);
    }

    fn diagnostics_of(&self, kind: &str) -> Value {
        let hook = self.ctx.diagnostics(kind);
        match (self.sources.get(), hook.is_null()) {
            (Some(s), true) => (s.diagnostics)(kind),
            (_, false) => hook,
            (None, true) => json!({}),
        }
    }

    fn heartbeat_of(&self) -> Result<Value, String> {
        let hook = self.ctx.heartbeat();
        match (self.sources.get(), hook.is_null()) {
            (Some(s), true) => (s.heartbeat)(),
            (_, false) => Ok(hook),
            (None, true) => Ok(json!({})),
        }
    }

    /// The payload exactly as it would be sealed (cleaned, checked).
    pub fn build_payload(&self, kind: &str, message: Option<&Value>, contact: Option<&Value>, attach: bool, crash: Option<Value>) -> Result<Value, ReportError> {
        if !self.configured {
            return Err(self.not_set_up());
        }
        // (not read: no report, never one that is not anonymous when it should be)
        let anonymous = truthy(&self.settings()?["anonymous"]);
        let install = if anonymous { p::ANON.to_string() } else { self.install_id()? };
        let ui = self.ctx.ui_pack();
        let mut pl = json!({
            "kind": kind, "sentAt": iso(self.now()), "install": install, "anonymous": anonymous,
            "build": self.build_block(), "ui": cut(if ui.is_empty() { "original" } else { &ui }, p::LIMIT_UI)
        });
        if kind == "feedback" {
            let m = text_of(message);
            if m.is_empty() {
                return Err(err(400, "Write a message first."));
            }
            if utf16_len(&m) > p::LIMIT_MESSAGE {
                return Err(err(400, format!("The message is longer than {} characters.", p::LIMIT_MESSAGE)));
            }
            pl["message"] = json!(m);
            let c = text_of(contact);
            if utf16_len(&c) > p::LIMIT_CONTACT {
                return Err(err(400, format!("The contact is longer than {} characters.", p::LIMIT_CONTACT)));
            }
            if !c.is_empty() && !anonymous {
                pl["contact"] = json!(c);
            }
        } else if kind == "support" {
            let m = text_of(message);
            if utf16_len(&m) > p::LIMIT_NOTE {
                return Err(err(400, format!("The note is longer than {} characters.", p::LIMIT_NOTE)));
            }
            if !m.is_empty() {
                pl["message"] = json!(m);
            }
        }
        if let Some(c) = crash {
            pl["crash"] = c;
        }
        if kind == "heartbeat" {
            let mut raw = match self.heartbeat_of().map_err(|e| err(500, format!("The heartbeat could not be made: {e}")))? {
                Value::Object(o) => Value::Object(o),
                _ => json!({}),
            };
            let mut text = Map::new();
            for k in HEARTBEAT_TEXT {
                if let Some(v) = raw.get(k) {
                    text.insert(k.to_string(), v.clone());
                }
            }
            let cleaned = scrub::clean_report(&Value::Object(text), true, &self.identifiers()?);
            for (k, v) in cleaned.as_object().unwrap() {
                raw[k] = v.clone();
            }
            raw["crashes24h"] = json!(self.crashes_24h());
            pl["heartbeat"] = normalize_heartbeat(&raw);
            let errs = p::validate_payload(&pl);
            if !errs.is_empty() {
                return Err(err(500, format!("The heartbeat did not come out right: {}", errs.iter().take(3).cloned().collect::<Vec<_>>().join(", "))));
            }
            return Ok(pl);
        }
        if kind != "feedback" || attach {
            pl["diagnostics"] = self.diagnostics_of(kind);
        }
        let ids = if anonymous { self.identifiers()? } else { Vec::new() };
        for k in ["message", "crash", "diagnostics"] {
            if pl.get(k).is_some() {
                pl[k] = scrub::clean_report(&pl[k], anonymous, &ids);
            }
        }
        if pl.get("crash").is_some() {
            let s = |v: &Value, def: &str| if v.is_null() { def.to_string() } else { super::js::to_string(v) };
            pl["crash"]["message"] = json!(cut(&s(&pl["crash"]["message"], ""), p::LIMIT_CRASH_MESSAGE));
            pl["crash"]["stack"] = json!(cut(&s(&pl["crash"]["stack"], ""), p::LIMIT_CRASH_STACK));
            pl["crash"]["name"] = json!(cut(&s(&pl["crash"]["name"], "Error"), 120));
        }
        if kind == "feedback" && pl["message"].as_str().is_some_and(|m| m.trim().is_empty()) {
            pl["message"] = json!(p::ANON);
        }
        let errs = p::validate_payload(&pl);
        if !errs.is_empty() {
            return Err(err(500, format!("The report did not come out right: {}", errs.iter().take(3).cloned().collect::<Vec<_>>().join(", "))));
        }
        Ok(pl)
    }

    /// Seals a payload into the outbox and tries it now.
    pub fn enqueue(&self, payload: &Value) -> Result<Value, ReportError> {
        let key = &self.cfg.keys[0];
        let env = p::seal(payload, &key.public_key).map_err(|m| err(500, m))?;
        let mut e = json!({ "id": rand_hex(12), "kind": payload["kind"], "anonymous": payload["anonymous"], "createdAt": self.now(), "attempts": 0, "nextAt": self.now(), "env": env });
        if e["env"].to_string().len() > p::MAX_BODY - 4096 {
            return Err(err(413, "This report is too large to send."));
        }
        self.save_entry(&e);
        self.trim_outbox();
        Ok(self.attempt(&mut e))
    }

    fn take_manual(&self, kind: &str) -> Result<(), ReportError> {
        let t = self.now();
        let mut all = self.state()?["manual"].clone();
        if !all.is_object() {
            all = json!({});
        }
        let mut list: Vec<i64> = all[kind].as_array().map(|a| a.iter().filter_map(|x| x.as_f64().map(|f| f as i64)).filter(|x| t - x < 3_600_000).collect()).unwrap_or_default();
        if list.len() >= MANUAL_PER_HOUR {
            let wait = ((list[0] + 3_600_000 - t) as f64 / 60_000.0).ceil() as i64;
            return Err(err(429, format!("That is {MANUAL_PER_HOUR} in the last hour already. Try again in {wait} minute{}.", if wait == 1 { "" } else { "s" })));
        }
        list.push(t);
        all[kind] = json!(list);
        // (a send that cannot be counted does not go)
        self.set_state(json!({ "manual": all }))?;
        Ok(())
    }

    // ---- crashes and unhandled errors (kept locally; sent only when sharing is on)

    fn read_crashes(&self) -> Vec<Value> {
        fs::read(&self.crash_file).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v.as_array().cloned()).unwrap_or_default()
    }

    fn crash_at(c: &Value) -> Option<i64> {
        c["at"].as_str().and_then(super::js::parse_date)
    }

    /// Notes a crash or an unhandled error (a 500 from a route: source "error").
    pub fn note_crash(self: &Arc<Self>, name: &str, message: &str, stack: &str, source: &str) {
        let now = self.now();
        ensure_dir(&self.dir);
        let mut list: Vec<Value> = self.read_crashes().into_iter().filter(|c| Self::crash_at(c).is_some_and(|a| now - a < OUTBOX_DAYS * DAY_MS)).collect();
        if list.len() > 19 {
            list.drain(..list.len() - 19);
        }
        list.push(json!({ "at": iso(now), "name": cut(if name.is_empty() { "Error" } else { name }, 120), "message": cut(message, p::LIMIT_CRASH_MESSAGE), "stack": cut(stack, p::LIMIT_CRASH_STACK), "source": source, "sent": false }));
        let tmp = PathBuf::from(format!("{}.tmp", self.crash_file.display()));
        if write_private(&tmp, Value::Array(list).to_string().as_bytes()).is_ok() {
            let _ = fs::rename(&tmp, &self.crash_file);
        }
        if source == "error" {
            let me = Arc::clone(self);
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
                me.send_crashes();
            });
        }
    }

    fn crashes_24h(&self) -> usize {
        let now = self.now();
        self.read_crashes().iter().filter(|c| Self::crash_at(c).is_some_and(|a| now - a < DAY_MS)).count()
    }

    /// The newest 5 crashes, for diagnostics.
    pub fn recent_crashes(&self) -> Vec<Value> {
        let list = self.read_crashes();
        list[list.len().saturating_sub(5)..]
            .iter()
            .map(|c| {
                let mut c = c.clone();
                if let Some(o) = c.as_object_mut() {
                    o.remove("sent");
                }
                c
            })
            .collect()
    }

    /// Sends what was noted and not sent yet: at most one report an hour for the same error, 6 a day.
    pub fn send_crashes(&self) -> Vec<Value> {
        if !self.configured {
            return Vec::new();
        }
        let Some(state) = self.shared("crash report") else { return Vec::new() };
        let now = self.now();
        let mut list = self.read_crashes();
        let mut sent_log: Vec<Value> = state["crashSent"].as_array().cloned().unwrap_or_default().into_iter().filter(|x| now - x["at"].as_f64().unwrap_or(0.0) as i64 > -1 && now - (x["at"].as_f64().unwrap_or(0.0) as i64) < DAY_MS).collect();
        let mut out = Vec::new();
        for c in list.iter_mut() {
            if truthy(&c["sent"]) {
                continue;
            }
            c["sent"] = json!(true);
            let s = |k: &str| super::js::to_string(&c[k]);
            let stack3 = s("stack").split('\n').take(3).collect::<Vec<_>>().join("|");
            let sig = p::sha256(&[format!("{}|{}|{stack3}", s("name"), s("message")).as_bytes()]).iter().map(|b| format!("{b:02x}")).collect::<String>()[..16].to_string();
            if sent_log.len() >= 6 || sent_log.iter().any(|x| x["sig"] == sig && now - (x["at"].as_f64().unwrap_or(0.0) as i64) < 3_600_000) {
                continue;
            }
            sent_log.push(json!({ "sig": sig, "at": now }));
            let crash = json!({ "at": c["at"], "name": c["name"], "message": c["message"], "stack": c["stack"], "source": if c["source"] == "error" { "error" } else { "crash" } });
            match self.build_payload("crash", None, None, true, Some(crash)).and_then(|pl| self.enqueue(&pl)) {
                Ok(r) => out.push(r),
                Err(e) => self.ctx.log("reports", Level::Warn, &format!("Reports: the crash report was not made: {}", e.message)),
            }
        }
        let _ = write_private(&self.crash_file, Value::Array(list).to_string().as_bytes());
        if let Err(e) = self.set_state(json!({ "crashSent": sent_log })) {
            self.ctx.log("reports", Level::Warn, &format!("Reports: the crash reports sent were not counted: {e}"));
        }
        out
    }

    pub fn daily_if_due(&self) -> Option<Value> {
        if !self.configured {
            return None;
        }
        let state = self.shared("daily summary")?;
        let last = state["lastDailyAt"].as_f64().unwrap_or(0.0) as i64;
        if self.now() - last < DAY_MS - 60_000 {
            return None;
        }
        // (one that cannot be noted is not sent: it would go again every hour)
        if let Err(e) = self.set_state(json!({ "lastDailyAt": self.now() })) {
            self.ctx.log("reports", Level::Warn, &format!("Reports: the daily summary waits, its time was not kept: {e}"));
            return None;
        }
        match self.build_payload("daily", None, None, true, None).and_then(|pl| self.enqueue(&pl)) {
            Ok(r) => Some(r),
            Err(e) => {
                self.ctx.log("reports", Level::Warn, &format!("Reports: the daily summary was not made: {}", e.message));
                None
            }
        }
    }

    /// Sends one heartbeat now when sharing is on; the one still waiting is replaced.
    pub fn send_heartbeat(&self) -> Option<Value> {
        if !self.configured {
            return None;
        }
        self.shared("heartbeat")?;
        let payload = match self.build_payload("heartbeat", None, None, true, None) {
            Ok(p) => p,
            Err(e) => {
                self.ctx.log("reports", Level::Warn, &format!("Reports: the heartbeat was not made: {}", e.message));
                return None;
            }
        };
        if !self.settings().is_ok_and(|s| truthy(&s["share"])) {
            return None;
        }
        for e in self.outbox() {
            if e["kind"] == "heartbeat" {
                self.drop_entry(&e);
            }
        }
        self.enqueue(&payload).ok()
    }

    fn schedule_heartbeat(&self, ms: i64) {
        self.sched.lock().unwrap().hb_next_at = Some(self.now() + ms);
    }

    // ---- what the routes call

    pub fn status(&self) -> Result<Value, ReportError> {
        let list = if self.configured { self.outbox() } else { Vec::new() };
        let s = self.state()?;
        let settings = self.settings()?;
        let endpoint = if self.configured { json!(self.endpoint()?) } else { Value::Null };
        let install = self.install_id()?;
        let sched = self.sched.lock().unwrap();
        let or_null = |k: &str| if truthy(&s[k]) { s[k].clone() } else { Value::Null };
        Ok(json!({
            "configured": self.configured,
            "notSetUpText": if self.configured { Value::Null } else { json!(self.off_text) },
            "endpoint": endpoint,
            "kid": self.cfg.keys.first().map(|k| k.kid.clone()),
            "settings": settings,
            "lastSent": or_null("lastSent"),
            "lastError": or_null("lastError"),
            "lastHeartbeat": or_null("lastHeartbeat"),
            "nextHeartbeatAt": if self.configured && truthy(&settings["share"]) && sched.started { json!(sched.hb_next_at) } else { Value::Null },
            "outbox": { "count": list.len(), "bytes": list.iter().map(|e| e["bytes"].as_u64().unwrap_or(0)).sum::<u64>() },
            "manualPerHour": MANUAL_PER_HOUR,
            "installCode": install[..8],
            "sentRefs": s["sentRefs"].as_array().cloned().unwrap_or_default()
        }))
    }

    /// PUT /api/reports/settings: (before, after).
    pub fn set_settings(self: &Arc<Self>, patch: &Value) -> Result<(Value, Value), ReportError> {
        if !self.configured {
            return Err(self.not_set_up());
        }
        let before = self.settings()?;
        let mut next = before.clone();
        for k in ["share", "anonymous"] {
            match patch.get(k) {
                None => continue,
                Some(Value::Bool(b)) => next[k] = json!(b),
                Some(_) => return Err(err(400, format!("{k} is on or off."))),
            }
        }
        next["changedAt"] = json!(self.now());
        let turned_on = !truthy(&before["share"]) && truthy(&next["share"]);
        // (the daily summary's clock first: a write that fails then leaves sharing off)
        if turned_on {
            self.set_state(json!({ "lastDailyAt": self.now() }))?;
        }
        store::set(&self.ctx.db(), "reports-settings", &next)?;
        if truthy(&before["share"]) && !truthy(&next["share"]) {
            for e in self.outbox() {
                if auto_kind(e["kind"].as_str().unwrap_or("")) {
                    self.drop_entry(&e);
                }
            }
        }
        if turned_on {
            if self.sched.lock().unwrap().started {
                self.schedule_heartbeat(HEARTBEAT_EVERY_MS + jitter(HEARTBEAT_JITTER_MS));
                let me = Arc::clone(self);
                std::thread::spawn(move || {
                    me.send_heartbeat();
                    me.flush(false);
                });
            }
        }
        Ok((before, next))
    }

    pub fn preview(&self, body: &Value) -> Result<Value, ReportError> {
        if body["kind"] == "heartbeat" {
            return Ok(json!({ "previewId": null, "sample": true, "payload": self.build_payload("heartbeat", None, None, true, None)? }));
        }
        let kind = if body["kind"] == "support" { "support" } else { "feedback" };
        let payload = self.build_payload(kind, body.get("message"), body.get("contact"), body["attach"] != json!(false), None)?;
        let now = self.now();
        let mut pv = self.previews.lock().unwrap();
        pv.retain(|(_, v)| v.until >= now);
        while pv.len() >= 10 {
            pv.remove(0);
        }
        let id = rand_hex(12);
        pv.push((id.clone(), Preview { payload: payload.clone(), until: now + 10 * 60_000 }));
        Ok(json!({ "previewId": id, "payload": payload }))
    }

    /// Sends exactly what a preview showed.
    pub fn send_preview(&self, preview_id: &Value) -> Result<Value, ReportError> {
        if !self.configured {
            return Err(self.not_set_up());
        }
        let id = if preview_id.is_null() { String::new() } else { super::js::to_string(preview_id) };
        let payload = {
            let pv = self.previews.lock().unwrap();
            match pv.iter().find(|(k, _)| *k == id) {
                Some((_, p)) if p.until >= self.now() => p.payload.clone(),
                _ => return Err(err(409, "The preview is too old: look at what will be sent again.")),
            }
        };
        if payload["anonymous"].as_bool() != Some(truthy(&self.settings()?["anonymous"])) {
            return Err(err(409, "\"Send anonymously\" changed since the preview: look at what will be sent again."));
        }
        self.take_manual(payload["kind"].as_str().unwrap_or(""))?;
        self.previews.lock().unwrap().retain(|(k, _)| *k != id);
        let r = self.enqueue(&payload)?;
        let mut out = json!({ "kind": payload["kind"] });
        for (k, v) in r.as_object().unwrap() {
            out[k] = v.clone();
        }
        Ok(out)
    }

    /// The timers: flush every minute, the daily summary hourly, crashes and
    /// the daily one 90 s after the start, the heartbeat 10 to 60 s after the
    /// start and then hourly (ticks with sharing off send nothing).
    pub fn start(self: &Arc<Self>) {
        if !self.configured {
            return;
        }
        {
            let mut s = self.sched.lock().unwrap();
            if s.started {
                return;
            }
            s.started = true;
        }
        self.schedule_heartbeat(HEARTBEAT_FIRST_MS + jitter(HEARTBEAT_FIRST_JITTER_MS));
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            let begun = me.now();
            let (mut next_flush, mut next_daily, mut first_done) = (begun + 60_000, begun + 3_600_000, false);
            loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
                if !me.sched.lock().unwrap().started {
                    return;
                }
                let now = me.now();
                if !first_done && now - begun >= 90_000 {
                    first_done = true;
                    me.send_crashes();
                    me.daily_if_due();
                }
                if now >= next_flush {
                    next_flush = now + 60_000;
                    me.flush(false);
                }
                if now >= next_daily {
                    next_daily = now + 3_600_000;
                    me.daily_if_due();
                }
                let due = me.sched.lock().unwrap().hb_next_at.is_some_and(|t| now >= t);
                if due {
                    me.sched.lock().unwrap().hb_next_at = None;
                    me.send_heartbeat();
                    if me.sched.lock().unwrap().hb_next_at.is_none() {
                        me.schedule_heartbeat(HEARTBEAT_EVERY_MS + jitter(HEARTBEAT_JITTER_MS));
                    }
                }
            }
        });
    }

    pub fn stop(&self) {
        let mut s = self.sched.lock().unwrap();
        s.started = false;
        s.hb_next_at = None;
    }
}

// ---- the heartbeat block (reports.js normalizeHeartbeat)

const HEARTBEAT_TEXT: [&str; 7] = ["platform", "arch", "cpu", "gpus", "cars", "convert", "nodes"];

/// Text as the protocol takes it: accents off, only printable ASCII without
/// " and \, single spaces, at most `max` characters, trimmed.
pub fn plain_text(x: &Value, max: usize) -> Value {
    use unicode_normalization::UnicodeNormalization;
    let Some(s) = x.as_str() else { return Value::Null };
    let n: String = s.nfkd().collect();
    let spaced: String = n.split(|c: char| c.is_whitespace() || c == '\u{feff}').collect::<Vec<_>>().join(" ");
    let mut kept: String = spaced.chars().filter(|c| matches!(*c as u32, 0x20 | 0x21 | 0x23..=0x5b | 0x5d..=0x7e)).collect();
    while kept.contains("  ") {
        kept = kept.replace("  ", " ");
    }
    let t: String = kept.trim().chars().take(max).collect::<String>().trim().to_string();
    if t.is_empty() {
        Value::Null
    } else {
        json!(t)
    }
}

fn model_name(x: &Value) -> Value {
    let s = x.as_str().map(str::trim).unwrap_or("");
    const CODES: [(&str, &str); 4] = [("3", "Model 3"), ("Y", "Model Y"), ("S", "Model S"), ("X", "Model X")];
    if let Some((_, n)) = CODES.iter().find(|(c, _)| *c == s) {
        return json!(n);
    }
    ["Model 3", "Model Y", "Model S", "Model X", "Cybertruck"].iter().find(|m| m.to_lowercase() == s.to_lowercase()).map_or(Value::Null, |m| json!(m))
}

fn firmware_text(x: &Value) -> Value {
    let t = plain_text(x, 24);
    let Some(s) = t.as_str() else { return Value::Null };
    let (ver, hash) = match s.split_once(' ') {
        Some((v, h)) => (v, Some(h)),
        None => (s, None),
    };
    let parts: Vec<&str> = ver.split('.').collect();
    let ok_ver = parts.len() >= 2
        && parts.len() <= 5
        && parts[0].len() == 4
        && parts[0].starts_with("20")
        && parts[0].bytes().all(|c| c.is_ascii_digit())
        && (1..=2).contains(&parts[1].len())
        && parts[1].bytes().all(|c| c.is_ascii_digit())
        && parts[2..].iter().all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|c| c.is_ascii_digit()));
    let ok_hash = hash.is_none_or(|h| (4..=12).contains(&h.len()) && h.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
    if ok_ver && ok_hash {
        t
    } else {
        Value::Null
    }
}

fn number(v: &Value) -> f64 {
    super::js::number(v)
}

/// Number(x) > 0 ? min(max, round(x)) : 0 (undefined is NaN, null is 0).
fn n(x: Option<&Value>, max: f64) -> Value {
    let f = match x {
        None => f64::NAN,
        Some(v) => number(v),
    };
    if f.is_finite() && f > 0.0 {
        super::js::num(f.round().min(max))
    } else {
        json!(0)
    }
}

fn get<'a>(v: &'a Value, k: &str) -> Option<&'a Value> {
    v.as_object().and_then(|o| o.get(k))
}

fn convert_block(v: Option<&Value>, device_max: usize) -> Value {
    let empty = json!({});
    let c = v.filter(|x| x.is_object()).unwrap_or(&empty);
    let fps_raw = get(c, "fps");
    let fps = fps_raw.map(number).unwrap_or(f64::NAN);
    let fps_v = match fps_raw {
        Some(x) if !x.is_null() && fps.is_finite() && fps >= 0.0 => super::js::num((fps.min(100_000.0) * 10.0).round() / 10.0),
        _ => Value::Null,
    };
    let t = |k: &str, max: usize| get(c, k).map_or(Value::Null, |x| plain_text(x, max));
    json!({ "fps": fps_v, "encoder": t("encoder", 40), "device": t("device", device_max), "api": t("api", 12), "codec": t("codec", 10) })
}

/// The heartbeat block, exactly the protocol's fields from what the server counted.
pub fn normalize_heartbeat(h: &Value) -> Value {
    let max = 9_007_199_254_740_991.0;
    let health = get(h, "health");
    let warnings = n(health.and_then(|x| get(x, "warnings")), 1000.0);
    let problems = n(health.and_then(|x| get(x, "problems")), 1000.0);
    let fin = |k: &str| get(h, k).and_then(Value::as_f64).filter(|x| x.is_finite());
    let known = fin("freeBytes").is_some() && fin("totalBytes").is_some_and(|t| t > 0.0);
    let total = if known { n(get(h, "totalBytes"), max) } else { Value::Null };
    let free = if known { super::js::num(n(get(h, "freeBytes"), max).as_f64().unwrap().min(total.as_f64().unwrap())) } else { Value::Null };
    let dist = get(h, "distanceKm").map(number).unwrap_or(f64::NAN);
    let feat = get(h, "features");
    let fb = |k: &str| feat.and_then(|f| get(f, k)) == Some(&json!(true));
    let mut out = json!({
        "uptimeSec": n(get(h, "uptimeSec"), 100.0 * 365.0 * 86400.0),
        "health": { "overall": p::health_overall(warnings.as_u64().unwrap(), problems.as_u64().unwrap()), "warnings": warnings, "problems": problems },
        "vehicles": n(get(h, "vehicles"), 1000.0),
        "footageBytes": n(get(h, "footageBytes"), max),
        "recordings": n(get(h, "recordings"), 1e9),
        "spaceSavedBytes": n(get(h, "spaceSavedBytes"), max),
        "distanceKm": if dist.is_finite() && dist > 0.0 { super::js::num((dist.min(10_000_000.0) * 10.0).round() / 10.0) } else { json!(0) },
        "freeBytes": free,
        "totalBytes": total,
        "converting": get(h, "converting") == Some(&json!(true)),
        "jobsQueued": n(get(h, "jobsQueued"), 100_000.0),
        "features": { "can": fb("can"), "sentryUsbPaired": fb("sentryUsbPaired"), "gpu": fb("gpu") }
    });
    let o = out.as_object_mut().unwrap();
    o.insert("footageSeconds".into(), n(get(h, "footageSeconds"), 1e12));
    let platform = get(h, "platform").map_or(Value::Null, |x| plain_text(x, 32));
    let arch = get(h, "arch").map_or(Value::Null, |x| plain_text(x, 16));
    if !platform.is_null() {
        o.insert("platform".into(), platform);
    }
    if !arch.is_null() {
        o.insert("arch".into(), arch);
    }
    o.insert("cpu".into(), get(h, "cpu").map_or(Value::Null, |x| plain_text(x, 120)));
    let arr = |v: Option<&Value>| v.and_then(Value::as_array).cloned().unwrap_or_default();
    o.insert("gpus".into(), json!(arr(get(h, "gpus")).iter().map(|g| plain_text(g, 80)).filter(|g| !g.is_null()).take(4).collect::<Vec<_>>()));
    o.insert(
        "cars".into(),
        json!(arr(get(h, "cars")).iter().take(12).map(|c| json!({ "model": get(c, "model").map_or(Value::Null, model_name), "firmware": get(c, "firmware").map_or(Value::Null, firmware_text) })).collect::<Vec<_>>()),
    );
    let clips = get(h, "clips24h");
    o.insert("clips24h".into(), json!({ "sentry": n(clips.and_then(|c| get(c, "sentry")), 1e6), "dashcam": n(clips.and_then(|c| get(c, "dashcam")), 1e6) }));
    o.insert("convert".into(), convert_block(get(h, "convert"), 120));
    o.insert(
        "nodes".into(),
        json!(arr(get(h, "nodes"))
            .iter()
            .take(8)
            .map(|x| json!({
                "cpu": get(x, "cpu").map_or(Value::Null, |c| plain_text(c, 60)),
                "gpus": arr(get(x, "gpus")).iter().map(|g| plain_text(g, 60)).filter(|g| !g.is_null()).take(4).collect::<Vec<_>>(),
                "convert": convert_block(get(x, "convert"), 60)
            }))
            .collect::<Vec<_>>()),
    );
    o.insert("crashes24h".into(), n(get(h, "crashes24h"), 10_000.0));
    if let Some(host) = get(h, "host").filter(|x| x.is_object()) {
        let os = get(host, "os").and_then(Value::as_str).filter(|s| p::HOST_OS.contains(s));
        o.insert("host".into(), json!({ "os": os, "docker": get(host, "docker") == Some(&json!(true)) }));
    }
    out
}

/// A transport that refuses everything: for a server with reporting off, and the tests.
pub struct NoNetwork;

impl Transport for NoNetwork {
    fn request(&self, _r: &HttpReq) -> Result<HttpRes, String> {
        Err("no network in this build".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::testing::FakeCtx;
    use std::sync::Mutex as M;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    /// Counts every request and answers none: proves nothing goes out.
    struct Counting(M<Vec<String>>);
    impl Transport for Counting {
        fn request(&self, r: &HttpReq) -> Result<HttpRes, String> {
            self.0.lock().unwrap().push(format!("{} {}", r.method, r.url));
            Err("ECONNREFUSED".into())
        }
    }

    fn key_line() -> String {
        let mut sk = [0u8; 32];
        OsRng.fill_bytes(&mut sk);
        let s = x25519_dalek::StaticSecret::from(sk);
        format!("sr1:{}", p::b64(x25519_dalek::PublicKey::from(&s).as_bytes()))
    }

    #[test]
    fn this_build_has_the_receiver_key_for_reports_skittles_live() {
        let c = reports_config(&HashMap::new());
        assert_eq!(c.endpoint, "https://reports.skittles.live");
        assert_eq!(c.keys[0].kid, "208993f9bb2c38d1");
        assert_eq!(c.error, None);
    }

    #[test]
    fn endpoints_https_only_http_only_to_localhost_in_tests() {
        let t = env(&[("NODE_ENV", "test")]);
        assert_eq!(check_endpoint("https://reports.example.org/", &HashMap::new()).unwrap(), "https://reports.example.org");
        assert_eq!(check_endpoint("https://Reports.Example.org:443/x//", &HashMap::new()).unwrap(), "https://reports.example.org/x");
        assert_eq!(check_endpoint("http://127.0.0.1:1234", &t).unwrap(), "http://127.0.0.1:1234");
        assert!(check_endpoint("http://127.0.0.1:1234", &HashMap::new()).unwrap_err().contains("must be https"));
        assert!(check_endpoint("http://evil.example.org", &t).unwrap_err().contains("must be https"));
        assert!(check_endpoint("https://u:p@x.example.org", &t).unwrap_err().contains("no user name"));
        assert!(check_endpoint("https://x.example.org/?a=1", &t).unwrap_err().contains("no user name"));
        assert!(check_endpoint("nope", &t).unwrap_err().contains("not an address"));
        let c = reports_config(&env(&[("REPORTS_URL", "http://evil.example.org")]));
        assert!(c.keys.is_empty() && c.error.is_some(), "a bad address turns reporting off");
    }

    #[test]
    fn reports_off_nothing_is_built_or_sent() {
        let ctx = FakeCtx::new();
        let t = Arc::new(Counting(M::new(Vec::new())));
        let rep = Reports::new(ctx, env(&[("REPORTS", "off")]), json!({}), t.clone(), None);
        let s = rep.status().unwrap();
        assert_eq!(s["configured"], false);
        assert_eq!(s["notSetUpText"], "Reporting is turned off on this server (REPORTS=off).");
        assert!(rep.preview(&json!({ "kind": "feedback", "message": "x" })).unwrap_err().message.contains("turned off"));
        assert_eq!(rep.set_settings(&json!({ "share": true })).unwrap_err().code, Some("NOT_SET_UP"));
        rep.note_crash("Error", "x", "", "crash");
        assert!(rep.send_crashes().is_empty());
        assert!(rep.flush(true).is_empty());
        assert!(t.0.lock().unwrap().is_empty());
    }

    #[test]
    fn opt_in_off_crashes_and_daily_summaries_make_no_network_call() {
        let ctx = FakeCtx::new();
        let t = Arc::new(Counting(M::new(Vec::new())));
        let rep = Reports::new(ctx.clone(), env(&[("REPORTS_PUBLIC_KEY", &key_line())]), json!({}), t.clone(), None);
        rep.note_crash("TypeError", "boom at 192.168.1.4", "", "crash");
        assert!(rep.send_crashes().is_empty());
        assert_eq!(rep.daily_if_due(), None);
        assert!(rep.send_heartbeat().is_none());
        rep.flush(true);
        assert!(t.0.lock().unwrap().is_empty(), "nothing went out");
        assert_eq!(rep.recent_crashes().len(), 1);
        let mode = fs::metadata(ctx.data.join("reports/crashes.json")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn previews_clean_the_report_and_anonymous_drops_identifiers() {
        let ctx = FakeCtx::new();
        *ctx.diagnostics.lock().unwrap() = json!({ "system": { "hostname": "tower", "os": "Debian", "ip": "192.168.1.9", "note": "smb password=hunter2 from 192.168.1.9" }, "logs": ["WARN share //nas/TeslaCam (Daily Driver) gone at 10.0.0.2"] });
        *ctx.identifiers.lock().unwrap() = vec!["tower".into(), "Daily Driver".into(), "nas".into()];
        let t = Arc::new(Counting(M::new(Vec::new())));
        let rep = Reports::new(ctx.clone(), env(&[("REPORTS_PUBLIC_KEY", &key_line())]), json!({ "build": 130, "sha": "1345348abcdef0", "builtAt": "2026-11-11T00:00:00Z", "tag": "latest" }), t.clone(), None);
        let pv = rep.preview(&json!({ "kind": "feedback", "message": "Love it", "contact": "me@example.org", "attach": true })).unwrap();
        assert_eq!(pv["payload"]["install"].as_str().unwrap().len(), 32);
        assert_eq!(pv["payload"]["contact"], "me@example.org");
        assert_eq!(pv["payload"]["diagnostics"]["system"]["hostname"], "tower");
        assert!(pv["payload"]["diagnostics"]["system"]["note"].as_str().unwrap().contains("password=[removed]"));
        assert_eq!(pv["payload"]["build"], json!({ "build": 130, "sha": "1345348abcdef0", "builtAt": "2026-11-11T00:00:00Z", "tag": "latest" }));
        let install = rep.install_id().unwrap();
        rep.set_settings(&json!({ "anonymous": true })).unwrap();
        let pv = rep.preview(&json!({ "kind": "feedback", "message": "from tower, my Daily Driver at 192.168.1.9", "contact": "me@example.org", "attach": true })).unwrap();
        assert_eq!(pv["payload"]["install"], "ANON");
        assert_eq!(pv["payload"]["anonymous"], true);
        assert!(pv["payload"].get("contact").is_none());
        let all = pv["payload"].to_string();
        for s in ["tower", "Daily Driver", "192.168", "10.0.0.2", "nas", "hunter2", install.as_str()] {
            assert!(!all.contains(s), "{s}: {all}");
        }
        // the toggle changed since: not sent
        rep.set_settings(&json!({ "anonymous": false })).unwrap();
        assert!(rep.send_preview(&pv["previewId"]).unwrap_err().message.contains("changed since the preview"));
        assert!(rep.send_preview(&json!("nope")).unwrap_err().message.contains("too old"));
        assert_eq!(rep.set_settings(&json!({ "share": "yes" })).unwrap_err().message, "share is on or off.");
        assert!(t.0.lock().unwrap().is_empty(), "previews send nothing");
    }

    #[test]
    fn the_outbox_holds_sealed_envelopes_only_with_caps() {
        let ctx = FakeCtx::new();
        let t = Arc::new(Counting(M::new(Vec::new())));
        let clock = Arc::new(M::new(store::now_ms()));
        let c2 = clock.clone();
        let rep = Reports::new(ctx.clone(), env(&[("REPORTS_PUBLIC_KEY", &key_line())]), json!({}), t.clone(), Some(Arc::new(move || *c2.lock().unwrap())));
        let pv = rep.preview(&json!({ "kind": "feedback", "message": "secret plan: tower", "attach": false })).unwrap();
        let r = rep.send_preview(&pv["previewId"]).unwrap();
        assert_eq!(r["result"], "retry");
        assert!(r["message"].as_str().unwrap().starts_with("Could not reach the receiver (ECONNREFUSED)"));
        let dir = ctx.data.join("reports/outbox");
        let file = fs::read_dir(&dir).unwrap().next().unwrap().unwrap().path();
        let raw = fs::read_to_string(&file).unwrap();
        assert!(!raw.contains("secret plan") && !raw.contains("tower"));
        let v: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["env"].as_object().unwrap().keys().collect::<Vec<_>>(), ["v", "kid", "epk", "iv", "ct", "tag"]);
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(ctx.data.join("reports")).unwrap().permissions().mode() & 0o777, 0o700);
        // not due yet: nothing tried
        let n = t.0.lock().unwrap().len();
        rep.flush(false);
        assert_eq!(t.0.lock().unwrap().len(), n);
        for i in 0..OUTBOX_MAX + 4 {
            let pl = rep.build_payload("feedback", Some(&json!(format!("m{i}"))), None, false, None).unwrap();
            rep.enqueue(&pl).unwrap();
        }
        assert_eq!(rep.status().unwrap()["outbox"]["count"], OUTBOX_MAX);
        *clock.lock().unwrap() += 8 * DAY_MS;
        rep.trim_outbox();
        assert_eq!(rep.status().unwrap()["outbox"]["count"], 0);
        // the per-hour limit on manual reports
        *clock.lock().unwrap() -= 8 * DAY_MS;
        for _ in 0..4 {
            let pv = rep.preview(&json!({ "kind": "feedback", "message": "x", "attach": false })).unwrap();
            rep.send_preview(&pv["previewId"]).unwrap();
        }
        let pv = rep.preview(&json!({ "kind": "feedback", "message": "x", "attach": false })).unwrap();
        let e = rep.send_preview(&pv["previewId"]).unwrap_err();
        assert_eq!(e.status, 429);
        assert!(e.message.contains("5 in the last hour"));
    }

    #[test]
    fn the_install_key_is_kept_in_nodes_pkcs8_form() {
        // made by Node: crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
        let node = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIMVojVAj0CmeTGroP0WwcWI4ofPl7yIcFUmqXf+oD2XS\n-----END PRIVATE KEY-----\n";
        let k = key_from_pem(node).unwrap();
        assert_eq!(key_to_pem(&k), node, "written back byte for byte as Node writes it");
    }

    #[test]
    fn the_heartbeat_has_exactly_the_protocols_fields() {
        let h = normalize_heartbeat(&json!({
            "uptimeSec": 12.4, "health": { "warnings": 2, "problems": 0 }, "vehicles": 1, "footageBytes": 5e9, "recordings": 3, "spaceSavedBytes": -4,
            "distanceKm": 12.345, "freeBytes": 9, "totalBytes": 5, "converting": "yes", "jobsQueued": null, "features": { "can": true, "gpu": 1 },
            "footageSeconds": 3600.6, "platform": "linux", "arch": "x64", "cpu": "Intel® Core™ i5 \"x\"", "gpus": ["Intel UHD 630", 5, ""],
            "cars": [{ "model": "3", "firmware": "2025.14.3.1 abcd12" }, { "model": "Roadster", "firmware": "v12" }],
            "clips24h": { "sentry": 4 }, "convert": { "fps": 41.26, "encoder": "hevc_qsv", "device": "Intel UHD 630", "api": "qsv", "codec": "hevc" },
            "nodes": [{ "name": "tower", "cpu": "AMD Ryzen", "gpus": [], "convert": null }], "host": { "os": "debian", "docker": true }, "secret": "x"
        }));
        // what Node's normalizeHeartbeat gives for the same input, byte for byte
        let node = r#"{"uptimeSec":12,"health":{"overall":"warn","warnings":2,"problems":0},"vehicles":1,"footageBytes":5000000000,"recordings":3,"spaceSavedBytes":0,"distanceKm":12.3,"freeBytes":5,"totalBytes":5,"converting":false,"jobsQueued":0,"features":{"can":true,"sentryUsbPaired":false,"gpu":false},"footageSeconds":3601,"platform":"linux","arch":"x64","cpu":"Intel CoreTM i5 x","gpus":["Intel UHD 630"],"cars":[{"model":"Model 3","firmware":"2025.14.3.1 abcd12"},{"model":null,"firmware":null}],"clips24h":{"sentry":4,"dashcam":0},"convert":{"fps":41.3,"encoder":"hevc_qsv","device":"Intel UHD 630","api":"qsv","codec":"hevc"},"nodes":[{"cpu":"AMD Ryzen","gpus":[],"convert":{"fps":null,"encoder":null,"device":null,"api":null,"codec":null}}],"crashes24h":0,"host":{"os":"debian","docker":true}}"#;
        assert_eq!(h.to_string(), node);
        let mut pl = json!({ "kind": "heartbeat", "sentAt": "2026-11-15T10:00:00.000Z", "install": "a".repeat(32), "anonymous": false, "build": { "build": null, "sha": null, "builtAt": null, "tag": null }, "ui": "original" });
        pl["heartbeat"] = h;
        assert_eq!(p::validate_payload(&pl), Vec::<String>::new());
    }

    #[test]
    fn settings_or_state_that_cannot_be_read_or_kept_send_nothing_never_a_report_that_is_not_anonymous() {
        let ctx = FakeCtx::new();
        let t = Arc::new(Counting(M::new(Vec::new())));
        let rep = Reports::new(ctx.clone(), env(&[("REPORTS_PUBLIC_KEY", &key_line())]), json!({}), t.clone(), None);
        rep.set_settings(&json!({ "share": true, "anonymous": true })).unwrap();
        // the daily summary is due; one whose time cannot be noted does not go (it would every hour);
        // (the install's id is kept already: nothing else needs writing to build it)
        store::set(&ctx.db(), "reports-state", &json!({ "lastDailyAt": 0, "installId": "0123456789abcdef0123456789abcdef" })).unwrap();
        ctx.db().execute_batch("CREATE TEMP TRIGGER refused BEFORE UPDATE ON settings WHEN NEW.key = 'reports-state' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;").unwrap();
        assert_eq!(rep.daily_if_due(), None);
        assert!(rep.outbox().is_empty() && t.0.lock().unwrap().is_empty());
        // settings that cannot be read: no report, never one that is not anonymous; the timers wait
        ctx.db().execute_batch("CREATE TABLE gone (x); ALTER TABLE settings RENAME TO settings_kept; CREATE VIEW settings AS SELECT * FROM gone; DROP TABLE gone;").unwrap();
        let refused = rep.preview(&json!({ "kind": "feedback", "message": "x", "attach": false })).unwrap_err();
        assert_eq!(refused.status, 500);
        assert!(rep.status().is_err());
        assert!(rep.send_heartbeat().is_none() && rep.send_heartbeat().is_none() && rep.send_crashes().is_empty());
        let waits = |what: &str| ctx.logs.lock().unwrap().iter().filter(|(_, _, l)| l.starts_with(&format!("Reports: the {what} waits"))).count();
        assert_eq!((waits("heartbeat"), waits("crash report")), (1, 1), "said once until it can be read");
        assert!(rep.outbox().is_empty() && t.0.lock().unwrap().is_empty());
    }

    #[test]
    fn sharing_turned_on_whose_daily_clock_cannot_be_kept_stays_off() {
        let ctx = FakeCtx::new();
        let rep = Reports::new(ctx.clone(), env(&[("REPORTS_PUBLIC_KEY", &key_line())]), json!({}), Arc::new(Counting(M::new(Vec::new()))), None);
        for when in ["INSERT", "UPDATE"] {
            ctx.db().execute_batch(&format!("CREATE TEMP TRIGGER refused_{when} BEFORE {when} ON settings WHEN NEW.key = 'reports-state' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;")).unwrap();
        }
        assert_eq!(rep.set_settings(&json!({ "share": true })).unwrap_err().status, 500);
        assert_eq!(rep.settings().unwrap()["share"], false, "a 500 that leaves sharing off");
    }

    #[test]
    fn a_heartbeat_that_cannot_be_made_is_not_sent_and_its_preview_is_a_500() {
        let ctx = FakeCtx::new();
        let t = Arc::new(Counting(M::new(Vec::new())));
        let rep = Reports::new(ctx.clone(), env(&[("REPORTS_PUBLIC_KEY", &key_line())]), json!({}), t.clone(), None);
        rep.set_settings(&json!({ "share": true })).unwrap();
        rep.set_sources(Sources { diagnostics: Box::new(|_| json!({})), heartbeat: Box::new(|| Err("manager.db: database disk image is malformed".into())), identifiers: Box::new(|| Ok(Vec::new())) });
        assert_eq!(rep.preview(&json!({ "kind": "heartbeat" })).unwrap_err().status, 500);
        assert!(rep.send_heartbeat().is_none());
        assert!(rep.outbox().is_empty() && t.0.lock().unwrap().is_empty());
        let said = "Reports: the heartbeat was not made: The heartbeat could not be made: manager.db: database disk image is malformed";
        assert!(ctx.logs.lock().unwrap().iter().any(|(_, _, l)| l == said));
    }
}
