//! Settings → Security (server/access.js): bans after repeated failed
//! attempts, the two-step sign-in rules, admin work only from home, and what
//! the home network is. Kept in the settings `security:access` and
//! `security:bans`, as Node keeps them.

use super::client_addr::{ban_key, home_matcher, parse_cidr, Matcher};
use super::db::{now_ms, Db};
use super::log::Scope;
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex};

pub const KEY_SETTINGS: &str = "security:access";
pub const KEY_BANS: &str = "security:bans";
const MAX_BANS: usize = 2000;
const MAX_TRACKED: usize = 10000;
const REPEAT_MS: f64 = 7.0 * 24.0 * 3600.0 * 1000.0;
const MAX_EXTRA: usize = 32;

pub fn defaults() -> Value {
    json!({
        "bans": { "enabled": true, "maxFailures": 10, "windowMinutes": 60, "banMinutes": 60, "maxBanHours": 24, "exemptHome": true },
        "twoFactor": { "outside": false, "everyone": false },
        "homeOnly": { "adminChanges": false, "adminPages": false },
        "home": { "tailscale": false, "extra": [] }
    })
}

fn limits(k: &str) -> Option<(i64, i64, &'static str)> {
    match k {
        "maxFailures" => Some((3, 100, "Failed attempts before a ban")),
        "windowMinutes" => Some((1, 1440, "The window for failed attempts (minutes)")),
        "banMinutes" => Some((1, 10080, "The first ban (minutes)")),
        "maxBanHours" => Some((1, 720, "The longest ban (hours)")),
        _ => None,
    }
}

fn bad(msg: String) -> super::auth::Refusal {
    super::auth::refuse(400, &msg)
}

/// Number(v) for a JSON value (NaN as None... as f64::NAN).
pub fn js_num(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => *b as i32 as f64,
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => super::http::js_number(s),
        Value::Array(a) if a.is_empty() => 0.0,
        Value::Array(a) if a.len() == 1 => js_num(&Value::String(super::accounts::js_string(Some(&a[0])))),
        _ => f64::NAN,
    }
}

/// Stored or sent settings filled with the defaults (Object.assign per part; bad extra ranges dropped).
pub fn with_defaults(stored: Option<&Value>) -> Value {
    let mut out = defaults();
    if let Some(Value::Object(s)) = stored {
        for (k, part) in out.as_object_mut().unwrap() {
            if let Some(Value::Object(given)) = s.get(k) {
                for (gk, gv) in given {
                    part.as_object_mut().unwrap().insert(gk.clone(), gv.clone());
                }
            }
        }
    }
    let extra = out["home"]["extra"].clone();
    out["home"]["extra"] = match extra {
        Value::Array(a) => Value::Array(a.into_iter().filter(|e| parse_cidr(&super::accounts::js_string(Some(e))).is_some()).collect()),
        _ => json!([]),
    };
    out
}

/// The extra home ranges: a list or a text of addresses and ranges.
pub fn parse_extra(v: &Value) -> Result<Vec<String>, super::auth::Refusal> {
    let items: Vec<String> = match v {
        Value::Array(a) => a.iter().map(|x| super::accounts::js_string(Some(x))).collect(),
        Value::Null => vec![],
        other => super::accounts::js_string(Some(other)).split(|c: char| c.is_whitespace() || c == ',').map(String::from).collect(),
    };
    let mut out: Vec<String> = Vec::new();
    for raw in items.iter().map(|x| x.trim()).filter(|x| !x.is_empty()) {
        let Some(c) = parse_cidr(raw) else {
            let cut: String = raw.chars().take(60).collect();
            return Err(bad(format!("\"{cut}\" is not an address or a range like 192.0.2.0/24.")));
        };
        if (!c.v6 && c.prefix < 8) || (c.v6 && c.prefix < 32) {
            return Err(bad(format!("{} is too wide to be a home network (at most /8 for IPv4, /32 for IPv6).", c.text)));
        }
        if !out.contains(&c.text) {
            out.push(c.text);
        }
    }
    if out.len() > MAX_EXTRA {
        return Err(bad(format!("At most {MAX_EXTRA} extra ranges.")));
    }
    Ok(out)
}

