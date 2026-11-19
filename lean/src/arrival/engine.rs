//! server/arrivalChecksums.js: the checksum of every clip that reaches a
//! Sentry USB share, in the share's record (record.rs), so the Pi verifies
//! each upload from Manager's line and never reads it back.
//!
//! Only shares whose root has a `.sentryusb/` folder. Tesla clips in
//! RecentClips / SentryClips / SavedClips / TeslaTrackMode from the
//! inventory's last scan, newest first: the recent window (fresh arrivals of
//! the last 48 h first) for every car, then the older backlog. Skipped: clips
//! Sentry USB still copies (holds), clips a conversion has in hand, clips
//! modified in the last minute, unchanged ones, our own conversions'
//! output and any other H.265 / AV1 clip. One file at a time, at most
//! `rate` bytes a second, paused while not idle, at most `per_cycle` clips
//! a pass; the identity is checked again after hashing.

use super::ctx::{ArrivalCtx, Car};
use super::index::{Entry, Files, Index, Op};
use super::js::{self, num};
use super::record::RecordSink;
use indexmap::IndexMap;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub const WINDOW_DAYS: f64 = 7.0;
pub const FRESH_MS: f64 = 48.0 * 3_600_000.0;
pub const PER_CYCLE: usize = 300;
/// bytes a second
pub const RATE: f64 = 64.0 * 1024.0 * 1024.0;
pub const CHUNK: usize = 1024 * 1024;
pub const SETTLE_MS: f64 = 60_000.0;
pub const TIMER_MS: u64 = 10 * 60_000;
/// when a pass stopped at PER_CYCLE
pub const NEXT_CYCLE_MS: u64 = 30_000;
pub const SAVE_EVERY: usize = 25;
pub const COMPACT_MIN: usize = 2000;
pub const DAY_MS: f64 = 86_400_000.0;
pub const SENTRY_USB_DIR: &str = ".sentryusb";

pub type CodecOf = Box<dyn Fn(&Path) -> Result<Option<String>, String> + Send + Sync>;

/// createArrivalChecksums' options (Node's defaults in `Options::new`).
pub struct Options {
    /// `<DATA>/arrival-checksums`
    pub dir: PathBuf,
    pub window_days: f64,
    pub fresh_ms: f64,
    pub per_cycle: usize,
    pub rate: f64,
    pub settle_ms: f64,
    pub timer_ms: u64,
    pub next_cycle_ms: u64,
    pub idle_wait_ms: u64,
    pub save_every: usize,
    pub compact_min: usize,
    pub now: Box<dyn Fn() -> f64 + Send + Sync>,
    /// videoCodec (mp4codec.js)
    pub codec_of: CodecOf,
}

impl Options {
    pub fn new(dir: impl Into<PathBuf>) -> Options {
        Options {
            dir: dir.into(),
            window_days: WINDOW_DAYS,
            fresh_ms: FRESH_MS,
            per_cycle: PER_CYCLE,
            rate: RATE,
            settle_ms: SETTLE_MS,
            timer_ms: TIMER_MS,
            next_cycle_ms: NEXT_CYCLE_MS,
            idle_wait_ms: 2000,
            save_every: SAVE_EVERY,
            compact_min: COMPACT_MIN,
            now: Box::new(js::now_ms),
            codec_of: Box::new(|p| crate::mp4::video_codec(p).map_err(|e| e.to_string())),
        }
    }
}

/// clips of the backlog: { total, left, bytesLeft, failed }
#[derive(Clone, Debug, Default)]
struct Backlog {
    total: u64,
    left: u64,
    bytes_left: f64,
    failed: u64,
}

#[derive(Default)]
struct State {
    indexes: HashMap<String, Index>,
    pending_ops: IndexMap<String, Vec<Op>>,
    enabled: HashMap<String, bool>,
    pending_of: HashMap<String, u64>,
    backlogs: HashMap<String, Backlog>,
    /// share root -> (at, yes)
    roots: HashMap<String, (f64, bool)>,
    hashed_bytes: u64,
    hashed_ms: f64,
}

struct Cand {
    rel: String,
    abs: String,
    size: u64,
    mtime_ms: f64,
    t: f64,
    recent: f64,
    fresh: bool,
}

