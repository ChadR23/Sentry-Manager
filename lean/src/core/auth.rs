//! Sign-in with a local account and a cookie session (server/auth.js).
//! Passwords are scrypt (N 16384, r 8, p 1, 64 bytes) with a 32-character hex
//! salt, stored as hex: the hashes the Node server made verify here and the
//! other way round. The cookie holds a random token; its SHA-256 is stored.
//! Over HTTPS the cookie is `__Host-sm_session` (Secure), else `sm_session`.

use super::db::{now_ms, Db};
use super::log::Scope;
use base64::Engine;
use indexmap::IndexMap;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

pub const COOKIE: &str = "sm_session";
pub const SECURE_COOKIE: &str = "__Host-sm_session";
pub const SESSION_MS: i64 = 30 * 24 * 3600 * 1000;
pub const CONFIRM_MS: i64 = 10 * 60 * 1000;

pub fn sha256_hex(s: &str) -> String {
    hex(&Sha256::digest(s.as_bytes()))
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut b = vec![0u8; n];
    getrandom::getrandom(&mut b).expect("random");
    b
}

pub fn base64url(b: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

/// crypto.timingSafeEqual for two byte strings (unequal lengths are simply unequal here).
pub fn same(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// scrypt as auth.js hashPassword: the salt is the hex text itself (its UTF-8 bytes).
pub fn hash_password(password: &str, salt: &str) -> String {
    let params = scrypt::Params::new(14, 8, 1, 64).expect("scrypt params");
    let mut out = [0u8; 64];
    scrypt::scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut out).expect("scrypt");
    hex(&out)
}

pub fn new_salt() -> String {
    hex(&random_bytes(16))
}

/// The length JavaScript gives a string (UTF-16 units).
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// auth.js parseCookies: the first of a repeated name wins; a value that does not decode stays as it is.
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

/// The one-time setup code: 15 characters without look-alikes, XXXXX-XXXXX-XXXXX.
pub fn setup_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let chars: String = random_bytes(15).iter().map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect();
    format!("{}-{}-{}", &chars[..5], &chars[5..10], &chars[10..])
}

/// An error with a status, as Node's `Object.assign(new Error(msg), { status })`.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub status: u16,
    pub message: String,
}

pub fn refuse(status: u16, message: &str) -> Refusal {
    Refusal { status, message: message.to_string() }
}

fn valid_token(t: &str) -> bool {
    (20..=100).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_username(u: &str) -> bool {
    (1..=64).contains(&u.len()) && u.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'@' | b'-'))
}

#[derive(Debug, Clone, Copy)]
struct Failure {
    count: u32,
    until: i64,
}

#[derive(Default)]
struct Checking {
    keys: HashSet<String>,
    running: usize,
}

pub struct Auth {
    db: std::sync::Arc<Db>,
    log: Scope,
    setup_file: Option<PathBuf>,
    /// key -> failures (insertion order kept: newest last)
    failures: Mutex<IndexMap<String, Failure>>,
    /// session hash -> confirmed until
    confirmed: Mutex<HashMap<String, i64>>,
    code: Mutex<Option<String>>,
    checking: Mutex<Checking>,
}

/// A request as auth.js sees it: whether it came over HTTPS, its cookies and user agent.
pub struct ReqView<'a> {
    pub secure: bool,
    pub cookie: &'a str,
    pub agent: &'a str,
}

impl Auth {
    pub fn new(db: std::sync::Arc<Db>, log: Scope, setup_file: Option<PathBuf>) -> Auth {
        Auth {
            db,
            log,
            setup_file,
            failures: Mutex::new(IndexMap::new()),
            confirmed: Mutex::new(HashMap::new()),
            code: Mutex::new(None),
            checking: Mutex::new(Checking::default()),
        }
    }

