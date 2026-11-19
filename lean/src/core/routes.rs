//! Core's routes (index.js): accounts, sessions and access; HTTPS
//! certificates; logs; jobs. `/api/events` is answered by the request
//! handler itself (server.rs), as in Node.

use super::access::validate as validate_access;
use super::accounts::{js_string, truthy};
use super::client_addr::ban_key;
use super::http::{number_or, Access, Ctx, HttpError, Reply, Router};
use super::log::{iso, parse_iso, Search};
use super::server::BANNED_TEXT;
use axum::http::{header, Method, Response};
use serde_json::{json, Map, Value};

const PENDING_COOKIE: &str = "sm_pending";

fn pending_token(c: &Ctx) -> Option<String> {
    super::auth::parse_cookies(c.header("cookie"))
        .get(PENDING_COOKIE)
        .filter(|t| (20..=80).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
        .cloned()
}

fn pending_cookie(c: &Ctx, value: &str, max_age: i64) -> String {
    format!("{PENDING_COOKIE}={value}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age}{}", if c.secure { "; Secure" } else { "" })
}

fn banned() -> HttpError {
    HttpError::new(429, BANNED_TEXT).code("BANNED")
}

/// A banned address gets this on every sign-in step.
fn refuse_banned(c: &Ctx) -> Result<(), HttpError> {
    if c.state.access.banned(&c.client).is_some() {
        return Err(banned());
    }
    Ok(())
}

/// One failed attempt from this address; a ban it brings from a signed-in session signs that session out.
/// A 500 when that ban could not be saved (it holds in memory; the session stays, as Node stops at the
/// failed save) or that session could not be signed out (it would still work from another address).
fn failed_attempt(c: &Ctx, reason: &str, session: bool) -> Result<bool, HttpError> {
    let banned = c.state.access.fail(&c.client, reason)?.is_some();
    if banned && session {
        if let Some(h) = c.state.auth.session_hash(&c.view()) {
            c.state.db.delete_session(&h)?;
        }
    }
    Ok(banned)
}

fn too_many(wait: i64) -> HttpError {
    HttpError::new(429, format!("Too many attempts. Try again in {wait} s."))
}

/// One password check at a time per throttle key (auth.attempt).
fn guarded<T>(c: &Ctx, keys: &[String], check: impl FnOnce() -> T) -> Result<T, HttpError> {
    c.state.auth.attempt(keys, check).map_err(|e| HttpError::new(429, e.message))
}

/// String(x).slice(0, n) in UTF-16 units.
fn cut(s: &str, n: usize) -> String {
    let u: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&u)
}

fn me(c: &mut Ctx) -> Result<Reply, HttpError> {
    let st = &c.state;
    let user = st.auth.user(&c.view())?;
    let home = st.from_home(&c.client);
    let rules = st.access.get();
    let admin = match &user {
        Some(u) => st.accounts.is_admin(u)?,
        None => false,
    };
    let limited = match &user {
        Some(_) if admin && !home => {
            if truthy(&rules["homeOnly"]["adminPages"]) {
                Some("pages")
            } else if truthy(&rules["homeOnly"]["adminChanges"]) {
                Some("changes")
            } else {
                None
            }
        }
        _ => None,
    };
    let mut out = Map::new();
    out.insert("user".into(), json!(user));
    out.insert("role".into(), json!(match &user {
        Some(u) => st.role_for(&c.client, u)?,
        None => None,
    }));
    out.insert("twoFactor".into(), json!(match &user {
        Some(u) => st.accounts.two_factor_on(u)?,
        None => false,
    }));
    let needs = st.auth.needs_setup()?;
    out.insert("needsSetup".into(), json!(needs));
    out.insert("secure".into(), json!(c.secure));
    out.insert("fingerprint".into(), json!(if c.conn.encrypted { st.cert_fingerprint() } else { None }));
    if needs {
        let configured = match st.hooks.reports_configured.get() {
            Some(f) => f(),
            None => !matches!(st.config.var("REPORTS").unwrap_or("").to_lowercase().as_str(), "off" | "false" | "0" | "no"),
        };
        out.insert("reports".into(), json!({ "configured": configured }));
    }
    out.insert("homeNetwork".into(), json!(home));
    if let Some(l) = limited {
        out.insert("adminLimited".into(), json!(l));
    }
    if let Some(u) = &user {
        if st.two_factor_state(u, home)? == "setup" {
            out.insert("twoFactorSetupRequired".into(), json!(true));
        }
    }
    Ok(Reply::json(Value::Object(out)))
}

