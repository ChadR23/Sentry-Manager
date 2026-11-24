//! src/main/converter/staging.js: every file the converter creates, moves or
//! removes outside its own job records goes through here, journaled in the
//! job file before each step so a stop at any point can prove what it owns.
//!
//! Ported for the configuration the server runs (server/converterHost.js):
//! the posix owned-file adapters of `owned` (atomic ownership check, guarded
//! removal, content and identity checks, replace-by-link) and identity
//! cleanup of the converter's private temp folder. The Node module's other
//! branches (desktop adapters without those guarantees) are not needed by
//! the server and are left out; nothing here is weaker than what the server
//! does today.

mod ops;
mod recover;

use super::jobstore::states::{ArtifactState, ReplacementPhase};
use super::owned::{self, errno_code, Expected};
use super::snapshot::{Artifact, Registry, Validate};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read};
use std::os::unix::fs::{FileExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

pub use ops::{Adopted, Prepared, Reserved, Staged};
pub use recover::{Cleaned, Recovered};

pub const OWNED_PATH_FIELDS: [&str; 6] = ["stagedSource", "encodedCandidate", "publicationSnapshot", "destinationPartial", "replacementCandidate", "replacementBackup"];
const DIRECTORY_SYNC_UNSUPPORTED: [&str; 6] = ["EISDIR", "EINVAL", "EPERM", "EACCES", "ENOSYS", "ENOTSUP"];

pub fn message_of(code: &str) -> &'static str {
    match code {
        "INVALID_TRANSACTION_INPUT" => "The file transaction request is invalid.",
        "INSUFFICIENT_STAGING_SPACE" => "There is not enough local space to stage this file.",
        "STAGING_BUSY" => "Another file is already staged.",
        "STAGING_FAILED" => "The source file could not be staged.",
        "CANCELLED" => "The file transaction was cancelled.",
        "INVALID_PUBLICATION_ARTIFACT" => "The verified publication artifact is invalid.",
        "PUBLICATION_ARTIFACT_CHANGED" => "The verified publication artifact changed before publication.",
        "PUBLICATION_ARTIFACT_CONSUMED" => "The verified publication artifact was already consumed.",
        "PUBLICATION_CLEANUP_FAILED" => "The verified publication artifact could not be cleaned up.",
        "DESTINATION_COLLISION" => "The destination already exists.",
        "PARTIAL_COLLISION" => "An unrelated partial file already exists.",
        "DESTINATION_WRITE_FAILED" => "The destination could not be written safely.",
        "ATOMIC_PROMOTION_UNSUPPORTED" => "This filesystem does not support safe atomic publication.",
        "DESTINATION_VALIDATION_FAILED" => "The destination did not pass read-back validation.",
        "SOURCE_OUTSIDE_ROOT" => "The replacement source is outside the selected source root.",
        "SOURCE_CHANGED" => "The original changed after input capture. Retain it and restart with a stable source.",
        "SOURCE_AUTHORITY_REQUIRED" => "The original input version is unknown. Preserve recovery files and restart safely.",
        "REPLACEMENT_COLLISION" => "An unrelated replacement artifact already exists.",
        "REPLACEMENT_FAILED" => "The original file could not be replaced safely.",
        "CHECKSUM_RECORD_FAILED" => "The original's checksum could not be recorded on the share before replacing it; the original was kept.",
        "INSUFFICIENT_REPLACEMENT_SPACE" => "There is not enough free space beside the original for its verified replacement.",
        "REPLACEMENT_SPACE_UNAVAILABLE" => "Free space on the original volume could not be checked safely.",
        "FINAL_VALIDATION_FAILED" => "The replaced file did not pass final validation.",
        "ROLLBACK_FAILED" => "Automatic replacement rollback could not be completed.",
        "TRANSACTION_STATE_PERSIST_FAILED" => "The file transaction phase could not be persisted.",
        "OWNED_CLEANUP_FAILED" => "An owned artifact could not be cleaned up safely.",
        "UNSAFE_OWNED_PATH" => "An owned artifact path failed its safety check.",
        "MANUAL_INTERVENTION" => "This file transaction requires manual intervention.",
        "RECOVERY_ACTION_INVALID" => "The recovery action is invalid.",
        _ => "The file transaction failed.",
    }
}

/// A save that ended with its final file in place (error.validFinal), or
/// any save's result.
#[derive(Debug, Clone, PartialEq)]
pub struct Saved {
    pub final_path: String,
    pub output_bytes: u64,
    pub phase: Option<ReplacementPhase>,
    pub owned_paths: Paths,
    pub owned_artifacts: Artifacts,
    pub cleanup_pending: Vec<String>,
}

/// FileTransactionError (tx = true) or a raw filesystem error (its errno name).
#[derive(Debug, Clone, PartialEq)]
pub struct TxError {
    pub code: String,
    pub tx: bool,
    pub message: String,
    pub cleanup_pending: Option<Vec<String>>,
    pub valid_final: Option<Box<Saved>>,
    pub rolled_back: Option<(Paths, Artifacts)>,
    /// UNSAFE_OWNED_PATH only: which check refused and the values that did
    /// not match ("check: field observed != recorded; ..."). No file
    /// contents, no secrets; the code and message stay as they are.
    pub detail: Option<String>,
}

impl TxError {
    pub fn new(code: &str) -> TxError {
        TxError { code: code.into(), tx: true, message: message_of(code).into(), cleanup_pending: None, valid_final: None, rolled_back: None, detail: None }
    }
}

/// The longest refusal detail kept (in bytes, cut at a character boundary).
pub const MAX_DETAIL: usize = 600;

/// An UNSAFE_OWNED_PATH refusal: `check` names the check that refused,
/// `detail` the values that did not match. One log line per refusal, naming
/// the file (its name only) the check was about.
pub fn unsafe_path(check: &str, target: &str, detail: impl AsRef<str>) -> TxError {
    let detail = detail.as_ref();
    let mut d = if detail.is_empty() { check.to_string() } else { format!("{check}: {detail}") };
    if d.len() > MAX_DETAIL {
        let mut cut = MAX_DETAIL;
        while !d.is_char_boundary(cut) {
            cut -= 1;
        }
        d.truncate(cut);
    }
    let name = Path::new(target).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    eprintln!("[CONVERTER] UNSAFE_OWNED_PATH refusal on {name:?}: {d}");
    TxError { detail: Some(d), ..TxError::new("UNSAFE_OWNED_PATH") }
}

/// txe(code), with the refusal's detail when the code is UNSAFE_OWNED_PATH.
fn refuse(code: &str, check: &str, target: &str, detail: impl AsRef<str>) -> TxError {
    if code == "UNSAFE_OWNED_PATH" {
        unsafe_path(check, target, detail)
    } else {
        txe(code)
    }
}

/// The record's fields `st` does not match, as "dev 1 != 2; ino ...; size ..." (observed != recorded).
fn stat_diffs(m: Option<&Meta>, st: &fs::Metadata) -> Vec<String> {
    let Some(m) = m else { return vec!["no record".into()] };
    let mut d = Vec::new();
    if m.state == ArtifactState::Intent {
        d.push("record state intent".into());
    }
    if m.device.as_deref() != Some(&st.dev().to_string()) {
        d.push(format!("dev {} != {}", st.dev(), m.device.as_deref().unwrap_or("none")));
    }
    if m.inode.as_deref() != Some(&st.ino().to_string()) {
        d.push(format!("ino {} != {}", st.ino(), m.inode.as_deref().unwrap_or("none")));
    }
    if m.size != Some(st.size()) {
        d.push(format!("size {} != {}", st.size(), m.size.map(|s| s.to_string()).unwrap_or_else(|| "none".into())));
    }
    d
}

/// The identity fields `st` does not match ("dev ...; ino ..."), observed != recorded.
fn identity_diffs(m: &Meta, st: &fs::Metadata) -> String {
    let mut d = Vec::new();
    if m.device.as_deref() != Some(&st.dev().to_string()) {
        d.push(format!("dev {} != {}", st.dev(), m.device.as_deref().unwrap_or("none")));
    }
    if m.inode.as_deref() != Some(&st.ino().to_string()) {
        d.push(format!("ino {} != {}", st.ino(), m.inode.as_deref().unwrap_or("none")));
    }
    d.join("; ")
}

/// What a non-regular or multi-linked file is, for a refusal: "not a regular file" / "nlink 2 != 1".
fn regular_single_diffs(st: &fs::Metadata) -> Vec<String> {
    let mut d = Vec::new();
    if !is_regular(st) {
        d.push("not a regular file".into());
    }
    if !single_link(st) {
        d.push(format!("nlink {} != 1", st.nlink()));
    }
    d
}

impl From<io::Error> for TxError {
    fn from(e: io::Error) -> TxError {
        TxError { code: owned::code_of(&e).into(), tx: false, message: e.to_string(), cleanup_pending: None, valid_final: None, rolled_back: None, detail: None }
    }
}

impl std::fmt::Display for TxError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

pub type R<T> = Result<T, TxError>;

