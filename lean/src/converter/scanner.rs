//! src/main/converter/scanner.js (scanTeslaFootage, compareScanPaths) and
//! src/shared/teslaFilename.mjs parseTeslaFilename: the clips and event
//! files of a footage folder, in the order Node finds them (the sequential
//! walk; Node's look-ahead variant makes the same decisions in the same order).

use super::error::{CError, CResult};
use serde_json::{json, Map, Value};
use std::cmp::Ordering;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering as AtOrd};

pub const GROUPS: [&str; 3] = ["RecentClips", "SavedClips", "SentryClips"];
pub const DEFAULT_GROUP_ORDER: [&str; 3] = ["SavedClips", "SentryClips", "RecentClips"];

pub fn canonical_group(name: &str) -> Option<&'static str> {
    let lower = name.to_lowercase();
    GROUPS.iter().copied().find(|g| g.to_lowercase() == lower)
}

/// String comparison as JS `<` does it (UTF-16 code units).
pub fn js_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// parseTeslaFilename: /^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})-(.+)\.mp4$/i
pub fn parse_tesla_filename(name: &str) -> Option<(String, String)> {
    let b = name.as_bytes();
    let d = |i: usize| b.get(i).is_some_and(|c| c.is_ascii_digit());
    let at = |i: usize, c: u8| b.get(i) == Some(&c);
    let date_ok = (0..4).all(d) && at(4, b'-') && d(5) && d(6) && at(7, b'-') && d(8) && d(9);
    let time_ok = at(10, b'_') && d(11) && d(12) && at(13, b'-') && d(14) && d(15) && at(16, b'-') && d(17) && d(18) && at(19, b'-');
    if !date_ok || !time_ok || b.len() < 25 || !b[b.len() - 4..].eq_ignore_ascii_case(b".mp4") || !name.is_char_boundary(b.len() - 4) {
        return None;
    }
    let camera_raw = &name[20..b.len() - 4];
    if camera_raw.is_empty() || camera_raw.contains('\n') || camera_raw.contains('\r') || camera_raw.contains('\u{2028}') || camera_raw.contains('\u{2029}') {
        return None;
    }
    let camera = camera_raw.to_lowercase();
    let camera = match camera.as_str() {
        "left" => "left_repeater".to_string(),
        "right" => "right_repeater".to_string(),
        _ => camera,
    };
    Some((format!("{}_{}", &name[0..10], &name[11..19]), camera))
}

fn starts_ci(name: &str, prefix: &str) -> bool {
    name.len() >= prefix.len() && name.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

fn is_replacement_artifact(name: &str) -> bool {
    starts_ci(name, "TEMP-H265-") || starts_ci(name, "TEMP-AV1-") || starts_ci(name, "BACKUP-")
}

fn classify_event_asset(name: &str, group: Option<&str>, group_rel: &[String]) -> Option<&'static str> {
    if !matches!(group, Some("SavedClips") | Some("SentryClips")) || group_rel.is_empty() {
        return None;
    }
    let lower = name.to_lowercase();
    if lower == "event.json" {
        return Some("event-json");
    }
    if lower == "event.mp4" {
        return Some("event-video");
    }
    let image = |stem: &str| ["png", "jpg", "jpeg", "webp"].iter().any(|e| name.eq_ignore_ascii_case(&format!("{stem}.{e}")));
    if image("event") || image("thumb") || image("thumbnail") {
        return Some("thumbnail");
    }
    None
}

/// path.resolve (lexical)
pub fn resolve(p: &Path) -> PathBuf {
    super::owned::resolve(p)
}

fn same_or_descendant(root: &Path, candidate: &Path) -> bool {
    resolve(candidate).starts_with(resolve(root))
}

/// normalizeGroupOrder
pub fn group_order(v: Option<&Value>) -> CResult<Vec<&'static str>> {
    let Some(v) = v.filter(|v| !v.is_null()) else { return Ok(DEFAULT_GROUP_ORDER.to_vec()) };
    let bad = || CError::type_error("groupOrder must contain each Tesla clip group exactly once");
    let a = v.as_array().ok_or_else(bad)?;
    let mut out = Vec::new();
    for g in a {
        let s = g.as_str().ok_or_else(bad)?;
        let Some(found) = GROUPS.iter().copied().find(|x| *x == s) else { return Err(bad()) };
        if out.contains(&found) {
            return Err(bad());
        }
        out.push(found);
    }
    if out.len() != 3 {
        return Err(bad());
    }
    Ok(out)
}

