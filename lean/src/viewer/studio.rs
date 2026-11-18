//! The Studio viewer's file routes (server/studioApi.js and the
//! /api/studio/* routes of index.js), the real-path guard they all go
//! through (safePath.js createRealGuard: a share is not trusted, so every
//! symlink is followed and the result must stay inside an allowed root; the
//! data and system folders only through a root that lies inside them), and
//! the clip filmstrips (src/main/clipThumbnails.js). Nothing here writes to
//! the footage.

use super::ctx::Ctx;
use super::js;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// path.resolve of an absolute path: . and .. taken out
pub fn resolve_abs(p: &str) -> PathBuf {
    let mut out = PathBuf::from("/");
    for c in Path::new(p).components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(x) => out.push(x),
            _ => {}
        }
    }
    out
}

fn inside(abs: &Path, root: &Path) -> bool {
    abs == root || abs.starts_with(root)
}

/// A guard over roots (createRealGuard): the real path of p when it is inside one, else None.
pub struct Guard {
    pub roots: Vec<PathBuf>,
    pub deny: Vec<PathBuf>,
}

impl Guard {
    fn real_roots(&self, abs: Option<&Path>) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for r in &self.roots {
            let r = resolve_abs(&r.to_string_lossy());
            let Ok(real) = std::fs::canonicalize(&r) else { continue };
            if abs.map_or(true, |a| inside(a, &r) || inside(a, &real)) {
                out.push(real);
            }
        }
        out
    }

    fn allowed_in(&self, real: &Path, roots: &[PathBuf]) -> bool {
        let denied: Vec<PathBuf> = self.deny.iter().map(|d| std::fs::canonicalize(d).unwrap_or_else(|_| resolve_abs(&d.to_string_lossy()))).collect();
        roots.iter().any(|root| inside(real, root) && denied.iter().all(|d| !inside(real, d) || inside(root, d)))
    }

    pub fn resolve(&self, p: &str) -> Option<PathBuf> {
        if p.is_empty() || p.contains('\0') || !p.starts_with('/') {
            return None;
        }
        let abs = resolve_abs(p);
        let roots = self.real_roots(Some(&abs));
        if roots.is_empty() {
            return None;
        }
        let real = std::fs::canonicalize(&abs).ok()?;
        self.allowed_in(&real, &roots).then_some(real)
    }

    /// resolve(p, { mustExist }): with `must_exist` false a path whose last parts do not
    /// exist yet is allowed (safePath.js realOrNearest: the nearest real folder, then the rest).
    pub fn resolve_with(&self, p: &str, must_exist: bool) -> Option<PathBuf> {
        if must_exist {
            return self.resolve(p);
        }
        if p.is_empty() || p.contains('\0') || !p.starts_with('/') {
            return None;
        }
        let abs = resolve_abs(p);
        let roots = self.real_roots(Some(&abs));
        if roots.is_empty() {
            return None;
        }
        let mut rest: Vec<std::ffi::OsString> = Vec::new();
        let mut cur = abs.clone();
        let real = loop {
            match std::fs::canonicalize(&cur) {
                Ok(r) => break rest.iter().rev().fold(r, |acc, x| acc.join(x)),
                Err(e) if matches!(e.raw_os_error(), Some(libc::ENOENT) | Some(libc::ENOTDIR)) => {
                    let parent = cur.parent()?.to_path_buf();
                    rest.push(cur.file_name()?.to_os_string());
                    cur = parent;
                }
                Err(_) => return None,
            }
        };
        self.allowed_in(&real, &roots).then_some(real)
    }

    /// Is an open file still inside a root (a swap after resolve)?
    pub fn fd_inside(&self, f: &std::fs::File) -> bool {
        use std::os::fd::AsRawFd;
        match std::fs::read_link(format!("/proc/self/fd/{}", f.as_raw_fd())) {
            Ok(real) => self.allowed_in(&real, &self.real_roots(None)),
            Err(_) => true,
        }
    }
}

/// The Recycle Bin and binned files are never read through the viewer.
pub fn hidden_path(p: &Path) -> bool {
    let s = p.to_string_lossy();
    s.contains("/.sentry-recycle-bin/") || s.ends_with("/.sentry-recycle-bin") || s.ends_with(".binned")
}

