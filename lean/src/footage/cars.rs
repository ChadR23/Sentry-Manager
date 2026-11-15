//! The car-model table as the vehicle settings use it (web/carModels.js:
//! normalizeCar, choices, and resolveCar without CAN data). Reading the VIN
//! from CAN logs is the CAN area's (ctx::Ctx::car_summary).

use serde_json::{json, Value};

pub const MODELS: [(&str, &str); 4] = [("3", "Model 3"), ("Y", "Model Y"), ("S", "Model S"), ("X", "Model X")];

pub struct Generation {
    pub id: &'static str,
    pub label: &'static str,
    pub profile: &'static str,
    pub legacy: bool,
}

const fn g(id: &'static str, label: &'static str, profile: &'static str, legacy: bool) -> Generation {
    Generation { id, label, profile, legacy }
}

pub fn generations(model: &str) -> &'static [Generation] {
    const M3: [Generation; 2] = [g("3-2017", "2017-2023", "tesla-3y", false), g("3-2024", "2024 and later (Highland)", "tesla-3y", false)];
    const MY: [Generation; 2] = [g("Y-2020", "2020-2024", "tesla-3y", false), g("Y-2025", "2025 and later (Juniper)", "tesla-3y", false)];
    const MS: [Generation; 3] = [
        g("S-2012", "2012-2014 (before Autopilot hardware)", "tesla-sx-legacy", true),
        g("S-2015", "2015-2020", "tesla-sx-legacy", true),
        g("S-2021", "2021 and later (refresh)", "tesla-3y", false),
    ];
    const MX: [Generation; 2] = [g("X-2016", "2016-2020", "tesla-sx-legacy", true), g("X-2021", "2021 and later (refresh)", "tesla-3y", false)];
    match model {
        "3" => &M3,
        "Y" => &MY,
        "S" => &MS,
        "X" => &MX,
        _ => &[],
    }
}

pub fn generation_by_id(id: &str) -> Option<&'static Generation> {
    MODELS.iter().flat_map(|(m, _)| generations(m).iter()).find(|g| g.id == id)
}

/// normalizeCar: { model: 'auto' | '3' | 'Y' | 'S' | 'X', generation: 'auto' | an id of that model }
pub fn normalize_car(input: Option<&Value>) -> Value {
    let model = input.and_then(|i| i.get("model")).map(super::js::string).filter(|m| MODELS.iter().any(|(k, _)| k == m)).unwrap_or_else(|| "auto".into());
    let gen = input.and_then(|i| i.get("generation")).filter(|g| super::js::truthy(Some(g))).map(super::js::string).unwrap_or_else(|| "auto".into());
    let generation = if model != "auto" && generations(&model).iter().any(|g| g.id == gen) { gen } else { "auto".into() };
    json!({ "model": model, "generation": generation })
}

/// choices(): the vehicle settings' "Car model" and "Year"
pub fn choices() -> Value {
    Value::Array(MODELS.iter().map(|(id, label)| json!({ "id": id, "label": label, "generations": generations(id).iter().map(|g| json!({ "id": g.id, "label": g.label })).collect::<Vec<_>>() })).collect())
}

/// index.js withCar without a CAN index: { setting, detected: null, ...resolveCar(car, null) }
pub fn default_summary(car: Option<&Value>) -> Value {
    let s = normalize_car(car);
    let model = s["model"].as_str().filter(|m| *m != "auto").map(String::from);
    let (gen, source) = match &model {
        Some(_) if s["generation"] != "auto" => (generation_by_id(s["generation"].as_str().unwrap_or("")), "setting"),
        Some(_) => (None, "setting"),
        None => (None, "default"),
    };
    json!({
        "setting": s, "detected": null,
        "model": model, "modelLabel": model.as_deref().and_then(|m| MODELS.iter().find(|(k, _)| *k == m)).map(|(_, l)| l),
        "year": null, "generation": gen.map(|g| g.id), "generationLabel": gen.map(|g| g.label),
        "profile": gen.map_or("tesla-3y", |g| g.profile), "legacy": gen.is_some_and(|g| g.legacy), "source": source
    })
}
