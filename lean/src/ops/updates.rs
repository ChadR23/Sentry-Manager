//! Updates come as new images (server/imageUpdates.js). Twice a day this
//! asks the registry the build recorded (BUILD_INFO.json), anonymously,
//! which image the tag points to now and compares its build number with
//! ours; an image from before build numbers is compared by revision and
//! build time. Nothing is downloaded or installed and no token is stored.
//! UPDATE_CHECK=off turns it off; images built locally have no tag to check.

use super::build::clean_build;
use super::ctx::{Level, OpsCtx};
use super::js::{iso, parse_date, truthy};
use super::net::{form_encode, HttpReq, HttpRes, Transport};
use super::notes::Notes;
use super::store::{self, now_ms, Note};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

pub const CHECK_MS: i64 = 12 * 3600 * 1000;
pub const STARTUP_CHECK_MS: i64 = 10 * 60 * 1000;
const VERSION_LABEL: &str = "org.opencontainers.image.version";
const CRITICAL_LABEL: &str = "io.sentry-six.critical";
const CRITICAL_LEVEL_LABEL: &str = "io.sentry-six.critical-level";
const MAX_LEVEL: u64 = 999_999;
const CRITICAL_MAX: usize = 300;
const MIN_CHECK_GAP_MS: i64 = 60 * 1000;
const MAX_BODY: usize = 1024 * 1024;
const ACCEPT: &str = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";

fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    }
}

/// IMAGE_RE: host.tld[:port]/path in lower case
fn parse_image(s: &str) -> Option<(String, String)> {
    let (host, repo) = s.split_once('/')?;
    let name = match host.rsplit_once(':') {
        Some((n, p)) if !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()) => n,
        Some(_) => return None,
        None => host,
    };
    let name_ok = name.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'-')
        && name.rsplit_once('.').is_some_and(|(a, tld)| !a.is_empty() && tld.len() >= 2 && tld.bytes().all(|c| c.is_ascii_lowercase()));
    let repo_ok = !repo.is_empty() && repo.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'/' | b'-'));
    (name_ok && repo_ok).then(|| (host.to_string(), repo.to_string()))
}

fn tag_ok(t: &str) -> bool {
    let b = t.as_bytes();
    !b.is_empty() && b.len() <= 128 && (b[0].is_ascii_alphanumeric() || b[0] == b'_') && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
}

fn digest_ok(d: &str) -> bool {
    d.len() == 71 && d.starts_with("sha256:") && d[7..].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// The parameters of a `Bearer realm="…",service="…",scope="…"` challenge.
pub fn parse_challenge(header: &str) -> Option<Vec<(String, String)>> {
    let lower = header.to_ascii_lowercase();
    if !(lower.starts_with("bearer") && header[6..].starts_with(char::is_whitespace)) {
        return None;
    }
    let mut out: Vec<(String, String)> = Vec::new();
    let b = header.as_bytes();
    let mut i = 0;
    while i < b.len() {
        // (\w+)="([^"]*)"
        if b[i].is_ascii_alphanumeric() || b[i] == b'_' {
            let s = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1;
            }
            if i + 1 < b.len() && b[i] == b'=' && b[i + 1] == b'"' {
                if let Some(end) = header[i + 2..].find('"') {
                    let k = header[s..i].to_ascii_lowercase();
                    let v = header[i + 2..i + 2 + end].to_string();
                    out.retain(|(x, _)| *x != k);
                    out.push((k, v));
                    i = i + 2 + end + 1;
                    continue;
                }
            }
            continue;
        }
        i += 1;
    }
    out.iter().any(|(k, v)| k == "realm" && !v.is_empty()).then_some(out)
}

fn control(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// A label's text as plain, single-line, short text (or None when empty).
pub fn clean_critical(v: &Value) -> Option<String> {
    let s = v.as_str()?;
    let spaced: String = s.chars().map(|c| if control(c) { ' ' } else { c }).collect();
    let collapsed = spaced.split(|c: char| c.is_whitespace() || c == '\u{feff}').filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ");
    let t = js_trim(&super::power::js_slice(js_trim(&collapsed), CRITICAL_MAX)).to_string();
    (!t.is_empty()).then_some(t)
}

/// A critical level: a whole number from 0 (none); anything else is 0.
pub fn clean_level(v: &Value) -> u64 {
    let text = match v {
        Value::Null => String::new(),
        v => super::js::to_string(v),
    };
    let t = js_trim(&text);
    if t.is_empty() || t.len() > 6 || !t.bytes().all(|c| c.is_ascii_digit()) {
        return 0;
    }
    t.parse::<u64>().map(|n| n.min(MAX_LEVEL)).unwrap_or(0)
}

/// CRITICAL_UPDATE.txt as the image build reads it: (level, reason).
pub fn critical_from_file(text: &str) -> (u64, Option<String>) {
    let mut level = 0;
    let mut reason: Option<String> = None;
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.trim_start().starts_with('#') {
            continue;
        }
        let l = line.trim_start();
        let Some((k, rest)) = l.split_once(':') else { continue };
        match k.to_ascii_lowercase().as_str() {
            "level" => level = clean_level(&json!(rest)),
            "reason" => {
                let t: String = rest.chars().filter_map(|c| if c == '\t' || c == '\r' { Some(' ') } else if matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}' | '"' | '\'' | '`' | '\\') { None } else { Some(c) }).collect();
                reason = clean_critical(&json!(t.replace(',', ";")));
            }
            _ => {}
        }
    }
    if level > 0 && reason.is_some() {
        (level, reason)
    } else {
        (0, None)
    }
}