pub fn deny_list(ctx: &dyn Ctx) -> Vec<PathBuf> {
    let run = std::env::var("RUN_DIR").unwrap_or_else(|_| "/run/sentry-six-manager".into());
    let mut d = vec![ctx.data_dir(), ctx.app_root(), PathBuf::from(run)];
    d.extend(["/proc", "/sys", "/dev", "/etc", "/root", "/run", "/boot"].map(PathBuf::from));
    d
}

pub fn output_roots(ctx: &dyn Ctx) -> Vec<PathBuf> {
    let mut r = vec![ctx.data_dir().join("converted")];
    r.extend(ctx.extra_roots());
    r
}

/// allowedRoots(): the vehicles' folders and the output folders
pub fn allowed(ctx: &dyn Ctx) -> Guard {
    let mut roots: Vec<PathBuf> = ctx.vehicles().into_iter().map(|v| v.root).collect();
    roots.extend(output_roots(ctx));
    Guard { roots, deny: deny_list(ctx) }
}

/// studioReadable: allowedRoots plus the data folder's thumbnails and exports
pub fn readable(ctx: &dyn Ctx) -> Guard {
    let mut g = allowed(ctx);
    let data = ctx.data_dir();
    g.roots.extend([data.join("thumbnails"), data.join("clip-thumbnails"), data.join("exports")]);
    g
}

fn converter_part(name: &str) -> bool {
    name.starts_with("TEMP-H265-") || name.starts_with("TEMP-AV1-") || name.starts_with("BACKUP-") || name.find(".sentry-six-").is_some_and(|i| name[i + 12..].ends_with(".partial"))
}

/// readDir: symlinks, the bin and the converter's work files left out
pub fn read_dir(dir: &Path) -> std::io::Result<Vec<Value>> {
    let mut out = Vec::new();
    // (libuv's scandir lists names sorted, byte by byte)
    let mut list: Vec<std::fs::DirEntry> = std::fs::read_dir(dir)?.collect::<std::io::Result<_>>()?;
    list.sort_by(|a, b| a.file_name().as_encoded_bytes().cmp(b.file_name().as_encoded_bytes()));
    for e in list {
        let t = e.file_type()?;
        let name = e.file_name().to_string_lossy().into_owned();
        let p = dir.join(&name);
        if t.is_symlink() || hidden_path(&p) || converter_part(&name) {
            continue;
        }
        out.push(json!({ "name": name, "isDirectory": t.is_dir(), "isFile": t.is_file(), "path": p.to_string_lossy() }));
    }
    Ok(out)
}

pub fn stat(p: &Path) -> Value {
    match std::fs::metadata(p) {
        Ok(m) => json!({ "size": m.size(), "isDirectory": m.is_dir(), "isFile": m.is_file(), "mtime": js::iso(crate::scanner::ms_of(m.mtime(), m.mtime_nsec())) }),
        Err(_) => Value::Null,
    }
}

/// readTextConfined: a regular file, not through a final symlink, checked again through its descriptor
pub fn read_text_confined(p: &Path, guard: &Guard, max: u64) -> Option<String> {
    let mut f = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(p).ok()?;
    let md = f.metadata().ok()?;
    if !md.is_file() || !guard.fd_inside(&f) || md.len() > max {
        return None;
    }
    let mut b = Vec::new();
    f.read_to_end(&mut b).ok()?;
    Some(String::from_utf8_lossy(&b).into_owned())
}

fn app_version(ctx: &dyn Ctx) -> Option<String> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(ctx.app_root().join("version.json")).ok()?).ok()?;
    match v.get("version") {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

pub fn context(ctx: &dyn Ctx) -> Value {
    let version = app_version(ctx).map_or("web".to_string(), |v| format!("{v} (web)"));
    json!({ "version": version,
        "vehicles": ctx.vehicles().iter().map(|v| json!({ "id": v.id, "name": v.name, "root": v.root.to_string_lossy(), "timezone": v.timezone })).collect::<Vec<_>>(),
        "outputRoots": output_roots(ctx).iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>() })
}

fn appearance(ctx: &dyn Ctx) -> serde_json::Map<String, Value> {
    match ctx.setting("appearance") {
        Some(Value::Object(o)) => o,
        _ => serde_json::Map::new(),
    }
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        _ => true,
    }
}

