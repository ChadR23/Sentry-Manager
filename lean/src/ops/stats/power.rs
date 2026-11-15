//! power.js: power in watts. The CPU package comes from the RAPL energy
//! counters: read here when the app may read them, otherwise sent by the
//! root supervisor (`rapl-reading`, set_rapl), since kernels after 5.10 let
//! only root read them. W = energy used / time between two readings, across
//! the counter's wrap-around. A server with two CPU sockets has a package
//! zone per socket: summed for the CPU, and also shown per socket.

use super::util::*;
use crate::ops::js::num as jnum;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq)]
pub struct Package {
    pub name: String,
    pub energy_uj: Option<f64>,
    pub max_energy_uj: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Reading {
    pub at: f64,
    pub packages: Vec<Package>,
}

/// µJ used between two readings of a counter that wraps after max.
pub fn energy_delta(prev: Option<f64>, cur: Option<f64>, max: Option<f64>) -> Option<f64> {
    let (p, c) = (prev.filter(|x| x.is_finite())?, cur.filter(|x| x.is_finite())?);
    if p < 0.0 || c < 0.0 {
        return None;
    }
    let mut d = c - p;
    if d < 0.0 {
        let m = max.filter(|m| *m > 0.0)?;
        if p > m {
            return None;
        }
        d += m;
    }
    Some(d)
}

fn zone_watts(prev: Option<&Reading>, cur: Option<&Reading>) -> Option<Vec<(String, f64)>> {
    let (prev, cur) = (prev?, cur?);
    let dt = (cur.at - prev.at) / 1000.0;
    if !(dt > 0.0) || dt > 60.0 {
        return None;
    }
    let mut out = Vec::new();
    for p in &cur.packages {
        if !p.name.starts_with("package") {
            continue;
        }
        let Some(before) = prev.packages.iter().find(|x| x.name == p.name) else { continue };
        let Some(d) = energy_delta(before.energy_uj, p.energy_uj, p.max_energy_uj.or(before.max_energy_uj)) else { continue };
        out.push((p.name.clone(), d / 1e6 / dt));
    }
    Some(out)
}

/// CPU package watts between two readings: every package (socket) together.
pub fn package_watts(prev: Option<&Reading>, cur: Option<&Reading>) -> Option<f64> {
    let zones = zone_watts(prev, cur)?;
    let mut total = None;
    for (_, w) in zones {
        if w > 1000.0 {
            return None;
        }
        total = Some(total.unwrap_or(0.0) + w);
    }
    total
}

/// W per socket: "package-1" is socket 1 (with its dies together).
pub fn socket_watts(prev: Option<&Reading>, cur: Option<&Reading>) -> BTreeMap<i64, f64> {
    let mut out = BTreeMap::new();
    if package_watts(prev, cur).is_none() {
        return out;
    }
    for (name, w) in zone_watts(prev, cur).unwrap_or_default() {
        if let Some(n) = re!(r"^package-(\d+)(?:-die-\d+)?$").group(&name, 1) {
            *out.entry(n.parse().unwrap_or(0)).or_insert(0.0) += w;
        }
    }
    out
}

/// The supervisor's message ({ at, packages: [{ name, energyUj, maxEnergyUj }] }), checked.
pub fn clean_reading(r: &Value) -> Option<Reading> {
    let at = crate::ops::js::number_opt(r.get("at"));
    let list = r.get("packages")?.as_array()?;
    if !at.is_finite() {
        return None;
    }
    let packages: Vec<Package> = list
        .iter()
        .take(16)
        .map(|p| {
            let name = match p.get("name") {
                None | Some(Value::Null) => String::new(),
                Some(v) => crate::ops::js::to_string(v),
            };
            let e = crate::ops::js::number_opt(p.get("energyUj"));
            let m = crate::ops::js::number_opt(p.get("maxEnergyUj"));
            Package { name, energy_uj: Some(e), max_energy_uj: (m.is_finite() && m != 0.0).then_some(m) }
        })
        .filter(|p| p.energy_uj.is_some_and(|e| e.is_finite()))
        .collect();
    (!packages.is_empty()).then_some(Reading { at, packages })
}

/// Why the CPU's watts cannot be read: 'windows', 'vm' or None.
pub fn cpu_unavailable(cpu_w: Option<f64>, wsl: bool, virtual_: bool) -> Option<&'static str> {
    if cpu_w.is_some() {
        return None;
    }
    if wsl {
        return Some("windows");
    }
    if virtual_ {
        return Some("vm");
    }
    None
}

