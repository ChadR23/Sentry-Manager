//! The footage check (a port of server/integrity.js): clips that will not
//! play: empty files, files that are not MP4, clips cut off part way (no
//! `moov` index, or data running past the end). Only box headers are read.
//! Results per vehicle in <data>/integrity/<vehicle>.json ({ rel: [size,
//! mtimeMs, problem | null] }), so a check a restart cut short goes on where
//! it was, and unchanged files are not read again.

use super::scanner::FileEntry;
use crate::app::App;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const CONCURRENCY: usize = 4;

/// What is wrong with an MP4 file (None: nothing found). A file that cannot be read
/// is an error: that says nothing about the clip.
pub fn check_file(file: &Path) -> std::io::Result<Option<&'static str>> {
    let mut fh = std::fs::File::open(file)?;
    let size = fh.metadata()?.len();
    if size == 0 {
        return Ok(Some("empty file"));
    }
    let mut head = [0u8; 16];
    let (mut pos, mut first, mut moov, mut boxes) = (0u64, true, false, 0);
    while pos < size {
        if size - pos < 8 {
            return Ok(Some(if first { "not an MP4 file" } else { "cut off: the file ends part way through" }));
        }
        fh.seek(SeekFrom::Start(pos))?;
        let mut got = 0;
        while got < 16 {
            let n = fh.read(&mut head[got..])?;
            if n == 0 {
                break;
            }
            got += n;
        }
        if got < 8 {
            return Ok(Some("cut off: the file ends part way through"));
        }
        let mut len = u32::from_be_bytes(head[0..4].try_into().unwrap()) as u64;
        let typ = &head[4..8];
        if !typ.iter().all(|c| (0x20..=0x7e).contains(c)) {
            return Ok(Some(if first { "not an MP4 file" } else { "damaged: unreadable data in the file" }));
        }
        if first && typ != b"ftyp" {
            return Ok(Some("not an MP4 file"));
        }
        first = false;
        if len == 1 {
            if got < 16 {
                return Ok(Some("cut off: the file ends part way through"));
            }
            len = u64::from_be_bytes(head[8..16].try_into().unwrap());
        } else if len == 0 {
            len = size - pos;
        }
        if len < 8 {
            return Ok(Some("damaged: unreadable data in the file"));
        }
        if pos.saturating_add(len) > size {
            return Ok(Some(if typ == b"mdat" && !moov { "cut off while recording (no index): it will not play" } else { "cut off: the file ends part way through" }));
        }
        if typ == b"moov" {
            moov = true;
        }
        pos += len;
        boxes += 1;
        if boxes > 10000 {
            break;
        }
    }
    Ok(if moov { None } else { Some("no index (moov): it will not play") })
}

#[derive(Default)]
struct Run {
    running: bool,
    done: Arc<AtomicUsize>,
    total: usize,
    started_at: f64,
    finished_at: Option<f64>,
}

/// The checks of every vehicle: the loaded results and the runs.
#[derive(Default)]
pub struct Runs {
    loaded: Mutex<HashMap<String, Arc<Mutex<Map<String, Value>>>>>,
    runs: Mutex<HashMap<String, Run>>,
}

fn file_of(dir: &Path, vid: &str) -> PathBuf {
    let safe: String = vid.chars().map(|c| if c.is_alphanumeric() && c.is_ascii() || c == '_' || c == '-' { c } else { '_' }).collect();
    dir.join(format!("{safe}.json"))
}

fn dir_of(app: &App) -> PathBuf {
    app.core.data_dir().join("integrity")
}

fn load(app: &App, vid: &str) -> Arc<Mutex<Map<String, Value>>> {
    let runs = &app.footage.integrity;
    let mut loaded = runs.loaded.lock().unwrap();
    loaded
        .entry(vid.to_string())
        .or_insert_with(|| {
            let data = std::fs::read_to_string(file_of(&dir_of(app), vid)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default();
            Arc::new(Mutex::new(data))
        })
        .clone()
}

fn save(app: &App, vid: &str, data: &Map<String, Value>) {
    let dir = dir_of(app);
    let _ = std::fs::create_dir_all(&dir);
    let file = file_of(&dir, vid);
    let tmp = PathBuf::from(format!("{}.{}.tmp", file.display(), std::process::id()));
    if std::fs::write(&tmp, Value::Object(data.clone()).to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, &file);
    }
}