/// compareScanPaths(left, right, groupOrder)
pub fn compare_scan_paths(left: &str, right: &str, order: &[&str]) -> Ordering {
    let rank = |g: &str| order.iter().position(|x| *x == g).unwrap_or(0) as i64;
    let a: Vec<&str> = left.split('/').collect();
    let b: Vec<&str> = right.split('/').collect();
    for i in 0..a.len().min(b.len()) {
        if a[i] == b[i] {
            continue;
        }
        match (canonical_group(a[i]), canonical_group(b[i])) {
            (Some(l), Some(r)) => {
                let d = rank(l) - rank(r);
                return if d != 0 { d.cmp(&0) } else { js_cmp(a[i], b[i]) };
            }
            (Some(_), None) => return Ordering::Less,
            (None, Some(_)) => return Ordering::Greater,
            _ => return js_cmp(a[i], b[i]),
        }
    }
    a.len().cmp(&b.len())
}

/// A clip or event file the scan found.
#[derive(Debug, Clone, PartialEq)]
pub struct Discovered {
    pub value: Value,
    pub ino: u64,
}

/// What the scan asks before each listing (retryOperation): the job waits
/// out an outage there.
pub type Retry<'a> = &'a dyn Fn(&Path, &mut dyn FnMut() -> std::io::Result<Vec<fs::DirEntry>>) -> std::io::Result<Vec<fs::DirEntry>>;

fn cancelled() -> CError {
    CError::new("CANCELLED", "cancelled")
}

fn io_err(e: std::io::Error) -> CError {
    CError::from(e)
}

struct Walk<'a> {
    included: Vec<&'static str>,
    order: Vec<&'static str>,
    source_root: PathBuf,
    source_real: PathBuf,
    destination: Option<(PathBuf, PathBuf)>,
    dest_abs_inside: bool,
    dest_real_inside: bool,
    cancel: Option<&'a AtomicBool>,
    retry: Option<Retry<'a>>,
}

fn vanished(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::NotFound
}

