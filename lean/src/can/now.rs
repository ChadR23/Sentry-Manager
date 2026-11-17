//! The car's latest CAN values, for a Stream Deck (or anything that polls a
//! URL): a port of server/canNow.js. The newest values the CAN index has
//! decoded for a car, whether or not the log is paired with footage yet. The
//! stats are the Viewer's popular ones, named for a URL (speed, battery,
//! batteryPower...), each from the first of its signals that has a value, in
//! the units asked for (miles: mph, °F, psi; kilometres: km/h, °C, bar).
//! GET /api/can/now and the Stream Deck link are in routes.rs.

use super::calc::{self, V};
use super::index::CanIndex;
use super::json::{self, n};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::collections::HashSet;

/// [id, label, signals (the first with a value wins; calc.* are worked out)]
pub const STATS: [(&str, &str, &[&str]); 32] = [
    ("speed", "Speed", &["DI_vehicleSpeed", "DI_vehicleSpeed_116", "DI_vehicleSpeed_118", "UI_gpsVehicleSpeed"]),
    ("battery", "Battery", &["SOCUI292", "UI_SOC", "SOCave292", "SOCUI302"]),
    ("range", "Range", &["UI_Range", "UI_idealRange", "RatedRange338", "IdealRange338"]),
    ("batteryPower", "Battery power", &["calc.batteryPower"]),
    ("gear", "Gear", &["DI_gear", "DI_gear_116", "DI_gear_118"]),
    ("batteryVoltage", "Battery voltage", &["BattVoltage132", "BattVoltage102"]),
    ("batteryCurrent", "Battery current", &["SmoothBattCurrent132", "RawBattCurrent132"]),
    ("batteryTemp", "Battery temp", &["calc.battTemp", "BattTemp102"]),
    ("outsideTemp", "Outside temp", &["VCFRONT_tempAmbientFiltered", "VCFRONT_tempAmbient", "VCRIGHT_tempAmbientRaw"]),
    ("cabinTemp", "Cabin temp", &["VCRIGHT_hvacCabinTempEst"]),
    ("batteryInletTemp", "Battery inlet temp", &["VCFRONT_tempCoolantBatInlet"]),
    ("powertrainInletTemp", "Powertrain inlet temp", &["VCFRONT_tempCoolantPTInlet"]),
    ("rearMotorPower", "Rear motor power", &["RearPower266"]),
    ("frontMotorPower", "Front motor power", &["FrontPower2E5"]),
    ("rearMotorTemp", "Rear motor temp", &["DIR_statorEndWindingTemp", "MotorTemp306"]),
    ("frontMotorTemp", "Front motor temp", &["DIF_statorEndWindingTemp"]),
    ("lv12Current", "12V system current", &["PCS_dcdcLvOutputCurrent"]),
    ("lv12Power", "12V system power", &["calc.lv12SystemPower"]),
    ("lv12Voltage", "12V battery", &["v12vBattVoltage261"]),
    ("lv12State", "12V battery state", &["calc.lv12State"]),
    ("tire1", "Tire 1", &["VCSEC_TPMSPressure0", "TPMSFLpressure31F"]),
    ("tire2", "Tire 2", &["VCSEC_TPMSPressure1", "TPMSFRpressure31F"]),
    ("tire3", "Tire 3", &["VCSEC_TPMSPressure2", "TPMSRLpressure31F"]),
    ("tire4", "Tire 4", &["VCSEC_TPMSPressure3", "TPMSRRpressure31F"]),
    ("charging", "Charging", &["BMS_uiChargeStatus", "CP_hvChargeStatus_13D", "CP_hvChargeStatus_23D", "PCS_hvChargeStatus"]),
    ("chargingPower", "Charging power", &["calc.chargingPower", "ChargerPower222"]),
    ("chargeTimeLeft", "Charge time left", &["ChargeHoursRemaining132"]),
    ("energyRemaining", "Energy remaining", &["BMS_nominalEnergyRemaining", "BMS_expectedEnergyRemaining"]),
    ("odometer", "Odometer", &["UI_odometer", "Odometer3B6", "Odometer5D8"]),
    ("setSpeed", "Set speed", &["DAS_setSpeed", "DAS_setSpeed_2BF", "DAS_setSpeed_2B9"]),
    ("speedLimit", "Speed limit", &["DAS_fusedSpeedLimit", "UI_mppSpeedLimit"]),
    ("elevation", "Elevation", &["Elevation3D8"]),
];

/// STAT_IDS
pub fn stat_ids() -> Vec<&'static str> {
    STATS.iter().map(|s| s.0).collect()
}

