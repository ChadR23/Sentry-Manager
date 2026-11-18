//! server/zip.js: just enough of the .zip format for interface packs: read an
//! uploaded archive (stored or deflated files, no encryption) and write one.
//! Every size is checked against limits before anything is inflated, and each
//! file is inflated to at most its declared size and checked against its CRC.
//! Zip64 is read, and written only where it is needed. (streamZip, the CAN
//! bundles' streamed writer, belongs to the CAN area.)

use std::io::{Read, Write};

#[derive(Debug, Clone, PartialEq)]
pub struct ZipError(pub String);

impl std::fmt::Display for ZipError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub struct Entry {
    pub name: String,
    pub data: Vec<u8>,
}

const EOCD: u32 = 0x0605_4b50;
const CENTRAL: u32 = 0x0201_4b50;
const LOCAL: u32 = 0x0403_4b50;
const ZIP64_END: u32 = 0x0606_4b50;
const ZIP64_LOCATOR: u32 = 0x0706_4b50;
const MAX16: u64 = 0xffff;
const MAX32: u64 = 0xffff_ffff;

pub struct Limits {
    pub max_files: u64,
    pub max_total: u64,
    pub max_file: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { max_files: 5000, max_total: 256 * 1024 * 1024, max_file: 64 * 1024 * 1024 }
    }
}

fn u16_at(b: &[u8], i: usize) -> u64 {
    b.get(i..i + 2).map_or(0, |s| u16::from_le_bytes([s[0], s[1]]) as u64)
}
fn u32_at(b: &[u8], i: usize) -> u64 {
    b.get(i..i + 4).map_or(0, |s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as u64)
}
fn u64_at(b: &[u8], i: usize) -> u64 {
    b.get(i..i + 8).map_or(0, |s| u64::from_le_bytes(s.try_into().unwrap()))
}

pub fn crc32(data: &[u8]) -> u32 {
    let mut c = flate2::Crc::new();
    c.update(data);
    c.sum()
}

fn damaged() -> ZipError {
    ZipError("The .zip file is damaged.".into())
}

/// latin1 as Node's Buffer#toString('latin1')
fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| c as char).collect()
}

