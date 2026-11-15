//! src/main/converter/pictureCheck.js: a clip encoded on another server must
//! show the original's pictures. Both files are decoded to tiny grey frames
//! and compared frame by frame (SSIM over 8x8 blocks), lined up by frame.
//! Only used for helper servers (nodes): the node port calls
//! `compare_pictures` with `ffmpeg_decoder`.

use super::contracts::js_round;
use serde_json::{json, Value};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
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
            let (mut sa, mut sb, mut saa, mut sbb, mut sab) = (0.0, 0.0, 0.0, 0.0, 0.0);
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

pub struct Shifts {
    pub min_shift: i64,
    pub max_shift: i64,
    pub expect: i64,
}

impl Default for Shifts {
    fn default() -> Self {
        Shifts { min_shift: -SHIFT, max_shift: SHIFT, expect: 0 }
    }
}

/// judgeFrames(source, candidate, { minShift, maxShift, expect })
pub fn judge_frames(source: &[u8], candidate: &[u8], o: &Shifts) -> Value {
    let src = split(source);
    let cand = split(candidate);
    if src.is_empty() || cand.is_empty() {
        return json!({ "ok": false, "reason": "no-frames" });
    }
    let at = |i: usize, j: i64| -> f64 {
        if j >= 0 && (j as usize) < cand.len() {
            similarity(src[i], cand[j as usize])
        } else {
            -1.0
        }
    };
    let offset_score = |shift: i64, step: usize| -> f64 {
        let mut sum = 0.0;
        let mut n = 0usize;
        let mut i = 0;
        while i < src.len() {
            let v = at(i, i as i64 + shift);
            if v != -1.0 {
                sum += v;
                n += 1;
            }
            i += step;
        }
        if n > 0 && n as f64 >= (src.len() as f64 / step as f64).ceil() / 2.0 {
            sum / n as f64
        } else {
            f64::NEG_INFINITY
        }
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
    let mut scores = vec![];
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
    json!({ "ok": mean >= PICTURE_MEAN && low >= PICTURE_LOW, "mean": round3(mean), "low": round3(low), "frames": scores.len(), "shift": best.0 })
}

/// What one decode is asked for.
#[derive(Debug, Clone, Default)]
pub struct DecodeRequest {
    pub width: usize,
    pub height: usize,
    pub start: Option<f64>,
    pub length: Option<f64>,
}

pub type Decode = dyn Fn(&str, &DecodeRequest, &Arc<AtomicBool>) -> Result<Vec<u8>, String> + Send + Sync;

/// comparePictures({ source, candidate, signal, decode, durationSeconds, random })
pub fn compare_pictures(source: &str, candidate: &str, cancel: &Arc<AtomicBool>, decode: &Decode, duration_seconds: Option<f64>, random: &mut dyn FnMut() -> f64) -> Value {
    let fail = |e: String| json!({ "ok": false, "reason": "decode-failed", "detail": e.chars().take(80).collect::<String>() });
    if let Some(d) = duration_seconds.filter(|d| d.is_finite() && *d >= SAMPLE_MIN_SECONDS) {
        let span = d - SAMPLE_SECONDS - 2.0 * SAMPLE_EDGE_SECONDS;
        let starts: Vec<f64> = (0..SAMPLE_COUNT).map(|n| js_round((SAMPLE_EDGE_SECONDS + ((n as f64 + random()) / SAMPLE_COUNT as f64) * span) * 100.0) / 100.0).collect();
        let results: Vec<Result<Value, String>> = std::thread::scope(|s| {
            let handles: Vec<_> = starts
                .iter()
                .map(|&start| {
                    s.spawn(move || -> Result<Value, String> {
                        let from = (start - SAMPLE_MARGIN_SECONDS).max(0.0);
                        let (a, b) = std::thread::scope(|s2| {
                            let ha = s2.spawn(|| decode(source, &DecodeRequest { width: W, height: H, start: Some(start), length: Some(SAMPLE_SECONDS) }, cancel));
                            let hb = s2.spawn(|| decode(candidate, &DecodeRequest { width: W, height: H, start: Some(from), length: Some(SAMPLE_SECONDS + (start - from) + SAMPLE_MARGIN_SECONDS) }, cancel));
                            (ha.join().unwrap_or_else(|_| Err("decode failed".into())), hb.join().unwrap_or_else(|_| Err("decode failed".into())))
                        });
                        let (a, b) = (a?, b?);
                        let early = js_round((start - from) * 36.0) as i64;
                        let slack = ((start - from) * 4.0).ceil() as i64 + SHIFT;
                        let mut r = judge_frames(&a, &b, &Shifts { min_shift: early - slack, max_shift: early + slack, expect: early });
                        r["at"] = json!(start);
                        Ok(r)
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("decode failed".into()))).collect()
        });
        let mut ok = vec![];
        for r in results {
            match r {
                Ok(v) => ok.push(v),
                Err(e) => return fail(e),
            }
        }
        if let Some(failed) = ok.iter().find(|r| r["ok"] != true) {
            let mut f = failed.clone();
            f["sampled"] = json!(ok.len());
            return f;
        }
        let mean = ok.iter().map(|r| r["mean"].as_f64().unwrap_or(0.0)).sum::<f64>() / ok.len() as f64;
        let low = ok.iter().map(|r| r["low"].as_f64().unwrap_or(0.0)).fold(f64::INFINITY, f64::min);
        let frames: u64 = ok.iter().map(|r| r["frames"].as_u64().unwrap_or(0)).sum();
        return json!({ "ok": true, "mean": round3(mean), "low": low, "frames": frames, "sampled": ok.len() });
    }
    let (a, b) = std::thread::scope(|s| {
        let ha = s.spawn(|| decode(source, &DecodeRequest { width: W, height: H, ..Default::default() }, cancel));
        let hb = s.spawn(|| decode(candidate, &DecodeRequest { width: W, height: H, ..Default::default() }, cancel));
        (ha.join().unwrap_or_else(|_| Err("decode failed".into())), hb.join().unwrap_or_else(|_| Err("decode failed".into())))
    });
    match (a, b) {
        (Ok(a), Ok(b)) => judge_frames(&a, &b, &Shifts::default()),
        (Err(e), _) | (_, Err(e)) => fail(e),
    }
}

/// The decode arguments of one ffmpeg run (ffmpegDecoder's `once`).
pub fn decoder_args(file: &str, r: &DecodeRequest, hw: &[String]) -> Vec<String> {
    let mut a: Vec<String> = ["-nostdin", "-hide_banner", "-loglevel", "error"].iter().map(|s| s.to_string()).collect();
    a.extend(hw.iter().cloned());
    a.extend(["-protocol_whitelist".to_string(), "file".to_string()]);
    if let Some(s) = r.start.filter(|s| s.is_finite() && *s > 0.0) {
        a.extend(["-ss".into(), format!("{s:.3}")]);
    }
    if let Some(l) = r.length.filter(|l| l.is_finite() && *l > 0.0) {
        a.extend(["-t".into(), format!("{l:.3}")]);
    }
    a.extend(["-i".into(), file.into(), "-vf".into(), format!("scale={}:{}:flags=area,format=gray", r.width, r.height), "-frames:v".into(), MAX_FRAMES.to_string(), "-f".into(), "rawvideo".into(), "-".into()]);
    a
}

/// A program run for the decoder (tests stand in their own).
pub type Spawn = dyn Fn(&str, &[String], &Arc<AtomicBool>, usize, Duration) -> Result<Vec<u8>, String> + Send + Sync;

/// ffmpeg as a child process: stdout collected up to `limit`, killed at the timeout or a cancel
pub fn run_ffmpeg(cmd: &str, args: &[String], cancel: &Arc<AtomicBool>, limit: usize, timeout: Duration) -> Result<Vec<u8>, String> {
    let mut child = Command::new(cmd).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| super::owned::code_of(&e).to_string())?;
    let mut out = child.stdout.take().unwrap();
    let pid = child.id() as i32;
    let done = Arc::new(AtomicBool::new(false));
    let (d2, c2) = (done.clone(), cancel.clone());
    let started = Instant::now();
    let watcher = std::thread::spawn(move || {
        while !d2.load(Ordering::SeqCst) {
            if c2.load(Ordering::SeqCst) || started.elapsed() > timeout {
                unsafe { libc::kill(pid, libc::SIGKILL) };
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    });
    let mut buf = vec![];
    let mut chunk = [0u8; 65536];
    let mut over = false;
    loop {
        match out.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if buf.len() + n > limit {
                    over = true;
                    unsafe { libc::kill(pid, libc::SIGKILL) };
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
        }
    }
    let status = child.wait();
    done.store(true, Ordering::SeqCst);
    let _ = watcher.join();
    match status {
        Ok(s) if s.success() && !over => Ok(buf),
        _ => Err("DECODE_FAILED".into()),
    }
}

/// ffmpegDecoder({ spawn, ffmpegPath, timeoutMs, accel }): a GPU decode that fails is done again on the CPU
pub fn ffmpeg_decoder(ffmpeg: String, spawn: Arc<Spawn>, accel: Option<Arc<dyn Fn() -> Option<Vec<String>> + Send + Sync>>, timeout: Duration) -> Arc<Decode> {
    Arc::new(move |file: &str, r: &DecodeRequest, cancel: &Arc<AtomicBool>| {
        let limit = r.width * r.height * MAX_FRAMES;
        let hw = accel.as_ref().and_then(|a| a());
        if let Some(hw) = hw.filter(|h| !h.is_empty()) {
            match spawn(&ffmpeg, &decoder_args(file, r, &hw), cancel, limit, timeout) {
                Ok(b) => return Ok(b),
                Err(e) if cancel.load(Ordering::SeqCst) => return Err(e),
                Err(_) => {}
            }
        }
        spawn(&ffmpeg, &decoder_args(file, r, &[]), cancel, limit, timeout)
    })
}

#[cfg(test)]
mod tests {
    //! the picture-check tests of test/nodes.test.js
    use super::*;
    use std::sync::Mutex;

    fn frames(n: usize, f: impl Fn(i64, i64, i64) -> i64) -> Vec<u8> {
        let mut out = Vec::with_capacity(n * W * H);
        for k in 0..n {
            for i in 0..W * H {
                out.push((f(k as i64, (i % W) as i64, (i / W) as i64) & 255) as u8);
            }
        }
        out
    }

    #[test]
    fn shifted_copies_pass_black_frozen_and_other_footage_do_not() {
        let moving = |k: i64, x: i64, y: i64| (x * 3 + y * 2 + k * 5) + ((x * y + k) % 7);
        let src = frames(60, moving);
        assert_eq!(judge_frames(&src, &src, &Shifts::default())["ok"], true);
        let r = judge_frames(&src, &frames(60, |k, x, y| moving(k + 6, x, y)), &Shifts::default());
        assert_eq!(r["ok"], true);
        assert_eq!(r["shift"], -6);
        assert_eq!(judge_frames(&src, &frames(60, |_, _, _| 0), &Shifts::default())["ok"], false);
        assert_eq!(judge_frames(&src, &frames(60, |_, x, y| moving(0, x, y)), &Shifts::default())["ok"], false);
        assert_eq!(judge_frames(&src, &frames(60, |k, x, y| (y * 7 + k * 3) ^ x), &Shifts::default())["ok"], false);
        assert_eq!(judge_frames(&src, &[], &Shifts::default())["ok"], false);
    }

    #[test]
    fn a_still_scene_ties_to_the_expected_offset() {
        let base: Vec<i64> = (0..W * H).map(|i| (((i / W) * 2 + (i % W)) % 256) as i64).collect();
        let seed = Mutex::new(12345u64);
        let rnd = move || {
            let mut s = seed.lock().unwrap();
            *s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((*s >> 33) as f64) / (1u64 << 31) as f64
        };
        let rnd = Arc::new(rnd);
        let r2 = rnd.clone();
        let decode: Arc<Decode> = Arc::new(move |_f: &str, r: &DecodeRequest, _c: &Arc<AtomicBool>| {
            let n = js_round(r.length.unwrap_or(60.0) * 36.0) as usize;
            let mut buf = vec![0u8; n * W * H];
            for f in 0..n {
                for i in 0..W * H {
                    buf[f * W * H + i] = (base[i] + js_round((r2() - 0.5) * 6.0) as i64).clamp(0, 255) as u8;
                }
            }
            Ok(buf)
        });
        let cancel = Arc::new(AtomicBool::new(false));
        let mut failed = 0;
        for _ in 0..4 {
            let r3 = rnd.clone();
            if compare_pictures("s", "c", &cancel, &*decode, Some(60.0), &mut move || r3())["ok"] != true {
                failed += 1;
            }
        }
        assert_eq!(failed, 0);
    }

    #[test]
    fn the_gpu_decodes_first_and_the_cpu_again_when_it_fails() {
        let calls = Arc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let ok_on_gpu = Arc::new(AtomicBool::new(true));
        let (c2, g2) = (calls.clone(), ok_on_gpu.clone());
        let spawn: Arc<Spawn> = Arc::new(move |_cmd: &str, args: &[String], _c: &Arc<AtomicBool>, _l: usize, _t: Duration| {
            c2.lock().unwrap().push(args.to_vec());
            let gpu = args.iter().any(|a| a == "-hwaccel");
            if gpu && !g2.load(Ordering::SeqCst) {
                Err("DECODE_FAILED".into())
            } else {
                Ok(vec![0; 4])
            }
        });
        let accel: Arc<dyn Fn() -> Option<Vec<String>> + Send + Sync> = Arc::new(|| Some(vec!["-hwaccel".into(), "vaapi".into(), "-hwaccel_device".into(), "/dev/dri/renderD128".into()]));
        let decode = ffmpeg_decoder("ffmpeg".into(), spawn.clone(), Some(accel), Duration::from_secs(60));
        let cancel = Arc::new(AtomicBool::new(false));
        let r = DecodeRequest { width: 2, height: 2, ..Default::default() };
        assert_eq!(decode("a.mp4", &r, &cancel).unwrap().len(), 4);
        {
            let c = calls.lock().unwrap();
            assert_eq!(c.len(), 1);
            assert!(c[0].iter().position(|a| a == "-hwaccel") < c[0].iter().position(|a| a == "-i"));
        }
        ok_on_gpu.store(false, Ordering::SeqCst);
        calls.lock().unwrap().clear();
        assert_eq!(decode("a.mp4", &r, &cancel).unwrap().len(), 4);
        assert_eq!(calls.lock().unwrap().iter().map(|a| a.iter().any(|x| x == "-hwaccel")).collect::<Vec<_>>(), vec![true, false]);
        calls.lock().unwrap().clear();
        ffmpeg_decoder("ffmpeg".into(), spawn, None, Duration::from_secs(60))("a.mp4", &r, &cancel).unwrap();
        assert_eq!(calls.lock().unwrap().iter().map(|a| a.iter().any(|x| x == "-hwaccel")).collect::<Vec<_>>(), vec![false]);
    }

    #[test]
    fn real_encodes_pass_a_blacked_out_one_does_not() {
        let has = Command::new("ffmpeg").args(["-hide_banner", "-encoders"]).output().map(|o| String::from_utf8_lossy(&o.stdout).contains(" libx265 ")).unwrap_or(false);
        if !has {
            eprintln!("skipped: needs ffmpeg with libx265");
            return;
        }
        let d = super::super::testutil::tempdir().unwrap();
        let p = |n: &str| d.path().join(n).to_string_lossy().to_string();
        let run = |args: &[&str]| assert!(Command::new("ffmpeg").args(args).output().unwrap().status.success());
        run(&["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=12:duration=2,noise=alls=3:allf=t", "-c:v", "libx264", "-pix_fmt", "yuv420p", &p("src.mp4")]);
        run(&["-v", "error", "-y", "-i", &p("src.mp4"), "-c:v", "libx265", "-b:v", "300k", "-x265-params", "log-level=error", "-an", &p("good.mp4")]);
        run(&["-v", "error", "-y", "-i", &p("src.mp4"), "-vf", "drawbox=t=fill:c=black", "-c:v", "libx265", "-b:v", "300k", "-x265-params", "log-level=error", "-an", &p("black.mp4")]);
        let decode = ffmpeg_decoder("ffmpeg".into(), Arc::new(run_ffmpeg), None, Duration::from_secs(120));
        let cancel = Arc::new(AtomicBool::new(false));
        let mut r = || 0.5;
        assert_eq!(compare_pictures(&p("src.mp4"), &p("good.mp4"), &cancel, &*decode, None, &mut r)["ok"], true);
        assert_eq!(compare_pictures(&p("src.mp4"), &p("black.mp4"), &cancel, &*decode, None, &mut r)["ok"], false);
        let missing = compare_pictures(&p("src.mp4"), &p("missing.mp4"), &cancel, &*decode, None, &mut r);
        assert_eq!(missing["ok"], false);
        assert_eq!(missing["reason"], "decode-failed");
    }
}
