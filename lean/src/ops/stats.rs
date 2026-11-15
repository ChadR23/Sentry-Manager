//! Server monitor (server/stats/*): samples the machine every 2 s while a
//! page is watching (15 s after its last request) and runs no timer
//! otherwise. GET /api/stats is the last sample, /api/stats/history the 15
//! minute and 24 hour graphs, /api/stats/export.csv the same as CSV.
//!
//! Ported here: the history (history.js, exactly, saved in the same
//! data/stats-history.json, whose energy, traffic and share parts are kept
//! as they are), the CPU (/proc/stat, cpuinfo, loadavg, cpufreq), memory
//! (/proc/meminfo), the host and the network rates (/proc/net/dev). The
//! answer has every part Node's has, in the same shape; the parts not ported
//! yet (GPUs, power and energy, disks, file systems, sensors, processes,
//! alerts) answer as Node's skeleton does before they have a reading.

use super::js::num;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const SERIES: [&str; 8] = ["cpu", "memory", "gpuBusy", "gpuVideo", "powerW", "rxBps", "txBps", "tempMax"];
const DIGITS: [i32; 8] = [1, 1, 0, 0, 1, 0, 0, 1];
const RECENT_MS: i64 = 15 * 60 * 1000;
const DAY_MS: i64 = 24 * 3600 * 1000;
const MINUTE: i64 = 60_000;
const SPARK_POINTS: usize = 90;
pub const WATCH_MS: i64 = 15_000;
const SAVE_EVERY_MS: i64 = 5 * 60 * 1000;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// Math.round
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// util.js round(n, digits)
pub fn round(n: Option<f64>, digits: i32) -> Option<f64> {
    let n = n.filter(|x| x.is_finite())?;
    let f = 10f64.powi(digits);
    Some(js_round(n * f) / f)
}

type Row = Vec<Option<f64>>; // [t, ...values]

#[derive(Clone, Debug)]
struct Open {
    t: i64,
    sum: Vec<f64>,
    n: Vec<f64>,
}

/// history.js: every sample of the last 15 minutes, 1-minute averages of the last 24 hours.
#[derive(Clone, Debug)]
pub struct History {
    interval_ms: i64,
    recent: Vec<Row>,
    minutes: Vec<Row>,
    open: Option<Open>,
}

fn t_of(r: &Row) -> i64 {
    r[0].unwrap_or(0.0) as i64
}

impl History {
    pub fn new(interval_ms: i64) -> History {
        History { interval_ms, recent: Vec::new(), minutes: Vec::new(), open: None }
    }

    pub fn add(&mut self, t: i64, values: &[Option<f64>]) {
        let mut row: Row = vec![Some(t as f64)];
        for (i, _) in SERIES.iter().enumerate() {
            row.push(round(values.get(i).copied().flatten(), DIGITS[i]));
        }
        self.recent.push(row.clone());
        let cut = t - RECENT_MS - self.interval_ms;
        let drop = self.recent.iter().take_while(|r| t_of(r) < cut).count();
        self.recent.drain(..drop);
        if self.recent.len() > 2000 {
            let n = self.recent.len() - 2000;
            self.recent.drain(..n);
        }
        let minute = t.div_euclid(MINUTE) * MINUTE;
        if self.open.as_ref().is_some_and(|o| o.t != minute) {
            self.close_minute();
        }
        let open = self.open.get_or_insert_with(|| Open { t: minute, sum: vec![0.0; SERIES.len()], n: vec![0.0; SERIES.len()] });
        for (i, v) in row[1..].iter().enumerate() {
            if let Some(v) = v {
                open.sum[i] += v;
                open.n[i] += 1.0;
            }
        }
    }

    fn averages(m: &Open) -> Vec<Option<f64>> {
        (0..SERIES.len()).map(|i| if m.n[i] != 0.0 { round(Some(m.sum[i] / m.n[i]), DIGITS[i]) } else { None }).collect()
    }

    fn close_minute(&mut self) {
        let Some(m) = self.open.take() else { return };
        let avg = Self::averages(&m);
        if avg.iter().any(Option::is_some) {
            if self.minutes.last().is_some_and(|r| t_of(r) >= m.t) {
                self.minutes.retain(|r| t_of(r) < m.t);
            }
            let mut row = vec![Some(m.t as f64)];
            row.extend(avg);
            self.minutes.push(row);
        }
        let cut = m.t - DAY_MS;
        let drop = self.minutes.iter().take_while(|r| t_of(r) <= cut).count();
        self.minutes.drain(..drop);
    }

