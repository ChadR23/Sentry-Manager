//! server/uiPacks.js: an interface of the owner's choosing in place of the
//! built-in one, for everyone, switched in Settings → Interface without a
//! restart. A pack's `web/…` and `studio/…` files take the place of the
//! built-in files of the same path; a file it leaves out is the built-in one.
//! The packs that come with the app (`ui-packs/` in the image,
//! `examples/ui-packs/` in a checkout) are listed without an upload and never
//! deleted. /original always shows the built-in interface in that browser.

use super::ctx::UiCtx;
use super::zip::{read_zip, write_zip, Entry, Limits};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub const KINDS: [&str; 2] = ["web", "studio"];
pub const MAX_ZIP_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_PACKS: usize = 20;

/// A refusal shown to the admin (status 400).
#[derive(Debug, Clone, PartialEq)]
pub struct PackError(pub String);

/// /^[a-z0-9-]{1,48}$/
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 48 && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

/// cleanText: control characters as one space, trimmed, at most `max` (UTF-16 units).
pub fn clean_text(v: Option<&Value>, max: usize) -> String {
    let Some(s) = v.and_then(Value::as_str) else { return String::new() };
    let mut out = String::new();
    let mut in_ctrl = false;
    for c in s.chars() {
        if (c as u32) < 0x20 || c as u32 == 0x7f {
            if !in_ctrl {
                out.push(' ');
            }
            in_ctrl = true;
        } else {
            in_ctrl = false;
            out.push(c);
        }
    }
    js_slice(js_trim(&out), max)
}

/// String#trim (JavaScript's white space and line terminators).
pub fn js_trim(s: &str) -> &str {
    let ws = |c: char| c.is_whitespace() || c == '\u{feff}';
    s.trim_matches(ws)
}

/// s.slice(0, max) in UTF-16 units (a pair cut in half keeps its first half, as JavaScript does: here dropped).
pub fn js_slice(s: &str, max: usize) -> String {
    let mut n = 0;
    let mut out = String::new();
    for c in s.chars() {
        n += c.len_utf16();
        if n > max {
            break;
        }
        out.push(c);
    }
    out
}

/// safeRel: a path inside the pack, or None for one that could leave it.
pub fn safe_rel(name: &str) -> Option<String> {
    if name.is_empty() || name.encode_utf16().count() > 300 || name.contains('\0') || name.contains('\\') || name.starts_with('/') {
        return None;
    }
    let parts: Vec<&str> = name.split('/').collect();
    let drive = |p: &str| p.len() == 2 && p.as_bytes()[0].is_ascii_alphabetic() && p.as_bytes()[1] == b':';
    if parts.iter().any(|p| p.is_empty() || *p == "." || *p == ".." || drive(p)) {
        return None;
    }
    Some(parts.join("/"))
}

