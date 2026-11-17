//! The server's state: vehicles, the catalog, what the last scan of each
//! found, and the background work after a scan (codecs, speed index).

use crate::catalog::Catalog;
use crate::inventory::{self, Codecs, Recording};
use crate::jobs::{par_each, Jobs, Priority};
use crate::scanner::{self, FileEntry, FileList};
use crate::thumbnails::Thumbnails;
use crate::footage::ctx::{Ctx, Fail, Level, Res};
use crate::footage::vehicles::Vehicles;
use crate::{footage, mp4};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

/// Clip codec reads at once (inventory.js limiter(8)); scan threads (scanner.js concurrency 16).
const PROBE_THREADS: usize = 8;
const SCAN_THREADS: usize = 16;
/// Every sixth background rescan looks at every file (inventory.js).
const LIGHT_SCANS: u32 = 5;

// (vehicles live in the footage area now: footage/vehicles.rs)
pub use crate::footage::vehicles::Vehicle;

static GENERATIONS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn next_generation() -> u64 {
    GENERATIONS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
}

#[derive(Default, Clone)]
pub struct VehicleState {
    pub recordings: Arc<Vec<Recording>>,
    /// new whenever `recordings` is replaced; never reused (an Arc's address can be)
    pub generation: u64,
    pub codecs: Arc<Codecs>,
    pub files: usize,
    pub scanned_at: Option<f64>,
    pub scanning: bool,
    pub last_error: Option<String>,
    /// whether a scan has finished (Node: inventory.get(id).files)
    pub scanned: bool,
    pub light_scans: u32,
    pub error_count: usize,
    /// every file of the last scan, in the scan's order (inventory.js entry.files)
    pub file_list: Arc<FileList>,
    pub dirs: Arc<HashMap<String, f64>>,
    pub started_at: f64,
}

pub struct App {
    pub vehicles: Arc<Vehicles>,
    /// what the footage area needs from core (footage/ctx.rs)
    pub core: Arc<dyn Ctx>,
    /// the footage area's own state (Recycle Bin locks, footage checks, scans running)
    pub footage: footage::State,
    pub catalog: Catalog,
    pub jobs: Arc<Jobs>,
    pub state: RwLock<HashMap<String, VehicleState>>,
    pub app_root: PathBuf,
    pub thumbnails: Thumbnails,
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
    pub fn new(vehicles: Arc<Vehicles>, core: Arc<dyn Ctx>, catalog: Catalog, app_root: PathBuf, thumbnails: Thumbnails) -> Arc<App> {
        Arc::new(App {
            vehicles,
            core,
            footage: footage::State::default(),
            catalog,
            jobs: Jobs::start(0),
            state: RwLock::new(HashMap::new()),
            app_root,
            thumbnails,
        })
    }

    pub fn vehicle(&self, id: &str) -> Option<Vehicle> {
        self.vehicles.get(id)
    }

    pub fn state_of(&self, id: &str) -> Option<VehicleState> {
        self.state.read().unwrap().get(id).cloned()
    }

    /// vehicles.js studioRoot (kept a minute)
    pub fn studio_root(&self, v: &Vehicle) -> PathBuf {
        self.vehicles.studio_root(v)
    }

    /// Queue a scan of a vehicle (light: reuse unchanged folders). Returns whether it was queued.
    pub fn scan(self: &Arc<Self>, id: &str, light: bool) -> bool {
        let app = self.clone();
        let vid = id.to_string();
        self.jobs.submit(format!("scan:{id}"), Priority::High, move || {
            let _ = app.scan_now(&vid, light);
            app.core.announce("inventory");
        })
    }

    /// inventory.js scan, on this thread: a scan already running is waited for, not run twice.
    /// `light`: the background rescan (unchanged folders keep what they knew; every sixth is
    /// full); the first light scan after a start begins from the catalog's last scan of the
    /// same folder.
    pub fn scan_now(self: &Arc<Self>, vid: &str, light: bool) -> Res<VehicleState> {
        let v = self.vehicle(vid).ok_or_else(|| Fail::new(404, "No such vehicle."))?;
        if self.vehicles.share(vid).is_some_and(|s| !s.is_healthy()) {
            return Err(Fail::new(503, format!("{}: the share is not available.", v.name)));
        }
        let lock = self.footage.scan_lock(vid);
        let asked = lock.done.load(std::sync::atomic::Ordering::SeqCst);
        let _one = lock.running.lock().unwrap();
        if lock.done.load(std::sync::atomic::Ordering::SeqCst) != asked {
            // (one finished while this waited: its answer is this one's)
            return self.state_of(vid).ok_or_else(|| Fail::internal("no scan"));
        }
        let prev = {
            let mut st = self.state.write().unwrap();
            let e = st.entry(vid.to_string()).or_default();
            e.scanning = true;
            e.clone()
        };
        let root = v.root.to_string_lossy().into_owned();
        let mut lights = prev.light_scans;
        let mut resumed = false;
        let previous = if light && prev.scanned && lights < LIGHT_SCANS {
            Some(scanner::Previous { files: prev.file_list.clone(), dirs: (*prev.dirs).clone(), started_ms: None })
        } else if light && !prev.scanned {
            let p = self.catalog.resume(vid, &root).unwrap_or_else(|e| {
                self.core.log("inventory", Level::Warn, &format!("Footage catalog not read: {e}"));
                None
            });
            if p.is_some() {
                lights = 0;
                resumed = true;
            }
            p
        } else {
            None
        };
        let reuse = previous.is_some();
        let res = scanner::scan(&v.root, previous.as_ref(), SCAN_THREADS);
        drop(previous);
        let mut recs = inventory::build_recordings(&res.files, vid);
        inventory::mark_protected(&mut recs, &self.core.db().protected_set(vid));
        if let Err(e) = self.catalog.save_scan(vid, &root, &res) {
            self.core.log("inventory", Level::Warn, &format!("Footage catalog not updated: {e}"));
        }
        self.core.log("inventory", Level::Info, &format!("{}: {} recordings, {} files ({:.1}s{})", v.name, recs.len(), res.files.len(), res.duration_ms / 1000.0,
            if reuse { format!(", {} unchanged{}", res.reused, if resumed { " since the last run" } else { "" }) } else { String::new() }));
        let files = Arc::new(FileList::from(res.files));
        let codecs = self.codec_map(vid, &files);
        let entry = VehicleState {
            recordings: Arc::new(recs),
            generation: next_generation(),
            codecs: Arc::new(codecs),
            files: files.len(),
            scanned_at: Some(res.scanned_at),
            scanning: false,
            last_error: None,
            scanned: true,
            light_scans: if reuse { lights + 1 } else { 0 },
            error_count: res.errors.len(),
            file_list: files.clone(),
            dirs: Arc::new(res.dirs),
            started_at: res.started_at,
        };
        self.state.write().unwrap().insert(vid.to_string(), entry.clone());
        lock.done.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let app = self.clone();
        let id = vid.to_string();
        self.jobs.submit(format!("codecs:{vid}"), Priority::Normal, move || app.probe_codecs(&id));
        footage::integrity::resume(self, vid);
        Ok(entry)
    }