/// The state before any check.
fn fresh_state() -> Value {
    json!({ "latest": null, "checkedAt": 0, "error": null })
}

pub struct ImageUpdates {
    ctx: Arc<dyn OpsCtx>,
    notes: Option<Arc<Notes>>,
    transport: Arc<dyn Transport>,
    registry: Option<String>,
    repo: Option<String>,
    tag: Option<String>,
    current: Value,
    pub enabled: bool,
    state: Mutex<Value>,
    /// the kept state has been read: until it is, nothing is answered, checked, written or
    /// announced (it holds the critical fix seen, which a later image without one must not clear)
    read: std::sync::atomic::AtomicBool,
    last_check: Mutex<i64>,
    started_at: i64,
    own_level: u64,
}

impl ImageUpdates {
    pub fn new(ctx: Arc<dyn OpsCtx>, notes: Option<Arc<Notes>>, transport: Arc<dyn Transport>, build_info: &Value, enabled: bool, own_level: u64) -> ImageUpdates {
        let image = super::js::to_string(if build_info["image"].is_null() { &Value::Null } else { &build_info["image"] });
        let image = if build_info["image"].is_null() { String::new() } else { image };
        let (registry, repo) = parse_image(&image).map_or((None, None), |(a, b)| (Some(a), Some(b)));
        let tag_text = if build_info["tag"].is_null() { String::new() } else { super::js::to_string(&build_info["tag"]) };
        let tag = tag_ok(&tag_text).then(|| build_info["tag"].clone()).and_then(|t| t.as_str().map(String::from).or(Some(tag_text.clone())));
        let or_null = |v: &Value| if truthy(v) { v.clone() } else { Value::Null };
        let current = json!({ "sha": or_null(&build_info["sha"]), "build": clean_build(&build_info["build"]), "builtAt": or_null(&build_info["builtAt"]) });
        let enabled = enabled && registry.is_some() && repo.is_some() && tag.is_some();
        let (state, read) = match store::get_or(&ctx.read_db(), "image-updates", fresh_state()) {
            Ok(s) => (s, true),
            Err(e) => {
                ctx.log("updates", Level::Error, &format!("The last update check could not be read (updates are not shown or checked until it can): {e}"));
                (fresh_state(), false)
            }
        };
        ImageUpdates { ctx, notes, transport, registry, repo, tag, current, enabled, state: Mutex::new(state), read: read.into(), last_check: Mutex::new(0), started_at: now_ms(), own_level }
    }

    /// The kept state, read again while it could not be read before; an error while it cannot be.
    /// (read under the state's lock: a check that wrote a newer one meanwhile is never undone)
    fn kept(&self) -> store::DbResult<()> {
        use std::sync::atomic::Ordering::SeqCst;
        if self.read.load(SeqCst) {
            return Ok(());
        }
        let mut st = self.state.lock().unwrap();
        if self.read.load(SeqCst) {
            return Ok(());
        }
        *st = store::get_or(&self.ctx.read_db(), "image-updates", fresh_state())?;
        self.read.store(true, SeqCst);
        Ok(())
    }

    /// Allows a test to start the minute between checks over.
    pub fn forget_last_check(&self) {
        *self.last_check.lock().unwrap() = 0;
    }

    pub fn set_transport(&mut self, t: Arc<dyn Transport>) {
        self.transport = t;
    }

    /// An error while the kept state cannot be read (not "no update").
    pub fn status(&self) -> store::DbResult<Value> {
        self.kept()?;
        let st = self.state.lock().unwrap().clone();
        Ok(json!({
            "enabled": self.enabled,
            "image": self.repo.as_ref().map(|r| format!("{}/{}", self.registry.as_deref().unwrap_or(""), r)),
            "tag": self.tag,
            "current": self.current,
            "latest": st.get("latest").cloned().unwrap_or(Value::Null),
            "checkedAt": if truthy(&st["checkedAt"]) { st["checkedAt"].clone() } else { Value::Null },
            "error": st.get("error").cloned().unwrap_or(Value::Null),
            "updateAvailable": self.update_available(),
            "buildsBehind": self.builds_behind(),
            "critical": self.critical()
        }))
    }

    /// While an image with a critical fix this one lacks is out: { level, reason, created }.
    pub fn critical(&self) -> Value {
        let st = self.state.lock().unwrap();
        let c = &st["critical"];
        if !self.enabled || !truthy(c) || clean_level(&c["level"]) <= self.own_level {
            return Value::Null;
        }
        json!({
            "level": clean_level(&c["level"]),
            "reason": clean_critical(&c["reason"]).unwrap_or_else(|| "A critical fix is out.".into()),
            "created": if truthy(&c["created"]) { c["created"].clone() } else { Value::Null }
        })
    }

