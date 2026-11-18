//! The feedback and diagnostics reports' wire protocol, v1
//! (server/reportsProtocol.js, docs/reports-api.md). The developers'
//! receiver keeps its own copy of the Node module: both must agree byte for
//! byte, which tests/reports_parity.rs checks against the Node code.
//!
//!   - The report (JSON) is gzipped and sealed to the receiver: an ephemeral
//!     X25519 key, ECDH with the receiver's key, HKDF-SHA256 (salt = ephemeral
//!     public || receiver public, info "sentry-reports v1", 32 bytes),
//!     AES-256-GCM with a random 12-byte IV and AAD "sentry-reports v1|<kid>".
//!   - The envelope is signed with the install's Ed25519 key over its hash, a
//!     timestamp and a random nonce.
//!   - It carries a proof of work: sha256(envelope hash || nonce || pow) has at
//!     least `bits` leading zero bits.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey, Verifier, VerifyingKey};
use rand_core::{OsRng, RngCore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

pub const V: i64 = 1;
pub const INFO: &str = "sentry-reports v1";
pub const MAX_BODY: usize = 8 * 1024 * 1024;
pub const MAX_PLAIN: usize = 100 * 1024 * 1024;
pub const KINDS: [&str; 5] = ["feedback", "support", "crash", "daily", "heartbeat"];
pub const ANON: &str = "ANON";

pub fn b64(b: &[u8]) -> String {
    STANDARD.encode(b)
}

/// Standard base64 of exactly `len` bytes (when given), else None.
pub fn unb64(text: &str, len: Option<usize>) -> Option<Vec<u8>> {
    let ok_chars = {
        let t = text.trim_end_matches('=');
        text.len() - t.len() <= 2 && t.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/')
    };
    if !ok_chars || text.len() % 4 != 0 {
        return None;
    }
    // Node's decoder is lenient about the last bits; the standard engine is strict.
    let buf = base64::engine::GeneralPurpose::new(&base64::alphabet::STANDARD, base64::engine::GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true)).decode(text).ok()?;
    if len.is_some_and(|l| buf.len() != l) {
        return None;
    }
    Some(buf)
}

