//! server/posixOwnedFs.js: the only ways the converter removes or renames a
//! file it does not create in that same step. A file is touched only after
//! its device, inode, size and SHA-256 (hashed with the file held open, and
//! unchanged while it was hashed) match what the converter recorded, or,
//! for a file whose content the converter has just proven, its device, inode,
//! size and modification time (`identity_only`).
//!
//! Removal renames the verified file to a private quarantine name first and
//! checks the inode again there before unlinking (it is put back on a
//! mismatch). Promotion calls renameat2(RENAME_NOREPLACE) directly (what
//! native/noreplace-rename.c does for Node); on SMB the CIFS client sends it
//! as a server-side rename that never replaces. Filesystems without it fall
//! back to link + unlink, where link never replaces either.

use sha2::{Digest, Sha256};
use std::ffi::CString;
use std::fs::{self, File};
use std::io::{self, Read};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

const HASH_CHUNK: usize = 4 * 1024 * 1024;

/// What the converter recorded of a file it owns.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expected {
    pub device: String,
    pub inode: String,
    pub size: u64,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mtime_ns: Option<String>,
}

/// The errno name of an io::Error, as Node's err.code.
pub fn errno_code(e: &io::Error) -> &'static str {
    match e.raw_os_error() {
        Some(n) => errno_name(n),
        None => match e.kind() {
            io::ErrorKind::NotFound => "ENOENT",
            io::ErrorKind::AlreadyExists => "EEXIST",
            io::ErrorKind::PermissionDenied => "EACCES",
            io::ErrorKind::UnexpectedEof => "EIO",
            _ => "EIO",
        },
    }
}

pub fn errno_name(n: i32) -> &'static str {
    match n {
        libc::EEXIST => "EEXIST",
        libc::ENOENT => "ENOENT",
        libc::EINVAL => "EINVAL",
        libc::ENOSYS => "ENOSYS",
        libc::EXDEV => "EXDEV",
        libc::EACCES => "EACCES",
        libc::EPERM => "EPERM",
        libc::EBUSY => "EBUSY",
        libc::EIO => "EIO",
        libc::ENOTDIR => "ENOTDIR",
        libc::EISDIR => "EISDIR",
        libc::ENOTEMPTY => "ENOTEMPTY",
        libc::EROFS => "EROFS",
        libc::ENOSPC => "ENOSPC",
        libc::ETIMEDOUT => "ETIMEDOUT",
        libc::EHOSTDOWN => "EHOSTDOWN",
        libc::ESTALE => "ESTALE",
        libc::EAGAIN => "EAGAIN",
        libc::ENOTCONN => "ENOTCONN",
        libc::EOPNOTSUPP => "EOPNOTSUPP",
        libc::ELOOP => "ELOOP",
        libc::EMLINK => "EMLINK",
        libc::ENETDOWN => "ENETDOWN",
        libc::EHOSTUNREACH => "EHOSTUNREACH",
        libc::ECONNRESET => "ECONNRESET",
        libc::ECONNABORTED => "ECONNABORTED",
        libc::ENETUNREACH => "ENETUNREACH",
        libc::EBADF => "EBADF",
        _ => "EIO",
    }
}

fn code_err(code: &'static str, msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::Other, OwnedError { code, msg: msg.into() })
}

#[derive(Debug)]
pub struct OwnedError {
    pub code: &'static str,
    pub msg: String,
}
impl std::fmt::Display for OwnedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.msg, self.code)
    }
}
impl std::error::Error for OwnedError {}

/// err.code of an error from this module (an errno name or one of ours).
pub fn code_of(e: &io::Error) -> &'static str {
    if let Some(o) = e.get_ref().and_then(|r| r.downcast_ref::<OwnedError>()) {
        return o.code;
    }
    errno_code(e)
}

fn cpath(p: &Path) -> io::Result<CString> {
    CString::new(p.as_os_str().as_bytes()).map_err(|_| code_err("EINVAL", "path holds a NUL byte"))
}