fn count_files(folder: &Path) -> (u64, u64) {
    let mut files = 0;
    let mut bytes = 0;
    fn walk(abs: &Path, files: &mut u64, bytes: &mut u64) {
        let Ok(rd) = std::fs::read_dir(abs) else { return };
        for e in rd.flatten() {
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() {
                walk(&e.path(), files, bytes);
            } else if t.is_file() {
                *files += 1;
                *bytes += std::fs::metadata(e.path()).map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    walk(folder, &mut files, &mut bytes);
    (files, bytes)
}

#[derive(Clone)]
struct Builtin {
    meta: Map<String, Value>,
    root: PathBuf,
}

/// readBuiltin: each folder with ui.json and web/ or studio/, read once.
fn read_builtin(folder: &Path) -> BTreeMap<String, Builtin> {
    let mut out = BTreeMap::new();
    let Ok(rd) = std::fs::read_dir(folder) else { return out };
    let mut names: Vec<String> = rd.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| valid_id(n)).collect();
    names.sort();
    for id in names {
        let root = folder.join(&id);
        let Ok(text) = std::fs::read_to_string(root.join("ui.json")) else { continue };
        let Ok(manifest) = serde_json::from_str::<Value>(&text) else { continue };
        let manifest = if manifest.is_null() || manifest == json!(false) { json!({}) } else { manifest };
        let replaces: Vec<&str> = KINDS.iter().copied().filter(|k| root.join(k).exists()).collect();
        if replaces.is_empty() {
            continue;
        }
        let (mut files, mut bytes) = (0, 0);
        for k in &replaces {
            let (f, b) = count_files(&root.join(k));
            files += f;
            bytes += b;
        }
        let name = clean_text(manifest.get("name"), 64);
        let mut m = Map::new();
        m.insert("id".into(), json!(id));
        m.insert("name".into(), json!(if name.is_empty() { id.clone() } else { name }));
        m.insert("description".into(), json!(clean_text(manifest.get("description"), 300)));
        m.insert("author".into(), json!(clean_text(manifest.get("author"), 64)));
        m.insert("files".into(), json!(files));
        m.insert("bytes".into(), json!(bytes));
        m.insert("replaces".into(), json!(replaces));
        m.insert("uploadedAt".into(), Value::Null);
        m.insert("builtin".into(), json!(true));
        out.insert(id, Builtin { meta: m, root });
    }
    out
}

/// Random bytes as hex (crypto.randomBytes(n).toString('hex')).
pub fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut b);
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// new Date().toISOString()
pub fn iso_now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub struct Packs {
    dir: PathBuf,
    db: Arc<dyn UiCtx>,
    builtin: BTreeMap<String, Builtin>,
    default_id: Option<String>,
    installing: AtomicBool,
    /// the choice could not be read last time (logged once, not on every file served)
    unread: AtomicBool,
}

impl Packs {
    pub fn new(dir: PathBuf, db: Arc<dyn UiCtx>, builtin_dir: Option<&Path>, default_id: Option<String>) -> Packs {
        let builtin = builtin_dir.map(read_builtin).unwrap_or_default();
        Packs { dir, db, builtin, default_id, installing: AtomicBool::new(false), unread: AtomicBool::new(false) }
    }

    fn meta_file(&self, id: &str) -> PathBuf {
        self.dir.join(id).join("pack.json")
    }

    fn read_meta(&self, id: &str) -> Option<Map<String, Value>> {
        if let Some(b) = self.builtin.get(id) {
            return Some(b.meta.clone());
        }
        let text = std::fs::read_to_string(self.meta_file(id)).ok()?;
        match serde_json::from_str::<Value>(&text).ok()? {
            Value::Object(m) if m.get("id").and_then(Value::as_str) == Some(id) => Some(m),
            _ => None,
        }
    }

    /// The packs: the built-in ones first (the default first of them), then the uploaded ones, newest first.
    pub fn list(&self) -> Vec<Map<String, Value>> {
        let mut ids: Vec<String> = std::fs::read_dir(&self.dir)
            .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|id| valid_id(id) && !self.builtin.contains_key(id)).collect())
            .unwrap_or_default();
        // (readdir order: by name on most file systems; the sort below decides)
        ids.sort();
        let mut uploaded: Vec<Map<String, Value>> = ids.iter().filter_map(|id| self.read_meta(id)).collect();
        let key = |m: &Map<String, Value>| match m.get("uploadedAt") {
            Some(Value::String(s)) => s.clone(),
            Some(v) => crate::ui::js::string(v),
            None => "undefined".into(),
        };
        uploaded.sort_by(|a, b| crate::ui::js::locale_compare(&key(b), &key(a)));
        let mut own: Vec<Map<String, Value>> = self.builtin.values().map(|b| b.meta.clone()).collect();
        let d = self.default_id.as_deref();
        // a stable sort: the default first, the others in name order
        own.sort_by_key(|m| if m.get("id").and_then(Value::as_str) == d && d.is_some() { 0 } else { 1 });
        own.extend(uploaded);
        own
    }

    /// The chosen pack's id, or the default (Sentry Six) when none is chosen; None for Original.
    /// A choice that cannot be read is logged (once until it reads again) and the default is shown.
    pub fn active(&self) -> Option<String> {
        match self.chosen() {
            Ok(id) => {
                self.unread.store(false, Ordering::SeqCst);
                id
            }
            Err(e) => {
                if !self.unread.swap(true, Ordering::SeqCst) {
                    self.db.log(super::ctx::Level::Warn, "ui", &format!("The default interface is shown: the chosen one could not be read: {e}"));
                }
                self.pick(None)
            }
        }
    }

    /// active(), with an error when the choice cannot be read (what the ui-packs routes answer).
    pub(crate) fn chosen(&self) -> Result<Option<String>, String> {
        let saved = self.db.setting("ui-pack")?;
        Ok(self.pick(saved.as_ref().and_then(Value::as_str).map(str::to_string)))
    }

    fn pick(&self, saved: Option<String>) -> Option<String> {
        [saved, self.default_id.clone()].into_iter().flatten().find(|id| valid_id(id) && self.read_meta(id).is_some())
    }

    /// The choice kept; Err((400, refusal)), or Err((500, what failed)) when it was not kept.
    pub fn set_active(&self, id: Option<&str>) -> Result<Option<String>, (u16, String)> {
        let Some(id) = id else {
            self.db.set_setting("ui-pack", &Value::Null).map_err(|e| (500, e))?;
            return Ok(None);
        };
        if !valid_id(id) || self.read_meta(id).is_none() {
            return Err((400, "No such interface.".into()));
        }
        self.db.set_setting("ui-pack", &json!(id)).map_err(|e| (500, e))?;
        Ok(Some(id.to_string()))
    }

    /// The folder the chosen pack serves `kind` from, or None.
    pub fn root(&self, kind: &str) -> Option<PathBuf> {
        let id = self.active()?;
        if !KINDS.contains(&kind) {
            return None;
        }
        let folder = match self.builtin.get(&id) {
            Some(b) => b.root.join(kind),
            None => self.dir.join(&id).join("files").join(kind),
        };
        folder.exists().then_some(folder)
    }

    pub fn name_of(&self, id: &str) -> Option<String> {
        self.list().into_iter().find(|m| m.get("id").and_then(Value::as_str) == Some(id)).and_then(|m| m.get("name").and_then(Value::as_str).map(str::to_string))
    }

    /// Install a pack from a .zip; `file_name` names it without a ui.json.
    pub fn install(&self, zip: &[u8], file_name: &str) -> Result<Map<String, Value>, PackError> {
        if self.installing.swap(true, Ordering::SeqCst) {
            return Err(PackError("Another interface is being installed. Try again when it is done.".into()));
        }
        let out = self.install_inner(zip, file_name);
        self.installing.store(false, Ordering::SeqCst);
        out
    }

    fn install_inner(&self, zip: &[u8], file_name: &str) -> Result<Map<String, Value>, PackError> {
        if self.list().iter().filter(|x| x.get("builtin") != Some(&json!(true))).count() >= MAX_PACKS {
            return Err(PackError(format!("There are {MAX_PACKS} interfaces already: delete one first.")));
        }
        let entries = read_zip(zip, &Limits::default()).map_err(|e| PackError(e.0))?;
        // leave out what a Mac or Windows adds, and a folder the whole pack is in
        let junk = |n: &str| n.split('/').any(|p| p == "__MACOSX" || p == ".DS_Store" || p == "Thumbs.db");
        let mut entries: Vec<Entry> = entries.into_iter().filter(|e| !junk(&e.name)).collect();
        let tops: std::collections::HashSet<&str> = entries.iter().map(|e| e.name.split('/').next().unwrap_or("")).collect();
        if tops.len() == 1 && entries.iter().all(|e| e.name.contains('/')) && !KINDS.contains(tops.iter().next().unwrap()) {
            let top = tops.iter().next().unwrap().len() + 1;
            for e in &mut entries {
                e.name = e.name[top..].to_string();
            }
        }
        let mut manifest = json!({});
        let mut files: Vec<(String, Vec<u8>)> = Vec::new();
        for e in entries {
            let Some(rel) = safe_rel(&e.name) else {
                return Err(PackError(format!("\"{}\" is not a path a pack can use.", clean_text(Some(&json!(e.name)), 120))));
            };
            if rel == "ui.json" {
                let text = String::from_utf8_lossy(&e.data);
                manifest = match serde_json::from_str::<Value>(&text) {
                    Ok(v) if super::js::truthy(&v) => v,
                    Ok(_) => json!({}),
                    Err(_) => return Err(PackError("ui.json is not valid JSON.".into())),
                };
            } else if KINDS.contains(&rel.split('/').next().unwrap_or("")) && rel.contains('/') {
                files.push((rel, e.data));
            }
        }
        if files.is_empty() {
            return Err(PackError("The pack has no files in web/ or studio/. Download the original interface to see how a pack is laid out.".into()));
        }
        let base = file_name.rsplit('/').next().unwrap_or("");
        let base = strip_zip(base);
        let mut name = clean_text(manifest.get("name"), 64);
        if name.is_empty() {
            name = clean_text(Some(&json!(base)), 64);
        }
        if name.is_empty() {
            name = "Custom interface".into();
        }
        let mut slug = String::new();
        let mut dash = false;
        for c in name.to_lowercase().chars() {
            if c.is_ascii_lowercase() || c.is_ascii_digit() {
                if dash {
                    slug.push('-');
                }
                dash = false;
                slug.push(c);
            } else {
                dash = true;
            }
        }
        // (leading and trailing dashes dropped, then at most 32)
        let slug = slug.trim_start_matches('-');
        let slug: String = slug.chars().take(32).collect();
        let slug = if slug.is_empty() { "ui".to_string() } else { slug };
        let id = format!("{slug}-{}", random_hex(3));
        let mut meta = Map::new();
        meta.insert("id".into(), json!(id));
        meta.insert("name".into(), json!(name));
        meta.insert("description".into(), json!(clean_text(manifest.get("description"), 300)));
        meta.insert("author".into(), json!(clean_text(manifest.get("author"), 64)));
        meta.insert("files".into(), json!(files.len()));
        meta.insert("bytes".into(), json!(files.iter().map(|f| f.1.len() as u64).sum::<u64>()));
        meta.insert("replaces".into(), json!(KINDS.iter().filter(|k| files.iter().any(|f| f.0.starts_with(&format!("{k}/")))).collect::<Vec<_>>()));
        meta.insert("uploadedAt".into(), json!(iso_now()));
        // unpacked next to the others, then put in place in one rename
        let tmp = self.dir.join(format!(".incoming-{}", random_hex(4)));
        let res = (|| -> std::io::Result<()> {
            std::fs::create_dir_all(&tmp)?;
            for (rel, data) in &files {
                let mut abs = tmp.join("files");
                for part in rel.split('/') {
                    abs.push(part);
                }
                std::fs::create_dir_all(abs.parent().unwrap())?;
                use std::io::Write;
                let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&abs)?;
                f.write_all(data)?;
            }
            std::fs::write(tmp.join("pack.json"), serde_json::to_string_pretty(&Value::Object(meta.clone())).unwrap())?;
            std::fs::rename(&tmp, self.dir.join(&id))
        })();
        if let Err(e) = res {
            let _ = std::fs::remove_dir_all(&tmp);
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                return Err(PackError("The pack has the same file twice.".into()));
            }
            return Err(PackError(format!("Installing the interface failed: {e}")));
        }
        self.db.log(super::ctx::Level::Info, "ui", &format!("UI pack \"{name}\" ({id}) installed: {} files", files.len()));
        Ok(meta)
    }

    /// Err((400, refusal)), or Err((500, what failed)) when the pack could not be removed or the
    /// choice could not be read or kept.
    pub fn remove(&self, id: &str) -> Result<(), (u16, String)> {
        if !valid_id(id) || self.read_meta(id).is_none() {
            return Err((400, "No such interface.".into()));
        }
        if self.builtin.contains_key(id) {
            return Err((400, "This interface comes with Sentry Six Manager and cannot be deleted.".into()));
        }
        let was_chosen = self.chosen().map_err(|e| (500, e))?.as_deref() == Some(id);
        // (moved out of the packs first, in one step: one that cannot be moved stays installed, and
        // chosen when it was; one moved away is never shown)
        let gone = self.dir.join(format!(".deleting-{id}"));
        // (what an earlier delete of this id left, which would stand in the way)
        let _ = std::fs::remove_dir_all(&gone);
        std::fs::rename(self.dir.join(id), &gone).map_err(|e| (500, format!("The interface {id} could not be deleted: {e}")))?;
        if was_chosen {
            if let Err(e) = self.db.set_setting("ui-pack", &Value::Null) {
                // (its choice was not cleared: the pack goes back, still installed and chosen)
                if let Err(back) = std::fs::rename(&gone, self.dir.join(id)) {
                    self.db.log(super::ctx::Level::Warn, "ui", &format!("The interface {id} stays aside in {} (its choice was not cleared; the next start puts it back): {back}", gone.display()));
                }
                return Err((500, e));
            }
        }
        // (the files go only once the choice is gone)
        if let Err(e) = std::fs::remove_dir_all(&gone) {
            self.db.log(super::ctx::Level::Warn, "ui", &format!("The files of the deleted interface {id} stay in {} until the next start: {e}", gone.display()));
        }
        Ok(())
    }

    /// Leftovers of an install a restart cut short, and of a delete. A delete's leftover whose pack
    /// is still chosen (the delete could neither clear the choice nor put the pack back) is put
    /// back, or kept while its place is taken; one whose choice cannot be read is kept until it can.
    pub fn tidy(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let saved = self.db.setting("ui-pack");
        for e in std::fs::read_dir(&self.dir)?.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with(".incoming-") {
                let _ = std::fs::remove_dir_all(e.path());
                continue;
            }
            let Some(id) = name.strip_prefix(".deleting-") else { continue };
            let aside = e.path();
            let chosen = match &saved {
                Ok(v) => valid_id(id) && v.as_ref().and_then(Value::as_str) == Some(id),
                Err(err) => {
                    self.db.log(super::ctx::Level::Warn, "ui", &format!("The interface {id} left aside by a delete stays in {} until the chosen one can be read: {err}", aside.display()));
                    continue;
                }
            };
            if !chosen {
                let _ = std::fs::remove_dir_all(&aside);
                continue;
            }
            let place = self.dir.join(id);
            // (anything there, even a link to nothing, takes its place)
            let said = if std::fs::symlink_metadata(&place).is_ok() {
                format!("The interface {id} left aside by a delete stays in {}: it is still chosen and {} is taken", aside.display(), place.display())
            } else {
                match std::fs::rename(&aside, &place) {
                    Ok(()) => format!("The interface {id} is put back: a delete left it aside while it was still chosen"),
                    Err(err) => format!("The interface {id} left aside by a delete stays in {}: it is still chosen and could not be put back: {err}", aside.display()),
                }
            };
            self.db.log(super::ctx::Level::Warn, "ui", &said);
        }
        Ok(())
    }
}