fn unb64v(v: &Value, len: Option<usize>) -> Option<Vec<u8>> {
    v.as_str().and_then(|s| unb64(s, len))
}

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The key id of a receiver public key: the first 16 hex of its sha256.
pub fn kid_of(pub_raw: &[u8]) -> String {
    hex(&sha256(&[pub_raw]))[..16].to_string()
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReceiverKey {
    pub kid: String,
    pub public_key: String,
    pub signing_key: Option<String>,
}

/// { kid?, publicKey, signingKey? } checked, with the kid worked out.
pub fn normalize_key(kid: Option<&str>, public_key: &str, signing_key: Option<&str>) -> Result<ReceiverKey, String> {
    let pubk = unb64(public_key, Some(32)).ok_or("A receiver key needs publicKey: 32 bytes in base64.")?;
    let k = kid_of(&pubk);
    if let Some(given) = kid.filter(|s| !s.is_empty()) {
        if given != k {
            return Err(format!("The receiver key's kid {given} does not match its public key ({k})."));
        }
    }
    let sign = match signing_key.filter(|s| !s.is_empty()) {
        Some(s) => Some(unb64(s, Some(32)).ok_or("A receiver signingKey is 32 bytes in base64.")?),
        None => None,
    };
    if let Some(s) = &sign {
        let arr: [u8; 32] = s.as_slice().try_into().unwrap();
        VerifyingKey::from_bytes(&arr).map_err(|e| e.to_string())?;
    }
    Ok(ReceiverKey { kid: k, public_key: b64(&pubk), signing_key: sign.map(|s| b64(&s)) })
}

/// "sr1:<publicKey>:<signingKey>" lines, separated by spaces, ; or ,.
pub fn parse_key_line(text: &str) -> Result<Vec<ReceiverKey>, String> {
    let mut out = Vec::new();
    for part in text.split(|c: char| c.is_whitespace() || c == ';' || c == ',').filter(|p| !p.is_empty()) {
        let rest = part.strip_prefix("sr1:").unwrap_or(part);
        let is_key = |s: &str| s.len() == 44 && s.ends_with('=') && s[..43].bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/');
        let (a, b) = match rest.split_once(':') {
            Some((a, b)) => (a, Some(b)),
            None => (rest, None),
        };
        if !is_key(a) || b.is_some_and(|b| !is_key(b)) {
            let head: String = part.encode_utf16().take(20).collect::<Vec<u16>>().iter().map(|u| char::from_u32(u32::from(*u)).unwrap_or('\u{fffd}')).collect();
            return Err(format!("\"{head}…\" is not a receiver key (sr1:<public key>:<signing key>)."));
        }
        out.push(normalize_key(None, a, b)?);
    }
    Ok(out)
}

fn derive_key(shared: &[u8], epk: &[u8], pubk: &[u8]) -> [u8; 32] {
    let salt = [epk, pubk].concat();
    let hk = hkdf::Hkdf::<Sha256>::new(Some(&salt), shared);
    let mut okm = [0u8; 32];
    hk.expand(INFO.as_bytes(), &mut okm).unwrap();
    okm
}

fn aad_of(kid: &str) -> Vec<u8> {
    format!("{INFO}|{kid}").into_bytes()
}

pub fn gzip(b: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(b).unwrap();
    e.finish().unwrap()
}

/// Seals a payload to a receiver key: { v, kid, epk, iv, ct, tag }.
pub fn seal(payload: &Value, receiver_public: &str) -> Result<Value, String> {
    let pub_raw = unb64(receiver_public, Some(32)).ok_or("No receiver key.")?;
    let kid = kid_of(&pub_raw);
    let eph = x25519_dalek::EphemeralSecret::random_from_rng(OsRng);
    let epk = x25519_dalek::PublicKey::from(&eph);
    let their: [u8; 32] = pub_raw.as_slice().try_into().unwrap();
    let shared = eph.diffie_hellman(&x25519_dalek::PublicKey::from(their));
    let key = derive_key(shared.as_bytes(), epk.as_bytes(), &pub_raw);
    let mut iv = [0u8; 12];
    OsRng.fill_bytes(&mut iv);
    let plain = gzip(payload.to_string().as_bytes());
    let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
    let mut out = cipher.encrypt(Nonce::from_slice(&iv), Payload { msg: &plain, aad: &aad_of(&kid) }).map_err(|e| e.to_string())?;
    let tag = out.split_off(out.len() - 16);
    Ok(json!({ "v": V, "kid": kid, "epk": b64(epk.as_bytes()), "iv": b64(&iv), "ct": b64(&out), "tag": b64(&tag) }))
}

/// Opens an envelope with the receiver's private key (the tests' fake receiver).
/// Err: BAD_TAG, TOO_BIG, BAD_GZIP, BAD_JSON.
pub fn open(env: &Value, private: &[u8; 32], max_plain: usize) -> Result<Value, &'static str> {
    let secret = x25519_dalek::StaticSecret::from(*private);
    let pub_raw = x25519_dalek::PublicKey::from(&secret);
    let epk: [u8; 32] = unb64v(&env["epk"], Some(32)).ok_or("BAD_TAG")?.try_into().unwrap();
    let shared = secret.diffie_hellman(&x25519_dalek::PublicKey::from(epk));
    let key = derive_key(shared.as_bytes(), &epk, pub_raw.as_bytes());
    let iv = unb64v(&env["iv"], Some(12)).ok_or("BAD_TAG")?;
    let tag = unb64v(&env["tag"], Some(16)).ok_or("BAD_TAG")?;
    let mut ct = unb64v(&env["ct"], None).ok_or("BAD_TAG")?;
    ct.extend_from_slice(&tag);
    let kid = env["kid"].as_str().unwrap_or("");
    let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
    let gz = cipher.decrypt(Nonce::from_slice(&iv), Payload { msg: &ct, aad: &aad_of(kid) }).map_err(|_| "BAD_TAG")?;
    let mut text = Vec::new();
    let mut d = flate2::read::GzDecoder::new(&gz[..]).take(max_plain as u64 + 1);
    d.read_to_end(&mut text).map_err(|_| "BAD_GZIP")?;
    if text.len() > max_plain {
        return Err("TOO_BIG");
    }
    serde_json::from_slice(&text).map_err(|_| "BAD_JSON")
}

fn field(env: &Value, k: &str) -> String {
    super::super::js::to_string(&env[k])
}

/// The envelope's hash: what the signature and the proof of work are over.
pub fn envelope_hash(env: &Value) -> [u8; 32] {
    let s = format!("{INFO}|{}|{}|{}|{}|{}|{}", field(env, "v"), field(env, "kid"), field(env, "epk"), field(env, "iv"), field(env, "ct"), field(env, "tag"));
    sha256(&[s.as_bytes()])
}

pub fn signed_bytes(h: &[u8; 32], ts: &str, nonce: &str) -> Vec<u8> {
    format!("{INFO} sig|{}|{ts}|{nonce}", hex(h)).into_bytes()
}

pub fn leading_zero_bits(buf: &[u8]) -> u32 {
    let mut n = 0;
    for b in buf {
        if *b == 0 {
            n += 8;
            continue;
        }
        return n + b.leading_zeros();
    }
    n
}

pub fn pow_ok(h: &[u8; 32], nonce: &str, pow: &str, bits: u32) -> bool {
    let (Some(p), Some(n)) = (unb64(pow, Some(8)), unb64(nonce, Some(16))) else { return false };
    leading_zero_bits(&sha256(&[h, &n, &p])) >= bits
}

