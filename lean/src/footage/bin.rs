//! The Recycle Bin (a port of server/recycleBin.js). "Move to trash" renames
//! a recording's files into <vehicle root>/.sentry-recycle-bin/<item>/<path>.binned,
//! a rename on the same share. Nothing here deletes on its own: files only
//! go when someone deletes them for good or empties the bin (or the policy's
//! "empty after N days" does).
//!
//! The same safety order as Node: the item is written to the database with
//! its files pending before the first file moves (a crash leaves a record
//! that `reconcile` settles); protection is read again under the vehicle's
//! lock right before a recording moves, and a clip a conversion has in hand
//! is refused; every folder is made and every file moved through safe_fs
//! (no symlink followed out of the share); whatever moved is put back when
//! one file fails, so a recording is never split.

use super::ctx::{Fail, Level, Res};
use super::mdb::{BinFile, BinItem};
use super::safe_fs::{self, safe_join};
use super::share::errno_name;
use crate::app::{App, Vehicle};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const BIN_DIR: &str = ".sentry-recycle-bin";

/// formatBytes: "3.2 MiB" (toFixed(1), "12 B")
pub fn format_bytes(n: f64) -> String {
    let u = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut i = 0;
    let mut v = n;
    while v >= 1024.0 && i < u.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 { format!("{} {}", v.round(), u[0]) } else { format!("{:.1} {}", (v * 10.0).round() / 10.0, u[i]) }
}

fn is_junk(n: &str) -> bool {
    let l = n.to_lowercase();
    (n.starts_with("._") && n.len() > 2) || l == ".ds_store" || l == "thumbs.db" || l == "desktop.ini"
}

fn dirname(rel: &str) -> &str {
    rel.rfind('/').map_or(".", |i| &rel[..i])
}

/// recycleBin.js isKeptDir: the root, its direct children and the clip folders stay.
pub fn is_kept_dir(rel: &str) -> bool {
    if rel.is_empty() || rel == "." || !rel.contains('/') {
        return true;
    }
    let name = rel.rsplit('/').next().unwrap_or("").to_lowercase();
    matches!(name.as_str(), "recentclips" | "sentryclips" | "savedclips" | "teslacam" | "teslausb")
}

/// rmdir the folders left empty under root, deepest first, never recursively.
pub fn remove_empty_dirs(root: &Path, rels: &[String], keep: &dyn Fn(&str) -> bool) {
    let mut dirs: Vec<String> = Vec::new();
    for rel in rels {
        let mut d = dirname(rel);
        while !d.is_empty() && d != "." && !keep(d) {
            if !dirs.iter().any(|x| x == d) {
                dirs.push(d.to_string());
            }
            d = dirname(d);
        }
    }
    dirs.sort_by_key(|d| std::cmp::Reverse(d.split('/').count()));
    for d in dirs {
        let Ok(abs) = safe_join(root, &d) else { continue };
        let Ok(list) = std::fs::read_dir(&abs) else { continue };
        let names: Vec<String> = list.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        if !names.is_empty() && names.iter().all(|n| is_junk(n)) {
            for n in &names {
                let _ = safe_fs::unlink_inside(root, &abs.join(n));
            }
        }
        let _ = safe_fs::rmdir_inside(root, &abs);
    }
}

fn exists(p: &Path) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

/// An error as Node's message says it ("ENOENT: no such file or directory, rename 'a' -> 'b'").
fn io_message(e: &std::io::Error, call: &str, a: &Path, b: Option<&Path>) -> String {
    match e.raw_os_error() {
        Some(n) => {
            let text = std::io::Error::from_raw_os_error(n).to_string();
            let text = text.split(" (os error").next().unwrap_or(&text).to_lowercase();
            match b {
                Some(b) => format!("{}: {text}, {call} '{}' -> '{}'", errno_name(n), a.display(), b.display()),
                None => format!("{}: {text}, {call} '{}'", errno_name(n), a.display()),
            }
        }
        None => e.to_string(),
    }
}

