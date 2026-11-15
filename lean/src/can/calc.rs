//! The Viewer's computed stats of one moment (web/carCalc.js, the ones
//! without a window) in the decoded CSV export (server/canCalc.js): battery
//! power, charging power, the 12 V battery's power, ... worked out at each
//! change of an input from the inputs' latest values.

use super::json;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub enum V {
    Num(f64),
    Str(String),
}

type Get<'a> = &'a dyn Fn(&str) -> Option<f64>;

pub struct Calc {
    pub id: &'static str,
    pub unit: &'static str,
    pub digits: Option<usize>,
    pub uses: Vec<Vec<&'static str>>,
    pub also: Vec<&'static str>,
    pub value: fn(Get) -> Option<V>,
}

const VOLTS: &[&str] = &["BattVoltage132"];
const AMPS: &[&str] = &["SmoothBattCurrent132", "RawBattCurrent132"];
const CHARGE: &[(&str, f64)] = &[("BMS_uiChargeStatus", 3.0), ("CP_hvChargeStatus_13D", 5.0), ("CP_hvChargeStatus_23D", 5.0), ("PCS_hvChargeStatus", 2.0)];
const CHARGE_NAMES: &[&str] = &["BMS_uiChargeStatus", "CP_hvChargeStatus_13D", "CP_hvChargeStatus_23D", "PCS_hvChargeStatus"];
const LV_VOLTS: &[&str] = &["v12vBattVoltage261"];
const LV_AMPS: &[&str] = &["v12vBattCurrent261"];
const SYS_VOLTS: &[&str] = &["PCS_dcdcLvBusVolt", "v12vBattVoltage261"];
const SYS_AMPS: &[&str] = &["PCS_dcdcLvOutputCurrent"];

fn first(get: Get, names: &[&str]) -> Option<f64> {
    names.iter().find_map(|n| get(n).filter(|v| v.is_finite()))
}
fn battery_kw(get: Get) -> Option<f64> {
    Some(first(get, VOLTS)? * first(get, AMPS)? / 1000.0)
}
fn charging(get: Get) -> Option<bool> {
    for (n, on) in CHARGE {
        if let Some(v) = get(n).filter(|v| v.is_finite()) {
            return Some(json::round(v) == *on);
        }
    }
    None
}
fn num(get: Get, n: &str) -> Option<f64> {
    get(n).filter(|v| v.is_finite())
}

pub fn calcs() -> &'static [Calc] {
    static C: std::sync::OnceLock<Vec<Calc>> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        vec![
            Calc { id: "calc.batteryPower", unit: "kW", digits: Some(1), uses: vec![VOLTS.to_vec(), AMPS.to_vec()], also: vec![], value: |g| battery_kw(g).map(V::Num) },
            Calc { id: "calc.drivePower", unit: "kW", digits: Some(1), uses: vec![VOLTS.to_vec(), AMPS.to_vec()], also: vec![], value: |g| battery_kw(g).map(|p| V::Num(p.max(0.0))) },
            Calc {
                id: "calc.regenPower",
                unit: "kW",
                digits: Some(1),
                uses: vec![VOLTS.to_vec(), AMPS.to_vec()],
                also: CHARGE_NAMES.to_vec(),
                value: |g| battery_kw(g).map(|p| V::Num(if p < 0.0 && charging(g) != Some(true) { -p } else { 0.0 })),
            },
            Calc {
                id: "calc.chargingPower",
                unit: "kW",
                digits: Some(1),
                uses: vec![VOLTS.to_vec(), AMPS.to_vec(), CHARGE_NAMES.to_vec()],
                also: vec![],
                value: |g| if charging(g) != Some(true) { None } else { battery_kw(g).map(|p| V::Num(-p)) },
            },
            Calc {
                id: "calc.dcChargerPower",
                unit: "kW",
                digits: Some(1),
                uses: vec![vec!["CP_evseOutputDcVoltage"], vec!["CP_evseOutputDcCurrent"]],
                also: vec!["CP_evseOutputDcCurrentStale"],
                value: |g| {
                    let v = num(g, "CP_evseOutputDcVoltage")?;
                    let i = num(g, "CP_evseOutputDcCurrent")?;
                    if num(g, "CP_evseOutputDcCurrentStale") == Some(1.0) || !(v > 0.0 && i > 0.0) {
                        return None;
                    }
                    Some(V::Num(v * i / 1000.0))
                },
            },
            Calc { id: "calc.lv12Power", unit: "W", digits: Some(0), uses: vec![LV_VOLTS.to_vec(), LV_AMPS.to_vec()], also: vec![], value: |g| Some(V::Num(-(first(g, LV_VOLTS)? * first(g, LV_AMPS)?))) },
            Calc { id: "calc.lv12SystemPower", unit: "W", digits: Some(0), uses: vec![SYS_VOLTS.to_vec(), SYS_AMPS.to_vec()], also: vec![], value: |g| Some(V::Num(first(g, SYS_VOLTS)? * first(g, SYS_AMPS)?)) },
            Calc {
                id: "calc.lv12State",
                unit: "",
                digits: None,
                uses: vec![LV_AMPS.to_vec()],
                also: vec![],
                value: |g| {
                    let i = first(g, LV_AMPS)?;
                    Some(V::Str(if i.abs() < 0.2 { "Resting" } else if i > 0.0 { "Charging" } else { "Discharging" }.into()))
                },
            },
            Calc {
                id: "calc.battTemp",
                unit: "C",
                digits: Some(1),
                uses: vec![vec!["BattBrickTempMax332"], vec!["BattBrickTempMin332"]],
                also: vec![],
                value: |g| Some(V::Num((num(g, "BattBrickTempMax332")? + num(g, "BattBrickTempMin332")?) / 2.0)),
            },
            Calc {
                id: "calc.battTempSpread",
                unit: "Cdelta",
                digits: Some(1),
                uses: vec![vec!["BattBrickTempMax332"], vec!["BattBrickTempMin332"]],
                also: vec![],
                value: |g| Some(V::Num(num(g, "BattBrickTempMax332")? - num(g, "BattBrickTempMin332")?)),
            },
        ]
    })
}