/// Finds a stamp (run it on a thread of its own).
pub fn solve_pow(h: &[u8; 32], nonce: &str, bits: u32) -> Result<String, String> {
    let n = unb64(nonce, Some(16)).ok_or("No proof of work found.")?;
    let start = OsRng.next_u32();
    let mut p = [0u8; 8];
    for i in 0u64..(1u64 << 34) {
        p[..4].copy_from_slice(&(start.wrapping_add(i as u32)).to_be_bytes());
        p[4..].copy_from_slice(&((i >> 32) as u32).to_be_bytes());
        if leading_zero_bits(&sha256(&[h, &n, &p])) >= bits {
            return Ok(b64(&p));
        }
    }
    Err("No proof of work found.".into())
}

/// Signs and stamps an envelope with an install key: the request body.
pub fn sign(env: &Value, key: &SigningKey, ts: i64, nonce: &str, pow: &str, bits: u32) -> Value {
    let h = envelope_hash(env);
    let sig = key.sign(&signed_bytes(&h, &ts.to_string(), nonce));
    let mut body = env.clone();
    body["ts"] = json!(ts);
    body["nonce"] = json!(nonce);
    body["ik"] = json!(b64(key.verifying_key().as_bytes()));
    body["sig"] = json!(b64(&sig.to_bytes()));
    body["pow"] = json!(pow);
    body["bits"] = json!(bits);
    body
}

const BODY_FIELDS: [(&str, &str); 12] = [("v", "v"), ("kid", "kid"), ("epk", "b64:32"), ("iv", "b64:12"), ("ct", "b64"), ("tag", "b64:16"), ("ts", "int"), ("nonce", "b64:16"), ("ik", "b64:32"), ("sig", "b64:64"), ("pow", "b64:8"), ("bits", "bits")];

fn safe_int(v: &Value) -> Option<i64> {
    let f = v.as_f64()?;
    (f.fract() == 0.0 && f.abs() <= 9_007_199_254_740_991.0).then_some(f as i64)
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn cut40(k: &str) -> String {
    let mut out = String::new();
    let mut n = 0;
    for c in k.chars() {
        n += c.len_utf16();
        if n > 40 {
            break;
        }
        out.push(c);
    }
    out
}

/// Errors in a request body (empty when it is right).
pub fn validate_body(b: &Value) -> Vec<String> {
    let Some(o) = b.as_object() else { return vec!["not an object".into()] };
    let mut errs = Vec::new();
    for k in o.keys() {
        if !BODY_FIELDS.iter().any(|(f, _)| f == k) {
            errs.push(format!("unknown field {}", cut40(k)));
        }
    }
    for (k, t) in BODY_FIELDS {
        let x = &b[k];
        match t {
            "v" => {
                if x.as_f64() != Some(1.0) {
                    errs.push("v must be 1".into());
                }
            }
            "kid" => {
                if !x.as_str().is_some_and(|s| s.len() == 16 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))) {
                    errs.push("kid".into());
                }
            }
            "int" => {
                if !safe_int(x).is_some_and(|n| n >= 0) {
                    errs.push(k.into());
                }
            }
            "bits" => {
                if !x.as_f64().is_some_and(|f| f.fract() == 0.0 && (0.0..=40.0).contains(&f)) {
                    errs.push(k.into());
                }
            }
            _ => {
                let len = t.split_once(':').map(|(_, l)| l.parse::<usize>().unwrap());
                if !x.as_str().is_some_and(|s| s.len() <= MAX_BODY && unb64(s, len).is_some()) {
                    errs.push(k.into());
                }
            }
        }
    }
    errs
}

/// Verifies the signature of a body that passed validate_body.
pub fn verify_sig(b: &Value) -> bool {
    let (Some(ik), Some(sig)) = (unb64v(&b["ik"], Some(32)), unb64v(&b["sig"], Some(64))) else { return false };
    let Ok(key) = VerifyingKey::from_bytes(&ik.try_into().unwrap()) else { return false };
    let sig = ed25519_dalek::Signature::from_bytes(&sig.try_into().unwrap());
    let ts = super::super::js::to_string(&b["ts"]);
    key.verify(&signed_bytes(&envelope_hash(b), &ts, b["nonce"].as_str().unwrap_or("")), &sig).is_ok()
}

// ---- the payload, exactly
pub const LIMIT_MESSAGE: usize = 5000;
pub const LIMIT_NOTE: usize = 1000;
pub const LIMIT_CONTACT: usize = 200;
pub const LIMIT_UI: usize = 80;
pub const LIMIT_CRASH_MESSAGE: usize = 4000;
pub const LIMIT_CRASH_STACK: usize = 30000;
pub const DIAG_KEYS: [&str; 14] = ["system", "storage", "counts", "jobs", "converter", "settings", "features", "health", "logs", "crashes", "can", "sentryUsb", "nodes", "errors"];
pub const HEARTBEAT_MAX_BYTES: usize = 8192;
pub const HOST_OS: [&str; 11] = super::super::build::HOST_OS;

