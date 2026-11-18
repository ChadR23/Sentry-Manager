//! Which car a vehicle is, and so which DBC set decodes it (web/carModels.js,
//! which the Node server require()s): the VIN from the CAN bus (0x405, or
//! 0x508 on a legacy Model S/X), the vehicle's "Car model" setting, and what
//! the two resolve to.

use serde_json::{json, Value};

pub const DEFAULT_PROFILE: &str = "tesla-3y";
const MODELS: [(&str, &str); 4] = [("3", "Model 3"), ("Y", "Model Y"), ("S", "Model S"), ("X", "Model X")];
const YEAR_CODES: &str = "ABCDEFGHJKLMNPRSTVWXY123456789";

#[derive(Debug)]
pub struct Generation {
    pub id: &'static str,
    pub label: &'static str,
    pub from: i64,
    pub to: i64,
    pub profile: &'static str,
    pub legacy: bool,
}

const fn g(id: &'static str, label: &'static str, from: i64, to: i64, profile: &'static str, legacy: bool) -> Generation {
    Generation { id, label, from, to, profile, legacy }
}

static GEN_3: [Generation; 2] = [g("3-2017", "2017-2023", 2017, 2023, "tesla-3y", false), g("3-2024", "2024 and later (Highland)", 2024, 9999, "tesla-3y", false)];
static GEN_Y: [Generation; 2] = [g("Y-2020", "2020-2024", 2020, 2024, "tesla-3y", false), g("Y-2025", "2025 and later (Juniper)", 2025, 9999, "tesla-3y", false)];
static GEN_S: [Generation; 3] = [
    g("S-2012", "2012-2014 (before Autopilot hardware)", 2012, 2014, "tesla-sx-legacy", true),
    g("S-2015", "2015-2020", 2015, 2020, "tesla-sx-legacy", true),
    g("S-2021", "2021 and later (refresh)", 2021, 9999, "tesla-3y", false),
];
static GEN_X: [Generation; 2] = [g("X-2016", "2016-2020", 2015, 2020, "tesla-sx-legacy", true), g("X-2021", "2021 and later (refresh)", 2021, 9999, "tesla-3y", false)];

pub fn generations(model: &str) -> Option<&'static [Generation]> {
    match model {
        "3" => Some(&GEN_3),
        "Y" => Some(&GEN_Y),
        "S" => Some(&GEN_S),
        "X" => Some(&GEN_X),
        _ => None,
    }
}

pub fn model_label(m: &str) -> Option<&'static str> {
    MODELS.iter().find(|x| x.0 == m).map(|x| x.1)
}

pub fn year_of(code: char) -> Option<i64> {
    YEAR_CODES.find(code.to_ascii_uppercase()).map(|i| 2010 + i as i64)
}

fn plant(p: &str) -> Option<&'static str> {
    Some(match p {
        "5YJ" => "Fremont",
        "7SA" => "Tesla US",
        "LRW" => "Shanghai",
        "XP7" => "Berlin",
        "7G2" => "Tesla US",
        "SFZ" => "Hethel",
        _ => return None,
    })
}

fn vin_ok(v: &str) -> bool {
    v.len() == 17 && v.bytes().all(|c| c.is_ascii_digit() || (c.is_ascii_uppercase() && c != b'I' && c != b'O' && c != b'Q'))
}

#[derive(Debug, Clone, PartialEq)]
pub struct Vin {
    pub vin: String,
    pub model: Option<String>,
    pub year: Option<i64>,
    pub plant: Option<String>,
    pub via: Option<String>,
}

pub fn decode_vin(vin: &str) -> Option<Vin> {
    let v = vin.trim().to_uppercase();
    if !vin_ok(&v) {
        return None;
    }
    let c = v.as_bytes();
    let m = (c[3] as char).to_string();
    Some(Vin { model: model_label(&m).map(|_| m), year: year_of(c[9] as char), plant: plant(&v[..3]).map(String::from), vin: v, via: None })
}