pub fn is_calc(name: &str) -> bool {
    calcs().iter().any(|c| c.id == name)
}

/// The export's unit of a computed stat.
pub fn calc_unit(id: &str) -> &'static str {
    match calcs().iter().find(|c| c.id == id).map(|c| c.unit) {
        Some("kW") => "kW",
        Some("W") => "W",
        Some("C") | Some("Cdelta") => "C",
        _ => "",
    }
}

pub struct Plan {
    pub calcs: Vec<&'static Calc>,
    pub inputs: Vec<&'static str>,
    pub by_input: HashMap<&'static str, Vec<usize>>,
    // the state carried across minutes
    pub latest: HashMap<String, f64>,
    pub last: HashMap<&'static str, (Option<V>, f64)>,
}

/// calcPlan(only): the computed stats asked for (all without a list), and the signals they read.
pub fn plan(only: Option<&dyn Fn(&str) -> bool>) -> Option<Plan> {
    let list: Vec<&'static Calc> = calcs().iter().filter(|c| only.is_none_or(|f| f(c.id))).collect();
    if list.is_empty() {
        return None;
    }
    let mut inputs = Vec::new();
    let mut by_input: HashMap<&'static str, Vec<usize>> = HashMap::new();
    for (i, c) in list.iter().enumerate() {
        for n in c.uses.iter().flatten().chain(c.also.iter()) {
            if !inputs.contains(n) {
                inputs.push(*n);
            }
            by_input.entry(n).or_default().push(i);
        }
    }
    Some(Plan { calcs: list, inputs, by_input, latest: HashMap::new(), last: HashMap::new() })
}

fn rounded(c: &Calc, v: V) -> V {
    match v {
        V::Num(x) => V::Num(json::to_fixed(x, c.digits.unwrap_or(1) + 2)),
        s => s,
    }
}

/// calcPoints: the computed stats' points for these time-ordered points [(ms, name, value)].
/// `every`: each time it has a value; else changes, a repeat once each heartbeat, and '' once when it stops.
pub fn points(pts: &[(f64, String, V)], plan: &mut Plan, every: bool, heartbeat_ms: f64) -> Vec<(f64, String, V)> {
    let mut out = Vec::new();
    let mut k = 0;
    while k < pts.len() {
        let at = pts[k].0;
        let mut touched: Vec<usize> = Vec::new();
        while k < pts.len() && pts[k].0 == at {
            if let Some(users) = plan.by_input.get(pts[k].1.as_str()) {
                if let V::Num(x) = &pts[k].2 {
                    plan.latest.insert(pts[k].1.clone(), *x);
                } else {
                    plan.latest.remove(&pts[k].1);
                }
                for u in users {
                    if !touched.contains(u) {
                        touched.push(*u);
                    }
                }
            }
            k += 1;
        }
        for i in touched {
            let c = plan.calcs[i];
            let latest = &plan.latest;
            let get = |n: &str| latest.get(n).copied();
            let val = (c.value)(&get).map(|v| rounded(c, v));
            let l = plan.last.get(c.id).cloned();
            if every {
                if let Some(v) = val {
                    out.push((at, c.id.to_string(), v));
                }
                continue;
            }
            match val {
                None => {
                    if l.as_ref().is_some_and(|l| l.0.is_some()) {
                        out.push((at, c.id.to_string(), V::Str(String::new())));
                        plan.last.insert(c.id, (None, at));
                    }
                }
                Some(v) => {
                    if let Some(l) = &l {
                        if l.0.as_ref() == Some(&v) && at - l.1 < heartbeat_ms {
                            continue;
                        }
                    }
                    plan.last.insert(c.id, (Some(v.clone()), at));
                    out.push((at, c.id.to_string(), v));
                }
            }
        }
    }
    out
}

pub fn point_count() -> usize {
    calcs().len()
}
