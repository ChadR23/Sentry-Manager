//! Certificate pinning (nodes.js pinMatches and the authority kept at
//! pairing): the node must present the certificate it had when it was
//! paired (by SHA-256 fingerprint), or one issued by the certificate
//! authority it had then and valid now.

use super::same_hex;
use serde_json::Value;
use x509_parser::certificate::X509Certificate;
use x509_parser::extensions::ParsedExtension;

/// What is kept with a paired node: { fingerprint, authority (PEM) | null }.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Pin {
    pub fingerprint: Option<String>,
    pub authority: Option<String>,
}

impl Pin {
    pub fn from_json(v: &Value) -> Option<Pin> {
        if !v.is_object() {
            return None;
        }
        Some(Pin { fingerprint: v["fingerprint"].as_str().map(String::from), authority: v["authority"].as_str().map(String::from) })
    }
}

/// The DER of the first certificate in a PEM text (or DER bytes), as
/// `new crypto.X509Certificate(text)` reads it.
pub fn der_of(text: &[u8]) -> Option<Vec<u8>> {
    if let Ok((_, pem)) = x509_parser::pem::parse_x509_pem(text) {
        if pem.label == "CERTIFICATE" || pem.label == "X509 CERTIFICATE" || pem.label == "TRUSTED CERTIFICATE" {
            return Some(pem.contents);
        }
        return None;
    }
    x509_parser::parse_x509_certificate(text).ok().map(|_| text.to_vec())
}

/// X509Certificate.toString(): the certificate as PEM, 64 characters a line.
pub fn pem_of(der: &[u8]) -> String {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(der);
    let mut out = String::from("-----BEGIN CERTIFICATE-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap());
        out.push('\n');
    }
    out.push_str("-----END CERTIFICATE-----\n");
    out
}

fn skid<'a>(c: &'a X509Certificate) -> Option<&'a [u8]> {
    c.extensions().iter().find_map(|e| match e.parsed_extension() {
        ParsedExtension::SubjectKeyIdentifier(k) => Some(k.0),
        _ => None,
    })
}

fn akid<'a>(c: &'a X509Certificate) -> Option<&'a [u8]> {
    c.extensions().iter().find_map(|e| match e.parsed_extension() {
        ParsedExtension::AuthorityKeyIdentifier(a) => a.key_identifier.as_ref().map(|k| k.0),
        _ => None,
    })
}

/// X509Certificate.checkIssued (OpenSSL X509_check_issued): the names, the
/// key identifiers when both carry one, and the issuer's key usage.
fn check_issued(leaf: &X509Certificate, ca: &X509Certificate) -> bool {
    if leaf.issuer().as_raw() != ca.subject().as_raw() && leaf.issuer() != ca.subject() {
        return false;
    }
    if let (Some(a), Some(s)) = (akid(leaf), skid(ca)) {
        if a != s {
            return false;
        }
    }
    if let Ok(Some(ku)) = ca.key_usage() {
        if !ku.value.key_cert_sign() {
            return false;
        }
    }
    true
}

fn verify(leaf: &X509Certificate, ca: &X509Certificate) -> bool {
    leaf.verify_signature(Some(ca.public_key())).is_ok()
}

/// pinMatches(pin, raw, fingerprint)
pub fn pin_matches(pin: &Pin, raw: &[u8], fingerprint: &str, now_ms: i64) -> bool {
    if let Some(f) = &pin.fingerprint {
        if same_hex(f, fingerprint) {
            return true;
        }
    }
    let Some(authority) = &pin.authority else { return false };
    let Some(ca_der) = der_of(authority.as_bytes()) else { return false };
    let (Ok((_, ca)), Ok((_, leaf))) = (x509_parser::parse_x509_certificate(&ca_der), x509_parser::parse_x509_certificate(raw)) else { return false };
    let from = leaf.validity().not_before.timestamp() * 1000;
    let to = leaf.validity().not_after.timestamp() * 1000;
    check_issued(&leaf, &ca) && verify(&leaf, &ca) && from <= now_ms && now_ms <= to
}

/// At pairing: the node's authority (PEM), kept when it is a CA and issued
/// the certificate seen now; None pins by fingerprint only.
pub fn accept_authority(authority: &Value, leaf_raw: &[u8]) -> Option<String> {
    let text = authority.as_str()?;
    if text.encode_utf16().count() >= 16_384 {
        return None;
    }
    let ca_der = der_of(text.as_bytes())?;
    let (_, ca) = x509_parser::parse_x509_certificate(&ca_der).ok()?;
    let (_, leaf) = x509_parser::parse_x509_certificate(leaf_raw).ok()?;
    (ca.is_ca() && check_issued(&leaf, &ca) && verify(&leaf, &ca)).then(|| pem_of(&ca_der))
}