    fn rows(&self, day: bool, t: i64) -> Vec<Row> {
        if day {
            let mut rows: Vec<Row> = self.minutes.iter().filter(|r| t_of(r) > t - DAY_MS).cloned().collect();
            if let Some(m) = &self.open {
                let mut row = vec![Some(m.t as f64)];
                row.extend(Self::averages(m));
                rows.push(row);
            }
            return rows;
        }
        self.recent.iter().filter(|r| t_of(r) > t - RECENT_MS).cloned().collect()
    }

    /// { step, start, series } on a regular grid ending now.
    pub fn range(&self, day: bool, t: i64) -> Value {
        let step = if day { MINUTE } else { self.interval_ms };
        let span = if day { DAY_MS } else { RECENT_MS };
        let n = (js_round(span as f64 / step as f64) as i64).max(1) as usize;
        let end = if day { t.div_euclid(MINUTE) * MINUTE } else { t };
        let start = end - (n as i64 - 1) * step;
        let mut series: Vec<Vec<Value>> = vec![vec![Value::Null; n]; SERIES.len()];
        for row in self.rows(day, t) {
            let slot = js_round((t_of(&row) - start) as f64 / step as f64);
            if slot < 0.0 || slot >= n as f64 {
                continue;
            }
            for i in 0..SERIES.len() {
                if let Some(v) = row[i + 1] {
                    series[i][slot as usize] = num(v);
                }
            }
        }
        let mut m = Map::new();
        for (i, name) in SERIES.iter().enumerate() {
            m.insert(name.to_string(), Value::Array(std::mem::take(&mut series[i])));
        }
        json!({ "step": step, "start": start, "series": m })
    }

    /// The tiles' sparklines: the last 15 min, averaged down to at most 90 points.
    pub fn sparks(&self, t: i64) -> Value {
        let rows = self.rows(false, t);
        let pick = |name: &str, digits: i32| -> Value {
            let i = SERIES.iter().position(|s| *s == name).unwrap();
            let vals: Vec<f64> = rows.iter().filter_map(|r| r[i + 1]).collect();
            if vals.len() <= SPARK_POINTS {
                return json!(vals.iter().map(|v| num(*v)).collect::<Vec<_>>());
            }
            let size = vals.len() as f64 / SPARK_POINTS as f64;
            let out: Vec<Value> = (0..SPARK_POINTS)
                .map(|k| {
                    let part = &vals[(k as f64 * size).floor() as usize..((k + 1) as f64 * size).floor() as usize];
                    round(Some(part.iter().sum::<f64>() / part.len() as f64), digits).map_or(Value::Null, num)
                })
                .collect();
            json!(out)
        };
        json!({ "cpu": pick("cpu", 1), "gpuVideo": pick("gpuVideo", 0), "gpuBusy": pick("gpuBusy", 0), "rxBps": pick("rxBps", 0), "txBps": pick("txBps", 0) })
    }

    /// text/csv of a range: an ISO time column, then the series.
    pub fn csv(&self, day: bool, t: i64) -> String {
        let mut lines = vec![std::iter::once("time").chain(SERIES).collect::<Vec<_>>().join(",")];
        for row in self.rows(day, t) {
            let mut cells = vec![super::js::iso(t_of(&row))];
            cells.extend(row[1..].iter().map(|v| v.map_or(String::new(), super::js::num_text)));
            lines.push(cells.join(","));
        }
        format!("{}\n", lines.join("\n"))
    }

    pub fn to_json(&self) -> Value {
        let rows = |rs: &[Row]| json!(rs.iter().map(|r| r.iter().map(|v| v.map_or(Value::Null, num)).collect::<Vec<_>>()).collect::<Vec<_>>());
        json!({
            "series": SERIES, "recent": rows(&self.recent), "minutes": rows(&self.minutes),
            "open": self.open.as_ref().map(|o| json!({ "t": o.t, "sum": o.sum.iter().map(|x| num(*x)).collect::<Vec<_>>(), "n": o.n.iter().map(|x| num(*x)).collect::<Vec<_>>() }))
        })
    }

