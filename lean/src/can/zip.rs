//! A .zip streamed as it is written (server/zip.js streamZip): each entry
//! stored as it is, its CRC worked out while it streams and written after it
//! (a data descriptor), Zip64 where a size, an offset or the count needs it.

use std::io::{self, Read, Write};

const EOCD: u32 = 0x06054b50;
const CENTRAL: u32 = 0x02014b50;
const LOCAL: u32 = 0x04034b50;
const DESCRIPTOR: u32 = 0x08074b50;
const ZIP64_END: u32 = 0x06064b50;
const ZIP64_LOCATOR: u32 = 0x07064b50;
const MAX16: u64 = 0xffff;
const MAX32: u64 = 0xffff_ffff;

fn zip64_extra(values: &[u64]) -> Vec<u8> {
    let mut b = Vec::with_capacity(4 + 8 * values.len());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&((8 * values.len()) as u16).to_le_bytes());
    for v in values {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b
}

fn local_header(name: &[u8], flags: u16, method: u16, time: u16, date: u16, zip64: bool) -> Vec<u8> {
    let extra = if zip64 { zip64_extra(&[0, 0]) } else { Vec::new() };
    let mut h = Vec::with_capacity(30 + name.len() + extra.len());
    h.extend_from_slice(&LOCAL.to_le_bytes());
    h.extend_from_slice(&(if zip64 { 45u16 } else { 20 }).to_le_bytes());
    h.extend_from_slice(&flags.to_le_bytes());
    h.extend_from_slice(&method.to_le_bytes());
    h.extend_from_slice(&time.to_le_bytes());
    h.extend_from_slice(&date.to_le_bytes());
    h.extend_from_slice(&0u32.to_le_bytes());
    let sz = if zip64 { MAX32 as u32 } else { 0 };
    h.extend_from_slice(&sz.to_le_bytes());
    h.extend_from_slice(&sz.to_le_bytes());
    h.extend_from_slice(&(name.len() as u16).to_le_bytes());
    h.extend_from_slice(&(extra.len() as u16).to_le_bytes());
    h.extend_from_slice(name);
    h.extend_from_slice(&extra);
    h
}

#[allow(clippy::too_many_arguments)]
fn central_record(name: &[u8], flags: u16, method: u16, time: u16, date: u16, crc: u32, csize: u64, usize_: u64, offset: u64) -> Vec<u8> {
    let big: Vec<u64> = [usize_, csize, offset].into_iter().filter(|v| *v >= MAX32).collect();
    let extra = if big.is_empty() { Vec::new() } else { zip64_extra(&big) };
    let version: u16 = if big.is_empty() { 20 } else { 45 };
    let mut e = Vec::with_capacity(46 + name.len() + extra.len());
    e.extend_from_slice(&CENTRAL.to_le_bytes());
    e.extend_from_slice(&version.to_le_bytes());
    e.extend_from_slice(&version.to_le_bytes());
    e.extend_from_slice(&flags.to_le_bytes());
    e.extend_from_slice(&method.to_le_bytes());
    e.extend_from_slice(&time.to_le_bytes());
    e.extend_from_slice(&date.to_le_bytes());
    e.extend_from_slice(&crc.to_le_bytes());
    e.extend_from_slice(&(csize.min(MAX32) as u32).to_le_bytes());
    e.extend_from_slice(&(usize_.min(MAX32) as u32).to_le_bytes());
    e.extend_from_slice(&(name.len() as u16).to_le_bytes());
    e.extend_from_slice(&(extra.len() as u16).to_le_bytes());
    e.extend_from_slice(&[0u8; 10]); // comment length, disk, internal and external attributes
    e.extend_from_slice(&(offset.min(MAX32) as u32).to_le_bytes());
    e.extend_from_slice(name);
    e.extend_from_slice(&extra);
    e
}

fn end_records(count: u64, cd_size: u64, cd_at: u64) -> Vec<u8> {
    let mut tail = Vec::with_capacity(22);
    tail.extend_from_slice(&EOCD.to_le_bytes());
    tail.extend_from_slice(&[0u8; 4]);
    tail.extend_from_slice(&(count.min(MAX16) as u16).to_le_bytes());
    tail.extend_from_slice(&(count.min(MAX16) as u16).to_le_bytes());
    tail.extend_from_slice(&(cd_size.min(MAX32) as u32).to_le_bytes());
    tail.extend_from_slice(&(cd_at.min(MAX32) as u32).to_le_bytes());
    tail.extend_from_slice(&[0u8; 2]);
    if count < MAX16 && cd_size < MAX32 && cd_at < MAX32 {
        return tail;
    }
    let mut out = Vec::new();
    out.extend_from_slice(&ZIP64_END.to_le_bytes());
    out.extend_from_slice(&44u64.to_le_bytes());
    out.extend_from_slice(&45u16.to_le_bytes());
    out.extend_from_slice(&45u16.to_le_bytes());
    out.extend_from_slice(&[0u8; 8]);
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_at.to_le_bytes());
    out.extend_from_slice(&ZIP64_LOCATOR.to_le_bytes());
    out.extend_from_slice(&[0u8; 4]);
    out.extend_from_slice(&(cd_at + cd_size).to_le_bytes());
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(&tail);
    out
}

