//! Accounts beyond the first (server/accounts.js): roles (admin, or viewer:
//! watch-only), two-step sign-in (TOTP, RFC 6238, with ten one-time recovery
//! codes) and pending sign-ins. Everything is kept where Node keeps it: the
//! setting `account:<name>` holds `{ role, totp, totpSetup, recovery, recoveryV }`.

use super::auth::{random_bytes, refuse, same, sha256_hex, Refusal};
use super::db::{now_ms, Db};
use hmac::{Hmac, Mac};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

const B32: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP: i64 = 30;
pub const ROLES: [&str; 2] = ["admin", "viewer"];

pub fn base32(buf: &[u8]) -> String {
    let (mut bits, mut value, mut out) = (0u32, 0u32, String::new());
    for b in buf {
        value = (value << 8) | *b as u32;
        bits += 8;
        while bits >= 5 {
            out.push(B32[((value >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(B32[((value << (5 - bits)) & 31) as usize] as char);
    }
    out
}

pub fn unbase32(text: &str) -> Vec<u8> {
    let (mut bits, mut value, mut out) = (0u32, 0u32, Vec::new());
    for c in text.to_uppercase().bytes().filter(|c| c.is_ascii_uppercase() || (b'2'..=b'7').contains(c)) {
        value = (value << 5) | B32.iter().position(|x| *x == c).unwrap_or(0) as u32;
        bits += 5;
        if bits >= 8 {
            out.push(((value >> (bits - 8)) & 255) as u8);
            bits -= 8;
        }
    }
    out
}

/// The 6-digit code of a secret for a time step.
pub fn totp(secret: &str, counter: i64) -> String {
    let mut mac = Hmac::<sha1::Sha1>::new_from_slice(&unbase32(secret)).expect("hmac");
    mac.update(&(counter as u64).to_be_bytes());
    let h = mac.finalize().into_bytes();
    let o = (h[h.len() - 1] & 15) as usize;
    let n = (u32::from_be_bytes([h[o], h[o + 1], h[o + 2], h[o + 3]]) & 0x7fff_ffff) % 1_000_000;
    format!("{n:06}")
}

/// The time step a code matches (this one, or one before or after), or None.
pub fn match_totp(secret: &str, code: &str, now: i64) -> Option<i64> {
    let given: String = code.chars().filter(|c| c.is_ascii_digit()).collect();
    if given.len() != 6 {
        return None;
    }
    let c = (now as f64 / 1000.0 / STEP as f64).floor() as i64;
    [0, -1, 1].into_iter().map(|d| c + d).find(|step| same(totp(secret, *step).as_bytes(), given.as_bytes()))
}

/// encodeURIComponent
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// A recovery code as kept: its hex letters and digits only.
pub fn recovery_key(code: &str) -> String {
    code.to_lowercase().chars().filter(|c| c.is_ascii_hexdigit()).collect()
}

/// A JSON body field as a string, as String(x) would give it in Node (null and undefined are "").
pub fn js_string(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => super::http::js_number_text(n),
        Some(Value::Array(a)) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(Some(x)) }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

#[derive(Debug, Clone)]
struct Pending {
    username: String,
    until: i64,
    tries: u32,
}

pub struct Accounts {
    db: Arc<Db>,
    issuer: String,
    pending: Mutex<HashMap<String, Pending>>,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
}

fn meta_key(u: &str) -> String {
    format!("account:{u}")
}

/// The JSON an /api/accounts answer lists.
pub fn account_json(username: &str, created_at: i64, role: &str, two_factor: bool) -> Value {
    json!({ "username": username, "createdAt": created_at, "role": role, "twoFactor": two_factor })
}

impl Accounts {
    pub fn new(db: Arc<Db>) -> Accounts {
        Accounts::with_clock(db, Box::new(now_ms))
    }

    pub fn with_clock(db: Arc<Db>, now: Box<dyn Fn() -> i64 + Send + Sync>) -> Accounts {
        Accounts { db, issuer: "Sentry Six Manager".into(), pending: Mutex::new(HashMap::new()), now }
    }

    /// `{ role: 'admin', ...stored }`
    fn meta(&self, u: &str) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("role".into(), json!("admin"));
        if let Some(Value::Object(stored)) = self.db.get(&meta_key(u)) {
            for (k, v) in stored {
                m.insert(k, v);
            }
        }
        m
    }

    fn set_meta(&self, u: &str, m: &Map<String, Value>) {
        self.db.set(&meta_key(u), &Value::Object(m.clone()));
    }

    pub fn role_of(&self, username: Option<&str>) -> Option<String> {
        let u = username.filter(|u| !u.is_empty())?;
        let r = self.meta(u).get("role").and_then(Value::as_str).map(String::from);
        Some(match r {
            Some(r) if ROLES.contains(&r.as_str()) => r,
            _ => "admin".into(),
        })
    }

    pub fn is_admin(&self, username: &str) -> bool {
        self.role_of(Some(username)).as_deref() == Some("admin")
    }

    pub fn list(&self) -> Vec<Value> {
        self.db
            .list_users()
            .into_iter()
            .map(|(u, created)| account_json(&u, created, &self.role_of(Some(&u)).unwrap_or_default(), self.two_factor_on(&u)))
            .collect()
    }

    fn admins(&self) -> usize {
        self.list().iter().filter(|u| u["role"] == "admin").count()
    }

    pub fn set_role(&self, username: &str, role: &str) -> Result<(), Refusal> {
        if !ROLES.contains(&role) {
            return Err(refuse(400, "The role is admin or viewer."));
        }
        if self.db.get_user(username).is_none() {
            return Err(refuse(404, "No such account."));
        }
        if role != "admin" && self.is_admin(username) && self.admins() <= 1 {
            return Err(refuse(409, "There must be one admin left: make another account admin first."));
        }
        let mut m = self.meta(username);
        m.insert("role".into(), json!(role));
        self.set_meta(username, &m);
        Ok(())
    }

    pub fn remove(&self, username: &str) -> Result<(), Refusal> {
        if self.db.get_user(username).is_none() {
            return Err(refuse(404, "No such account."));
        }
        if self.is_admin(username) && self.admins() <= 1 {
            return Err(refuse(409, "The last admin cannot be removed."));
        }
        self.db.delete_user(username);
        self.db.set(&meta_key(username), &Value::Null);
        Ok(())
    }

    // ---- two-step sign-in
    /// A new secret to scan or type (not on until confirmed with a code): { secret, uri }.
    pub fn start_totp(&self, username: &str) -> Value {
        let secret = base32(&random_bytes(20));
        let mut m = self.meta(username);
        m.insert("totpSetup".into(), json!({ "secret": secret, "at": (self.now)() }));
        self.set_meta(username, &m);
        let label = encode_uri_component(&format!("{}:{username}", self.issuer));
        let uri = format!("otpauth://totp/{label}?secret={secret}&issuer={}&algorithm=SHA1&digits=6&period={STEP}", encode_uri_component(&self.issuer));
        json!({ "secret": secret, "uri": uri })
    }

    /// Turn it on with the first code; returns the recovery codes (shown once).
    pub fn enable_totp(&self, username: &str, code: &str) -> Result<Vec<String>, Refusal> {
        let mut m = self.meta(username);
        let setup = m.get("totpSetup").and_then(Value::as_object).cloned();
        let now = (self.now)();
        // (`now() - setup.at > 15 min`: a missing time compares as NaN, so it passes, as in Node)
        let Some(setup) = setup.filter(|s| !(now as f64 - s.get("at").and_then(Value::as_f64).unwrap_or(f64::NAN) > 15.0 * 60.0 * 1000.0)) else {
            return Err(refuse(400, "Start again: the set-up waited too long."));
        };
        let secret = setup.get("secret").and_then(Value::as_str).unwrap_or("").to_string();
        let Some(step) = match_totp(&secret, code, now) else {
            return Err(refuse(400, "That code is not right. Check the phone's clock, and use the newest code."));
        };
        let recovery: Vec<String> = (0..10)
            .map(|_| {
                let h = super::auth::hex(&random_bytes(5));
                format!("{}-{}", &h[..5], &h[5..])
            })
            .collect();
        m.shift_remove("totpSetup");
        m.insert("totp".into(), json!({ "secret": secret, "enabled": true, "last": step }));
        m.insert("recovery".into(), json!(recovery.iter().map(|c| sha256_hex(&recovery_key(c))).collect::<Vec<_>>()));
        m.insert("recoveryV".into(), json!(2));
        self.set_meta(username, &m);
        Ok(recovery)
    }

    pub fn disable_totp(&self, username: &str) {
        let mut m = self.meta(username);
        for k in ["totp", "totpSetup", "recovery"] {
            m.shift_remove(k);
        }
        self.set_meta(username, &m);
    }

    pub fn two_factor_on(&self, username: &str) -> bool {
        self.meta(username).get("totp").and_then(|t| t.get("enabled")).is_some_and(truthy)
    }

    /// A code (or a recovery code) for this account; each is used once.
    pub fn verify_code(&self, username: &str, code: &str) -> bool {
        let mut m = self.meta(username);
        let Some(totp) = m.get("totp").and_then(Value::as_object).cloned() else { return false };
        if !totp.get("enabled").is_some_and(truthy) {
            return false;
        }
        let secret = totp.get("secret").and_then(Value::as_str).unwrap_or("");
        if let Some(step) = match_totp(secret, code, (self.now)()) {
            let last = totp.get("last").and_then(Value::as_f64).unwrap_or(-1.0);
            if (step as f64) <= last {
                return false;
            }
            let mut t = totp.clone();
            t.insert("last".into(), json!(step));
            m.insert("totp".into(), Value::Object(t));
            self.set_meta(username, &m);
            return true;
        }
        // codes kept before recoveryV 2 were hashed with the dash
        let given = recovery_key(code);
        if given.len() != 10 {
            return false;
        }
        let h = if m.get("recoveryV") == Some(&json!(2)) { sha256_hex(&given) } else { sha256_hex(&format!("{}-{}", &given[..5], &given[5..])) };
        let mut rest: Vec<Value> = m.get("recovery").and_then(Value::as_array).cloned().unwrap_or_default();
        let Some(i) = rest.iter().position(|x| x.as_str() == Some(h.as_str())) else { return false };
        rest.remove(i);
        m.insert("recovery".into(), Value::Array(rest));
        self.set_meta(username, &m);
        true
    }

    pub fn recovery_left(&self, username: &str) -> usize {
        self.meta(username).get("recovery").and_then(Value::as_array).map_or(0, Vec::len)
    }

    // ---- pending sign-ins (password right, code still to come)
    pub fn start_pending(&self, username: &str) -> String {
        let token = super::auth::base64url(&random_bytes(24));
        let now = (self.now)();
        let mut p = self.pending.lock().unwrap();
        p.insert(sha256_hex(&token), Pending { username: username.to_string(), until: now + 5 * 60 * 1000, tries: 0 });
        p.retain(|_, v| v.until >= now);
        token
    }

    pub fn pending_user(&self, token: Option<&str>) -> Option<String> {
        let t = token?;
        let p = self.pending.lock().unwrap();
        p.get(&sha256_hex(t)).filter(|x| x.until > (self.now)()).map(|x| x.username.clone())
    }

    /// The code for a pending sign-in: the user name when right; five wrong ones end it.
    /// The error's bool: whether the pending sign-in is over (its cookie goes).
    pub fn finish_pending(&self, token: Option<&str>, code: &str) -> Result<String, (Refusal, bool)> {
        let key = token.map(sha256_hex);
        let p = key.as_ref().and_then(|k| self.pending.lock().unwrap().get(k).cloned());
        let Some(p) = p.filter(|p| p.until >= (self.now)()) else {
            return Err((refuse(401, "The sign-in waited too long: sign in again."), true));
        };
        let key = key.unwrap();
        if !self.verify_code(&p.username, code) {
            let mut map = self.pending.lock().unwrap();
            let tries = match map.get_mut(&key) {
                Some(x) => {
                    x.tries += 1;
                    x.tries
                }
                None => p.tries + 1,
            };
            if tries >= 5 {
                map.remove(&key);
            }
            return Err((refuse(401, if tries >= 5 { "Too many wrong codes: sign in again." } else { "That code is not right." }), tries >= 5));
        }
        self.pending.lock().unwrap().remove(&key);
        Ok(p.username)
    }
}

/// JavaScript truthiness of a JSON value.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

static VIEWER_POSTS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"^/api/auth/(logout|confirm|password|2fa/.*|sessions/.*|sessions-end-others)$",
        r"^/api/telemetry/speeds$",
        r"^/api/vehicles/[^/]+/exports$",
        r"^/api/exports(/[^/]+)?$",
        r"^/api/stars(/[^/]+)?$",
        r"^/api/dashboards$",
        r"^/api/notifications/[^/]+/(read|dismiss)$",
        r"^/api/notifications/read$",
        r"^/api/studio/(readDir|readFile|exists|stat|thumbnail)$",
    ]
    .iter()
    .map(|r| Regex::new(r).unwrap())
    .collect()
});

static VIEWER_HIDDEN: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"^/api/metrics",
        r"^/api/can/(settings|files|tokens|pairing|export)(/|$)",
        r"^/api/logs",
        r"^/api/support-bundle",
        r"^/api/snapshots",
        r"^/api/security",
        r"^/api/accounts",
        r"^/api/ui-packs/original\.zip",
        r"^/api/nodes",
        r"^/api/sentryusb/[^/]+/files/",
        r"^/api/sentryusb/security",
        r"^/api/reports(/|$)",
        r"^/api/settings/work-limits",
    ]
    .iter()
    .map(|r| Regex::new(r).unwrap())
    .collect()
});