/// renameat2(from, to, RENAME_NOREPLACE): never replaces `to`.
pub fn rename_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    if !from.is_absolute() || !to.is_absolute() {
        return Err(code_err("EINVAL", "noreplace rename needs absolute paths"));
    }
    let (f, t) = (cpath(from)?, cpath(to)?);
    // SAFETY: two valid NUL-terminated paths; renameat2 reads them only.
    let r = unsafe { libc::syscall(libc::SYS_renameat2, libc::AT_FDCWD, f.as_ptr(), libc::AT_FDCWD, t.as_ptr(), libc::RENAME_NOREPLACE) };
    if r == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Move a file to `to` only if nothing exists there; falls back to link + unlink.
pub fn move_noreplace(from: &Path, to: &Path) -> io::Result<()> {
    match rename_noreplace(from, to) {
        Ok(()) => return Ok(()),
        Err(e) => {
            if !["EINVAL", "ENOSYS", "EOPNOTSUPP"].contains(&code_of(&e)) {
                return Err(e);
            }
        }
    }
    fs::hard_link(from, to)?; // EEXIST if taken: never replaces
    fs::remove_file(from)
}

fn valid_path(p: &Path) -> bool {
    p.is_absolute() && !p.as_os_str().as_bytes().contains(&0)
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

pub fn valid_expected(e: &Expected) -> bool {
    digits(&e.device)
        && digits(&e.inode)
        && e.size <= super::mp4w::MAX_SAFE
        && e.sha256.len() == 64
        && e.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn same_identity(m: &fs::Metadata, e: &Expected) -> bool {
    m.dev().to_string() == e.device && m.ino().to_string() == e.inode
}

pub fn mtime_ns(m: &fs::Metadata) -> String {
    (m.mtime() as i128 * 1_000_000_000 + m.mtime_nsec() as i128).to_string()
}

fn identity_only_for(e: &Expected, requested: bool) -> bool {
    requested && e.mtime_ns.as_deref().is_some_and(digits)
}

pub enum Opened {
    Verified(File, fs::Metadata),
    Missing,
    /// which check refused, and the values that did not match (observed != recorded)
    Mismatch(String),
}

/// The fields of `st` that differ from the record, as "dev 1 != 2; ino 3 != 4; size 5 != 6"
/// (observed != recorded); empty when all match.
pub fn identity_diffs(st: &fs::Metadata, e: &Expected) -> String {
    let mut d = Vec::new();
    if st.dev().to_string() != e.device {
        d.push(format!("dev {} != {}", st.dev(), e.device));
    }
    if st.ino().to_string() != e.inode {
        d.push(format!("ino {} != {}", st.ino(), e.inode));
    }
    if st.size() != e.size {
        d.push(format!("size {} != {}", st.size(), e.size));
    }
    d.join("; ")
}

/// "dev:ino A != B" of two stats, or None when they are the same file.
fn dev_ino_diff(now: Option<&fs::Metadata>, want: &fs::Metadata) -> Option<String> {
    match now {
        None => Some("missing".into()),
        Some(m) if !m.is_file() => Some("not a regular file".into()),
        Some(m) if m.dev() != want.dev() || m.ino() != want.ino() => Some(format!("dev:ino {}:{} != {}:{}", m.dev(), m.ino(), want.dev(), want.ino())),
        Some(_) => None,
    }
}

/// SHA-256 of an open file from its start, and how many bytes were read.
pub fn hash_handle(f: &mut File, size: u64) -> io::Result<(String, u64)> {
    use std::io::{Seek, SeekFrom};
    f.seek(SeekFrom::Start(0))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; HASH_CHUNK.min(size.max(1) as usize)];
    let mut n = 0u64;
    loop {
        let r = f.read(&mut buf)?;
        if r == 0 {
            break;
        }
        h.update(&buf[..r]);
        n += r as u64;
    }
    Ok((super::tesla_sei::hex(&h.finalize()), n))
}

/// openVerified: open without following links and prove it is the expected
/// file. The handle stays open for the caller's next step.
pub fn open_verified(target: &Path, e: &Expected, identity_only: bool) -> io::Result<Opened> {
    let mut f = match fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(target) {
        Ok(f) => f,
        Err(err) => {
            return match code_of(&err) {
                "ENOENT" => Ok(Opened::Missing),
                "ELOOP" => Ok(Opened::Mismatch("open: symbolic link (ELOOP)".into())),
                _ => Err(err),
            }
        }
    };
    let st = f.metadata()?;
    if !st.is_file() || !same_identity(&st, e) || st.size() != e.size {
        let d = if st.is_file() { identity_diffs(&st, e) } else { "not a regular file".into() };
        return Ok(Opened::Mismatch(format!("fstat: {d}")));
    }
    if identity_only {
        if Some(mtime_ns(&st)) != e.mtime_ns {
            return Ok(Opened::Mismatch(format!("identity-only: mtime_ns {} != {}", mtime_ns(&st), e.mtime_ns.as_deref().unwrap_or("none"))));
        }
        return Ok(Opened::Verified(f, st));
    }
    let (digest, bytes) = hash_handle(&mut f, e.size)?;
    // written to while it was hashed: the hash proves nothing about it now
    let after = f.metadata()?;
    if bytes != e.size || digest != e.sha256 || mtime_ns(&after) != mtime_ns(&st) || after.size() != st.size() || !same_identity(&after, e) {
        let mut d = Vec::new();
        if bytes != e.size {
            d.push(format!("bytes read {} != size {}", bytes, e.size));
        }
        if digest != e.sha256 {
            d.push("sha256 differs from record".to_string());
        }
        if mtime_ns(&after) != mtime_ns(&st) {
            d.push(format!("mtime_ns changed while hashed {} -> {}", mtime_ns(&st), mtime_ns(&after)));
        }
        if after.size() != st.size() {
            d.push(format!("size changed while hashed {} -> {}", st.size(), after.size()));
        }
        if !same_identity(&after, e) {
            d.push(format!("identity after hash: {}", identity_diffs(&after, e)));
        }
        return Ok(Opened::Mismatch(format!("full hash: {}", d.join("; "))));
    }
    Ok(Opened::Verified(f, st))
}

fn lstat(p: &Path) -> Option<fs::Metadata> {
    fs::symlink_metadata(p).ok()
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    if let Ok(mut f) = File::open("/dev/urandom") {
        let _ = f.read_exact(&mut b);
    }
    super::tesla_sei::hex(&b)
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    pub removed: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub missing: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub ownership_mismatch: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub guard_mismatch: bool,
    /// on a mismatch: which check refused and what did not match
    #[serde(skip)]
    pub reason: String,
}

impl RemoveResult {
    fn mismatch(reason: String) -> Self {
        RemoveResult { ownership_mismatch: true, reason, ..Default::default() }
    }
    fn guard(reason: String) -> Self {
        RemoveResult { ownership_mismatch: true, guard_mismatch: true, reason, ..Default::default() }
    }
}

pub struct Guard<'a> {
    pub target: &'a Path,
    pub expected: &'a Expected,
    pub identity_only: bool,
}

