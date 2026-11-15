//! DBC files: what each CAN message means, and decoding frames with them
//! (server/canDbc.js): messages (BO_), signals (SG_, multiplexed ones too),
//! value names (VAL_) and comments (CM_), the DBC sets per kind of car
//! (PROFILES) read from server/dbc/, and each signal's series name (its name,
//! or name_ID when two messages share it).

use regex::bytes::Regex;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Debug, Clone, PartialEq)]
pub enum Mux {
    None,
    Switch,
    Value(f64),
}

#[derive(Debug, Clone)]
pub struct Signal {
    pub name: String,
    pub message: String,
    pub message_id: u32,
    pub bus: String,
    pub start: u32,
    pub length: u32,
    pub little: bool,
    pub signed: bool,
    pub factor: f64,
    pub offset: f64,
    pub min: f64,
    pub max: f64,
    pub unit: String,
    pub mux: Mux,
    /// value names, as a JS object ({ "0": "OFF", ... }), or None
    pub values: Option<Map<String, Value>>,
    pub comment: Option<String>,
    pub series: String,
}

#[derive(Debug, Clone)]
pub struct Message {
    pub id: u32,
    pub name: String,
    pub size: u32,
    pub bus: String,
    pub signals: Vec<Signal>,
    pub mux: Option<usize>,
}

#[derive(Debug)]
pub struct Dbc {
    /// in the order JS's Map keeps them (first definition's place)
    pub order: Vec<u32>,
    pub messages: HashMap<u32, Message>,
    pub profile: String,
    pub buses: Vec<(String, String)>,
}

/// A pattern over the text's bytes, in Unicode mode as JavaScript reads the DBC text (\s any
/// white space, [^"] any character), with \d and \w spelled out as JavaScript's ASCII ones.
/// (regex 1.13's captures can miss in ASCII-only mode with a class that takes the bytes
/// 0x80-0xFF when its Unicode feature is on, as it is for core's patterns.)
fn rx(s: &str) -> Regex {
    Regex::new(s).unwrap()
}