/// What a watch-only (viewer) account may do (accounts.js viewerMay); `p` is the decoded path.
pub fn viewer_may(method: &str, p: &str) -> bool {
    if method == "GET" || method == "HEAD" {
        return !VIEWER_HIDDEN.iter().any(|re| re.is_match(p));
    }
    VIEWER_POSTS.iter().any(|re| re.is_match(p))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};

    fn accounts_at(clock: Arc<AtomicI64>) -> (Arc<Db>, Accounts) {
        let db = Arc::new(Db::memory().unwrap());
        let c = clock.clone();
        let a = Accounts::with_clock(db.clone(), Box::new(move || c.load(Ordering::SeqCst)));
        (db, a)
    }

    #[test]
    fn totp_as_node() {
        // values from server/accounts.js
        assert_eq!(totp("JBSWY3DPEHPK3PXP", 1), "996554");
        assert_eq!(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1), "287082");
        assert_eq!(base32(b"hello world"), "NBSWY3DPEB3W64TMMQ");
        assert_eq!(unbase32("nbsw y3dp-eb3w64tmmq"), b"hello world");
        // RFC 6238 SHA-1 test vector (59 s)
        assert_eq!(&totp(&base32(b"12345678901234567890"), 1)[..], "287082");
        assert_eq!(match_totp("JBSWY3DPEHPK3PXP", "996 554", 45_000), Some(1));
        assert_eq!(match_totp("JBSWY3DPEHPK3PXP", "996554", 95_000), None);
    }

    #[test]
    fn roles_and_last_admin() {
        let (db, a) = accounts_at(Arc::new(AtomicI64::new(0)));
        db.put_user("one", "s", "h");
        assert_eq!(a.role_of(Some("one")).as_deref(), Some("admin"));
        assert_eq!(a.role_of(None), None);
        assert_eq!(a.set_role("one", "viewer").unwrap_err().status, 409);
        assert_eq!(a.set_role("one", "boss").unwrap_err().status, 400);
        assert_eq!(a.set_role("nobody", "admin").unwrap_err().status, 404);
        db.put_user("two", "s", "h");
        a.set_role("two", "viewer").unwrap();
        assert_eq!(a.remove("one").unwrap_err().message, "The last admin cannot be removed.");
        a.remove("two").unwrap();
        assert_eq!(db.get("account:two"), Some(Value::Null));
        assert_eq!(a.list().len(), 1);
    }

    #[test]
    fn two_step_codes_once_each() {
        let clock = Arc::new(AtomicI64::new(1_700_000_000_000));
        let (db, a) = accounts_at(clock.clone());
        db.put_user("u", "s", "h");
        let s = a.start_totp("u");
        let secret = s["secret"].as_str().unwrap().to_string();
        assert!(s["uri"].as_str().unwrap().starts_with("otpauth://totp/Sentry%20Six%20Manager%3Au?secret="));
        let now = clock.load(Ordering::SeqCst);
        let code = totp(&secret, now / 1000 / 30);
        let recovery = a.enable_totp("u", &code).unwrap();
        assert_eq!(recovery.len(), 10);
        assert!(a.two_factor_on("u"));
        // the same code again is refused
        assert!(!a.verify_code("u", &code));
        clock.fetch_add(30_000, Ordering::SeqCst);
        assert!(a.verify_code("u", &totp(&secret, now / 1000 / 30 + 1)));
        assert!(a.verify_code("u", &recovery[0].replace('-', " ").to_uppercase()));
        assert!(!a.verify_code("u", &recovery[0]));
        assert_eq!(a.recovery_left("u"), 9);
        let token = a.start_pending("u");
        assert_eq!(a.pending_user(Some(&token)).as_deref(), Some("u"));
        for i in 1..=5 {
            let (e, over) = a.finish_pending(Some(&token), "000000").unwrap_err();
            assert_eq!(over, i == 5);
            assert_eq!(e.message, if i == 5 { "Too many wrong codes: sign in again." } else { "That code is not right." });
        }
        assert_eq!(a.finish_pending(Some(&token), "x").unwrap_err().0.message, "The sign-in waited too long: sign in again.");
        a.disable_totp("u");
        assert!(!a.two_factor_on("u"));
    }

    #[test]
    fn viewer_rules() {
        assert!(viewer_may("GET", "/api/vehicles"));
        assert!(!viewer_may("GET", "/api/logs"));
        assert!(!viewer_may("GET", "/api/security/access"));
        assert!(viewer_may("POST", "/api/auth/logout"));
        assert!(viewer_may("POST", "/api/stars/abc"));
        assert!(!viewer_may("POST", "/api/jobs/clear"));
        assert!(!viewer_may("DELETE", "/api/accounts/x"));
        assert!(viewer_may("GET", "/api/can/signals"));
        assert!(!viewer_may("GET", "/api/can/settings"));
    }
}