pub fn txe(code: &str) -> TxError {
    TxError::new(code)
}

trait OrTx<T> {
    /// `catch (e) { if (e instanceof FileTransactionError) throw e; throw transactionError(code) }`
    fn or_tx(self, code: &str) -> R<T>;
}
impl<T> OrTx<T> for R<T> {
    fn or_tx(self, code: &str) -> R<T> {
        self.map_err(|e| if e.tx { e } else { txe(code) })
    }
}
impl<T> OrTx<T> for io::Result<T> {
    fn or_tx(self, code: &str) -> R<T> {
        self.map_err(|_| txe(code))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mark {
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Journal {
    pub committed: Option<Mark>,
    pub pending: Option<Mark>,
}

/// What the job file records of an owned file (artifactMetadata).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Meta {
    pub path: String,
    pub nonce: String,
    pub state: ArtifactState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub journal: Option<Journal>,
}

impl Meta {
    pub fn expected(&self) -> Expected {
        Expected {
            device: self.device.clone().unwrap_or_default(),
            inode: self.inode.clone().unwrap_or_default(),
            size: self.size.unwrap_or(u64::MAX),
            sha256: self.sha256.clone().unwrap_or_default(),
            mtime_ns: None,
        }
    }
}

pub type Paths = IndexMap<String, String>;
pub type Artifacts = IndexMap<String, Meta>;

/// The original's recorded version (validateSourceAuthority).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceAuthority {
    pub size: u64,
    pub sha256: String,
    pub device: String,
    pub inode: String,
}

impl SourceAuthority {
    fn expected(&self) -> Expected {
        Expected { device: self.device.clone(), inode: self.inode.clone(), size: self.size, sha256: self.sha256.clone(), mtime_ns: None }
    }
}

fn hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

pub fn validate_source_authority(e: Option<&SourceAuthority>) -> R<SourceAuthority> {
    match e {
        Some(e) if hex64(&e.sha256) && e.size <= super::mp4w::MAX_SAFE && digits(&e.device) && digits(&e.inode) => Ok(e.clone()),
        _ => Err(txe("SOURCE_AUTHORITY_REQUIRED")),
    }
}

pub type PersistFn<'a> = &'a (dyn Fn(&Value) -> Result<(), String> + Sync);

/// Everything an operation may carry (the Node `operation` object).
#[derive(Default)]
pub struct Op<'a> {
    pub job_id: String,
    pub item_id: String,
    pub source: Option<String>,
    pub source_root: Option<String>,
    pub destination: Option<String>,
    pub destination_root: Option<String>,
    pub expected_source: Option<SourceAuthority>,
    pub publication_artifact: Option<Artifact>,
    pub owned_paths: Paths,
    pub owned_artifacts: Artifacts,
    pub resume: Option<(Paths, Artifacts)>,
    pub codec: Option<String>,
    pub action: Option<String>,
    pub extension: Option<String>,
    pub record_expected_source: bool,
    pub verify_readable: Option<&'a (dyn Fn(&Path) -> bool + Sync)>,
    pub cancel: Option<&'a AtomicBool>,
    pub persist: Option<PersistFn<'a>>,
    pub persist_phase: Option<PersistFn<'a>>,
    pub prepared: Option<&'a Prepared>,
}

pub struct BeforeReplace<'a> {
    pub source: &'a str,
    pub source_root: &'a str,
    pub sha256: &'a str,
    pub size: u64,
    pub job_id: &'a str,
    pub item_id: &'a str,
}

pub type BeforeReplaceFn = Box<dyn Fn(&BeforeReplace) -> Result<(), String> + Send + Sync>;
pub type FreeSpaceFn = Box<dyn Fn(&Path) -> io::Result<u64> + Send + Sync>;

pub struct Options {
    pub temp_root: PathBuf,
    pub chunk_size: usize,
    pub max_active_leases: usize,
    pub before_replace_original: Option<BeforeReplaceFn>,
    /// replacementFreeSpace (tests); statvfs otherwise
    pub replacement_free_space: Option<FreeSpaceFn>,
}

pub struct Tx {
    temp_root: PathBuf,
    chunk_size: usize,
    max_leases: usize,
    registry: std::sync::Arc<Registry>,
    before_replace_original: Option<BeforeReplaceFn>,
    replacement_free_space: Option<FreeSpaceFn>,
    owned_identities: Mutex<IndexMap<PathBuf, String>>,
    staged: Mutex<Vec<PathBuf>>,
    encoded: Mutex<Vec<PathBuf>>,
}

// ---- paths

pub fn lex(p: &str) -> PathBuf {
    owned::resolve(Path::new(p))
}
pub fn same_path(a: &str, b: &str) -> bool {
    lex(a) == lex(b)
}
pub fn same_pathbuf(a: &Path, b: &Path) -> bool {
    owned::resolve(a) == owned::resolve(b)
}
pub fn contained(root: &Path, cand: &Path) -> bool {
    owned::resolve(cand).starts_with(owned::resolve(root))
}
pub fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// validateAbsolutePath
pub fn valid_abs(v: Option<&str>) -> R<String> {
    match v {
        Some(v) if !v.is_empty() && v.len() <= 32_768 && !v.contains('\0') && v.starts_with('/') => Ok(s(&lex(v))),
        _ => Err(txe("INVALID_TRANSACTION_INPUT")),
    }
}

const WINDOWS_RESERVED: [&str; 4] = ["con", "prn", "aux", "nul"];

/// validateId: [a-z0-9][a-z0-9_-]{0,127}, not a Windows device name.
pub fn validate_id(v: &str) -> R<String> {
    let b = v.as_bytes();
    let ok = !b.is_empty()
        && b.len() <= 128
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-');
    let reserved = WINDOWS_RESERVED.contains(&v) || ((v.starts_with("com") || v.starts_with("lpt")) && v.len() == 4 && (b'1'..=b'9').contains(&b[3]));
    if !ok || reserved {
        return Err(txe("INVALID_TRANSACTION_INPUT"));
    }
    Ok(v.to_string())
}

// ---- stats

