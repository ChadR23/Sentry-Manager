//! Leftover BACKUP- files of an earlier replace. In "replace originals" mode
//! the original is linked (or, without hard links, moved) to BACKUP-<name>
//! beside it, the verified copy is renamed over <name>, and the backup name
//! is removed. A server killed in between, a job discarded while it needed
//! recovery, or a removal that was refused leaves BACKUP-<name>; the scanner
//! hides it, and every later replace of <name> fails (nlink 2 != 1).
//!
//! A replace job's discovery calls `tidy_folder` for each folder with such
//! names, before any clip of that folder is queued. A name is touched only
//! when no job record names it or could recover from it (`Owners`, matched by
//! path text, real path and the folder's identity, so another mount point of the
//! folder is the same folder), no
//! replace, rollback or recovery holds it in this process (`Tx::try_hold`),
//! and the two names are in one of three exact shapes:
//! - a: BACKUP-X is a second name of X (same file, 2 names): the second name goes;
//! - b: X is missing and BACKUP-X is the original: it is put back as X;
//! - c: X is the converted copy (H.265/AV1) and BACKUP-X the H.264 original:
//!   the original goes to the Recycle Bin as the original of X (never deleted),
//!   only once X passes the verifier's full check as a copy of BACKUP-X (a
//!   complete decode, frames and durations within its tolerance, every
//!   telemetry record: what final validation rests on). A copy that failed its
//!   final validation, or was never validated, keeps the original where it is.
//!
//! - an unfinished copy TEMP-H265-X / TEMP-AV1-X beside X (the copy a replace
//!   writes before it touches the original; a later replace of X is refused
//!   while it is there): removed once X is there, the copy is a whole H.265 /
//!   AV1 file and X is another file. It is never an original.
//!
//! - the tidy's own quarantine name `.sentry-tidy-<hex>-L` (a tidy stopped mid-removal):
//!   one more name of L's file goes; with L gone it is settled exactly as L would be.
//!
//! Anything else is kept and reported. Every step works in the folder opened
//! from the share's real root without following a link (safe_fs), with
//! fstatat(AT_SYMLINK_NOFOLLOW), renameat2(RENAME_NOREPLACE) (link + unlink
//! where a file system lacks it; never a plain rename) and unlinkat.

use super::jobstore::states::ItemState;
use super::jobstore::Manifest;
use super::mount_place::{Place, Table};
use super::staging::Tx;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};

pub const PREFIX: &str = "BACKUP-";
/// The unfinished copies' prefixes, and the codec each must hold.
pub const COPY_PREFIXES: [(&str, &str); 2] = [("TEMP-H265-", "h265"), ("TEMP-AV1-", "av1")];
/// The tidy's own quarantine name for a leftover name L it removes:
/// `.sentry-tidy-<16 hex>-L`. A server stopped between the rename and the unlink leaves
/// it (a hidden second name of the clip, or a copy); the next tidy settles it as L.
pub const QUARANTINE: &str = ".sentry-tidy-";
/// Why an original beside its converted copy is kept when the copy is not proven good
/// (the interfaces count these: web/backupCleanup.js).
pub const UNVERIFIED: &str = "the converted copy beside it is not verified";

/// The leftover name L that a tidy quarantine name stands for.
pub fn quarantined_name(name: &str) -> Option<&str> {
    let rest = name.strip_prefix(QUARANTINE)?;
    let (h, l) = (rest.get(..16)?, rest.get(16..)?.strip_prefix('-')?);
    (h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) && !l.is_empty()).then_some(l)
}

/// A name the tidy looks at (any letter case: other cases are reported, never touched),
/// and the tidy's own quarantine names.
pub fn is_leftover_name(name: &str) -> bool {
    let up = |p: &str| name.len() >= p.len() && name.as_bytes()[..p.len()].eq_ignore_ascii_case(p.as_bytes());
    up(PREFIX) || COPY_PREFIXES.iter().any(|(p, _)| up(p)) || quarantined_name(name).is_some()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Link,
    Dir,
    Other,
}

/// A name in a folder that starts with BACKUP- (any case), as the listing typed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub name: String,
    pub kind: Kind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// case a: the second name removed, the clip kept at its name
    Removed,
    /// a quarantine name the tidy left that was one more name of this leftover name's file
    RemovedExtra(String),
    /// an unfinished copy removed (its codec), the clip kept at its name
    RemovedCopy(String),
    /// case b: the original put back at its name
    Restored,
    /// case c (or b with the converted clip in the bin): moved to the Recycle Bin as
    /// the original of X (the item id; X's codec when X is there)
    Binned { item: String, codec: Option<String> },
    /// left as it is, and why
    Kept(String),
}

/// The Recycle Bin, for an original the Encoder left beside its converted copy.
pub trait OriginalsBin: Send + Sync {
    /// Move `backup` (still the file `dev`:`ino`) into the Recycle Bin of the vehicle whose
    /// folder holds it, listed under `original`'s name (Restore puts it back there). The
    /// item's id, or why it was not moved (the file is then where it was).
    fn adopt_original(&self, backup: &Path, original: &Path, dev: u64, ino: u64) -> Result<String, String>;
    /// The Recycle Bin lists a file that was at `original` (someone moved the clip there).
    fn holds(&self, original: &Path) -> bool;
}