fn bounded_json(v: &Value, errs: &mut Vec<String>, at: &str) {
    let mut keys = 0usize;
    fn walk(v: &Value, depth: usize, keys: &mut usize, errs: &mut Vec<String>, at: &str) -> bool {
        if errs.len() > 20 {
            return false;
        }
        if depth > 10 {
            errs.push(format!("{at}: nested too deep"));
            return true;
        }
        match v {
            Value::Null | Value::Bool(_) | Value::Number(_) => true,
            Value::String(s) => {
                if utf16_len(s) > 40_000 {
                    errs.push(format!("{at}: a string is too long"));
                }
                true
            }
            Value::Array(a) => {
                if a.len() > 5000 {
                    errs.push(format!("{at}: a list is too long"));
                    return true;
                }
                for x in a {
                    walk(x, depth + 1, keys, errs, at);
                }
                true
            }
            Value::Object(o) => {
                for (k, x) in o {
                    *keys += 1;
                    if *keys > 60_000 {
                        errs.push(format!("{at}: too many fields"));
                        return false;
                    }
                    if utf16_len(k) > 120 {
                        errs.push(format!("{at}: a field name is too long"));
                        return false;
                    }
                    walk(x, depth + 1, keys, errs, at);
                }
                true
            }
        }
    }
    walk(v, 0, &mut keys, errs, at);
}

fn is_str(x: &Value, max: usize, min: usize) -> bool {
    x.as_str().is_some_and(|s| (min..=max).contains(&utf16_len(s)))
}

fn int_in(x: &Value, max: f64) -> bool {
    safe_int(x).is_some_and(|n| n >= 0 && (n as f64) <= max)
}

/// Plain heartbeat text: printable ASCII without " and \, 1 to max, no outer spaces.
pub fn is_plain(x: &Value, max: usize) -> bool {
    x.as_str().is_some_and(|s| !s.is_empty() && s.len() <= max && s.bytes().all(|c| (0x20..=0x7e).contains(&c) && c != b'"' && c != b'\\') && s.trim() == s)
}

fn plain_or_null(x: &Value, max: usize) -> bool {
    x.is_null() || is_plain(x, max)
}

fn has(o: &Value, k: &str) -> bool {
    o.as_object().is_some_and(|m| m.contains_key(k))
}

fn exact_keys(o: &Value, keys: &[&str], at: &str, errs: &mut Vec<String>) -> bool {
    let Some(m) = o.as_object() else {
        errs.push(at.into());
        return false;
    };
    for k in m.keys() {
        if !keys.contains(&k.as_str()) {
            errs.push(format!("unknown field {at}.{}", cut40(k)));
        }
    }
    for k in keys {
        if !m.contains_key(*k) {
            errs.push(format!("{at}.{k} missing"));
        }
    }
    true
}

fn tenth(n: f64) -> bool {
    (n * 10.0 - (n * 10.0).round()).abs() < 1e-6
}

fn check_gpus(x: &Value, count: usize, max: usize, at: &str, errs: &mut Vec<String>) {
    let Some(a) = x.as_array().filter(|a| a.len() <= count) else {
        errs.push(at.into());
        return;
    };
    for (i, g) in a.iter().enumerate() {
        if !is_plain(g, max) {
            errs.push(format!("{at}[{i}]"));
        }
    }
}

fn check_convert(x: &Value, device_max: usize, at: &str, errs: &mut Vec<String>) {
    if !exact_keys(x, &["fps", "encoder", "device", "api", "codec"], at, errs) {
        return;
    }
    if has(x, "fps") && !(x["fps"].is_null() || x["fps"].as_f64().is_some_and(|n| n.is_finite() && (0.0..=100_000.0).contains(&n) && tenth(n))) {
        errs.push(format!("{at}.fps"));
    }
    for (k, max) in [("encoder", 40), ("device", device_max), ("api", 12), ("codec", 10)] {
        if has(x, k) && !plain_or_null(&x[k], max) {
            errs.push(format!("{at}.{k}"));
        }
    }
}

const HEARTBEAT_FIELDS: [&str; 12] = ["uptimeSec", "health", "vehicles", "footageBytes", "recordings", "spaceSavedBytes", "distanceKm", "freeBytes", "totalBytes", "converting", "jobsQueued", "features"];
const HEARTBEAT_OPTIONAL: [&str; 11] = ["footageSeconds", "platform", "arch", "cpu", "gpus", "cars", "clips24h", "convert", "crashes24h", "host", "nodes"];
const BYTES_MAX: f64 = 9_007_199_254_740_991.0;

