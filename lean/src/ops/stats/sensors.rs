//! sensors.js: every temperature and fan the board reports
//! (/sys/class/hwmon), plus the thermal zones when no hwmon chip covers the
//! CPU. Reads go through BackgroundReads: some ask the device itself
//! (drivetemp sends the disk a command); the CPU's are read every sample, the
//! rest every 10-30 s.

use super::util::*;
use crate::ops::js::num as jnum;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

const MAX_AGE: i64 = 90000;

fn every(role: &str) -> i64 {
    match role {
        "cpu" | "gpu" => 0,
        "nvme" => 10000,
        "drivetemp" => 30000,
        _ => 10000,
    }
}

/// A plausible temperature in °C from millidegrees; unplugged inputs read -128, 127, 255...
pub fn temp_c(text: Option<&str>) -> Option<f64> {
    let c = num(text)? / 1000.0;
    (c > -30.0 && c < 127.0).then(|| js_round(c * 10.0) / 10.0)
}

#[derive(Clone, Debug)]
pub struct Input {
    pub n: u64,
    pub file: PathBuf,
    pub label: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Chip {
    pub id: String,
    pub dir: PathBuf,
    pub name: String,
    pub dev: Option<String>,
    pub files: HashSet<String>,
    pub temps: Vec<Input>,
    pub fans: Vec<Input>,
    pub disk: Option<String>,
    pub role: &'static str,
}

fn chip_files(dir: &Path) -> (HashSet<String>, Vec<Input>, Vec<Input>) {
    let files = list_dir(dir, 512);
    let (mut temps, mut fans) = (Vec::new(), Vec::new());
    for f in &files {
        if let Some(n) = re!(r"^temp(\d+)_input$").group(f, 1) {
            temps.push(Input { n: n.parse().unwrap_or(0), file: dir.join(f), label: read_line(dir.join(format!("temp{n}_label"))) });
        }
        if let Some(n) = re!(r"^fan(\d+)_input$").group(f, 1) {
            fans.push(Input { n: n.parse().unwrap_or(0), file: dir.join(f), label: read_line(dir.join(format!("fan{n}_label"))) });
        }
    }
    temps.sort_by_key(|t| t.n);
    fans.sort_by_key(|t| t.n);
    (files.into_iter().collect(), temps, fans)
}

#[derive(Clone, Debug)]
struct Zone {
    id: String,
    type_: String,
    file: PathBuf,
}

pub struct SensorsProvider {
    sys_root: PathBuf,
    reads: Arc<BackgroundReads>,
    pub chips: Vec<Chip>,
    zones: Vec<Zone>,
    cpu_chips: Vec<usize>,
    cpu_zone: Option<usize>,
    fans_seen: HashSet<PathBuf>,
}

impl SensorsProvider {
    pub fn new(sys_root: &Path, reads: Arc<BackgroundReads>) -> SensorsProvider {
        SensorsProvider { sys_root: sys_root.into(), reads, chips: Vec::new(), zones: Vec::new(), cpu_chips: Vec::new(), cpu_zone: None, fans_seen: HashSet::new() }
    }