/// The files in a .zip: folders and symbolic links are left out. An error for
/// anything it cannot read safely.
pub fn read_zip(buf: &[u8], lim: &Limits) -> Result<Vec<Entry>, ZipError> {
    let not_zip = || ZipError("That is not a .zip file.".into());
    if buf.len() < 22 {
        return Err(not_zip());
    }
    // the end record is in the last 22 bytes plus a comment of up to 64 KiB
    let mut end: Option<usize> = None;
    let lowest = buf.len().saturating_sub(22 + 0xffff);
    let mut i = buf.len() - 22;
    loop {
        if u32_at(buf, i) == EOCD as u64 {
            end = Some(i);
            break;
        }
        if i == lowest {
            break;
        }
        i -= 1;
    }
    let end = end.ok_or_else(not_zip)?;
    let mut count = u16_at(buf, end + 10);
    let mut cd_size = u32_at(buf, end + 12);
    let mut cd_offset = u32_at(buf, end + 16);
    let mut cd_end = end as u64;
    if (count == MAX16 || cd_size == MAX32 || cd_offset == MAX32) && end >= 20 && u32_at(buf, end - 20) == ZIP64_LOCATOR as u64 {
        let at = u64_at(buf, end - 12);
        if at.saturating_add(56) > (end - 20) as u64 || u32_at(buf, at as usize) != ZIP64_END as u64 {
            return Err(damaged());
        }
        let at = at as usize;
        count = u64_at(buf, at + 32);
        cd_size = u64_at(buf, at + 40);
        cd_offset = u64_at(buf, at + 48);
        cd_end = at as u64;
    }
    if count > lim.max_files {
        return Err(ZipError(format!("Too many files (over {}).", lim.max_files)));
    }
    if cd_offset.saturating_add(cd_size) > cd_end {
        return Err(damaged());
    }
    let cd_end = cd_end as usize;
    let mut files = Vec::new();
    let mut total: u64 = 0;
    let mut at = cd_offset as usize;
    for _ in 0..count {
        if at + 46 > cd_end || u32_at(buf, at) != CENTRAL as u64 {
            return Err(damaged());
        }
        let flags = u16_at(buf, at + 8);
        let method = u16_at(buf, at + 10);
        let crc = u32_at(buf, at + 16) as u32;
        let mut csize = u32_at(buf, at + 20);
        let mut usize_ = u32_at(buf, at + 24);
        let name_len = u16_at(buf, at + 28) as usize;
        let extra_len = u16_at(buf, at + 30) as usize;
        let comment_len = u16_at(buf, at + 32) as usize;
        let made_by = u16_at(buf, at + 4) >> 8;
        let attrs = u32_at(buf, at + 38);
        let mut local = u32_at(buf, at + 42);
        let raw_name = buf.get(at + 46..(at + 46 + name_len).min(buf.len())).unwrap_or(&[]);
        let name = if flags & 0x800 != 0 { String::from_utf8_lossy(raw_name).into_owned() } else { latin1(raw_name) };
        if at + 46 + name_len + extra_len + comment_len > cd_end {
            return Err(damaged());
        }
        if usize_ == MAX32 || csize == MAX32 || local == MAX32 {
            // the Zip64 extra field holds the fields set to 0xFFFFFFFF, in this order
            let mut x = at + 46 + name_len;
            let x_end = x + extra_len;
            while x + 4 <= x_end && u16_at(buf, x) != 0x0001 {
                x += 4 + u16_at(buf, x + 2) as usize;
            }
            if x + 4 > x_end {
                return Err(damaged());
            }
            let mut v = x + 4;
            let field_end = x_end.min(v + u16_at(buf, x + 2) as usize);
            let mut next = || -> Result<u64, ZipError> {
                if v + 8 > field_end {
                    return Err(damaged());
                }
                v += 8;
                Ok(u64_at(buf, v - 8))
            };
            if usize_ == MAX32 {
                usize_ = next()?;
            }
            if csize == MAX32 {
                csize = next()?;
            }
            if local == MAX32 {
                local = next()?;
            }
        }
        at += 46 + name_len + extra_len + comment_len;
        if name.ends_with('/') {
            continue;
        }
        // (a Unix symbolic link: its target is the content)
        if made_by == 3 && ((attrs >> 16) & 0o170000) == 0o120000 {
            continue;
        }
        if flags & 1 != 0 {
            return Err(ZipError("Encrypted .zip files are not supported.".into()));
        }
        if method != 0 && method != 8 {
            return Err(ZipError(format!("\"{name}\" is packed in a way that is not supported (use normal zip compression).")));
        }
        if usize_ > lim.max_file {
            return Err(ZipError(format!("\"{name}\" is too large.")));
        }
        total += usize_;
        if total > lim.max_total {
            return Err(ZipError("The pack is too large when unpacked.".into()));
        }
        let local = local as usize;
        if local.saturating_add(30) > buf.len() || u32_at(buf, local) != LOCAL as u64 {
            return Err(damaged());
        }
        let start = local + 30 + u16_at(buf, local + 26) as usize + u16_at(buf, local + 28) as usize;
        if (start as u64).saturating_add(csize) > buf.len() as u64 {
            return Err(damaged());
        }
        let raw = &buf[start..start + csize as usize];
        let bad = || ZipError(format!("\"{name}\" is damaged."));
        let data = if method == 0 {
            raw.to_vec()
        } else {
            // inflated to at most its declared size (zlib's maxOutputLength: more is an error)
            let cap = usize_.max(1);
            let mut d = flate2::read::DeflateDecoder::new(raw).take(cap + 1);
            let mut out = Vec::with_capacity(cap.min(1 << 20) as usize);
            d.read_to_end(&mut out).map_err(|_| bad())?;
            if out.len() as u64 > cap {
                return Err(bad());
            }
            out
        };
        if data.len() as u64 != usize_ || crc32(&data) != crc {
            return Err(bad());
        }
        files.push(Entry { name, data });
    }
    Ok(files)
}

