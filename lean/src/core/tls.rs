//! HTTPS certificates (server/tls.js): the app is its own small, name-
//! constrained certificate authority in `DATA/tls` (ca.key/ca.crt, 10 years;
//! server.key/server.crt, 825 days, renewed 30 days before the end or when a
//! name is missing), made with the same openssl commands as Node, so the
//! files either server made are used by the other as they are. Or your own
//! certificate (TLS_CERT_FILE/TLS_KEY_FILE), or Let's Encrypt (acme.rs).

use super::acme::{AcmeConfig, AcmeManager};
use super::log::Scope;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::net::IpAddr;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const LEAF_DAYS: u32 = 825;
pub const RENEW_BEFORE_MS: i64 = 30 * 24 * 3600 * 1000;
pub const LOCAL_DNS: [&str; 7] = ["localhost", "local", "lan", "home", "home.arpa", "internal", "localdomain"];
const PRIVATE_V4: [(&str, &str); 6] = [
    ("10.0.0.0", "255.0.0.0"),
    ("172.16.0.0", "255.240.0.0"),
    ("192.168.0.0", "255.255.0.0"),
    ("127.0.0.0", "255.0.0.0"),
    ("100.64.0.0", "255.192.0.0"),
    ("169.254.0.0", "255.255.0.0"),
];
const PRIVATE_V6: [(&str, &str); 3] = [
    ("fc00:0:0:0:0:0:0:0", "fe00:0:0:0:0:0:0:0"),
    ("fe80:0:0:0:0:0:0:0", "ffc0:0:0:0:0:0:0:0"),
    ("0:0:0:0:0:0:0:1", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"),
];

pub fn is_ip(s: &str) -> bool {
    s.parse::<IpAddr>().is_ok()
}

fn dns_ok(s: &str) -> bool {
    if s.is_empty() || s.len() > 253 {
        return false;
    }
    s.split('.').all(|l| {
        let b = l.as_bytes();
        !b.is_empty() && b.len() <= 63 && b[0].is_ascii_alphanumeric() && b[b.len() - 1].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
    })
}

/// One spelling per name: lower-case host names, canonical IPs.
pub fn canonical_name(n: &str) -> String {
    let h = n.trim().trim_start_matches('[').trim_end_matches(']');
    match h.parse::<IpAddr>() {
        Ok(ip) => ip.to_string(),
        Err(_) => h.to_lowercase(),
    }
}

/// Split and check a list of host names / IP addresses.
pub fn parse_hostnames(value: &str) -> Result<Vec<String>, super::auth::Refusal> {
    let mut out: Vec<String> = Vec::new();
    for raw in value.split(|c: char| c.is_whitespace() || c == ',') {
        let h = raw.trim().trim_start_matches('[').trim_end_matches(']').to_lowercase();
        if h.is_empty() {
            continue;
        }
        if is_ip(&h) || dns_ok(&h) {
            if !out.contains(&h) {
                out.push(h);
            }
        } else {
            return Err(super::auth::refuse(400, &format!("\"{raw}\" is not a host name or IP address.")));
        }
    }
    Ok(out)
}

pub fn ip_permitted(ip: &str) -> bool {
    match ip.parse::<IpAddr>() {
        Ok(IpAddr::V4(a)) => {
            let n = u32::from(a);
            PRIVATE_V4.iter().any(|(b, m)| {
                let (b, m): (std::net::Ipv4Addr, std::net::Ipv4Addr) = (b.parse().unwrap(), m.parse().unwrap());
                n & u32::from(m) == u32::from(b) & u32::from(m)
            })
        }
        Ok(IpAddr::V6(_)) => {
            let lower = ip.to_lowercase();
            lower == "::1" || lower.starts_with("fc") || lower.starts_with("fd") || ["fe8", "fe9", "fea", "feb"].iter().any(|p| lower.starts_with(p))
        }
        Err(_) => false,
    }
}

pub fn dns_permitted(name: &str, extra: &[String]) -> bool {
    let n = name.to_lowercase();
    LOCAL_DNS.iter().map(|s| s.to_string()).chain(extra.iter().cloned()).any(|c| n == c || n.ends_with(&format!(".{c}")))
}

fn openssl(args: &[&str]) -> Result<(), String> {
    let out = std::process::Command::new("openssl").args(args).stdin(std::process::Stdio::null()).output().map_err(|e| format!("openssl {} failed: {e}", args[0]))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = err.trim().lines().collect();
        let t = tail[tail.len().saturating_sub(3)..].join("\n");
        return Err(format!("openssl {} failed: {}", args[0], if t.is_empty() { out.status.code().unwrap_or(-1).to_string() } else { t }));
    }
    Ok(())
}

