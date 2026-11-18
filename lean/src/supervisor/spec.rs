//! A port of `server/mountSpec.js`: the one place that turns a vehicle's SMB
//! settings into a mount.cifs call. Everything is rebuilt from validated
//! fields; nothing the user typed reaches the -o string as free text, so no
//! setting can add options like exec, suid, sec=none, vers=1.0 or
//! credentials=/etc/shadow.
//!
//! Security of every mount (as in Node):
//!   - SMB 3 only (3.1.1, or 3.0/3.02 for older servers).
//!   - Encrypted (seal) by default; with encryption off, signing is required.
//!   - An account is required: a guest session has no keys to sign or encrypt.
//!   - nosuid,nodev,noexec.
//!   - The password goes in a 0600 credentials file, never on a command line.
//!
//! Inputs are JSON values with JavaScript's coercions (see `js.rs`), so what is
//! accepted and refused is the same as Node's, byte for byte.

use super::js::{is_integer, is_js_line_terminator, is_js_ws, js_number, js_string, js_trim, truthy, utf16_len};
use serde_json::{json, Value};
use std::fmt;

/// (version, label), in the order of `VERSIONS` in mountSpec.js.
pub const VERSIONS: [(&str, &str); 4] = [
    ("3.1.1", "SMB 3.1.1 (recommended)"),
    ("3.02", "SMB 3.02"),
    ("3.0", "SMB 3.0"),
    ("3", "SMB 3.0 or newer (best the server offers)"),
];
pub const DEFAULT_VERSION: &str = "3.1.1";

pub fn version_label(v: &str) -> Option<&'static str> {
    VERSIONS.iter().find(|(k, _)| *k == v).map(|(_, l)| *l)
}

/// `{ status: 400, code: 'INVALID_SMB' }` in Node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SmbError(pub String);