struct Timers {
    started: bool,
    soon: u64,
}

struct Inner {
    ctx: Arc<dyn ArrivalCtx>,
    record: Arc<dyn RecordSink>,
    o: Options,
    files: Files,
    st: Mutex<State>,
    running: Mutex<bool>,
    done: Condvar,
    again: AtomicBool,
    stopped: AtomicBool,
    timers: Mutex<Timers>,
    tick: Condvar,
    clock: Instant,
}

/// The arrival hasher (Node's createArrivalChecksums object).
#[derive(Clone)]
pub struct Arrival(Arc<Inner>);

/// What one clip came to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Hashed,
    Unchanged,
    Held,
    Busy,
    Settling,
    Encoded,
    Changed,
    Gone,
    Failed,
}

impl Outcome {
    /// what a clip of the backlog ends as: looked at (a line, ours, encoded, gone)
    fn settled(self) -> bool {
        matches!(self, Outcome::Hashed | Outcome::Unchanged | Outcome::Encoded | Outcome::Gone)
    }
    fn waiting(self) -> bool {
        matches!(self, Outcome::Held | Outcome::Busy | Outcome::Settling | Outcome::Failed | Outcome::Changed)
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// (size, mtimeMs, ino) of a file's metadata, as Node's stat has them.
fn id_of(md: &std::fs::Metadata) -> (u64, f64, u64) {
    (md.size(), js::stat_ms(md.mtime(), md.mtime_nsec()), md.ino())
}

fn index<'a>(st: &'a mut State, files: &Files, vid: &str) -> &'a mut Index {
    if !st.indexes.contains_key(vid) {
        let idx = files.load(vid);
        st.indexes.insert(vid.to_string(), idx);
    }
    st.indexes.get_mut(vid).unwrap()
}

impl Arrival {
    pub fn new(ctx: Arc<dyn ArrivalCtx>, record: Arc<dyn RecordSink>, o: Options) -> Arrival {
        let files = Files { dir: o.dir.clone() };
        Arrival(Arc::new(Inner {
            ctx,
            record,
            o,
            files,
            st: Mutex::new(State::default()),
            running: Mutex::new(false),
            done: Condvar::new(),
            again: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            timers: Mutex::new(Timers { started: false, soon: 0 }),
            tick: Condvar::new(),
            clock: Instant::now(),
        }))
    }

    /// kick(): a pass now, or another one after the running one (new clips).
    pub fn kick(&self) {
        let inner = self.0.clone();
        if inner.stopped.load(Ordering::SeqCst) {
            return;
        }
        {
            let mut r = lock(&inner.running);
            if *r {
                inner.again.store(true, Ordering::SeqCst);
                return;
            }
            *r = true;
        }
        std::thread::spawn(move || {
            let mut more;
            loop {
                inner.again.store(false, Ordering::SeqCst);
                more = inner.pass();
                if !(inner.again.load(Ordering::SeqCst) && !inner.stopped.load(Ordering::SeqCst)) {
                    break;
                }
            }
            *lock(&inner.running) = false;
            inner.done.notify_all();
            if more && !inner.stopped.load(Ordering::SeqCst) {
                Inner::soon(&inner);
            }
        });
    }

    /// Wait for the current pass (Node: settled()).
    pub fn settled(&self) {
        let mut r = lock(&self.0.running);
        while *r {
            r = self.0.done.wait(r).unwrap_or_else(|p| p.into_inner());
        }
    }

    /// `await kick()` in Node: kick and wait for the passes it ran.
    pub fn kick_wait(&self) {
        self.kick();
        self.settled();
    }

    pub fn running(&self) -> bool {
        *lock(&self.0.running)
    }

    /// The pass every TIMER_MS.
    pub fn start(&self) {
        let inner = self.0.clone();
        {
            let mut t = lock(&inner.timers);
            if t.started {
                return;
            }
            t.started = true;
        }
        std::thread::spawn(move || loop {
            let t = lock(&inner.timers);
            let (t, _) = inner.tick.wait_timeout_while(t, Duration::from_millis(inner.o.timer_ms), |_| !inner.stopped.load(Ordering::SeqCst)).unwrap_or_else(|p| p.into_inner());
            drop(t);
            if inner.stopped.load(Ordering::SeqCst) {
                return;
            }
            Arrival(inner.clone()).kick();
        });
    }