fn zip64_extra(values: &[u64]) -> Vec<u8> {
    let mut b = Vec::with_capacity(4 + 8 * values.len());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&((8 * values.len()) as u16).to_le_bytes());
    for v in values {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b
}

pub struct Record<'a> {
    pub name: &'a [u8],
    pub flags: u16,
    pub method: u16,
    pub time: u16,
    pub date: u16,
    pub crc: u32,
    pub csize: u64,
    pub usize: u64,
}

/// A local file header and its name (zip64: both sizes in the extra field).
pub fn local_header(r: &Record, zip64: bool) -> Vec<u8> {
    let extra = if zip64 { zip64_extra(&[r.usize, r.csize]) } else { Vec::new() };
    let mut h = Vec::with_capacity(30 + r.name.len() + extra.len());
    h.extend_from_slice(&LOCAL.to_le_bytes());
    h.extend_from_slice(&(if zip64 { 45u16 } else { 20 }).to_le_bytes());
    h.extend_from_slice(&r.flags.to_le_bytes());
    h.extend_from_slice(&r.method.to_le_bytes());
    h.extend_from_slice(&r.time.to_le_bytes());
    h.extend_from_slice(&r.date.to_le_bytes());
    h.extend_from_slice(&r.crc.to_le_bytes());
    h.extend_from_slice(&(if zip64 { MAX32 as u32 } else { r.csize as u32 }).to_le_bytes());
    h.extend_from_slice(&(if zip64 { MAX32 as u32 } else { r.usize as u32 }).to_le_bytes());
    h.extend_from_slice(&(r.name.len() as u16).to_le_bytes());
    h.extend_from_slice(&(extra.len() as u16).to_le_bytes());
    h.extend_from_slice(r.name);
    h.extend_from_slice(&extra);
    h
}

/// A central directory record (a value of 4 GiB or more goes in a Zip64 extra field).
pub fn central_record(r: &Record, offset: u64) -> Vec<u8> {
    let big: Vec<u64> = [r.usize, r.csize, offset].into_iter().filter(|v| *v >= MAX32).collect();
    let extra = if big.is_empty() { Vec::new() } else { zip64_extra(&big) };
    let version: u16 = if big.is_empty() { 20 } else { 45 };
    let mut e = vec![0u8; 46];
    e[0..4].copy_from_slice(&CENTRAL.to_le_bytes());
    e[4..6].copy_from_slice(&version.to_le_bytes());
    e[6..8].copy_from_slice(&version.to_le_bytes());
    e[8..10].copy_from_slice(&r.flags.to_le_bytes());
    e[10..12].copy_from_slice(&r.method.to_le_bytes());
    e[12..14].copy_from_slice(&r.time.to_le_bytes());
    e[14..16].copy_from_slice(&r.date.to_le_bytes());
    e[16..20].copy_from_slice(&r.crc.to_le_bytes());
    e[20..24].copy_from_slice(&(r.csize.min(MAX32) as u32).to_le_bytes());
    e[24..28].copy_from_slice(&(r.usize.min(MAX32) as u32).to_le_bytes());
    e[28..30].copy_from_slice(&(r.name.len() as u16).to_le_bytes());
    e[30..32].copy_from_slice(&(extra.len() as u16).to_le_bytes());
    e[42..46].copy_from_slice(&(offset.min(MAX32) as u32).to_le_bytes());
    e.extend_from_slice(r.name);
    e.extend_from_slice(&extra);
    e
}