pub fn generation_for(model: &str, year: Option<i64>, legacy: Option<bool>) -> Option<&'static Generation> {
    let list = generations(model)?;
    if let Some(l) = legacy {
        let kind: Vec<&Generation> = list.iter().filter(|g| g.legacy == l).collect();
        if kind.is_empty() {
            return None;
        }
        let Some(y) = year.filter(|y| *y != 0) else { return Some(if l { kind[kind.len() - 1] } else { kind[0] }) };
        return Some(kind.iter().find(|g| y >= g.from && y <= g.to).copied().unwrap_or(if y < kind[0].from { kind[0] } else { kind[kind.len() - 1] }));
    }
    let y = year.filter(|y| *y != 0)?;
    Some(list.iter().find(|g| y >= g.from && y <= g.to).unwrap_or(if y < list[0].from { &list[0] } else { &list[list.len() - 1] }))
}

pub fn generation_by_id(id: &str) -> Option<&'static Generation> {
    [&GEN_3[..], &GEN_Y[..], &GEN_S[..], &GEN_X[..]].into_iter().flatten().find(|g| g.id == id)
}

/// The VIN from a log's frames, one at a time.
#[derive(Default)]
pub struct VinCollector {
    p405: [Option<String>; 3],
    p508: [Option<String>; 3],
    pub found: Option<Vin>,
}

impl VinCollector {
    pub fn add(&mut self, id: u32, b: &[u8]) {
        if self.found.is_some() || b.len() < 8 {
            return;
        }
        let chars = |from: usize, to: usize| -> String { (from..=to).filter(|i| *i < b.len()).map(|i| b[i] as char).collect() };
        let p = match id {
            0x405 => {
                if b[0] & 0xF0 != 0x10 || b[0] & 0x0F > 2 {
                    return;
                }
                let i = (b[0] & 0x0F) as usize;
                self.p405[i] = Some(if i == 0 { chars(5, 7) } else { chars(1, 7) });
                &mut self.p405
            }
            0x508 => {
                if b[0] > 2 {
                    return;
                }
                let i = b[0] as usize;
                self.p508[i] = Some(if i == 2 { chars(1, 3) } else { chars(1, 7) });
                &mut self.p508
            }
            _ => return,
        };
        // (an empty part is falsy in JS: not complete yet)
        if p.iter().all(|x| x.as_ref().is_some_and(|s| !s.is_empty())) {
            let joined: String = p.iter().map(|x| x.clone().unwrap()).collect();
            match decode_vin(&joined) {
                Some(mut d) => {
                    d.via = Some(if id == 0x405 { "0x405".into() } else { "0x508".into() });
                    self.found = Some(d);
                }
                None => *p = [None, None, None],
            }
        }
    }
}

/// normalizeCar: { model, generation }.
pub fn normalize_car(input: Option<&Value>) -> (String, String) {
    let model_raw = match input.and_then(|i| i.get("model")) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => crate::can::json::num_str(n.as_f64().unwrap_or(f64::NAN)),
        _ => String::new(),
    };
    let model = if model_label(&model_raw).is_some() { model_raw } else { "auto".to_string() };
    let gen = match input.and_then(|i| i.get("generation")) {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => "auto".into(),
    };
    let generation = if model != "auto" && generations(&model).unwrap().iter().any(|g| g.id == gen) { gen } else { "auto".into() };
    (model, generation)
}

#[derive(Debug, Clone)]
pub struct Resolved {
    pub model: Option<String>,
    pub year: Option<i64>,
    pub generation: Option<&'static Generation>,
    pub profile: String,
    pub source: &'static str,
}

