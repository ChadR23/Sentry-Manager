//! The server's state: vehicles, the catalog, what the last scan of each
//! found, and the background work after a scan (codecs, speed index).

use crate::catalog::Catalog;
use crate::inventory::{self, Codecs, Recording};
use crate::jobs::{par_each, Jobs, Priority};
use crate::scanner::{self, FileEntry};
use crate::thumbnails::Thumbnails;
use crate::{footage, mp4, speeds};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

/// Clip codec reads at once (inventory.js limiter(8)); scan threads (scanner.js concurrency 16).
const PROBE_THREADS: usize = 8;
const SCAN_THREADS: usize = 16;
/// Every sixth background rescan looks at every file (inventory.js).
const LIGHT_SCANS: u32 = 5;

#[derive(Debug, Clone)]
pub struct Vehicle {
    pub id: String,
    pub name: String,
    pub timezone: String,
    pub root: PathBuf,
}

#[derive(Default, Clone)]
pub struct VehicleState {
    pub recordings: Arc<Vec<Recording>>,
    pub codecs: Arc<Codecs>,
    pub files: usize,
    pub scanned_at: Option<f64>,
    pub scanning: bool,
    pub last_error: Option<String>,
    /// whether a scan has finished (Node: inventory.get(id).files)
    pub scanned: bool,
    pub light_scans: u32,
    pub error_count: usize,
}

#[derive(Default, Clone)]
pub struct SpeedStatus {
    pub running: bool,
    pub done: usize,
    pub total: usize,
    pub day: Option<String>,
    pub finished_at: Option<f64>,
    pub last: usize,
}

pub struct App {
    pub vehicles: Vec<Vehicle>,
    pub catalog: Catalog,
    pub jobs: Arc<Jobs>,
    pub state: RwLock<HashMap<String, VehicleState>>,
    pub speeds: Mutex<SpeedStatus>,
    pub app_root: PathBuf,
    pub thumbnails: Thumbnails,
    studio_roots: Mutex<HashMap<String, (f64, PathBuf)>>,
}

/// A vehicle's name as vehicles.js normalizeVehicle keeps it: `String(name).trim().slice(0, 60)`
/// (JavaScript's white space, 60 UTF-16 units); None when nothing is left (Node refuses it).
/// (A cut through a character outside the BMP leaves half of it in Node; here it is left out.)
pub fn vehicle_name(raw: &str) -> Option<String> {
    let js_space = |c: char| matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}');
    let mut units = 0;
    let name: String = raw.trim_matches(js_space).chars().take_while(|c| {
        units += c.len_utf16();
        units <= 60
    }).collect();
    (!name.is_empty()).then_some(name)
}

/// vehicles.js slug:`String(name || 'vehicle').toLowerCase().normalize('NFKD')`, every run
/// of other characters than a-z and 0-9 one dash, no dash at either end, at most 40
/// characters (a cut can end on a dash, as in Node), else "vehicle". The NFKD step splits
/// an accented letter into its base letter and the accent, so é gives e.
pub fn slug(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let name = if name.is_empty() { "vehicle" } else { name };
    let mut out = String::new();
    let mut dash = false;
    for c in name.to_lowercase().nfkd() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c);
        } else {
            dash = true;
        }
    }
    let s: String = out.chars().take(40).collect();
    if s.is_empty() { "vehicle".into() } else { s }
}

/// The shallowest folder at most three levels down with clip folders in it, preferring
/// one called TeslaCam (vehicles.js findClipRoot); else None.
pub fn find_clip_root(root: &Path) -> Option<PathBuf> {
    let mut level = vec![root.to_path_buf()];
    let mut read = 0;
    for _ in 0..=3 {
        if level.is_empty() {
            break;
        }
        let mut hits: Vec<PathBuf> = Vec::new();
        let mut next: Vec<PathBuf> = Vec::new();
        for dir in &level {
            read += 1;
            if read > 200 {
                return None;
            }
            let Ok(list) = std::fs::read_dir(dir) else { continue };
            let entries: Vec<(String, bool)> = list.flatten().map(|e| (e.file_name().to_string_lossy().into_owned(), e.file_type().is_ok_and(|t| t.is_dir()))).collect();
            if entries.iter().any(|(n, d)| *d && matches!(n.to_lowercase().as_str(), "recentclips" | "sentryclips" | "savedclips")) {
                hits.push(dir.clone());
            } else {
                for (n, d) in &entries {
                    if *d && !footage::should_skip_dir(n) {
                        next.push(dir.join(n));
                    }
                }
            }
        }
        if !hits.is_empty() {
            if let Some(t) = hits.iter().find(|d| d.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("teslacam"))) {
                return Some(t.clone());
            }
            hits.sort();
            return hits.into_iter().next();
        }
        next.sort();
        level = next;
    }
    None
}

impl App {
    /// `thumbnails`: made from clips with ffmpeg, cached in DATA_PATH/thumbnails.
    pub fn new(vehicles: Vec<Vehicle>, catalog: Catalog, app_root: PathBuf, thumbnails: Thumbnails) -> Arc<App> {
        Arc::new(App {
            vehicles,
            catalog,
            jobs: Jobs::start(0),
            state: RwLock::new(HashMap::new()),
            speeds: Mutex::new(SpeedStatus::default()),
            app_root,
            thumbnails,
            studio_roots: Mutex::new(HashMap::new()),
        })
    }

    pub fn vehicle(&self, id: &str) -> Option<&Vehicle> {
        self.vehicles.iter().find(|v| v.id == id)
    }