pub(crate) fn lstat_or_none(p: &str) -> R<Option<fs::Metadata>> {
    match fresh_lstat(p) {
        Ok(m) => Ok(Some(m)),
        Err(e) if errno_code(&e) == "ENOENT" => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn exact_lstat(p: &str) -> R<fs::Metadata> {
    Ok(fresh_lstat(p)?)
}

/// lstat, with a link count the server confirms. A cifs mount keeps a file's
/// attributes cached for up to a second, and its link count goes stale across
/// the replace: link(original, BACKUP) counts 2 links, and the rename over the
/// original does not count one off again (ext4 does), so a moment later BACKUP
/// still reads 2 links though it is the only name left. Every check that wants
/// one link then refused (unsafe-owned-path, all clips, the originals put back).
/// When lstat says more than one link, the attributes are read again from the
/// file system itself (statx AT_STATX_FORCE_SYNC refreshes the cached inode on
/// cifs and NFS; a no-op on a local disk) and lstat is asked again. The checks
/// are unchanged: a file the server says has two links is still refused.
fn fresh_lstat(p: &str) -> std::io::Result<fs::Metadata> {
    let st = fs::symlink_metadata(p)?;
    if st.nlink() <= 1 {
        return Ok(st);
    }
    force_sync_attributes(p);
    fs::symlink_metadata(p)
}

fn force_sync_attributes(p: &str) {
    let Ok(c) = std::ffi::CString::new(p) else { return };
    let mut sx: libc::statx = unsafe { std::mem::zeroed() };
    // (the answer is not used: the call refreshes the kernel's cached attributes)
    unsafe {
        libc::statx(libc::AT_FDCWD, c.as_ptr(), libc::AT_SYMLINK_NOFOLLOW | libc::AT_STATX_FORCE_SYNC, libc::STATX_BASIC_STATS, &mut sx);
    }
}

fn is_regular(m: &fs::Metadata) -> bool {
    m.file_type().is_file()
}
fn single_link(m: &fs::Metadata) -> bool {
    m.nlink() == 1
}
fn ident(m: &fs::Metadata) -> String {
    format!("{}:{}", m.dev(), m.ino())
}
fn same_identity(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino()
}
fn mtime_ns(m: &fs::Metadata) -> i128 {
    m.mtime() as i128 * 1_000_000_000 + m.mtime_nsec() as i128
}
fn ctime_ns(m: &fs::Metadata) -> i128 {
    m.ctime() as i128 * 1_000_000_000 + m.ctime_nsec() as i128
}
/// mtimeStamp: the modification time in ns, None when not positive.
fn mtime_stamp(m: Option<&fs::Metadata>) -> Option<String> {
    m.map(mtime_ns).filter(|&t| t > 0).map(|t| t.to_string())
}

fn canonical_existing(p: &str) -> R<String> {
    Ok(s(&fs::canonicalize(p)?))
}

fn canonical_for_new(p: &str) -> R<String> {
    let mut cursor = lex(p);
    let mut suffix: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match fs::symlink_metadata(&cursor) {
            Ok(_) => break,
            Err(e) if errno_code(&e) == "ENOENT" => {
                let Some(parent) = cursor.parent().map(Path::to_path_buf) else { return Err(unsafe_path("canonical-for-new", p, "no existing ancestor folder")) };
                if parent == cursor {
                    return Err(unsafe_path("canonical-for-new", p, "no existing ancestor folder"));
                }
                suffix.insert(0, cursor.file_name().unwrap_or_default().to_os_string());
                cursor = parent;
            }
            Err(e) => return Err(e.into()),
        }
    }
    let mut real = fs::canonicalize(&cursor)?;
    for c in suffix {
        real.push(c);
    }
    Ok(s(&real))
}

fn sync_directory(dir: &Path) -> R<()> {
    match File::open(dir).and_then(|f| f.sync_all()) {
        Ok(()) => Ok(()),
        Err(e) if DIRECTORY_SYNC_UNSUPPORTED.contains(&errno_code(&e)) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

fn dirname(p: &str) -> PathBuf {
    Path::new(p).parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("/"))
}

fn abort_if(cancel: Option<&AtomicBool>) -> R<()> {
    if cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
        return Err(txe("CANCELLED"));
    }
    Ok(())
}

fn hex(b: &[u8]) -> String {
    super::tesla_sei::hex(b)
}

pub fn empty_sha() -> String {
    hex(&Sha256::digest([]))
}

/// artifactMetadata(target, nonce, state, stat, sha256, size, journal)
pub fn artifact_metadata(target: &str, nonce: &str, state: ArtifactState, stat: Option<&fs::Metadata>, sha256: Option<&str>, size: u64, journal: Option<Journal>) -> Meta {
    let recorded = state != ArtifactState::Intent;
    let mut m = Meta { path: target.into(), nonce: nonce.into(), state, size: None, sha256: None, device: None, inode: None, journal: None };
    if recorded {
        let st = stat.expect("stat for a recorded file");
        m.size = Some(size);
        m.sha256 = sha256.map(String::from);
        m.device = Some(st.dev().to_string());
        m.inode = Some(st.ino().to_string());
        m.journal = journal;
    }
    m
}

fn matches_stat(m: Option<&Meta>, st: &fs::Metadata) -> bool {
    m.is_some_and(|m| m.state != ArtifactState::Intent && m.device.as_deref() == Some(&st.dev().to_string()) && m.inode.as_deref() == Some(&st.ino().to_string()) && m.size == Some(st.size()))
}

fn matches_identity(m: Option<&Meta>, st: &fs::Metadata) -> bool {
    m.is_some_and(|m| m.device.as_deref() == Some(&st.dev().to_string()) && m.inode.as_deref() == Some(&st.ino().to_string()))
}

/// quickExpected: identity and time only, while the proven time is unchanged.
fn quick_expected(m: &Meta, mtime: Option<&str>, st: Option<&fs::Metadata>) -> Option<Expected> {
    let t = mtime?;
    if mtime_stamp(st).as_deref() != Some(t) {
        return None;
    }
    let mut e = m.expected();
    e.mtime_ns = Some(t.to_string());
    Some(e)
}

fn new_nonce() -> String {
    let mut b = [0u8; 16];
    if let Ok(mut f) = File::open("/dev/urandom") {
        let _ = f.read_exact(&mut b);
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex(&b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// The snapshot the job store receives (transactionSnapshot).
pub struct Snap<'a> {
    pub step: Option<&'a str>,
    pub phase: Option<ReplacementPhase>,
    pub owned_paths: &'a Paths,
    pub owned_artifacts: &'a Artifacts,
    pub publication_artifact: Option<&'a Artifact>,
    pub cleanup_pending: &'a [String],
    pub clear_owned_keys: &'a [&'a str],
    pub item_fields: Option<Value>,
}

impl<'a> Snap<'a> {
    pub fn new(owned_paths: &'a Paths, owned_artifacts: &'a Artifacts) -> Snap<'a> {
        Snap { step: None, phase: None, owned_paths, owned_artifacts, publication_artifact: None, cleanup_pending: &[], clear_owned_keys: &[], item_fields: None }
    }
    pub fn step(mut self, s: &'a str) -> Self {
        self.step = Some(s);
        self
    }
    pub fn phase(mut self, p: ReplacementPhase) -> Self {
        self.phase = Some(p);
        self
    }
    pub fn artifact(mut self, a: Option<&'a Artifact>) -> Self {
        self.publication_artifact = a;
        self
    }
    pub fn pending(mut self, p: &'a [String]) -> Self {
        self.cleanup_pending = p;
        self
    }
    pub fn clears(mut self, c: &'a [&'a str]) -> Self {
        self.clear_owned_keys = c;
        self
    }
}

fn transaction_owned_keys(step: Option<&str>, phase: Option<&ReplacementPhase>) -> &'static [&'static str] {
    if phase.is_some() {
        return &["replacementCandidate", "replacementBackup", "publicationSnapshot"];
    }
    let Some(st) = step else { return &[] };
    if st.starts_with("staged-source-") {
        &["stagedSource"]
    } else if st.starts_with("encoded-candidate-") {
        &["encodedCandidate"]
    } else if st.starts_with("asset-") {
        &["destinationPartial"]
    } else if st.starts_with("separate-") || st.starts_with("copy-") || st.starts_with("recovery-copy-") {
        &["destinationPartial", "publicationSnapshot"]
    } else if st.starts_with("replacement-") || st.starts_with("rollback-") || st.starts_with("recovery-") {
        &["replacementCandidate", "replacementBackup", "publicationSnapshot"]
    } else {
        &[]
    }
}

/// transactionSnapshot(...) as the JSON the job store gets.
pub fn snapshot_json(sn: &Snap) -> Value {
    let mut m = Map::new();
    m.insert("ownedPaths".into(), serde_json::to_value(sn.owned_paths).unwrap());
    m.insert("ownedArtifacts".into(), serde_json::to_value(sn.owned_artifacts).unwrap());
    if let Some(st) = sn.step {
        m.insert("step".into(), json!(st));
    }
    if let Some(f) = &sn.item_fields {
        m.insert("itemFields".into(), f.clone());
    }
    if let Some(p) = &sn.phase {
        m.insert("phase".into(), p.clone().into());
    }
    if let Some(a) = sn.publication_artifact {
        if sn.owned_paths.contains_key("publicationSnapshot") {
            m.insert("publicationArtifact".into(), serde_json::to_value(a).unwrap());
        }
    }
    if !sn.cleanup_pending.is_empty() {
        m.insert("cleanupPending".into(), json!(sn.cleanup_pending));
    }
    let mut clears: Vec<String> = sn.clear_owned_keys.iter().map(|s| s.to_string()).collect();
    for k in transaction_owned_keys(sn.step, sn.phase.as_ref()) {
        if !sn.owned_paths.contains_key(*k) && !clears.iter().any(|c| c == k) {
            clears.push(k.to_string());
        }
    }
    if !clears.is_empty() {
        if clears.iter().any(|c| c == "publicationSnapshot") {
            m.insert("clearOwnedKeys".into(), json!(clears));
            m.insert("clearPublicationArtifact".into(), json!(true));
        } else {
            m.insert("clearOwnedKeys".into(), json!(clears));
        }
    }
    Value::Object(m)
}

fn persist(op: &Op, sn: Snap) -> R<()> {
    let Some(cb) = op.persist else { return Err(txe("TRANSACTION_STATE_PERSIST_FAILED")) };
    let v = snapshot_json(&sn);
    cb(&v).map_err(|_| txe("TRANSACTION_STATE_PERSIST_FAILED"))?;
    if sn.phase.is_some() {
        if let Some(p) = op.persist_phase {
            if !std::ptr::eq(p as *const _ as *const u8, cb as *const _ as *const u8) {
                p(&v).map_err(|_| txe("TRANSACTION_STATE_PERSIST_FAILED"))?;
            }
        }
    }
    Ok(())
}

/// One read-back: size, digest and the stats around it.
pub(crate) struct Observed {
    pub size: u64,
    pub sha256: String,
    pub stat: fs::Metadata,
    pub stat_before: fs::Metadata,
}

/// What copyExclusive reports to its journal.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Event {
    Created,
    ChunkPending,
    ChunkCommitted,
    ResumeReconciled,
}

#[derive(Default, Clone, Copy)]
pub struct Hooks {
    pub created: bool,
    pub pending: bool,
    pub committed: bool,
    pub reconciled: bool,
}

pub struct Copied {
    pub size: u64,
    pub sha256: String,
    pub stat: fs::Metadata,
    pub expected_source: SourceAuthority,
}

pub struct CopyArgs<'a> {
    pub expected: Option<(u64, String, Option<(String, String)>)>,
    pub cancel: Option<&'a AtomicBool>,
    pub collision: &'a str,
    pub failure: &'a str,
    pub resume: Option<(&'a Meta, &'a Journal)>,
    pub hooks: Hooks,
}

fn read_full_at(f: &File, buf: &mut [u8], at: u64) -> io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        let r = f.read_at(&mut buf[n..], at + n as u64)?;
        if r == 0 {
            break;
        }
        n += r;
    }
    Ok(n)
}