/// What the job records still own: a BACKUP- name in here is never touched.
#[derive(Debug, Default)]
pub struct Owners {
    /// every path a record names (ownedPaths, ownedArtifacts, publicationArtifact), by job
    pub paths: HashMap<PathBuf, String>,
    /// clips whose BACKUP- name a recovery could derive (a replace that started), by job
    pub sources: HashMap<PathBuf, String>,
    /// the source folders of jobs with files still to settle (as written, made real, and by
    /// identity: staging::folder_identity)
    pub roots: Vec<(PathBuf, String)>,
    /// the source folders of jobs with files still to settle that do not resolve now (a
    /// mount that is gone, or not there yet): any folder may be one of them, so all are kept
    pub unreachable: Vec<(String, String)>,
    /// the clips the calling job has not finished
    pub mine: HashSet<PathBuf>,
    /// folders already made real (see `keys`)
    pub canon: HashMap<PathBuf, Option<PathBuf>>,
    /// the reachable roots by place (mount_place: the folder and every mount below it),
    /// as written, by job; None when a root cannot be placed (it is then kept)
    pub placed: Vec<(Option<Vec<Place>>, String, String)>,
    /// this process's mount table, read once
    pub mounts: std::sync::OnceLock<Option<Table>>,
}

fn res(p: &str) -> PathBuf {
    super::owned::resolve(Path::new(p))
}

fn non_empty(v: Option<&Value>) -> bool {
    v.and_then(Value::as_object).is_some_and(|o| !o.is_empty())
}

impl Owners {
    fn table(&self) -> Option<&Table> {
        self.mounts.get_or_init(Table::read).as_ref()
    }

    fn real(&mut self, dir: &Path) -> Option<PathBuf> {
        if let Some(r) = self.canon.get(dir) {
            return r.clone();
        }
        let r = std::fs::canonicalize(dir).ok();
        self.canon.insert(dir.to_path_buf(), r.clone());
        r
    }

    /// A record's path as it is written, with its folder made real, and by its folder's
    /// identity, the way the in-process holds key it (staging::hold_keys): a record that
    /// names a file through another spelling of its folder (a link to it, or another
    /// mount point of it) still owns that file.
    fn keys(&mut self, p: &str) -> Vec<PathBuf> {
        let l = res(p);
        let mut out = vec![l.clone()];
        if let (Some(parent), Some(name)) = (l.parent(), l.file_name()) {
            if let Some(r) = self.real(parent).map(|r| r.join(name)) {
                if r != l {
                    out.push(r);
                }
            }
            if let Some(k) = super::staging::folder_identity(parent, Some(name)) {
                out.push(k);
            }
        }
        out
    }

    /// An unsettled job's source folder as written, made real and by identity; one that
    /// does not resolve now is kept aside as unreachable (every folder is then kept).
    fn add_root(&mut self, p: &str, id: &str) {
        let l = res(p);
        let mut out = vec![l.clone()];
        match self.real(&l) {
            Some(r) => {
                if r != l {
                    out.push(r);
                }
                let places = self.table().and_then(|t| t.places(&l));
                self.placed.push((places, p.to_string(), id.to_string()));
            }
            None => self.unreachable.push((p.to_string(), id.to_string())),
        }
        out.extend(super::staging::folder_identity(&l, None));
        for k in out {
            self.roots.push((k, id.to_string()));
        }
    }

    fn own(&mut self, p: &str, id: &str) {
        for k in self.keys(p) {
            self.paths.insert(k, id.to_string());
        }
    }

    fn collect(&mut self, holder: &Value, id: &str) {
        for v in holder.get("ownedPaths").and_then(Value::as_object).into_iter().flat_map(|o| o.values()) {
            if let Some(p) = v.as_str() {
                self.own(p, id);
            }
        }
        for v in holder.get("ownedArtifacts").and_then(Value::as_object).into_iter().flat_map(|o| o.values()) {
            if let Some(p) = v.get("path").and_then(Value::as_str) {
                self.own(p, id);
            }
        }
        if let Some(p) = holder.get("publicationArtifact").and_then(|a| a.get("path")).and_then(Value::as_str) {
            self.own(p, id);
        }
    }

    /// A job whose record could not be replayed (its journal is damaged; the job is
    /// listed nowhere): every path anywhere in what can be read of it is owned, and its
    /// whole source folder is kept. Err when not even its source folder can be read.
    pub fn add_damaged(&mut self, id: &str, parts: &[Value]) -> Result<(), String> {
        fn walk(v: &Value, key: Option<&str>, paths: &mut Vec<String>, roots: &mut Vec<String>) {
            match v {
                Value::String(s) if s.starts_with('/') => {
                    if key == Some("sourceRoot") {
                        roots.push(s.clone());
                    }
                    paths.push(s.clone());
                }
                Value::Array(a) => a.iter().for_each(|x| walk(x, key, paths, roots)),
                Value::Object(o) => o.iter().for_each(|(k, x)| walk(x, Some(k), paths, roots)),
                _ => {}
            }
        }
        let (mut paths, mut roots) = (Vec::new(), Vec::new());
        for v in parts {
            walk(v, None, &mut paths, &mut roots);
        }
        if roots.is_empty() {
            return Err(format!("job {id}'s record is damaged and names no source folder"));
        }
        for p in paths {
            self.own(&p, id);
        }
        for r in roots {
            self.add_root(&r, id);
        }
        Ok(())
    }