/// The first certificate of a PEM text, as DER.
pub fn pem_der(pem: &str) -> Option<Vec<u8>> {
    let mut rd = std::io::BufReader::new(pem.as_bytes());
    let first = rustls_pemfile::certs(&mut rd).next()?.ok().map(|c| c.to_vec());
    first
}

pub fn pem_ders(pem: &[u8]) -> Vec<Vec<u8>> {
    let mut rd = std::io::BufReader::new(pem);
    rustls_pemfile::certs(&mut rd).filter_map(Result::ok).map(|c| c.to_vec()).collect()
}

/// X509Certificate.fingerprint256: SHA-256 of the DER, AB:CD:...
pub fn fingerprint_der(der: &[u8]) -> String {
    Sha256::digest(der).iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

pub fn fingerprint(pem: &str) -> Option<String> {
    pem_der(pem).filter(|d| x509_parser::parse_x509_certificate(d).is_ok()).map(|d| fingerprint_der(&d))
}

/// OpenSSL's time text, as X509Certificate.validFrom: "Nov  5 19:18:19 2026 GMT".
fn openssl_time(t: &x509_parser::time::ASN1Time) -> (String, i64) {
    let ts = t.timestamp();
    let d = chrono::DateTime::from_timestamp(ts, 0).unwrap_or_default();
    (d.format("%b %e %H:%M:%S %Y GMT").to_string(), ts * 1000)
}

fn dn_text(n: &x509_parser::x509::X509Name) -> String {
    let reg = x509_parser::objects::oid_registry();
    let mut parts = Vec::new();
    for rdn in n.iter() {
        for a in rdn.iter() {
            let key = x509_parser::objects::oid2abbrev(a.attr_type(), reg).map(String::from).unwrap_or_else(|_| a.attr_type().to_id_string());
            let val = a.as_str().map(String::from).unwrap_or_default();
            parts.push(format!("{key}={val}"));
        }
    }
    parts.join("\n")
}

/// The names of a certificate's subjectAltName as Node lists them (IPv6 in full, upper-case).
fn san_names(c: &x509_parser::certificate::X509Certificate) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(Some(san)) = c.subject_alternative_name() {
        for g in &san.value.general_names {
            match g {
                x509_parser::extensions::GeneralName::DNSName(d) => out.push(d.to_string()),
                x509_parser::extensions::GeneralName::IPAddress(b) => {
                    if b.len() == 4 {
                        out.push(format!("{}.{}.{}.{}", b[0], b[1], b[2], b[3]));
                    } else if b.len() == 16 {
                        out.push((0..8).map(|i| format!("{:X}", u16::from_be_bytes([b[2 * i], b[2 * i + 1]]))).collect::<Vec<_>>().join(":"));
                    }
                }
                other => out.push(format!("{other}")),
            }
        }
    }
    out
}

/// tls.js certInfo: { fingerprint, validFrom, validTo, expiresAt, subject, issuer, names }, or null.
pub fn cert_info(pem: &str) -> Value {
    let Some(der) = pem_der(pem) else { return Value::Null };
    let Ok((_, c)) = x509_parser::parse_x509_certificate(&der) else { return Value::Null };
    let (from, _) = openssl_time(&c.validity().not_before);
    let (to, to_ms) = openssl_time(&c.validity().not_after);
    json!({ "fingerprint": fingerprint_der(&der), "validFrom": from, "validTo": to, "expiresAt": to_ms,
        "subject": dn_text(c.subject()), "issuer": dn_text(c.issuer()), "names": san_names(&c) })
}

