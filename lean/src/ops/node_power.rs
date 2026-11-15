//! nodePower.js: power across servers. Each node reports its own live power
//! and energy in GET /node/v1/info (`power`); the main checks those numbers,
//! keeps the last one per node and adds them to its own for "All servers"
//! (/api/stats power.nodes and power.combined). Only numbers travel.

use super::js::num as jnum;
use serde_json::{json, Value};

const MAX_W: f64 = 20_000.0;
const MAX_WH: f64 = 10_000_000.0;
const MAX_GPUS: usize = 16;
pub const NODE_SAMPLE_MAX_AGE_MS: i64 = 60_000;

fn text(v: &Value, max: usize) -> String {
    let s = match v {
        Value::Null => String::new(),
        Value::Bool(false) => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) if n.as_f64() == Some(0.0) => String::new(),
        x => super::js::to_string(x),
    };
    let s: String = s.chars().map(|c| if (c as u32) < 0x20 || (0x7f..=0x9f).contains(&(c as u32)) { ' ' } else { c }).collect();
    super::power::js_slice(s.trim(), max)
}

fn unavailable(v: &Value) -> Value {
    match v.as_str() {
        Some(s @ ("windows" | "vm")) => json!(s),
        _ => Value::Null,
    }
}

fn watts(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite() && *x >= 0.0 && *x <= MAX_W).map(|x| (x * 10.0 + 0.5).floor() / 10.0)
}

fn wh(v: &Value) -> Option<f64> {
    v.as_f64().filter(|x| x.is_finite() && *x >= 0.0 && *x <= MAX_WH).map(|x| (x * 1000.0 + 0.5).floor() / 1000.0)
}

fn n(x: Option<f64>) -> Value {
    x.map_or(Value::Null, jnum)
}

/// The worker's side: what /node/v1/info says about this server's power, from a stats snapshot.
pub fn power_report(snapshot: &Value, now: i64) -> Value {
    let p = &snapshot["power"];
    let at = super::js::number_opt(snapshot.get("at"));
    let live = at.is_finite() && now as f64 - at <= NODE_SAMPLE_MAX_AGE_MS as f64;
    let gpus: Vec<Value> = snapshot["gpus"].as_array().into_iter().flatten().take(MAX_GPUS).map(|g| {
        let name = text(&g["name"], 64);
        json!({ "name": if name.is_empty() { "GPU".into() } else { name }, "w": if live { n(watts(&g["powerW"])) } else { Value::Null } })
    }).collect();
    let l = |v: &Value| if live { n(watts(v)) } else { Value::Null };
    json!({
        "at": if at.is_finite() { jnum(at) } else { Value::Null },
        "cpuW": l(&p["cpuW"]), "gpuW": l(&p["gpuW"]), "totalW": l(&p["totalW"]),
        "todayWh": n(wh(&p["todayWh"])), "weekWh": n(wh(&p["weekWh"])),
        "cpuUnavailable": unavailable(&p["cpuUnavailable"]), "gpus": gpus
    })
}

/// The main's side: a node's `power` as reported, checked; Null when it sent none (an older node).
pub fn clean_report(v: &Value) -> Value {
    let Some(_) = v.as_object() else { return Value::Null };
    let gpus: Vec<Value> = v["gpus"].as_array().into_iter().flatten().take(64).filter(|g| g.is_object()).take(MAX_GPUS).map(|g| {
        let name = text(&g["name"], 64);
        json!({ "name": if name.is_empty() { "GPU".into() } else { name }, "w": n(watts(&g["w"])) })
    }).collect();
    json!({ "cpuW": n(watts(&v["cpuW"])), "gpuW": n(watts(&v["gpuW"])), "totalW": n(watts(&v["totalW"])), "todayWh": n(wh(&v["todayWh"])), "weekWh": n(wh(&v["weekWh"])), "cpuUnavailable": unavailable(&v["cpuUnavailable"]), "gpus": gpus })
}