impl Tx {
    pub fn new(o: Options, registry: std::sync::Arc<Registry>) -> R<Tx> {
        let root = valid_abs(Some(&s(&o.temp_root)))?;
        if o.max_active_leases < 1 {
            return Err(txe("INVALID_TRANSACTION_INPUT"));
        }
        Ok(Tx {
            temp_root: PathBuf::from(root),
            chunk_size: if o.chunk_size > 0 { o.chunk_size } else { 1024 * 1024 },
            max_leases: o.max_active_leases,
            registry,
            before_replace_original: o.before_replace_original,
            replacement_free_space: o.replacement_free_space,
            owned_identities: Mutex::new(IndexMap::new()),
            staged: Mutex::new(vec![]),
            encoded: Mutex::new(vec![]),
        })
    }

    /// the converter's private temp folder
    pub fn temp_root(&self) -> &Path {
        &self.temp_root
    }

    /// capabilities (the server's: every guarantee available)
    pub fn capabilities(&self) -> Value {
        json!({
            "separatePublication": "native-atomic",
            "ownershipCleanup": "atomic-expected-ownership",
            "replacement": "available",
            "privateTempCleanup": "identity",
            "splitSave": true
        })
    }

    fn leased(list: &Mutex<Vec<PathBuf>>, p: &str) -> bool {
        list.lock().unwrap().iter().any(|e| same_pathbuf(e, Path::new(p)))
    }
    fn release_lease(list: &Mutex<Vec<PathBuf>>, p: &str) {
        let mut l = list.lock().unwrap();
        if let Some(i) = l.iter().position(|e| same_pathbuf(e, Path::new(p))) {
            l.remove(i);
        }
    }
    fn release_owned_lease(&self, p: &str) {
        Self::release_lease(&self.staged, p);
        Self::release_lease(&self.encoded, p);
    }
    /// releaseLeases(paths): in-process leases only.
    pub fn release_leases(&self, paths: &[String]) {
        for p in paths {
            self.release_owned_lease(p);
        }
    }
    fn forget_owned(&self, p: &str) {
        self.owned_identities.lock().unwrap().shift_remove(&lex(p));
        self.release_owned_lease(p);
    }

    fn assert_regular_unaliased(&self, target: &str, code: &str) -> R<fs::Metadata> {
        const CHECK: &str = "regular-unaliased";
        let st = exact_lstat(target).map_err(|e| refuse(code, CHECK, target, format!("lstat {}", e.code)))?;
        if !is_regular(&st) || !single_link(&st) {
            return Err(refuse(code, CHECK, target, regular_single_diffs(&st).join("; ")));
        }
        let real = canonical_existing(target).map_err(|e| refuse(code, CHECK, target, format!("realpath {}", e.code)))?;
        if !same_path(&real, target) {
            return Err(refuse(code, CHECK, target, "realpath differs from path (linked folder)"));
        }
        if let Some(rec) = self.owned_identities.lock().unwrap().get(&lex(target)) {
            if *rec != ident(&st) {
                return Err(refuse(code, CHECK, target, format!("dev:ino {} != {}", ident(&st), rec)));
            }
        }
        Ok(st)
    }

    fn remember_owned(&self, target: &str) -> R<fs::Metadata> {
        let st = self.assert_regular_unaliased(target, "UNSAFE_OWNED_PATH")?;
        self.owned_identities.lock().unwrap().insert(lex(target), ident(&st));
        Ok(st)
    }

    fn hash_open(&self, f: &mut File, cancel: Option<&AtomicBool>) -> R<(u64, String)> {
        use std::io::{Seek, SeekFrom};
        f.seek(SeekFrom::Start(0))?;
        let mut h = Sha256::new();
        let mut buf = vec![0u8; self.chunk_size];
        let mut size = 0u64;
        loop {
            abort_if(cancel)?;
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
            size += n as u64;
        }
        Ok((size, hex(&h.finalize())))
    }

    /// readExactFile: a plain file at its real path whose bytes are `size` and `sha256`.
    fn read_exact_file(&self, target: &str, size: Option<u64>, sha256: Option<&str>, code: &str, cancel: Option<&AtomicBool>) -> R<Observed> {
        const CHECK: &str = "read-exact";
        (|| -> R<Observed> {
            let link = exact_lstat(target)?;
            if !is_regular(&link) {
                return Err(refuse(code, CHECK, target, "lstat: not a regular file"));
            }
            if !same_path(&canonical_existing(target)?, target) {
                return Err(refuse(code, CHECK, target, "realpath differs from path (linked folder)"));
            }
            let mut f = File::open(target)?;
            super::fs_hook::event("read-open", Path::new(target));
            let before = f.metadata()?;
            if !before.is_file() {
                return Err(refuse(code, CHECK, target, "fstat: not a regular file"));
            }
            let (n, sha) = self.hash_open(&mut f, cancel)?;
            let after = f.metadata()?;
            if !same_identity(&before, &after) || Some(n) != size || Some(before.size()) != size || Some(after.size()) != size || Some(sha.as_str()) != sha256 {
                let want = size.map(|s| s.to_string()).unwrap_or_else(|| "none".into());
                let mut d = Vec::new();
                if !same_identity(&before, &after) {
                    d.push(format!("dev:ino changed while read {} -> {}", ident(&before), ident(&after)));
                }
                if Some(n) != size {
                    d.push(format!("bytes read {n} != size {want}"));
                }
                if Some(before.size()) != size || Some(after.size()) != size {
                    d.push(format!("fstat size {}/{} != {want}", before.size(), after.size()));
                }
                if Some(sha.as_str()) != sha256 {
                    d.push("sha256 differs from record".into());
                }
                return Err(refuse(code, CHECK, target, d.join("; ")));
            }
            Ok(Observed { size: n, sha256: sha, stat: after, stat_before: before })
        })()
        .map_err(|e| if e.tx { e } else { refuse(code, CHECK, target, format!("io {}", e.code)) })
    }

    fn read_exact_meta(&self, target: &str, m: &Meta, code: &str) -> R<Observed> {
        self.read_exact_file(target, m.size, m.sha256.as_deref(), code, None)
    }
    fn read_exact_artifact(&self, target: &str, a: &Artifact, code: &str, cancel: Option<&AtomicBool>) -> R<Observed> {
        self.read_exact_file(target, Some(a.size), Some(&a.sha256), code, cancel)
    }

    /// proveCopy: read back in full as the same file it was written as; its proven time.
    fn prove_copy(&self, target: &str, a: &Artifact, written: &fs::Metadata, code: &str) -> R<Option<String>> {
        let p = self.read_exact_artifact(target, a, code, None)?;
        if !same_identity(written, &p.stat) {
            return Err(txe(code));
        }
        Ok(proven_mtime(&p))
    }

    /// inspectExactFile: hash a plain file at its real path, unchanged while read.
    fn inspect_exact_file(&self, target: &str, cancel: Option<&AtomicBool>, code: &str) -> R<Observed> {
        (|| -> R<Observed> {
            let link = exact_lstat(target)?;
            if !is_regular(&link) {
                return Err(txe(code));
            }
            if !same_path(&canonical_existing(target)?, target) {
                return Err(txe(code));
            }
            let mut f = File::open(target)?;
            let before = f.metadata()?;
            let (n, sha) = self.hash_open(&mut f, cancel)?;
            let after = f.metadata()?;
            let named = exact_lstat(target)?;
            if !same_identity(&link, &before) || !same_identity(&before, &after) || !same_identity(&after, &named) || mtime_ns(&before) != mtime_ns(&after) || ctime_ns(&before) != ctime_ns(&after) || n != before.size() || n != after.size() {
                return Err(txe(code));
            }
            Ok(Observed { size: n, sha256: sha, stat: after, stat_before: before })
        })()
        .or_tx(code)
    }