fn hostname() -> String {
    let mut buf = [0u8; 256];
    if unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) } != 0 {
        return String::new();
    }
    let n = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..n]).into_owned()
}

/// The key and certificate chain to serve (PEM).
#[derive(Clone)]
pub struct Material {
    pub key: Vec<u8>,
    pub cert: Vec<u8>,
    pub own: bool,
    pub acme: bool,
}

pub struct TlsManager {
    pub dir: PathBuf,
    log: Option<Scope>,
    pub extra_hostnames: Vec<String>,
    own_cert: Option<(PathBuf, PathBuf)>,
    pub acme: Option<Arc<AcmeManager>>,
    last_served: Mutex<Option<String>>,
}

struct Files {
    ca_key: PathBuf,
    ca_crt: PathBuf,
    key: PathBuf,
    crt: PathBuf,
    names: PathBuf,
}

impl TlsManager {
    pub fn new(dir: PathBuf, log: Option<Scope>, hostnames: Vec<String>, cert_file: Option<String>, key_file: Option<String>, acme: Option<AcmeConfig>) -> TlsManager {
        let own_cert = match (cert_file, key_file) {
            (Some(c), Some(k)) => Some((PathBuf::from(c), PathBuf::from(k))),
            _ => None,
        };
        if acme.is_some() && own_cert.is_some() {
            if let Some(l) = &log {
                l.warn("TLS_CERT_FILE/TLS_KEY_FILE are set, so TLS_ACME_DOMAIN is ignored.");
            }
        }
        let acme = acme.filter(|_| own_cert.is_none()).map(|a| Arc::new(AcmeManager::new(a, dir.clone(), log.clone())));
        TlsManager { dir, log, extra_hostnames: hostnames, own_cert, acme, last_served: Mutex::new(None) }
    }

    fn files(&self) -> Files {
        Files { ca_key: self.dir.join("ca.key"), ca_crt: self.dir.join("ca.crt"), key: self.dir.join("server.key"), crt: self.dir.join("server.crt"), names: self.dir.join("hostnames.json") }
    }

    pub fn stored_hostnames(&self) -> Vec<String> {
        let Ok(text) = std::fs::read_to_string(self.files().names) else { return Vec::new() };
        let Ok(Value::Array(list)) = serde_json::from_str::<Value>(&text) else { return Vec::new() };
        let joined = list.iter().map(|v| super::accounts::js_string(Some(v))).collect::<Vec<_>>().join(",");
        parse_hostnames(&joined).unwrap_or_default()
    }

    /// Every name the server certificate covers.
    pub fn hostnames(&self) -> Vec<String> {
        let mut names: Vec<String> = vec!["localhost".into(), "127.0.0.1".into(), "::1".into()];
        names.extend(self.extra_hostnames.iter().cloned());
        if let Some(a) = &self.acme {
            names.extend(a.config.domains.iter().cloned());
        }
        names.extend(self.stored_hostnames());
        let mut out: Vec<String> = Vec::new();
        for n in names.iter().map(|n| canonical_name(n)) {
            if !out.contains(&n) {
                out.push(n);
            }
        }
        out
    }

    fn info(&self, m: &str) {
        if let Some(l) = &self.log {
            l.info(m);
        }
    }