fn heartbeat_field_ok(k: &str, x: &Value) -> bool {
    match k {
        "uptimeSec" => int_in(x, 100.0 * 365.0 * 86400.0),
        "vehicles" => int_in(x, 1000.0),
        "footageBytes" | "spaceSavedBytes" => int_in(x, BYTES_MAX),
        "recordings" => int_in(x, 1e9),
        "distanceKm" => x.as_f64().is_some_and(|n| n.is_finite() && (0.0..=10_000_000.0).contains(&n) && tenth(n)),
        "freeBytes" | "totalBytes" => x.is_null() || int_in(x, BYTES_MAX),
        "converting" => x.is_boolean(),
        "jobsQueued" => int_in(x, 100_000.0),
        _ => true,
    }
}

fn check_optional(k: &str, x: &Value, errs: &mut Vec<String>) {
    match k {
        "footageSeconds" => {
            if !int_in(x, 1e12) {
                errs.push("heartbeat.footageSeconds".into());
            }
        }
        "platform" => {
            if !is_plain(x, 32) {
                errs.push("heartbeat.platform".into());
            }
        }
        "arch" => {
            if !is_plain(x, 16) {
                errs.push("heartbeat.arch".into());
            }
        }
        "cpu" => {
            if !plain_or_null(x, 120) {
                errs.push("heartbeat.cpu".into());
            }
        }
        "gpus" => check_gpus(x, 4, 80, "heartbeat.gpus", errs),
        "cars" => {
            let Some(a) = x.as_array().filter(|a| a.len() <= 12) else {
                errs.push("heartbeat.cars".into());
                return;
            };
            for (i, c) in a.iter().enumerate() {
                let at = format!("heartbeat.cars[{i}]");
                if !exact_keys(c, &["model", "firmware"], &at, errs) {
                    continue;
                }
                if has(c, "model") && !plain_or_null(&c["model"], 16) {
                    errs.push(format!("{at}.model"));
                }
                if has(c, "firmware") && !plain_or_null(&c["firmware"], 24) {
                    errs.push(format!("{at}.firmware"));
                }
            }
        }
        "clips24h" => {
            if !exact_keys(x, &["sentry", "dashcam"], "heartbeat.clips24h", errs) {
                return;
            }
            for k in ["sentry", "dashcam"] {
                if has(x, k) && !int_in(&x[k], 1e6) {
                    errs.push(format!("heartbeat.clips24h.{k}"));
                }
            }
        }
        "convert" => check_convert(x, 120, "heartbeat.convert", errs),
        "crashes24h" => {
            if !int_in(x, 10_000.0) {
                errs.push("heartbeat.crashes24h".into());
            }
        }
        "host" => {
            if !exact_keys(x, &["os", "docker"], "heartbeat.host", errs) {
                return;
            }
            if has(x, "os") && !(x["os"].is_null() || x["os"].as_str().is_some_and(|s| HOST_OS.contains(&s))) {
                errs.push("heartbeat.host.os".into());
            }
            if has(x, "docker") && !x["docker"].is_boolean() {
                errs.push("heartbeat.host.docker".into());
            }
        }
        "nodes" => {
            let Some(a) = x.as_array().filter(|a| a.len() <= 8) else {
                errs.push("heartbeat.nodes".into());
                return;
            };
            for (i, n) in a.iter().enumerate() {
                let at = format!("heartbeat.nodes[{i}]");
                if !exact_keys(n, &["cpu", "gpus", "convert"], &at, errs) {
                    continue;
                }
                if has(n, "cpu") && !plain_or_null(&n["cpu"], 60) {
                    errs.push(format!("{at}.cpu"));
                }
                if has(n, "gpus") {
                    check_gpus(&n["gpus"], 4, 60, &format!("{at}.gpus"), errs);
                }
                if has(n, "convert") {
                    check_convert(&n["convert"], 60, &format!("{at}.convert"), errs);
                }
            }
        }
        _ => {}
    }
}

pub fn health_overall(warnings: u64, problems: u64) -> &'static str {
    if problems > 0 {
        "problem"
    } else if warnings > 0 {
        "warn"
    } else {
        "ok"
    }
}

