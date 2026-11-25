//! Trust in CAN Bridge logs (server/canTrust.js): each finished log's ECDSA
//! P-256 signature in its sidecar, the car's pairing (the first signed log
//! pins its key), each log's status (verified, failed, unsigned, waiting),
//! the chain (gaps, mismatches, duplicates, reorders, restarts), and the
//! records judged again after a rule change.
//!
//!   <DATA>/can/<vehicleKey>/trust.json   { v, pin, newKey, logs: { name: record },
//!                                          tombstones: { name: tombstone }, tombstonesV }
//!
//! A tombstone is kept for each log deleted here on purpose (see CanLogs::delete_log): its
//! size, SHA-256, sidecar size, the upload API's check it had, when and why, and when the log
//! ended. A log that vanished without the server deleting it (a crash, a lost disk) has none.

use super::json::{self, js_number, js_str, n};
use super::logs::parse_name;
use super::util::{self, one_line};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const VERSION: &str = "canbridge-log-sig-v1";
pub const ALGORITHM: &str = "ECDSA-P256-SHA256";
const WAIT_MS: f64 = 10.0 * 60.0 * 1000.0;
pub const JUDGE_V: i64 = 2;
pub const COULD_NOT_SIGN: &str = "bridge-could-not-sign";
/// The reason of a record whose log (or sidecar) was just replaced by a new copy.
const REPLACED: &str = "replaced by a new copy; checking it again";
/// The reason of a replaced record whose new copy could not be read when judged: it waits to be
/// judged again (pending()), and is not open to another copy meanwhile.
const UNREAD: &str = "replaced by a new copy; it could not be read yet, checking it again";

/// Which half of a log's pair a new copy is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Half {
    Log,
    Sidecar,
}

impl Half {
    fn word(self) -> &'static str {
        match self {
            Half::Log => "log",
            Half::Sidecar => "sidecar",
        }
    }
}
const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";
/// The version of the tombstones worked out from what an older server kept (`tombstonesV`).
pub const TOMBSTONES_V: i64 = 1;

/// What `CanTrust::buried` knows of a log that is not here.
#[derive(Debug, Clone, PartialEq)]
pub enum Buried {
    /// nothing: it was never deleted here on purpose (missing)
    No,
    /// deleted here on purpose: its tombstone
    Tomb(Value),
    /// its record says an older server deleted it, and this car key's tombstones of such
    /// deletes are not worked out yet (just after a start): not known yet (its record's length)
    NotDerived(Option<f64>),
}

/// SHA-256 of a public key's DER, hex in pairs with colons.
pub fn fingerprint_of(der: &[u8]) -> String {
    let h = util::hex(&Sha256::digest(der)).to_uppercase();
    h.as_bytes().chunks(2).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join(":")
}

fn hex_only(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_hexdigit()).collect::<String>().to_lowercase()
}
pub fn same_fingerprint(a: &str, b: &str) -> bool {
    hex_only(a) == hex_only(b)
}

/// The exact bytes the bridge signs.
pub fn signed_message(vehicle_key: &str, name: &str, sha256: &str, length: f64, index: f64, prev_name: &str, prev_sha256: &str) -> String {
    format!("{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n", VERSION, vehicle_key, name, sha256, json::num_str(length), json::num_str(index), prev_name, prev_sha256)
}

/// Buffer.from(s, 'base64'): both alphabets, other characters skipped, stops at padding.
pub fn base64_loose(s: &str) -> Vec<u8> {
    let mut vals = Vec::new();
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        vals.push(v);
    }
    let mut out = Vec::with_capacity(vals.len() * 3 / 4);
    for ch in vals.chunks(4) {
        let mut acc: u32 = 0;
        for (i, v) in ch.iter().enumerate() {
            acc |= (*v as u32) << (18 - 6 * i);
        }
        let bytes = [(acc >> 16) as u8, (acc >> 8) as u8, acc as u8];
        let k = match ch.len() {
            4 => 3,
            3 => 2,
            2 => 1,
            _ => 0,
        };
        out.extend_from_slice(&bytes[..k]);
    }
    out
}

pub fn base64(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(b)
}

enum KeyRead {
    P256(p256::ecdsa::VerifyingKey),
    Other,
    Bad,
}

fn read_key(der: &[u8]) -> KeyRead {
    use p256::pkcs8::der::Decode;
    let Ok(spki) = p256::pkcs8::SubjectPublicKeyInfoRef::from_der(der) else { return KeyRead::Bad };
    let oid = spki.algorithm.oid.to_string();
    const EC: &str = "1.2.840.10045.2.1";
    const P256: &str = "1.2.840.10045.3.1.7";
    if oid == EC {
        let curve = spki.algorithm.parameters.and_then(|p| p.decode_as::<p256::pkcs8::ObjectIdentifier>().ok()).map(|o| o.to_string());
        if curve.as_deref() == Some(P256) {
            return match p256::ecdsa::VerifyingKey::from_sec1_bytes(spki.subject_public_key.raw_bytes()) {
                Ok(k) => KeyRead::P256(k),
                Err(_) => KeyRead::Bad,
            };
        }
        return KeyRead::Other;
    }
    // other key types OpenSSL reads (RSA, RSA-PSS, DSA, DH, Ed25519, Ed448, X25519, X448)
    if ["1.2.840.113549.1.1.1", "1.2.840.113549.1.1.10", "1.2.840.10040.4.1", "1.2.840.113549.1.3.1", "1.2.840.10046.2.1", "1.3.101.110", "1.3.101.111", "1.3.101.112", "1.3.101.113"].contains(&oid.as_str()) {
        return KeyRead::Other;
    }
    KeyRead::Bad
}

/// What checkSignature finds.
#[derive(Debug, Clone, Default)]
pub struct Check {
    pub sha256: String,
    pub length: f64,
    pub chain_note: Option<String>,
    pub signed: bool,
    pub ok: bool,
    pub reason: Option<String>,
    pub bridge_error: Option<String>,
    pub fingerprint: Option<String>,
    pub public_key: Option<String>,
    pub index: Option<f64>,
    pub prev_name: Option<String>,
    pub prev_sha256: Option<String>,
}

