//! The CAN sync's service (server/canSync.js createCanSync): the cache per
//! car key (<DATA>/can-index/<key>/sync.json), a clip worked out on its own
//! when the Viewer asks, its whole drive in the background, and what a newly
//! indexed log covers forgotten and worked out again.

use super::ctx::{CanCtx, Car, Scan};
use super::json::{self, n};
use super::sync::{clip_duration, estimate_clip, solve_drive, telemetry_frames, DriveClip, Estimate, Series, SEARCH_MS, SYNC_FORMAT};
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};

pub type SeriesFn = Box<dyn Fn(&[String], f64, f64) -> Series + Send + Sync>;

struct Front {
    rel: String,
    real: PathBuf,
    start: f64,
}

pub struct CanSync {
    pub dir: PathBuf,
    pub ctx: Arc<dyn CanCtx>,
    pub series: SeriesFn,
    pub keys_for: Box<dyn Fn(&str) -> Vec<String> + Send + Sync>,
    pub idle: Box<dyn Fn() -> bool + Send + Sync>,
    pub pause_ms: u64,
    stores: Mutex<HashMap<String, Value>>,
    todo: Mutex<IndexMap<String, (String, String)>>,
    running: Mutex<bool>,
    cv: Condvar,
    status: Mutex<(bool, u64, usize, Option<String>)>,
}

fn front_of(real: &Path) -> PathBuf {
    let s = real.to_string_lossy();
    let lower = s.to_lowercase();
    for cam in ["front", "back", "left_repeater", "right_repeater", "left_pillar", "right_pillar"] {
        let suffix = format!("-{}.mp4", cam);
        if lower.ends_with(&suffix) {
            return PathBuf::from(format!("{}-front.mp4", &s[..s.len() - suffix.len()]));
        }
    }
    real.to_path_buf()
}

fn stamp_of(p: &Path) -> Option<String> {
    let st = std::fs::metadata(p).ok()?;
    Some(format!("{}/{}", st.len(), json::num_str(json::round(super::util::mtime_ms(&st)))))
}

fn relative(root: &Path, p: &Path) -> Option<String> {
    let r = p.strip_prefix(root).ok()?;
    let s = r.to_string_lossy().into_owned();
    (!s.is_empty() && !s.starts_with("..")).then_some(s)
}

impl CanSync {
    pub fn new(dir: PathBuf, ctx: Arc<dyn CanCtx>, series: SeriesFn, keys_for: Box<dyn Fn(&str) -> Vec<String> + Send + Sync>) -> CanSync {
        CanSync { dir, ctx, series, keys_for, idle: Box::new(|| true), pause_ms: 200, stores: Mutex::new(HashMap::new()), todo: Mutex::new(IndexMap::new()), running: Mutex::new(false), cv: Condvar::new(), status: Mutex::new((false, 0, 0, None)) }
    }

    fn file_of(&self, key: &str) -> PathBuf {
        self.dir.join(key).join("sync.json")
    }
    fn with_store<T>(&self, key: &str, f: impl FnOnce(&mut Value) -> T) -> T {
        let mut s = self.stores.lock().unwrap();
        if !s.contains_key(key) {
            let data = super::util::read_json(&self.file_of(key))
                .filter(|d| d.get("v").and_then(|v| v.as_str()) == Some(SYNC_FORMAT) && d.get("clips").is_some_and(|c| c.is_object()))
                .unwrap_or_else(|| json!({ "v": SYNC_FORMAT, "clips": {} }));
            s.insert(key.to_string(), data);
        }
        f(s.get_mut(key).unwrap())
    }
    fn save(&self, key: &str) {
        let text = self.with_store(key, |d| json::stringify(d));
        let _ = std::fs::create_dir_all(self.dir.join(key));
        if let Err(e) = super::format::write_atomic(&self.file_of(key), text.as_bytes()) {
            self.ctx.log("warn", &format!("CAN sync: {}", e));
        }
    }

