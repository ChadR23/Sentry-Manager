//! nodeBenchmark.js, Nodes > Benchmark: how fast a paired node converts,
//! measured from here. This server lends it a few sample clips from a
//! vehicle's share (only read) and sends them at 1, 2, 4, 6 and 8 at once,
//! as a conversion would. The encoded files come back and are deleted;
//! nothing on the share changes. The lightest setting within 5% of the
//! fastest is suggested.

use super::cancel::Cancel;
use super::ctx::{Level, NodesCtx};
use super::main_side::{EncodeRequest, Nodes};
use crate::converter::contracts::js_round;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const LEVELS: [i64; 5] = [1, 2, 4, 6, 8];
const SAMPLES: usize = 4;
pub const MIN_BYTES: u64 = 2 * 1024 * 1024;
const MAX_BYTES: u64 = 200 * 1024 * 1024;
const WITHIN: f64 = 0.05;
const MAX_CHECKS: usize = 5000;
const CAMERAS: [&str; 6] = ["front", "back", "left_repeater", "right_repeater", "left_pillar", "right_pillar"];

/// CLIP_NAME: the camera of a Tesla clip's name, or None.
fn camera_of(name: &str) -> Option<&str> {
    let b = name.as_bytes();
    if b.len() < 24 || !name.ends_with(".mp4") {
        return None;
    }
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    let ok = digits(0..4) && b[4] == b'-' && digits(5..7) && b[7] == b'-' && digits(8..10) && b[10] == b'_' && digits(11..13) && b[13] == b'-' && digits(14..16) && b[16] == b'-' && digits(17..19) && b[19] == b'-';
    let cam = &name[20..name.len() - 4];
    (ok && CAMERAS.contains(&cam)).then_some(cam)
}

fn event_folder(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() >= 11 && b[..4].iter().all(u8::is_ascii_digit) && b[4] == b'-' && b[5..7].iter().all(u8::is_ascii_digit) && b[7] == b'-' && b[8..10].iter().all(u8::is_ascii_digit) && b[10] == b'_'
}

/// pickSamples(root, { limit, codecOf, minBytes, maxChecks }) -> (files, converted)
pub fn pick_samples(root: &Path, limit: usize, codec_of: &dyn Fn(&Path) -> Option<String>, min_bytes: u64, max_checks: usize) -> (Vec<PathBuf>, bool) {
    let mut found: Vec<PathBuf> = Vec::new();
    for group in ["RecentClips", "SavedClips", "SentryClips"] {
        let dir = root.join(group);
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Ok(t) = e.file_type() else { continue };
            if t.is_file() && camera_of(&name).is_some() {
                found.push(dir.join(&name));
            } else if t.is_dir() && event_folder(&name) {
                if let Ok(inner) = std::fs::read_dir(dir.join(&name)) {
                    for f in inner.flatten() {
                        let n = f.file_name().to_string_lossy().into_owned();
                        if camera_of(&n).is_some() {
                            found.push(dir.join(&name).join(n));
                        }
                    }
                }
            }
        }
    }
    let base = |p: &PathBuf| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // newest first (names alike in form: byte order is ICU's here)
    found.sort_by_key(|p| std::cmp::Reverse(base(p)));
    let (mut originals, mut converted) = (Vec::new(), Vec::new());
    let mut checks = 0;
    for file in found {
        if originals.len() >= limit * 6 || checks >= max_checks {
            break;
        }
        let Ok(st) = std::fs::metadata(&file) else { continue };
        if !st.is_file() || st.len() < min_bytes || st.len() > MAX_BYTES {
            continue;
        }
        checks += 1;
        match codec_of(&file).as_deref() {
            Some("h264") => originals.push(file),
            Some("h265") if converted.len() < limit * 6 => converted.push(file),
            _ => {}
        }
    }
    let have_originals = !originals.is_empty();
    let pool = if have_originals { originals } else { converted };
    let mut picked: Vec<PathBuf> = Vec::new();
    let mut cameras: Vec<String> = Vec::new();
    for pass in [true, false] {
        for file in &pool {
            if picked.len() >= limit {
                break;
            }
            if picked.contains(file) {
                continue;
            }
            let cam = camera_of(&base(file)).unwrap_or("").to_string();
            if pass && cameras.contains(&cam) {
                continue;
            }
            picked.push(file.clone());
            cameras.push(cam);
        }
    }
    let conv = !have_originals && !picked.is_empty();
    (picked, conv)
}

/// The lightest level within 5% of the fastest: [(level, clipsPerMinute)] -> level.
pub fn suggest(results: &[(i64, f64)]) -> Option<i64> {
    let ok: Vec<&(i64, f64)> = results.iter().filter(|r| r.1 > 0.0).collect();
    let fastest = ok.iter().map(|r| r.1).fold(f64::NEG_INFINITY, f64::max);
    let mut close: Vec<&&(i64, f64)> = ok.iter().filter(|r| r.1 >= fastest * (1.0 - WITHIN)).collect();
    close.sort_by_key(|r| r.0);
    close.first().map(|r| r.0)
}