/// Settings as an admin sent them (a part is enough), checked (access.js validate).
pub fn validate(input: &Value, current: &Value) -> Result<Value, super::auth::Refusal> {
    let Value::Object(input) = input else { return Err(bad("Send the settings as an object.".into())) };
    let mut out = with_defaults(Some(current));
    let d = defaults();
    for (part, value) in input {
        let Some(known) = d.get(part).and_then(Value::as_object) else { return Err(bad(format!("Unknown setting \"{part}\"."))) };
        let Value::Object(value) = value else { return Err(bad(format!("\"{part}\" must be an object."))) };
        for (k, v) in value {
            if !known.contains_key(k) {
                return Err(bad(format!("Unknown setting \"{part}.{k}\".")));
            }
            if part == "home" && k == "extra" {
                out["home"]["extra"] = json!(parse_extra(v)?);
            } else if let Some((min, max, label)) = limits(k) {
                let n = js_num(v);
                if n.fract() != 0.0 || !n.is_finite() || n < min as f64 || n > max as f64 {
                    return Err(bad(format!("{label}: a whole number from {min} to {max}.")));
                }
                out[part][k] = json!(n as i64);
            } else {
                let Value::Bool(b) = v else { return Err(bad(format!("\"{part}.{k}\" is on or off (true or false)."))) };
                out[part][k] = json!(b);
            }
        }
    }
    if js_num(&out["bans"]["maxBanHours"]) * 60.0 < js_num(&out["bans"]["banMinutes"]) {
        return Err(bad("The longest ban cannot be shorter than the first ban.".into()));
    }
    Ok(out)
}

struct State {
    settings: Value,
    home: Matcher,
    /// ban key -> failure times
    failures: IndexMap<String, Vec<i64>>,
    /// ban key -> { key, at, until, reason, failures, offences }
    bans: IndexMap<String, Map<String, Value>>,
}

pub struct Access {
    db: Arc<Db>,
    audit: Option<Scope>,
    st: Mutex<State>,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
}

fn home_of(settings: &Value) -> Matcher {
    let extra: Vec<String> = settings["home"]["extra"].as_array().map(|a| a.iter().map(|x| super::accounts::js_string(Some(x))).collect()).unwrap_or_default();
    home_matcher(super::accounts::truthy(&settings["home"]["tailscale"]), &extra)
}

fn f(v: &Value) -> f64 {
    js_num(v)
}

impl Access {
    pub fn new(db: Arc<Db>, audit: Option<Scope>) -> Access {
        Access::with_clock(db, audit, Box::new(now_ms))
    }

    pub fn with_clock(db: Arc<Db>, audit: Option<Scope>, now: Box<dyn Fn() -> i64 + Send + Sync>) -> Access {
        let settings = with_defaults(db.get(KEY_SETTINGS).as_ref());
        let mut bans = IndexMap::new();
        if let Some(Value::Array(list)) = db.get(KEY_BANS) {
            for b in list {
                if let Value::Object(b) = b {
                    if let (Some(k), Some(u)) = (b.get("key").and_then(Value::as_str), b.get("until").and_then(Value::as_f64)) {
                        if u.is_finite() {
                            bans.insert(k.to_string(), b.clone());
                        }
                    }
                }
            }
        }
        let home = home_of(&settings);
        Access { db, audit, st: Mutex::new(State { settings, home, failures: IndexMap::new(), bans }), now }
    }

    fn save(&self, st: &mut State) {
        let t = (self.now)() as f64;
        st.bans.retain(|_, b| f(&b["until"]) + REPEAT_MS >= t);
        if st.bans.len() > MAX_BANS {
            let mut order: Vec<(String, f64)> = st.bans.iter().map(|(k, b)| (k.clone(), f(&b["until"]))).collect();
            order.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
            let n = st.bans.len() - MAX_BANS;
            for (k, _) in order.into_iter().take(n) {
                st.bans.shift_remove(&k);
            }
        }
        self.db.set(KEY_BANS, &Value::Array(st.bans.values().cloned().map(Value::Object).collect()));
    }

    pub fn get(&self) -> Value {
        self.st.lock().unwrap().settings.clone()
    }

    pub fn set(&self, next: &Value) -> Value {
        let mut st = self.st.lock().unwrap();
        st.settings = with_defaults(Some(next));
        st.home = home_of(&st.settings);
        self.db.set(KEY_SETTINGS, &st.settings);
        st.settings.clone()
    }

    pub fn is_home(&self, ip: &str) -> bool {
        self.st.lock().unwrap().home.check(ip)
    }

    /// The ban in force for this address, or None.
    pub fn banned(&self, ip: &str) -> Option<Value> {
        let st = self.st.lock().unwrap();
        let b = st.bans.get(&ban_key(ip))?;
        if f(&b["until"]) <= (self.now)() as f64 {
            return None;
        }
        if super::accounts::truthy(&st.settings["bans"]["exemptHome"]) && st.home.check(ip) {
            return None;
        }
        Some(Value::Object(b.clone()))
    }