fn check_heartbeat(h: &Value, errs: &mut Vec<String>) {
    let Some(m) = h.as_object() else {
        errs.push("heartbeat".into());
        return;
    };
    for k in m.keys() {
        if !HEARTBEAT_FIELDS.contains(&k.as_str()) && !HEARTBEAT_OPTIONAL.contains(&k.as_str()) {
            errs.push(format!("unknown field heartbeat.{}", cut40(k)));
        }
    }
    for k in HEARTBEAT_FIELDS {
        if !m.contains_key(k) {
            errs.push(format!("heartbeat.{k} missing"));
            continue;
        }
        if !heartbeat_field_ok(k, &h[k]) {
            errs.push(format!("heartbeat.{k}"));
        }
    }
    for k in HEARTBEAT_OPTIONAL {
        if m.contains_key(k) {
            check_optional(k, &h[k], errs);
        }
    }
    let (f, t) = (&h["freeBytes"], &h["totalBytes"]);
    // (=== null: a missing field is undefined, not null)
    let (fnull, tnull) = (m.get("freeBytes") == Some(&Value::Null), m.get("totalBytes") == Some(&Value::Null));
    if int_in(f, BYTES_MAX) && int_in(t, BYTES_MAX) && f.as_f64() > t.as_f64() {
        errs.push("heartbeat.freeBytes (more than totalBytes)".into());
    }
    if fnull != tnull {
        errs.push("heartbeat.freeBytes and totalBytes (both or neither)".into());
    }
    let hl = &h["health"];
    match hl.as_object() {
        None => errs.push("heartbeat.health".into()),
        Some(o) => {
            for k in o.keys() {
                if !["overall", "warnings", "problems"].contains(&k.as_str()) {
                    errs.push(format!("unknown field heartbeat.health.{}", cut40(k)));
                }
            }
            let ok_counts = int_in(&hl["warnings"], 1000.0) && int_in(&hl["problems"], 1000.0);
            if !int_in(&hl["warnings"], 1000.0) {
                errs.push("heartbeat.health.warnings".into());
            }
            if !int_in(&hl["problems"], 1000.0) {
                errs.push("heartbeat.health.problems".into());
            }
            if !hl["overall"].as_str().is_some_and(|s| ["ok", "warn", "problem"].contains(&s)) {
                errs.push("heartbeat.health.overall".into());
            } else if ok_counts && hl["overall"] != health_overall(hl["warnings"].as_u64().unwrap(), hl["problems"].as_u64().unwrap()) {
                errs.push("heartbeat.health.overall (does not match the counts)".into());
            }
        }
    }
    let f = &h["features"];
    match f.as_object() {
        None => errs.push("heartbeat.features".into()),
        Some(o) => {
            for k in o.keys() {
                if !["can", "sentryUsbPaired", "gpu"].contains(&k.as_str()) {
                    errs.push(format!("unknown field heartbeat.features.{}", cut40(k)));
                }
            }
            for k in ["can", "sentryUsbPaired", "gpu"] {
                if !f[k].is_boolean() {
                    errs.push(format!("heartbeat.features.{k}"));
                }
            }
        }
    }
}

