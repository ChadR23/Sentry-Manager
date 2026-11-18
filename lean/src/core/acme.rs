//! Let's Encrypt certificates (ACME v2, RFC 8555; server/acme.js), HTTP-01
//! only, with the same files in the TLS directory as Node
//! (acme-account.key, acme.key, acme.crt, acme-state.json, all 0600), the
//! same backoff (15 min to a day, kept across restarts) and renewal (30 days
//! before the end, or a third of a short lifetime).

use super::log::LogTo as Scope;
use base64::Engine;
use p256::ecdsa::signature::Signer;
use p256::pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey, LineEnding};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const LE_DIRECTORY: &str = "https://acme-v02.api.letsencrypt.org/directory";
pub const LE_STAGING_DIRECTORY: &str = "https://acme-staging-v02.api.letsencrypt.org/directory";
pub const CHALLENGE_PREFIX: &str = "/.well-known/acme-challenge/";
const MAX_RESPONSE: usize = 256 * 1024;
const MAX_DOMAINS: usize = 10;
const REQUEST_TIMEOUT_MS: u64 = 30_000;
const DAY: i64 = 24 * 3600 * 1000;
const RENEW_BEFORE_MS: i64 = 30 * DAY;
pub const BACKOFF_MS: [i64; 5] = [15 * 60_000, 3_600_000, 4 * 3_600_000, 12 * 3_600_000, DAY];

