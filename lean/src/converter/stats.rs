//! server/encoderStats.js (the `encoder` block of GET /api/stats: what the
//! running conversion uses and what it has cost so far) and
//! server/convertStats.js (the heartbeat's `convert` and `nodes`: the
//! average speed of the last 24 hours of converting and the latest encode).
//! `OpsCtx::encoder_block` and `OpsCtx::heartbeat_hardware` call these.

use super::contracts::js_round;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub const RUNNING: [&str; 8] = ["discovering", "waiting", "staging", "encoding", "writing-telemetry", "verifying", "copying", "replacing"];

fn running(state: &Value) -> bool {
    state.as_str().is_some_and(|s| RUNNING.contains(&s))
}

fn r1(n: f64) -> f64 {
    js_round(n * 10.0) / 10.0
}

fn num(x: f64) -> Value {
    super::jobstore::normalize::num(x)
}

/// gpuFor(gpus, node): the GPU a render node belongs to, or the only GPU there is
pub fn gpu_for<'a>(gpus: &'a Value, node: &Value) -> Option<&'a Value> {
    let list = gpus.as_array().filter(|a| !a.is_empty())?;
    let n = node.as_str().filter(|s| !s.is_empty());
    list.iter()
        .find(|g| {
            let (Some(n), Some(gn)) = (n, g["node"].as_str().filter(|s| !s.is_empty())) else { return false };
            gn == n || n.ends_with(&format!("/{gn}")) || gn.ends_with(&format!("/{n}"))
        })
        .or(if list.len() == 1 { Some(&list[0]) } else { None })
}

/// jobProgress(job): clips converted so far and the bytes they saved
pub fn job_progress(job: &Value) -> (i64, f64) {
    let saved = crate::ops::js::number(&job["counters"]["savedBytes"]);
    let saved = if saved.is_finite() { saved } else { 0.0 };
    let items = job["items"].as_array();
    if let Some(p) = super::jobstore::normalize::safe_int_of(&job["progressClips"]) {
        if items.map_or(true, |i| i.is_empty()) {
            return (p, saved);
        }
    }
    let clips = items.into_iter().flatten().filter(|i| i["kind"] == "video" && i["state"] == "completed" && i["eligibleVideo"] != false).count() as i64;
    (clips, saved)
}

/// concurrencyOf(job, slots)
pub fn concurrency_of(job: &Value, slots: Option<i64>) -> Value {
    if let Some(s) = slots.filter(|s| *s > 0) {
        return json!(s);
    }
    let c = &job["config"];
    if let Some(n) = super::jobstore::normalize::safe_int_of(&c["concurrency"]).filter(|n| *n > 0) {
        return json!(n);
    }
    let lanes: i64 = c["lanes"].as_array().into_iter().flatten().filter_map(|l| super::jobstore::normalize::safe_int_of(&l["concurrency"])).filter(|n| *n > 0).sum();
    if lanes > 0 {
        json!(lanes)
    } else {
        Value::Null
    }
}

fn device_entries(workers: &[Value], gpus: &Value) -> Vec<Value> {
    let lanes = workers.iter().any(|w| !w["deviceId"].is_null());
    let mut groups: indexmap::IndexMap<String, (Value, Vec<&Value>)> = indexmap::IndexMap::new();
    for w in workers {
        let key = if lanes { w["deviceId"].clone() } else { Value::Null };
        groups.entry(key.to_string()).or_insert((key, vec![])).1.push(w);
    }
    let mut entries: Vec<Value> = groups
        .into_values()
        .map(|(id, list)| {
            let first = list.iter().find(|w| w["hardware"] == true && super::jobstore::normalize::truthy(&w["device"])).or(list.iter().find(|w| w["hardware"] == true)).unwrap_or(&list[0]);
            let hw = first["hardware"] == true;
            let gpu = if hw { gpu_for(gpus, &first["device"]) } else { None };
            let truthy = |v: &Value| super::jobstore::normalize::truthy(v);
            let name = if truthy(&first["node"]) { first["node"].clone() } else if hw { gpu.map(|g| g["name"].clone()).filter(truthy).unwrap_or(Value::Null) } else { json!("CPU") };
            let node = if truthy(&first["device"]) { first["device"].clone() } else if hw { gpu.map(|g| g["node"].clone()).filter(truthy).unwrap_or(Value::Null) } else { Value::Null };
            json!({
                "id": id, "name": name, "node": node,
                "encoder": if truthy(&first["encoder"]) { first["encoder"].clone() } else { Value::Null },
                "hardware": hw, "workers": list.len(),
                "video": gpu.map(|g| g.get("video").cloned().unwrap_or(Value::Null)).unwrap_or(Value::Null),
                "busy": gpu.map(|g| g.get("busy").cloned().unwrap_or(Value::Null)).unwrap_or(Value::Null)
            })
        })
        .collect();
    // GPUs first, in a steady order; the CPU last (Tesla-free ids: [a-z0-9:.@_-])
    let text = |v: &Value| match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        o => o.to_string(),
    };
    entries.sort_by(|a, b| (a["hardware"] != true).cmp(&(b["hardware"] != true)).then_with(|| super::jobstore::locale_cmp(&text(&a["id"]), &text(&b["id"]))));
    entries
}