fn login(c: &mut Ctx) -> Result<Reply, HttpError> {
    refuse_banned(c)?;
    let st = c.state.clone();
    let name = c.field_str("username");
    let keys = vec![c.client.clone(), format!("user:{}@{}", cut(&name.to_lowercase(), 64), c.client)];
    let wait = keys.iter().map(|k| st.auth.throttled(k)).max().unwrap_or(0);
    if wait > 0 {
        return Err(too_many(wait));
    }
    let password = c.field("password").and_then(Value::as_str).map(String::from);
    // (an account that cannot be read is a 500, never a wrong password toward a ban)
    let ok = guarded(c, &keys, || st.auth.check(&name, password.as_deref()))??;
    if !ok {
        for k in &keys {
            st.auth.note_failure(k);
        }
        st.audit.warn(format!("Sign-in failed for \"{}\" from {}", cut(&name, 64), c.client));
        if failed_attempt(c, "wrong password", false)? {
            return Err(banned());
        }
        return Err(HttpError::new(401, "Wrong user name or password."));
    }
    for k in &keys {
        st.auth.note_success(k);
    }
    let username = js_string(c.field("username"));
    let rule = st.two_factor_state(&username, st.from_home(&c.client))?;
    if rule == "out" {
        st.audit.warn(format!("Sign-in refused (no two-step sign-in, outside the home network): {}", c.by(Some(&username))));
        let everyone = truthy(&st.access.get()["twoFactor"]["everyone"]);
        return Err(HttpError::new(403, if everyone { super::server::TWO_FACTOR_EVERYONE_TEXT } else { super::server::TWO_FACTOR_OUTSIDE_TEXT }).code("TWO_FACTOR_REQUIRED"));
    }
    if st.accounts.two_factor_on(&username)? {
        let cookie = pending_cookie(c, &st.accounts.start_pending(&username), 300);
        st.audit.info(format!("Password right, waiting for the two-step code: {}", c.by(Some(&username))));
        return Ok(Reply::json(json!({ "ok": true, "twoFactor": true, "next": "/login/code" })).cookie(&cookie));
    }
    let cookie = st.auth.login(&c.view(), &username, Some(&c.client))?;
    if rule == "setup" {
        st.audit.info(format!("Signed in to set up two-step sign-in (every account needs it): {}", c.by(Some(&username))));
        return Ok(Reply::json(json!({ "ok": true, "twoFactorSetup": true, "next": "/login/two-factor" })).cookie(&cookie));
    }
    st.audit.info(format!("Signed in: {}", c.by(Some(&username))));
    Ok(Reply::json(json!({ "ok": true })).cookie(&cookie))
}

fn two_factor_code(c: &mut Ctx) -> Result<Reply, HttpError> {
    refuse_banned(c)?;
    let st = c.state.clone();
    let key = format!("code:{}", c.client);
    let wait = st.auth.throttled(&key);
    if wait > 0 {
        return Err(too_many(wait));
    }
    let code = js_string(c.field("code"));
    let username = match st.accounts.finish_pending(pending_token(c).as_deref(), &code) {
        Ok(u) => u,
        // (a code that could not be checked is not a wrong one)
        Err((e, _)) if e.status >= 500 => return Err(e.into()),
        Err((e, expired)) => {
            st.auth.note_failure(&key);
            st.audit.warn(format!("Two-step code wrong from {}", c.client));
            let clear = pending_cookie(c, "", 0);
            let with = |err: HttpError| if expired { err.with_cookie(&clear) } else { err };
            if failed_attempt(c, "wrong two-step code", false).map_err(&with)? {
                return Err(with(banned()));
            }
            return Err(with(HttpError::new(e.status, e.message)));
        }
    };
    st.auth.note_success(&key);
    let cookie = st.auth.login(&c.view(), &username, Some(&c.client))?;
    st.audit.info(format!("Signed in with a two-step code: {}", c.by(Some(&username))));
    Ok(Reply::json(json!({ "ok": true })).cookie(&cookie).cookie(&pending_cookie(c, "", 0)))
}

fn setup_reports(v: Option<&Value>) -> Result<Option<(bool, bool)>, HttpError> {
    let Some(v) = v else { return Ok(None) };
    let Value::Object(o) = v else { return Err(HttpError::new(400, "reports is { share, anonymous }.")) };
    for k in o.keys() {
        if k != "share" && k != "anonymous" {
            return Err(HttpError::new(400, format!("reports has no \"{k}\".")));
        }
    }
    for k in ["share", "anonymous"] {
        if o.get(k).is_some_and(|x| !x.is_boolean()) {
            return Err(HttpError::new(400, format!("reports.{k} is on or off.")));
        }
    }
    Ok(Some((o.get("share") == Some(&json!(true)), o.get("anonymous") == Some(&json!(true)))))
}

fn setup(c: &mut Ctx) -> Result<Reply, HttpError> {
    refuse_banned(c)?;
    let st = c.state.clone();
    let key = format!("setup:{}", c.client);
    let wait = st.auth.throttled(&key);
    if wait > 0 {
        return Err(too_many(wait));
    }
    let opt_in = setup_reports(c.field("reports"))?;
    let code = c.field_str("code");
    if let Err(e) = st.auth.setup(&c.field_str("username"), &c.field_str("password"), &code) {
        if e.status == 403 {
            st.auth.note_failure(&key);
            st.audit.warn(format!("Account setup with a wrong setup code from {}", c.client));
            if failed_attempt(c, "wrong setup code", false)? {
                return Err(banned());
            }
        }
        return Err(e.into());
    }
    let username = js_string(c.field("username"));
    let cookie = st.auth.login(&c.view(), &username, Some(&c.client))?;
    st.audit.info(format!("Account \"{username}\" created with the setup code: {}", c.by(Some(&username))));
    if let (Some((share, anonymous)), Some(f)) = (opt_in, st.hooks.reports_setup.get()) {
        let configured = st.hooks.reports_configured.get().is_none_or(|g| g());
        if configured {
            match f(share, anonymous) {
                Ok((before, after)) => {
                    let word = |x: &Value| if truthy(x) { "on" } else { "off" };
                    if before["share"] != after["share"] {
                        st.audit.warn(format!("Share diagnostics with the developers turned {} at setup: {}", word(&after["share"]), c.by(Some(&username))));
                    }
                    if before["anonymous"] != after["anonymous"] {
                        st.audit.warn(format!("Send reports anonymously turned {} at setup: {}", word(&after["anonymous"]), c.by(Some(&username))));
                    }
                }
                Err(e) => st.log.warn(format!("The reporting choice at setup was not saved: {e}")),
            }
        }
    }
    Ok(Reply::json(json!({ "ok": true })).cookie(&cookie))
}

