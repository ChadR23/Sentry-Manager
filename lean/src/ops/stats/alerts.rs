//! alerts.js: alerts with hysteresis: a condition must hold for 30 s before
//! it is raised, and it clears only once the value is back below a lower
//! mark for 30 s. Each raise is passed to `on_alert` once; the server turns
//! it into a notification and a log line.

use super::util::round;
use crate::ops::js::num_text;
use serde_json::{json, Value};

pub const HOLD_MS: i64 = 30000;

fn disk_limit(kind: &str) -> f64 {
    match kind {
        "hdd" => 55.0,
        _ => 70.0,
    }
}

fn disk_kind(kind: &str) -> &'static str {
    match kind {
        "nvme" => "NVMe disk",
        "ssd" => "SSD",
        "hdd" => "Hard disk",
        _ => "Disk",
    }
}

fn f(v: &Value) -> Option<f64> {
    v.as_f64()
}

/// Math.round(x) as text, the way a template string prints it (null: "null").
fn r(n: Option<f64>, digits: i32) -> String {
    round(n, digits).map_or_else(|| "null".into(), num_text)
}

fn pct_used(fs: &Value) -> Option<f64> {
    let total = f(&fs["totalB"]).filter(|t| *t > 0.0)?;
    let used = f(&fs["usedB"])?;
    // like df: used / (used + available), so the reserve for root counts as full
    let avail = f(&fs["freeB"]).filter(|x| x.is_finite()).unwrap_or(total - used);
    Some(used / (used + avail).max(1.0) * 100.0)
}

pub struct Rule {
    pub key: String,
    pub level: &'static str,
    pub value: Option<f64>,
    pub raise: f64,
    pub clear: f64,
    pub above: bool,
    pub message: String,
}

/// The rules, from one snapshot body.
pub fn rules(body: &Value) -> Vec<Rule> {
    let mut out = Vec::new();
    let mut push = |key: String, level: &'static str, value: Option<f64>, raise: f64, clear: f64, above: bool, message: String| out.push(Rule { key, level, value, raise, clear, above, message });
    let cpu_t = f(&body["cpu"]["tempC"]);
    push("cpu-temp".into(), "warn", cpu_t, 90.0, 85.0, true, format!("CPU at {} °C", r(cpu_t, 0)));
    let throttle = body.get("cpu").filter(|c| !c.is_null()).map(|c| if c["throttling"].as_bool() == Some(true) { 1.0 } else { 0.0 });
    push("cpu-throttle".into(), "warn", throttle, 1.0, 1.0, true, "The CPU is slowing itself down to stay cool (thermal throttling)".into());
    for g in body["gpus"].as_array().into_iter().flatten() {
        let name = g["name"].as_str().filter(|s| !s.is_empty()).unwrap_or("GPU");
        push(format!("gpu-temp:{}", crate::ops::js::to_string(&g["id"])), "warn", f(&g["tempC"]), 90.0, 85.0, true, format!("{name} at {} °C", r(f(&g["tempC"]), 0)));
    }
    for d in body["disks"].as_array().into_iter().flatten() {
        let kind = d["kind"].as_str().unwrap_or("other");
        let limit = disk_limit(kind);
        let name = crate::ops::js::to_string(&d["name"]);
        push(format!("disk-temp:{name}"), "warn", f(&d["tempC"]), limit, limit - 5.0, true, format!("{} {name} at {} °C", disk_kind(kind), r(f(&d["tempC"]), 0)));
    }
    for fs in body["filesystems"].as_array().into_iter().flatten() {
        let label = crate::ops::js::to_string(&fs["label"]);
        // a vehicle's share already has its own notifications for full and offline
        if fs["vehicle"].as_bool() != Some(true) {
            let pct = pct_used(fs);
            push(format!("fs-full:{label}"), "warn", pct, 90.0, 88.0, true, format!("{label} is {}% full", r(pct, 0)));
            let down = match fs["reachable"].as_bool() {
                Some(false) => Some(1.0),
                Some(true) => Some(0.0),
                None => None,
            };
            push(format!("share-down:{label}"), "error", down, 1.0, 1.0, true, format!("{label} is not reachable"));
        }
        let lat = f(&fs["latencyMs"]);
        let value = if fs["reachable"].as_bool() == Some(false) { None } else { lat };
        push(format!("share-slow:{label}"), "warn", value, 2000.001, 1500.0, true, format!("{label} answers slowly ({} s)", r(Some(lat.unwrap_or(0.0) / 1000.0), 1)));
    }
    let m = &body["memory"];
    let avail = match (f(&m["totalB"]), f(&m["availableB"])) {
        (Some(t), Some(a)) if t > 0.0 => Some(a / t * 100.0),
        _ => None,
    };
    push("memory-low".into(), "warn", avail, 5.0, 7.0, false, format!("Memory almost full: {}% available", r(avail, 1)));
    out
}

#[derive(Clone, Debug)]
struct State {
    key: String,
    raised: bool,
    since: Option<i64>,
    message: Option<String>,
    level: &'static str,
}

pub type OnAlert = Box<dyn Fn(&str, &str, &str) + Send + Sync>;
pub type OnClear = Box<dyn Fn(&str) + Send + Sync>;

pub struct Alerts {
    on_alert: Option<OnAlert>,
    on_clear: Option<OnClear>,
    state: Vec<State>,
}

impl Alerts {
    pub fn new(on_alert: Option<OnAlert>, on_clear: Option<OnClear>) -> Alerts {
        Alerts { on_alert, on_clear, state: Vec::new() }
    }