/// removeOwned.remove({ target, expected, guard, identityOnly })
pub fn remove(target: &Path, expected: &Expected, guard: Option<Guard>, identity_only: bool) -> io::Result<RemoveResult> {
    if !valid_path(target) || !valid_expected(expected) || guard.as_ref().is_some_and(|g| !valid_path(g.target) || !valid_expected(g.expected)) {
        return Ok(RemoveResult::mismatch("remove: invalid target, record or guard record".into()));
    }
    let mut guarded = None;
    if let Some(g) = &guard {
        match open_verified(g.target, g.expected, identity_only_for(g.expected, g.identity_only))? {
            Opened::Verified(f, st) => {
                f.sync_all()?;
                guarded = Some((f, st));
            }
            Opened::Missing => return Ok(RemoveResult::guard("remove guard (kept file): missing".into())),
            Opened::Mismatch(r) => return Ok(RemoveResult::guard(format!("remove guard (kept file): {r}"))),
        }
    }
    let victim = match open_verified(target, expected, identity_only_for(expected, identity_only))? {
        Opened::Missing => return Ok(RemoveResult { missing: true, ..Default::default() }),
        Opened::Mismatch(r) => return Ok(RemoveResult::mismatch(format!("remove victim: {r}"))),
        Opened::Verified(f, st) => (f, st),
    };
    let dir = target.parent().unwrap_or(Path::new("/"));
    let quarantine = dir.join(format!(".sentry-owned-remove-{}", random_hex(8)));
    move_noreplace(target, &quarantine)?;
    test_hook("quarantined", target, &quarantine)?;
    let moved = lstat(&quarantine);
    if !moved.as_ref().is_some_and(|m| m.is_file() && m.dev() == victim.1.dev() && m.ino() == victim.1.ino()) {
        // Something replaced the path between the check and the rename: put it back.
        let d = dev_ino_diff(moved.as_ref(), &victim.1).unwrap_or_default();
        let _ = move_noreplace(&quarantine, target);
        return Ok(RemoveResult::mismatch(format!("remove quarantine lstat: {d}")));
    }
    if let (Some(g), Some((_, gst))) = (&guard, &guarded) {
        let now = lstat(g.target);
        if !now.as_ref().is_some_and(|m| m.dev() == gst.dev() && m.ino() == gst.ino()) {
            let d = match now.as_ref() {
                None => "missing".to_string(),
                Some(m) => format!("dev:ino {}:{} != {}:{}", m.dev(), m.ino(), gst.dev(), gst.ino()),
            };
            let _ = move_noreplace(&quarantine, target);
            return Ok(RemoveResult::guard(format!("remove guard (kept file) lstat after quarantine: {d}")));
        }
    }
    fs::remove_file(&quarantine)?;
    drop(victim);
    drop(guarded);
    Ok(RemoveResult { removed: true, ..Default::default() })
}

