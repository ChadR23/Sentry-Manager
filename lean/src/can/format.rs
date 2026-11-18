//! How the CAN index's minute files are kept on disk (server/canFormat.js):
//! gzipped JSON, each series as two columns (time steps, values) since enc
//! "c1", a file without "enc" in the older point-list layout. The top of a
//! minute file (minute, enc, act, trust, logs) comes before its signals, so
//! read_head() unpacks only what it needs.

use super::json::{self, n};
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use indexmap::IndexMap;
use serde_json::{Map, Value};
use std::io::{Read, Write};
use std::path::Path;

pub const ENC: &str = "c1";
const MOVING_KPH: f64 = 3.0;
const MAX_KPH: f64 = 285.0;

pub type Pts = Vec<(f64, f64)>;
pub type Signals = IndexMap<String, Pts>;
pub type RawPts = Vec<(f64, String)>;
pub type Raw = IndexMap<String, RawPts>;

/// A signals minute: { minute, trust, act, logs, signals, ids } (signals as point lists).
#[derive(Debug, Clone, Default)]
pub struct Minute {
    pub minute: Option<Value>,
    pub trust: Option<String>,
    pub act: Option<String>,
    pub logs: Option<Map<String, Value>>,
    pub signals: Signals,
    pub ids: Option<IndexMap<String, f64>>,
}

#[derive(Debug, Clone, Default)]
pub struct RawMinute {
    pub minute: Option<Value>,
    pub raw: Raw,
    pub logs: Option<Map<String, Value>>,
    pub rest: Map<String, Value>,
}

/// What a CAN minute shows: 'drive', 'sentry' or 'none'.
pub fn classify(sig: &Signals) -> &'static str {
    let get = |k: &str| sig.get(k).map(|p| p.iter().map(|x| x.1).collect::<Vec<_>>()).unwrap_or_default();
    let speed = get("DI_vehicleSpeed");
    let gear = get("DI_gear");
    let moving = speed.iter().any(|&x| x > MOVING_KPH && x <= MAX_KPH);
    let in_dr = gear.iter().any(|&x| x == 4.0 || x == 2.0);
    let parked = !gear.is_empty() && gear.iter().all(|&x| x == 1.0);
    if in_dr || (moving && !parked) {
        return "drive";
    }
    if get("UI_autopilotPowerStateRequest").contains(&1.0) || get("UIsentryMode284").contains(&1.0) {
        return "sentry";
    }
    "none"
}

pub fn act_letter(kind: &str) -> &'static str {
    match kind {
        "drive" => "d",
        "sentry" => "s",
        _ => "n",
    }
}

fn columns_of<V: Clone>(pts: &[(f64, V)], val: impl Fn(&V) -> Value) -> Value {
    let mut dt = Vec::with_capacity(pts.len());
    let mut vs = Vec::with_capacity(pts.len());
    let mut prev = 0f64;
    for (t, v) in pts {
        let t = json::round(*t);
        dt.push(n(t - prev));
        prev = t;
        vs.push(val(v));
    }
    Value::Array(vec![Value::Array(dt), Value::Array(vs)])
}

pub fn signals_to_columns(s: &Signals) -> Value {
    let mut out = Map::new();
    for (k, pts) in s {
        out.insert(k.clone(), columns_of(pts, |v| n(*v)));
    }
    Value::Object(out)
}

pub fn raw_to_columns(s: &Raw) -> Value {
    let mut out = Map::new();
    for (k, pts) in s {
        out.insert(k.clone(), columns_of(pts, |v| Value::String(v.clone())));
    }
    Value::Object(out)
}

fn from_columns<V>(v: Option<&Value>, val: impl Fn(&Value) -> Option<V>) -> IndexMap<String, Vec<(f64, V)>> {
    let mut out = IndexMap::new();
    let Some(Value::Object(m)) = v else { return out };
    for k in json::ordered_keys(m) {
        let Some(Value::Array(c)) = m.get(k) else { continue };
        let (Some(Value::Array(dt)), Some(Value::Array(vs))) = (c.first(), c.get(1)) else { continue };
        let len = dt.len().min(vs.len());
        let mut pts = Vec::with_capacity(len);
        let mut t = 0f64;
        for i in 0..len {
            t += dt[i].as_f64().unwrap_or(f64::NAN);
            if let Some(x) = val(&vs[i]) {
                pts.push((t, x));
            }
        }
        out.insert(k.clone(), pts);
    }
    out
}