    /// stop(): no more passes; the running one ends after its file; what is waiting is saved.
    pub fn stop(&self) {
        self.0.stopped.store(true, Ordering::SeqCst);
        {
            let mut t = lock(&self.0.timers);
            t.soon += 1;
        }
        self.0.tick.notify_all();
        self.settled();
        self.0.save();
    }

    /// converted(outputPath): our in-place conversion saved this clip; its identity is ours, never hashed.
    pub fn converted(&self, output_path: &str) {
        let inner = &self.0;
        let Some(vid) = inner.ctx.vehicle_for_path(output_path) else { return };
        let root = inner.ctx.root_of(&vid);
        let rel = js::relative(&root.to_string_lossy(), &js::resolve(output_path));
        if rel.is_empty() || rel.starts_with("..") {
            return;
        }
        let Ok(md) = std::fs::metadata(output_path) else { return };
        // (a clip kept as it was, no savings, is still the original: hashed as any other)
        let codec = (inner.o.codec_of)(Path::new(output_path)).ok().flatten();
        if !matches!(codec.as_deref(), Some("h265") | Some("av1")) {
            return;
        }
        inner.note(&vid, &rel, id_of(&md), "c");
        inner.save();
    }

    /// view(vid): the `record` of GET /api/vehicles/:id/sentry-usb (without canBackfill):
    /// { enabled, today, lastAt, pending, lines, windowDays, older, backlog }; an error when
    /// the setting cannot be read.
    pub fn view(&self, vid: &str) -> Result<Value, String> {
        let inner = &self.0;
        let v = inner.ctx.vehicle(vid);
        let tz = v.as_ref().map(|v| v.timezone.clone()).unwrap_or_default();
        let t = (inner.o.now)();
        let today = inner.day_in(t, &tz);
        let since = t - 2.0 * DAY_MS; // (today, in any zone, is within the last two days)
        let older = inner.ctx.older_of(vid)?;
        let mut st = lock(&inner.st);
        let (mut lines, mut today_n, mut last_at) = (0u64, 0u64, None::<f64>);
        // (a day starts on a quarter hour in every zone: one look per quarter hour, not per clip)
        let mut quarters: HashMap<i64, bool> = HashMap::new();
        let ats: Vec<f64> = index(&mut st, &inner.files, vid).files.values().filter(|e| e.kind == "h").map(|e| e.at).collect();
        for at in ats {
            lines += 1;
            if at >= since {
                let q = (at / 900_000.0).floor() as i64;
                let is_today = *quarters.entry(q).or_insert_with(|| inner.day_in(at, &tz) == today);
                if is_today {
                    today_n += 1;
                }
            }
            if last_at.is_none_or(|l| at > l) {
                last_at = Some(at);
            }
        }
        let bl = if older { st.backlogs.get(vid).cloned() } else { None };
        let speed = inner.speed(&st);
        let backlog = match bl {
            None => Value::Null,
            Some(bl) => {
                let seconds = if bl.left > 0 { bl.bytes_left / speed + (bl.left as f64 / inner.o.per_cycle as f64).ceil() * (inner.o.next_cycle_ms as f64 / 1000.0) } else { 0.0 };
                let mut m = Map::new();
                m.insert("total".into(), num(bl.total as f64));
                m.insert("done".into(), num((bl.total as f64) - (bl.left as f64)));
                m.insert("left".into(), num(bl.left as f64));
                m.insert("failed".into(), num(bl.failed as f64));
                m.insert("bytesLeft".into(), num(bl.bytes_left));
                m.insert("etaMinutes".into(), num(if bl.left > 0 { (seconds / 60.0).ceil().max(1.0) } else { 0.0 }));
                Value::Object(m)
            }
        };
        let mut m = Map::new();
        m.insert("enabled".into(), Value::Bool(st.enabled.get(vid) == Some(&true)));
        m.insert("today".into(), num(today_n as f64));
        m.insert("lastAt".into(), last_at.map_or(Value::Null, num));
        m.insert("pending".into(), num(st.pending_of.get(vid).copied().unwrap_or(0) as f64));
        m.insert("lines".into(), num(lines as f64));
        m.insert("windowDays".into(), num(inner.o.window_days));
        m.insert("older".into(), Value::Bool(older));
        m.insert("backlog".into(), backlog);
        Ok(Value::Object(m))
    }

