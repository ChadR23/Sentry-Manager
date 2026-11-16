//! pictureCheck.js: a clip encoded on another server must show the same
//! pictures as the original. Both files are decoded to tiny grey frames and
//! compared frame by frame (SSIM over 8x8 blocks), lined up by frame rather
//! than by timestamp. Black, swapped or frozen footage scores far below any
//! real encode. The converter calls `compare_pictures` for a node's encode
//! unless the node is trusted (`Nodes::trusted`).

use super::cancel::Cancel;
use crate::converter::contracts::js_round;
use serde_json::{json, Map, Value};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const W: usize = 160;
pub const H: usize = 120;
const BLOCK: usize = 8;
const FRAME: usize = W * H;
pub const MAX_FRAMES: usize = 20_000;
const SHIFT: i64 = 48;
const DRIFT: i64 = 2;
pub const PICTURE_MEAN: f64 = 0.9;
pub const PICTURE_LOW: f64 = 0.75;
const SAMPLE_MIN_SECONDS: f64 = 20.0;
const SAMPLE_COUNT: usize = 3;
const SAMPLE_SECONDS: f64 = 3.0;
const SAMPLE_MARGIN_SECONDS: f64 = 1.5;
const SAMPLE_EDGE_SECONDS: f64 = 2.0;
const C1: f64 = (0.01 * 255.0) * (0.01 * 255.0);
const C2: f64 = (0.03 * 255.0) * (0.03 * 255.0);

