//! JSON as JavaScript writes it (JSON.stringify): numbers in Number#toString
//! form (5, not 5.0; 1e+21; 1e-7), NaN and Infinity as null, and an object's
//! keys that are array indexes ("0", "17") first in ascending order, then the
//! others in the order they were added, as a JS object keeps them. Every
//! answer and every file the CAN area writes goes through here, so the bytes
//! are the Node server's.

use serde_json::{Map, Value};

/// A number as JavaScript's String(n).
pub fn num_str(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if x == 0.0 {
        return "0".into();
    }
    let neg = x < 0.0;
    // shortest round-trip digits: "d.ddddde±x"
    let e = format!("{:e}", x.abs());
    let (mant, exp) = e.split_once('e').unwrap();
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i64;
    let n = exp.parse::<i64>().unwrap() + 1; // value = 0.digits × 10^n
    let mut out = String::new();
    if neg {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        for _ in 0..(n - k) {
            out.push('0');
        }
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        let ex = n - 1;
        out.push(if ex >= 0 { '+' } else { '-' });
        out.push_str(&ex.abs().to_string());
    }
    out
}

/// A JSON number Value from an f64 (integers as integers, so equality and output stay JS-like).
pub fn n(x: f64) -> Value {
    if x.is_finite() && x.fract() == 0.0 && x.abs() < 9.007_199_254_740_992e15 {
        if x == 0.0 {
            return Value::from(0);
        }
        return Value::from(x as i64);
    }
    serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
}

/// Whether a key is an array index as JS orders them (0 .. 2^32-2, no leading zeros).
fn index_key(k: &str) -> Option<u64> {
    if k.is_empty() || k.len() > 10 || !k.bytes().all(|c| c.is_ascii_digit()) || (k.len() > 1 && k.starts_with('0')) {
        return None;
    }
    let v: u64 = k.parse().ok()?;
    (v < 4_294_967_295).then_some(v)
}

fn quote(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// The keys of an object in the order JS keeps them.
pub fn ordered_keys(m: &Map<String, Value>) -> Vec<&String> {
    let mut idx: Vec<(u64, &String)> = Vec::new();
    let mut rest = Vec::new();
    for k in m.keys() {
        match index_key(k) {
            Some(v) => idx.push((v, k)),
            None => rest.push(k),
        }
    }
    if idx.is_empty() {
        return rest;
    }
    idx.sort_by_key(|x| x.0);
    idx.into_iter().map(|x| x.1).chain(rest).collect()
}

fn number(v: &serde_json::Number, out: &mut String) {
    if let Some(i) = v.as_i64() {
        out.push_str(&i.to_string());
    } else if let Some(u) = v.as_u64() {
        out.push_str(&num_str(u as f64));
    } else {
        let f = v.as_f64().unwrap_or(f64::NAN);
        if f.is_finite() {
            out.push_str(&num_str(f));
        } else {
            out.push_str("null");
        }
    }
}

fn write(v: &Value, out: &mut String, indent: Option<&str>, depth: usize) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(x) => number(x, out),
        Value::String(s) => quote(s, out),
        Value::Array(a) => {
            if a.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                write(x, out, indent, depth + 1);
            }
            newline(out, indent, depth);
            out.push(']');
        }
        Value::Object(m) => {
            if m.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, k) in ordered_keys(m).into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                quote(k, out);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write(&m[k], out, indent, depth + 1);
            }
            newline(out, indent, depth);
            out.push('}');
        }
    }
}

fn newline(out: &mut String, indent: Option<&str>, depth: usize) {
    if let Some(ind) = indent {
        out.push('\n');
        for _ in 0..depth {
            out.push_str(ind);
        }
    }
}

/// JSON.stringify(v).
pub fn stringify(v: &Value) -> String {
    let mut out = String::new();
    write(v, &mut out, None, 0);
    out
}

/// JSON.stringify(v, null, 2).
pub fn pretty(v: &Value) -> String {
    let mut out = String::new();
    write(v, &mut out, Some("  "), 0);
    out
}

/// JSON.parse (null when it is not JSON).
pub fn parse(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}

/// A number of a Value as JS would read it in arithmetic (only numbers; else None).
pub fn f(v: &Value) -> Option<f64> {
    v.as_f64()
}

/// Number.isFinite(v) for a Value.
pub fn finite(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite())
}