fn clips_of(app: &App, vid: &str) -> Vec<FileEntry> {
    app.state_of(vid).map(|s| s.file_list.iter().filter(|f| f.kind == super::Kind::Clip && f.rel.to_lowercase().ends_with(".mp4")).cloned().collect()).unwrap_or_default()
}

fn fresh(had: Option<&Value>, f: &FileEntry) -> bool {
    had.and_then(Value::as_array).is_some_and(|h| h.first().and_then(Value::as_f64) == Some(f.size as f64) && h.get(1).and_then(Value::as_f64) == Some(crate::sei::js_round(f.mtime_ms)))
}

fn mark(app: &App, vid: &str, on: bool) {
    app.core.db().set(&format!("integrity-running:{vid}"), &json!(on));
}

/// Check what is new or changed; one run per vehicle at a time. The status.
pub fn start(app: &Arc<App>, vid: &str) -> Value {
    {
        let mut runs = app.footage.integrity.runs.lock().unwrap();
        if runs.get(vid).is_some_and(|r| r.running) {
            drop(runs);
            return status(app, vid);
        }
        runs.insert(vid.to_string(), Run { running: true, started_at: super::js::now().trunc(), ..Default::default() });
    }
    // a check a restart cuts short is started again (resume), and goes on where it was
    mark(app, vid, true);
    let a = app.clone();
    let id = vid.to_string();
    std::thread::spawn(move || {
        run(&a, &id);
        if let Some(r) = a.footage.integrity.runs.lock().unwrap().get_mut(&id) {
            r.running = false;
            r.finished_at = Some(super::js::now().trunc());
        }
    });
    status(app, vid)
}

fn run(app: &App, vid: &str) {
    let data = load(app, vid);
    let Some(v) = app.vehicle(vid) else { return };
    let todo: Vec<FileEntry> = {
        let d = data.lock().unwrap();
        clips_of(app, vid).into_iter().filter(|f| !fresh(d.get(&f.rel), f)).collect()
    };
    let done = {
        let mut runs = app.footage.integrity.runs.lock().unwrap();
        let r = runs.get_mut(vid).unwrap();
        r.total = todo.len();
        r.done.clone()
    };
    let next = AtomicUsize::new(0);
    let unreadable = AtomicUsize::new(0);
    let since_save = AtomicUsize::new(0);
    std::thread::scope(|s| {
        for _ in 0..CONCURRENCY {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::SeqCst);
                let Some(f) = todo.get(i) else { return };
                let res = check_file(&v.root.join(&f.rel));
                {
                    let mut d = data.lock().unwrap();
                    match res {
                        Ok(problem) => {
                            d.insert(f.rel.clone(), json!([f.size, super::js::num(crate::sei::js_round(f.mtime_ms)), problem]));
                        }
                        Err(_) => {
                            // read again next time
                            d.shift_remove(&f.rel);
                            unreadable.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                }
                done.fetch_add(1, Ordering::SeqCst);
                if since_save.fetch_add(1, Ordering::SeqCst) + 1 >= 200 {
                    since_save.store(0, Ordering::SeqCst);
                    let snapshot = data.lock().unwrap().clone();
                    save(app, vid, &snapshot);
                }
            });
        }
    });
    // files that are gone are forgotten
    let present: std::collections::HashSet<String> = clips_of(app, vid).into_iter().map(|f| f.rel).collect();
    let snapshot = {
        let mut d = data.lock().unwrap();
        d.retain(|rel, _| present.contains(rel));
        d.clone()
    };
    save(app, vid, &snapshot);
    let bad = snapshot.values().filter(|x| x.get(2).is_some_and(|p| super::js::truthy(Some(p)))).count();
    let u = unreadable.load(Ordering::SeqCst);
    app.core.log("integrity", super::ctx::Level::Info, &format!("Footage check of {vid}: {} file(s) read, {bad} that will not play{}", todo.len(),
        if u > 0 { format!(", {u} that could not be read now (checked again next time)") } else { String::new() }));
    mark(app, vid, false);
}

