//! A speed-index entry kept as numbers: [size, mtimeMs, speeds | null, summary | null].
//! Only entries whose every number writes back as read are kept as numbers; the rest stay as read.

use super::js::{num, r2};
use super::speed_index::{stats_of, Stats, BRAKE, SWERVE};
use serde_json::{Map, Value};
use std::borrow::Cow;

pub enum Entry {
    Clip { size: f64, mtime: f64, speeds: Option<Box<[f64]>>, sum: Sum },
    Raw(Value),
}

pub enum Sum {
    Null,
    Typed(Box<Summary>),
    Raw(Value),
}

pub struct Summary {
    b: Option<[f64; 2]>,
    t: Option<[f64; 2]>,
    v: Option<[f64; 2]>,
    g: Box<[[f64; 3]]>,
    k: f64,
}

const SUMMARY_KEYS: [&str; 5] = ["b", "t", "v", "g", "k"];

/// a number that num() writes back exactly as it was read
fn exact(v: &Value) -> Option<f64> {
    let x = v.as_f64()?;
    (num(x) == *v).then_some(x)
}

fn nums<const N: usize>(v: &Value) -> Option<[f64; N]> {
    let a = v.as_array().filter(|a| a.len() == N)?;
    let mut out = [0.0; N];
    for (o, x) in out.iter_mut().zip(a) {
        *o = exact(x)?;
    }
    Some(out)
}

fn pair(v: &Value) -> Option<Option<[f64; 2]>> {
    if v.is_null() {
        Some(None)
    } else {
        nums::<2>(v).map(Some)
    }
}

fn pair_value(p: &Option<[f64; 2]>) -> Value {
    p.map_or(Value::Null, |[s, x]| Value::Array(vec![num(s), num(x)]))
}

impl Summary {
    fn parse(v: &Value) -> Option<Summary> {
        let o = v.as_object().filter(|o| o.keys().map(String::as_str).eq(SUMMARY_KEYS))?;
        let g = o["g"].as_array()?.iter().map(nums::<3>).collect::<Option<Vec<_>>>()?;
        Some(Summary { b: pair(&o["b"])?, t: pair(&o["t"])?, v: pair(&o["v"])?, g: g.into(), k: exact(&o["k"])? })
    }

    fn value(&self) -> Value {
        let g = self.g.iter().map(|[s, a, o]| Value::Array(vec![num(*s), num(*a), num(*o)])).collect();
        let mut m = Map::new();
        m.insert("b".into(), pair_value(&self.b));
        m.insert("t".into(), pair_value(&self.t));
        m.insert("v".into(), pair_value(&self.v));
        m.insert("g".into(), Value::Array(g));
        m.insert("k".into(), num(self.k));
        Value::Object(m)
    }
}

impl Sum {
    fn from_value(v: Value) -> Sum {
        if v.is_null() {
            return Sum::Null;
        }
        match Summary::parse(&v) {
            Some(s) => Sum::Typed(Box::new(s)),
            None => Sum::Raw(v),
        }
    }

    pub fn value(&self) -> Value {
        match self {
            Sum::Null => Value::Null,
            Sum::Typed(s) => s.value(),
            Sum::Raw(v) => v.clone(),
        }
    }
}

fn speeds_of(v: &Value) -> Option<Option<Box<[f64]>>> {
    if v.is_null() {
        return Some(None);
    }
    let a = v.as_array()?;
    a.iter().map(|x| if x.is_null() { Some(f64::NAN) } else { exact(x) }).collect::<Option<Vec<_>>>().map(|s| Some(s.into()))
}

fn speeds_value(s: &Option<Box<[f64]>>) -> Value {
    s.as_ref().map_or(Value::Null, |s| Value::Array(s.iter().map(|x| if x.is_nan() { Value::Null } else { num(*x) }).collect()))
}

