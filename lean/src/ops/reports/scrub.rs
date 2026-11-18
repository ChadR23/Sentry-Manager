//! Cleaning a report before it is sealed (server/reportsScrub.js), exactly.
//!
//! strip_secrets: ALWAYS. Values under secret-sounding names become
//! "[removed]", and secrets written inside text are cut out (PEM blocks,
//! user:password@ in URLs, webhook URLs, Bearer/Basic headers, name=value
//! pairs, JWTs, GitHub tokens).
//!
//! anonymize: when "Send anonymously" is on. Every identifier becomes "ANON":
//! the ones the server knows wherever they appear, values under identifying
//! names, and by pattern in every string: IPv4 and IPv6 addresses, MACs,
//! e-mail addresses, Tesla VINs, GPS coordinates, local host names, UNC
//! paths, and the host of any URL that is not a well-known public one.
//!
//! The patterns are the JavaScript ones with JavaScript's ASCII meaning of
//! \d, \w and \b spelled out ([0-9], [A-Za-z0-9_], (?-u:\b)).

use fancy_regex::{Captures, Regex};
use serde_json::{Map, Value};
use std::sync::OnceLock;

pub const ANON: &str = "ANON";
pub const REMOVED: &str = "[removed]";

fn norm(k: &str) -> String {
    k.to_lowercase().chars().filter(|c| !matches!(c, '-' | '_' | ' ' | '.')).collect()
}

/// JavaScript's \b: between an ASCII word character and anything else.
const ASCII_B: &str = r"(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))";

/// A pattern, with (?-u:\b) (written for clarity below) spelled as lookarounds.
fn re(p: &str) -> Regex {
    let p = p.replace(r"(?-u:\b)", ASCII_B);
    Regex::new(&p).unwrap_or_else(|e| panic!("{p}: {e}"))
}

macro_rules! lazy {
    ($name:ident, $pat:expr) => {
        fn $name() -> &'static Regex {
            static R: OnceLock<Regex> = OnceLock::new();
            R.get_or_init(|| re($pat))
        }
    };
}

lazy!(secret_key, r"(password|passwd|passphrase|^pwd$|^pass$|secret|token|apikey|privatekey|cookie|credential|authorization|^auth$|authheader|webhook|linkkey|recovery|totp|^otp|^psk$|sessionid|^session$|^sessions$|signature|^sig$|key$|keys$|^salt$|^setupcode$|pairingcode)");
lazy!(id_key, r"^(hostname|hostnames|host|hosts|ssid|ssids|wifi|address|addresses|ip|ips|ipaddress|mac|macaddress|vin|vins|email|emails|user|username|usernames|users|account|accounts|owner|by|lat|lon|lng|latitude|longitude|coords|coordinates|gps|city|place|places|placename|street|location|gw|gateway|domain|domains|share|sharepath|path|paths|root|roots|folder|installid|install|vehiclename|devicename|nodename|home|homenetwork|peer|remote|remoteaddress|client|clientaddress|from|tlshostnames|acmedomain)$");

/// Whether a field's name says its value is a secret.
pub fn is_secret_key(k: &str) -> bool {
    secret_key().is_match(&norm(k)).unwrap_or(false)
}

/// Whether a field's name says its value identifies someone or something.
pub fn is_id_key(k: &str) -> bool {
    id_key().is_match(&norm(k)).unwrap_or(false)
}

const B: &str = r"(?-u:\b)";