    /// One job's record (the runtime's copy when it has one). `calling`: the job whose
    /// discovery is tidying (its own unfinished clips are in its hands).
    pub fn add_manifest(&mut self, m: &Manifest, calling: bool) {
        let id = m.id().to_string();
        let top = Value::Object(m.top.clone());
        self.collect(&top, &id);
        let replace = m.config().get("outputMode").and_then(Value::as_str) == Some("replace");
        let mut unsettled = !m.state().is_terminal() || non_empty(top.get("ownedPaths"));
        for it in &m.items {
            let v = it.value();
            self.collect(v, &id);
            let state = ItemState::parse(v["state"].as_str().unwrap_or(""));
            let owns = non_empty(v.get("ownedPaths"));
            unsettled |= owns;
            let Some(src) = v.get("sourcePath").and_then(Value::as_str) else { continue };
            let active = top.get("replacementPhase").is_some_and(|p| !p.is_null()) && top.get("activeItemId").and_then(Value::as_str) == Some(it.id());
            let started = v.get("replacementPhase").is_some_and(|p| !p.is_null()) || owns || state == ItemState::Processing || active;
            if replace && started {
                for k in self.keys(src) {
                    self.sources.insert(k, id.clone());
                }
            }
            if calling && !state.is_terminal() {
                for k in self.keys(src) {
                    self.mine.insert(k);
                }
            }
        }
        if !calling && unsettled {
            if let Some(root) = m.config().get("sourceRoot").and_then(Value::as_str) {
                self.add_root(root, &id);
            }
        }
    }

    /// The clip's files a runtime holds in memory (written to its record next).
    pub fn add_owned(&mut self, holder: &Value, id: &str) {
        self.collect(holder, id);
    }

    /// Why BACKUP-X must stay, given every name of X and of BACKUP-X (lexical and real).
    /// Each is also compared by its folder's identity, and the folder and each folder above
    /// it against the roots' identities (another mount point of the same folder).
    pub fn why(&self, originals: &[PathBuf], backups: &[PathBuf]) -> Option<String> {
        let with_ids = |ps: &[PathBuf]| -> Vec<PathBuf> {
            let mut out = ps.to_vec();
            for p in ps {
                if let (Some(parent), Some(name)) = (p.parent(), p.file_name()) {
                    out.extend(super::staging::folder_identity(parent, Some(name)));
                }
            }
            out
        };
        let (originals, backups) = (with_ids(originals), with_ids(backups));
        for p in originals.iter().chain(&backups) {
            if let Some(id) = self.paths.get(p) {
                return Some(format!("job {id} still names it in its record"));
            }
        }
        for p in &originals {
            if let Some(id) = self.sources.get(p) {
                return Some(format!("job {id} can still recover this clip from it"));
            }
            if self.mine.contains(p) {
                return Some("this job has the clip in hand".into());
            }
            if let Some((_, id)) = self.roots.iter().find(|(r, _)| r.is_absolute() && p.is_absolute() && p.starts_with(r)) {
                return Some(format!("job {id} still has files to settle in this folder"));
            }
            // (the folder and every folder above it, by identity)
            if p.is_absolute() {
                for a in p.ancestors().skip(1) {
                    if let Some(k) = super::staging::folder_identity(a, None) {
                        if let Some((_, id)) = self.roots.iter().find(|(r, _)| *r == k) {
                            return Some(format!("job {id} still has files to settle in this folder"));
                        }
                    }
                }
            }
        }
        // (by place: a bind mount of a folder below the root is not above the clip's
        // folder, so walking the folders above misses it; mount_place sees it)
        for p in originals.iter().filter(|p| p.is_absolute()) {
            let Some(dir) = p.parent() else { continue };
            let here = self.table().and_then(|t| t.place(dir));
            for (places, root, id) in &self.placed {
                match (places, &here) {
                    (Some(ps), Some(h)) => {
                        if super::mount_place::holds(ps, h) {
                            return Some(format!("job {id} still has files to settle in this folder"));
                        }
                        // (another device that may show the same files: an overlay, a FUSE
                        // union or a network share of them, which paths cannot compare)
                        if let Some(o) = ps.iter().find(|o| super::mount_place::cannot_tell(o, h)) {
                            return Some(if o.opaque {
                                format!("job {id}'s folder is on a merged or network mount and cannot be told apart from this folder")
                            } else {
                                format!("this folder is on a merged or network mount and cannot be told apart from job {id}'s folder")
                            });
                        }
                    }
                    _ => return Some(format!("job {id} still has files to settle in \"{root}\", which cannot be told apart from this folder now")),
                }
            }
        }
        if let Some((root, id)) = self.unreachable.first() {
            return Some(format!("job {id} still has files to settle in \"{root}\", which cannot be reached now (it may be this folder)"));
        }
        None
    }
}

// ---- the folder's own operations (all relative to its pinned fd)