pub fn settings(ctx: &dyn Ctx) -> Value {
    let mut out = match ctx.setting("studio-settings") {
        Some(Value::Object(o)) => o,
        _ => serde_json::Map::new(),
    };
    out.insert("timeFormat".into(), json!(if truthy(appearance(ctx).get("clock24")) { "24h" } else { "12h" }));
    Value::Object(out)
}

pub fn set_setting(ctx: &dyn Ctx, body: &Value) -> Result<Value, (u16, String)> {
    let Some(key) = body.get("key").and_then(Value::as_str).filter(|k| k.encode_utf16().count() <= 100) else { return Err((400, "Invalid setting".into())) };
    let value = body.get("value").cloned();
    if key == "timeFormat" {
        let mut a = serde_json::Map::new();
        a.insert("reduceEffects".into(), json!(false));
        for (k, v) in appearance(ctx) {
            a.insert(k, v);
        }
        a.insert("clock24".into(), json!(value == Some(json!("24h"))));
        ctx.set_setting("appearance", Value::Object(a));
        return Ok(json!({ "ok": true }));
    }
    let mut all = match ctx.setting("studio-settings") {
        Some(Value::Object(o)) => o,
        _ => serde_json::Map::new(),
    };
    match value {
        // (JSON.stringify leaves out a key whose value is undefined)
        None => {
            all.remove(key);
        }
        Some(v) => {
            all.insert(key.to_string(), v);
        }
    }
    ctx.set_setting("studio-settings", Value::Object(all));
    Ok(json!({ "ok": true }))
}

const DENIED: &str = "That path is outside the vehicle shares.";

fn path_of(body: &Value) -> String {
    body.get("path").and_then(Value::as_str).unwrap_or("").to_string()
}

pub fn confined(guard: &Guard, body: &Value) -> Result<PathBuf, (u16, String)> {
    match guard.resolve(&path_of(body)) {
        Some(r) if !hidden_path(&r) => Ok(r),
        _ => Err((403, DENIED.into())),
    }
}

pub fn read_dir_route(ctx: &dyn Ctx, body: &Value) -> Result<Value, (u16, String)> {
    let real = confined(&readable(ctx), body)?;
    Ok(Value::Array(read_dir(&real).unwrap_or_default()))
}

pub fn read_file_route(ctx: &dyn Ctx, body: &Value) -> Result<Value, (u16, String)> {
    let g = readable(ctx);
    let real = confined(&g, body)?;
    match read_text_confined(&real, &g, 8 * 1024 * 1024) {
        Some(text) => Ok(json!({ "text": text })),
        None => Err((404, "Not readable".into())),
    }
}

pub fn exists_route(ctx: &dyn Ctx, body: &Value) -> Value {
    json!(readable(ctx).resolve(&path_of(body)).is_some_and(|r| !hidden_path(&r)))
}

pub fn stat_route(ctx: &dyn Ctx, body: &Value) -> Value {
    match readable(ctx).resolve(&path_of(body)) {
        Some(r) if !hidden_path(&r) => stat(&r),
        _ => Value::Null,
    }
}

pub fn browse(ctx: &dyn Ctx, body: &Value) -> Result<Value, (u16, String)> {
    let g = allowed(ctx);
    let has_path = match body.get("path") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        _ => true,
    };
    if !has_path {
        let converted = ctx.data_dir().join("converted");
        let vehicles = ctx.vehicles();
        let entries: Vec<Value> = g
            .roots
            .iter()
            .map(|p| {
                let name = vehicles.iter().find(|v| inside(&resolve_abs(&p.to_string_lossy()), &resolve_abs(&v.root.to_string_lossy()))).map(|v| v.name.clone()).unwrap_or_else(|| if *p == converted { "Converted copies".into() } else { p.to_string_lossy().into_owned() });
                json!({ "name": name, "path": p.to_string_lossy(), "isDirectory": true })
            })
            .collect();
        return Ok(json!({ "path": null, "parent": null, "entries": entries }));
    }
    let real = confined(&g, body)?;
    let entries: Vec<Value> = read_dir(&real).unwrap_or_default().into_iter().filter(|e| e["isDirectory"] == json!(true) && !e["name"].as_str().unwrap_or("").starts_with('.')).collect();
    let at_root = g.roots.iter().any(|p| resolve_abs(&p.to_string_lossy()) == real || std::fs::canonicalize(p).unwrap_or_else(|_| p.clone()) == real);
    let parent = if at_root { Value::Null } else { json!(real.parent().unwrap_or(Path::new("/")).to_string_lossy()) };
    Ok(json!({ "path": real.to_string_lossy(), "parent": parent, "entries": entries }))
}

