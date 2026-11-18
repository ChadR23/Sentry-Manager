//! cpu.js: model, cores and threads, total and per-core use from /proc/stat
//! deltas, clock, load, thermal throttling. A server with two or more CPU
//! sockets also gets the use of each socket.

use super::util::*;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ticks {
    pub busy: f64,
    pub all: f64,
}

#[derive(Clone, Debug, Default)]
pub struct ProcStat {
    pub total: Option<Ticks>,
    pub cores: BTreeMap<usize, Ticks>,
}

/// busy/total jiffies per line of /proc/stat (guest time is already inside user).
pub fn parse_proc_stat(text: Option<&str>) -> ProcStat {
    let mut out = ProcStat::default();
    for line in text.unwrap_or("").split('\n') {
        let Some(c) = re!(r"^cpu(\d*)\s+(.+)$").caps(line) else { continue };
        let (id, rest) = (c[1].clone().unwrap_or_default(), c[2].clone().unwrap_or_default());
        let v: Vec<f64> = rest.trim().split_whitespace().map(crate::ops::js::number_str).collect();
        if v.len() < 4 || v[..4].iter().any(|n| !n.is_finite()) {
            continue;
        }
        let g = |i: usize| v.get(i).copied().filter(|n| n.is_finite()).unwrap_or(0.0);
        let all = (0..8).map(g).sum::<f64>();
        let e = Ticks { busy: all - g(3) - g(4), all };
        if id.is_empty() {
            out.total = Some(e);
        } else {
            out.cores.insert(id.parse().unwrap_or(0), e);
        }
    }
    out
}