impl SmbError {
    pub const CODE: &'static str = "INVALID_SMB";
    pub const STATUS: u16 = 400;
    pub fn message(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for SmbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SmbError {}

fn bad(m: &str) -> SmbError {
    SmbError(m.to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedShare {
    pub host: String,
    pub share: String,
    pub folder: Vec<String>,
    pub unc: String,
}

/// A normalized SMB source (`normalizeSmb`'s result).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Smb {
    pub share: String,
    pub username: String,
    pub password: String,
    pub domain: String,
    pub version: String,
    pub encrypt: bool,
    pub port: Option<u16>,
}

impl Smb {
    /// The object Node returns: `{ type, share, username, password, domain, version, encrypt, port }`.
    pub fn to_value(&self) -> Value {
        json!({
            "type": "smb", "share": self.share, "username": self.username, "password": self.password,
            "domain": self.domain, "version": self.version, "encrypt": self.encrypt, "port": self.port
        })
    }
}

fn label_ok(l: &str) -> bool {
    let b = l.as_bytes();
    !b.is_empty()
        && b.len() <= 63
        && b[0].is_ascii_alphanumeric()
        && b[b.len() - 1].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
}

/// HOST_RE: host name labels, a dotted quad (digits are labels too) or [v6].
fn host_ok(h: &str) -> bool {
    if let Some(inner) = h.strip_prefix('[').and_then(|x| x.strip_suffix(']')) {
        return !inner.is_empty() && inner.bytes().all(|c| c.is_ascii_hexdigit() || c == b':' || c == b'.');
    }
    h.split('.').all(label_ok)
}

/// SEGMENT_RE: `^[^\\/,"\x00-\x1f\x7f]{1,80}$`
fn segment_ok(s: &str) -> bool {
    let n = utf16_len(s);
    (1..=80).contains(&n) && !s.chars().any(|c| matches!(c, '\\' | '/' | ',' | '"' | '\u{0}'..='\u{1f}' | '\u{7f}'))
}

/// USER_RE: `^[^\s\\/,%:"\x00-\x1f\x7f]{1,104}$`
fn user_ok(s: &str) -> bool {
    let n = utf16_len(s);
    (1..=104).contains(&n)
        && !s.chars().any(|c| is_js_ws(c) || matches!(c, '\\' | '/' | ',' | '%' | ':' | '"' | '\u{0}'..='\u{1f}' | '\u{7f}'))
}

/// DOMAIN_RE: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`
fn domain_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 64 && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

fn has_crlf_nul(s: &str) -> bool {
    s.contains(['\r', '\n', '\0'])
}

/// Parse //host/share[/folder...] strictly (`parseShare`). `None` is `undefined`.
pub fn parse_share(value: Option<&Value>) -> Result<ParsedShare, SmbError> {
    let raw = if truthy(value) { js_string(value) } else { String::new() };
    let s = js_trim(&raw).replace('\\', "/");
    // /^\/\/([^/]+)\/(.+?)\/?$/
    let shape = || bad("The SMB share must look like //192.168.1.50/TeslaCam (optionally //server/share/folder).");
    let after = s.strip_prefix("//").ok_or_else(shape)?;
    let slash = after.find('/').ok_or_else(shape)?;
    if slash == 0 {
        return Err(shape());
    }
    let host = &after[..slash];
    let full = &after[slash + 1..];
    if full.is_empty() || full.chars().any(is_js_line_terminator) {
        return Err(shape());
    }
    let rest = if full.len() > 1 && full.ends_with('/') { &full[..full.len() - 1] } else { full };
    if !host_ok(host) {
        return Err(bad("The server in the share must be an IP address or a host name."));
    }
    let segments: Vec<&str> = rest.split('/').collect();
    if segments.iter().any(|seg| !segment_ok(seg) || *seg == "." || *seg == ".." || js_trim(seg) != *seg) {
        return Err(bad("The share or folder name has characters a share cannot use (commas, quotes, \\ or control characters)."));
    }
    Ok(ParsedShare {
        host: host.to_string(),
        share: segments[0].to_string(),
        folder: segments[1..].iter().map(|s| s.to_string()).collect(),
        unc: format!("//{host}/{}", segments.join("/")),
    })
}

fn get<'a>(v: &'a Value, k: &str) -> Option<&'a Value> {
    v.as_object().and_then(|o| o.get(k))
}

fn nullish(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

/// Validate and normalize the SMB part of a vehicle (`normalizeSmb`). `prev` keeps a stored password.
pub fn normalize_smb(input: &Value, prev: Option<&Value>) -> Result<Smb, SmbError> {
    let prev = prev.filter(|p| truthy(Some(p)));
    let parsed = parse_share(get(input, "share"))?;
    let u = get(input, "username");
    let username = js_trim(&if nullish(u) { String::new() } else { js_string(u) }).to_string();
    if username.is_empty() {
        return Err(bad("Enter the SMB user name. Guest access cannot be encrypted or signed, so it is not allowed."));
    }
    if !user_ok(&username) {
        return Err(bad("The user name may not contain spaces, \\ / , % : or quotes. Put a Windows domain in the Domain field."));
    }
    let p = get(input, "password");
    let password = if nullish(p) {
        let pp = prev.and_then(|x| get(x, "password"));
        if truthy(pp) {
            js_string(pp)
        } else {
            String::new()
        }
    } else {
        js_string(p)
    };
    if password.is_empty() {
        return Err(bad("Enter the SMB password."));
    }
    if utf16_len(&password) > 256 || has_crlf_nul(&password) {
        return Err(bad("The password may not contain line breaks and must be at most 256 characters."));
    }
    let d = get(input, "domain");
    let domain = js_trim(&if nullish(d) { String::new() } else { js_string(d) }).to_string();
    if !domain.is_empty() && !domain_ok(&domain) {
        return Err(bad("The domain may use letters, numbers, . _ and - only."));
    }
    let v = get(input, "version");
    let pv = prev.and_then(|x| get(x, "version"));
    let version_raw = if !nullish(v) {
        js_string(v)
    } else if !nullish(pv) {
        js_string(pv)
    } else {
        DEFAULT_VERSION.to_string()
    };
    let version = js_trim(&version_raw).to_string();
    if version_label(&version).is_none() {
        return Err(bad("Choose SMB 3.1.1, 3.02 or 3.0. Older SMB versions are not secure against a man in the middle."));
    }
    let is_false = |x: Option<&Value>| matches!(x, Some(Value::Bool(false)));
    let encrypt = match get(input, "encrypt") {
        None => match prev {
            Some(p) => !is_false(get(p, "encrypt")),
            None => true,
        },
        e => !is_false(e),
    };
    let mut port = None;
    let pin = get(input, "port");
    if !nullish(pin) && pin != Some(&Value::String(String::new())) {
        let n = js_number(pin);
        if !is_integer(n) || !(1.0..=65535.0).contains(&n) {
            return Err(bad("The port must be a number from 1 to 65535."));
        }
        port = Some(n as u16);
    }
    Ok(Smb { share: parsed.unc, username, password, domain, version, encrypt, port })
}

/// The credentials file's text (`credentialsText`), from a normalized source or any object.
pub fn credentials_text(smb: &Value) -> Result<String, SmbError> {
    let field = |k: &str| {
        let v = get(smb, k);
        if truthy(v) {
            js_string(v)
        } else {
            String::new()
        }
    };
    let (username, password, domain) = (field("username"), field("password"), field("domain"));
    for v in [&username, &password, &domain] {
        if has_crlf_nul(v) {
            return Err(bad("Line breaks are not allowed in SMB credentials."));
        }
    }
    // the template literal uses String() of the raw value, '' only for undefined/null-free fields
    let raw = |k: &str| js_string(get(smb, k));
    let mut text = format!("username={}\npassword={}\n", raw("username"), raw("password"));
    if !domain.is_empty() {
        text += &format!("domain={}\n", raw("domain"));
    }
    Ok(text)
}

/// `mountArgs`: arguments for `mount` (mount.cifs) for a validated SMB source.
/// uid/gid own every file on the mount (the unprivileged app user).
pub fn mount_args(smb_input: &Value, target: &str, cred_file: &str, uid: i64, gid: i64) -> Result<(Smb, Vec<String>), SmbError> {
    let smb = normalize_smb(smb_input, Some(smb_input))?;
    if uid < 0 || gid < 0 {
        return Err(bad("Invalid uid/gid for the mount."));
    }
    let bad_path = |p: &str| !p.starts_with('/') || p.chars().any(|c| c == ',' || c == '\0' || is_js_ws(c));
    if bad_path(target) {
        return Err(bad("Invalid mount point."));
    }
    if bad_path(cred_file) {
        return Err(bad("Invalid credentials file."));
    }
    let mut opts = vec![
        format!("credentials={cred_file}"),
        format!("vers={}", smb.version),
        "sec=ntlmssp".to_string(),
        if smb.encrypt { "seal" } else { "sign" }.to_string(),
        "nosuid".into(),
        "nodev".into(),
        "noexec".into(),
        format!("uid={uid}"),
        format!("gid={gid}"),
        "forceuid".into(),
        "forcegid".into(),
        "file_mode=0660".into(),
        "dir_mode=0770".into(),
        // serverino (the default) keeps inode numbers stable, which the
        // converter's identity checks rely on
        "serverino".into(),
    ];
    if let Some(p) = smb.port {
        opts.push(format!("port={p}"));
    }
    let args = vec!["-t".into(), "cifs".into(), smb.share.clone(), target.to_string(), "-o".into(), opts.join(",")];
    Ok((smb, args))
}

/// Short description of how a vehicle's share is protected, for the UI (`securitySummary`).
pub fn security_summary(smb: &Smb) -> String {
    let label = version_label(&smb.version).map(str::to_string).unwrap_or_else(|| smb.version.clone());
    if smb.encrypt {
        format!("{label}, encrypted and signed")
    } else {
        format!("{label}, signed (not encrypted: someone on the network could see the footage, but not change it)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn merge(base: &Value, change: &Value) -> Value {
        let mut m = base.as_object().unwrap().clone();
        for (k, v) in change.as_object().unwrap() {
            m.insert(k.clone(), v.clone());
        }
        Value::Object(m)
    }

    // test/security.test.js: 'SMB settings can never add mount options or weaken security'
    #[test]
    fn smb_settings_can_never_add_mount_options_or_weaken_security() {
        let ok = json!({ "share": "//192.168.1.50/TeslaCam", "username": "tesla", "password": "p,a=s s%x", "domain": "HOME" });
        let smb = normalize_smb(&ok, None).unwrap();
        assert_eq!((smb.version.as_str(), smb.encrypt, smb.port), ("3.1.1", true, None));
        let (_, args) = mount_args(&smb.to_value(), "/footage/car", "/run/sentry-six-manager/car.cred", 1000, 1000).unwrap();
        assert_eq!(&args[..4], ["-t", "cifs", "//192.168.1.50/TeslaCam", "/footage/car"]);
        let opts: Vec<&str> = args[5].split(',').collect();
        for o in ["vers=3.1.1", "sec=ntlmssp", "seal", "nosuid", "nodev", "noexec", "forceuid", "forcegid", "serverino"] {
            assert!(opts.contains(&o), "{o}");
        }
        assert!(!args.join(" ").contains("p,a=s s%x"), "the password is never on the command line");
        let (_, signed) = mount_args(&merge(&ok, &json!({ "encrypt": false })), "/footage/car", "/run/x.cred", 1, 1).unwrap();
        let signed: Vec<&str> = signed[5].split(',').collect();
        assert!(signed.contains(&"sign") && !signed.contains(&"seal"), "without encryption, signing is required");

        let bad = [
            json!({ "share": "//1.2.3.4/s,exec" }), json!({ "share": "//1.2.3.4/s/../etc" }), json!({ "share": "//h/s\nx" }),
            json!({ "share": "-o exec" }), json!({ "share": "//h;rm/s" }), json!({ "username": "" }), json!({ "username": "u,vers=1.0" }),
            json!({ "username": "u%pass" }), json!({ "username": "DOMAIN\\user" }), json!({ "password": "" }),
            json!({ "password": "a\nusername=root" }), json!({ "domain": "x,sec=none" }), json!({ "version": "1.0" }),
            json!({ "version": "2.1" }), json!({ "version": "default" }), json!({ "version": "3.0,sec=none" }),
            json!({ "port": "445,exec" }), json!({ "port": 70000 }),
        ];
        for change in &bad {
            assert!(normalize_smb(&merge(&ok, change), None).is_err(), "{change}");
        }
        // fields beyond the known ones are ignored, never passed through
        let extra = normalize_smb(&merge(&ok, &json!({ "options": "exec,suid,credentials=/etc/shadow", "guest": true })), None).unwrap();
        let v = extra.to_value();
        assert!(v.get("options").is_none() && v.get("guest").is_none());
        assert_eq!(parse_share(Some(&json!("\\\\nas\\TeslaCam\\car"))).unwrap().unc, "//nas/TeslaCam/car");
        assert!(mount_args(&smb.to_value(), "/footage/car,exec", "/x", 1, 1).is_err());
    }

    #[test]
    fn exact_options_string_and_error_texts() {
        let ok = json!({ "share": "//nas.local/Tesla Cam/sub/", "username": "tesla", "password": "pw", "version": " 3.02 ", "encrypt": null, "port": " 0x1bb " });
        let (smb, args) = mount_args(&ok, "/footage/car", "/run/sentry-six-manager/car.cred", 1000, 1001).unwrap();
        assert_eq!(smb.share, "//nas.local/Tesla Cam/sub");
        assert_eq!(smb.port, Some(443));
        assert!(smb.encrypt, "null is not false");
        assert_eq!(
            args,
            [
                "-t", "cifs", "//nas.local/Tesla Cam/sub", "/footage/car", "-o",
                "credentials=/run/sentry-six-manager/car.cred,vers=3.02,sec=ntlmssp,seal,nosuid,nodev,noexec,uid=1000,gid=1001,forceuid,forcegid,file_mode=0660,dir_mode=0770,serverino,port=443"
            ]
        );
        let err = |v: Value| normalize_smb(&v, None).unwrap_err().0;
        assert_eq!(err(json!({})), "The SMB share must look like //192.168.1.50/TeslaCam (optionally //server/share/folder).");
        assert_eq!(err(json!({ "share": "//h_x/s" })), "The server in the share must be an IP address or a host name.");
        assert_eq!(err(json!({ "share": "//h/s//" })), "The share or folder name has characters a share cannot use (commas, quotes, \\ or control characters).");
        assert_eq!(err(json!({ "share": "//h/ s" })), "The share or folder name has characters a share cannot use (commas, quotes, \\ or control characters).");
        assert_eq!(err(json!({ "share": "//h/s" })), "Enter the SMB user name. Guest access cannot be encrypted or signed, so it is not allowed.");
        assert_eq!(err(json!({ "share": "//h/s", "username": "a b" })), "The user name may not contain spaces, \\ / , % : or quotes. Put a Windows domain in the Domain field.");
        assert_eq!(err(json!({ "share": "//h/s", "username": "u" })), "Enter the SMB password.");
        assert_eq!(err(json!({ "share": "//h/s", "username": "u", "password": "x".repeat(257) })), "The password may not contain line breaks and must be at most 256 characters.");
        assert_eq!(err(json!({ "share": "//h/s", "username": "u", "password": "p", "domain": "-x" })), "The domain may use letters, numbers, . _ and - only.");
        assert_eq!(err(json!({ "share": "//h/s", "username": "u", "password": "p", "port": 1.5 })), "The port must be a number from 1 to 65535.");
        // a stored password and version are kept; a number is a password too
        let prev = json!({ "password": "saved", "version": "3.0", "encrypt": false });
        let s = normalize_smb(&json!({ "share": "//[fe80::1]/s", "username": "u" }), Some(&prev)).unwrap();
        assert_eq!((s.password.as_str(), s.version.as_str(), s.encrypt), ("saved", "3.0", false));
        assert_eq!(normalize_smb(&json!({ "share": "//h/s", "username": "u", "password": 1234 }), None).unwrap().password, "1234");
        // `port: ''` means none; `//h/s/` and `//h//` (shapes of the Node regex)
        assert_eq!(normalize_smb(&json!({ "share": "//h/s/", "username": "u", "password": "p", "port": "" }), None).unwrap().port, None);
        assert!(parse_share(Some(&json!("//h//"))).is_err());
        assert!(parse_share(Some(&json!("//h/"))).is_err());
        assert_eq!(parse_share(Some(&json!("  //10.0.0.1/a/b/c  "))).unwrap().folder, ["b", "c"]);
        assert_eq!(credentials_text(&json!({ "username": "u", "password": "p", "domain": "D" })).unwrap(), "username=u\npassword=p\ndomain=D\n");
        assert_eq!(credentials_text(&json!({ "username": "u", "password": "p", "domain": "" })).unwrap(), "username=u\npassword=p\n");
        assert!(credentials_text(&json!({ "username": "u\n", "password": "p" })).is_err());
        assert_eq!(security_summary(&s), "SMB 3.0, signed (not encrypted: someone on the network could see the footage, but not change it)");
    }
}