    fn rel_of(v: &Car, real: &Path) -> Option<String> {
        let root = v.root.as_ref()?;
        relative(root, real).or_else(|| std::fs::canonicalize(root).ok().and_then(|r| relative(&r, real)))
    }

    fn cams(scan: &Scan) -> HashMap<&str, Option<&str>> {
        scan.files.iter().map(|f| (f.rel.as_str(), f.camera.as_deref())).collect()
    }

    fn fronts_of(v: &Car, clip_rels: &[String], cams: &HashMap<&str, Option<&str>>) -> Vec<Front> {
        let Some(root) = v.root.as_ref() else { return Vec::new() };
        let mut out: Vec<Front> = clip_rels
            .iter()
            .filter(|r| cams.get(r.as_str()).copied().flatten().or_else(|| r.to_lowercase().ends_with("-front.mp4").then_some("front")) == Some("front"))
            .filter_map(|rel| super::prune::start_of(v, rel.rsplit('/').next().unwrap_or(rel)).map(|start| Front { rel: rel.clone(), real: root.join(rel), start }))
            .collect();
        out.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap());
        out
    }

    fn recording_of(&self, v: &Car, rel: &str) -> Option<(String, Vec<Front>)> {
        let scan = self.ctx.scan_of(&v.id)?;
        let rec = scan.recordings.iter().find(|r| r.clip_rels.iter().any(|x| x == rel))?;
        Some((rec.id.clone(), Self::fronts_of(v, &rec.clip_rels, &Self::cams(&scan))))
    }

    fn estimate(&self, keys: &[String], real: &Path, start: f64) -> Estimate {
        let (frames, failed) = match self.ctx.telemetry(real) {
            Ok(body) => (telemetry_frames(&body), false),
            Err(_) => (Vec::new(), true),
        };
        let d = clip_duration(&frames);
        let dur = if d == 0.0 || d.is_nan() { 60_000.0 } else { d };
        let s = if frames.is_empty() { IndexMap::new() } else { (self.series)(keys, start - SEARCH_MS - 2000.0, start + dur + SEARCH_MS + 2000.0) };
        let mut e = estimate_clip(&frames, &s, start);
        e.failed = failed;
        e
    }

    fn store_key(keys: &[String]) -> String {
        let mut k = keys.to_vec();
        k.sort();
        k[0].clone()
    }
    fn keys_tag(keys: &[String]) -> String {
        let mut k = keys.to_vec();
        k.sort();
        k.join(",")
    }

    /// forClip: a clip's sync (worked out on its own now, for its whole drive in the background).
    pub fn for_clip(self: &Arc<Self>, v: &Car, keys: &[String], real: &Path, start: f64) -> Option<Value> {
        if keys.is_empty() {
            return None;
        }
        let front = front_of(real);
        let stamp = stamp_of(&front)?;
        let key = Self::store_key(keys);
        let rel = Self::rel_of(v, &front);
        let at = match (&rel, &v.root) {
            (Some(r), Some(root)) => root.join(r).to_string_lossy().into_owned(),
            _ => front.to_string_lossy().into_owned(),
        };
        let tag = Self::keys_tag(keys);
        let had = self.with_store(&key, |d| d["clips"].get(&at).cloned());
        if let Some(h) = had {
            if h.get("stamp").and_then(|x| x.as_str()) == Some(stamp.as_str()) && h.get("keys").and_then(|x| x.as_str()) == Some(tag.as_str()) && h.get("start").and_then(|x| x.as_f64()) == Some(start) {
                if !json::truthy(h.get("drive")) {
                    if let Some(r) = &rel {
                        self.queue(v, r);
                    }
                }
                return h.get("sync").cloned();
            }
        }
        let est = self.estimate(keys, &front, start);
        if est.failed {
            return Some(est.result.to_json());
        }
        let rec = rel.as_ref().and_then(|r| self.recording_of(v, r)).map(|x| x.0);
        let entry = json!({ "stamp": stamp, "keys": tag, "start": n(start), "end": n(start + if est.dur != 0.0 { est.dur } else { 60_000.0 }), "rec": rec, "drive": !est.has_can, "sync": est.result.to_json() });
        self.with_store(&key, |d| d["clips"].as_object_mut().unwrap().insert(at.clone(), entry));
        self.save(&key);
        if est.has_can {
            if let Some(r) = &rel {
                self.queue(v, r);
            }
        }
        Some(est.result.to_json())
    }

    fn queue(self: &Arc<Self>, v: &Car, rel: &str) {
        let Some(scan) = self.ctx.scan_of(&v.id) else { return };
        let Some(rec) = scan.recordings.iter().find(|r| r.clip_rels.iter().any(|x| x == rel)) else { return };
        self.enqueue(v, rel, &rec.id);
    }

    fn enqueue(self: &Arc<Self>, v: &Car, rel: &str, rec_id: &str) {
        let id = format!("{}|{}", v.id, rec_id);
        {
            let mut t = self.todo.lock().unwrap();
            if !t.contains_key(&id) {
                t.insert(id, (v.id.clone(), rel.to_string()));
            }
            self.status.lock().unwrap().2 = t.len();
        }
        self.run();
    }

    fn run(self: &Arc<Self>) {
        {
            let mut r = self.running.lock().unwrap();
            if *r {
                return;
            }
            *r = true;
        }
        let me = self.clone();
        std::thread::spawn(move || {
            me.status.lock().unwrap().0 = true;
            loop {
                let job = {
                    let mut t = me.todo.lock().unwrap();
                    let j = t.shift_remove_index(0);
                    me.status.lock().unwrap().2 = t.len();
                    j
                };
                let Some((_, (vid, rel))) = job else { break };
                match me.solve_recording(&vid, &rel) {
                    Ok(()) => me.status.lock().unwrap().1 += 1,
                    Err(e) => {
                        me.ctx.log("warn", &format!("CAN sync: {}", e));
                        me.status.lock().unwrap().3 = Some(e);
                    }
                }
            }
            *me.running.lock().unwrap() = false;
            me.status.lock().unwrap().0 = false;
            me.cv.notify_all();
            if !me.todo.lock().unwrap().is_empty() {
                me.run();
            }
        });
    }

    fn solve_recording(&self, vid: &str, rel: &str) -> Result<(), String> {
        let Some(v) = self.ctx.vehicle(vid) else { return Ok(()) };
        let keys = (self.keys_for)(vid);
        if keys.is_empty() {
            return Ok(());
        }
        let Some((rec_id, fronts)) = self.recording_of(&v, rel) else { return Ok(()) };
        if fronts.is_empty() {
            return Ok(());
        }
        let mut meta: Vec<(PathBuf, f64, String)> = Vec::new();
        let mut dc: Vec<DriveClip> = Vec::new();
        for c in fronts {
            while !(self.idle)() {
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
            let Some(stamp) = stamp_of(&c.real) else { continue };
            let est = self.estimate(&keys, &c.real, c.start);
            meta.push((c.real.clone(), c.start, stamp));
            dc.push(DriveClip { start: c.start, est });
            if self.pause_ms > 0 {
                std::thread::sleep(std::time::Duration::from_millis(self.pause_ms));
            }
            let _ = &c.rel;
        }
        let results = solve_drive(&dc);
        let key = Self::store_key(&keys);
        let tag = Self::keys_tag(&keys);
        self.with_store(&key, |d| {
            let m = d["clips"].as_object_mut().unwrap();
            for (k, (real, start, stamp)) in meta.iter().enumerate() {
                if dc[k].est.failed {
                    continue;
                }
                let dur = if dc[k].est.dur != 0.0 { dc[k].est.dur } else { 60_000.0 };
                m.insert(real.to_string_lossy().into_owned(), json!({ "stamp": stamp, "keys": tag, "start": n(*start), "end": n(start + dur), "rec": rec_id, "drive": true, "sync": results[k].to_json() }));
            }
        });
        self.save(&key);
        if let Some(best) = results.iter().find(|r| r.method == "edges-drive") {
            self.ctx.log(
                "info",
                &format!("CAN sync: {}'s drive: {} ms, {} edges, ±{} ms", rel.rsplit('/').next().unwrap_or(rel), json::num_str(best.offset_ms), best.matches, best.spread_ms.map(json::num_str).unwrap_or_else(|| "null".into())),
            );
        }
        Ok(())
    }

    /// indexed: a log was indexed; the drives it covers are worked out again.
    pub fn indexed(self: &Arc<Self>, key: &str, from: f64, to: f64) {
        if !from.is_finite() || !to.is_finite() {
            return;
        }
        let mut cars = Vec::new();
        let mut stores: Vec<String> = vec![key.to_string()];
        for v in self.ctx.vehicles() {
            let keys = (self.keys_for)(&v.id);
            if !keys.iter().any(|k| k == key) {
                continue;
            }
            let sk = Self::store_key(&keys);
            if !stores.contains(&sk) {
                stores.push(sk);
            }
            cars.push(v);
        }
        for k in &stores {
            self.forget(k, from, to);
        }
        for v in cars {
            let Some(scan) = self.ctx.scan_of(&v.id) else { continue };
            let cams = Self::cams(&scan);
            let mut first: HashMap<&str, &str> = HashMap::new();
            for r in &scan.recordings {
                for x in &r.clip_rels {
                    first.entry(x.as_str()).or_insert(r.id.as_str());
                }
            }
            for rec in &scan.recordings {
                let fronts = Self::fronts_of(&v, &rec.clip_rels, &cams);
                if fronts.is_empty() || fronts[0].start > to + 60_000.0 || fronts[fronts.len() - 1].start + 60_000.0 < from {
                    continue;
                }
                let rel = &fronts[0].rel;
                match first.get(rel.as_str()) {
                    Some(id) if self.ctx.scan_generation(&v.id) == Some(scan.generation) => self.enqueue(&v, rel, id),
                    _ => self.queue(&v, rel),
                }
            }
        }
    }

    fn forget(&self, key: &str, from: f64, to: f64) {
        let changed = self.with_store(key, |d| {
            let m = d["clips"].as_object_mut().unwrap();
            let mut recs: Vec<String> = Vec::new();
            let mut lone: Vec<String> = Vec::new();
            for (real, e) in m.iter() {
                let end = e.get("end").and_then(|x| x.as_f64()).unwrap_or(f64::NAN);
                let start = e.get("start").and_then(|x| x.as_f64()).unwrap_or(f64::NAN);
                if end >= from - 60_000.0 && start <= to + 60_000.0 {
                    match e.get("rec").and_then(|r| r.as_str()).filter(|r| !r.is_empty()) {
                        Some(r) => recs.push(r.to_string()),
                        None => lone.push(real.clone()),
                    }
                }
            }
            let before = m.len();
            m.retain(|real, e| !(lone.contains(real) || e.get("rec").and_then(|r| r.as_str()).filter(|r| !r.is_empty()).is_some_and(|r| recs.iter().any(|x| x == r))));
            m.len() != before
        });
        if changed {
            self.save(key);
        }
    }

    pub fn status(&self) -> Value {
        let s = self.status.lock().unwrap();
        json!({ "running": s.0, "drives": s.1, "pending": s.2, "lastError": s.3 })
    }

    /// Once the background is done (for tests).
    pub fn settled(&self) {
        let mut r = self.running.lock().unwrap();
        while *r {
            r = self.cv.wait(r).unwrap();
        }
    }
}
