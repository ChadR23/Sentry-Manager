//! Small JavaScript behaviours the Node code relies on: numbers as JSON
//! prints them, Number(x), toFixed, toISOString, truthiness.

use serde_json::{json, Value};

/// A number as JSON.stringify writes it: whole numbers without ".0".
pub fn num(x: f64) -> Value {
    if !x.is_finite() {
        return Value::Null;
    }
    if x.fract() == 0.0 && x.abs() < 9.007_199_254_740_992e15 {
        json!(x as i64)
    } else {
        json!(x)
    }
}

/// A number or null.
pub fn num_or_null(x: Option<f64>) -> Value {
    x.map_or(Value::Null, num)
}

/// JavaScript's Number(value) for a JSON value (NaN for what is not a number).
pub fn number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => number_str(s),
        Value::Array(a) => match a.len() {
            0 => 0.0,
            1 => number(&Value::String(to_string(&a[0]))),
            _ => f64::NAN,
        },
        Value::Object(_) => f64::NAN,
    }
}

/// Number(undefined) is NaN, Number(null) is 0: a missing field is NaN.
pub fn number_opt(v: Option<&Value>) -> f64 {
    v.map_or(f64::NAN, number)
}

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
            return u64::from_str_radix(d, r).map(|n| n as f64).unwrap_or(f64::NAN);
        }
    }
    if !t.bytes().all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-')) || t.contains("inf") {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// String(value) for the values JSON has.
pub fn to_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.as_f64().map(num_text).unwrap_or_default(),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { to_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// A number as String(n) writes it.
pub fn num_text(x: f64) -> String {
    match num(x) {
        Value::Null if x.is_nan() => "NaN".into(),
        Value::Null => if x > 0.0 { "Infinity".into() } else { "-Infinity".into() },
        v => v.to_string(),
    }
}

/// JavaScript truthiness.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// Number.prototype.toFixed: the exact binary value rounded, a tie away from zero (V8).
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() {
        return num_text(x);
    }
    if x.abs() >= 1e21 {
        return num_text(x);
    }
    let neg = x < 0.0;
    // the exact decimal expansion (a double below 1e21 has at most 1074 fraction digits;
    // 1100 is enough for any of them)
    let exact = format!("{:.1100}", x.abs());
    let (int, frac) = exact.split_once('.').unwrap();
    let mut digits_v: Vec<u8> = int.bytes().chain(frac.bytes().take(digits)).map(|b| b - b'0').collect();
    let rest = &frac.as_bytes()[digits..];
    if rest.first().is_some_and(|d| *d >= b'5') {
        let mut i = digits_v.len();
        loop {
            if i == 0 {
                digits_v.insert(0, 1);
                break;
            }
            i -= 1;
            if digits_v[i] == 9 {
                digits_v[i] = 0;
            } else {
                digits_v[i] += 1;
                break;
            }
        }
    }
    let text: String = digits_v.iter().map(|d| (d + b'0') as char).collect();
    let split = text.len() - digits;
    let mut out = text[..split].to_string();
    if digits > 0 {
        out.push('.');
        out.push_str(&text[split..]);
    }
    if neg {
        out.insert(0, '-');
    }
    out
}

/// new Date(ms).toISOString()
pub fn iso(ms: i64) -> String {
    match chrono::DateTime::from_timestamp_millis(ms) {
        Some(t) => t.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        None => String::new(),
    }
}

/// Date.parse for the ISO forms the server writes (and plain dates); None when not a date.
pub fn parse_date(s: &str) -> Option<i64> {
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(t.timestamp_millis());
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Some(d.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis());
    }
    for f in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"] {
        if let Ok(t) = chrono::NaiveDateTime::parse_from_str(s, f) {
            use chrono::TimeZone;
            return chrono::Local.from_local_datetime(&t).earliest().map(|x| x.timestamp_millis());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_as_javascript() {
        assert_eq!(num(3.0).to_string(), "3");
        assert_eq!(num(0.15).to_string(), "0.15");
        assert!(number_str("abc").is_nan());
        assert_eq!(number_str(" 12 "), 12.0);
        assert_eq!(number_str(""), 0.0);
        assert_eq!(number(&json!(null)), 0.0);
        assert!(number_opt(None).is_nan());
        assert_eq!(to_fixed(4.0, 1), "4.0");
        assert_eq!(to_fixed(1.25, 1), "1.3");
        assert_eq!(to_fixed(1.005, 2), "1.00");
        assert_eq!(to_fixed(9.96, 1), "10.0");
        assert_eq!(to_fixed(-0.04, 1), "-0.0");
        assert_eq!(to_fixed(0.0, 0), "0");
    }
}