fn similarity(a: &[u8], b: &[u8]) -> f64 {
    let mut total = 0.0;
    let mut blocks = 0.0;
    let n = (BLOCK * BLOCK) as f64;
    let mut by = 0;
    while by + BLOCK <= H {
        let mut bx = 0;
        while bx + BLOCK <= W {
            let (mut sa, mut sb, mut saa, mut sbb, mut sab) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
            for y in by..by + BLOCK {
                let row = y * W;
                for x in bx..bx + BLOCK {
                    let va = a[row + x] as f64;
                    let vb = b[row + x] as f64;
                    sa += va;
                    sb += vb;
                    saa += va * va;
                    sbb += vb * vb;
                    sab += va * vb;
                }
            }
            let ma = sa / n;
            let mb = sb / n;
            let va = saa / n - ma * ma;
            let vb = sbb / n - mb * mb;
            let cov = sab / n - ma * mb;
            total += ((2.0 * ma * mb + C1) * (2.0 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
            blocks += 1.0;
            bx += BLOCK;
        }
        by += BLOCK;
    }
    total / blocks
}

fn split(buf: &[u8]) -> Vec<&[u8]> {
    let count = (buf.len() / FRAME).min(MAX_FRAMES);
    (0..count).map(|n| &buf[n * FRAME..(n + 1) * FRAME]).collect()
}

fn round3(v: f64) -> f64 {
    js_round(v * 1000.0) / 1000.0
}

#[derive(Clone, Copy)]
pub struct Shifts {
    pub min_shift: i64,
    pub max_shift: i64,
    pub expect: i64,
}

impl Default for Shifts {
    fn default() -> Shifts {
        Shifts { min_shift: -SHIFT, max_shift: SHIFT, expect: 0 }
    }
}

/// judgeFrames(source, candidate, { minShift, maxShift, expect }) -> { ok, mean, low, frames, shift } (or a reason).
pub fn judge_frames(source: &[u8], candidate: &[u8], o: Shifts) -> Value {
    let src = split(source);
    let cand = split(candidate);
    if src.is_empty() || cand.is_empty() {
        return json!({ "ok": false, "reason": "no-frames" });
    }
    let at = |i: usize, j: i64| if j >= 0 && (j as usize) < cand.len() { similarity(src[i], cand[j as usize]) } else { -1.0 };
    let offset_score = |shift: i64, step: usize| {
        let (mut sum, mut n) = (0.0, 0usize);
        let mut i = 0;
        while i < src.len() {
            let v = at(i, i as i64 + shift);
            if v != -1.0 {
                sum += v;
                n += 1;
            }
            i += step;
        }
        if n > 0 && n as f64 >= (src.len() as f64 / step as f64).ceil() / 2.0 { sum / n as f64 } else { f64::NEG_INFINITY }
    };
    const TIE: f64 = 0.002;
    let better = |shift: i64, score: f64, best: (i64, f64)| score > best.1 + TIE || (score >= best.1 - TIE && (shift - o.expect).abs() < (best.0 - o.expect).abs());
    let coarse = if src.len() >= 64 { 32 } else { 8 };
    let mut best = (o.expect, f64::NEG_INFINITY);
    for shift in o.min_shift..=o.max_shift {
        let score = offset_score(shift, coarse);
        if better(shift, score, best) {
            best = (shift, score);
        }
    }
    if coarse != 8 {
        let around = best.0;
        best = (around, f64::NEG_INFINITY);
        for shift in o.min_shift.max(around - 4)..=o.max_shift.min(around + 4) {
            let score = offset_score(shift, 8);
            if better(shift, score, best) {
                best = (shift, score);
            }
        }
    }
    let mut scores = Vec::new();
    for i in 0..src.len() {
        let mut top = at(i, i as i64 + best.0);
        if top < PICTURE_MEAN {
            for d in -DRIFT..=DRIFT {
                if d != 0 {
                    top = top.max(at(i, i as i64 + best.0 + d));
                }
            }
        }
        if top != -1.0 {
            scores.push(top);
        }
    }
    if (scores.len() as f64) < src.len().min(cand.len()) as f64 * 0.9 {
        return json!({ "ok": false, "reason": "frames-missing", "frames": scores.len() });
    }
    let mean = scores.iter().sum::<f64>() / scores.len() as f64;
    let mut sorted = scores.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let low = sorted[(scores.len() as f64 * 0.05).floor() as usize];
    json!({ "ok": mean >= PICTURE_MEAN && low >= PICTURE_LOW, "mean": super::jnum(round3(mean)), "low": super::jnum(round3(low)), "frames": scores.len(), "shift": best.0 })
}

/// What a decode is asked for: { width, height, signal, start, length }.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DecodeOptions {
    pub width: usize,
    pub height: usize,
    pub start: Option<f64>,
    pub length: Option<f64>,
}

/// decode(file, options) -> grey frames, or the error's code / message.
pub type Decode<'a> = dyn Fn(&Path, DecodeOptions, &Cancel) -> Result<Vec<u8>, String> + Send + Sync + 'a;

fn decode_failed(e: &str) -> Value {
    json!({ "ok": false, "reason": "decode-failed", "detail": super::js_slice(e, 80) })
}

/// comparePictures({ source, candidate, signal, decode, durationSeconds, random })
pub fn compare_pictures(source: &Path, candidate: &Path, signal: &Cancel, decode: &Decode, duration_seconds: Option<f64>, random: &mut dyn FnMut() -> f64) -> Value {
    if let Some(d) = duration_seconds.filter(|d| d.is_finite() && *d >= SAMPLE_MIN_SECONDS) {
        let span = d - SAMPLE_SECONDS - 2.0 * SAMPLE_EDGE_SECONDS;
        let starts: Vec<f64> = (0..SAMPLE_COUNT).map(|n| js_round((SAMPLE_EDGE_SECONDS + ((n as f64 + random()) / SAMPLE_COUNT as f64) * span) * 100.0) / 100.0).collect();
        let results: Vec<Result<Value, String>> = std::thread::scope(|s| {
            let hs: Vec<_> = starts.iter().map(|&start| s.spawn(move || {
                let from = (start - SAMPLE_MARGIN_SECONDS).max(0.0);
                let (a, b) = std::thread::scope(|t| {
                    let ha = t.spawn(|| decode(source, DecodeOptions { width: W, height: H, start: Some(start), length: Some(SAMPLE_SECONDS) }, signal));
                    let hb = t.spawn(|| decode(candidate, DecodeOptions { width: W, height: H, start: Some(from), length: Some(SAMPLE_SECONDS + (start - from) + SAMPLE_MARGIN_SECONDS) }, signal));
                    (ha.join().unwrap(), hb.join().unwrap())
                });
                let (a, b) = (a?, b?);
                let early = js_round((start - from) * 36.0) as i64;
                let slack = ((start - from) * 4.0).ceil() as i64 + SHIFT;
                let mut r = judge_frames(&a, &b, Shifts { min_shift: early - slack, max_shift: early + slack, expect: early });
                r["at"] = super::jnum(start);
                Ok(r)
            })).collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        // (Promise.all: the first decode that failed)
        let mut ok = Vec::new();
        for r in results {
            match r {
                Ok(v) => ok.push(v),
                Err(e) => return decode_failed(&e),
            }
        }
        if let Some(f) = ok.iter().find(|r| r["ok"] != json!(true)) {
            let mut f = f.clone();
            f["sampled"] = json!(ok.len());
            return f;
        }
        let mean = ok.iter().map(|r| r["mean"].as_f64().unwrap_or(0.0)).sum::<f64>() / ok.len() as f64;
        let low = ok.iter().map(|r| r["low"].as_f64().unwrap_or(0.0)).fold(f64::INFINITY, f64::min);
        let frames: u64 = ok.iter().map(|r| r["frames"].as_u64().unwrap_or(0)).sum();
        let mut m = Map::new();
        m.insert("ok".into(), json!(true));
        m.insert("mean".into(), super::jnum(round3(mean)));
        m.insert("low".into(), super::jnum(low));
        m.insert("frames".into(), json!(frames));
        m.insert("sampled".into(), json!(ok.len()));
        return Value::Object(m);
    }
    let (a, b) = std::thread::scope(|t| {
        let ha = t.spawn(|| decode(source, DecodeOptions { width: W, height: H, ..Default::default() }, signal));
        let hb = t.spawn(|| decode(candidate, DecodeOptions { width: W, height: H, ..Default::default() }, signal));
        (ha.join().unwrap(), hb.join().unwrap())
    });
    match (a, b) {
        (Ok(a), Ok(b)) => judge_frames(&a, &b, Shifts::default()),
        (Err(e), _) | (_, Err(e)) => decode_failed(&e),
    }
}

/// Runs one ffmpeg decode (arguments given) and returns its stdout, capped.
pub type RunDecode = Arc<dyn Fn(&[String], usize, &Cancel) -> Result<Vec<u8>, String> + Send + Sync>;

/// The real runner: ffmpeg, killed past `limit` bytes, the timeout or a cancel.
pub fn ffmpeg_runner(ffmpeg: String, timeout: Duration) -> RunDecode {
    Arc::new(move |args: &[String], limit: usize, signal: &Cancel| {
        let mut child = Command::new(&ffmpeg).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| super::client::errno_name(&e))?;
        let mut out = child.stdout.take().unwrap();
        let pid = child.id();
        let child = Arc::new(std::sync::Mutex::new(child));
        let kill = {
            let c = child.clone();
            move || {
                let _ = c.lock().unwrap().kill();
            }
        };
        let abort = {
            let k = kill.clone();
            signal.on_abort(k)
        };
        let started = Instant::now();
        let watch = {
            let c = child.clone();
            std::thread::spawn(move || loop {
                if let Ok(Some(_)) = c.lock().unwrap().try_wait() {
                    return;
                }
                if started.elapsed() > timeout {
                    let _ = c.lock().unwrap().kill();
                }
                std::thread::sleep(Duration::from_millis(50));
            })
        };
        let _ = pid;
        let mut data = Vec::new();
        let mut buf = vec![0u8; 256 * 1024];
        let mut over = false;
        loop {
            match out.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if data.len() + n > limit {
                        over = true;
                        kill();
                    } else if !over {
                        data.extend_from_slice(&buf[..n]);
                    }
                }
            }
        }
        let _ = watch.join();
        signal.remove(abort);
        let status = child.lock().unwrap().wait().map_err(|e| e.to_string())?;
        if status.success() {
            Ok(data)
        } else {
            Err("DECODE_FAILED".into())
        }
    })
}