fn skip_words(reason: &str) -> Option<&'static str> {
    match reason {
        "protected" => Some("protected"),
        "converting" => Some("being converted right now"),
        "missing" => Some("a file is no longer there (refresh the inventory)"),
        "error" => Some("could not be moved"),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Skip {
    pub id: String,
    pub reason: &'static str,
    pub message: Option<String>,
}

/// skipWhy: "3 protected, 1 could not be moved (EACCES: ...)"
pub fn skip_why(skipped: &[Skip]) -> String {
    let mut by: Vec<(&str, usize, Option<String>)> = Vec::new();
    for s in skipped {
        let k = if skip_words(s.reason).is_some() { s.reason } else { "error" };
        match by.iter_mut().find(|b| b.0 == k) {
            Some(b) => b.1 += 1,
            None => by.push((k, 1, s.message.clone())),
        }
    }
    by.iter()
        .map(|(k, n, m)| {
            let extra = match (k, m) {
                (&"error", Some(m)) if !m.is_empty() => format!(" ({})", super::js::slice16(m, 160)),
                _ => String::new(),
            };
            format!("{n} {}{extra}", skip_words(k).unwrap())
        })
        .collect::<Vec<_>>()
        .join(", ")
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Trashed {
    pub moved: Vec<String>,
    pub skipped: Vec<Skip>,
    pub bytes: u64,
}

impl Trashed {
    pub fn json(&self) -> Value {
        json!({
            "moved": self.moved,
            "skipped": self.skipped.iter().map(|s| {
                let mut v = json!({ "id": s.id, "reason": s.reason });
                if let Some(m) = &s.message { v["message"] = json!(m); }
                v
            }).collect::<Vec<_>>(),
            "bytes": self.bytes
        })
    }
}

/// Run `f` holding the vehicle's lock (shared by protect and trash).
pub fn with_lock<T>(app: &App, vid: &str, f: impl FnOnce() -> T) -> T {
    let lock = app.footage.bin_lock(vid);
    let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
    f()
}

/// Protect or unprotect files, never in the middle of moving one of their recordings.
pub fn set_protected(app: &App, vid: &str, rels: &[String], on: bool) {
    with_lock(app, vid, || app.core.db().set_protected(vid, rels, on));
}

/// recycleBin.js rootOf: the vehicle and its folder, refused while its share is not writable.
fn root_of(app: &App, vid: &str) -> Res<(Vehicle, PathBuf)> {
    let v = app.vehicle(vid).ok_or_else(|| Fail::new(404, "No such vehicle."))?;
    if app.vehicles.share(vid).is_some_and(|s| !s.is_writable()) {
        return Err(Fail::new(503, format!("{}: the share is not writable right now.", v.name)));
    }
    let root = v.root.clone();
    Ok((v, root))
}

fn log(app: &App, level: Level, line: &str) {
    app.core.log("bin", level, line);
}

fn item_id() -> String {
    format!("{}-{}", crate::media::base36(super::js::now() as u64), super::random_hex(4))
}

/// Move recordings to the bin. Protected or busy recordings are refused.
pub fn trash(app: &Arc<App>, vid: &str, ids: &[String], reason: &str) -> Res<Trashed> {
    let (vehicle, root) = root_of(app, vid)?;
    let inv = app.state_of(vid).filter(|s| s.scanned).ok_or_else(|| Fail::new(409, "Footage has not been scanned yet."))?;
    // (the recordings of the footage the vehicle had before are not paths in this one)
    if inv.root != vehicle.source_key() {
        return Err(Fail::new(409, "The footage folder changed and has not been scanned yet."));
    }
    let wanted: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let recordings: Vec<_> = inv.recordings.iter().filter(|r| wanted.contains(r.id.as_str())).cloned().collect();
    let sizes: std::collections::HashMap<&str, u64> = inv.file_list.iter().map(|f| (f.rel.as_str(), f.size)).collect();
    let mut result = Trashed::default();
    let job = app.core.job_start(if reason == "policy" { "policy" } else { "trash" }, Some(vid), &format!("Move {} recording(s) to the Recycle Bin", recordings.len()));
    let real_root = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
    let mut gone: HashSet<String> = HashSet::new();
    for rec in &recordings {
        let rels: Vec<String> = rec.files().map(|(r, _)| r.to_string()).collect();
        with_lock(app, vid, || {
            // the footage source again: a vehicle moved to another while this ran has other files here
            if app.vehicle(vid).map(|v| v.source_key()).as_deref() != Some(inv.root.as_str()) {
                result.skipped.push(Skip { id: rec.id.clone(), reason: "error", message: Some("the footage folder changed".into()) });
                return;
            }
            // protection is read again here: it may have been set after this run started
            let protected = app.core.db().protected_set(vid);
            if rec.protected || rels.iter().any(|r| protected.contains(r)) {
                result.skipped.push(Skip { id: rec.id.clone(), reason: "protected", message: None });
                return;
            }
            // only a clip a conversion is working on right now; a queued one may go
            let in_hand = app.core.busy_paths();
            if !in_hand.is_empty() && rels.iter().any(|r| in_hand.contains(&root.join(r)) || in_hand.contains(&real_root.join(r))) {
                result.skipped.push(Skip { id: rec.id.clone(), reason: "converting", message: None });
                return;
            }
            let id = item_id();
            let planned: Vec<BinFile> = rels.iter().map(|rel| BinFile { rel: rel.clone(), bin_rel: format!("{BIN_DIR}/{id}/{rel}.binned"), size: sizes.get(rel.as_str()).copied().unwrap_or(0), pending: true, conflict: false }).collect();
            let label = format!("{} {}", rec.category, rec.start.clone().unwrap_or_default()).trim().to_string();
            let record = BinItem {
                id: id.clone(), vehicle_id: vid.to_string(), label, category: rec.category.to_string(), start_at: rec.start.clone(),
                bytes: planned.iter().map(|f| f.size).sum(), files: planned.clone(), trashed_at: super::js::now().trunc(), reason: reason.to_string(),
            };
            app.core.db().add_bin_item(&record);
            let mut moved: Vec<BinFile> = Vec::new();
            let step = |f: &BinFile, moved: &mut Vec<BinFile>| -> std::io::Result<()> {
                let from = safe_join(&root, &f.rel)?;
                let to = safe_join(&root, &f.bin_rel)?;
                safe_fs::mkdirp_inside(&root, to.parent().unwrap_or(&root))?;
                let size = match sizes.get(f.rel.as_str()) {
                    Some(s) => *s,
                    None => std::fs::symlink_metadata(&from).map_err(|e| std::io::Error::new(e.kind(), io_message(&e, "lstat", &from, None)))?.len(),
                };
                safe_fs::rename_inside(&root, &from, &to).map_err(|e| if safe_fs::is_escape(&e) { e } else { std::io::Error::new(e.kind(), io_message(&e, "rename", &from, Some(&to))) })?;
                moved.push(BinFile { rel: f.rel.clone(), bin_rel: f.bin_rel.clone(), size, pending: false, conflict: false });
                Ok(())
            };
            let failed = planned.iter().find_map(|f| step(f, &mut moved).err());
            if let Some(err) = failed {
                // put back whatever moved so a recording is never split
                for m in moved.iter().rev() {
                    if let (Ok(a), Ok(b)) = (safe_join(&root, &m.bin_rel), safe_join(&root, &m.rel)) {
                        let _ = safe_fs::rename_inside(&root, &a, &b);
                    }
                }
                if let Ok(dir) = safe_join(&root, &format!("{BIN_DIR}/{id}")) {
                    let _ = safe_fs::rmrf_inside(&root, &dir);
                }
                app.core.db().remove_bin_item(&id);
                let missing = err.kind() == std::io::ErrorKind::NotFound;
                result.skipped.push(Skip { id: rec.id.clone(), reason: if missing { "missing" } else { "error" }, message: Some(err.to_string()) });
                return;
            }
            let bytes = moved.iter().map(|m| m.size).sum();
            app.core.db().update_bin_files(&id, &moved, bytes);
            gone.extend(moved.iter().map(|m| m.rel.clone()));
            // (a scan of this source walking now does not put them back)
            app.footage.scan_lock(vid).moved.lock().unwrap().extend(moved.iter().map(|m| (inv.root.clone(), m.rel.clone())));
            result.moved.push(rec.id.clone());
            result.bytes += bytes;
            remove_empty_dirs(&root, &rels, &is_kept_dir);
        });
    }
    // (rebuild_without leaves in a file restored while this ran)
    if !gone.is_empty() {
        app.rebuild_without(vid, &gone, &inv.root);
    }
    let failed = result.skipped.iter().any(|s| s.reason == "error");
    let skipped = if result.skipped.is_empty() { String::new() } else { format!(", {} skipped: {}", result.skipped.len(), skip_why(&result.skipped)) };
    app.core.job_finish(job, if failed { "failed" } else { "done" }, &format!("{} moved ({}){skipped}", result.moved.len(), format_bytes(result.bytes as f64)), Some(result.json()));
    if !result.skipped.is_empty() {
        log(app, Level::Warn, &format!("{}: {} recording(s) not moved to the Recycle Bin: {}", vehicle.name, result.skipped.len(), skip_why(&result.skipped)));
    }
    log(app, Level::Info, &format!("{}: {} recording(s) moved to the Recycle Bin ({reason})", vehicle.name, result.moved.len()));
    Ok(result)
}

/// A readable thumbnail of a bin item, without needing write access: ("image" | "clip", path).
pub fn thumbnail_source(app: &App, item_id: &str) -> Option<(&'static str, PathBuf)> {
    let item = app.core.db().bin_item(item_id)?;
    let v = app.vehicle(&item.vehicle_id)?;
    let root = &v.root;
    let item_root = safe_join(root, &format!("{BIN_DIR}/{}", item.id)).ok()?;
    let real_item = std::fs::canonicalize(&item_root).ok()?;
    let real_root = std::fs::canonicalize(root).ok()?;
    let real_bin = std::fs::canonicalize(root.join(BIN_DIR)).ok()?;
    if !real_bin.starts_with(&real_root) || real_bin == real_root || !real_item.starts_with(&real_bin) || real_item == real_bin {
        return None;
    }
    let lower = |f: &BinFile| f.rel.to_lowercase();
    let thumbs = item.files.iter().filter(|f| lower(f) == "thumb.png" || lower(f).ends_with("/thumb.png"));
    let fronts = item.files.iter().filter(|f| lower(f).ends_with("-front.mp4"));
    for f in thumbs.chain(fronts) {
        if f.pending || !f.bin_rel.starts_with(&format!("{BIN_DIR}/{}/", item.id)) {
            continue;
        }
        let Some(abs) = safe_join(root, &f.bin_rel).ok().and_then(|p| std::fs::canonicalize(p).ok()) else { continue };
        if !abs.starts_with(&real_item) || abs == real_item {
            continue;
        }
        if !std::fs::metadata(&abs).is_ok_and(|m| m.is_file()) {
            continue;
        }
        return Some((if lower(f).ends_with("thumb.png") { "image" } else { "clip" }, abs));
    }
    None
}

pub fn list(app: &App, vid: Option<&str>) -> Vec<Value> {
    app.core.db().bin_items(vid).iter().map(BinItem::json).collect()
}

pub fn bin_bytes(app: &App, vid: &str) -> u64 {
    app.core.db().bin_items(Some(vid)).iter().map(|i| i.bytes).sum()
}

fn walk_binned(root: &Path, rel_dir: &str, item_prefix: &str, out: &mut Vec<BinFile>) {
    let Ok(abs) = safe_join(root, rel_dir) else { return };
    let Ok(list) = std::fs::read_dir(abs) else { return };
    let mut entries: Vec<_> = list.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        let rel = format!("{rel_dir}/{name}");
        let Ok(t) = e.file_type() else { continue };
        if t.is_dir() {
            walk_binned(root, &rel, item_prefix, out);
        } else if t.is_file() && name.ends_with(".binned") {
            if let Some(st) = safe_join(root, &rel).ok().and_then(|p| std::fs::symlink_metadata(p).ok()) {
                let orig = rel[item_prefix.len()..rel.len() - ".binned".len()].to_string();
                out.push(BinFile { rel: orig, bin_rel: rel.clone(), size: st.len(), pending: false, conflict: false });
            }
        }
    }
}

fn adoptable(name: &str) -> bool {
    let Some((a, b)) = name.split_once('-') else { return false };
    !a.is_empty() && a.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) && b.len() == 8 && b.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// After a restart: finish items a crash interrupted (keep what moved, drop what did not)
/// and list bin folders the database does not know. (fixed, adopted)
pub fn reconcile(app: &App, vid: &str) -> Res<(usize, usize)> {
    let (_, root) = root_of(app, vid)?;
    let db = app.core.db();
    Ok(with_lock(app, vid, || {
        let mut fixed = 0;
        let mut adopted = 0;
        for item in db.bin_items(Some(vid)) {
            if !item.files.iter().any(|f| f.pending) {
                continue;
            }
            let moved: Vec<BinFile> = item.files.iter().filter_map(|f| {
                let st = safe_join(&root, &f.bin_rel).ok().and_then(|p| std::fs::symlink_metadata(p).ok())?;
                st.is_file().then(|| BinFile { rel: f.rel.clone(), bin_rel: f.bin_rel.clone(), size: st.len(), pending: false, conflict: false })
            }).collect();
            if moved.is_empty() {
                db.remove_bin_item(&item.id);
            } else {
                db.update_bin_files(&item.id, &moved, moved.iter().map(|m| m.size).sum());
            }
            fixed += 1;
        }
        let known: HashSet<String> = db.bin_items(Some(vid)).into_iter().map(|i| i.id).collect();
        let bin_root = safe_join(&root, BIN_DIR).unwrap_or_else(|_| root.join(BIN_DIR));
        let mut dirs: Vec<_> = std::fs::read_dir(&bin_root).map(|l| l.flatten().collect()).unwrap_or_default();
        dirs.sort_by_key(|e: &std::fs::DirEntry| e.file_name());
        for ent in dirs {
            let name = ent.file_name().to_string_lossy().into_owned();
            if !ent.file_type().is_ok_and(|t| t.is_dir()) || known.contains(&name) || !adoptable(&name) {
                continue;
            }
            let mut files = Vec::new();
            let prefix = format!("{BIN_DIR}/{name}/");
            walk_binned(&root, &format!("{BIN_DIR}/{name}"), &prefix, &mut files);
            if files.is_empty() {
                if let Ok(d) = safe_join(&root, &format!("{BIN_DIR}/{name}")) {
                    let _ = safe_fs::rmrf_inside(&root, &d);
                }
                continue;
            }
            let first = files[0].rel.to_lowercase();
            let category = if first.contains("sentryclips") { "Sentry" } else if first.contains("savedclips") { "Saved" } else if first.contains("recentclips") { "Recent" } else { "Other" };
            db.add_bin_item(&BinItem {
                id: name.clone(), vehicle_id: vid.to_string(), label: format!("{category} (recovered after a restart)"), category: category.into(), start_at: None,
                bytes: files.iter().map(|f| f.size).sum(), files, trashed_at: super::js::now().trunc(), reason: "recovered".into(),
            });
            adopted += 1;
        }
        if fixed > 0 || adopted > 0 {
            log(app, Level::Warn, &format!("Recycle Bin: settled {fixed} interrupted move(s), recovered {adopted} unlisted item(s)"));
        }
        (fixed, adopted)
    }))
}

fn not_in_bin() -> Fail {
    Fail::new(404, "Not in the Recycle Bin.")
}

fn still_moving() -> Fail {
    Fail::new(409, "This item is still being moved to the Recycle Bin.")
}

/// Put an item back where it was; files whose spot is taken stay in the bin.
/// { restored, conflicts }; a full scan follows in the background.
pub fn restore(app: &Arc<App>, item_id: &str) -> Res<Value> {
    let item = app.core.db().bin_item(item_id).ok_or_else(not_in_bin)?;
    let vid = item.vehicle_id.clone();
    let out = with_lock(app, &vid, || -> Res<(usize, usize)> {
        let item = app.core.db().bin_item(item_id).ok_or_else(not_in_bin)?;
        if item.files.iter().any(|f| f.pending) {
            return Err(still_moving());
        }
        let (vehicle, root) = root_of(app, &item.vehicle_id)?;
        let mut left: Vec<BinFile> = Vec::new();
        let mut restored = 0;
        let mut back: Vec<String> = Vec::new();
        for f in &item.files {
            let (Ok(from), Ok(to)) = (safe_join(&root, &f.bin_rel), safe_join(&root, &f.rel)) else {
                left.push(BinFile { conflict: true, ..f.clone() });
                continue;
            };
            if !exists(&from) {
                continue;
            }
            if exists(&to) {
                left.push(BinFile { conflict: true, ..f.clone() });
                continue;
            }
            // following no symlink out of the share (safe_fs)
            let r = safe_fs::mkdirp_inside(&root, to.parent().unwrap_or(&root)).and_then(|_| safe_fs::rename_inside(&root, &from, &to));
            if let Err(e) = r {
                log(app, Level::Warn, &format!("Restore of {} refused: {}", f.rel, if safe_fs::is_escape(&e) { e.to_string() } else { io_message(&e, "rename", &from, Some(&to)) }));
                left.push(BinFile { conflict: true, ..f.clone() });
                continue;
            }
            restored += 1;
            back.push(f.rel.clone());
        }
        if left.is_empty() {
            app.core.db().remove_bin_item(item_id);
        } else {
            app.core.db().update_bin_files(item_id, &left, left.iter().map(|f| f.size).sum());
        }
        let bin_rels: Vec<String> = item.files.iter().map(|f| f.bin_rel.clone()).collect();
        remove_empty_dirs(&root, &bin_rels, &|d| d == BIN_DIR || is_kept_dir(d));
        // (under the bin lock: a scan walking now does not leave them out as moved, and a scan that
        // walked before this restore is not taken as the answer by one that waited)
        let lock = app.footage.scan_lock(&item.vehicle_id);
        let source = vehicle.source_key();
        lock.moved.lock().unwrap().retain(|(s, r)| !(*s == source && back.contains(r)));
        lock.restores.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let job = app.core.job_start("restore", Some(&item.vehicle_id), &format!("Restore {}", item.label));
        let detail = format!("{restored} file(s) restored{}", if left.is_empty() { String::new() } else { format!(", {} could not (a file with that name exists)", left.len()) });
        app.core.job_finish(job, if left.is_empty() { "done" } else { "failed" }, &detail, None);
        Ok((restored, left.len()))
    })?;
    // the files are back: a full scan (as inventory.scan(id)), in the background, that walks after
    // they are (not one that began before)
    let a = app.clone();
    let v = vid.clone();
    std::thread::spawn(move || {
        let _ = a.scan_fresh(&v, false);
        a.core.announce("inventory");
    });
    Ok(json!({ "restored": out.0, "conflicts": out.1 }))
}

/// Delete one item for good (someone's action, or the bin emptied after N days). { bytes }
pub fn delete_forever(app: &App, item_id: &str) -> Res<u64> {
    let item = app.core.db().bin_item(item_id).ok_or_else(not_in_bin)?;
    let vid = item.vehicle_id.clone();
    with_lock(app, &vid, || {
        let item = app.core.db().bin_item(item_id).ok_or_else(not_in_bin)?;
        if item.files.iter().any(|f| f.pending) {
            return Err(still_moving());
        }
        let (_, root) = root_of(app, &item.vehicle_id)?;
        let mut bytes = 0;
        for f in &item.files {
            let target = safe_join(&root, &f.bin_rel).map_err(|e| Fail::internal(e.to_string()))?;
            match safe_fs::unlink_inside(&root, &target) {
                Ok(()) => bytes += f.size,
                Err(e) if e.raw_os_error() == Some(libc::ENOENT) => {}
                Err(e) if safe_fs::is_escape(&e) => return Err(Fail::new(403, e.to_string())),
                Err(e) => return Err(Fail::internal(io_message(&e, "unlink", &target, None))),
            }
        }
        let dir = safe_join(&root, &format!("{BIN_DIR}/{item_id}")).map_err(|e| Fail::internal(e.to_string()))?;
        safe_fs::rmrf_inside(&root, &dir).map_err(|e| Fail::internal(e.to_string()))?;
        app.core.db().remove_bin_item(item_id);
        let rels: Vec<String> = item.files.iter().map(|f| f.rel.clone()).collect();
        super::deleted_clips::add(app.core.db(), &item.vehicle_id, &rels, super::js::now());
        // every delete for good comes here (by hand, emptying the bin, the bin emptied after N days)
        app.core.on_deleted(&item.vehicle_id, &item.json());
        Ok(bytes)
    })
}

/// Empty the bin (of one vehicle, or all): { deleted, failed, bytes }
pub fn empty(app: &App, vid: Option<&str>) -> Value {
    let items = app.core.db().bin_items(vid);
    let job = app.core.job_start("empty-bin", vid, &format!("Empty the Recycle Bin ({} item(s))", items.len()));
    let mut bytes = 0;
    let mut failed = 0;
    for item in &items {
        match delete_forever(app, &item.id) {
            Ok(b) => bytes += b,
            Err(e) => {
                failed += 1;
                log(app, Level::Warn, &format!("Could not delete {}: {}", item.label, e.message));
            }
        }
    }
    let detail = format!("{} freed{}", format_bytes(bytes as f64), if failed > 0 { format!(", {failed} failed") } else { String::new() });
    app.core.job_finish(job, if failed > 0 { "failed" } else { "done" }, &detail, None);
    json!({ "deleted": items.len() - failed, "failed": failed, "bytes": bytes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words() {
        assert_eq!(format_bytes(12.0), "12 B");
        assert_eq!(format_bytes(1536.0), "1.5 KiB");
        assert_eq!(format_bytes(3.0 * 1024.0 * 1024.0 * 1024.0), "3.0 GiB");
        let s = |id: &str, reason: &'static str, m: Option<&str>| Skip { id: id.into(), reason, message: m.map(String::from) };
        assert_eq!(skip_why(&[s("a", "protected", None), s("b", "error", Some("EACCES: x")), s("c", "protected", None), s("d", "error", Some("other"))]), "2 protected, 2 could not be moved (EACCES: x)");
        assert!(is_kept_dir("TeslaCam") && is_kept_dir("a/SentryClips") && !is_kept_dir("TeslaCam/SentryClips/2025-01-01_10-00-00"));
        assert!(adoptable("m7x2k1-0a1b2c3d") && !adoptable("x-0A1B2C3D") && !adoptable("nope"));
    }
}
