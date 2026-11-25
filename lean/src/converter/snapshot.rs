//! verificationSnapshot.js and runtime.js createVerificationSnapshotRegistry:
//! the private, read-only copy of a candidate that is verified and later
//! published. The verifier analyses these bytes, not the candidate path, so
//! nothing can change what was verified; publication only accepts a
//! snapshot this registry made (structurally owned, same token, digest and
//! size, consumed once).

use super::owned::errno_code;
use super::tesla_sei::sha256_hex;
use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

pub const SNAPSHOT_PREFIX: &str = "sentry-six-verification-";

fn random_token() -> String {
    // crypto.randomUUID shape (v4)
    let mut b = [0u8; 16];
    if let Ok(mut f) = fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut b);
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = super::tesla_sei::hex(&b);
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

fn remove_snapshot_file(dir: &Path, path: &Path) -> io::Result<()> {
    let mut first: Option<io::Error> = None;
    if let Err(e) = fs::set_permissions(path, fs::Permissions::from_mode(0o600)) {
        if errno_code(&e) != "ENOENT" {
            first = Some(e);
        }
    }
    if let Err(e) = fs::remove_file(path) {
        if errno_code(&e) != "ENOENT" && first.is_none() {
            first = Some(e);
        }
    }
    if let Err(e) = fs::remove_dir(dir) {
        if errno_code(&e) != "ENOENT" && first.is_none() {
            first = Some(e);
        }
    }
    match first {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// adoptIntoSnapshot: move a plain single-link candidate of the exact size in.
fn adopt(adopt: &Path, snapshot: &Path, size: u64) -> io::Result<bool> {
    let before = fs::symlink_metadata(adopt)?;
    if !before.is_file() || before.nlink() != 1 || before.size() != size {
        return Ok(false);
    }
    if fs::rename(adopt, snapshot).is_err() {
        return Ok(false);
    }
    let after = fs::symlink_metadata(snapshot)?;
    if !after.is_file() || after.nlink() != 1 || after.size() != size || after.ino() != before.ino() || after.dev() != before.dev() || after.mtime() != before.mtime() || after.mtime_nsec() != before.mtime_nsec() {
        return Err(io::Error::new(io::ErrorKind::Other, "Adopted snapshot changed"));
    }
    Ok(true)
}

#[derive(Debug)]
pub struct Snapshot {
    pub dir: PathBuf,
    pub path: PathBuf,
    pub token: String,
    pub size: u64,
    pub sha256: String,
    trusted: bool,
    cleaned: bool,
    pub transferred: bool,
    registry: Weak<Mutex<HashMap<String, Artifact>>>,
}

fn mkdtemp(root: &Path, prefix: &str) -> io::Result<PathBuf> {
    for _ in 0..16 {
        let d = root.join(format!("{prefix}{}", &random_token()[..6]));
        match fs::create_dir(&d) {
            Ok(()) => return Ok(d),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "mkdtemp"))
}

impl Snapshot {
    /// createVerificationSnapshot
    pub fn create(bytes: &[u8], sha256: &str, temp_root: &Path, adopt_path: Option<&Path>, trusted: bool) -> io::Result<Snapshot> {
        if bytes.is_empty() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "Snapshot bytes must be a non-empty Buffer"));
        }
        if sha256.len() != 64 || (!trusted && sha256 != sha256_hex(bytes)) {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "Snapshot digest must match its bytes"));
        }
        if !temp_root.is_absolute() {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "Snapshot temporary root must be absolute"));
        }
        let size = bytes.len() as u64;
        let token = random_token();
        let dir = mkdtemp(temp_root, SNAPSHOT_PREFIX)?;
        let path = dir.join(format!("{token}.mp4"));
        let made = (|| -> io::Result<()> {
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
            let adopted = match adopt_path {
                Some(a) if a.is_absolute() => adopt(a, &path, size)?,
                _ => false,
            };
            if !adopted {
                let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path)?;
                f.write_all(bytes)?;
                f.sync_all()?;
            }
            fs::set_permissions(&path, fs::Permissions::from_mode(0o400))
        })();
        if let Err(e) = made {
            let _ = remove_snapshot_file(&dir, &path);
            return Err(e);
        }
        Ok(Snapshot { dir, path, token, size, sha256: sha256.to_string(), trusted, cleaned: false, transferred: false, registry: Weak::new() })
    }

    /// read(): the persisted bytes, checked against size and digest.
    pub fn read(&self) -> io::Result<Vec<u8>> {
        if self.cleaned {
            return Err(io::Error::new(io::ErrorKind::Other, "Snapshot is no longer available"));
        }
        let b = fs::read(&self.path)?;
        if b.len() as u64 != self.size || sha256_hex(&b) != self.sha256 {
            return Err(io::Error::new(io::ErrorKind::Other, "Snapshot integrity check failed"));
        }
        Ok(b)
    }

    pub fn cleanup(&mut self) -> io::Result<()> {
        if self.cleaned {
            return Ok(());
        }
        remove_snapshot_file(&self.dir, &self.path)?;
        self.cleaned = true;
        self.forget_registration();
        Ok(())
    }

    fn forget_registration(&self) {
        if let Some(live) = self.registry.upgrade() {
            live.lock().unwrap().remove(&self.token);
        }
    }

    /// transfer(): the snapshot becomes the publication artifact.
    pub fn transfer(&mut self) -> io::Result<()> {
        if self.cleaned {
            return Err(io::Error::new(io::ErrorKind::Other, "Snapshot is no longer available"));
        }
        if self.trusted {
            let st = fs::symlink_metadata(&self.path)?;
            if !st.is_file() || st.nlink() != 1 || st.size() != self.size {
                return Err(io::Error::new(io::ErrorKind::Other, "Snapshot integrity check failed"));
            }
        } else {
            self.read()?;
        }
        self.transferred = true;
        Ok(())
    }
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        // Failed/abandoned verification grants no publication capability. A transferred
        // snapshot stays live until publication consumes it, even after this handle ends.
        if !self.transferred {
            self.forget_registration();
        }
    }
}