    /// Takes back what was saved; anything malformed or too old is skipped.
    pub fn load(&mut self, data: &Value, t: i64) {
        let Some(names) = data["series"].as_array() else { return };
        let idx: Vec<Option<usize>> = SERIES.iter().map(|n| names.iter().position(|x| x == n)).collect();
        let take = |row: &Value| -> Option<Row> {
            let a = row.as_array()?;
            let t0 = a.first()?.as_f64().filter(|x| x.is_finite())?;
            let mut r = vec![Some(t0)];
            for (k, i) in idx.iter().enumerate() {
                r.push(i.and_then(|i| a.get(i + 1)).and_then(Value::as_f64).filter(|x| x.is_finite()).and_then(|v| round(Some(v), DIGITS[k])));
            }
            Some(r)
        };
        let ordered = |rows: &Value, from: i64| -> Vec<Row> {
            let list = rows.as_array().cloned().unwrap_or_default();
            let skip = list.len().saturating_sub(5000);
            let mut out: Vec<Row> = list[skip..].iter().filter_map(take).filter(|r| t_of(r) > from && (r[0].unwrap()) <= (t + MINUTE) as f64).collect();
            out.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap());
            out
        };
        self.recent = ordered(&data["recent"], t - RECENT_MS);
        self.minutes = ordered(&data["minutes"], t - DAY_MS);
        let o = &data["open"];
        if let (Some(ot), Some(sum), Some(n)) = (o["t"].as_f64(), o["sum"].as_array(), o["n"].as_array()) {
            let ot = ot as i64;
            if ot > t - DAY_MS && ot <= t {
                let at = |arr: &Vec<Value>, i: Option<usize>| i.and_then(|i| arr.get(i)).map(super::js::number).filter(|x| x.is_finite() && *x != 0.0).unwrap_or(0.0);
                self.open = Some(Open { t: ot, sum: idx.iter().map(|i| at(sum, *i)).collect(), n: idx.iter().map(|i| at(n, *i)).collect() });
                if t.div_euclid(MINUTE) * MINUTE != ot {
                    self.close_minute();
                }
            }
        }
    }
}

// ---- the machine

fn read(p: &str) -> String {
    fs::read_to_string(p).unwrap_or_default()
}

fn read_line(p: &str) -> Option<String> {
    let t = read(p);
    let l = t.split('\n').next().unwrap_or("").trim().to_string();
    (!l.is_empty()).then_some(l)
}

#[derive(Clone, Copy, Debug)]
struct Ticks {
    busy: f64,
    all: f64,
}

fn parse_proc_stat(text: &str) -> (Option<Ticks>, Vec<(usize, Ticks)>) {
    let mut total = None;
    let mut cores = Vec::new();
    for line in text.split('\n') {
        let Some(rest) = line.strip_prefix("cpu") else { continue };
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        let after = &rest[digits.len()..];
        if !after.starts_with(char::is_whitespace) {
            continue;
        }
        let v: Vec<f64> = after.split_whitespace().map(|x| x.parse::<f64>().unwrap_or(f64::NAN)).collect();
        if v.len() < 4 || v[..4].iter().any(|x| !x.is_finite()) {
            continue;
        }
        let g = |i: usize| v.get(i).copied().filter(|x| x.is_finite()).unwrap_or(0.0);
        let all = (0..8).map(g).sum::<f64>();
        let e = Ticks { busy: all - g(3) - g(4), all };
        if digits.is_empty() {
            total = Some(e);
        } else {
            cores.push((digits.parse().unwrap_or(0), e));
        }
    }
    cores.sort_by_key(|c| c.0);
    (total, cores)
}

/// "12th Gen Intel(R) Core(TM) i5-12500" -> "Intel Core i5-12500"
pub fn clean_model(name: &str) -> Option<String> {
    use fancy_regex::Regex;
    let mut s = name.to_string();
    for (re, to) in [
        (r"\((R|TM|tm|r)\)", ""),
        (r"(?i)^[0-9]+(st|nd|rd|th) Gen ", ""),
        (r"(?i)\s+@\s+[0-9.]+\s*GHz", ""),
        (r"\s+CPU(?=[^A-Za-z0-9_]|$)", ""),
        (r"(?i)\s+[0-9]+-Core Processor(?=[^A-Za-z0-9_]|$)", ""),
        (r"(?i)\s+with Radeon( [A-Za-z0-9_]+)* Graphics(?=[^A-Za-z0-9_]|$)", ""),
        (r"(?i)\s+Processor(?=[^A-Za-z0-9_]|$)", ""),
        (r"\s+", " "),
    ] {
        let r = Regex::new(re).unwrap();
        // (the JS regexes without g replace the first match only)
        let global = re == r"\((R|TM|tm|r)\)" || re == r"\s+CPU(?=[^A-Za-z0-9_]|$)" || re == r"\s+";
        s = if global { r.replace_all(&s, to).into_owned() } else { r.replace(&s, to).into_owned() };
    }
    let s = s.trim().to_string();
    (!s.is_empty()).then_some(s)
}

#[derive(Clone, Debug, Default)]
struct CpuInfo {
    model: Option<String>,
    cores: Option<usize>,
    threads: Option<usize>,
}

