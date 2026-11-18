//! The settings routes of the "Other" group that are not ops's: general
//! settings and the look (/api/settings, /api/settings/appearance), the
//! Viewer's dashboards (/api/dashboards, index.js cleanBoards and
//! upgradeBoards) and the background work limits (server/workLimits.js,
//! /api/settings/work-limits).

use super::js;
use serde_json::{json, Map, Value};

// ---- /api/settings

/// GET /api/settings (power is shown here; its PUT is the power-price area's)
pub fn settings(appearance: Option<Value>, power: Option<Value>) -> Value {
    json!({
        "appearance": merged_appearance(appearance),
        "power": power.unwrap_or_else(|| json!({ "currency": "$", "mode": "flat", "pricePerKwh": null, "defaultPrice": null, "rates": [] }))
    })
}

/// { reduceEffects: false, clock24: false, ...saved }
pub fn merged_appearance(saved: Option<Value>) -> Value {
    let mut m = Map::new();
    m.insert("reduceEffects".into(), json!(false));
    m.insert("clock24".into(), json!(false));
    spread(&mut m, saved.as_ref());
    Value::Object(m)
}

/// `{ ...v }` into m (an array spreads its indexes, a string its letters; others nothing).
pub fn spread(m: &mut Map<String, Value>, v: Option<&Value>) {
    match v {
        Some(Value::Object(o)) => {
            for (k, x) in o {
                m.insert(k.clone(), x.clone());
            }
        }
        Some(Value::Array(a)) => {
            for (i, x) in a.iter().enumerate() {
                m.insert(i.to_string(), x.clone());
            }
        }
        Some(Value::String(s)) => {
            for (i, c) in s.encode_utf16().enumerate() {
                m.insert(i.to_string(), json!(String::from_utf16_lossy(&[c])));
            }
        }
        _ => {}
    }
}

/// PUT /api/settings/appearance: a field left out keeps its value. Err: `k in body` on a
/// value that is not an object (a TypeError: 500 on the Node server).
pub fn put_appearance(saved: Option<Value>, body: Option<&Value>) -> Result<Value, ()> {
    let mut next = merged_appearance(saved);
    if let Some(b) = body {
        for k in ["reduceEffects", "clock24"] {
            match b {
                Value::Object(o) => {
                    if let Some(v) = o.get(k) {
                        next[k] = json!(js::truthy(v));
                    }
                }
                Value::Array(_) => {}
                Value::Null | Value::Bool(false) => {}
                Value::Number(n) if n.as_f64() == Some(0.0) => {}
                Value::String(s) if s.is_empty() => {}
                _ => return Err(()),
            }
        }
    }
    Ok(next)
}

// ---- /api/dashboards

const DASH_REV: i64 = 2;

fn dash_type(t: &str) -> Option<usize> {
    match t {
        "small" | "gauge" | "state" => Some(1),
        "wide" => Some(3),
        "list" => Some(0),
        _ => None,
    }
}