struct Zone {
    name: String,
    energy: PathBuf,
    max: Option<f64>,
}

#[derive(Default, Clone)]
struct Pair {
    prev: Option<Reading>,
    cur: Option<Reading>,
}

pub struct PowerProvider {
    sys_root: PathBuf,
    interval_ms: i64,
    zones: Vec<Zone>,
    pub direct: bool,
    readings: Pair,
    sent: Pair,
    used: Pair,
}

/// One GPU's power as the power sum sees it.
pub struct GpuPower {
    pub power_w: Option<f64>,
    pub integrated: bool,
    pub source: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PowerSample {
    pub total_w: Option<f64>,
    pub cpu_w: Option<f64>,
    pub gpu_w: Option<f64>,
    pub chip_w: Option<f64>,
    pub discrete_w: Option<f64>,
    pub cpu_source: Option<&'static str>,
    pub gpu_source: Option<String>,
}

impl PowerSample {
    pub fn fields(&self) -> Vec<(&'static str, Value)> {
        let n = |x: Option<f64>| x.map_or(Value::Null, jnum);
        vec![("totalW", n(self.total_w)), ("cpuW", n(self.cpu_w)), ("gpuW", n(self.gpu_w)), ("chipW", n(self.chip_w)), ("discreteW", n(self.discrete_w)), ("cpuSource", json!(self.cpu_source)), ("gpuSource", json!(self.gpu_source))]
    }
}

impl PowerProvider {
    pub fn new(sys_root: &Path, interval_ms: i64) -> PowerProvider {
        PowerProvider { sys_root: sys_root.into(), interval_ms, zones: Vec::new(), direct: false, readings: Pair::default(), sent: Pair::default(), used: Pair::default() }
    }

    pub fn probe(&mut self) {
        let dir = self.sys_root.join("class/powercap");
        let mut names: Vec<String> = list_dir(&dir, 4096).into_iter().filter(|n| re!(r"^intel-rapl:\d+$").is(n)).collect();
        names.sort();
        self.zones = names
            .into_iter()
            .map(|z| Zone { name: read_line(dir.join(&z).join("name")).unwrap_or_else(|| z.clone()), energy: dir.join(&z).join("energy_uj"), max: read_num(dir.join(&z).join("max_energy_range_uj")) })
            .filter(|z| z.name.starts_with("package"))
            .collect();
        self.direct = !self.zones.is_empty() && self.zones.iter().all(|z| read_num(&z.energy).is_some());
    }

    /// The supervisor's latest reading.
    pub fn set_rapl(&mut self, reading: &Value) {
        let Some(r) = clean_reading(reading) else { return };
        if self.sent.cur.as_ref().is_some_and(|c| r.at <= c.at) {
            return;
        }
        self.sent = Pair { prev: self.sent.cur.take(), cur: Some(r) };
    }