fn parse_cpuinfo(text: &str, dt_model: Option<String>) -> CpuInfo {
    let mut threads = 0;
    let mut core_keys = std::collections::HashSet::new();
    let (mut model_name, mut hardware, mut board): (Option<String>, Option<String>, Option<String>) = (None, None, None);
    for block in text.split("\n\n") {
        let mut kv: HashMap<String, String> = HashMap::new();
        for line in block.split('\n') {
            if let Some(i) = line.find(':').filter(|i| *i > 0) {
                kv.insert(line[..i].trim().to_string(), line[i + 1..].trim().to_string());
            }
        }
        if kv.get("processor").is_some_and(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit())) {
            threads += 1;
            if let Some(c) = kv.get("core id") {
                core_keys.insert(format!("{}:{c}", kv.get("physical id").map_or("0", |s| if s.is_empty() { "0" } else { s })));
            }
        }
        let pick = |cur: &mut Option<String>, k: &str| {
            if cur.is_none() {
                *cur = kv.get(k).filter(|s| !s.is_empty()).cloned();
            }
        };
        pick(&mut model_name, "model name");
        pick(&mut hardware, "Hardware");
        pick(&mut board, "Model");
    }
    let arm = model_name.as_deref().is_some_and(|m| m.len() >= 4 && m[..3].eq_ignore_ascii_case("arm") && m.as_bytes()[3] == b'v');
    let model = match &model_name {
        Some(m) if !arm => clean_model(m),
        _ => board.or(dt_model).or(hardware).or_else(|| model_name.as_deref().and_then(clean_model)),
    };
    let t = (threads > 0).then_some(threads);
    CpuInfo { model, threads: t, cores: if core_keys.is_empty() { t } else { Some(core_keys.len()) } }
}

fn os_from_kernel(release: &str, version: &str) -> Option<&'static str> {
    use fancy_regex::Regex;
    let s = format!("{release} {version}");
    let tests = [
        (r"(?i)unraid", "Unraid"), (r"(?i)truenas", "TrueNAS"), (r"(?i)-pve(?=[^A-Za-z0-9_]|$)|proxmox", "Proxmox VE"), (r"(?i)synology", "Synology DSM"),
        (r"(?i)qnap", "QNAP QTS"), (r"(?i)microsoft|WSL", "Windows (WSL)"), (r"(?i)rpt-rpi|raspberrypi|\+rpt", "Raspberry Pi OS"),
        (r"(?i)ubuntu", "Ubuntu"), (r"(?i)debian|\+deb[0-9]+", "Debian"), (r"(?i)\.fc[0-9]+\.", "Fedora"), (r"(?i)\.el[0-9]+", "Enterprise Linux"),
        (r"(?i)-arch[0-9]|archlinux", "Arch Linux"), (r"(?i)manjaro", "Manjaro"), (r"(?i)gentoo", "Gentoo"), (r"(?i)alpine|-lts(?=[^A-Za-z0-9_]|$)", "Alpine"),
        (r"(?i)nixos", "NixOS"), (r"(?i)suse", "openSUSE"), (r"(?i)talos", "Talos"), (r"(?i)linuxkit", "Docker Desktop"),
    ];
    for (re, name) in tests {
        if Regex::new(re).unwrap().is_match(&s).unwrap_or(false) {
            return Some(name);
        }
    }
    (!release.is_empty()).then_some("Linux")
}

fn net_skip(n: &str) -> bool {
    let pre = ["lo", "veth", "podman", "virbr", "lxcbr", "lxdbr", "incusbr", "cni", "flannel", "cali", "cilium", "weave", "vnet", "fwbr", "fwpr", "fwln", "ifb", "dummy", "kube", "vxlan", "genev", "tunl", "gre"];
    let digit_after = |p: &str| n.strip_prefix(p).is_some_and(|r| r.starts_with(|c: char| c.is_ascii_digit()));
    pre.iter().any(|p| n.starts_with(p)) || digit_after("docker") || digit_after("tap") || digit_after("sit") || n.starts_with("ip6tnl") || n.strip_prefix("br-").is_some_and(|r| r.len() >= 6 && r[..6].bytes().all(|c| c.is_ascii_hexdigit()))
}

fn net_tunnel(n: &str) -> bool {
    ["tun", "wg", "tailscale", "zt", "ppp", "nordlynx", "nordtun"].iter().any(|p| n.starts_with(p)) || n.strip_prefix("wt").is_some_and(|r| r.starts_with(|c: char| c.is_ascii_digit()))
}

struct Prev {
    cpu: Option<(Ticks, Vec<(usize, Ticks)>)>,
    net: Option<(i64, HashMap<String, (f64, f64)>)>,
}

pub struct Stats {
    data_file: Option<PathBuf>,
    interval_ms: i64,
    version: Value,
    inner: Mutex<Inner>,
}

struct Inner {
    history: History,
    /// energy, traffic and shares of the saved file, kept as they are
    kept: Map<String, Value>,
    body: Value,
    prev: Prev,
    info: Option<CpuInfo>,
    watch_until: Option<i64>,
    sampling: bool,
    last_save: i64,
    dirty: bool,
    started_ms: i64,
    ffmpeg: Value,
}