    /// Make sure CA and server certificate exist and fit.
    pub fn ensure(&self) -> Result<Material, String> {
        if let Some((cert, key)) = &self.own_cert {
            return Ok(Material { key: std::fs::read(key).map_err(|e| e.to_string())?, cert: std::fs::read(cert).map_err(|e| e.to_string())?, own: true, acme: false });
        }
        if let Some(a) = &self.acme {
            if let Some(issued) = a.current() {
                let mut last = self.last_served.lock().unwrap();
                if last.as_deref() != Some(issued.fingerprint.as_str()) {
                    self.info(&format!("HTTPS certificate: Let's Encrypt for {}, fingerprint (SHA-256) {}", a.config.domains.join(", "), issued.fingerprint));
                }
                *last = Some(issued.fingerprint.clone());
                return Ok(Material { key: issued.key, cert: issued.cert, own: false, acme: true });
            }
        }
        let f = self.files();
        std::fs::DirBuilder::new().recursive(true).create(&self.dir).map_err(|e| e.to_string())?;
        let _ = std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700));
        if !f.ca_key.exists() || !f.ca_crt.exists() || !self.ca_covers(&self.hostnames()) {
            self.create_ca()?;
        }
        let leaf = cert_info(&std::fs::read_to_string(&f.crt).unwrap_or_default());
        let want = self.hostnames();
        let stale = leaf.is_null()
            || leaf["expiresAt"].as_i64().unwrap_or(0) - super::db::now_ms() < RENEW_BEFORE_MS
            || {
                let have: Vec<String> = leaf["names"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(canonical_name).collect()).unwrap_or_default();
                want.iter().any(|n| !have.contains(n))
            }
            || !self.signed_by_ca();
        if stale {
            self.issue_leaf(&want)?;
        }
        let ca_pem = std::fs::read_to_string(&f.ca_crt).map_err(|e| e.to_string())?;
        self.info(&format!(
            "HTTPS certificate fingerprint (SHA-256), as browsers show it: {}",
            fingerprint(&std::fs::read_to_string(&f.crt).unwrap_or_default()).unwrap_or_else(|| "null".into())
        ));
        self.info(&format!("HTTPS certificate authority fingerprint (SHA-256): {}", fingerprint(&ca_pem).unwrap_or_else(|| "null".into())));
        Ok(Material { key: std::fs::read(&f.key).map_err(|e| e.to_string())?, cert: std::fs::read(&f.crt).map_err(|e| e.to_string())?, own: false, acme: false })
    }

    fn ca_permitted_dns(&self) -> Option<Vec<String>> {
        let text = std::fs::read_to_string(self.dir.join("ca-names.json")).ok()?;
        match serde_json::from_str::<Value>(&text).ok()? {
            Value::Array(a) => Some(a.iter().map(|v| super::accounts::js_string(Some(v))).collect()),
            _ => Some(Vec::new()),
        }
    }

    pub fn ca_covers(&self, names: &[String]) -> bool {
        let Some(extra) = self.ca_permitted_dns() else { return false };
        names.iter().all(|n| if is_ip(n) { ip_permitted(n) } else { dns_permitted(n, &extra) })
    }

    pub fn signed_by_ca(&self) -> bool {
        let f = self.files();
        let (Ok(ca), Ok(leaf)) = (std::fs::read_to_string(&f.ca_crt), std::fs::read_to_string(&f.crt)) else { return false };
        let (Some(ca), Some(leaf)) = (pem_der(&ca), pem_der(&leaf)) else { return false };
        let (Ok((_, ca)), Ok((_, leaf))) = (x509_parser::parse_x509_certificate(&ca), x509_parser::parse_x509_certificate(&leaf)) else { return false };
        leaf.issuer().as_raw() == ca.subject().as_raw() && leaf.verify_signature(Some(ca.public_key())).is_ok()
    }

    fn create_ca(&self) -> Result<(), String> {
        let names = self.hostnames();
        for ip in names.iter().filter(|n| is_ip(n)) {
            if !ip_permitted(ip) {
                return Err(format!("{ip} is a public IP address; use TLS_CERT_FILE/TLS_KEY_FILE with a real certificate for it."));
            }
        }
        let mut extra_dns: Vec<String> = Vec::new();
        for n in names.iter().filter(|n| !is_ip(n) && !dns_permitted(n, &[])) {
            let l = n.to_lowercase();
            if !extra_dns.contains(&l) {
                extra_dns.push(l);
            }
        }
        let constraints = LOCAL_DNS
            .iter()
            .map(|d| d.to_string())
            .chain(extra_dns.iter().cloned())
            .map(|d| format!("permitted;DNS:{d}"))
            .chain(PRIVATE_V4.iter().map(|(b, m)| format!("permitted;IP:{b}/{m}")))
            .chain(PRIVATE_V6.iter().map(|(b, m)| format!("permitted;IP:{b}/{m}")))
            .collect::<Vec<_>>()
            .join(",");
        let id = super::auth::hex(&super::auth::random_bytes(4));
        let f = self.files();
        let tmp_key = format!("{}.tmp", f.ca_key.display());
        let tmp_crt = format!("{}.tmp", f.ca_crt.display());
        openssl(&["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", &tmp_key])?;
        std::fs::set_permissions(&tmp_key, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
        let subj = format!("/O=Sentry Six Manager/CN=Sentry Six Manager local CA {id}");
        let nc = format!("nameConstraints=critical,{constraints}");
        openssl(&[
            "req", "-x509", "-new", "-key", &tmp_key, "-sha256", "-days", "3650", "-subj", &subj, "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-addext",
            "keyUsage=critical,keyCertSign,cRLSign", "-addext", &nc, "-out", &tmp_crt,
        ])?;
        std::fs::rename(&tmp_key, &f.ca_key).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp_crt, &f.ca_crt).map_err(|e| e.to_string())?;
        std::fs::write(self.dir.join("ca-names.json"), serde_json::to_string(&extra_dns).unwrap()).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&f.crt);
        if let Some(l) = &self.log {
            l.warn("Created a new HTTPS certificate authority. Install /data/tls/ca.crt on your devices (Settings > Security) to trust the page.");
        }
        Ok(())
    }

    fn issue_leaf(&self, names: &[String]) -> Result<(), String> {
        let f = self.files();
        let san = names.iter().map(|n| if is_ip(n) { format!("IP:{n}") } else { format!("DNS:{n}") }).collect::<Vec<_>>().join(",");
        let ext = self.dir.join("server.ext");
        std::fs::write(&ext, ["basicConstraints=critical,CA:FALSE", "keyUsage=critical,digitalSignature", "extendedKeyUsage=serverAuth", &format!("subjectAltName={san}")].join("\n"))
            .map_err(|e| e.to_string())?;
        let tmp_key = format!("{}.tmp", f.key.display());
        let tmp_crt = format!("{}.tmp", f.crt.display());
        let csr = self.dir.join("server.csr");
        let (csr_s, ext_s) = (csr.display().to_string(), ext.display().to_string());
        openssl(&["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", &tmp_key])?;
        std::fs::set_permissions(&tmp_key, std::fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
        let cn = names.iter().find(|n| !is_ip(n)).cloned().unwrap_or_else(|| "localhost".into());
        let subj = format!("/O=Sentry Six Manager/CN={cn}");
        openssl(&["req", "-new", "-key", &tmp_key, "-subj", &subj, "-out", &csr_s])?;
        let serial = format!("0x{}", super::auth::hex(&super::auth::random_bytes(16)));
        let days = LEAF_DAYS.to_string();
        let (ca_crt, ca_key) = (f.ca_crt.display().to_string(), f.ca_key.display().to_string());
        openssl(&["x509", "-req", "-in", &csr_s, "-CA", &ca_crt, "-CAkey", &ca_key, "-set_serial", &serial, "-days", &days, "-sha256", "-extfile", &ext_s, "-out", &tmp_crt])?;
        std::fs::rename(&tmp_key, &f.key).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp_crt, &f.crt).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&csr);
        let _ = std::fs::remove_file(&ext);
        self.info(&format!("Issued the HTTPS certificate for {}", names.join(", ")));
        Ok(())
    }

    /// Change the extra names (from the UI); returns the material and whether the CA had to be replaced.
    pub fn set_hostnames(&self, list: &[String]) -> Result<(Material, bool), super::http::HttpError> {
        use super::http::HttpError;
        let names = parse_hostnames(&list.join(",")).map_err(HttpError::from)?;
        if names.len() > 20 {
            return Err(HttpError::new(400, "At most 20 names."));
        }
        for ip in names.iter().filter(|n| is_ip(n)) {
            if !ip_permitted(ip) {
                return Err(HttpError::new(400, format!("{ip} is a public IP address. Use your own certificate (TLS_CERT_FILE) for public addresses.")));
            }
        }
        let f = self.files();
        let before = fingerprint(&std::fs::read_to_string(&f.ca_crt).unwrap_or_default());
        std::fs::write(&f.names, serde_json::to_string(&names).unwrap()).map_err(|e| HttpError::internal(e.to_string()))?;
        let out = self.ensure().map_err(HttpError::internal)?;
        let after = fingerprint(&std::fs::read_to_string(&f.ca_crt).unwrap_or_default());
        Ok((out, before != after))
    }

    pub fn challenge(&self, token: &str) -> Option<String> {
        self.acme.as_ref().and_then(|a| a.challenge(token))
    }

    pub fn status(&self) -> Result<Value, String> {
        let read = |p: &Path| std::fs::read_to_string(p).map(|t| cert_info(&t)).unwrap_or(Value::Null);
        if let Some((cert, _)) = &self.own_cert {
            let c = cert_info(&std::fs::read_to_string(cert).map_err(|e| e.to_string())?);
            let names = if c.is_null() { json!([]) } else { c["names"].clone() };
            return Ok(json!({ "mode": "own", "certificate": c, "ca": null, "hostnames": names }));
        }
        let f = self.files();
        if let Some(a) = &self.acme {
            let issued = a.current();
            let st = a.status();
            let day = |v: &Value| v.as_str().map(|s| s.chars().take(10).collect::<String>()).unwrap_or_else(|| "?".into());
            let names = a.config.domains.join(", ");
            let summary = if issued.is_some() {
                format!(
                    "Let's Encrypt{} for {names}, renews on {} (valid until {})",
                    if a.config.staging { " (staging, not trusted by browsers)" } else { "" },
                    day(&st["renewsAt"]),
                    day(&st["validTo"])
                )
            } else {
                let next = st["nextAttemptAt"].as_str().map(|s| format!(" Next try {} UTC.", s.replace('T', " ").chars().take(16).collect::<String>())).unwrap_or_default();
                format!(
                    "Let's Encrypt for {names}: not issued yet{}.{}{next} The self-signed certificate is served until then.",
                    if st["working"] == true { " (working on it)" } else { "" },
                    st["lastError"].as_str().map(|e| format!(" {e}")).unwrap_or_default()
                )
            };
            let certificate = match &issued {
                Some(i) => cert_info(&String::from_utf8_lossy(&i.cert)),
                None => read(&f.crt),
            };
            return Ok(json!({
                "mode": "acme", "acme": st, "summary": summary, "serving": if issued.is_some() { "acme" } else { "self-signed" },
                "certificate": certificate, "ca": read(&f.ca_crt),
                "hostnames": self.hostnames(), "editable": self.stored_hostnames(), "fromEnv": self.extra_hostnames, "containerHostname": hostname()
            }));
        }
        let ca = cert_info(&std::fs::read_to_string(&f.ca_crt).map_err(|e| format!("ENOENT: no such file or directory, open '{}': {e}", f.ca_crt.display()))?);
        let certificate = cert_info(&std::fs::read_to_string(&f.crt).map_err(|e| e.to_string())?);
        Ok(json!({
            "mode": "local-ca", "ca": ca, "certificate": certificate,
            "hostnames": self.hostnames(), "editable": self.stored_hostnames(), "fromEnv": self.extra_hostnames,
            "containerHostname": hostname()
        }))
    }

    pub fn ca_pem(&self) -> Option<Vec<u8>> {
        if self.own_cert.is_some() {
            return None;
        }
        std::fs::read(self.files().ca_crt).ok()
    }
}

