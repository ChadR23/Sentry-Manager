//! How much background work runs at once (a port of server/workLimits.js),
//! picked from the memory and CPUs this container really has (its cgroup
//! limits, not the host's totals). An admin can set any of them by hand; the
//! `work-limits` setting holds only the ones set.

use serde_json::{json, Map, Value};

const GB: f64 = 1024.0 * 1024.0 * 1024.0;
pub const KEYS: [&str; 5] = ["speedIndex", "codecChecks", "scrubPreviews", "telemetryReads", "thumbnails"];
pub const MAX: [u32; 5] = [8, 32, 8, 8, 8];
const TIERS: [(&str, [u32; 5]); 3] = [("small", [1, 2, 1, 1, 1]), ("medium", [2, 4, 2, 1, 2]), ("big", [4, 8, 3, 2, 2])];
const BIG_MEMORY: f64 = 7.0 * GB;
const SMALL_MEMORY: f64 = 3.0 * GB;

#[derive(Debug, Clone, PartialEq)]
pub struct Resources {
    pub memory_bytes: f64,
    pub memory_from: &'static str,
    pub cpus: f64,
    pub cpus_from: &'static str,
}

/// The limits in use (pickLimits).
#[derive(Debug, Clone)]
pub struct Limits {
    pub limits: [u32; 5],
    pub auto: [u32; 5],
    pub over: Vec<(usize, u32)>,
    pub tier: &'static str,
    pub resources: Resources,
}

fn idx(key: &str) -> usize {
    KEYS.iter().position(|k| *k == key).expect("work limit key")
}

impl Limits {
    pub fn get(&self, key: &str) -> u32 {
        self.limits[idx(key)]
    }
    fn obj(vals: &[u32; 5]) -> Value {
        Value::Object(KEYS.iter().zip(vals).map(|(k, v)| (k.to_string(), json!(v))).collect())
    }
    /// workView() of index.js
    pub fn view(&self) -> Value {
        let mut over = Map::new();
        for (i, n) in &self.over {
            over.insert(KEYS[*i].into(), json!(n));
        }
        let r = &self.resources;
        json!({ "limits": Self::obj(&self.limits), "auto": Self::obj(&self.auto), "override": over, "tier": self.tier,
            "resources": { "memoryBytes": crate::inventory::num(r.memory_bytes), "memoryFrom": r.memory_from, "cpus": crate::inventory::num(r.cpus), "cpusFrom": r.cpus_from },
            "max": Self::obj(&MAX) })
    }
}

/// realLimit: cgroup v1 writes about 2^63 for "no limit"
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

fn num_of(s: &str) -> f64 {
    super::js::number_str(s)
}

pub fn cgroup_memory(read: &dyn Fn(&str) -> String) -> Option<f64> {
    let mut found = Vec::new();
    for dir in v2_dirs(read) {
        let v = read(&format!("{dir}/memory.max"));
        if !v.is_empty() {
            found.push(if v == "max" { None } else { real_limit(num_of(&v)) });
        }
    }
    let v1 = read("/sys/fs/cgroup/memory/memory.limit_in_bytes");
    found.push(real_limit(if v1.is_empty() { f64::NAN } else { num_of(&v1) }));
    found.into_iter().flatten().reduce(f64::min)
}

pub fn cgroup_cpus(read: &dyn Fn(&str) -> String) -> Option<f64> {
    let mut found = Vec::new();
    for dir in v2_dirs(read) {
        let v = read(&format!("{dir}/cpu.max"));
        let mut parts = v.split_whitespace();
        let (q, p) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        if !q.is_empty() && q != "max" && num_of(q) > 0.0 && num_of(p) > 0.0 {
            found.push(num_of(q) / num_of(p));
        }
    }
    for dir in ["/sys/fs/cgroup/cpu", "/sys/fs/cgroup/cpu,cpuacct"] {
        let q = read(&format!("{dir}/cpu.cfs_quota_us"));
        let p = read(&format!("{dir}/cpu.cfs_period_us"));
        let (q, p) = (if q.is_empty() { f64::NAN } else { num_of(&q) }, if p.is_empty() { f64::NAN } else { num_of(&p) });
        if q > 0.0 && p > 0.0 {
            found.push(q / p);
        }
    }
    found.into_iter().reduce(f64::min)
}