fn from_points<V>(v: Option<&Value>, val: impl Fn(&Value) -> Option<V>) -> IndexMap<String, Vec<(f64, V)>> {
    let mut out = IndexMap::new();
    let Some(Value::Object(m)) = v else { return out };
    for k in json::ordered_keys(m) {
        let Some(Value::Array(list)) = m.get(k) else { continue };
        let mut pts = Vec::with_capacity(list.len());
        for p in list {
            if let Some(Value::Array(p)) = Some(p) {
                if let (Some(t), Some(x)) = (p.first().and_then(|t| t.as_f64()), p.get(1).and_then(&val)) {
                    pts.push((t, x));
                }
            }
        }
        out.insert(k.clone(), pts);
    }
    out
}

fn ids_of(v: Option<&Value>) -> Option<IndexMap<String, f64>> {
    let Value::Object(m) = v? else { return None };
    let mut out = IndexMap::new();
    for k in json::ordered_keys(m) {
        out.insert(k.clone(), m[k].as_f64().unwrap_or(0.0));
    }
    Some(out)
}

pub fn ids_value(ids: &IndexMap<String, f64>) -> Value {
    Value::Object(ids.iter().map(|(k, v)| (k.clone(), n(*v))).collect())
}

impl Minute {
    pub fn from_value(mut data: Value) -> Option<Minute> {
        let m = data.as_object_mut()?;
        let columns = m.get("enc").and_then(|e| e.as_str()) == Some(ENC);
        let signals = if columns { from_columns(m.get("signals"), |x| x.as_f64()) } else { from_points(m.get("signals"), |x| x.as_f64()) };
        Some(Minute {
            minute: m.get("minute").cloned(),
            trust: m.get("trust").and_then(|t| t.as_str()).map(String::from),
            act: m.get("act").and_then(|t| t.as_str()).map(String::from),
            logs: m.get("logs").and_then(|l| l.as_object()).cloned(),
            signals,
            ids: ids_of(m.get("ids")),
        })
    }

    /// encodeMinute: the file's text, its activity worked out from the signals.
    pub fn encode(minute: &Value, trust: Option<&str>, logs: &Map<String, Value>, signals: &Signals, ids: &IndexMap<String, f64>) -> String {
        let mut o = Map::new();
        o.insert("minute".into(), minute.clone());
        o.insert("enc".into(), Value::String(ENC.into()));
        o.insert("act".into(), Value::String(act_letter(classify(signals)).into()));
        if let Some(t) = trust {
            o.insert("trust".into(), Value::String(t.into()));
        }
        o.insert("logs".into(), Value::Object(logs.clone()));
        o.insert("signals".into(), signals_to_columns(signals));
        o.insert("ids".into(), ids_value(ids));
        json::stringify(&Value::Object(o))
    }
}

impl RawMinute {
    pub fn from_value(mut data: Value) -> Option<RawMinute> {
        let m = data.as_object_mut()?;
        let columns = m.get("enc").and_then(|e| e.as_str()) == Some(ENC);
        let val = |x: &Value| x.as_str().map(String::from);
        let raw = if columns { from_columns(m.get("raw"), val) } else { from_points(m.get("raw"), val) };
        let mut rest = Map::new();
        for (k, v) in m.iter() {
            if !matches!(k.as_str(), "minute" | "enc" | "raw" | "logs") {
                rest.insert(k.clone(), v.clone());
            }
        }
        Some(RawMinute { minute: m.get("minute").cloned(), raw, logs: m.get("logs").and_then(|l| l.as_object()).cloned(), rest })
    }