    /// First start: the account from UI_USERNAME / UI_PASSWORD, or a setup code in the log.
    pub fn bootstrap(&self, ui_username: Option<&str>, ui_password: Option<&str>) {
        if self.db.user_count() == 0 {
            if let Some(pw) = ui_password.filter(|p| !p.is_empty()) {
                let name = ui_username.filter(|u| !u.is_empty()).unwrap_or("admin");
                match self.set_password(name, pw) {
                    Ok(()) => self.log.info(format!("Created account \"{name}\" from UI_PASSWORD")),
                    Err(e) => self.log.error(e.message),
                }
            }
        }
        if self.needs_setup() {
            let code = setup_code();
            self.log.warn(format!("No account yet. To create it, open the web UI and enter the setup code {code}"));
            if let Some(f) = &self.setup_file {
                let write = || -> std::io::Result<()> {
                    use std::io::Write;
                    use std::os::unix::fs::OpenOptionsExt;
                    if let Some(d) = f.parent() {
                        std::fs::create_dir_all(d)?;
                    }
                    let mut h = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(f)?;
                    h.write_all(format!("{code}\n").as_bytes())
                };
                if let Err(e) = write() {
                    self.log.warn(format!("Could not write {}: {e}", f.display()));
                }
            }
            *self.code.lock().unwrap() = Some(code);
        }
    }

    pub fn needs_setup(&self) -> bool {
        self.db.user_count() == 0
    }

    /// The setup code in force (tests, the log).
    pub fn current_code(&self) -> Option<String> {
        self.code.lock().unwrap().clone()
    }