fn skeleton(interval_ms: i64, version: &Value, ffmpeg: &Value) -> Value {
    json!({
        "at": null, "intervalMs": interval_ms,
        "host": { "hostname": null, "os": null, "kernel": null, "arch": null, "uptimeS": null, "appUptimeS": null, "version": version, "node": null, "ffmpeg": ffmpeg },
        "cpu": { "model": null, "cores": null, "threads": null, "usage": null, "perCore": [], "freqMHz": null, "tempC": null, "load": null, "app": { "usage": null, "ffmpegUsage": null, "ffmpegCount": null }, "throttling": false, "sockets": 1, "perSocket": null },
        "memory": { "totalB": null, "usedB": null, "availableB": null, "cacheB": null, "swapTotalB": null, "swapUsedB": null, "appB": null },
        "gpus": [],
        "power": { "totalW": null, "cpuW": null, "gpuW": null, "chipW": null, "discreteW": null, "todayWh": null, "weekWh": null, "todayCost": null, "weekCost": null, "priceNow": null, "cpuSource": null, "gpuSource": null, "cpuUnavailable": null, "peakW": null },
        "disks": [],
        "filesystems": [],
        "network": { "scope": "container", "interfaces": [], "today": null, "week": null, "month": null },
        "sensors": [],
        "processes": { "scope": "container", "top": [] },
        "alerts": [],
        "unlock": [],
        "sparks": { "cpu": [], "gpuVideo": [], "gpuBusy": [], "rxBps": [], "txBps": [] }
    })
}

fn meminfo() -> Value {
    let text = read("/proc/meminfo");
    let mut m: HashMap<String, f64> = HashMap::new();
    for line in text.split('\n') {
        if let Some((k, v)) = line.split_once(':') {
            if let Some(n) = v.split_whitespace().next().and_then(|x| x.parse::<f64>().ok()) {
                m.insert(k.trim().to_string(), n);
            }
        }
    }
    let kb = |k: &str| m.get(k).map(|v| v * 1024.0);
    let Some(total) = kb("MemTotal").filter(|t| *t != 0.0) else {
        return json!({ "totalB": null, "usedB": null, "availableB": null, "cacheB": null, "swapTotalB": kb("SwapTotal").map(num), "swapUsedB": null, "appB": null });
    };
    let avail = kb("MemAvailable").unwrap_or_else(|| kb("MemFree").unwrap_or(0.0) + kb("Buffers").unwrap_or(0.0) + kb("Cached").unwrap_or(0.0)).max(0.0).min(total);
    let cache = kb("Buffers").unwrap_or(0.0) + kb("Cached").unwrap_or(0.0) + kb("SReclaimable").unwrap_or(0.0);
    let (st, sf) = (kb("SwapTotal"), kb("SwapFree"));
    let app = fs::read_to_string("/proc/self/statm").ok().and_then(|s| s.split_whitespace().nth(1).and_then(|x| x.parse::<f64>().ok())).map(|p| p * 4096.0);
    json!({
        "totalB": num(total), "usedB": num(total - avail), "availableB": num(avail), "cacheB": num(cache),
        "swapTotalB": st.map(num), "swapUsedB": match (st, sf) { (Some(a), Some(b)) => num((a - b).max(0.0)), _ => Value::Null }, "appB": app.map(num)
    })
}

