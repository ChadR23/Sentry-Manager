//! A vehicle's SMB settings, checked field by field (a port of the parts of
//! server/mountSpec.js the footage area uses: parseShare, normalizeSmb,
//! securitySummary). The mount itself (mountArgs, the credentials file) is
//! the supervisor's: it gets the normalized source through ctx::Mounter.

use super::ctx::Fail;
use super::js;
use serde_json::{json, Value};

pub const VERSIONS: [(&str, &str); 4] = [
    ("3.1.1", "SMB 3.1.1 (recommended)"),
    ("3.02", "SMB 3.02"),
    ("3.0", "SMB 3.0"),
    ("3", "SMB 3.0 or newer (best the server offers)"),
];
pub const DEFAULT_VERSION: &str = "3.1.1";

fn bad(m: &str) -> Fail {
    // (code INVALID_SMB is not exposed: the answer is { error } only)
    Fail::new(400, m)
}

fn label(v: &str) -> bool {
    let b = v.as_bytes();
    !b.is_empty() && b.len() <= 63 && b[0].is_ascii_alphanumeric() && b[b.len() - 1].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
}

/// mountSpec.js HOST_RE
pub fn valid_host(h: &str) -> bool {
    if let Some(inner) = h.strip_prefix('[').and_then(|r| r.strip_suffix(']')) {
        return !inner.is_empty() && inner.bytes().all(|c| c.is_ascii_hexdigit() || c == b':' || c == b'.');
    }
    !h.is_empty() && h.split('.').all(label)
}

fn segment_ok(s: &str) -> bool {
    let n = js::len16(s);
    (1..=80).contains(&n) && !s.chars().any(|c| matches!(c, '\\' | '/' | ',' | '"' | '\u{0}'..='\u{1f}' | '\u{7f}'))
}

fn user_ok(s: &str) -> bool {
    let n = js::len16(s);
    (1..=104).contains(&n) && !s.chars().any(|c| js::is_space(c) || matches!(c, '\\' | '/' | ',' | '%' | ':' | '"' | '\u{0}'..='\u{1f}' | '\u{7f}'))
}

fn domain_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 64 && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// parseShare: //host/share[/folder...] strictly; the UNC as it is stored.
pub fn parse_share(value: Option<&Value>) -> Result<String, Fail> {
    let raw = if js::truthy(value) { js::string(value.unwrap()) } else { String::new() };
    let s = js::trim(&raw).replace('\\', "/");
    let shape = || bad("The SMB share must look like //192.168.1.50/TeslaCam (optionally //server/share/folder).");
    let rest = s.strip_prefix("//").ok_or_else(shape)?;
    let slash = rest.find('/').ok_or_else(shape)?;
    let (host, mut tail) = (&rest[..slash], &rest[slash + 1..]);
    if host.is_empty() {
        return Err(shape());
    }
    // (.+?)\/?$: one trailing slash is dropped
    if tail.len() > 1 && tail.ends_with('/') {
        tail = &tail[..tail.len() - 1];
    }
    if tail.is_empty() {
        return Err(shape());
    }
    if !valid_host(host) {
        return Err(bad("The server in the share must be an IP address or a host name."));
    }
    let segments: Vec<&str> = tail.split('/').collect();
    if segments.iter().any(|seg| !segment_ok(seg) || *seg == "." || *seg == ".." || js::trim(seg) != *seg) {
        return Err(bad("The share or folder name has characters a share cannot use (commas, quotes, \\ or control characters)."));
    }
    Ok(format!("//{host}/{}", segments.join("/")))
}