fn b64u(b: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

/// Untrusted text from an ACME server, made safe for a log line or the UI.
pub fn clean(s: &str, max: usize) -> String {
    let mut out = String::new();
    let mut ctl = false;
    for c in s.chars() {
        if (c as u32) < 0x20 || c as u32 == 0x7f {
            if !ctl {
                out.push(' ');
            }
            ctl = true;
        } else {
            out.push(c);
            ctl = false;
        }
    }
    out.trim().chars().take(max).collect()
}

/// RFC 8555 8.3 token (Let's Encrypt: 43 characters).
pub fn token_ok(t: &str) -> bool {
    (22..=128).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn key_auth_ok(k: &str) -> bool {
    match k.split_once('.') {
        Some((t, p)) => token_ok(t) && p.len() == 43 && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        None => false,
    }
}

fn dns_ok(d: &str) -> bool {
    // two labels at least, lower-case letters, digits and inner dashes
    if d.len() > 253 || !d.contains('.') {
        return false;
    }
    d.split('.').all(|l| {
        let b = l.as_bytes();
        !b.is_empty() && b.len() <= 63 && b[0].is_ascii_alphanumeric() && b[b.len() - 1].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
    })
}

/// The domains of TLS_ACME_DOMAIN: public DNS names only.
pub fn parse_domains(value: &str) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for raw in value.split(|c: char| c.is_whitespace() || c == ',') {
        let d = raw.trim().to_lowercase();
        let d = d.strip_suffix('.').unwrap_or(&d).to_string();
        if d.is_empty() {
            continue;
        }
        if !dns_ok(&d) || super::tls::is_ip(&d) {
            return Err(format!("TLS_ACME_DOMAIN: \"{}\" is not a public DNS name (no IP addresses or wildcards).", clean(raw, 80)));
        }
        if !out.contains(&d) {
            out.push(d);
        }
    }
    if out.len() > MAX_DOMAINS {
        return Err(format!("TLS_ACME_DOMAIN: at most {MAX_DOMAINS} names."));
    }
    Ok(out)
}

#[derive(Debug, Clone)]
pub struct AcmeConfig {
    pub domains: Vec<String>,
    pub email: Option<String>,
    pub staging: bool,
    pub directory: String,
    pub ca_file: Option<String>,
    pub port: u16,
    /// where this server's plain HTTP answers (for the self-check before Let's Encrypt is asked)
    pub host: String,
}

fn truthy(v: Option<&str>) -> bool {
    matches!(v.unwrap_or("").trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on")
}

/// ACME settings from the environment, or None when TLS_ACME_DOMAIN is not set.
pub fn config_from_env(env: &std::collections::HashMap<String, String>) -> Result<Option<AcmeConfig>, String> {
    let g = |k: &str| env.get(k).map(String::as_str).filter(|v| !v.is_empty());
    let domains = parse_domains(g("TLS_ACME_DOMAIN").unwrap_or(""))?;
    if domains.is_empty() {
        return Ok(None);
    }
    let email = g("TLS_ACME_EMAIL").unwrap_or("").trim().to_string();
    if !email.is_empty() {
        let bad = |c: char| c.is_whitespace() || "@<>\"',;:".contains(c);
        let ok = email.split_once('@').is_some_and(|(a, b)| !a.is_empty() && !a.chars().any(bad) && b.split_once('.').is_some_and(|(x, y)| !x.is_empty() && !y.is_empty() && !b.chars().any(bad)));
        if !ok {
            return Err("TLS_ACME_EMAIL is not an email address.".into());
        }
    }
    let staging = truthy(g("TLS_ACME_STAGING"));
    let directory = g("TLS_ACME_DIRECTORY").map(String::from);
    if let Some(d) = &directory {
        if !d.starts_with("https://") {
            return Err("TLS_ACME_DIRECTORY must be an https:// URL.".into());
        }
    }
    let host = g("HOST").unwrap_or("");
    Ok(Some(AcmeConfig {
        domains,
        email: (!email.is_empty()).then_some(email),
        staging,
        directory: directory.unwrap_or_else(|| if staging { LE_STAGING_DIRECTORY.into() } else { LE_DIRECTORY.into() }),
        ca_file: g("TLS_ACME_CA_FILE").map(String::from),
        port: g("PORT").and_then(|p| p.parse().ok()).unwrap_or(9000),
        host: if host.is_empty() || host == "0.0.0.0" || host == "::" { "127.0.0.1".into() } else { host.into() },
    }))
}

// ---- keys, JWK, thumbprint, JWS

pub fn new_key() -> p256::SecretKey {
    loop {
        if let Ok(k) = p256::SecretKey::from_slice(&super::auth::random_bytes(32)) {
            return k;
        }
    }
}

pub fn key_pem(k: &p256::SecretKey) -> String {
    k.to_pkcs8_pem(LineEnding::LF).map(|z| z.to_string()).unwrap_or_default()
}

pub fn read_key(pem: &str) -> Option<p256::SecretKey> {
    p256::SecretKey::from_pkcs8_pem(pem).ok().or_else(|| p256::SecretKey::from_sec1_pem(pem).ok())
}

/// The public JWK with only the members RFC 7638 hashes.
pub fn jwk(k: &p256::SecretKey) -> Value {
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    let p = k.public_key().to_encoded_point(false);
    json!({ "crv": "P-256", "kty": "EC", "x": b64u(p.x().unwrap()), "y": b64u(p.y().unwrap()) })
}

/// RFC 7638 thumbprint.
pub fn thumbprint(jwk: &Value) -> String {
    let s = |k: &str| serde_json::to_string(&super::accounts::js_string(jwk.get(k))).unwrap();
    let text = format!("{{\"crv\":{},\"kty\":{},\"x\":{},\"y\":{}}}", s("crv"), s("kty"), s("x"), s("y"));
    b64u(&Sha256::digest(text.as_bytes()))
}

pub fn key_authorization(token: &str, k: &p256::SecretKey) -> String {
    format!("{token}.{}", thumbprint(&jwk(k)))
}

/// A flattened JWS, ES256; payload None is POST-as-GET.
pub fn sign_jws(k: &p256::SecretKey, url: &str, nonce: &str, kid: Option<&str>, payload: Option<&Value>) -> Value {
    let mut h = Map::new();
    h.insert("alg".into(), json!("ES256"));
    h.insert("nonce".into(), json!(nonce));
    h.insert("url".into(), json!(url));
    match kid {
        Some(kid) => h.insert("kid".into(), json!(kid)),
        None => h.insert("jwk".into(), jwk(k)),
    };
    let p = b64u(Value::Object(h).to_string().as_bytes());
    let body = payload.map(|v| b64u(v.to_string().as_bytes())).unwrap_or_default();
    let sk = p256::ecdsa::SigningKey::from(k);
    let sig: p256::ecdsa::Signature = sk.sign(format!("{p}.{body}").as_bytes());
    json!({ "protected": p, "payload": body, "signature": b64u(&sig.to_bytes()) })
}

// ---- a CSR in DER (PKCS #10)

fn der_len(n: usize) -> Vec<u8> {
    if n < 0x80 {
        return vec![n as u8];
    }
    let mut b = Vec::new();
    let mut x = n;
    while x > 0 {
        b.insert(0, (x & 0xff) as u8);
        x >>= 8;
    }
    let mut out = vec![0x80 | b.len() as u8];
    out.extend(b);
    out
}

fn tlv(tag: u8, parts: &[&[u8]]) -> Vec<u8> {
    let body: Vec<u8> = parts.concat();
    let mut out = vec![tag];
    out.extend(der_len(body.len()));
    out.extend(body);
    out
}

fn oid(s: &str) -> Vec<u8> {
    let p: Vec<u64> = s.split('.').map(|x| x.parse().unwrap()).collect();
    let mut out = vec![(40 * p[0] + p[1]) as u8];
    for v in &p[2..] {
        let mut b = vec![(v & 0x7f) as u8];
        let mut x = v >> 7;
        while x > 0 {
            b.insert(0, 0x80 | (x & 0x7f) as u8);
            x >>= 7;
        }
        out.extend(b);
    }
    tlv(0x06, &[&out])
}

/// CSR for these DNS names (subjectAltName; the first as CN when it fits), signed with the certificate key.
pub fn create_csr(k: &p256::SecretKey, domains: &[String]) -> Vec<u8> {
    let cn = if domains[0].len() <= 64 {
        tlv(0x30, &[&tlv(0x31, &[&tlv(0x30, &[&oid("2.5.4.3"), &tlv(0x0c, &[domains[0].as_bytes()])])])])
    } else {
        tlv(0x30, &[])
    };
    let names: Vec<Vec<u8>> = domains.iter().map(|d| tlv(0x82, &[d.as_bytes()])).collect();
    let san = tlv(0x30, &names.iter().map(Vec::as_slice).collect::<Vec<_>>());
    let extensions = tlv(0x30, &[&tlv(0x30, &[&oid("2.5.29.17"), &tlv(0x04, &[&san])])]);
    let attributes = tlv(0xa0, &[&tlv(0x30, &[&oid("1.2.840.113549.1.9.14"), &tlv(0x31, &[&extensions])])]);
    let spki = k.public_key().to_public_key_der().map(|d| d.as_bytes().to_vec()).unwrap_or_default();
    let info = tlv(0x30, &[&tlv(0x02, &[&[0]]), &cn, &spki, &attributes]);
    let sk = p256::ecdsa::SigningKey::from(k);
    let sig: p256::ecdsa::Signature = sk.sign(&info);
    let der = sig.to_der();
    tlv(0x30, &[&info, &tlv(0x30, &[&oid("1.2.840.10045.4.3.2")]), &tlv(0x03, &[&[0], der.as_bytes()])])
}

// ---- HTTPS requests to the ACME server

#[derive(Debug, Clone, Default)]
pub struct AcmeError {
    pub message: String,
    pub kind: Option<String>,
    pub detail: Option<String>,
    pub retry_after: Option<i64>,
    /// not an ACME answer (a connection or TLS failure)
    pub network: bool,
}

fn aerr(m: impl Into<String>) -> AcmeError {
    AcmeError { message: m.into(), ..Default::default() }
}

/// Retry-After as a time (seconds or an HTTP date).
pub fn retry_after_at(value: Option<&str>, now: i64) -> Option<i64> {
    let v = value?.trim();
    if v.is_empty() {
        return None;
    }
    let s = super::http::js_number(v);
    if s.is_finite() && s >= 0.0 {
        return Some(now + (s * 1000.0) as i64);
    }
    chrono::DateTime::parse_from_rfc2822(v).ok().map(|d| d.timestamp_millis())
}

pub struct HttpAnswer {
    pub status: u16,
    pub headers: axum::http::HeaderMap,
    pub body: Vec<u8>,
}

impl HttpAnswer {
    fn header(&self, k: &str) -> Option<&str> {
        self.headers.get(k).and_then(|v| v.to_str().ok())
    }
    fn json(&self) -> Option<Value> {
        serde_json::from_slice(&self.body).ok()
    }
}

fn split_url(url: &str) -> Result<(String, u16, String, String), AcmeError> {
    let u: axum::http::Uri = url.parse().map_err(|_| aerr(format!("The ACME server sent an invalid URL: {}", clean(url, 200))))?;
    if u.scheme_str() != Some("https") {
        return Err(aerr(format!("The ACME server sent a non-HTTPS URL: {}", clean(url, 200))));
    }
    let host = u.host().ok_or_else(|| aerr(format!("The ACME server sent an invalid URL: {}", clean(url, 200))))?.to_string();
    let port = u.port_u16().unwrap_or(443);
    let path = u.path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".into());
    let origin = format!("https://{}{}", host.to_lowercase(), if port == 443 { String::new() } else { format!(":{port}") });
    Ok((host, port, path, origin))
}

/// One request (only https://, only to the directory's own origin), the answer cut at 256 KB.
pub async fn request(url: &str, method: &str, body: Option<&Value>, roots: Arc<rustls::ClientConfig>, origin: Option<&str>, accept: &str) -> Result<HttpAnswer, AcmeError> {
    let (host, port, path, o) = split_url(url)?;
    if let Some(want) = origin {
        if o != want {
            return Err(aerr(format!("The ACME server sent a URL on another host: {}", clean(url, 200))));
        }
    }
    let work = async {
        let net = |e: String| AcmeError { message: e, network: true, ..Default::default() };
        let tcp = tokio::net::TcpStream::connect((host.as_str(), port)).await.map_err(|e| net(e.to_string()))?;
        let name = rustls::pki_types::ServerName::try_from(host.clone()).map_err(|e| net(e.to_string()))?;
        let tls = tokio_rustls::TlsConnector::from(roots).connect(name, tcp).await.map_err(|e| net(e.to_string()))?;
        let (mut send, conn) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(tls)).await.map_err(|e| net(e.to_string()))?;
        tokio::spawn(conn);
        let data = body.map(|b| b.to_string().into_bytes());
        let mut rb = axum::http::Request::builder()
            .method(method)
            .uri(&path)
            .header("host", if port == 443 { host.clone() } else { format!("{host}:{port}") })
            .header("user-agent", "sentry-six-manager-acme")
            .header("accept", accept);
        if let Some(d) = &data {
            rb = rb.header("content-type", "application/jose+json").header("content-length", d.len());
        }
        let req = rb.body(http_body_util::Full::new(bytes::Bytes::from(data.unwrap_or_default()))).map_err(|e| net(e.to_string()))?;
        let res = send.send_request(req).await.map_err(|e| net(e.to_string()))?;
        let status = res.status().as_u16();
        let headers = res.headers().clone();
        let mut b = res.into_body();
        let mut out = Vec::new();
        use http_body_util::BodyExt;
        while let Some(frame) = b.frame().await {
            let frame = frame.map_err(|e| net(e.to_string()))?;
            if let Some(d) = frame.data_ref() {
                out.extend_from_slice(d);
                if out.len() > MAX_RESPONSE {
                    return Err(aerr("The ACME server sent too large a response."));
                }
            }
        }
        Ok(HttpAnswer { status, headers, body: out })
    };
    match tokio::time::timeout(std::time::Duration::from_millis(REQUEST_TIMEOUT_MS), work).await {
        Ok(r) => r,
        Err(_) => Err(aerr(format!("No answer from {host} within {} s.", REQUEST_TIMEOUT_MS / 1000))),
    }
}

fn nonce_ok(n: &str) -> bool {
    (1..=256).contains(&n.len()) && n.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub struct AcmeClient {
    pub directory_url: String,
    origin: String,
    key: p256::SecretKey,
    roots: Arc<rustls::ClientConfig>,
    email: Option<String>,
    pub kid: Option<String>,
    pub poll_ms: u64,
    max_poll_ms: u64,
    port: u16,
    log: Option<Scope>,
    dir: Option<Value>,
    nonce: Option<String>,
}

impl AcmeClient {
    pub fn new(directory: &str, key: p256::SecretKey, roots: Arc<rustls::ClientConfig>, email: Option<String>, kid: Option<String>, port: u16, log: Option<Scope>) -> Result<AcmeClient, AcmeError> {
        let (_, _, _, origin) = split_url(directory)?;
        Ok(AcmeClient { directory_url: directory.into(), origin, key, roots, email, kid, poll_ms: 2000, max_poll_ms: 180_000, port, log, dir: None, nonce: None })
    }

    async fn directory(&mut self) -> Result<Value, AcmeError> {
        if let Some(d) = &self.dir {
            return Ok(d.clone());
        }
        let res = request(&self.directory_url, "GET", None, self.roots.clone(), Some(&self.origin), "application/json").await?;
        let d = res.json();
        let ok = d.as_ref().is_some_and(|d| ["newNonce", "newAccount", "newOrder"].iter().all(|k| d[k].is_string()));
        if res.status != 200 || !ok {
            return Err(aerr(format!("{} is not an ACME directory (HTTP {}).", self.directory_url, res.status)));
        }
        self.dir = d.clone();
        Ok(d.unwrap())
    }

    async fn fresh_nonce(&mut self) -> Result<String, AcmeError> {
        if let Some(n) = self.nonce.take() {
            return Ok(n);
        }
        let url = self.directory().await?["newNonce"].as_str().unwrap_or("").to_string();
        let res = request(&url, "HEAD", None, self.roots.clone(), Some(&self.origin), "application/json").await?;
        match res.header("replay-nonce") {
            Some(n) if nonce_ok(n) => Ok(n.to_string()),
            _ => Err(aerr("The ACME server sent no usable nonce.")),
        }
    }

    /// A signed POST; retries a bad nonce twice.
    async fn post(&mut self, url: &str, payload: Option<&Value>, use_jwk: bool, accept: &str) -> Result<HttpAnswer, AcmeError> {
        let mut attempt = 0;
        loop {
            let nonce = self.fresh_nonce().await?;
            let jws = sign_jws(&self.key, url, &nonce, if use_jwk { None } else { self.kid.as_deref() }, payload);
            let res = request(url, "POST", Some(&jws), self.roots.clone(), Some(&self.origin), accept).await?;
            if let Some(n) = res.header("replay-nonce").filter(|n| nonce_ok(n)) {
                self.nonce = Some(n.to_string());
            }
            if res.status < 400 {
                return Ok(res);
            }
            let problem = res.json().unwrap_or(json!({}));
            let kind = problem["type"].as_str().map(String::from);
            if kind.as_deref() == Some("urn:ietf:params:acme:error:badNonce") && attempt < 2 {
                attempt += 1;
                continue;
            }
            let detail = clean(problem["detail"].as_str().unwrap_or(""), 300);
            return Err(AcmeError {
                message: if detail.is_empty() { format!("HTTP {} from the ACME server", res.status) } else { detail.clone() },
                kind,
                detail: Some(detail),
                retry_after: retry_after_at(res.header("retry-after"), super::db::now_ms()),
                network: false,
            });
        }
    }

    async fn post_json(&mut self, url: &str, payload: Option<&Value>, use_jwk: bool) -> Result<(HttpAnswer, Value), AcmeError> {
        let res = self.post(url, payload, use_jwk, "application/json").await?;
        match res.json() {
            Some(v) if v.is_object() => Ok((res, v)),
            _ => Err(aerr(format!("The ACME server's answer from {} is not JSON.", clean(url, 200)))),
        }
    }

    pub async fn account(&mut self) -> Result<String, AcmeError> {
        if let Some(k) = &self.kid {
            return Ok(k.clone());
        }
        let d = self.directory().await?;
        let mut p = json!({ "termsOfServiceAgreed": true });
        if let Some(e) = &self.email {
            p["contact"] = json!([format!("mailto:{e}")]);
        }
        let (res, _) = self.post_json(d["newAccount"].as_str().unwrap_or(""), Some(&p), true).await?;
        let kid = res.header("location").ok_or_else(|| aerr("The ACME server sent no account URL."))?.to_string();
        if kid.parse::<axum::http::Uri>().map(|u| u.scheme().is_none()).unwrap_or(true) {
            return Err(aerr("The ACME server sent an invalid account URL."));
        }
        self.kid = Some(kid.clone());
        Ok(kid)
    }

    async fn poll(&mut self, url: &str, done: impl Fn(&Value) -> bool) -> Result<Value, AcmeError> {
        let deadline = super::db::now_ms() + self.max_poll_ms as i64;
        loop {
            let (res, body) = self.post_json(url, None, false).await?;
            if done(&body) {
                return Ok(body);
            }
            let st = body["status"].as_str().unwrap_or("");
            if !["pending", "processing", "ready"].contains(&st) {
                return Ok(body);
            }
            if super::db::now_ms() > deadline {
                return Err(aerr(format!("Still {} after {} s.", clean(st, 20), self.max_poll_ms / 1000)));
            }
            let after = retry_after_at(res.header("retry-after"), super::db::now_ms());
            let wait = (self.poll_ms as i64).max(after.map_or(0, |a| a - super::db::now_ms())).min(30_000);
            tokio::time::sleep(std::time::Duration::from_millis(wait.max(0) as u64)).await;
        }
    }

    /// The whole order: account, order, HTTP-01 for every name, finalize, chain.
    pub async fn issue(&mut self, domains: &[String], cert_key: &p256::SecretKey, mgr: &AcmeManager) -> Result<String, AcmeError> {
        self.account().await?;
        let d = self.directory().await?;
        let ids: Vec<Value> = domains.iter().map(|v| json!({ "type": "dns", "value": v })).collect();
        let (order_res, created) = self.post_json(d["newOrder"].as_str().unwrap_or(""), Some(&json!({ "identifiers": ids })), false).await?;
        let order_url = order_res.header("location").ok_or_else(|| aerr("The ACME server sent no order URL."))?.to_string();
        let mut order = created;
        let authzs: Vec<String> = order["authorizations"].as_array().map(|a| a.iter().take(MAX_DOMAINS * 2).map(|x| super::accounts::js_string(Some(x))).collect()).unwrap_or_default();
        if authzs.is_empty() || !order["finalize"].is_string() {
            return Err(aerr("The ACME server sent an order without authorizations."));
        }
        let mut published: Vec<String> = Vec::new();
        let result: Result<(), AcmeError> = async {
            for authz_url in &authzs {
                let (_, authz) = self.post_json(authz_url, None, false).await?;
                if authz["status"] == "valid" {
                    continue;
                }
                let domain = clean(authz["identifier"]["value"].as_str().unwrap_or(""), 253).to_lowercase();
                if !domains.contains(&domain) {
                    return Err(aerr(format!("The ACME server asked about a name that was not ordered: {domain}")));
                }
                let ch = authz["challenges"].as_array().and_then(|a| a.iter().find(|c| c["type"] == "http-01")).cloned();
                let Some(ch) = ch.filter(|c| c["url"].is_string()) else {
                    return Err(aerr(format!("The ACME server offered no HTTP-01 check for {domain}.")));
                };
                let token = ch["token"].as_str().filter(|t| token_ok(t)).ok_or_else(|| aerr("The ACME server sent an unusable challenge token."))?.to_string();
                let key_auth = key_authorization(&token, &self.key);
                mgr.publish(&token, &key_auth);
                published.push(token.clone());
                mgr.ready(&domain, &token, &key_auth).await?;
                if let Some(l) = &self.log {
                    l.info(format!("Let's Encrypt: asking it to check http://{domain}{CHALLENGE_PREFIX}{token}"));
                }
                self.post_json(ch["url"].as_str().unwrap(), Some(&json!({})), false).await?;
                let r = self.poll(authz_url, |a| a["status"] == "valid" || a["status"] == "invalid").await?;
                if r["status"] != "valid" {
                    return Err(challenge_failure(&domain, &token, &r, self.port));
                }
            }
            order = self.poll(&order_url, |o| o["status"] != "pending").await?;
            let st = order["status"].as_str().unwrap_or("");
            if st != "ready" && st != "valid" {
                let why = clean(order["error"]["detail"].as_str().unwrap_or(""), 300);
                return Err(aerr(format!("The order is {}: {}", clean(st, 20), if why.is_empty() { "no reason given".into() } else { why })));
            }
            Ok(())
        }
        .await;
        for t in &published {
            mgr.unpublish(t);
        }
        result?;
        if order["status"] == "ready" {
            let csr = b64u(&create_csr(cert_key, domains));
            self.post_json(order["finalize"].as_str().unwrap_or(""), Some(&json!({ "csr": csr })), false).await?;
            order = self.poll(&order_url, |o| o["status"] == "valid" || o["status"] == "invalid").await?;
        }
        if order["status"] != "valid" || !order["certificate"].is_string() {
            let why = clean(order["error"]["detail"].as_str().unwrap_or(""), 300);
            return Err(aerr(format!("The order ended {}: {}", clean(order["status"].as_str().unwrap_or(""), 20), if why.is_empty() { "no certificate".into() } else { why })));
        }
        let cert = self.post(order["certificate"].as_str().unwrap(), None, false, "application/pem-certificate-chain").await?;
        Ok(String::from_utf8_lossy(&cert.body).into_owned())
    }
}

/// A failed check, explained for the owner.
pub fn challenge_failure(domain: &str, token: &str, authz: &Value, port: u16) -> AcmeError {
    let ch = authz["challenges"].as_array().and_then(|a| a.iter().find(|c| c["type"] == "http-01")).cloned().unwrap_or(json!({}));
    let err = if ch["error"].is_object() { ch["error"].clone() } else if authz["error"].is_object() { authz["error"].clone() } else { json!({}) };
    let kind = err["type"].as_str().unwrap_or("").replace("urn:ietf:params:acme:error:", "");
    let d = clean(err["detail"].as_str().unwrap_or(""), 300);
    let said = if !d.is_empty() { d } else if !kind.is_empty() { clean(&kind, 300) } else { "no reason given".into() };
    let url = format!("http://{domain}{CHALLENGE_PREFIX}{token}");
    let msg = match kind.as_str() {
        "dns" => format!("Let's Encrypt couldn't look up {domain}: add a DNS A/AAAA record that points to this server's public IP"),
        "caa" => format!("A CAA record on {domain} does not allow Let's Encrypt"),
        _ => format!("Let's Encrypt couldn't reach {url}: check DNS points here and port 80 is forwarded to {port}"),
    };
    AcmeError { message: format!("{msg} (Let's Encrypt said: {said})"), kind: err["type"].as_str().map(String::from), detail: Some(said), ..Default::default() }
}

// ---- files

/// Write a file atomically, 0600, never through an existing link.
pub fn write_secret(dir: &Path, name: &str, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let file = dir.join(name);
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).custom_flags(libc::O_NOFOLLOW).mode(0o600).open(&tmp)?;
    f.write_all(data)?;
    drop(f);
    std::fs::rename(&tmp, &file)
}

pub fn read_small(file: &Path, max: u64) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut f = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(file)?;
    let md = f.metadata()?;
    if !md.is_file() || md.len() > max {
        return Err(std::io::Error::other(format!("{} is not a small regular file", file.display())));
    }
    let mut out = Vec::new();
    f.read_to_end(&mut out)?;
    Ok(out)
}