impl Stats {
    pub fn new(data_dir: Option<PathBuf>, version: Value) -> Arc<Stats> {
        let interval_ms = 2000;
        let now = super::store::now_ms();
        let mut inner = Inner {
            history: History::new(interval_ms),
            kept: Map::new(),
            body: skeleton(interval_ms, &version, &Value::Null),
            prev: Prev { cpu: None, net: None },
            info: None,
            watch_until: None,
            sampling: false,
            last_save: now,
            dirty: false,
            started_ms: now,
            ffmpeg: Value::Null,
        };
        let data_file = data_dir.map(|d| d.join("stats-history.json"));
        if let Some(f) = &data_file {
            if fs::metadata(f).is_ok_and(|m| m.len() <= MAX_FILE_BYTES) {
                if let Some(Value::Object(d)) = fs::read(f).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) {
                    if d.get("v") == Some(&json!(1)) {
                        inner.history.load(d.get("history").unwrap_or(&Value::Null), now);
                        for k in ["energy", "traffic", "shares"] {
                            if let Some(v) = d.get(k) {
                                inner.kept.insert(k.into(), v.clone());
                            }
                        }
                    }
                }
            }
        }
        Arc::new(Stats { data_file, interval_ms, version, inner: Mutex::new(inner) })
    }

    pub fn set_ffmpeg_version(&self, v: Option<String>) {
        let mut i = self.inner.lock().unwrap();
        i.ffmpeg = json!(v);
        i.body["host"]["ffmpeg"] = json!(v);
    }

    pub fn snapshot(&self) -> Value {
        self.inner.lock().unwrap().body.clone()
    }

    pub fn history(&self, day: bool) -> Value {
        self.inner.lock().unwrap().history.range(day, super::store::now_ms())
    }

    pub fn csv(&self, day: bool) -> String {
        self.inner.lock().unwrap().history.csv(day, super::store::now_ms())
    }

    fn save(&self, i: &mut Inner) {
        let Some(f) = &self.data_file else { return };
        let mut out = json!({ "v": 1, "savedAt": super::store::now_ms(), "history": i.history.to_json() });
        for (k, v) in &i.kept {
            out[k] = v.clone();
        }
        let tmp = PathBuf::from(format!("{}.{}.tmp", f.display(), std::process::id()));
        if let Some(d) = f.parent() {
            let _ = fs::create_dir_all(d);
        }
        use std::os::unix::fs::OpenOptionsExt;
        let ok = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp).and_then(|mut fh| {
            use std::io::Write;
            fh.write_all(out.to_string().as_bytes())
        });
        if ok.is_ok() && fs::rename(&tmp, f).is_ok() {
            i.dirty = false;
        } else {
            let _ = fs::remove_file(&tmp);
        }
        i.last_save = super::store::now_ms();
    }

    /// One sample now (the sampler's tick; tests).
    pub fn sample_now(&self) -> Value {
        let t = super::store::now_ms();
        let mut i = self.inner.lock().unwrap();
        if i.info.is_none() {
            let dt = read_line("/sys/firmware/devicetree/base/model").or_else(|| read_line("/proc/device-tree/model")).map(|s| s.replace('\0', "").trim().to_string()).filter(|s| !s.is_empty());
            i.info = Some(parse_cpuinfo(&read("/proc/cpuinfo"), dt));
        }
        let info = i.info.clone().unwrap_or_default();
        // cpu
        let (total, cores) = parse_proc_stat(&read("/proc/stat"));
        let (mut usage, mut per_core) = (None, Vec::new());
        if let (Some(tot), Some((ptot, pcores))) = (total, &i.prev.cpu) {
            let all = tot.all - ptot.all;
            let busy = tot.busy - ptot.busy;
            if all > 0.0 && busy >= 0.0 {
                usage = Some((busy / all * 100.0).clamp(0.0, 100.0));
            }
            for (n, c) in &cores {
                let before = pcores.iter().find(|(m, _)| m == n).map(|x| x.1);
                let a = before.map_or(0.0, |b| c.all - b.all);
                let b = before.map_or(-1.0, |b| c.busy - b.busy);
                per_core.push(if a > 0.0 && b >= 0.0 { round(Some((b / a * 100.0).clamp(0.0, 100.0)), 0).map_or(Value::Null, num) } else { Value::Null });
            }
        }
        if let Some(tot) = total {
            i.prev.cpu = Some((tot, cores));
        }
        let mut freq: Option<f64> = None;
        if let Ok(rd) = fs::read_dir("/sys/devices/system/cpu") {
            for e in rd.filter_map(|e| e.ok()).take(64) {
                let n = e.file_name().to_string_lossy().into_owned();
                if n.len() > 3 && n.starts_with("cpu") && n[3..].bytes().all(|c| c.is_ascii_digit()) {
                    if let Some(khz) = read_line(&format!("/sys/devices/system/cpu/{n}/cpufreq/scaling_cur_freq")).and_then(|s| s.parse::<f64>().ok()) {
                        if khz > 0.0 && freq.is_none_or(|f| khz / 1000.0 > f) {
                            freq = Some(khz / 1000.0);
                        }
                    }
                }
            }
        }
        let load: Vec<f64> = read_line("/proc/loadavg").unwrap_or_default().split_whitespace().take(3).filter_map(|x| x.parse().ok()).collect();
        let usage_r = round(usage, 1);
        // memory
        let memory = meminfo();
        // network
        let mut counters: HashMap<String, (f64, f64)> = HashMap::new();
        let mut names = Vec::new();
        for line in read("/proc/net/dev").split('\n') {
            let Some(ix) = line.find(':') else { continue };
            let name = line[..ix].trim().to_string();
            let f: Vec<f64> = line[ix + 1..].split_whitespace().map(|x| x.parse().unwrap_or(f64::NAN)).collect();
            if name.is_empty() || f.len() < 9 || !f[0].is_finite() || !f[8].is_finite() || net_skip(&name) {
                continue;
            }
            counters.insert(name.clone(), (f[0], f[8]));
            names.push(name);
        }
        if names.iter().any(|n| !net_tunnel(n)) {
            names.retain(|n| !net_tunnel(n));
        }
        names.sort();
        let mut interfaces = Vec::new();
        let (mut rx_sum, mut tx_sum, mut any_rate) = (0.0, 0.0, false);
        for n in &names {
            let c = counters[n];
            let before = i.prev.net.as_ref().and_then(|(at, m)| m.get(n).map(|b| (*at, *b)));
            let rates = before.and_then(|(at, b)| {
                let dt = (t - at) as f64 / 1000.0;
                (dt > 0.0 && c.0 >= b.0 && c.1 >= b.1).then(|| (js_round((c.0 - b.0) / dt), js_round((c.1 - b.1) / dt)))
            });
            if let Some((r, x)) = rates {
                rx_sum += r;
                tx_sum += x;
                any_rate = true;
            }
            let speed = read_line(&format!("/sys/class/net/{n}/speed")).and_then(|s| s.parse::<f64>().ok()).filter(|s| *s > 0.0);
            interfaces.push(json!({ "name": n, "speedMbps": speed.map(num), "rxBps": rates.map(|r| num(r.0)), "txBps": rates.map(|r| num(r.1)) }));
        }
        i.prev.net = Some((t, counters));
        // host
        let kernel = read_line("/proc/sys/kernel/osrelease").unwrap_or_default();
        let uptime = read_line("/proc/uptime").and_then(|s| s.split_whitespace().next().and_then(|x| x.parse::<f64>().ok()));
        let app_uptime = (t - i.started_ms) / 1000;
        let host = json!({
            "hostname": read_line("/proc/sys/kernel/hostname"),
            "os": os_from_kernel(&kernel, &read("/proc/version")),
            "kernel": if kernel.is_empty() { Value::Null } else { json!(kernel) },
            "arch": read_line("/proc/sys/kernel/arch").unwrap_or_else(|| std::env::consts::ARCH.to_string()),
            "version": self.version, "node": null,
            "uptimeS": uptime.map(|u| num(js_round(u))), "appUptimeS": app_uptime, "ffmpeg": i.ffmpeg
        });
        let mut body = skeleton(self.interval_ms, &self.version, &i.ffmpeg);
        body["at"] = json!(t);
        body["host"] = host;
        body["cpu"]["model"] = json!(info.model);
        body["cpu"]["cores"] = json!(info.cores);
        body["cpu"]["threads"] = json!(info.threads);
        body["cpu"]["usage"] = usage_r.map_or(Value::Null, num);
        body["cpu"]["perCore"] = json!(per_core);
        body["cpu"]["freqMHz"] = freq.map_or(Value::Null, |f| num(js_round(f)));
        body["cpu"]["load"] = if load.len() == 3 { json!(load.iter().map(|x| num(*x)).collect::<Vec<_>>()) } else { Value::Null };
        body["memory"] = memory.clone();
        body["network"]["interfaces"] = json!(interfaces);
        for k in ["today", "week", "month"] {
            body["network"][k] = Value::Null;
        }
        let mem_pct = match (memory["usedB"].as_f64(), memory["totalB"].as_f64()) {
            (Some(u), Some(tt)) if tt > 0.0 => Some(u / tt * 100.0),
            _ => None,
        };
        let values = [usage_r, mem_pct, None, None, None, any_rate.then_some(rx_sum), any_rate.then_some(tx_sum), None];
        i.history.add(t, &values);
        body["sparks"] = i.history.sparks(t);
        i.body = body.clone();
        i.dirty = true;
        if t - i.last_save >= SAVE_EVERY_MS {
            self.save(&mut i);
        }
        body
    }

    /// A page is watching: sample for the next 15 s.
    pub fn touch(self: &Arc<Self>) {
        let start = {
            let mut i = self.inner.lock().unwrap();
            i.watch_until = Some(i.watch_until.unwrap_or(0).max(super::store::now_ms() + WATCH_MS));
            let s = !i.sampling;
            i.sampling = true;
            s
        };
        if !start {
            return;
        }
        self.sample_now();
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            loop {
                let wanted = me.inner.lock().unwrap().watch_until.is_some_and(|w| super::store::now_ms() < w);
                if !wanted {
                    let mut i = me.inner.lock().unwrap();
                    i.sampling = false;
                    if i.dirty {
                        me.save(&mut i);
                    }
                    return;
                }
                let began = std::time::Instant::now();
                me.sample_now();
                let took = began.elapsed().as_millis() as i64;
                std::thread::sleep(Duration::from_millis((me.interval_ms - took).max(me.interval_ms / 2) as u64));
            }
        });
    }

    /// At shutdown: what was sampled is kept.
    pub fn stop(&self) {
        let mut i = self.inner.lock().unwrap();
        if i.dirty {
            self.save(&mut i);
        }
    }
}