/// normalizeSmb: the stored SMB source, `prev` keeping a stored password.
pub fn normalize_smb(input: &Value, prev: Option<&Value>) -> Result<Value, Fail> {
    let share = parse_share(input.get("share"))?;
    let username = js::trim(&js::string_or(input.get("username"), "")).to_string();
    if username.is_empty() {
        return Err(bad("Enter the SMB user name. Guest access cannot be encrypted or signed, so it is not allowed."));
    }
    if !user_ok(&username) {
        return Err(bad("The user name may not contain spaces, \\ / , % : or quotes. Put a Windows domain in the Domain field."));
    }
    let password = match js::nn(input.get("password")) {
        None => prev.and_then(|p| p.get("password")).map(|p| if js::truthy(Some(p)) { js::string(p) } else { String::new() }).unwrap_or_default(),
        Some(p) => js::string(p),
    };
    if password.is_empty() {
        return Err(bad("Enter the SMB password."));
    }
    if js::len16(&password) > 256 || password.contains(['\r', '\n', '\0']) {
        return Err(bad("The password may not contain line breaks and must be at most 256 characters."));
    }
    let domain = js::trim(&js::string_or(input.get("domain"), "")).to_string();
    if !domain.is_empty() && !domain_ok(&domain) {
        return Err(bad("The domain may use letters, numbers, . _ and - only."));
    }
    let version_raw = js::nn(input.get("version")).or_else(|| js::nn(prev.and_then(|p| p.get("version")))).map_or_else(|| DEFAULT_VERSION.to_string(), js::string);
    let version = js::trim(&version_raw).to_string();
    if !VERSIONS.iter().any(|(v, _)| *v == version) {
        return Err(bad("Choose SMB 3.1.1, 3.02 or 3.0. Older SMB versions are not secure against a man in the middle."));
    }
    let encrypt = match input.get("encrypt") {
        None => prev.map_or(true, |p| p.get("encrypt") != Some(&Value::Bool(false))),
        Some(e) => *e != Value::Bool(false),
    };
    let port = match input.get("port") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(s)) if s.is_empty() => Value::Null,
        Some(p) => {
            let n = js::number(Some(p));
            if !js::is_integer(n) || !(1.0..=65535.0).contains(&n) {
                return Err(bad("The port must be a number from 1 to 65535."));
            }
            json!(n as i64)
        }
    };
    Ok(json!({ "type": "smb", "share": share, "username": username, "password": password, "domain": domain, "version": version, "encrypt": encrypt, "port": port }))
}

fn version_label(v: &str) -> String {
    VERSIONS.iter().find(|(k, _)| *k == v).map_or_else(|| v.to_string(), |(_, l)| l.to_string())
}

/// securitySummary
pub fn security_summary(encrypt: bool, version: &str) -> String {
    if encrypt {
        format!("{}, encrypted and signed", version_label(version))
    } else {
        format!("{}, signed (not encrypted: someone on the network could see the footage, but not change it)", version_label(version))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shares_and_fields() {
        let ok = |s: &str| parse_share(Some(&json!(s)));
        assert_eq!(ok(" \\\\nas\\TeslaCam\\ ").unwrap(), "//nas/TeslaCam");
        assert_eq!(ok("//192.168.1.5/share/folder/").unwrap(), "//192.168.1.5/share/folder");
        assert!(ok("//nas/").is_err() && ok("nas/x").is_err() && ok("//-nas/x").is_err() && ok("//nas/a,b").is_err() && ok("//nas/a/..").is_err());
        assert!(ok("//nas/a//").is_err());
        let smb = normalize_smb(&json!({ "share": "//nas/cam", "username": "u", "password": "p", "port": "445" }), None).unwrap();
        assert_eq!(smb.to_string(), r#"{"type":"smb","share":"//nas/cam","username":"u","password":"p","domain":"","version":"3.1.1","encrypt":true,"port":445}"#);
        // the stored password and version are kept
        let again = normalize_smb(&json!({ "share": "//nas/cam", "username": "u", "encrypt": null }), Some(&json!({ "password": "old", "version": "3.0", "encrypt": false }))).unwrap();
        assert_eq!((again["password"].as_str(), again["version"].as_str(), again["encrypt"].as_bool()), (Some("old"), Some("3.0"), Some(true)));
        assert_eq!(normalize_smb(&json!({ "share": "//nas/cam", "username": "a b", "password": "p" }), None).unwrap_err().message,
            "The user name may not contain spaces, \\ / , % : or quotes. Put a Windows domain in the Domain field.");
        assert_eq!(normalize_smb(&json!({ "share": "//nas/cam", "username": "u", "password": "p", "version": "2.1" }), None).unwrap_err().status, 400);
        assert!(normalize_smb(&json!({ "share": "//nas/cam", "username": "u", "password": "p", "port": 1.5 }), None).is_err());
        assert_eq!(security_summary(false, "3.0"), "SMB 3.0, signed (not encrypted: someone on the network could see the footage, but not change it)");
    }
}