/// STATS as the Nerd panel lists them: [{ id, label }]
pub fn stats_list() -> Value {
    Value::Array(STATS.iter().map(|(id, label, _)| json!({ "id": id, "label": label })).collect())
}

/// how far back a signal's last value is looked for (some are sent once in minutes)
pub const LOOK_BACK_MS: f64 = 5.0 * 60_000.0;
/// older than this: `stale` (the car is off, or out of reach of the upload)
pub const STALE_MS: f64 = 5.0 * 60_000.0;

/// JavaScript's \s
pub fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

/// web/units.js canonUnit: a unit as one spelling, or None when it is not one this knows.
pub fn canon_unit(u: &str) -> Option<&'static str> {
    let mut k: String = u.replace('\u{2103}', "C").replace('\u{2109}', "F").chars().filter(|c| !(js_space(*c) || matches!(c, '_' | '°' | 'º' | '˚'))).collect();
    // /^degrees?(?=[cf]$)/i -> 'deg'
    let low = k.to_ascii_lowercase();
    for p in ["degrees", "degree"] {
        if low.starts_with(p) && k.len() == p.len() + 1 && matches!(low.as_bytes()[p.len()], b'c' | b'f') {
            k = format!("deg{}", &k[p.len()..]);
            break;
        }
    }
    let k = k.to_lowercase();
    if k.is_empty() {
        return None;
    }
    Some(match k.as_str() {
        "c" | "degc" | "degreec" | "degreesc" | "celsius" | "degcelsius" | "degreescelsius" | "centigrade" => "C",
        "f" | "degf" | "degreef" | "degreesf" | "fahrenheit" | "degfahrenheit" | "degreesfahrenheit" => "F",
        "k" | "kelvin" => "K",
        "kph" | "km/h" | "kmh" | "km/hr" | "kmph" | "kmperh" | "kilometersperhour" | "kilometresperhour" => "km/h",
        "mph" | "mi/h" | "mi/hr" | "milesperhour" => "mph",
        "m/s" | "mps" | "m/sec" => "m/s",
        "km" | "kilometer" | "kilometers" | "kilometre" | "kilometres" => "km",
        "mi" | "mile" | "miles" => "mi",
        "m" | "meter" | "meters" | "metre" | "metres" => "m",
        "deg" | "degree" | "degrees" => "deg",
        "kwh" => "kWh",
        "wh" => "Wh",
        "kw" => "kW",
        "w" => "W",
        "nm" | "n*m" | "n.m" | "newtonmeter" | "newtonmetre" => "Nm",
        "kpa" => "kPa",
        "bar" => "bar",
        "psi" => "psi",
        "mbar" => "mbar",
        "hpa" => "hPa",
        "pa" => "Pa",
        _ => return None,
    })
}

const MI: f64 = 1.609344;

/// A DBC unit's conversion for the choice ('mi' or 'km'): the unit shown and the value in it.
fn convert(unit: &str, km: bool, v: f64) -> Option<(&'static str, f64)> {
    let key = if unit == "Cdelta" { "Cdelta" } else { canon_unit(unit).unwrap_or(unit) };
    Some(match (key, km) {
        ("C", true) => ("°C", v),
        ("C", false) => ("°F", v * 1.8 + 32.0),
        ("F", true) => ("°C", (v - 32.0) / 1.8),
        ("F", false) => ("°F", v),
        ("Cdelta", true) => ("°C", v),
        ("Cdelta", false) => ("°F", v * 1.8),
        ("km/h", true) => ("km/h", v),
        ("km/h", false) => ("mph", v / MI),
        ("mph", true) => ("km/h", v * MI),
        ("mph", false) => ("mph", v),
        ("km", true) => ("km", v),
        ("km", false) => ("mi", v / MI),
        ("mi", true) => ("km", v * MI),
        ("mi", false) => ("mi", v),
        ("m", true) => ("m", v),
        ("m", false) => ("ft", v * 3.28084),
        ("kPa", true) => ("bar", v / 100.0),
        ("kPa", false) => ("psi", v * 0.1450377),
        ("bar", true) => ("bar", v),
        ("bar", false) => ("psi", v * 14.50377),
        ("psi", true) => ("bar", v / 14.50377),
        ("psi", false) => ("psi", v),
        _ => return None,
    })
}

/// /(^|_)SNA$|NOT_?AVAILABLE|INVALID|UNKNOWN/i
pub fn is_sna(t: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)(^|_)SNA$|NOT_?AVAILABLE|INVALID|UNKNOWN").unwrap()).is_match(t)
}