    pub fn state_of(&self, id: &str) -> Option<VehicleState> {
        self.state.read().unwrap().get(id).cloned()
    }

    /// vehicles.js studioRoot (kept a minute)
    pub fn studio_root(&self, v: &Vehicle) -> PathBuf {
        let now = scanner::now_ms();
        if let Some((at, p)) = self.studio_roots.lock().unwrap().get(&v.id) {
            if now - at < 60_000.0 {
                return p.clone();
            }
        }
        let p = find_clip_root(&v.root).unwrap_or_else(|| v.root.clone());
        self.studio_roots.lock().unwrap().insert(v.id.clone(), (now, p.clone()));
        p
    }

    /// Queue a scan of a vehicle (light: reuse unchanged folders). Returns whether it was queued.
    pub fn scan(self: &Arc<Self>, id: &str, light: bool) -> bool {
        let app = self.clone();
        let vid = id.to_string();
        self.jobs.submit(format!("scan:{id}"), Priority::High, move || app.run_scan(&vid, light))
    }

    fn run_scan(self: &Arc<Self>, vid: &str, light: bool) {
        let Some(v) = self.vehicle(vid).cloned() else { return };
        let lights = {
            let mut st = self.state.write().unwrap();
            let e = st.entry(vid.to_string()).or_default();
            e.scanning = true;
            e.light_scans
        };
        let reuse = light && lights < LIGHT_SCANS;
        let prev = if reuse { self.catalog.previous(vid).ok().filter(|p| !p.files.is_empty() || !p.dirs.is_empty()) } else { None };
        let res = scanner::scan(&v.root, prev.as_ref(), SCAN_THREADS);
        drop(prev);
        let recs = inventory::build_recordings(&res.files, vid);
        if let Err(e) = self.catalog.save_scan(vid, &res) {
            eprintln!("{}: saving the catalog failed: {e}", v.name);
        }
        let codecs = self.codec_map(vid);
        eprintln!("{}: {} recordings, {} files ({:.1}s{})", v.name, recs.len(), res.files.len(), res.duration_ms / 1000.0, if reuse { format!(", {} unchanged", res.reused) } else { String::new() });
        {
            let mut st = self.state.write().unwrap();
            let e = st.entry(vid.to_string()).or_default();
            *e = VehicleState {
                recordings: Arc::new(recs),
                codecs: Arc::new(codecs),
                files: res.files.len(),
                scanned_at: Some(res.scanned_at),
                scanning: false,
                last_error: None,
                scanned: true,
                light_scans: if reuse { lights + 1 } else { 0 },
                error_count: res.errors.len(),
            };
        }
        let app = self.clone();
        let id = vid.to_string();
        let files = Arc::new(res.files);
        self.jobs.submit(format!("codecs:{vid}"), Priority::Normal, move || app.probe_codecs(&id, &files));
    }

    fn codec_map(&self, vid: &str) -> Codecs {
        self.catalog.codecs(vid).map(|m| m.into_iter().map(|(rel, (_, _, c))| (rel, c)).collect()).unwrap_or_default()
    }

    /// Read the codec of every clip that is new or changed since it was last read; forget clips that are gone.
    fn probe_codecs(self: &Arc<Self>, vid: &str, files: &[FileEntry]) {
        let Some(v) = self.vehicle(vid).cloned() else { return };
        let known = self.catalog.codecs(vid).unwrap_or_default();
        let present: HashSet<&str> = files.iter().map(|f| f.rel.as_str()).collect();
        let gone: Vec<String> = known.keys().filter(|r| !present.contains(r.as_str())).cloned().collect();
        let todo: Vec<&FileEntry> = files
            .iter()
            .filter(|f| f.kind == footage::Kind::Clip && f.rel.to_lowercase().ends_with(".mp4"))
            .filter(|f| known.get(&f.rel).map_or(true, |(s, m, _)| *s != f.size || *m != f.mtime_ms))
            .collect();
        let read = par_each(&todo, PROBE_THREADS, |f| mp4::video_codec(&v.root.join(&f.rel)).ok().map(|c| (f.rel.clone(), f.size, f.mtime_ms, c)));
        let set: Vec<_> = read.into_iter().flatten().collect();
        if !set.is_empty() || !gone.is_empty() {
            if let Err(e) = self.catalog.update_codecs(vid, &set, &gone) {
                eprintln!("{}: saving clip codecs failed: {e}", v.name);
            }
            let codecs = self.codec_map(vid);
            if let Some(e) = self.state.write().unwrap().get_mut(vid) {
                e.codecs = Arc::new(codecs);
            }
        }
        let app = self.clone();
        let id = vid.to_string();
        self.jobs.submit(format!("speeds:{vid}"), Priority::Low, move || app.index_speeds(&id));
    }

    fn index_speeds(self: &Arc<Self>, vid: &str) {
        let Some(v) = self.vehicle(vid).cloned() else { return };
        {
            let mut s = self.speeds.lock().unwrap();
            s.running = true;
            s.done = 0;
            s.total = 0;
            s.day = None;
        }
        let progress = |done: usize, total: usize, day: &str| {
            let mut s = self.speeds.lock().unwrap();
            s.done = done;
            s.total = total;
            s.day = Some(day.to_string());
        };
        let n = speeds::pass(&self.catalog, vid, &v.root, &progress).unwrap_or_else(|e| {
            eprintln!("Speed index: {e}");
            0
        });
        let mut s = self.speeds.lock().unwrap();
        s.running = false;
        s.finished_at = Some(scanner::now_ms());
        s.last = n;
    }
}