// ---- clip filmstrips: six small frames spread across a clip, in one JPEG

const STRIP_FRAMES: usize = 6;
const STRIP_WIDTH: u32 = 160;
const STRIPS_KEPT: usize = 20_000;
const STRIPS_QUEUED: usize = 2_000;

type Waiter = Arc<(Mutex<Option<Option<PathBuf>>>, Condvar)>;

#[derive(Default)]
struct StripQueue {
    jobs: VecDeque<(PathBuf, PathBuf)>,
    running: usize,
    in_flight: HashMap<PathBuf, Waiter>,
    prepared: bool,
}

pub struct ClipStrips {
    pub dir: PathBuf,
    ffmpeg: String,
    ffprobe: String,
    q: Mutex<StripQueue>,
}

fn run(cmd: &str, args: &[String], limit: Duration) -> (i32, String) {
    let Ok(mut child) = Command::new(cmd).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() else { return (-1, String::new()) };
    let mut out = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = out.read_to_end(&mut s);
        s.truncate(4096);
        String::from_utf8_lossy(&s).into_owned()
    });
    let started = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s.code().unwrap_or(-1),
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break -1;
            }
        }
    };
    (code, reader.join().unwrap_or_default())
}

impl ClipStrips {
    pub fn new(dir: PathBuf, ffmpeg: String, ffprobe: String) -> Arc<ClipStrips> {
        Arc::new(ClipStrips { dir, ffmpeg, ffprobe, q: Mutex::new(StripQueue::default()) })
    }