    /// CPU package W, or None.
    pub fn cpu(&mut self, t: i64) -> Option<f64> {
        if self.direct {
            let r = Reading { at: t as f64, packages: self.zones.iter().map(|z| Package { name: z.name.clone(), energy_uj: read_num(&z.energy), max_energy_uj: z.max }).collect() };
            if r.packages.iter().all(|p| p.energy_uj.is_some()) {
                self.readings = Pair { prev: self.readings.cur.take(), cur: Some(r) };
            }
            self.used = self.readings.clone();
            return package_watts(self.readings.prev.as_ref(), self.readings.cur.as_ref());
        }
        let fresh = self.sent.cur.as_ref().is_some_and(|c| (t as f64) - c.at <= (3 * self.interval_ms).max(10000) as f64);
        if !fresh {
            self.used = Pair::default();
            return None;
        }
        self.used = self.sent.clone();
        package_watts(self.sent.prev.as_ref(), self.sent.cur.as_ref())
    }

    /// W per socket from the readings of the last sample.
    pub fn socket_watts(&self) -> BTreeMap<i64, f64> {
        socket_watts(self.used.prev.as_ref(), self.used.cur.as_ref())
    }

    pub fn has_rapl(&self, t: i64) -> bool {
        self.direct || self.sent.cur.as_ref().is_some_and(|c| (t as f64) - c.at < 60000.0)
    }