fn read_file(p: &str) -> String {
    std::fs::read_to_string(p).map(|s| s.trim().to_string()).unwrap_or_default()
}

/// os.totalmem() and os.availableParallelism() (the CPUs this process may run on)
fn host() -> (f64, f64) {
    let mut info: libc::sysinfo = unsafe { std::mem::zeroed() };
    let mem = if unsafe { libc::sysinfo(&mut info) } == 0 { info.totalram as f64 * info.mem_unit as f64 } else { 0.0 };
    let mut set: libc::cpu_set_t = unsafe { std::mem::zeroed() };
    let cpus = if unsafe { libc::sched_getaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &mut set) } == 0 {
        unsafe { libc::CPU_COUNT(&set) as f64 }
    } else {
        1.0
    };
    (mem, cpus.max(1.0))
}

pub fn detect_resources() -> Resources {
    let (host_mem, host_cpus) = host();
    resources_from(&read_file, host_mem, host_cpus)
}

pub fn resources_from(read: &dyn Fn(&str) -> String, host_mem: f64, host_cpus: f64) -> Resources {
    let mem = cgroup_memory(read);
    let cpu = cgroup_cpus(read);
    let memory_from = if mem.is_some_and(|m| host_mem == 0.0 || m < host_mem) { "container" } else { "host" };
    let cpus_from = if cpu.is_some_and(|c| c < host_cpus) { "container" } else { "host" };
    Resources {
        memory_bytes: if memory_from == "container" { mem.unwrap() } else { host_mem },
        memory_from,
        cpus: if cpus_from == "container" { super::js::js_round(cpu.unwrap() * 10.0) / 10.0 } else { host_cpus },
        cpus_from,
    }
}

pub fn tier_for(r: &Resources) -> &'static str {
    let mem = if r.memory_bytes == 0.0 || r.memory_bytes.is_nan() { 2 } else if r.memory_bytes >= BIG_MEMORY { 2 } else if r.memory_bytes >= SMALL_MEMORY { 1 } else { 0 };
    let cpu = if r.cpus >= 4.0 { 2 } else if r.cpus >= 3.0 { 1 } else { 0 };
    TIERS[mem.min(cpu)].0
}

fn safe_int(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
}

/// cleanOverride: only whole numbers in range
pub fn clean_override(raw: Option<&Value>) -> Vec<(usize, u32)> {
    let Some(Value::Object(o)) = raw else { return Vec::new() };
    let mut out = Vec::new();
    for (i, k) in KEYS.iter().enumerate() {
        if let Some(n) = o.get(*k).and_then(safe_int) {
            if n >= 1.0 && n <= MAX[i] as f64 {
                out.push((i, n as u32));
            }
        }
    }
    out
}

pub fn pick_limits(resources: Resources, raw: Option<&Value>) -> Limits {
    let tier = tier_for(&resources);
    let auto = TIERS.iter().find(|t| t.0 == tier).unwrap().1;
    let over = clean_override(raw);
    let mut limits = auto;
    for (i, n) in &over {
        limits[*i] = *n;
    }
    Limits { limits, auto, over, tier, resources }
}