    fn prepare(&self) {
        let mut q = self.q.lock().unwrap();
        if q.prepared {
            return;
        }
        q.prepared = true;
        drop(q);
        let _ = std::fs::create_dir_all(&self.dir);
        let Ok(list) = std::fs::read_dir(&self.dir) else { return };
        let mut names: Vec<(f64, PathBuf)> = list.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".jpg")).filter_map(|e| e.metadata().ok().map(|m| (crate::scanner::ms_of(m.mtime(), m.mtime_nsec()), e.path()))).collect();
        if names.len() > STRIPS_KEPT {
            names.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            let n = names.len() - STRIPS_KEPT;
            for (_, p) in names.into_iter().take(n) {
                let _ = std::fs::remove_file(p);
            }
        }
    }

    pub fn cache_path_for(&self, video: &Path) -> Option<PathBuf> {
        let md = std::fs::metadata(video).ok()?;
        if !md.is_file() || md.size() == 0 {
            return None;
        }
        let m = js::js_round(crate::scanner::ms_of(md.mtime(), md.mtime_nsec()));
        Some(self.dir.join(format!("{}.jpg", js::sha1_hex(format!("{}\0{}\0{}", video.to_string_lossy(), md.size(), js::num(m)).as_bytes()))))
    }

    fn generate(&self, video: &Path, target: &Path) -> Option<PathBuf> {
        let v = video.to_string_lossy().into_owned();
        let (status, out) = run(&self.ffprobe, &["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", &v].map(String::from), Duration::from_secs(30));
        let duration = js::number_str(out.trim());
        if status != 0 || !duration.is_finite() || duration <= 0.0 {
            return None;
        }
        let mut rnd = [0u8; 4];
        if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
            let _ = f.read_exact(&mut rnd);
        }
        let tmp = PathBuf::from(format!("{}.{}.{}.tmp.jpg", target.display(), std::process::id(), rnd.iter().map(|b| format!("{b:02x}")).collect::<String>()));
        let t = tmp.to_string_lossy().into_owned();
        let made = |args: Vec<String>| -> bool {
            let mut all: Vec<String> = ["-nostdin", "-hide_banner", "-loglevel", "error"].map(String::from).to_vec();
            all.extend(args);
            all.extend(["-q:v", "5", "-y", &t].map(String::from));
            run(&self.ffmpeg, &all, Duration::from_secs(30)).0 == 0 && std::fs::metadata(&tmp).is_ok_and(|m| m.len() > 0)
        };
        let mut seek = Vec::new();
        let mut filters = Vec::new();
        for i in 0..STRIP_FRAMES {
            seek.extend(["-threads".into(), "1".into(), "-ss".into(), format!("{:.3}", duration * i as f64 / STRIP_FRAMES as f64), "-noaccurate_seek".into(), "-protocol_whitelist".into(), "file".into(), "-i".into(), v.clone()]);
            filters.push(format!("[{i}:v:0]trim=end_frame=1,scale={STRIP_WIDTH}:-2,setsar=1[f{i}]"));
        }
        let stack = format!("{};{}hstack=inputs={STRIP_FRAMES}[strip]", filters.join(";"), (0..STRIP_FRAMES).map(|i| format!("[f{i}]")).collect::<String>());
        let mut args = seek;
        args.extend(["-filter_complex".into(), stack, "-map".into(), "[strip]".into(), "-frames:v".into(), "1".into()]);
        let mut ok = made(args);
        if !ok {
            let step = format!("{:.3}", (duration / STRIP_FRAMES as f64).max(0.05));
            ok = made(vec!["-skip_frame".into(), "nokey".into(), "-protocol_whitelist".into(), "file".into(), "-i".into(), v.clone(), "-an".into(), "-sn".into(), "-dn".into(), "-vf".into(),
                format!("select='gte(t\\,selected_n*{step})',scale={STRIP_WIDTH}:-2,tile={STRIP_FRAMES}x1"), "-fps_mode".into(), "passthrough".into(), "-frames:v".into(), "1".into()]);
        }
        let out = if ok && std::fs::rename(&tmp, target).is_ok() { Some(target.to_path_buf()) } else { None };
        let _ = std::fs::remove_file(&tmp);
        out
    }

    fn pump(self: &Arc<Self>) {
        let mut q = self.q.lock().unwrap();
        while q.running < 2 {
            let Some((video, target)) = q.jobs.pop_front() else { break };
            q.running += 1;
            let me = self.clone();
            std::thread::spawn(move || {
                let out = me.generate(&video, &target);
                let w = {
                    let mut q = me.q.lock().unwrap();
                    q.running -= 1;
                    q.in_flight.remove(&target)
                };
                if let Some(w) = w {
                    *w.0.lock().unwrap() = Some(out);
                    w.1.notify_all();
                }
                me.pump();
            });
        }
    }

    /// The strip of a clip, made first when needed (None when it cannot be made).
    pub fn get(self: &Arc<Self>, video: &Path) -> Option<PathBuf> {
        if !video.is_absolute() || !video.to_string_lossy().to_lowercase().ends_with(".mp4") {
            return None;
        }
        self.prepare();
        let target = self.cache_path_for(video)?;
        if std::fs::metadata(&target).is_ok_and(|m| m.len() > 0) {
            return Some(target);
        }
        let w = {
            let mut q = self.q.lock().unwrap();
            match q.in_flight.get(&target).cloned() {
                Some(w) => w,
                None => {
                    if q.jobs.len() >= STRIPS_QUEUED {
                        return None;
                    }
                    q.jobs.push_front((video.to_path_buf(), target.clone()));
                    let w: Waiter = Arc::new((Mutex::new(None), Condvar::new()));
                    q.in_flight.insert(target.clone(), w.clone());
                    w
                }
            }
        };
        self.pump();
        let mut r = w.0.lock().unwrap();
        while r.is_none() {
            r = w.1.wait(r).unwrap();
        }
        r.clone().unwrap()
    }
}