fn secret_text() -> &'static [(Regex, &'static str)] {
    static R: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    R.get_or_init(|| {
        let b = B;
        vec![
            (re(r"-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)"), "[removed]"),
            (re(&format!(r#"(?i){b}https?://(?:[A-Za-z0-9_.-]+\.)?(?:discord(?:app)?\.com|discord\.gg)/api/webhooks/[^\s"'<>]*"#)), "[removed]"),
            (re(&format!(r#"(?i){b}https?://hooks\.slack\.com/[^\s"'<>]*"#)), "[removed]"),
            (re(&format!(r#"(?i){b}https?://[^\s"'<>]*/(?:api/)?webhooks?/[^\s"'<>]*"#)), "[removed]"),
            (re(&format!(r#"(?i)({b}[a-z][a-z0-9+.-]*://)[^\s/@:"']+:[^\s/@"']+@"#)), "${1}[removed]@"),
            (re(&format!(r"{b}(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{{8,}}")), "${1} [removed]"),
            (re(&format!(r"{b}eyJ[A-Za-z0-9_-]{{5,}}\.[A-Za-z0-9_-]{{5,}}\.[A-Za-z0-9_-]*")), "[removed]"),
            (re(&format!(r"{b}(?:gh[pousr]_[A-Za-z0-9]{{20,}}|github_pat_[A-Za-z0-9_]{{20,}}){b}")), "[removed]"),
            (
                re(&format!(r#"(?i){b}([A-Za-z_]*(?:password|passwd|pwd|passphrase|pass|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|link[_-]?key|psk|cookie|session|sid|auth)[A-Za-z_]*)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&)}}\]]+)"#)),
                "${1}${2}[removed]",
            ),
        ]
    })
}

pub fn strip_secret_text(text: &str) -> String {
    let mut t = text.to_string();
    for (r, to) in secret_text() {
        t = r.replace_all(&t, *to).into_owned();
    }
    t
}

/// A copy of value with every secret removed (by field name and inside text).
pub fn strip_secrets(v: &Value) -> Value {
    fn walk(v: &Value, depth: usize) -> Value {
        if depth > 40 {
            return Value::Null;
        }
        match v {
            Value::String(s) => Value::String(strip_secret_text(s)),
            Value::Array(a) => Value::Array(a.iter().map(|x| walk(x, depth + 1)).collect()),
            Value::Object(o) => {
                let mut out = Map::new();
                for (k, x) in o {
                    if is_secret_key(k) {
                        out.insert(k.clone(), if x.is_boolean() || x.is_null() { x.clone() } else { Value::String(REMOVED.into()) });
                    } else {
                        out.insert(k.clone(), walk(x, depth + 1));
                    }
                }
                Value::Object(out)
            }
            other => other.clone(),
        }
    }
    walk(v, 0)
}

lazy!(public_hosts, r"(?i)(^|\.)(github\.com|githubusercontent\.com|ghcr\.io|skittles\.live|cloudflare\.com|letsencrypt\.org|nodejs\.org|npmjs\.org|ffmpeg\.org|tesla\.com|openstreetmap\.org|discord\.com|google\.com|docker\.com|docker\.io|example\.com|example\.org)$");
lazy!(tesla_vin, r"(?i)(?-u:\b)(?:5YJ|7SA|LRW|XP7|7G2|SFZ|5YJ|7FC)[A-HJ-NPR-Z0-9]{14}(?-u:\b)");
lazy!(email, r"(?-u:\b)[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?-u:\b)");
lazy!(mac, r"(?-u:\b)[0-9A-Fa-f]{2}(?:([:-])[0-9A-Fa-f]{2})(?:\1[0-9A-Fa-f]{2}){4}(?-u:\b)");
lazy!(ipv4, r"(?-u:\b)(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])){3}(?-u:\b)");
lazy!(ipv6_candidate, r"(?<![0-9A-Za-z])(?<![0-9A-Fa-f:]:)\[?((?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?:\.[0-9]{1,3}){0,3}(?:%[A-Za-z0-9_.-]+)?)\]?(?![0-9A-Za-z:])");
lazy!(coord_pair, r"-?(?-u:\b)[0-9]{1,3}\.[0-9]{3,}\s*,\s*-?[0-9]{1,3}\.[0-9]{3,}(?-u:\b)");
lazy!(coord_named, r#"(?i)(?-u:\b)(lat|lon|lng|latitude|longitude)(["']?\s*[:=]\s*)-?[0-9]{1,3}(?:\.[0-9]+)?"#);
lazy!(local_host, r"(?i)(?-u:\b)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:local|lan|home|home\.arpa|internal|localdomain|ts\.net|fritz\.box)(?-u:\b)");
lazy!(unc, r#"(?<![A-Za-z0-9+.-]:)(?://|\\\\)[A-Za-z0-9._-]+(?:[/\\][^\s"'<>,;)]*)?"#);
lazy!(url_host, r"(?i)(?-u:\b)([a-z][a-z0-9+.-]*://)(\[[0-9a-f:.]+\]|[A-Za-z0-9.-]+)");

fn escape_re(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if ".*+?^${}()|[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The text-level anonymizer for a set of known identifiers (the longest
/// replaced first, case-insensitively, as whole words or path parts).
pub struct Anonymizer {
    known: Option<Regex>,
}

impl Anonymizer {
    pub fn new(identifiers: &[String]) -> Anonymizer {
        let mut known: Vec<String> = Vec::new();
        for s in identifiers {
            let t = s.trim().to_string();
            if utf16_len(&t) >= 3 && t != ANON && !known.contains(&t) {
                known.push(t);
            }
        }
        known.sort_by_key(|s| std::cmp::Reverse(utf16_len(s)));
        let known = (!known.is_empty()).then(|| re(&format!("(?i)(?<![A-Za-z0-9])(?:{})(?![A-Za-z0-9])", known.iter().map(|k| escape_re(k)).collect::<Vec<_>>().join("|"))));
        Anonymizer { known }
    }

    pub fn text(&self, text: &str) -> String {
        let mut t = text.to_string();
        if let Some(k) = &self.known {
            t = k.replace_all(&t, ANON).into_owned();
        }
        t = url_host()
            .replace_all(&t, |c: &Captures| {
                let host = &c[2];
                if public_hosts().is_match(host).unwrap_or(false) || host == ANON {
                    c[0].to_string()
                } else {
                    format!("{}{ANON}", &c[1])
                }
            })
            .into_owned();
        for r in [unc(), email(), tesla_vin(), mac()] {
            t = r.replace_all(&t, ANON).into_owned();
        }
        t = ipv6_candidate()
            .replace_all(&t, |c: &Captures| {
                let inner = &c[1];
                let bare = inner.split('%').next().unwrap_or(inner);
                if is_ipv6(bare) {
                    ANON.to_string()
                } else {
                    c[0].to_string()
                }
            })
            .into_owned();
        t = ipv4().replace_all(&t, ANON).into_owned();
        t = coord_named().replace_all(&t, "${1}${2}ANON").into_owned();
        t = coord_pair().replace_all(&t, ANON).into_owned();
        t = local_host().replace_all(&t, ANON).into_owned();
        t
    }
}

/// net.isIPv6
fn is_ipv6(s: &str) -> bool {
    s.parse::<std::net::Ipv6Addr>().is_ok()
}

/// A copy of value with every identifier replaced by "ANON" (keys too: ANON-1, ANON-2, ...).
pub fn anonymize(v: &Value, identifiers: &[String]) -> Value {
    let a = Anonymizer::new(identifiers);
    fn walk(a: &Anonymizer, v: &Value, depth: usize) -> Value {
        if depth > 40 {
            return Value::Null;
        }
        match v {
            Value::String(s) => Value::String(a.text(s)),
            Value::Array(x) => Value::Array(x.iter().map(|y| walk(a, y, depth + 1)).collect()),
            Value::Object(o) => {
                let mut out = Map::new();
                let mut n = 0;
                for (k, x) in o {
                    let mut key = a.text(k);
                    if key != *k {
                        n += 1;
                        key = format!("{ANON}-{n}");
                    }
                    if is_id_key(k) && !x.is_null() && !x.is_boolean() {
                        out.insert(key, Value::String(ANON.into()));
                    } else {
                        out.insert(key, walk(a, x, depth + 1));
                    }
                }
                Value::Object(out)
            }
            other => other.clone(),
        }
    }
    walk(&a, v, 0)
}

/// Secrets out always; identifiers too when anonymous.
pub fn clean_report(v: &Value, anonymous: bool, identifiers: &[String]) -> Value {
    let clean = strip_secrets(v);
    if anonymous {
        anonymize(&clean, identifiers)
    } else {
        clean
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    // test/reportsScrub.test.js
    #[test]
    fn secrets_by_field_name_at_any_depth() {
        let out = strip_secrets(&json!({
            "password": "hunter2", "smbPassword": "x", "passwordSet": true, "token": "abc", "tokenHash": "deadbeef", "apiKey": "k", "api_key": "k", "privateKey": "p", "secret": "s",
            "cookie": "c", "webhook": "w", "discordWebhook": "w", "linkKey": "l", "recoveryCodes": ["a"], "totp": { "secret": "x" }, "session": "s", "sessionId": "i", "credentials": { "user": "u" },
            "authorization": "Bearer x", "psk": "wifi", "setupCode": "123", "pairingCode": "AB-12",
            "nested": [{ "deep": { "password": "p2", "ok": "kept" } }],
            "harmless": { "keyframe": 1, "monkeyName": "kept", "name": "kept", "tokens": null }
        }));
        for k in ["password", "smbPassword", "token", "tokenHash", "apiKey", "api_key", "privateKey", "secret", "cookie", "webhook", "discordWebhook", "linkKey", "recoveryCodes", "totp", "session", "sessionId", "credentials", "authorization", "psk", "setupCode", "pairingCode"] {
            assert_eq!(out[k], REMOVED, "{k}");
        }
        assert_eq!(out["passwordSet"], true);
        assert_eq!(out["nested"][0]["deep"]["password"], REMOVED);
        assert_eq!(out["nested"][0]["deep"]["ok"], "kept");
        assert_eq!(out["harmless"]["keyframe"], 1);
        assert_eq!(out["harmless"]["name"], "kept");
        assert_eq!(out["harmless"]["tokens"], Value::Null);
        assert!(is_secret_key("SMB_PASSWORD") && is_secret_key("link-key") && !is_secret_key("keyframe") && !is_secret_key("name"));
    }

    #[test]
    fn secrets_inside_text() {
        let text = [
            "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----",
            "mount //nas/share -o username=bob,password=s3cret!,vers=3.1.1",
            "smb://bob:s3cret@nas.local/TeslaCam",
            "https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz",
            "https://hooks.slack.com/services/T0/B0/xyz",
            "Authorization: Bearer abcdefghijklmnop.qrs",
            "token=abc123 secret: \"x y z\" api_key=K-1 sm_session=zzz; other=1",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "-----BEGIN EC PRIVATE KEY-----\nabcSECRETrest",
        ]
        .join("\n");
        let out = strip_secret_text(&text);
        for s in ["MIIEvQIBADANBg", "s3cret", "abcdefghijklmnopqrstuvwxyz", "services/T0", "abcdefghijklmnop", "abc123", "x y z", "K-1", "zzz", "eyJhbGci", "ghp_", "SECRETrest"] {
            assert!(!out.contains(s), "{s} is gone: {out}");
        }
        assert!(out.contains("vers=3.1.1"));
        assert!(out.contains("other=1"));
        assert!(out.contains("smb://[removed]@nas.local"));
    }

    #[test]
    fn anonymous_identifiers_by_field_name() {
        let out = anonymize(
            &json!({
                "hostname": "tower", "ip": "10.0.0.4", "mac": "aa:bb:cc:dd:ee:ff", "ssid": "Home WiFi", "vin": "5YJ3E1EA7KF123456", "email": "a@b.co", "username": "bob", "accounts": ["bob", "kid"],
                "lat": 30.26, "lon": -97.74, "city": "Austin", "path": "/footage/car", "share": "//nas/TeslaCam", "home": { "ssid": "x", "gw": "10.0.0.1" }, "install": "f".repeat(32),
                "keep": { "paired": true, "cores": 8, "model": "Intel(R) Core(TM) i5", "kernel": "6.18.44-fc" }
            }),
            &[],
        );
        for k in ["hostname", "ip", "mac", "ssid", "vin", "email", "username", "accounts", "lat", "lon", "city", "path", "share", "home", "install"] {
            assert_eq!(out[k], ANON, "{k}");
        }
        assert_eq!(out["keep"], json!({ "paired": true, "cores": 8, "model": "Intel(R) Core(TM) i5", "kernel": "6.18.44-fc" }));
        assert!(is_id_key("host_name") && is_id_key("IPAddress") && !is_id_key("cores"));
    }

    #[test]
    fn anonymous_identifiers_by_pattern() {
        let a = Anonymizer::new(&[]);
        let cases: [(&str, Option<&str>); 10] = [
            ("from 192.168.1.50:445 ok", Some("from ANON:445 ok")),
            ("peer ::ffff:10.1.2.3 and fe80::1%eth0 and 2001:db8::8a2e:370:7334", None),
            ("mac 00:1A:2B:3C:4D:5E / 00-1a-2b-3c-4d-5e", Some("mac ANON / ANON")),
            ("car 5YJ3E1EA7KF123456 and LRW3E7EK1NC123456 and 7SAYGDEE1PA123456", Some("car ANON and ANON and ANON")),
            ("mail bob.smith+x@example.co.uk now", Some("mail ANON now")),
            ("at 30.267153, -97.743057 today", Some("at ANON today")),
            ("{\"lat\":30.2672,\"lon\":-97.7431}", Some("{\"lat\":ANON,\"lon\":ANON}")),
            ("share \\\\nas\\TeslaCam\\RecentClips and //nas2/cam", Some("share ANON and ANON")),
            ("host pi.local and tower.lan and car.tail1234.ts.net", Some("host ANON and ANON and ANON")),
            ("fetch https://my-ddns.example.net/x failed, https://github.com/a ok", Some("fetch https://ANON/x failed, https://github.com/a ok")),
        ];
        let leak = re(r"(?i)[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+|fe80|2001:db8|@example|5YJ|30\.26|nas(?-u:\b)|pi\.local");
        for (input, want) in cases {
            let got = a.text(input);
            if let Some(w) = want {
                assert_eq!(got, w, "{input}");
            }
            assert!(!leak.is_match(&got).unwrap(), "{input} -> {got}");
        }
        for keep in ["2026-11-11T18:20:30.000Z", "at 12:30:00", "node v26.13.0", "ffmpeg version 7.1.1", "kernel 6.18.44-fc-v378", "sha 1345348", "Build 130", "a 1:2 ratio", "Error: x\n    at foo (/app/server/index.js:12:5)"] {
            assert_eq!(a.text(keep), keep);
        }
    }

    #[test]
    fn anonymous_the_servers_own_identifiers_keys_too() {
        let list = ids(&["Daily Driver", "veh-abc123", "tower", "/footage/daily", "bob", "SentryPi", "Home WiFi", "Mom's house"]);
        let out = anonymize(
            &json!({
                "note": "Daily Driver (veh-abc123) on tower: /footage/daily/TeslaCam missing; signed in as bob; SentryPi on Home WiFi near Mom's house",
                "policies": { "veh-abc123": { "keepDays": 30 }, "other": 1 },
                "logs": ["2026-11-11 WARN [share] daily driver share /footage/daily went away"],
                "stack": "Error: ENOENT /footage/daily/x\n    at read (/app/server/x.js:1:1)"
            }),
            &list,
        );
        let all = out.to_string();
        for s in ["Daily Driver", "daily driver", "veh-abc123", "tower", "/footage/daily", "bob", "SentryPi", "Home WiFi", "Mom"] {
            assert!(!all.contains(s), "{s}");
        }
        assert_eq!(out["policies"].as_object().unwrap().keys().collect::<Vec<_>>(), ["ANON-1", "other"]);
        assert_eq!(out["policies"]["ANON-1"]["keepDays"], 30);
        assert!(out["stack"].as_str().unwrap().contains("at read (/app/server/x.js:1:1)"));
        assert_eq!(Anonymizer::new(&ids(&["a", "", "ok"])).text("a car is ok"), "a car is ok");
        assert_eq!(Anonymizer::new(&ids(&["Car"])).text("Scarlet Car car"), "Scarlet ANON ANON");
    }

    #[test]
    fn clean_report_secrets_always_identifiers_when_anonymous() {
        let v = json!({ "hostname": "tower", "password": "x", "log": "login from 10.0.0.9 token=abc" });
        assert_eq!(clean_report(&v, false, &[]), json!({ "hostname": "tower", "password": REMOVED, "log": "login from 10.0.0.9 token=[removed]" }));
        assert_eq!(clean_report(&v, true, &[]), json!({ "hostname": ANON, "password": REMOVED, "log": "login from ANON token=[removed]" }));
    }

    #[test]
    fn secrets_inside_json_text_and_cifs_pass() {
        let t = strip_secret_text("Mount failed: {\"username\":\"bob\",\"password\":\"hunter 2\",\"smbPass\": \"x9\"} -o username=bob,pass=hunter2,vers=3.0");
        assert!(!t.contains("hunter") && !t.contains("x9"), "{t}");
        assert!(t.contains("\"username\":\"bob\""));
        assert!(t.contains("vers=3.0"));
    }

    #[test]
    fn ipv6_after_a_word_and_a_colon() {
        let a = Anonymizer::new(&[]);
        assert_eq!(a.text("ip:2001:db8::1 peer:fe80::1%eth0"), "ip:ANON peer:ANON");
        assert_eq!(a.text("10:00:00 at x.js:10:5 2026-11-11T10:00:00.000Z"), "10:00:00 at x.js:10:5 2026-11-11T10:00:00.000Z");
    }
}
