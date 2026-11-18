//! Node's ways with paths, numbers, object keys and days, where the files
//! this area writes depend on them.

use chrono::{TimeZone, Utc};
use serde_json::{Map, Value};
use std::cmp::Ordering;

pub use crate::inventory::num;

/// String comparison as JS `<` does it (UTF-16 code units).
pub fn js_cmp(a: &str, b: &str) -> Ordering {
    crate::converter::scanner::js_cmp(a, b)
}

/// Whether a key is an array index, which JS objects list first, ascending.
fn array_index(k: &str) -> Option<u32> {
    if k.is_empty() || k.len() > 10 || !k.bytes().all(|c| c.is_ascii_digit()) || (k.len() > 1 && k.starts_with('0')) {
        return None;
    }
    let n: u64 = k.parse().ok()?;
    (n < u32::MAX as u64).then_some(n as u32)
}

/// A JSON object's entries in the order JS keeps them (Object.entries,
/// JSON.stringify): array-index keys ascending, then the rest as inserted.
pub fn js_ordered(m: Map<String, Value>) -> Map<String, Value> {
    if !m.keys().any(|k| array_index(k).is_some()) {
        return m;
    }
    let mut ints: Vec<(u32, String, Value)> = Vec::new();
    let mut rest: Vec<(String, Value)> = Vec::new();
    for (k, v) in m {
        match array_index(&k) {
            Some(n) => ints.push((n, k, v)),
            None => rest.push((k, v)),
        }
    }
    ints.sort_by_key(|x| x.0);
    let mut out = Map::new();
    for (_, k, v) in ints {
        out.insert(k, v);
    }
    for (k, v) in rest {
        out.insert(k, v);
    }
    out
}

/// `vid.replace(/[^A-Za-z0-9_-]/g, '_')` (per UTF-16 unit, as JS does it).
pub fn file_base(vid: &str) -> String {
    let mut out = String::new();
    for c in vid.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                out.push('_');
            }
        }
    }
    out
}

fn cwd() -> String {
    std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| "/".into())
}

/// path.normalize for posix paths (no trailing slash kept).
fn normalize(p: &str) -> String {
    let abs = p.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for s in p.split('/') {
        match s {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|l| *l != "..") {
                    parts.pop();
                } else if !abs {
                    parts.push("..");
                }
            }
            _ => parts.push(s),
        }
    }
    let body = parts.join("/");
    if abs {
        format!("/{body}")
    } else if body.is_empty() {
        ".".into()
    } else {
        body
    }
}

/// path.resolve(p)
pub fn resolve(p: &str) -> String {
    if p.starts_with('/') {
        normalize(p)
    } else {
        normalize(&format!("{}/{}", cwd(), p))
    }
}

/// path.join(a, ...parts)
pub fn join(a: &str, parts: &[&str]) -> String {
    let mut s = a.to_string();
    for p in parts {
        if p.is_empty() {
            continue;
        }
        if !s.is_empty() {
            s.push('/');
        }
        s.push_str(p);
    }
    if s.is_empty() {
        return ".".into();
    }
    normalize(&s)
}

/// path.relative(from, to)
pub fn relative(from: &str, to: &str) -> String {
    let f = resolve(from);
    let t = resolve(to);
    if f == t {
        return String::new();
    }
    let fp: Vec<&str> = f.split('/').filter(|s| !s.is_empty()).collect();
    let tp: Vec<&str> = t.split('/').filter(|s| !s.is_empty()).collect();
    let mut i = 0;
    while i < fp.len() && i < tp.len() && fp[i] == tp[i] {
        i += 1;
    }
    let mut out: Vec<&str> = vec![".."; fp.len() - i];
    out.extend_from_slice(&tp[i..]);
    out.join("/")
}

/// path.posix.basename
pub fn basename(p: &str) -> &str {
    let t = p.trim_end_matches('/');
    t.rsplit('/').next().unwrap_or("")
}

/// Date.UTC(y, mo - 1, d, h, mi, s) in ms, years 0..99 as 1900 + y (as Date.UTC does).
fn date_utc(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64) -> f64 {
    let y = if (0..=99).contains(&y) { 1900 + y } else { y };
    crate::viewer::js::utc_seconds(y, mo, d, h, mi, s) * 1000.0
}

