//! Symlink-safe file operations inside an untrusted share (a port of
//! server/safeFs.js). Each walks down from the share's real root one folder
//! at a time with O_NOFOLLOW | O_DIRECTORY, then renames, unlinks, makes or
//! removes relative to the pinned folder (renameat, unlinkat, mkdirat): a
//! component swapped for a symlink is refused (ELINKESCAPE, 403), and once a
//! folder is open a later swap of an ancestor cannot move where the
//! operation lands. Node does the same through /proc/self/fd paths.

use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Component, Path, PathBuf};

const ESCAPE: &str = "Refusing to follow a link out of the share: ";

/// The ELINKESCAPE error (status 403 where a route shows it).
pub fn escape(target: &Path) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, format!("{ESCAPE}{}", target.display()))
}

pub fn is_escape(e: &io::Error) -> bool {
    e.to_string().starts_with(ESCAPE)
}

/// path.resolve for an absolute path: `.` and `..` worked out, no symlinks followed.
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

/// footage.js safeJoin: root joined with rel, refused when it leaves root.
pub fn safe_join(root: &Path, rel: &str) -> io::Result<PathBuf> {
    let abs = resolve(&root.join(rel));
    let r = resolve(root);
    if abs != r && !abs.starts_with(&r) {
        return Err(io::Error::other(format!("Path escapes footage root: {rel}")));
    }
    Ok(abs)
}

fn cstr(s: &[u8]) -> io::Result<CString> {
    CString::new(s).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
}

fn errno() -> io::Error {
    io::Error::last_os_error()
}

/// The components of `target` below `real_root`, or ELINKESCAPE.
fn parts_inside(real_root: &Path, target: &Path) -> io::Result<Vec<Vec<u8>>> {
    let abs = resolve(target);
    if abs == real_root {
        return Ok(Vec::new());
    }
    let Ok(rest) = abs.strip_prefix(real_root) else { return Err(escape(target)) };
    Ok(rest.components().map(|c| c.as_os_str().as_bytes().to_vec()).collect())
}

fn open_at(dir: libc::c_int, name: &[u8], flags: libc::c_int) -> io::Result<OwnedFd> {
    let c = cstr(name)?;
    let fd = unsafe { libc::openat(dir, c.as_ptr(), flags | libc::O_CLOEXEC) };
    if fd < 0 { Err(errno()) } else { Ok(unsafe { OwnedFd::from_raw_fd(fd) }) }
}

const DIR_FLAGS: libc::c_int = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW;

/// Open the folder `dir_abs` (the root or below it) walking from the root, never following
/// a symlink. `create` makes missing folders as it goes (mkdir -p, symlink-safe).
pub fn open_dir_inside(root: &Path, dir_abs: &Path, create: bool) -> io::Result<OwnedFd> {
    let real_root = std::fs::canonicalize(root)?;
    let parts = parts_inside(&real_root, dir_abs)?;
    let mut dir = open_at(libc::AT_FDCWD, real_root.as_os_str().as_bytes(), libc::O_RDONLY | libc::O_DIRECTORY)?;
    for part in parts {
        let next = match open_at(dir.as_raw_fd(), &part, DIR_FLAGS) {
            Ok(fd) => fd,
            Err(e) => {
                let code = e.raw_os_error();
                if code == Some(libc::ELOOP) || code == Some(libc::ENOTDIR) {
                    return Err(escape(dir_abs));
                }
                if !create || code != Some(libc::ENOENT) {
                    return Err(e);
                }
                let c = cstr(&part)?;
                if unsafe { libc::mkdirat(dir.as_raw_fd(), c.as_ptr(), 0o777) } != 0 {
                    return Err(errno());
                }
                open_at(dir.as_raw_fd(), &part, DIR_FLAGS).map_err(|e| if e.raw_os_error() == Some(libc::ELOOP) { escape(dir_abs) } else { e })?
            }
        };
        dir = next;
    }
    Ok(dir)
}

fn parent_and_name(p: &Path) -> io::Result<(PathBuf, Vec<u8>)> {
    let p = resolve(p);
    let name = p.file_name().ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?.as_bytes().to_vec();
    Ok((p.parent().unwrap_or(Path::new("/")).to_path_buf(), name))
}

/// Rename within one share, following no symlink on either side.
pub fn rename_inside(root: &Path, from: &Path, to: &Path) -> io::Result<()> {
    let (fp, fname) = parent_and_name(from)?;
    let (tp, tname) = parent_and_name(to)?;
    let fd = open_dir_inside(root, &fp, false)?;
    let td = open_dir_inside(root, &tp, false)?;
    let (a, b) = (cstr(&fname)?, cstr(&tname)?);
    if unsafe { libc::renameat(fd.as_raw_fd(), a.as_ptr(), td.as_raw_fd(), b.as_ptr()) } != 0 {
        return Err(errno());
    }
    Ok(())
}

