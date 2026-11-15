//! JavaScript's conversions where the Node code leans on them: String(x),
//! Number(x), trim(), slice() in UTF-16 units, `??`.

use serde_json::Value;

/// `a ?? b`: a value that is neither missing nor null.
pub fn nn(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| !v.is_null())
}

/// A number as String(n) writes it.
pub fn num_string(x: f64) -> String {
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

/// String(value)
pub fn string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => num_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// String(value ?? fallback) for an optional field.
pub fn string_or(v: Option<&Value>, fallback: &str) -> String {
    nn(v).map_or_else(|| fallback.to_string(), string)
}

pub fn is_space(c: char) -> bool {
    matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// s.slice(0, n) in UTF-16 units (a character cut in half is left out).
pub fn slice16(s: &str, n: usize) -> String {
    let mut units = 0;
    s.chars().take_while(|c| {
        units += c.len_utf16();
        units <= n
    }).collect()
}

pub fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Number(string)
pub fn number_str(s: &str) -> f64 {
    let t = trim(s);
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
    if !t.bytes().all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-')) || t.ends_with(['e', 'E']) {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// Number(value): undefined is NaN, null 0.
pub fn number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => *b as u8 as f64,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => number_str(s),
        Some(Value::Array(a)) => match a.len() {
            0 => 0.0,
            1 => number(Some(&Value::String(string(&a[0])))),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// Number.isInteger
pub fn is_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0
}

/// Boolean(value)
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        _ => true,
    }
}

/// A number as JSON.stringify writes it (integers without ".0").
pub fn num(x: f64) -> Value {
    if !x.is_finite() {
        Value::Null
    } else if x.fract() == 0.0 && x.abs() < 9.007_199_254_740_992e15 {
        Value::from(x as i64)
    } else {
        Value::from(x)
    }
}

/// Date.now() as JavaScript has it.
pub fn now() -> f64 {
    super::scanner::now_ms()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn conversions() {
        assert_eq!(number(Some(&json!(" 12 "))), 12.0);
        assert!(number(Some(&json!("1e"))).is_nan());
        assert_eq!(number(Some(&json!(null))), 0.0);
        assert_eq!(number(Some(&json!(["7"]))), 7.0);
        assert_eq!(string(&json!(3.5)), "3.5");
        assert_eq!(string(&json!([1, null, "a"])), "1,,a");
        assert_eq!(slice16("aé😀b", 3), "aé");
    }
}