    pub fn builds_behind(&self) -> Option<u64> {
        let latest = clean_build(&self.state.lock().unwrap()["latest"]["build"]);
        let mine = clean_build(&self.current["build"]);
        if !self.enabled {
            return None;
        }
        Some(latest?.saturating_sub(mine?))
    }

    pub fn update_available(&self) -> bool {
        let latest = self.state.lock().unwrap()["latest"].clone();
        if !self.enabled || !truthy(&latest) {
            return false;
        }
        if let Some(b) = self.builds_behind() {
            return b > 0;
        }
        if truthy(&latest["revision"]) && truthy(&self.current["sha"]) && latest["revision"] != self.current["sha"] {
            return true;
        }
        let a = latest["created"].as_str().and_then(parse_date);
        let b = self.current["builtAt"].as_str().and_then(parse_date);
        matches!((a, b), (Some(a), Some(b)) if a > b)
    }

    pub fn tick(&self) {
        // (a kept state that cannot be read: said at the start, tried again at the next tick)
        if !self.enabled || self.kept().is_err() {
            return;
        }
        let checked = self.state.lock().unwrap()["checkedAt"].as_f64().unwrap_or(0.0) as i64;
        let since = now_ms() - checked;
        let first_since_start = checked < self.started_at;
        if since >= CHECK_MS || (first_since_start && since >= STARTUP_CHECK_MS) {
            let _ = self.check();
        }
    }

    /// An error while the kept state cannot be read: no check runs over it.
    pub fn check(&self) -> store::DbResult<Value> {
        self.kept()?;
        if !self.enabled {
            return self.status();
        }
        {
            let mut last = self.last_check.lock().unwrap();
            if now_ms() - *last < MIN_CHECK_GAP_MS {
                return self.status();
            }
            *last = now_ms();
        }
        let got = self.fetch_latest();
        {
            let mut st = self.state.lock().unwrap();
            match got {
                Ok(latest) => {
                    let seen = st["critical"].clone();
                    let level = latest["criticalLevel"].as_u64().unwrap_or(0);
                    let critical = if level > clean_level(&seen["level"]) {
                        json!({ "level": level, "reason": latest["critical"], "created": latest["created"] })
                    } else if truthy(&seen) {
                        seen
                    } else {
                        Value::Null
                    };
                    *st = json!({ "latest": latest, "critical": critical, "checkedAt": now_ms(), "error": null });
                }
                Err(e) => {
                    st["checkedAt"] = json!(now_ms());
                    st["error"] = json!(e);
                    drop(st);
                    self.ctx.log("updates", Level::Warn, &format!("Could not check for a newer image: {e}"));
                    st = self.state.lock().unwrap();
                }
            }
            if let Err(e) = store::set(&self.ctx.db(), "image-updates", &st) {
                self.ctx.log("updates", Level::Warn, &format!("The update check was not kept: {e}"));
            }
        }
        self.announce();
        self.status()
    }

    /// Raises the notification while an update is out, clears it once installed (what was not
    /// kept is logged); nothing while the kept state cannot be read.
    pub fn announce(&self) {
        if self.kept().is_err() {
            return;
        }
        if let Err(e) = self.notify() {
            self.ctx.log("updates", Level::Warn, &format!("The update notification was not kept: {e}"));
        }
    }

    fn notify(&self) -> super::store::DbResult<()> {
        let Some(notes) = &self.notes else { return Ok(()) };
        let critical = self.critical();
        if truthy(&critical) {
            notes.raise(&Note::new("update", "critical", "Critical update: install now").key("image-update-critical").message(format!(
                "{} To install it, run \"docker compose pull && docker compose up -d\" where you set up Sentry Six Manager (TrueNAS: see Updates in the README).",
                critical["reason"].as_str().unwrap_or("")
            )))?;
        } else {
            notes.resolve("image-update-critical")?;
        }
        if !self.update_available() {
            return notes.resolve("image-update");
        }
        let l = self.state.lock().unwrap()["latest"].clone();
        let build = clean_build(&l["build"]).map(|b| format!(" (Build {b})")).unwrap_or_default();
        let on = l["created"].as_str().filter(|s| !s.is_empty()).map(|c| format!(" on {}", c.chars().take(10).collect::<String>())).unwrap_or_default();
        notes.raise(&Note::new("update", "info", "An update is available").key("image-update").message(format!(
            "A newer {} image{build} was published{on}. To install it, run \"docker compose pull && docker compose up -d\" where you set up Sentry Six Manager.",
            self.tag.as_deref().unwrap_or("")
        )))?;
        Ok(())
    }

    fn request(&self, url: &str, headers: Vec<(String, String)>) -> Result<HttpRes, String> {
        let mut h = vec![("User-Agent".to_string(), "sentry-six-manager".to_string())];
        h.extend(headers);
        self.transport.request(&HttpReq {
            method: "GET".into(),
            url: url.into(),
            headers: h,
            body: None,
            timeout_ms: 20_000,
            follow_redirects: true,
            max_body: MAX_BODY,
            too_much: "the registry answered with too much data".into(),
        })
    }

