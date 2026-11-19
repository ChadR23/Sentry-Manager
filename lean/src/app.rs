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
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

/// Clip codec reads at once without a running viewer (inventory.js limiter(this.codecChecks || 8)); scan threads (scanner.js concurrency 16).
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
        if let Err(e) = self.catalog.save_scan(vid, &root, &res) {
            self.core.log("inventory", Level::Warn, &format!("Footage catalog not updated: {e}"));
        }
        let (n_files, took, unchanged) = (res.files.len(), res.duration_ms, res.reused);
        let files = Arc::new(FileList::from(res.files));
        let mut recs = inventory::build_recordings(&files, vid);
        inventory::mark_protected(&mut recs, &self.core.db().protected_set(vid));
        self.core.log("inventory", Level::Info, &format!("{}: {} recordings, {} files ({:.1}s{})", v.name, recs.len(), n_files, took / 1000.0,
            if reuse { format!(", {} unchanged{}", unchanged, if resumed { " since the last run" } else { "" }) } else { String::new() }));
        let probe = self.adopt_saved_codecs(vid, &v.name);
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
        if probe {
            self.jobs.submit(format!("codecs:{vid}"), Priority::Normal, move || app.probe_codecs(&id));
        }
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

    /// inventory.js codecs(): the clip codecs an older server kept as one settings value
    /// (`codecs:<vehicle>`, rel -> [size, mtimeMs, codec]) move into the catalog, so none of those
    /// clips is read again: the rows the catalog lacks are added (its own rows are kept), then the
    /// value is deleted. False when the move failed: the value stays, and the codec probe waits
    /// for the next scan to finish the move instead of reading every clip.
    fn adopt_saved_codecs(&self, vid: &str, name: &str) -> bool {
        let key = format!("codecs:{vid}");
        let db = self.core.db();
        let Some(saved) = db.get(&key) else { return true };
        let rows = saved_codec_rows(&saved);
        // (no entry a server wrote: left as it is, as inventory.js does)
        if rows.is_empty() {
            return true;
        }
        match self.catalog.adopt_codecs(vid, &rows) {
            Ok(added) => {
                db.del(&key);
                if added > 0 {
                    self.core.log("inventory", Level::Info, &format!("{name}: {added} clip codecs kept from before"));
                }
                true
            }
            Err(e) => {
                self.core.log("inventory", Level::Warn, &format!("{name}: clip codecs kept from before not moved yet: {e}"));
                false
            }
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
            let save = |rows: &[(String, u64, f64, Option<String>)], gone: &[String]| match self.catalog.update_codecs(vid, rows, gone) {
                Ok(()) => true,
                Err(e) => {
                    eprintln!("{}: saving clip codecs failed: {e}", v.name);
                    false
                }
            };
            let slots = codec_slots(&v.root);
            let (n_read, rest) = read_saving(
                &todo,
                most_codec_checks(),
                &slots,
                crate::catalog::BATCH,
                |f| mp4::video_codec(&v.root.join(&f.rel)).ok().map(|c| (f.rel.clone(), f.size, f.mtime_ms, c)),
                |rows| save(rows, &[]),
            );
            let (codecs, known) = if n_read == 0 && gone.is_empty() {
                (Codecs::new(list.clone(), known.into_iter().map(|(rel, (_, _, c))| (rel, c))), None)
            } else {
                save(&rest, &gone);
                // (a save that failed after committing some of its 1,000-row chunks still changed the
                // catalog, and an extra announce only makes clients read the same rows again)
                read_any |= n_read > 0;
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

/// Clip codecs read at once now: index.js workLimit('codecChecks') as Settings > Advanced >
/// Background work has it (inventory.js's `|| 8` before the viewer runs), but see codec_limit.
fn codec_checks(spinning: bool) -> usize {
    let Some(v) = crate::viewer::get() else { return codec_limit(PROBE_THREADS as u32, false, spinning, false) };
    // (the limits' lock is let go before the pace's is taken)
    let (limit, set) = {
        let l = v.limits.read().unwrap();
        (l.get("codecChecks"), l.is_set("codecChecks"))
    };
    codec_limit(limit, set, spinning, v.pace.viewing())
}

/// One at a time while footage plays in the Viewer (as the speed index reads), and, unless an
/// admin set the number, when the footage is on a spinning disk: a check is a few small reads
/// at both ends of a file, so checks at once only add seeks there. On a USB hard drive, 8 at
/// once read 42 to 65 clips a second and 1 at once 66 to 73, and four videos read next to 8 at
/// once waited twice as long (p95 200 to 215 ms against 91 to 108 with 1).
fn codec_limit(limit: u32, set: bool, spinning: bool, viewing: bool) -> usize {
    if viewing || (spinning && !set) {
        1
    } else {
        limit.max(1) as usize
    }
}

/// Whether `path` is on a local spinning disk: sysfs calls its block device (or the disk a
/// partition is on) rotational. A network share, tmpfs, an SSD, or a device sysfs does not
/// show, is not.
fn on_spinning_disk(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).is_ok_and(|md| {
        let (major, minor) = dev_numbers(md.dev());
        rotational_in(Path::new("/sys"), major, minor)
    })
}

fn rotational_in(sys: &Path, major: u64, minor: u64) -> bool {
    if major == 0 {
        return false;
    }
    let Ok(dev) = std::fs::canonicalize(sys.join(format!("dev/block/{major}:{minor}"))) else { return false };
    [dev.join("queue/rotational"), dev.join("../queue/rotational")]
        .iter()
        .find_map(|q| std::fs::read_to_string(q).ok())
        .is_some_and(|s| s.trim() == "1")
}

/// A Linux dev_t's major and minor numbers (glibc gnu_dev_major and gnu_dev_minor).
fn dev_numbers(dev: u64) -> (u64, u64) {
    let major = ((dev >> 8) & 0xfff) | (((dev >> 32) as u32 & !0xfff) as u64);
    let minor = (dev & 0xff) | (((dev >> 12) as u32 & !0xff) as u64);
    (major, minor)
}

/// The codec checks of every vehicle on one disk share one limit, so two vehicles on the same
/// drive do not each read while footage plays (or each add seeks on a spinning disk).
fn codec_slots(root: &Path) -> Arc<crate::viewer::telemetry_api::Limiter> {
    use std::os::unix::fs::MetadataExt;
    static SLOTS: std::sync::OnceLock<Mutex<std::collections::HashMap<u64, Arc<crate::viewer::telemetry_api::Limiter>>>> = std::sync::OnceLock::new();
    let dev = std::fs::metadata(root).map_or(0, |m| m.dev());
    let mut slots = SLOTS.get_or_init(Default::default).lock().unwrap();
    slots
        .entry(dev)
        .or_insert_with(|| {
            let spinning = on_spinning_disk(root);
            crate::viewer::telemetry_api::Limiter::new(move || codec_checks(spinning))
        })
        .clone()
}

/// The most codecChecks may be set to (workLimits.js MAX).
fn most_codec_checks() -> usize {
    use crate::viewer::work_limits::{KEYS, MAX};
    KEYS.iter().zip(MAX).find(|(k, _)| **k == "codecChecks").map_or(PROBE_THREADS, |(_, n)| n as usize)
}

/// inventory.js's codec pass: at most as many reads at once as `slots` allows (its limit read again
/// for each item, scanner.js limiter), and what was read saved every `batch` rows as it comes, so a
/// restart halfway through keeps it (rows whose save fails wait until another `batch` rows have
/// been read, or for the caller). How many were read, and the rows not saved yet.
fn read_saving<T: Sync, R: Send>(
    items: &[T],
    threads: usize,
    slots: &crate::viewer::telemetry_api::Limiter,
    batch: usize,
    read: impl Fn(&T) -> Option<R> + Sync,
    save: impl Fn(&[R]) -> bool + Sync,
) -> (usize, Vec<R>) {
    // rows not saved yet, and how many came since the last save was tried
    let pending = Mutex::new((Vec::new(), 0usize));
    let done = std::sync::atomic::AtomicUsize::new(0);
    par_each(items, threads, |item| {
        let got = {
            let _slot = slots.take();
            read(item)
        };
        let Some(row) = got else { return };
        done.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let full = {
            let mut p = pending.lock().unwrap();
            p.0.push(row);
            p.1 += 1;
            (p.1 >= batch.max(1)).then(|| {
                p.1 = 0;
                std::mem::take(&mut p.0)
            })
        };
        if let Some(rows) = full {
            if !save(&rows) {
                pending.lock().unwrap().0.extend(rows);
            }
        }
    });
    (done.into_inner(), pending.into_inner().unwrap().0)
}

/// The rows of a `codecs:<vehicle>` value: rel -> [size, mtimeMs, codec or null], as Node wrote
/// them (an entry of another shape is left out, so its clip is read).
fn saved_codec_rows(saved: &Value) -> Vec<(String, u64, f64, Option<String>)> {
    let Some(m) = saved.as_object() else { return Vec::new() };
    m.iter()
        .filter_map(|(rel, v)| match v.as_array().map(Vec::as_slice) {
            Some([size, mtime, codec]) => Some((
                rel.clone(),
                size.as_u64()?,
                mtime.as_f64()?,
                match codec {
                    Value::Null => None,
                    Value::String(c) => Some(c.clone()),
                    _ => return None,
                },
            )),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn codec_reads_never_run_more_at_once_than_the_limit() {
        for limit in [1usize, 3] {
            let (now, most) = (AtomicUsize::new(0), AtomicUsize::new(0));
            let items: Vec<usize> = (0..40).collect();
            let (n, rest) = read_saving(
                &items,
                32,
                &crate::viewer::telemetry_api::Limiter::new(move || limit),
                1000,
                |i| {
                    most.fetch_max(now.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(2));
                    now.fetch_sub(1, Ordering::SeqCst);
                    Some(*i)
                },
                |_| panic!("fewer rows than a batch are left to the caller"),
            );
            let mut rest = rest;
            rest.sort();
            assert_eq!(n, items.len());
            assert_eq!(rest, items, "fewer rows than a batch all come back unsaved");
            assert!(most.load(Ordering::SeqCst) <= limit, "{} at once with a limit of {limit}", most.load(Ordering::SeqCst));
        }
    }

    #[test]
    fn codecs_read_are_saved_every_batch_as_they_come_and_a_clip_not_read_is_not_saved() {
        let started = AtomicUsize::new(0);
        let saves: Mutex<Vec<(Vec<usize>, usize)>> = Mutex::new(Vec::new());
        let items: Vec<usize> = (0..37).collect();
        let (n, rest) = read_saving(
            &items,
            32,
            &crate::viewer::telemetry_api::Limiter::new(|| 2),
            10,
            |i| {
                started.fetch_add(1, Ordering::SeqCst);
                (i % 9 != 4).then_some(*i)
            },
            |rows| {
                saves.lock().unwrap().push((rows.to_vec(), started.load(Ordering::SeqCst)));
                true
            },
        );
        let saves = saves.into_inner().unwrap();
        let read: Vec<usize> = items.iter().copied().filter(|i| i % 9 != 4).collect();
        assert_eq!(n, read.len());
        assert_eq!(saves.iter().map(|(rows, _)| rows.len()).collect::<Vec<_>>(), vec![10, 10, 10]);
        assert!(saves[0].1 < items.len(), "the first rows were saved while clips were still being read");
        let mut saved: Vec<usize> = saves.iter().flat_map(|(rows, _)| rows.iter().copied()).chain(rest.iter().copied()).collect();
        saved.sort();
        assert_eq!(saved, read, "every row read is saved once, the last ones by the caller");
        assert_eq!(rest.len(), 3);
    }

    #[test]
    fn rows_whose_save_failed_are_saved_with_a_later_batch() {
        let calls = AtomicUsize::new(0);
        let saved: Mutex<Vec<usize>> = Mutex::new(Vec::new());
        let failed: Mutex<Vec<usize>> = Mutex::new(Vec::new());
        let items: Vec<usize> = (0..25).collect();
        // (one thread: a failed batch is back in the queue before the next row is read)
        let (n, rest) = read_saving(&items, 1, &crate::viewer::telemetry_api::Limiter::new(|| 1), 10, |i| Some(*i), |rows| {
            if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                failed.lock().unwrap().extend_from_slice(rows);
                return false;
            }
            saved.lock().unwrap().extend_from_slice(rows);
            true
        });
        assert_eq!(n, 25);
        assert_eq!(calls.load(Ordering::SeqCst), 2, "tried again only after another full batch, not on every read");
        let failed = failed.into_inner().unwrap();
        let mut all = saved.into_inner().unwrap();
        assert_eq!(failed.len(), 10);
        assert!(failed.iter().all(|r| all.contains(r)), "the rows of the failed save went out with a later one");
        all.extend(rest);
        all.sort();
        assert_eq!(all, items, "every row read is saved once or handed back");
    }

    #[test]
    fn a_kept_codec_list_gives_its_rows_and_leaves_out_entries_of_another_shape() {
        let v = json!({
            "a.mp4": [10, 1700000000123.456, "h265"],
            "b.mp4": [20, 1700000000000u64, null],
            "c.mp4": [30, 1.0],
            "d.mp4": ["30", 1.0, "h264"],
            "e.mp4": [30, 1.0, 5],
            "f.mp4": { "size": 1 },
            "g.mp4": [-1, 1.0, "h264"]
        });
        let mut rows = saved_codec_rows(&v);
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(rows, vec![("a.mp4".to_string(), 10, 1700000000123.456, Some("h265".to_string())), ("b.mp4".to_string(), 20, 1700000000000.0, None)]);
        assert!(saved_codec_rows(&json!([1, 2, 3])).is_empty());
    }

    #[test]
    fn codec_checks_follow_the_work_limits_and_their_maximum() {
        assert_eq!(most_codec_checks(), 32);
        if crate::viewer::get().is_none() {
            assert_eq!(codec_checks(false), PROBE_THREADS);
            assert_eq!(codec_checks(true), 1);
        }
    }

    #[test]
    fn one_codec_read_at_a_time_while_footage_plays_or_on_a_spinning_disk_nobody_tuned() {
        assert_eq!(codec_limit(8, false, false, false), 8);
        assert_eq!(codec_limit(8, false, false, true), 1, "footage playing");
        assert_eq!(codec_limit(8, false, true, false), 1, "spinning disk");
        assert_eq!(codec_limit(6, true, true, false), 6, "an admin's number wins on a spinning disk");
        assert_eq!(codec_limit(6, true, true, true), 1, "but not while footage plays");
        assert_eq!(codec_limit(0, true, false, false), 1);
    }

    #[test]
    fn dev_numbers_as_glibc_splits_them() {
        assert_eq!(dev_numbers(0x830), (8, 48));
        assert_eq!(dev_numbers(0x10301), (259, 1));
        assert_eq!(dev_numbers(0x11ff2c), (511, 300));
        assert_eq!(dev_numbers(0x1000_0002_3400), (0x1234, 0), "a major past 12 bits");
    }

    #[test]
    fn a_disk_or_its_partition_is_spinning_when_sysfs_says_rotational() {
        let sys = std::env::temp_dir().join(format!("sysfs-{}", std::process::id()));
        let disk = sys.join("devices/usb/sdd");
        std::fs::create_dir_all(disk.join("queue")).unwrap();
        std::fs::create_dir_all(disk.join("sdd1")).unwrap();
        std::fs::write(disk.join("queue/rotational"), "1\n").unwrap();
        let ssd = sys.join("devices/pci/nvme0n1");
        std::fs::create_dir_all(ssd.join("queue")).unwrap();
        std::fs::write(ssd.join("queue/rotational"), "0\n").unwrap();
        std::fs::create_dir_all(sys.join("dev/block")).unwrap();
        std::os::unix::fs::symlink(&disk, sys.join("dev/block/8:48")).unwrap();
        std::os::unix::fs::symlink(disk.join("sdd1"), sys.join("dev/block/8:49")).unwrap();
        std::os::unix::fs::symlink(&ssd, sys.join("dev/block/259:0")).unwrap();
        assert!(rotational_in(&sys, 8, 48));
        assert!(rotational_in(&sys, 8, 49), "a partition: the disk it is on");
        assert!(!rotational_in(&sys, 259, 0));
        assert!(!rotational_in(&sys, 0, 51), "a network share or tmpfs");
        assert!(!rotational_in(&sys, 7, 7), "a device sysfs does not show");
        assert!(!on_spinning_disk(Path::new("/no/such/footage")));
        std::fs::remove_dir_all(sys).unwrap();
    }
}