impl<'a> Walk<'a> {
    fn aborted(&self) -> bool {
        self.cancel.is_some_and(|c| c.load(AtOrd::SeqCst))
    }
    fn list(&self, dir: &Path) -> std::io::Result<Vec<fs::DirEntry>> {
        let mut op = || -> std::io::Result<Vec<fs::DirEntry>> { fs::read_dir(dir)?.collect() };
        match self.retry {
            Some(r) => r(dir, &mut op),
            None => op(),
        }
    }
    fn entry_order(&self, a: &str, b: &str) -> Ordering {
        let rank = |g: &str| self.order.iter().position(|x| *x == g).unwrap_or(0);
        match (canonical_group(a), canonical_group(b)) {
            (Some(l), Some(r)) => rank(l).cmp(&rank(r)),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            _ => js_cmp(a, b),
        }
    }
    fn walk(&self, dir: &Path, rel: &[String], group: Option<&'static str>, group_rel: &[String], out: &mut dyn FnMut(Discovered) -> bool) -> CResult<bool> {
        if self.aborted() {
            return Err(cancelled());
        }
        let entries = match self.list(dir) {
            Ok(e) => e,
            Err(e) if vanished(&e) && dir != self.source_root => return Ok(true),
            Err(e) => return Err(io_err(e)),
        };
        let mut named: Vec<(String, fs::FileType)> = Vec::new();
        for e in entries {
            let t = e.file_type().map_err(io_err)?;
            named.push((e.file_name().to_string_lossy().to_string(), t));
        }
        // (Array.prototype.sort is stable; equal group ranks keep the listing's order)
        named.sort_by(|a, b| self.entry_order(&a.0, &b.0));
        for (name, t) in named {
            if self.aborted() {
                return Err(cancelled());
            }
            if t.is_file() && is_replacement_artifact(&name) {
                continue;
            }
            if name.starts_with('.') {
                continue;
            }
            let child = dir.join(&name);
            let mut child_rel = rel.to_vec();
            child_rel.push(name.clone());
            if t.is_symlink() {
                continue;
            }
            if t.is_dir() {
                let child_group = group.or_else(|| canonical_group(&name));
                if child_group.is_some_and(|g| !self.included.contains(&g)) {
                    continue;
                }
                let real = match fs::canonicalize(&child) {
                    Ok(r) => r,
                    Err(e) if vanished(&e) => continue,
                    Err(e) => return Err(io_err(e)),
                };
                if !same_or_descendant(&self.source_real, &real) {
                    continue;
                }
                if let Some((abs, dreal)) = &self.destination {
                    if (self.dest_abs_inside && same_or_descendant(abs, &child)) || (self.dest_real_inside && same_or_descendant(dreal, &real)) {
                        continue;
                    }
                }
                let next_group_rel: Vec<String> = match child_group {
                    Some(_) if group.is_some() => {
                        let mut g = group_rel.to_vec();
                        g.push(name.clone());
                        g
                    }
                    _ => vec![],
                };
                if !self.walk(&child, &child_rel, child_group, &next_group_rel, out)? {
                    return Ok(false);
                }
                continue;
            }
            if !t.is_file() {
                continue;
            }
            let parsed = parse_tesla_filename(&name);
            let asset = classify_event_asset(&name, group, group_rel);
            if parsed.is_none() && asset.is_none() {
                continue;
            }
            let st = match fs::canonicalize(&child).and_then(|real| {
                if !same_or_descendant(&self.source_real, &real) {
                    return Ok(None);
                }
                fs::metadata(&child).map(Some)
            }) {
                Ok(Some(st)) => st,
                Ok(None) => continue,
                Err(e) if vanished(&e) => continue,
                Err(e) => return Err(io_err(e)),
            };
            if !st.is_file() {
                continue;
            }
            let event_id = match group {
                Some("SavedClips") | Some("SentryClips") if !group_rel.is_empty() => Value::from(group_rel[0].clone()),
                _ => Value::Null,
            };
            let mut item = Map::new();
            item.insert("kind".into(), json!(if parsed.is_some() { "video" } else { "asset" }));
            item.insert("group".into(), group.map(Value::from).unwrap_or(Value::Null));
            item.insert("eventId".into(), event_id);
            item.insert("relativePath".into(), json!(child_rel.join("/")));
            item.insert("sourcePath".into(), json!(child.to_string_lossy()));
            item.insert("sourceBytes".into(), json!(st.len()));
            item.insert("mtimeMs".into(), super::jobstore::normalize::num(super::jobstore::mtime_ms(&st)));
            if let Some((ts, camera)) = parsed {
                item.insert("timestampKey".into(), json!(ts));
                item.insert("camera".into(), json!(camera));
            } else {
                item.insert("assetType".into(), json!(asset.unwrap()));
            }
            if !out(Discovered { value: Value::Object(item), ino: st.ino() }) {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

/// resolveDestinationRoot: its path, and its real path (the missing part
/// appended to its deepest existing folder's real path).
fn resolve_destination(dest: &str) -> CResult<(PathBuf, PathBuf)> {
    let abs = resolve(Path::new(dest));
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut existing = abs.clone();
    loop {
        match fs::canonicalize(&existing) {
            Ok(real) => {
                let mut r = real;
                for m in &missing {
                    r.push(m);
                }
                return Ok((abs, r));
            }
            Err(e) if vanished(&e) => {
                if fs::symlink_metadata(&existing).is_ok() {
                    return Err(CError::new("UNSAFE_DESTINATION_PATH", format!("Destination path cannot be resolved safely: {}", existing.display())));
                }
                let Some(parent) = existing.parent().map(Path::to_path_buf) else { return Err(io_err(e)) };
                missing.insert(0, existing.file_name().unwrap_or_default().to_os_string());
                existing = parent;
            }
            Err(e) => return Err(io_err(e)),
        }
    }
}

/// scanTeslaFootage(config): calls `out` for each clip in scan order until
/// it returns false.
pub fn scan(config: &Value, cancel: Option<&AtomicBool>, retry: Option<Retry>, out: &mut dyn FnMut(Discovered) -> bool) -> CResult<()> {
    let Some(root) = config.get("sourceRoot").and_then(Value::as_str).filter(|s| !s.is_empty()) else { return Err(CError::type_error("sourceRoot is required")) };
    let included: Vec<&'static str> = match config.get("includedGroups") {
        None | Some(Value::Null) => GROUPS.to_vec(),
        Some(Value::Array(a)) => {
            let mut v = Vec::new();
            for g in a {
                let name = g.as_str().unwrap_or("");
                let Some(c) = canonical_group(name) else { return Err(CError::type_error(format!("Unknown Tesla clip group: {name}"))) };
                if !v.contains(&c) {
                    v.push(c);
                }
            }
            v
        }
        _ => return Err(CError::type_error("includedGroups must be an array")),
    };
    let order = group_order(config.get("groupOrder"))?;
    let source_root = resolve(Path::new(root));
    let source_real = fs::canonicalize(&source_root).map_err(io_err)?;
    let destination = match config.get("destinationRoot").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        Some(d) => Some(resolve_destination(d)?),
        None => None,
    };
    let root_group = source_root.file_name().and_then(|n| canonical_group(&n.to_string_lossy()));
    if root_group.is_some_and(|g| !included.contains(&g)) {
        return Ok(());
    }
    if let Some((abs, real)) = &destination {
        if *abs == source_root || *real == source_real {
            return Err(CError::type_error("destinationRoot must differ from sourceRoot"));
        }
    }
    let dest_abs_inside = destination.as_ref().is_some_and(|(a, _)| same_or_descendant(&source_root, a));
    let dest_real_inside = destination.as_ref().is_some_and(|(_, r)| same_or_descendant(&source_real, r));
    let w = Walk { included, order, source_root: source_root.clone(), source_real, destination, dest_abs_inside, dest_real_inside, cancel, retry };
    w.walk(&source_root, &[], root_group, &[], out)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_order() {
        assert_eq!(parse_tesla_filename("2026-10-20_07-44-14-front.mp4"), Some(("2026-10-20_07-44-14".into(), "front".into())));
        assert_eq!(parse_tesla_filename("2026-10-20_07-44-14-LEFT.MP4"), Some(("2026-10-20_07-44-14".into(), "left_repeater".into())));
        assert_eq!(parse_tesla_filename("2026-10-20_07-44-14-.mp4"), None);
        assert_eq!(parse_tesla_filename("2026-10-20-07-44-14-front.mp4"), None);
        let order = DEFAULT_GROUP_ORDER;
        assert_eq!(compare_scan_paths("SavedClips/a/x.mp4", "RecentClips/x.mp4", &order), Ordering::Less);
        assert_eq!(compare_scan_paths("SentryClips/a", "SentryClips/a/x.mp4", &order), Ordering::Less);
        assert_eq!(compare_scan_paths("SentryClips/b/x.mp4", "SentryClips/a/x.mp4", &order), Ordering::Greater);
        assert_eq!(compare_scan_paths("x", "x", &order), Ordering::Equal);
    }

    /// The same folder scanned by this scanner answers as Node's scanner
    /// (src/main/converter/scanner.js, through lean/parity/converterScan.js)
    /// answered: tests/fixtures/node-reference/converter-scan.json. Every
    /// file gets a fixed time; the inode numbers are this run's, put into
    /// Node's answer for the same file.
    #[test]
    fn parity_with_node_scanner() {
        let base = std::env::temp_dir().join(format!("lean-scan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("TeslaCam");
        let files = [
            "RecentClips/2026-10-20_07-44-14-front.mp4",
            "RecentClips/2026-10-20_07-44-14-LEFT_REPEATER.MP4",
            "RecentClips/2026-10-20_07-44-14-left.mp4",
            "RecentClips/notes.txt",
            "RecentClips/TEMP-H265-2026-10-20_07-44-14-front.mp4",
            "RecentClips/backup-2026-10-20_07-44-14-front.mp4",
            "SentryClips/2026-10-21_08-00-00/2026-10-21_07-59-00-back.mp4",
            "SentryClips/2026-10-21_08-00-00/event.json",
            "SentryClips/2026-10-21_08-00-00/thumb.PNG",
            "SentryClips/2026-10-21_08-00-00/event.mp4",
            "SentryClips/2026-10-21_08-00-00/.sentryusb-partial/2026-10-21_07-58-00-back.mp4",
            "SentryClips/2026-10-21_08-00-00/sub/2026-10-21_07-57-00-front.mp4",
            "SentryClips/2026-10-21_08-00-00/sub/event.json",
            "SentryClips/éclair/2026-10-21_07-56-00-front.mp4",
            "SentryClips/Zed/2026-10-21_07-55-00-front.mp4",
            "SavedClips/2026-10-19_10-00-00/2026-10-19_09-59-00-right.mp4",
            "SavedClips/2026-10-19_10-00-00/event.json",
            "sentryclips/2026-10-18_01-00-00-front.mp4",
            "Other/2026-10-17_01-00-00-front.mp4",
            "Other/event.json",
            "2026-10-16_01-00-00-front.mp4",
            ".hidden/2026-10-16_01-00-00-front.mp4",
        ];
        for (n, f) in files.iter().enumerate() {
            let p = root.join(f);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, f.as_bytes()).unwrap();
            // a fixed time, with a fraction of a millisecond
            let t = std::time::UNIX_EPOCH + std::time::Duration::from_nanos(1_792_000_000_000_000_000 + n as u64 * 61_000_123_457);
            fs::File::options().write(true).open(&p).unwrap().set_modified(t).unwrap();
        }
        std::os::unix::fs::symlink(root.join("RecentClips/2026-10-20_07-44-14-front.mp4"), root.join("RecentClips/2026-10-20_07-44-15-front.mp4")).unwrap();
        std::os::unix::fs::symlink(&root, root.join("SavedClips/loop")).unwrap();
        let ino_of = |v: &mut Value| {
            for i in v.as_array_mut().into_iter().flatten() {
                if let (Some(p), Some(_)) = (i.get("sourcePath").and_then(Value::as_str), i.get("ino")) {
                    use std::os::unix::fs::MetadataExt;
                    let ino = fs::metadata(p).unwrap().ino();
                    i["ino"] = json!(ino);
                }
            }
        };
        let configs = [
            json!({ "sourceRoot": root, "destinationRoot": base.join("out") }),
            json!({ "sourceRoot": root, "includedGroups": ["SentryClips", "RecentClips"], "groupOrder": ["RecentClips", "SentryClips", "SavedClips"] }),
            json!({ "sourceRoot": root.join("SentryClips"), "includedGroups": ["SentryClips"] }),
            json!({ "sourceRoot": root.join("SentryClips"), "includedGroups": ["RecentClips"] }),
            json!({ "sourceRoot": root, "destinationRoot": root.join("SentryClips/Zed") }),
            json!({ "sourceRoot": root, "destinationRoot": root }),
        ];
        for (n, config) in configs.iter().enumerate() {
            let places = [("{BASE}", base.to_string_lossy().into_owned())];
            let mut theirs = crate::reference::answer("converter-scan", &places, config);
            ino_of(&mut theirs["items"]);
            let mut mine = Vec::new();
            let r = scan(config, None, None, &mut |d| {
                let mut v = d.value.clone();
                v.as_object_mut().unwrap().shift_insert(7, "ino".into(), json!(d.ino));
                mine.push(v);
                true
            });
            if let Err(e) = r {
                mine.push(json!({ "error": if e.code.is_empty() { "TypeError".to_string() } else { e.code } }));
            }
            assert_eq!(Value::Array(mine.clone()), theirs["items"], "config {n}");
            let order = group_order(config.get("groupOrder")).unwrap();
            let paths: Vec<&str> = mine.iter().filter_map(|i| i.get("relativePath").and_then(Value::as_str)).collect();
            let mut compared = Vec::new();
            for a in &paths {
                for b in &paths {
                    compared.push(json!(compare_scan_paths(a, b, &order) as i8));
                }
            }
            assert_eq!(Value::Array(compared), theirs["compared"], "config {n}");
        }
        fs::remove_dir_all(&base).unwrap();
    }
}