#[derive(Clone)]
struct Sample {
    file: PathBuf,
    seconds: f64,
    bitrate: f64,
}

struct State {
    codec: String,
    state: &'static str,
    phase: Option<String>,
    results: Vec<Value>,
    suggested: Option<i64>,
    error: Option<String>,
    started_at: i64,
    ended_at: Option<i64>,
    samples: Option<usize>,
    converted: bool,
    controller: Cancel,
}

struct Inner {
    nodes: Nodes,
    ctx: Arc<dyn NodesCtx>,
    work_dir: PathBuf,
    min_bytes: u64,
    levels: Vec<i64>,
    states: Mutex<HashMap<String, State>>,
    running: Mutex<Option<String>>,
}

#[derive(Clone)]
pub struct NodeBenchmark(Arc<Inner>);

/// ffprobe's format duration in seconds (30 s at most).
fn duration_of(ffprobe: &str, file: &Path) -> Result<Option<f64>, String> {
    let mut child = std::process::Command::new(ffprobe)
        .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"]).arg(file)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null())
        .spawn().map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if started.elapsed() > Duration::from_secs(30) {
            let _ = child.kill();
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut out = String::new();
    use std::io::Read;
    child.stdout.take().map(|mut s| s.read_to_string(&mut out));
    let s = out.trim().parse::<f64>().ok().filter(|s| s.is_finite() && *s > 0.0);
    Ok(s)
}

impl NodeBenchmark {
    pub fn new(nodes: Nodes, ctx: Arc<dyn NodesCtx>, work_dir: PathBuf, min_bytes: Option<u64>, levels: Option<Vec<i64>>) -> NodeBenchmark {
        NodeBenchmark(Arc::new(Inner { nodes, ctx, work_dir, min_bytes: min_bytes.unwrap_or(MIN_BYTES), levels: levels.unwrap_or_else(|| LEVELS.to_vec()), states: Mutex::new(HashMap::new()), running: Mutex::new(None) }))
    }

    pub fn busy(&self) -> bool {
        self.0.running.lock().unwrap().is_some()
    }

    fn samples(&self) -> (Vec<PathBuf>, bool) {
        let mut fallback = None;
        for v in self.0.ctx.vehicles() {
            let Some(root) = v.studio_root else { continue };
            let picked = pick_samples(&root, SAMPLES, &|p| crate::mp4::video_codec(p).ok().flatten(), self.0.min_bytes, MAX_CHECKS);
            if !picked.0.is_empty() && !picked.1 {
                return picked;
            }
            if !picked.0.is_empty() && fallback.is_none() {
                fallback = Some(picked);
            }
        }
        fallback.unwrap_or((Vec::new(), false))
    }

    fn encode_one(&self, node: &str, s: &Sample, codec: &str, signal: &Cancel) -> bool {
        let target = self.0.work_dir.join(format!("{}.mp4", super::hex(&super::random_bytes(8))));
        let child = match self.0.nodes.encode(EncodeRequest {
            device: format!("node:{node}"), source: s.file.clone(), target: target.clone(), codec: codec.into(), bitrate: Some(s.bitrate), quality: None,
            hold_frames: 0, duration_us: Some(js_round(s.seconds * 1e6)), benchmark: true,
        }) {
            Ok(c) => c,
            Err(_) => return false,
        };
        let k = child.killer.clone();
        let id = signal.on_abort(move || {
            k.kill("SIGTERM");
        });
        let (code, _) = child.wait();
        signal.remove(id);
        let _ = std::fs::remove_file(&target);
        code == Some(0)
    }

    fn run_level(&self, node: &str, level: i64, list: &[Sample], codec: &str, signal: &Cancel) -> Value {
        let n = (level * 2).max(2) as usize;
        let queue: Mutex<std::collections::VecDeque<Sample>> = Mutex::new((0..n).map(|i| list[i % list.len()].clone()).collect());
        let started = Instant::now();
        let (done, failed) = (Mutex::new(0i64), Mutex::new(0i64));
        std::thread::scope(|sc| {
            for _ in 0..level {
                sc.spawn(|| loop {
                    if signal.aborted() {
                        break;
                    }
                    let Some(s) = queue.lock().unwrap().pop_front() else { break };
                    if self.encode_one(node, &s, codec, signal) {
                        *done.lock().unwrap() += 1;
                    } else {
                        *failed.lock().unwrap() += 1;
                    }
                });
            }
        });
        let minutes = started.elapsed().as_secs_f64() / 60.0;
        let (done, failed) = (*done.lock().unwrap(), *failed.lock().unwrap());
        let cpm = if failed > 0 || minutes == 0.0 { 0.0 } else { js_round(done as f64 / minutes * 10.0) / 10.0 };
        json!({ "level": level, "clips": done, "failed": failed, "seconds": super::jnum(js_round(minutes * 600.0) / 10.0), "clipsPerMinute": super::jnum(cpm) })
    }

    fn set(&self, id: &str, f: impl FnOnce(&mut State)) {
        if let Some(s) = self.0.states.lock().unwrap().get_mut(id) {
            f(s);
        }
    }

    fn benchmark(&self, id: &str, codec: &str, signal: &Cancel) -> Result<(), String> {
        std::fs::create_dir_all(&self.0.work_dir).map_err(|e| e.to_string())?;
        self.set(id, |s| s.phase = Some("Picking sample clips".into()));
        let (files, converted) = self.samples();
        if files.is_empty() {
            return Err("No Tesla clips were found on the vehicles' footage to lend the node.".into());
        }
        self.set(id, |s| s.converted = converted);
        let ffprobe = self.0.ctx.ffprobe_path();
        let mut list = Vec::new();
        for file in files {
            let Some(seconds) = duration_of(&ffprobe, &file)? else { continue };
            let size = std::fs::metadata(&file).map_err(|e| e.to_string())?.len();
            list.push(Sample { bitrate: (500_000f64).max(((size as f64 * 8.0) / seconds * 0.8).floor()), file, seconds });
        }
        if list.is_empty() {
            return Err("The sample clips could not be read.".into());
        }
        let count = list.len();
        self.set(id, |s| s.samples = Some(count));
        for &level in &self.0.levels {
            if signal.aborted() {
                return Ok(());
            }
            self.set(id, |s| s.phase = Some(format!("Converting {level} at once")));
            let result = self.run_level(id, level, &list, codec, signal);
            let mut stop = false;
            self.set(id, |s| {
                s.results.push(result.clone());
                let best = s.results.iter().map(|r| r["clipsPerMinute"].as_f64().unwrap_or(0.0)).fold(f64::NEG_INFINITY, f64::max);
                stop = result["failed"].as_i64().unwrap_or(0) > 0 || result["clipsPerMinute"].as_f64().unwrap_or(0.0) < best * 0.8;
            });
            if stop {
                break;
            }
        }
        self.set(id, |s| {
            let r: Vec<(i64, f64)> = s.results.iter().map(|r| (r["level"].as_i64().unwrap_or(0), r["clipsPerMinute"].as_f64().unwrap_or(0.0))).collect();
            s.suggested = suggest(&r);
        });
        Ok(())
    }

    /// start(id, { codec }): Err((status, message)).
    pub fn start(&self, id: &str, codec: &str) -> Result<Value, (u16, String)> {
        let mut running = self.0.running.lock().unwrap();
        if running.is_some() {
            return Err((409, "A node benchmark is already running.".into()));
        }
        if codec != "h265" && codec != "av1" {
            return Err((400, "Codec: h265 or av1.".into()));
        }
        let controller = Cancel::new();
        self.0.states.lock().unwrap().insert(id.into(), State {
            codec: codec.into(), state: "running", phase: Some("Starting".into()), results: vec![], suggested: None, error: None,
            started_at: self.0.ctx.now_ms(), ended_at: None, samples: None, converted: false, controller: controller.clone(),
        });
        *running = Some(id.into());
        drop(running);
        let me = self.clone();
        let (id2, codec2) = (id.to_string(), codec.to_string());
        std::thread::spawn(move || {
            let r = me.benchmark(&id2, &codec2, &controller);
            let now = me.0.ctx.now_ms();
            me.set(&id2, |s| {
                match &r {
                    Ok(()) => s.state = if controller.aborted() { "cancelled" } else { "done" },
                    Err(e) => {
                        s.state = "failed";
                        s.error = Some(e.clone());
                    }
                }
                s.phase = None;
                s.ended_at = Some(now);
            });
            if let Err(e) = r {
                me.0.ctx.log(Level::Warn, &format!("Node benchmark: {e}"));
            }
            *me.0.running.lock().unwrap() = None;
        });
        Ok(self.view(id))
    }

    pub fn cancel(&self, id: &str) -> Value {
        if let Some(s) = self.0.states.lock().unwrap().get(id) {
            if s.state == "running" {
                s.controller.abort();
            }
        }
        self.view(id)
    }

    pub fn view(&self, id: &str) -> Value {
        let g = self.0.states.lock().unwrap();
        let Some(s) = g.get(id) else { return Value::Null };
        json!({ "state": s.state, "phase": s.phase, "codec": s.codec, "results": s.results, "suggested": s.suggested, "error": s.error,
            "startedAt": s.started_at, "endedAt": s.ended_at, "samples": s.samples.filter(|n| *n > 0), "converted": s.converted })
    }
}