    /// copyExclusive(source, target, { expected, signal, collisionCode, failureCode, hooks..., resume })
    fn copy_exclusive(&self, source: &str, target: &str, a: CopyArgs, cb: &mut dyn FnMut(Event, u64, &str, &fs::Metadata) -> R<()>) -> R<Copied> {
        let r = (|| -> R<Copied> {
            let source_link = exact_lstat(source)?;
            if !is_regular(&source_link) {
                return Err(txe(a.failure));
            }
            if !same_path(&canonical_existing(source)?, source) {
                return Err(txe(a.failure));
            }
            let mut sf = File::open(source)?;
            let source_before = sf.metadata()?;
            let tf = if a.resume.is_some() {
                fs::OpenOptions::new().read(true).write(true).open(target)?
            } else {
                let f = fs::OpenOptions::new().read(true).write(true).create_new(true).mode(0o600).open(target)?;
                super::fs_hook::event("open-new", Path::new(target));
                f
            };
            let target_before = tf.metadata()?;
            let mut h = Sha256::new();
            let mut buf = vec![0u8; self.chunk_size];
            let mut size = 0u64;
            if let Some((meta, journal)) = a.resume {
                if !matches_identity(Some(meta), &target_before) || !target_before.is_file() {
                    return Err(txe("MANUAL_INTERVENTION"));
                }
                let actual = target_before.size();
                let mut th = Sha256::new();
                let mut off = 0u64;
                while off < actual {
                    abort_if(a.cancel)?;
                    let req = (buf.len() as u64).min(actual - off) as usize;
                    let n = read_full_at(&tf, &mut buf[..req], off)?;
                    if n != req {
                        return Err(txe("MANUAL_INTERVENTION"));
                    }
                    th.update(&buf[..n]);
                    off += n as u64;
                }
                let after_read = tf.metadata()?;
                if !same_identity(&target_before, &after_read) || after_read.size() != actual {
                    return Err(txe("MANUAL_INTERVENTION"));
                }
                let actual_sha = hex(&th.finalize());
                let mut boundary = None;
                let mut matched_pending = false;
                if let Some(c) = journal.committed.as_ref().filter(|c| c.size == actual && c.sha256 == actual_sha) {
                    boundary = Some(c.clone());
                } else if let Some(p) = journal.pending.as_ref().filter(|p| p.size == actual && p.sha256 == actual_sha) {
                    boundary = Some(p.clone());
                    matched_pending = true;
                }
                let Some(b) = boundary else { return Err(txe("MANUAL_INTERVENTION")) };
                size = b.size;
                let mut remaining = size;
                while remaining > 0 {
                    let req = (buf.len() as u64).min(remaining) as usize;
                    let n = read_fill(&mut sf, &mut buf[..req])?;
                    if n != req {
                        return Err(txe(a.failure));
                    }
                    h.update(&buf[..n]);
                    remaining -= n as u64;
                }
                if hex(&h.clone().finalize()) != b.sha256 {
                    return Err(txe(a.failure));
                }
                if matched_pending && a.hooks.reconciled {
                    cb(Event::ResumeReconciled, size, &b.sha256, &after_read)?;
                }
            } else if a.hooks.created {
                cb(Event::Created, 0, &empty_sha(), &target_before)?;
            }
            let journaled = a.hooks.pending || a.hooks.committed;
            loop {
                abort_if(a.cancel)?;
                let n = sf.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                let next = size + n as u64;
                h.update(&buf[..n]);
                let next_sha = if journaled { hex(&h.clone().finalize()) } else { String::new() };
                if a.hooks.pending {
                    cb(Event::ChunkPending, next, &next_sha, &target_before)?;
                }
                let mut off = 0;
                if super::fs_hook::event("write", Path::new(target)).is_some() {
                    tf.write_all_at(&buf[..n / 2], size)?;
                    super::fs_hook::event("written-part", Path::new(target));
                }
                while off < n {
                    abort_if(a.cancel)?;
                    let w = tf.write_at(&buf[off..n], size + off as u64)?;
                    if w == 0 {
                        return Err(txe(a.failure));
                    }
                    off += w;
                }
                size = next;
                if a.hooks.committed {
                    tf.sync_all()?;
                    let progress = tf.metadata()?;
                    if !same_identity(&target_before, &progress) || progress.size() != next {
                        return Err(txe(a.failure));
                    }
                    cb(Event::ChunkCommitted, size, &next_sha, &progress)?;
                }
            }
            tf.sync_all()?;
            let source_after = sf.metadata()?;
            let source_path_after = exact_lstat(source)?;
            let target_after = tf.metadata()?;
            let target_path = exact_lstat(target)?;
            let observed = hex(&h.finalize());
            let bad_expected = match &a.expected {
                Some((esize, esha, id)) => *esize != size || *esha != observed || id.as_ref().is_some_and(|(d, i)| *d != source_after.dev().to_string() || *i != source_after.ino().to_string()),
                None => false,
            };
            if !same_identity(&source_link, &source_before)
                || !same_identity(&source_before, &source_after)
                || !same_identity(&source_after, &source_path_after)
                || mtime_ns(&source_before) != mtime_ns(&source_after)
                || ctime_ns(&source_before) != ctime_ns(&source_after)
                || source_before.size() != size
                || source_after.size() != size
                || target_after.size() != size
                || !same_identity(&target_before, &target_after)
                || !same_identity(&target_after, &target_path)
                || bad_expected
            {
                return Err(txe(a.failure));
            }
            drop(tf);
            drop(sf);
            super::fs_hook::event("copied", Path::new(target));
            sync_directory(&dirname(target))?;
            Ok(Copied {
                size,
                expected_source: SourceAuthority { size, sha256: observed.clone(), device: source_after.dev().to_string(), inode: source_after.ino().to_string() },
                sha256: observed,
                stat: target_after,
            })
        })();
        r.map_err(|e| if !e.tx && e.code == "EEXIST" { txe(a.collision) } else if e.tx { e } else { txe(a.failure) })
    }

    /// promoteNoReplace(from, to, collisionCode, { expectedSource, removeSource, identityOnly })
    fn promote_no_replace(&self, from: &str, to: &str, collision: &str, expected: Option<&Expected>, remove_source: bool, identity_only: bool) -> R<(bool, bool)> {
        let r = (|| -> R<(bool, bool)> {
            let mut e = expected.cloned();
            if let Some(x) = e.as_mut() {
                if !identity_only {
                    x.mtime_ns = None;
                }
            }
            let res = owned::promote(Path::new(from), Path::new(to), e.as_ref(), remove_source, identity_only)?;
            if !res.atomic_no_replace {
                return Err(txe("ATOMIC_PROMOTION_UNSUPPORTED"));
            }
            if res.ownership_mismatch {
                return Err(unsafe_path("promote-no-replace", from, &res.reason));
            }
            if !remove_source && res.source_removed {
                return Err(txe("ATOMIC_PROMOTION_UNSUPPORTED"));
            }
            sync_directory(&dirname(to))?;
            Ok((true, res.source_removed))
        })();
        r.map_err(|e| {
            if !e.tx && ["EEXIST", "EACCES", "EPERM"].contains(&e.code.as_str()) {
                txe(collision)
            } else if e.tx {
                e
            } else {
                txe("DESTINATION_WRITE_FAILED")
            }
        })
    }

    fn validate_publication(&self, a: &Artifact, mode: Validate) -> R<()> {
        if !normalize_artifact_ok(a) {
            return Err(txe("INVALID_PUBLICATION_ARTIFACT"));
        }
        if !self.registry.validate(a, mode) {
            return Err(txe("INVALID_PUBLICATION_ARTIFACT"));
        }
        Ok(())
    }

    /// validateReadable(target, metadata, verifyReadable, failureCode)
    fn validate_readable(&self, target: &str, a: &Artifact, verify: Option<&(dyn Fn(&Path) -> bool + Sync)>, code: &str) -> R<()> {
        self.read_exact_artifact(target, a, code, None)?;
        if let Some(v) = verify {
            if !v(Path::new(target)) {
                return Err(txe(code));
            }
        }
        Ok(())
    }

    fn validate_readable_meta(&self, target: &str, m: &Meta, verify: Option<&(dyn Fn(&Path) -> bool + Sync)>, code: &str) -> R<()> {
        self.read_exact_meta(target, m, code)?;
        if let Some(v) = verify {
            if !v(Path::new(target)) {
                return Err(txe(code));
            }
        }
        Ok(())
    }

    /// captureSource({ source }): the original's identity and hash, read once.
    pub fn capture_source(&self, source: &str, cancel: Option<&AtomicBool>) -> R<SourceAuthority> {
        let src = valid_abs(Some(source))?;
        let o = self.inspect_exact_file(&src, cancel, "SOURCE_CHANGED")?;
        Ok(SourceAuthority { size: o.size, sha256: o.sha256, device: o.stat.dev().to_string(), inode: o.stat.ino().to_string() })
    }

    /// assertSourceIdentity: a single-link plain file at its real path with the converted version's identity and size.
    fn assert_source_identity(&self, source: &str, e: &SourceAuthority) -> R<fs::Metadata> {
        validate_source_authority(Some(e))?;
        let st = (|| -> R<fs::Metadata> {
            let st = exact_lstat(source)?;
            if !same_path(&canonical_existing(source)?, source) {
                return Err(txe("SOURCE_CHANGED"));
            }
            Ok(st)
        })()
        .map_err(|_| txe("SOURCE_CHANGED"))?;
        if !is_regular(&st) || !single_link(&st) || st.dev().to_string() != e.device || st.ino().to_string() != e.inode || st.size() != e.size {
            return Err(txe("SOURCE_CHANGED"));
        }
        Ok(st)
    }

    fn assert_source_authority(&self, source: &str, e: &SourceAuthority, cancel: Option<&AtomicBool>) -> R<SourceAuthority> {
        validate_source_authority(Some(e))?;
        let o = self.capture_source(source, cancel)?;
        if o != *e {
            return Err(txe("SOURCE_CHANGED"));
        }
        Ok(o)
    }

