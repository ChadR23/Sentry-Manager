//! The speed index (a port of server/speedIndex.js): every front-camera
//! clip's speed, one value a second, kept under DATA_PATH/speeds in the Node
//! server's own files, so either server reads what the other wrote:
//!   speeds/<vehicleId>/<YYYY-MM-DD>.json  { rel: [size, mtimeMs, speeds | null, summary | null] }
//!
//! It fills in the background, newest days first. How many clips it reads at
//! once is the pace's (pace.rs), each from another day while it can. A clip
//! is read in short reads or a few long ones (speed_reader.rs), whichever has
//! been faster here; the full telemetry read is the fallback. A clip is read
//! again only when its size or time changes. The summary is what Find
//! moments and the place search read (speeds.rs summarize).

use super::ctx::{Ctx, Files};
use super::js::{self, locale_cmp, num, r2, r5};
use super::pace::Pace;
use super::speed_entry::{self as entry, Entries, Entry};
use super::speed_reader::{self, Mode};
use crate::footage::{is_day_shape, Kind};
use crate::sei::Sample;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub(super) const BRAKE: f64 = 3.9;
pub(super) const SWERVE: f64 = 4.0;
const SUMMARY_VERSION: f64 = 2.0;
const DAYS_KEPT: usize = 400;
const GEO_MAX: usize = 3_000_000;

type Day = Arc<Mutex<Entries>>;

/// A summary of an older version needs the clip read again only if its speeds have a slowing second.
pub(super) fn can_brake(sp: &Value) -> bool {
    let Some(a) = sp.as_array() else { return false };
    (0..a.len()).any(|i| match (a[i].as_f64(), a.get(i + 1).and_then(Value::as_f64)) {
        (Some(x), Some(y)) => (x - y).abs() >= 0.29,
        _ => false,
    })
}

/// Metres between two points (haversine).
pub fn metres(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let rad = std::f64::consts::PI / 180.0;
    let a = (((lat2 - lat1) * rad) / 2.0).sin().powi(2) + (lat1 * rad).cos() * (lat2 * rad).cos() * (((lon2 - lon1) * rad) / 2.0).sin().powi(2);
    2.0 * 6371000.0 * a.sqrt().min(1.0).asin()
}

/// One clip's numbers (statsOf): seconds with a speed, metres, seconds moving, top speed,
/// first and last second moving, first and last position, hard braking and swerve.
#[derive(Debug, Clone, PartialEq)]
pub struct Stats {
    pub n: u32,
    pub d: f64,
    pub m: u32,
    pub v: f64,
    pub f: i64,
    pub l: i64,
    pub a: Option<(f64, f64)>,
    pub z: Option<(f64, f64)>,
    pub b: u32,
    pub t: u32,
}

pub fn stats_of(speeds: &Value, sum: &Value) -> Option<Stats> {
    let sp = speeds.as_array()?;
    let (mut n, mut d, mut m, mut v, mut f, mut l) = (0u32, 0f64, 0u32, 0f64, -1i64, -1i64);
    for (i, x) in sp.iter().enumerate() {
        let Some(x) = x.as_f64().filter(|x| x.is_finite()) else { continue };
        n += 1;
        d += x;
        if x > 0.5 {
            m += 1;
            if f < 0 {
                f = i as i64;
            }
            l = i as i64;
        }
        if x > v {
            v = x;
        }
    }
    if n == 0 {
        return None;
    }
    let g = sum.get("g").and_then(Value::as_array).cloned().unwrap_or_default();
    let pos = |p: &Value| (js::number(p.get(1)), js::number(p.get(2)));
    let over = |key: &str, line: f64| sum.get(key).and_then(Value::as_array).and_then(|p| p.get(1)).and_then(Value::as_f64).is_some_and(|x| x >= line) as u32;
    Some(Stats { n, d: r2(d), m, v: r2(v), f, l, a: g.first().map(pos), z: g.last().map(pos), b: over("b", BRAKE), t: over("t", SWERVE) })
}

#[derive(Debug, Clone)]
pub struct Moment {
    pub kind: &'static str,
    pub rel: String,
    pub second: Value,
    pub value: f64,
}

#[derive(Debug, Clone)]
pub struct Hit {
    pub vid: String,
    pub day: String,
    pub rel: String,
    pub second: f64,
    pub metres: f64,
}

#[derive(Debug, Clone, Default)]
pub struct Progress {
    pub running: bool,
    pub done: usize,
    pub total: usize,
    pub day: Option<String>,
    pub finished_at: Option<f64>,
    pub last: usize,
}

struct Packed {
    stamp: String,
    rels: Vec<String>,
    at: Vec<usize>,
    bbox: Vec<f64>,
    pts: Vec<f32>,
}

