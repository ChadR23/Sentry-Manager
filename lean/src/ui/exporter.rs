//! server/exporter.js: a stretch of footage (from a start in one clip to an
//! end in the same or a later one) rendered on the server into one MP4: the
//! cameras in a grid, or one camera, with the date, time and speed burned in.
//! One export at a time (others wait); the file is kept in <data>/exports for
//! a day. Each clip's part is rendered on its own with ffmpeg (inputs seeked
//! to the part, the overlay from an ASS file), then the parts are joined
//! without encoding again.

use super::ctx::{Level, UiCtx, VehicleRef};
use super::js;
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const CAMS: [&str; 6] = ["front", "back", "left_repeater", "right_repeater", "left_pillar", "right_pillar"];
pub fn cam_name(c: &str) -> &'static str {
    match c {
        "front" => "Front",
        "back" => "Rear",
        "left_repeater" => "Left repeater",
        "right_repeater" => "Right repeater",
        "left_pillar" => "Left pillar",
        "right_pillar" => "Right pillar",
        _ => "undefined",
    }
}
const GRID6: [&str; 6] = ["left_pillar", "front", "right_pillar", "left_repeater", "back", "right_repeater"];
const GRID4: [&str; 4] = ["front", "back", "left_repeater", "right_repeater"];
const TILE_W: i64 = 640;
const TILE_H: i64 = 480;
const FPS: i64 = 30;
pub const MAX_SECONDS: f64 = 3600.0;
pub const MAX_CLIPS: usize = 120;
const KEEP_MS: f64 = 24.0 * 3600.0 * 1000.0;
const KEEP_FILES: usize = 10;
pub const GPU_ENCODERS: [&str; 3] = ["h264_nvenc", "h264_qsv", "h264_vaapi"];

/// A refusal of the request (400, shown as written).
#[derive(Debug, Clone, PartialEq)]
pub struct ExportError(pub String);

#[derive(Debug, Clone, Copy)]
struct KeyParts {
    y: i32,
    mo: u32,
    d: u32,
    h: u32,
    mi: u32,
    s: u32,
}

fn key_parts(key: &str) -> Option<KeyParts> {
    let b = key.as_bytes();
    if b.len() != 19 || b[4] != b'-' || b[7] != b'-' || b[10] != b'_' || b[13] != b'-' || b[16] != b'-' {
        return None;
    }
    let d = |a: usize, z: usize| -> Option<u32> { key.get(a..z).filter(|s| s.bytes().all(|c| c.is_ascii_digit())).and_then(|s| s.parse().ok()) };
    Some(KeyParts { y: d(0, 4)? as i32, mo: d(5, 7)?, d: d(8, 10)?, h: d(11, 13)?, mi: d(14, 16)?, s: d(17, 19)? })
}

/// Date.UTC with JavaScript's overflow (month 13, day 0, hour 25 roll over).
fn utc_ms(p: KeyParts) -> i64 {
    let mut y = p.y as i64;
    let mut m = p.mo as i64 - 1;
    y += m.div_euclid(12);
    m = m.rem_euclid(12);
    let first = chrono::NaiveDate::from_ymd_opt(y as i32, m as u32 + 1, 1).unwrap_or_default();
    let days = first.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis();
    days + (p.d as i64 - 1) * 86_400_000 + p.h as i64 * 3_600_000 + p.mi as i64 * 60_000 + p.s as i64 * 1000
}

/// "2026-11-03 10:00:05 AM" (or 24-hour) for a clip key plus seconds.
pub fn wall_at(key: &str, seconds: f64, clock24: bool) -> String {
    let Some(p) = key_parts(key) else { return String::new() };
    let ms = utc_ms(p) + (seconds.floor() as i64) * 1000;
    let Some(t) = chrono::DateTime::from_timestamp_millis(ms) else { return String::new() };
    use chrono::{Datelike, Timelike};
    let date = format!("{}-{:02}-{:02}", t.year(), t.month(), t.day());
    let h = t.hour();
    let clock = if clock24 {
        format!("{:02}:{:02}:{:02}", h, t.minute(), t.second())
    } else {
        format!("{}:{:02}:{:02} {}", if h % 12 == 0 { 12 } else { h % 12 }, t.minute(), t.second(), if h < 12 { "AM" } else { "PM" })
    };
    format!("{date} {clock}")
}

#[derive(Debug, Clone)]
pub struct Clip {
    pub key: String,
    /// camera -> path, in the order the request gave them
    pub files: Vec<(String, String)>,
    pub from: f64,
    pub to: f64,
}

impl Clip {
    pub fn file(&self, cam: &str) -> Option<&str> {
        self.files.iter().find(|(c, _)| c == cam).map(|(_, p)| p.as_str())
    }
}

#[derive(Debug, Clone)]
pub struct Request {
    pub clips: Vec<Clip>,
    pub camera: String,
    pub units: String,
    pub seconds: f64,
    pub privacy: bool,
}