/// What publication receives of a verified snapshot.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Artifact {
    pub path: String,
    pub token: String,
    pub sha256: String,
    pub size: u64,
}

/// createVerificationSnapshotRegistry
pub struct Registry {
    pub temp_root: PathBuf,
    live: Arc<Mutex<HashMap<String, Artifact>>>,
}

fn resolve(p: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::Normal(n) => out.push(n),
            _ => {}
        }
    }
    out
}

pub enum Validate<'a> {
    Consume,
    Reconcile(&'a Artifact),
}

impl Registry {
    pub fn new(temp_root: PathBuf) -> Registry {
        Registry { temp_root: resolve(&temp_root), live: Arc::new(Mutex::new(HashMap::new())) }
    }

    /// structurallyOwnedSnapshot
    pub fn structurally_owned(&self, a: &Artifact) -> bool {
        let token_ok = !a.token.is_empty() && a.token.len() <= 128 && a.token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        let sha_ok = a.sha256.len() == 64 && a.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !token_ok || !sha_ok || a.size == 0 || a.size > super::mp4w::MAX_SAFE || !Path::new(&a.path).is_absolute() {
            return false;
        }
        let abs = resolve(Path::new(&a.path));
        let Ok(rel) = abs.strip_prefix(&self.temp_root) else { return false };
        if rel.as_os_str().is_empty() {
            return false;
        }
        abs.file_name().is_some_and(|n| n.to_string_lossy() == format!("{}.mp4", a.token))
            && abs.parent().and_then(|p| p.file_name()).is_some_and(|n| n.to_string_lossy().starts_with(SNAPSHOT_PREFIX))
    }

    /// createSnapshot through the registry
    pub fn create(&self, bytes: &[u8], sha256: &str, adopt_path: Option<&Path>, trusted: bool) -> io::Result<Snapshot> {
        let mut s = Snapshot::create(bytes, sha256, &self.temp_root, adopt_path, trusted)?;
        let a = Artifact { path: s.path.to_string_lossy().into_owned(), token: s.token.clone(), sha256: s.sha256.clone(), size: s.size };
        if !self.structurally_owned(&a) {
            if !s.transferred {
                s.cleanup()?;
            }
            return Err(io::Error::new(io::ErrorKind::Other, "INVALID_PUBLICATION_ARTIFACT"));
        }
        self.live.lock().unwrap().insert(a.token.clone(), a);
        s.registry = Arc::downgrade(&self.live);
        Ok(s)
    }

    /// A snapshot this process made earlier, known again (tests, and a
    /// runtime that hands over its own artifacts).
    #[cfg(test)]
    pub fn insert_live(&self, a: Artifact) {
        self.live.lock().unwrap().insert(a.token.clone(), a);
    }

    /// Ownership cleanup can discard a transferred snapshot before publication consumes it.
    pub(crate) fn forget(&self, a: &Artifact) {
        let mut live = self.live.lock().unwrap();
        if live.get(&a.token) == Some(a) {
            live.remove(&a.token);
        }
    }