/// path.resolve for an absolute path: lexical normalization.
pub fn resolve(p: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(n) => out.push(n),
            _ => {}
        }
    }
    out
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoteResult {
    pub atomic_no_replace: bool,
    pub source_removed: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub ownership_mismatch: bool,
    /// on a mismatch: which check refused and what did not match
    #[serde(skip)]
    pub reason: String,
}

/// renameExclusive.promote({ from, to, expectedSource, removeSource, identityOnly })

/// Kill points for the crash tests (crashPoints.js wraps renameExclusive and
/// the no-replace rename the same way): called around each move.
#[cfg(test)]
pub type TestHook = std::sync::Arc<dyn Fn(&str, &Path, &Path) -> io::Result<()> + Send + Sync>;
#[cfg(test)]
pub static TEST_HOOK: std::sync::RwLock<Option<TestHook>> = std::sync::RwLock::new(None);

#[cfg(test)]
fn test_hook(event: &str, from: &Path, to: &Path) -> io::Result<()> {
    let h = TEST_HOOK.read().unwrap().clone();
    match h {
        Some(h) => h(event, from, to),
        None => Ok(()),
    }
}

#[cfg(not(test))]
#[inline(always)]
fn test_hook(_event: &str, _from: &Path, _to: &Path) -> io::Result<()> {
    Ok(())
}

pub fn promote(from: &Path, to: &Path, expected: Option<&Expected>, remove_source: bool, identity_only: bool) -> io::Result<PromoteResult> {
    test_hook("promote-before", from, to)?;
    let r = promote_inner(from, to, expected, remove_source, identity_only)?;
    test_hook("promote-after", from, to)?;
    Ok(r)
}

