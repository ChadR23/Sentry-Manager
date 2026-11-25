//! Where a folder is on its filesystem, whatever mount it is reached through.
//!
//! A folder's place is the device of the mount that holds it and its path inside that
//! filesystem (the mount's root, from /proc/self/mountinfo, joined with the rest of the
//! path below the mount point). Two spellings of one folder (a bind mount of it, or of a
//! folder above or below it) have places that are one inside the other, where walking the
//! folders above a path by dev:ino does not see it: when only a subfolder is bind-mounted
//! the two chains of folders above split at the mount point.
//!
//! The mount a path is on is the one the kernel reports for it (statx STATX_MNT_ID, the
//! first field of its mountinfo line), not the one whose mount point is the longest
//! prefix of the path: mountinfo also lists mounts that are hidden (a deeper mount covered
//! by a later mount on a folder above it, or a mount that a `mount --move` put underneath
//! another, which can then be listed after the one on top).
//!
//! A kernel without statx or without STATX_MNT_ID (before Linux 5.8: Synology DSM 7 runs
//! 4.4) cannot say which mount a path is on. Then the table alone places it, by the
//! parent chain of mountinfo (see `Table::tops`): a path is on the visible mount with the
//! longest mount point above it.
//!
//! A folder also holds what is mounted below it, so `places` lists the folder's own place
//! and the root of every visible mount below it (one whose mount point the kernel reports
//! on that mount, or that the parent chain shows on top). Anything that cannot be read,
//! parsed or resolved (a table whose parent chain is not one tree included) is None, and
//! callers keep (treat it as overlapping).
//!
//! Two different filesystems are told apart by device, which is only right when each
//! holds its own files. An overlay, a FUSE filesystem (mergerfs, Unraid's shfs) or a
//! network share (cifs, NFS, 9p, virtiofs, ceph) may show the files of another device, or
//! the same files through two superblocks: a place on one of those and a place on another
//! device cannot be told apart (`cannot_tell`), so they overlap.

use std::collections::HashMap;
use std::ffi::{CString, OsString};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
struct Mount {
    id: u64,
    parent: u64,
    dev: String,
    /// the filesystem type (the field after " - ")
    fstype: String,
    root: PathBuf,
    at: PathBuf,
}

/// The mount table of this process.
#[derive(Debug, Clone)]
pub struct Table(Vec<Mount>);

/// A folder's device and its path inside that device's filesystem.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Place {
    pub dev: String,
    pub path: PathBuf,
    /// on a filesystem that may show another device's files (`opaque_type`)
    pub opaque: bool,
}

/// A filesystem type whose files may be another device's, or the same files as another
/// mount of it with its own device: overlay and other unions, FUSE (mergerfs, shfs, ...)
/// and network or host shares.
pub fn opaque_type(t: &str) -> bool {
    matches!(t, "overlay" | "aufs" | "fuse" | "fuseblk" | "cifs" | "smb3" | "smbfs" | "nfs" | "nfs4" | "9p" | "virtiofs" | "ceph") || t.starts_with("fuse.")
}

/// mountinfo's escapes: a backslash and three octal digits (\040 space, \011 tab, \012
/// newline, \134 backslash).
fn unescape(b: &[u8]) -> Option<PathBuf> {
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' {
            let d = b.get(i + 1..i + 4)?;
            if !d.iter().all(|c| (b'0'..=b'7').contains(c)) {
                return None;
            }
            let v = (d[0] - b'0') as u32 * 64 + (d[1] - b'0') as u32 * 8 + (d[2] - b'0') as u32;
            out.push(u8::try_from(v).ok()?);
            i += 4;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    Some(PathBuf::from(OsString::from_vec(out)))
}

fn digits(b: &[u8]) -> bool {
    !b.is_empty() && b.iter().all(u8::is_ascii_digit)
}

/// One line, as bytes: mount points are not escaped beyond the four characters above, so
/// one may hold any other byte (one that is not UTF-8 included).
fn parse_line(line: &[u8]) -> Option<Mount> {
    let f: Vec<&[u8]> = line.split(|&c| c == b' ').collect();
    if f.len() < 7 || !digits(f[0]) {
        return None;
    }
    let id = std::str::from_utf8(f[0]).ok()?.parse().ok()?;
    if !digits(f[1]) {
        return None;
    }
    let parent = std::str::from_utf8(f[1]).ok()?.parse().ok()?;
    let dev = std::str::from_utf8(f[2]).ok()?;
    let (maj, min) = dev.split_once(':')?;
    if !digits(maj.as_bytes()) || !digits(min.as_bytes()) {
        return None;
    }
    // optional fields, then " - ", then the filesystem type, source and options
    let sep = 6 + f[6..].iter().position(|x| *x == b"-")?;
    let fstype = std::str::from_utf8(f.get(sep + 1).filter(|t| !t.is_empty())?).ok()?.to_string();
    let at = unescape(f[4]).filter(|p| p.is_absolute())?;
    Some(Mount { id, parent, dev: dev.to_string(), fstype, root: unescape(f[3])?, at })
}