/// Check a request and put it in order.
pub fn normalize(body: &Value) -> Result<Request, ExportError> {
    let e = |s: String| Err(ExportError(s));
    let clips: &[Value] = body.get("clips").and_then(Value::as_array).map_or(&[], |a| a.as_slice());
    if clips.is_empty() {
        return e("Choose a start and an end first.".into());
    }
    if clips.len() > MAX_CLIPS {
        return e(format!("An export can cover up to {MAX_CLIPS} clips (two hours of footage); choose a shorter stretch."));
    }
    let mut out = Vec::new();
    for (i, c) in clips.iter().enumerate() {
        let key = c.get("key").map(js::string).unwrap_or_else(|| "undefined".into());
        if c.get("key").is_none() || c.get("key").is_some_and(Value::is_null) || key_parts(&key).is_none() {
            return e(format!("Clip {} has no valid time.", i + 1));
        }
        let mut files = Vec::new();
        if let Some(Value::Object(f)) = c.get("files") {
            for (cam, p) in f {
                if let Some(p) = p.as_str().filter(|p| !p.is_empty()) {
                    if CAMS.contains(&cam.as_str()) {
                        files.push((cam.clone(), p.to_string()));
                    }
                }
            }
        }
        if files.is_empty() {
            return e(format!("The clip at {} has no video.", wall_at(&key, 0.0, false)));
        }
        let from = js::number(c.get("from"));
        let to = js::number(c.get("to"));
        if !from.is_finite() || !to.is_finite() || from < 0.0 || to > 600.0 || to - from < 0.5 {
            return e(format!("The clip at {} has no time to export.", wall_at(&key, 0.0, false)));
        }
        out.push(Clip { key, files, from, to });
    }
    let seconds: f64 = out.iter().map(|c| c.to - c.from).sum();
    if seconds > MAX_SECONDS {
        return e("An export can be up to 60 minutes long; choose a shorter stretch.".into());
    }
    let camera = match body.get("camera") {
        None => "grid".to_string(),
        Some(Value::String(s)) if s == "grid" => "grid".into(),
        Some(v) => js::string(v),
    };
    if camera != "grid" && !CAMS.contains(&camera.as_str()) {
        return e("Choose all cameras or one camera.".into());
    }
    if camera != "grid" && !out.iter().any(|c| c.file(&camera).is_some()) {
        return e(format!("None of these clips has the {} camera.", cam_name(&camera)));
    }
    let units = if body.get("units").and_then(Value::as_str) == Some("kmh") { "kmh" } else { "mph" };
    // privacy: no speed in the picture and no hidden details in the file
    let privacy = body.get("privacy") == Some(&Value::Bool(true));
    Ok(Request { clips: out, camera, units: units.into(), seconds, privacy })
}

#[derive(Debug, Clone, PartialEq)]
pub struct Layout {
    pub cams: Vec<String>,
    pub cols: i64,
    pub rows: i64,
    pub w: Option<i64>,
    pub h: Option<i64>,
}

/// The picture: one camera, or a grid of the cameras these clips have.
pub fn layout_for(clips: &[Clip], camera: &str) -> Layout {
    if camera != "grid" {
        return Layout { cams: vec![camera.into()], cols: 1, rows: 1, w: None, h: None };
    }
    let pillars = clips.iter().any(|c| c.file("left_pillar").is_some() || c.file("right_pillar").is_some());
    let cams: Vec<String> = if pillars { GRID6.iter().map(|s| s.to_string()).collect() } else { GRID4.iter().map(|s| s.to_string()).collect() };
    let cols = if pillars { 3 } else { 2 };
    Layout { cams, cols, rows: 2, w: Some(cols * TILE_W), h: Some(2 * TILE_H) }
}

fn ass_escape(s: &str) -> String {
    s.chars().filter(|c| !matches!(c, '{' | '}' | '\\')).collect()
}

fn ass_time(t: f64) -> String {
    let cs = js::round(t * 100.0).max(0.0) as i64;
    let h = cs / 360_000;
    let m = (cs % 360_000) / 6000;
    let s = (cs % 6000) / 100;
    format!("{h}:{m:02}:{s:02}.{:02}", cs % 100)
}

fn dim(v: Option<i64>) -> String {
    v.map_or("null".into(), |x| x.to_string())
}

/// The overlay for one clip's part (speeds: m/s for each second of the clip).
pub fn overlay_ass(clip: &Clip, speeds: Option<&[Option<f64>]>, units: &str, clock24: bool, width: Option<i64>, height: Option<i64>, layout: &Layout) -> String {
    let hf = height.map_or(f64::NAN, |h| h as f64);
    let size_f = js::round(hf * 0.035);
    let size = if size_f.is_nan() { f64::NAN } else { size_f.max(16.0) };
    let small = if size.is_nan() { f64::NAN } else { js::round(size * 0.7).max(13.0) };
    let n = |x: f64| js::number_string(x);
    let mut lines: Vec<String> = vec![
        "[Script Info]".into(),
        "ScriptType: v4.00+".into(),
        format!("PlayResX: {}", dim(width)),
        format!("PlayResY: {}", dim(height)),
        "WrapStyle: 2".into(),
        "ScaledBorderAndShadow: yes".into(),
        "".into(),
        "[V4+ Styles]".into(),
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding".into(),
        format!(
            "Style: Bar,DejaVu Sans,{},&H00FFFFFF,&H00FFFFFF,&H99000000,&H99000000,1,0,0,0,100,100,0,0,3,{},0,1,{},0,{},1",
            n(size),
            n(js::round(size * 0.35)),
            n(js::round(size * 0.6)),
            n(js::round(size * 0.6))
        ),
        format!("Style: Cam,DejaVu Sans,{},&H00FFFFFF,&H00FFFFFF,&H99000000,&H99000000,1,0,0,0,100,100,0,0,3,{},0,7,0,0,0,1", n(small), n(js::round(small * 0.3))),
        "".into(),
        "[Events]".into(),
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text".into(),
    ];
    let dur = clip.to - clip.from;
    let mut sec = clip.from.floor();
    while sec < clip.to {
        let a = (sec - clip.from).max(0.0);
        let b = dur.min(sec + 1.0 - clip.from);
        if b > a {
            let v = speeds.and_then(|s| s.get(sec as usize).copied().flatten()).filter(|v| v.is_finite());
            let speed = v.map_or(String::new(), |v| {
                let mps = if units == "kmh" { 3.6 } else { 2.23694 };
                format!("   {} {}", n(js::round(v.abs() * mps)), if units == "mph" { "mph" } else { "km/h" })
            });
            lines.push(format!("Dialogue: 0,{},{},Bar,,0,0,0,,{}{}", ass_time(a), ass_time(b), ass_escape(&wall_at(&clip.key, sec, clock24)), ass_escape(&speed)));
        }
        sec += 1.0;
    }
    if layout.cols > 1 || layout.rows > 1 {
        for (i, cam) in layout.cams.iter().enumerate() {
            let i = i as i64;
            let x = (i % layout.cols) * TILE_W + 8;
            let y = (i / layout.cols) * TILE_H + 8;
            lines.push(format!("Dialogue: 0,{},{},Cam,,0,0,0,,{{\\pos({x},{y})}}{}", ass_time(0.0), ass_time(dur), ass_escape(cam_name(cam))));
        }
    }
    format!("{}\n", lines.join("\n"))
}