    pub fn probe(&mut self) {
        let block_devs: Vec<(String, Option<String>)> = list_dir(self.sys_root.join("block"), 4096).into_iter().map(|name| {
            let dev = real_path(self.sys_root.join("block").join(&name).join("device"));
            (name, dev)
        }).collect();
        let hwmon_dir = self.sys_root.join("class/hwmon");
        let mut ids: Vec<String> = list_dir(&hwmon_dir, 4096).into_iter().filter(|n| re!(r"^hwmon\d+$").is(n)).collect();
        ids.sort_by_key(|n| n[5..].parse::<u64>().unwrap_or(0));
        self.chips.clear();
        for id in ids {
            let dir = hwmon_dir.join(&id);
            let name = read_line(dir.join("name")).unwrap_or_else(|| id.clone());
            let dev = real_path(dir.join("device"));
            let (files, temps, fans) = chip_files(&dir);
            let mut chip = Chip { id, dir, name, dev, files, temps, fans, disk: None, role: "other" };
            if re!(r"^(coretemp|k10temp|zenpower|cpu[_-]?thermal|cpu\d*[_-]thermal|soc[_-]?thermal)$").is(&chip.name) {
                chip.role = "cpu";
            } else if chip.name == "drivetemp" {
                chip.role = "drivetemp";
                chip.disk = block_devs.iter().find(|b| b.1.is_some() && b.1 == chip.dev).map(|b| b.0.clone());
            } else if chip.name == "nvme" {
                chip.role = "nvme";
                let ctrl = chip.dev.as_deref().map(basename);
                let mut ns: Vec<String> = ctrl.as_ref().map(|c| block_devs.iter().map(|b| b.0.clone()).filter(|n| n.starts_with(&format!("{c}n"))).collect()).unwrap_or_default();
                ns.sort();
                chip.disk = ns.into_iter().next().or(ctrl);
            }
            self.chips.push(chip);
        }
        self.cpu_chips = self.chips.iter().enumerate().filter(|(_, c)| c.role == "cpu" && !c.temps.is_empty()).map(|(i, _)| i).collect();
        let zone_dir = self.sys_root.join("class/thermal");
        let mut zones: Vec<String> = list_dir(&zone_dir, 4096).into_iter().filter(|n| re!(r"^thermal_zone\d+$").is(n)).collect();
        zones.sort_by_key(|n| n[12..].parse::<u64>().unwrap_or(0));
        self.zones = zones.into_iter().map(|z| Zone { type_: read_line(zone_dir.join(&z).join("type")).unwrap_or_else(|| z.clone()), file: zone_dir.join(&z).join("temp"), id: z }).collect();
        self.cpu_zone = self.zones.iter().position(|z| z.type_.contains("x86_pkg_temp")).or_else(|| self.zones.iter().position(|z| re!(r"(?i)x86_pkg_temp|cpu|soc").is(&z.type_)));
    }

    /// Mark the hwmon chips that belong to a GPU (read every sample, not every 10 s).
    pub fn mark_gpu_chips(&mut self, devs: &[String]) {
        for c in &mut self.chips {
            if c.role == "other" && c.dev.as_ref().is_some_and(|d| devs.contains(d)) {
                c.role = "gpu";
            }
        }
    }

    fn value(&self, file: &Path, role: &str) -> Option<String> {
        self.reads.text(file, every(role), MAX_AGE)
    }

    fn chip_temp(&self, c: &Chip, t: &Input) -> Option<f64> {
        temp_c(self.value(&t.file, c.role).as_deref())
    }