impl Entry {
    pub fn from_value(v: Value) -> Entry {
        let head = v.as_array().filter(|a| a.len() == 4).and_then(|a| Some((exact(&a[0])?, exact(&a[1])?, speeds_of(&a[2])?)));
        let Some((size, mtime, speeds)) = head else { return Entry::Raw(v) };
        let sum = match v {
            Value::Array(mut a) => Sum::from_value(a.pop().unwrap_or(Value::Null)),
            _ => Sum::Null,
        };
        Entry::Clip { size, mtime, speeds, sum }
    }

    pub fn value(&self) -> Value {
        match self {
            Entry::Clip { size, mtime, speeds, sum } => Value::Array(vec![num(*size), num(*mtime), speeds_value(speeds), sum.value()]),
            Entry::Raw(v) => v.clone(),
        }
    }

    /// entry[i] as a number (size, mtime)
    pub fn num(&self, i: usize) -> Option<f64> {
        match self {
            Entry::Clip { size, mtime, .. } => [Some(*size), Some(*mtime)].get(i).copied().flatten(),
            Entry::Raw(v) => v.get(i).and_then(Value::as_f64),
        }
    }

    /// read in full: speeds and summary (or their nulls) are there
    pub fn complete(&self) -> bool {
        match self {
            Entry::Clip { .. } => true,
            Entry::Raw(v) => v.as_array().is_some_and(|a| a.len() >= 4),
        }
    }

    pub fn speeds(&self) -> Value {
        match self {
            Entry::Clip { speeds, .. } => speeds_value(speeds),
            Entry::Raw(v) => v.get(2).cloned().unwrap_or(Value::Null),
        }
    }

    pub fn summary(&self) -> Value {
        match self {
            Entry::Clip { sum, .. } => sum.value(),
            Entry::Raw(v) => v.get(3).cloned().unwrap_or(Value::Null),
        }
    }

    pub fn summary_is_null(&self) -> bool {
        match self {
            Entry::Clip { sum, .. } => matches!(sum, Sum::Null),
            Entry::Raw(v) => v.get(3).is_none_or(Value::is_null),
        }
    }

    pub fn summary_is_object(&self) -> bool {
        match self {
            Entry::Clip { sum: Sum::Typed(_), .. } => true,
            Entry::Clip { sum: Sum::Raw(v), .. } => v.is_object(),
            Entry::Clip { sum: Sum::Null, .. } => false,
            Entry::Raw(v) => v.get(3).is_some_and(Value::is_object),
        }
    }

    pub fn summary_truthy(&self) -> bool {
        match self {
            Entry::Clip { sum: Sum::Typed(_), .. } => true,
            Entry::Clip { sum: Sum::Null, .. } => false,
            Entry::Clip { sum: Sum::Raw(s), .. } => truthy(s),
            Entry::Raw(v) => v.get(3).is_some_and(truthy),
        }
    }

    pub fn summary_version(&self) -> Option<f64> {
        match self {
            Entry::Clip { sum: Sum::Typed(s), .. } => Some(s.k),
            Entry::Clip { sum: Sum::Raw(v), .. } => v.get("k").and_then(Value::as_f64),
            Entry::Clip { sum: Sum::Null, .. } => None,
            Entry::Raw(v) => v.get(3).and_then(|s| s.get("k")).and_then(Value::as_f64),
        }
    }

    /// summary.k = 2 (kept as it was: no slowing second)
    pub fn mark_version_2(&mut self) {
        match self {
            Entry::Clip { sum: Sum::Typed(s), .. } => s.k = 2.0,
            Entry::Clip { sum, .. } => {
                let mut v = sum.value();
                v["k"] = Value::from(2);
                *sum = Sum::from_value(v);
            }
            Entry::Raw(v) => v[3]["k"] = Value::from(2),
        }
    }

    /// any second slower than the one before by 0.29 or more
    pub fn can_brake(&self) -> bool {
        match self {
            Entry::Clip { speeds: Some(s), .. } => s.windows(2).any(|w| !w[0].is_nan() && !w[1].is_nan() && (w[0] - w[1]).abs() >= 0.29),
            Entry::Clip { speeds: None, .. } => false,
            Entry::Raw(v) => super::speed_index::can_brake(&v[2]),
        }
    }