/// encoderBlock's memory across polls: the device of a running job's last
/// encode, and whether its energy includes the CPU's
#[derive(Default)]
pub struct EncoderStats {
    last_device: Mutex<HashMap<String, Value>>,
    cpu_known: Mutex<HashMap<String, Value>>,
}

impl EncoderStats {
    /// encoderBlock({ snapshot, jobs, workers, energy, slotsOf }); `jobs` in the
    /// server's order; null when no conversion job is known
    pub fn encoder_block(&self, snapshot: &Value, jobs: &[Value], workers: &[Value], energy: &Value, slots_of: Option<&dyn Fn(&str) -> Option<i64>>) -> Value {
        let job = jobs.iter().find(|j| running(&j["state"])).or_else(|| jobs.iter().find(|j| j["state"] == "paused" || j["state"] == "paused_network"));
        if job.is_none() && workers.is_empty() {
            return Value::Null;
        }
        let id = job.map(|j| j["id"].as_str().unwrap_or("").to_string());
        let mine: Vec<Value> = workers.iter().filter(|w| id.as_ref().map_or(true, |i| w["jobId"] == i.as_str())).filter(|w| w["waitingOnNode"] != true && w["started"] != false).cloned().collect();
        for known in [&self.last_device, &self.cpu_known] {
            known.lock().unwrap().retain(|k, _| id.as_deref() == Some(k.as_str()));
        }
        if let (Some(i), Some(m)) = (&id, mine.first()) {
            self.last_device.lock().unwrap().insert(i.clone(), m.clone());
        }
        let first = mine.first().cloned().or_else(|| if job.is_some_and(|j| running(&j["state"])) { self.last_device.lock().unwrap().get(id.as_ref().unwrap()).cloned() } else { None });
        let gpu = gpu_for(&snapshot["gpus"], first.as_ref().map(|f| &f["device"]).unwrap_or(&Value::Null)).cloned();
        let (clips, saved) = job.map(job_progress).unwrap_or((0, 0.0));
        let run = id.as_ref().and_then(|i| energy["byJob"].get(i)).filter(|r| super::jobstore::normalize::truthy(r)).cloned();
        let base = run.as_ref().map(|r| r["base"].clone()).filter(|b| super::jobstore::normalize::truthy(b));
        let power = &snapshot["power"];
        let truthy = super::jobstore::normalize::truthy;
        let measured = if truthy(&power["cpuSource"]) || power["chipW"].as_f64().is_some_and(f64::is_finite) {
            Some(true)
        } else if truthy(&power["gpuSource"]) {
            Some(false)
        } else {
            None
        };
        if let (Some(i), Some(m)) = (&id, measured) {
            let mut k = self.cpu_known.lock().unwrap();
            if k.get(i) != Some(&json!(true)) {
                k.insert(i.clone(), json!(m));
            }
        }
        let cpu_measured = match &id {
            Some(i) => self.cpu_known.lock().unwrap().get(i).cloned().unwrap_or(Value::Null),
            None => measured.map(Value::from).unwrap_or(Value::Null),
        };
        let slots = match (&id, slots_of) {
            (Some(i), Some(f)) => std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(i))).ok().flatten(),
            _ => None,
        };
        let devices = device_entries(&mine, &snapshot["gpus"]);
        let device = first.as_ref().map(|f| {
            let hw = f["hardware"] == true;
            json!({
                "encoder": if truthy(&f["encoder"]) { f["encoder"].clone() } else { Value::Null },
                "hardware": hw,
                "gpuName": if hw { gpu.as_ref().map(|g| g["name"].clone()).filter(truthy).unwrap_or(Value::Null) } else { Value::Null },
                "node": if truthy(&f["device"]) { f["device"].clone() } else { gpu.as_ref().map(|g| g["node"].clone()).filter(truthy).unwrap_or(Value::Null) },
                "decode": if truthy(&f["decode"]) { f["decode"].clone() } else { Value::Null }
            })
        });
        let run_block = job.map(|j| {
            let n = |v: &Value| crate::ops::js::number(v);
            let mut m = Map::new();
            match &run {
                Some(r) => {
                    m.insert("wh".into(), num(r1(n(&r["wh"]))));
                    m.insert("avgW".into(), num(js_round(n(&r["avgW"]))));
                    m.insert("cost".into(), r.get("cost").cloned().unwrap_or(Value::Null));
                    if n(&r["nodeWh"]) > 0.0 {
                        m.insert("nodeWh".into(), num(r1(n(&r["nodeWh"]))));
                    }
                    let (bc, bs, bw) = base.as_ref().map(|b| (n(&b["clips"]), n(&b["savedB"]), n(&b["wh"]))).unwrap_or((0.0, 0.0, 0.0));
                    m.insert("clips".into(), if base.is_some() { num((clips as f64 - bc).max(0.0)) } else { json!(0) });
                    m.insert("savedB".into(), if base.is_some() { num((saved - bs).max(0.0)) } else { json!(0) });
                    m.insert("sinceWh".into(), if base.is_some() { num(r1((n(&r["wh"]) - bw).max(0.0))) } else { json!(0) });
                }
                None => {
                    m.insert("wh".into(), Value::Null);
                    m.insert("avgW".into(), Value::Null);
                    m.insert("cost".into(), Value::Null);
                    m.insert("clips".into(), json!(clips));
                    m.insert("savedB".into(), num(saved));
                    m.insert("sinceWh".into(), Value::Null);
                }
            }
            m.insert("cpuMeasured".into(), cpu_measured.clone());
            let started = if truthy(&j["startedAt"]) { j["startedAt"].clone() } else if truthy(&j["createdAt"]) { j["createdAt"].clone() } else { Value::Null };
            m.insert("startedAt".into(), started);
            Value::Object(m)
        });
        json!({
            "jobId": id, "state": job.map(|j| j["state"].clone()).unwrap_or(Value::Null),
            "running": job.is_some_and(|j| running(&j["state"])), "workers": mine,
            "concurrency": job.map(|j| concurrency_of(j, slots)).unwrap_or(Value::Null),
            "device": device, "devices": devices, "run": run_block
        })
    }
}