    fn fetch_latest(&self) -> Result<Value, String> {
        let repo = self.repo.clone().unwrap_or_default();
        let base = format!("https://{}/v2/{repo}", self.registry.as_deref().unwrap_or(""));
        let tag = self.tag.clone().unwrap_or_default();
        let mut auth: Option<String> = None;
        let get = |auth: &mut Option<String>, p: &str, accept: &str| -> Result<(Value, Option<String>), String> {
            let mut hdr = vec![("Accept".to_string(), accept.to_string())];
            if let Some(a) = auth.as_ref() {
                hdr.push(("Authorization".into(), a.clone()));
            }
            let mut r = self.request(&format!("{base}/{p}"), hdr.clone())?;
            if r.status == 401 && auth.is_none() {
                let ch = r.header("www-authenticate").and_then(parse_challenge).ok_or("the registry asked for a sign-in this check cannot do")?;
                let get_ch = |k: &str| ch.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone());
                let realm = get_ch("realm").unwrap_or_default();
                let lower = realm.to_ascii_lowercase();
                let scheme_end = lower.find(':').ok_or("Invalid URL")?;
                if !lower[..scheme_end].bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'-' | b'.')) || !lower.as_bytes()[0].is_ascii_alphabetic() {
                    return Err("Invalid URL".into());
                }
                if &lower[..scheme_end] != "https" {
                    return Err("the registry offered a sign-in without HTTPS".into());
                }
                let (without_hash, _) = realm.split_once('#').unwrap_or((&realm, ""));
                let (path, query) = without_hash.split_once('?').unwrap_or((without_hash, ""));
                let mut pairs: Vec<(String, String)> = query.split('&').filter(|x| !x.is_empty()).map(|kv| {
                    let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
                    (k.to_string(), v.to_string())
                }).collect();
                let mut set = |k: &str, v: &str| {
                    let enc = form_encode(v);
                    if let Some(i) = pairs.iter().position(|(x, _)| x == k) {
                        pairs[i].1 = enc;
                        let mut n = 0;
                        pairs.retain(|(x, _)| x != k || { n += 1; n == 1 });
                    } else {
                        pairs.push((k.to_string(), enc));
                    }
                };
                if let Some(s) = get_ch("service").filter(|s| !s.is_empty()) {
                    set("service", &s);
                }
                set("scope", &get_ch("scope").filter(|s| !s.is_empty()).unwrap_or_else(|| format!("repository:{repo}:pull")));
                let href = format!("{path}?{}", pairs.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&"));
                let t = self.request(&href, Vec::new())?;
                let body: Value = if t.status == 200 { serde_json::from_slice(&t.body).map_err(|e| e.to_string())? } else { json!({}) };
                let token = [&body["token"], &body["access_token"]].into_iter().find(|v| truthy(v)).map(super::js::to_string);
                let Some(token) = token else { return Err(format!("the registry refused an anonymous check ({}); is the image public?", t.status)) };
                *auth = Some(format!("Bearer {token}"));
                let mut hdr = vec![("Accept".to_string(), accept.to_string())];
                hdr.push(("Authorization".into(), auth.clone().unwrap()));
                r = self.request(&format!("{base}/{p}"), hdr)?;
            }
            if r.status == 404 {
                return Err(format!("no image tagged {tag}"));
            }
            if r.status != 200 {
                return Err(format!("the registry answered {}", r.status));
            }
            let json: Value = serde_json::from_slice(&r.body).map_err(|e| e.to_string())?;
            Ok((json, r.header("docker-content-digest").map(String::from)))
        };

        let (mut manifest, mut digest) = get(&mut auth, &format!("manifests/{tag}"), ACCEPT)?;
        if let Some(list) = manifest["manifests"].as_array() {
            let mine = list.iter().find(|m| m["platform"]["os"] == "linux" && m["platform"]["architecture"] == arch());
            let d = mine.and_then(|m| m["digest"].as_str()).filter(|d| digest_ok(d)).ok_or_else(|| format!("the {tag} image has no linux/{} build", arch()))?.to_string();
            digest = Some(d.clone());
            manifest = get(&mut auth, &format!("manifests/{d}"), ACCEPT)?.0;
        }
        let config_digest = manifest["config"]["digest"].as_str().filter(|d| digest_ok(d)).ok_or("the registry sent an unexpected manifest")?.to_string();
        let (config, _) = get(&mut auth, &format!("blobs/{config_digest}"), "application/json")?;
        let labels = if truthy(&config["config"]["Labels"]) { config["config"]["Labels"].clone() } else { json!({}) };
        let revision = labels["org.opencontainers.image.revision"].as_str().filter(|r| (7..=64).contains(&r.len()) && r.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
        let version = if labels[VERSION_LABEL].is_null() { String::new() } else { super::js::to_string(&labels[VERSION_LABEL]) };
        let vt = version.trim();
        let build = (vt.len() > 6 && vt.len() <= 15 && vt[..6].eq_ignore_ascii_case("build-") && vt[6..].bytes().all(|c| c.is_ascii_digit())).then(|| clean_build(&json!(vt))).flatten();
        let created = [&labels["org.opencontainers.image.created"], &config["created"]].into_iter().find(|v| truthy(v)).cloned().unwrap_or(Value::Null);
        let reason = clean_critical(&labels[CRITICAL_LABEL]);
        let level = if reason.is_some() { clean_level(&labels[CRITICAL_LEVEL_LABEL]) } else { 0 };
        Ok(json!({
            "digest": digest.filter(|d| digest_ok(d)).unwrap_or(config_digest),
            "revision": revision,
            "build": build,
            "created": created,
            "criticalLevel": level,
            "critical": if level > 0 { json!(reason) } else { Value::Null }
        }))
    }
}