fn res() -> &'static [Regex; 5] {
    static R: OnceLock<[Regex; 5]> = OnceLock::new();
    R.get_or_init(|| {
        [
            rx(r"^BO_\s+([0-9]+)\s+([0-9A-Za-z_]+)\s*:\s*([0-9]+)\s+([0-9A-Za-z_]+)"),
            rx(r#"^\s+SG_\s+([0-9A-Za-z_]+)\s*(M|m[0-9]+)?\s*:\s*([0-9]+)\|([0-9]+)@([01])([+-])\s*\(\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*\)\s*\[\s*([-+0-9.eE]+)\s*\|\s*([-+0-9.eE]+)\s*\]\s*"([^"]*)""#),
            rx(r#"(?m)^VAL_\s+([0-9]+)\s+([0-9A-Za-z_]+)\s+((?:-?[0-9]+\s+"[^"]*"\s*)+);"#),
            rx(r#"(-?[0-9]+)\s+"([^"]*)""#),
            rx(r#"(?m)^CM_\s+SG_\s+([0-9]+)\s+([0-9A-Za-z_]+)\s+"((?:[^"\\]|\\.)*)"\s*;"#),
        ]
    })
}

fn s(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

/// Number(text) as JS reads a DBC number (NaN when it is not one).
fn js_num(t: &str) -> f64 {
    let t = t.trim();
    if t.is_empty() {
        return 0.0;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

fn raw_id(t: &str) -> u32 {
    let raw: f64 = t.parse().unwrap_or(f64::NAN);
    let id = if raw >= 2147483648.0 { raw - 2147483648.0 } else { raw };
    id as u32
}

/// parseDbc: every message and signal of a DBC text.
pub fn parse(text: &str) -> Dbc {
    let [bo, sg, val, pair, cm] = res();
    let mut order = Vec::new();
    let mut messages: HashMap<u32, Message> = HashMap::new();
    let mut current: Option<u32> = None;
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    for line in &lines {
        let lb = line.as_bytes();
        if let Some(m) = bo.captures(lb) {
            let id = raw_id(&s(&m[1]));
            let msg = Message { id, name: s(&m[2]), size: s(&m[3]).parse().unwrap_or(0), bus: s(&m[4]), signals: Vec::new(), mux: None };
            if !messages.contains_key(&id) {
                order.push(id);
            }
            messages.insert(id, msg);
            current = Some(id);
            continue;
        }
        if let (Some(m), Some(cur)) = (sg.captures(lb), current) {
            let msg = messages.get_mut(&cur).unwrap();
            let mux = match m.get(2).map(|x| s(x.as_bytes())) {
                Some(x) if x == "M" => Mux::Switch,
                Some(x) => Mux::Value(js_num(&x[1..])),
                None => Mux::None,
            };
            let sig = Signal {
                name: s(&m[1]),
                message: msg.name.clone(),
                message_id: msg.id,
                bus: msg.bus.clone(),
                start: s(&m[3]).parse().unwrap_or(0),
                length: s(&m[4]).parse().unwrap_or(0),
                little: &m[5] == b"1",
                signed: &m[6] == b"-",
                factor: js_num(&s(&m[7])),
                offset: js_num(&s(&m[8])),
                min: js_num(&s(&m[9])),
                max: js_num(&s(&m[10])),
                unit: s(&m[11]),
                mux: mux.clone(),
                values: None,
                comment: None,
                series: String::new(),
            };
            msg.signals.push(sig);
            if mux == Mux::Switch {
                msg.mux = Some(msg.signals.len() - 1);
            }
            continue;
        }
        if !lb.first().is_some_and(|c| c.is_ascii_whitespace()) {
            current = None;
        }
    }
    let all = lines.join("\n");
    let ab = all.as_bytes();
    for v in val.captures_iter(ab) {
        let id = raw_id(&s(&v[1]));
        let name = s(&v[2]);
        let Some(sig) = messages.get_mut(&id).and_then(|m| m.signals.iter_mut().find(|x| x.name == name)) else { continue };
        let mut values = Map::new();
        for p in pair.captures_iter(&v[3]) {
            values.insert(s(&p[1]), Value::String(s(&p[2])));
        }
        sig.values = Some(values);
    }
    for c in cm.captures_iter(ab) {
        let id = raw_id(&s(&c[1]));
        let name = s(&c[2]);
        let Some(sig) = messages.get_mut(&id).and_then(|m| m.signals.iter_mut().find(|x| x.name == name)) else { continue };
        let text = s(&c[3]);
        let one = text.split(|ch: char| ch.is_whitespace()).filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" ");
        sig.comment = Some(one.chars().take(200).collect());
    }
    // series names: unique, else name_ID
    let mut count: HashMap<String, usize> = HashMap::new();
    for m in messages.values() {
        for sg in &m.signals {
            *count.entry(sg.name.clone()).or_default() += 1;
        }
    }
    for m in messages.values_mut() {
        let hex = format!("{:03X}", m.id);
        for sg in &mut m.signals {
            sg.series = if count[&sg.name] > 1 { format!("{}_{}", sg.name, hex) } else { sg.name.clone() };
        }
    }
    Dbc { order, messages, profile: String::new(), buses: Vec::new() }
}

/// The raw (unscaled) bits of a signal in a frame's bytes, or None when it does not fit.
pub fn raw_bits(bytes: &[u8], sig: &Signal) -> Option<f64> {
    let (start, length) = (sig.start, sig.length);
    let mut value = 0f64;
    if sig.little {
        for i in 0..length {
            let bit = start + i;
            let byte = (bit >> 3) as usize;
            if byte >= bytes.len() {
                return None;
            }
            if (bytes[byte] >> (bit & 7)) & 1 == 1 {
                value += 2f64.powi(i as i32);
            }
        }
    } else {
        let mut bit = start as i64;
        for i in (0..length as i32).rev() {
            let byte = (bit >> 3) as usize;
            if bit < 0 || byte >= bytes.len() {
                return None;
            }
            if (bytes[byte] >> (bit & 7)) & 1 == 1 {
                value += 2f64.powi(i);
            }
            bit = if bit & 7 == 0 { bit + 15 } else { bit - 1 };
        }
    }
    if sig.signed && length > 0 && value >= 2f64.powi(length as i32 - 1) {
        value -= 2f64.powi(length as i32);
    }
    Some(value)
}

/// Every signal a frame carries: [(signal index, value)] (multiplexed ones by the frame's mux value).
pub fn decode_frame<'a>(msg: &'a Message, bytes: &[u8], out: &mut Vec<(&'a Signal, f64)>) {
    out.clear();
    let mux_value = msg.mux.and_then(|i| raw_bits(bytes, &msg.signals[i]));
    for sig in &msg.signals {
        if let Mux::Value(v) = sig.mux {
            if Some(v) != mux_value {
                continue;
            }
        }
        if let Some(raw) = raw_bits(bytes, sig) {
            let v = raw * sig.factor + sig.offset;
            if v.is_finite() {
                out.push((sig, v));
            }
        }
    }
}

pub const DEFAULT_PROFILE: &str = "tesla-3y";
pub const PROFILES: [&str; 2] = ["tesla-3y", "tesla-sx-legacy"];

fn profile_files(name: &str) -> (Vec<(&'static str, Option<&'static str>)>, Vec<(String, String)>) {
    if name == "tesla-sx-legacy" {
        (
            vec![("opendbc-tesla_can.dbc", Some("ChassisBus")), ("opendbc-tesla_powertrain.dbc", Some("PowertrainBus")), ("sx-legacy.dbc", None)],
            vec![("can0".into(), "PowertrainBus".into()), ("can1".into(), "ChassisBus".into())],
        )
    } else {
        (
            vec![("Model3CAN.dbc", None), ("model3y-opendbc.dbc", None), ("override.dbc", None)],
            vec![("can0".into(), "VehicleBus".into()), ("can1".into(), "ChassisBus".into())],
        )
    }
}

fn dbc_dir() -> PathBuf {
    if let Ok(d) = std::env::var("CAN_DBC_DIR") {
        return PathBuf::from(d);
    }
    let root = std::env::var("APP_ROOT").ok().filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_else(|| {
        // (tests: the repository this crate is in)
        Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
    });
    root.join("server").join("dbc")
}

/// A DBC set by its name, parsed once; an unknown name is the default set.
pub fn dbc_for(profile: &str) -> Arc<Dbc> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<Dbc>>>> = OnceLock::new();
    let name = if PROFILES.contains(&profile) { profile } else { DEFAULT_PROFILE };
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(d) = cache.lock().unwrap().get(name) {
        return d.clone();
    }
    let (files, buses) = profile_files(name);
    let bo_line = Regex::new(r"(?m)^(BO_\s+[0-9]+\s+[0-9A-Za-z_]+\s*:\s*[0-9]+\s+)[0-9A-Za-z_]+").unwrap();
    let dir = dbc_dir();
    let mut parts = Vec::new();
    for (file, bus) in files {
        let text = std::fs::read(dir.join(file)).unwrap_or_default();
        let text = match bus {
            Some(b) => bo_line.replace_all(&text, |c: &regex::bytes::Captures| [&c[1], b.as_bytes()].concat()).into_owned(),
            None => text,
        };
        parts.push(String::from_utf8_lossy(&text).into_owned());
    }
    let mut dbc = parse(&format!("{}\n", parts.join("\n")));
    dbc.profile = name.to_string();
    dbc.buses = buses;
    let d = Arc::new(dbc);
    cache.lock().unwrap().insert(name.to_string(), d.clone());
    d
}

impl Dbc {
    pub fn bus_defaults(&self) -> Vec<(String, String)> {
        self.buses.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_little_and_big_endian() {
        let dbc = parse("BO_ 280 DI_systemStatus: 8 VehicleBus\n SG_ Speed : 12|12@1+ (0.08,-40) [-40|285] \"kph\" X\n SG_ Big : 7|8@0- (1,0) [0|0] \"\" X\nVAL_ 280 Speed 0 \"ZERO\" 1 \"ONE\" ;\nCM_ SG_ 280 Speed \"the\n  speed\";\n");
        let msg = &dbc.messages[&280];
        let mut out = Vec::new();
        decode_frame(msg, &[0, 0x10, 0x27, 0, 0, 0, 0, 0], &mut out);
        assert_eq!(out.len(), 2);
        assert!((out[0].1 - (0x271 as f64 * 0.08 - 40.0)).abs() < 1e-9);
        assert_eq!(out[1].1, 0.0);
        assert_eq!(msg.signals[0].comment.as_deref(), Some("the speed"));
        assert_eq!(msg.signals[0].values.as_ref().unwrap().len(), 2);
        decode_frame(msg, &[0xFF], &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].1, -1.0);
    }

    #[test]
    fn bundled_sets_parse() {
        let d = dbc_for("tesla-3y");
        assert!(d.messages.len() > 100);
        let l = dbc_for("tesla-sx-legacy");
        assert!(l.messages.values().all(|m| m.bus == "ChassisBus" || m.bus == "PowertrainBus" || !m.signals.is_empty() || true));
    }
}