    /// validate(artifact, { mode })
    pub fn validate(&self, a: &Artifact, mode: Validate) -> bool {
        if !self.structurally_owned(a) {
            return false;
        }
        match mode {
            Validate::Consume => {
                let mut live = self.live.lock().unwrap();
                if live.get(&a.token) != Some(a) {
                    return false;
                }
                // Removing the capability is the one-use guard; no tombstone per clip.
                live.remove(&a.token);
                true
            }
            Validate::Reconcile(persisted) => a == persisted,
        }
    }
}

/// Remove a verified snapshot that will never be published (a check that only reads, such
/// as the leftover tidy's check of a converted copy), and forget it.
pub fn discard_artifact(registry: &Registry, a: &Artifact) {
    if !registry.structurally_owned(a) {
        return;
    }
    let p = Path::new(&a.path);
    if let Some(dir) = p.parent() {
        let _ = remove_snapshot_file(dir, p);
    }
    registry.live.lock().unwrap().remove(&a.token);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finished_snapshots_release_registry_entries_without_allowing_reuse() {
        let root = super::super::testutil::tempdir().unwrap();
        let reg = Registry::new(root.path().to_path_buf());
        let bytes = b"generated snapshot";
        let sha = sha256_hex(bytes);
        for consume in [false, true] {
            for _ in 0..32 {
                let mut s = reg.create(bytes, &sha, None, false).unwrap();
                let a = Artifact { path: s.path.to_string_lossy().into(), token: s.token.clone(), sha256: sha.clone(), size: bytes.len() as u64 };
                if consume {
                    s.transfer().unwrap();
                    let mut forged = a.clone();
                    forged.sha256 = "0".repeat(64);
                    assert!(!reg.validate(&forged, Validate::Consume));
                    assert!(reg.validate(&a, Validate::Consume), "a forged request must not remove the real capability");
                }
                s.cleanup().unwrap();
                assert!(!reg.validate(&a, Validate::Consume), "cleaned or consumed artifacts cannot be reused");
                assert!(reg.live.lock().unwrap().is_empty(), "completed verification must release its registry entry");
            }
        }
        for transfer in [false, true] {
            let mut s = reg.create(bytes, &sha, None, false).unwrap();
            let a = Artifact { path: s.path.to_string_lossy().into(), token: s.token.clone(), sha256: sha.clone(), size: bytes.len() as u64 };
            if transfer { s.transfer().unwrap(); }
            drop(s);
            assert_eq!(reg.validate(&a, Validate::Consume), transfer, "only transferred capabilities outlive the verification handle");
            assert!(!reg.validate(&a, Validate::Consume));
            assert!(reg.live.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn snapshot_lifecycle_and_registry() {
        let root = std::env::temp_dir().join(format!("snap-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let reg = Registry::new(root.clone());
        let bytes = b"verified bytes".to_vec();
        let sha = sha256_hex(&bytes);
        assert!(reg.create(&bytes, &"0".repeat(64), None, false).is_err(), "a wrong digest is refused");
        let mut s = reg.create(&bytes, &sha, None, false).unwrap();
        assert_eq!(fs::metadata(&s.path).unwrap().permissions().mode() & 0o777, 0o400);
        assert_eq!(s.read().unwrap(), bytes);
        let a = Artifact { path: s.path.to_string_lossy().into(), token: s.token.clone(), sha256: sha.clone(), size: bytes.len() as u64 };
        s.transfer().unwrap();
        assert!(reg.validate(&a, Validate::Consume));
        assert!(!reg.validate(&a, Validate::Consume), "consumed once");
        assert!(reg.validate(&a, Validate::Reconcile(&a)));
        let forged = Artifact { path: root.join("x/y.mp4").to_string_lossy().into(), token: "y".into(), ..a.clone() };
        assert!(!reg.validate(&forged, Validate::Reconcile(&forged)));
        s.cleanup().unwrap();
        assert!(!s.path.exists() && !s.dir.exists());

        // adoption moves a single-link candidate in
        let cand = root.join("cand.mp4");
        fs::write(&cand, &bytes).unwrap();
        let s2 = reg.create(&bytes, &sha, Some(&cand), true).unwrap();
        assert!(!cand.exists());
        assert_eq!(fs::read(&s2.path).unwrap(), bytes);
        fs::remove_dir_all(&root).unwrap_or_else(|_| {
            let _ = fs::set_permissions(&s2.path, fs::Permissions::from_mode(0o600));
            fs::remove_dir_all(&root).unwrap();
        });
    }
}