/// The id of the mount a path is on, as the kernel sees it (statx STATX_MNT_ID; the same
/// number as the first field of that mount's mountinfo line). None when the kernel does
/// not report it (before Linux 5.8) or the path cannot be looked at.
pub fn mnt_id(path: &Path) -> Option<u64> {
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: a zeroed statx is a valid buffer for the kernel to fill.
    let mut stx: libc::statx = unsafe { std::mem::zeroed() };
    // a raw syscall: not every libc this is built against has a statx wrapper. Never
    // trigger an automount (autofs, systemd .automount) and never ask a network server:
    // only the mount id is wanted, which the local mount table has.
    let flags = libc::AT_NO_AUTOMOUNT | libc::AT_STATX_DONT_SYNC;
    // SAFETY: c is a NUL-terminated path and stx outlives the call.
    let r = unsafe { libc::syscall(libc::SYS_statx, libc::AT_FDCWD, c.as_ptr(), flags, libc::STATX_MNT_ID, &mut stx as *mut libc::statx) };
    if r != 0 || stx.stx_mask & libc::STATX_MNT_ID == 0 {
        return None;
    }
    Some(stx.stx_mnt_id)
}

/// Whether this kernel reports mount ids (statx STATX_MNT_ID on "/"), asked once.
fn kernel_reports_mnt_id() -> bool {
    static ASKED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ASKED.get_or_init(|| mnt_id(Path::new("/")).is_some())
}

