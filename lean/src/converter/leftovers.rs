//! Leftover BACKUP- files of an earlier replace. In "replace originals" mode
//! the original is linked (or, without hard links, moved) to BACKUP-<name>
//! beside it, the verified copy is renamed over <name>, and the backup name
//! is removed. A server killed in between, a job discarded while it needed
//! recovery, or a removal that was refused leaves BACKUP-<name>; the scanner
//! hides it, and every later replace of <name> fails (nlink 2 != 1).
//!
//! A replace job's discovery calls `tidy_folder` for each folder with such
//! names, before any clip of that folder is queued. A name is touched only
//! when no job record names it or could recover from it (`Owners`), no
//! replace, rollback or recovery holds it in this process (`Tx::try_hold`),
//! and the two names are in one of three exact shapes:
//! - a: BACKUP-X is a second name of X (same file, 2 names): the second name goes;
//! - b: X is missing and BACKUP-X is the original: it is put back as X;
//! - c: X is the converted copy (H.265/AV1) and BACKUP-X the H.264 original:
//!   the original goes to the Recycle Bin as the original of X (never deleted).
//!
//! - an unfinished copy TEMP-H265-X / TEMP-AV1-X beside X (the copy a replace
//!   writes before it touches the original; a later replace of X is refused
//!   while it is there): removed once X is there, the copy is a whole H.265 /
//!   AV1 file and X is another file. It is never an original.
//!
//! Anything else is kept and reported. Every step works in the folder opened
//! from the share's real root without following a link (safe_fs), with
//! fstatat(AT_SYMLINK_NOFOLLOW), renameat2(RENAME_NOREPLACE) (link + unlink
//! where a file system lacks it; never a plain rename) and unlinkat.

use super::jobstore::states::ItemState;
use super::jobstore::Manifest;
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

/// A name the tidy looks at (any letter case: other cases are reported, never touched).
pub fn is_leftover_name(name: &str) -> bool {
    let up = |p: &str| name.len() >= p.len() && name.as_bytes()[..p.len()].eq_ignore_ascii_case(p.as_bytes());
    up(PREFIX) || COPY_PREFIXES.iter().any(|(p, _)| up(p))
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
    /// the source folders of jobs with files still to settle
    pub roots: Vec<(PathBuf, String)>,
    /// the clips the calling job has not finished
    pub mine: HashSet<PathBuf>,
}

fn res(p: &str) -> PathBuf {
    super::owned::resolve(Path::new(p))
}

fn non_empty(v: Option<&Value>) -> bool {
    v.and_then(Value::as_object).is_some_and(|o| !o.is_empty())
}