    /// Create the first account; needs the setup code from the log.
    pub fn setup(&self, username: &str, password: &str, code: &str) -> Result<(), Refusal> {
        if !self.needs_setup() {
            return Err(refuse(409, "An account already exists."));
        }
        let given: String = code.trim().to_uppercase().chars().filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit()).collect();
        let want: String = self.code.lock().unwrap().clone().unwrap_or_default().replace('-', "");
        if want.is_empty() || given.len() != want.len() || !same(given.as_bytes(), want.as_bytes()) {
            return Err(refuse(403, "That setup code is not right. It is printed in the container log (docker logs sentry-six-manager)."));
        }
        self.set_password(username, password)?;
        *self.code.lock().unwrap() = None;
        if let Some(f) = &self.setup_file {
            let _ = std::fs::remove_file(f);
        }
        Ok(())
    }

    pub fn set_password(&self, username: &str, password: &str) -> Result<(), Refusal> {
        if !valid_username(username) {
            return Err(refuse(400, "User names may use letters, numbers and . _ @ -"));
        }
        if js_len(password) < 8 {
            return Err(refuse(400, "Use a password of at least 8 characters."));
        }
        if js_len(password) > 1024 {
            return Err(refuse(400, "That password is too long."));
        }
        let salt = new_salt();
        let hash = hash_password(password, &salt);
        self.db.put_user(username, &salt, &hash);
        Ok(())
    }

    /// Whether this is the password (None: not a string, as a JSON body may send).
    /// Hashes anyway so timing does not reveal whether the user exists.
    pub fn check(&self, username: &str, password: Option<&str>) -> bool {
        let Some(password) = password else { return false };
        if js_len(password) > 1024 {
            return false;
        }
        let user = self.db.get_user(username);
        let salt = user.as_ref().map(|u| u.salt.clone()).unwrap_or_else(|| "x".repeat(32));
        let hash = hash_password(password, &salt);
        match user {
            Some(u) => match (unhex(&hash), unhex(&u.hash)) {
                (Some(a), Some(b)) => same(&a, &b),
                _ => false,
            },
            None => false,
        }
    }

    /// Seconds still locked out for this key (0: not).
    pub fn throttled(&self, key: &str) -> i64 {
        let f = self.failures.lock().unwrap();
        match f.get(key) {
            Some(x) if x.until > now_ms() => ((x.until - now_ms()) as f64 / 1000.0).ceil() as i64,
            _ => 0,
        }
    }

    pub fn note_failure(&self, key: &str) {
        let mut map = self.failures.lock().unwrap();
        let mut f = map.shift_remove(key).unwrap_or(Failure { count: 0, until: 0 });
        f.count += 1;
        if f.count >= 5 {
            let secs = (15.0 * 60.0f64).min(2f64.powi(f.count as i32 - 5) * 30.0);
            f.until = now_ms() + (secs * 1000.0) as i64;
        }
        map.insert(key.to_string(), f);
        if map.len() > 10000 {
            // what is no longer locked goes first
            let now = now_ms();
            let mut i = 0;
            while i < map.len() && map.len() > 9000 {
                if map[i].until <= now {
                    map.shift_remove_index(i);
                } else {
                    i += 1;
                }
            }
            while map.len() > 10000 {
                map.shift_remove_index(0);
            }
        }
    }

    pub fn note_success(&self, key: &str) {
        self.failures.lock().unwrap().shift_remove(key);
    }

    /// One password check for these throttle keys; one already running for
    /// any of them, or two at all, turns this one away (429).
    pub fn attempt<T>(&self, keys: &[String], check: impl FnOnce() -> T) -> Result<T, Refusal> {
        {
            let mut c = self.checking.lock().unwrap();
            if keys.iter().any(|k| c.keys.contains(k)) || c.running >= 2 {
                return Err(refuse(429, "Another sign-in is being checked. Try again in a moment."));
            }
            for k in keys {
                c.keys.insert(k.clone());
            }
            c.running += 1;
        }
        struct Done<'a>(&'a Mutex<Checking>, &'a [String]);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                let mut c = self.0.lock().unwrap();
                c.running -= 1;
                for k in self.1 {
                    c.keys.remove(k);
                }
            }
        }
        let _done = Done(&self.checking, keys);
        Ok(check())
    }

    pub fn cookie_name(&self, secure: bool) -> &'static str {
        if secure { SECURE_COOKIE } else { COOKIE }
    }

    pub fn cookie_attrs(&self, secure: bool, max_age: i64) -> String {
        format!("HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age}{}", if secure { "; Secure" } else { "" })
    }

    /// The session token of this request (over HTTPS only the __Host- cookie counts).
    pub fn token(&self, r: &ReqView) -> Option<String> {
        let cookies = parse_cookies(r.cookie);
        let t = cookies.get(if r.secure { SECURE_COOKIE } else { COOKIE })?;
        valid_token(t).then(|| t.clone())
    }

    pub fn session_hash(&self, r: &ReqView) -> Option<String> {
        self.token(r).map(|t| sha256_hex(&t))
    }

    /// The signed-in user name, or None.
    pub fn user(&self, r: &ReqView) -> Option<String> {
        let t = self.token(r)?;
        self.db.get_session(&sha256_hex(&t)).map(|s| s.username)
    }

    /// Sign in: a fresh token every time. Returns the Set-Cookie value.
    pub fn login(&self, r: &ReqView, username: &str, ip: Option<&str>) -> String {
        if let Some(old) = self.token(r) {
            self.db.delete_session(&sha256_hex(&old));
        }
        let token = base64url(&random_bytes(32));
        let token_hash = sha256_hex(&token);
        let agent: String = r.agent.chars().take(300).collect();
        self.db.add_session(&token_hash, username, now_ms() + SESSION_MS, Some(agent.as_str()).filter(|a| !a.is_empty()), ip);
        self.confirmed.lock().unwrap().insert(token_hash, now_ms() + CONFIRM_MS);
        format!("{}={token}; {}", self.cookie_name(r.secure), self.cookie_attrs(r.secure, SESSION_MS / 1000))
    }

    /// Sign out; returns the Set-Cookie value that clears the cookie.
    pub fn logout(&self, r: &ReqView) -> String {
        if let Some(t) = self.token(r) {
            let h = sha256_hex(&t);
            self.db.delete_session(&h);
            self.confirmed.lock().unwrap().remove(&h);
        }
        format!("{}=; {}", self.cookie_name(r.secure), self.cookie_attrs(r.secure, 0))
    }

    /// Confirm the password again; opens the short window for sensitive changes.
    pub fn confirm(&self, r: &ReqView, username: &str, password: Option<&str>) -> bool {
        if !self.check(username, password) {
            return false;
        }
        if let Some(t) = self.token(r) {
            self.confirmed.lock().unwrap().insert(sha256_hex(&t), now_ms() + CONFIRM_MS);
        }
        true
    }

    pub fn recently_confirmed(&self, r: &ReqView) -> bool {
        let Some(t) = self.token(r) else { return false };
        let h = sha256_hex(&t);
        let mut c = self.confirmed.lock().unwrap();
        if c.get(&h).copied().unwrap_or(0) > now_ms() {
            return true;
        }
        c.remove(&h);
        false
    }

    pub fn forget_confirmations(&self) {
        self.confirmed.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn auth() -> (Arc<Db>, Auth) {
        let db = Arc::new(Db::memory().unwrap());
        let log = super::super::log::Logger::with("error", 10, true, None, 1).scope("auth");
        let a = Auth::new(db.clone(), log, None);
        (db, a)
    }

    #[test]
    fn node_hash_verifies() {
        // made by server/auth.js hashPassword('correct horse', '00112233445566778899aabbccddeeff')
        let want = "3e19ebeabf15ad17c24de695284e79441c0d80c6d98b95a3c052c58a0d57b09f83b0742a5805af28a0b5bbcf673af62819b91eb830a104fb0bb42def767f52aa";
        assert_eq!(hash_password("correct horse", "00112233445566778899aabbccddeeff"), want);
    }

    #[test]
    fn cookies() {
        let c = parse_cookies("a=1; sm_session=abc%20d; a=2; bad; =x; p=%zz");
        assert_eq!(c["a"], "1");
        assert_eq!(c["sm_session"], "abc d");
        assert_eq!(c["p"], "%zz");
        // (" =x": the name is the blank before "=", trimmed, as in Node)
        assert_eq!(c[""], "x");
    }

    #[test]
    fn setup_code_shape() {
        let c = setup_code();
        assert_eq!(c.len(), 17);
        assert!(c.chars().all(|x| x == '-' || "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".contains(x)));
    }

    #[test]
    fn passwords_and_names() {
        let (_db, a) = auth();
        assert_eq!(a.set_password("bad name", "longenough").unwrap_err().status, 400);
        assert_eq!(a.set_password("ok", "short").unwrap_err().message, "Use a password of at least 8 characters.");
        a.set_password("ok", "correct horse").unwrap();
        assert!(a.check("ok", Some("correct horse")));
        assert!(!a.check("ok", Some("wrong horse")));
        assert!(!a.check("nobody", Some("correct horse")));
        assert!(!a.check("ok", None));
    }

    #[test]
    fn setup_needs_the_code() {
        let (_db, a) = auth();
        a.bootstrap(None, None);
        let code = a.current_code().unwrap();
        assert_eq!(a.setup("admin", "correct horse", "WRONG").unwrap_err().status, 403);
        a.setup("admin", "correct horse", &code.to_lowercase().replace('-', " ")).unwrap();
        assert_eq!(a.setup("x", "correct horse", &code).unwrap_err().status, 409);
    }

    #[test]
    fn throttle_doubles() {
        let (_db, a) = auth();
        for _ in 0..4 {
            a.note_failure("k");
        }
        assert_eq!(a.throttled("k"), 0);
        a.note_failure("k");
        assert_eq!(a.throttled("k"), 30);
        a.note_failure("k");
        assert_eq!(a.throttled("k"), 60);
        a.note_success("k");
        assert_eq!(a.throttled("k"), 0);
    }

    #[test]
    fn parallel_checks_turned_away() {
        let (_db, a) = auth();
        let keys = vec!["ip".to_string()];
        let inner = a.attempt(&keys, || a.attempt(&keys, || ()).unwrap_err().status).unwrap();
        assert_eq!(inner, 429);
        let two = a.attempt(&["a".into()], || a.attempt(&["b".into()], || a.attempt(&["c".into()], || ()).unwrap_err().status).unwrap()).unwrap();
        assert_eq!(two, 429);
        assert!(a.attempt(&keys, || ()).is_ok());
    }

    #[test]
    fn sessions_and_cookies() {
        let (db, a) = auth();
        a.set_password("u", "correct horse").unwrap();
        let none = ReqView { secure: true, cookie: "", agent: "test agent" };
        let set = a.login(&none, "u", Some("10.0.0.1"));
        assert!(set.starts_with("__Host-sm_session="));
        assert!(set.ends_with("HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000; Secure"));
        let token = set.split(';').next().unwrap().split_once('=').unwrap().1.to_string();
        let cookie = format!("__Host-sm_session={token}");
        let r = ReqView { secure: true, cookie: &cookie, agent: "" };
        assert_eq!(a.user(&r).as_deref(), Some("u"));
        assert!(a.recently_confirmed(&r));
        // over plain HTTP the __Host- cookie does not count
        let plain = ReqView { secure: false, cookie: &cookie, agent: "" };
        assert_eq!(a.user(&plain), None);
        assert_eq!(db.sessions_for("u")[0].agent.as_deref(), Some("test agent"));
        assert_eq!(a.logout(&r), "__Host-sm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure");
        assert_eq!(a.user(&r), None);
    }
}