// ---- convertStats.js

const KEY: &str = "convert-stats";
const NODES_KEY: &str = "convert-stats-nodes";
pub const DAY_MS: i64 = 86_400_000;

/// apiOf(encoder): nvenc, vaapi, qsv, amf, videotoolbox, mf, v4l2m2m, cpu, or None
pub fn api_of(encoder: &str) -> Option<&'static str> {
    for api in ["nvenc", "vaapi", "qsv", "amf", "videotoolbox", "mf", "v4l2m2m"] {
        if encoder.ends_with(&format!("_{api}")) {
            return Some(api);
        }
    }
    let rest = encoder.strip_prefix("lib")?;
    (!rest.is_empty() && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')).then_some("cpu")
}

/// codecOf(encoder): h265, av1, h264, or None
pub fn codec_of(e: &str) -> Option<&'static str> {
    if e.starts_with("hevc_") || e == "libx265" || e == "libkvazaar" {
        Some("h265")
    } else if e.starts_with("av1_") || ["libsvtav1", "libaom-av1", "librav1e"].contains(&e) {
        Some("av1")
    } else if e.starts_with("h264_") || e == "libx264" || e == "libopenh264" {
        Some("h264")
    } else {
        None
    }
}

/// a node's lane: the node's 12 letters and its own device
fn lane_of(e: &Value) -> Option<(String, Option<String>)> {
    let id = e["deviceId"].as_str()?;
    let rest = id.strip_prefix("node:")?;
    let (node, dev) = match rest.split_once('@') {
        Some((n, d)) => (n, Some(d)),
        None => (rest, None),
    };
    if node.len() != 12 || !node.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) {
        return None;
    }
    if let Some(d) = dev {
        if d != "cpu" && !super::contracts::is_local_device_id(d) {
            return None;
        }
    }
    Some((node.to_string(), dev.map(str::to_string)))
}

fn empty() -> Value {
    json!({ "fps": null, "encoder": null, "device": null, "api": null, "codec": null })
}