    /// removeExactOwned(target, metadata, { allowMissing, allowIdentityAlias, guard, mtimeNs })
    fn remove_exact_owned(&self, target: &str, m: Option<&Meta>, allow_missing: bool, allow_identity_alias: bool, guard: Option<(&str, &Expected, bool)>, mtime: Option<&str>) -> R<bool> {
        let Some(st) = lstat_or_none(target)? else {
            if allow_missing {
                self.forget_owned(target);
                return Ok(false);
            }
            return Err(unsafe_path("remove-exact-owned", target, "lstat ENOENT (missing)"));
        };
        let Some(m) = m else { return Err(unsafe_path("remove-exact-owned", target, "no record")) };
        if (!allow_identity_alias && m.path != target) || m.nonce.is_empty() || m.state == ArtifactState::Intent || !matches_stat(Some(m), &st) || (!single_link(&st) && m.state != ArtifactState::CleanupPending) {
            let mut d = Vec::new();
            if !allow_identity_alias && m.path != target {
                d.push("record path differs from target".to_string());
            }
            if m.nonce.is_empty() {
                d.push("record nonce empty".into());
            }
            if !matches_stat(Some(m), &st) || m.state == ArtifactState::Intent {
                d.extend(stat_diffs(Some(m), &st));
            }
            if !single_link(&st) && m.state != ArtifactState::CleanupPending {
                d.push(format!("nlink {} != 1 (state {})", st.nlink(), m.state));
            }
            return Err(unsafe_path("remove-exact-owned", target, d.join("; ")));
        }
        // the adapter hashes it (held open) against the record; the path
        // itself must still be the file's real path (no linked folder)
        match canonical_existing(target) {
            Ok(real) if same_path(&real, target) => {}
            Ok(_) => return Err(unsafe_path("remove-exact-owned", target, "realpath differs from path (linked folder)")),
            Err(e) => return Err(unsafe_path("remove-exact-owned", target, format!("realpath {}", e.code))),
        }
        let quick = quick_expected(m, mtime, Some(&st));
        let expected = quick.clone().unwrap_or_else(|| m.expected());
        let g = guard.map(|(t, e, io)| owned::Guard { target: Path::new(t), expected: e, identity_only: io });
        let r = owned::remove(Path::new(target), &expected, g, quick.is_some()).map_err(|_| txe("OWNED_CLEANUP_FAILED"))?;
        if r.ownership_mismatch {
            return Err(unsafe_path("remove-exact-owned", target, format!("{} ({})", r.reason, if quick.is_some() { "identity-only" } else { "full hash" })));
        }
        if (!r.removed && !r.missing) || (r.missing && !allow_missing) {
            return Err(txe("OWNED_CLEANUP_FAILED"));
        }
        sync_directory(&dirname(target)).or_tx("OWNED_CLEANUP_FAILED")?;
        self.forget_owned(target);
        Ok(r.removed)
    }

    /// linkBackupAside: the verified original's backup name as a second link (false: no hard links here).
    fn link_backup_aside(&self, source: &str, backup: &str, e: &SourceAuthority) -> R<bool> {
        let r = owned::link_backup(Path::new(source), Path::new(backup), &e.expected(), false).map_err(|err| {
            let c = owned::code_of(&err);
            if c == "EEXIST" || c == "EACCES" {
                txe("REPLACEMENT_COLLISION")
            } else if c == "ENOENT" {
                txe("SOURCE_CHANGED")
            } else {
                txe("REPLACEMENT_FAILED")
            }
        })?;
        match r {
            owned::LinkResult::OwnershipMismatch => Err(txe("SOURCE_CHANGED")),
            owned::LinkResult::Unsupported => Ok(false),
            owned::LinkResult::Linked => {
                sync_directory(&dirname(backup))?;
                Ok(true)
            }
        }
    }

    /// replaceOverOriginal: rename(2) the verified copy over the original's name.
    fn replace_over_original(&self, candidate: &str, source: &str, backup: &str, expected_candidate: &Expected, identity_only: bool, e: &SourceAuthority) -> R<()> {
        let r = owned::replace_over(Path::new(candidate), Path::new(source), Path::new(backup), expected_candidate, &e.device, &e.inode, identity_only).map_err(|_| txe("REPLACEMENT_FAILED"))?;
        if !r.replaced {
            return Err(if r.ownership_mismatch { unsafe_path("replace-over-original", candidate, &r.reason) } else { txe("REPLACEMENT_FAILED") });
        }
        if r.ownership_mismatch {
            return Err(unsafe_path("replace-over-original", source, &r.reason));
        }
        sync_directory(&dirname(source))?;
        Ok(())
    }

    /// dropBackupAlias: the backup name still a second link of the original at its own name goes.
    fn drop_backup_alias(&self, source: &str, backup: &str) -> R<bool> {
        let (a, b) = (lstat_or_none(source)?, lstat_or_none(backup)?);
        let (Some(a), Some(b)) = (a, b) else { return Ok(false) };
        if !is_regular(&a) || !is_regular(&b) || !same_identity(&a, &b) {
            return Ok(false);
        }
        match fs::remove_file(backup) {
            Ok(()) => {}
            Err(e) if errno_code(&e) == "ENOENT" => return Ok(true),
            Err(_) => return Err(txe("ROLLBACK_FAILED")),
        }
        sync_directory(&dirname(backup))?;
        self.forget_owned(backup);
        Ok(true)
    }

    fn before_replace(&self, source: &str, root: &str, e: &SourceAuthority, job: &str, item: &str) -> R<()> {
        if let Some(f) = &self.before_replace_original {
            f(&BeforeReplace { source, source_root: root, sha256: &e.sha256, size: e.size, job_id: job, item_id: item }).map_err(|_| txe("CHECKSUM_RECORD_FAILED"))?;
        }
        Ok(())
    }

    /// backupRecord: the inode now at the backup name is the verified original (no read).
    fn backup_record(&self, backup: &str, nonce: &str, source_removed: bool, e: &SourceAuthority, proven_mtime: Option<&str>) -> R<(Meta, Option<String>)> {
        let state = if source_removed { ArtifactState::Owned } else { ArtifactState::CleanupPending };
        let st = exact_lstat(backup).ok();
        let Some(st) = st.filter(|st| is_regular(st) && st.dev().to_string() == e.device && st.ino().to_string() == e.inode && st.size() == e.size) else {
            return Err(txe("REPLACEMENT_FAILED"));
        };
        let m = mtime_stamp(Some(&st));
        let mt = if m.is_some() && m.as_deref() == proven_mtime { m } else { None };
        Ok((artifact_metadata(backup, nonce, state, Some(&st), Some(&e.sha256), e.size, None), mt))
    }

    /// removeReplacementBackup: only with the verified final held by the guard.
    fn remove_replacement_backup(&self, backup: &str, m: Option<&Meta>, final_path: &str, a: &Artifact, expected_final: Option<&Meta>, final_mtime: Option<&str>, backup_mtime: Option<&str>) -> R<bool> {
        let st = exact_lstat(final_path)?;
        if !is_regular(&st) {
            return Err(txe("FINAL_VALIDATION_FAILED"));
        }
        if let Some(ef) = expected_final {
            if !matches_identity(Some(ef), &st) {
                return Err(txe("FINAL_VALIDATION_FAILED"));
            }
        }
        let fe = Expected { device: st.dev().to_string(), inode: st.ino().to_string(), size: a.size, sha256: a.sha256.clone(), mtime_ns: None };
        let fm = Meta { path: final_path.into(), nonce: String::new(), state: ArtifactState::Owned, size: Some(a.size), sha256: Some(a.sha256.clone()), device: Some(fe.device.clone()), inode: Some(fe.inode.clone()), journal: None };
        let quick = if expected_final.is_some() { quick_expected(&fm, final_mtime, Some(&st)) } else { None };
        match &quick {
            Some(q) => self.remove_exact_owned(backup, m, false, false, Some((final_path, q, true)), backup_mtime),
            None => self.remove_exact_owned(backup, m, false, false, Some((final_path, &fe, false)), backup_mtime),
        }
    }

    /// removePrivateFile: a work file by its exact name, folder and identity.
    fn remove_private_file(&self, target: &str, m: &Meta, real_temp: &str) -> R<bool> {
        let Some(st) = lstat_or_none(target)? else {
            self.forget_owned(target);
            return Ok(false);
        };
        if !is_regular(&st) || !single_link(&st) {
            return Err(unsafe_path("remove-private-file", target, regular_single_diffs(&st).join("; ")));
        }
        match canonical_existing(&s(&dirname(target))) {
            Ok(folder) if same_path(&folder, real_temp) => {}
            Ok(_) => return Err(unsafe_path("remove-private-file", target, "folder realpath is not the temp folder")),
            Err(e) => return Err(unsafe_path("remove-private-file", target, format!("folder realpath {}", e.code))),
        }
        if m.state != ArtifactState::Intent && !matches_identity(Some(m), &st) {
            return Err(unsafe_path("remove-private-file", target, identity_diffs(m, &st)));
        }
        unlink_private(target)?;
        self.forget_owned(target);
        Ok(true)
    }