fn logout(c: &mut Ctx) -> Result<Reply, HttpError> {
    let cookie = c.state.auth.logout(&c.view())?;
    c.state.audit.info(format!("Signed out: {}", c.by(c.user.as_deref())));
    Ok(Reply::json(json!({ "ok": true })).cookie(&cookie))
}

fn confirm(c: &mut Ctx) -> Result<Reply, HttpError> {
    refuse_banned(c)?;
    let st = c.state.clone();
    let user = c.user().to_string();
    let key = format!("confirm:{user}");
    let wait = st.auth.throttled(&key);
    if wait > 0 {
        return Err(too_many(wait));
    }
    let password = c.field("password").and_then(Value::as_str).map(String::from);
    let ok = guarded(c, std::slice::from_ref(&key), || st.auth.confirm(&c.view(), &user, password.as_deref()))??;
    if !ok {
        st.auth.note_failure(&key);
        st.audit.warn(format!("Password confirmation failed: {}", c.by(Some(&user))));
        if failed_attempt(c, "wrong password confirmation", true)? {
            return Err(banned());
        }
        return Err(HttpError::new(401, "That password is not right."));
    }
    st.auth.note_success(&key);
    st.audit.info(format!("Password confirmed for sensitive changes: {}", c.by(Some(&user))));
    Ok(Reply::json(json!({ "ok": true })))
}

fn change_password(c: &mut Ctx) -> Result<Reply, HttpError> {
    refuse_banned(c)?;
    let st = c.state.clone();
    let user = c.user().to_string();
    let key = format!("confirm:{user}");
    let wait = st.auth.throttled(&key);
    if wait > 0 {
        return Err(too_many(wait));
    }
    let current = c.field("current").and_then(Value::as_str).map(String::from);
    let ok = guarded(c, std::slice::from_ref(&key), || st.auth.check(&user, current.as_deref()))??;
    if !ok {
        st.auth.note_failure(&key);
        st.audit.warn(format!("Password change with a wrong current password: {}", c.by(Some(&user))));
        if failed_attempt(c, "wrong current password", true)? {
            return Err(banned());
        }
        return Err(HttpError::new(401, "The current password is wrong."));
    }
    st.auth.note_success(&key);
    st.auth.set_password(&user, &c.field_str("next"))?;
    st.db.delete_sessions_for(&user)?;
    st.auth.forget_confirmations();
    let cookie = st.auth.login(&c.view(), &user, Some(&c.client))?;
    st.audit.info(format!("Password changed (all other sessions signed out): {}", c.by(Some(&user))));
    Ok(Reply::json(json!({ "ok": true })).cookie(&cookie))
}

fn access_view(c: &Ctx) -> Result<Value, HttpError> {
    let st = &c.state;
    let ip = &c.client;
    let me = st.auth.user(&c.view())?.unwrap_or_else(|| "null".into());
    let without: Vec<Value> = st.accounts.list()?.into_iter().filter(|a| a["twoFactor"] != true).map(|a| a["username"].clone()).collect();
    Ok(json!({
        "settings": st.access.get(), "bans": st.access.list(), "watching": st.access.watching(),
        "you": { "address": ip, "banKey": ban_key(ip), "home": st.access.is_home(ip) },
        "trustProxy": st.config.trust_proxy, "trustedProxies": st.config.trusted_proxies,
        "twoFactor": { "yours": st.accounts.two_factor_on(&me)?, "without": without }
    }))
}

fn running_as_root() -> bool {
    unsafe { libc::getuid() == 0 }
}

fn security(c: &mut Ctx) -> Result<Reply, HttpError> {
    let st = &c.state;
    let tls = match &st.tls {
        None => Value::Null,
        Some(t) => t.status().unwrap_or_else(|e| json!({ "error": e })),
    };
    let host = super::server::clean_host(st, &c.conn, &c.headers, None);
    Ok(Reply::json(json!({
        "https": c.secure, "tlsMode": st.config.tls_mode, "trustProxy": st.config.trust_proxy, "tls": tls,
        "supervised": st.config.supervised, "runningAsRoot": running_as_root(),
        "currentHost": host, "confirmed": st.auth.recently_confirmed(&c.view())
    })))
}

fn set_hostnames(c: &mut Ctx) -> Result<Reply, HttpError> {
    c.require_confirmed()?;
    let st = c.state.clone();
    let Some(tls) = &st.tls else { return Err(HttpError::new(409, "HTTPS is turned off (TLS_MODE=off).")) };
    let given = match c.field("hostnames") {
        Some(Value::Array(a)) => a.iter().map(|v| if v.is_null() { String::new() } else { js_string(Some(v)) }).collect::<Vec<_>>().join(","),
        other => match other {
            Some(v) if truthy(v) => js_string(Some(v)),
            _ => String::new(),
        },
    };
    let list = super::tls::parse_hostnames(&given)?;
    let (material, ca_replaced) = tls.set_hostnames(&list)?;
    if let Ok(cfg) = super::tls::server_config(&material, true) {
        *st.tls_config.write().unwrap() = Some(cfg);
    }
    st.audit.info(format!("HTTPS certificate names set to [{}]{}: {}", list.join(", "), if ca_replaced { " (new certificate authority)" } else { "" }, c.by(c.user.as_deref())));
    let status = tls.status().map_err(HttpError::internal)?;
    Ok(Reply::json(json!({ "ok": true, "caReplaced": ca_replaced, "tls": status })))
}