/// topEncode(list): the encoder most clips use (a GPU first on a tie)
fn top_encode(list: &[Value]) -> Value {
    let mut count: HashMap<String, usize> = HashMap::new();
    for e in list {
        *count.entry(e["encoder"].to_string()).or_insert(0) += 1;
    }
    let mut l = list.to_vec();
    l.sort_by(|a, b| count[&b["encoder"].to_string()].cmp(&count[&a["encoder"].to_string()]).then((b["hardware"] == true).cmp(&(a["hardware"] == true))));
    l[0].clone()
}

struct Track {
    samples: Vec<(i64, f64)>,
    last: Option<Value>,
}

impl Track {
    fn average(&self, t: i64, window: i64) -> Option<f64> {
        let recent: Vec<f64> = self.samples.iter().filter(|s| t - s.0 < window).map(|s| s.1).collect();
        if recent.is_empty() {
            None
        } else {
            Some(r1(recent.iter().sum::<f64>() / recent.len() as f64))
        }
    }
    fn add(&mut self, t: i64, list: &[Value], window: i64) -> Value {
        let fps: f64 = list.iter().map(|e| e["fps"].as_f64().unwrap_or(0.0)).sum();
        self.samples.retain(|s| t - s.0 < window);
        self.samples.push((t, fps));
        let top = top_encode(list);
        let enc = top["encoder"].as_str().unwrap_or("");
        let api = api_of(enc);
        let device = lane_of(&top).and_then(|l| l.1).or_else(|| top["device"].as_str().map(str::to_string));
        let hardware = top["hardware"] == true || api.is_some_and(|a| a != "cpu");
        let is_cpu = device.as_deref() == Some("cpu");
        let last = json!({
            "encoder": if enc.is_empty() { Value::Null } else { json!(enc) }, "api": api, "codec": codec_of(enc),
            "fps": self.average(t, window).map(num), "at": t,
            "ref": { "hardware": hardware && !is_cpu, "device": if is_cpu { Value::Null } else { json!(device) }, "api": api }
        });
        self.last = Some(last.clone());
        last
    }
    fn summary(&self, t: i64, window: i64, kept: Option<Value>, name: &dyn Fn(&Value) -> Option<String>) -> Value {
        let Some(k) = self.last.clone().or(kept).filter(Value::is_object) else { return empty() };
        let fps = self.average(t, window).map(num).or_else(|| k["fps"].as_f64().filter(|f| f.is_finite()).map(num)).unwrap_or(Value::Null);
        let reference = if k["ref"].is_object() {
            k["ref"].clone()
        } else {
            json!({ "hardware": k["api"].as_str().is_some_and(|a| a != "cpu"), "device": null, "api": k.get("api").cloned().unwrap_or(Value::Null) })
        };
        let truthy = super::jobstore::normalize::truthy;
        let device = if truthy(&k["encoder"]) || truthy(&k["api"]) { name(&reference).filter(|s| !s.is_empty()).map(Value::from).unwrap_or(Value::Null) } else { Value::Null };
        let pick = |key: &str| k.get(key).cloned().unwrap_or(Value::Null);
        json!({ "fps": fps, "encoder": pick("encoder"), "device": device, "api": pick("api"), "codec": pick("codec") })
    }
}

/// db.get(key): an error when it cannot be read (then nothing is written over it)
pub type DbGet = dyn Fn(&str) -> Result<Option<Value>, String> + Send + Sync;
pub type DbSet = dyn Fn(&str, &Value) + Send + Sync;

/// createConvertStats({ db, now, everyMs, windowMs, deviceName, cpuName })
pub struct ConvertStats {
    pub get: Option<Arc<DbGet>>,
    pub set: Option<Arc<DbSet>>,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub every_ms: i64,
    pub window_ms: i64,
    pub device_name: Arc<dyn Fn(&Value) -> Option<String> + Send + Sync>,
    pub cpu_name: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    st: Mutex<(i64, Track, indexmap::IndexMap<String, Track>)>,
}

impl ConvertStats {
    pub fn new(get: Option<Arc<DbGet>>, set: Option<Arc<DbSet>>) -> ConvertStats {
        ConvertStats {
            get,
            set,
            now: Arc::new(|| super::jobstore::now_ms() as i64),
            every_ms: 30_000,
            window_ms: DAY_MS,
            device_name: Arc::new(|_| None),
            cpu_name: Arc::new(|| None),
            st: Mutex::new((i64::MIN / 2, Track { samples: vec![], last: None }, Default::default())),
        }
    }