#[derive(Debug, Clone)]
pub struct ChainInfo {
    pub valid_from: i64,
    pub valid_to: i64,
    pub fingerprint: String,
}

fn pem_chain_ok(pem: &str) -> bool {
    let mut rest = pem.trim_start();
    if rest.is_empty() {
        return false;
    }
    while !rest.is_empty() {
        let Some(r) = rest.strip_prefix("-----BEGIN CERTIFICATE-----") else { return false };
        let r = r.strip_prefix("\r\n").or_else(|| r.strip_prefix('\n'));
        let Some(r) = r else { return false };
        let Some(end) = r.find("-----END CERTIFICATE-----") else { return false };
        let body = &r[..end];
        if body.is_empty() || !body.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b'\r' | b'\n')) {
            return false;
        }
        rest = r[end + "-----END CERTIFICATE-----".len()..].trim_start();
    }
    true
}

/// Is this chain the certificate for this key and these names, still valid?
pub fn check_chain(chain_pem: &str, key_pem: &str, domains: &[String], now: i64) -> Option<ChainInfo> {
    if !pem_chain_ok(chain_pem) {
        return None;
    }
    let der = super::tls::pem_der(chain_pem)?;
    let (_, leaf) = x509_parser::parse_x509_certificate(&der).ok()?;
    let key = read_key(key_pem)?;
    let spki = key.public_key().to_public_key_der().ok()?;
    if leaf.public_key().raw != spki.as_bytes() {
        return None;
    }
    let mut dns: Vec<String> = Vec::new();
    if let Ok(Some(san)) = leaf.subject_alternative_name() {
        for g in &san.value.general_names {
            if let x509_parser::extensions::GeneralName::DNSName(d) = g {
                dns.push(d.to_lowercase());
            }
        }
    }
    if dns.is_empty() {
        dns.extend(leaf.subject().iter_common_name().filter_map(|c| c.as_str().ok()).map(|s| s.to_lowercase()));
    }
    if !domains.iter().all(|d| dns.contains(&d.to_lowercase())) {
        return None;
    }
    let valid_from = leaf.validity().not_before.timestamp() * 1000;
    let valid_to = leaf.validity().not_after.timestamp() * 1000;
    if valid_to <= now {
        return None;
    }
    Some(ChainInfo { valid_from, valid_to, fingerprint: super::tls::fingerprint_der(&der) })
}

