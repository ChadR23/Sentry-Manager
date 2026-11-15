//! The folders the supervisor prepares before it starts the app
//! (`prepareDirs` and its helpers in supervisor.js).
//!
//! Root never writes into a folder the app can write. /data itself is
//! root:PGID with the sticky bit (like /tmp): the app creates and owns its
//! files there, but cannot rename or replace root's folders (/data/tls with
//! the CA key, /data/.supervisor with root's own notes).

use super::Config;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

fn err(m: String) -> io::Error {
    io::Error::other(m)
}

/// Real directory (not a symlink) at exactly this path? (`isPlainDir`)
pub fn is_plain_dir(p: &Path) -> bool {
    match (fs::symlink_metadata(p), fs::canonicalize(p)) {
        (Ok(st), Ok(real)) => st.is_dir() && real == super::mounter::resolve(p),
        _ => false,
    }
}

pub fn lchown(p: &Path, uid: u32, gid: u32) -> io::Result<()> {
    std::os::unix::fs::lchown(p, Some(uid), Some(gid))
}

pub fn chown(p: &Path, uid: u32, gid: u32) -> io::Result<()> {
    std::os::unix::fs::chown(p, Some(uid), Some(gid))
}

pub fn chmod(p: &Path, mode: u32) -> io::Result<()> {
    fs::set_permissions(p, fs::Permissions::from_mode(mode))
}

fn mkdirp(p: &Path, mode: u32) -> io::Result<()> {
    fs::DirBuilder::new().recursive(true).mode(mode).create(p)
}

/// Write a file atomically, never following a link (used in root-only folders). (`safeWrite`)
pub fn safe_write(dir: &Path, name: &str, data: &[u8], mode: u32) -> io::Result<()> {
    if !is_plain_dir(dir) {
        return Err(err(format!("{} is not a plain directory", dir.display())));
    }
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    match fs::remove_file(&tmp) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    {
        let mut f = fs::OpenOptions::new().write(true).create_new(true).custom_flags(libc::O_NOFOLLOW).mode(mode).open(&tmp)?;
        f.write_all(data)?;
    }
    fs::rename(&tmp, dir.join(name))
}

/// Read a small file without following a link. (`readNoFollow`)
pub fn read_no_follow(file: &Path, max: u64) -> io::Result<String> {
    let mut f = fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(file)?;
    let st = f.metadata()?;
    if !st.is_file() || st.len() > max {
        return Err(err("not a small regular file".into()));
    }
    let mut s = String::new();
    f.read_to_string(&mut s)?;
    Ok(s)
}

/// A root-only folder: if what is there is not a plain root-owned 0700
/// directory (someone swapped it), set it aside and start a fresh one. (`ensureRootDir`)
pub fn ensure_root_dir(dir: &Path, warn: &dyn Fn(String)) -> io::Result<()> {
    match fs::symlink_metadata(dir) {
        Ok(st) => {
            let ok = st.is_dir() && !st.file_type().is_symlink() && st.uid() == 0 && fs::canonicalize(dir).map(|r| r == dir).unwrap_or(false);
            if !ok {
                let aside = PathBuf::from(format!("{}.untrusted-{}", dir.display(), super::rapl::now_ms()));
                warn(format!("{} was not a root-owned folder; moved it to {} and starting a fresh one", dir.display(), aside.display()));
                fs::rename(dir, &aside)?;
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    mkdirp(dir, 0o700)?;
    chown(dir, 0, 0)?;
    chmod(dir, 0o700)
}

/// lchown a tree to the app user, never following symlinks or crossing into other mounts. (`chownTree`)
pub fn chown_tree(dir: &Path, uid: u32, gid: u32) -> io::Result<()> {
    let Ok(top) = fs::symlink_metadata(dir) else { return Ok(()) };
    let dev = top.dev();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(cur) = stack.pop() {
        let Ok(st) = fs::symlink_metadata(&cur) else { continue };
        if st.file_type().is_symlink() || st.dev() != dev {
            continue;
        }
        if st.uid() != uid || st.gid() != gid {
            lchown(&cur, uid, gid)?;
        }
        if st.is_dir() {
            for e in fs::read_dir(&cur)? {
                stack.push(cur.join(e?.file_name()));
            }
        }
    }
    Ok(())
}

/// `prepareDirs`.
pub fn prepare_dirs(cfg: &Config, log: &dyn Fn(String), warn: &dyn Fn(String)) -> io::Result<()> {
    fs::create_dir_all(&cfg.data)?;
    mkdirp(&cfg.root_run, 0o700)?;
    chmod(&cfg.root_run, 0o700)?;
    mkdirp(&cfg.footage_root, 0o755)?;
    let root_state = cfg.root_state();
    if !cfg.separate() {
        return mkdirp(&root_state, 0o700);
    }
    let (puid, pgid) = (cfg.puid, cfg.pgid);
    if !is_plain_dir(&cfg.data) {
        return Err(err(format!("{} must be a plain directory", cfg.data.display())));
    }
    // /data: root:PGID, sticky, so the app owns its files but not root's folders
    chown(&cfg.data, 0, pgid)?;
    chmod(&cfg.data, 0o1770)?;
    let tls_dir = cfg.data.join("tls");
    ensure_root_dir(&tls_dir, warn)?;
    ensure_root_dir(&root_state, warn)?;
    let want = format!("{puid}:{pgid}");
    // None: first start, or data from a version that ran as root
    let have = read_no_follow(&root_state.join("owner"), 64 * 1024).ok().map(|s| super::js::js_trim(&s).to_string());
    if have.as_deref() != Some(want.as_str()) {
        log(format!("giving the files in {} to {want} (one time)", cfg.data.display()));
        let mut names: Vec<_> = fs::read_dir(&cfg.data)?.collect::<Result<Vec<_>, _>>()?.into_iter().map(|e| e.file_name()).collect();
        names.sort();
        for name in names {
            let p = cfg.data.join(&name);
            if p == tls_dir || p == root_state || name.as_bytes().windows(11).any(|w| w == b".untrusted-") {
                continue;
            }
            chown_tree(&p, puid, pgid)?;
        }
        safe_write(&root_state, "owner", format!("{want}\n").as_bytes(), 0o600)?;
    }
    // FOOTAGE_ROOT stays root's (mount points are created here); folder vehicles are bind mounts below it
    chown(&cfg.footage_root, 0, 0)?;
    let parent = cfg.app_tls.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("/"));
    for dir in [parent, cfg.app_tls.clone()] {
        mkdirp(&dir, 0o750)?;
        if !is_plain_dir(&dir) {
            return Err(err(format!("{} must be a plain directory", dir.display())));
        }
        chown(&dir, 0, pgid)?;
        chmod(&dir, 0o750)?;
    }
    Ok(())
}

/// The app's copy of the TLS files is root-owned and group-readable: 0640 for
/// the key, 0644 for the rest (the second half of `exportTls`).
pub fn own_app_tls_files(dir: &Path, pgid: u32) -> io::Result<()> {
    for e in fs::read_dir(dir)? {
        let name = e?.file_name();
        let f = dir.join(&name);
        lchown(&f, 0, pgid)?;
        chmod(&f, if name.as_bytes().ends_with(b".key") { 0o640 } else { 0o644 })?;
    }
    Ok(())
}