/// A paired node as nodes.js power() lists it.
#[derive(Clone, Debug)]
pub struct NodeRow {
    pub id: String,
    pub name: String,
    pub online: bool,
    /// clean_report's answer, or Null
    pub power: Value,
}

fn add(a: Option<f64>, b: Option<f64>) -> Option<f64> {
    match b {
        None => a,
        Some(b) => Some(a.unwrap_or(0.0) + b),
    }
}

fn r(x: Option<f64>, f: f64) -> Option<f64> {
    x.map(|x| (x * f + 0.5).floor() / f)
}

/// This server's power block plus the nodes': (rows, combined or Null).
pub fn combine(own: &Value, nodes: &[NodeRow], price_now: Option<f64>) -> (Vec<Value>, Value) {
    if nodes.is_empty() {
        return (Vec::new(), Value::Null);
    }
    let f = |v: &Value, k: &str| v[k].as_f64();
    let rows: Vec<Value> = nodes
        .iter()
        .map(|nd| {
            let p = if nd.online && nd.power.is_object() { Some(&nd.power) } else { None };
            let g = |k: &str| p.map_or(Value::Null, |p| p[k].clone());
            json!({
                "id": nd.id, "name": nd.name, "online": nd.online, "known": p.is_some(),
                "cpuW": g("cpuW"), "gpuW": g("gpuW"), "totalW": g("totalW"), "todayWh": g("todayWh"), "weekWh": g("weekWh"),
                "cpuUnavailable": g("cpuUnavailable"), "gpus": p.map_or(json!([]), |p| if p["gpus"].is_array() { p["gpus"].clone() } else { json!([]) })
            })
        })
        .collect();
    let (mut cpu, mut gpu, mut total, mut today, mut week) = (f(own, "cpuW"), f(own, "gpuW"), f(own, "totalW"), f(own, "todayWh"), f(own, "weekWh"));
    let (mut node_today, mut node_week) = (0.0, 0.0);
    for row in &rows {
        cpu = add(cpu, f(row, "cpuW"));
        gpu = add(gpu, f(row, "gpuW"));
        total = add(total, f(row, "totalW"));
        today = add(today, f(row, "todayWh"));
        week = add(week, f(row, "weekWh"));
        node_today += f(row, "todayWh").unwrap_or(0.0);
        node_week += f(row, "weekWh").unwrap_or(0.0);
    }
    // per Wh: this server's average price over the period, else the price now
    let price = |cost: Option<f64>, own_wh: Option<f64>| -> Option<f64> {
        match (cost.filter(|c| c.is_finite()), own_wh) {
            (Some(c), Some(w)) if w > 0.0 => Some(c / w),
            _ => price_now.filter(|p| p.is_finite()).map(|p| p / 1000.0),
        }
    };
    let p_today = price(f(own, "todayCost"), f(own, "todayWh"));
    let p_week = price(f(own, "weekCost"), f(own, "weekWh"));
    let cost = |own_cost: Option<f64>, node_wh: f64, per_wh: Option<f64>| -> Option<f64> {
        match per_wh {
            None => own_cost,
            Some(p) => Some(own_cost.unwrap_or(0.0) + node_wh * p),
        }
    };
    let reporting = usize::from(f(own, "totalW").is_some()) + rows.iter().filter(|r| !r["totalW"].is_null()).count();
    let combined = json!({
        "cpuW": n(r(cpu, 10.0)), "gpuW": n(r(gpu, 10.0)), "totalW": n(r(total, 10.0)), "todayWh": n(r(today, 1000.0)), "weekWh": n(r(week, 1000.0)),
        "todayCost": n(r(cost(f(own, "todayCost"), node_today, p_today), 1e6)), "weekCost": n(r(cost(f(own, "weekCost"), node_week, p_week), 1e6)),
        "servers": 1 + rows.len(), "reporting": reporting
    });
    (rows, combined)
}

#[cfg(test)]
mod tests {
    use super::*;

