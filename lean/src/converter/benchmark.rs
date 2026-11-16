//! src/main/converter/benchmark.js (runConverterBenchmark) and runtime.js's
//! runBenchmark: the real converter run on copies of real clips at every
//! parallel level (1, 2, 4, 6, 8), files per minute (and per Wh with a power
//! meter), a clip that fails on its own left out. The footage is only read;
//! every run writes into a temporary folder.

use super::contracts::js_round;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const CLIP_FAILURES: [&str; 9] = ["duration-mismatch", "frame-count-mismatch", "dimension-mismatch", "container-invalid", "decode-failed", "probe-failed", "telemetry-invalid", "telemetry-mismatch", "not-smaller"];
pub const LEVELS: [i64; 5] = [1, 2, 4, 6, 8];
pub const MAX_CLIPS: usize = 8;

/// The server's energy reading over one level run.
pub trait PowerMeter: Send + Sync {
    fn start(&self) -> Result<Value, String>;
    fn stop(&self, token: &Value) -> Result<Option<Value>, String>;
}

pub struct LevelRequest<'a> {
    pub level: i64,
    pub source_root: &'a Path,
    pub work_root: &'a Path,
    pub verify_mode: Option<&'a str>,
}

pub type RunLevel<'a> = dyn Fn(&LevelRequest, &Arc<AtomicBool>) -> Result<Value, String> + Send + Sync + 'a;

pub struct BenchOptions<'a> {
    pub clips: Vec<(PathBuf, String)>,
    pub run_level: &'a RunLevel<'a>,
    pub count_frames: &'a (dyn Fn(&Path) -> i64 + Sync),
    pub encoder: Value,
    pub temp_root: PathBuf,
    pub cancel: Arc<AtomicBool>,
    pub on_progress: &'a (dyn Fn(Value) + Sync),
    pub now: &'a (dyn Fn() -> f64 + Sync),
    pub power_meter: Option<Arc<dyn PowerMeter>>,
    pub compare_verify_modes: Vec<String>,
}

fn err(code: &str) -> String {
    code.to_string()
}

fn round1(x: f64) -> f64 {
    js_round(x * 10.0) / 10.0
}

fn num(x: f64) -> Value {
    super::jobstore::normalize::num(x)
}

fn start_meter(m: &Option<Arc<dyn PowerMeter>>) -> Option<Value> {
    m.as_ref().and_then(|m| m.start().ok())
}

fn stop_meter(m: &Option<Arc<dyn PowerMeter>>, started: Option<Value>, completed: usize) -> (Value, Value, Value) {
    let none = (Value::Null, Value::Null, Value::Null);
    let (Some(m), Some(token)) = (m, started) else { return none };
    let Ok(Some(r)) = m.stop(&token) else { return none };
    let wh = crate::ops::js::number(&r["wh"]);
    let avg = crate::ops::js::number(&r["avgW"]);
    if !wh.is_finite() || wh <= 0.0 {
        return none;
    }
    (num(js_round(wh * 10_000.0) / 10_000.0), if avg.is_finite() && avg >= 0.0 { num(round1(avg)) } else { Value::Null }, num(js_round(completed as f64 / wh * 100.0) / 100.0))
}

fn mkdtemp(root: &Path, prefix: &str) -> std::io::Result<PathBuf> {
    for _ in 0..100 {
        let p = root.join(format!("{prefix}{}", &super::jobstore::random_uuid().unwrap_or_default().replace('-', "")[..6]));
        match std::fs::create_dir(&p) {
            Ok(()) => return Ok(p),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists))
}

#[derive(Clone)]
struct Sample {
    name: String,
    origin: String,
    path: PathBuf,
    frames: i64,
    reused: bool,
}

fn tesla_stamp(name: &str) -> bool {
    let b = name.as_bytes();
    let d = |i: usize| b.get(i).is_some_and(u8::is_ascii_digit);
    b.len() >= 19 && (0..4).all(d) && b[4] == b'-' && d(5) && d(6) && b[7] == b'-' && d(8) && d(9) && b[10] == b'_' && d(11) && d(12) && b[13] == b'-' && d(14) && d(15) && b[16] == b'-' && d(17) && d(18)
}

