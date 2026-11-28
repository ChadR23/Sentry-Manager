//! Non-mutating folder access checks, performed by the server's effective identity.
//! Never infer access from mode bits: ACL masks and mounted filesystems decide it.
use super::service::{Fail, SResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::{HashMap, HashSet}, ffi::CString, fs, os::unix::{ffi::OsStrExt, fs::MetadataExt}, path::{Path, PathBuf}, sync::{Mutex, OnceLock}};

pub const EXAMPLES: usize = 5;
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Issues { pub count: u64, pub examples: Vec<String> }
impl Issues {
    pub fn note(&mut self, path: &Path, error: &std::io::Error) {
        self.count += 1;
        if self.examples.len() < EXAMPLES { self.examples.push(format!("{}: {} ({})",path.display(),super::owned::errno_code(error),error)); }
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct RootReport { pub root: String, pub role: String, pub read_only_count: u64, pub examples: Vec<Value>, pub unreadable: Issues }
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub struct Report {
    pub roots: Vec<RootReport>, pub read_only_count: u64, pub process_uid: u32, pub process_gid: u32, pub hint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub newest_folder: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub root_blocked: bool,
}
impl Report {
    pub fn has_warning(&self) -> bool { self.read_only_count > 0 || self.root_blocked }

    pub fn refusal(&self) -> Fail {
        Fail { code: Some("FOLDERS_NOT_WRITABLE".into()), retryable: true, detail: Some(self.detail()), ..Default::default() }
    }
    pub fn detail(&self)->String {
        let roots=self.roots.iter().map(|r|format!("{} {}: {} folders are read-only{}{}",r.role,r.root,r.read_only_count,
            if r.examples.is_empty(){String::new()}else{format!("; {}",r.examples.iter().map(|e|format!("{} (owner uid/gid {}/{}, mode {})",e["folder"].as_str().unwrap_or(""),e["ownerUid"],e["ownerGid"],e["mode"].as_str().unwrap_or("unknown"))).collect::<Vec<_>>().join("; "))},
            if r.unreadable.count==0 {String::new()}else{format!("; {} paths could not be read: {}",r.unreadable.count,r.unreadable.examples.join("; "))})).collect::<Vec<_>>().join(". ");
        let newest = self.newest_folder.as_ref().map(|p| format!(" Newest dated folder: {p}.")).unwrap_or_default();
        format!("{roots}.{newest} {}", self.hint)
    }
}
pub fn hint()->String {format!("Give these folders to the user the app runs as (uid/gid {}/{}), with write and search permission, e.g. Unraid > Tools > Docker Safe New Perms, or chown/chmod; check ACL masks and read-only mounts too. Fix the uploader's permissions: new footage arriving this way will be flagged again.",unsafe{libc::geteuid()},unsafe{libc::getegid()})}
pub fn writable(dir:&Path)->std::io::Result<()> {
    let path=CString::new(dir.as_os_str().as_bytes()).map_err(|_|std::io::Error::from_raw_os_error(libc::EINVAL))?;
    // glibc uses faccessat2 where available; AT_EACCESS includes effective uid,
    // effective gid and supplementary groups. X_OK is needed to create entries.
    if unsafe{libc::faccessat(libc::AT_FDCWD,path.as_ptr(),libc::W_OK|libc::X_OK,libc::AT_EACCESS)}==0 {Ok(())} else {Err(std::io::Error::last_os_error())}
}
pub fn denied(error:&std::io::Error)->bool {matches!(error.raw_os_error(),Some(libc::EACCES|libc::EPERM|libc::EROFS))}
pub fn folder_detail(dir:&Path)->Value {
    let m=fs::metadata(dir).ok();
    json!({"folder":dir.to_string_lossy(),"ownerUid":m.as_ref().map(|m|m.uid()),"ownerGid":m.as_ref().map(|m|m.gid()),"mode":m.map(|m|format!("{:04o}",m.mode()&0o7777)),"processUid":unsafe{libc::geteuid()},"processGid":unsafe{libc::getegid()}})
}
/// Missing copy subfolders need permission on the nearest existing ancestor.
pub fn existing_parent(dir:&Path)->PathBuf {
    let mut p=dir.to_path_buf();
    while fs::symlink_metadata(&p).is_err_and(|e|e.kind()==std::io::ErrorKind::NotFound) {if !p.pop(){break;}}
    p
}
/// Tesla dates sort chronologically across clip groups, including timestamped event folders.
fn footage_date_name(path: &str) -> Option<&str> {
    let name = Path::new(path).file_name()?.to_str()?;
    chrono::NaiveDate::parse_from_str(name.get(..10)?, "%Y-%m-%d").ok()?;
    Some(name)
}

impl RootReport {
    fn note_read_only(&mut self, dir: &Path) {
        self.read_only_count += 1;
        let name = dir.to_str().and_then(footage_date_name);
        let at = self.examples.iter().position(|e| name > e["folder"].as_str().and_then(footage_date_name))
            .unwrap_or(self.examples.len());
        if at < EXAMPLES {
            self.examples.insert(at, folder_detail(dir));
            self.examples.truncate(EXAMPLES);
        }
    }
}

fn walk(dir:&Path, out:&mut RootReport, seen:&mut HashSet<PathBuf>) {
    // Do not follow symlinked folders, just like converter discovery.
    if !seen.insert(dir.to_path_buf()){return;}
    if let Err(e)=writable(dir) {
        if denied(&e) { out.note_read_only(dir); }
        else {out.unreadable.note(dir,&e);}
    }
    let entries=match fs::read_dir(dir) {Ok(v)=>v,Err(e)=>{out.unreadable.note(dir,&e);return;}};
    for entry in entries {
        match entry {
            Ok(e)=>match e.file_type(){Ok(t) if t.is_dir() && !e.file_name().to_string_lossy().starts_with('.')=>walk(&e.path(),out,seen),Ok(_)=>{},Err(err)=>out.unreadable.note(&e.path(),&err)},
            Err(e)=>out.unreadable.note(dir,&e),
        }
    }
}
fn key(config:&Value)->String {format!("{}\0{}",config["sourceRoot"].as_str().unwrap_or(""),config["destinationRoot"].as_str().unwrap_or(""))}
static REPORTS:OnceLock<Mutex<HashMap<String,Report>>>=OnceLock::new();
pub fn scan(config:&Value)->Report {
    let mut r=Report{process_uid:unsafe{libc::geteuid()},process_gid:unsafe{libc::getegid()},hint:hint(),..Default::default()};
    for (field,role) in [("sourceRoot","Source"),("destinationRoot","Copy destination")] {
        let Some(root)=config[field].as_str().filter(|s|!s.is_empty()) else{continue};
        if field=="destinationRoot" && config["outputMode"]=="replace" {continue;}
        let mut rr=RootReport{root:root.into(),role:role.into(),..Default::default()};
        let dir=if field=="destinationRoot"{existing_parent(Path::new(root))}else{PathBuf::from(root)};
        // The root (or the parent where a future destination must be created)
        // is an admission prerequisite, independent of the examples we retain.
        r.root_blocked |= writable(&dir).is_err_and(|e| denied(&e))
            || (field == "sourceRoot" && fs::read_dir(&dir).is_err_and(|e| denied(&e)));
        if field=="destinationRoot" && dir!=Path::new(root) {
            if let Err(e)=writable(&dir) {if denied(&e){rr.note_read_only(&dir);}else{rr.unreadable.note(&dir,&e);}}
        } else {walk(&dir,&mut rr,&mut HashSet::new());}
        r.read_only_count+=rr.read_only_count;r.roots.push(rr);
    }
    r.newest_folder = r.roots.iter().flat_map(|root| &root.examples)
        .filter_map(|e| e["folder"].as_str()).filter_map(|p| footage_date_name(p).map(|date| (date, p)))
        .max().map(|(_, path)| path.to_owned());
    let mut cache=REPORTS.get_or_init(Default::default).lock().unwrap();
    if cache.len()>=128 && !cache.contains_key(&key(config)){cache.clear();}
    cache.insert(key(config),r.clone());r
}
pub fn cached(config:&Value)->Option<Report>{REPORTS.get_or_init(Default::default).lock().unwrap().get(&key(config)).cloned()}
/// Only permission errors become a folder wait. A vanished file or a network
/// error still goes through the existing source and publication recovery paths.
fn check_dir(dir: &Path) -> SResult<()> {
    let parent = existing_parent(dir);
    if let Err(error) = writable(&parent) {
        if denied(&error) {
            return Err(Fail { code: Some("FOLDER_NOT_WRITABLE".into()), retryable: true,
                detail: Some(format!("{}: {error}", folder_detail(&parent))), ..Default::default() });
        }
    }
    Ok(())
}

fn check_targets(config: &Value, item: &Value, mut check: impl FnMut(&Path) -> SResult<()>) -> SResult<()> {
    if let Some(dir) = item["sourcePath"].as_str().and_then(|p| Path::new(p).parent()) {
        check(dir)?;
    }
    if config["outputMode"] == "separate" {
        let output = super::service::output_path(config, item);
        if let Some(dir) = Path::new(&output).parent() { check(dir)?; }
    }
    Ok(())
}

pub fn check_item(config: &Value, item: &Value) -> SResult<()> {
    check_targets(config, item, check_dir)
}

/// Cache only within one admission decision. The worker and the publisher
/// check afresh, including permission changes on ancestors and remounted shares.
#[derive(Default)]
pub struct FolderChecks(HashMap<PathBuf, SResult<()>>);

impl FolderChecks {
    pub fn allows(&mut self, config: &Value, item: &Value) -> bool {
        check_targets(config, item, |dir| {
            if let Some(result) = self.0.get(dir) { return result.clone(); }
            let result = check_dir(dir);
            self.0.insert(dir.to_owned(), result.clone());
            result
        }).is_ok()
    }
}

/// Only walk the eligible clips if the folder inventory found a problem.
/// Stop at the first writable candidate. An empty future schedule is allowed.
pub fn discovery_access(config: &Value, skip: impl Fn(&super::scanner::Discovered) -> bool) -> SResult<Option<bool>> {
    let order = super::scanner::group_order(config.get("groupOrder")).map_err(Fail::from)?;
    let after = config["resumeAfter"].as_str();
    let mut checks = FolderChecks::default();
    let mut writable_work = None;
    let inaccessible = std::cell::Cell::new(false);
    let issue = |path: &Path, error: &std::io::Error| {
        if denied(error) { inaccessible.set(true); }
        super::service::log_line(format!("[CONVERTER] Discovery skipped {}: {}: {error}", path.display(), super::owned::errno_code(error)));
    };
    super::scanner::scan_reporting(config, None, None, None, &issue, None, &mut |clip| {
        if after.is_some_and(|p| super::scanner::compare_scan_paths(clip.value["relativePath"].as_str().unwrap_or(""), p, &order).is_le())
            || skip(&clip) { return true; }
        let writable = checks.allows(config, &clip.value);
        writable_work = Some(writable);
        !writable
    }).map_err(Fail::from)?;
    // A selected directory that discovery could not enter may hold work.
    // Only a fully enumerated, empty selection can admit an idle schedule.
    Ok(writable_work.or_else(|| inaccessible.get().then_some(false)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    #[test]
    fn readonly_effective_access_matches_real_create_and_preserves_mtime() {
        let temp=crate::converter::testutil::tempdir().unwrap();
        let root=std::env::var_os("LEAN_FOLDER_ACCESS_FIXTURE").map(PathBuf::from).unwrap_or_else(||temp.path().to_path_buf());
        if std::env::var_os("LEAN_FOLDER_ACCESS_FIXTURE").is_none() {
            for (name,mode) in [("denied",0o555),("allowed",0o755)] {let p=root.join(name);fs::create_dir(&p).unwrap();fs::set_permissions(p,fs::Permissions::from_mode(mode)).unwrap();}
        }
        for (name,expected) in [("denied",false),("allowed",true)] {
            let dir=root.join(name);let before=fs::metadata(&dir).unwrap();
            let result=writable(&dir);let after=fs::metadata(&dir).unwrap();
            assert_eq!((before.mtime(),before.mtime_nsec()),(after.mtime(),after.mtime_nsec()));
            assert_eq!(result.is_ok(),expected,"{} {result:?}",dir.display());
            let probe=dir.join("test-create");let create=fs::OpenOptions::new().write(true).create_new(true).open(&probe);
            assert_eq!(create.is_ok(),expected,"kernel access must agree with actual create");
            drop(create);if expected {fs::remove_file(probe).unwrap();}
            eprintln!("access agreed with actual create: {} expected={expected} {}",dir.display(),folder_detail(&dir));
        }
        if root==temp.path(){fs::set_permissions(root.join("denied"),fs::Permissions::from_mode(0o755)).unwrap();}
    }
}