    /// the summary's positions: (second, lat, lon)
    pub fn positions(&self) -> Cow<'_, [[f64; 3]]> {
        match self {
            Entry::Clip { sum: Sum::Typed(s), .. } => Cow::Borrowed(&s.g),
            Entry::Clip { sum: Sum::Null, .. } => Cow::Borrowed(&[]),
            Entry::Clip { sum: Sum::Raw(s), .. } => Cow::Owned(positions_of(s)),
            Entry::Raw(v) => Cow::Owned(v.get(3).map(positions_of).unwrap_or_default()),
        }
    }

    /// stats_of(speeds, summary), read where they are kept
    pub fn stats(&self) -> Option<Stats> {
        let (sp, sum) = match self {
            Entry::Clip { speeds: None, .. } => return None,
            Entry::Clip { speeds: Some(sp), sum, .. } => (sp, sum),
            Entry::Raw(v) => return stats_of(v.get(2).unwrap_or(&Value::Null), v.get(3).unwrap_or(&Value::Null)),
        };
        let (mut n, mut d, mut m, mut v, mut f, mut l) = (0u32, 0f64, 0u32, 0f64, -1i64, -1i64);
        for (i, &x) in sp.iter().enumerate() {
            if x.is_nan() {
                continue;
            }
            n += 1;
            d += x;
            if x > 0.5 {
                m += 1;
                if f < 0 {
                    f = i as i64;
                }
                l = i as i64;
            }
            if x > v {
                v = x;
            }
        }
        if n == 0 {
            return None;
        }
        let over = |p: Option<[f64; 2]>, line: f64| p.is_some_and(|[_, x]| x >= line) as u32;
        let (a, z, b, t) = match sum {
            Sum::Null => (None, None, 0, 0),
            Sum::Typed(s) => (s.g.first().map(|p| (p[1], p[2])), s.g.last().map(|p| (p[1], p[2])), over(s.b, BRAKE), over(s.t, SWERVE)),
            Sum::Raw(s) => {
                use super::js::number;
                let g = s.get("g").and_then(Value::as_array);
                let pos = |p: &Value| (number(p.get(1)), number(p.get(2)));
                let over = |k: &str, line: f64| s.get(k).and_then(Value::as_array).and_then(|p| p.get(1)).and_then(Value::as_f64).is_some_and(|x| x >= line) as u32;
                (g.and_then(|g| g.first()).map(pos), g.and_then(|g| g.last()).map(pos), over("b", BRAKE), over("t", SWERVE))
            }
        };
        Some(Stats { n, d: r2(d), m, v: r2(v), f, l, a, z, b, t })
    }
}

fn positions_of(sum: &Value) -> Vec<[f64; 3]> {
    use super::js::number;
    sum.get("g").and_then(Value::as_array).map_or_else(Vec::new, |g| g.iter().map(|p| [number(p.get(0)), number(p.get(1)), number(p.get(2))]).collect())
}

/// not null, false, the integer 0 or ""
fn truthy(s: &Value) -> bool {
    match s {
        Value::Null | Value::Bool(false) => false,
        Value::Number(n) => n.as_u64() != Some(0),
        Value::String(x) => !x.is_empty(),
        _ => true,
    }
}

pub type Entries = indexmap::IndexMap<String, Entry>;

pub fn parse_day(text: &str) -> Option<Entries> {
    match serde_json::from_str::<Value>(text).ok()? {
        Value::Object(o) => Some(o.into_iter().map(|(k, v)| (k, Entry::from_value(v))).collect()),
        _ => None,
    }
}

pub fn day_value(data: &Entries) -> Value {
    Value::Object(data.iter().map(|(k, e)| (k.clone(), e.value())).collect::<Map<String, Value>>())
}

#[cfg(test)]
#[path = "speed_entry_tests.rs"]
mod tests;
