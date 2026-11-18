//! JavaScript's ways with numbers, times and text, where the answers depend on them.

pub use crate::inventory::num;
pub use crate::sei::js_round;
use chrono::{Datelike, NaiveDate, TimeZone, Utc};
use serde_json::Value;

pub fn r1(x: f64) -> f64 {
    js_round(x * 10.0) / 10.0
}
pub fn r2(x: f64) -> f64 {
    js_round(x * 100.0) / 100.0
}
pub fn r5(x: f64) -> f64 {
    js_round(x * 1e5) / 1e5
}
pub fn r6(x: f64) -> f64 {
    js_round(x * 1e6) / 1e6
}

/// JavaScript's Number(value) for a JSON value; NaN for what it cannot read.
pub fn number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => *b as u8 as f64,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => number_str(s),
        Some(Value::Array(a)) => match a.len() {
            0 => 0.0,
            1 => number(Some(&a[0])),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// Number(string)
pub fn number_str(s: &str) -> f64 {
    let t = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    for (p, r) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
        if let Some(d) = t.strip_prefix(p) {
            return u64::from_str_radix(d, r).map_or(f64::NAN, |n| n as f64);
        }
    }
    if !t.bytes().all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-')) || t.contains("inf") {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// Number(query value) where the query may not have it (undefined: NaN).
pub fn query_number(q: Option<&String>) -> f64 {
    q.map_or(f64::NAN, |s| number_str(s))
}

/// `Number(x) || d`
pub fn or(x: f64, d: f64) -> f64 {
    if x.is_nan() || x == 0.0 { d } else { x }
}

/// new Date(ms).toISOString()
pub fn iso(ms: f64) -> String {
    let t = Utc.timestamp_millis_opt(ms.floor() as i64).single().unwrap_or_default();
    t.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub fn now_ms() -> f64 {
    crate::scanner::now_ms()
}

/// Date.UTC(y, m - 1, d, h, mi, s) / 1000, with JavaScript's overflow (Feb 30 is Mar 2).
pub fn utc_seconds(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64) -> f64 {
    let y2 = y + (mo - 1).div_euclid(12);
    let m2 = (mo - 1).rem_euclid(12) + 1;
    let base = NaiveDate::from_ymd_opt(y2 as i32, m2 as u32, 1).map(|d| d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp()).unwrap_or(0);
    (base + (d - 1) * 86400 + h * 3600 + mi * 60 + s) as f64
}

/// Seconds of a YYYY-MM-DD_HH-MM-SS found in text (as if UTC), with the stamp; None without one.
pub fn stamp_in(text: &str) -> Option<(String, f64)> {
    let i = stamp_at(text)?;
    let stamp = &text[i..i + 19];
    Some((stamp.to_string(), stamp_seconds(stamp)))
}

/// where the first YYYY-MM-DD_HH-MM-SS in text starts
pub fn stamp_at(text: &str) -> Option<usize> {
    let b = text.as_bytes();
    (0..(b.len() + 1).saturating_sub(19)).find(|&i| {
        let w = &b[i..i + 19];
        let dig = |r: std::ops::Range<usize>| w[r].iter().all(u8::is_ascii_digit);
        dig(0..4) && w[4] == b'-' && dig(5..7) && w[7] == b'-' && dig(8..10) && w[10] == b'_' && dig(11..13) && w[13] == b'-' && dig(14..16) && w[16] == b'-' && dig(17..19)
    })
}

/// the seconds of a stamp_at stamp (as if UTC)
pub fn stamp_seconds(stamp: &str) -> f64 {
    let n = |r: std::ops::Range<usize>| stamp[r].parse::<i64>().unwrap();
    utc_seconds(n(0..4), n(5..7), n(8..10), n(11..13), n(14..16), n(17..19))
}

/// "YYYY-MM-DD HH:MM:SS" of wall seconds (as if UTC)
pub fn wall(s: f64) -> String {
    let t = Utc.timestamp_millis_opt((s * 1000.0).floor() as i64).single().unwrap_or_default();
    t.format("%Y-%m-%d %H:%M:%S").to_string()
}

/// The day (YYYY-MM-DD) of now in a time zone (policies.js dayInZone: Intl's zones).
pub fn day_in_zone(now_ms: f64, tz: &str) -> String {
    crate::footage::tz::day_in_zone(now_ms, tz)
}

/// The Monday (YYYY-MM-DD) of a day's week.
pub fn monday(day: &str) -> String {
    let Ok(d) = NaiveDate::parse_from_str(day, "%Y-%m-%d") else { return day.to_string() };
    let back = d.weekday().num_days_from_monday() as i64;
    (d - chrono::Duration::days(back)).format("%Y-%m-%d").to_string()
}

pub fn add_days(day: &str, n: i64) -> String {
    let Ok(d) = NaiveDate::parse_from_str(day, "%Y-%m-%d") else { return day.to_string() };
    (d + chrono::Duration::days(n)).format("%Y-%m-%d").to_string()
}

/// String's localeCompare (ICU's root collation) as far as footage paths need it:
/// white space, then punctuation in CLDR's order, then digits, then letters
/// without regard to case; ties broken lower case first, then by code units.
pub fn locale_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    const PUNCT: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    fn primary(c: char) -> (u8, u32) {
        if c.is_whitespace() {
            (0, c as u32)
        } else if let Some(i) = PUNCT.find(c) {
            (1, i as u32)
        } else if c.is_ascii_digit() {
            (2, c as u32)
        } else if c.is_alphabetic() {
            (3, c.to_lowercase().next().unwrap_or(c) as u32)
        } else {
            (4, c as u32)
        }
    }
    let pa: Vec<(u8, u32)> = a.chars().map(primary).collect();
    let pb: Vec<(u8, u32)> = b.chars().map(primary).collect();
    pa.cmp(&pb)
        .then_with(|| {
            let ta: Vec<bool> = a.chars().map(|c| c.is_uppercase()).collect();
            let tb: Vec<bool> = b.chars().map(|c| c.is_uppercase()).collect();
            ta.cmp(&tb)
        })
        .then_with(|| a.cmp(b))
}

/// text.slice(0, n) in UTF-16 units
pub fn slice_units(s: &str, n: usize) -> String {
    let mut units = 0;
    s.chars().take_while(|c| {
        units += c.len_utf16();
        units <= n
    }).collect()
}

/// JSON.stringify of a value as Node writes it (serde_json, with integers without ".0").
pub fn stringify(v: &Value) -> String {
    v.to_string()
}

/// encodeURIComponent
pub fn encode_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// JSON number of a sha1 hex digest
pub fn sha1_hex(s: &[u8]) -> String {
    let mut h = sha1_smol::Sha1::new();
    h.update(s);
    h.digest().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dates_and_numbers() {
        assert_eq!(utc_seconds(2024, 2, 30, 0, 0, 0), utc_seconds(2024, 3, 1, 0, 0, 0));
        assert_eq!(wall(utc_seconds(2024, 5, 1, 8, 0, 0)), "2024-05-01 08:00:00");
        assert_eq!(monday("2024-05-05"), "2024-04-29");
        assert_eq!(monday("2024-04-29"), "2024-04-29");
        assert_eq!(number_str(" 12 "), 12.0);
        assert!(number_str("12a").is_nan());
        assert_eq!(number_str(""), 0.0);
        assert_eq!(iso(0.0), "1970-01-01T00:00:00.000Z");
        assert_eq!(stamp_in("a/2024-05-01_08-00-00-front.mp4").unwrap().0, "2024-05-01_08-00-00");
        assert_eq!(encode_component("a b/c"), "a%20b%2Fc");
    }
}
