//! A clip's full telemetry: every frame's records with their times, the way
//! the dashboard reads them (server/telemetry.js readRecords with Studio's
//! parser, src/renderer/scripts/data/dashcam-mp4.js, ported here check for
//! check). The file is read a few KB at a time: the index (moov) and, of
//! each frame, the records ahead of the picture; a picture's bytes are not
//! read. It is the speed index's fallback when the quick read
//! (sei.rs) gives up, as speedIndex.js speedsFor does.
//!
//! The footage is only read: the file is opened read-only.

use crate::sei::{hevc_sei_payload, js_round, speed_of_bytes, tesla_payload};
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::os::unix::fs::FileExt;
use std::path::Path;

const PAGE: u64 = 4096;
const MAX_PAGES: usize = 256;
const SAFE: i64 = 9_007_199_254_740_991;

/// Why a read gave no records.
#[derive(Debug)]
pub enum Fail {
    /// not a Tesla clip, or a damaged one (telemetry.js: a note, no frames)
    Parse(String),
    /// the file changed (shorter than it was) while it was read, or could not be opened
    Io(String),
}

type R<T> = std::result::Result<T, Fail>;

fn bad<T>(msg: impl Into<String>) -> R<T> {
    Err(Fail::Parse(msg.into()))
}

/// telemetry.js FileBytes: a file read a page at a time, the parts of ArrayBuffer and DataView the parser uses.
struct Bytes {
    file: File,
    len: i64,
    pages: HashMap<u64, Vec<u8>>,
    order: VecDeque<u64>,
    skip: bool,
}

impl Bytes {
    fn read(&self, into: &mut [u8], at: u64) -> R<()> {
        self.file.read_exact_at(into, at).map_err(|_| Fail::Io("The clip changed while it was read".into()))
    }

    fn page(&mut self, n: u64) -> R<&[u8]> {
        if self.pages.contains_key(&n) {
            self.order.retain(|&x| x != n);
        } else {
            let len = PAGE.min(self.len as u64 - n * PAGE) as usize;
            let mut page = vec![0; len];
            self.read(&mut page, n * PAGE)?;
            if self.pages.len() >= MAX_PAGES {
                if let Some(old) = self.order.pop_front() {
                    self.pages.remove(&old);
                }
            }
            self.pages.insert(n, page);
        }
        self.order.push_back(n);
        Ok(&self.pages[&n])
    }

    fn u8(&mut self, pos: i64) -> R<u8> {
        if !(pos >= 0 && pos < self.len) {
            return bad("Offset is outside the bounds of the DataView");
        }
        let p = pos as u64;
        Ok(self.page(p / PAGE)?[(p % PAGE) as usize])
    }

    fn u16(&mut self, pos: i64) -> R<u32> {
        if !(pos >= 0 && pos + 2 <= self.len) {
            return bad("Offset is outside the bounds of the DataView");
        }
        Ok(self.u8(pos)? as u32 * 256 + self.u8(pos + 1)? as u32)
    }

    fn u32(&mut self, pos: i64) -> R<u32> {
        if !(pos >= 0 && pos + 4 <= self.len) {
            return bad("Offset is outside the bounds of the DataView");
        }
        Ok(self.u16(pos)? * 65536 + self.u16(pos + 2)?)
    }

    fn i32(&mut self, pos: i64) -> R<i32> {
        Ok(self.u32(pos)? as i32)
    }

    /// A copy of [start, end) (empty while skip is set).
    fn slice(&mut self, start: i64, end: i64) -> R<Vec<u8>> {
        let start = start.clamp(0, self.len);
        let end = end.clamp(start, self.len);
        if self.skip {
            return Ok(Vec::new());
        }
        let mut out = vec![0; (end - start) as usize];
        if out.len() as u64 > 16 * PAGE {
            self.read(&mut out, start as u64)?;
            return Ok(out);
        }
        let mut at = start as u64;
        while at < end as u64 {
            let n = at / PAGE;
            let page = self.page(n)?;
            let from = (at - n * PAGE) as usize;
            let len = (page.len() - from).min((end as u64 - at) as usize);
            let dst = (at - start as u64) as usize;
            out[dst..dst + len].copy_from_slice(&page[from..from + len]);
            at += len as u64;
        }
        Ok(out)
    }
}