pub fn thumbnail_route(ctx: &dyn Ctx, strips: &Arc<ClipStrips>, body: &Value) -> Value {
    let Some(real) = readable(ctx).resolve(&path_of(body)) else { return Value::Null };
    let lower = real.to_string_lossy().to_lowercase();
    if hidden_path(&real) || !(lower.ends_with(".mp4") || lower.ends_with(".mov")) {
        return Value::Null;
    }
    strips.get(&real).map_or(Value::Null, |p| json!(p.to_string_lossy()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::viewer::testkit::Car;

    #[test]
    fn the_guard_follows_links_and_keeps_to_the_roots() {
        let car = Car::new("guard");
        std::fs::create_dir_all(car.root.join("TeslaCam/RecentClips")).unwrap();
        std::fs::write(car.root.join("TeslaCam/RecentClips/a-front.mp4"), b"x").unwrap();
        std::os::unix::fs::symlink("/etc", car.root.join("etc-link")).unwrap();
        std::fs::create_dir_all(car.root.join(".sentry-recycle-bin")).unwrap();
        std::fs::write(car.root.join(".sentry-recycle-bin/b.mp4"), b"x").unwrap();
        let g = readable(&*car.ctx);
        let a = format!("{}/TeslaCam/RecentClips/a-front.mp4", car.root.display());
        assert!(g.resolve(&a).is_some());
        assert!(g.resolve(&format!("{}/TeslaCam/../TeslaCam/RecentClips/a-front.mp4", car.root.display())).is_some());
        assert!(g.resolve(&format!("{}/etc-link/passwd", car.root.display())).is_none(), "a link out of the share");
        assert!(g.resolve("/etc/passwd").is_none());
        assert!(g.resolve("relative").is_none());
        assert!(g.resolve(&format!("{}/missing.mp4", car.root.display())).is_none());
        assert!(g.resolve(&format!("{}/x", car.data.display())).is_none(), "the data folder only through its own roots");
        assert_eq!(exists_route(&*car.ctx, &json!({ "path": a })), json!(true));
        assert_eq!(exists_route(&*car.ctx, &json!({ "path": format!("{}/.sentry-recycle-bin/b.mp4", car.root.display()) })), json!(false));
        let list = read_dir_route(&*car.ctx, &json!({ "path": car.root.to_string_lossy() })).unwrap();
        let names: Vec<&str> = list.as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"TeslaCam") && !names.contains(&"etc-link") && !names.contains(&".sentry-recycle-bin"));
        assert_eq!(read_dir_route(&*car.ctx, &json!({ "path": "/etc" })).unwrap_err().0, 403);
        assert_eq!(read_file_route(&*car.ctx, &json!({ "path": a })).unwrap(), json!({ "text": "x" }));
        assert_eq!(stat_route(&*car.ctx, &json!({ "path": a }))["size"], json!(1));
        assert_eq!(stat_route(&*car.ctx, &json!({ "path": "/etc/passwd" })), Value::Null);
    }

    #[test]
    fn studio_settings_and_the_clock() {
        let car = Car::new("studio-settings");
        let ctx = &*car.ctx;
        assert_eq!(settings(ctx), json!({ "timeFormat": "12h" }));
        assert_eq!(set_setting(ctx, &json!({ "key": "timeFormat", "value": "24h" })).unwrap(), json!({ "ok": true }));
        assert_eq!(ctx.setting("appearance"), Some(json!({ "reduceEffects": false, "clock24": true })));
        set_setting(ctx, &json!({ "key": "speedUnit", "value": "kmh" })).unwrap();
        assert_eq!(settings(ctx), json!({ "speedUnit": "kmh", "timeFormat": "24h" }));
        assert_eq!(set_setting(ctx, &json!({ "key": 3 })).unwrap_err(), (400, "Invalid setting".to_string()));
        assert_eq!(set_setting(ctx, &json!({ "key": "x".repeat(101) })).unwrap_err().0, 400);
    }

    #[test]
    fn browse_the_roots() {
        let car = Car::new("browse");
        std::fs::create_dir_all(car.root.join("TeslaCam/.hidden")).unwrap();
        std::fs::create_dir_all(car.data.join("converted")).unwrap();
        let top = browse(&*car.ctx, &json!({})).unwrap();
        assert_eq!(top["entries"][0]["name"], json!("Car"));
        assert_eq!(top["entries"][1]["name"], json!("Converted copies"));
        let at = browse(&*car.ctx, &json!({ "path": car.root.to_string_lossy() })).unwrap();
        assert_eq!(at["parent"], Value::Null);
        assert_eq!(at["entries"].as_array().unwrap().len(), 1);
        let down = browse(&*car.ctx, &json!({ "path": car.root.join("TeslaCam").to_string_lossy() })).unwrap();
        assert_eq!(down["parent"], json!(std::fs::canonicalize(&car.root).unwrap().to_string_lossy()));
        assert!(down["entries"].as_array().unwrap().is_empty(), "dot folders left out");
    }
}
