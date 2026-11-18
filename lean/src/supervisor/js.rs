//! The few JavaScript semantics the mount spec depends on, so the Rust port
//! accepts and refuses exactly what `server/mountSpec.js` does: `String(x)`,
//! `Number(x)`, truthiness, `trim()`, `\s` and lengths in UTF-16 code units.

use serde_json::Value;

/// JavaScript's WhiteSpace and LineTerminator (what `trim()` and `\s` use).
pub fn is_js_ws(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `.` in a JavaScript regex without the s flag does not match these.
pub fn is_js_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_ws)
}

/// `s.length`: UTF-16 code units.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(0, n)` in UTF-16 code units (a split surrogate pair is dropped).
pub fn utf16_slice(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

/// JavaScript truthiness of a JSON value (`undefined` is `None`).
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `Number.prototype.toString()`.
pub fn number_to_string(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if f == 0.0 {
        return "0".into();
    }
    let neg = f < 0.0;
    // shortest round-trip digits and the exponent
    let e = format!("{:e}", f.abs());
    let (mant, exp) = e.split_once('e').unwrap();
    let digits: String = mant.chars().filter(|c| c.is_ascii_digit()).collect();
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().unwrap() + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let sign = if n > 0 { "+" } else { "-" };
        let rest = if k > 1 { format!(".{}", &digits[1..]) } else { String::new() };
        format!("{}{rest}e{sign}{}", &digits[..1], (n - 1).abs())
    };
    if neg {
        format!("-{body}")
    } else {
        body
    }
}

/// `String(x)` (`None` is `undefined`).
pub fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => value_string(v),
    }
}

fn value_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) if (i.unsigned_abs()) < (1u64 << 53) => i.to_string(),
            (_, Some(u)) if u < (1u64 << 53) => u.to_string(),
            _ => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        },
        Value::String(s) => s.clone(),
        // Array.prototype.join: null and undefined become ''
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { value_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `Number(x)` (`None` is `undefined`).
pub fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => string_to_number(s),
        Some(a @ Value::Array(_)) => string_to_number(&value_string(a)),
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// StringToNumber: trimmed; empty is 0; decimal, Infinity, 0x / 0o / 0b.
pub fn string_to_number(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |digits: &str, r: u32| -> f64 {
        if digits.is_empty() {
            return f64::NAN;
        }
        let mut acc = 0f64;
        for c in digits.chars() {
            match c.to_digit(r) {
                Some(d) => acc = acc * f64::from(r) + f64::from(d),
                None => return f64::NAN,
            }
        }
        acc
    };
    let lower2 = t.get(..2).map(str::to_ascii_lowercase);
    match lower2.as_deref() {
        Some("0x") => return radix(&t[2..], 16),
        Some("0o") => return radix(&t[2..], 8),
        Some("0b") => return radix(&t[2..], 2),
        _ => {}
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    // StrUnsignedDecimalLiteral
    let b = body.as_bytes();
    let mut i = 0;
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let f = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - f;
    }
    if int_digits == 0 && frac_digits == 0 {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let e = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == e {
            return f64::NAN;
        }
    }
    if i != b.len() {
        return f64::NAN;
    }
    sign * body.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number.isInteger(f)`.
pub fn is_integer(f: f64) -> bool {
    f.is_finite() && f.trunc() == f
}

/// A JavaScript number as JSON the way `JSON.stringify` writes it.
pub fn number_json(f: f64) -> Value {
    if !f.is_finite() {
        return Value::Null;
    }
    if is_integer(f) && f.abs() < 9.007_199_254_740_992e15 {
        return Value::from(f as i64);
    }
    serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn number_and_string_coercion() {
        for (s, want) in [("445", 445.0), (" 445 ", 445.0), ("0x1bb", 443.0), ("1e3", 1000.0), ("", 0.0), ("+5", 5.0), ("5.", 5.0), (".5", 0.5), ("\u{feff}7", 7.0)] {
            assert_eq!(string_to_number(s), want, "{s:?}");
        }
        for s in ["445,exec", "inf", "nan", "0x", "1e", "--1", "\u{85}7", "1_000", "-0x10"] {
            assert!(string_to_number(s).is_nan(), "{s:?}");
        }
        assert_eq!(string_to_number("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(js_number(Some(&json!(true))), 1.0);
        assert_eq!(js_number(Some(&json!([445]))), 445.0);
        assert!(js_number(Some(&json!({}))).is_nan());
        assert_eq!(js_string(Some(&json!(1.5))), "1.5");
        assert_eq!(js_string(Some(&json!(1.0))), "1");
        assert_eq!(js_string(Some(&json!(1e21))), "1e+21");
        assert_eq!(js_string(Some(&json!(1e-7))), "1e-7");
        assert_eq!(js_string(Some(&json!(0.000001))), "0.000001");
        assert_eq!(js_string(Some(&json!(123456789012.5))), "123456789012.5");
        assert_eq!(js_string(Some(&json!(["a", null, 1]))), "a,,1");
        assert_eq!(js_string(Some(&json!({"a": 1}))), "[object Object]");
        assert_eq!(js_string(None), "undefined");
        assert_eq!(js_trim("\u{feff} a \u{3000}"), "a");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a");
        assert_eq!(utf16_len("a\u{1F600}"), 3);
        assert_eq!(utf16_slice("ab\u{1F600}c", 3), "ab");
    }
}
