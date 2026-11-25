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
//! A folder also holds what is mounted below it, so `places` lists the folder's own place
//! and the root of every visible mount below it (one whose mount point the kernel reports
//! on that mount). Anything that cannot be read, parsed or resolved (a kernel without
//! STATX_MNT_ID included) is None, and callers keep (treat it as overlapping).

use std::ffi::{CString, OsString};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
struct Mount {
    id: u64,
    dev: String,
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
    let dev = std::str::from_utf8(f[2]).ok()?;
    let (maj, min) = dev.split_once(':')?;
    if !digits(maj.as_bytes()) || !digits(min.as_bytes()) {
        return None;
    }
    // optional fields, then " - ", then the filesystem type, source and options
    if !f[6..].contains(&&b"-"[..]) {
        return None;
    }
    let at = unescape(f[4]).filter(|p| p.is_absolute())?;
    Some(Mount { id, dev: dev.to_string(), root: unescape(f[3])?, at })
}

/// The id of the mount a path is on, as the kernel sees it (statx STATX_MNT_ID; the same
/// number as the first field of that mount's mountinfo line). None when the kernel does
/// not report it (before Linux 5.8) or the path cannot be looked at.
pub fn mnt_id(path: &Path) -> Option<u64> {
    let c = CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: a zeroed statx is a valid buffer for the kernel to fill.
    let mut stx: libc::statx = unsafe { std::mem::zeroed() };
    // a raw syscall: not every libc this is built against has a statx wrapper
    // SAFETY: c is a NUL-terminated path and stx outlives the call.
    let r = unsafe { libc::syscall(libc::SYS_statx, libc::AT_FDCWD, c.as_ptr(), libc::AT_STATX_SYNC_AS_STAT, libc::STATX_MNT_ID, &mut stx as *mut libc::statx) };
    if r != 0 || stx.stx_mask & libc::STATX_MNT_ID == 0 {
        return None;
    }
    Some(stx.stx_mnt_id)
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
    /// up by id (a mount listed with a longer mount point above the path may be hidden).
    pub fn place_of_real(&self, real: &Path) -> Option<Place> {
        self.place_of_real_by(real, &mnt_id)
    }

    fn place_of_real_by(&self, real: &Path, id_of: &dyn Fn(&Path) -> Option<u64>) -> Option<Place> {
        let id = id_of(real)?;
        let m = self.0.iter().find(|m| m.id == id)?;
        // (a mount that is not above the path as this table has it: the table is stale)
        let rest = real.strip_prefix(&m.at).ok()?;
        let path = if rest.as_os_str().is_empty() { m.root.clone() } else { m.root.join(rest) };
        Some(Place { dev: m.dev.clone(), path })
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
        self.places_of_real_by(real, &mnt_id)
    }

    /// Only the mounts below that are visible count: one whose mount point is on another
    /// mount (hidden under a later one) holds nothing reachable here. A mount point that
    /// cannot be looked at counts (holding more only keeps more).
    fn places_of_real_by(&self, real: &Path, id_of: &dyn Fn(&Path) -> Option<u64>) -> Option<Vec<Place>> {
        let mut out = vec![self.place_of_real_by(real, id_of)?];
        for m in &self.0 {
            if m.at != real && m.at.starts_with(real) && id_of(&m.at).is_none_or(|id| id == m.id) {
                let p = Place { dev: m.dev.clone(), path: m.root.clone() };
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

/// Two folders share files: some part of one is in or above some part of the other.
pub fn overlap(x: &[Place], y: &[Place]) -> bool {
    x.iter().any(|a| y.iter().any(|b| within(a, b) || within(b, a)))
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
        Place { dev: dev.into(), path: p.into() }
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
}