/// Check one log against its sidecar's signature (no pairing decisions here).
pub fn check_signature(file: &Path, name: &str, sidecar: Option<&Value>) -> std::io::Result<Check> {
    let nm = parse_name(name);
    let (sha256, length) = util::hash_file(file)?;
    let mut base = Check { sha256: sha256.clone(), length: length as f64, ..Default::default() };
    let g = sidecar.and_then(|s| s.get("integrity")).filter(|g| g.is_object());
    let note = g.and_then(|g| g.get("chain_note")).and_then(|v| v.as_str()).map(|s| one_line(s, 300)).filter(|s| !s.is_empty());
    base.chain_note = note;
    let Some(g) = g.filter(|g| g.get("signed") == Some(&Value::Bool(true))) else {
        let error = g.filter(|g| g.get("signed") == Some(&Value::Bool(false))).and_then(|g| g.get("error")).and_then(|e| e.as_str()).map(|s| one_line(s, 120)).filter(|s| !s.is_empty());
        base.reason = Some(match &error {
            Some(e) => format!("not signed: {}", e),
            None => "not signed".into(),
        });
        base.bridge_error = error;
        return Ok(base);
    };
    base.signed = true;
    let fail = |mut c: Check, reason: String| -> std::io::Result<Check> {
        c.ok = false;
        c.reason = Some(reason);
        Ok(c)
    };
    if g.get("version").and_then(|v| v.as_str()) != Some(VERSION) {
        return fail(base, format!("unknown signature version {}", util::utf16_slice(&js_str(g.get("version")), 40)));
    }
    if g.get("algorithm").and_then(|v| v.as_str()) != Some(ALGORITHM) {
        return fail(base, format!("unknown algorithm {}", util::utf16_slice(&js_str(g.get("algorithm")), 40)));
    }
    let pk = match g.get("public_key") {
        None | Some(Value::Null) => String::new(),
        Some(v) if !json::truthy(Some(v)) => String::new(),
        Some(v) => json::js_str(Some(v)),
    };
    let der = base64_loose(&pk);
    let key = match read_key(&der) {
        KeyRead::Bad => return fail(base, "the public key cannot be read".into()),
        KeyRead::Other => return fail(base, "not a P-256 key".into()),
        KeyRead::P256(k) => k,
    };
    let fingerprint = fingerprint_of(&der);
    let index = js_number(g.get("index"));
    let prev_name = match g.get("prev_name") {
        None | Some(Value::Null) => String::new(),
        v => js_str(v),
    };
    let prev_sha = match g.get("prev_sha256") {
        None | Some(Value::Null) => String::new(),
        v => js_str(v),
    }
    .to_lowercase();
    let idx_ok = index.fract() == 0.0 && index.abs() <= 9_007_199_254_740_991.0 && index >= 0.0;
    base.fingerprint = Some(fingerprint.clone());
    base.index = idx_ok.then_some(index);
    base.prev_name = Some(prev_name.clone());
    base.prev_sha256 = Some(prev_sha.clone());
    let kf = g.get("key_fingerprint");
    if json::truthy(kf) && !same_fingerprint(&js_str(kf), &fingerprint) {
        return fail(base, "the key fingerprint does not match the key".into());
    }
    if g.get("vehicle_key").and_then(|v| v.as_str()) != nm.as_ref().map(|x| x.vehicle_key.as_str()) || g.get("vehicle_key").is_none() && nm.is_none() {
        return fail(base, "signed for another car key".into());
    }
    let gs = g.get("sha256").filter(|v| json::truthy(Some(v))).map(|v| js_str(Some(v))).unwrap_or_default().to_lowercase();
    if gs != sha256 {
        return fail(base, "the file is not the one that was signed (SHA-256 differs)".into());
    }
    if js_number(g.get("length")) != length as f64 {
        return fail(base, "the file is not the one that was signed (length differs)".into());
    }
    if !idx_ok {
        return fail(base, "bad chain index".into());
    }
    if prev_name.encode_utf16().count() > 200 || prev_sha.len() != 64 || !prev_sha.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        return fail(base, "bad chain fields".into());
    }
    let nm = nm.unwrap();
    let message = signed_message(&nm.vehicle_key, name, &sha256, length as f64, index, &prev_name, &prev_sha);
    let sig_text = g.get("signature").filter(|v| json::truthy(Some(v))).map(|v| js_str(Some(v))).unwrap_or_default();
    let sig = base64_loose(&sig_text);
    let good = {
        use p256::ecdsa::signature::Verifier;
        p256::ecdsa::Signature::from_der(&sig).map(|s| key.verify(message.as_bytes(), &s).is_ok()).unwrap_or(false)
    };
    base.public_key = Some(base64(&der));
    base.index = Some(index);
    if good {
        base.ok = true;
        base.reason = None;
        Ok(base)
    } else {
        fail(base, "the signature does not match".into())
    }
}

#[derive(Debug, Clone)]
pub struct TrustFile {
    pub v: f64,
    pub pin: Value,
    pub new_key: Value,
    pub logs: Map<String, Value>,
    /// the logs deleted here on purpose (see CanTrust::bury)
    pub tombstones: Map<String, Value>,
    /// the tombstones of logs deleted before this server kept them were worked out (`TOMBSTONES_V`)
    pub tombstones_v: Value,
}

impl TrustFile {
    fn to_value(&self) -> Value {
        let mut v = json!({ "v": n(self.v), "pin": self.pin, "newKey": self.new_key, "logs": self.logs });
        if !self.tombstones.is_empty() || !self.tombstones_v.is_null() {
            v["tombstones"] = Value::Object(self.tombstones.clone());
            v["tombstonesV"] = self.tombstones_v.clone();
        }
        v
    }
}

pub struct CanTrust {
    dir: PathBuf,
    now: Box<dyn Fn() -> f64 + Send + Sync>,
    cache: Mutex<HashMap<String, Arc<Mutex<TrustFile>>>>,
    pub log: Box<dyn Fn(&str, &str) + Send + Sync>,
}

fn set(rec: &mut Map<String, Value>, k: &str, v: Value) {
    rec.insert(k.to_string(), v);
}
fn opt_s(v: &Option<String>) -> Value {
    v.clone().map(Value::String).unwrap_or(Value::Null)
}

impl CanTrust {
    pub fn new(dir: PathBuf, now: Box<dyn Fn() -> f64 + Send + Sync>) -> Arc<CanTrust> {
        Arc::new(CanTrust { dir, now, cache: Mutex::new(HashMap::new()), log: Box::new(|_, _| {}) })
    }
    pub fn with_log(dir: PathBuf, now: Box<dyn Fn() -> f64 + Send + Sync>, log: Box<dyn Fn(&str, &str) + Send + Sync>) -> Arc<CanTrust> {
        Arc::new(CanTrust { dir, now, cache: Mutex::new(HashMap::new()), log })
    }

    fn file_of(&self, key: &str) -> PathBuf {
        self.dir.join(key).join("trust.json")
    }