    /// Evaluate at time t; returns the raised alerts [{ key, level, message }].
    pub fn evaluate(&mut self, t: i64, body: &Value) -> Vec<Value> {
        let mut seen = Vec::new();
        // (key, Some((level, message))) for a raise, (key, None) for a clear, in the rules' order
        let mut events: Vec<(String, Option<(&'static str, String)>)> = Vec::new();
        for r in rules(body) {
            seen.push(r.key.clone());
            if !self.state.iter().any(|s| s.key == r.key) {
                self.state.push(State { key: r.key.clone(), raised: false, since: None, message: None, level: r.level });
            }
            let s = self.state.iter_mut().find(|s| s.key == r.key).unwrap();
            let Some(v) = r.value.filter(|v| v.is_finite()) else {
                // unknown this time: neither raises nor clears, and breaks a hold
                s.since = None;
                continue;
            };
            let over = if r.above { v >= r.raise } else { v <= r.raise };
            let under = if r.above { v < r.clear } else { v > r.clear };
            if !s.raised {
                if !over {
                    s.since = None;
                } else if s.since.is_none() {
                    s.since = Some(t);
                }
                if over && s.since.is_some_and(|since| t - since >= HOLD_MS) {
                    s.raised = true;
                    s.since = None;
                    s.level = r.level;
                    s.message = Some(r.message.clone());
                    events.push((r.key.clone(), Some((r.level, r.message.clone()))));
                }
            } else {
                if over {
                    s.message = Some(r.message.clone());
                }
                if !under {
                    s.since = None;
                } else if s.since.is_none() {
                    s.since = Some(t);
                }
                if under && s.since.is_some_and(|since| t - since >= HOLD_MS) {
                    s.raised = false;
                    s.since = None;
                    events.push((r.key.clone(), None));
                }
            }
        }
        // a disk, GPU or share that is gone takes its alert with it
        for s in &self.state {
            if !seen.contains(&s.key) && s.raised {
                events.push((s.key.clone(), None));
            }
        }
        self.state.retain(|s| seen.contains(&s.key));
        for (key, raise) in events {
            match (raise, &self.on_alert, &self.on_clear) {
                (Some((level, message)), Some(h), _) => h(&key, level, &message),
                (None, _, Some(h)) => h(&key),
                _ => {}
            }
        }
        self.list()
    }

    pub fn list(&self) -> Vec<Value> {
        let mut out: Vec<(&State, Value)> = self.state.iter().filter(|s| s.raised).map(|s| (s, json!({ "key": s.key, "level": s.level, "message": s.message }))).collect();
        out.sort_by(|a, b| {
            use std::cmp::Ordering;
            if a.0.level == b.0.level {
                Ordering::Equal
            } else if a.0.level == "error" {
                Ordering::Less
            } else {
                Ordering::Greater
            }
        });
        out.into_iter().map(|x| x.1).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn body(cpu_t: f64) -> Value {
        json!({ "cpu": { "tempC": cpu_t, "throttling": false }, "gpus": [], "disks": [], "filesystems": [], "memory": { "totalB": 100, "availableB": 50 } })
    }

    // test/statsAlerts.test.js "hysteresis: 30 s over 90 °C to raise, 30 s under 85 °C to clear, one call per raise"
    #[test]
    fn hysteresis() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (c1, c2) = (calls.clone(), calls.clone());
        let mut a = Alerts::new(Some(Box::new(move |k, l, m| c1.lock().unwrap().push(format!("raise {k} {l} {m}")))), Some(Box::new(move |k| c2.lock().unwrap().push(format!("clear {k}")))));
        let mut t = 0;
        for _ in 0..15 {
            a.evaluate(t, &body(92.0));
            t += 2000;
        }
        assert!(calls.lock().unwrap().is_empty(), "28 s over is not yet 30");
        let list = a.evaluate(t, &body(92.0));
        assert_eq!(list, vec![json!({ "key": "cpu-temp", "level": "warn", "message": "CPU at 92 °C" })]);
        a.evaluate(t + 2000, &body(93.0));
        assert_eq!(calls.lock().unwrap().len(), 1, "one call per raise");
        // between the marks: stays
        for k in 0..20 {
            a.evaluate(t + 4000 + k * 2000, &body(87.0));
        }
        assert_eq!(a.list().len(), 1);
        let t2 = t + 50_000;
        for k in 0..=15 {
            a.evaluate(t2 + k * 2000, &body(80.0));
        }
        assert_eq!(a.list().len(), 0);
        assert_eq!(calls.lock().unwrap().last().unwrap(), "clear cpu-temp");
    }

    // "each rule: disks by kind, full filesystems, low memory, throttling"
    #[test]
    fn each_rule() {
        let b = json!({
            "cpu": { "tempC": 50, "throttling": true }, "gpus": [{ "id": "card0", "name": null, "tempC": 95 }],
            "disks": [{ "name": "sda", "kind": "hdd", "tempC": 56 }, { "name": "nvme0n1", "kind": "nvme", "tempC": 66 }],
            "filesystems": [{ "label": "Data volume", "vehicle": false, "totalB": 100, "usedB": 91, "freeB": 9, "reachable": true, "latencyMs": 2500 }],
            "memory": { "totalB": 1000, "availableB": 40 }
        });
        let mut a = Alerts::new(None, None);
        a.evaluate(0, &b);
        let keys: Vec<String> = a.evaluate(30_000, &b).iter().map(|x| x["message"].as_str().unwrap().to_string()).collect();
        assert_eq!(keys, vec!["The CPU is slowing itself down to stay cool (thermal throttling)", "GPU at 95 °C", "Hard disk sda at 56 °C", "Data volume is 91% full", "Data volume answers slowly (2.5 s)", "Memory almost full: 4% available"]);
        // a disk that goes away takes its alert with it
        let mut gone = b.clone();
        gone["disks"] = json!([]);
        assert!(!a.evaluate(32_000, &gone).iter().any(|x| x["key"] == "disk-temp:sda"));
    }
}