    fn read(&self, key: &str) -> Result<Option<Value>, String> {
        Ok(match &self.get {
            Some(g) => g(key)?.filter(|v| super::jobstore::normalize::truthy(v)),
            None => None,
        })
    }

    fn kept_nodes(&self) -> Result<Map<String, Value>, String> {
        Ok(self.read(NODES_KEY)?.and_then(|v| v.as_object().cloned()).unwrap_or_default())
    }

    /// sample(encodes): at most one sample every everyMs; true when this server converted
    pub fn sample(&self, encodes: &dyn Fn() -> Vec<Value>) -> bool {
        let t = (self.now)();
        let mut st = self.st.lock().unwrap();
        if t - st.0 < self.every_ms {
            return false;
        }
        let list = encodes();
        let live = |e: &Value| e["started"] != false && e["waitingOnNode"] != true && e["fps"].as_f64().is_some_and(|f| f.is_finite() && f > 0.0);
        let mine: Vec<Value> = list.iter().filter(|e| live(e) && e["remote"] != true && !super::jobstore::normalize::truthy(&e["node"])).cloned().collect();
        let mut by_node: indexmap::IndexMap<String, Vec<Value>> = Default::default();
        for e in &list {
            if !live(e) || e["remote"] != true {
                continue;
            }
            if let Some((n, _)) = lane_of(e) {
                by_node.entry(n).or_default().push(e.clone());
            }
        }
        if mine.is_empty() && by_node.is_empty() {
            return false;
        }
        st.0 = t;
        let window = self.window_ms;
        if !mine.is_empty() {
            let last = st.1.add(t, &mine, window);
            if let Some(s) = &self.set {
                s(KEY, &last);
            }
        }
        if !by_node.is_empty() {
            // (kept numbers that could not be read are not written over with these alone)
            let mut kept = self.kept_nodes();
            for (id, l) in by_node {
                let track = st.2.entry(id.clone()).or_insert(Track { samples: vec![], last: None });
                let last = track.add(t, &l, window);
                if let Ok(k) = &mut kept {
                    k.insert(id, last);
                }
            }
            if let (Some(s), Ok(kept)) = (&self.set, kept) {
                s(NODES_KEY, &Value::Object(kept));
            }
        }
        !mine.is_empty()
    }

    /// summary(name): this server's { fps, encoder, device, api, codec }
    pub fn summary(&self, name: Option<&dyn Fn(&Value) -> Option<String>>) -> Value {
        let t = (self.now)();
        let kept = self.read(KEY).ok().flatten();
        let default = |r: &Value| if r["hardware"] == true { (self.device_name)(r) } else { (self.cpu_name)() };
        let st = self.st.lock().unwrap();
        st.1.summary(t, self.window_ms, kept, name.unwrap_or(&default))
    }

    /// nodeSummary(id, name)
    pub fn node_summary(&self, id: &str, name: &dyn Fn(&Value) -> Option<String>) -> Value {
        let t = (self.now)();
        let kept = self.kept_nodes().ok().and_then(|k| k.get(id).cloned());
        let mut st = self.st.lock().unwrap();
        let track = st.2.entry(id.to_string()).or_insert(Track { samples: vec![], last: None });
        track.summary(t, self.window_ms, kept, name)
    }

    /// keepNodes(ids): forgets the numbers of nodes no longer paired
    pub fn keep_nodes(&self, ids: &[String]) {
        self.st.lock().unwrap().2.retain(|k, _| ids.contains(k));
        let Ok(kept) = self.kept_nodes() else { return };
        if kept.keys().any(|k| !ids.contains(k)) {
            if let Some(s) = &self.set {
                s(NODES_KEY, &Value::Object(kept.into_iter().filter(|(k, _)| ids.contains(k)).collect()));
            }
        }
    }
}

/// nodeDeviceName(hw, ref)
pub fn node_device_name(hw: &Value, r: &Value) -> Option<String> {
    if r["hardware"] != true {
        return hw["cpu"].as_str().filter(|s| !s.is_empty()).map(str::to_string);
    }
    let devices = hw["devices"].as_array().cloned().unwrap_or_default();
    let d = match r["device"].as_str().filter(|s| !s.is_empty()) {
        Some(id) => devices.iter().find(|x| x["id"] == id),
        None => devices.iter().find(|x| x["id"] != "cpu"),
    };
    if let Some(n) = d.and_then(|d| d["name"].as_str()).filter(|s| !s.is_empty()) {
        return Some(n.into());
    }
    if let Some(g) = hw["gpus"].as_array().filter(|g| g.len() == 1) {
        return g[0].as_str().map(str::to_string);
    }
    Some(match r["api"].as_str() {
        Some("nvenc") => "NVIDIA GPU".into(),
        Some("qsv") => "Intel GPU".into(),
        Some("amf") => "AMD GPU".into(),
        _ => "GPU".into(),
    })
}