#[cfg(test)]
thread_local! {
    static FORCE_CHAIN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Tests: place by the parent chain on this thread, as on a kernel without mount ids.
#[cfg(test)]
pub fn force_parent_chain(on: bool) {
    FORCE_CHAIN.with(|c| c.set(on));
}

/// Tests: runs a test with this thread placing by the parent chain.
#[cfg(test)]
pub fn with_parent_chain(test: fn()) {
    struct Off;
    impl Drop for Off {
        fn drop(&mut self) {
            force_parent_chain(false);
        }
    }
    let _off = Off;
    force_parent_chain(true);
    test();
}

/// Place by the table's parent chain (the kernel cannot say which mount a path is on).
fn by_chain() -> bool {
    #[cfg(test)]
    if FORCE_CHAIN.with(|c| c.get()) {
        return true;
    }
    !kernel_reports_mnt_id()
}

fn strictly_below(p: &Path, above: &Path) -> bool {
    p != above && p.starts_with(above)
}

impl Mount {
    fn place(&self, real: &Path) -> Option<Place> {
        let rest = real.strip_prefix(&self.at).ok()?;
        let path = if rest.as_os_str().is_empty() { self.root.clone() } else { self.root.join(rest) };
        Some(Place { dev: self.dev.clone(), path, opaque: opaque_type(&self.fstype) })
    }
    fn root_place(&self) -> Place {
        Place { dev: self.dev.clone(), path: self.root.clone(), opaque: opaque_type(&self.fstype) }
    }
}

impl Table {
    /// The bytes of a mountinfo file; None when any line of it is not one, or two lines
    /// share an id.
    pub fn parse(text: impl AsRef<[u8]>) -> Option<Table> {
        let v = text.as_ref().split(|&c| c == b'\n').filter(|l| !l.is_empty()).map(parse_line).collect::<Option<Vec<_>>>()?;
        if v.is_empty() {
            return None;
        }
        let mut ids: Vec<u64> = v.iter().map(|m| m.id).collect();
        ids.sort_unstable();
        ids.dedup();
        if ids.len() != v.len() {
            return None;
        }
        Some(Table(v))
    }

    pub fn read() -> Option<Table> {
        Table::parse(std::fs::read("/proc/self/mountinfo").ok()?)
    }

    /// The place of a path already made real: the mount the kernel says it is on, looked
    /// up by id (a mount listed with a longer mount point above the path may be hidden);
    /// on a kernel that does not say, the mount on top by the parent chain.
    pub fn place_of_real(&self, real: &Path) -> Option<Place> {
        if by_chain() {
            return self.place_by_chain(real, &self.tops()?);
        }
        self.place_of_real_by(real, &mnt_id)
    }

    fn place_of_real_by(&self, real: &Path, id_of: &dyn Fn(&Path) -> Option<u64>) -> Option<Place> {
        let id = id_of(real)?;
        let m = self.0.iter().find(|m| m.id == id)?;
        // (a mount that is not above the path as this table has it: the table is stale)
        m.place(real)
    }

    /// Which mounts are on top at their mount point (their files are what a path there
    /// reaches), by the parent chain alone; None when the chain is not one tree.
    ///
    /// A path is looked up from the root mount down: inside a mount P the lookup enters the
    /// child of P (a mount whose parent is P) at the first mount point on its way, and on
    /// that point the mount stacked over it (a child whose mount point is the same), and so
    /// on. So a mount M is reached iff its parent P is reached and no other child of P has a
    /// mount point strictly above M's (it is entered first; a child stacked over P itself is
    /// one of those, so what was mounted inside P before it is hidden). A reached M is on top
    /// iff no child of M is stacked over it (mount point equal to M's). Two children of one
    /// mount on the same point, more than one root (a mount whose parent is not listed),
    /// a root not at "/", a mount point not below its parent's, or a loop: None.
    fn tops(&self) -> Option<Vec<bool>> {
        let n = self.0.len();
        let index: HashMap<u64, usize> = self.0.iter().enumerate().map(|(i, m)| (m.id, i)).collect();
        let parent: Vec<Option<usize>> = self.0.iter().map(|m| index.get(&m.parent).copied().filter(|&p| self.0[p].id != m.id)).collect();
        let roots: Vec<usize> = (0..n).filter(|&i| parent[i].is_none()).collect();
        if roots.len() != 1 || self.0[roots[0]].at != Path::new("/") {
            return None;
        }
        let mut children: Vec<Vec<usize>> = vec![vec![]; n];
        for i in 0..n {
            if let Some(p) = parent[i] {
                if !self.0[i].at.starts_with(&self.0[p].at) {
                    return None;
                }
                children[p].push(i);
            }
        }
        for c in &children {
            for (k, &a) in c.iter().enumerate() {
                if c[k + 1..].iter().any(|&b| self.0[b].at == self.0[a].at) {
                    return None;
                }
            }
        }
        // reached, from the root down (a mount never reached from the root is in a loop)
        let mut reached: Vec<Option<bool>> = vec![None; n];
        reached[roots[0]] = Some(true);
        let mut todo = vec![roots[0]];
        while let Some(p) = todo.pop() {
            for &c in &children[p] {
                let hidden = children[p].iter().any(|&o| o != c && strictly_below(&self.0[c].at, &self.0[o].at));
                reached[c] = Some(reached[p] == Some(true) && !hidden);
                todo.push(c);
            }
        }
        let reached = reached.into_iter().collect::<Option<Vec<bool>>>()?;
        Some((0..n).map(|i| reached[i] && !children[i].iter().any(|&c| self.0[c].at == self.0[i].at)).collect())
    }

    /// The place of a real path by the parent chain: the mount on top with the longest
    /// mount point above it.
    fn place_by_chain(&self, real: &Path, tops: &[bool]) -> Option<Place> {
        let mut best: Option<&Mount> = None;
        for (m, &top) in self.0.iter().zip(tops) {
            if top && real.starts_with(&m.at) {
                match best {
                    Some(b) if b.at == m.at => return None,
                    Some(b) if b.at.starts_with(&m.at) => {}
                    _ => best = Some(m),
                }
            }
        }
        best?.place(real)
    }

    fn places_by_chain(&self, real: &Path) -> Option<Vec<Place>> {
        let tops = self.tops()?;
        let mut out = vec![self.place_by_chain(real, &tops)?];
        for (m, &top) in self.0.iter().zip(&tops) {
            if top && strictly_below(&m.at, real) {
                let p = m.root_place();
                if !out.contains(&p) {
                    out.push(p);
                }
            }
        }
        Some(out)
    }

    /// A folder's own place.
    pub fn place(&self, dir: &Path) -> Option<Place> {
        self.place_of_real(&std::fs::canonicalize(dir).ok()?)
    }

    /// A folder's own place, then the root of every mount below it (what it also holds).
    pub fn places(&self, dir: &Path) -> Option<Vec<Place>> {
        let real = std::fs::canonicalize(dir).ok()?;
        self.places_of_real(&real)
    }

    pub fn places_of_real(&self, real: &Path) -> Option<Vec<Place>> {
        if by_chain() {
            return self.places_by_chain(real);
        }
        self.places_of_real_by(real, &mnt_id)
    }

    /// Only the mounts below that are visible count: one whose mount point is on another
    /// mount (hidden under a later one) holds nothing reachable here. A mount point that
    /// cannot be looked at counts (holding more only keeps more).
    fn places_of_real_by(&self, real: &Path, id_of: &dyn Fn(&Path) -> Option<u64>) -> Option<Vec<Place>> {
        let mut out = vec![self.place_of_real_by(real, id_of)?];
        for m in &self.0 {
            if strictly_below(&m.at, real) && id_of(&m.at).is_none_or(|id| id == m.id) {
                let p = m.root_place();
                if !out.contains(&p) {
                    out.push(p);
                }
            }
        }
        Some(out)
    }
}

/// `inner` is `outer` or inside it.
pub fn within(inner: &Place, outer: &Place) -> bool {
    inner.dev == outer.dev && inner.path.starts_with(&outer.path)
}

/// A folder with these places holds the folder at `p` (it is that folder or inside it).
pub fn holds(places: &[Place], p: &Place) -> bool {
    places.iter().any(|o| within(p, o))
}

/// Two places on different devices where either may show the other's files (an overlay
/// or FUSE union of it, or a network share of the same files through another superblock):
/// whether they share files cannot be told. On one device paths compare as usual.
pub fn cannot_tell(a: &Place, b: &Place) -> bool {
    a.dev != b.dev && (a.opaque || b.opaque)
}

/// Two folders share files: some part of one is in or above some part of the other, or
/// that cannot be told (`cannot_tell`).
pub fn overlap(x: &[Place], y: &[Place]) -> bool {
    x.iter().any(|a| y.iter().any(|b| within(a, b) || within(b, a) || cannot_tell(a, b)))
}

/// Whether two folders share files, by place; true when that cannot be told.
pub fn folders_overlap(x: &Path, y: &Path) -> bool {
    let Some(t) = Table::read() else { return true };
    match (t.places(x), t.places(y)) {
        (Some(a), Some(b)) => overlap(&a, &b),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    const SAMPLE: &str = "\
22 27 0:21 / /proc rw,relatime - proc proc rw
27 1 253:1 / / rw,relatime shared:1 - ext4 /dev/vda rw
40 27 253:1 /srv/share/TeslaCam/SentryClips /view/SentryClips rw,relatime shared:1 master:2 - ext4 /dev/vda rw
41 27 0:50 / /mnt/my\\040usb rw - vfat /dev/sdb1 rw
42 27 0:50 /TeslaCam /cam rw - vfat /dev/sdb1 rw
43 27 253:1 /hidden /cam rw - ext4 /dev/vda rw
44 27 0:4 net:[4026531840] /run/netns/x rw - nsfs nsfs rw
";

    fn t() -> Table {
        Table::parse(SAMPLE).unwrap()
    }

    /// What a kernel with only these mounts, made in the order listed, reports a path is
    /// on: the last mount made on the deepest mount point above it.
    fn on(t: &Table) -> impl Fn(&Path) -> Option<u64> + '_ {
        move |p: &Path| {
            let mut best: Option<&Mount> = None;
            for m in &t.0 {
                if p.starts_with(&m.at) && best.is_none_or(|b| m.at.components().count() >= b.at.components().count()) {
                    best = Some(m);
                }
            }
            best.map(|m| m.id)
        }
    }

    impl Table {
        fn place_in_sample(&self, p: &str) -> Option<Place> {
            self.place_of_real_by(Path::new(p), &on(self))
        }
        fn places_in_sample(&self, p: &str) -> Option<Vec<Place>> {
            self.places_of_real_by(Path::new(p), &on(self))
        }
    }

    fn pl(dev: &str, p: &str) -> Place {
        Place { dev: dev.into(), path: p.into(), opaque: false }
    }

    #[test]
    fn parses_escapes_and_optional_fields() {
        let t = t();
        assert_eq!(t.0.len(), 7);
        assert_eq!(t.0[3].at, Path::new("/mnt/my usb"));
        assert_eq!(t.0[2].root, Path::new("/srv/share/TeslaCam/SentryClips"));
        assert_eq!(unescape(br"a\134b\011c\012d").unwrap(), Path::new("a\\b\tc\nd"));
    }

    #[test]
    fn rejects_what_is_not_mountinfo() {
        assert!(Table::parse("").is_none());
        assert!(Table::parse("garbage").is_none());
        assert!(Table::parse("1 2 8:1 / / rw shared:1 ext4 /dev/x rw").is_none(), "no separator");
        assert!(Table::parse("1 2 x:1 / / rw - ext4 /dev/x rw").is_none(), "bad device");
        assert!(Table::parse("1 2 8:1 / /a\\04 rw - ext4 /dev/x rw").is_none(), "short escape");
        assert!(Table::parse("1 2 8:1 / rel rw - ext4 /dev/x rw").is_none(), "relative mount point");
        assert!(Table::parse(&format!("{SAMPLE}junk\n")).is_none(), "one bad line spoils the table");
    }

    #[test]
    fn places_through_the_mount_a_path_is_on() {
        let t = t();
        assert_eq!(t.place_in_sample("/srv/share/TeslaCam").unwrap(), pl("253:1", "/srv/share/TeslaCam"));
        assert_eq!(t.place_in_sample("/view/SentryClips/2026-x").unwrap(), pl("253:1", "/srv/share/TeslaCam/SentryClips/2026-x"));
        assert_eq!(t.place_in_sample("/view/SentryClips").unwrap(), pl("253:1", "/srv/share/TeslaCam/SentryClips"));
        assert_eq!(t.place_in_sample("/view").unwrap(), pl("253:1", "/view"));
        assert_eq!(t.place_in_sample("/mnt/my usb/TeslaCam").unwrap(), pl("0:50", "/TeslaCam"));
        // a later mount at one point hides the earlier one
        assert_eq!(t.place_in_sample("/cam/a").unwrap(), pl("253:1", "/hidden/a"));
        // a mount point that only shares a prefix of its name is not above
        assert_eq!(t.place_in_sample("/viewer").unwrap(), pl("253:1", "/viewer"));
    }

    #[test]
    fn a_folder_above_a_bind_mount_point_holds_what_is_mounted_there() {
        let t = t();
        let view = t.places_in_sample("/view").unwrap();
        let cam = t.places_in_sample("/srv/share/TeslaCam").unwrap();
        let clip = t.place_in_sample("/srv/share/TeslaCam/SentryClips/2026-x").unwrap();
        let via = t.place_in_sample("/view/SentryClips/2026-x").unwrap();
        assert!(holds(&view, &clip), "view holds the real folder");
        assert!(holds(&cam, &via), "TeslaCam holds the bind spelling");
        assert!(overlap(&view, &cam) && overlap(&cam, &view));
        let other = t.places_in_sample("/srv/share/Other").unwrap();
        assert!(!overlap(&other, &view) && !overlap(&cam, &other));
        assert!(!holds(&other, &clip));
        // a folder inside the root does not hold the root's other folders
        let sub = t.places_in_sample("/srv/share/TeslaCam/RecentClips").unwrap();
        assert!(!holds(&sub, &clip));
        assert!(overlap(&sub, &cam), "a folder inside the other");
        // the same path on another device is another folder
        assert!(!within(&pl("0:50", "/TeslaCam"), &pl("253:1", "/")));
        // "/" holds everything mounted anywhere
        assert!(holds(&t.places_in_sample("/").unwrap(), &pl("0:50", "/TeslaCam/x")));
    }

    #[test]
    fn a_path_is_placed_on_the_mount_it_is_on_not_the_longest_mount_point_listed() {
        // 50 at /share/TeslaCam/SentryClips, then 51 bound over /share/TeslaCam (hiding 50)
        let t = Table::parse(
            "27 1 253:1 / / rw - ext4 /dev/vda rw\n\
             50 27 0:60 / /share/TeslaCam/SentryClips rw - tmpfs t rw\n\
             51 27 253:1 /real/TeslaCam /share/TeslaCam rw - ext4 /dev/vda rw\n",
        )
        .unwrap();
        let kernel = |p: &Path| Some(if p.starts_with("/share/TeslaCam") { 51 } else { 27 });
        let got = t.place_of_real_by(Path::new("/share/TeslaCam/SentryClips/evt"), &kernel).unwrap();
        assert_eq!(got, pl("253:1", "/real/TeslaCam/SentryClips/evt"));
        // the hidden tmpfs is not something /share holds
        let share = t.places_of_real_by(Path::new("/share"), &kernel).unwrap();
        assert_eq!(share, vec![pl("253:1", "/share"), pl("253:1", "/real/TeslaCam")]);
        // a mount on top listed before the one under it (after mount --move)
        let moved = Table::parse(
            "27 1 253:1 / / rw - ext4 /dev/vda rw\n\
             48 49 253:1 /real/TeslaCam /x rw - ext4 /dev/vda rw\n\
             49 27 0:40 / /x rw - tmpfs t rw\n",
        )
        .unwrap();
        let kernel = |p: &Path| Some(if p.starts_with("/x") { 48 } else { 27 });
        assert_eq!(moved.place_of_real_by(Path::new("/x/SentryClips"), &kernel).unwrap(), pl("253:1", "/real/TeslaCam/SentryClips"));
        assert_eq!(moved.places_of_real_by(Path::new("/"), &kernel).unwrap(), vec![pl("253:1", "/"), pl("253:1", "/real/TeslaCam")]);
        // unknown to the kernel, unknown to the table, or not above the path: no place
        assert!(t.place_of_real_by(Path::new("/a"), &|_| None).is_none());
        assert!(t.place_of_real_by(Path::new("/a"), &|_| Some(99)).is_none());
        assert!(t.place_of_real_by(Path::new("/a"), &|_| Some(51)).is_none());
        // a mount point below that cannot be looked at still counts
        let all = t.places_of_real_by(Path::new("/"), &|p| (p == Path::new("/")).then_some(27)).unwrap();
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn a_mount_point_that_is_not_utf8_is_read() {
        let mut text = SAMPLE.as_bytes().to_vec();
        text.extend_from_slice(b"45 27 0:51 / /mnt/caf\xe9 rw - vfat /dev/sdc1 rw\n");
        let t = Table::parse(&text).expect("a table with one odd mount");
        assert_eq!(t.0.len(), 8);
        assert_eq!(t.0[7].at.as_os_str(), OsStr::from_bytes(b"/mnt/caf\xe9"));
        assert!(Table::parse("1 2 8:1 / / rw - ext4 a rw\n1 2 8:1 / /b rw - ext4 a rw\n").is_none(), "one id twice");
        assert!(Table::parse("x 2 8:1 / / rw - ext4 a rw\n").is_none(), "bad id");
    }

    #[test]
    fn reads_this_process_table() {
        let t = Table::read().expect("mountinfo");
        let Some(here) = t.place(Path::new("/")) else {
            assert!(mnt_id(Path::new("/")).is_none(), "placed whenever the kernel reports mount ids");
            eprintln!("skipped: no STATX_MNT_ID");
            return;
        };
        assert!(!here.dev.is_empty());
        let proc_id = mnt_id(Path::new("/proc")).unwrap();
        assert!(t.0.iter().any(|m| m.id == proc_id && m.at == Path::new("/proc")), "statx's mount id is mountinfo's");
        assert!(!folders_overlap(Path::new("/proc"), Path::new("/sys")));
        assert!(folders_overlap(Path::new("/nonexistent-folder-x"), Path::new("/")), "unresolvable keeps");
    }

    // ---- kernels without mount ids: the parent chain

    /// 43 bound over 42 at /cam (so 45, inside 42, is hidden); 47 stacked over 46
    const CHAIN: &str = "\
22 27 0:21 / /proc rw,relatime - proc proc rw
27 1 253:1 / / rw,relatime shared:1 - ext4 /dev/vda rw
40 27 253:1 /srv/share/TeslaCam/SentryClips /view/SentryClips rw,relatime shared:1 master:2 - ext4 /dev/vda rw
41 27 0:50 / /mnt/my\\040usb rw - vfat /dev/sdb1 rw
42 27 0:50 /TeslaCam /cam rw - vfat /dev/sdb1 rw
43 42 253:1 /hidden /cam rw - ext4 /dev/vda rw
45 42 0:51 / /cam/deep rw - tmpfs t rw
46 27 0:52 / /pts rw - devpts devpts rw
47 46 0:53 / /pts rw - devpts devpts rw
";

    fn chain_place(t: &Table, p: &str) -> Option<Place> {
        t.place_by_chain(Path::new(p), &t.tops()?)
    }
    fn chain_places(t: &Table, p: &str) -> Option<Vec<Place>> {
        t.places_by_chain(Path::new(p))
    }

    #[test]
    fn without_mount_ids_a_path_is_placed_on_the_visible_mount_by_the_parent_chain() {
        let t = Table::parse(CHAIN).unwrap();
        assert_eq!(chain_place(&t, "/cam/a").unwrap(), pl("253:1", "/hidden/a"), "the mount stacked on top");
        assert_eq!(chain_place(&t, "/cam/deep/x").unwrap(), pl("253:1", "/hidden/deep/x"), "not the hidden tmpfs inside the covered mount");
        assert_eq!(chain_place(&t, "/pts/1").unwrap(), pl("0:53", "/1"));
        assert_eq!(chain_place(&t, "/view/SentryClips/x").unwrap(), pl("253:1", "/srv/share/TeslaCam/SentryClips/x"));
        assert_eq!(chain_place(&t, "/mnt/my usb/TeslaCam").unwrap(), pl("0:50", "/TeslaCam"));
        assert_eq!(chain_place(&t, "/viewer").unwrap(), pl("253:1", "/viewer"));
        let all = chain_places(&t, "/").unwrap();
        for p in [pl("253:1", "/"), pl("0:21", "/"), pl("253:1", "/srv/share/TeslaCam/SentryClips"), pl("0:50", "/"), pl("253:1", "/hidden"), pl("0:53", "/")] {
            assert!(all.contains(&p), "{p:?} in {all:?}");
        }
        for p in [pl("0:50", "/TeslaCam"), pl("0:51", "/"), pl("0:52", "/")] {
            assert!(!all.contains(&p), "hidden {p:?} in {all:?}");
        }
        assert_eq!(all.len(), 6);
        // the statx way agrees wherever its simulated kernel is right (no hidden mount)
        let kernel = |p: &Path| {
            Some(if p.starts_with("/cam") { 43 } else if p.starts_with("/pts") { 47 } else if p.starts_with("/view/SentryClips") { 40 } else if p.starts_with("/mnt/my usb") { 41 } else if p.starts_with("/proc") { 22 } else { 27 })
        };
        for p in ["/", "/cam", "/cam/deep/x", "/pts", "/view", "/view/SentryClips/a", "/mnt/my usb/x", "/srv"] {
            assert_eq!(chain_place(&t, p), t.place_of_real_by(Path::new(p), &kernel), "{p}");
            let (a, b) = (chain_places(&t, p).unwrap(), t.places_of_real_by(Path::new(p), &kernel).unwrap());
            assert!(a.iter().all(|x| b.contains(x)) && b.iter().all(|x| a.contains(x)), "{p}: {a:?} vs {b:?}");
        }
    }

    #[test]
    fn without_mount_ids_hidden_and_moved_mounts_are_left_out() {
        // 50 at /share/TeslaCam/SentryClips, then 51 bound over /share/TeslaCam (hiding 50)
        let t = Table::parse(
            "27 1 253:1 / / rw - ext4 /dev/vda rw\n\
             50 27 0:60 / /share/TeslaCam/SentryClips rw - tmpfs t rw\n\
             51 27 253:1 /real/TeslaCam /share/TeslaCam rw - ext4 /dev/vda rw\n",
        )
        .unwrap();
        assert_eq!(chain_place(&t, "/share/TeslaCam/SentryClips/evt").unwrap(), pl("253:1", "/real/TeslaCam/SentryClips/evt"));
        assert_eq!(chain_places(&t, "/share").unwrap(), vec![pl("253:1", "/share"), pl("253:1", "/real/TeslaCam")]);
        // a mount on top listed before the one under it (after mount --move)
        let moved = Table::parse(
            "27 1 253:1 / / rw - ext4 /dev/vda rw\n\
             48 49 253:1 /real/TeslaCam /x rw - ext4 /dev/vda rw\n\
             49 27 0:40 / /x rw - tmpfs t rw\n",
        )
        .unwrap();
        assert_eq!(chain_place(&moved, "/x/SentryClips").unwrap(), pl("253:1", "/real/TeslaCam/SentryClips"));
        assert_eq!(chain_places(&moved, "/").unwrap(), vec![pl("253:1", "/"), pl("253:1", "/real/TeslaCam")]);
        // a mount made inside the one moved underneath stays hidden
        let under = Table::parse(
            "27 1 253:1 / / rw - ext4 /dev/vda rw\n\
             48 49 253:1 /real/TeslaCam /x rw - ext4 /dev/vda rw\n\
             49 27 0:40 / /x rw - tmpfs t rw\n\
             52 49 0:41 / /x/SentryClips rw - tmpfs t rw\n",
        )
        .unwrap();
        assert_eq!(chain_place(&under, "/x/SentryClips/evt").unwrap(), pl("253:1", "/real/TeslaCam/SentryClips/evt"));
        assert!(!chain_places(&under, "/x").unwrap().contains(&pl("0:41", "/")));
        // a mount on a shallower point of the same parent hides a deeper one, in any order
        let shallow = Table::parse(
            "27 1 253:1 / / rw - ext4 /dev/vda rw\n\
             61 27 253:1 /real /a rw - ext4 /dev/vda rw\n\
             60 27 0:60 / /a/b/c rw - tmpfs t rw\n",
        )
        .unwrap();
        assert_eq!(chain_place(&shallow, "/a/b/c/d").unwrap(), pl("253:1", "/real/b/c/d"));
        // ... but a mount made inside it is seen
        let inside = Table::parse(
            "27 1 253:1 / / rw - ext4 /dev/vda rw\n\
             61 27 253:1 /real /a rw - ext4 /dev/vda rw\n\
             60 61 0:60 / /a/b/c rw - tmpfs t rw\n",
        )
        .unwrap();
        assert_eq!(chain_place(&inside, "/a/b/c/d").unwrap(), pl("0:60", "/d"));
        assert_eq!(chain_places(&inside, "/a").unwrap(), vec![pl("253:1", "/real"), pl("0:60", "/")]);
    }

    #[test]
    fn without_mount_ids_a_chain_that_is_not_one_tree_places_nothing() {
        let none = |text: &str, why: &str| {
            let t = Table::parse(text).unwrap();
            assert!(t.tops().is_none(), "{why}");
            assert!(chain_place(&t, "/a/b").is_none() && chain_places(&t, "/").is_none(), "{why}");
        };
        // two mounts of one parent on one point (42 and 43 in SAMPLE)
        none(SAMPLE, "two children on one point");
        none("27 1 253:1 / / rw - ext4 a rw\n30 2 0:60 / /a rw - tmpfs t rw\n", "two roots");
        none("27 1 253:1 / /x rw - ext4 a rw\n", "a root not at /");
        none("27 1 253:1 / / rw - ext4 a rw\n30 27 0:60 / /a rw - tmpfs t rw\n31 30 0:61 / /b rw - tmpfs t rw\n", "a mount point not below its parent's");
        none("27 1 253:1 / / rw - ext4 a rw\n30 31 0:60 / /a rw - tmpfs t rw\n31 30 0:61 / /a rw - tmpfs t rw\n", "a loop");
        // a mount listed as its own parent is a root
        let t = Table::parse("1 1 253:1 / / rw - ext4 a rw\n30 1 0:60 / /a rw - tmpfs t rw\n").unwrap();
        assert_eq!(chain_place(&t, "/a/b").unwrap(), pl("0:60", "/b"));
    }

    // ---- filesystems whose files cannot be told apart by device

    const TYPES: &str = "\
27 1 253:1 / / rw - ext4 /dev/vda rw
60 27 0:70 / /mnt/user rw - fuse.shfs shfs rw
61 27 253:2 / /mnt/disk1 rw - xfs /dev/md1 rw
62 27 0:71 / /merged rw - overlay ov rw,lowerdir=/lower
63 27 0:72 / /nas rw - cifs //h/s rw
64 27 0:72 /TeslaCam /nas2 rw - cifs //h/s rw
65 27 0:73 / /nfs rw - nfs4 h:/x rw
66 27 0:74 / /ext rw - ext4 /dev/sdb rw
";

    #[test]
    fn a_merged_or_network_mount_and_another_device_cannot_be_told_apart() {
        for ty in ["overlay", "aufs", "fuse", "fuseblk", "fuse.mergerfs", "fuse.shfs", "cifs", "smb3", "smbfs", "nfs", "nfs4", "9p", "virtiofs", "ceph"] {
            assert!(opaque_type(ty), "{ty}");
        }
        for ty in ["ext4", "xfs", "btrfs", "zfs", "tmpfs", "vfat", "exfat", "fusectl", "proc"] {
            assert!(!opaque_type(ty), "{ty}");
        }
        let t = Table::parse(TYPES).unwrap();
        assert!(t.0[1].fstype == "fuse.shfs" && t.0[3].fstype == "overlay");
        for way in [false, true] {
            let ps = |p: &str| if way { chain_places(&t, p).unwrap() } else { t.places_in_sample(p).unwrap() };
            let ov = |a: &str, b: &str| overlap(&ps(a), &ps(b)) && overlap(&ps(b), &ps(a));
            assert!(ps("/mnt/user/TeslaCam")[0].opaque && !ps("/mnt/disk1")[0].opaque);
            assert!(ov("/mnt/user/TeslaCam", "/mnt/disk1/TeslaCam"), "a union and a branch of it");
            assert!(ov("/merged/TeslaCam", "/lower/TeslaCam"), "an overlay and its lower folder");
            assert!(ov("/nfs/a", "/ext/a"), "a network share and a local disk");
            assert!(ov("/data", "/nas/x"), "a network share and a folder of the root disk");
            assert!(ov("/mnt", "/ext"), "a folder that holds a union");
            // one superblock: paths compare as usual
            assert!(!ov("/mnt/user/a", "/mnt/user/b"));
            assert!(!ov("/nas/x", "/nas2"), "the same share mounted twice, other folders");
            assert!(ov("/nas/TeslaCam/a", "/nas2"), "the same share mounted twice, one inside the other");
            // two plain devices are told apart
            assert!(!ov("/ext/a", "/mnt/disk1/a"));
            assert!(!ov("/ext/a", "/srv"));
        }
        assert!(cannot_tell(&Place { opaque: true, ..pl("0:1", "/") }, &pl("0:2", "/")));
        assert!(!cannot_tell(&Place { opaque: true, ..pl("0:1", "/") }, &Place { opaque: true, ..pl("0:1", "/x") }));
    }

    fn mnt(args: &[&OsStr]) -> bool {
        std::process::Command::new("mount").args(args).stderr(std::process::Stdio::null()).status().is_ok_and(|s| s.success())
    }
    fn um(p: &Path) {
        let _ = std::process::Command::new("umount").arg(p).status();
    }

    /// The parent chain places every path as the kernel does, on real hidden, stacked and
    /// moved mounts (root only).
    #[test]
    fn the_parent_chain_agrees_with_the_kernel_on_real_hidden_and_moved_mounts() {
        if mnt_id(Path::new("/")).is_none() {
            eprintln!("skipped: no STATX_MNT_ID to compare with");
            return;
        }
        let tmp = crate::converter::testutil::tempdir().unwrap();
        let tmp = std::fs::canonicalize(tmp.path()).unwrap();
        let real = tmp.join("real/TeslaCam");
        std::fs::create_dir_all(real.join("SentryClips/evt")).unwrap();
        let share = tmp.join("share/TeslaCam");
        std::fs::create_dir_all(share.join("SentryClips")).unwrap();
        let view = tmp.join("view");
        std::fs::create_dir_all(view.join("SentryClips")).unwrap();
        let (x, y) = (tmp.join("x"), tmp.join("y"));
        std::fs::create_dir_all(&x).unwrap();
        std::fs::create_dir_all(&y).unwrap();
        if !mnt(&[OsStr::new("-t"), OsStr::new("tmpfs"), OsStr::new("t"), share.join("SentryClips").as_os_str()]) {
            eprintln!("skipped: needs root");
            return;
        }
        let mut made = vec![share.join("SentryClips")];
        let mut ok = true;
        let mut add = |args: &[&OsStr], at: &Path, made: &mut Vec<PathBuf>| {
            let r = mnt(args);
            if r {
                made.push(at.to_path_buf());
            }
            ok &= r;
            r
        };
        add(&[OsStr::new("--bind"), real.as_os_str(), share.as_os_str()], &share, &mut made);
        add(&[OsStr::new("--bind"), real.join("SentryClips").as_os_str(), view.join("SentryClips").as_os_str()], &view.join("SentryClips"), &mut made);
        if add(&[OsStr::new("--bind"), real.as_os_str(), y.as_os_str()], &y, &mut made) && add(&[OsStr::new("-t"), OsStr::new("tmpfs"), OsStr::new("t"), x.as_os_str()], &x, &mut made) {
            // y moved onto x: on top of the tmpfs, but listed before it
            if add(&[OsStr::new("--move"), y.as_os_str(), x.as_os_str()], &x, &mut made) {
                made.retain(|p| p != &y);
            }
        }
        // a tmpfs stacked twice on one point
        let z = tmp.join("z");
        std::fs::create_dir_all(&z).unwrap();
        add(&[OsStr::new("-t"), OsStr::new("tmpfs"), OsStr::new("t"), z.as_os_str()], &z, &mut made);
        add(&[OsStr::new("-t"), OsStr::new("tmpfs"), OsStr::new("t"), z.as_os_str()], &z, &mut made);
        let t = Table::read();
        let mut bad = vec![];
        if let Some(t) = &t {
            let tops = t.tops();
            for p in [tmp.clone(), share.clone(), share.join("SentryClips/evt"), view.clone(), view.join("SentryClips/evt"), x.clone(), x.join("SentryClips/evt"), z.clone(), tmp.join("share")] {
                let chain = tops.as_ref().and_then(|tops| t.place_by_chain(&p, tops));
                let kernel = t.place_of_real_by(&p, &mnt_id);
                if chain.is_none() || chain != kernel {
                    bad.push(format!("{}: chain {chain:?} kernel {kernel:?}", p.display()));
                }
                let (a, b) = (t.places_by_chain(&p), t.places_of_real_by(&p, &mnt_id));
                if !matches!((&a, &b), (Some(a), Some(b)) if a.iter().all(|q| b.contains(q)) && b.iter().all(|q| a.contains(q))) {
                    bad.push(format!("{}: places chain {a:?} kernel {b:?}", p.display()));
                }
            }
            // every mount point of this process
            for m in &t.0 {
                let chain = tops.as_ref().and_then(|tops| t.place_by_chain(&m.at, tops));
                let kernel = t.place_of_real_by(&m.at, &mnt_id);
                if kernel.is_some() && chain != kernel {
                    bad.push(format!("{}: chain {chain:?} kernel {kernel:?}", m.at.display()));
                }
            }
        }
        for p in made.iter().rev() {
            um(p);
        }
        assert!(ok, "mounts made");
        assert!(t.is_some());
        assert!(bad.is_empty(), "{bad:#?}");
    }

    /// An overlay's merged folder and its lower folder are the same files on two devices.
    #[test]
    fn an_overlay_and_its_lower_folder_overlap() {
        let tmp = crate::converter::testutil::tempdir().unwrap();
        let lower = tmp.path().join("lower/TeslaCam");
        std::fs::create_dir_all(lower.join("SentryClips/evt")).unwrap();
        std::fs::create_dir_all(lower.join("RecentClips")).unwrap();
        let (up, work, merged, other) = (tmp.path().join("up"), tmp.path().join("work"), tmp.path().join("merged"), tmp.path().join("other"));
        for d in [&up, &work, &merged, &other] {
            std::fs::create_dir_all(d).unwrap();
        }
        let o = format!("lowerdir={},upperdir={},workdir={}", tmp.path().join("lower").display(), up.display(), work.display());
        if !mnt(&[OsStr::new("-t"), OsStr::new("overlay"), OsStr::new("ov"), OsStr::new("-o"), OsStr::new(&o), merged.as_os_str()]) {
            eprintln!("skipped: no overlay (or not root)");
            return;
        }
        let r = [
            folders_overlap(&merged.join("TeslaCam"), &lower),
            folders_overlap(&lower.join("SentryClips"), &merged.join("TeslaCam/SentryClips/evt")),
            folders_overlap(&merged.join("TeslaCam/SentryClips"), &merged.join("TeslaCam/SentryClips/evt")),
            folders_overlap(&merged.join("TeslaCam/SentryClips/evt"), &merged.join("TeslaCam/RecentClips")),
            folders_overlap(&other, &lower),
        ];
        force_parent_chain(true);
        let c = folders_overlap(&merged.join("TeslaCam"), &lower);
        force_parent_chain(false);
        um(&merged);
        assert!(r[0] && r[1] && c, "merged and lower: {r:?} {c}");
        assert!(r[2], "one folder inside the other in the overlay");
        assert!(!r[3] && !r[4], "other folders of one device still apart: {r:?}");
    }
}