    /// stats(): bytes hashed and the time it took (reading only), since start.
    pub fn stats(&self) -> Value {
        let st = lock(&self.0.st);
        let mut m = Map::new();
        m.insert("bytes".into(), num(st.hashed_bytes as f64));
        m.insert("ms".into(), num(st.hashed_ms));
        m.insert("running".into(), Value::Bool(self.running()));
        m.insert("bytesPerSecond".into(), num(self.0.speed(&st)));
        Value::Object(m)
    }

    pub fn hashed_bytes(&self) -> u64 {
        lock(&self.0.st).hashed_bytes
    }

    /// forget(vid): a vehicle removed; its index files go.
    pub fn forget(&self, vid: &str) {
        let inner = &self.0;
        {
            let mut st = lock(&inner.st);
            st.indexes.remove(vid);
            st.pending_ops.shift_remove(vid);
            st.enabled.remove(vid);
            st.pending_of.remove(vid);
            st.backlogs.remove(vid);
        }
        let _ = std::fs::remove_file(inner.files.snapshot(vid));
        let _ = std::fs::remove_file(inner.files.journal(vid));
    }

    /// The index files of a vehicle (tests, parity).
    pub fn index_files(&self, vid: &str) -> (PathBuf, PathBuf) {
        (self.0.files.snapshot(vid), self.0.files.journal(vid))
    }
}

impl Inner {
    fn now(&self) -> f64 {
        (self.o.now)()
    }
    /// olderOf for a pass: a setting that cannot be read is logged and counts as off (the
    /// recent clips only: no extra work on a setting that may have turned it off).
    fn older(&self, vid: &str) -> bool {
        self.ctx.older_of(vid).unwrap_or_else(|e| {
            self.ctx.log_warn(&format!("Checksum record of {vid}: only recent clips this pass, the setting could not be read: {e}"));
            false
        })
    }