    fn load(&self, key: &str) -> Arc<Mutex<TrustFile>> {
        let mut c = self.cache.lock().unwrap();
        if let Some(t) = c.get(key) {
            return t.clone();
        }
        let raw = util::read_json(&self.file_of(key)).filter(|v| v.is_object()).unwrap_or_else(|| json!({ "v": JUDGE_V }));
        let truthy_or = |k: &str| raw.get(k).filter(|v| json::truthy(Some(v))).cloned().unwrap_or(Value::Null);
        let v = raw.get("v").filter(|v| json::truthy(Some(v))).and_then(|v| v.as_f64()).unwrap_or(1.0);
        let t = TrustFile {
            v,
            pin: truthy_or("pin"),
            new_key: truthy_or("newKey"),
            logs: raw.get("logs").and_then(|l| l.as_object()).cloned().unwrap_or_default(),
            tombstones: raw.get("tombstones").and_then(|l| l.as_object()).cloned().unwrap_or_default(),
            tombstones_v: raw.get("tombstonesV").cloned().unwrap_or(Value::Null),
        };
        let a = Arc::new(Mutex::new(t));
        c.insert(key.to_string(), a.clone());
        a
    }

    fn save(&self, key: &str, t: &TrustFile) {
        let _ = std::fs::create_dir_all(self.dir.join(key));
        let f = self.file_of(key);
        let tmp = f.with_file_name(format!("trust.json.{}.tmp", std::process::id()));
        if std::fs::write(&tmp, json::stringify(&t.to_value())).is_ok() {
            let _ = std::fs::rename(&tmp, &f);
        }
    }

    /// check(key, name): judge one log, its record.
    pub fn check(&self, key: &str, name: &str) -> Value {
        let tf = self.load(key);
        let mut t = tf.lock().unwrap();
        self.check_locked(key, name, &mut t)
    }