/// Where the certificate comes from: this process (standalone, tests) or the root supervisor's export.
pub enum TlsSource {
    Local(TlsManager),
    /// the files the supervisor exported (server.key, server.crt, status.json, ca.crt); names change through it
    Supervised(PathBuf),
}

impl TlsSource {
    pub fn load(&self) -> Result<Material, String> {
        match self {
            TlsSource::Local(m) => m.ensure(),
            TlsSource::Supervised(d) => Ok(Material {
                key: std::fs::read(d.join("server.key")).map_err(|e| e.to_string())?,
                cert: std::fs::read(d.join("server.crt")).map_err(|e| e.to_string())?,
                own: false,
                acme: false,
            }),
        }
    }

    pub fn status(&self) -> Result<Value, String> {
        match self {
            TlsSource::Local(m) => m.status(),
            TlsSource::Supervised(d) => std::fs::read_to_string(d.join("status.json")).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str(&t).map_err(|e| e.to_string())),
        }
    }

    pub fn ca_pem(&self) -> Option<Vec<u8>> {
        match self {
            TlsSource::Local(m) => m.ca_pem(),
            TlsSource::Supervised(d) => std::fs::read(d.join("ca.crt")).ok(),
        }
    }

    pub fn challenge(&self, token: &str) -> Option<String> {
        match self {
            TlsSource::Local(m) => m.challenge(token),
            // (the supervisor's pending tokens come over its IPC channel: supervisor area)
            TlsSource::Supervised(_) => None,
        }
    }

    pub fn set_hostnames(&self, list: &[String]) -> Result<(Material, bool), super::http::HttpError> {
        match self {
            TlsSource::Local(m) => m.set_hostnames(list),
            TlsSource::Supervised(_) => Err(super::http::HttpError::internal("The supervisor did not answer.")),
        }
    }
}