/// The decode arguments (ffmpegDecoder's once()).
pub fn decode_args(file: &Path, o: DecodeOptions, hw: &[String]) -> Vec<String> {
    let mut a: Vec<String> = ["-nostdin", "-hide_banner", "-loglevel", "error"].iter().map(|s| s.to_string()).collect();
    a.extend(hw.iter().cloned());
    a.extend(["-protocol_whitelist".to_string(), "file".to_string()]);
    if let Some(s) = o.start.filter(|s| s.is_finite() && *s > 0.0) {
        a.extend(["-ss".to_string(), crate::ops::js::to_fixed(s, 3)]);
    }
    if let Some(l) = o.length.filter(|l| l.is_finite() && *l > 0.0) {
        a.extend(["-t".to_string(), crate::ops::js::to_fixed(l, 3)]);
    }
    a.extend(["-i".to_string(), file.to_string_lossy().into_owned()]);
    a.extend(["-vf".to_string(), format!("scale={}:{}:flags=area,format=gray", o.width, o.height), "-frames:v".to_string(), MAX_FRAMES.to_string(), "-f".to_string(), "rawvideo".to_string(), "-".to_string()]);
    a
}

/// ffmpegDecoder({ run, accel }): GPU decode arguments first when `accel`
/// gives some (frames back in system memory), the CPU when that fails.
pub fn ffmpeg_decoder(run: RunDecode, accel: Option<Arc<dyn Fn() -> Option<Vec<String>> + Send + Sync>>) -> impl Fn(&Path, DecodeOptions, &Cancel) -> Result<Vec<u8>, String> + Send + Sync {
    move |file: &Path, o: DecodeOptions, signal: &Cancel| {
        let limit = o.width * o.height * MAX_FRAMES;
        let hw = accel.as_ref().and_then(|f| f());
        if let Some(hw) = hw.filter(|h| !h.is_empty()) {
            match run(&decode_args(file, o, &hw), limit, signal) {
                Ok(b) => return Ok(b),
                Err(e) if signal.aborted() => return Err(e),
                Err(_) => {}
            }
        }
        run(&decode_args(file, o, &[]), limit, signal)
    }
}