fn ca_crt(c: &mut Ctx) -> Result<Reply, HttpError> {
    let pem = c.state.tls.as_ref().and_then(|t| t.ca_pem());
    let Some(pem) = pem else { return Err(HttpError::new(404, "This server uses its own certificate; there is no local certificate authority.")) };
    Ok(Reply::Raw(
        Response::builder()
            .status(200)
            .header(header::CONTENT_TYPE, "application/x-x509-ca-cert")
            .header(header::CONTENT_DISPOSITION, "attachment; filename=\"sentry-six-manager-ca.crt\"")
            .header(header::CACHE_CONTROL, "no-store")
            .body(axum::body::Body::from(pem))
            .unwrap(),
    ))
}

fn put_access(c: &mut Ctx) -> Result<Reply, HttpError> {
    c.require_confirmed()?;
    let st = c.state.clone();
    let user = c.user().to_string();
    let before = st.access.get();
    let input = match c.body.as_ref() {
        Some(b) => match b.get("settings") {
            Some(s) if !s.is_null() => s.clone(),
            _ => b.clone(),
        },
        None => Value::Null,
    };
    let next = validate_access(&input, &before)?;
    let mine = st.accounts.two_factor_on(&user)?;
    let home = st.access.is_home(&c.client);
    if truthy(&next["twoFactor"]["everyone"]) && !truthy(&before["twoFactor"]["everyone"]) && !mine {
        return Err(HttpError::new(409, "Turn on two-step sign-in for your own account first (Account), then every account can be made to need it."));
    }
    if truthy(&next["twoFactor"]["outside"]) && !truthy(&before["twoFactor"]["outside"]) && !mine && !home {
        return Err(HttpError::new(409, "You are outside the home network without two-step sign-in: this would sign you out. Turn it on for your account first (Account)."));
    }
    st.access.set(&next)?;
    let mut changes = Vec::new();
    if let Value::Object(parts) = &next {
        for (part, v) in parts {
            if let Value::Object(keys) = v {
                for (k, b) in keys {
                    let a = before.get(part).and_then(|p| p.get(k)).map(|x| x.to_string()).unwrap_or_else(|| "undefined".into());
                    let b = b.to_string();
                    if a != b {
                        changes.push(format!("{part}.{k} {a} → {b}"));
                    }
                }
            }
        }
    }
    if !changes.is_empty() {
        st.audit.warn(format!("Security settings changed ({}): {}", changes.join(", "), c.by(Some(&user))));
    }
    Ok(Reply::json(access_view(c)?))
}

fn unban(c: &mut Ctx) -> Result<Reply, HttpError> {
    let addr = cut(&c.field_str("address"), 64);
    c.state.access.unban(&addr, &c.by(c.user.as_deref()))?;
    Ok(Reply::json(access_view(c)?))
}

fn sessions(c: &mut Ctx) -> Result<Reply, HttpError> {
    let mine = c.state.auth.session_hash(&c.view());
    let list: Vec<Value> = c
        .state
        .db
        .sessions_for(c.user())?
        .into_iter()
        .map(|x| json!({ "id": &x.token_hash[..16.min(x.token_hash.len())], "current": Some(&x.token_hash) == mine.as_ref(), "agent": x.agent, "ip": x.ip, "createdAt": x.created_at, "seenAt": x.seen_at }))
        .collect();
    Ok(Reply::json(json!({ "sessions": list })))
}

fn end_session(c: &mut Ctx) -> Result<Reply, HttpError> {
    let id = c.params.get("id").cloned().unwrap_or_default();
    let hit = c.state.db.sessions_for(c.user())?.into_iter().find(|x| x.token_hash.get(..16) == Some(id.as_str()));
    let Some(hit) = hit else { return Err(HttpError::new(404, "No such session.")) };
    c.state.db.delete_session(&hit.token_hash)?;
    c.state.audit.info(format!("Signed out a device: {}", c.by(c.user.as_deref())));
    Ok(Reply::json(json!({ "ok": true })))
}

fn end_others(c: &mut Ctx) -> Result<Reply, HttpError> {
    let mine = c.state.auth.session_hash(&c.view());
    let mut n = 0;
    let mut failed = None;
    for x in c.state.db.sessions_for(c.user())? {
        if Some(&x.token_hash) != mine.as_ref() {
            if let Err(e) = c.state.db.delete_session(&x.token_hash) {
                failed = Some(e);
                break;
            }
            n += 1;
        }
    }
    // (the ones that did end are in the audit log even when the rest could not be)
    let rest = if failed.is_some() { "; the others could not be signed out" } else { "" };
    c.state.audit.warn(format!("Signed out everywhere else ({n} session{}{rest}): {}", if n == 1 { "" } else { "s" }, c.by(c.user.as_deref())));
    if let Some(e) = failed {
        return Err(e.into());
    }
    Ok(Reply::json(json!({ "ended": n })))
}

fn add_account(c: &mut Ctx) -> Result<Reply, HttpError> {
    c.require_confirmed()?;
    let st = c.state.clone();
    let name = c.field_str("username");
    if st.db.get_user(&name)?.is_some() {
        return Err(HttpError::new(409, "There is an account with that name already."));
    }
    let role = if c.field("role") == Some(&json!("admin")) { "admin" } else { "viewer" };
    // (the account and its role are kept together: never an account without its role, which would be an admin)
    let (key, record) = st.accounts.first_record(&name, role)?;
    st.auth.add_user(&name, &c.field_str("password"), &[(&key, &record)])?;
    st.audit.warn(format!("Account \"{name}\" ({}) created: {}", st.accounts.role_of(Some(&name))?.unwrap_or_default(), c.by(c.user.as_deref())));
    Ok(Reply::json(json!({ "accounts": st.accounts.list()? })))
}