/// A rustls server configuration for this key and chain (HTTP/2 and HTTP/1.1, TLS 1.2 and 1.3).
pub fn server_config(m: &Material, alpn_h2: bool) -> Result<Arc<rustls::ServerConfig>, String> {
    let certs: Vec<rustls::pki_types::CertificateDer<'static>> = pem_ders(&m.cert).into_iter().map(rustls::pki_types::CertificateDer::from).collect();
    if certs.is_empty() {
        return Err("no certificate in the PEM".into());
    }
    let key = rustls_pemfile::private_key(&mut std::io::BufReader::new(&m.key[..])).map_err(|e| e.to_string())?.ok_or("no key in the PEM")?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut cfg = rustls::ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| e.to_string())?;
    cfg.alpn_protocols = if alpn_h2 { vec![b"h2".to_vec(), b"http/1.1".to_vec()] } else { vec![b"http/1.1".to_vec()] };
    Ok(Arc::new(cfg))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(parse_hostnames("NAS.lan, [fd00::5] 192.168.1.4 nas.lan").unwrap(), vec!["nas.lan", "fd00::5", "192.168.1.4"]);
        assert_eq!(parse_hostnames("bad_name").unwrap_err().message, "\"bad_name\" is not a host name or IP address.");
        assert_eq!(canonical_name("0:0:0:0:0:0:0:1"), "::1");
        assert_eq!(canonical_name("FD00:0:0:0:0:0:0:5"), "fd00::5");
        assert!(ip_permitted("192.168.1.4"));
        assert!(ip_permitted("100.100.0.1"));
        assert!(!ip_permitted("8.8.8.8"));
        assert!(ip_permitted("fd00::5"));
        assert!(!ip_permitted("2001:db8::1"));
        assert!(dns_permitted("nas.lan", &[]));
        assert!(!dns_permitted("example.com", &[]));
        assert!(dns_permitted("a.example.com", &["example.com".into()]));
    }
}