pub fn renew_at(i: &ChainInfo) -> i64 {
    let lifetime = (i.valid_to - i.valid_from).max(0);
    i.valid_to - RENEW_BEFORE_MS.min(lifetime / 3)
}

pub fn backoff_ms(failures: i64) -> i64 {
    BACKOFF_MS[(failures.max(1) as usize).min(BACKOFF_MS.len()) - 1]
}

/// The roots' usual check, plus: a server certificate that is itself listed in the CA file is trusted
/// for the names it carries (as OpenSSL does with a self-signed certificate given as `ca`).
#[derive(Debug)]
struct Pinned {
    pinned: Vec<Vec<u8>>,
    inner: Arc<rustls::client::WebPkiServerVerifier>,
}

fn cert_has_name(der: &[u8], name: &rustls::pki_types::ServerName) -> bool {
    let Ok((_, c)) = x509_parser::parse_x509_certificate(der) else { return false };
    let Ok(Some(san)) = c.subject_alternative_name() else { return false };
    let want = match name {
        rustls::pki_types::ServerName::DnsName(d) => d.as_ref().to_lowercase(),
        rustls::pki_types::ServerName::IpAddress(ip) => std::net::IpAddr::from(*ip).to_string(),
        _ => return false,
    };
    san.value.general_names.iter().any(|g| match g {
        x509_parser::extensions::GeneralName::DNSName(d) => d.to_lowercase() == want,
        x509_parser::extensions::GeneralName::IPAddress(b) => match b.len() {
            4 => std::net::IpAddr::from([b[0], b[1], b[2], b[3]]).to_string() == want,
            16 => <[u8; 16]>::try_from(*b).map(|a| std::net::IpAddr::from(a).to_string() == want).unwrap_or(false),
            _ => false,
        },
        _ => false,
    })
}