#[derive(Clone, Copy)]
struct BoxAt {
    typ: [u8; 4],
    start: i64,
    end: i64,
    size: i64,
}

#[derive(Clone, Copy)]
struct Sample {
    offset: i64,
    size: i64,
    timestamp: f64,
}

/// A NAL record: whole when the parser looks past its first two bytes, else only those and its length.
struct Nal {
    bytes: Vec<u8>,
    b0: u8,
    b1: Option<u8>,
    len: usize,
}

impl Nal {
    fn at(&self, i: usize) -> Option<u8> {
        match i {
            0 => Some(self.b0),
            1 => self.b1,
            _ => self.bytes.get(i).copied(),
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Entry {
    Avc1,
    Hvc1,
    Av01,
}

struct Config {
    entry: Entry,
    length_size: usize,
    durations: Vec<f64>,
}

struct Parser {
    b: Bytes,
    mdats: Vec<BoxAt>,
    samples: Vec<Sample>,
    other: Vec<Sample>,
    config: Option<Config>,
}

fn require(start: i64, size: i64, end: i64, label: &str) -> R<()> {
    if start.unsigned_abs() > SAFE as u64 || size.unsigned_abs() > SAFE as u64 || start < 0 || size < 0 || start > end || size > end - start {
        return bad(format!("Truncated or invalid {label}: exceeds containing range"));
    }
    Ok(())
}

fn name(t: &[u8; 4]) -> String {
    t.iter().map(|&c| c as char).collect()
}

impl Parser {
    fn read_u64(&mut self, pos: i64) -> R<i64> {
        let v = self.b.u32(pos)? as f64 * 4_294_967_296.0 + self.b.u32(pos + 4)? as f64;
        if v > SAFE as f64 {
            return bad("Unsupported MP4 size or offset exceeds safe integer range");
        }
        Ok(v as i64)
    }

    fn boxes(&mut self, start: i64, end: i64) -> R<Vec<BoxAt>> {
        require(start, end - start, self.b.len, "box range")?;
        let mut out = Vec::new();
        let mut pos = start;
        while pos < end {
            require(pos, 8, end, "box header")?;
            let mut size = self.b.u32(pos)? as i64;
            let mut typ = [0u8; 4];
            for (i, t) in typ.iter_mut().enumerate() {
                *t = self.b.u8(pos + 4 + i as i64)?;
            }
            let header = if size == 1 { 16 } else { 8 };
            require(pos, header, end, &format!("{} header", name(&typ)))?;
            if size == 1 {
                size = self.read_u64(pos + 8)?;
            } else if size == 0 {
                size = end - pos;
            }
            if size < header {
                return bad(format!("Invalid {} box size", name(&typ)));
            }
            require(pos, size, end, &format!("{} box", name(&typ)))?;
            out.push(BoxAt { typ, start: pos + header, end: pos + size, size: size - header });
            pos += size;
        }
        Ok(out)
    }

    fn find(&mut self, start: i64, end: i64, typ: &[u8; 4]) -> R<BoxAt> {
        match self.boxes(start, end)?.into_iter().find(|b| &b.typ == typ) {
            Some(b) => Ok(b),
            None => bad(format!("Box \"{}\" not found", name(typ))),
        }
    }

    fn in_box(&mut self, b: BoxAt, typ: &[u8; 4]) -> R<BoxAt> {
        self.find(b.start, b.end, typ)
    }

    fn table_entries(&mut self, b: BoxAt, stride: i64, header: i64) -> R<i64> {
        require(b.start, header, b.end, &format!("{} table", name(&b.typ)))?;
        let count = self.b.u32(b.start + header - 4)? as i64;
        require(b.start + header, count * stride, b.end, &format!("{} entries", name(&b.typ)))?;
        Ok(count)
    }

    fn config(&mut self) -> R<()> {
        if self.config.is_some() {
            return Ok(());
        }
        let len = self.b.len;
        let top = self.boxes(0, len)?;
        let moov = self.find(0, len, b"moov")?;
        self.mdats = top.into_iter().filter(|b| &b.typ == b"mdat").collect();
        let tracks: Vec<BoxAt> = self.boxes(moov.start, moov.end)?.into_iter().filter(|b| &b.typ == b"trak").collect();
        let mut media = Vec::new();
        for t in tracks {
            media.push(self.in_box(t, b"mdia")?);
        }
        let mut mdia = None;
        for (i, m) in media.iter().enumerate() {
            let hdlr = self.in_box(*m, b"hdlr")?;
            require(hdlr.start, 12, hdlr.end, "hdlr")?;
            let mut h = [0u8; 4];
            for (k, x) in h.iter_mut().enumerate() {
                *x = self.b.u8(hdlr.start + 8 + k as i64)?;
            }
            if &h == b"vide" {
                mdia = Some(i);
                break;
            }
        }
        let Some(vi) = mdia else { return bad("Unsupported MP4: no video track") };
        let mdia = media[vi];
        let minf = self.in_box(mdia, b"minf")?;
        let stbl = self.in_box(minf, b"stbl")?;
        let stsd = self.in_box(stbl, b"stsd")?;
        require(stsd.start, 8, stsd.end, "stsd")?;
        let entries = self.boxes(stsd.start + 8, stsd.end)?;
        if self.b.u32(stsd.start + 4)? != 1 || entries.len() != 1 {
            return bad("Unsupported video sample descriptions");
        }
        let entry = entries[0];
        let (kind, cfg_name) = match &entry.typ {
            b"avc1" => (Entry::Avc1, b"avcC"),
            b"hvc1" => (Entry::Hvc1, b"hvcC"),
            b"av01" => (Entry::Av01, b"av1C"),
            t => return bad(format!("Unsupported video sample entry {}", name(t))),
        };
        require(entry.start, 78, entry.end, &format!("{} sample entry", name(&entry.typ)))?;
        let desc = self.find(entry.start + 78, entry.end, cfg_name)?;
        let o = desc.start;
        require(o, match kind { Entry::Avc1 => 7, Entry::Hvc1 => 23, Entry::Av01 => 4 }, desc.end, &name(cfg_name))?;
        if self.b.u8(o)? != if kind == Entry::Av01 { 0x81 } else { 1 } {
            return bad(format!("Unsupported {} version", name(cfg_name)));
        }
        let mut length_size = 4;
        if kind == Entry::Avc1 {
            length_size = (self.b.u8(o + 4)? & 3) as usize + 1;
            let mut p = o + 6;
            let sets = |me: &mut Parser, count: u8, p: &mut i64| -> R<()> {
                for _ in 0..count {
                    require(*p, 2, desc.end, "AVC parameter set length")?;
                    let l = me.b.u16(*p)? as i64;
                    *p += 2;
                    require(*p, l, desc.end, "AVC parameter set")?;
                    *p += l;
                }
                Ok(())
            };
            let n = self.b.u8(o + 5)? & 31;
            sets(self, n, &mut p)?;
            require(p, 1, desc.end, "AVC PPS count")?;
            let n = self.b.u8(p)?;
            p += 1;
            sets(self, n, &mut p)?;
        } else if kind == Entry::Hvc1 {
            length_size = (self.b.u8(o + 21)? & 3) as usize + 1;
        }
        let mdhd = self.in_box(mdia, b"mdhd")?;
        require(mdhd.start, 1, mdhd.end, "mdhd")?;
        let version = self.b.u8(mdhd.start)?;
        if version > 1 {
            return bad("Unsupported mdhd version");
        }
        let ts_at = mdhd.start + if version == 1 { 20 } else { 12 };
        require(ts_at, 4, mdhd.end, "mdhd timescale")?;
        let timescale = self.b.u32(ts_at)? as f64;
        if timescale == 0.0 {
            return bad("Invalid media timescale");
        }
        self.samples = self.sample_index(stbl)?;
        if kind == Entry::Av01 {
            let mut other = Vec::new();
            for (i, m) in media.iter().enumerate() {
                if i == vi {
                    continue;
                }
                let minf = self.in_box(*m, b"minf")?;
                let st = self.in_box(minf, b"stbl")?;
                other.extend(self.sample_index(st)?);
            }
            self.other = other;
        }
        let n = self.samples.len();
        let stts = self.in_box(stbl, b"stts")?;
        let durations = self.timing(stts, n, false)?;
        let ctts = self.boxes(stbl.start, stbl.end)?.into_iter().find(|b| &b.typ == b"ctts");
        let offsets = match ctts {
            Some(c) => Some(self.timing(c, n, true)?),
            None => None,
        };
        let mut ticks: f64 = 0.0;
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            self.samples[i].timestamp = (ticks + offsets.as_ref().map_or(0.0, |o| o[i])) * 1000.0 / timescale;
            ticks += durations[i];
            if !(ticks.fract() == 0.0 && ticks.abs() <= SAFE as f64) {
                return bad("Invalid sample timing overflow");
            }
            out.push(durations[i] * 1000.0 / timescale);
        }
        self.config = Some(Config { entry: kind, length_size, durations: out });
        Ok(())
    }

    fn sample_index(&mut self, stbl: BoxAt) -> R<Vec<Sample>> {
        let tables = self.boxes(stbl.start, stbl.end)?;
        let sizes = self.in_box(stbl, b"stsz")?;
        require(sizes.start, 12, sizes.end, "stsz")?;
        let fixed = self.b.u32(sizes.start + 4)? as i64;
        let count = self.b.u32(sizes.start + 8)? as i64;
        let media_bytes: i64 = self.mdats.iter().map(|b| b.size).sum();
        if count as f64 > media_bytes as f64 / (if fixed == 0 { 1 } else { fixed }) as f64 {
            return bad("Invalid sample count exceeds media bytes");
        }
        if fixed == 0 {
            self.table_entries(sizes, 4, 12)?;
        }
        let offsets: Vec<BoxAt> = tables.iter().filter(|b| &b.typ == b"stco" || &b.typ == b"co64").copied().collect();
        if offsets.len() != 1 {
            return bad("Unsupported sample chunk offset tables");
        }
        let table = offsets[0];
        let stride = if &table.typ == b"co64" { 8 } else { 4 };
        let chunks = self.table_entries(table, stride, 8)?;
        let stsc = self.in_box(stbl, b"stsc")?;
        let entries = self.table_entries(stsc, 12, 8)?;
        let mut runs: Vec<(i64, i64)> = Vec::new();
        for i in 0..entries {
            let p = stsc.start + 8 + i * 12;
            let first = self.b.u32(p)? as i64;
            let samples = self.b.u32(p + 4)? as i64;
            if first == 0
                || first > chunks
                || (i == 0 && first != 1)
                || (i > 0 && first <= runs[i as usize - 1].0)
                || samples == 0
                || samples > count
                || self.b.u32(p + 8)? != 1
            {
                return bad("Invalid or unsupported sample chunk mapping");
            }
            runs.push((first, samples));
        }
        if chunks > 0 && runs.is_empty() {
            return bad("Invalid empty sample chunk mapping");
        }
        let mut out: Vec<Sample> = Vec::new();
        let mut run = 0;
        for chunk in 1..=chunks {
            if run + 1 < runs.len() && chunk >= runs[run + 1].0 {
                run += 1;
            }
            let p = table.start + 8 + (chunk - 1) * stride;
            let mut offset = if stride == 8 { self.read_u64(p)? } else { self.b.u32(p)? as i64 };
            if runs[run].1 > count - out.len() as i64 {
                return bad("Invalid chunk sample count");
            }
            for _ in 0..runs[run].1 {
                let size = if fixed != 0 { fixed } else { self.b.u32(sizes.start + 12 + out.len() as i64 * 4)? as i64 };
                if size == 0 || !self.mdats.iter().any(|b| offset >= b.start && offset <= b.end && size <= b.end - offset) {
                    return bad("Invalid sample extent outside mdat");
                }
                out.push(Sample { offset, size, timestamp: 0.0 });
                offset += size;
            }
        }
        if out.len() as i64 != count {
            return bad("Invalid sample count does not match chunks");
        }
        let mut ordered: Vec<(i64, i64)> = out.iter().map(|s| (s.offset, s.size)).collect();
        ordered.sort_by_key(|s| s.0);
        if ordered.windows(2).any(|w| w[1].0 < w[0].0 + w[0].1) {
            return bad("Invalid overlapping samples");
        }
        Ok(out)
    }

    fn timing(&mut self, b: BoxAt, n: usize, ctts: bool) -> R<Vec<f64>> {
        let count = self.table_entries(b, 8, 8)?;
        let version = self.b.u8(b.start)?;
        if version > if ctts { 1 } else { 0 } {
            return bad("Unsupported sample timing version");
        }
        let mut values = Vec::with_capacity(n);
        for i in 0..count {
            let pos = b.start + 8 + i * 8;
            let repeat = self.b.u32(pos)? as usize;
            let value = if version == 1 { self.b.i32(pos + 4)? as f64 } else { self.b.u32(pos + 4)? as f64 };
            if repeat == 0 || repeat > n - values.len() {
                return bad("Invalid sample timing count");
            }
            values.extend(std::iter::repeat(value).take(repeat));
        }
        if values.len() != n {
            return bad("Invalid sample timing count");
        }
        Ok(values)
    }

    /// telemetry.js FileRecordReader.records: a picture's bytes are not read.
    fn records(&mut self, start: i64, end: i64, length_size: usize) -> R<Vec<Nal>> {
        let entry = self.config.as_ref().map(|c| c.entry);
        let mut out = Vec::new();
        let mut pos = start;
        while pos < end {
            require(pos, length_size as i64, end, "NAL record length")?;
            let mut len: i64 = 0;
            for _ in 0..length_size {
                len = len * 256 + self.b.u8(pos)? as i64;
                pos += 1;
            }
            if len == 0 {
                return bad("Invalid zero-length NAL record");
            }
            require(pos, len, end, "NAL record")?;
            let b0 = self.b.u8(pos)?;
            let b1 = if len > 1 { Some(self.b.u8(pos + 1)?) } else { None };
            let whole = len <= 3
                || match entry {
                    Some(Entry::Avc1) => matches!(b0 & 31, 6..=8),
                    Some(Entry::Hvc1) => (b0 == 0x66 && b1 == Some(0x01)) || matches!((b0 >> 1) & 63, 39 | 40),
                    Some(Entry::Av01) => b0 == 6 && b1 == Some(5),
                    None => true,
                };
            let bytes = if whole { self.b.slice(pos, pos + len)? } else { Vec::new() };
            out.push(Nal { bytes, b0, b1, len: len as usize });
            pos += len;
        }
        Ok(out)
    }

    fn av1_groups(&mut self) -> R<Vec<Vec<Vec<u8>>>> {
        let carrier = match self.mdats.first() {
            Some(c) if self.mdats.len() >= 2 => *c,
            _ => return bad("Unsupported AV1 telemetry carrier: missing first mdat"),
        };
        if self.samples.iter().chain(self.other.iter()).any(|s| s.offset < carrier.end) {
            return bad("Invalid AV1 sample references telemetry carrier");
        }
        let mut groups = Vec::new();
        let mut pending = Vec::new();
        let mut pending_records = false;
        for nal in self.records(carrier.start, carrier.end, 4)? {
            if is_marker(&nal) {
                if groups.len() >= self.samples.len() {
                    return bad("Invalid AV1 carrier marker count");
                }
                groups.push(std::mem::take(&mut pending));
                pending_records = false;
            } else {
                let payload = if nal.b0 == 6 && nal.b1 == Some(5) { tesla_payload(&nal.bytes) } else { None };
                let Some(p) = payload else { return bad("Invalid AV1 carrier record") };
                pending.push(p);
                pending_records = true;
            }
        }
        if pending_records || groups.len() != self.samples.len() {
            return bad("Invalid AV1 carrier marker count");
        }
        // (the frames' own bytes are not read once the records are)
        self.b.skip = true;
        Ok(groups)
    }

    /// Every frame's records, [timestamp ms, record] (readFrames, then recordsOf per frame).
    fn frames(&mut self) -> R<Vec<(f64, Vec<u8>)>> {
        self.config()?;
        let (entry, length_size) = {
            let c = self.config.as_ref().unwrap();
            (c.entry, c.length_size)
        };
        let av1 = if entry == Entry::Av01 { Some(self.av1_groups()?) } else { None };
        let mut out = Vec::new();
        let mut markers = Vec::new();
        let mut compatibility = false;
        let samples = self.samples.clone();
        for (index, s) in samples.iter().enumerate() {
            let mut seis: Vec<Vec<u8>> = av1.as_ref().and_then(|g| g.get(index)).cloned().unwrap_or_default();
            let mut picture = av1.is_some();
            let mut count = 0;
            if av1.is_none() {
                for nal in self.records(s.offset, s.offset + s.size, length_size)? {
                    if entry == Entry::Avc1 {
                        match nal.b0 & 31 {
                            6 => seis.extend(tesla_payload(&nal.bytes)),
                            1 | 5 => picture = true,
                            _ => {}
                        }
                    } else {
                        if nal.len < 2 {
                            return bad("Invalid HEVC NAL record header");
                        }
                        let typ = (nal.b0 >> 1) & 63;
                        if is_marker(&nal) {
                            count += 1;
                        } else if nal.b0 == 0x61 && nal.b1 == Some(0x01) {
                            return bad("Invalid HEVC carrier picture marker");
                        } else if nal.b0 == 0x66 && nal.b1 == Some(0x01) {
                            let mut original = vec![6, 5];
                            original.extend_from_slice(&nal.bytes[2..]);
                            let Some(p) = tesla_payload(&original) else { return bad("Invalid HEVC compatibility record") };
                            seis.push(p);
                            compatibility = true;
                        } else if let Some(p) = hevc_sei_payload(&nal.bytes) {
                            if !seis.contains(&p) {
                                seis.push(p);
                            }
                        } else if typ <= 31 {
                            picture = true;
                        }
                    }
                }
            }
            if !picture {
                return bad("Invalid video sample: missing picture");
            }
            markers.push(count);
            let duration = self.config.as_ref().unwrap().durations[index];
            let mut seis = seis.into_iter();
            if let Some(first) = seis.next() {
                out.push((s.timestamp, first));
                // (recordsOf: a record carried from Tesla's closing sample, one frame later; duration || 0)
                let later = s.timestamp + if duration.is_nan() { 0.0 } else { duration };
                out.extend(seis.map(|m| (later, m)));
            }
        }
        self.b.skip = false;
        if entry == Entry::Hvc1 && (compatibility || markers.iter().any(|&m| m > 0)) && markers.iter().any(|&m| m != 1) {
            return bad("Invalid HEVC carrier picture marker count");
        }
        Ok(out)
    }
}

fn is_marker(nal: &Nal) -> bool {
    nal.len == 3 && nal.at(0) == Some(0x61) && nal.at(1) == Some(0x01) && nal.at(2) == Some(0x80)
}

/// A clip's telemetry records, [timestamp ms, record bytes], as telemetry.js readRecords
/// lists them (`size`: the size the scan found). Ok(empty) for a clip the parser cannot
/// read (a note in Node), Err(Fail::Io) when the file cannot be read as it was.
pub fn read_records(path: &Path, size: u64) -> R<Vec<(f64, Vec<u8>)>> {
    let file = File::open(path).map_err(|e| Fail::Io(e.to_string()))?;
    let mut p = Parser { b: Bytes { file, len: size as i64, pages: HashMap::new(), order: VecDeque::new(), skip: false }, mdats: Vec::new(), samples: Vec::new(), other: Vec::new(), config: None };
    let mut frames = match p.frames() {
        Ok(f) => f,
        Err(Fail::Io(e)) => return Err(Fail::Io(e)),
        Err(Fail::Parse(_)) => Vec::new(),
    };
    if p.b.file.metadata().map_or(true, |m| m.len() < size) {
        return Err(Fail::Io("The clip changed while it was read".into()));
    }
    // in the order shown (frames come in file order; with B-frames that differs)
    frames.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    Ok(frames)
}

/// One speed a second (the average, m/s, rounded to 0.01; None for a second without one)
/// from a clip's records, or None for none at all (telemetry.js speedsOf).
pub fn speeds_of(frames: &[(f64, Vec<u8>)]) -> Option<Vec<Option<f64>>> {
    let t0 = frames.first()?.0;
    let mut sum: Vec<Option<f64>> = Vec::new();
    let mut n: Vec<u32> = Vec::new();
    for (t, rec) in frames {
        let Some(v) = speed_of_bytes(rec).filter(|v| v.is_finite()) else { continue };
        let i = ((t - t0) / 1000.0).floor().max(0.0);
        if i > 7200.0 {
            break;
        }
        let i = i as usize;
        if sum.len() <= i {
            sum.resize(i + 1, None);
            n.resize(i + 1, 0);
        }
        sum[i] = Some(sum[i].unwrap_or(0.0) + v);
        n[i] += 1;
    }
    let out: Vec<Option<f64>> = sum.iter().zip(&n).map(|(s, &k)| if k > 0 { Some(js_round(s.unwrap() / k as f64 * 100.0) / 100.0) } else { None }).collect();
    (!out.is_empty()).then_some(out)
}