/// parseOverride: the setting an admin sent, checked; Err with the message for the admin.
pub fn parse_override(body: &Value) -> Result<Value, String> {
    let mut out = Map::new();
    for (i, k) in KEYS.iter().enumerate() {
        let v = body.get(*k);
        let n = match v {
            None | Some(Value::Null) => continue,
            Some(Value::String(s)) if s.is_empty() => continue,
            Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
            Some(Value::String(s)) => {
                let t = s.trim_matches(|c: char| c.is_whitespace());
                if !t.is_empty() && t.bytes().all(|c| c.is_ascii_digit()) { super::js::number_str(s) } else { f64::NAN }
            }
            _ => f64::NAN,
        };
        if !(n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0) || n < 1.0 || n > MAX[i] as f64 {
            return Err(format!("{k} must be a whole number from 1 to {}, or empty for automatic.", MAX[i]));
        }
        out.insert(k.to_string(), json!(n as u64));
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn reader(files: &[(&str, &str)]) -> impl Fn(&str) -> String {
        let m: HashMap<String, String> = files.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        move |p: &str| m.get(p).cloned().unwrap_or_default()
    }

    #[test]
    fn tiers_from_memory_and_cpus() {
        let r = |m: f64, c: f64| Resources { memory_bytes: m * GB, memory_from: "host", cpus: c, cpus_from: "host" };
        assert_eq!(tier_for(&r(16.0, 8.0)), "big");
        assert_eq!(tier_for(&r(7.5, 4.0)), "big");
        assert_eq!(tier_for(&r(3.7, 4.0)), "medium");
        assert_eq!(tier_for(&r(16.0, 3.0)), "medium");
        assert_eq!(tier_for(&r(1.8, 8.0)), "small");
        assert_eq!(tier_for(&r(16.0, 2.0)), "small");
        assert_eq!(tier_for(&r(0.0, 8.0)), "big");
    }

    #[test]
    fn cgroup_v2_and_v1() {
        let rd = reader(&[("/proc/self/cgroup", "0::/docker/abc"), ("/sys/fs/cgroup/docker/abc/memory.max", "2147483648"), ("/sys/fs/cgroup/docker/abc/cpu.max", "250000 100000")]);
        assert_eq!(cgroup_memory(&rd), Some(2147483648.0));
        assert_eq!(cgroup_cpus(&rd), Some(2.5));
        let r = resources_from(&rd, 16.0 * GB, 8.0);
        assert_eq!((r.memory_from, r.cpus_from, r.cpus), ("container", "container", 2.5));
        assert_eq!(tier_for(&r), "small");
        let rd = reader(&[("/sys/fs/cgroup/memory.max", "max"), ("/sys/fs/cgroup/memory/memory.limit_in_bytes", "9223372036854771712")]);
        assert_eq!(cgroup_memory(&rd), None);
        let rd = reader(&[("/sys/fs/cgroup/cpu/cpu.cfs_quota_us", "-1"), ("/sys/fs/cgroup/cpu/cpu.cfs_period_us", "100000")]);
        assert_eq!(cgroup_cpus(&rd), None);
        let rd = reader(&[("/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us", "150000"), ("/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us", "100000")]);
        assert_eq!(cgroup_cpus(&rd), Some(1.5));
        let r = resources_from(&reader(&[]), 4.0 * GB, 4.0);
        assert_eq!((r.memory_from, r.cpus_from), ("host", "host"));
    }

    #[test]
    fn overrides() {
        let r = Resources { memory_bytes: 16.0 * GB, memory_from: "host", cpus: 8.0, cpus_from: "host" };
        let l = pick_limits(r.clone(), Some(&json!({ "speedIndex": 6, "thumbnails": 99, "codecChecks": 1.5, "x": 3 })));
        assert_eq!(l.get("speedIndex"), 6);
        assert_eq!(l.get("thumbnails"), 2);
        assert_eq!(l.get("codecChecks"), 8);
        assert_eq!(l.view()["override"], json!({ "speedIndex": 6 }));
        assert_eq!(parse_override(&json!({ "speedIndex": "3", "thumbnails": "", "codecChecks": null })).unwrap(), json!({ "speedIndex": 3 }));
        assert_eq!(parse_override(&json!({ "speedIndex": 9 })).unwrap_err(), "speedIndex must be a whole number from 1 to 8, or empty for automatic.");
        assert!(parse_override(&json!({ "speedIndex": "2.5" })).is_err());
        assert!(parse_override(&json!({ "speedIndex": true })).is_err());
        assert_eq!(parse_override(&json!({})).unwrap(), json!({}));
    }
}
