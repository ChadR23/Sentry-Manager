//! The ops routes of server/index.js, answer for answer. `access` says who
//! may call each one (core checks it before calling `Ops::handle`); the 🔑
//! routes (AdminConfirmed) also need the password confirmed lately, which
//! `handle` checks itself from `Caller::confirmed`, as Node's
//! requireConfirmed does inside the handler.

use super::ctx::{Caller, Level};
use super::js::{num, number_opt, truthy};
use super::power;
use super::store::{self, now_ms};
use super::Ops;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    Public,
    Signed,
    Admin,
    AdminConfirmed,
    /// /metrics: its own Bearer token, no session
    MetricsToken,
}

/// (method, pattern, access): the routes this area answers.
pub const ROUTES: [(&str, &str, Access); 28] = [
    ("GET", "/api/notification-rules", Access::Signed),
    ("PUT", "/api/notification-rules", Access::Admin),
    ("GET", "/api/notifications", Access::Signed),
    ("POST", "/api/notifications/:id/dismiss", Access::Signed),
    ("POST", "/api/notifications/read", Access::Signed),
    ("GET", "/api/health", Access::Signed),
    ("POST", "/api/health/run", Access::Admin),
    ("GET", "/api/health/banner", Access::Signed),
    ("GET", "/api/snapshots", Access::Admin),
    ("POST", "/api/snapshots", Access::Admin),
    ("POST", "/api/snapshots/:name/restore", Access::AdminConfirmed),
    ("GET", "/api/metrics/settings", Access::Admin),
    ("POST", "/api/metrics/enable", Access::AdminConfirmed),
    ("POST", "/api/metrics/disable", Access::AdminConfirmed),
    ("GET", "/metrics", Access::MetricsToken),
    ("GET", "/api/stats", Access::Signed),
    ("GET", "/api/stats/history", Access::Signed),
    ("GET", "/api/stats/export.csv", Access::Signed),
    ("GET", "/api/system", Access::Signed),
    ("GET", "/api/support-bundle", Access::Admin),
    ("GET", "/api/reports", Access::Admin),
    ("PUT", "/api/reports/settings", Access::Admin),
    ("POST", "/api/reports/preview", Access::Admin),
    ("POST", "/api/reports/send", Access::AdminConfirmed),
    ("PUT", "/api/settings/power", Access::Admin),
    ("GET", "/api/vehicles/:id/savings-by-month", Access::Signed),
    ("GET", "/api/updates", Access::Signed),
    ("POST", "/api/updates/check", Access::Admin),
];

/// Matches a path against a pattern; the :params, decoded as decodeURIComponent does.
fn matches(pattern: &str, path: &str) -> Option<HashMap<String, String>> {
    let (p, q): (Vec<&str>, Vec<&str>) = (pattern.split('/').collect(), path.split('/').collect());
    if p.len() != q.len() {
        return None;
    }
    let mut params = HashMap::new();
    for (a, b) in p.iter().zip(q.iter()) {
        if let Some(k) = a.strip_prefix(':') {
            if b.is_empty() {
                return None;
            }
            params.insert(k.to_string(), crate::api::decode(b, false)?);
        } else if a != b {
            return None;
        }
    }
    Some(params)
}

/// Who may call a route of this area (None: not one of its routes).
pub fn access(method: &str, path: &str) -> Option<Access> {
    ROUTES.iter().find(|(m, p, _)| *m == method && matches(p, path).is_some()).map(|r| r.2)
}

/// An answer: JSON, or raw bytes with their own headers.
#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn json(status: u16, v: &Value) -> Reply {
        Reply { status, headers: vec![("Content-Type".into(), "application/json; charset=utf-8".into()), ("Cache-Control".into(), "no-store".into())], body: v.to_string().into_bytes() }
    }
    pub fn ok(v: Value) -> Reply {
        Reply::json(200, &v)
    }
    pub fn error(status: u16, msg: &str, code: Option<&str>) -> Reply {
        let mut v = json!({ "error": msg });
        if let Some(c) = code {
            v["code"] = json!(c);
        }
        Reply::json(status, &v)
    }
    pub fn raw(status: u16, headers: &[(&str, &str)], body: Vec<u8>) -> Reply {
        Reply { status, headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), body }
    }
    pub fn body_json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
}