/// The end of the archive (the Zip64 end record and locator first when needed).
pub fn end_records(count: u64, cd_size: u64, cd_at: u64) -> Vec<u8> {
    let mut tail = vec![0u8; 22];
    tail[0..4].copy_from_slice(&EOCD.to_le_bytes());
    tail[8..10].copy_from_slice(&(count.min(MAX16) as u16).to_le_bytes());
    tail[10..12].copy_from_slice(&(count.min(MAX16) as u16).to_le_bytes());
    tail[12..16].copy_from_slice(&(cd_size.min(MAX32) as u32).to_le_bytes());
    tail[16..20].copy_from_slice(&(cd_at.min(MAX32) as u32).to_le_bytes());
    if count < MAX16 && cd_size < MAX32 && cd_at < MAX32 {
        return tail;
    }
    let mut end64 = vec![0u8; 56];
    end64[0..4].copy_from_slice(&ZIP64_END.to_le_bytes());
    end64[4..12].copy_from_slice(&44u64.to_le_bytes());
    end64[12..14].copy_from_slice(&45u16.to_le_bytes());
    end64[14..16].copy_from_slice(&45u16.to_le_bytes());
    end64[24..32].copy_from_slice(&count.to_le_bytes());
    end64[32..40].copy_from_slice(&count.to_le_bytes());
    end64[40..48].copy_from_slice(&cd_size.to_le_bytes());
    end64[48..56].copy_from_slice(&cd_at.to_le_bytes());
    let mut locator = vec![0u8; 20];
    locator[0..4].copy_from_slice(&ZIP64_LOCATOR.to_le_bytes());
    locator[8..16].copy_from_slice(&(cd_at + cd_size).to_le_bytes());
    locator[16..20].copy_from_slice(&1u32.to_le_bytes());
    end64.extend_from_slice(&locator);
    end64.extend_from_slice(&tail);
    end64
}

pub fn deflate_raw(data: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
    let _ = e.write_all(data);
    e.finish().unwrap_or_default()
}