fn patch_account(c: &mut Ctx) -> Result<Reply, HttpError> {
    c.require_confirmed()?;
    let st = c.state.clone();
    let name = c.params.get("name").cloned().unwrap_or_default();
    let role = match c.field("role") {
        Some(Value::String(s)) => s.clone(),
        _ => String::from("\u{0}"),
    };
    st.accounts.set_role(&name, &role)?;
    st.audit.warn(format!("Account \"{name}\" is now {role}: {}", c.by(c.user.as_deref())));
    Ok(Reply::json(json!({ "accounts": st.accounts.list()? })))
}

fn delete_account(c: &mut Ctx) -> Result<Reply, HttpError> {
    c.require_confirmed()?;
    let st = c.state.clone();
    let name = c.params.get("name").cloned().unwrap_or_default();
    if Some(&name) == c.user.as_ref() {
        return Err(HttpError::new(400, "You cannot remove the account you are signed in with."));
    }
    st.accounts.remove(&name)?;
    st.audit.warn(format!("Account \"{name}\" removed: {}", c.by(c.user.as_deref())));
    Ok(Reply::json(json!({ "accounts": st.accounts.list()? })))
}

fn logs(c: &mut Ctx) -> Result<Reply, HttpError> {
    let limit = number_or(c.query.get("limit"), 300.0).min(1000.0);
    let min = if c.query.get("level").map(String::as_str) == Some("all") { "debug" } else { "warn" };
    let mut lines = c.state.logger.recent(limit, min);
    lines.reverse();
    Ok(Reply::json(json!({ "lines": lines.iter().map(|e| e.to_json()).collect::<Vec<_>>() })))
}

fn logs_clear(c: &mut Ctx) -> Result<Reply, HttpError> {
    let name = c.state.logger.archive().map_err(|e| HttpError::internal(e.to_string()))?;
    c.state.audit.info(format!("Logs cleared{}: {}", name.as_ref().map(|n| format!(" (earlier lines kept in logs/archive/{n})")).unwrap_or_default(), c.by(c.user.as_deref())));
    Ok(Reply::json(json!({ "ok": true, "archived": name })))
}

fn logs_search(c: &mut Ctx) -> Result<Reply, HttpError> {
    let at = |v: Option<&String>, end: bool| -> Option<i64> {
        let v = v.filter(|v| !v.is_empty())?;
        let day = v.len() == 10 && v.as_bytes()[4] == b'-' && v.as_bytes()[7] == b'-' && v.bytes().enumerate().all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
        let text = if day { format!("{v}T{}", if end { "23:59:59.999" } else { "00:00:00" }) } else { v.clone() };
        parse_iso(&text)
    };
    let q = &c.query;
    let level = q.get("level").map(String::as_str).filter(|l| ["debug", "info", "warn", "error"].contains(l)).unwrap_or("info");
    let download = q.get("download").is_some_and(|d| !d.is_empty());
    let mut lines = c.state.logger.search(&Search {
        from: at(q.get("from"), false),
        to: at(q.get("to"), true),
        text: q.get("q").cloned().unwrap_or_default(),
        min_level: level.into(),
        limit: if download { 50000 } else { 2000 },
    });
    if !download {
        lines.reverse();
        return Ok(Reply::json(json!({ "lines": lines.iter().map(|e| e.to_json()).collect::<Vec<_>>() })));
    }
    let text = lines.iter().map(|l| l.line()).collect::<Vec<_>>().join("\n");
    let name = format!(
        "sentry-six-manager-{}-to-{}.log",
        q.get("from").filter(|s| !s.is_empty()).map(String::as_str).unwrap_or("start"),
        q.get("to").filter(|s| !s.is_empty()).map(String::as_str).unwrap_or("now")
    );
    Reply::text_download(format!("{text}\n"), &name)
}

fn jobs(c: &mut Ctx) -> Result<Reply, HttpError> {
    let limit = number_or(c.query.get("limit"), 200.0).min(500.0);
    let vehicle = c.query.get("vehicle").filter(|v| !v.is_empty()).cloned();
    let list: Vec<Value> = c
        .state
        .jobs
        .list(limit.trunc() as i64, vehicle.as_deref())?
        .into_iter()
        .map(|j| {
            let mut v = j.to_json();
            let energy = j.result.get("energy").filter(|e| truthy(e)).cloned();
            if let Some(e) = energy {
                let mut out = Map::new();
                for k in ["wh", "avgW"] {
                    if let Some(x) = e.get(k) {
                        out.insert(k.into(), x.clone());
                    }
                }
                out.insert("cost".into(), e.get("cost").cloned().unwrap_or(Value::Null));
                v["energy"] = Value::Object(out);
            }
            v
        })
        .collect();
    Ok(Reply::json(json!({ "jobs": list })))
}