/// "12th Gen Intel(R) Core(TM) i5-12500" -> "Intel Core i5-12500".
pub fn clean_model(name: &str) -> Option<String> {
    if name.is_empty() {
        return None;
    }
    let mut s = re!(r"\((R|TM|tm|r)\)").replace_all(name, "");
    s = re!(r"(?i)^\d+(st|nd|rd|th) Gen ").replace(&s, "");
    s = re!(r"(?i)\s+@\s+[\d.]+\s*GHz").replace(&s, "");
    s = re!(r"\s+CPU\b").replace_all(&s, "");
    s = re!(r"(?i)\s+\d+-Core Processor\b").replace(&s, "");
    s = re!(r"(?i)\s+with Radeon( \w+)* Graphics\b").replace(&s, "");
    s = re!(r"(?i)\s+Processor\b").replace(&s, "");
    s = re!(r"\s+").replace_all(&s, " ");
    let s = s.trim().to_string();
    (!s.is_empty()).then_some(s)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Socket {
    pub socket: i64,
    pub cores: usize,
    pub threads: usize,
}

#[derive(Clone, Debug, Default)]
pub struct CpuInfo {
    pub model: Option<String>,
    pub threads: Option<usize>,
    pub cores: Option<usize>,
    pub package_cpus: Vec<usize>,
    pub x86: bool,
    pub vendor: Option<String>,
    pub virtual_: bool,
    pub sockets: usize,
    pub socket_list: Vec<Socket>,
    pub socket_of: HashMap<usize, i64>,
}

pub fn parse_cpuinfo(text: Option<&str>, dt_model: Option<String>) -> CpuInfo {
    let text = text.unwrap_or("");
    let blocks: Vec<&str> = re!(r"\n\s*\n").split(text);
    let mut threads = 0;
    let mut core_keys = HashSet::new();
    let mut packages: Vec<(String, usize)> = Vec::new();
    let mut socket_of = HashMap::new();
    let mut per_package: Vec<(String, HashSet<String>, usize)> = Vec::new();
    let (mut model_name, mut hardware, mut board, mut vendor, mut implementer): (Option<String>, Option<String>, Option<String>, Option<String>, Option<String>) = (None, None, None, None, None);
    let mut virtual_ = false;
    for block in blocks {
        let mut kv: HashMap<String, String> = HashMap::new();
        for line in block.split('\n') {
            if let Some(i) = line.find(':').filter(|i| *i > 0) {
                kv.insert(line[..i].trim().to_string(), line[i + 1..].trim().to_string());
            }
        }
        if let Some(p) = kv.get("processor").filter(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit())) {
            let n: usize = p.parse().unwrap_or(0);
            threads += 1;
            if let Some(c) = kv.get("core id") {
                let phys = kv.get("physical id").filter(|s| !s.is_empty()).map_or("0", |s| s.as_str());
                core_keys.insert(format!("{phys}:{c}"));
            }
            let pkg = kv.get("physical id").filter(|s| !s.is_empty()).cloned().unwrap_or_else(|| "0".into());
            if !packages.iter().any(|(k, _)| *k == pkg) {
                packages.push((pkg.clone(), n));
            }
            if !pkg.is_empty() && pkg.bytes().all(|c| c.is_ascii_digit()) {
                socket_of.insert(n, pkg.parse::<i64>().unwrap_or(0));
                if !per_package.iter().any(|(k, _, _)| *k == pkg) {
                    per_package.push((pkg.clone(), HashSet::new(), 0));
                }
                let e = per_package.iter_mut().find(|(k, _, _)| *k == pkg).unwrap();
                e.2 += 1;
                if let Some(c) = kv.get("core id") {
                    e.1.insert(c.clone());
                }
            }
        }
        let pick = |cur: &mut Option<String>, k: &str| {
            if cur.is_none() {
                *cur = kv.get(k).filter(|s| !s.is_empty()).cloned();
            }
        };
        pick(&mut model_name, "model name");
        pick(&mut vendor, "vendor_id");
        pick(&mut implementer, "CPU implementer");
        pick(&mut hardware, "Hardware");
        if re!(r"\bhypervisor\b").is(kv.get("flags").map_or("", |s| s.as_str())) {
            virtual_ = true;
        }
        pick(&mut board, "Model");
    }
    // ARM boards: the board ("Raspberry Pi 4 Model B") says more than "ARMv8 Processor"
    let model = match &model_name {
        Some(m) if !re!(r"(?i)^ARMv\d").is(m) => clean_model(m),
        _ => board.or(dt_model).or(hardware).or_else(|| model_name.as_deref().and_then(clean_model)),
    };
    let x86 = vendor.is_some();
    // A virtual machine's sockets are however it was set up and say nothing
    // about the server's own, so a VM counts as one.
    let mut sockets: Vec<Socket> = if virtual_ {
        Vec::new()
    } else {
        per_package.iter().map(|(id, cores, t)| Socket { socket: id.parse().unwrap_or(0), cores: if cores.is_empty() { *t } else { cores.len() }, threads: *t }).collect()
    };
    sockets.sort_by_key(|s| s.socket);
    let mut package_cpus: Vec<usize> = packages.iter().map(|p| p.1).collect();
    package_cpus.sort();
    let t = (threads > 0).then_some(threads);
    CpuInfo {
        model,
        threads: t,
        cores: if core_keys.is_empty() { t } else { Some(core_keys.len()) },
        package_cpus,
        x86,
        vendor,
        virtual_,
        sockets: sockets.len().max(1),
        socket_list: if sockets.len() > 1 { sockets } else { Vec::new() },
        socket_of,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SocketUse {
    pub socket: i64,
    pub cores: usize,
    pub threads: usize,
    pub usage: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct CpuSample {
    pub model: Option<String>,
    pub cores: Option<usize>,
    pub threads: Option<usize>,
    pub usage: Option<f64>,
    pub per_core: Vec<Option<f64>>,
    pub freq_mhz: Option<f64>,
    pub load: Option<Vec<f64>>,
    pub throttling: bool,
    pub total_ticks: Option<f64>,
    pub sockets: usize,
    pub per_socket: Option<Vec<SocketUse>>,
}

pub struct CpuProvider {
    proc_root: PathBuf,
    sys_root: PathBuf,
    now: Clock,
    prev: Option<ProcStat>,
    pub info: CpuInfo,
    pub freq_files: Vec<PathBuf>,
    throttle_files: Vec<PathBuf>,
    throttle_counts: Option<Vec<Option<f64>>>,
    last_throttle_at: Option<i64>,
}

impl CpuProvider {
    pub fn new(proc_root: &Path, sys_root: &Path, now: Clock) -> CpuProvider {
        CpuProvider {
            proc_root: proc_root.into(),
            sys_root: sys_root.into(),
            now,
            prev: None,
            info: CpuInfo { sockets: 1, ..Default::default() },
            freq_files: Vec::new(),
            throttle_files: Vec::new(),
            throttle_counts: None,
            last_throttle_at: None,
        }
    }

    pub fn probe(&mut self) {
        let dt = read_text(self.sys_root.join("firmware/devicetree/base/model"))
            .filter(|s| !s.is_empty())
            .or_else(|| read_text(self.proc_root.join("device-tree/model")))
            .unwrap_or_default()
            .replace('\0', "")
            .trim()
            .to_string();
        self.info = parse_cpuinfo(read_text(self.proc_root.join("cpuinfo")).as_deref(), (!dt.is_empty()).then_some(dt));
        let cpu_dir = self.sys_root.join("devices/system/cpu");
        let mut cpus: Vec<String> = list_dir(&cpu_dir, 4096).into_iter().filter(|n| re!(r"^cpu\d+$").is(n)).collect();
        cpus.sort_by_key(|c| c[3..].parse::<u64>().unwrap_or(0));
        // a 128-thread server need not be read core by core: 32 spread over it tell the clock
        let step = (cpus.len() as f64 / 32.0).max(1.0);
        let mut picked = Vec::new();
        let mut i = 0.0f64;
        while (i as usize) < cpus.len() && picked.len() < 32 {
            picked.push(cpus[i.floor() as usize].clone());
            i = (i + step - 1e-9).ceil();
        }
        self.freq_files = picked.iter().map(|c| cpu_dir.join(c).join("cpufreq/scaling_cur_freq")).filter(|f| read_num(f).is_some()).collect();
        if self.info.threads.is_none() && !cpus.is_empty() {
            self.info.threads = Some(cpus.len());
            self.info.cores = Some(cpus.len());
        }
        // one CPU per package covers the package, and its core counter is a fair sample
        let firsts = if self.info.package_cpus.is_empty() { vec![0] } else { self.info.package_cpus.clone() };
        self.throttle_files.clear();
        self.throttle_counts = None;
        for n in firsts {
            for name in ["package_throttle_count", "core_throttle_count"] {
                let f = cpu_dir.join(format!("cpu{n}")).join("thermal_throttle").join(name);
                if read_num(&f).is_some() {
                    self.throttle_files.push(f);
                }
            }
        }
    }

    pub fn sample(&mut self) -> CpuSample {
        let t = (self.now)();
        let stat = parse_proc_stat(read_text(self.proc_root.join("stat")).as_deref());
        let mut usage = None;
        let mut per_core = Vec::new();
        let mut total_ticks = None;
        let mut by_socket: BTreeMap<i64, (f64, f64)> = self.info.socket_list.iter().map(|s| (s.socket, (0.0, 0.0))).collect();
        if let (Some(cur), Some(prev)) = (stat.total, self.prev.as_ref().and_then(|p| p.total)) {
            let all = cur.all - prev.all;
            let busy = cur.busy - prev.busy;
            // iowait can run backwards on some kernels; a step back is no data
            if all > 0.0 && busy >= 0.0 {
                usage = clamp_pct(Some(busy / all * 100.0));
                total_ticks = Some(all);
            }
            let prev_cores = &self.prev.as_ref().unwrap().cores;
            for (n, core) in &stat.cores {
                let before = prev_cores.get(n);
                let a = before.map_or(0.0, |b| core.all - b.all);
                let b = before.map_or(-1.0, |b| core.busy - b.busy);
                per_core.push(if a > 0.0 && b >= 0.0 { round(clamp_pct(Some(b / a * 100.0)), 0) } else { None });
                if a > 0.0 && b >= 0.0 {
                    if let Some(s) = self.info.socket_of.get(n).and_then(|id| by_socket.get_mut(id)) {
                        s.0 += b;
                        s.1 += a;
                    }
                }
            }
        }
        if stat.total.is_some() {
            self.prev = Some(stat);
        }
        let per_socket = (self.info.socket_list.len() > 1).then(|| {
            self.info
                .socket_list
                .iter()
                .map(|s| {
                    let (b, a) = by_socket[&s.socket];
                    SocketUse { socket: s.socket, cores: s.cores, threads: s.threads, usage: if a > 0.0 { round(clamp_pct(Some(b / a * 100.0)), 1) } else { None } }
                })
                .collect()
        });
        // the fastest core: idle cores sit at their lowest clock and say little
        let mut freq: Option<f64> = None;
        for f in &self.freq_files {
            if let Some(khz) = read_num(f) {
                if khz > 0.0 && freq.is_none_or(|m| khz / 1000.0 > m) {
                    freq = Some(khz / 1000.0);
                }
            }
        }
        let line = read_line(self.proc_root.join("loadavg")).unwrap_or_default();
        let load: Vec<f64> = re!(r"\s+").split(&line).into_iter().take(3).map(|x| if x.is_empty() { 0.0 } else { crate::ops::js::number_str(x) }).collect();
        if !self.throttle_files.is_empty() {
            let counts: Vec<Option<f64>> = self.throttle_files.iter().map(read_num).collect();
            if let Some(before) = &self.throttle_counts {
                if counts.iter().zip(before).any(|(c, b)| matches!((c, b), (Some(c), Some(b)) if c > b)) {
                    self.last_throttle_at = Some(t);
                }
            }
            self.throttle_counts = Some(counts);
        }
        let throttling = !self.throttle_files.is_empty() && self.last_throttle_at.is_some_and(|at| t - at < 10000);
        CpuSample {
            model: self.info.model.clone(),
            cores: self.info.cores,
            threads: self.info.threads,
            usage: round(usage, 1),
            per_core,
            freq_mhz: freq.map(js_round),
            load: (load.len() == 3 && load.iter().all(|x| x.is_finite())).then_some(load),
            throttling,
            total_ticks,
            sockets: self.info.sockets,
            per_socket,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_names() {
        assert_eq!(clean_model("12th Gen Intel(R) Core(TM) i5-12500").as_deref(), Some("Intel Core i5-12500"));
        assert_eq!(clean_model("AMD Ryzen 7 5700G with Radeon Graphics").as_deref(), Some("AMD Ryzen 7 5700G"));
        assert_eq!(clean_model("Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz").as_deref(), Some("Intel Xeon E5-2680 v4"));
        assert_eq!(clean_model("AMD Ryzen 9 5950X 16-Core Processor").as_deref(), Some("AMD Ryzen 9 5950X"));
        assert_eq!(clean_model("AMD Ryzen 5 PRO 4650G with Radeon Graphics").as_deref(), Some("AMD Ryzen 5 PRO 4650G"));
        assert_eq!(clean_model("Intel(R) Celeron(R) J4125 CPU @ 2.00GHz").as_deref(), Some("Intel Celeron J4125"));
        let pi = parse_cpuinfo(Some("processor\t: 0\nmodel name\t: ARMv7 Processor rev 3 (v7l)\nCPU implementer\t: 0x41\n\nModel\t: Raspberry Pi 3 Model B Plus Rev 1.3\n"), None);
        assert_eq!(pi.model.as_deref(), Some("Raspberry Pi 3 Model B Plus Rev 1.3"));
    }

    // test/statsSockets.test.js "cpuinfo: sockets from the physical ids; boards without them have one"
    #[test]
    fn sockets_from_physical_ids() {
        let block = |n: usize, phys: &str, core: usize| format!("processor\t: {n}\nvendor_id\t: GenuineIntel\nphysical id\t: {phys}\ncore id\t\t: {core}\n");
        let two = (0..4).map(|n| block(n, if n < 2 { "0" } else { "1" }, n % 2)).collect::<Vec<_>>().join("\n");
        let i = parse_cpuinfo(Some(&two), None);
        assert_eq!(i.sockets, 2);
        assert_eq!(i.socket_list, vec![Socket { socket: 0, cores: 2, threads: 2 }, Socket { socket: 1, cores: 2, threads: 2 }]);
        assert_eq!(i.package_cpus, vec![0, 2]);
        let one = parse_cpuinfo(Some("processor\t: 0\n\nprocessor\t: 1\n"), None);
        assert_eq!((one.sockets, one.socket_list.len()), (1, 0));
    }

    #[test]
    fn proc_stat() {
        let s = parse_proc_stat(Some("cpu  10 0 10 80 0 0 0 0\ncpu0 5 0 5 40\ncpu1 x 0 0 0\nintr 1"));
        assert_eq!(s.total, Some(Ticks { busy: 20.0, all: 100.0 }));
        assert_eq!(s.cores.len(), 1);
    }
}