/// upgradeBoards: a stat whose id now means something else, shown with the new id.
pub fn upgrade_boards(d: Option<Value>) -> Option<Value> {
    let d = d?;
    let rev = match d.get("rev").and_then(Value::as_f64) {
        Some(x) if x.is_finite() && x.fract() == 0.0 => x,
        _ => 1.0,
    };
    let Some(boards) = d.get("boards").and_then(Value::as_array) else { return Some(d) };
    if rev >= DASH_REV as f64 {
        return Some(d);
    }
    let renamed = |id: &Value| -> Value {
        if rev < 2.0 && id.as_str() == Some("can.v12vBattCurrent261") {
            json!("can.PCS_dcdcLvOutputCurrent")
        } else {
            id.clone()
        }
    };
    let boards: Vec<Value> = boards
        .iter()
        .map(|b| {
            let mut m = Map::new();
            if let Value::Object(_) | Value::Array(_) | Value::String(_) = b {
                spread(&mut m, Some(b));
            }
            let blocks: Vec<Value> = b
                .get("blocks")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .map(|x| match x.get("signals").and_then(Value::as_array) {
                            Some(sig) => {
                                let mut o = Map::new();
                                spread(&mut o, Some(x));
                                o.insert("signals".into(), Value::Array(sig.iter().map(renamed).collect()));
                                Value::Object(o)
                            }
                            None => x.clone(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            m.insert("blocks".into(), Value::Array(blocks));
            Value::Object(m)
        })
        .collect();
    let mut out = Map::new();
    spread(&mut out, Some(&d));
    out.insert("rev".into(), json!(DASH_REV));
    out.insert("boards".into(), Value::Array(boards));
    Some(Value::Object(out))
}

/// GET /api/dashboards: the account's boards (or none) and whether car data is shown.
pub fn dashboards(saved: Option<Value>, car_data: Value) -> Value {
    let mut m = Map::new();
    match upgrade_boards(saved).filter(js::truthy) {
        Some(v) => spread(&mut m, Some(&v)),
        None => {
            m.insert("boards".into(), json!([]));
            m.insert("active".into(), Value::Null);
        }
    }
    m.insert("carData".into(), car_data);
    Value::Object(m)
}

fn finite(v: Option<&Value>) -> Option<f64> {
    js::finite(v)
}

fn share(v: f64) -> Value {
    js::num(v.min(1.0).max(0.0) + 0.0)
}

fn px(v: f64) -> Value {
    js::num(js::round(v.min(100_000.0).max(-100_000.0)))
}

fn anchored(a: Option<&Value>) -> bool {
    let Some(a) = a else { return false };
    let h = a.get("h").and_then(Value::as_str);
    let v = a.get("v").and_then(Value::as_str);
    matches!(h, Some("l" | "r" | "R")) && matches!(v, Some("t" | "b" | "B")) && finite(a.get("dx")).is_some() && finite(a.get("dy")).is_some()
}

fn clean_anchor(a: &Value, m: &mut Map<String, Value>) {
    m.insert("h".into(), a["h"].clone());
    m.insert("v".into(), a["v"].clone());
    m.insert("dx".into(), px(a["dx"].as_f64().unwrap()));
    m.insert("dy".into(), px(a["dy"].as_f64().unwrap()));
}

fn clean_spots(o: Option<&Value>) -> Value {
    let mut out = Map::new();
    for k in ["wide", "narrow"] {
        let p = o.and_then(|o| o.as_object()).and_then(|o| o.get(k));
        let xy = matches!((p.and_then(|p| finite(p.get("x"))), p.and_then(|p| finite(p.get("y")))), (Some(_), Some(_)));
        if !(xy || anchored(p)) {
            continue;
        }
        let p = p.unwrap();
        let mut m = Map::new();
        if xy {
            m.insert("x".into(), share(p["x"].as_f64().unwrap()));
            m.insert("y".into(), share(p["y"].as_f64().unwrap()));
        }
        if let Some(t) = finite(p.get("top")) {
            m.insert("top".into(), js::num(js::round(t.min(100_000.0).max(0.0))));
        }
        if anchored(Some(p)) {
            clean_anchor(p, &mut m);
            m.insert("over".into(), json!(p.get("over") == Some(&Value::Bool(true))));
            if anchored(p.get("bar")) {
                let mut b = Map::new();
                clean_anchor(&p["bar"], &mut b);
                m.insert("bar".into(), Value::Object(b));
            }
        }
        out.insert(k.into(), Value::Object(m));
    }
    Value::Object(out)
}

fn clean_sizes(o: Option<&Value>) -> Value {
    let mut out = Map::new();
    for k in ["wide", "narrow"] {
        let z = o.and_then(|o| o.as_object()).and_then(|o| o.get(k));
        let w = z.and_then(|z| finite(z.get("w")));
        let h = z.and_then(|z| finite(z.get("h")));
        if w.is_none() && h.is_none() {
            continue;
        }
        let mut m = Map::new();
        if let Some(w) = w {
            m.insert("w".into(), js::num(js::round(w.min(8000.0).max(120.0))));
        }
        if let Some(h) = h {
            m.insert("h".into(), js::num(js::round(h.min(8000.0).max(40.0))));
        }
        out.insert(k.into(), Value::Object(m));
    }
    Value::Object(out)
}

/// .replace(/[\u0000-\u001f]/g, ' ')
fn no_controls(s: &str) -> String {
    s.chars().map(|c| if (c as u32) < 0x20 { ' ' } else { c }).collect()
}

fn word_id(s: &str, max: usize, extra: &str) -> bool {
    let n = s.encode_utf16().count();
    n >= 1 && n <= max && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || extra.contains(c))
}

/// cleanBoards: what a page sends, kept to what a dashboard can hold. Err: none sent.
pub fn clean_boards(body: Option<&Value>) -> Result<Value, String> {
    let list = body.and_then(|b| b.get("boards")).and_then(Value::as_array).cloned().unwrap_or_default();
    let mut boards = Vec::new();
    for (i, b) in list.iter().take(12).enumerate() {
        let id_s = b.get("id").map_or("undefined".to_string(), js::string);
        let mut m = Map::new();
        m.insert("id".into(), json!(if word_id(&id_s, 24, "-") { id_s } else { format!("b{i}") }));
        let name = match b.get("name") {
            None | Some(Value::Null) => "Dashboard".to_string(),
            Some(v) => js::string(v),
        };
        let name = super::packs::js_slice(super::packs::js_trim(&no_controls(&name)), 40);
        m.insert("name".into(), json!(if name.is_empty() { "Dashboard".to_string() } else { name }));
        let placement = b.get("placement").and_then(Value::as_str).filter(|p| *p == "over" || *p == "float").unwrap_or("below");
        m.insert("placement".into(), json!(placement));
        m.insert("barHome".into(), json!(if b.get("barHome").and_then(Value::as_str) == Some("over") { "over" } else { "below" }));
        m.insert("float".into(), clean_spots(b.get("float")));
        m.insert("size".into(), clean_sizes(b.get("size")));
        m.insert("listPlacement".into(), json!(if b.get("listPlacement").and_then(Value::as_str) == Some("float") { "float" } else { "dock" }));
        m.insert("listFloat".into(), clean_spots(b.get("listFloat")));
        m.insert("listSize".into(), clean_sizes(b.get("listSize")));
        m.insert("metric".into(), b.get("metric").filter(|v| v.is_boolean()).cloned().unwrap_or(Value::Null));
        let blocks: Vec<Value> = b
            .get("blocks")
            .and_then(Value::as_array)
            .map(|a| a.iter().take(32).cloned().collect::<Vec<_>>())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|x| {
                let t = x.get("type").map_or("undefined".to_string(), js::string);
                let n = dash_type(&t)?;
                let signals: Vec<Value> = x
                    .get("signals")
                    .and_then(Value::as_array)
                    .map(|s| s.iter().take(n).map(js::string).filter(|id| word_id(id, 80, ".:-")).map(Value::String).collect())
                    .unwrap_or_default();
                let mut o = Map::new();
                o.insert("type".into(), x["type"].clone());
                o.insert("signals".into(), Value::Array(signals));
                if x.get("type").and_then(Value::as_str) == Some("list") {
                    let q = match x.get("q") {
                        None | Some(Value::Null) => String::new(),
                        Some(v) => js::string(v),
                    };
                    o.insert("q".into(), json!(super::packs::js_slice(&no_controls(&q), 60)));
                    o.insert("changing".into(), json!(x.get("changing") == Some(&Value::Bool(true))));
                }
                Some(Value::Object(o))
            })
            .collect();
        m.insert("blocks".into(), Value::Array(blocks));
        boards.push(Value::Object(m));
    }
    if boards.is_empty() {
        return Err("Send at least one dashboard.".into());
    }
    let wanted = body.and_then(|b| b.get("active"));
    let active = match wanted {
        Some(Value::String(a)) if boards.iter().any(|b| b["id"].as_str() == Some(a)) => json!(a),
        _ => boards[0]["id"].clone(),
    };
    Ok(json!({ "boards": boards, "active": active, "rev": DASH_REV }))
}

// ---- server/workLimits.js

const GB: f64 = 1024.0 * 1024.0 * 1024.0;
pub const KEYS: [&str; 5] = ["speedIndex", "codecChecks", "scrubPreviews", "telemetryReads", "thumbnails"];

fn max_of(k: &str) -> i64 {
    match k {
        "codecChecks" => 32,
        _ => 8,
    }
}

fn tier_values(t: &str) -> [i64; 5] {
    match t {
        "small" => [1, 2, 1, 1, 1],
        "medium" => [2, 4, 2, 1, 2],
        _ => [4, 8, 3, 2, 2],
    }
}

#[derive(Debug, Clone)]
pub struct Resources {
    pub memory_bytes: f64,
    pub memory_from: &'static str,
    pub cpus: f64,
    pub cpus_from: &'static str,
}

fn read(p: &str) -> String {
    std::fs::read_to_string(p).map(|s| s.trim().to_string()).unwrap_or_default()
}

fn real_limit(n: f64) -> Option<f64> {
    (n.is_finite() && n > 0.0 && n < 2f64.powi(60)).then_some(n)
}

fn v2_dirs(read: &dyn Fn(&str) -> String) -> Vec<String> {
    let cg = read("/proc/self/cgroup");
    let own = cg.lines().find_map(|l| l.strip_prefix("0::")).filter(|p| p.starts_with('/') && !p.contains(char::is_whitespace) && *p != "/").map(|p| format!("/sys/fs/cgroup{p}"));
    match own {
        Some(o) => vec![o, "/sys/fs/cgroup".into()],
        None => vec!["/sys/fs/cgroup".into()],
    }
}

pub fn cgroup_memory(read: &dyn Fn(&str) -> String) -> Option<f64> {
    let mut found = Vec::new();
    for dir in v2_dirs(read) {
        let v = read(&format!("{dir}/memory.max"));
        if !v.is_empty() {
            found.push(if v == "max" { None } else { real_limit(js::string_number(&v)) });
        }
    }
    let v1 = read("/sys/fs/cgroup/memory/memory.limit_in_bytes");
    found.push(real_limit(if v1.is_empty() { f64::NAN } else { js::string_number(&v1) }));
    found.into_iter().flatten().reduce(f64::min)
}

pub fn cgroup_cpus(read: &dyn Fn(&str) -> String) -> Option<f64> {
    let mut found = Vec::new();
    for dir in v2_dirs(read) {
        let v = read(&format!("{dir}/cpu.max"));
        let mut parts = v.split_whitespace();
        let (q, p) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        let (qn, pn) = (js::string_number(q), if p.is_empty() { f64::NAN } else { js::string_number(p) });
        if !q.is_empty() && q != "max" && qn > 0.0 && pn > 0.0 {
            found.push(qn / pn);
        }
    }
    for dir in ["/sys/fs/cgroup/cpu", "/sys/fs/cgroup/cpu,cpuacct"] {
        let num = |f: &str| {
            let v = read(&format!("{dir}/{f}"));
            if v.is_empty() { f64::NAN } else { js::string_number(&v) }
        };
        let (q, p) = (num("cpu.cfs_quota_us"), num("cpu.cfs_period_us"));
        if q > 0.0 && p > 0.0 {
            found.push(q / p);
        }
    }
    found.into_iter().reduce(f64::min)
}

fn host_memory() -> f64 {
    read("/proc/meminfo")
        .lines()
        .find_map(|l| l.strip_prefix("MemTotal:"))
        .and_then(|v| v.trim().trim_end_matches("kB").trim().parse::<f64>().ok())
        .map_or(0.0, |kb| kb * 1024.0)
}

fn host_cpus() -> f64 {
    unsafe {
        let mut set: libc::cpu_set_t = std::mem::zeroed();
        if libc::sched_getaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &mut set) == 0 {
            let n = libc::CPU_COUNT(&set);
            if n > 0 {
                return n as f64;
            }
        }
    }
    std::thread::available_parallelism().map_or(1.0, |n| n.get() as f64)
}