    /// The readings of a CPU chip that stand for the CPU: coretemp package, k10temp Tdie/Tctl, else the cores.
    fn cpu_inputs<'a>(&self, c: &'a Chip) -> Vec<&'a Input> {
        let pick = |r: &Re| c.temps.iter().filter(|t| t.label.as_deref().is_some_and(|l| r.is(l))).collect::<Vec<_>>();
        let mut list = pick(re!(r"^Package id \d+$"));
        if list.is_empty() {
            list = pick(re!(r"^Tdie$"));
        }
        if list.is_empty() {
            list = pick(re!(r"^Tctl$"));
        }
        if list.is_empty() {
            list = pick(re!(r"^Core \d+$"));
        }
        if list.is_empty() {
            list = c.temps.iter().take(1).collect();
        }
        list
    }

    fn chip_cpu_temp(&self, c: &Chip) -> Option<f64> {
        max_of(self.cpu_inputs(c).into_iter().map(|t| self.chip_temp(c, t)))
    }

    /// CPU temperature: the hottest CPU chip (one per socket), or the CPU thermal zone.
    pub fn cpu_temp(&self) -> Option<f64> {
        if !self.cpu_chips.is_empty() {
            return max_of(self.cpu_chips.iter().map(|i| self.chip_cpu_temp(&self.chips[*i])));
        }
        self.cpu_zone.and_then(|z| temp_c(self.value(&self.zones[z].file, "cpu").as_deref()))
    }

    /// Each socket's temperature, in the order of `sockets` (physical ids).
    pub fn socket_temps(&self, sockets: &[i64]) -> Vec<Option<f64>> {
        let mut out: BTreeMap<i64, Option<f64>> = BTreeMap::new();
        let mut unnamed = Vec::new();
        let mut packages: BTreeMap<u64, Option<f64>> = BTreeMap::new();
        for i in &self.cpu_chips {
            let c = &self.chips[*i];
            let pkgs: Vec<&Input> = c.temps.iter().filter(|t| t.label.as_deref().is_some_and(|l| re!(r"^Package id \d+$").is(l))).collect();
            if pkgs.is_empty() {
                unnamed.push(c);
            }
            for t in pkgs {
                let n: u64 = t.label.as_deref().unwrap()[11..].parse().unwrap_or(0);
                let v = max_of([packages.get(&n).copied().flatten(), self.chip_temp(c, t)]);
                packages.insert(n, v);
            }
        }
        if packages.len() == sockets.len() {
            let mut order = sockets.to_vec();
            order.sort();
            for (i, (_, v)) in packages.iter().enumerate() {
                out.insert(order[i], *v);
            }
        }
        if packages.is_empty() && unnamed.len() == sockets.len() {
            let mut by_device = unnamed.clone();
            by_device.sort_by(|a, b| a.dev.clone().unwrap_or_else(|| "null".into()).cmp(&b.dev.clone().unwrap_or_else(|| "null".into())));
            for (i, c) in by_device.iter().enumerate() {
                out.insert(sockets[i], self.chip_cpu_temp(c));
            }
        }
        sockets.iter().map(|s| out.get(s).copied().flatten()).collect()
    }

    /// Temperature of a disk's own sensor, by disk name.
    pub fn disk_temp(&self, disk: &str) -> Option<f64> {
        let c = self.chips.iter().find(|c| c.disk.as_deref() == Some(disk) && (c.role == "nvme" || c.role == "drivetemp"))?;
        let t = c.temps.iter().find(|x| x.label.as_deref() == Some("Composite")).or(c.temps.first())?;
        self.chip_temp(c, t)
    }

    /// The hwmon chip of a device (a GPU), if any.
    pub fn chip_of(&self, dev: Option<&str>) -> Option<Chip> {
        let d = dev?;
        self.chips.iter().find(|c| c.dev.as_deref() == Some(d)).cloned()
    }

    /// { sensors, cpuTempC } as they stand (values from the last background reads).
    pub fn sample(&mut self) -> (Vec<Value>, Option<f64>) {
        (self.list(), self.cpu_temp())
    }

    fn list(&mut self) -> Vec<Value> {
        let mut out = Vec::new();
        let mut ordered: Vec<&Chip> = self.chips.iter().collect();
        ordered.sort_by_key(|c| if c.role == "cpu" { 0 } else { 1 });
        let mut seen_now = Vec::new();
        for c in ordered {
            for t in &c.temps {
                let Some(value) = self.chip_temp(c, t) else { continue };
                // unlabelled inputs go by the chip's name (numbered when it has several)
                let mut label = t.label.clone().unwrap_or_else(|| if c.temps.len() > 1 { format!("{} {}", c.name, t.n) } else { c.name.clone() });
                if let Some(d) = &c.disk {
                    label = match &t.label {
                        Some(l) if l != "Composite" => format!("{d} {l}"),
                        _ => d.clone(),
                    };
                }
                out.push(json!({ "chip": c.name, "label": label, "kind": "temp", "value": jnum(value) }));
            }
            for f in &c.fans {
                let Some(value) = num(self.value(&f.file, c.role).as_deref()) else { continue };
                if !(0.0..=50000.0).contains(&value) {
                    continue;
                }
                // unconnected fan headers read 0 forever; a fan that ever spun stays listed
                if value > 0.0 {
                    seen_now.push(f.file.clone());
                }
                if !self.fans_seen.contains(&f.file) && value <= 0.0 {
                    continue;
                }
                seen_now.push(f.file.clone());
                out.push(json!({ "chip": c.name, "label": f.label.clone().unwrap_or_else(|| format!("Fan {}", f.n)), "kind": "fan", "value": jnum(value) }));
            }
        }
        self.fans_seen.extend(seen_now);
        if self.cpu_chips.is_empty() {
            for (i, z) in self.zones.iter().enumerate() {
                let cpu = self.cpu_zone == Some(i);
                if let Some(value) = temp_c(self.value(&z.file, if cpu { "cpu" } else { "other" }).as_deref()) {
                    out.push(json!({ "chip": z.type_, "label": if cpu { "CPU".to_string() } else { z.type_.clone() }, "kind": "temp", "value": jnum(value) }));
                }
            }
        }
        let _ = self.zones.iter().map(|z| &z.id).count();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temperatures() {
        assert_eq!(temp_c(Some("58000\n")), Some(58.0));
        assert_eq!(temp_c(Some("127000")), None);
        assert_eq!(temp_c(Some("-128000")), None);
        assert_eq!(temp_c(Some("64850")), Some(64.9));
    }
}