/// resolveCar(setting, detected).
pub fn resolve_car(setting: Option<&Value>, detected: Option<&Vin>) -> Resolved {
    let (sm, sg) = normalize_car(setting);
    let det = detected.filter(|d| d.model.as_deref().is_some_and(|m| model_label(m).is_some()));
    let model = if sm != "auto" { Some(sm.clone()) } else { det.and_then(|d| d.model.clone()) };
    let same = det.is_some_and(|d| d.model == model);
    let mut gen = None;
    let mut source = "default";
    if let Some(m) = &model {
        if sg != "auto" {
            gen = generation_by_id(&sg);
            source = "setting";
        } else if same {
            let d = det.unwrap();
            let legacy = if m == "S" || m == "X" {
                match d.via.as_deref() {
                    Some("0x508") => Some(true),
                    Some("0x405") => Some(false),
                    _ => None,
                }
            } else {
                None
            };
            gen = generation_for(m, d.year, legacy);
            source = if sm != "auto" { "setting" } else { "vin" };
        } else {
            source = "setting";
        }
    }
    Resolved { year: if same { det.unwrap().year } else { None }, profile: gen.map_or(DEFAULT_PROFILE, |g| g.profile).to_string(), model, generation: gen, source }
}

impl Resolved {
    pub fn to_json(&self) -> Value {
        json!({
            "model": self.model, "modelLabel": self.model.as_deref().and_then(model_label), "year": self.year,
            "generation": self.generation.map(|g| g.id), "generationLabel": self.generation.map(|g| g.label),
            "profile": self.profile, "legacy": self.generation.is_some_and(|g| g.legacy), "source": self.source
        })
    }
}

/// choices(): the vehicle settings' list.
pub fn choices() -> Value {
    Value::Array(MODELS.iter().map(|(id, label)| json!({ "id": id, "label": label, "generations": generations(id).unwrap().iter().map(|g| json!({ "id": g.id, "label": g.label })).collect::<Vec<_>>() })).collect())
}

/// maskVin: maker, model and year characters, not the serial number.
pub fn mask_vin(vin: &str) -> Option<String> {
    vin_ok(vin).then(|| format!("{}******", &vin[..11]))
}

/// A car.json record (canIndex noteCar) as a Vin.
pub fn vin_of_json(v: &Value) -> Option<Vin> {
    Some(Vin {
        vin: v.get("vin")?.as_str()?.to_string(),
        model: v.get("model").and_then(|x| x.as_str()).map(String::from),
        year: v.get("year").and_then(|x| x.as_i64()),
        plant: v.get("plant").and_then(|x| x.as_str()).map(String::from),
        via: v.get("via").and_then(|x| x.as_str()).map(String::from),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vin_and_resolve() {
        let d = decode_vin("7SAYGDEE2NA000001").unwrap();
        assert_eq!(d.model.as_deref(), Some("Y"));
        assert_eq!(d.year, Some(2022));
        assert_eq!(d.plant.as_deref(), Some("Tesla US"));
        assert!(decode_vin("7SAYGDEE2NA00000I").is_none());
        let mut legacy = d.clone();
        legacy.model = Some("S".into());
        legacy.year = Some(2021);
        legacy.via = Some("0x508".into());
        let r = resolve_car(None, Some(&legacy));
        assert_eq!(r.profile, "tesla-sx-legacy");
        assert_eq!(r.generation.unwrap().id, "S-2015");
        assert_eq!(r.source, "vin");
        let r = resolve_car(Some(&json!({ "model": "S", "generation": "S-2021" })), Some(&legacy));
        assert_eq!(r.profile, "tesla-3y");
        assert_eq!(r.source, "setting");
        assert_eq!(resolve_car(None, None).source, "default");
        assert_eq!(mask_vin("7SAYGDEE2NA000001").as_deref(), Some("7SAYGDEE2NA******"));
    }

    #[test]
    fn collects_a_vin() {
        let mut c = VinCollector::default();
        c.add(0x405, &[0x10, 0, 0, 0, 0, b'7', b'S', b'A']);
        c.add(0x405, &[0x11, b'Y', b'G', b'D', b'E', b'E', b'2', b'N']);
        c.add(0x405, &[0x12, b'A', b'0', b'0', b'0', b'0', b'0', b'1']);
        assert_eq!(c.found.as_ref().unwrap().vin, "7SAYGDEE2NA000001");
        assert_eq!(c.found.as_ref().unwrap().via.as_deref(), Some("0x405"));
    }
}