/// detectResources: this container's memory and CPUs (its cgroup limits, else the host's).
pub fn detect_resources() -> Resources {
    let host_mem = host_memory();
    let host_cpu = host_cpus();
    let mem = cgroup_memory(&read);
    let cpu = cgroup_cpus(&read);
    let memory_from = if mem.is_some_and(|m| host_mem == 0.0 || m < host_mem) { "container" } else { "host" };
    let cpus_from = if cpu.is_some_and(|c| c < host_cpu) { "container" } else { "host" };
    Resources {
        memory_bytes: if memory_from == "container" { mem.unwrap() } else { host_mem },
        memory_from,
        cpus: if cpus_from == "container" { js::round(cpu.unwrap() * 10.0) / 10.0 } else { host_cpu },
        cpus_from,
    }
}

pub fn tier_for(r: &Resources) -> &'static str {
    let mem = if r.memory_bytes == 0.0 || r.memory_bytes >= 7.0 * GB { 2 } else if r.memory_bytes >= 3.0 * GB { 1 } else { 0 };
    let cpu = if r.cpus >= 4.0 { 2 } else if r.cpus >= 3.0 { 1 } else { 0 };
    ["small", "medium", "big"][mem.min(cpu)]
}

pub fn clean_override(raw: Option<&Value>) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(Value::Object(raw)) = raw else { return out };
    for k in KEYS {
        if let Some(n) = js::safe_integer(raw.get(k)) {
            if n >= 1 && n <= max_of(k) {
                out.insert(k.into(), json!(n));
            }
        }
    }
    out
}