    /// encodeRaw: { minute, enc, ...rest, raw, logs }.
    pub fn encode(&self) -> String {
        let mut o = Map::new();
        if let Some(m) = &self.minute {
            o.insert("minute".into(), m.clone());
        }
        o.insert("enc".into(), Value::String(ENC.into()));
        for (k, v) in &self.rest {
            o.insert(k.clone(), v.clone());
        }
        o.insert("raw".into(), raw_to_columns(&self.raw));
        if let Some(l) = &self.logs {
            o.insert("logs".into(), Value::Object(l.clone()));
        }
        json::stringify(&Value::Object(o))
    }
}

pub fn gzip(text: &str) -> Vec<u8> {
    let mut e = GzEncoder::new(Vec::new(), Compression::new(6));
    e.write_all(text.as_bytes()).unwrap();
    e.finish().unwrap()
}

pub fn gunzip(b: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    GzDecoder::new(b).read_to_end(&mut out).ok()?;
    Some(out)
}

fn read_json_gz(file: &Path) -> Option<Value> {
    let b = std::fs::read(file).ok()?;
    let text = gunzip(&b)?;
    serde_json::from_slice(&text).ok()
}

/// readMinuteFile: a minute file, or None when it is not there or unreadable.
pub fn read_minute_file(file: &Path) -> Option<Minute> {
    Minute::from_value(read_json_gz(file)?)
}

pub fn read_raw_file(file: &Path) -> Option<RawMinute> {
    RawMinute::from_value(read_json_gz(file)?)
}

const HEAD_END: &str = ",\"signals\":";

/// readHead: the top of a minute file without its signals ({ minute, act, trust, logs }), or None.
pub fn read_head(file: &Path) -> Option<Map<String, Value>> {
    let f = std::fs::File::open(file).ok()?;
    let mut d = GzDecoder::new(std::io::BufReader::new(f));
    let mut text: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; 16 * 1024];
    let mut searched = 0usize;
    loop {
        let r = d.read(&mut buf);
        let k = match r {
            Ok(0) => 0,
            Ok(k) => k,
            Err(_) => {
                // a cut-off or damaged stream: what was unpacked before it counts (Z_SYNC_FLUSH)
                if text.is_empty() {
                    return None;
                }
                0
            }
        };
        if k > 0 {
            text.extend_from_slice(&buf[..k]);
            let from = searched.saturating_sub(HEAD_END.len());
            if let Some(at) = find(&text[from..], HEAD_END.as_bytes()).map(|x| x + from) {
                if at == 0 {
                    return None;
                }
                let mut head = text[..at].to_vec();
                head.push(b'}');
                return serde_json::from_slice::<Value>(&head).ok().and_then(|v| v.as_object().cloned());
            }
            searched = text.len();
            continue;
        }
        // the whole file: no signals at all (or not this layout)
        let mut all: Map<String, Value> = serde_json::from_slice::<Value>(&text).ok()?.as_object()?.clone();
        all.remove("signals");
        all.remove("ids");
        return Some(all);
    }
}

fn find(h: &[u8], n: &[u8]) -> Option<usize> {
    h.windows(n.len()).position(|w| w == n)
}

/// idsOfHead: a head's per-log id counts as one map, or None when a log of it has none.
pub fn ids_of_head(head: Option<&Map<String, Value>>) -> Option<IndexMap<String, f64>> {
    let logs = head?.get("logs")?.as_object()?;
    if logs.is_empty() {
        return None;
    }
    let mut out: IndexMap<String, f64> = IndexMap::new();
    for k in json::ordered_keys(logs) {
        let ids = logs[k].get("ids")?;
        if !json::truthy(Some(ids)) {
            return None;
        }
        if let Value::Object(m) = ids {
            for id in json::ordered_keys(m) {
                *out.entry(id.clone()).or_insert(0.0) += m[id].as_f64().unwrap_or(f64::NAN);
            }
        }
    }
    Some(out)
}

/// Write a file whole or not at all.
pub fn write_atomic(file: &Path, body: &[u8]) -> std::io::Result<()> {
    let tmp = file.with_file_name(format!("{}.{}.tmp", file.file_name().unwrap().to_string_lossy(), std::process::id()));
    let r = std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, file));
    if r.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    r
}