/// A .zip of these files, deflated (writeZip; dated 1 January 2026).
pub fn write_zip(files: &[Entry]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    let date: u16 = ((2026 - 1980) << 9) | (1 << 5) | 1;
    for f in files {
        let packed = deflate_raw(&f.data);
        let r = Record { name: f.name.as_bytes(), flags: 0x800, method: 8, time: 0, date, crc: crc32(&f.data), csize: packed.len() as u64, usize: f.data.len() as u64 };
        let offset = out.len() as u64;
        out.extend_from_slice(&local_header(&r, r.csize >= MAX32 || r.usize >= MAX32));
        out.extend_from_slice(&packed);
        central.extend_from_slice(&central_record(&r, offset));
    }
    let cd_at = out.len() as u64;
    let cd_len = central.len() as u64;
    out.extend_from_slice(&central);
    out.extend_from_slice(&end_records(files.len() as u64, cd_len, cd_at));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        write_zip(&files.iter().map(|(n, d)| Entry { name: n.to_string(), data: d.to_vec() }).collect::<Vec<_>>())
    }
    fn find_last(b: &[u8], pat: &[u8]) -> usize {
        (0..=b.len() - pat.len()).rev().find(|&i| &b[i..i + pat.len()] == pat).unwrap()
    }
    fn err(r: Result<Vec<Entry>, ZipError>) -> String {
        match r {
            Err(e) => e.0,
            Ok(_) => panic!("read"),
        }
    }

    // test/uiPacks.test.js
    #[test]
    fn written_reads_back_byte_for_byte() {
        let big = b"abc".repeat(100_000);
        let files = read_zip(&zip(&[("web/app.js", b"console.log(1)"), ("web/fonts/x.woff2", &big), ("ünï.txt", b"")]), &Limits::default()).unwrap();
        assert_eq!(files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["web/app.js", "web/fonts/x.woff2", "ünï.txt"]);
        assert_eq!(files[0].data, b"console.log(1)");
        assert_eq!(files[1].data, big);
        assert!(files[2].data.is_empty());
    }

    #[test]
    fn damaged_encrypted_oversized_and_bombs_refused() {
        assert!(err(read_zip(b"not a zip at all, just some text here", &Limits::default())).contains("not a .zip"));
        let good = zip(&[("a.txt", b"hello hello hello")]);
        let mut bad = good.clone();
        bad[30 + 5 + 2] ^= 0xff;
        assert!(err(read_zip(&bad, &Limits::default())).contains("damaged"));
        let mut enc = good.clone();
        let cd = find_last(&enc, &[0x50, 0x4b, 1, 2]);
        enc[cd + 8..cd + 10].copy_from_slice(&1u16.to_le_bytes());
        assert!(err(read_zip(&enc, &Limits::default())).contains("Encrypted"));
        let mut bomb = zip(&[("b.txt", &vec![0u8; 1_000_000])]);
        let cd2 = find_last(&bomb, &[0x50, 0x4b, 1, 2]);
        bomb[cd2 + 24..cd2 + 28].copy_from_slice(&10u32.to_le_bytes());
        assert!(err(read_zip(&bomb, &Limits::default())).contains("damaged"));
        assert!(err(read_zip(&zip(&[("c.txt", &[0u8; 2000])]), &Limits { max_file: 1000, ..Default::default() })).contains("too large"));
        assert!(err(read_zip(&zip(&[("a", b"1"), ("b", b"2"), ("c", b"3")]), &Limits { max_files: 2, ..Default::default() })).contains("Too many"));
        assert!(err(read_zip(&zip(&[("a", &[0u8; 600]), ("b", &[0u8; 600])]), &Limits { max_total: 1000, ..Default::default() })).contains("too large"));
    }

    #[test]
    fn symlinks_left_out() {
        let mut buf = zip(&[("web/link.js", b"/etc/passwd"), ("web/app.js", b"x")]);
        let cd = (0..buf.len()).find(|&i| buf[i..].starts_with(&[0x50, 0x4b, 1, 2])).unwrap();
        buf[cd + 4..cd + 6].copy_from_slice(&((3u16 << 8) | 20).to_le_bytes());
        buf[cd + 38..cd + 42].copy_from_slice(&(0o120777u32 << 16).to_le_bytes());
        assert_eq!(read_zip(&buf, &Limits::default()).unwrap().iter().map(|f| f.name.clone()).collect::<Vec<_>>(), ["web/app.js"]);
    }

    // test/zip64.test.js
    #[test]
    fn small_archive_is_the_classic_format() {
        let z = zip(&[("web/x.js", b"1"), ("ü", b"")]);
        assert_eq!(u32_at(&z, z.len() - 22), EOCD as u64);
        assert_ne!(u32_at(&z, z.len() - 42), ZIP64_LOCATOR as u64);
        // (Node's zlib and this deflate may pack the bytes differently; the records are the same)
        let files = read_zip(&z, &Limits::default()).unwrap();
        assert_eq!(files[0].data, b"1");
        assert_eq!(files[1].name, "ü");
    }

    #[test]
    fn zip64_records_read_back() {
        // a central directory with its offset in a Zip64 extra field, and Zip64 end records
        let data = b"hello";
        let packed = deflate_raw(data);
        let r = Record { name: b"a.txt", flags: 0x800, method: 8, time: 0, date: 0, crc: crc32(data), csize: packed.len() as u64, usize: 5 };
        let mut out = local_header(&r, true);
        out.extend_from_slice(&packed);
        let cd_at = out.len() as u64;
        // force the Zip64 form: offset as 0xFFFFFFFF with the real value in the extra field
        let mut cd = central_record(&r, 0);
        cd[42..46].copy_from_slice(&u32::MAX.to_le_bytes());
        let extra = zip64_extra(&[0]);
        cd[30..32].copy_from_slice(&(extra.len() as u16).to_le_bytes());
        cd.extend_from_slice(&extra);
        out.extend_from_slice(&cd);
        let cd_len = cd.len() as u64;
        let mut ends = end_records(70_000, cd_len, cd_at);
        // one file really: the Zip64 count says so, the classic one 0xFFFF
        let z = ends.len() - 22 - 20 - 56;
        ends[z + 24..z + 32].copy_from_slice(&1u64.to_le_bytes());
        ends[z + 32..z + 40].copy_from_slice(&1u64.to_le_bytes());
        out.extend_from_slice(&ends);
        let files = read_zip(&out, &Limits::default()).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].data, b"hello");
    }

    #[test]
    fn end_records_zip64_only_when_needed() {
        assert_eq!(end_records(3, 100, 200).len(), 22);
        let e = end_records(70_000, 100, 200);
        assert_eq!(e.len(), 98);
        assert_eq!(u16_at(&e, 98 - 22 + 10), 0xffff);
        assert_eq!(u64_at(&e, 32), 70_000);
        assert_eq!(u64_at(&e, 56 + 8), 300);
    }
}