/// parseOverride: each key a whole number in range, or null / '' for automatic.
pub fn parse_override(body: Option<&Value>) -> Result<Map<String, Value>, String> {
    let mut out = Map::new();
    for k in KEYS {
        let v = body.and_then(|b| b.as_object()).and_then(|b| b.get(k));
        match v {
            None | Some(Value::Null) => continue,
            Some(Value::String(s)) if s.is_empty() => continue,
            _ => {}
        }
        let v = v.unwrap();
        let n = match v {
            Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
            Value::String(s) if !s.trim().is_empty() && s.trim().bytes().all(|c| c.is_ascii_digit()) => js::string_number(s),
            _ => f64::NAN,
        };
        let max = max_of(k);
        if !(n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0) || n < 1.0 || n > max as f64 {
            return Err(format!("{k} must be a whole number from 1 to {max}, or empty for automatic."));
        }
        out.insert(k.into(), json!(n as i64));
    }
    Ok(out)
}

/// pickLimits: { limits, auto, override, tier, resources, max }
pub fn pick_limits(r: &Resources, saved: Option<&Value>) -> Value {
    let tier = tier_for(r);
    let vals = tier_values(tier);
    let mut auto = Map::new();
    for (k, v) in KEYS.iter().zip(vals) {
        auto.insert((*k).into(), json!(v));
    }
    let set = clean_override(saved);
    let mut limits = auto.clone();
    for (k, v) in &set {
        limits.insert(k.clone(), v.clone());
    }
    let mut max = Map::new();
    for k in KEYS {
        max.insert(k.into(), json!(max_of(k)));
    }
    json!({
        "limits": limits, "auto": auto, "override": set, "tier": tier,
        "resources": { "memoryBytes": js::num(r.memory_bytes), "memoryFrom": r.memory_from, "cpus": js::num(r.cpus), "cpusFrom": r.cpus_from },
        "max": max
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean(v: Value) -> Value {
        clean_boards(Some(&v)).unwrap()
    }

    // test/server.test.js: Viewer dashboards
    #[test]
    fn boards_are_cleaned() {
        let got = clean(json!({ "active": "b2", "boards": [
            { "id": "b1", "name": "Drive", "placement": "below", "blocks": [{ "type": "gauge", "signals": ["dash.speed"] }, { "type": "wide", "signals": ["a", "b", "c", "d"] }, { "type": "evil", "signals": ["x"] }] },
            { "id": "b2", "name": "  Battery\nnerd ", "placement": "sideways", "metric": true, "blocks": [{ "type": "small", "signals": ["can.BattVoltage132", "<script>"] }] }
        ] }));
        assert_eq!(got["active"], "b2");
        assert_eq!(got["boards"][0]["blocks"], json!([{ "type": "gauge", "signals": ["dash.speed"] }, { "type": "wide", "signals": ["a", "b", "c"] }]));
        let b1 = &got["boards"][1];
        assert_eq!(json!([b1["name"], b1["placement"], b1["metric"], b1["blocks"][0]["signals"]]), json!(["Battery nerd", "below", true, ["can.BattVoltage132"]]));
        assert!(clean_boards(Some(&json!({ "boards": [] }))).is_err());
        let fl = clean(json!({ "active": "f", "boards": [{ "id": "f", "name": "Float", "placement": "float", "float": { "wide": { "x": 0.25, "y": 0.1 }, "narrow": { "x": 7, "y": -2 }, "huge": { "x": 1, "y": 1 } }, "blocks": [] }] }));
        assert_eq!(json!([fl["boards"][0]["placement"], fl["boards"][0]["float"]]), json!(["float", { "wide": { "x": 0.25, "y": 0.1 }, "narrow": { "x": 1, "y": 0 } }]));
        let lb = clean(json!({ "boards": [{ "id": "l", "listPlacement": "float", "listFloat": { "wide": { "x": 0.9, "y": 0.2 }, "narrow": { "x": -3, "y": 9 }, "other": { "x": 0, "y": 0 } }, "blocks": [] }, { "id": "m", "listPlacement": "sideways", "blocks": [] }] }));
        assert_eq!(lb["boards"][0]["listFloat"], json!({ "wide": { "x": 0.9, "y": 0.2 }, "narrow": { "x": 0, "y": 1 } }));
        assert_eq!(json!([lb["boards"][1]["listPlacement"], lb["boards"][1]["listFloat"]]), json!(["dock", {}]));
        let pg = clean(json!({ "boards": [{ "id": "p", "placement": "float", "barHome": "over",
            "float": { "wide": { "x": 0.5, "y": 0.2, "top": 1234.6 }, "narrow": { "x": 0.1, "y": 0.1, "top": -50 } },
            "listFloat": { "wide": { "x": 0.3, "y": 0.4, "top": 9e9 }, "narrow": { "x": 0.3, "y": 0.4, "top": "high" } },
            "size": { "wide": { "w": 640.4, "h": 210 }, "narrow": { "h": 5 }, "other": { "w": 1, "h": 1 } },
            "listSize": { "wide": { "w": 99999, "h": "tall" }, "narrow": { "w": "x" } }, "blocks": [] }, { "id": "q", "barHome": "sideways", "blocks": [] }] }));
        let p0 = &pg["boards"][0];
        assert_eq!(json!([p0["barHome"], pg["boards"][1]["barHome"]]), json!(["over", "below"]));
        assert_eq!(p0["float"], json!({ "wide": { "x": 0.5, "y": 0.2, "top": 1235 }, "narrow": { "x": 0.1, "y": 0.1, "top": 0 } }));
        assert_eq!(p0["listFloat"], json!({ "wide": { "x": 0.3, "y": 0.4, "top": 100000 }, "narrow": { "x": 0.3, "y": 0.4 } }));
        assert_eq!(p0["size"], json!({ "wide": { "w": 640, "h": 210 }, "narrow": { "h": 40 } }));
        assert_eq!(p0["listSize"], json!({ "wide": { "w": 8000 } }));
        let an = clean(json!({ "boards": [{ "id": "a", "placement": "float", "listPlacement": "float",
            "float": { "wide": { "x": 0.5, "y": 0.2, "top": 700, "h": "r", "v": "b", "dx": 20.4, "dy": -190, "over": true }, "narrow": { "h": "l", "v": "t", "dx": 9e9, "dy": -9e9, "over": "yes" } },
            "listFloat": { "wide": { "h": "R", "v": "t", "dx": 20, "dy": 0, "over": false, "bar": { "h": "l", "v": "B", "dx": 0, "dy": 8, "extra": 1 } }, "narrow": { "h": "x", "v": "t", "dx": 0, "dy": 0 } },
            "blocks": [] }, { "id": "b", "float": { "wide": { "h": "l", "v": "t", "dx": "far", "dy": 0 } }, "listFloat": { "wide": { "x": 0.1, "y": 0.1, "h": "l", "v": "t", "dx": 1, "dy": 2, "bar": { "h": "q" } } }, "blocks": [] }] }));
        assert_eq!(an["boards"][0]["float"], json!({ "wide": { "x": 0.5, "y": 0.2, "top": 700, "h": "r", "v": "b", "dx": 20, "dy": -190, "over": true }, "narrow": { "h": "l", "v": "t", "dx": 100000, "dy": -100000, "over": false } }));
        assert_eq!(an["boards"][0]["listFloat"], json!({ "wide": { "h": "R", "v": "t", "dx": 20, "dy": 0, "over": false, "bar": { "h": "l", "v": "B", "dx": 0, "dy": 8 } } }));
        assert_eq!(json!([an["boards"][1]["float"], an["boards"][1]["listFloat"]]), json!([{}, { "wide": { "x": 0.1, "y": 0.1, "h": "l", "v": "t", "dx": 1, "dy": 2, "over": false } }]));
        let li = clean(json!({ "boards": [{ "id": "l", "blocks": [{ "type": "list", "signals": ["a"], "q": "volt\u{7}age", "changing": true }, { "type": "toString", "signals": [] }] }] }));
        assert_eq!(li["boards"][0]["blocks"], json!([{ "type": "list", "signals": [], "q": "volt age", "changing": true }]));
        // a board without an id: String(undefined) is a valid id on the Node server too
        assert_eq!(clean(json!({ "boards": [{}] }))["boards"][0]["id"], "undefined");
    }

    #[test]
    fn old_boards_get_the_new_ids() {
        let saved = json!({ "active": "d", "boards": [{ "id": "d", "name": "Drive", "placement": "below", "blocks": [
            { "type": "small", "signals": ["can.v12vBattCurrent261"] },
            { "type": "wide", "signals": ["dash.speed", "can.v12vBattCurrent261", "can.v12vBattVoltage261"] },
            { "type": "list", "signals": [], "q": "12v", "changing": false }] }] });
        let got = dashboards(Some(saved), json!({ "enabled": false }));
        assert_eq!(got["rev"], 2);
        assert_eq!(got["boards"][0]["blocks"], json!([
            { "type": "small", "signals": ["can.PCS_dcdcLvOutputCurrent"] },
            { "type": "wide", "signals": ["dash.speed", "can.PCS_dcdcLvOutputCurrent", "can.v12vBattVoltage261"] },
            { "type": "list", "signals": [], "q": "12v", "changing": false }]));
        let now = clean(json!({ "active": "d", "boards": [{ "id": "d", "blocks": [{ "type": "small", "signals": ["can.v12vBattCurrent261"] }] }] }));
        assert_eq!(dashboards(Some(now), json!(null))["boards"][0]["blocks"][0]["signals"][0], "can.v12vBattCurrent261");
        assert_eq!(dashboards(None, json!({ "enabled": false })), json!({ "boards": [], "active": null, "carData": { "enabled": false } }));
    }

    #[test]
    fn appearance() {
        assert_eq!(put_appearance(Some(json!({ "clock24": true })), Some(&json!({ "reduceEffects": 1 }))).unwrap(), json!({ "reduceEffects": true, "clock24": true }));
        assert!(put_appearance(None, Some(&json!(5))).is_err());
        assert_eq!(settings(None, None)["power"]["currency"], "$");
    }

    // test/workLimits.test.js (the parts the route uses)
    #[test]
    fn work_limits() {
        let r = |m: f64, c: f64| Resources { memory_bytes: m * GB, memory_from: "host", cpus: c, cpus_from: "host" };
        assert_eq!(tier_for(&r(1.0, 4.0)), "small");
        assert_eq!(tier_for(&r(3.7, 4.0)), "medium");
        assert_eq!(tier_for(&r(16.0, 2.0)), "small");
        assert_eq!(tier_for(&r(16.0, 8.0)), "big");
        assert_eq!(tier_for(&r(0.0, 8.0)), "big");
        assert_eq!(parse_override(Some(&json!({ "speedIndex": " 3 ", "codecChecks": null, "thumbnails": "" }))).unwrap(), json!({ "speedIndex": 3 }).as_object().unwrap().clone());
        assert!(parse_override(Some(&json!({ "codecChecks": 33 }))).unwrap_err().contains("codecChecks must be a whole number from 1 to 32"));
        assert!(parse_override(Some(&json!({ "speedIndex": 1.5 }))).is_err());
        let v = pick_limits(&r(16.0, 8.0), Some(&json!({ "speedIndex": 1, "thumbnails": 99 })));
        assert_eq!(v["limits"]["speedIndex"], 1);
        assert_eq!(v["override"], json!({ "speedIndex": 1 }));
        assert_eq!(v["tier"], "big");
        let fake = |p: &str| match p {
            "/proc/self/cgroup" => "0::/docker/abc".to_string(),
            "/sys/fs/cgroup/docker/abc/memory.max" => "2147483648".into(),
            "/sys/fs/cgroup/docker/abc/cpu.max" => "150000 100000".into(),
            "/sys/fs/cgroup/memory.max" => "max".into(),
            _ => String::new(),
        };
        assert_eq!(cgroup_memory(&fake), Some(2.0 * GB));
        assert_eq!(cgroup_cpus(&fake), Some(1.5));
    }
}