    /// removePrivateSnapshot (cleanupPublicationArtifact with identity cleanup)
    fn remove_private_snapshot(&self, a: &Artifact, m: Option<&Meta>) -> R<()> {
        let folder = dirname(&a.path);
        if let Some(st) = lstat_or_none(&a.path)? {
            if !is_regular(&st) || !single_link(&st) {
                return Err(unsafe_path("remove-private-snapshot", &a.path, regular_single_diffs(&st).join("; ")));
            }
            if let Some(m) = m {
                if m.state != ArtifactState::Intent && !matches_identity(Some(m), &st) {
                    return Err(unsafe_path("remove-private-snapshot", &a.path, identity_diffs(m, &st)));
                }
            }
            match fs::canonicalize(&folder) {
                Ok(real) if same_pathbuf(&real, &folder) => {}
                Ok(_) => return Err(unsafe_path("remove-private-snapshot", &a.path, "folder realpath differs (linked folder)")),
                Err(e) => return Err(unsafe_path("remove-private-snapshot", &a.path, format!("folder realpath {}", owned::code_of(&e)))),
            }
            // read-only (0400) as the snapshot was made: unlink needs only the folder
            unlink_private(&a.path)?;
        }
        let _ = fs::remove_dir(&folder);
        Ok(())
    }

    /// cleanupPublicationArtifact: Ok(true) cleaned, Ok(false) 'publication-cleanup-failed'.
    fn cleanup_publication(&self, a: Option<&Artifact>, m: Option<&Meta>) -> R<bool> {
        let Some(a) = a else { return Ok(true) };
        if !normalize_artifact_ok(a) {
            return Err(txe("INVALID_PUBLICATION_ARTIFACT"));
        }
        match self.remove_private_snapshot(a, m) {
            Ok(()) => {
                self.registry.forget(a);
                Ok(true)
            }
            Err(e) if e.tx && e.code == "OWNED_CLEANUP_FAILED" => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// hashFilePrefix: SHA-256 of the first `size` bytes of a file.
    fn hash_file_prefix(&self, file: &str, size: u64) -> io::Result<String> {
        let f = File::open(file)?;
        let mut h = Sha256::new();
        let mut buf = vec![0u8; self.chunk_size.min(size.max(1) as usize)];
        let mut off = 0u64;
        while off < size {
            let req = (buf.len() as u64).min(size - off) as usize;
            let n = read_full_at(&f, &mut buf[..req], off)?;
            if n != req {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "short read"));
            }
            h.update(&buf[..n]);
            off += n as u64;
        }
        Ok(hex(&h.finalize()))
    }

    fn adapter_remove(&self, target: &str, e: &Expected, guard: Option<(&str, &Expected)>) -> R<bool> {
        let g = guard.map(|(t, e)| owned::Guard { target: Path::new(t), expected: e, identity_only: false });
        let r = owned::remove(Path::new(target), e, g, false).map_err(|_| txe("OWNED_CLEANUP_FAILED"))?;
        if r.ownership_mismatch {
            return Err(unsafe_path("adapter-remove", target, &r.reason));
        }
        if !r.removed && !r.missing {
            return Err(txe("OWNED_CLEANUP_FAILED"));
        }
        let _ = sync_directory(&dirname(target));
        Ok(r.removed)
    }

    /// removeQuarantined: a removal stopped between its quarantine rename and the unlink.
    fn remove_quarantined(&self, target: &str, m: Option<&Meta>, guard: Option<(&str, &Expected)>) -> bool {
        let Some(m) = m.filter(|m| m.state != ArtifactState::Intent) else { return false };
        let folder = dirname(target);
        let Ok(names) = fs::read_dir(&folder) else { return false };
        for n in names.flatten() {
            let name = n.file_name().to_string_lossy().into_owned();
            let Some(h) = name.strip_prefix(".sentry-owned-remove-") else { continue };
            if h.len() != 16 || !h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                continue;
            }
            let left = s(&folder.join(&name));
            let Ok(Some(st)) = lstat_or_none(&left) else { continue };
            if !is_regular(&st) || !matches_stat(Some(m), &st) {
                continue;
            }
            if let Ok(true) = self.adapter_remove(&left, &m.expected(), guard) {
                return true;
            }
        }
        false
    }

    /// removeShareCopy: an interrupted copy of the verified snapshot on the share.
    fn remove_share_copy(&self, target: &str, m: &Meta, a: Option<&Artifact>) -> R<bool> {
        let Some(st) = lstat_or_none(target)? else {
            if m.state != ArtifactState::Intent {
                self.remove_quarantined(target, Some(m), None);
            }
            self.forget_owned(target);
            return Ok(false);
        };
        if !is_regular(&st) {
            return Err(unsafe_path("remove-share-copy", target, "not a regular file"));
        }
        if m.state == ArtifactState::Intent || m.state == ArtifactState::Writing {
            if !single_link(&st) {
                return Err(unsafe_path("remove-share-copy", target, format!("nlink {} != 1 (state {})", st.nlink(), m.state)));
            }
            match canonical_existing(target) {
                Ok(real) if same_path(&real, target) => {}
                Ok(_) => return Err(unsafe_path("remove-share-copy", target, "realpath differs from path (linked folder)")),
                Err(e) => return Err(unsafe_path("remove-share-copy", target, format!("realpath {}", e.code))),
            }
            let size = st.size();
            let sha = if m.state == ArtifactState::Intent {
                if size != 0 {
                    return Err(unsafe_path("remove-share-copy", target, format!("size {size} != 0 (state intent)")));
                }
                empty_sha()
            } else {
                let Some(a) = a.filter(|a| matches_identity(Some(m), &st) && size <= a.size) else {
                    let d = match a {
                        None => "no publication artifact".to_string(),
                        Some(a) => {
                            let mut d = vec![identity_diffs(m, &st)];
                            if size > a.size {
                                d.push(format!("size {size} > snapshot size {}", a.size));
                            }
                            d.retain(|x| !x.is_empty());
                            d.join("; ")
                        }
                    };
                    return Err(unsafe_path("remove-share-copy", target, d));
                };
                // the snapshot gone (only after a power cut): nothing proves this copy is ours
                self.hash_file_prefix(&a.path, size).map_err(|_| txe("OWNED_CLEANUP_FAILED"))?
            };
            let removed = self.adapter_remove(target, &Expected { device: st.dev().to_string(), inode: st.ino().to_string(), size, sha256: sha, mtime_ns: None }, None)?;
            self.forget_owned(target);
            return Ok(removed);
        }
        self.remove_exact_owned(target, Some(m), true, false, None, None)
    }

    /// assertReplacementSpace: room beside the original for its replacement and 512 MiB.
    fn assert_replacement_space(&self, source: &str, bytes: u64) -> R<()> {
        let dir = dirname(source);
        let free: Result<u64, ()> = match &self.replacement_free_space {
            Some(f) => f(&dir).map_err(|_| ()),
            None => statvfs_free(&dir).map_err(|_| ()),
        };
        let free = free.map_err(|_| txe("REPLACEMENT_SPACE_UNAVAILABLE"))?;
        if (free as u128) < bytes as u128 + 512 * 1024 * 1024 {
            return Err(txe("INSUFFICIENT_REPLACEMENT_SPACE"));
        }
        Ok(())
    }

    /// capturePublication: record the verified snapshot (identity cleanup: size and identity; bytes checked as copied).
    fn capture_publication(&self, a: &Artifact, persisted: Option<&Meta>) -> R<Meta> {
        let st = exact_lstat(&a.path).map_err(|_| txe("PUBLICATION_ARTIFACT_CHANGED"))?;
        if !is_regular(&st) || !single_link(&st) {
            return Err(txe("PUBLICATION_ARTIFACT_CHANGED"));
        }
        let nonce = persisted.map(|p| p.nonce.clone()).unwrap_or_else(new_nonce);
        let state = persisted.map(|p| p.state.clone()).unwrap_or(ArtifactState::Owned);
        let m = artifact_metadata(&a.path, &nonce, state, Some(&st), Some(&a.sha256), a.size, None);
        if st.size() != a.size {
            return Err(txe("PUBLICATION_ARTIFACT_CHANGED"));
        }
        self.validate_publication(a, Validate::Consume)?;
        Ok(m)
    }

    /// assertSourceContained(source, sourceRoot)
    fn assert_source_contained(&self, source: Option<&str>, root: Option<&str>) -> R<(String, String, String)> {
        let root = valid_abs(root)?;
        let target = valid_abs(source)?;
        let (real_root, real_target) = (|| -> R<(String, String)> {
            let rr = canonical_existing(&root)?;
            let st = exact_lstat(&target)?;
            if !is_regular(&st) {
                return Err(txe("SOURCE_OUTSIDE_ROOT"));
            }
            Ok((rr, canonical_existing(&target)?))
        })()
        .map_err(|_| txe("SOURCE_OUTSIDE_ROOT"))?;
        if !contained(Path::new(&root), Path::new(&target)) || !contained(Path::new(&real_root), Path::new(&real_target)) || !same_path(&real_target, &target) {
            return Err(txe("SOURCE_OUTSIDE_ROOT"));
        }
        Ok((target, root, real_root))
    }

    /// assertSourceOrMissingContained
    fn assert_source_or_missing_contained(&self, source: Option<&str>, root: Option<&str>) -> R<(String, String, String)> {
        let src = valid_abs(source)?;
        let root = valid_abs(root)?;
        let real_root = canonical_existing(&root).map_err(|_| txe("SOURCE_OUTSIDE_ROOT"))?;
        let canon = canonical_for_new(&src).map_err(|_| txe("SOURCE_OUTSIDE_ROOT"))?;
        if !contained(Path::new(&root), Path::new(&src)) || !contained(Path::new(&real_root), Path::new(&canon)) {
            return Err(txe("SOURCE_OUTSIDE_ROOT"));
        }
        if let Some(st) = lstat_or_none(&src)? {
            if !is_regular(&st) {
                return Err(txe("SOURCE_OUTSIDE_ROOT"));
            }
            let real = canonical_existing(&src)?;
            if !same_path(&real, &src) || !contained(Path::new(&real_root), Path::new(&real)) {
                return Err(txe("SOURCE_OUTSIDE_ROOT"));
            }
        }
        Ok((src, root, real_root))
    }

    fn staged_path(&self, job: &str, item: &str, nonce: &str, source: &str) -> String {
        let ext = Path::new(source).extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_else(|| ".mp4".into());
        s(&self.temp_root.join(format!("{job}-{item}-{nonce}-source{ext}")))
    }

    fn encoded_path(&self, job: &str, item: &str, nonce: &str, ext: &str) -> R<String> {
        let b = ext.as_bytes();
        if b.len() < 2 || b.len() > 17 || b[0] != b'.' || !b[1..].iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) {
            return Err(txe("INVALID_TRANSACTION_INPUT"));
        }
        Ok(s(&self.temp_root.join(format!("{job}-{item}-{nonce}-encoded{ext}"))))
    }
}