fn hex_str(x: &Value, min: usize, max: usize) -> bool {
    x.as_str().is_some_and(|s| (min..=max).contains(&s.len()) && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
}

/// Errors in a payload (empty when it is right): exactly these fields, of these types and lengths.
pub fn validate_payload(p: &Value) -> Vec<String> {
    let Some(m) = p.as_object() else { return vec!["not an object".into()] };
    let mut errs = Vec::new();
    let allowed = ["kind", "sentAt", "install", "anonymous", "build", "ui", "message", "contact", "crash", "diagnostics", "heartbeat"];
    for k in m.keys() {
        if !allowed.contains(&k.as_str()) {
            errs.push(format!("unknown field {}", cut40(k)));
        }
    }
    let kind = p["kind"].as_str().unwrap_or("");
    if !KINDS.contains(&kind) {
        errs.push("kind".into());
    }
    if !is_str(&p["sentAt"], 40, 10) || super::super::js::parse_date(p["sentAt"].as_str().unwrap_or("")).is_none() {
        errs.push("sentAt".into());
    }
    let install_anon = p["install"] == ANON;
    if !(install_anon || hex_str(&p["install"], 32, 32)) {
        errs.push("install".into());
    }
    if !p["anonymous"].is_boolean() || p["anonymous"].as_bool() != Some(install_anon) {
        errs.push("anonymous".into());
    }
    let b = &p["build"];
    match b.as_object() {
        None => errs.push("build".into()),
        Some(o) => {
            for k in o.keys() {
                if !["build", "sha", "builtAt", "tag"].contains(&k.as_str()) {
                    errs.push(format!("unknown field build.{}", cut40(k)));
                }
            }
            // (nullOr: a missing field is undefined, not null)
            let null = |k: &str| o.get(k) == Some(&Value::Null);
            if !(null("build") || safe_int(&b["build"]).is_some_and(|n| n > 0)) {
                errs.push("build.build".into());
            }
            if !(null("sha") || hex_str(&b["sha"], 7, 64)) {
                errs.push("build.sha".into());
            }
            if !(null("builtAt") || is_str(&b["builtAt"], 40, 0)) {
                errs.push("build.builtAt".into());
            }
            if !(null("tag") || is_str(&b["tag"], 120, 0)) {
                errs.push("build.tag".into());
            }
            for k in ["build", "sha", "builtAt", "tag"] {
                if !o.contains_key(k) {
                    errs.push(format!("build.{k} missing"));
                }
            }
        }
    }
    if !is_str(&p["ui"], LIMIT_UI, 0) {
        errs.push("ui".into());
    }
    let has_message = m.contains_key("message");
    if kind == "feedback" {
        if !is_str(&p["message"], LIMIT_MESSAGE, 1) || p["message"].as_str().unwrap_or("").trim().is_empty() {
            errs.push("message".into());
        }
    } else if kind == "support" {
        if has_message && !is_str(&p["message"], LIMIT_NOTE, 0) {
            errs.push("message".into());
        }
    } else if has_message {
        errs.push("message (feedback and support only)".into());
    }
    if m.contains_key("contact") {
        if kind != "feedback" {
            errs.push("contact (feedback only)".into());
        } else if super::super::js::truthy(&p["anonymous"]) {
            errs.push("contact (never when anonymous)".into());
        } else if !is_str(&p["contact"], LIMIT_CONTACT, 0) {
            errs.push("contact".into());
        }
    }
    if kind == "crash" {
        let c = &p["crash"];
        match c.as_object() {
            None => errs.push("crash".into()),
            Some(o) => {
                for k in o.keys() {
                    if !["at", "name", "message", "stack", "source"].contains(&k.as_str()) {
                        errs.push(format!("unknown field crash.{}", cut40(k)));
                    }
                }
                if !is_str(&c["at"], 40, 10) {
                    errs.push("crash.at".into());
                }
                if !is_str(&c["name"], 120, 0) {
                    errs.push("crash.name".into());
                }
                if !is_str(&c["message"], LIMIT_CRASH_MESSAGE, 0) {
                    errs.push("crash.message".into());
                }
                if !is_str(&c["stack"], LIMIT_CRASH_STACK, 0) {
                    errs.push("crash.stack".into());
                }
                if o.contains_key("source") && !c["source"].as_str().is_some_and(|s| s == "crash" || s == "error") {
                    errs.push("crash.source".into());
                }
            }
        }
    } else if m.contains_key("crash") {
        errs.push("crash (crash reports only)".into());
    }
    if kind == "heartbeat" {
        check_heartbeat(&p["heartbeat"], &mut errs);
        if m.contains_key("diagnostics") {
            errs.push("diagnostics (never in a heartbeat)".into());
        }
        if p.to_string().len() > HEARTBEAT_MAX_BYTES {
            errs.push(format!("heartbeat: larger than {HEARTBEAT_MAX_BYTES} bytes"));
        }
        return errs;
    }
    if m.contains_key("heartbeat") {
        errs.push("heartbeat (heartbeats only)".into());
    }
    match m.get("diagnostics") {
        None => {
            if kind != "feedback" {
                errs.push("diagnostics missing".into());
            }
        }
        Some(d) => match d.as_object() {
            None => errs.push("diagnostics".into()),
            Some(o) => {
                for (k, v) in o {
                    if !DIAG_KEYS.contains(&k.as_str()) {
                        errs.push(format!("unknown field diagnostics.{}", cut40(k)));
                    } else {
                        bounded_json(v, &mut errs, &format!("diagnostics.{k}"));
                    }
                }
            }
        },
    }
    errs
}

// ---- the receiver's own signature: a "moved to" notice at GET /v1/config
fn moved_bytes(url: &str, at: i64) -> Vec<u8> {
    format!("{INFO} moved|{url}|{at}").into_bytes()
}

/// For tests: a notice signed by a receiver signing key.
pub fn sign_moved(url: &str, at: i64, key: &SigningKey) -> Value {
    json!({ "url": url, "at": at, "sig": b64(&key.sign(&moved_bytes(url, at)).to_bytes()) })
}

/// Whether a { url, at, sig } notice is signed by one of these keys.
pub fn verify_moved(m: &Value, keys: &[ReceiverKey]) -> bool {
    let (Some(url), Some(at), Some(sig)) = (m["url"].as_str(), safe_int(&m["at"]), m["sig"].as_str()) else { return false };
    if utf16_len(url) > 300 {
        return false;
    }
    let Some(sig) = unb64(sig, Some(64)) else { return false };
    let sig = ed25519_dalek::Signature::from_bytes(&sig.try_into().unwrap());
    keys.iter().any(|k| {
        let Some(raw) = k.signing_key.as_deref().and_then(|s| unb64(s, Some(32))) else { return false };
        let Ok(vk) = VerifyingKey::from_bytes(&raw.try_into().unwrap()) else { return false };
        vk.verify(&moved_bytes(url, at), &sig).is_ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receiver() -> ([u8; 32], String) {
        let mut sk = [0u8; 32];
        OsRng.fill_bytes(&mut sk);
        let s = x25519_dalek::StaticSecret::from(sk);
        (sk, b64(x25519_dalek::PublicKey::from(&s).as_bytes()))
    }

    fn payload() -> Value {
        json!({ "kind": "feedback", "sentAt": "2026-11-15T10:00:00.000Z", "install": "a".repeat(32), "anonymous": false, "build": { "build": 130, "sha": "1345348", "builtAt": null, "tag": null }, "ui": "original", "message": "hello" })
    }

    // test/reportsProtocol.test.js
    #[test]
    fn seal_and_open() {
        let (sk, pubk) = receiver();
        let env = seal(&payload(), &pubk).unwrap();
        assert_eq!(env.as_object().unwrap().keys().collect::<Vec<_>>(), ["v", "kid", "epk", "iv", "ct", "tag"]);
        assert_eq!(env["kid"].as_str().unwrap().len(), 16);
        assert_eq!(open(&env, &sk, MAX_PLAIN).unwrap(), payload());
        let kid = hex(&sha256(&[&unb64(&pubk, None).unwrap()]))[..16].to_string();
        assert_eq!(env["kid"], kid);
    }

    #[test]
    fn tampering_another_key_a_changed_kid() {
        let (sk, pubk) = receiver();
        let env = seal(&payload(), &pubk).unwrap();
        let flip = |s: &Value| {
            let mut b = unb64(s.as_str().unwrap(), None).unwrap();
            b[0] ^= 1;
            json!(b64(&b))
        };
        for k in ["tag", "ct", "iv"] {
            let mut bad = env.clone();
            bad[k] = flip(&env[k]);
            assert_eq!(open(&bad, &sk, MAX_PLAIN), Err("BAD_TAG"));
        }
        let mut bad = env.clone();
        bad["kid"] = json!("0".repeat(16));
        assert_eq!(open(&bad, &sk, MAX_PLAIN), Err("BAD_TAG"));
        assert_eq!(open(&env, &receiver().0, MAX_PLAIN), Err("BAD_TAG"));
    }

    #[test]
    fn signature_and_proof_of_work() {
        let (_, pubk) = receiver();
        let env = seal(&payload(), &pubk).unwrap();
        let key = SigningKey::generate(&mut OsRng);
        let mut n = [0u8; 16];
        OsRng.fill_bytes(&mut n);
        let nonce = b64(&n);
        let h = envelope_hash(&env);
        let pow = solve_pow(&h, &nonce, 8).unwrap();
        assert!(pow_ok(&h, &nonce, &pow, 8));
        let body = sign(&env, &key, 1_763_200_000_000, &nonce, &pow, 8);
        assert_eq!(validate_body(&body), Vec::<String>::new());
        assert!(verify_sig(&body));
        let mut b2 = body.clone();
        b2["ts"] = json!(1_763_200_000_001i64);
        assert!(!verify_sig(&b2));
        let mut b3 = body.clone();
        b3["ct"] = seal(&payload(), &pubk).unwrap()["ct"].clone();
        assert!(!verify_sig(&b3));
        let mut b4 = body.clone();
        b4["extra"] = json!(1);
        assert_eq!(validate_body(&b4), ["unknown field extra"]);
    }

    #[test]
    fn moved_notices_and_keys() {
        let k = SigningKey::generate(&mut OsRng);
        let (_, pubk) = receiver();
        let rk = normalize_key(None, &pubk, Some(&b64(k.verifying_key().as_bytes()))).unwrap();
        let m = sign_moved("https://new.example.com", 5, &k);
        assert!(verify_moved(&m, &[rk.clone()]));
        let mut bad = m.clone();
        bad["url"] = json!("https://evil.example.com");
        assert!(!verify_moved(&bad, &[rk.clone()]));
        let line = format!("sr1:{}:{}", rk.public_key, rk.signing_key.clone().unwrap());
        assert_eq!(parse_key_line(&line).unwrap(), vec![rk.clone()]);
        assert!(parse_key_line("sr1:nope").unwrap_err().contains("is not a receiver key"));
        assert!(normalize_key(Some("0000000000000000"), &pubk, None).unwrap_err().contains("does not match"));
    }

    #[test]
    fn the_payload_schema() {
        assert!(validate_payload(&payload()).is_empty());
        let mut p = payload();
        p["install"] = json!(ANON);
        assert_eq!(validate_payload(&p), ["anonymous"]);
        p["anonymous"] = json!(true);
        p["contact"] = json!("me");
        assert_eq!(validate_payload(&p), ["contact (never when anonymous)"]);
        let mut s = payload();
        s["kind"] = json!("support");
        assert_eq!(validate_payload(&s), ["diagnostics missing"]);
        s["diagnostics"] = json!({ "system": { "a": 1 }, "bogus": 1 });
        assert_eq!(validate_payload(&s), ["unknown field diagnostics.bogus"]);
        let mut d = payload();
        d["kind"] = json!("daily");
        d["diagnostics"] = json!({});
        assert_eq!(validate_payload(&d), ["message (feedback and support only)"]);
        let mut deep = json!(1);
        for _ in 0..12 {
            deep = json!([deep]);
        }
        let mut s = payload();
        s["kind"] = json!("support");
        s["diagnostics"] = json!({ "logs": deep });
        assert_eq!(validate_payload(&s), ["diagnostics.logs: nested too deep"]);
    }
}