/// runConverterBenchmark(options)
pub fn run_converter_benchmark(o: &BenchOptions) -> Result<Value, String> {
    if o.clips.is_empty() {
        return Err(err("BENCHMARK_SOURCE_REQUIRED"));
    }
    let check = || if o.cancel.load(Ordering::SeqCst) { Err(err("CANCELLED")) } else { Ok(()) };
    let work_root = mkdtemp(&o.temp_root, "benchmark-").map_err(|e| super::owned::code_of(&e).to_string())?;
    let r = (|| -> Result<Value, String> {
        let chosen: Vec<&(PathBuf, String)> = o.clips.iter().take(MAX_CLIPS).collect();
        let library = work_root.join("clips");
        std::fs::create_dir_all(&library).map_err(|e| super::owned::code_of(&e).to_string())?;
        let mut samples: Vec<Sample> = vec![];
        for (i, (src, name)) in chosen.iter().enumerate() {
            check()?;
            (o.on_progress)(json!({ "step": "copy", "index": i + 1, "total": chosen.len() }));
            let target = library.join(name);
            std::fs::copy(src, &target).map_err(|e| super::owned::code_of(&e).to_string())?;
            let frames = (o.count_frames)(&target);
            samples.push(Sample { name: name.clone(), origin: name.clone(), path: target, frames, reused: false });
        }
        let measure = |level: i64, batch: &[Sample], key: &str, verify_mode: Option<&str>| -> Result<Value, String> {
            let level_root = work_root.join(key);
            let source_root = level_root.join("source");
            let clip_dir = source_root.join("RecentClips");
            std::fs::create_dir_all(&clip_dir).map_err(|e| super::owned::code_of(&e).to_string())?;
            for s in batch {
                let target = clip_dir.join(&s.name);
                if s.reused || std::fs::hard_link(&s.path, &target).is_err() {
                    std::fs::copy(&s.path, &target).map_err(|e| super::owned::code_of(&e).to_string())?;
                }
            }
            let meter = start_meter(&o.power_meter);
            let started = (o.now)();
            let job = match (o.run_level)(&LevelRequest { level, source_root: &source_root, work_root: &level_root, verify_mode }, &o.cancel) {
                Ok(j) => j,
                Err(e) => {
                    stop_meter(&o.power_meter, meter, 0);
                    return Err(e);
                }
            };
            let seconds = (((o.now)() - started) / 1000.0).max(0.001);
            let items: Vec<Value> = job["items"].as_array().cloned().unwrap_or_default();
            let completed: Vec<&Value> = items.iter().filter(|i| i["state"] == "completed").collect();
            let (wh, avg, per_wh) = stop_meter(&o.power_meter, meter, completed.len());
            check()?;
            let sample_of = |i: &Value| batch.iter().find(|s| i["relativePath"].as_str().is_some_and(|r| r.ends_with(&s.name)));
            let failed_items: Vec<Value> = items
                .iter()
                .filter(|i| i["state"] == "failed")
                .map(|i| {
                    let code = i["failure"]["code"].as_str().filter(|c| !c.is_empty()).or(i["resultCode"].as_str().filter(|c| !c.is_empty())).unwrap_or("failed");
                    json!({ "origin": sample_of(i).map(|s| s.origin.clone()), "code": code })
                })
                .collect();
            let mut failures: Vec<Value> = vec![];
            for f in &failed_items {
                if !failures.contains(&f["code"]) {
                    failures.push(f["code"].clone());
                }
            }
            let frames: i64 = completed.iter().map(|i| sample_of(i).map(|s| s.frames).unwrap_or(0)).sum();
            let fpm = js_round(completed.len() as f64 / seconds * 600.0) / 10.0;
            let src_total: f64 = completed.iter().map(|i| i["sourceBytes"].as_f64().unwrap_or(0.0)).sum();
            let out_total: f64 = completed.iter().map(|i| i["outputBytes"].as_f64().unwrap_or(0.0)).sum();
            let saved = if src_total > 0.0 && out_total > 0.0 { num(js_round(1000.0 - out_total / src_total * 1000.0) / 10.0) } else { Value::Null };
            let files = super::jobstore::normalize::safe_int_of(&job["timings"]["files"]);
            let verify_ms = job["timings"]["totalMs"]["verify"].as_f64();
            let vspc = match (files, verify_ms) {
                (Some(f), Some(v)) if f > 0 && v.is_finite() => num(js_round(v / f as f64 / 100.0) / 10.0),
                _ => Value::Null,
            };
            let _ = std::fs::remove_dir_all(&level_root);
            Ok(json!({
                "level": level, "clips": batch.len(), "completed": completed.len(),
                "failed": items.iter().filter(|i| i["state"] == "failed").count(), "failures": failures,
                "seconds": num(round1(seconds)), "filesPerMinute": num(fpm), "savedPercent": saved, "verifySecondsPerClip": vspc,
                "fps": num(round1(frames as f64 / seconds)), "ok": completed.len() == batch.len(),
                "wh": wh, "avgW": avg, "filesPerWh": per_wh, "failedItems": failed_items
            }))
        };
        let batch_for = |samples: &[Sample], level: i64| -> Vec<Sample> {
            (0..level.max(2) as usize)
                .map(|i| {
                    let s = &samples[i % samples.len()];
                    if i < samples.len() {
                        return s.clone();
                    }
                    let stamp = format!("2000-01-01_00-{i:02}-00");
                    let name = if tesla_stamp(&s.name) { format!("{stamp}{}", &s.name[19..]) } else { format!("{stamp}-{}", s.name) };
                    Sample { name, reused: true, ..s.clone() }
                })
                .collect()
        };
        let mut skipped: Vec<Value> = vec![];
        let public = |mut r: Value| {
            r.as_object_mut().unwrap().shift_remove("failedItems");
            r
        };
        let mut results: Vec<Value> = vec![];
        let levels: Vec<i64> = LEVELS.iter().copied().filter(|l| *l <= super::contracts::CONCURRENCY_MAX).collect();
        for (index, &level) in levels.iter().enumerate() {
            check()?;
            (o.on_progress)(json!({ "step": "run", "level": level, "index": index + 1, "total": levels.len(), "encoder": o.encoder["codec"], "hardware": o.encoder["hardware"] == true }));
            let mut result = measure(level, &batch_for(&samples, level), &format!("level-{level}"), None)?;
            // leaveOutBadClips
            let failed = result["failedItems"].as_array().cloned().unwrap_or_default();
            let own = result["ok"] != true && !failed.is_empty() && failed.iter().all(|f| f["code"].as_str().is_some_and(|c| CLIP_FAILURES.contains(&c)) && f["origin"].is_string());
            if own {
                let mut bad = failed;
                if level > 1 {
                    let suspects: Vec<Sample> = samples.iter().filter(|s| bad.iter().any(|b| b["origin"] == s.origin.as_str())).cloned().collect();
                    check()?;
                    bad = measure(1, &suspects, &format!("check-{level}"), None)?["failedItems"].as_array().cloned().unwrap_or_default();
                }
                for b in &bad {
                    let Some(i) = samples.iter().position(|s| b["origin"] == s.origin.as_str()) else { continue };
                    if !b["code"].as_str().is_some_and(|c| CLIP_FAILURES.contains(&c)) {
                        continue;
                    }
                    skipped.push(json!({ "name": b["origin"], "code": b["code"] }));
                    samples.remove(i);
                }
                if !bad.is_empty() && !samples.is_empty() {
                    check()?;
                    result = measure(level, &batch_for(&samples, level), &format!("level-{level}-again"), None)?;
                }
            }
            let ok = result["ok"] == true;
            results.push(public(result));
            if !ok {
                break;
            }
        }
        let successful: Vec<&Value> = results.iter().filter(|r| r["ok"] == true).collect();
        let top = successful.iter().map(|r| r["filesPerMinute"].as_f64().unwrap_or(0.0)).fold(0.0, f64::max);
        let mut fast: Vec<&Value> = successful.iter().copied().filter(|r| r["filesPerMinute"].as_f64().unwrap_or(0.0) >= top * 0.95).collect();
        fast.sort_by_key(|r| r["level"].as_i64());
        let best = fast.first().map(|v| (*v).clone()).unwrap_or(Value::Null);
        let efficient = if !successful.is_empty() && successful.iter().all(|r| r["filesPerWh"].as_f64().is_some_and(|x| x > 0.0)) {
            let mut e = successful.clone();
            e.sort_by(|a, b| b["filesPerWh"].as_f64().partial_cmp(&a["filesPerWh"].as_f64()).unwrap().then(a["level"].as_i64().cmp(&b["level"].as_i64())));
            e[0].clone()
        } else {
            Value::Null
        };
        let mut comparison: Vec<Value> = vec![];
        if !best.is_null() && !o.compare_verify_modes.is_empty() {
            let level = best["level"].as_i64().unwrap_or(1);
            for (index, mode) in o.compare_verify_modes.iter().enumerate() {
                check()?;
                (o.on_progress)(json!({ "step": "verify", "verifyMode": mode, "level": level, "index": index + 1, "total": o.compare_verify_modes.len() }));
                let r = public(measure(level, &samples, &format!("verify-{mode}"), Some(mode))?);
                let mut m = Map::new();
                m.insert("verifyMode".into(), json!(mode));
                for (k, v) in r.as_object().unwrap() {
                    m.insert(k.clone(), v.clone());
                }
                comparison.push(Value::Object(m));
            }
        }
        Ok(json!({ "encoder": o.encoder, "clips": samples.len(), "results": results, "best": best, "efficient": efficient, "verifyComparison": comparison, "skipped": skipped }))
    })();
    let _ = std::fs::remove_dir_all(&work_root);
    r
}

#[cfg(test)]
mod tests;