pub fn publication_partial(destination: &str, job: &str, item: &str, nonce: &str) -> String {
    format!("{destination}.sentry-six-{job}-{item}-{nonce}.partial")
}

/// replacementPaths(source, job, item, candidateNonce, backupNonce, codec): (candidate, backup)
pub fn replacement_paths(source: &str, job: &str, item: &str, cn: Option<&str>, bn: Option<&str>, codec: Option<&str>) -> R<(String, String)> {
    if let Some(c) = codec {
        if c != "h265" && c != "av1" {
            return Err(txe("INVALID_TRANSACTION_INPUT"));
        }
        let dir = dirname(source);
        let base = Path::new(source).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        return Ok((s(&dir.join(format!("TEMP-{}-{base}", c.to_uppercase()))), s(&dir.join(format!("BACKUP-{base}")))));
    }
    let cn = cn.map(String::from).unwrap_or_else(|| "undefined".into());
    let bn = bn.map(String::from).unwrap_or_else(|| cn.clone());
    Ok((format!("{source}.sentry-six-{job}-{item}-{cn}.candidate"), format!("{source}.sentry-six-{job}-{item}-{bn}.backup")))
}

/// recordedReplacementPaths: the persisted names choose the readable or the legacy format.
pub fn recorded_replacement_paths(source: &str, job: &str, item: &str, arts: &Artifacts, codec: Option<&str>) -> R<(String, String)> {
    let legacy = replacement_paths(source, job, item, arts.get("replacementCandidate").map(|m| m.nonce.as_str()), arts.get("replacementBackup").map(|m| m.nonce.as_str()), None)?;
    let Some(_) = codec else { return Ok(legacy) };
    let readable = replacement_paths(source, job, item, None, None, codec)?;
    let hit = arts.get("replacementCandidate").is_some_and(|m| same_path(&m.path, &readable.0)) || arts.get("replacementBackup").is_some_and(|m| same_path(&m.path, &readable.1));
    Ok(if hit { readable } else { legacy })
}

fn proven_mtime(o: &Observed) -> Option<String> {
    let b = mtime_stamp(Some(&o.stat_before));
    if b.is_some() && b == mtime_stamp(Some(&o.stat)) {
        b
    } else {
        None
    }
}

fn read_fill(f: &mut File, buf: &mut [u8]) -> io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        let r = f.read(&mut buf[n..])?;
        if r == 0 {
            break;
        }
        n += r;
    }
    Ok(n)
}

fn unlink_private(target: &str) -> R<()> {
    match fs::remove_file(target) {
        Ok(()) => Ok(()),
        Err(e) if errno_code(&e) == "ENOENT" => Ok(()),
        Err(_) => Err(txe("OWNED_CLEANUP_FAILED")),
    }
}

/// normalizeArtifact's checks
pub fn normalize_artifact_ok(a: &Artifact) -> bool {
    !a.token.is_empty() && a.token.len() <= 512 && !a.token.contains('\0') && hex64(&a.sha256) && a.size >= 1 && a.size <= super::mp4w::MAX_SAFE && valid_abs(Some(&a.path)).is_ok()
}

fn norm_artifact(a: Option<&Artifact>) -> R<Artifact> {
    match a {
        Some(a) if normalize_artifact_ok(a) => Ok(Artifact { path: s(&lex(&a.path)), ..a.clone() }),
        _ => Err(txe("INVALID_PUBLICATION_ARTIFACT")),
    }
}

/// Free bytes for an unprivileged writer (f_bavail in f_frsize units, see fsSpace.js).
pub fn statvfs_free(dir: &Path) -> io::Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: a valid path and a zeroed out-struct
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let unit = if st.f_frsize > 0 { st.f_frsize as u128 } else { st.f_bsize as u128 };
    Ok((st.f_bavail as u128 * unit).min(super::mp4w::MAX_SAFE as u128) as u64)
}

// ---- the module-level helpers

#[derive(Debug, Clone, PartialEq)]
pub struct Classification {
    pub kind: &'static str,
    pub reason: &'static str,
}

/// classifyPath with runtime.js createVolumeInfo: network file systems by statfs type.
pub fn classify_path(target: &str) -> R<Classification> {
    if target.is_empty() || target.contains('\0') {
        return Err(txe("INVALID_TRANSACTION_INPUT"));
    }
    use std::os::unix::ffi::OsStrExt;
    if let Ok(c) = std::ffi::CString::new(Path::new(target).as_os_str().as_bytes()) {
        let mut st: libc::statfs = unsafe { std::mem::zeroed() };
        // SAFETY: valid path, zeroed out-struct
        if unsafe { libc::statfs(c.as_ptr(), &mut st) } == 0 {
            let t = st.f_type as u64 & 0xffff_ffff;
            if [0x6969u64, 0xff53_4d42, 0xfe53_4d42, 0x7375_7245, 0x5346_414f].contains(&t) {
                return Ok(Classification { kind: "network", reason: "mapped-remote" });
            }
        }
    }
    Ok(Classification { kind: "ambiguous", reason: "volume-unknown" })
}

#[derive(Debug, Clone, PartialEq)]
pub struct Space {
    pub sufficient: bool,
    pub required_bytes: u64,
    pub free_bytes: u64,
}

/// checkStagingSpace({ sourceBytes, outputBytes, reserveBytes, tempRoot })
pub fn check_staging_space(source_bytes: u64, output_bytes: Option<u64>, reserve: Option<u64>, free: Result<u64, ()>) -> R<Space> {
    let out = output_bytes.unwrap_or(source_bytes);
    let reserve = reserve.unwrap_or(512 * 1024 * 1024);
    let max = super::mp4w::MAX_SAFE;
    if source_bytes > max || out > max || reserve > max || source_bytes > max - out || source_bytes + out > max - reserve {
        return Err(txe("INVALID_TRANSACTION_INPUT"));
    }
    let free = free.map_err(|_| txe("INVALID_TRANSACTION_INPUT"))?;
    let required = source_bytes + out + reserve;
    Ok(Space { sufficient: free >= required, required_bytes: required, free_bytes: free })
}

/// chooseStagingMode({ networkMode, classification, space })
pub fn choose_staging_mode(network_mode: &str, c: &Classification, space: Option<&Space>) -> R<(&'static str, &'static str)> {
    if !["auto", "staging", "direct"].contains(&network_mode) {
        return Err(txe("INVALID_TRANSACTION_INPUT"));
    }
    if network_mode == "direct" {
        return Ok(("direct", "forced-direct"));
    }
    if network_mode == "staging" {
        let sp = space.ok_or_else(|| txe("INVALID_TRANSACTION_INPUT"))?;
        if !sp.sufficient {
            return Err(txe("INSUFFICIENT_STAGING_SPACE"));
        }
        return Ok(("staging", "forced-staging"));
    }
    match c.kind {
        "ambiguous" => Ok(("direct", "ambiguous-volume")),
        "local" => Ok(("direct", "local-source")),
        _ => {
            let sp = space.ok_or_else(|| txe("INVALID_TRANSACTION_INPUT"))?;
            Ok(if sp.sufficient { ("staging", "network-source") } else { ("direct", "insufficient-space") })
        }
    }
}

#[cfg(test)]
mod tests;