    fn check_locked(&self, key: &str, name: &str, t: &mut TrustFile) -> Value {
        let file = self.dir.join(key).join(name);
        let had = t.logs.get(name).and_then(|r| r.as_object()).cloned().unwrap_or_default();
        if std::fs::metadata(&file).is_err() {
            return Value::Object(had);
        }
        let side_path = PathBuf::from(format!("{}.json", file.display()));
        let side = std::fs::read_to_string(&side_path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
        let side_here = side.is_some();
        let now = (self.now)();
        let mut rec = had.clone();
        // judged (or waiting for its sidecar) from here on: no half is open to a new copy
        rec.remove("replaced");
        // a copy here is judged as itself: a deleted copy's mark does not hide it
        rec.remove("deleted");
        rec.remove("lost");
        set(&mut rec, "checkedAt", n(now));
        let first_seen = had.get("firstSeen").filter(|v| json::truthy(Some(v))).cloned().unwrap_or(n(now));
        set(&mut rec, "firstSeen", first_seen.clone());
        if !side_here && now - first_seen.as_f64().unwrap_or(now) < WAIT_MS {
            set(&mut rec, "status", json!("waiting"));
            set(&mut rec, "reason", json!("waiting for its sidecar"));
            t.logs.insert(name.to_string(), Value::Object(rec.clone()));
            self.save(key, t);
            return Value::Object(rec);
        }
        let c = match check_signature(&file, name, side.as_ref()) {
            Ok(c) => c,
            Err(_) => {
                // a just-replaced copy that could not be read stays waiting (judged again by the
                // pending pass), but is no longer open to a new copy of either half
                if had.get("reason").and_then(|x| x.as_str()) == Some(REPLACED) {
                    let mut r = had;
                    r.remove("replaced");
                    r.insert("reason".into(), json!(UNREAD));
                    t.logs.insert(name.to_string(), Value::Object(r.clone()));
                    self.save(key, t);
                    return Value::Object(r);
                }
                return Value::Object(had);
            }
        };
        set(&mut rec, "v", json!(JUDGE_V));
        set(&mut rec, "kind", Value::Null);
        set(&mut rec, "sha256", json!(c.sha256));
        set(&mut rec, "length", n(c.length));
        set(&mut rec, "signed", json!(c.signed));
        set(&mut rec, "fingerprint", opt_s(&c.fingerprint));
        set(&mut rec, "index", c.index.map(n).unwrap_or(Value::Null));
        set(&mut rec, "prevName", opt_s(&c.prev_name));
        set(&mut rec, "prevSha256", opt_s(&c.prev_sha256));
        set(&mut rec, "chainNote", opt_s(&c.chain_note));
        let pinned = !t.pin.is_null();
        if !c.signed && pinned && c.bridge_error.is_some() {
            set(&mut rec, "status", json!("failed"));
            set(&mut rec, "kind", json!(COULD_NOT_SIGN));
            set(&mut rec, "reason", json!(format!("unsigned: the CAN Bridge could not sign it ({})", c.bridge_error.clone().unwrap())));
        } else if !c.signed {
            if pinned {
                set(&mut rec, "status", json!("failed"));
                set(&mut rec, "reason", json!(format!("{}, but this car is paired with a key", c.reason.clone().unwrap_or_default())));
            } else {
                set(&mut rec, "status", json!("unsigned"));
                set(&mut rec, "reason", opt_s(&c.reason));
            }
        } else if !c.ok {
            set(&mut rec, "status", json!("failed"));
            set(&mut rec, "reason", opt_s(&c.reason));
        } else if !pinned {
            let fp = c.fingerprint.clone().unwrap();
            t.pin = json!({ "fingerprint": fp, "publicKey": c.public_key, "pinnedAt": n(now), "how": "first signed upload" });
            t.new_key = Value::Null;
            (self.log)("info", &format!("CAN Bridge {}: paired with key {}", key, fp));
            set(&mut rec, "status", json!("verified"));
            set(&mut rec, "reason", Value::Null);
        } else if same_fingerprint(c.fingerprint.as_deref().unwrap_or(""), t.pin.get("fingerprint").and_then(|f| f.as_str()).unwrap_or("")) {
            set(&mut rec, "status", json!("verified"));
            set(&mut rec, "reason", Value::Null);
        } else {
            let fp = c.fingerprint.clone().unwrap();
            let first = if t.new_key.get("fingerprint").and_then(|f| f.as_str()) == Some(fp.as_str()) { t.new_key.get("firstSeen").cloned().unwrap_or(Value::Null) } else { n(now) };
            t.new_key = json!({ "fingerprint": fp, "publicKey": c.public_key, "firstSeen": first, "log": name });
            set(&mut rec, "status", json!("failed"));
            set(&mut rec, "reason", json!("signed by a key this car is not paired with"));
        }
        t.logs.insert(name.to_string(), Value::Object(rec.clone()));
        self.save(key, t);
        if rec.get("status").and_then(|s| s.as_str()) == Some("failed") {
            (self.log)("warn", &format!("CAN Bridge {}: {} failed: {}", key, name, rec.get("reason").and_then(|r| r.as_str()).unwrap_or("")));
        }
        Value::Object(rec)
    }

    /// checks(key, logs): the upload API's `check` for each (log name, its size here):
    /// ("verified" | "failed" | "pending", reason when failed). Read from the stored records
    /// (judged when the log or its sidecar arrived), never by hashing a file again.
    pub fn checks(&self, key: &str, logs: &[(String, f64)]) -> Vec<(&'static str, Option<&'static str>)> {
        let tf = self.load(key);
        let t = tf.lock().unwrap();
        let side_here = |name: &str| self.sidecar_here(key, name);
        logs.iter().map(|(name, size)| Self::check_answer(&t, name, *size, &side_here)).collect()
    }

    /// Whether the log's sidecar is here (all of it: one still arriving is a `.part`).
    fn sidecar_here(&self, key: &str, name: &str) -> bool {
        std::fs::metadata(self.dir.join(key).join(format!("{}.json", name))).is_ok_and(|m| m.is_file())
    }

    /// A record judged not signed: by its sidecar, or for want of one after 10 minutes.
    fn not_signed(r: &Value) -> bool {
        r.get("signed") == Some(&Value::Bool(false)) || r.get("kind").and_then(|k| k.as_str()) == Some(COULD_NOT_SIGN)
    }

    fn check_answer(t: &TrustFile, name: &str, size: f64, side_here: &dyn Fn(&str) -> bool) -> (&'static str, Option<&'static str>) {
        let Some(r) = t.logs.get(name) else { return ("pending", None) };
        // the record of a copy deleted here: a copy here now is not judged yet
        if json::truthy(r.get("deleted")) {
            return ("pending", None);
        }
        Self::answer_of(t, name, r, size, side_here)
    }

    fn answer_of(t: &TrustFile, name: &str, r: &Value, size: f64, side_here: &dyn Fn(&str) -> bool) -> (&'static str, Option<&'static str>) {
        let st = r.get("status").and_then(|s| s.as_str()).unwrap_or("");
        // a record of another copy of this name (replaced, not judged again yet)
        if st == "waiting" || r.get("length").and_then(|l| l.as_f64()) != Some(size) {
            return ("pending", None);
        }
        // judged not signed for want of a sidecar (10 minutes without one): for the bridge the
        // sidecar has not arrived yet (the server itself still goes by the record)
        if Self::not_signed(r) && !side_here(name) {
            return ("pending", None);
        }
        match st {
            "verified" => match Self::link_fits(t, r, side_here) {
                Some(true) => ("verified", None),
                Some(false) => ("failed", Some("chain_break")),
                None => ("pending", None),
            },
            "unsigned" => ("failed", Some("unsigned")),
            "failed" => ("failed", Some(fault_of(r))),
            _ => ("pending", None),
        }
    }

    /// Whether a verified log's chain link fits the log it names as its previous one: None
    /// while that one is here but not judged yet, or judged not signed for want of its sidecar
    /// (unsigned logs are not part of the chain, so a signed log never names one: its sidecar
    /// has not arrived yet). A previous log that is not here (not sent yet, or lost on the
    /// bridge: a gap) or that failed its own check (not signed by the sidecar that is here
    /// included) is not this log's fault.
    fn link_fits(t: &TrustFile, r: &Value, side_here: &dyn Fn(&str) -> bool) -> Option<bool> {
        let s = |r: &Value, k: &str| r.get(k).and_then(|v| v.as_str()).map(String::from);
        let index = r.get("index").and_then(|x| x.as_f64())?;
        let prev_name = s(r, "prevName").unwrap_or_default();
        let prev_sha = s(r, "prevSha256").unwrap_or_default();
        if prev_name == "-" {
            return Some(index == 0.0 && prev_sha == ZERO);
        }
        if index < 1.0 {
            return Some(false);
        }
        let Some(p) = t.logs.get(&prev_name) else { return Some(true) };
        // a previous log waiting to be judged (again) is not known yet, whatever its old
        // record says
        if matches!(p.get("status").and_then(|x| x.as_str()), Some("waiting") | None) {
            return None;
        }
        if Self::not_signed(p) {
            return if side_here(&prev_name) { Some(true) } else { None };
        }
        if p.get("status").and_then(|x| x.as_str()) == Some("failed") {
            return Some(true);
        }
        let same_key = match (s(p, "fingerprint"), s(r, "fingerprint")) {
            (Some(a), Some(b)) => same_fingerprint(&a, &b),
            _ => false,
        };
        Some(same_key && s(p, "sha256").as_deref() == Some(prev_sha.as_str()) && p.get("index").and_then(|x| x.as_f64()) == Some(index - 1.0))
    }

    /// Whether a new copy of this log (or of its sidecar) may take the stored one's place, from
    /// the stored record alone: its own check failed (mismatch, bad signature, bad chain
    /// fields, or not signed by the sidecar that is here), for this copy (`size`: the log's size
    /// here); or it waits to be judged again after one half of the pair was replaced (`half`:
    /// the half this copy is for): then only the other half may come, once (the half already
    /// replaced keeps its new copy until judged). Never for a chain break worked out at status
    /// time from the previous log: this log's own copy is good.
    fn replaceable(r: &Value, size: f64, side_here: bool, half: Half) -> bool {
        match r.get("status").and_then(|s| s.as_str()) {
            Some("waiting") => {
                let other = match half {
                    Half::Log => Half::Sidecar,
                    Half::Sidecar => Half::Log,
                };
                r.get("reason").and_then(|x| x.as_str()) == Some(REPLACED) && r.get("replaced").and_then(|x| x.as_str()) == Some(other.word())
            }
            Some("failed") | Some("unsigned") => r.get("length").and_then(|l| l.as_f64()) == Some(size) && (!Self::not_signed(r) || side_here),
            _ => false,
        }
    }

    /// Whether this log's record waits to be judged again because its new copy could not be
    /// read: no half is taken until then, but nothing says the bridge's copy is wrong, so the
    /// upload API answers a retryable `409 busy` rather than `exists_different`.
    pub fn rereading(&self, key: &str, name: &str) -> bool {
        let tf = self.load(key);
        let t = tf.lock().unwrap();
        t.logs.get(name).is_some_and(|r| r.get("status").and_then(|s| s.as_str()) == Some("waiting") && r.get("reason").and_then(|x| x.as_str()) == Some(UNREAD))
    }

    /// replaceable_now(key, name, size, half): see `replaceable` (a first look, before a copy arrives).
    pub fn replaceable_now(&self, key: &str, name: &str, size: f64, half: Half) -> bool {
        let side_here = self.sidecar_here(key, name);
        let tf = self.load(key);
        let t = tf.lock().unwrap();
        t.logs.get(name).is_some_and(|r| Self::replaceable(r, size, side_here, half))
    }

    /// replace_if_failed(key, name, size, half, swap): under the one lock on this car's records, and
    /// only if the stored record may still be replaced (see `replaceable`; an owner's "trust
    /// key" may have verified it meanwhile): `swap` puts the new copy in place, then the record
    /// waits to be judged again (its override and deleted marks dropped), with the half it
    /// replaced (`replaced`: "log" or "sidecar", "both" after the other one too). Ok(false):
    /// nothing was done.
    pub fn replace_if_failed(&self, key: &str, name: &str, size: f64, half: Half, swap: impl FnOnce() -> std::io::Result<()>) -> std::io::Result<bool> {
        let side_here = self.sidecar_here(key, name);
        let tf = self.load(key);
        let mut t = tf.lock().unwrap();
        let Some(r) = t.logs.get_mut(name).and_then(|r| r.as_object_mut()) else { return Ok(false) };
        if !Self::replaceable(&Value::Object(r.clone()), size, side_here, half) {
            return Ok(false);
        }
        let first = r.get("status").and_then(|s| s.as_str()) != Some("waiting");
        swap()?;
        r.insert("replaced".into(), json!(if first { half.word() } else { "both" }));
        r.insert("status".into(), json!("waiting"));
        r.insert("reason".into(), json!(REPLACED));
        r.remove("override");
        r.remove("deleted");
        r.remove("lost");
        self.save(key, &t);
        Ok(true)
    }

    /// recheck_if_failed(key, name, size, half): `replace_if_failed` with nothing to swap: the record
    /// waits to be judged again, only if it may still be replaced.
    pub fn recheck_if_failed(&self, key: &str, name: &str, size: f64, half: Half) -> bool {
        self.replace_if_failed(key, name, size, half, || Ok(())).unwrap_or(false)
    }

    /// usable(key, name): (use, trust).
    pub fn usable(&self, key: &str, name: &str) -> (bool, Option<&'static str>) {
        let tf = self.load(key);
        let t = tf.lock().unwrap();
        // a copy of a log deleted here, sent again: checked and dropped, never indexed (see
        // Can::judge), until its tombstone goes
        if t.tombstones.contains_key(name) {
            return (false, None);
        }
        let Some(r) = t.logs.get(name) else { return (false, None) };
        match r.get("status").and_then(|s| s.as_str()) {
            Some("verified") => (true, Some("verified")),
            Some("unsigned") => (true, Some("unsigned")),
            Some("failed") if json::truthy(r.get("override")) => (true, Some("override")),
            _ => (false, None),
        }
    }

    pub fn record(&self, key: &str, name: &str) -> Option<Value> {
        let tf = self.load(key);
        let t = tf.lock().unwrap();
        t.logs.get(name).cloned()
    }

    fn chain_of(t: &TrustFile) -> Value {
        let fp = t.pin.get("fingerprint").and_then(|f| f.as_str()).map(String::from);
        let at = |name: &str| parse_name(name).map(|x| x.started_at);
        let s = |r: &Value, k: &str| r.get(k).and_then(|v| v.as_str()).map(String::from);
        let mine: Vec<(String, &Value)> = t
            .logs
            .iter()
            .filter(|(_, r)| {
                fp.is_some()
                    && r.get("signed") != Some(&Value::Bool(false))
                    && r.get("fingerprint").filter(|f| json::truthy(Some(f))).and_then(|f| f.as_str()).is_some_and(|f| same_fingerprint(f, fp.as_deref().unwrap()))
                    && r.get("index").and_then(json::safe_int).is_some() && r.get("index").and_then(|x| x.as_f64()).is_some_and(|x| x.fract() == 0.0)
            })
            .map(|(k, r)| (k.clone(), r))
            .collect();
        let note_of = |r: &Value| s(r, "chainNote").filter(|x| !x.is_empty()).map(|x| format!(" (the bridge says: {})", x)).unwrap_or_default();
        let idx = |r: &Value| r.get("index").and_then(|x| x.as_f64()).unwrap_or(0.0) as i64;
        let mut geneses: Vec<i64> = mine
            .iter()
            .filter(|(nm, r)| s(r, "status").as_deref() == Some("verified") && idx(r) == 0 && s(r, "prevName").as_deref() == Some("-") && s(r, "prevSha256").as_deref() == Some(ZERO) && at(nm).is_some())
            .map(|(nm, _)| at(nm).unwrap())
            .collect();
        geneses.sort();
        let older = |a: i64| mine.iter().filter(|(nm, _)| at(nm).is_some_and(|x| x < a)).count();
        let mut bounds: Vec<i64> = Vec::new();
        for (k, &a) in geneses.iter().enumerate() {
            if ((k > 0 && a > geneses[0]) || older(a) >= 2) && !bounds.contains(&a) {
                bounds.push(a);
            }
        }
        let seg_of = |nm: &str| -> usize {
            let mut k = 0;
            if let Some(a) = at(nm) {
                while k < bounds.len() && bounds[k] <= a {
                    k += 1;
                }
            }
            k
        };
        let mut parts: Vec<Vec<&(String, &Value)>> = vec![Vec::new(); bounds.len() + 1];
        for e in &mine {
            parts[seg_of(&e.0)].push(e);
        }
        let mut issues: Vec<Value> = Vec::new();
        let mut segments: Vec<(i64, i64, usize, String)> = Vec::new();
        let mut restarts: Vec<Value> = Vec::new();
        for (p, part) in parts.iter().enumerate() {
            // index -> (name, record), in first-seen order
            let mut by_index: Vec<(i64, String, &Value)> = Vec::new();
            for (name, r) in part.iter().map(|e| (&e.0, e.1)) {
                let i = idx(r);
                if let Some(other) = by_index.iter().find(|x| x.0 == i) {
                    if &other.1 != name {
                        let note = { let a = note_of(r); if a.is_empty() { note_of(other.2) } else { a } };
                        issues.push(json!({ "kind": "duplicate", "index": i, "names": [other.1, name], "text": format!("two logs with index {}{}", i, note) }));
                    }
                } else {
                    by_index.push((i, name.clone(), r));
                }
            }
            let mut keys: Vec<i64> = by_index.iter().map(|x| x.0).collect();
            keys.sort();
            let get = |i: i64| by_index.iter().find(|x| x.0 == i);
            if p > 0 {
                let before = segments.last();
                if let Some(s0) = keys.first().and_then(|&i| get(i)) {
                    let note = s(s0.2, "chainNote").filter(|x| !x.is_empty());
                    let text = format!(
                        "the chain started again at {} with {}{}{}",
                        s0.0,
                        s0.1,
                        note.as_ref().map(|x| format!(" (the bridge says: {})", x)).unwrap_or_else(|| " (the bridge gave no note)".into()),
                        before.map(|b| format!(": logs signed between {} (#{}) and it cannot be checked for gaps", b.3, b.1)).unwrap_or_default()
                    );
                    restarts.push(json!({ "kind": "restart", "index": s0.0, "name": s0.1, "note": note, "after": before.map(|b| json!({ "index": b.1, "name": b.3 })), "text": text }));
                }
            }
            if keys.is_empty() {
                continue;
            }
            for (k, &i) in keys.iter().enumerate() {
                let cur = get(i).unwrap();
                if k > 0 && i != keys[k - 1] + 1 {
                    let (a, b) = (keys[k - 1] + 1, i - 1);
                    issues.push(json!({ "kind": "gap", "from": a, "to": b, "text": if b == a { format!("log {} is missing", a) } else { format!("logs {} to {} are missing", a, b) } }));
                }
                if s(cur.2, "status").as_deref() == Some("failed") {
                    issues.push(json!({ "kind": "failed", "index": i, "name": cur.1, "text": format!("log {} ({}) failed its check: {}", i, cur.1, js_str(cur.2.get("reason"))) }));
                }
                if let Some(prev) = get(i - 1) {
                    let names = |n: &str, r: &Value| s(cur.2, "prevName").as_deref() == Some(n) && cur.2.get("prevSha256") == r.get("sha256");
                    // (it may name another copy of that index: a chain continued from an older
                    // sidecar repeats indexes, each a duplicate above, and goes on from its own)
                    let follows = names(&prev.1, prev.2) || part.iter().any(|e| idx(e.1) == i - 1 && names(&e.0, e.1));
                    if s(prev.2, "status").as_deref() != Some("failed") && !follows {
                        issues.push(json!({ "kind": "mismatch", "index": i, "name": cur.1, "text": format!("log {} ({}) does not follow the stored log {} ({}): swapped or changed{}", i, cur.1, i - 1, prev.1, note_of(cur.2)) }));
                    }
                    let (a, b) = (at(&prev.1), at(&cur.1));
                    if let (Some(a), Some(b)) = (a, b) {
                        if a != 0 && b != 0 && b < a {
                            issues.push(json!({ "kind": "reordered", "index": i, "name": cur.1, "text": format!("log {} starts before log {}", i, i - 1) }));
                        }
                    }
                }
            }
            let last = *keys.last().unwrap();
            segments.push((keys[0], last, keys.len(), get(last).unwrap().1.clone()));
        }
        if segments.is_empty() {
            return json!({ "count": 0, "first": null, "last": null, "issues": issues, "restarts": restarts, "segments": [] });
        }
        json!({
            "count": segments.iter().map(|x| x.2).sum::<usize>(), "first": segments[0].0, "last": segments[segments.len() - 1].1,
            "issues": issues, "restarts": restarts, "segments": segments.iter().map(|x| json!({ "first": x.0, "last": x.1, "count": x.2 })).collect::<Vec<_>>()
        })
    }

    pub fn chain(&self, key: &str) -> Value {
        let tf = self.load(key);
        let t = tf.lock().unwrap();
        Self::chain_of(&t)
    }

    fn summary_of(key: &str, t: &TrustFile) -> Value {
        let mut counts = [0usize; 4];
        let (mut cns, mut used) = (0, 0);
        for r in t.logs.values() {
            if json::truthy(r.get("deleted")) {
                continue;
            }
            let st = r.get("status").and_then(|s| s.as_str()).unwrap_or("");
            if let Some(i) = ["verified", "failed", "unsigned", "waiting"].iter().position(|x| *x == st) {
                counts[i] += 1;
            }
            if st == "failed" && r.get("kind").and_then(|k| k.as_str()) == Some(COULD_NOT_SIGN) {
                cns += 1;
                if json::truthy(r.get("override")) {
                    used += 1;
                }
            }
        }
        let pin = if t.pin.is_null() { Value::Null } else { json!({ "fingerprint": t.pin.get("fingerprint"), "pinnedAt": t.pin.get("pinnedAt"), "how": t.pin.get("how") }) };
        let nk = if t.new_key.is_null() { Value::Null } else { json!({ "fingerprint": t.new_key.get("fingerprint"), "firstSeen": t.new_key.get("firstSeen") }) };
        json!({
            "key": key, "couldNotSign": { "count": cns, "used": used }, "pin": pin, "newKey": nk,
            "counts": { "verified": counts[0], "failed": counts[1], "unsigned": counts[2], "waiting": counts[3] }, "chain": Self::chain_of(t)
        })
    }

    /// summary(key): what the Nerd settings show for a car key.
    pub fn summary(&self, key: &str) -> Value {
        let tf = self.load(key);
        let t = tf.lock().unwrap();
        Self::summary_of(key, &t)
    }

    /// trustKey: the waiting new key, by its fingerprint; every log it signed judged again.
    pub fn trust_key(&self, key: &str, fingerprint: &str) -> Result<Value, (u16, String)> {
        let tf = self.load(key);
        let mut t = tf.lock().unwrap();
        let nk = t.new_key.get("fingerprint").and_then(|f| f.as_str()).map(String::from);
        if nk.as_deref().is_none_or(|f| !same_fingerprint(f, fingerprint)) {
            return Err((404, "No such new key for this car.".into()));
        }
        t.pin = json!({ "fingerprint": nk, "publicKey": t.new_key.get("publicKey"), "pinnedAt": n((self.now)()), "how": "confirmed by the owner" });
        t.new_key = Value::Null;
        self.save(key, &t);
        let names: Vec<String> = t.logs.iter().filter(|(_, r)| r.get("status").and_then(|s| s.as_str()) != Some("verified") && !json::truthy(r.get("deleted"))).map(|(k, _)| k.clone()).collect();
        for nm in names {
            self.check_locked(key, &nm, &mut t);
        }
        Ok(Self::summary_of(key, &t))
    }

    pub fn forget_pin(&self, key: &str) -> Value {
        let tf = self.load(key);
        let mut t = tf.lock().unwrap();
        t.pin = Value::Null;
        t.new_key = Value::Null;
        self.save(key, &t);
        Self::summary_of(key, &t)
    }

    pub fn set_override(&self, key: &str, name: &str, on: bool) -> Result<Value, (u16, String)> {
        let tf = self.load(key);
        let mut t = tf.lock().unwrap();
        let ok = t.logs.get(name).is_some_and(|r| r.get("status").and_then(|s| s.as_str()) == Some("failed"));
        if !ok {
            return Err((409, "Only a failed log can be used anyway.".into()));
        }
        let r = t.logs.get_mut(name).unwrap().as_object_mut().unwrap();
        r.insert("override".into(), json!(on));
        let out = Value::Object(r.clone());
        self.save(key, &t);
        Ok(out)
    }

    pub fn set_override_could_not_sign(&self, key: &str, on: bool) -> Vec<String> {
        let tf = self.load(key);
        let mut t = tf.lock().unwrap();
        let mut names = Vec::new();
        for (k, r) in t.logs.iter_mut() {
            let Some(r) = r.as_object_mut() else { continue };
            if json::truthy(r.get("deleted")) || r.get("status").and_then(|s| s.as_str()) != Some("failed") || r.get("kind").and_then(|s| s.as_str()) != Some(COULD_NOT_SIGN) || json::truthy(r.get("override")) == on {
                continue;
            }
            r.insert("override".into(), json!(on));
            names.push(k.clone());
        }
        if !names.is_empty() {
            self.save(key, &t);
        }
        names.sort();
        names
    }

    pub fn deleted(&self, key: &str, name: &str) {
        let tf = self.load(key);
        let mut t = tf.lock().unwrap();
        if let Some(r) = t.logs.get_mut(name).and_then(|r| r.as_object_mut()) {
            r.insert("deleted".into(), json!(true));
            self.save(key, &t);
        }
    }

    /// lost(key, name): a rule went to delete a log whose file was already gone (404: lost on a
    /// disk, removed by hand). Its record stays for the chain and is hidden as a deleted one's,
    /// but marked `lost` too: nothing shows it was deleted on purpose, so it never gets a
    /// tombstone (it stays missing and may be sent again).
    pub fn lost(&self, key: &str, name: &str) {
        let tf = self.load(key);
        let mut t = tf.lock().unwrap();
        if let Some(r) = t.logs.get_mut(name).and_then(|r| r.as_object_mut()) {
            r.insert("deleted".into(), json!(true));
            r.insert("lost".into(), json!(true));
            self.save(key, &t);
        }
    }

    /// bury(key, name, tombstone): a log deleted here on purpose (its files gone already, see
    /// CanLogs::delete_log): its tombstone kept, and its record marked deleted (kept for the chain).
    pub fn bury(&self, key: &str, name: &str, tomb: Value) {
        let tf = self.load(key);
        let mut t = tf.lock().unwrap();
        if let Some(r) = t.logs.get_mut(name).and_then(|r| r.as_object_mut()) {
            r.insert("deleted".into(), json!(true));
        }
        t.tombstones.insert(name.to_string(), tomb);
        self.save(key, &t);
    }

    /// The tombstone of a log deleted here, or None.
    pub fn tomb(&self, key: &str, name: &str) -> Option<Value> {
        let tf = self.load(key);
        let t = tf.lock().unwrap();
        t.tombstones.get(name).cloned()
    }

    /// The tombstones of these logs (one lock).
    pub fn tombs(&self, key: &str, names: &[String]) -> Vec<Option<Value>> {
        let tf = self.load(key);
        let t = tf.lock().unwrap();
        if t.tombstones.is_empty() {
            return vec![None; names.len()];
        }
        names.iter().map(|n| t.tombstones.get(n).cloned()).collect()
    }

    /// What is known of these logs not here (one lock): their tombstones, and, until this car
    /// key's tombstones of an older server's deletes are worked out (derive_tombstones), the
    /// records that may still get one (marked deleted, not `lost`): `status` must not answer
    /// those missing meanwhile (the bridge would send them again, and the copy would be kept).
    pub fn buried(&self, key: &str, names: &[String]) -> Vec<Buried> {
        let tf = self.load(key);
        let t = tf.lock().unwrap();
        let derived = t.tombstones_v.as_f64().is_some_and(|v| v >= TOMBSTONES_V as f64);
        names
            .iter()
            .map(|n| match t.tombstones.get(n) {
                Some(tomb) => Buried::Tomb(tomb.clone()),
                None if derived => Buried::No,
                None => match t.logs.get(n) {
                    Some(r) if json::truthy(r.get("deleted")) && !json::truthy(r.get("lost")) => Buried::NotDerived(r.get("length").and_then(json::finite)),
                    _ => Buried::No,
                },
            })
            .collect()
    }

    /// unbury(key, name): a deleted log sent again while its car still keeps footage of its
    /// time (deleted by a rule, see CanLogs::buried_older): kept as a new log from here on (its tombstone goes; it is judged as usual).
    pub fn unbury(&self, key: &str, name: &str) -> bool {
        let tf = self.load(key);
        let mut t = tf.lock().unwrap();
        if t.tombstones.remove(name).is_none() {
            return false;
        }
        self.save(key, &t);
        true
    }

    /// rebury(key, name, size, side): a deleted log that counts as delivered (CanLogs::buried_older), sent again
    /// (`size`: its copy's size, `side`: its sidecar's, when here) and judged: the check its
    /// record now says (worked out as `status` does, with both halves here) goes into its
    /// tombstone, and the record is marked deleted again (the copy is deleted next). None while
    /// the record waits (for its sidecar, or to be read): nothing changes then.
    pub fn rebury(&self, key: &str, name: &str, size: f64, side: Option<(f64, Option<String>)>) -> Option<(&'static str, Option<&'static str>)> {
        let tf = self.load(key);
        let mut t = tf.lock().unwrap();
        let r = t.logs.get(name)?.clone();
        if r.get("status").and_then(|s| s.as_str()).is_none_or(|s| s == "waiting") || r.get("length").and_then(|l| l.as_f64()) != Some(size) {
            return None;
        }
        let (check, reason) = Self::answer_of(&t, name, &r, size, &|_| true);
        let now = (self.now)();
        let mut tomb = t.tombstones.get(name).and_then(|x| x.as_object()).cloned().unwrap_or_default();
        tomb.insert("size".into(), n(size));
        tomb.insert("sha256".into(), r.get("sha256").cloned().unwrap_or(Value::Null));
        if let Some((sd, sha)) = side {
            tomb.insert("side".into(), n(sd));
            if let Some(sha) = sha {
                tomb.insert("sideSha256".into(), json!(sha));
            }
        }
        tomb.insert("check".into(), json!(check));
        tomb.insert("checkReason".into(), reason.map(|x| json!(x)).unwrap_or(Value::Null));
        tomb.insert("recheckedAt".into(), n(now));
        t.tombstones.insert(name.to_string(), Value::Object(tomb));
        if let Some(rec) = t.logs.get_mut(name).and_then(|r| r.as_object_mut()) {
            rec.insert("deleted".into(), json!(true));
        }
        self.save(key, &t);
        Some((check, reason))
    }

    /// A deleted log's sidecar sent again on its own (its log not here): its size (and
    /// SHA-256) noted on the tombstone.
    pub fn note_side(&self, key: &str, name: &str, side: f64, sha: Option<String>) {
        let tf = self.load(key);
        let mut t = tf.lock().unwrap();
        let Some(tomb) = t.tombstones.get_mut(name).and_then(|x| x.as_object_mut()) else { return };
        tomb.insert("side".into(), n(side));
        if let Some(sha) = sha {
            tomb.insert("sideSha256".into(), json!(sha));
        }
        self.save(key, &t);
    }

    /// derive_tombstones(key, here): once per car key (`tombstonesV`), the tombstones of logs
    /// deleted here before tombstones were kept, from what trust.json still holds: a record
    /// marked deleted of a log that was received complete and judged (its SHA-256 and length),
    /// whose log is not here (`here`: its log or an upload of it is here). An older server
    /// marked records deleted in the owner's delete, "Keeping logs" and "Also delete its CAN
    /// data": after deleting the files, and also when its rule found the file already gone
    /// (404; those cannot be told apart in its records, and a rule had decided to delete each
    /// such log anyway). Since this version a 404 marks the record `lost` as well, and a `lost`
    /// record gets none. Every other record whose log is gone (no deleted mark: lost on a
    /// disk, or deleted by hand; or never judged) gets none: that log stays missing and may be
    /// sent again. Without a sidecar size in the record (it never held one), the tombstone's
    /// sidecar answers missing. (tombstoned, left missing); None when this key was done before.
    pub fn derive_tombstones(&self, key: &str, here: &dyn Fn(&str) -> bool) -> Option<(usize, usize)> {
        let tf = self.load(key);
        let mut t = tf.lock().unwrap();
        if t.tombstones_v.as_f64().is_some_and(|v| v >= TOMBSTONES_V as f64) {
            return None;
        }
        let (mut buried, mut missing) = (0, 0);
        let now = (self.now)();
        let names: Vec<String> = t.logs.keys().cloned().collect();
        for name in names {
            if t.tombstones.contains_key(&name) || here(&name) {
                continue;
            }
            let Some(nm) = parse_name(&name).filter(|x| !x.sidecar) else { continue };
            let r = t.logs[&name].clone();
            let st = r.get("status").and_then(|s| s.as_str()).unwrap_or("");
            let sha = r.get("sha256").and_then(|s| s.as_str()).filter(|s| s.len() == 64);
            let size = r.get("length").and_then(json::finite).filter(|l| *l > 0.0);
            let purposeful = json::truthy(r.get("deleted")) && !json::truthy(r.get("lost"));
            let (Some(sha), Some(size), true, true) = (sha, size, purposeful, matches!(st, "verified" | "failed" | "unsigned")) else {
                missing += 1;
                continue;
            };
            let (check, reason) = Self::answer_of(&t, &name, &r, size, &|_| true);
            let tomb = json!({
                "size": n(size), "sha256": sha, "side": null, "check": check, "checkReason": reason, "at": null, "why": "before-tombstones",
                "end": n(nm.started_at as f64 + super::prune::LOG_MAX_MS), "derivedAt": n(now)
            });
            t.tombstones.insert(name, tomb);
            buried += 1;
        }
        t.tombstones_v = json!(TOMBSTONES_V);
        self.save(key, &t);
        Some((buried, missing))
    }

    /// upgrade(key): records of an older version brought up to this one; the names to judge again.
    pub fn upgrade(&self, key: &str) -> HashSet<String> {
        let tf = self.load(key);
        let mut t = tf.lock().unwrap();
        let mut again = HashSet::new();
        let mut changed = t.v != JUDGE_V as f64;
        let dir = self.dir.join(key);
        for (name, r) in t.logs.iter_mut() {
            let Some(r) = r.as_object_mut() else { continue };
            let v = r.get("v").filter(|v| json::truthy(Some(v))).and_then(|v| v.as_f64()).unwrap_or(1.0);
            if v >= JUDGE_V as f64 || r.get("status").and_then(|s| s.as_str()) == Some("waiting") {
                continue;
            }
            changed = true;
            let deleted = json::truthy(r.get("deleted"));
            if !deleted && r.get("signed") == Some(&Value::Bool(false)) && std::fs::metadata(dir.join(name)).is_ok() {
                again.insert(name.clone());
                continue;
            }
            if !deleted && r.get("signed") == Some(&Value::Bool(true)) {
                if let Some(side) = util::read_json(&dir.join(format!("{}.json", name))) {
                    let note = side.get("integrity").and_then(|g| g.get("chain_note")).and_then(|x| x.as_str()).map(|s| one_line(s, 300)).filter(|s| !s.is_empty());
                    r.insert("chainNote".into(), opt_s(&note));
                }
            }
            r.insert("v".into(), json!(JUDGE_V));
        }
        t.v = JUDGE_V as f64;
        if changed {
            self.save(key, &t);
        }
        if !again.is_empty() {
            (self.log)("info", &format!("CAN Bridge {}: {} log{} judged again (new rules)", key, again.len(), if again.len() == 1 { "" } else { "s" }));
        }
        again
    }

    /// The deleted logs of a key whose sidecar alone is here (sent again on its own).
    pub fn lone_sides(&self, key: &str) -> Vec<String> {
        let tf = self.load(key);
        let t = tf.lock().unwrap();
        let dir = self.dir.join(key);
        t.tombstones.keys().filter(|n| std::fs::metadata(dir.join(n)).is_err() && std::fs::metadata(dir.join(format!("{}.json", n))).is_ok_and(|m| m.is_file())).cloned().collect()
    }

    /// pending(): every car key's logs not judged yet, or waiting.
    pub fn pending(&self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for key in util::subdirs(&self.dir) {
            let again = self.upgrade(&key);
            let tf = self.load(&key);
            let names = util::names(&self.dir.join(&key)).unwrap_or_default();
            let t = tf.lock().unwrap();
            for name in names {
                let Some(nm) = parse_name(&name) else { continue };
                if nm.sidecar {
                    continue;
                }
                let r = t.logs.get(&name);
                // (also: a copy of a deleted log sent again, and a copy whose record still says
                // deleted from before such copies were judged as themselves)
                if r.is_none() || r.and_then(|r| r.get("status")).and_then(|s| s.as_str()) == Some("waiting") || again.contains(&name) || t.tombstones.contains_key(&name) || r.is_some_and(|r| json::truthy(r.get("deleted"))) {
                    out.push((key.clone(), name));
                }
            }
        }
        out
    }
}

/// What a failed record's check failed on, for the upload API's `check_reason`.
fn fault_of(r: &Value) -> &'static str {
    let reason = r.get("reason").and_then(|x| x.as_str()).unwrap_or("");
    if r.get("signed") == Some(&Value::Bool(false)) || r.get("kind").and_then(|k| k.as_str()) == Some(COULD_NOT_SIGN) {
        "unsigned"
    } else if reason.contains("(SHA-256 differs)") || reason.contains("(length differs)") {
        "mismatch"
    } else if reason.starts_with("bad chain") {
        "chain_break"
    } else {
        "bad_signature"
    }
}

#[allow(dead_code)]
fn _unused(_: BTreeSet<i64>) {}
