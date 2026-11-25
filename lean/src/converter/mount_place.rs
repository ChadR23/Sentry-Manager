//! Where a folder is on its filesystem, whatever mount it is reached through.
//!
//! A folder's place is the device of the mount that holds it and its path inside that
//! filesystem (the mount's root, from /proc/self/mountinfo, joined with the rest of the
//! path below the mount point). Two spellings of one folder (a bind mount of it, or of a
//! folder above or below it) have places that are one inside the other, where walking the
//! folders above a path by dev:ino does not see it: when only a subfolder is bind-mounted
//! the two chains of folders above split at the mount point.
//!
//! A folder also holds what is mounted below it, so `places` lists the folder's own place
//! and the root of every mount below it. Anything that cannot be read, parsed or resolved
//! is None, and callers keep (treat it as overlapping).

use std::ffi::OsString;
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
struct Mount {
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
fn unescape(s: &str) -> Option<PathBuf> {
    let b = s.as_bytes();
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

fn parse_line(line: &str) -> Option<Mount> {
    let f: Vec<&str> = line.split(' ').collect();
    if f.len() < 7 {
        return None;
    }
    let (maj, min) = f[2].split_once(':')?;
    if maj.is_empty() || min.is_empty() || !maj.bytes().chain(min.bytes()).all(|c| c.is_ascii_digit()) {
        return None;
    }
    // optional fields, then " - ", then the filesystem type, source and options
    if !f[6..].contains(&"-") {
        return None;
    }
    let at = unescape(f[4]).filter(|p| p.is_absolute())?;
    Some(Mount { dev: f[2].to_string(), root: unescape(f[3])?, at })
}

impl Table {
    /// The text of a mountinfo file; None when any line of it is not one.
    pub fn parse(text: &str) -> Option<Table> {
        let v = text.lines().filter(|l| !l.is_empty()).map(parse_line).collect::<Option<Vec<_>>>()?;
        if v.is_empty() {
            return None;
        }
        Some(Table(v))
    }

    pub fn read() -> Option<Table> {
        Table::parse(&std::fs::read_to_string("/proc/self/mountinfo").ok()?)
    }

    /// The place of a path already made real: the mount with the longest mount point above
    /// it (the last one listed of mounts at one point, which hides the earlier ones).
    pub fn place_of_real(&self, real: &Path) -> Option<Place> {
        let mut best: Option<&Mount> = None;
        for m in &self.0 {
            if real.starts_with(&m.at) && best.is_none_or(|b| m.at.components().count() >= b.at.components().count()) {
                best = Some(m);
            }
        }
        let m = best?;
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
        let mut out = vec![self.place_of_real(real)?];
        for m in &self.0 {
            if m.at != real && m.at.starts_with(real) {
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

    fn pl(dev: &str, p: &str) -> Place {
        Place { dev: dev.into(), path: p.into() }
    }

    #[test]
    fn parses_escapes_and_optional_fields() {
        let t = t();
        assert_eq!(t.0.len(), 7);
        assert_eq!(t.0[3].at, Path::new("/mnt/my usb"));
        assert_eq!(t.0[2].root, Path::new("/srv/share/TeslaCam/SentryClips"));
        assert_eq!(unescape(r"a\134b\011c\012d").unwrap(), Path::new("a\\b\tc\nd"));
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
    fn places_through_the_longest_mount_point() {
        let t = t();
        assert_eq!(t.place_of_real(Path::new("/srv/share/TeslaCam")).unwrap(), pl("253:1", "/srv/share/TeslaCam"));
        assert_eq!(t.place_of_real(Path::new("/view/SentryClips/2026-x")).unwrap(), pl("253:1", "/srv/share/TeslaCam/SentryClips/2026-x"));
        assert_eq!(t.place_of_real(Path::new("/view/SentryClips")).unwrap(), pl("253:1", "/srv/share/TeslaCam/SentryClips"));
        assert_eq!(t.place_of_real(Path::new("/view")).unwrap(), pl("253:1", "/view"));
        assert_eq!(t.place_of_real(Path::new("/mnt/my usb/TeslaCam")).unwrap(), pl("0:50", "/TeslaCam"));
        // a later mount at one point hides the earlier one
        assert_eq!(t.place_of_real(Path::new("/cam/a")).unwrap(), pl("253:1", "/hidden/a"));
        // a mount point that only shares a prefix of its name is not above
        assert_eq!(t.place_of_real(Path::new("/viewer")).unwrap(), pl("253:1", "/viewer"));
    }

    #[test]
    fn a_folder_above_a_bind_mount_point_holds_what_is_mounted_there() {
        let t = t();
        let view = t.places_of_real(Path::new("/view")).unwrap();
        let cam = t.places_of_real(Path::new("/srv/share/TeslaCam")).unwrap();
        let clip = t.place_of_real(Path::new("/srv/share/TeslaCam/SentryClips/2026-x")).unwrap();
        let via = t.place_of_real(Path::new("/view/SentryClips/2026-x")).unwrap();
        assert!(holds(&view, &clip), "view holds the real folder");
        assert!(holds(&cam, &via), "TeslaCam holds the bind spelling");
        assert!(overlap(&view, &cam) && overlap(&cam, &view));
        let other = t.places_of_real(Path::new("/srv/share/Other")).unwrap();
        assert!(!overlap(&other, &view) && !overlap(&cam, &other));
        assert!(!holds(&other, &clip));
        // a folder inside the root does not hold the root's other folders
        let sub = t.places_of_real(Path::new("/srv/share/TeslaCam/RecentClips")).unwrap();
        assert!(!holds(&sub, &clip));
        assert!(overlap(&sub, &cam), "a folder inside the other");
        // the same path on another device is another folder
        assert!(!within(&pl("0:50", "/TeslaCam"), &pl("253:1", "/")));
        // "/" holds everything mounted anywhere
        assert!(holds(&t.places_of_real(Path::new("/")).unwrap(), &pl("0:50", "/TeslaCam/x")));
    }

    #[test]
    fn reads_this_process_table() {
        let t = Table::read().expect("mountinfo");
        let here = t.place(Path::new("/")).unwrap();
        assert!(!here.dev.is_empty());
        assert!(!folders_overlap(Path::new("/proc"), Path::new("/sys")));
        assert!(folders_overlap(Path::new("/nonexistent-folder-x"), Path::new("/")), "unresolvable keeps");
    }
}