fn promote_inner(from: &Path, to: &Path, expected: Option<&Expected>, remove_source: bool, identity_only: bool) -> io::Result<PromoteResult> {
    if !valid_path(from) || !valid_path(to) || resolve(from) == resolve(to) {
        return Err(code_err("ENOTSUP", "Promotion requires two distinct absolute paths."));
    }
    let mismatch = |reason: String| PromoteResult { atomic_no_replace: true, source_removed: false, ownership_mismatch: true, reason };
    if !remove_source {
        // Keep the source: publish a hard link.
        let st = fs::symlink_metadata(from)?;
        match expected {
            Some(e) if st.is_file() && same_identity(&st, e) && st.size() == e.size => {}
            Some(e) if st.is_file() => return Ok(mismatch(format!("promote (keep source) lstat: {}", identity_diffs(&st, e)))),
            Some(_) => return Ok(mismatch("promote (keep source) lstat: not a regular file".into())),
            None => return Ok(mismatch("promote (keep source): no record".into())),
        }
        fs::hard_link(from, to)?;
        return Ok(PromoteResult { atomic_no_replace: true, source_removed: false, ownership_mismatch: false, reason: String::new() });
    }
    let Some(e) = expected.filter(|e| valid_expected(e)) else { return Ok(mismatch("promote: no valid record".into())) };
    let (_f, st) = match open_verified(from, e, identity_only_for(e, identity_only))? {
        Opened::Missing => return Err(code_err("ENOENT", "Source is missing.")),
        Opened::Mismatch(r) => return Ok(mismatch(format!("promote source: {r}"))),
        Opened::Verified(f, st) => (f, st),
    };
    move_noreplace(from, to)?;
    let landed = fs::symlink_metadata(to)?;
    if landed.dev() != st.dev() || landed.ino() != st.ino() {
        let d = format!("promote landed lstat: dev:ino {}:{} != {}:{}", landed.dev(), landed.ino(), st.dev(), st.ino());
        let _ = move_noreplace(to, from);
        return Ok(mismatch(d));
    }
    Ok(PromoteResult { atomic_no_replace: true, source_removed: true, ownership_mismatch: false, reason: String::new() })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkResult {
    Linked,
    /// no hard links here: the caller moves the original aside instead
    Unsupported,
    OwnershipMismatch,
}

/// renameExclusive.linkBackup({ from, to, expectedSource, identityOnly })
pub fn link_backup(from: &Path, to: &Path, expected: &Expected, identity_only: bool) -> io::Result<LinkResult> {
    match test_hook("link-before", from, to) {
        Err(e) if e.kind() == io::ErrorKind::Unsupported => return Ok(LinkResult::Unsupported),
        Err(e) => return Err(e),
        Ok(()) => {}
    }
    let r = link_backup_inner(from, to, expected, identity_only)?;
    test_hook("link-after", from, to)?;
    Ok(r)
}

fn link_backup_inner(from: &Path, to: &Path, expected: &Expected, identity_only: bool) -> io::Result<LinkResult> {
    if !valid_path(from) || !valid_path(to) || resolve(from) == resolve(to) {
        return Err(code_err("ENOTSUP", "Linking requires two distinct absolute paths."));
    }
    if !valid_expected(expected) {
        return Ok(LinkResult::OwnershipMismatch);
    }
    let (_f, st) = match open_verified(from, expected, identity_only_for(expected, identity_only))? {
        Opened::Missing => return Err(code_err("ENOENT", "Source is missing.")),
        Opened::Mismatch(_) => return Ok(LinkResult::OwnershipMismatch),
        Opened::Verified(f, st) => (f, st),
    };
    if let Err(err) = fs::hard_link(from, to) {
        if ["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK", "EINVAL"].contains(&code_of(&err)) {
            return Ok(LinkResult::Unsupported);
        }
        return Err(err);
    }
    let linked = lstat(to);
    let named = lstat(from);
    let same = |m: &Option<fs::Metadata>| m.as_ref().is_some_and(|m| m.is_file() && m.dev() == st.dev() && m.ino() == st.ino());
    if !same(&linked) || !same(&named) {
        // a share that reports a new inode per name: no usable link
        if same(&named) && linked.as_ref().is_some_and(|l| l.is_file() && l.size() == st.size()) {
            let _ = fs::remove_file(to);
            return Ok(LinkResult::Unsupported);
        }
        return Ok(LinkResult::OwnershipMismatch);
    }
    Ok(LinkResult::Linked)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplaceResult {
    pub replaced: bool,
    pub ownership_mismatch: bool,
    /// on a mismatch: which check refused and what did not match
    pub reason: String,
}

/// renameExclusive.replaceOver({ from, to, keep, expectedSource, expectedTarget, identityOnly }):
/// rename(2) the verified `from` over `to`, which must still be the file
/// `expected_target` names (device, inode) with that same file at `keep`.
pub fn replace_over(from: &Path, to: &Path, keep: &Path, expected: &Expected, target_dev: &str, target_ino: &str, identity_only: bool) -> io::Result<ReplaceResult> {
    test_hook("replace-before", from, to)?;
    let r = replace_over_inner(from, to, keep, expected, target_dev, target_ino, identity_only)?;
    test_hook("replace-after", from, to)?;
    Ok(r)
}

#[allow(clippy::too_many_arguments)]
fn replace_over_inner(from: &Path, to: &Path, keep: &Path, expected: &Expected, target_dev: &str, target_ino: &str, identity_only: bool) -> io::Result<ReplaceResult> {
    let distinct = {
        let (a, b, c) = (resolve(from), resolve(to), resolve(keep));
        a != b && b != c && a != c
    };
    if !valid_path(from) || !valid_path(to) || !valid_path(keep) || !distinct {
        return Err(code_err("ENOTSUP", "Replacing requires three distinct absolute paths."));
    }
    let no = |reason: String| ReplaceResult { replaced: false, ownership_mismatch: true, reason };
    if !valid_expected(expected) || !digits(target_dev) || !digits(target_ino) {
        return Ok(no("replace-over: invalid candidate record or original dev/ino".into()));
    }
    let (_f, st) = match open_verified(from, expected, identity_only_for(expected, identity_only))? {
        Opened::Missing => return Err(code_err("ENOENT", "Source is missing.")),
        Opened::Mismatch(r) => return Ok(no(format!("replace-over candidate: {r}"))),
        Opened::Verified(f, st) => (f, st),
    };
    let target_diff = |m: &Option<fs::Metadata>| match m {
        None => Some("missing".to_string()),
        Some(m) if !m.is_file() => Some("not a regular file".to_string()),
        Some(m) if m.dev().to_string() != target_dev || m.ino().to_string() != target_ino => Some(format!("dev:ino {}:{} != {}:{}", m.dev(), m.ino(), target_dev, target_ino)),
        Some(_) => None,
    };
    let (at_to, at_keep) = (target_diff(&lstat(to)), target_diff(&lstat(keep)));
    if at_to.is_some() || at_keep.is_some() {
        let mut d = Vec::new();
        if let Some(x) = at_to {
            d.push(format!("original name lstat: {x}"));
        }
        if let Some(x) = at_keep {
            d.push(format!("backup name lstat: {x}"));
        }
        return Ok(no(format!("replace-over before rename: {}", d.join("; "))));
    }
    fs::rename(from, to)?;
    let landed = fs::symlink_metadata(to)?;
    if landed.dev() != st.dev() || landed.ino() != st.ino() {
        return Ok(ReplaceResult { replaced: true, ownership_mismatch: true, reason: format!("replace-over landed lstat: dev:ino {}:{} != {}:{}", landed.dev(), landed.ino(), st.dev(), st.ino()) });
    }
    Ok(ReplaceResult { replaced: true, ownership_mismatch: false, reason: String::new() })
}

/// The identity record of a file as it is now (tests, and files the
/// converter has just written and read back).
pub fn identity(p: &Path) -> io::Result<Expected> {
    let mut f = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(p)?;
    let st = f.metadata()?;
    let (sha256, _) = hash_handle(&mut f, st.size())?;
    Ok(Expected { device: st.dev().to_string(), inode: st.ino().to_string(), size: st.size(), sha256, mtime_ns: Some(mtime_ns(&st)) })
}

#[cfg(test)]
mod tests {
    //! test/posixOwnedFs.test.js
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("posix-owned-{tag}-{}-{}", std::process::id(), random_hex(4)));
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn id(p: &Path) -> Expected {
        let mut e = identity(p).unwrap();
        e.mtime_ns = None;
        e
    }
    fn is_mismatch(r: &RemoveResult) -> bool {
        r.ownership_mismatch && !r.guard_mismatch && !r.removed && !r.missing && !r.reason.is_empty()
    }
    fn names(d: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn remove_deletes_only_the_exact_recorded_file() {
        let dir = tmp("rm");
        let f = dir.join("clip.mp4");
        fs::write(&f, "original").unwrap();
        let expected = id(&f);
        fs::write(&f, "replaced").unwrap();
        let r = remove(&f, &expected, None, false).unwrap();
        assert!(is_mismatch(&r));
        assert!(r.reason.starts_with("remove victim: full hash: ") && r.reason.contains("sha256 differs from record"), "{}", r.reason);
        assert_eq!(fs::read_to_string(&f).unwrap(), "replaced", "a mismatching file is never deleted");
        let now = id(&f);
        assert!(remove(&f, &now, None, false).unwrap().removed);
        assert!(!f.exists());
        assert!(remove(&f, &now, None, false).unwrap().missing);
        assert!(names(&dir).is_empty(), "no quarantine file left behind");
        let r = remove(Path::new("relative.mp4"), &now, None, false).unwrap();
        assert!(is_mismatch(&r) && r.reason.contains("invalid target, record"), "{}", r.reason);
        let bad = Expected { sha256: "x".into(), ..now };
        assert!(is_mismatch(&remove(&f, &bad, None, false).unwrap()));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn remove_refuses_symlinks_and_honours_the_guard() {
        let dir = tmp("guard");
        let real = dir.join("real.mp4");
        let link = dir.join("link.mp4");
        fs::write(&real, "data").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let e = id(&real);
        let r = remove(&link, &e, None, false).unwrap();
        assert!(is_mismatch(&r) && r.reason == "remove victim: open: symbolic link (ELOOP)", "{}", r.reason);
        assert!(real.exists());

        let backup = dir.join("BACKUP-clip.mp4");
        let fin = dir.join("clip.mp4");
        fs::write(&backup, "old").unwrap();
        fs::write(&fin, "new").unwrap();
        let b = id(&backup);
        let good = id(&fin);
        fs::write(&fin, "tampered").unwrap();
        let r = remove(&backup, &b, Some(Guard { target: &fin, expected: &good, identity_only: false }), false).unwrap();
        assert!(r.ownership_mismatch && r.guard_mismatch && !r.removed, "backup kept when the final is not the verified one");
        assert!(r.reason.starts_with("remove guard (kept file): fstat: ") && r.reason.contains("size 8 != 3"), "{}", r.reason);
        assert!(backup.exists());
        let fixed = id(&fin);
        assert!(remove(&backup, &b, Some(Guard { target: &fin, expected: &fixed, identity_only: false }), false).unwrap().removed);
        assert!(!backup.exists());
        assert_eq!(fs::read_to_string(&fin).unwrap(), "tampered");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn promote_never_replaces_and_only_moves_the_verified_source() {
        let dir = tmp("promote");
        let from = dir.join("TEMP-H265-clip.mp4");
        let to = dir.join("clip.mp4");
        fs::write(&from, "candidate").unwrap();
        fs::write(&to, "someone else").unwrap();
        let e = id(&from);
        let err = promote(&from, &to, Some(&e), true, false).unwrap_err();
        assert_eq!(code_of(&err), "EEXIST");
        assert_eq!(fs::read_to_string(&to).unwrap(), "someone else");
        fs::remove_file(&to).unwrap();
        let r = promote(&from, &to, Some(&e), true, false).unwrap();
        assert!(r.source_removed && r.atomic_no_replace && !r.ownership_mismatch);
        assert_eq!(fs::read_to_string(&to).unwrap(), "candidate");
        assert!(!from.exists());
        let err = promote(&from, &dir.join("x.mp4"), Some(&e), true, false).unwrap_err();
        assert_eq!(code_of(&err), "ENOENT");

        // keep-source promotion is a hard link
        let src = dir.join("out.partial");
        fs::write(&src, "output").unwrap();
        let i = id(&src);
        let r = promote(&src, &dir.join("out.mp4"), Some(&i), false, false).unwrap();
        assert!(!r.source_removed && !r.ownership_mismatch);
        assert_eq!(fs::metadata(&src).unwrap().nlink(), 2);
        fs::write(&src, "changed!").unwrap();
        let r = promote(&src, &dir.join("out2.mp4"), Some(&i), true, false).unwrap();
        assert!(r.ownership_mismatch);
        assert_eq!(r.reason, "promote source: fstat: size 8 != 6");
        assert!(promote(&src, &src, Some(&i), true, false).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn identity_only_needs_the_recorded_time() {
        let dir = tmp("ident");
        let f = dir.join("a.mp4");
        fs::write(&f, "abc").unwrap();
        let mut e = identity(&f).unwrap();
        e.sha256 = "0".repeat(64); // wrong hash: only the identity check can pass
        assert!(matches!(open_verified(&f, &e, true).unwrap(), Opened::Verified(..)));
        assert!(matches!(open_verified(&f, &e, false).unwrap(), Opened::Mismatch(r) if r == "full hash: sha256 differs from record"));
        let stale = Expected { mtime_ns: Some("123".into()), ..e.clone() };
        let real = mtime_ns(&fs::metadata(&f).unwrap());
        assert!(matches!(open_verified(&f, &stale, true).unwrap(), Opened::Mismatch(r) if r == format!("identity-only: mtime_ns {real} != 123")));
        let moved = Expected { inode: "1".into(), size: 9, ..e.clone() };
        let ino = fs::metadata(&f).unwrap().ino();
        assert!(matches!(open_verified(&f, &moved, true).unwrap(), Opened::Mismatch(r) if r == format!("fstat: ino {ino} != 1; size 3 != 9")));
        // without a time the full check runs
        let no_time = Expected { mtime_ns: None, ..e.clone() };
        assert!(is_mismatch(&remove(&f, &no_time, None, true).unwrap()));
        assert!(remove(&f, &e, None, true).unwrap().removed);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn link_backup_then_replace_over_keeps_the_name() {
        let dir = tmp("replace");
        let orig = dir.join("clip.mp4");
        let backup = dir.join(".clip.backup");
        let cand = dir.join(".clip.candidate");
        fs::write(&orig, "original").unwrap();
        fs::write(&cand, "converted").unwrap();
        let eo = id(&orig);
        let ec = id(&cand);
        assert_eq!(link_backup(&orig, &backup, &eo, false).unwrap(), LinkResult::Linked);
        assert!(link_backup(&orig, &backup, &eo, false).is_err(), "never replaces the backup name");
        // the target must still be the original (same inode at both names)
        let wrong = replace_over(&cand, &orig, &backup, &ec, &eo.device, "1", false).unwrap();
        assert!(!wrong.replaced && wrong.ownership_mismatch);
        let want = format!("dev:ino {}:{} != {}:1", eo.device, eo.inode, eo.device);
        assert_eq!(wrong.reason, format!("replace-over before rename: original name lstat: {want}; backup name lstat: {want}"));
        let mut stale = ec.clone();
        stale.mtime_ns = Some("5".into());
        let r = replace_over(&cand, &orig, &backup, &stale, &eo.device, &eo.inode, true).unwrap();
        assert!(!r.replaced && r.reason.starts_with("replace-over candidate: identity-only: mtime_ns ") && r.reason.ends_with(" != 5"), "{}", r.reason);
        let r = replace_over(&cand, &orig, &backup, &ec, &eo.device, &eo.inode, false).unwrap();
        assert!(r.replaced && !r.ownership_mismatch);
        assert_eq!(fs::read_to_string(&orig).unwrap(), "converted");
        assert_eq!(fs::read_to_string(&backup).unwrap(), "original");
        assert!(!cand.exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn noreplace_rename_refuses_an_existing_name() {
        let dir = tmp("nr");
        let a = dir.join("a");
        let b = dir.join("b");
        fs::write(&a, "a").unwrap();
        fs::write(&b, "b").unwrap();
        let e = rename_noreplace(&a, &b).unwrap_err();
        assert_eq!(code_of(&e), "EEXIST");
        assert_eq!(code_of(&rename_noreplace(Path::new("a"), &b).unwrap_err()), "EINVAL");
        fs::remove_file(&b).unwrap();
        move_noreplace(&a, &b).unwrap();
        assert_eq!(fs::read_to_string(&b).unwrap(), "a");
        fs::remove_dir_all(&dir).unwrap();
    }
}