    /// inventory.js rebuild: the recordings again after files moved (trash, restore, protect),
    /// without a scan; the catalog follows.
    pub fn rebuild(&self, vid: &str, files: Option<Vec<FileEntry>>) {
        let protected = self.core.db().protected_set(vid);
        let mut st = self.state.write().unwrap();
        let Some(e) = st.get_mut(vid).filter(|e| e.scanned) else { return };
        if let Some(f) = files {
            e.file_list = Arc::new(FileList::from(f));
            e.files = e.file_list.len();
            e.codecs = Arc::new(e.codecs.remap(e.file_list.clone()));
        }
        let mut recs = inventory::build_recordings(&e.file_list, vid);
        inventory::mark_protected(&mut recs, &protected);
        e.recordings = Arc::new(recs);
        e.generation = next_generation();
        let list = e.file_list.clone();
        drop(st);
        if let Err(err) = self.catalog.sync_files(vid, &list) {
            self.core.log("inventory", Level::Warn, &format!("Footage catalog not updated: {err}"));
        }
    }

    fn codec_map(&self, vid: &str, list: &Arc<FileList>) -> Codecs {
        Codecs::new(list.clone(), self.catalog.codecs(vid).map(|m| m.into_iter().map(|(rel, (_, _, c))| (rel, c)).collect::<Vec<_>>()).unwrap_or_default())
    }

    /// Read the codec of every clip that is new or changed since it was last read; forget clips that are gone.
    /// Works on the newest file list, again if a scan replaces it meanwhile, and leaves its codecs as saved.
    fn probe_codecs(self: &Arc<Self>, vid: &str) {
        let Some(v) = self.vehicle(vid) else { return };
        let mut read_any = false;
        for _ in 0..4 {
            let list = self.state.read().unwrap().get(vid).map(|e| e.file_list.clone());
            let Some(list) = list else { return };
            let known = self.catalog.codecs(vid).unwrap_or_default();
            let gone: Vec<String> = known.keys().filter(|r| !list.contains_key(r)).cloned().collect();
            let todo: Vec<&FileEntry> = list
                .iter()
                .filter(|f| f.kind == footage::Kind::Clip && f.rel.to_lowercase().ends_with(".mp4"))
                .filter(|f| known.get(&f.rel).is_none_or(|(s, m, _)| *s != f.size || *m != f.mtime_ms))
                .collect();
            let read = par_each(&todo, PROBE_THREADS, |f| mp4::video_codec(&v.root.join(&f.rel)).ok().map(|c| (f.rel.clone(), f.size, f.mtime_ms, c)));
            let set: Vec<_> = read.into_iter().flatten().collect();
            let (codecs, known) = if set.is_empty() && gone.is_empty() {
                (Codecs::new(list.clone(), known.into_iter().map(|(rel, (_, _, c))| (rel, c))), None)
            } else {
                if let Err(e) = self.catalog.update_codecs(vid, &set, &gone) {
                    eprintln!("{}: saving clip codecs failed: {e}", v.name);
                }
                read_any |= !set.is_empty();
                (self.codec_map(vid, &list), Some(known))
            };
            // a newer list: the rows forgotten for this one that it still holds come back first
            let back: Option<Vec<_>> = match self.state.write().unwrap().get_mut(vid) {
                Some(e) if !Arc::ptr_eq(&e.file_list, &list) => Some(
                    known.map_or_else(Vec::new, |k| gone.iter().filter(|r| e.file_list.contains_key(r)).filter_map(|r| k.get(r).map(|(s, m, c)| (r.clone(), *s, *m, c.clone()))).collect()),
                ),
                Some(e) => {
                    e.codecs = Arc::new(codecs);
                    None
                }
                None => None,
            };
            let Some(back) = back else { break };
            if !back.is_empty() {
                if let Err(e) = self.catalog.update_codecs(vid, &back, &[]) {
                    eprintln!("{}: saving clip codecs failed: {e}", v.name);
                }
            }
        }
        if read_any {
            self.core.announce("inventory");
        }
        // (the speed index is the viewer area's: speeds in the Node server's day files)
    }
}