struct Encoder {
    pre: &'static [&'static str],
    tail: &'static str,
    args: &'static [&'static str],
}

const VAAPI_DEVICE: &str = "/dev/dri/renderD128";

fn encoder(name: &str) -> Option<Encoder> {
    Some(match name {
        "libx264" => Encoder { pre: &[], tail: "format=yuv420p", args: &["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"] },
        "h264_nvenc" => Encoder { pre: &[], tail: "format=yuv420p", args: &["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "23", "-b:v", "0"] },
        "h264_qsv" => Encoder { pre: &[], tail: "format=nv12", args: &["-c:v", "h264_qsv", "-global_quality", "23"] },
        "h264_vaapi" => Encoder { pre: &["-vaapi_device", VAAPI_DEVICE], tail: "format=nv12,hwupload", args: &["-c:v", "h264_vaapi", "-rc_mode", "CQP", "-qp", "23"] },
        _ => return None,
    })
}

/// ffmpeg's arguments for one clip's part (run in the work folder).
pub fn part_args(clip: &Clip, layout: &Layout, ass_name: &str, out_name: &str, enc_name: &str) -> Vec<String> {
    let dur = clip.to - clip.from;
    let enc = encoder(enc_name).unwrap_or_else(|| encoder("libx264").unwrap());
    let s = |x: &str| x.to_string();
    let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-progress", "pipe:1", "-nostats"].iter().map(|x| s(x)).collect();
    args.extend(enc.pre.iter().map(|x| s(x)));
    let mut filters = Vec::new();
    let mut tiles = Vec::new();
    for (i, cam) in layout.cams.iter().enumerate() {
        match clip.file(cam) {
            Some(file) => args.extend([s("-ss"), js::to_fixed(clip.from, 3), s("-t"), js::to_fixed(dur, 3), s("-i"), s(file)]),
            // a camera this clip lacks: a black tile
            None => args.extend([s("-f"), s("lavfi"), s("-t"), js::to_fixed(dur, 3), s("-i"), format!("color=c=black:s={TILE_W}x{TILE_H}:r={FPS}")]),
        }
        if layout.cols == 1 && layout.rows == 1 {
            filters.push(format!("[{i}:v]scale=w='min(iw,1920)':h=-2,setsar=1,fps={FPS}[v{i}]"));
        } else {
            filters.push(format!("[{i}:v]scale={TILE_W}:{TILE_H}:force_original_aspect_ratio=decrease,pad={TILE_W}:{TILE_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={FPS}[v{i}]"));
        }
        tiles.push(format!("[v{i}]"));
    }
    let mut last = "v0".to_string();
    if tiles.len() > 1 {
        let pos: Vec<String> = (0..layout.cams.len() as i64).map(|i| format!("{}_{}", (i % layout.cols) * TILE_W, (i / layout.cols) * TILE_H)).collect();
        filters.push(format!("{}xstack=inputs={}:layout={}:fill=black[grid]", tiles.join(""), tiles.len(), pos.join("|")));
        last = "grid".into();
    }
    filters.push(format!("[{last}]subtitles={ass_name},{}[out]", enc.tail));
    args.extend([s("-filter_complex"), filters.join(";"), s("-map"), s("[out]"), s("-t"), js::to_fixed(dur, 3), s("-an")]);
    args.extend(enc.args.iter().map(|x| s(x)));
    args.extend([s("-r"), FPS.to_string(), s("-movflags"), s("+faststart"), s(out_name)]);
    args
}

pub fn clock_len(s: f64) -> String {
    let t = js::round(s) as i64;
    let h = t / 3600;
    let m = (t % 3600) / 60;
    let sec = t % 60;
    if h != 0 { format!("{h}:{m:02}:{sec:02}") } else { format!("{m}:{sec:02}") }
}

pub fn mb(b: u64) -> String {
    let b = b as f64;
    if b >= 1e9 {
        format!("{} GB", js::to_fixed(b / 1e9, 1))
    } else {
        format!("{} MB", js::number_string(js::round(b / 1e6).max(1.0)))
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

struct Export {
    id: String,
    vehicle_id: String,
    req: Request,
    state: String,
    done_seconds: f64,
    name: String,
    title: String,
    file: PathBuf,
    created_at: f64,
    finished_at: Option<f64>,
    job_id: Value,
    error: Option<String>,
    notes: Vec<String>,
    bytes: u64,
    cancel: bool,
    pid: Option<u32>,
    encoder: Option<String>,
}

fn public(x: &Export) -> Value {
    let done = x.req.seconds.min(x.done_seconds);
    json!({
        "id": x.id, "vehicleId": x.vehicle_id, "state": x.state, "seconds": js::num(x.req.seconds), "done": js::num(done),
        "progress": if x.req.seconds != 0.0 { js::num((x.done_seconds / x.req.seconds).min(1.0)) } else { json!(0) },
        "bytes": x.bytes, "error": x.error, "name": x.name, "title": x.title, "notes": x.notes,
        "createdAt": js::num(x.created_at), "finishedAt": x.finished_at.map(js::num), "jobId": x.job_id
    })
}

type Shared = Arc<Mutex<Export>>;

pub struct ExporterCfg {
    pub dir: PathBuf,
    pub ffmpeg: String,
    pub ffprobe: Option<String>,
    /// EXPORT_ENCODER != cpu
    pub gpu: bool,
    pub gpu_encoders: Vec<String>,
}

pub struct Exporter {
    cfg: ExporterCfg,
    ffprobe: String,
    ctx: Arc<dyn UiCtx>,
    chosen: Mutex<Option<String>>,
    all: Mutex<Vec<Shared>>,
    queue: Mutex<VecDeque<Shared>>,
    running: Mutex<Option<Shared>>,
}

impl Exporter {
    pub fn new(cfg: ExporterCfg, ctx: Arc<dyn UiCtx>) -> Arc<Exporter> {
        let ffprobe = cfg.ffprobe.clone().unwrap_or_else(|| if cfg.ffmpeg.ends_with("ffmpeg") { format!("{}ffprobe", &cfg.ffmpeg[..cfg.ffmpeg.len() - 6]) } else { "ffprobe".into() });
        Arc::new(Exporter { cfg, ffprobe, ctx, chosen: Mutex::new(None), all: Mutex::new(Vec::new()), queue: Mutex::new(VecDeque::new()), running: Mutex::new(None) })
    }

    /// The clock written on an export: one that cannot be read is logged, and 12-hour then.
    fn clock24(&self) -> bool {
        match self.ctx.setting("appearance") {
            Ok(a) => a.and_then(|a| a.get("clock24").map(js::truthy)).unwrap_or(false),
            Err(e) => {
                self.ctx.log(Level::Warn, "export", &format!("Export times in 12-hour time: the appearance could not be read: {e}"));
                false
            }
        }
    }

    fn find(&self, id: &str) -> Option<Shared> {
        self.all.lock().unwrap().iter().find(|x| x.lock().unwrap().id == id).cloned()
    }

    /// Check a request, queue the export and return it (its job shows the progress).
    /// Err((400, refusal)), or Err((500, what failed)) when its job could not be kept.
    pub fn start(self: &Arc<Self>, vehicle: &VehicleRef, body: &Value) -> Result<Value, (u16, String)> {
        let mut req = normalize(body).map_err(|e| (400, e.0))?;
        // every file must be a real file of this vehicle's footage
        for clip in &mut req.clips {
            let key = clip.key.clone();
            for (cam, p) in &mut clip.files {
                match self.ctx.resolve_footage(p) {
                    Some((real, v)) if v.id == vehicle.id => *p = real.to_string_lossy().into_owned(),
                    _ => return Err((400, format!("The {} file of the clip at {} is not in {}'s footage.", cam_name(cam), wall_at(&key, 0.0, false), vehicle.name))),
                }
            }
        }
        let id = super::packs::random_hex(8);
        let c24 = self.clock24();
        let first = &req.clips[0];
        let last = &req.clips[req.clips.len() - 1];
        let from = wall_at(&first.key, first.from, c24);
        let to: String = wall_at(&last.key, last.to, c24).chars().skip(11).collect();
        let name: String = format!("Sentry {} {}.mp4", if req.privacy { "export" } else { &vehicle.name }, from.replace(':', "-")).chars().filter(|c| !matches!(c, '\\' | '/' | '"' | '<' | '>' | '|' | '?' | '*')).collect();
        let title = format!("Export {}: {from} to {to}{}", vehicle.name, if req.camera == "grid" { String::new() } else { format!(" ({})", cam_name(&req.camera)) });
        let busy = self.running.lock().unwrap().is_some();
        // (no export without its Activity row: no made-up job id)
        let job_id = self.ctx.job_start(json!({ "type": "export", "vehicleId": vehicle.id, "title": title, "detail": if busy { "Waiting for the export before it…" } else { "Starting…" } })).map_err(|e| (500, e))?;
        let x = Arc::new(Mutex::new(Export {
            id: id.clone(), vehicle_id: vehicle.id.clone(), req, state: "waiting".into(), done_seconds: 0.0, name, title,
            file: self.cfg.dir.join(format!("{id}.mp4")), created_at: now_ms(), finished_at: None, job_id, error: None, notes: Vec::new(), bytes: 0, cancel: false, pid: None, encoder: None,
        }));
        self.all.lock().unwrap().push(x.clone());
        let _ = std::fs::create_dir_all(&self.cfg.dir);
        let mut running = self.running.lock().unwrap();
        if running.is_some() {
            self.queue.lock().unwrap().push_back(x.clone());
        } else {
            *running = Some(x.clone());
            x.lock().unwrap().state = "running".into();
            let me = self.clone();
            let job = x.clone();
            std::thread::spawn(move || me.run(job));
        }
        drop(running);
        let out = public(&x.lock().unwrap());
        Ok(out)
    }

    pub fn get(&self, id: &str) -> Option<Value> {
        self.find(id).map(|x| public(&x.lock().unwrap()))
    }

    /// Newest first; only one vehicle's when asked.
    pub fn list(&self, vehicle: Option<&str>) -> Vec<Value> {
        self.all.lock().unwrap().iter().rev().map(|x| x.lock().unwrap()).filter(|x| vehicle.map_or(true, |v| x.vehicle_id == v)).map(|x| public(&x)).collect()
    }

    /// The finished file and its download name.
    pub fn file(&self, id: &str) -> Option<(PathBuf, String)> {
        let x = self.find(id)?;
        let x = x.lock().unwrap();
        (x.state == "done" && x.file.exists()).then(|| (x.file.clone(), x.name.clone()))
    }

    pub fn cancel(&self, id: &str) -> bool {
        let Some(x) = self.find(id) else { return false };
        let mut g = x.lock().unwrap();
        if g.state != "waiting" && g.state != "running" {
            return false;
        }
        g.cancel = true;
        let mut q = self.queue.lock().unwrap();
        if let Some(at) = q.iter().position(|y| Arc::ptr_eq(y, &x)) {
            q.remove(at);
            g.state = "cancelled".into();
            self.ctx.job_finish(&g.job_id, json!({ "status": "cancelled", "detail": "Cancelled." }));
        } else if let Some(pid) = g.pid {
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        }
        true
    }

    /// Kill what is running (the server stops).
    pub fn stop(&self) {
        for x in self.all.lock().unwrap().iter() {
            let mut g = x.lock().unwrap();
            if let Some(pid) = g.pid {
                g.cancel = true;
                unsafe { libc::kill(pid as i32, libc::SIGKILL) };
            }
        }
    }

    /// Old files and work folders go; only the newest few finished files stay.
    pub fn tidy(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.cfg.dir)?;
        let now = now_ms();
        if let Ok(rd) = std::fs::read_dir(&self.cfg.dir) {
            for e in rd.flatten() {
                let p = e.path();
                let name = e.file_name().to_string_lossy().into_owned();
                let st = std::fs::metadata(&p).ok();
                let known_id = name.strip_suffix(".mp4").unwrap_or(&name).to_string();
                let known = self.find(&known_id);
                if known.as_ref().is_some_and(|k| matches!(k.lock().unwrap().state.as_str(), "waiting" | "running")) {
                    continue;
                }
                let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
                let old = st.as_ref().map_or(true, |m| {
                    use std::os::unix::fs::MetadataExt;
                    now - crate::scanner::ms_of(m.mtime(), m.mtime_nsec()) > KEEP_MS
                });
                if old || (known.is_none() && is_dir) {
                    let _ = if is_dir { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
                }
            }
        }
        let all = self.all.lock().unwrap().clone();
        let mut done: Vec<&Shared> = all.iter().filter(|x| x.lock().unwrap().state == "done").collect();
        done.sort_by(|a, b| b.lock().unwrap().finished_at.unwrap_or(0.0).partial_cmp(&a.lock().unwrap().finished_at.unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
        for x in done.iter().skip(KEEP_FILES) {
            let mut g = x.lock().unwrap();
            let _ = std::fs::remove_file(&g.file);
            g.state = "expired".into();
        }
        for x in &all {
            let mut g = x.lock().unwrap();
            if g.state == "done" && now - g.finished_at.unwrap_or(0.0) > KEEP_MS {
                let _ = std::fs::remove_file(&g.file);
                g.state = "expired".into();
            }
        }
        Ok(())
    }

    fn try_encoder(&self, name: &str) -> bool {
        let Some(enc) = encoder(name) else { return false };
        let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-loglevel".into(), "error".into()];
        args.extend(enc.pre.iter().map(|s| s.to_string()));
        args.extend(["-f", "lavfi", "-i"].iter().map(|s| s.to_string()));
        args.push(format!("color=c=black:s=320x240:r={FPS}"));
        args.extend(["-frames:v", "5", "-vf", enc.tail].iter().map(|s| s.to_string()));
        args.extend(enc.args.iter().map(|s| s.to_string()));
        args.extend(["-f", "null", "-"].iter().map(|s| s.to_string()));
        let Ok(mut child) = Command::new(&self.cfg.ffmpeg).args(&args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else { return false };
        let until = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            match child.try_wait() {
                Ok(Some(s)) => return s.code() == Some(0),
                Ok(None) if std::time::Instant::now() < until => std::thread::sleep(Duration::from_millis(50)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
            }
        }
    }

    /// The GPU's H.264 encoder, found once (EXPORT_ENCODER=cpu, or none: libx264).
    fn encoder_for(&self) -> String {
        let mut c = self.chosen.lock().unwrap();
        if let Some(e) = c.as_ref() {
            return e.clone();
        }
        let mut pick = "libx264".to_string();
        if self.cfg.gpu {
            for name in &self.cfg.gpu_encoders {
                if self.try_encoder(name) {
                    self.ctx.log(Level::Info, "export", &format!("Exports render on the GPU ({name})"));
                    pick = name.clone();
                    break;
                }
            }
        }
        *c = Some(pick.clone());
        pick
    }

    /// The size of one camera's picture.
    fn probe_size(&self, file: &str) -> Option<(i64, i64)> {
        let out = Command::new(&self.ffprobe)
            .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", file])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let t = text.trim();
        let (w, rest) = t.split_once('x')?;
        let h: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if w.is_empty() || h.is_empty() || !w.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        Some((w.parse().ok()?, h.parse().ok()?))
    }

    fn ffmpeg(&self, x: &Shared, args: &[String], cwd: &Path, part_seconds: f64) -> Result<(), String> {
        let mut child = match Command::new(&self.cfg.ffmpeg).args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(format!("spawn {} ENOENT", self.cfg.ffmpeg)),
            Err(e) => return Err(e.to_string()),
        };
        let pid = child.id();
        // (lower priority: playback and conversions first)
        unsafe { libc::setpriority(libc::PRIO_PROCESS, pid, 10) };
        let (base, job_id, total) = {
            let mut g = x.lock().unwrap();
            g.pid = Some(pid);
            (g.done_seconds, g.job_id.clone(), g.req.seconds)
        };
        let mut stderr = child.stderr.take().unwrap();
        let err_reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = stderr.read_to_end(&mut buf);
            let s = String::from_utf8_lossy(&buf).into_owned();
            let n = s.chars().count();
            s.chars().skip(n.saturating_sub(2000)).collect::<String>()
        });
        let mut last_update = 0.0;
        for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
            let Some(us) = line.strip_prefix("out_time_us=") else { continue };
            if !us.bytes().next().is_some_and(|c| c.is_ascii_digit()) || part_seconds == 0.0 {
                continue;
            }
            let digits: String = us.chars().take_while(|c| c.is_ascii_digit()).collect();
            let v = digits.parse::<f64>().unwrap_or(0.0) / 1e6;
            let done = base + part_seconds.min(v);
            x.lock().unwrap().done_seconds = done;
            if now_ms() - last_update > 1000.0 {
                last_update = now_ms();
                self.ctx.job_update(&job_id, json!({ "detail": format!("Rendering {} of {} ({}%)", clock_len(done), clock_len(total), js::number_string(js::round(done / total * 100.0))) }));
            }
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        let err = err_reader.join().unwrap_or_default();
        let mut g = x.lock().unwrap();
        g.pid = None;
        if status.code() == Some(0) {
            g.done_seconds = base + part_seconds;
            return Ok(());
        }
        if g.cancel {
            return Err("cancelled".into());
        }
        let last = err.trim().split('\n').last().unwrap_or("").to_string();
        Err(if last.is_empty() { format!("ffmpeg exited with {}", status.code().map_or("null".into(), |c| c.to_string())) } else { last })
    }

    fn render_parts(&self, x: &Shared, layout: &Layout, work: &Path, enc: &str, notes: &mut Vec<String>) -> Result<Vec<String>, String> {
        let mut parts = Vec::new();
        let n = x.lock().unwrap().req.clips.len();
        for i in 0..n {
            if x.lock().unwrap().cancel {
                return Err("cancelled".into());
            }
            let (mut clip, privacy, units) = {
                let g = x.lock().unwrap();
                (g.req.clips[i].clone(), g.req.privacy, g.req.units.clone())
            };
            // a damaged camera file shows as a black tile; a clip with none that opens is left out
            let cams: Vec<String> = clip.files.iter().map(|(c, _)| c.clone()).collect();
            for cam in cams {
                if !layout.cams.contains(&cam) {
                    clip.files.retain(|(c, _)| *c != cam);
                    continue;
                }
                let f = clip.file(&cam).unwrap().to_string();
                if self.probe_size(&f).is_none() {
                    clip.files.retain(|(c, _)| *c != cam);
                    notes.push(format!("{} at {} could not be read (black)", cam_name(&cam), wall_at(&clip.key, 0.0, self.clock24()).chars().skip(11).collect::<String>()));
                }
            }
            x.lock().unwrap().req.clips[i] = clip.clone();
            if !layout.cams.iter().any(|c| clip.file(c).is_some()) {
                notes.push(format!("the clip at {} could not be read (left out)", wall_at(&clip.key, 0.0, self.clock24()).chars().skip(11).collect::<String>()));
                x.lock().unwrap().done_seconds += clip.to - clip.from;
                continue;
            }
            let front = clip.file("front").or_else(|| layout.cams.iter().find_map(|c| clip.file(c))).or_else(|| clip.files.first().map(|f| f.1.as_str())).unwrap().to_string();
            let speeds = if privacy { None } else { self.ctx.speeds_for(Path::new(&front)) };
            let ass_name = format!("part-{i}.ass");
            let out_name = format!("part-{i}.mp4");
            std::fs::write(work.join(&ass_name), overlay_ass(&clip, speeds.as_deref(), &units, self.clock24(), layout.w, layout.h, layout)).map_err(|e| e.to_string())?;
            self.ffmpeg(x, &part_args(&clip, layout, &ass_name, &out_name, enc), work, clip.to - clip.from)?;
            parts.push(out_name);
        }
        Ok(parts)
    }

    fn run(self: Arc<Self>, x: Shared) {
        let (id, job_id) = {
            let mut g = x.lock().unwrap();
            g.state = "running".into();
            (g.id.clone(), g.job_id.clone())
        };
        let work = self.cfg.dir.join(format!("{id}.work"));
        let res = (|| -> Result<(), String> {
            self.ctx.job_update(&job_id, json!({ "status": "running", "detail": "Starting…" }));
            std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
            let (clips, camera) = {
                let g = x.lock().unwrap();
                (g.req.clips.clone(), g.req.camera.clone())
            };
            let mut layout = layout_for(&clips, &camera);
            if camera != "grid" {
                let sample = clips.iter().find_map(|c| c.file(&camera)).unwrap().to_string();
                let s = self.probe_size(&sample);
                let w = s.map_or(1280, |s| if s.0 == 0 { 1280 } else { s.0 }).min(1920);
                let lw = w - (w % 2);
                layout.w = Some(lw);
                let h = s.map_or(960, |(sw, sh)| js::round((sh * lw) as f64 / sw as f64) as i64);
                layout.h = Some(h - (h % 2));
            }
            let mut enc = self.encoder_for();
            let mut notes = Vec::new();
            let parts = match self.render_parts(&x, &layout, &work, &enc, &mut notes) {
                Ok(p) => p,
                Err(e) => {
                    if x.lock().unwrap().cancel || enc == "libx264" {
                        return Err(e);
                    }
                    self.ctx.log(Level::Warn, "export", &format!("Export {id}: the GPU encoder ({enc}) failed ({e}); rendering on the CPU"));
                    *self.chosen.lock().unwrap() = Some("libx264".into());
                    enc = "libx264".into();
                    x.lock().unwrap().done_seconds = 0.0;
                    self.render_parts(&x, &layout, &work, &enc, &mut notes)?
                }
            };
            x.lock().unwrap().encoder = Some(enc.clone());
            if x.lock().unwrap().cancel {
                return Err("cancelled".into());
            }
            if parts.is_empty() {
                return Err("none of these clips could be read".into());
            }
            std::fs::write(work.join("parts.txt"), parts.iter().map(|p| format!("file '{p}'")).collect::<Vec<_>>().join("\n")).map_err(|e| e.to_string())?;
            self.ctx.job_update(&job_id, json!({ "detail": "Joining the clips…" }));
            let privacy = x.lock().unwrap().req.privacy;
            let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "parts.txt", "-c", "copy"].iter().map(|s| s.to_string()).collect();
            if privacy {
                // no tags, and no SEI units in the video (the encoder writes its name and settings in one)
                args.extend(
                    ["-map_metadata", "-1", "-map_chapters", "-1", "-fflags", "+bitexact", "-metadata:s:v", "handler_name=", "-metadata:s:v", "encoder=", "-bsf:v", "filter_units=remove_types=6"]
                        .iter()
                        .map(|s| s.to_string()),
                );
            }
            args.extend(["-movflags", "+faststart", "export.mp4"].iter().map(|s| s.to_string()));
            self.ffmpeg(&x, &args, &work, 0.0)?;
            let file = x.lock().unwrap().file.clone();
            std::fs::rename(work.join("export.mp4"), &file).map_err(|e| e.to_string())?;
            let bytes = std::fs::metadata(&file).map_err(|e| e.to_string())?.len();
            let mut g = x.lock().unwrap();
            g.bytes = bytes;
            g.state = "done".into();
            g.finished_at = Some(now_ms());
            g.done_seconds = g.req.seconds;
            g.notes = notes.clone();
            let gpu = if enc != "libx264" { ", made on the GPU" } else { "" };
            let note = if notes.is_empty() {
                String::new()
            } else {
                format!(" Note: {}{}.", notes.iter().take(5).cloned().collect::<Vec<_>>().join("; "), if notes.len() > 5 { format!(", and {} more", notes.len() - 5) } else { String::new() })
            };
            self.ctx.job_finish(&job_id, json!({ "detail": format!("Ready to download: {}, {}{gpu}. Kept for a day.{note}", clock_len(g.req.seconds), mb(bytes)), "result": { "export": id } }));
            Ok(())
        })();
        if let Err(e) = res {
            let mut g = x.lock().unwrap();
            g.finished_at = Some(now_ms());
            if g.cancel {
                g.state = "cancelled".into();
                self.ctx.job_finish(&job_id, json!({ "status": "cancelled", "detail": "Cancelled." }));
            } else {
                g.state = "failed".into();
                g.error = Some(e.clone());
                self.ctx.log(Level::Warn, "export", &format!("Export {id} failed: {e}"));
                self.ctx.job_finish(&job_id, json!({ "status": "failed", "detail": format!("The export failed: {e}") }));
            }
        }
        let _ = std::fs::remove_dir_all(&work);
        let next = {
            let mut running = self.running.lock().unwrap();
            let next = self.queue.lock().unwrap().pop_front();
            *running = next.clone();
            next
        };
        if let Some(n) = next {
            self.run(n);
        }
    }
}

/// The file's download headers: an ASCII name and the UTF-8 one (index.js).
pub fn disposition(name: &str) -> String {
    let ascii: String = name.encode_utf16().map(|u| if (0x20..=0x7e).contains(&u) { u as u8 as char } else { '_' }).collect();
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{}", encode_uri_component(name))
}

/// encodeURIComponent
pub fn encode_uri_component(s: &str) -> String {
    let mut o = String::new();
    for b in s.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric() || "-_.!~*'()".contains(c) {
            o.push(c);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

/// Object.values(body.clips[0].files).find(string): the path the built-in Viewer's export names first.
pub fn first_file(body: &Value) -> Option<String> {
    let files = body.get("clips")?.get(0)?.get("files")?;
    match files {
        Value::Object(m) => m.values().find_map(|v| v.as_str().map(str::to_string)),
        Value::Array(a) => a.iter().find_map(|v| v.as_str().map(str::to_string)),
        Value::String(s) => s.chars().next().map(|c| c.to_string()),
        _ => None,
    }
}

#[allow(dead_code)]
fn unused(_: Map<String, Value>) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(key: &str, from: f64, to: f64, cams: &[&str]) -> Value {
        let files: Map<String, Value> = cams.iter().map(|c| (c.to_string(), json!(format!("/footage/{key}-{c}.mp4")))).collect();
        json!({ "key": key, "from": from, "to": to, "files": files })
    }
    fn clip_of(v: &Value) -> Clip {
        normalize(&json!({ "clips": [v] })).unwrap().clips.remove(0)
    }
    fn refused(body: Value) -> String {
        normalize(&body).unwrap_err().0
    }

    // test/exporter.test.js
    #[test]
    fn wall_clock() {
        assert_eq!(wall_at("2026-11-03_23-59-50", 15.0, false), "2026-11-04 12:00:05 AM");
        assert_eq!(wall_at("2026-11-03_13-00-00", 5.9, true), "2026-11-03 13:00:05");
        assert_eq!(wall_at("nonsense", 0.0, false), "");
    }

    #[test]
    fn requests_are_checked() {
        assert!(refused(json!({ "clips": [] })).contains("start and an end"));
        assert!(refused(json!({ "clips": [{ "key": "x", "files": { "front": "/a" }, "from": 0, "to": 5 }] })).contains("no valid time"));
        assert!(refused(json!({ "clips": [{ "key": "2026-11-03_10-00-00", "files": {}, "from": 0, "to": 5 }] })).contains("no video"));
        assert!(refused(json!({ "clips": [clip("2026-11-03_10-00-00", 5.0, 5.2, &["front"])] })).contains("no time to export"));
        let long: Vec<Value> = (0..61).map(|i| clip(&format!("2026-11-03_10-{:02}-00", i % 60), 0.0, 60.0, &["front"])).collect();
        assert!(refused(json!({ "clips": long })).contains("60 minutes"));
        assert!(refused(json!({ "clips": [clip("2026-11-03_10-00-00", 0.0, 5.0, &["front"])], "camera": "trunk" })).contains("all cameras or one"));
        assert!(refused(json!({ "clips": [clip("2026-11-03_10-00-00", 0.0, 5.0, &["front"])], "camera": "back" })).contains("None of these clips has the Rear camera"));
        let ok = normalize(&json!({ "clips": [clip("2026-11-03_10-00-00", 40.0, 60.0, &["front"]), clip("2026-11-03_10-01-00", 0.0, 15.0, &["front"])], "units": "kmh" })).unwrap();
        assert_eq!((ok.camera.as_str(), ok.units.as_str(), ok.seconds), ("grid", "kmh", 35.0));
        let only = normalize(&json!({ "clips": [{ "key": "2026-11-03_10-00-00", "from": 0, "to": 5, "files": { "front": "/a", "evil": "/b" } }] })).unwrap();
        assert_eq!(only.clips[0].files.iter().map(|f| f.0.as_str()).collect::<Vec<_>>(), ["front"]);
    }

    #[test]
    fn grid_layout() {
        let hw3 = layout_for(&[clip_of(&clip("2026-11-03_10-00-00", 0.0, 5.0, &["front", "back"]))], "grid");
        assert_eq!(hw3.cams, ["front", "back", "left_repeater", "right_repeater"]);
        assert_eq!((hw3.cols, hw3.w, hw3.h), (2, Some(1280), Some(960)));
        let hw4 = layout_for(&[clip_of(&clip("2026-11-03_10-00-00", 0.0, 5.0, &["front", "left_pillar"]))], "grid");
        assert_eq!(hw4.cams, ["left_pillar", "front", "right_pillar", "left_repeater", "back", "right_repeater"]);
        assert_eq!((hw4.cols, hw4.w, hw4.h), (3, Some(1920), Some(960)));
        assert_eq!(layout_for(&[clip_of(&clip("2026-11-03_10-00-00", 0.0, 5.0, &["front"]))], "back").cams, ["back"]);
    }

    #[test]
    fn overlay() {
        let c = clip_of(&clip("2026-11-03_10-00-00", 1.5, 4.0, &["front"]));
        let layout = layout_for(std::slice::from_ref(&c), "grid");
        let ass = overlay_ass(&c, Some(&[Some(0.0), Some(10.0), Some(20.0), None, Some(30.0)]), "mph", false, layout.w, layout.h, &layout);
        let lines: Vec<&str> = ass.split('\n').filter(|l| l.starts_with("Dialogue: 0,") && l.contains(",Bar,")).collect();
        let texts: Vec<&str> = lines.iter().map(|l| l.split(",Bar,,0,0,0,,").nth(1).unwrap()).collect();
        assert_eq!(texts, ["2026-11-03 10:00:01 AM   22 mph", "2026-11-03 10:00:02 AM   45 mph", "2026-11-03 10:00:03 AM"]);
        assert!(lines[0].starts_with("Dialogue: 0,0:00:00.00,0:00:00.50,"));
        assert!(lines[2].contains(",0:00:01.50,0:00:02.50,"));
        assert!(ass.contains("{\\pos(648,8)}Rear"));
        let one = layout_for(std::slice::from_ref(&c), "front");
        assert!(overlay_ass(&c, Some(&[Some(0.0), Some(10.0)]), "kmh", true, Some(640), Some(480), &one).contains("10:00:01   36 km/h"));
    }

    #[test]
    fn ffmpeg_args() {
        let c = clip_of(&clip("2026-11-03_10-00-00", 12.5, 30.0, &["front", "back"]));
        let s = part_args(&c, &layout_for(std::slice::from_ref(&c), "grid"), "part-0.ass", "part-0.mp4", "libx264").join(" ");
        assert!(s.contains("-ss 12.500 -t 17.500 -i /footage/2026-11-03_10-00-00-front.mp4"));
        assert!(s.contains("-f lavfi -t 17.500 -i color=c=black:s=640x480"));
        assert!(s.contains("xstack=inputs=4:layout=0_0|640_0|0_480|640_480"));
        assert!(s.contains("subtitles=part-0.ass"));
        assert!(s.contains("-c:v libx264 -preset veryfast -crf 23 -r 30"));
    }

    #[test]
    fn download_name() {
        assert_eq!(disposition("Sentry Car 2026-11-03 10-00-02 AM.mp4"), "attachment; filename=\"Sentry Car 2026-11-03 10-00-02 AM.mp4\"; filename*=UTF-8''Sentry%20Car%202026-11-03%2010-00-02%20AM.mp4");
        assert_eq!(disposition("Ö.mp4"), "attachment; filename=\"_.mp4\"; filename*=UTF-8''%C3%96.mp4");
        assert_eq!(mb(3_400_000), "3 MB");
        assert_eq!(mb(1_250_000_000), "1.3 GB");
        assert_eq!(clock_len(3.5), "0:04");
        assert_eq!(clock_len(3725.0), "1:02:05");
    }
}