fn jobs_clear(c: &mut Ctx) -> Result<Reply, HttpError> {
    let st = c.state.clone();
    let Some(Value::Object(body)) = c.body.clone() else { return Err(HttpError::new(400, "Say which jobs to clear.")) };
    let vehicle = body.get("vehicle").cloned().unwrap_or(Value::Null);
    let preview = body.get("preview").cloned().unwrap_or(json!(false));
    let vehicle_id = match &vehicle {
        Value::Null => None,
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        _ => return Err(HttpError::new(400, "Choose a vehicle, or none for every vehicle.")),
    };
    let Value::Bool(preview) = preview else { return Err(HttpError::new(400, "preview is true or false.")) };
    if !preview && body.get("confirm") != Some(&json!(true)) {
        return Err(HttpError::new(400, "Confirm clearing the finished jobs."));
    }
    if let Some(v) = &vehicle_id {
        if !st.hooks.vehicle_exists.get().is_some_and(|f| f(v)) {
            return Err(HttpError::new(404, "No such vehicle."));
        }
    }
    if let Some(f) = st.hooks.settle_conversions.get() {
        f();
    }
    let keep = st.hooks.conversions_active.get().map(|f| f()).unwrap_or_default();
    if preview {
        return Ok(Reply::json(json!({ "jobs": st.jobs.finished(vehicle_id.as_deref(), &keep)? })));
    }
    let cleared = st.jobs.clear(vehicle_id.as_deref(), &keep)?;
    st.audit.info(format!("Jobs cleared: {cleared} finished job(s){}: {}", vehicle_id.as_ref().map(|v| format!(" of {v}")).unwrap_or_default(), c.by(c.user.as_deref())));
    Ok(Reply::json(json!({ "cleared": cleared })))
}