/// The CSV's file name, as Node's Content-Disposition gives it.
pub fn csv_name(range: &str) -> String {
    format!("sentry-six-manager-stats-{range}.csv")
}

#[cfg(test)]
mod tests {
    use super::*;

    // test/statsHistory.test.js (the grid, minute averages, CSV and a restart)
    #[test]
    fn history_grid_minutes_csv_and_reload() {
        let mut h = History::new(2000);
        let t0 = 1_763_200_000_000i64 - (1_763_200_000_000i64 % MINUTE);
        for k in 0..40 {
            h.add(t0 + k * 2000, &[Some(10.0 + k as f64), Some(50.04), None, None, Some(12.25), Some(1000.4), Some(0.0), None]);
        }
        let now = t0 + 39 * 2000;
        let r = h.range(false, now);
        assert_eq!(r["step"], 2000);
        let cpu = r["series"]["cpu"].as_array().unwrap();
        assert_eq!(cpu.len(), 450);
        assert_eq!(cpu[449], 49);
        assert_eq!(cpu[449 - 39], 10);
        assert_eq!(cpu[0], Value::Null);
        assert_eq!(r["series"]["memory"][449], 50.0);
        let day = h.range(true, now);
        assert_eq!(day["series"]["cpu"].as_array().unwrap().len(), 1440);
        // the first minute closed (30 samples: 10..39), the second open (40..49)
        assert_eq!(day["series"]["cpu"][1439], 44.5);
        assert_eq!(day["series"]["cpu"][1438], 24.5);
        let csv = h.csv(false, now);
        let mut lines = csv.lines();
        assert_eq!(lines.next(), Some("time,cpu,memory,gpuBusy,gpuVideo,powerW,rxBps,txBps,tempMax"));
        assert_eq!(lines.next().unwrap(), format!("{},10,50,,,12.3,1000,0,", super::super::js::iso(t0)));
        // a restart takes it back
        let saved = h.to_json();
        let mut again = History::new(2000);
        again.load(&saved, now);
        assert_eq!(again.range(false, now), r);
        assert_eq!(again.range(true, now), day);
        let s = h.sparks(now);
        assert_eq!(s["cpu"].as_array().unwrap().len(), 40);
    }