/// clipMs: a Tesla clip name's time (its wall clock read as UTC), or None.
/// /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-[a-z0-9_]+\.mp4$/i
pub fn clip_ms(name: &str) -> Option<f64> {
    let b = name.as_bytes();
    if b.len() < 25 {
        return None;
    }
    let d = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    let shape = d(0..4) && b[4] == b'-' && d(5..7) && b[7] == b'-' && d(8..10) && b[10] == b'_' && d(11..13) && b[13] == b'-' && d(14..16) && b[16] == b'-' && d(17..19) && b[19] == b'-';
    if !shape || !b[b.len() - 4..].eq_ignore_ascii_case(b".mp4") {
        return None;
    }
    let cam = &b[20..b.len() - 4];
    if cam.is_empty() || !cam.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_') {
        return None;
    }
    let n = |r: std::ops::Range<usize>| std::str::from_utf8(&b[r]).unwrap().parse::<i64>().unwrap();
    Some(date_utc(n(0..4), n(5..7), n(8..10), n(11..13), n(14..16), n(17..19)))
}

/// /^(recentclips|sentryclips|savedclips|teslatrackmode)$/i
pub fn is_group(s: &str) -> bool {
    ["recentclips", "sentryclips", "savedclips", "teslatrackmode"].iter().any(|g| s.eq_ignore_ascii_case(g))
}

/// new Date(ms).toISOString().slice(0, 10)
pub fn utc_day(ms: f64) -> String {
    let t = Utc.timestamp_millis_opt(ms.floor() as i64).single().unwrap_or_default();
    t.format("%Y-%m-%d").to_string()
}

/// Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(ms): None for a zone it does not know.
pub fn day_in_zone(ms: f64, tz: &str) -> Option<String> {
    let zone: chrono_tz::Tz = tz.parse().ok().or_else(|| chrono_tz::Tz::from_str_insensitive(tz).ok())?;
    let t = zone.timestamp_millis_opt(ms.floor() as i64).single()?;
    Some(t.format("%Y-%m-%d").to_string())
}

/// Date.now()
pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// Node's st.mtimeMs etc. from a file's metadata.
pub fn stat_ms(sec: i64, nsec: i64) -> f64 {
    crate::scanner::ms_of(sec, nsec)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn paths_as_node() {
        assert_eq!(resolve("/a/b/../c/./d/"), "/a/c/d");
        assert_eq!(relative("/a/b", "/a/b/c/d"), "c/d");
        assert_eq!(relative("/a/b", "/a/x"), "../x");
        assert_eq!(relative("/a/b", "/a/b"), "");
        assert_eq!(join("/a", &["b", "c"]), "/a/b/c");
        assert_eq!(basename("RecentClips/x/y.mp4"), "y.mp4");
    }

    #[test]
    fn clip_names() {
        assert_eq!(clip_ms("2026-11-08_12-59-00-front.mp4"), Some(1_794_142_740_000.0));
        assert_eq!(clip_ms("2026-11-08_12-59-00-left_repeater.MP4"), Some(1_794_142_740_000.0));
        assert_eq!(clip_ms("2026-11-08_12-59-00-.mp4"), None);
        assert_eq!(clip_ms("2026-11-08_12-59-00-a.b.mp4"), None);
        assert_eq!(clip_ms("2026-11-08_12-59-00-front.mp4.mismatch-1"), None);
        // node -e "console.log(Date.UTC(2026, 1, 30, 0, 0, 0))" (Feb 30 is Mar 2)
        assert_eq!(clip_ms("2026-02-30_00-00-00-front.mp4"), Some(1_772_409_600_000.0));
    }

    #[test]
    fn keys_and_names() {
        let mut m = Map::new();
        m.insert("b".into(), json!(1));
        m.insert("10".into(), json!(2));
        m.insert("2".into(), json!(3));
        m.insert("01".into(), json!(4));
        assert_eq!(Value::Object(js_ordered(m)).to_string(), r#"{"2":3,"10":2,"b":1,"01":4}"#);
        assert_eq!(file_base("car 1/ü😀"), "car_1____");
        assert_eq!(num(1762646400123.4567).to_string(), "1762646400123.4568");
        assert_eq!(num(5.0).to_string(), "5");
        assert_eq!(day_in_zone(1_762_646_400_000.0, "america/los_angeles").as_deref(), Some("2025-11-08"));
        assert_eq!(day_in_zone(1_762_646_400_000.0, "UTC").as_deref(), Some("2025-11-09"));
        assert_eq!(day_in_zone(0.0, "Not/AZone"), None);
    }
}