/// hardwareFromDevices(devices): a node too old to send its hardware
pub fn hardware_from_devices(devices: &Value) -> Value {
    let Some(list) = devices.as_array().filter(|l| !l.is_empty()) else { return Value::Null };
    let strip = |n: &str| -> String {
        // a bus address some runtimes add: " (0000:03:00.0)"
        let t = n.trim_end();
        if let Some(open) = t.rfind('(') {
            let inner = &t[open + 1..t.len().saturating_sub(1)];
            let parts: Vec<&str> = inner.split(':').collect();
            let hex = |s: &str, n: usize| s.len() == n && s.bytes().all(|b| b.is_ascii_hexdigit());
            let ok = t.ends_with(')')
                && match parts.as_slice() {
                    [d, b, sf] => hex(d, 4) && hex(b, 2) && sf.len() == 4 && hex(&sf[..2], 2) && sf.as_bytes()[2] == b'.' && sf.as_bytes()[3].is_ascii_hexdigit(),
                    [b, sf] => hex(b, 2) && sf.len() == 4 && hex(&sf[..2], 2) && sf.as_bytes()[2] == b'.' && sf.as_bytes()[3].is_ascii_hexdigit(),
                    _ => false,
                };
            if ok {
                return t[..open].trim().to_string();
            }
        }
        n.trim().to_string()
    };
    let named: Vec<Value> = list
        .iter()
        .filter(|d| d["id"].is_string() && d["name"].as_str().is_some_and(|n| !n.trim().is_empty()) && d["name"] != d["id"])
        .map(|d| json!({ "id": d["id"], "name": strip(d["name"].as_str().unwrap()) }))
        .filter(|d| d["name"] != "")
        .collect();
    let cpu_entry = named.iter().find(|d| d["id"] == "cpu");
    let gpus: Vec<Value> = named.iter().filter(|d| d["id"] != "cpu").map(|d| d["name"].clone()).collect();
    let generic = |n: &str| {
        let l = n.to_lowercase();
        (l.starts_with("cpu") && !l[3..].starts_with(|c: char| c.is_alphanumeric() || c == '_')) || l.contains("software encoder")
    };
    let cpu = cpu_entry.and_then(|c| c["name"].as_str()).filter(|n| !generic(n)).map(str::to_string);
    if gpus.is_empty() && cpu.is_none() {
        return Value::Null;
    }
    json!({ "cpu": cpu, "gpus": gpus, "devices": named })
}

/// heartbeatHardware({ found, cpu, stats, paired, maxNodes })
pub fn heartbeat_hardware(found: &Value, cpu: Option<&str>, stats: &ConvertStats, paired: &[Value], max_nodes: usize) -> Value {
    stats.keep_nodes(&paired.iter().map(|n| n["id"].as_str().map(str::to_string).unwrap_or_else(|| n["id"].to_string())).collect::<Vec<_>>());
    let gpus: Vec<Value> = crate::ops::gpu::usable_gpus(found).iter().map(|g| g["name"].clone()).collect();
    let name = |r: &Value| if r["hardware"] == true { Some(crate::ops::gpu::encode_gpu_name(found, r["device"].as_str(), r["api"].as_str(), None)) } else { cpu.map(str::to_string) };
    let convert = stats.summary(Some(&name));
    let nodes: Vec<Value> = paired
        .iter()
        .take(max_nodes)
        .map(|n| {
            let hw = if super::jobstore::normalize::truthy(&n["hardware"]) { n["hardware"].clone() } else { hardware_from_devices(&n["devices"]) };
            let id = n["id"].as_str().map(str::to_string).unwrap_or_else(|| n["id"].to_string());
            json!({
                "cpu": hw["cpu"].as_str().filter(|s| !s.is_empty()),
                "gpus": hw["gpus"].as_array().cloned().unwrap_or_default(),
                "convert": stats.node_summary(&id, &|r| node_device_name(&hw, r))
            })
        })
        .collect();
    json!({ "cpu": cpu, "gpus": gpus, "convert": convert, "nodes": nodes })
}

#[cfg(test)]
mod tests;