impl Owners {
    fn collect(&mut self, holder: &Value, id: &str) {
        for v in holder.get("ownedPaths").and_then(Value::as_object).into_iter().flat_map(|o| o.values()) {
            if let Some(p) = v.as_str() {
                self.paths.insert(res(p), id.to_string());
            }
        }
        for v in holder.get("ownedArtifacts").and_then(Value::as_object).into_iter().flat_map(|o| o.values()) {
            if let Some(p) = v.get("path").and_then(Value::as_str) {
                self.paths.insert(res(p), id.to_string());
            }
        }
        if let Some(p) = holder.get("publicationArtifact").and_then(|a| a.get("path")).and_then(Value::as_str) {
            self.paths.insert(res(p), id.to_string());
        }
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
                self.sources.insert(res(src), id.clone());
            }
            if calling && !state.is_terminal() {
                self.mine.insert(res(src));
            }
        }
        if !calling && unsettled {
            if let Some(root) = m.config().get("sourceRoot").and_then(Value::as_str) {
                self.roots.push((res(root), id));
            }
        }
    }

    /// The clip's files a runtime holds in memory (written to its record next).
    pub fn add_owned(&mut self, holder: &Value, id: &str) {
        self.collect(holder, id);
    }

    /// Why BACKUP-X must stay, given every name of X and of BACKUP-X (lexical and real).
    pub fn why(&self, originals: &[PathBuf], backups: &[PathBuf]) -> Option<String> {
        for p in originals.iter().chain(backups) {
            if let Some(id) = self.paths.get(p) {
                return Some(format!("job {id} still names it in its record"));
            }
        }
        for p in originals {
            if let Some(id) = self.sources.get(p) {
                return Some(format!("job {id} can still recover this clip from it"));
            }
            if self.mine.contains(p) {
                return Some("this job has the clip in hand".into());
            }
            if let Some((_, id)) = self.roots.iter().find(|(r, _)| p.starts_with(r)) {
                return Some(format!("job {id} still has files to settle in this folder"));
            }
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
}

impl St {
    fn same(&self, o: &St) -> bool {
        self.dev == o.dev && self.ino == o.ino
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
    Ok(St { dev: st.st_dev, ino: st.st_ino, nlink: st.st_nlink, size: st.st_size as u64, regular: fmt == libc::S_IFREG, link: fmt == libc::S_IFLNK, dir: fmt == libc::S_IFDIR })
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
pub fn clip_of(f: &Found) -> Result<(&str, Role), String> {
    let (rest, role) = match f.name.strip_prefix(PREFIX) {
        Some(r) => (r, Role::Backup),
        None => match COPY_PREFIXES.iter().find_map(|(p, c)| f.name.strip_prefix(p).map(|r| (r, Role::Copy(c)))) {
            Some(x) => x,
            None => return Err("not the Encoder's name for it (other letter case)".into()),
        },
    };
    match f.kind {
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

/// What tidy_folder needs from its caller.
pub struct Tidy<'a> {
    pub tx: &'a Tx,
    pub bin: Option<&'a dyn OriginalsBin>,
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
    order.sort_by_key(|fd| !matches!(clip_of(fd), Ok((_, Role::Backup))));
    for found in order {
        let (clip, role) = match clip_of(found) {
            Ok(c) => c,
            Err(why) => {
                out.push((found.name.clone(), Outcome::Kept(why)));
                continue;
            }
        };
        let names = [s(f.dir.join(clip)), s(f.dir.join(&found.name)), s(f.real_dir.join(clip)), s(f.real_dir.join(&found.name))];
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
        let names = [super::owned::resolve(&f.dir.join(&found.name)), super::owned::resolve(&f.real_dir.join(&found.name))];
        let outcome = match owners.why(&originals, &names) {
            Some(why) => Outcome::Kept(why),
            None => {
                let r = match role {
                    Role::Backup => act(t, &dir, f.real_dir, clip, &found.name),
                    Role::Copy(codec) => unfinished_copy(&dir, clip, &found.name, codec),
                };
                r.unwrap_or_else(|e| Outcome::Kept(format!("{} ({})", e, super::owned::errno_code(&e))))
            }
        };
        drop(held);
        out.push((found.name.clone(), outcome));
    }
    out
}

/// Remove a name through the private quarantine name, only while it and `keep` (when
/// given) are still the files checked; put back on any mismatch.
fn remove_checked(dir: &OwnedFd, name: &str, st: &St, keep: Option<(&str, &St)>) -> io::Result<Option<String>> {
    let q = format!(".sentry-owned-remove-{}", random_hex(8));
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
        return kept(format!("the same file as \"{clip}\" but with {} names (only 2 is the Encoder's)", b.nlink));
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
    Ok(match bin.adopt_original(&real_dir.join(backup), &real_dir.join(clip), b.dev, b.ino) {
        Ok(item) => Outcome::Binned { item, codec: xc.map(str::to_string) },
        Err(why) => Outcome::Kept(format!("the original of \"{clip}\" (which is the converted {word} copy); not moved to the Recycle Bin: {why}")),
    })
}

/// The log line for one name (rel_dir: the folder below the source, "" for the source itself).
pub fn log_line(rel_dir: &str, name: &str, o: &Outcome) -> String {
    let clip = name.strip_prefix(PREFIX).unwrap_or(name);
    let at = if rel_dir.is_empty() { String::new() } else { format!(" in \"{rel_dir}/\"") };
    match o {
        Outcome::Removed => format!("[CONVERTER] BACKUP cleanup: removed the second name \"{name}\"{at} (the same file as \"{clip}\", 2 names; the clip is kept)"),
        Outcome::RemovedCopy(c) => format!("[CONVERTER] BACKUP cleanup: removed the unfinished copy \"{name}\"{at} ({}; the clip \"{}\" is kept)", codec_word(c), name.splitn(3, '-').nth(2).unwrap_or(name)),
        Outcome::Restored => format!("[CONVERTER] BACKUP cleanup: put the original back: \"{name}\" -> \"{clip}\"{at} (\"{clip}\" was missing)"),
        Outcome::Binned { item, codec: Some(c) } => format!("[CONVERTER] BACKUP cleanup: moved \"{name}\"{at} to the Recycle Bin as the original of \"{clip}\" (item {item}; \"{clip}\" is the converted {} copy)", codec_word(c)),
        Outcome::Binned { item, codec: None } => format!("[CONVERTER] BACKUP cleanup: moved \"{name}\"{at} to the Recycle Bin as the original of \"{clip}\" (item {item}; \"{clip}\" itself is in the Recycle Bin)"),
        Outcome::Kept(why) => format!("[CONVERTER] BACKUP cleanup: kept \"{name}\"{at}: {why}"),
    }
}

#[cfg(test)]
#[path = "leftovers_tests.rs"]
mod tests;