/// Number.isSafeInteger(v).
pub fn safe_int(v: &Value) -> Option<i64> {
    let x = v.as_f64()?;
    (x.fract() == 0.0 && x.abs() <= 9_007_199_254_740_991.0).then_some(x as i64)
}

/// JS truthiness of a Value.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(x)) => x.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// Math.round as JS does it (a half goes toward +Infinity).
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let r = x.floor();
    if x - r >= 0.5 { r + 1.0 } else { r }
}

/// Number(x.toFixed(d)): the nearest d-digit decimal, an exact tie away from zero (as JS picks).
pub fn to_fixed(x: f64, d: usize) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let a = x.abs();
    let long = format!("{:.*}", d + 40, a);
    let dot = long.find('.').unwrap_or(long.len());
    let tail = &long[dot + 1 + d..];
    let tie = tail.starts_with('5') && tail[1..].bytes().all(|c| c == b'0');
    let mut v: f64 = format!("{:.*}", d, a).parse().unwrap_or(a);
    if tie {
        let scale = 10f64.powi(d as i32);
        let up: f64 = format!("{:.*}", d, ((a * scale).floor() + 1.0) / scale).parse().unwrap_or(v);
        if up > v {
            v = up;
        }
    }
    if x < 0.0 { -v } else { v }
}

/// String(v) for a value that may be missing (undefined).
pub fn js_str(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => crate::can::logs::js_string(v),
    }
}

/// Number(text) as JS reads a string.
pub fn str_number(t: &str) -> f64 {
    let t = t.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if t.is_empty() {
        return 0.0;
    }
    let (neg, body) = match t.as_bytes()[0] {
        b'-' => (true, &t[1..]),
        b'+' => (false, &t[1..]),
        _ => (false, t),
    };
    if body == "Infinity" {
        return if neg { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    if t.len() > 2 && (t.starts_with("0x") || t.starts_with("0X") || t.starts_with("0o") || t.starts_with("0O") || t.starts_with("0b") || t.starts_with("0B")) {
        let radix = match &t[1..2] { "x" | "X" => 16, "o" | "O" => 8, _ => 2 };
        return u128::from_str_radix(&t[2..], radix).map(|v| v as f64).unwrap_or(f64::NAN);
    }
    if !body.bytes().all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-')) || !body.bytes().next().is_some_and(|c| c.is_ascii_digit() || c == b'.') {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// Number(v) for a JSON value that may be missing.
pub fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => if *b { 1.0 } else { 0.0 },
        Some(Value::Number(x)) => x.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => str_number(s),
        Some(Value::Array(a)) => match a.len() { 0 => 0.0, 1 => js_number(Some(&a[0])), _ => f64::NAN },
        Some(Value::Object(_)) => f64::NAN,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_as_js() {
        assert_eq!(num_str(5.0), "5");
        assert_eq!(num_str(-0.0), "0");
        assert_eq!(num_str(0.1), "0.1");
        assert_eq!(num_str(1e21), "1e+21");
        assert_eq!(num_str(1e20), "100000000000000000000");
        assert_eq!(num_str(1e-7), "1e-7");
        assert_eq!(num_str(0.000001), "0.000001");
        assert_eq!(num_str(123.456), "123.456");
        assert_eq!(num_str(1.5e-10), "1.5e-10");
        assert_eq!(num_str(-2.75), "-2.75");
        assert_eq!(num_str(1794099498000.437), "1794099498000.437");
    }

    #[test]
    fn keys_as_js() {
        let v: Value = serde_json::from_str(r#"{"b":1,"10":2,"2":3,"-1":4,"01":5}"#).unwrap();
        assert_eq!(stringify(&v), r#"{"2":3,"10":2,"b":1,"-1":4,"01":5}"#);
        assert_eq!(stringify(&json!([1.0, 2.5, null])), "[1,2.5,null]");
        assert_eq!(pretty(&json!({"a": [1], "b": {}})), "{\n  \"a\": [\n    1\n  ],\n  \"b\": {}\n}");
    }

    #[test]
    fn rounding_as_js() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(-2.6), -3.0);
        assert_eq!(to_fixed(1.005, 2), 1.0); // 1.005 is below the tie in binary
        assert_eq!(to_fixed(0.125, 2), 0.13);
        assert_eq!(to_fixed(2.345678, 3), 2.346);
    }
}