/// Unlink a file within a share, following no symlink.
pub fn unlink_inside(root: &Path, target: &Path) -> io::Result<()> {
    let (p, name) = parent_and_name(target)?;
    let d = open_dir_inside(root, &p, false)?;
    let c = cstr(&name)?;
    if unsafe { libc::unlinkat(d.as_raw_fd(), c.as_ptr(), 0) } != 0 {
        return Err(errno());
    }
    Ok(())
}

/// rmdir a folder within a share, following no symlink.
pub fn rmdir_inside(root: &Path, target: &Path) -> io::Result<()> {
    let (p, name) = parent_and_name(target)?;
    let d = open_dir_inside(root, &p, false)?;
    let c = cstr(&name)?;
    if unsafe { libc::unlinkat(d.as_raw_fd(), c.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
        return Err(errno());
    }
    Ok(())
}

/// mkdir -p inside a share, making no folder through a symlink.
pub fn mkdirp_inside(root: &Path, dir: &Path) -> io::Result<()> {
    open_dir_inside(root, dir, true).map(drop)
}

/// lstat of `name` in an open folder: Some(is_dir), None when it is not there.
fn lstat_at(dir: &OwnedFd, name: &[u8]) -> Option<bool> {
    let c = cstr(name).ok()?;
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatat(dir.as_raw_fd(), c.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
        return None;
    }
    Some(st.st_mode & libc::S_IFMT == libc::S_IFDIR)
}

/// The entries of an open folder: (name, is a real folder).
fn entries(dir: &OwnedFd) -> Vec<(Vec<u8>, bool)> {
    let Ok(list) = std::fs::read_dir(format!("/proc/self/fd/{}", dir.as_raw_fd())) else { return Vec::new() };
    list.flatten().map(|e| (e.file_name().as_bytes().to_vec(), e.file_type().is_ok_and(|t| t.is_dir()))).collect()
}

/// Remove a file or folder tree inside a share, following no symlink: a symlink entry is
/// unlinked, never entered. Missing (or out of reach through a link) is not an error.
pub fn rmrf_inside(root: &Path, target: &Path) -> io::Result<()> {
    let (p, name) = parent_and_name(target)?;
    let d = match open_dir_inside(root, &p, false) {
        Ok(d) => d,
        Err(e) if e.raw_os_error() == Some(libc::ENOENT) || is_escape(&e) => return Ok(()),
        Err(e) => return Err(e),
    };
    match lstat_at(&d, &name) {
        None => return Ok(()),
        Some(false) => {
            let c = cstr(&name)?;
            unsafe { libc::unlinkat(d.as_raw_fd(), c.as_ptr(), 0) };
            return Ok(());
        }
        Some(true) => {}
    }
    drop(d);
    let target = resolve(target);
    let me = open_dir_inside(root, &target, false)?;
    for (n, is_dir) in entries(&me) {
        if is_dir {
            rmrf_inside(root, &target.join(std::ffi::OsStr::from_bytes(&n)))?;
        } else if let Ok(c) = cstr(&n) {
            unsafe { libc::unlinkat(me.as_raw_fd(), c.as_ptr(), 0) };
        }
    }
    drop(me);
    let _ = rmdir_inside(root, &target);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lean-safefs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn moves_inside_and_refuses_links_out() {
        let root = tmp("root");
        let outside = tmp("outside");
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::write(root.join("a/f.mp4"), b"x").unwrap();
        mkdirp_inside(&root, &root.join("bin/x/a")).unwrap();
        rename_inside(&root, &root.join("a/f.mp4"), &root.join("bin/x/a/f.mp4.binned")).unwrap();
        assert!(root.join("bin/x/a/f.mp4.binned").exists());
        // a folder swapped for a link out of the share
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let e = mkdirp_inside(&root, &root.join("link/deeper")).unwrap_err();
        assert!(is_escape(&e), "{e}");
        assert!(!outside.join("deeper").exists());
        let e = rename_inside(&root, &root.join("bin/x/a/f.mp4.binned"), &root.join("link/f.mp4")).unwrap_err();
        assert!(is_escape(&e));
        assert!(is_escape(&unlink_inside(&root, &root.join("link/../../etc/passwd")).unwrap_err()));
        assert!(is_escape(&mkdirp_inside(&root, &outside.join("x")).unwrap_err()));
        // rm -rf leaves what a link points at alone
        std::fs::write(outside.join("keep"), b"k").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("bin/x/inner")).unwrap();
        rmrf_inside(&root, &root.join("bin/x")).unwrap();
        assert!(!root.join("bin/x").exists());
        assert!(outside.join("keep").exists());
        rmrf_inside(&root, &root.join("link")).unwrap();
        assert!(outside.join("keep").exists());
        assert!(safe_join(&root, "../x").is_err());
        assert_eq!(safe_join(&root, "a/./b").unwrap(), root.join("a/b"));
    }
}