/// Core's routes, in index.js order.
pub fn register(r: &mut Router) {
    r.add(Method::GET, "/api/auth/me", Access::Public, me);
    r.add(Method::POST, "/api/auth/login", Access::Public, login);
    r.add(Method::POST, "/api/auth/2fa/code", Access::Public, two_factor_code);
    r.get("/api/auth/2fa", |c| {
        let u = c.user().to_string();
        Ok(Reply::json(json!({ "enabled": c.state.accounts.two_factor_on(&u)?, "recoveryLeft": c.state.accounts.recovery_left(&u)? })))
    });
    r.post("/api/auth/2fa/start", |c| {
        c.require_confirmed()?;
        Ok(Reply::json(c.state.accounts.start_totp(c.user())?))
    });
    r.post("/api/auth/2fa/enable", |c| {
        let recovery = c.state.accounts.enable_totp(c.user(), &js_string(c.field("code")))?;
        c.state.audit.warn(format!("Two-step sign-in turned on: {}", c.by(c.user.as_deref())));
        Ok(Reply::json(json!({ "recovery": recovery })))
    });
    r.post("/api/auth/2fa/disable", |c| {
        c.require_confirmed()?;
        c.state.accounts.disable_totp(c.user())?;
        c.state.audit.warn(format!("Two-step sign-in turned off: {}", c.by(c.user.as_deref())));
        Ok(Reply::json(json!({ "ok": true })))
    });
    r.get("/api/auth/sessions", sessions);
    r.post("/api/auth/sessions/:id/end", end_session);
    r.post("/api/auth/sessions-end-others", end_others);
    r.get("/api/accounts", |c| Ok(Reply::json(json!({ "accounts": c.state.accounts.list()? }))));
    r.post("/api/accounts", add_account);
    r.add(Method::PATCH, "/api/accounts/:name", Access::SignedIn, patch_account);
    r.add(Method::DELETE, "/api/accounts/:name", Access::SignedIn, delete_account);
    r.add(Method::POST, "/api/auth/setup", Access::Public, setup);
    r.post("/api/auth/logout", logout);
    r.post("/api/auth/confirm", confirm);
    r.post("/api/auth/password", change_password);
    r.get("/api/security", security);
    r.add(Method::PUT, "/api/security/hostnames", Access::SignedIn, set_hostnames);
    r.get("/api/security/ca.crt", ca_crt);
    r.get("/api/security/access", |c| Ok(Reply::json(access_view(c)?)));
    r.add(Method::PUT, "/api/security/access", Access::SignedIn, put_access);
    r.post("/api/security/unban", unban);
    r.get("/api/logs", logs);
    r.post("/api/logs/clear", logs_clear);
    r.get("/api/logs/archive", |c| Ok(Reply::json(json!({ "archives": c.state.logger.archives() }))));
    r.get("/api/logs/archive/:name", |c| {
        let name = c.params.get("name").cloned().unwrap_or_default();
        let Some(text) = c.state.logger.archive_text(&name) else { return Err(HttpError::new(404, "No such archived log.")) };
        Reply::text_download(text, &format!("sentry-six-manager-{}", &name["manager-".len()..]))
    });
    r.get("/api/logs/download", |c| {
        let text = c.state.logger.file_text();
        Reply::text_download(text, &format!("sentry-six-manager-{}.log", &iso(super::db::now_ms())[..10]))
    });
    r.get("/api/logs/search", logs_search);
    r.get("/api/jobs", jobs);
    r.post("/api/jobs/clear", jobs_clear);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::http::ConnInfo;
    use crate::core::state::AppState;
    use http_body_util::BodyExt;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Arc;

    /// A server of its own (DATA in a temporary folder, HTTPS off) with its admin signed in:
    /// the state, the session cookie and the folder.
    fn server(name: &str) -> (Arc<AppState>, String, PathBuf) {
        let dir = std::env::temp_dir().join(format!("lean-routes-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let env = [("DATA_PATH", dir.to_string_lossy().into_owned()), ("TLS_MODE", "off".into()), ("UI_USERNAME", "admin".into()), ("UI_PASSWORD", "correct horse".into())];
        let config = crate::core::Config::from_map(env.into_iter().map(|(k, v)| (k.to_string(), v)).collect());
        let st = AppState::open_with(config, super::super::log::Logger::with("error", 100, true, None, 1)).unwrap();
        super::super::server::install(&st, crate::core::router());
        let set = st.auth.login(&super::super::auth::ReqView { secure: false, cookie: "", agent: "" }, "admin", None).unwrap();
        (st, set.split(';').next().unwrap().to_string(), dir)
    }

    fn put(st: &Arc<AppState>, cookie: &str, path: &str, body: Value) -> Ctx {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(header::COOKIE, cookie.parse().unwrap());
        let conn = ConnInfo { peer: None, encrypted: false, device: false };
        Ctx { state: st.clone(), method: Method::PUT, raw_path: path.into(), path: path.into(), params: HashMap::new(), query: HashMap::new(), raw_query: None, headers, body: Some(body), user: Some("admin".into()), conn, client: "127.0.0.1".into(), secure: false }
    }

    /// A request from `client` (an address outside the home network can be banned), signed in
    /// as admin with `cookie` when given.
    fn from(st: &Arc<AppState>, cookie: Option<&str>, method: Method, path: &str, body: Value, client: &str) -> Ctx {
        let mut headers = axum::http::HeaderMap::new();
        if let Some(c) = cookie {
            headers.insert(header::COOKIE, c.parse().unwrap());
        }
        let conn = ConnInfo { peer: None, encrypted: false, device: false };
        let user = cookie.map(|_| "admin".to_string());
        Ctx { state: st.clone(), method, raw_path: path.into(), path: path.into(), params: HashMap::new(), query: HashMap::new(), raw_query: None, headers, body: Some(body), user, conn, client: client.into(), secure: false }
    }

    /// Writes matching `when` fail inside manager.db (as a failing disk would), every other write is kept.
    fn failing(st: &Arc<AppState>, name: &str, when: &str) {
        st.db.conn().execute_batch(&format!("CREATE TEMP TRIGGER {name} {when} BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;")).unwrap();
    }

    #[test]
    fn a_security_settings_save_that_was_not_kept_answers_500_and_changes_nothing() {
        let (st, cookie, dir) = server("access");
        let mut c = put(&st, &cookie, "/api/security/access", json!({ "bans": { "maxFailures": 5 } }));
        st.db.conn().execute_batch("PRAGMA query_only = ON").unwrap();
        let e = put_access(&mut c).err().expect("an error answer, not success");
        assert_eq!((e.status, e.explicit), (500, false), "500 Internal error, logged");
        assert_eq!(st.access.get()["bans"]["maxFailures"], 10, "the rules in force are the ones kept");
        st.db.conn().execute_batch("PRAGMA query_only = OFF").unwrap();
        assert_eq!(st.db.get(super::super::access::KEY_SETTINGS).unwrap(), None, "nothing was written");
        assert!(put_access(&mut c).is_ok());
        assert_eq!(st.access.get()["bans"]["maxFailures"], 5);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_session_that_cannot_be_read_answers_500_not_signed_out() {
        let (st, cookie, dir) = server("session");
        let me = || {
            let req = axum::http::Request::builder().uri("/api/auth/me").header(header::HOST, "127.0.0.1:9000").header(header::COOKIE, cookie.as_str()).body(axum::body::Body::empty()).unwrap();
            super::super::server::dispatch(st.clone(), req, ConnInfo { peer: None, encrypted: false, device: false })
        };
        let body = |r: axum::http::Response<axum::body::Body>| async move { serde_json::from_slice::<Value>(&r.into_body().collect().await.unwrap().to_bytes()).unwrap() };
        let ok = me().await;
        assert_eq!(ok.status(), 200);
        assert_eq!(body(ok).await["user"], "admin");
        st.db.conn().execute_batch("DROP TABLE sessions").unwrap();
        let failed = me().await;
        assert_eq!(failed.status(), 500);
        assert_eq!(body(failed).await, json!({ "error": "Internal error" }), "not a signed-out answer (user null): the sessions could not be read");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_account_whose_role_cannot_be_kept_is_not_made_at_all() {
        let (st, cookie, dir) = server("add-account");
        // (its record cannot be written, nor can an account be deleted afterwards)
        failing(&st, "no_record", "BEFORE INSERT ON settings WHEN NEW.key = 'account:watcher'");
        failing(&st, "no_delete", "BEFORE DELETE ON users");
        let mut c = from(&st, Some(&cookie), Method::POST, "/api/accounts", json!({ "username": "watcher", "password": "correct horse", "role": "viewer" }), "127.0.0.1");
        let e = add_account(&mut c).err().expect("an error answer");
        assert_eq!(e.status, 500);
        assert!(st.db.get_user("watcher").unwrap().is_none(), "no account without its role (it would be an admin)");
        assert_eq!(st.accounts.list().unwrap().len(), 1);
        st.db.conn().execute_batch("DROP TRIGGER no_record; DROP TRIGGER no_delete").unwrap();
        add_account(&mut c).unwrap();
        assert_eq!(st.accounts.role_of(Some("watcher")).unwrap().as_deref(), Some("viewer"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_removed_account_takes_its_record_with_it_or_stays_whole() {
        let (st, cookie, dir) = server("remove-account");
        add_account(&mut from(&st, Some(&cookie), Method::POST, "/api/accounts", json!({ "username": "watcher", "password": "correct horse", "role": "viewer" }), "127.0.0.1")).unwrap();
        st.auth.login(&super::super::auth::ReqView { secure: false, cookie: "", agent: "" }, "watcher", None).unwrap();
        // (the record cannot be cleared)
        failing(&st, "no_clear", "BEFORE UPDATE ON settings WHEN NEW.key = 'account:watcher'");
        let mut c = from(&st, Some(&cookie), Method::DELETE, "/api/accounts/watcher", Value::Null, "127.0.0.1");
        c.params.insert("name".into(), "watcher".into());
        assert_eq!(delete_account(&mut c).err().expect("an error answer").status, 500);
        assert!(st.db.get_user("watcher").unwrap().is_some(), "not gone without its record");
        assert_eq!(st.db.sessions_for("watcher").unwrap().len(), 1);
        assert_eq!(st.db.get("account:watcher").unwrap(), Some(json!({ "role": "viewer" })));
        st.db.conn().execute_batch("DROP TRIGGER no_clear").unwrap();
        delete_account(&mut c).unwrap();
        assert!(st.db.get_user("watcher").unwrap().is_none());
        assert_eq!(st.db.get("account:watcher").unwrap(), Some(Value::Null), "the record goes with it: an account made later of that name starts fresh");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_ban_that_cannot_be_saved_answers_500_and_holds_until_a_restart() {
        let (st, _cookie, dir) = server("ban-unsaved");
        st.access.set(&super::super::access::validate(&json!({ "bans": { "maxFailures": 3 } }), &st.access.get()).unwrap()).unwrap();
        st.db.conn().execute_batch("PRAGMA query_only = ON").unwrap();
        let wrong = || from(&st, None, Method::POST, "/api/auth/login", json!({ "username": "admin", "password": "wrong horse" }), "203.0.113.7");
        for _ in 0..2 {
            assert_eq!(login(&mut wrong()).err().unwrap().status, 401);
        }
        let e = login(&mut wrong()).err().unwrap();
        assert_eq!(e.status, 500, "not the ban answer (429) for a ban that was not saved");
        assert!(st.access.banned("203.0.113.7").is_some(), "it holds in memory");
        assert_eq!(login(&mut wrong()).err().unwrap().status, 429);
        st.db.conn().execute_batch("PRAGMA query_only = OFF").unwrap();
        let restarted = super::super::access::Access::new(st.db.clone(), None).unwrap();
        assert!(restarted.banned("203.0.113.7").is_none(), "what a restart would know");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_banned_session_that_cannot_be_signed_out_answers_500() {
        let (st, cookie, dir) = server("ban-session");
        st.access.set(&super::super::access::validate(&json!({ "bans": { "maxFailures": 3 } }), &st.access.get()).unwrap()).unwrap();
        // (the ban is saved; the session cannot be removed)
        failing(&st, "no_signout", "BEFORE DELETE ON sessions");
        let wrong = || from(&st, Some(&cookie), Method::POST, "/api/auth/confirm", json!({ "password": "wrong horse" }), "203.0.113.8");
        for _ in 0..2 {
            assert_eq!(confirm(&mut wrong()).err().unwrap().status, 401);
        }
        let e = confirm(&mut wrong()).err().unwrap();
        assert_eq!(e.status, 500, "not the ban answer while the session still works from another address");
        assert!(st.access.banned("203.0.113.8").is_some());
        assert_eq!(st.db.sessions_for("admin").unwrap().len(), 1);
        st.db.conn().execute_batch("DROP TRIGGER no_signout").unwrap();
        let restarted = super::super::access::Access::new(st.db.clone(), None).unwrap();
        assert!(restarted.banned("203.0.113.8").is_some(), "the ban itself was saved");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_session_whose_ban_could_not_be_saved_is_not_signed_out() {
        let (st, cookie, dir) = server("ban-unsaved-session");
        st.access.set(&super::super::access::validate(&json!({ "bans": { "maxFailures": 3 } }), &st.access.get()).unwrap()).unwrap();
        // (the ban cannot be saved; sessions can still be removed)
        failing(&st, "no_ban_insert", "BEFORE INSERT ON settings WHEN NEW.key = 'security:bans'");
        failing(&st, "no_ban_update", "BEFORE UPDATE ON settings WHEN NEW.key = 'security:bans'");
        let wrong = || from(&st, Some(&cookie), Method::POST, "/api/auth/confirm", json!({ "password": "wrong horse" }), "203.0.113.9");
        for _ in 0..2 {
            assert_eq!(confirm(&mut wrong()).err().unwrap().status, 401);
        }
        assert_eq!(confirm(&mut wrong()).err().unwrap().status, 500);
        assert!(st.access.banned("203.0.113.9").is_some(), "it holds in memory");
        assert_eq!(st.db.sessions_for("admin").unwrap().len(), 1, "not signed out for a ban that was not saved");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_start_whose_accounts_or_security_settings_cannot_be_read_names_them_and_stops() {
        let (st, _cookie, dir) = server("start-unreadable");
        let reopen = || {
            let env = [("DATA_PATH", dir.to_string_lossy().into_owned()), ("TLS_MODE", "off".into())];
            let config = crate::core::Config::from_map(env.into_iter().map(|(k, v)| (k.to_string(), v)).collect());
            AppState::open_with(config, super::super::log::Logger::with("error", 100, true, None, 1)).err()
        };
        // (a view of a table that is gone: CREATE TABLE IF NOT EXISTS leaves it, and every read fails)
        st.db.conn().execute_batch("ALTER TABLE users RENAME TO users_kept; CREATE TABLE gone (x); CREATE VIEW users AS SELECT * FROM gone; DROP TABLE gone;").unwrap();
        assert_eq!(reopen().as_deref(), Some("The accounts could not be read: manager.db: no such table: main.gone"), "no setup code, no start");
        st.db.conn().execute_batch("DROP VIEW users; ALTER TABLE users_kept RENAME TO users; ALTER TABLE settings RENAME TO settings_kept; CREATE TABLE gone (x); CREATE VIEW settings AS SELECT * FROM gone; DROP TABLE gone;").unwrap();
        assert_eq!(reopen().as_deref(), Some("The security settings could not be read: manager.db: no such table: main.gone"), "no start without its bans and rules");
        let _ = std::fs::remove_dir_all(dir);
    }
}
