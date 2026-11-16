//! Helper servers ("nodes"): other Sentry Six Managers that encode clips for
//! this one (server/nodes.js, the main side), this server encoding for a
//! main (server/nodeWorker.js, the worker side), Nodes > Benchmark
//! (server/nodeBenchmark.js), the picture check of a node's encodes
//! (src/main/converter/pictureCheck.js) and the routes (`/api/nodes*`,
//! `/node/v1/*`). See README.md in this folder for how core mounts it and
//! how the converter uses the nodes as lanes.
//!
//! Everything here is blocking (threads, like the converter): core calls the
//! routes from `spawn_blocking`.

pub mod benchmark;
pub mod cancel;
pub mod client;
pub mod ctx;
pub mod lanes;
pub mod main_side;
pub mod picture;
pub mod pin;
pub mod routes;
pub mod serve;
pub mod worker;

#[cfg(test)]
mod tests;

use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// An error with the status and code Node's nodeError carries.
#[derive(Debug, Clone, PartialEq)]
pub struct NodeError {
    pub message: String,
    pub status: u16,
    pub code: &'static str,
}

impl NodeError {
    pub fn new(message: impl Into<String>, status: u16, code: &'static str) -> NodeError {
        NodeError { message: message.into(), status, code }
    }
    /// nodeError(message) with Node's defaults (400, NODE_ERROR)
    pub fn bad(message: impl Into<String>) -> NodeError {
        NodeError::new(message, 400, "NODE_ERROR")
    }
    pub fn cancelled() -> NodeError {
        NodeError::new("Cancelled.", 499, "CANCELLED")
    }
}

impl std::fmt::Display for NodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// String.prototype.trim's white space (Rust's trim lacks U+FEFF).
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// s.slice(0, n) in UTF-16 code units (a pair is never cut in half here).
pub fn js_slice(s: &str, n: usize) -> String {
    crate::ops::power::js_slice(s, n)
}

fn is_control(c: char) -> bool {
    let u = c as u32;
    u <= 0x1f || (0x7f..=0x9f).contains(&u)
}

/// String(value || ''): the text JS makes of a JSON value.
pub fn js_text(v: &Value) -> String {
    match v {
        Value::Null | Value::Bool(false) => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) if n.as_f64() == Some(0.0) => String::new(),
        x => crate::ops::js::to_string(x),
    }
}

/// peerText / cleanName: text a peer sent, safe for the log and the page.
pub fn peer_text(v: &Value, max: usize) -> String {
    let s: String = js_text(v).chars().map(|c| if is_control(c) { ' ' } else { c }).collect();
    js_slice(js_trim(&s), max)
}

pub fn peer_str(s: &str, max: usize) -> String {
    peer_text(&Value::String(s.to_string()), max)
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// crypto.createHmac('sha256', key).update(text).digest('hex')
pub fn hmac_hex(key: &str, text: &str) -> String {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key.as_bytes()).expect("any key length");
    m.update(text.as_bytes());
    hex(&m.finalize().into_bytes())
}

/// sameHex: equal lowercase hex of the same length, compared in constant time.
pub fn same_hex(a: &str, b: &str) -> bool {
    let ok = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
    if a.len() != b.len() || !ok(a) {
        return false;
    }
    // (Node's Buffer.from(b, 'hex') stops at the first non-hex pair; b must decode the same length)
    let (Some(x), Some(y)) = (unhex(a), unhex_lenient(b)) else { return false };
    if x.len() != y.len() {
        return false;
    }
    x.iter().zip(y.iter()).fold(0u8, |acc, (p, q)| acc | (p ^ q)) == 0
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        // Buffer.from('abc', 'hex') drops the odd last digit
        return unhex(&s[..s.len() - 1]);
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

fn unhex_lenient(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i + 1 < b.len() {
        match u8::from_str_radix(std::str::from_utf8(&b[i..i + 2]).ok()?, 16) {
            Ok(v) => out.push(v),
            Err(_) => break,
        }
        i += 2;
    }
    Some(out)
}

/// The text each side signs while pairing.
pub mod pair_text {
    pub fn main(fingerprint: &str, name: &str) -> String {
        format!("sentry-six-node|v1|pair|{fingerprint}|{name}")
    }
    pub fn worker(fingerprint: &str, token: &str) -> String {
        format!("sentry-six-node|v1|paired|{fingerprint}|{token}")
    }
}

/// SHA-256 of a certificate's DER bytes, lowercase hex.
pub fn cert_fingerprint(raw: &[u8]) -> Option<String> {
    (!raw.is_empty()).then(|| sha256_hex(raw))
}

const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

pub fn random_bytes(n: usize) -> Vec<u8> {
    use rand_core::RngCore;
    let mut b = vec![0u8; n];
    rand_core::OsRng.fill_bytes(&mut b);
    b
}

pub fn base64url(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

/// "ABCD-EFGH-JKLM": 60 bits, typed by hand.
pub fn new_pairing_code() -> String {
    let chars: String = random_bytes(12).iter().map(|b| CODE_ALPHABET[*b as usize % CODE_ALPHABET.len()] as char).collect();
    format!("{}-{}-{}", &chars[0..4], &chars[4..8], &chars[8..12])
}

/// normalizeCode: upper case, letters and digits only.
pub fn normalize_code(code: &Value) -> String {
    js_text(code).to_uppercase().chars().filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit()).collect()
}

/// Number.isSafeInteger of a JSON value.
pub fn safe_int(v: &Value) -> Option<i64> {
    let x = v.as_f64()?;
    (x.is_finite() && x.fract() == 0.0 && x.abs() <= 9_007_199_254_740_991.0).then_some(x as i64)
}

/// A JSON number as JS writes it (2.0 is 2).
pub fn jnum(x: f64) -> Value {
    crate::ops::js::num(x)
}

/// The lowercase local device id pattern (LOCAL_DEVICE_ID).
pub fn is_local_device(s: &str) -> bool {
    crate::converter::contracts::is_local_device_id(s)
}