impl rustls::client::danger::ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        intermediates: &[rustls::pki_types::CertificateDer<'_>],
        server_name: &rustls::pki_types::ServerName<'_>,
        ocsp: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        if self.pinned.iter().any(|p| p.as_slice() == end_entity.as_ref()) && cert_has_name(end_entity.as_ref(), server_name) {
            return Ok(rustls::client::danger::ServerCertVerified::assertion());
        }
        self.inner.verify_server_cert(end_entity, intermediates, server_name, ocsp, now)
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &rustls::pki_types::CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(m, c, d)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &rustls::pki_types::CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(m, c, d)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

pub struct Issued {
    pub key: Vec<u8>,
    pub cert: Vec<u8>,
    pub fingerprint: String,
    pub info: ChainInfo,
}

type Hook = Arc<dyn Fn(bool) + Send + Sync>;

pub struct AcmeManager {
    pub config: AcmeConfig,
    dir: PathBuf,
    log: Option<Scope>,
    pending: Mutex<std::collections::HashMap<String, String>>,
    running: Mutex<bool>,
    generation: Mutex<u64>,
    on_change: Mutex<Option<Hook>>,
    /// publish / unpublish: whoever serves port 9000's plain HTTP hears of each token (the supervisor's app)
    share: Mutex<Option<(Arc<dyn Fn(String, String) + Send + Sync>, Arc<dyn Fn(String) + Send + Sync>)>>,
    pub ready_timeout_ms: i64,
    /// how often an order is polled (Node: 2 s)
    pub poll_ms: u64,
}

fn iso(ms: i64) -> String {
    super::log::iso(ms)
}

impl AcmeManager {
    pub fn new(config: AcmeConfig, dir: PathBuf, log: Option<Scope>) -> AcmeManager {
        AcmeManager { config, dir, log, pending: Mutex::new(Default::default()), running: Mutex::new(false), generation: Mutex::new(0), on_change: Mutex::new(None), share: Mutex::new(None), ready_timeout_ms: 120_000, poll_ms: 2000 }
    }

    fn file(&self, n: &str) -> PathBuf {
        self.dir.join(n)
    }

    pub fn state(&self) -> Map<String, Value> {
        read_small(&self.file("acme-state.json"), 64 * 1024).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
    }

    fn save_state(&self, patch: Value) {
        let mut s = self.state();
        if let Value::Object(p) = patch {
            for (k, v) in p {
                s.insert(k, v);
            }
        }
        let _ = write_secret(&self.dir, "acme-state.json", serde_json::to_string_pretty(&Value::Object(s)).unwrap_or_default().as_bytes());
    }

    /// The certificate on disk, if it fits these names and this server and has not expired.
    pub fn current(&self) -> Option<Issued> {
        let s = self.state();
        if s.get("certDirectory").and_then(Value::as_str) != Some(self.config.directory.as_str()) {
            return None;
        }
        let key = read_small(&self.file("acme.key"), 256 * 1024).ok()?;
        let cert = read_small(&self.file("acme.crt"), 256 * 1024).ok()?;
        let info = check_chain(&String::from_utf8_lossy(&cert), &String::from_utf8_lossy(&key), &self.config.domains, super::db::now_ms())?;
        Some(Issued { key, cert, fingerprint: info.fingerprint.clone(), info })
    }

    pub fn challenge(&self, token: &str) -> Option<String> {
        if !token_ok(token) {
            return None;
        }
        self.pending.lock().unwrap().get(token).cloned()
    }

    fn publish(&self, t: &str, ka: &str) {
        let mut p = self.pending.lock().unwrap();
        if p.len() >= 50 || !token_ok(t) || !key_auth_ok(ka) {
            return;
        }
        p.insert(t.into(), ka.into());
        drop(p);
        if let Some((publish, _)) = self.share.lock().unwrap().clone() {
            publish(t.into(), ka.into());
        }
    }

    fn unpublish(&self, t: &str) {
        self.pending.lock().unwrap().remove(t);
        if let Some((_, unpublish)) = self.share.lock().unwrap().clone() {
            unpublish(t.into());
        }
    }

    /// The tokens still waiting for their check (`acme.pending`).
    pub fn pending_list(&self) -> Vec<(String, String)> {
        self.pending.lock().unwrap().iter().map(|(a, b)| (a.clone(), b.clone())).collect()
    }

    /// Tell someone else of every token published and withdrawn (supervisor.js start hooks).
    pub fn share_tokens(&self, publish: Arc<dyn Fn(String, String) + Send + Sync>, unpublish: Arc<dyn Fn(String) + Send + Sync>) {
        *self.share.lock().unwrap() = Some((publish, unpublish));
    }

    pub fn status(&self) -> Value {
        let s = self.state();
        let cur = self.current();
        let ms = |k: &str| s.get(k).and_then(Value::as_f64).filter(|x| *x != 0.0).map(|x| iso(x as i64));
        json!({
            "domains": self.config.domains, "staging": self.config.staging, "directory": self.config.directory, "email": self.config.email.is_some(),
            "issued": cur.is_some(), "validTo": cur.as_ref().map(|c| iso(c.info.valid_to)),
            "renewsAt": cur.as_ref().map(|c| iso(renew_at(&c.info))),
            "lastError": s.get("lastError").filter(|v| super::accounts::truthy(v)).cloned().unwrap_or(Value::Null),
            "failures": s.get("failures").filter(|v| super::accounts::truthy(v)).cloned().unwrap_or(json!(0)),
            "nextAttemptAt": ms("nextAttemptAt"), "lastIssuedAt": ms("issuedAt"),
            "working": *self.running.lock().unwrap()
        })
    }

    /// Start checking (now, or when the backoff says), then daily. `on_change(cert_changed)`.
    pub fn start(self: &Arc<Self>, on_change: Hook, delay_ms: i64) {
        *self.on_change.lock().unwrap() = Some(on_change);
        self.schedule(super::db::now_ms() + delay_ms);
    }

    fn schedule(self: &Arc<Self>, at: i64) {
        let gen = {
            let mut g = self.generation.lock().unwrap();
            *g += 1;
            *g
        };
        let wait = (at - super::db::now_ms()).clamp(0, DAY) as u64;
        let me = self.clone();
        if let Ok(h) = tokio::runtime::Handle::try_current() {
            h.spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
                if *me.generation.lock().unwrap() == gen {
                    me.tick().await;
                }
            });
        }
    }

    /// What is due now: (issue, why or next time).
    pub fn due(&self) -> (bool, String, i64) {
        let now = super::db::now_ms();
        let s = self.state();
        if let Some(n) = s.get("nextAttemptAt").and_then(Value::as_f64).filter(|n| *n != 0.0) {
            if (now as f64) < n {
                return (false, String::new(), n as i64);
            }
        }
        let Some(cur) = self.current() else { return (true, "no certificate yet".into(), now) };
        let at = renew_at(&cur.info);
        if now >= at {
            return (true, format!("it expires {}", iso(cur.info.valid_to)), now);
        }
        (false, String::new(), at.min(now + DAY))
    }

    pub async fn tick(self: &Arc<Self>) {
        {
            let mut r = self.running.lock().unwrap();
            if *r {
                return;
            }
            let (issue, _, at) = self.due();
            if !issue {
                drop(r);
                self.schedule(at);
                return;
            }
            *r = true;
        }
        let why = self.due().1;
        self.attempt(&why).await;
        *self.running.lock().unwrap() = false;
    }

    /// The TLS client for the ACME server: Let's Encrypt's roots, or only TLS_ACME_CA_FILE's
    /// (Node: a `ca` replaces the default roots; OpenSSL also trusts a self-signed server certificate listed there).
    fn roots(&self) -> Result<Arc<rustls::ClientConfig>, AcmeError> {
        let mut roots = rustls::RootCertStore::empty();
        let mut pinned = Vec::new();
        match &self.config.ca_file {
            Some(f) => {
                let pem = read_small(Path::new(f), 256 * 1024).map_err(|e| aerr(e.to_string()))?;
                for c in super::tls::pem_ders(&pem) {
                    let _ = roots.add(rustls::pki_types::CertificateDer::from(c.clone()));
                    pinned.push(c);
                }
            }
            None => roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned()),
        }
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let inner = rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider.clone()).build().map_err(|e| aerr(e.to_string()))?;
        let verifier = Arc::new(Pinned { pinned, inner });
        let cfg = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| aerr(e.to_string()))?
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_no_client_auth();
        Ok(Arc::new(cfg))
    }

    fn account_key(&self) -> p256::SecretKey {
        match read_small(&self.file("acme-account.key"), 256 * 1024) {
            Ok(b) => {
                if let Some(k) = read_key(&String::from_utf8_lossy(&b)) {
                    return k;
                }
                if let Some(l) = &self.log {
                    l.warn("The Let's Encrypt account key could not be read; making a new account.");
                }
            }
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                if let Some(l) = &self.log {
                    l.warn("The Let's Encrypt account key could not be read; making a new account.");
                }
            }
            Err(_) => {}
        }
        let k = new_key();
        let _ = write_secret(&self.dir, "acme-account.key", key_pem(&k).as_bytes());
        k
    }

    /// Wait until this server answers plain HTTP on its port, then that it serves this token.
    async fn ready(&self, domain: &str, token: &str, key_auth: &str) -> Result<(), AcmeError> {
        let until = super::db::now_ms() + self.ready_timeout_ms;
        loop {
            let r = plain_get(&self.config.host, self.config.port, &format!("{CHALLENGE_PREFIX}{token}"), domain).await;
            if let Some((200, text)) = &r {
                if text == key_auth {
                    return Ok(());
                }
            }
            if super::db::now_ms() > until {
                return Err(aerr(format!(
                    "This server does not answer http://{domain}{CHALLENGE_PREFIX}… on its own port {} ({}), so Let's Encrypt was not asked to check yet.",
                    self.config.port,
                    r.map_or("no answer".to_string(), |(s, _)| format!("HTTP {s}"))
                )));
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }

    pub async fn attempt(self: &Arc<Self>, why: &str) -> bool {
        let label = self.config.domains.join(", ");
        let info = |m: String| {
            if let Some(l) = &self.log {
                l.info(m);
            }
        };
        info(format!("Let's Encrypt{}: requesting a certificate for {label} ({why}).", if self.config.staging { " (staging)" } else { "" }));
        let s = self.state();
        let out: Result<ChainInfo, AcmeError> = async {
            std::fs::create_dir_all(&self.dir).map_err(|e| aerr(e.to_string()))?;
            let key = self.account_key();
            let roots = self.roots()?;
            let kid = s.get("accounts").and_then(|a| a.get(&self.config.directory)).and_then(Value::as_str).map(String::from);
            let mut client = AcmeClient::new(&self.config.directory, key, roots, self.config.email.clone(), kid.clone(), self.config.port, self.log.clone())?;
            client.poll_ms = self.poll_ms;
            let cert_key = new_key();
            let key_pem_text = key_pem(&cert_key);
            let chain = client.issue(&self.config.domains, &cert_key, self).await;
            if client.kid.is_some() && client.kid != kid {
                let mut accounts = self.state().get("accounts").and_then(Value::as_object).cloned().unwrap_or_default();
                accounts.insert(self.config.directory.clone(), json!(client.kid));
                self.save_state(json!({ "accounts": accounts }));
            }
            let chain = chain?;
            let info = check_chain(&chain, &key_pem_text, &self.config.domains, super::db::now_ms()).ok_or_else(|| aerr("The certificate Let's Encrypt sent does not match the key or the names."))?;
            write_secret(&self.dir, "acme.key", key_pem_text.as_bytes()).map_err(|e| aerr(e.to_string()))?;
            write_secret(&self.dir, "acme.crt", chain.as_bytes()).map_err(|e| aerr(e.to_string()))?;
            self.save_state(json!({ "certDirectory": self.config.directory, "domains": self.config.domains, "issuedAt": super::db::now_ms(), "failures": 0, "lastError": null, "nextAttemptAt": 0 }));
            Ok(info)
        }
        .await;
        let hook = self.on_change.lock().unwrap().clone();
        match out {
            Ok(i) => {
                info(format!("Let's Encrypt: certificate for {label} issued, valid until {}; renews from {}.", iso(i.valid_to), iso(renew_at(&i))));
                if let Some(h) = hook {
                    h(true);
                }
                self.schedule(renew_at(&i).min(super::db::now_ms() + DAY));
                true
            }
            Err(e) => {
                let failures = self.state().get("failures").and_then(Value::as_i64).unwrap_or(0) + 1;
                let now = super::db::now_ms();
                let mut next = now + backoff_ms(failures);
                if let Some(ra) = e.retry_after {
                    next = next.max(ra.min(now + 7 * DAY));
                }
                let mut message = clean(&e.message, 600);
                if e.kind.as_deref() == Some("urn:ietf:params:acme:error:rateLimited") {
                    message = format!("Let's Encrypt's rate limit was reached ({}).", e.detail.clone().unwrap_or_default());
                } else if e.network {
                    message = format!("Couldn't reach Let's Encrypt at {}: {message}", self.config.directory);
                }
                self.save_state(json!({ "failures": failures, "lastError": message, "lastAttemptAt": now, "nextAttemptAt": next }));
                if let Some(l) = &self.log {
                    l.warn(format!(
                        "Let's Encrypt: no certificate for {label} yet (attempt {failures}). {message} Serving {} certificate meanwhile; trying again at {}.",
                        if self.current().is_some() { "the current Let's Encrypt" } else { "the self-signed" },
                        iso(next)
                    ));
                }
                if let Some(h) = hook {
                    h(false);
                }
                self.schedule(next);
                false
            }
        }
    }
}

/// A plain-HTTP GET to this server (the self-check): (status, the first KB of text).
async fn plain_get(host: &str, port: u16, path: &str, host_header: &str) -> Option<(u16, String)> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let work = async {
        let mut s = tokio::net::TcpStream::connect((host, port)).await.ok()?;
        s.write_all(format!("GET {path} HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\n\r\n").as_bytes()).await.ok()?;
        let mut buf = Vec::new();
        let _ = s.take(64 * 1024).read_to_end(&mut buf).await;
        let text = String::from_utf8_lossy(&buf).into_owned();
        let (head, body) = text.split_once("\r\n\r\n")?;
        let status: u16 = head.split(' ').nth(1)?.parse().ok()?;
        let chunked = head.to_lowercase().contains("transfer-encoding: chunked");
        let body = if chunked { body.split_once("\r\n").map(|(_, b)| b.split("\r\n").next().unwrap_or("").to_string()).unwrap_or_default() } else { body.to_string() };
        Some((status, body.chars().take(1024).collect()))
    };
    tokio::time::timeout(std::time::Duration::from_secs(5), work).await.ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domains_and_config() {
        assert_eq!(parse_domains("Demo.Example.com., www.example.com demo.example.com").unwrap(), vec!["demo.example.com", "www.example.com"]);
        assert!(parse_domains("192.0.2.1").is_err());
        assert!(parse_domains("*.example.com").is_err());
        assert!(parse_domains("localhost").is_err());
        let env = |pairs: &[(&str, &str)]| pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        assert!(config_from_env(&env(&[])).unwrap().is_none());
        let c = config_from_env(&env(&[("TLS_ACME_DOMAIN", "a.example.com"), ("TLS_ACME_STAGING", "yes")])).unwrap().unwrap();
        assert_eq!(c.directory, LE_STAGING_DIRECTORY);
        assert_eq!(c.host, "127.0.0.1");
        assert!(config_from_env(&env(&[("TLS_ACME_DOMAIN", "a.example.com"), ("TLS_ACME_EMAIL", "nope")])).is_err());
        assert!(config_from_env(&env(&[("TLS_ACME_DOMAIN", "a.example.com"), ("TLS_ACME_DIRECTORY", "http://x")])).is_err());
    }

    #[test]
    fn jws_verifies_and_thumbprint_shape() {
        use p256::ecdsa::signature::Verifier;
        let k = new_key();
        let j = jwk(&k);
        assert_eq!(thumbprint(&j).len(), 43);
        let jws = sign_jws(&k, "https://acme.test/new", "abc", None, Some(&json!({ "a": 1 })));
        let msg = format!("{}.{}", jws["protected"].as_str().unwrap(), jws["payload"].as_str().unwrap());
        let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(jws["signature"].as_str().unwrap()).unwrap();
        let sig = p256::ecdsa::Signature::from_slice(&sig).unwrap();
        assert!(p256::ecdsa::VerifyingKey::from(k.public_key()).verify(msg.as_bytes(), &sig).is_ok());
        let pem = key_pem(&k);
        assert!(pem.starts_with("-----BEGIN PRIVATE KEY-----"));
        assert_eq!(read_key(&pem).unwrap().to_bytes(), k.to_bytes());
        assert!(key_auth_ok(&key_authorization(&"t".repeat(43), &k)));
    }

    #[test]
    fn csr_parses() {
        let k = new_key();
        let der = create_csr(&k, &["demo.example.com".into(), "www.example.com".into()]);
        use x509_parser::prelude::FromDer;
        let (_, csr) = x509_parser::certification_request::X509CertificationRequest::from_der(&der).unwrap();
        assert!(csr.verify_signature().is_ok());
        assert_eq!(csr.certification_request_info.subject.iter_common_name().next().unwrap().as_str().unwrap(), "demo.example.com");
    }

    #[test]
    fn backoff_and_renewal() {
        assert_eq!(backoff_ms(0), 15 * 60_000);
        assert_eq!(backoff_ms(2), 3_600_000);
        assert_eq!(backoff_ms(99), DAY);
        let i = ChainInfo { valid_from: 0, valid_to: 90 * DAY, fingerprint: String::new() };
        assert_eq!(renew_at(&i), 60 * DAY);
        let short = ChainInfo { valid_from: 0, valid_to: 6 * DAY, fingerprint: String::new() };
        assert_eq!(renew_at(&short), 4 * DAY);
        assert_eq!(retry_after_at(Some("120"), 1000), Some(121_000));
        assert_eq!(retry_after_at(Some(""), 1000), None);
        assert_eq!(clean("a\u{1}\u{2}b  ", 300), "a b");
    }
}