pub struct Request<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub query: &'a HashMap<String, String>,
    /// the JSON body (Null when there was none)
    pub body: &'a Value,
    pub caller: &'a Caller,
    /// the Authorization header (for /metrics)
    pub authorization: Option<&'a str>,
}

const CONFIRM_TEXT: &str = "Enter your password to confirm this change.";

fn confirm(c: &Caller) -> Option<Reply> {
    (!c.confirmed).then(|| Reply::error(403, CONFIRM_TEXT, Some("CONFIRM_PASSWORD")))
}

fn report_err(e: super::reports::ReportError) -> Reply {
    Reply::error(e.status, &e.message, e.code)
}

fn rss_bytes() -> Option<f64> {
    let s = std::fs::read_to_string("/proc/self/statm").ok()?;
    let pages: f64 = s.split_whitespace().nth(1)?.parse().ok()?;
    Some(pages * unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as f64)
}

impl Ops {
    /// One request of this area, or None when it is not one of its routes.
    pub fn handle(&self, r: &Request) -> Option<Reply> {
        let (m, p) = (r.method, r.path);
        let by = r.caller.by();
        let ctx = &*self.ctx;
        let route = |method: &str, pattern: &str| if m == method { matches(pattern, p) } else { None };

        if route("GET", "/api/notification-rules").is_some() {
            return Some(Reply::ok(self.notes.rules()));
        }
        if route("PUT", "/api/notification-rules").is_some() {
            let muted = self.notes.set_rules(r.body);
            ctx.audit(Level::Info, &format!("Notification rules: {}: {by}", if muted.is_empty() { "all on".to_string() } else { format!("off for {}", muted.join(", ")) }));
            return Some(Reply::ok(self.notes.rules()));
        }
        if route("GET", "/api/notifications").is_some() {
            let open = r.query.get("open").is_some_and(|v| v == "1");
            let vehicle = r.query.get("vehicle").filter(|v| !v.is_empty()).map(String::as_str);
            return Some(Reply::ok(json!({ "notifications": self.notes.list(open, vehicle) })));
        }
        if let Some(params) = route("POST", "/api/notifications/:id/dismiss") {
            self.notes.dismiss(super::js::number_str(&params["id"]));
            return Some(Reply::ok(json!({ "ok": true })));
        }
        if route("POST", "/api/notifications/read").is_some() {
            let ids: Vec<f64> = r.body["ids"].as_array().map(|a| a.iter().map(super::js::number).filter(|x| x.is_finite()).collect()).unwrap_or_default();
            self.notes.mark_read(&ids);
            return Some(Reply::ok(json!({ "ok": true })));
        }
        if route("GET", "/api/health").is_some() {
            return Some(Reply::ok(self.health.last().unwrap_or_else(|| self.health.run(ctx, Some(&self.snapshots), false))));
        }
        if route("POST", "/api/health/run").is_some() {
            return Some(Reply::ok(self.health.run(ctx, Some(&self.snapshots), false)));
        }
        if route("GET", "/api/health/banner").is_some() {
            return Some(Reply::ok(self.health.banner()));
        }
        if route("GET", "/api/snapshots").is_some() {
            return Some(Reply::ok(json!({ "snapshots": self.snapshots.list(), "keep": 7 })));
        }
        if route("POST", "/api/snapshots").is_some() {
            let taken = self.snapshots.take(&ctx.db(), &super::snapshots::utc_day(now_ms()), true);
            return Some(match taken {
                Ok(name) => {
                    let name = name.unwrap_or_default();
                    ctx.log("snapshots", Level::Info, &format!("Database snapshot {name} saved"));
                    ctx.audit(Level::Info, &format!("Database snapshot {name} made: {by}"));
                    Reply::ok(json!({ "snapshots": self.snapshots.list() }))
                }
                Err(e) => {
                    ctx.log("server", Level::Error, &format!("POST {p}: {e}"));
                    Reply::error(500, "Internal error", None)
                }
            });
        }
        if let Some(params) = route("POST", "/api/snapshots/:name/restore") {
            if let Some(no) = confirm(r.caller) {
                return Some(no);
            }
            let name = &params["name"];
            if self.snapshots.prepare_restore(name).is_err() {
                return Some(Reply::error(404, "No such snapshot.", None));
            }
            ctx.audit(Level::Warn, &format!("Database snapshot {name} chosen to restore; restarting: {by}"));
            let c = self.ctx.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(500));
                c.shutdown("restore");
            });
            return Some(Reply::ok(json!({ "ok": true, "restarting": true })));
        }
        if route("GET", "/api/metrics/settings").is_some() {
            let cfg = store::get(&ctx.read_db(), "metrics").unwrap_or(Value::Null);
            return Some(Reply::ok(json!({ "enabled": truthy(&cfg["enabled"]) })));
        }
        if route("POST", "/api/metrics/enable").is_some() {
            if let Some(no) = confirm(r.caller) {
                return Some(no);
            }
            let mut b = [0u8; 24];
            rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut b);
            let token = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, b);
            let hash: String = Sha256::digest(token.as_bytes()).iter().map(|x| format!("{x:02x}")).collect();
            store::set(&ctx.db(), "metrics", &json!({ "enabled": true, "tokenHash": hash, "at": now_ms() }));
            ctx.audit(Level::Warn, &format!("Metrics turned on (new token): {by}"));
            return Some(Reply::ok(json!({ "enabled": true, "token": token })));
        }
        if route("POST", "/api/metrics/disable").is_some() {
            if let Some(no) = confirm(r.caller) {
                return Some(no);
            }
            store::set(&ctx.db(), "metrics", &json!({ "enabled": false }));
            ctx.audit(Level::Warn, &format!("Metrics turned off: {by}"));
            return Some(Reply::ok(json!({ "enabled": false })));
        }
        if route("GET", "/metrics").is_some() {
            return Some(self.metrics(r.authorization));
        }
        if route("GET", "/api/stats").is_some() {
            return Some(Reply::ok(self.stats_answer()));
        }
        if route("GET", "/api/stats/history").is_some() {
            self.stats.touch(None);
            return Some(Reply::ok(self.stats.history(r.query.get("range").is_some_and(|x| x == "24h"))));
        }
        if route("GET", "/api/stats/export.csv").is_some() {
            let range = if r.query.get("range").is_some_and(|x| x == "15m") { "15m" } else { "24h" };
            let disp = format!("attachment; filename=\"{}\"", super::stats::csv_name(range));
            return Some(Reply::raw(200, &[("Content-Type", "text/csv; charset=utf-8"), ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"), ("Content-Disposition", &disp)], self.stats.csv(range == "24h").into_bytes()));
        }
        if route("GET", "/api/system").is_some() {
            return Some(Reply::ok(self.system(r.caller)));
        }
        if route("GET", "/api/support-bundle").is_some() {
            return Some(self.support_bundle());
        }
        if route("GET", "/api/reports").is_some() {
            return Some(Reply::ok(self.reports.status()));
        }
        if route("PUT", "/api/reports/settings").is_some() {
            let patch = json!({ "share": r.body["share"], "anonymous": r.body["anonymous"] });
            // (a field left out is undefined in Node, not null)
            let mut p2 = serde_json::Map::new();
            for k in ["share", "anonymous"] {
                if r.body.get(k).is_some() {
                    p2.insert(k.into(), patch[k].clone());
                }
            }
            return Some(match self.reports.set_settings(&Value::Object(p2)) {
                Ok((before, after)) => {
                    let word = |v: &Value| if truthy(v) { "on" } else { "off" };
                    if before["share"] != after["share"] {
                        ctx.audit(Level::Warn, &format!("Share diagnostics with the developers turned {}: {by}", word(&after["share"])));
                    }
                    if before["anonymous"] != after["anonymous"] {
                        ctx.audit(Level::Warn, &format!("Send reports anonymously turned {}: {by}", word(&after["anonymous"])));
                    }
                    Reply::ok(self.reports.status())
                }
                Err(e) => report_err(e),
            });
        }
        if route("POST", "/api/reports/preview").is_some() {
            return Some(match self.reports.preview(r.body) {
                Ok(v) => Reply::ok(v),
                Err(e) => report_err(e),
            });
        }
        if route("POST", "/api/reports/send").is_some() {
            if let Some(no) = confirm(r.caller) {
                return Some(no);
            }
            return Some(match self.reports.send_preview(&r.body["previewId"]) {
                Ok(mut out) => {
                    let what = if out["kind"] == "support" { "Diagnostics sent to support" } else { "Feedback sent to the developers" };
                    let rf = out["ref"].as_str().filter(|s| !s.is_empty()).map(|s| format!(" ({s})")).unwrap_or_default();
                    let res = if out["result"] != "sent" { format!(" ({})", super::js::to_string(&out["result"])) } else { String::new() };
                    ctx.audit(Level::Warn, &format!("{what}{rf}{res}: {by}"));
                    out["status"] = self.reports.status();
                    Reply::ok(out)
                }
                Err(e) => report_err(e),
            });
        }
        if route("PUT", "/api/settings/power").is_some() {
            let body = if r.body.is_null() { json!({}) } else { r.body.clone() };
            return Some(match power::parse_power_settings(&body) {
                Ok(next) => {
                    store::set(&ctx.db(), "power", &next);
                    Reply::ok(next)
                }
                Err(e) => Reply::error(400, &e.0, None),
            });
        }
        if let Some(params) = route("GET", "/api/vehicles/:id/savings-by-month") {
            let id = &params["id"];
            if !ctx.vehicles().iter().any(|v| v.id == *id) {
                return Some(Reply::error(404, "No such vehicle.", None));
            }
            return Some(Reply::ok(power::savings_by_month(&ctx.read_db(), id, r.query.get("months").map(String::as_str))));
        }
        if route("GET", "/api/updates").is_some() {
            return Some(Reply::ok(self.updates.status()));
        }
        if route("POST", "/api/updates/check").is_some() {
            return Some(Reply::ok(self.updates.check()));
        }
        None
    }

    /// GET /api/system
    fn system(&self, caller: &Caller) -> Value {
        let ctx = &*self.ctx;
        let conv = ctx.converter();
        let (smb, smb_default) = ctx.smb_versions();
        let uid = unsafe { libc::getuid() };
        json!({
            "version": self.build_info,
            "converter": if conv.ready { json!({ "ready": true, "capabilities": conv.capabilities }) } else { json!({ "ready": false, "error": conv.error }) },
            "nativeHelper": conv.native_helper,
            "gpu": ctx.detect_gpus(),
            "dataFree": super::sys::disk_space(&ctx.data_dir()).map(|s| num(s.free)),
            "timezone": std::env::var("TZ").ok().filter(|s| !s.is_empty()).unwrap_or_else(local_zone),
            "security": { "https": caller.https, "tlsMode": ctx.tls_mode(), "supervised": ctx.supervised(), "runningAsRoot": uid == 0, "uid": uid },
            "smbVersions": smb,
            "smbDefaultVersion": smb_default
        })
    }

    /// GET /metrics: Prometheus text, only with the token made in Health.
    fn metrics(&self, authorization: Option<&str>) -> Reply {
        let ctx = &*self.ctx;
        let cfg = store::get(&ctx.read_db(), "metrics").unwrap_or(Value::Null);
        let hash = cfg["tokenHash"].as_str().unwrap_or("");
        if !truthy(&cfg["enabled"]) || hash.is_empty() {
            return Reply::error(404, "Not found", None);
        }
        let a = authorization.unwrap_or("");
        let given = if a.len() >= 6 && a[..6].eq_ignore_ascii_case("bearer") && a[6..].starts_with(char::is_whitespace) { a[6..].trim_start() } else { a };
        let mine: String = Sha256::digest(given.as_bytes()).iter().map(|x| format!("{x:02x}")).collect();
        // (constant time over equal lengths, as timingSafeEqual)
        let same = mine.len() == hash.len() && mine.bytes().zip(hash.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0;
        if given.is_empty() || !same {
            return Reply::raw(401, &[("Content-Type", "text/plain"), ("WWW-Authenticate", "Bearer"), ("Cache-Control", "no-store")], b"Bearer token required".to_vec());
        }
        let mut lines: Vec<String> = Vec::new();
        let mut metric = |name: &str, help: &str, rows: Vec<(String, Option<f64>)>| {
            lines.push(format!("# HELP {name} {help}"));
            lines.push(format!("# TYPE {name} gauge"));
            for (labels, v) in rows {
                if let Some(v) = v.filter(|x| x.is_finite()) {
                    lines.push(format!("{name}{labels} {}", super::js::num_text(v)));
                }
            }
        };
        let list = ctx.vehicles();
        let lab = |id: &str| format!("{{vehicle=\"{}\"}}", id.replace(['"', '\\', '\n'], "_"));
        let per = |f: &dyn Fn(&super::ctx::VehicleInfo) -> Option<f64>| list.iter().map(|v| (lab(&v.id), f(v))).collect::<Vec<_>>();
        metric("sentry_up", "The app is running", vec![(String::new(), Some(1.0))]);
        metric("sentry_uptime_seconds", "Seconds since the app started", vec![(String::new(), Some(super::stats::js_round((now_ms() - self.started_at) as f64 / 1000.0)))]);
        metric("sentry_process_resident_bytes", "Memory the app uses", vec![(String::new(), rss_bytes())]);
        metric("sentry_share_up", "The footage share can be read (1) or not (0)", per(&|v| Some(if v.status.as_ref().is_some_and(|s| s.healthy) { 1.0 } else { 0.0 })));
        metric("sentry_share_writable", "The footage share can be written", per(&|v| Some(if v.status.as_ref().is_some_and(|s| s.writable == Some(true)) { 1.0 } else { 0.0 })));
        metric("sentry_share_free_bytes", "Free space on the footage share", per(&|v| v.status.as_ref().and_then(|s| s.free_bytes)));
        metric("sentry_share_total_bytes", "Size of the footage share", per(&|v| v.status.as_ref().and_then(|s| s.total_bytes)));
        metric("sentry_footage_bytes", "Footage size", per(&|v| v.footage_bytes));
        metric("sentry_recordings", "Recordings", per(&|v| v.recordings));
        metric("sentry_recycle_bin_bytes", "Bytes in the Recycle Bin", per(&|v| v.bin_bytes));
        let db = ctx.read_db();
        let saved: Vec<(String, Option<f64>)> = list.iter().map(|v| (lab(&v.id), Some(number_opt(power::for_vehicle(&db, &v.id).get("bytes"))))).collect();
        let open = store::list(&db, true, 1000, None);
        drop(db);
        metric("sentry_saved_bytes", "Space saved by conversions", saved);
        metric("sentry_days_until_full", "Days until the share is full at the last 14 days' rate", per(&|v| v.days_left));
        metric("sentry_conversion_running", "A conversion is running", vec![(String::new(), Some(if ctx.converter().running { 1.0 } else { 0.0 }))]);
        metric("sentry_notifications_open", "Open notifications", ["critical", "warning", "info"].iter().map(|l| (format!("{{level=\"{l}\"}}"), Some(open.iter().filter(|n| n["level"] == *l).count() as f64))).collect());
        let last = self.health.last();
        metric("sentry_health_checks_failing", "Health checks failing at the last run", vec![(String::new(), last.map(|l| l["checks"].as_array().map_or(0, |c| c.iter().filter(|x| x["status"] == "bad").count()) as f64))]);
        let text = format!("{}\n", lines.join("\n"));
        Reply::raw(200, &[("Content-Type", "text/plain; version=0.0.4; charset=utf-8"), ("Cache-Control", "no-store")], text.into_bytes())
    }

    /// GET /api/support-bundle: what someone helping needs, without passwords,
    /// footage paths, share names, IP addresses or e-mails.
    fn support_bundle(&self) -> Reply {
        let ctx = &*self.ctx;
        let mut swaps: Vec<(String, String)> = Vec::new();
        for (i, v) in ctx.vehicles().iter().enumerate() {
            for p in &v.roots {
                if p.encode_utf16().count() > 1 {
                    swaps.push((p.clone(), format!("<footage-{}>", i + 1)));
                }
            }
            if let Some(s) = v.share.as_ref().filter(|s| !s.is_empty()) {
                swaps.push((s.clone(), format!("<share-{}>", i + 1)));
            }
            if let Some(u) = v.username.as_ref().filter(|s| !s.is_empty()) {
                swaps.push((u.clone(), format!("<share-user-{}>", i + 1)));
            }
            if !v.name.is_empty() {
                swaps.push((v.name.clone(), format!("<vehicle-{}>", i + 1)));
            }
        }
        swaps.push((ctx.data_dir().to_string_lossy().into_owned(), "<data>".into()));
        swaps.sort_by_key(|s| std::cmp::Reverse(s.0.encode_utf16().count()));
        let scrub = |text: &str| -> String {
            let mut t = text.to_string();
            for (from, to) in &swaps {
                t = t.split(from.as_str()).collect::<Vec<_>>().join(to);
            }
            bundle_patterns(&t)
        };
        let lines = ctx.log_search(now_ms() - 7 * 86_400_000, Level::Info, 50_000);
        let results = self.health.last().unwrap_or_else(|| self.health.run(ctx, Some(&self.snapshots), false));
        let system = ctx.system_summary(true);
        let pretty = |v: &Value| super::js_pretty(v);
        let logs = lines.iter().map(|l| format!("{} {:<5} [{}] {}", super::js::iso(l.at), l.level.name().to_uppercase(), l.scope, l.message)).collect::<Vec<_>>().join("\n");
        let files: Vec<(&str, Vec<u8>)> = vec![
            ("README.txt", b"Sentry Six Manager support bundle.\nsystem.json: version, GPUs, converter, shares (no paths or names).\nhealth.json: Settings > Health checks.\nlogs.txt: the last 7 days of logs.\nPasswords are masked in logs; footage paths, share names, vehicle names, IP addresses and e-mail addresses are replaced with <placeholders>.\n".to_vec()),
            ("system.json", scrub(&pretty(&system)).into_bytes()),
            ("health.json", scrub(&pretty(&results)).into_bytes()),
            ("logs.txt", scrub(&logs).into_bytes()),
        ];
        let zip = super::zip::write_zip(&files);
        let disp = format!("attachment; filename=\"sentry-six-manager-support-{}.zip\"", &super::js::iso(now_ms())[..10]);
        let len = zip.len().to_string();
        Reply::raw(200, &[("Content-Type", "application/zip"), ("Content-Length", &len), ("Cache-Control", "no-store"), ("Content-Disposition", &disp)], zip)
    }
}

/// The support bundle's last pass: IPv4, e-mail and IPv6 addresses.
fn bundle_patterns(t: &str) -> String {
    use fancy_regex::Regex;
    use std::sync::OnceLock;
    static R: OnceLock<[Regex; 3]> = OnceLock::new();
    let b = r"(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))";
    let r = R.get_or_init(|| {
        [
            Regex::new(&format!(r"{b}[0-9]{{1,3}}(?:\.[0-9]{{1,3}}){{3}}{b}")).unwrap(),
            Regex::new(&format!(r"{b}[A-Za-z0-9_.+-]+@[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+{b}")).unwrap(),
            Regex::new(&format!(r"(?i){b}(?:[0-9a-f]{{1,4}}:){{2,7}}[0-9a-f]{{1,4}}{b}")).unwrap(),
        ]
    });
    let t = r[0].replace_all(t, "<ip>");
    let t = r[1].replace_all(&t, "<email>");
    r[2].replace_all(&t, "<ip6>").into_owned()
}

/// Intl.DateTimeFormat().resolvedOptions().timeZone without TZ: /etc/timezone or the zoneinfo link.
fn local_zone() -> String {
    if let Ok(t) = std::fs::read_to_string("/etc/timezone") {
        let t = t.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    if let Ok(p) = std::fs::read_link("/etc/localtime") {
        let s = p.to_string_lossy();
        if let Some(i) = s.find("zoneinfo/") {
            return s[i + 9..].to_string();
        }
    }
    "UTC".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::ctx::{Caller, VehicleInfo};
    use crate::ops::testing::FakeCtx;
    use std::sync::Arc;

    fn ops() -> (Arc<FakeCtx>, Arc<Ops>) {
        let ctx = FakeCtx::new();
        *ctx.vehicles.lock().unwrap() = vec![VehicleInfo { id: "car".into(), name: "Car".into(), roots: vec!["/footage/car".into()], ..Default::default() }];
        let o = Ops::new(ctx.clone(), Arc::new(crate::ops::reports::NoNetwork), std::collections::HashMap::new());
        (ctx, o)
    }

    fn call(o: &Ops, method: &str, path: &str, query: &[(&str, &str)], body: Value, confirmed: bool) -> Reply {
        let q: HashMap<String, String> = query.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        let caller = Caller { user: Some("admin".into()), client: "127.0.0.1".into(), confirmed, https: true };
        o.handle(&Request { method, path, query: &q, body: &body, caller: &caller, authorization: None }).expect("a route of this area")
    }

    #[test]
    fn every_route_has_its_access_and_others_are_not_ours() {
        assert_eq!(access("GET", "/api/notifications"), Some(Access::Signed));
        assert_eq!(access("POST", "/api/notifications/12/dismiss"), Some(Access::Signed));
        assert_eq!(access("POST", "/api/snapshots/manager-2026-11-01.db/restore"), Some(Access::AdminConfirmed));
        assert_eq!(access("GET", "/api/vehicles"), None);
        let (_c, o) = ops();
        let q = HashMap::new();
        let caller = Caller::default();
        assert!(o.handle(&Request { method: "GET", path: "/api/vehicles", query: &q, body: &Value::Null, caller: &caller, authorization: None }).is_none());
    }

    #[test]
    fn notifications_rules_dismiss_and_read() {
        let (ctx, o) = ops();
        o.notes.raise(&store::Note::new("share", "warning", "A").key("k1"));
        o.notes.raise(&store::Note::new("update", "info", "B").key("k2"));
        let all = call(&o, "GET", "/api/notifications", &[], Value::Null, false).body_json();
        assert_eq!(all["notifications"].as_array().unwrap().len(), 2);
        let id = all["notifications"][0]["id"].as_i64().unwrap();
        assert_eq!(call(&o, "POST", &format!("/api/notifications/{id}/dismiss"), &[], Value::Null, false).body_json(), json!({ "ok": true }));
        assert_eq!(call(&o, "GET", "/api/notifications", &[("open", "1")], Value::Null, false).body_json()["notifications"].as_array().unwrap().len(), 1);
        call(&o, "POST", "/api/notifications/read", &[], json!({ "ids": [1, "2", "x", null] }), false);
        let r = call(&o, "PUT", "/api/notification-rules", &[], json!({ "rules": { "archive": false, "health": false } }), false).body_json();
        assert_eq!(r["rules"][3], json!({ "kind": "health", "on": false }));
        assert_eq!(ctx.audit_lines().last().unwrap(), "Notification rules: off for health, archive: admin from 127.0.0.1");
    }

    #[test]
    fn confirmed_routes_ask_for_the_password_first() {
        let (_c, o) = ops();
        for (m, p) in [("POST", "/api/metrics/enable"), ("POST", "/api/metrics/disable"), ("POST", "/api/reports/send"), ("POST", "/api/snapshots/x/restore")] {
            let r = call(&o, m, p, &[], Value::Null, false);
            assert_eq!(r.status, 403, "{p}");
            assert_eq!(r.body_json(), json!({ "error": CONFIRM_TEXT, "code": "CONFIRM_PASSWORD" }));
        }
        assert_eq!(call(&o, "POST", "/api/snapshots/x/restore", &[], Value::Null, true).body_json(), json!({ "error": "No such snapshot." }));
    }

    #[test]
    fn metrics_only_with_its_token() {
        let (_c, o) = ops();
        let get = |auth: Option<&str>| {
            let q = HashMap::new();
            let caller = Caller::default();
            o.handle(&Request { method: "GET", path: "/metrics", query: &q, body: &Value::Null, caller: &caller, authorization: auth }).unwrap()
        };
        assert_eq!(get(None).status, 404, "off by default");
        assert_eq!(call(&o, "GET", "/api/metrics/settings", &[], Value::Null, false).body_json(), json!({ "enabled": false }));
        let on = call(&o, "POST", "/api/metrics/enable", &[], Value::Null, true).body_json();
        let token = on["token"].as_str().unwrap().to_string();
        assert_eq!(token.len(), 32);
        assert_eq!(get(None).status, 401);
        assert_eq!(get(Some("Bearer nope")).status, 401);
        let ok = get(Some(&format!("Bearer {token}")));
        assert_eq!(ok.status, 200);
        let text = String::from_utf8(ok.body).unwrap();
        assert!(text.starts_with("# HELP sentry_up The app is running\n# TYPE sentry_up gauge\nsentry_up 1\n"));
        assert!(text.contains("sentry_share_up{vehicle=\"car\"} 0\n"));
        assert!(text.contains("sentry_notifications_open{level=\"critical\"} 0\n"));
        assert!(!text.contains("\nsentry_health_checks_failing "), "no run yet: NaN is left out");
        call(&o, "POST", "/api/metrics/disable", &[], Value::Null, true);
        assert_eq!(get(Some(&format!("Bearer {token}"))).status, 404);
    }

    #[test]
    fn power_settings_savings_and_stats() {
        let (_c, o) = ops();
        let bad = call(&o, "PUT", "/api/settings/power", &[], json!({ "pricePerKwh": 99 }), false);
        assert_eq!((bad.status, bad.body_json()), (400, json!({ "error": "Price: enter a price per kWh between 0 and 10." })));
        assert_eq!(call(&o, "PUT", "/api/settings/power", &[], json!({ "pricePerKwh": 0.2 }), false).body_json()["pricePerKwh"], 0.2);
        let s = call(&o, "GET", "/api/stats", &[], Value::Null, false).body_json();
        assert_eq!(s["price"], json!({ "currency": "$", "mode": "flat", "now": 0.2, "rate": null }));
        assert_eq!(s["encoder"], Value::Null);
        assert_eq!(call(&o, "GET", "/api/vehicles/none/savings-by-month", &[], Value::Null, false).status, 404);
        assert_eq!(call(&o, "GET", "/api/vehicles/car/savings-by-month", &[("months", "6")], Value::Null, false).body_json()["months"].as_array().unwrap().len(), 6);
        let csv = call(&o, "GET", "/api/stats/export.csv", &[("range", "15m")], Value::Null, false);
        assert!(csv.headers.iter().any(|(k, v)| k == "Content-Disposition" && v == "attachment; filename=\"sentry-six-manager-stats-15m.csv\""));
        assert!(String::from_utf8(csv.body).unwrap().starts_with("time,cpu,memory,"));
        let h = call(&o, "GET", "/api/stats/history", &[("range", "24h")], Value::Null, false).body_json();
        assert_eq!(h["step"], 60000);
    }

    #[test]
    fn reports_off_without_a_key_and_the_bundle_hides_names() {
        let (ctx, o) = ops();
        let st = call(&o, "GET", "/api/reports", &[], Value::Null, false).body_json();
        assert_eq!(st["configured"], true, "the built-in receiver key");
        assert_eq!(st["endpoint"], "https://reports.skittles.live");
        assert_eq!(st["settings"], json!({ "share": false, "anonymous": false }));
        let r = call(&o, "PUT", "/api/reports/settings", &[], json!({ "share": "x" }), false);
        assert_eq!((r.status, r.body_json()), (400, json!({ "error": "share is on or off." })));
        call(&o, "PUT", "/api/reports/settings", &[], json!({ "anonymous": true }), false);
        assert_eq!(ctx.audit_lines().last().unwrap(), "Send reports anonymously turned on: admin from 127.0.0.1");
        let z = call(&o, "GET", "/api/support-bundle", &[], Value::Null, false);
        assert_eq!(&z.body[..2], b"PK");
        // (as Node's: a compressed IPv6 address is not caught by this pass)
        assert_eq!(bundle_patterns("from 10.0.0.2 by a@b.co at fe80::1:2 and 2001:db8:0:0:1:2:3:4"), "from <ip> by <email> at fe80::1:2 and <ip6>");
    }

    #[test]
    fn snapshots_and_health_routes() {
        let (ctx, o) = ops();
        let r = call(&o, "POST", "/api/snapshots", &[], Value::Null, false).body_json();
        assert_eq!(r["snapshots"].as_array().unwrap().len(), 1);
        let name = r["snapshots"][0]["name"].as_str().unwrap().to_string();
        assert_eq!(call(&o, "GET", "/api/snapshots", &[], Value::Null, false).body_json()["keep"], 7);
        assert_eq!(call(&o, "POST", &format!("/api/snapshots/{name}/restore"), &[], Value::Null, true).body_json(), json!({ "ok": true, "restarting": true }));
        assert!(ctx.data.join("manager.db.restore").exists());
        assert_eq!(call(&o, "GET", "/api/health/banner", &[], Value::Null, false).body_json(), json!({ "problems": [] }));
        let h = call(&o, "GET", "/api/health", &[], Value::Null, false).body_json();
        assert!(h["checks"].as_array().unwrap().iter().any(|c| c["id"] == "snapshots" && c["status"] == "ok"));
        assert!(!call(&o, "GET", "/api/health/banner", &[], Value::Null, false).body_json()["problems"].as_array().unwrap().is_empty());
    }
}