    /// One failed attempt from this address; the ban, when it was the one too many.
    pub fn fail(&self, ip: &str, reason: &str) -> Option<Value> {
        let mut st = self.st.lock().unwrap();
        let cfg = st.settings["bans"].clone();
        if !super::accounts::truthy(&cfg["enabled"]) {
            return None;
        }
        if super::accounts::truthy(&cfg["exemptHome"]) && st.home.check(ip) {
            return None;
        }
        let key = ban_key(ip);
        let t = (self.now)();
        let since = t as f64 - f(&cfg["windowMinutes"]) * 60_000.0;
        let mut list: Vec<i64> = st.failures.shift_remove(&key).unwrap_or_default().into_iter().filter(|x| *x as f64 > since).collect();
        list.push(t);
        let count = list.len();
        let kept: Vec<i64> = list[list.len().saturating_sub(200)..].to_vec();
        st.failures.insert(key.clone(), kept);
        if st.failures.len() > MAX_TRACKED {
            st.failures.shift_remove_index(0);
        }
        if (count as f64) < f(&cfg["maxFailures"]) {
            return None;
        }
        Some(self.ban(&mut st, &key, reason, count))
    }

    fn ban(&self, st: &mut State, key: &str, reason: &str, count: usize) -> Value {
        let cfg = st.settings["bans"].clone();
        let t = (self.now)();
        let prev = st.bans.get(key);
        let offences = match prev {
            Some(p) if f(&p["until"]) + REPEAT_MS > t as f64 => {
                let o = p.get("offences").map(f).filter(|x| *x != 0.0 && !x.is_nan()).unwrap_or(1.0);
                o + 1.0
            }
            _ => 1.0,
        };
        let minutes = (f(&cfg["banMinutes"]) * 2f64.powf(offences - 1.0)).min(f(&cfg["maxBanHours"]) * 60.0);
        let reason_text = if reason.is_empty() { "failed attempts".to_string() } else { reason.encode_utf16().take(120).collect::<Vec<_>>().pipe(|u| String::from_utf16_lossy(&u)) };
        let until = t + (minutes * 60_000.0) as i64;
        let mut b = Map::new();
        b.insert("key".into(), json!(key));
        b.insert("at".into(), json!(t));
        b.insert("until".into(), json!(until));
        b.insert("reason".into(), json!(reason_text));
        b.insert("failures".into(), json!(count));
        b.insert("offences".into(), super::http::num(offences));
        st.bans.shift_remove(key);
        st.bans.insert(key.to_string(), b.clone());
        st.failures.shift_remove(key);
        self.save(st);
        if let Some(a) = &self.audit {
            let len = if minutes >= 60.0 && minutes % 60.0 == 0.0 { format!("{} h", super::http::num_text(minutes / 60.0)) } else { format!("{} min", super::http::num_text(minutes)) };
            let repeat = if offences > 1.0 { format!(", ban number {} this week", super::http::num_text(offences)) } else { String::new() };
            a.warn(format!(
                "Banned {key} for {len} (until {}) after {count} failed attempts in {} min (last: {reason_text}){repeat}",
                super::log::iso(until),
                super::http::num_text(f(&cfg["windowMinutes"]))
            ));
        }
        Value::Object(b)
    }

    /// Lift a ban (and forget its history and failures).
    pub fn unban(&self, key: &str, who: &str) -> Result<Value, super::auth::Refusal> {
        let k = key.trim();
        let mut st = self.st.lock().unwrap();
        let hit = st.bans.get(k).or_else(|| st.bans.get(&ban_key(k))).and_then(|b| b.get("key").and_then(Value::as_str)).map(String::from);
        let Some(hit) = hit else { return Err(super::auth::refuse(404, "That address is not banned.")) };
        st.bans.shift_remove(&hit);
        st.failures.shift_remove(&hit);
        self.save(&mut st);
        if let Some(a) = &self.audit {
            a.warn(format!("Unbanned {hit}{}", if who.is_empty() { String::new() } else { format!(": {who}") }));
        }
        Ok(json!({ "ok": true }))
    }