#[derive(Default)]
struct Inner {
    days: HashMap<String, Day>,
    order: VecDeque<String>,
    dirty: Vec<String>,
    ver: HashMap<String, u64>,
    reading: HashMap<String, usize>,
    geo: HashMap<String, Arc<Packed>>,
    geo_order: VecDeque<String>,
    geo_points: usize,
    stats: HashMap<String, (String, Arc<HashMap<String, (f64, f64, Option<Stats>)>>)>,
    stats_order: VecDeque<String>,
}

struct Run {
    running: bool,
    again: bool,
}

pub struct SpeedIndex {
    dir: PathBuf,
    ctx: Arc<dyn Ctx>,
    pace: Arc<Pace>,
    pause_ms: u64,
    inner: Mutex<Inner>,
    flushing: Mutex<()>,
    progress: Mutex<Progress>,
    modes: Mutex<(Option<f64>, Option<f64>, u64)>,
    run: Mutex<Run>,
    ended: Condvar,
    stopped: AtomicBool,
    /// moved-file lookups: a day's rels by file name, until the day changes
    names: Mutex<HashMap<String, (u64, HashMap<String, Vec<String>>)>>,
    /// the telemetry limiter (telemetry.limit): full reads at once
    full_reads: Arc<super::telemetry_api::Limiter>,
}

fn key_of(vid: &str, day: &str) -> String {
    format!("{vid}/{day}")
}