fn upper_name(t: &str) -> bool {
    !t.is_empty() && t.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

/// A named state in words, without the words every name of the signal starts with (as the
/// Viewer shows it): DI_GEAR_D -> "D", BMS_UI_CHARGE_STATUS_CHARGING -> "Charging",
/// ..._NOT_CHARGING -> "Not charging". `all`: the signal's names.
pub fn state_words(name: &str, all: &[String]) -> String {
    let split = |t: &str| t.split('_').filter(|w| !w.is_empty()).map(String::from).collect::<Vec<String>>();
    let names: Vec<Vec<String>> = all.iter().filter(|t| upper_name(t) && !is_sna(t)).map(|t| split(t)).collect();
    let mut drop = 0;
    if names.len() >= 2 {
        while names.iter().all(|w| w.len() > drop + 1 && w[drop] == names[0][drop]) {
            drop += 1;
        }
    }
    let words: Vec<String> = split(name).into_iter().skip(drop).collect();
    if words.is_empty() {
        return name.to_string();
    }
    if words.len() == 1 && words[0].encode_utf16().count() <= 2 {
        return words[0].clone();
    }
    words
        .iter()
        .enumerate()
        .map(|(k, w)| {
            if k > 0 {
                w.to_lowercase()
            } else {
                let mut c = w.chars();
                match c.next() {
                    Some(f) => format!("{}{}", f, c.as_str().to_lowercase()),
                    None => String::new(),
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn digits_for(id: &str, unit: &str, v: f64) -> usize {
    if id.starts_with("tire") {
        return if unit == "bar" { 2 } else { 0 };
    }
    if matches!(unit, "%" | "mph" | "km/h" | "W" | "mi" | "km" | "ft" | "m" | "°F") {
        return 0;
    }
    if v.abs() >= 100.0 { 0 } else { 1 }
}

fn text_of(value: &str, unit: &str) -> String {
    if unit == "%" {
        format!("{}%", value)
    } else if !unit.is_empty() {
        format!("{} {}", value, unit)
    } else {
        value.to_string()
    }
}

/// Number#toFixed(d) of a value already rounded to d digits (so never an exact tie, and a
/// negative that rounded to zero is zero).
pub fn fixed(v: f64, d: usize) -> String {
    if !v.is_finite() || v.abs() >= 1e21 {
        return json::num_str(v);
    }
    format!("{:.*}", d, if v == 0.0 { 0.0 } else { v })
}

/// What the stats read of the index.
pub trait NowSource {
    fn minute_times(&self, key: &str) -> Vec<f64>;
    fn clip_data(&self, key: &str, from: f64, to: f64, names: &HashSet<String>) -> IndexMap<String, Vec<(f64, f64)>>;
    fn signals(&self, key: &str) -> Map<String, Value>;
}

impl NowSource for CanIndex {
    fn minute_times(&self, key: &str) -> Vec<f64> {
        CanIndex::minute_times(self, key, f64::NEG_INFINITY, f64::INFINITY)
    }
    fn clip_data(&self, key: &str, from: f64, to: f64, names: &HashSet<String>) -> IndexMap<String, Vec<(f64, f64)>> {
        CanIndex::clip_data(self, &[key.to_string()], from, to, Some(names), 0.0, false, None).0
    }
    fn signals(&self, key: &str) -> Map<String, Value> {
        CanIndex::signals(self, &[key.to_string()])
    }
}

/// One stat of the answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Stat {
    pub id: &'static str,
    pub label: &'static str,
    /// a number or words
    pub value: Value,
    pub unit: String,
    pub text: String,
}

/// latestStats: the latest values of one car key.
#[derive(Debug, Clone)]
pub struct Latest {
    pub key: String,
    /// UTC ms of the newest point
    pub at: f64,
    pub age_sec: f64,
    pub stale: bool,
    pub stats: Vec<Stat>,
}

/// Every signal the stats read (a computed stat's inputs in its place).
pub fn signal_names() -> HashSet<String> {
    let mut names = HashSet::new();
    for (_, _, list) in STATS.iter() {
        for nm in list.iter() {
            match calc::calcs().iter().find(|c| c.id == *nm) {
                Some(c) => {
                    for x in c.uses.iter().flatten().chain(c.also.iter()) {
                        names.insert(x.to_string());
                    }
                }
                None => {
                    names.insert(nm.to_string());
                }
            }
        }
    }
    names
}

/// The latest values of one car from the index (a stat without a value is left out), or None
/// when the index has nothing for that car. `km`: units=km (else miles).
pub fn latest_stats(index: &dyn NowSource, key: &str, km: bool, now: f64) -> Option<Latest> {
    let minutes = index.minute_times(key);
    let last = *minutes.last()?;
    let got = index.clip_data(key, last - LOOK_BACK_MS, last + 60_000.0, &signal_names());
    let mut latest: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    let mut at: Option<f64> = None;
    for (name, pts) in &got {
        let Some((t, v)) = pts.last() else { continue };
        latest.insert(name.clone(), *v);
        if at.is_none_or(|a| *t > a) {
            at = Some(*t);
        }
    }
    let at = at?;
    let meta = index.signals(key);
    let get = |nm: &str| latest.get(nm).copied();
    let mut stats = Vec::new();
    for (id, label, list) in STATS.iter() {
        for nm in list.iter() {
            let mut value: Option<V> = None;
            let mut unit: Option<String> = None;
            if let Some(c) = calc::calcs().iter().find(|c| c.id == *nm) {
                value = (c.value)(&get);
                unit = Some(c.unit.to_string());
            } else {
                if let Some(v) = get(nm) {
                    value = Some(V::Num(v));
                }
                let m = meta.get(*nm).cloned().unwrap_or(Value::Null);
                if let (Some(V::Num(v)), Some(Value::Object(values))) = (&value, m.get("values")) {
                    let named = values.get(&json::num_str(json::round(*v))).filter(|x| json::truthy(Some(x))).cloned();
                    if let Some(named) = named {
                        let text = super::logs::js_string(&named);
                        let factor = m.get("factor").and_then(|f| f.as_f64());
                        if is_sna(&text) {
                            value = None;
                        } else if factor.is_none_or(|f| !f.is_finite() || f.abs() == 1.0) {
                            let all: Vec<String> = json::ordered_keys(values).iter().map(|k| super::logs::js_string(&values[k.as_str()])).collect();
                            value = Some(V::Str(state_words(&text, &all)));
                            unit = Some(String::new());
                        }
                    }
                }
                if unit.is_none() {
                    let mu = m.get("unit").filter(|u| json::truthy(Some(u))).map(super::logs::js_string).unwrap_or_default();
                    unit = Some(if *id == "battery" { "%".into() } else { mu });
                }
            }
            let mut unit = unit.unwrap_or_default();
            match value {
                None => continue,
                Some(V::Num(x)) if !x.is_finite() => continue,
                Some(V::Num(mut x)) => {
                    if let Some((u, y)) = convert(&unit, km, x) {
                        unit = u.to_string();
                        x = y;
                    } else if unit == "Cdelta" {
                        unit = "°C".into();
                    }
                    let d = digits_for(id, &unit, x);
                    let scale = 10f64.powi(d as i32);
                    let x = json::round(x * scale) / scale;
                    stats.push(Stat { id, label, value: n(x), unit: unit.clone(), text: text_of(&fixed(x, d), &unit) });
                    break;
                }
                Some(V::Str(s)) => {
                    stats.push(Stat { id, label, value: Value::String(s.clone()), unit: unit.clone(), text: text_of(&s, &unit) });
                    break;
                }
            }
        }
    }
    Some(Latest { key: key.to_string(), at, age_sec: 0f64.max(json::round((now - at) / 1000.0)), stale: now - at > STALE_MS, stats })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake {
        series: Vec<(&'static str, Vec<(f64, f64)>)>,
        meta: Value,
        minutes: Vec<f64>,
    }
    impl NowSource for Fake {
        fn minute_times(&self, _: &str) -> Vec<f64> {
            self.minutes.clone()
        }
        fn clip_data(&self, _: &str, _: f64, _: f64, names: &HashSet<String>) -> IndexMap<String, Vec<(f64, f64)>> {
            self.series.iter().filter(|(nm, _)| names.contains(*nm)).map(|(nm, p)| (nm.to_string(), p.clone())).collect()
        }
        fn signals(&self, _: &str) -> Map<String, Value> {
            self.meta.as_object().cloned().unwrap_or_default()
        }
    }
    const T0: f64 = 1_794_852_000_000.0; // 2026-11-16T18:00:00Z

    fn fake() -> Fake {
        Fake {
            series: vec![
                ("DI_vehicleSpeed", vec![(T0 + 1000.0, 50.0), (T0 + 2000.0, 100.0)]),
                ("SOCUI292", vec![(T0 + 2000.0, 78.4)]),
                ("BattVoltage132", vec![(T0 + 2000.0, 380.25)]),
                ("SmoothBattCurrent132", vec![(T0 + 2000.0, 20.0)]),
                ("VCFRONT_tempAmbientFiltered", vec![(T0 + 2000.0, 7.8)]),
                ("VCSEC_TPMSPressure0", vec![(T0 + 2000.0, 2.9)]),
                ("DI_gear", vec![(T0 + 2000.0, 4.0)]),
                ("BMS_uiChargeStatus", vec![(T0 + 2000.0, 7.0)]),
            ],
            meta: json!({
                "DI_vehicleSpeed": { "unit": "kph" }, "BattVoltage132": { "unit": "V" }, "SmoothBattCurrent132": { "unit": "A" },
                "VCFRONT_tempAmbientFiltered": { "unit": "C" }, "VCSEC_TPMSPressure0": { "unit": "bar" },
                "DI_gear": { "unit": "", "factor": 1, "values": { "1": "DI_GEAR_P", "4": "DI_GEAR_D", "7": "DI_GEAR_SNA" } },
                "BMS_uiChargeStatus": { "unit": "", "factor": 1, "values": { "7": "BMS_UI_CHARGE_STATUS_SNA" } }
            }),
            minutes: vec![T0],
        }
    }

    // test/canNow.test.js: 'stats: the newest value of each, the first signal with one, in miles or kilometres'
    #[test]
    fn stats_in_miles_or_kilometres() {
        assert_eq!(super::super::tz::utc_ms(2026, 11, 16, 18, 0, 0) as f64, T0);
        let index = fake();
        let mi = latest_stats(&index, "K", false, T0 + 62_000.0).unwrap();
        let by = |l: &Latest, id: &str| l.stats.iter().find(|s| s.id == id).cloned();
        assert_eq!(mi.at, T0 + 2000.0);
        assert_eq!(mi.age_sec, 60.0);
        assert!(!mi.stale);
        assert_eq!(by(&mi, "speed").unwrap().text, "62 mph", "the newest point, km/h to mph");
        assert_eq!(by(&mi, "battery").unwrap().text, "78%", "whole percent");
        assert_eq!(by(&mi, "batteryVoltage").unwrap().text, "380 V");
        assert_eq!(by(&mi, "batteryPower").unwrap().text, "7.6 kW", "worked out from volts and amps");
        assert_eq!(by(&mi, "outsideTemp").unwrap().text, "46 °F");
        assert_eq!(by(&mi, "tire1").unwrap().text, "42 psi");
        assert_eq!(by(&mi, "gear").unwrap().text, "D", "a named state in words");
        assert!(by(&mi, "charging").is_none(), "SNA: no value");
        let km = latest_stats(&index, "K", true, T0 + 62_000.0).unwrap();
        let t: Vec<String> = ["speed", "outsideTemp", "tire1"].iter().map(|id| by(&km, id).unwrap().text).collect();
        assert_eq!(t, ["100 km/h", "7.8 °C", "2.90 bar"]);
        assert!(latest_stats(&index, "K", false, T0 + 10.0 * 60_000.0).unwrap().stale, "older than 5 minutes");
        assert!(latest_stats(&Fake { series: vec![], meta: json!({}), minutes: vec![] }, "K", false, T0).is_none(), "nothing indexed");
        let charge: Vec<String> = ["BMS_UI_CHARGE_STATUS_DISCONNECTED", "BMS_UI_CHARGE_STATUS_CHARGING", "BMS_UI_CHARGE_STATUS_NOT_CHARGING", "BMS_UI_CHARGE_STATUS_SNA"].iter().map(|s| s.to_string()).collect();
        let gears: Vec<String> = ["DI_GEAR_P", "DI_GEAR_R", "DI_GEAR_D"].iter().map(|s| s.to_string()).collect();
        assert_eq!(
            [state_words("DI_GEAR_R", &gears), state_words("CHARGING", &["CHARGING".to_string()]), state_words(&charge[1], &charge), state_words(&charge[2], &charge)],
            ["R", "Charging", "Charging", "Not charging"]
        );
        let ids = stat_ids();
        assert!(ids.contains(&"battery") && ids.contains(&"tire4"));
    }

    #[test]
    fn units_and_numbers_as_javascript() {
        assert_eq!(canon_unit("deg C"), Some("C"));
        assert_eq!(canon_unit("Degrees F"), Some("F"));
        assert_eq!(canon_unit("°C"), Some("C"));
        assert_eq!(canon_unit("\u{2103}"), Some("C"));
        assert_eq!(canon_unit("KPH"), Some("km/h"));
        assert_eq!(canon_unit("%"), None);
        assert_eq!(canon_unit(""), None);
        assert_eq!(fixed(2.9, 2), "2.90");
        assert_eq!(fixed(0.0, 1), "0.0");
        assert_eq!(fixed(-0.0, 0), "0");
        assert_eq!(fixed(-7.6, 1), "-7.6");
        assert!(is_sna("DI_GEAR_SNA") && is_sna("not_available") && !is_sna("SNAP"));
    }
}