    fn stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }
    fn wall_ms(&self) -> f64 {
        self.clock.elapsed().as_millis() as f64
    }

    fn day_in(&self, ms: f64, tz: &str) -> String {
        let z = if tz.is_empty() { "UTC" } else { tz };
        self.ctx.day_in(ms, z).unwrap_or_else(|| js::utc_day(ms))
    }

    /// Bytes a second the hashing manages (measured once there is enough of it, else the limit).
    fn speed(&self, st: &State) -> f64 {
        let rate = self.o.rate;
        let measured = if st.hashed_bytes >= 64 * 1024 * 1024 && st.hashed_ms > 0.0 { st.hashed_bytes as f64 / st.hashed_ms * 1000.0 } else { 0.0 };
        if measured != 0.0 {
            return if rate > 0.0 { measured.min(rate) } else { measured };
        }
        if rate > 0.0 {
            rate
        } else {
            512.0 * 1024.0 * 1024.0
        }
    }

    fn soon(inner: &Arc<Inner>) {
        let generation = {
            let mut t = lock(&inner.timers);
            t.soon += 1;
            t.soon
        };
        let inner = inner.clone();
        std::thread::spawn(move || {
            let t = lock(&inner.timers);
            let (t, _) = inner
                .tick
                .wait_timeout_while(t, Duration::from_millis(inner.o.next_cycle_ms), |t| t.soon == generation && !inner.stopped.load(Ordering::SeqCst))
                .unwrap_or_else(|p| p.into_inner());
            let fire = t.soon == generation && !inner.stopped.load(Ordering::SeqCst);
            drop(t);
            if fire {
                Arrival(inner).kick();
            }
        });
    }

    fn note(&self, vid: &str, rel: &str, id: (u64, f64, u64), kind: &str) {
        let e = Entry::new(id.0, id.1, id.2, self.now(), kind);
        let mut st = lock(&self.st);
        index(&mut st, &self.files, vid).files.insert(rel.to_string(), e.clone());
        st.pending_ops.entry(vid.to_string()).or_default().push(Op::Set(rel.to_string(), e));
    }

    /// Drop the entries whose clip is gone from the inventory.
    fn prune(&self, vid: &str, present: &HashSet<String>) {
        let mut st = lock(&self.st);
        let idx = index(&mut st, &self.files, vid);
        let gone: Vec<String> = idx.files.keys().filter(|k| !present.contains(*k)).cloned().collect();
        for rel in &gone {
            idx.files.shift_remove(rel);
        }
        if !gone.is_empty() {
            let ops = st.pending_ops.entry(vid.to_string()).or_default();
            ops.extend(gone.into_iter().map(Op::Gone));
        }
    }

    /// Append the changes waiting (or rewrite the snapshot when the journal has grown long).
    fn save(&self) {
        let mut st = lock(&self.st);
        if st.pending_ops.is_empty() {
            return;
        }
        let _ = std::fs::create_dir_all(&self.files.dir);
        let all: Vec<(String, Vec<Op>)> = std::mem::take(&mut st.pending_ops).into_iter().collect();
        for (vid, ops) in all {
            let exists = self.files.exists(&vid);
            let compact_min = self.o.compact_min as f64;
            let idx = index(&mut st, &self.files, &vid);
            let r = if idx.compact || (idx.journal + ops.len()) as f64 > compact_min.max(idx.files.len() as f64 / 2.0) || !exists {
                self.files.write_snapshot(&vid, idx)
            } else {
                self.files.append(&vid, &ops).map(|_| idx.journal += ops.len())
            };
            if let Err(e) = r {
                // (kept in memory; the next save rewrites the snapshot)
                idx.compact = true;
                st.pending_ops.entry(vid.clone()).or_default();
                self.ctx.log_warn(&format!("Checksum record index {vid}: {e}"));
            }
        }
    }

    fn sentry_usb_root(&self, root: &str) -> bool {
        let now = self.now();
        if let Some((at, yes)) = lock(&self.st).roots.get(root) {
            if now - at < 60_000.0 {
                return *yes;
            }
        }
        let yes = std::fs::metadata(Path::new(root).join(SENTRY_USB_DIR)).is_ok_and(|m| m.is_dir());
        lock(&self.st).roots.insert(root.to_string(), (self.now(), yes));
        yes
    }

    /// The car's clips that may need a line, newest first (fresh arrivals,
    /// then by the clip's own time); the inventory's paths; whether any clip
    /// is on a Sentry USB share.
    fn candidates(&self, v: &Car, since_ms: f64) -> (Vec<Cand>, Option<HashSet<String>>, bool, bool) {
        let Some(inv) = self.ctx.inventory(&v.id) else { return (Vec::new(), None, false, false) };
        let root_dir = self.ctx.root_of(&v.id).to_string_lossy().into_owned();
        let mut out = Vec::new();
        let mut any = false;
        let fresh_from = self.now() - self.o.fresh_ms;
        for f in &inv.files {
            if !f.clip {
                continue;
            }
            let name = js::basename(&f.rel);
            let Some(t) = js::clip_ms(name) else { continue };
            if crate::footage::is_converter_artifact(name) {
                continue;
            }
            if f.rel.split('/').any(|p| p.starts_with('.')) {
                continue;
            }
            let parts: Vec<&str> = f.rel.split('/').collect();
            let abs = js::join(&root_dir, &parts);
            let Some(w) = super::record::locate(&abs, Some(&root_dir)) else { continue };
            if !js::is_group(w.rel.split('/').next().unwrap_or("")) {
                continue;
            }
            if !self.sentry_usb_root(&w.root) {
                continue;
            }
            any = true;
            // (rsync keeps a clip's mtime: when it reached the share is its
            // birth time, else its ctime where the filesystem has none)
            let arrived = if f.birthtime_ms > 0.0 { f.birthtime_ms } else if f.ctime_ms.is_nan() { 0.0 } else { f.ctime_ms };
            let recent = t.max(if f.mtime_ms.is_nan() { 0.0 } else { f.mtime_ms }).max(arrived);
            if recent < since_ms {
                continue;
            }
            out.push(Cand { rel: f.rel.clone(), abs, size: f.size, mtime_ms: f.mtime_ms, t, recent, fresh: recent >= fresh_from });
        }
        // the Pi waits on the latest archive: what arrived in the last 48 h first, then the newest clips
        out.sort_by(|a, b| b.fresh.cmp(&a.fresh).then(b.t.partial_cmp(&a.t).unwrap_or(std::cmp::Ordering::Equal)).then_with(|| js::js_cmp(&b.rel, &a.rel)));
        let present: HashSet<String> = inv.files.iter().map(|f| f.rel.clone()).collect();
        (out, Some(present), any, inv.scanning)
    }

    fn wait_idle(&self) {
        while !self.ctx.idle() && !self.stopped() {
            std::thread::sleep(Duration::from_millis(self.o.idle_wait_ms));
        }
    }

    /// The file's SHA-256, streamed at most `rate` bytes a second, paused while not idle.
    fn hash_file(&self, abs: &str) -> Result<String, String> {
        let mut h = Sha256::new();
        let f = std::fs::File::open(abs).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; CHUNK];
        let started = self.wall_ms();
        let mut paused = 0.0;
        let mut read: u64 = 0;
        loop {
            if self.stopped() {
                return Err("stopped".into());
            }
            if !self.ctx.idle() {
                let w = self.wall_ms();
                self.wait_idle();
                paused += self.wall_ms() - w;
            }
            let n = loop {
                match f.read_at(&mut buf, read) {
                    Ok(n) => break n,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => return Err(e.to_string()),
                }
            };
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
            read += n as u64;
            if self.o.rate > 0.0 {
                let ahead = (read as f64 / self.o.rate) * 1000.0 - (self.wall_ms() - started - paused);
                if ahead > 5.0 {
                    std::thread::sleep(Duration::from_millis(ahead as u64));
                }
            }
        }
        let mut st = lock(&self.st);
        st.hashed_bytes += read;
        st.hashed_ms += self.wall_ms() - started - paused;
        Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
    }

    fn busy_now(&self, abs: &str) -> bool {
        let me = js::resolve(abs);
        self.ctx.busy_paths().iter().any(|p| js::resolve(p) == me)
    }

    /// One clip.
    fn one(&self, v: &Car, c: &Cand) -> Outcome {
        let Ok(md) = std::fs::metadata(&c.abs) else { return Outcome::Gone };
        if !md.is_file() {
            return Outcome::Gone;
        }
        let id = id_of(&md);
        let unchanged = {
            let mut st = lock(&self.st);
            index(&mut st, &self.files, &v.id).files.get(&c.rel).is_some_and(|e| e.same_id(id.0, id.1, id.2))
        };
        if unchanged {
            return Outcome::Unchanged;
        }
        if self.ctx.holds(&c.abs) {
            return Outcome::Held;
        }
        if self.busy_now(&c.abs) {
            return Outcome::Busy;
        }
        // (renamed into place just now: ctime; still being written: mtime; in
        // whole milliseconds, as now(): a file time has a fraction of one)
        let ctime = js::stat_ms(md.ctime(), md.ctime_nsec());
        if self.now() - id.1.max(ctime).floor() < self.o.settle_ms {
            return Outcome::Settling;
        }
        // encoded: our own conversion's output is noted by converted(); any other is not the Pi's bytes
        let known = self.ctx.codec(&v.id, &c.rel);
        let codec = match known {
            Some(k) if k.size == id.0 && k.mtime_ms == id.1 => k.codec,
            _ => (self.o.codec_of)(Path::new(&c.abs)).ok().flatten(),
        };
        if matches!(codec.as_deref(), Some("h265") | Some("av1")) {
            self.note(&v.id, &c.rel, id, "s");
            return Outcome::Encoded;
        }
        let sha = match self.hash_file(&c.abs) {
            Ok(s) => s,
            Err(e) => {
                if !self.stopped() {
                    self.ctx.log_debug(&format!("Checksum record: {}: {e}", c.rel));
                }
                return Outcome::Failed;
            }
        };
        // the same file still (not replaced, converted or re-uploaded meanwhile)?
        let Ok(after) = std::fs::metadata(&c.abs) else { return Outcome::Gone };
        let after_id = id_of(&after);
        if after_id != id {
            return Outcome::Changed;
        }
        if self.busy_now(&c.abs) || self.ctx.holds(&c.abs) {
            return Outcome::Busy;
        }
        let root = self.ctx.root_of(&v.id).to_string_lossy().into_owned();
        if let Err(e) = self.record.record(&c.abs, &root, &sha) {
            self.ctx.log_warn(&format!("Checksum record: {}: {}", c.rel, e.message));
            return Outcome::Failed;
        }
        self.note(&v.id, &c.rel, after_id, "h");
        Outcome::Hashed
    }

    fn pass(&self) -> bool {
        let mut budget = self.o.per_cycle as i64;
        let mut hashed = 0usize;
        let mut more = false;
        let window_from = self.now() - self.o.window_days * DAY_MS;
        struct CarWork {
            v: Car,
            recent: Vec<Cand>,
            backlog: Vec<Cand>,
            waiting: u64,
        }
        let mut cars: Vec<CarWork> = Vec::new();
        for v in self.ctx.vehicles() {
            if self.stopped() {
                break;
            }
            let older = self.older(&v.id);
            let (list, present, any, scanning) = self.candidates(&v, if older { f64::NEG_INFINITY } else { window_from });
            lock(&self.st).enabled.insert(v.id.clone(), any);
            if let Some(present) = &present {
                if !scanning {
                    self.prune(&v.id, present);
                }
            }
            if !any {
                let mut st = lock(&self.st);
                st.pending_of.insert(v.id.clone(), 0);
                st.backlogs.remove(&v.id);
                continue;
            }
            let (mut recent, mut backlog) = (Vec::new(), Vec::new());
            let mut older_total = 0u64;
            {
                let mut st = lock(&self.st);
                let idx = index(&mut st, &self.files, &v.id);
                for c in list {
                    let in_window = c.recent >= window_from;
                    if !in_window {
                        older_total += 1;
                    }
                    if idx.files.get(&c.rel).is_some_and(|e| e.size == c.size as f64 && e.mtime_ms == c.mtime_ms) {
                        continue;
                    }
                    if in_window {
                        recent.push(c);
                    } else {
                        backlog.push(c);
                    }
                }
                if older {
                    let bytes: f64 = backlog.iter().map(|c| c.size as f64).sum();
                    st.backlogs.insert(v.id.clone(), Backlog { total: older_total, left: backlog.len() as u64, bytes_left: bytes, failed: 0 });
                } else {
                    st.backlogs.remove(&v.id);
                }
            }
            cars.push(CarWork { v, recent, backlog, waiting: 0 });
        }

        let step = |v: &Car, c: &Cand, budget: &mut i64, hashed: &mut usize| -> Outcome {
            self.wait_idle();
            let r = self.one(v, c);
            if r == Outcome::Hashed {
                *budget -= 1;
                *hashed += 1;
            }
            if *hashed > 0 && *hashed % self.o.save_every == 0 && r == Outcome::Hashed {
                self.save();
            }
            r
        };

        // first what arrived lately, for every car (the Pi is waiting on it)
        for car in cars.iter_mut() {
            for i in 0..car.recent.len() {
                if self.stopped() {
                    break;
                }
                if budget <= 0 {
                    more = true;
                    car.waiting += (car.recent.len() - i) as u64;
                    break;
                }
                if step(&car.v, &car.recent[i], &mut budget, &mut hashed).waiting() {
                    car.waiting += 1;
                }
            }
            lock(&self.st).pending_of.insert(car.v.id.clone(), car.waiting);
        }
        // then the older clips, newest first; new arrivals (a kick) end the pass so the next one takes them first
        for car in &cars {
            let has_bl = lock(&self.st).backlogs.contains_key(&car.v.id);
            for c in &car.backlog {
                if self.stopped() || self.again.load(Ordering::SeqCst) || !self.older(&car.v.id) || !has_bl {
                    break;
                }
                if budget <= 0 {
                    more = true;
                    break;
                }
                let r = step(&car.v, c, &mut budget, &mut hashed);
                if r.settled() || r == Outcome::Failed {
                    let mut st = lock(&self.st);
                    if let Some(bl) = st.backlogs.get_mut(&car.v.id) {
                        bl.left = bl.left.saturating_sub(1);
                        bl.bytes_left = (bl.bytes_left - c.size as f64).max(0.0);
                        if r == Outcome::Failed {
                            bl.failed += 1;
                        }
                    }
                }
            }
            if self.stopped() || self.again.load(Ordering::SeqCst) {
                break;
            }
        }
        self.save();
        more
    }
}