#[cfg(test)]
mod live {
    use super::*;
    use std::io::BufRead;

    /// A plain-HTTP answerer for the challenge (the plain side of port 9000, in small).
    async fn front(mgr: Arc<std::sync::OnceLock<Arc<AcmeManager>>>) -> u16 {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((s, _)) = l.accept().await else { return };
                let mgr = mgr.clone();
                tokio::spawn(async move {
                    let svc = hyper::service::service_fn(move |req: axum::http::Request<hyper::body::Incoming>| {
                        let mgr = mgr.clone();
                        async move {
                            let p = req.uri().path().to_string();
                            let ka = p.strip_prefix(CHALLENGE_PREFIX).and_then(|t| mgr.get().and_then(|m| m.challenge(t)));
                            let r = match ka {
                                Some(k) => axum::http::Response::builder().status(200).body(http_body_util::Full::new(bytes::Bytes::from(k))).unwrap(),
                                None => axum::http::Response::builder().status(308).body(http_body_util::Full::new(bytes::Bytes::new())).unwrap(),
                            };
                            Ok::<_, std::convert::Infallible>(r)
                        }
                    });
                    let _ = hyper::server::conn::http1::Builder::new().serve_connection(hyper_util::rt::TokioIo::new(s), svc).await;
                });
            }
        });
        port
    }

    /// Against test/fixtures/fakeAcme.js (Node's own test server for acme.js): a real order, start to finish.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn issues_against_the_fake_acme_server() {
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        let fixture = repo.join("test/fixtures/fakeAcme.js");
        if !fixture.exists() || std::process::Command::new("node").arg("--version").output().is_err() {
            eprintln!("skipped: no node or no fake ACME server");
            return;
        }
        let dir = std::env::temp_dir().join(format!("lean-acme-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cell: Arc<std::sync::OnceLock<Arc<AcmeManager>>> = Arc::new(std::sync::OnceLock::new());
        let port = front(cell.clone()).await;
        let script = format!(
            "require({:?}).startFakeAcme({:?}, {{ validate: {{ httpBase: 'http://127.0.0.1:{port}' }} }}).then((f) => console.log(JSON.stringify({{ directory: f.directory, caFile: f.caFile }})))",
            fixture.to_string_lossy(),
            dir.join("fake").to_string_lossy()
        );
        let mut child = std::process::Command::new("node").arg("-e").arg(&script).stdout(std::process::Stdio::piped()).spawn().unwrap();
        let mut line = String::new();
        std::io::BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let f: Value = serde_json::from_str(&line).unwrap();
        let config = AcmeConfig {
            domains: vec!["demo.example.test".into()],
            email: Some("owner@example.test".into()),
            staging: false,
            directory: f["directory"].as_str().unwrap().into(),
            ca_file: Some(f["caFile"].as_str().unwrap().into()),
            port,
            host: "127.0.0.1".into(),
        };
        let tls = dir.join("tls");
        std::fs::create_dir_all(&tls).unwrap();
        let mut m = AcmeManager::new(config, tls.clone(), None);
        m.poll_ms = 50;
        m.ready_timeout_ms = 5000;
        let m = Arc::new(m);
        let _ = cell.set(m.clone());
        assert!(m.current().is_none());
        let ok = m.attempt("test").await;
        let _ = child.kill();
        assert!(ok, "{:?}", m.state());
        let cur = m.current().expect("issued");
        assert!(cur.info.valid_to > super::super::db::now_ms());
        use std::os::unix::fs::PermissionsExt;
        for n in ["acme-account.key", "acme.key", "acme.crt", "acme-state.json"] {
            assert_eq!(std::fs::metadata(tls.join(n)).unwrap().permissions().mode() & 0o777, 0o600, "{n}");
        }
        let st = m.status();
        assert_eq!(st["issued"], true);
        assert_eq!(st["failures"], 0);
        assert!(m.pending.lock().unwrap().is_empty());
        // nothing due now: a renewal waits
        assert!(!m.due().0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