/// .replace(/\.zip$/i, '')
fn strip_zip(s: &str) -> &str {
    if s.len() >= 4 && s.is_char_boundary(s.len() - 4) && s[s.len() - 4..].eq_ignore_ascii_case(".zip") {
        &s[..s.len() - 4]
    } else {
        s
    }
}

/// Every file under `folder` as (prefix + relative path, bytes), in localeCompare order.
fn files_under(folder: &Path, prefix: &str) -> Vec<Entry> {
    let mut out = Vec::new();
    fn walk(abs: &Path, rel: &str, prefix: &str, out: &mut Vec<Entry>) {
        let Ok(rd) = std::fs::read_dir(abs) else { return };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() {
                walk(&e.path(), &child_rel, prefix, out);
            } else if t.is_file() {
                if let Ok(data) = std::fs::read(e.path()) {
                    out.push(Entry { name: format!("{prefix}{child_rel}"), data });
                }
            }
        }
    }
    walk(folder, "", prefix, &mut out);
    out.sort_by(|a, b| super::js::locale_compare(&a.name, &b.name));
    out
}

/// originalPack: the built-in interface as a pack to start from.
pub fn original_pack(web: &Path, studio: &Path, version: &str) -> Vec<u8> {
    let readme = [
        "Sentry Six Manager interface pack",
        "",
        "This is the built-in interface. Change any file, zip the folder and",
        "upload it under Settings > Interface. Files you delete from the pack",
        "stay the built-in ones, so a pack can be as small as one stylesheet:",
        "",
        "  web/      the manager: index.html, app.js (pages), shell.css (look)",
        "  studio/   the Viewer (index.html) and the Encoder (encoder.html)",
        "  ui.json   the name shown in Settings",
        "",
        "Scripts must be files of the pack (<script src=\"...\">): the pages",
        "run no inline scripts and nothing from other sites.",
        "If a pack breaks the pages, open /original on the server: that",
        "browser then shows the built-in interface, and Settings > Interface",
        "can switch back for everyone.",
        "",
    ]
    .join("\n");
    let desc = if version.is_empty() { "Based on the built-in interface.".to_string() } else { format!("Based on the built-in interface of {version}.") };
    let ui = format!("{}\n", serde_json::to_string_pretty(&json!({ "name": "My interface", "description": desc, "author": "" })).unwrap());
    let mut files = vec![Entry { name: "README.txt".into(), data: readme.into_bytes() }, Entry { name: "ui.json".into(), data: ui.into_bytes() }];
    files.extend(files_under(web, "web/"));
    files.extend(files_under(studio, "studio/"));
    write_zip(&files)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::ui::ctx::{Level, ReqInfo, VehicleRef};
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// A settings table in memory, for tests (its reads fail while the first switch is on, its
    /// writes while the second is), and the lines logged.
    #[derive(Default)]
    pub struct MemCtx(pub Mutex<HashMap<String, Value>>, pub std::sync::atomic::AtomicBool, pub std::sync::atomic::AtomicBool, pub Mutex<Vec<String>>);
    impl UiCtx for MemCtx {
        fn setting(&self, key: &str) -> Result<Option<Value>, String> {
            if self.1.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("manager.db: database disk image is malformed".into());
            }
            Ok(self.0.lock().unwrap().get(key).cloned())
        }
        fn set_setting(&self, key: &str, value: &Value) -> Result<(), String> {
            if self.2.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("manager.db: attempt to write a readonly database".into());
            }
            self.0.lock().unwrap().insert(key.into(), value.clone());
            Ok(())
        }
        fn has_setting_prefix(&self, p: &str) -> Result<bool, String> {
            Ok(self.0.lock().unwrap().keys().any(|k| k.starts_with(p)))
        }
        fn announce(&self, _: &str) {}
        fn audit(&self, _: Level, _: &str) {}
        fn log(&self, _: Level, _: &str, line: &str) {
            self.3.lock().unwrap().push(line.to_string());
        }
        fn user(&self, _: &ReqInfo) -> Option<String> {
            Some("admin".into())
        }
        fn session_hash(&self, _: &ReqInfo) -> Option<String> {
            None
        }
        fn recently_confirmed(&self, _: &ReqInfo) -> bool {
            true
        }
        fn is_secure(&self, _: &ReqInfo) -> bool {
            false
        }
        fn client_key(&self, _: &ReqInfo) -> String {
            "test".into()
        }
        fn pending_code(&self, _: &ReqInfo) -> bool {
            false
        }
        fn setup_only(&self, _: &ReqInfo) -> bool {
            false
        }
        fn job_start(&self, _: Value) -> Result<Value, String> {
            Ok(json!(1))
        }
        fn job_update(&self, _: &Value, _: Value) {}
        fn job_finish(&self, _: &Value, _: Value) {}
        fn vehicle(&self, _: &str) -> Option<VehicleRef> {
            None
        }
        fn resolve_footage(&self, _: &str) -> Option<(PathBuf, VehicleRef)> {
            None
        }
        fn speeds_for(&self, _: &Path) -> Option<Vec<Option<f64>>> {
            None
        }
        fn viewer_car_data(&self) -> Result<Value, String> {
            Ok(json!({ "enabled": false }))
        }
    }

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("sm-ui-test-{}", random_hex(6)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        write_zip(&files.iter().map(|(n, d)| Entry { name: n.to_string(), data: d.to_vec() }).collect::<Vec<_>>())
    }
    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }
    fn repo() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
    }

    // test/uiPacks.test.js
    #[test]
    fn pack_paths_stay_in_the_pack() {
        for bad in ["../x", "web/../../x", "/etc/passwd", "web\\..\\x", "web//x", "web/./x", "C:/x", "", "a\0b"] {
            assert_eq!(safe_rel(bad), None, "{bad}");
        }
        assert_eq!(safe_rel("web/fonts/a.woff2").as_deref(), Some("web/fonts/a.woff2"));
    }

    #[test]
    fn install_choose_serve_delete() {
        let dir = tmp();
        let db = Arc::new(MemCtx::default());
        let packs = Packs::new(dir.clone(), db.clone(), None, None);
        packs.tidy().unwrap();
        assert_eq!(packs.active(), None);
        assert_eq!(packs.root("web"), None);
        let meta = packs
            .install(
                &zip(&[
                    ("Dark Mint/ui.json", br#"{"name":"Dark Mint\n","description":"Greener","author":"Sam"}"#),
                    ("Dark Mint/web/shell.css", b"body{background:#012}"),
                    ("Dark Mint/README.md", b"ignored"),
                    ("__MACOSX/Dark Mint/._shell.css", b"junk"),
                    ("Dark Mint/.DS_Store", b"junk"),
                ]),
                "whatever.zip",
            )
            .unwrap();
        assert_eq!(meta["name"], "Dark Mint");
        assert_eq!(meta["author"], "Sam");
        assert_eq!(meta["replaces"], json!(["web"]));
        assert_eq!(meta["files"], 1);
        let id = meta["id"].as_str().unwrap().to_string();
        assert!(id.starts_with("dark-mint-") && id.len() == "dark-mint-".len() + 6);
        assert_eq!(packs.list().iter().map(|m| m["id"].clone()).collect::<Vec<_>>(), [json!(id)]);
        assert_eq!(packs.active(), None, "installing does not switch");
        packs.set_active(Some(&id)).unwrap();
        assert_eq!(packs.active().as_deref(), Some(id.as_str()));
        assert_eq!(std::fs::read_to_string(packs.root("web").unwrap().join("shell.css")).unwrap(), "body{background:#012}");
        assert_eq!(packs.root("studio"), None);
        assert!(packs.set_active(Some("nope")).unwrap_err().1.contains("No such"));
        assert!(packs.set_active(Some("../x")).unwrap_err().1.contains("No such"));
        let second = packs.install(&zip(&[("studio/styles/x.css", b"a{}")]), "Night Viewer.zip").unwrap();
        assert_eq!(second["name"], "Night Viewer");
        assert!(packs.install(&zip(&[("web/../../evil.js", b"x")]), "").unwrap_err().0.contains("not a path"));
        assert!(packs.install(&zip(&[("readme.txt", b"x")]), "").unwrap_err().0.contains("no files in web/ or studio/"));
        assert!(packs.install(&b"nope".repeat(10), "").unwrap_err().0.contains("not a .zip"));
        assert!(packs.install(&zip(&[("ui.json", b"{"), ("web/a", b"x")]), "").unwrap_err().0.contains("ui.json"));
        let mut both = vec![id.clone(), second["id"].as_str().unwrap().to_string()];
        both.sort();
        assert_eq!(names(&dir), both, "no half-unpacked pack is left");
        packs.remove(&id).unwrap();
        assert_eq!(packs.active(), None);
        assert!(packs.remove(&id).unwrap_err().1.contains("No such"));
        std::fs::create_dir_all(dir.join(".incoming-abcd")).unwrap();
        packs.tidy().unwrap();
        assert_eq!(names(&dir), [second["id"].as_str().unwrap()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_pack_that_cannot_be_removed_stays_installed_and_chosen_and_is_an_error() {
        // (permissions do not stop root)
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let dir = tmp();
        let packs = Packs::new(dir.clone(), Arc::new(MemCtx::default()), None, None);
        let id = packs.install(&zip(&[("web/shell.css", b"body{}")]), "Mine.zip").unwrap()["id"].as_str().unwrap().to_string();
        packs.set_active(Some(&id)).unwrap();
        let mode = |m: u32| std::fs::set_permissions(&dir, std::os::unix::fs::PermissionsExt::from_mode(m)).unwrap();
        mode(0o555);
        let refused = packs.remove(&id);
        mode(0o755);
        assert_eq!(refused.unwrap_err().0, 500);
        assert_eq!(packs.active().as_deref(), Some(id.as_str()), "still installed, still chosen");
        assert!(packs.list().iter().any(|m| m["id"] == json!(id)));
        packs.remove(&id).unwrap();
        assert_eq!((packs.active(), names(&dir)), (None, Vec::<String>::new()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_chosen_pack_whose_choice_cannot_be_cleared_stays_installed_and_chosen() {
        let dir = tmp();
        let ctx = Arc::new(MemCtx::default());
        let packs = Packs::new(dir.clone(), ctx.clone(), None, None);
        let id = packs.install(&zip(&[("web/shell.css", b"body{}")]), "Mine.zip").unwrap()["id"].as_str().unwrap().to_string();
        packs.set_active(Some(&id)).unwrap();
        ctx.2.store(true, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(packs.remove(&id).unwrap_err().0, 500);
        ctx.2.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(packs.active().as_deref(), Some(id.as_str()), "still installed, still chosen");
        assert_eq!(names(&dir), [id.clone()], "its files are back in place");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// What a delete leaves when it could neither clear the pack's choice nor put the pack back.
    fn left_aside(dir: &Path, packs: &Packs) -> String {
        let id = packs.install(&zip(&[("web/shell.css", b"body{}")]), "Mine.zip").unwrap()["id"].as_str().unwrap().to_string();
        packs.set_active(Some(&id)).unwrap();
        std::fs::rename(dir.join(&id), dir.join(format!(".deleting-{id}"))).unwrap();
        id
    }

    #[test]
    fn a_chosen_pack_a_delete_left_aside_is_put_back_at_the_start_never_swept() {
        let dir = tmp();
        let ctx = Arc::new(MemCtx::default());
        let packs = Packs::new(dir.clone(), ctx.clone(), None, None);
        let id = left_aside(&dir, &packs);
        // (what is not chosen still goes)
        std::fs::create_dir_all(dir.join(".deleting-other-abc123")).unwrap();
        std::fs::create_dir_all(dir.join(".incoming-abcd")).unwrap();
        packs.tidy().unwrap();
        assert_eq!(names(&dir), [id.clone()]);
        assert_eq!(packs.active().as_deref(), Some(id.as_str()), "installed and chosen again");
        assert!(ctx.3.lock().unwrap().iter().any(|l| l.starts_with(&format!("The interface {id} is put back"))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_chosen_pack_a_delete_left_aside_is_kept_while_its_place_is_taken_or_its_choice_cannot_be_read() {
        let dir = tmp();
        let ctx = Arc::new(MemCtx::default());
        let packs = Packs::new(dir.clone(), ctx.clone(), None, None);
        let id = left_aside(&dir, &packs);
        let aside = format!(".deleting-{id}");
        ctx.1.store(true, std::sync::atomic::Ordering::SeqCst);
        packs.tidy().unwrap();
        ctx.1.store(false, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(names(&dir), [aside.clone()], "not known to be unchosen: it stays");
        std::fs::create_dir_all(dir.join(&id)).unwrap();
        packs.tidy().unwrap();
        assert_eq!(names(&dir), [aside.clone(), id.clone()], "its place taken: it stays aside");
        let said = ctx.3.lock().unwrap().iter().filter(|l| l.starts_with(&format!("The interface {id} left aside by a delete stays"))).count();
        assert_eq!(said, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_original_installs_as_is() {
        let dir = tmp();
        let buf = original_pack(&repo().join("web"), &repo().join("src/renderer"), "");
        let files = read_zip(&buf, &Limits::default()).unwrap();
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        for n in ["README.txt", "ui.json", "web/index.html", "web/app.js", "web/shell.css", "studio/index.html", "studio/encoder.html"] {
            assert!(names.contains(&n), "{n}");
        }
        assert_eq!(files.iter().find(|f| f.name == "web/app.js").unwrap().data, std::fs::read(repo().join("web/app.js")).unwrap());
        let packs = Packs::new(dir.clone(), Arc::new(MemCtx::default()), None, None);
        let meta = packs.install(&buf, "").unwrap();
        assert_eq!(meta["name"], "My interface");
        assert_eq!(meta["replaces"], json!(["web", "studio"]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sentry_six_is_the_main_interface() {
        let dir = tmp();
        let builtin = repo().join("examples/ui-packs");
        let packs = Packs::new(dir.clone(), Arc::new(MemCtx::default()), Some(&builtin), Some("sentry-six".into()));
        assert_eq!(packs.active().as_deref(), Some("sentry-six"));
        assert!(packs.root("web").is_some());
        assert_eq!(packs.list()[0]["id"], "sentry-six");
        let mut ids: Vec<String> = packs.list().iter().filter(|p| p["builtin"] == true).map(|p| p["id"].as_str().unwrap().to_string()).collect();
        ids.sort();
        assert_eq!(ids, ["aurora", "daylight", "flux", "horizon", "sentry-six"]);
        packs.set_active(None).unwrap();
        assert_eq!(packs.active().as_deref(), Some("sentry-six"), "Original saved: Sentry Six all the same");
        packs.set_active(Some("horizon")).unwrap();
        assert_eq!(packs.active().as_deref(), Some("horizon"));
        assert!(packs.remove("flux").unwrap_err().1.contains("comes with"));
        assert_eq!(Packs::new(dir.clone(), Arc::new(MemCtx::default()), Some(&builtin), Some("nope".into())).active(), None);
        assert_eq!(Packs::new(dir.clone(), Arc::new(MemCtx::default()), Some(&builtin), None).active(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