pub fn status(app: &App, vid: &str) -> Value {
    let runs = app.footage.integrity.runs.lock().unwrap();
    match runs.get(vid) {
        Some(r) => json!({ "running": r.running, "done": r.done.load(Ordering::SeqCst), "total": r.total, "startedAt": r.started_at as i64, "finishedAt": r.finished_at.map(|t| t as i64) }),
        None => json!({ "running": false, "done": 0, "total": 0 }),
    }
}

/// The clips found broken (still the same file), with how many were checked.
pub fn results(app: &App, vid: &str) -> Value {
    let data = load(app, vid);
    let scanned = app.state_of(vid).is_some_and(|s| s.scanned);
    let clips = clips_of(app, vid);
    let mut problems: Vec<Value> = Vec::new();
    let mut checked = 0;
    {
        let d = data.lock().unwrap();
        for f in &clips {
            let had = d.get(&f.rel);
            if !fresh(had, f) {
                continue;
            }
            checked += 1;
            if let Some(p) = had.and_then(|h| h.get(2)).filter(|p| super::js::truthy(Some(p))) {
                problems.push(json!({ "rel": f.rel, "day": if f.day.is_empty() { Value::Null } else { json!(f.day) }, "camera": f.camera, "size": f.size, "problem": p }));
            }
        }
    }
    problems.sort_by(|a, b| b["rel"].as_str().cmp(&a["rel"].as_str()));
    let more = problems.len().saturating_sub(500);
    problems.truncate(500);
    let mut out = json!({ "checked": checked, "files": if scanned { clips.len() } else { 0 }, "problems": problems, "more": more });
    if let (Value::Object(o), Value::Object(s)) = (&mut out, status(app, vid)) {
        o.extend(s);
    }
    out
}

/// After a scan: a check that was running when the server stopped goes on.
pub fn resume(app: &Arc<App>, vid: &str) {
    let marked = app.core.db().get(&format!("integrity-running:{vid}")) == Some(Value::Bool(true));
    let running = app.footage.integrity.runs.lock().unwrap().get(vid).is_some_and(|r| r.running);
    if marked && !running && app.state_of(vid).is_some_and(|s| s.scanned) {
        app.core.log("integrity", super::ctx::Level::Info, &format!("Footage check of {vid}: going on after the restart"));
        start(app, vid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mp4box(t: &[u8; 4], body: usize) -> Vec<u8> {
        let mut b = ((body + 8) as u32).to_be_bytes().to_vec();
        b.extend_from_slice(t);
        b.resize(body + 8, 0);
        b
    }

    #[test]
    fn broken_clips_told_apart() {
        let dir = std::env::temp_dir().join(format!("lean-integrity-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = |name: &str, data: &[u8]| {
            let p = dir.join(name);
            std::fs::write(&p, data).unwrap();
            check_file(&p).unwrap()
        };
        let good = [mp4box(b"ftyp", 16), mp4box(b"moov", 40), mp4box(b"mdat", 100)].concat();
        assert_eq!(file("good.mp4", &good), None);
        // moov at the end, cut off before it (the car lost power)
        let at_end = [mp4box(b"ftyp", 16), mp4box(b"mdat", 100), mp4box(b"moov", 40)].concat();
        assert_eq!(file("cut.mp4", &at_end[..60]), Some("cut off while recording (no index): it will not play"));
        assert_eq!(file("cut2.mp4", &good[..good.len() - 10]), Some("cut off: the file ends part way through"));
        assert_eq!(file("nomoov.mp4", &[mp4box(b"ftyp", 16), mp4box(b"mdat", 10)].concat()), Some("no index (moov): it will not play"));
        assert_eq!(file("empty.mp4", b""), Some("empty file"));
        assert_eq!(file("text.mp4", b"this is not a video at all, just text"), Some("not an MP4 file"));
        assert_eq!(file("junk.mp4", &[mp4box(b"ftyp", 16), vec![0, 0, 0, 9, 1, 2, 3, 4, 5]].concat()), Some("damaged: unreadable data in the file"));
        assert!(check_file(&dir.join("gone.mp4")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