fn cstr(name: &str) -> io::Result<CString> {
    CString::new(name.as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
}

#[derive(Debug, Clone, Copy)]
struct St {
    dev: u64,
    ino: u64,
    nlink: u64,
    size: u64,
    regular: bool,
    link: bool,
    dir: bool,
    /// modification and change times (ns)
    mtime: i128,
    ctime: i128,
}

impl St {
    fn same(&self, o: &St) -> bool {
        self.dev == o.dev && self.ino == o.ino
    }
    /// the same file, not written or changed since
    fn unchanged(&self, o: &St) -> bool {
        self.same(o) && self.regular == o.regular && self.nlink == o.nlink && self.size == o.size && self.mtime == o.mtime && self.ctime == o.ctime
    }
}

fn stat_at_once(dir: &OwnedFd, name: &str) -> io::Result<St> {
    let c = cstr(name)?;
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: an open folder fd, a NUL-terminated name and a stat buffer
    if unsafe { libc::fstatat(dir.as_raw_fd(), c.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let fmt = st.st_mode & libc::S_IFMT;
    let ns = |s: i64, n: i64| s as i128 * 1_000_000_000 + n as i128;
    Ok(St {
        dev: st.st_dev,
        ino: st.st_ino,
        nlink: u64::from(st.st_nlink),
        size: st.st_size as u64,
        regular: fmt == libc::S_IFREG,
        link: fmt == libc::S_IFLNK,
        dir: fmt == libc::S_IFDIR,
        mtime: ns(st.st_mtime, st.st_mtime_nsec),
        ctime: ns(st.st_ctime, st.st_ctime_nsec),
    })
}

/// fstatat without following a link; a link count above one is asked of the file system
/// itself again (statx FORCE_SYNC: a cifs or NFS client keeps it cached, see staging fresh_lstat).
fn stat_at(dir: &OwnedFd, name: &str) -> io::Result<St> {
    let st = stat_at_once(dir, name)?;
    if st.nlink <= 1 {
        return Ok(st);
    }
    if let Ok(c) = cstr(name) {
        let mut sx: libc::statx = unsafe { std::mem::zeroed() };
        // SAFETY: as above; the answer is not used (the call refreshes the cached attributes)
        unsafe {
            libc::statx(dir.as_raw_fd(), c.as_ptr(), libc::AT_SYMLINK_NOFOLLOW | libc::AT_STATX_FORCE_SYNC, libc::STATX_BASIC_STATS, &mut sx);
        }
    }
    stat_at_once(dir, name)
}

fn missing(e: &io::Error) -> bool {
    e.raw_os_error() == Some(libc::ENOENT)
}

/// renameat2(RENAME_NOREPLACE) inside the folder; link + unlink where the file system has
/// no such rename (link never replaces either). Never a plain rename.
fn rename_noreplace_at(dir: &OwnedFd, from: &str, to: &str) -> io::Result<()> {
    hook("rename-before", from, to)?;
    let (a, b) = (cstr(from)?, cstr(to)?);
    let fd = dir.as_raw_fd();
    // SAFETY: an open folder fd and two NUL-terminated names
    let r = unsafe { libc::syscall(libc::SYS_renameat2, fd, a.as_ptr(), fd, b.as_ptr(), libc::RENAME_NOREPLACE) };
    if r == 0 {
        return Ok(());
    }
    let e = io::Error::last_os_error();
    if !matches!(e.raw_os_error(), Some(libc::EINVAL) | Some(libc::ENOSYS) | Some(libc::EOPNOTSUPP)) {
        return Err(e);
    }
    // SAFETY: as above
    if unsafe { libc::linkat(fd, a.as_ptr(), fd, b.as_ptr(), 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    unlink_at(dir, from)
}

fn unlink_at(dir: &OwnedFd, name: &str) -> io::Result<()> {
    let c = cstr(name)?;
    // SAFETY: an open folder fd and a NUL-terminated name
    if unsafe { libc::unlinkat(dir.as_raw_fd(), c.as_ptr(), 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// The clip's codec (h264 / h265 / av1) from its MP4 header, read through a handle opened
/// without following a link, and only if it is still the file `want`.
fn codec_at(dir: &OwnedFd, name: &str, want: &St) -> Option<&'static str> {
    let c = cstr(name).ok()?;
    // SAFETY: an open folder fd and a NUL-terminated name; the fd is owned from here
    let fd = unsafe { libc::openat(dir.as_raw_fd(), c.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK) };
    if fd < 0 {
        return None;
    }
    let f = std::fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
    use std::os::unix::fs::MetadataExt;
    let m = f.metadata().ok()?;
    if !m.is_file() || m.dev() != want.dev || m.ino() != want.ino {
        return None;
    }
    let o = super::mp4_header::ReadOptions { size: Some(m.len()), ..Default::default() };
    let entry = super::mp4_header::read_sample_entry_from(&f, &o).ok()??;
    super::mp4_header::codec_for_sample_entry(&entry)
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut b);
    }
    super::tesla_sei::hex(&b)
}

fn codec_word(c: &str) -> &'static str {
    match c {
        "h265" => "H.265",
        "av1" => "AV1",
        "h264" => "H.264",
        _ => "unknown",
    }
}

// ---- test kill points

#[cfg(test)]
pub type TestHook = std::sync::Arc<dyn Fn(&str, &str, &str) -> io::Result<()> + Send + Sync>;
#[cfg(test)]
pub static TEST_HOOK: std::sync::RwLock<Option<TestHook>> = std::sync::RwLock::new(None);

#[cfg(test)]
fn hook(event: &str, a: &str, b: &str) -> io::Result<()> {
    let h = TEST_HOOK.read().unwrap().clone();
    match h {
        Some(h) => h(event, a, b),
        None => Ok(()),
    }
}

#[cfg(not(test))]
#[inline(always)]
fn hook(_event: &str, _a: &str, _b: &str) -> io::Result<()> {
    Ok(())
}

// ---- which names

/// What a leftover name is to the clip it names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// BACKUP-X: the original, or a second name of it
    Backup,
    /// TEMP-<CODEC>-X: a copy of the encode, which must hold this codec
    Copy(&'static str),
}

/// The clip name X of a leftover name this module may act on and what the name is to it,
/// or why it is only reported.
/// A tidy quarantine name answers for the leftover name it stands for.
pub fn clip_of(f: &Found) -> Result<(&str, Role), String> {
    match quarantined_name(&f.name) {
        Some(l) if quarantined_name(l).is_some() => Err("a leftover name of a leftover name".into()),
        Some(l) => clip_of_name(l, f.kind),
        None => clip_of_name(&f.name, f.kind),
    }
}

fn clip_of_name(name: &str, kind: Kind) -> Result<(&str, Role), String> {
    let (rest, role) = match name.strip_prefix(PREFIX) {
        Some(r) => (r, Role::Backup),
        None => match COPY_PREFIXES.iter().find_map(|(p, c)| name.strip_prefix(p).map(|r| (r, Role::Copy(c)))) {
            Some(x) => x,
            None => return Err("not the Encoder's name for it (other letter case)".into()),
        },
    };
    match kind {
        Kind::File => {}
        Kind::Link => return Err("a symbolic link (never followed)".into()),
        Kind::Dir => return Err("a folder, not a backup".into()),
        Kind::Other => return Err("not a regular file".into()),
    }
    if is_leftover_name(rest) {
        return Err("a leftover name of a leftover name".into());
    }
    if super::scanner::parse_tesla_filename(rest).is_none() {
        return Err("the rest of the name is not a Tesla clip name".into());
    }
    Ok((rest, role))
}

/// (original, converted copy, codec) -> Ok when the copy is proven good (Tidy::verify)
pub type VerifyConverted<'a> = dyn Fn(&Path, &Path, &'static str) -> Result<(), String> + Sync + 'a;

/// The verifier's full check of `converted` as the copy of `original` (as a conversion's
/// verify step and so its final validation: ffprobe codec and tag, a complete decode with
/// ffmpeg, frame counts, durations and dimensions within the verifier's tolerance, every
/// telemetry record mapped), only reading both files: neither is moved or changed, and the
/// verifier's private snapshot is removed again. Err: the verifier's reason.
#[allow(clippy::too_many_arguments)]
pub fn verify_converted(original: &Path, converted: &Path, codec: &str, ffprobe: &str, ffmpeg: &str, runner: &dyn super::process::Runner, registry: &super::snapshot::Registry, cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>) -> Result<(), String> {
    use super::adapters::Codec;
    let codec = match codec {
        "h265" => Codec::H265,
        "av1" => Codec::Av1,
        other => return Err(format!("not a converted codec ({other})")),
    };
    let v = super::verifier::verify_candidate(&super::verifier::VerifyOptions {
        source: original.to_path_buf(),
        candidate: converted.to_path_buf(),
        codec,
        profile_id: super::contracts::CUSTOM_PROFILE_ID.into(),
        verify_mode: Some("full".into()),
        keep_off_target: true,
        allow_larger: true,
        trusted_snapshot: false,
        // (never: adopting moves the candidate into the snapshot)
        adopt_candidate: false,
        decode_accel: vec![],
        source_duration_us: None,
        source_timeline: None,
        ffprobe_path: ffprobe.into(),
        ffmpeg_path: ffmpeg.into(),
        run_ffprobe: runner,
        run_full_decode: runner,
        registry,
        on_decode_accel_fallback: None,
        cancel,
    });
    if let Some(a) = &v.publication_artifact {
        super::snapshot::discard_artifact(registry, a);
    }
    if v.ok {
        return Ok(());
    }
    let kind = v.details.get("kind").and_then(Value::as_str).map(|k| format!(", {k}")).unwrap_or_default();
    Err(format!("{}{kind}", v.reason.unwrap_or("verification-failed")))
}

/// What tidy_folder needs from its caller.
pub struct Tidy<'a> {
    pub tx: &'a Tx,
    pub bin: Option<&'a dyn OriginalsBin>,
    /// The check that the converted copy beside an original is a whole, good copy of it
    /// (verify_converted: the verifier's full check, which final validation rests on), given
    /// (original, converted copy, its codec): Err says what it found. None: not checked, so
    /// an original beside its converted copy is kept.
    pub verify: Option<&'a VerifyConverted<'a>>,
    /// the job records, read after the names are held (Err: kept, and why)
    pub owners: &'a dyn Fn() -> Result<Owners, String>,
}

/// One folder of a replace job's source: `dir` as the scan walks it, `real_dir` the same
/// folder below the share's real root (opened from `real_root` without following a link).
pub struct Folder<'a> {
    pub real_root: &'a Path,
    pub dir: &'a Path,
    pub real_dir: &'a Path,
    pub found: &'a [Found],
}

/// Settle the leftover names of one folder: (name, what happened) for each, the backups
/// first (one may put a clip back that a copy then needs to be beside).
pub fn tidy_folder(t: &Tidy, f: &Folder) -> Vec<(String, Outcome)> {
    let mut out: Vec<(String, Outcome)> = Vec::new();
    let mut work: Vec<(&Found, &str, Role, super::staging::Held)> = Vec::new();
    let s = |p: PathBuf| p.to_string_lossy().into_owned();
    let mut order: Vec<&Found> = f.found.iter().collect();
    // (the tidy's own quarantine names first: one may be just one more name of a leftover name)
    order.sort_by_key(|fd| match (quarantined_name(&fd.name), clip_of(fd)) {
        (Some(_), _) => 0,
        (None, Ok((_, Role::Backup))) => 1,
        _ => 2,
    });
    for found in order {
        let (clip, role) = match clip_of(found) {
            Ok(c) => c,
            Err(why) => {
                out.push((found.name.clone(), Outcome::Kept(why)));
                continue;
            }
        };
        let label = quarantined_name(&found.name).unwrap_or(&found.name);
        let names = [s(f.dir.join(clip)), s(f.dir.join(&found.name)), s(f.dir.join(label)), s(f.real_dir.join(clip)), s(f.real_dir.join(&found.name)), s(f.real_dir.join(label))];
        match t.tx.try_hold(&names.iter().map(String::as_str).collect::<Vec<_>>()) {
            Some(h) => work.push((found, clip, role, h)),
            None => out.push((found.name.clone(), Outcome::Kept("in use by a conversion right now".into()))),
        }
    }
    if work.is_empty() {
        return out;
    }
    // (read after the names are held: from here a record can only let go of one, never take one)
    let owners = match (t.owners)() {
        Ok(o) => o,
        Err(why) => {
            out.extend(work.into_iter().map(|(fd, ..)| (fd.name.clone(), Outcome::Kept(why.clone()))));
            return out;
        }
    };
    let dir = match crate::footage::safe_fs::open_dir_inside(f.real_root, f.real_dir, false) {
        Ok(d) => d,
        Err(e) => {
            let why = if crate::footage::safe_fs::is_escape(&e) { "the folder is reached through a link (never followed)".to_string() } else { format!("the folder could not be opened ({})", super::owned::errno_code(&e)) };
            out.extend(work.into_iter().map(|(fd, ..)| (fd.name.clone(), Outcome::Kept(why.clone()))));
            return out;
        }
    };
    for (found, clip, role, held) in work {
        let originals = [super::owned::resolve(&f.dir.join(clip)), super::owned::resolve(&f.real_dir.join(clip))];
        let label = quarantined_name(&found.name);
        let mut names = vec![super::owned::resolve(&f.dir.join(&found.name)), super::owned::resolve(&f.real_dir.join(&found.name))];
        if let Some(l) = label {
            names.extend([super::owned::resolve(&f.dir.join(l)), super::owned::resolve(&f.real_dir.join(l))]);
        }
        let outcome = match owners.why(&originals, &names) {
            Some(why) => Outcome::Kept(why),
            None => {
                let r = match (label, role) {
                    (Some(l), _) => quarantined(t, &dir, f.real_dir, clip, l, &found.name, role),
                    (None, Role::Backup) => act(t, &dir, f.real_dir, clip, &found.name),
                    (None, Role::Copy(codec)) => unfinished_copy(&dir, clip, &found.name, codec),
                };
                r.unwrap_or_else(|e| Outcome::Kept(format!("{} ({})", e, super::owned::errno_code(&e))))
            }
        };
        drop(held);
        out.push((found.name.clone(), outcome));
    }
    out
}

/// Remove a name through the tidy's quarantine name for it (a name that is one already is
/// removed as it is), only while it and `keep` (when given) are still the files checked;
/// put back on any mismatch.
fn remove_checked(dir: &OwnedFd, name: &str, st: &St, keep: Option<(&str, &St)>) -> io::Result<Option<String>> {
    if quarantined_name(name).is_some() {
        let now = stat_at(dir, name).ok();
        let kept_ok = keep.is_none_or(|(k, want)| stat_at(dir, k).ok().is_some_and(|n| n.regular && n.same(want)));
        if !now.is_some_and(|n| n.regular && n.same(st) && n.nlink == st.nlink) || !kept_ok {
            return Ok(Some("it changed while it was tidied".into()));
        }
        unlink_at(dir, name)?;
        return Ok(None);
    }
    let q = format!("{QUARANTINE}{}-{name}", random_hex(8));
    rename_noreplace_at(dir, name, &q)?;
    hook("quarantined", name, &q)?;
    let qs = stat_at(dir, &q).ok();
    let ks = keep.map(|(k, _)| stat_at(dir, k).ok());
    let kept_ok = match (keep, ks) {
        (Some((_, want)), Some(now)) => now.is_some_and(|n| n.regular && n.same(want)),
        _ => true,
    };
    if !qs.is_some_and(|q| q.regular && q.same(st)) || !kept_ok {
        return Ok(Some(match rename_noreplace_at(dir, &q, name) {
            Ok(()) => "it changed while it was tidied".to_string(),
            Err(e) => format!("it changed while it was tidied; left as \"{q}\" ({})", super::owned::errno_code(&e)),
        }));
    }
    unlink_at(dir, &q)?;
    Ok(None)
}

/// TEMP-<CODEC>-X: the copy a replace writes beside X before it touches the original.
fn unfinished_copy(dir: &OwnedFd, clip: &str, name: &str, codec: &'static str) -> io::Result<Outcome> {
    let c = match stat_at(dir, name) {
        Ok(c) => c,
        Err(e) if missing(&e) => return kept("no longer there"),
        Err(e) => return Err(e),
    };
    if !c.regular {
        return kept(if c.link { "a symbolic link (never followed)" } else { "not a regular file" });
    }
    let x = match stat_at(dir, clip) {
        Ok(x) => x,
        Err(e) if missing(&e) => return kept(format!("\"{clip}\" is missing: the copy is kept")),
        Err(e) => return Err(e),
    };
    if !x.regular {
        return kept(format!("\"{clip}\" is not a regular file"));
    }
    if x.same(&c) {
        return kept(format!("the same file as \"{clip}\""));
    }
    if c.nlink != 1 {
        return kept(format!("it has {} names", c.nlink));
    }
    let found = codec_at(dir, name, &c);
    if found != Some(codec) {
        return kept(format!("not a whole {} copy ({})", codec_word(codec), found.map_or("unreadable", codec_word)));
    }
    Ok(match remove_checked(dir, name, &c, Some((clip, &x)))? {
        None => Outcome::RemovedCopy(codec.to_string()),
        Some(why) => Outcome::Kept(why),
    })
}

fn kept(why: impl Into<String>) -> io::Result<Outcome> {
    Ok(Outcome::Kept(why.into()))
}

/// `q`: the tidy's quarantine name for the leftover name `label` (a tidy stopped between
/// its rename and its unlink, or between the link and the unlink of a rename without
/// renameat2). When `label` is still there as the same file, `q` is only one more name of
/// it and goes (label is then settled on its own); when `label` is gone, `q` is settled
/// exactly as `label` would be.
fn quarantined(t: &Tidy, dir: &OwnedFd, real_dir: &Path, clip: &str, label: &str, q: &str, role: Role) -> io::Result<Outcome> {
    let qs = match stat_at(dir, q) {
        Ok(s) => s,
        Err(e) if missing(&e) => return kept("no longer there"),
        Err(e) => return Err(e),
    };
    if !qs.regular {
        return kept(if qs.link { "a symbolic link (never followed)" } else { "not a regular file" });
    }
    let ls = match stat_at(dir, label) {
        Ok(s) => Some(s),
        Err(e) if missing(&e) => None,
        Err(e) => return Err(e),
    };
    match ls {
        Some(l) if l.regular && l.same(&qs) => {
            let x_too = matches!(stat_at(dir, clip), Ok(x) if x.regular && x.same(&qs));
            let here = 2 + u64::from(x_too);
            if qs.nlink != here {
                return kept(format!("the same file as \"{label}\" but with {} names (this folder has {here} of them)", qs.nlink));
            }
            Ok(match remove_checked(dir, q, &qs, Some((label, &l)))? {
                None => Outcome::RemovedExtra(label.to_string()),
                Some(why) => Outcome::Kept(why),
            })
        }
        Some(_) => kept(format!("\"{label}\" is there again and is another file")),
        None => match role {
            Role::Backup => act(t, dir, real_dir, clip, q),
            Role::Copy(codec) => unfinished_copy(dir, clip, q, codec),
        },
    }
}

fn act(t: &Tidy, dir: &OwnedFd, real_dir: &Path, clip: &str, backup: &str) -> io::Result<Outcome> {
    let b = match stat_at(dir, backup) {
        Ok(b) => b,
        Err(e) if missing(&e) => return kept("no longer there"),
        Err(e) => return Err(e),
    };
    if !b.regular {
        return kept(if b.link { "a symbolic link (never followed)" } else { "not a regular file" });
    }
    let x = match stat_at(dir, clip) {
        Ok(x) => Some(x),
        Err(e) if missing(&e) => None,
        Err(e) => return Err(e),
    };
    match x {
        Some(x) if x.link => kept(format!("\"{clip}\" is a symbolic link (never followed)")),
        Some(x) if !x.regular => kept(format!("\"{clip}\" is {}", if x.dir { "a folder" } else { "not a regular file" })),
        Some(x) if x.same(&b) => second_name(dir, clip, backup, &b),
        Some(x) => beside_copy(t, dir, real_dir, clip, backup, &b, &x),
        None => put_back(t, dir, real_dir, clip, backup, &b),
    }
}

/// case a: BACKUP-X is a second name of X.
fn second_name(dir: &OwnedFd, clip: &str, backup: &str, b: &St) -> io::Result<Outcome> {
    if b.nlink != 2 {
        return kept(format!("the same file as \"{clip}\" but with {} names (an Encoder backup has exactly 2)", b.nlink));
    }
    Ok(match remove_checked(dir, backup, b, Some((clip, b)))? {
        None => Outcome::Removed,
        Some(why) => Outcome::Kept(why),
    })
}

/// case b: X is missing and BACKUP-X is the original.
fn put_back(t: &Tidy, dir: &OwnedFd, real_dir: &Path, clip: &str, backup: &str, b: &St) -> io::Result<Outcome> {
    if b.nlink != 1 {
        return kept(format!("it has {} names", b.nlink));
    }
    if b.size == 0 {
        return kept("it is empty");
    }
    // (the converted clip was moved to the Recycle Bin by someone: the original is not brought back over that choice)
    if let Some(bin) = t.bin.filter(|bin| bin.holds(&real_dir.join(clip))) {
        return Ok(match bin.adopt_original(&real_dir.join(backup), &real_dir.join(clip), b.dev, b.ino) {
            Ok(item) => Outcome::Binned { item, codec: None },
            Err(why) => Outcome::Kept(format!("\"{clip}\" is in the Recycle Bin, and this original could not join it: {why}")),
        });
    }
    match rename_noreplace_at(dir, backup, clip) {
        Ok(()) => {}
        Err(e) if e.raw_os_error() == Some(libc::EEXIST) => return kept(format!("\"{clip}\" appeared meanwhile; both kept")),
        Err(e) => return Err(e),
    }
    match stat_at(dir, clip) {
        Ok(s) if s.regular && s.same(b) => Ok(Outcome::Restored),
        _ => kept(format!("put back as \"{clip}\", but that name changed right after; check it by hand")),
    }
}

/// case c: X is another file: only the converted copy beside its H.264 original.
fn beside_copy(t: &Tidy, dir: &OwnedFd, real_dir: &Path, clip: &str, backup: &str, b: &St, x: &St) -> io::Result<Outcome> {
    if x.nlink != 1 || b.nlink != 1 {
        return kept(format!("\"{clip}\" and its backup are different files with more names ({} and {})", x.nlink, b.nlink));
    }
    let xc = codec_at(dir, clip, x);
    let bc = codec_at(dir, backup, b);
    let converted = matches!(xc, Some("h265") | Some("av1"));
    if !converted || bc != Some("h264") {
        return kept(format!("\"{clip}\" ({}) is not a converted copy of this H.264 original ({})", xc.map_or("unreadable", codec_word), bc.map_or("unreadable", codec_word)));
    }
    let word = codec_word(xc.unwrap());
    let Some(bin) = t.bin else {
        return kept(format!("the original of \"{clip}\" (which is the converted {word} copy); this folder has no Recycle Bin, delete it by hand once \"{clip}\" plays"));
    };
    // (only beside a copy proven good: a copy that failed its final validation, or was never
    // validated, is no stand-in for its original. Both are read through the pinned folder.)
    let Some(verify) = t.verify else {
        return kept(format!("{UNVERIFIED} (it cannot be checked here)"));
    };
    let pinned = PathBuf::from(format!("/proc/self/fd/{}", dir.as_raw_fd()));
    if let Err(found) = verify(&pinned.join(backup), &pinned.join(clip), xc.unwrap()) {
        return kept(format!("{UNVERIFIED} (the {word} copy \"{clip}\" failed the check: {found})"));
    }
    // (and both are still the files checked, unchanged)
    let still = |name: &str, want: &St| stat_at(dir, name).ok().is_some_and(|n| n.unchanged(want));
    if !still(clip, x) || !still(backup, b) {
        return kept("it changed while it was tidied");
    }
    Ok(match bin.adopt_original(&real_dir.join(backup), &real_dir.join(clip), b.dev, b.ino) {
        Ok(item) => Outcome::Binned { item, codec: xc.map(str::to_string) },
        Err(why) => Outcome::Kept(format!("the original of \"{clip}\" (which is the converted {word} copy); not moved to the Recycle Bin: {why}")),
    })
}

/// The log line for one name (rel_dir: the folder below the source, "" for the source itself).
pub fn log_line(rel_dir: &str, name: &str, o: &Outcome) -> String {
    let clip = match clip_of_name(quarantined_name(name).unwrap_or(name), Kind::File) {
        Ok((c, _)) => c,
        Err(_) => name.strip_prefix(PREFIX).unwrap_or(name),
    };
    let at = if rel_dir.is_empty() { String::new() } else { format!(" in \"{rel_dir}/\"") };
    match o {
        Outcome::Removed => format!("[CONVERTER] BACKUP cleanup: removed the second name \"{name}\"{at} (the same file as \"{clip}\", 2 names; the clip is kept)"),
        Outcome::RemovedCopy(c) => format!("[CONVERTER] BACKUP cleanup: removed the unfinished copy \"{name}\"{at} ({}; the clip \"{clip}\" is kept)", codec_word(c)),
        Outcome::RemovedExtra(l) => format!("[CONVERTER] BACKUP cleanup: removed \"{name}\"{at}, a name an earlier tidy left (one more name of \"{l}\")"),
        Outcome::Restored => format!("[CONVERTER] BACKUP cleanup: put the original back: \"{name}\" -> \"{clip}\"{at} (\"{clip}\" was missing)"),
        Outcome::Binned { item, codec: Some(c) } => format!("[CONVERTER] BACKUP cleanup: moved \"{name}\"{at} to the Recycle Bin as the original of \"{clip}\" (item {item}; \"{clip}\" is the converted {} copy)", codec_word(c)),
        Outcome::Binned { item, codec: None } => format!("[CONVERTER] BACKUP cleanup: moved \"{name}\"{at} to the Recycle Bin as the original of \"{clip}\" (item {item}; \"{clip}\" itself is in the Recycle Bin)"),
        Outcome::Kept(why) => format!("[CONVERTER] BACKUP cleanup: kept \"{name}\"{at}: {why}"),
    }
}

#[cfg(test)]
#[path = "leftovers_tests.rs"]
mod tests;