    // test/nodePower.test.js "the worker reports numbers only, and nothing live from an old sample"
    #[test]
    fn the_worker_reports_numbers_only() {
        let now = 1_000_000;
        let snap = json!({ "at": now - 2000, "power": { "cpuW": 41.26, "gpuW": 120, "totalW": 161.3, "todayWh": 12.5, "weekWh": 80, "todayCost": 1 }, "gpus": [{ "name": "RTX 4070", "powerW": 120, "vramTotalB": 1, "driver": "x" }] });
        assert_eq!(power_report(&snap, now), json!({ "at": now - 2000, "cpuW": 41.3, "gpuW": 120, "totalW": 161.3, "todayWh": 12.5, "weekWh": 80, "cpuUnavailable": null, "gpus": [{ "name": "RTX 4070", "w": 120 }] }));
        let old = power_report(&snap, now + 120_000);
        assert_eq!((old["totalW"].clone(), old["cpuW"].clone(), old["gpus"][0]["w"].clone(), old["todayWh"].clone()), (Value::Null, Value::Null, Value::Null, json!(12.5)));
        assert_eq!(power_report(&json!({}), now)["totalW"], Value::Null);
    }

    // "a node's report is checked: absurd, negative or wrong-typed values are unknown"
    #[test]
    fn a_nodes_report_is_checked() {
        let c = clean_report(&json!({ "cpuW": -1, "gpuW": "50", "totalW": 1e9, "todayWh": 5.0004, "weekWh": null, "cpuUnavailable": "mac", "gpus": [null, { "name": "A\u{0007}B", "w": 10 }, 5] }));
        assert_eq!(c, json!({ "cpuW": null, "gpuW": null, "totalW": null, "todayWh": 5, "weekWh": null, "cpuUnavailable": null, "gpus": [{ "name": "A B", "w": 10 }] }));
        assert_eq!(clean_report(&json!([1])), Value::Null);
        assert_eq!(clean_report(&Value::Null), Value::Null);
    }

    // "this server and its nodes add up; offline, stale and older nodes are listed but not counted"
    #[test]
    fn this_server_and_its_nodes_add_up() {
        let own = json!({ "cpuW": 30, "gpuW": 70, "totalW": 100, "todayWh": 500, "weekWh": 2000, "todayCost": 0.1, "weekCost": 0.5 });
        let nodes = vec![
            NodeRow { id: "a".into(), name: "Garage".into(), online: true, power: clean_report(&json!({ "cpuW": 20, "gpuW": 180, "totalW": 200, "todayWh": 250, "weekWh": 1000, "gpus": [{ "name": "RTX", "w": 180 }] })) },
            NodeRow { id: "b".into(), name: "Office".into(), online: false, power: clean_report(&json!({ "cpuW": 99, "gpuW": 99, "totalW": 198, "todayWh": 9, "weekWh": 9 })) },
            NodeRow { id: "c".into(), name: "Old".into(), online: true, power: Value::Null },
        ];
        let (rows, c) = combine(&own, &nodes, Some(0.3));
        let pick: Vec<Value> = rows.iter().map(|r| json!([r["name"], r["online"], r["known"], r["totalW"]])).collect();
        assert_eq!(pick, vec![json!(["Garage", true, true, 200]), json!(["Office", false, false, null]), json!(["Old", true, false, null])]);
        assert_eq!(rows[0]["gpus"], json!([{ "name": "RTX", "w": 180 }]));
        assert_eq!(json!([c["cpuW"], c["gpuW"], c["totalW"], c["todayWh"], c["weekWh"]]), json!([50, 250, 300, 750, 3000]));
        assert_eq!(c["todayCost"], 0.15);
        assert_eq!(c["weekCost"], 0.75);
        assert_eq!(json!([c["servers"], c["reporting"]]), json!([4, 2]));
        assert_eq!(combine(&own, &[], Some(0.3)), (vec![], Value::Null));
        let alone = combine(&json!({ "cpuW": null, "gpuW": null, "totalW": null, "todayWh": 0, "weekWh": 0, "todayCost": null, "weekCost": null }), &nodes[..1], Some(0.2)).1;
        assert_eq!(alone["totalW"], 200);
        assert_eq!(alone["todayCost"], 0.05);
    }
}