    pub fn sample(&mut self, t: i64, gpus: &[GpuPower]) -> PowerSample {
        let cpu_w = self.cpu(t);
        let with: Vec<&GpuPower> = gpus.iter().filter(|g| g.power_w.is_some()).collect();
        let gpu_w = sum_of(with.iter().map(|g| g.power_w));
        // An AMD APU's reading is the whole chip, CPU included
        let discrete = sum_of(with.iter().filter(|g| !g.integrated).map(|g| g.power_w));
        let integrated = sum_of(with.iter().filter(|g| g.integrated).map(|g| g.power_w));
        let chip_w = integrated.map(|i| i.max(cpu_w.unwrap_or(0.0)));
        let total = if let Some(c) = chip_w {
            Some(c + discrete.unwrap_or(0.0))
        } else if let Some(c) = cpu_w {
            Some(c + discrete.unwrap_or(0.0))
        } else {
            gpu_w
        };
        PowerSample {
            total_w: round(total, 1),
            cpu_w: round(cpu_w, 1),
            gpu_w: round(gpu_w, 1),
            chip_w: round(chip_w, 1),
            discrete_w: if chip_w.is_some() { round(discrete, 1) } else { None },
            cpu_source: cpu_w.map(|_| "rapl"),
            gpu_source: with.first().and_then(|g| g.source.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX: f64 = 262143328850.0;

    fn reading(at: f64, e: f64) -> Value {
        json!({ "at": at, "packages": [{ "name": "package-0", "energyUj": e, "maxEnergyUj": MAX }] })
    }

    fn r(at: f64, e: f64) -> Reading {
        clean_reading(&reading(at, e)).unwrap()
    }

    // test/statsPower.test.js "RAPL: watts from energy deltas, across the wrap-around"
    #[test]
    fn rapl_watts_across_the_wrap() {
        assert_eq!(energy_delta(Some(100.0), Some(300.0), Some(MAX)), Some(200.0));
        assert_eq!(energy_delta(Some(MAX - 50.0), Some(150.0), Some(MAX)), Some(200.0));
        assert_eq!(energy_delta(Some(500.0), Some(100.0), None), None);
        assert_eq!(energy_delta(Some(MAX + 10.0), Some(5.0), Some(MAX)), None);
        assert_eq!(energy_delta(Some(f64::NAN), Some(5.0), Some(MAX)), None);
        assert_eq!(package_watts(Some(&r(0.0, MAX - 40e6)), Some(&r(2000.0, 42e6))), Some(41.0));
        assert_eq!(package_watts(Some(&r(0.0, 0.0)), Some(&r(0.0, 10.0))), None);
        assert_eq!(package_watts(Some(&r(0.0, 0.0)), Some(&r(120000.0, 10.0))), None);
        assert_eq!(package_watts(Some(&r(0.0, 0.0)), Some(&r(1000.0, 5e9))), None);
        let two = |at: f64, a: f64, b: f64, core: f64| clean_reading(&json!({ "at": at, "packages": [{ "name": "package-0", "energyUj": a }, { "name": "package-1", "energyUj": b }, { "name": "core", "energyUj": core }] })).unwrap();
        assert_eq!(package_watts(Some(&two(0.0, 0.0, 0.0, 0.0)), Some(&two(1000.0, 30e6, 20e6, 99e6))), Some(50.0));
    }

    // "RAPL from the supervisor: fresh readings only, out-of-order and malformed ones ignored"
    #[test]
    fn rapl_from_the_supervisor() {
        let mut t = 100000i64;
        let mut p = PowerProvider::new(Path::new("/nonexistent"), 2000);
        p.probe();
        assert!(!p.direct);
        assert_eq!(p.cpu(t), None);
        p.set_rapl(&reading((t - 2000) as f64, MAX - 10e6));
        p.set_rapl(&reading(t as f64, 50e6));
        assert_eq!(p.cpu(t), Some(30.0));
        p.set_rapl(&reading((t - 1000) as f64, 1.0));
        p.set_rapl(&json!({ "at": "soon", "packages": "all" }));
        p.set_rapl(&Value::Null);
        p.set_rapl(&json!({ "at": t + 1, "packages": [{ "name": "package-0", "energyUj": "x" }] }));
        assert_eq!(p.cpu(t), Some(30.0));
        assert!(p.has_rapl(t));
        t += 11000;
        assert_eq!(p.cpu(t), None);
    }

    // "a built-in GPU (APU): one figure for the whole chip, other GPUs added to it"
    #[test]
    fn an_apu_is_one_figure_for_the_chip() {
        let t = 100000i64;
        let mut p = PowerProvider::new(Path::new("/nonexistent"), 2000);
        p.probe();
        let apu = || GpuPower { power_w: Some(31.4), integrated: true, source: Some("hwmon".into()) };
        let card = || GpuPower { power_w: Some(85.0), integrated: false, source: Some("hwmon".into()) };
        let pick = |s: PowerSample| (s.total_w, s.cpu_w, s.gpu_w, s.chip_w, s.discrete_w);
        assert_eq!(pick(p.sample(t, &[apu()])), (Some(31.4), None, Some(31.4), Some(31.4), None));
        p.set_rapl(&reading((t - 2000) as f64, 0.0));
        p.set_rapl(&reading(t as f64, 60e6));
        assert_eq!(pick(p.sample(t, &[apu()])), (Some(31.4), Some(30.0), Some(31.4), Some(31.4), None));
        assert_eq!(pick(p.sample(t, &[apu(), card()])), (Some(116.4), Some(30.0), Some(116.4), Some(31.4), Some(85.0)));
        assert_eq!(pick(p.sample(t, &[card()])), (Some(115.0), Some(30.0), Some(85.0), None, None));
    }

    // test/statsSockets.test.js "RAPL per socket: dies of a package together, other zones and bad readings left out"
    #[test]
    fn rapl_per_socket() {
        let rd = |at: f64, list: &[(&str, f64)]| clean_reading(&json!({ "at": at, "packages": list.iter().map(|(n, e)| json!({ "name": n, "energyUj": e })).collect::<Vec<_>>() })).unwrap();
        let a = rd(0.0, &[("package-0-die-0", 0.0), ("package-0-die-1", 0.0), ("package-1", 0.0), ("dram", 0.0)]);
        let b = rd(1000.0, &[("package-0-die-0", 10e6), ("package-0-die-1", 5e6), ("package-1", 20e6), ("dram", 99e6)]);
        let w = socket_watts(Some(&a), Some(&b));
        assert_eq!(w.into_iter().collect::<Vec<_>>(), vec![(0, 15.0), (1, 20.0)]);
        let bad = rd(1000.0, &[("package-0-die-0", 5e12), ("package-1", 20e6)]);
        assert!(socket_watts(Some(&a), Some(&bad)).is_empty());
    }
}