fn name_of(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// The file of a clip as the scan saw it: (size, Math.round(mtimeMs))
fn now_of(files: Option<&Files>, rel: &str) -> Option<(f64, f64)> {
    files.and_then(|f| f.get(rel)).map(|f| (f.size as f64, js::js_round(f.mtime_ms)))
}

const GPS_EVERY: usize = 5;


/// A clip's summary from its seconds (speedIndex.js summarize).
pub fn summarize(samples: &[Option<Sample>]) -> Value {
    let mut b: Option<(usize, f64)> = None;
    let mut t: Option<(usize, f64)> = None;
    let mut v: Option<(usize, f64)> = None;
    let mut g = Vec::new();
    for s in 0..samples.len() {
        let Some(x) = samples[s] else { continue };
        if let Some(xv) = x.v {
            if v.map_or(true, |v| xv > v.1) {
                v = Some((s, r2(xv)));
            }
        }
        let n = samples.get(s + 1).copied().flatten();
        let p = if s > 0 { samples[s - 1] } else { None };
        let lost_next = match (x.v, n.and_then(|n| n.v)) {
            (Some(a), Some(c)) => a - c,
            _ => 0.0,
        };
        let lost_prev = match (x.v, p.and_then(|p| p.v)) {
            (Some(a), Some(c)) => c - a,
            _ => 0.0,
        };
        if x.v.is_some() && n.and_then(|n| n.v).is_some() && lost_next > 0.0 && b.map_or(true, |b| lost_next > b.1) {
            b = Some((s, r2(lost_next)));
        }
        let dec = match x.ax {
            Some(ax) if ax.is_finite() && ax < 0.0 => -ax,
            _ => 0.0,
        };
        if dec > 0.0 && (lost_next > 0.3 || lost_prev > 0.3) && lost_next.max(lost_prev) >= 0.4 * dec && b.map_or(true, |b| dec > b.1) {
            b = Some((s, r2(dec)));
        }
        if let Some(ay) = x.ay {
            if t.map_or(true, |t| ay.abs() > t.1) {
                t = Some((s, r2(ay.abs())));
            }
        }
        if let (Some(lat), Some(lon)) = (x.lat, x.lon) {
            if s % GPS_EVERY == 0 && (lat != 0.0 || lon != 0.0) && lat.abs() <= 90.0 && lon.abs() <= 180.0 {
                g.push(json!([s, num(r5(lat)), num(r5(lon))]));
            }
        }
    }
    let pair = |p: Option<(usize, f64)>| p.map(|(s, x)| json!([s, num(x)]));
    json!({ "b": pair(b), "t": pair(t), "v": pair(v), "g": g, "k": num(SUMMARY_VERSION) })
}

fn same(e: &Entry, f: Option<(f64, f64)>) -> bool {
    matches!(f, Some((s, m)) if e.num(0) == Some(s) && e.num(1) == Some(m))
}

/// speedsFor: the quick read, else the dashboard's full read (speeds only).
pub fn speeds_for(real: &Path, size: u64, mode: Mode, full: &super::telemetry_api::Limiter) -> (Value, Value) {
    match speed_reader::read_samples(real, mode) {
        Ok(None) => (Value::Null, Value::Null),
        Ok(Some(samples)) => {
            let speeds: Vec<Value> = samples.iter().map(|x| x.and_then(|x| x.v).map_or(Value::Null, |v| num(r2(v)))).collect();
            (Value::Array(speeds), summarize(&samples))
        }
        Err(err) => {
            let _slot = full.take();
            match crate::telemetry::read_records(real, size) {
                Ok(frames) => match crate::telemetry::speeds_of(&frames) {
                    Some(sp) => {
                        let samples: Vec<Option<Sample>> = sp.iter().map(|&v| Some(Sample { v, ..Sample::default() })).collect();
                        (Value::Array(sp.iter().map(|v| v.map_or(Value::Null, num)).collect()), summarize(&samples))
                    }
                    None => (Value::Null, Value::Null),
                },
                Err(_) => {
                    eprintln!("Speed index: no speeds in {} ({})", name_of(&real.to_string_lossy()), err);
                    (Value::Null, Value::Null)
                }
            }
        }
    }
}

struct Todo {
    vid: String,
    day: String,
    rel: String,
    size: u64,
    mtime: f64,
    root: PathBuf,
}

impl SpeedIndex {
    pub fn new(dir: PathBuf, ctx: Arc<dyn Ctx>, pace: Arc<Pace>, pause_ms: u64, full_reads: Arc<super::telemetry_api::Limiter>) -> Arc<SpeedIndex> {
        Arc::new(SpeedIndex {
            dir,
            ctx,
            pace,
            pause_ms,
            inner: Mutex::new(Inner::default()),
            flushing: Mutex::new(()),
            progress: Mutex::new(Progress::default()),
            modes: Mutex::new((None, None, 0)),
            run: Mutex::new(Run { running: false, again: false }),
            ended: Condvar::new(),
            stopped: AtomicBool::new(false),
            names: Mutex::new(HashMap::new()),
            full_reads,
        })
    }

    pub fn file_of(&self, vid: &str, day: &str) -> PathBuf {
        let safe: String = vid.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect();
        self.dir.join(safe).join(format!("{day}.json"))
    }

    fn touch(inner: &mut Inner, key: &str) {
        if !inner.dirty.iter().any(|k| k == key) {
            inner.dirty.push(key.to_string());
        }
        *inner.ver.entry(key.to_string()).or_default() += 1;
    }

    /// A day's data, read from its file the first time (one read at a time).
    fn load(&self, vid: &str, day: &str) -> Day {
        let key = key_of(vid, day);
        let mut inner = self.inner.lock().unwrap();
        if let Some(d) = inner.days.get(&key) {
            return d.clone();
        }
        let data = std::fs::read_to_string(self.file_of(vid, day)).ok().and_then(|t| entry::parse_day(&t));
        let d: Day = Arc::new(Mutex::new(data.unwrap_or_default()));
        inner.days.insert(key.clone(), d.clone());
        inner.order.push_back(key.clone());
        if inner.days.len() > DAYS_KEPT {
            let gone = inner.order.iter().position(|k| !inner.dirty.contains(k) && !inner.reading.contains_key(k) && *k != key);
            if let Some(i) = gone {
                let k = inner.order.remove(i).unwrap();
                inner.days.remove(&k);
            }
        }
        d
    }

    /// Write what changed (one flush at a time).
    pub fn flush(&self) {
        let _one = self.flushing.lock().unwrap();
        loop {
            let (key, data) = {
                let mut inner = self.inner.lock().unwrap();
                if inner.dirty.is_empty() {
                    return;
                }
                let key = inner.dirty.remove(0);
                let data = inner.days.get(&key).cloned();
                (key, data)
            };
            let Some(data) = data else { continue };
            let (vid, day) = key.split_once('/').unwrap();
            let file = self.file_of(vid, day);
            let value = entry::day_value(&data.lock().unwrap());
            let text = value.to_string();
            let _ = std::fs::create_dir_all(file.parent().unwrap());
            let tmp = PathBuf::from(format!("{}.{}.tmp", file.display(), std::process::id()));
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(&tmp, &file);
            }
        }
    }

    /// The front-camera clips to index, newest day first.
    fn fronts(&self, vid: &str) -> Vec<(String, String, u64, f64)> {
        let Some(files) = self.ctx.files(vid) else { return Vec::new() };
        let mut out: Vec<(String, String, u64, f64)> = files
            .values()
            .filter(|f| f.kind == Kind::Clip && f.camera.as_deref() == Some("front") && f.size > 0 && is_day_shape(&f.day))
            .map(|f| (f.day.clone(), f.rel.clone(), f.size, js::js_round(f.mtime_ms)))
            .collect();
        out.sort_by(|a, b| if a.0 == b.0 { locale_cmp(&b.1, &a.1) } else { locale_cmp(&b.0, &a.0) });
        out
    }

    /// The entry of the same file read under an older path (the folder set a level up or down), moved to rel.
    fn moved(&self, data: &mut Entries, key: &str, vid: &str, rel: &str, size: u64, mtime: f64, files: Option<&Files>) -> bool {
        let ver = self.inner.lock().unwrap().ver.get(key).copied().unwrap_or(0);
        let mut names = self.names.lock().unwrap();
        let fresh = names.get(key).is_some_and(|(v, _)| *v == ver);
        if !fresh {
            let mut m: HashMap<String, Vec<String>> = HashMap::new();
            for k in data.keys() {
                m.entry(name_of(k).to_string()).or_default().push(k.clone());
            }
            names.insert(key.to_string(), (ver, m));
        }
        let list = names.get(key).unwrap().1.get(name_of(rel)).cloned().unwrap_or_default();
        for k in list {
            let Some(e) = data.get(&k) else { continue };
            if k == rel || e.num(0) != Some(size as f64) || e.num(1) != Some(mtime) {
                continue;
            }
            if files.is_some_and(|f| f.contains_key(&k)) {
                continue;
            }
            if !(rel.ends_with(&format!("/{k}")) || k.ends_with(&format!("/{rel}"))) {
                continue;
            }
            let e = data.shift_remove(&k).unwrap();
            data.insert(rel.to_string(), e);
            let _ = vid;
            names.remove(key);
            return true;
        }
        false
    }

    fn pick_mode(&self) -> Mode {
        let mut m = self.modes.lock().unwrap();
        m.2 += 1;
        match (m.0, m.1) {
            (None, _) => Mode::Short,
            (_, None) => Mode::Straight,
            (Some(short), Some(straight)) => {
                let faster = if straight < short { Mode::Straight } else { Mode::Short };
                if m.2 % 40 == 0 {
                    if faster == Mode::Straight { Mode::Short } else { Mode::Straight }
                } else {
                    faster
                }
            }
        }
    }

    fn mode_done(&self, mode: Mode, ms: f64) {
        let mut m = self.modes.lock().unwrap();
        let slot = if mode == Mode::Short { &mut m.0 } else { &mut m.1 };
        *slot = Some(match *slot {
            None => ms,
            Some(x) => x * 0.8 + ms * 0.2,
        });
    }

    fn read_one(&self, c: &Todo) {
        let key = key_of(&c.vid, &c.day);
        let data = self.load(&c.vid, &c.day);
        let mode = self.pick_mode();
        let t0 = Instant::now();
        let (sp, sum) = speeds_for(&c.root.join(&c.rel), c.size, mode, &self.full_reads);
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        self.pace.done(ms);
        self.mode_done(mode, ms);
        // changed while it was read (converted, say): the next pass reads it again
        let files = self.ctx.files(&c.vid);
        if now_of(files.as_ref(), &c.rel) == Some((c.size as f64, c.mtime)) {
            data.lock().unwrap().insert(c.rel.clone(), Entry::from_value(json!([c.size, num(c.mtime), sp, sum])));
            let mut inner = self.inner.lock().unwrap();
            Self::touch(&mut inner, &key);
        }
        {
            let mut p = self.progress.lock().unwrap();
            p.done += 1;
            p.day = Some(c.day.clone());
        }
    }

    fn pass(&self) -> usize {
        let mut todo: Vec<Todo> = Vec::new();
        let (mut upgraded, mut relocated) = (0, 0);
        for v in self.ctx.vehicles() {
            let files = self.ctx.files(&v.id);
            for (day, rel, size, mtime) in self.fronts(&v.id) {
                let key = key_of(&v.id, &day);
                let data = self.load(&v.id, &day);
                let mut d = data.lock().unwrap();
                if !d.contains_key(&rel) && self.moved(&mut d, &key, &v.id, &rel, size, mtime, files.as_ref()) {
                    Self::touch(&mut self.inner.lock().unwrap(), &key);
                    relocated += 1;
                }
                if let Some(e) = d.get_mut(&rel).filter(|e| e.num(0) == Some(size as f64) && e.num(1) == Some(mtime) && e.complete()) {
                    if e.summary_is_null() || e.summary_version() == Some(SUMMARY_VERSION) {
                        continue;
                    }
                    if e.summary_is_object() && !e.can_brake() {
                        e.mark_version_2();
                        Self::touch(&mut self.inner.lock().unwrap(), &key);
                        upgraded += 1;
                        continue;
                    }
                }
                drop(d);
                todo.push(Todo { vid: v.id.clone(), day, rel, size, mtime, root: v.root.clone() });
            }
        }
        if upgraded > 0 || relocated > 0 {
            self.flush();
        }
        if relocated > 0 {
            eprintln!("Speed index: {relocated} clip(s) kept from before the footage folder moved");
        }
        if !todo.is_empty() {
            eprintln!("Speed index: {} clip(s) to read, newest days first{}", todo.len(), if upgraded > 0 { format!(" ({upgraded} kept as they were: no slowing second)") } else { String::new() });
        }
        let total = todo.len();
        {
            let mut p = self.progress.lock().unwrap();
            p.done = 0;
            p.total = total;
            p.day = None;
        }
        let started = Instant::now();
        // a queue per day, newest first; each reader takes the newest day no other is on
        let mut order: Vec<String> = Vec::new();
        let mut queues: HashMap<String, VecDeque<Todo>> = HashMap::new();
        for c in todo {
            let key = key_of(&c.vid, &c.day);
            if !queues.contains_key(&key) {
                order.push(key.clone());
            }
            queues.entry(key).or_default().push_back(c);
        }
        let mut left = total;
        let mut first = 0usize;
        let mut last_flush = 0usize;
        std::thread::scope(|scope| {
            let (tx, rx) = mpsc::channel::<()>();
            let mut in_flight = 0usize;
            let mut next = |queues: &mut HashMap<String, VecDeque<Todo>>| -> Option<Todo> {
                while first < order.len() && queues[&order[first]].is_empty() {
                    first += 1;
                }
                let reading = self.inner.lock().unwrap().reading.keys().cloned().collect::<HashSet<_>>();
                let mut pick: Option<&String> = None;
                for k in &order[first..] {
                    if queues[k].is_empty() {
                        continue;
                    }
                    if !reading.contains(k) {
                        pick = Some(k);
                        break;
                    }
                    pick = pick.or(Some(k));
                }
                let k = pick?.clone();
                queues.get_mut(&k).unwrap().pop_front()
            };
            while !self.stopped.load(Ordering::SeqCst) {
                self.pace.demand(in_flight, left > 0);
                let cap = self.pace.allowed() as usize;
                while in_flight < cap && left > 0 && !self.stopped.load(Ordering::SeqCst) {
                    let Some(c) = next(&mut queues) else { break };
                    left -= 1;
                    // (marked as being read before the next pick, as Node's read() does at once)
                    *self.inner.lock().unwrap().reading.entry(key_of(&c.vid, &c.day)).or_default() += 1;
                    let tx = tx.clone();
                    in_flight += 1;
                    scope.spawn(move || {
                        let key = key_of(&c.vid, &c.day);
                        self.read_one(&c);
                        {
                            let mut inner = self.inner.lock().unwrap();
                            let n = inner.reading.get(&key).copied().unwrap_or(1) - 1;
                            if n > 0 {
                                inner.reading.insert(key, n);
                            } else {
                                inner.reading.remove(&key);
                            }
                        }
                        let done = self.progress.lock().unwrap().done;
                        if done % 250 == 0 && done < total {
                            let min = js::js_round(started.elapsed().as_secs_f64() * 1000.0 / done as f64 * (total - done) as f64 / 60000.0);
                            eprintln!("Speed index: {done} of {total} clips (now on {}, about {min} min left, {} at a time)", c.day, self.pace.status().0);
                        }
                        let _ = tx.send(());
                    });
                    self.pace.demand(in_flight, left > 0);
                    if self.pause_ms > 0 {
                        std::thread::sleep(Duration::from_millis(self.pause_ms));
                    }
                    while rx.try_recv().is_ok() {
                        in_flight -= 1;
                        self.pace.demand(in_flight, left > 0);
                    }
                }
                if in_flight == 0 && left == 0 {
                    break;
                }
                let done = self.progress.lock().unwrap().done;
                if done - last_flush >= 100 {
                    last_flush = done;
                    self.flush();
                }
                let wait = if in_flight > 0 { 1000 } else { 2000 };
                if rx.recv_timeout(Duration::from_millis(wait)).is_ok() {
                    in_flight -= 1;
                    self.pace.demand(in_flight, left > 0);
                }
                while rx.try_recv().is_ok() {
                    in_flight -= 1;
                    self.pace.demand(in_flight, left > 0);
                }
            }
        });
        self.flush();
        self.progress.lock().unwrap().done
    }

    /// Index what is new; again after this pass if more changed meanwhile.
    pub fn kick(self: &Arc<Self>) {
        {
            let mut r = self.run.lock().unwrap();
            if r.running {
                r.again = true;
                return;
            }
            r.running = true;
            r.again = false;
        }
        self.progress.lock().unwrap().running = true;
        let me = self.clone();
        std::thread::Builder::new()
            .name("speed-index".into())
            .spawn(move || {
                loop {
                    me.run.lock().unwrap().again = false;
                    let n = me.pass();
                    if n > 0 {
                        eprintln!("Speed index: done, {n} clip(s) indexed");
                    }
                    me.progress.lock().unwrap().last = n;
                    let mut r = me.run.lock().unwrap();
                    if !(r.again && !me.stopped.load(Ordering::SeqCst)) {
                        r.running = false;
                        let mut p = me.progress.lock().unwrap();
                        p.running = false;
                        p.finished_at = Some(js::now_ms());
                        drop(p);
                        me.ended.notify_all();
                        return;
                    }
                }
            })
            .ok();
    }

    pub fn running(&self) -> bool {
        self.run.lock().unwrap().running
    }

    /// Wait until no pass runs (tests, shutdown).
    pub fn settled(&self) {
        let mut r = self.run.lock().unwrap();
        while r.running {
            r = self.ended.wait(r).unwrap();
        }
    }

    /// Stop: no new reads; returns once the reads in progress ended and all is written.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.settled();
        self.flush();
    }

    /// status(): the route's answer
    pub fn status(&self) -> Value {
        let p = self.progress.lock().unwrap().clone();
        let m = *self.modes.lock().unwrap();
        let read_mode = match (m.0, m.1) {
            (Some(short), Some(straight)) => json!(if straight < short { "straight" } else { "short" }),
            _ => Value::Null,
        };
        json!({ "running": p.running, "done": p.done, "total": p.total, "day": p.day, "finishedAt": p.finished_at.map(num), "last": p.last,
            "limit": self.pace.status().0, "readMode": read_mode })
    }

    /// A day's indexed speeds: [(rel, speeds | null)] for clips as they are now.
    pub fn day(&self, vid: &str, d: &str) -> Vec<(String, Value)> {
        if !is_day_shape(d) {
            return Vec::new();
        }
        let data = self.load(vid, d);
        let files = self.ctx.files(vid);
        let data = data.lock().unwrap();
        data.iter().filter(|(rel, e)| same(e, now_of(files.as_ref(), rel))).map(|(rel, e)| (rel.clone(), e.speeds())).collect()
    }

    /// A day's clip summaries (clips with one, as they are now).
    pub fn summaries(&self, vid: &str, d: &str) -> Vec<(String, Value)> {
        if !is_day_shape(d) {
            return Vec::new();
        }
        let data = self.load(vid, d);
        let files = self.ctx.files(vid);
        let data = data.lock().unwrap();
        data.iter()
            .filter(|(rel, e)| e.summary_truthy() && same(e, now_of(files.as_ref(), rel)))
            .map(|(rel, e)| (rel.clone(), e.summary()))
            .collect()
    }

    /// A day's moments: hard braking, swerves, and the three fastest clips' top speed; strongest first.
    pub fn moments(&self, vid: &str, d: &str) -> Vec<Moment> {
        let mut out = Vec::new();
        let mut fastest = Vec::new();
        for (rel, sum) in self.summaries(vid, d) {
            let pair = |k: &str| sum.get(k).and_then(Value::as_array).filter(|a| !a.is_empty()).map(|a| (a.first().cloned().unwrap_or(Value::Null), js::number(a.get(1))));
            if let Some((s, v)) = pair("b") {
                if v >= BRAKE {
                    out.push(Moment { kind: "brake", rel: rel.clone(), second: s, value: v });
                }
            }
            if let Some((s, v)) = pair("t") {
                if v >= SWERVE {
                    out.push(Moment { kind: "swerve", rel: rel.clone(), second: s, value: v });
                }
            }
            if let Some((s, v)) = pair("v") {
                if v > 0.0 {
                    fastest.push(Moment { kind: "speed", rel: rel.clone(), second: s, value: v });
                }
            }
        }
        let desc = |a: &Moment, b: &Moment| b.value.partial_cmp(&a.value).unwrap_or(std::cmp::Ordering::Equal);
        fastest.sort_by(desc);
        out.sort_by(desc);
        out.extend(fastest.into_iter().take(3));
        out
    }

    fn stamp_of(&self, key: &str, file: &Path) -> Option<(String, Option<Day>)> {
        let st = std::fs::metadata(file).ok();
        let (mem, ver) = {
            let inner = self.inner.lock().unwrap();
            (inner.days.get(key).cloned(), inner.ver.get(key).copied().unwrap_or(0))
        };
        if st.is_none() && mem.is_none() {
            return None;
        }
        let s = match &st {
            Some(m) => {
                use std::os::unix::fs::MetadataExt;
                let mt = crate::scanner::ms_of(m.mtime(), m.mtime_nsec());
                format!("{}/{}", m.len(), js::num(mt))
            }
            None => "-".into(),
        };
        Some((format!("{ver}|{s}"), mem))
    }

    fn data_of(mem: Option<Day>, file: &Path) -> Option<Day> {
        match mem {
            Some(d) => Some(d),
            None => std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).map(|v| match v {
                Value::Object(o) => Arc::new(Mutex::new(o.into_iter().map(|(k, v)| (k, Entry::from_value(v))).collect())),
                _ => Day::default(),
            }),
        }
    }

    fn pack(data: &Entries) -> (Vec<String>, Vec<usize>, Vec<f64>, Vec<f32>) {
        let (mut rels, mut at, mut bbox, mut pts) = (Vec::new(), vec![0usize], Vec::new(), Vec::new());
        for (rel, e) in data {
            let g = e.positions();
            if g.is_empty() {
                continue;
            }
            let (mut a0, mut a1, mut o0, mut o1) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
            for &[sec, a, o] in g.iter() {
                pts.extend([sec as f32, a as f32, o as f32]);
                a0 = a0.min(a);
                a1 = a1.max(a);
                o0 = o0.min(o);
                o1 = o1.max(o);
            }
            rels.push(rel.clone());
            at.push(pts.len() / 3);
            bbox.extend([a0, a1, o0, o1]);
        }
        (rels, at, bbox, pts)
    }

    fn geo_of(&self, vid: &str, d: &str, file: &Path) -> Option<Arc<Packed>> {
        let key = key_of(vid, d);
        let (stamp, mem) = self.stamp_of(&key, file)?;
        {
            let mut inner = self.inner.lock().unwrap();
            if let Some(had) = inner.geo.get(&key).cloned() {
                if had.stamp == stamp {
                    inner.geo_order.retain(|k| *k != key);
                    inner.geo_order.push_back(key);
                    return Some(had);
                }
            }
        }
        let data = Self::data_of(mem, file)?;
        let (rels, at, bbox, pts) = Self::pack(&data.lock().unwrap());
        let packed = Arc::new(Packed { stamp, rels, at, bbox, pts });
        let mut inner = self.inner.lock().unwrap();
        if let Some(had) = inner.geo.remove(&key) {
            inner.geo_points -= had.pts.len() / 3;
            inner.geo_order.retain(|k| *k != key);
        }
        inner.geo_points += packed.pts.len() / 3;
        inner.geo.insert(key.clone(), packed.clone());
        inner.geo_order.push_back(key.clone());
        while inner.geo_points > GEO_MAX {
            let Some(k) = inner.geo_order.front().cloned() else { break };
            if k == key {
                break;
            }
            inner.geo_order.pop_front();
            if let Some(v) = inner.geo.remove(&k) {
                inner.geo_points -= v.pts.len() / 3;
            }
        }
        Some(packed)
    }

    fn day_names(&self, vid: &str) -> Option<(PathBuf, Vec<String>)> {
        let folder = self.file_of(vid, "2000-01-01").parent().unwrap().to_path_buf();
        let mut names: Vec<String> = std::fs::read_dir(&folder).ok()?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".json") && is_day_shape(&n[..n.len() - 5])).collect();
        names.sort();
        names.reverse();
        Some((folder, names))
    }

    /// Clips that passed within `radius` metres of a place, newest first, at most `limit`.
    pub fn near(&self, vids: &[String], lat: f64, lon: f64, radius: f64, limit: usize) -> Vec<Hit> {
        let mut hits: Vec<Hit> = Vec::new();
        let d_lat = (radius / 111320.0) * 1.05 + 1e-4;
        let d_lon = (radius / (111320.0 * (lat * std::f64::consts::PI / 180.0).cos().max(0.01))) * 1.05 + 1e-4;
        for vid in vids {
            let Some((folder, names)) = self.day_names(vid) else { continue };
            for name in names {
                let d = &name[..name.len() - 5];
                let Some(p) = self.geo_of(vid, d, &folder.join(&name)) else { continue };
                for i in 0..p.rels.len() {
                    if p.bbox[4 * i + 1] < lat - d_lat || p.bbox[4 * i] > lat + d_lat || p.bbox[4 * i + 3] < lon - d_lon || p.bbox[4 * i + 2] > lon + d_lon {
                        continue;
                    }
                    let mut best: Option<(f64, f64)> = None;
                    for j in p.at[i]..p.at[i + 1] {
                        let a = p.pts[3 * j + 1] as f64;
                        let o = p.pts[3 * j + 2] as f64;
                        if (a - lat).abs() > d_lat || (o - lon).abs() > d_lon {
                            continue;
                        }
                        let m = metres(lat, lon, a, o);
                        if m <= radius && best.map_or(true, |b| m < b.1) {
                            best = Some((p.pts[3 * j] as f64, js::js_round(m)));
                        }
                    }
                    if let Some((second, m)) = best {
                        hits.push(Hit { vid: vid.clone(), day: d.to_string(), rel: p.rels[i].clone(), second, metres: m });
                    }
                }
                if hits.len() >= limit * 2 {
                    break;
                }
            }
        }
        hits.sort_by(|a, b| if a.day == b.day { locale_cmp(&b.rel, &a.rel) } else { locale_cmp(&b.day, &a.day) });
        hits.truncate(limit);
        hits
    }

    /// Read every indexed day into the place search's cache, newest first, a day at a time.
    pub fn warm(&self, vids: &[String], pause_ms: u64) {
        for vid in vids {
            let Some((folder, names)) = self.day_names(vid) else { continue };
            for name in names {
                if self.stopped.load(Ordering::SeqCst) || self.inner.lock().unwrap().geo_points >= GEO_MAX {
                    return;
                }
                while self.ctx.busy() && !self.stopped.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_secs(2));
                }
                self.geo_of(vid, &name[..name.len() - 5], &folder.join(&name));
                if pause_ms > 0 {
                    std::thread::sleep(Duration::from_millis(pause_ms));
                }
            }
        }
    }

    /// A day's clips in numbers (clips with speeds, as they are now).
    pub fn clip_stats(&self, vid: &str, d: &str) -> HashMap<String, Stats> {
        if !is_day_shape(d) {
            return HashMap::new();
        }
        let key = key_of(vid, d);
        let file = self.file_of(vid, d);
        let Some((stamp, mem)) = self.stamp_of(&key, &file) else { return HashMap::new() };
        let cached = self.inner.lock().unwrap().stats.get(&key).filter(|(s, _)| *s == stamp).map(|(_, p)| p.clone());
        let per = match cached {
            Some(p) => p,
            None => {
                let data = Self::data_of(mem, &file).unwrap_or_default();
                let mut per = HashMap::new();
                for (rel, e) in data.lock().unwrap().iter() {
                    if let Entry::Raw(v) = e {
                        let Some(a) = v.as_array() else { continue };
                        let st = stats_of(a.get(2).unwrap_or(&Value::Null), a.get(3).unwrap_or(&Value::Null));
                        per.insert(rel.clone(), (js::number(a.first()), js::number(a.get(1)), st));
                    } else {
                        per.insert(rel.clone(), (e.num(0).unwrap_or(f64::NAN), e.num(1).unwrap_or(f64::NAN), e.stats()));
                    }
                }
                Arc::new(per)
            }
        };
        {
            let mut inner = self.inner.lock().unwrap();
            inner.stats.insert(key.clone(), (stamp, per.clone()));
            inner.stats_order.retain(|k| *k != key);
            inner.stats_order.push_back(key);
            if inner.stats.len() > 2000 {
                if let Some(k) = inner.stats_order.pop_front() {
                    inner.stats.remove(&k);
                }
            }
        }
        let files = self.ctx.files(vid);
        per.iter().filter_map(|(rel, (s, m, st))| (st.is_some() && now_of(files.as_ref(), rel) == Some((*s, *m))).then(|| (rel.clone(), st.clone().unwrap()))).collect()
    }

    /// The clips of a day read as they are now, with or without driving data.
    pub fn clips_read(&self, vid: &str, d: &str) -> HashSet<String> {
        if !is_day_shape(d) {
            return HashSet::new();
        }
        let data = self.load(vid, d);
        let files = self.ctx.files(vid);
        let data = data.lock().unwrap();
        data.iter().filter(|(rel, e)| e.complete() && same(e, now_of(files.as_ref(), rel))).map(|(r, _)| r.clone()).collect()
    }

    /// How far each day is indexed: { day: (clips, indexed) } (front-camera clips).
    pub fn progress(&self, vid: &str, list: &[String]) -> HashMap<String, (u64, u64)> {
        let Some(files) = self.ctx.files(vid) else { return HashMap::new() };
        let mut per: HashMap<String, Vec<(String, f64, f64)>> = HashMap::new();
        for f in files.values() {
            if f.kind != Kind::Clip || f.camera.as_deref() != Some("front") || f.size == 0 || !list.contains(&f.day) {
                continue;
            }
            per.entry(f.day.clone()).or_default().push((f.rel.clone(), f.size as f64, js::js_round(f.mtime_ms)));
        }
        let mut out = HashMap::new();
        for (d, fs) in per {
            let data = self.load(vid, &d);
            let data = data.lock().unwrap();
            let indexed = fs.iter().filter(|(rel, s, m)| data.get(rel).is_some_and(|e| e.num(0) == Some(*s) && e.num(1) == Some(*m) && e.complete())).count();
            out.insert(d, (fs.len() as u64, indexed as u64));
        }
        out
    }

    /// Index one clip now (the viewer asked before the background got there): its speeds.
    pub fn clip(&self, vid: Option<&str>, rel: Option<&str>, real: &Path, size: u64, mtime_ms: f64) -> Value {
        let files = vid.and_then(|v| self.ctx.files(v));
        let f = rel.and_then(|r| files.as_ref().and_then(|fs| fs.get(r)).cloned());
        let (sp, sum) = speeds_for(real, size, Mode::Short, &self.full_reads);
        let (Some(vid), Some(rel)) = (vid, rel) else { return sp };
        let now = self.ctx.files(vid);
        let same = now_of(now.as_ref(), rel) == Some((size as f64, js::js_round(mtime_ms)));
        if let Some(f) = f.filter(|f| same && is_day_shape(&f.day) && f.camera.as_deref() == Some("front")) {
            let data = self.load(vid, &f.day);
            data.lock().unwrap().insert(rel.to_string(), Entry::from_value(json!([size, num(js::js_round(mtime_ms)), sp.clone(), sum])));
            Self::touch(&mut self.inner.lock().unwrap(), &key_of(vid, &f.day));
            if !self.running() {
                self.flush();
            }
        }
        sp
    }
}

#[cfg(test)]
#[path = "speed_index_tests.rs"]
mod tests;