    #[test]
    fn rounding_and_models_as_node() {
        assert_eq!(round(Some(12.25), 1), Some(12.3));
        assert_eq!(round(Some(-2.5), 0), Some(-2.0));
        assert_eq!(clean_model("12th Gen Intel(R) Core(TM) i5-12500").as_deref(), Some("Intel Core i5-12500"));
        assert_eq!(clean_model("AMD Ryzen 7 5700G with Radeon Graphics").as_deref(), Some("AMD Ryzen 7 5700G"));
        assert_eq!(clean_model("Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz").as_deref(), Some("Intel Xeon E5-2680 v4"));
        assert_eq!(clean_model("AMD Ryzen 9 5950X 16-Core Processor").as_deref(), Some("AMD Ryzen 9 5950X"));
        assert_eq!(os_from_kernel("6.6.44-production+truenas", ""), Some("TrueNAS"));
        assert_eq!(os_from_kernel("6.1.0-25-amd64", "Linux version 6.1.0-25-amd64 (debian-kernel@lists.debian.org)"), Some("Debian"));
        assert_eq!(os_from_kernel("", ""), None);
    }

    #[test]
    fn a_sample_has_every_part_of_nodes_answer() {
        let dir = std::env::temp_dir().join(format!("lean-stats-{}", std::process::id()));
        let s = Stats::new(Some(dir.clone()), json!("Build 1"));
        let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        let sk = skeleton(2000, &json!(null), &json!(null));
        assert_eq!(keys(&s.snapshot()), keys(&sk));
        s.sample_now();
        std::thread::sleep(Duration::from_millis(300));
        let b = s.sample_now();
        for part in ["host", "cpu", "memory", "power", "network", "processes", "sparks"] {
            let mut a = keys(&b[part]);
            let mut c = keys(&sk[part]);
            a.sort();
            c.sort();
            assert_eq!(a, c, "{part}");
        }
        assert!(b["memory"]["totalB"].as_f64().unwrap() > 0.0);
        s.stop();
        assert!(dir.join("stats-history.json").exists());
        let again = Stats::new(Some(dir.clone()), json!(null));
        assert!(again.history(false)["series"]["memory"].as_array().unwrap().iter().any(|v| !v.is_null()), "the history survives a restart");
        let _ = fs::remove_dir_all(&dir);
    }
}