/// The critical level this image was built with (APP_ROOT/CRITICAL_UPDATE.txt).
pub fn own_critical_level(app_root: &std::path::Path) -> u64 {
    std::fs::read_to_string(app_root.join("CRITICAL_UPDATE.txt")).map(|t| critical_from_file(&t).0).unwrap_or(0)
}

/// For the log: a time as ISO text.
pub fn when(ms: i64) -> String {
    iso(ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::testing::FakeCtx;
    use std::sync::Mutex as M;

    const IMAGE: &str = "ghcr.io/owner/sentry-six-manager";

    fn digest(c: char) -> String {
        format!("sha256:{}", c.to_string().repeat(64))
    }

    #[derive(Clone, Default)]
    struct Release {
        revision: Option<String>,
        created: Option<String>,
        version: Option<String>,
        critical: Option<String>,
        level: Option<String>,
        token_status: Option<u16>,
        realm: Option<String>,
    }

    struct Registry {
        r: Release,
        calls: M<Vec<String>>,
    }

    fn res(status: u16, body: Value, headers: Vec<(&str, String)>) -> HttpRes {
        HttpRes { status, headers: headers.into_iter().map(|(k, v)| (k.to_string(), v)).collect(), body: body.to_string().into_bytes() }
    }

    impl Transport for Registry {
        fn request(&self, q: &HttpReq) -> Result<HttpRes, String> {
            self.calls.lock().unwrap().push(q.url.clone());
            let realm = self.r.realm.clone().unwrap_or_else(|| "https://ghcr.io/token".into());
            let authed = q.headers.iter().any(|(k, v)| k == "Authorization" && v == "Bearer t0k3n");
            let path_only = q.url.split('?').next().unwrap();
            if path_only == realm {
                assert!(q.url.contains("scope=repository%3Aowner%2Fsentry-six-manager%3Apull"), "{}", q.url);
                let s = self.r.token_status.unwrap_or(200);
                return Ok(res(s, if s == 200 { json!({ "token": "t0k3n" }) } else { json!({ "errors": [{ "code": "DENIED" }] }) }, vec![]));
            }
            if !authed {
                return Ok(res(401, json!({}), vec![("www-authenticate", format!("Bearer realm=\"{realm}\",service=\"ghcr.io\",scope=\"repository:owner/sentry-six-manager:pull\""))]));
            }
            let p = q.url.strip_prefix("https://ghcr.io").unwrap_or("");
            let mine = if arch() == "amd64" { '1' } else { '2' };
            if p == "/v2/owner/sentry-six-manager/manifests/latest" {
                return Ok(res(200, json!({ "manifests": [
                    { "digest": digest('1'), "platform": { "os": "linux", "architecture": "amd64" } },
                    { "digest": digest('2'), "platform": { "os": "linux", "architecture": "arm64" } }
                ] }), vec![("docker-content-digest", digest('9'))]));
            }
            if p == format!("/v2/owner/sentry-six-manager/manifests/{}", digest(mine)) {
                return Ok(res(200, json!({ "config": { "digest": digest('c') } }), vec![]));
            }
            if p == format!("/v2/owner/sentry-six-manager/blobs/{}", digest('c')) {
                let created = self.r.created.clone().unwrap_or_else(|| "2026-10-20T04:00:00Z".into());
                let mut labels = json!({ "org.opencontainers.image.revision": self.r.revision.clone().unwrap_or_else(|| "c".repeat(40)), "org.opencontainers.image.created": created });
                if let Some(v) = &self.r.version { labels[VERSION_LABEL] = json!(v); }
                if let Some(v) = &self.r.critical { labels[CRITICAL_LABEL] = json!(v); }
                if let Some(v) = &self.r.level { labels[CRITICAL_LEVEL_LABEL] = json!(v); }
                return Ok(res(200, json!({ "created": created, "config": { "Labels": labels } }), vec![]));
            }
            Ok(res(404, json!({}), vec![]))
        }
    }

    fn reg(r: Release) -> Arc<Registry> {
        Arc::new(Registry { r, calls: M::new(Vec::new()) })
    }

    fn build(over: Value) -> Value {
        let mut b = json!({ "sha": "b".repeat(40), "builtAt": "2026-10-13T04:00:00Z", "image": IMAGE, "tag": "latest" });
        for (k, v) in over.as_object().unwrap() {
            b[k] = v.clone();
        }
        b
    }

    fn open_keys(ctx: &FakeCtx) -> Vec<String> {
        store::list(&ctx.db(), true, 200, None).unwrap().iter().map(|n| n["dedupeKey"].as_str().unwrap_or("").to_string()).collect()
    }

    #[test]
    fn a_newer_commit_is_an_update_and_the_notice_says_how_to_install() {
        let ctx = FakeCtx::new();
        let notes = Notes::new(ctx.clone());
        let r = reg(Release::default());
        let u = ImageUpdates::new(ctx.clone(), Some(notes), r.clone(), &build(json!({})), true, 0);
        let st = u.check().unwrap();
        assert_eq!(st["error"], Value::Null);
        assert_eq!(st["updateAvailable"], true);
        assert_eq!(st["latest"]["revision"], "c".repeat(40));
        assert_eq!(st["latest"]["digest"], digest(if arch() == "amd64" { '1' } else { '2' }));
        let n = store::list(&ctx.db(), true, 200, None).unwrap();
        assert!(n[0]["message"].as_str().unwrap().contains("docker compose pull && docker compose up -d"));
    }

    #[test]
    fn the_running_image_is_not_an_update_and_an_old_notice_is_cleared() {
        let ctx = FakeCtx::new();
        let notes = Notes::new(ctx.clone());
        notes.raise(&Note::new("update", "info", "old").key("image-update")).unwrap();
        let r = reg(Release { revision: Some("b".repeat(40)), created: Some("2026-10-13T04:00:00Z".into()), ..Default::default() });
        let u = ImageUpdates::new(ctx.clone(), Some(notes), r, &build(json!({})), true, 0);
        assert_eq!(u.check().unwrap()["updateAvailable"], false);
        assert!(open_keys(&ctx).is_empty());
        // the weekly rebuild of the same commit is an update
        let ctx = FakeCtx::new();
        let u = ImageUpdates::new(ctx, None, reg(Release { revision: Some("b".repeat(40)), ..Default::default() }), &build(json!({})), true, 0);
        assert_eq!(u.check().unwrap()["updateAvailable"], true);
    }

    #[test]
    fn a_build_without_an_image_never_contacts_anything() {
        for over in [json!({ "image": "", "tag": "" }), json!({ "image": "http://evil/x" }), json!({ "tag": "../../x" }), json!({ "image": "ghcr.io/Owner/X" })] {
            let r = reg(Release::default());
            let u = ImageUpdates::new(FakeCtx::new(), None, r.clone(), &build(over.clone()), true, 0);
            assert_eq!(u.check().unwrap()["enabled"], false, "{over}");
            assert!(r.calls.lock().unwrap().is_empty());
        }
        let u = ImageUpdates::new(FakeCtx::new(), None, reg(Release::default()), &build(json!({})), false, 0);
        assert_eq!(u.check().unwrap()["enabled"], false);
    }

    #[test]
    fn registry_problems_are_reported() {
        let u = ImageUpdates::new(FakeCtx::new(), None, reg(Release { token_status: Some(403), ..Default::default() }), &build(json!({})), true, 0);
        let st = u.check().unwrap();
        assert!(st["error"].as_str().unwrap().contains("is the image public"));
        assert_eq!(st["updateAvailable"], false);
        let u = ImageUpdates::new(FakeCtx::new(), None, reg(Release { realm: Some("http://ghcr.io/token".into()), ..Default::default() }), &build(json!({})), true, 0);
        assert!(u.check().unwrap()["error"].as_str().unwrap().contains("without HTTPS"));
        let u = ImageUpdates::new(FakeCtx::new(), None, reg(Release::default()), &build(json!({ "tag": "nope" })), true, 0);
        assert!(u.check().unwrap()["error"].as_str().unwrap().contains("no image tagged nope"));
    }

    #[test]
    fn checks_are_spaced_out_and_the_result_survives_a_restart() {
        let ctx = FakeCtx::new();
        let r = reg(Release::default());
        let u = ImageUpdates::new(ctx.clone(), None, r.clone(), &build(json!({})), true, 0);
        u.check().unwrap();
        let n = r.calls.lock().unwrap().len();
        u.check().unwrap();
        assert_eq!(r.calls.lock().unwrap().len(), n);
        let after = ImageUpdates::new(ctx.clone(), None, r.clone(), &build(json!({})), true, 0);
        assert_eq!(after.status().unwrap()["updateAvailable"], true);
        after.tick();
        assert_eq!(r.calls.lock().unwrap().len(), n);
    }

    #[test]
    fn build_numbers() {
        let ctx = FakeCtx::new();
        let notes = Notes::new(ctx.clone());
        let u = ImageUpdates::new(ctx.clone(), Some(notes), reg(Release { version: Some("build-131".into()), ..Default::default() }), &build(json!({ "build": 128 })), true, 0);
        let st = u.check().unwrap();
        assert_eq!(st["current"], json!({ "sha": "b".repeat(40), "build": 128, "builtAt": "2026-10-13T04:00:00Z" }));
        assert_eq!(st["latest"]["build"], 131);
        assert_eq!(st["buildsBehind"], 3);
        assert!(store::list(&ctx.db(), true, 200, None).unwrap()[0]["message"].as_str().unwrap().contains("A newer latest image (Build 131) was published"));
        for v in ["build-128", "build-120"] {
            let ctx = FakeCtx::new();
            let u = ImageUpdates::new(ctx.clone(), Some(Notes::new(ctx.clone())), reg(Release { version: Some(v.into()), created: Some("2026-10-30T04:00:00Z".into()), ..Default::default() }), &build(json!({ "build": 128 })), true, 0);
            let st = u.check().unwrap();
            assert_eq!(st["buildsBehind"], 0);
            assert_eq!(st["updateAvailable"], false);
            assert!(open_keys(&ctx).is_empty());
        }
        for v in ["131", "build-", "build-1x", "v2026.1", "build-0"] {
            let u = ImageUpdates::new(FakeCtx::new(), None, reg(Release { version: Some(v.into()), ..Default::default() }), &build(json!({ "build": 128 })), true, 0);
            assert_eq!(u.check().unwrap()["latest"]["build"], Value::Null, "{v}");
        }
        let old = ImageUpdates::new(FakeCtx::new(), None, reg(Release { version: Some("build-131".into()), ..Default::default() }), &build(json!({})), true, 0);
        let st = old.check().unwrap();
        assert_eq!(st["buildsBehind"], Value::Null);
        assert_eq!(st["updateAvailable"], true);
    }

    #[test]
    fn challenges_and_critical_text() {
        let ch = parse_challenge("Bearer realm=\"https://ghcr.io/token\",service=\"ghcr.io\",scope=\"repository:a/b:pull\"").unwrap();
        assert_eq!(ch, vec![("realm".into(), "https://ghcr.io/token".into()), ("service".into(), "ghcr.io".into()), ("scope".into(), "repository:a/b:pull".into())]);
        assert!(parse_challenge("Basic realm=\"x\"").is_none());
        assert!(parse_challenge("").is_none());
        assert_eq!(clean_critical(&json!(42)), None);
        assert_eq!(clean_critical(&json!("x".repeat(5000))).unwrap().len(), 300);
        assert_eq!(clean_critical(&json!(" a\u{202e}b\r\nc  ")).as_deref(), Some("a b c"));
        assert_eq!(critical_from_file("# c\nlevel: 2\nreason: Fix it\n"), (2, Some("Fix it".into())));
        assert_eq!(critical_from_file("level: 2\nreason:\n"), (0, None));
        assert_eq!(critical_from_file("level: 3\nreason:  Fix \"x\" `id` $(id), \\ it's\tbad\n# reason: note\n"), (3, Some("Fix x id $(id); its bad".into())));
        assert_eq!(critical_from_file("  LEVEL: 1\n  Reason: a: b\n"), (1, Some("a: b".into())));
        assert_eq!(critical_from_file(&format!("level: 0012\r\nreason: {}\r\n", "y".repeat(400))).1.unwrap().len(), 300);
        for (c, l) in [("", Some("1")), ("   ", Some("1")), ("Fix", None), ("Fix", Some("x")), ("Fix", Some("-1")), ("Fix", Some("1e3")), ("Fix", Some("0"))] {
            let u = ImageUpdates::new(FakeCtx::new(), None, reg(Release { critical: Some(c.into()), level: l.map(String::from), ..Default::default() }), &build(json!({})), true, 0);
            assert_eq!(u.check().unwrap()["critical"], Value::Null, "{c:?} {l:?}");
        }
    }

    #[test]
    fn critical_releases() {
        let a = Release { revision: Some("a".repeat(40)), created: Some("2026-10-20T04:00:00Z".into()), critical: Some("Fixes a bug that\ncan delete footage\u{7}".into()), level: Some("1".into()), ..Default::default() };
        let b = Release { revision: Some("d".repeat(40)), created: Some("2026-10-22T04:00:00Z".into()), critical: Some("Fixes a bug that can delete footage".into()), level: Some("1".into()), ..Default::default() };
        let c = Release { revision: Some("e".repeat(40)), created: Some("2026-10-25T04:00:00Z".into()), critical: Some("Closes a sign-in hole".into()), level: Some("2".into()), ..Default::default() };
        let at = |u: &mut ImageUpdates, r: &Release| {
            u.set_transport(reg(r.clone()));
            u.forget_last_check();
            u.check().unwrap()
        };
        // (1) an older server sees A, with a notification of its own
        let ctx = FakeCtx::new();
        let mut u = ImageUpdates::new(ctx.clone(), Some(Notes::new(ctx.clone())), reg(Release::default()), &build(json!({})), true, 0);
        let st = at(&mut u, &a);
        assert_eq!(st["critical"], json!({ "level": 1, "reason": "Fixes a bug that can delete footage", "created": "2026-10-20T04:00:00Z" }));
        let keys = open_keys(&ctx);
        assert!(keys.contains(&"image-update-critical".to_string()) && keys.contains(&"image-update".to_string()));
        // (2) a bug fix B after A does not cancel it; (3) nor B without labels, also after a restart
        assert_eq!(at(&mut u, &b)["critical"]["level"], 1);
        assert_eq!(at(&mut u, &Release { revision: b.revision.clone(), created: b.created.clone(), ..Default::default() })["critical"]["level"], 1);
        assert_eq!(ImageUpdates::new(ctx.clone(), None, reg(Release::default()), &build(json!({})), true, 0).status().unwrap()["critical"]["level"], 1);
        // (4) installing B clears it and its notification
        let mut after = ImageUpdates::new(ctx.clone(), Some(Notes::new(ctx.clone())), reg(Release::default()), &build(json!({ "sha": "d".repeat(40), "builtAt": "2026-10-22T04:00:00Z" })), true, 1);
        after.announce();
        assert_eq!(after.status().unwrap()["critical"], Value::Null);
        assert!(!open_keys(&ctx).contains(&"image-update-critical".to_string()));
        let st = at(&mut after, &b);
        assert_eq!(st["updateAvailable"], false);
        assert!(open_keys(&ctx).is_empty());
        // (5) a second critical release is critical again
        let st = at(&mut after, &c);
        assert_eq!(st["critical"], json!({ "level": 2, "reason": "Closes a sign-in hole", "created": "2026-10-25T04:00:00Z" }));
    }

    #[test]
    fn the_first_check_after_a_start_comes_within_minutes() {
        let ctx = FakeCtx::new();
        store::set(&ctx.db(), "image-updates", &json!({ "latest": null, "checkedAt": now_ms() - 11 * 60 * 1000, "error": null })).unwrap();
        let r = reg(Release::default());
        let u = ImageUpdates::new(ctx, None, r.clone(), &build(json!({})), true, 0);
        u.tick();
        let n = r.calls.lock().unwrap().len();
        assert!(n > 0);
        u.forget_last_check();
        u.tick();
        assert_eq!(r.calls.lock().unwrap().len(), n);
    }

    #[test]
    fn the_committed_critical_file_is_well_formed() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let text = std::fs::read_to_string(root.join("CRITICAL_UPDATE.txt")).unwrap();
        let (level, reason) = critical_from_file(&text);
        assert_eq!(level > 0, reason.is_some());
    }

    #[test]
    fn a_kept_check_that_cannot_be_read_is_an_error_until_it_can_never_no_update() {
        let ctx = FakeCtx::new();
        let notes = Notes::new(ctx.clone());
        let seen = json!({ "latest": null, "critical": { "level": 2, "reason": "Closes a sign-in hole", "created": "2026-10-25T04:00:00Z" }, "checkedAt": 1, "error": null });
        store::set(&ctx.db(), "image-updates", &seen).unwrap();
        notes.raise(&Note::new("update", "critical", "Critical update: install now").key("image-update-critical")).unwrap();
        ctx.db().execute_batch("CREATE TABLE gone (x); ALTER TABLE settings RENAME TO settings_kept; CREATE VIEW settings AS SELECT * FROM gone; DROP TABLE gone;").unwrap();
        let r = reg(Release::default());
        let u = ImageUpdates::new(ctx.clone(), Some(notes), r.clone(), &build(json!({})), true, 0);
        assert!(u.status().is_err(), "not \"no update\"");
        assert!(u.check().is_err(), "no check over what could not be read");
        u.announce();
        u.tick();
        assert!(r.calls.lock().unwrap().is_empty(), "nothing asked of the registry meanwhile");
        assert_eq!(open_keys(&ctx), ["image-update-critical"], "its notice is not cleared meanwhile");
        ctx.db().execute_batch("DROP VIEW settings; ALTER TABLE settings_kept RENAME TO settings;").unwrap();
        assert_eq!(store::get(&ctx.db(), "image-updates").unwrap(), Some(seen), "never written over meanwhile");
        assert_eq!(u.status().unwrap()["critical"]["level"], 2, "the critical fix seen, once it can be read");
        assert_eq!(ctx.logs.lock().unwrap().iter().filter(|(s, _, t)| s == "updates" && t.starts_with("The last update check could not be read")).count(), 1);
    }

    #[test]
    fn a_kept_state_read_again_never_goes_over_a_newer_one_a_check_wrote_meanwhile() {
        use std::sync::atomic::Ordering::SeqCst;
        let ctx = FakeCtx::new();
        let state = |build: u64| json!({ "latest": { "build": build }, "checkedAt": build, "error": null });
        store::set(&ctx.db(), "image-updates", &state(1)).unwrap();
        ctx.db().execute_batch("CREATE TABLE gone (x); ALTER TABLE settings RENAME TO settings_kept; CREATE VIEW settings AS SELECT * FROM gone; DROP TABLE gone;").unwrap();
        let u = Arc::new(ImageUpdates::new(ctx.clone(), None, reg(Release::default()), &build(json!({})), true, 0));
        ctx.db().execute_batch("DROP VIEW settings; ALTER TABLE settings_kept RENAME TO settings;").unwrap();
        // a check holds the state (it writes what it found under its lock) while the status reads it again
        let mut held = u.state.lock().unwrap();
        let reads = ctx.reads.load(SeqCst);
        let u2 = u.clone();
        let status = std::thread::spawn(move || u2.status().unwrap()["latest"]["build"].clone());
        // (a read that does not wait for the lock starts at once: this waits for it to be done)
        let t = std::time::Instant::now();
        while ctx.reads.load(SeqCst) == reads && t.elapsed() < std::time::Duration::from_secs(1) {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        *held = state(2);
        u.read.store(true, SeqCst);
        store::set(&ctx.db(), "image-updates", &state(2)).unwrap();
        drop(held);
        assert_eq!(status.join().unwrap(), 2, "not the older state read before the check wrote");
        assert_eq!(u.status().unwrap()["latest"]["build"], 2);
    }
}
