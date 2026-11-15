//! JavaScript's conversions where the ui routes rely on them: Number(),
//! String(), truthiness, Math.round, toFixed, localeCompare (approximately).

use serde_json::Value;
use std::cmp::Ordering;

/// Number(v): NaN as f64::NAN.
pub fn number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => string_number(s),
        Some(Value::Array(a)) => match a.len() {
            0 => 0.0,
            1 => number(Some(&Value::String(string(&a[0])))),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// Number(string)
pub fn string_number(s: &str) -> f64 {
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

/// String(v) for the values JSON has.
pub fn string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_string(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// A number as JavaScript prints it (integers without ".0").
pub fn number_string(x: f64) -> String {
    if x.is_nan() {
        "NaN".into()
    } else if x.is_infinite() {
        if x > 0.0 { "Infinity".into() } else { "-Infinity".into() }
    } else if x.fract() == 0.0 && x.abs() < 1e21 {
        format!("{}", x as i128)
    } else {
        let s = format!("{x}");
        s
    }
}

pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// Math.round
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// Number#toFixed(digits) (exact ties go up in magnitude, as JavaScript does).
pub fn to_fixed(x: f64, digits: usize) -> String {
    if !x.is_finite() || x.abs() >= 1e21 {
        return number_string(x);
    }
    // the exact decimal expansion, then rounding by hand
    let exact = format!("{:.1100}", x.abs());
    let (int, frac) = exact.split_once('.').unwrap();
    let mut digits_v: Vec<u8> = int.bytes().chain(frac.bytes().take(digits)).map(|c| c - b'0').collect();
    let rest = &frac[digits.min(frac.len())..];
    let up = rest.as_bytes().first().is_some_and(|&c| c >= b'5');
    if up {
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
    let s: String = digits_v.iter().map(|d| (d + b'0') as char).collect();
    let (a, b) = s.split_at(s.len() - digits);
    let neg = x < 0.0 && s.bytes().any(|c| c != b'0');
    let body = if digits == 0 { a.to_string() } else { format!("{a}.{b}") };
    // (-0.0001).toFixed(2) is "-0.00" in JavaScript
    if x < 0.0 && (neg || x != 0.0) { format!("-{body}") } else { body }
}

/// Number.isFinite on a JSON value: a number that is finite.
pub fn finite(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|x| x.is_finite())
}

/// Number.isSafeInteger on a JSON value.
pub fn safe_integer(v: Option<&Value>) -> Option<i64> {
    let x = v?.as_f64()?;
    (x.fract() == 0.0 && x.abs() <= 9_007_199_254_740_991.0).then_some(x as i64)
}

/// A number as JSON writes it the way JavaScript does (1, not 1.0).
pub fn num(x: f64) -> Value {
    crate::inventory::num(x)
}

/// String#localeCompare, roughly as ICU's root collation orders plain names:
/// letters without regard to case first, then lower case before upper case.
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let la = a.to_lowercase();
    let lb = b.to_lowercase();
    match la.cmp(&lb) {
        Ordering::Equal => b.cmp(a),
        o => o,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn conversions() {
        assert_eq!(to_fixed(12.5, 3), "12.500");
        assert_eq!(to_fixed(0.0625, 3), "0.063");
        assert_eq!(to_fixed(17.5, 3), "17.500");
        assert_eq!(to_fixed(1.0005, 3), "1.000");
        assert_eq!(to_fixed(-1.5, 0), "-2");
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(2.5), 3.0);
        assert!(number(Some(&json!("x"))).is_nan());
        assert_eq!(number(Some(&json!(null))), 0.0);
        assert_eq!(number(Some(&json!(" 12 "))), 12.0);
        assert!(number(None).is_nan());
        assert_eq!(string(&json!(7)), "7");
        assert_eq!(string(&json!(0.5)), "0.5");
    }
}