/// A date and time as a .zip keeps it (DOS, UTC fields).
pub fn dos_time(ms: Option<f64>) -> (u16, u16) {
    let ms = ms.filter(|m| m.is_finite()).unwrap_or(super::tz::utc_ms(2026, 1, 1, 0, 0, 0) as f64) as i64;
    let secs = ms.div_euclid(1000);
    let (y, mo, d) = super::tz::civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    let y = y.clamp(1980, 2107);
    (((rem / 3600) << 11 | (rem % 3600 / 60) << 5 | (rem % 60) >> 1) as u16, ((y - 1980) << 9 | mo << 5 | d) as u16)
}

pub enum Source {
    Data(Vec<u8>),
    /// a reader of a known size (it must give exactly that many bytes)
    Sized(u64, Box<dyn Read + Send>),
    /// made while it streams: its size is whatever it gives (Zip64 unless max_size says under 4 GiB)
    Stream(Option<u64>, Box<dyn FnMut(&mut dyn FnMut(&[u8]) -> io::Result<()>) -> io::Result<()> + Send>),
    /// made when its turn comes
    Make(Box<dyn FnOnce() -> Vec<u8> + Send>),
}

pub struct Entry {
    pub name: String,
    pub mtime: Option<f64>,
    pub source: Source,
}

struct Counter<W: Write> {
    w: W,
    n: u64,
}
impl<W: Write> Counter<W> {
    fn put(&mut self, b: &[u8]) -> io::Result<()> {
        self.w.write_all(b)?;
        self.n += b.len() as u64;
        Ok(())
    }
}

/// streamZip: the entries to `out`, one after the other.
pub fn stream_zip<W: Write>(out: W, entries: Vec<Entry>) -> io::Result<()> {
    let mut w = Counter { w: out, n: 0 };
    let mut central = Vec::new();
    let count = entries.len() as u64;
    for e in entries {
        let name = e.name.as_bytes().to_vec();
        let (time, date) = dos_time(e.mtime);
        let mut source = e.source;
        if let Source::Make(f) = source {
            source = Source::Data(f());
        }
        let (known, mut size) = match &source {
            Source::Data(d) => (true, d.len() as u64),
            Source::Sized(s, _) => (true, *s),
            Source::Stream(_, _) => (false, 0),
            Source::Make(_) => unreachable!(),
        };
        let zip64 = if known { size >= MAX32 } else { !matches!(&source, Source::Stream(Some(m), _) if *m < MAX32) };
        let at = w.n;
        let flags = 0x808u16;
        w.put(&local_header(&name, flags, 0, time, date, zip64))?;
        let mut crc = flate2::Crc::new();
        let mut got = 0u64;
        match source {
            Source::Data(d) => {
                crc.update(&d);
                got = d.len() as u64;
                w.put(&d)?;
            }
            Source::Sized(_, mut r) => {
                let mut buf = vec![0u8; 256 * 1024];
                loop {
                    let k = r.read(&mut buf)?;
                    if k == 0 {
                        break;
                    }
                    let k = (k as u64).min(size - got) as usize;
                    crc.update(&buf[..k]);
                    got += k as u64;
                    w.put(&buf[..k])?;
                    if got >= size {
                        break;
                    }
                }
            }
            Source::Stream(_, mut f) => {
                let mut sink = |b: &[u8]| -> io::Result<()> {
                    crc.update(b);
                    got += b.len() as u64;
                    if !zip64 && got >= MAX32 {
                        return Err(io::Error::other(format!("{} is larger than it was said to be.", e.name)));
                    }
                    w.put(b)
                };
                f(&mut sink)?;
                size = got;
            }
            Source::Make(_) => unreachable!(),
        }
        if got != size {
            return Err(io::Error::other(format!("{} changed while it was being sent.", e.name)));
        }
        let mut desc = Vec::with_capacity(24);
        desc.extend_from_slice(&DESCRIPTOR.to_le_bytes());
        desc.extend_from_slice(&crc.sum().to_le_bytes());
        if zip64 {
            desc.extend_from_slice(&size.to_le_bytes());
            desc.extend_from_slice(&size.to_le_bytes());
        } else {
            desc.extend_from_slice(&(size as u32).to_le_bytes());
            desc.extend_from_slice(&(size as u32).to_le_bytes());
        }
        w.put(&desc)?;
        central.extend_from_slice(&central_record(&name, flags, 0, time, date, crc.sum(), size, size, at));
    }
    let cd_at = w.n;
    w.put(&central)?;
    w.put(&end_records(count, central.len() as u64, cd_at))?;
    w.w.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_zip_unzip_reads() {
        let dir = std::env::temp_dir().join(format!("canzip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("t.zip");
        let f = std::fs::File::create(&file).unwrap();
        stream_zip(
            f,
            vec![
                Entry { name: "a/b.txt".into(), mtime: Some(1_700_000_000_000.0), source: Source::Data(b"hello".to_vec()) },
                Entry { name: "c.log".into(), mtime: None, source: Source::Stream(Some(100), Box::new(|put| put(b"one\ntwo\n"))) },
                Entry { name: "d.bin".into(), mtime: None, source: Source::Sized(3, Box::new(std::io::Cursor::new(vec![1, 2, 3]))) },
            ],
        )
        .unwrap();
        if let Ok(o) = std::process::Command::new("unzip").arg("-t").arg(&file).output() {
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stdout));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