    /// The bans in force, newest first.
    pub fn list(&self) -> Vec<Value> {
        let st = self.st.lock().unwrap();
        let t = (self.now)() as f64;
        let mut l: Vec<&Map<String, Value>> = st.bans.values().filter(|b| f(&b["until"]) > t).collect();
        l.sort_by(|a, b| f(&b["at"]).partial_cmp(&f(&a["at"])).unwrap_or(std::cmp::Ordering::Equal));
        l.into_iter().cloned().map(Value::Object).collect()
    }

    /// Addresses with failed attempts counted now.
    pub fn watching(&self) -> usize {
        let st = self.st.lock().unwrap();
        let since = (self.now)() as f64 - f(&st.settings["bans"]["windowMinutes"]) * 60_000.0;
        st.failures.values().filter(|l| l.iter().any(|x| *x as f64 > since)).count()
    }
}

trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}
impl<T> Pipe for T {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};

    fn access(clock: Arc<AtomicI64>) -> (Arc<Db>, Access) {
        let db = Arc::new(Db::memory().unwrap());
        let c = clock.clone();
        let a = Access::with_clock(db.clone(), None, Box::new(move || c.load(Ordering::SeqCst)));
        (db, a)
    }

    #[test]
    fn validation_messages() {
        let d = defaults();
        assert_eq!(validate(&json!([]), &d).unwrap_err().message, "Send the settings as an object.");
        assert_eq!(validate(&json!({ "x": {} }), &d).unwrap_err().message, "Unknown setting \"x\".");
        assert_eq!(validate(&json!({ "bans": 1 }), &d).unwrap_err().message, "\"bans\" must be an object.");
        assert_eq!(validate(&json!({ "bans": { "y": 1 } }), &d).unwrap_err().message, "Unknown setting \"bans.y\".");
        assert_eq!(validate(&json!({ "bans": { "maxFailures": 2 } }), &d).unwrap_err().message, "Failed attempts before a ban: a whole number from 3 to 100.");
        assert_eq!(validate(&json!({ "bans": { "enabled": "yes" } }), &d).unwrap_err().message, "\"bans.enabled\" is on or off (true or false).");
        assert_eq!(validate(&json!({ "bans": { "banMinutes": 120, "maxBanHours": 1 } }), &d).unwrap_err().message, "The longest ban cannot be shorter than the first ban.");
        assert_eq!(validate(&json!({ "home": { "extra": "10.0.0.0/4" } }), &d).unwrap_err().message, "10.0.0.0/4 is too wide to be a home network (at most /8 for IPv4, /32 for IPv6).");
        let ok = validate(&json!({ "bans": { "maxFailures": "5" }, "home": { "extra": "203.0.113.0/24, 203.0.113.0/24 2001:db8::/48" } }), &d).unwrap();
        assert_eq!(ok["bans"]["maxFailures"], 5);
        assert_eq!(ok["home"]["extra"], json!(["203.0.113.0/24", "2001:db8::/48"]));
    }

    #[test]
    fn bans_double_and_persist() {
        let clock = Arc::new(AtomicI64::new(1_000_000_000_000));
        let (db, a) = access(clock.clone());
        for _ in 0..9 {
            assert!(a.fail("8.8.8.8", "wrong password").is_none());
        }
        let b = a.fail("::ffff:8.8.8.8", "wrong password").unwrap();
        assert_eq!(b["until"].as_i64().unwrap() - b["at"].as_i64().unwrap(), 3_600_000);
        assert!(a.banned("8.8.8.8").is_some());
        // home addresses are never banned
        for _ in 0..20 {
            assert!(a.fail("192.168.1.2", "x").is_none());
        }
        // a restart keeps it
        let c = clock.clone();
        let again = Access::with_clock(db.clone(), None, Box::new(move || c.load(Ordering::SeqCst)));
        assert!(again.banned("8.8.8.8").is_some());
        clock.fetch_add(3_600_001, Ordering::SeqCst);
        assert!(a.banned("8.8.8.8").is_none());
        for _ in 0..10 {
            a.fail("8.8.8.8", "x");
        }
        let b2 = a.banned("8.8.8.8").unwrap();
        assert_eq!(b2["offences"], 2);
        assert_eq!(b2["until"].as_i64().unwrap() - b2["at"].as_i64().unwrap(), 7_200_000);
        assert_eq!(a.list().len(), 1);
        a.unban("8.8.8.8", "admin").unwrap();
        assert_eq!(a.unban("8.8.8.8", "").unwrap_err().status, 404);
        // IPv6 by its /64
        for _ in 0..10 {
            a.fail("2001:db8:0:1::5", "x");
        }
        assert!(a.banned("2001:db8:0:1::99").is_some());
    }
}
