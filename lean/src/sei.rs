//! A clip's telemetry, one record a second, without reading the whole clip
//! (a port of server/speedReader.js): the moov gives each frame's offset,
//! and Tesla writes a frame's telemetry record (an H.264 SEI, payload type 5,
//! with the 42..42 69 marker) ahead of its picture, so only the first few KB
//! of one frame a second are read. Converted clips keep the records: H.265
//! in a compatibility NAL (66 01 ...) in each frame, AV1 all together in a
//! first mdat (each frame's ended by a 61 01 80 picture marker).

use crate::mp4::{self, err, read_at, Result};
use serde::Serialize;
use std::fs::File;
use std::path::Path;

const HEAD: u32 = 4096;
const MAX_CARRIER: u64 = 16 * 1024 * 1024;

/// Tesla's protobuf inside an SEI NAL (06 05 size 42.. 69 payload 80), or None.
pub fn tesla_payload(nal: &[u8]) -> Option<Vec<u8>> {
    if nal.len() < 6 || (nal[0] & 31) != 6 || nal[1] != 5 || nal[nal.len() - 1] != 0x80 {
        return None;
    }
    // strip emulation-prevention bytes (00 00 03 -> 00 00)
    let mut rbsp = Vec::with_capacity(nal.len());
    let mut zeros = 0;
    for &b in &nal[1..] {
        if zeros >= 2 && b == 3 {
            zeros = 0;
            continue;
        }
        rbsp.push(b);
        zeros = if b == 0 { zeros + 1 } else { 0 };
    }
    let mut i = 1;
    let mut size = 0usize;
    while i < rbsp.len() && rbsp[i] == 255 {
        size += 255;
        i += 1;
    }
    if i >= rbsp.len() {
        return None;
    }
    size += rbsp[i] as usize;
    i += 1;
    if size as isize != rbsp.len() as isize - i as isize - 1 {
        return None;
    }
    let prefix = i;
    while i < rbsp.len() && rbsp[i] == 0x42 {
        i += 1;
    }
    if i == prefix || rbsp.get(i) != Some(&0x69) {
        return None;
    }
    i += 1;
    if i as isize >= rbsp.len() as isize - 1 {
        return None;
    }
    Some(rbsp[i..rbsp.len() - 1].to_vec())
}

/// Tesla's record in a standard H.265 SEI NAL (prefix 39, suffix 40), as archive converters
/// carry it: the first user-data message (type 5) with tesla_payload's 0x42..0x69 marker.
pub fn hevc_sei_payload(nal: &[u8]) -> Option<Vec<u8>> {
    if nal.len() < 3 || !matches!((nal[0] >> 1) & 63, 39 | 40) || nal[nal.len() - 1] != 0x80 {
        return None;
    }
    let mut rbsp = Vec::with_capacity(nal.len());
    let mut zeros = 0;
    for &b in &nal[2..] {
        if zeros >= 2 && b == 3 {
            zeros = 0;
            continue;
        }
        rbsp.push(b);
        zeros = if b == 0 { zeros + 1 } else { 0 };
    }
    let last = rbsp.len() - 1;
    let mut i = 0;
    let coded = |i: &mut usize| -> Option<usize> {
        let mut n = 0;
        while *rbsp.get(*i)? == 255 {
            n += 255;
            *i += 1;
        }
        n += *rbsp.get(*i)? as usize;
        *i += 1;
        Some(n)
    };
    while i < last {
        let typ = coded(&mut i)?;
        let size = coded(&mut i)?;
        let body = rbsp.get(i..i + size).filter(|_| i + size <= last)?;
        i += size;
        let marks = body.iter().take_while(|&&b| b == 0x42).count();
        if typ == 5 && marks > 0 && body.get(marks) == Some(&0x69) && body.len() > marks + 1 {
            return Some(body[marks + 1..].to_vec());
        }
    }
    None
}

/// The length-prefixed NAL records of buf; `cut` when one runs past the end.
fn nals(buf: &[u8], length_size: usize) -> Result<(Vec<&[u8]>, bool)> {
    let mut out = Vec::new();
    let mut p = 0usize;
    while p + length_size <= buf.len() {
        let mut len = 0usize;
        for k in 0..length_size {
            len = len * 256 + buf[p + k] as usize;
        }
        p += length_size;
        if len == 0 {
            return err("zero-length NAL record");
        }
        if p + len > buf.len() {
            return Ok((out, true));
        }
        out.push(&buf[p..p + len]);
        p += len;
    }
    Ok((out, false))
}

/// What a frame's NALs hold: a record, the picture first (no record), or neither yet.
enum Found {
    Record(Vec<u8>),
    PictureFirst,
    Nothing,
}

fn record_in(list: &[&[u8]], codec: &[u8; 4]) -> Found {
    for nal in list {
        if codec == b"avc1" {
            let t = nal[0] & 31;
            if t == 6 {
                if let Some(p) = tesla_payload(nal) {
                    return Found::Record(p);
                }
            } else if t == 1 || t == 5 {
                return Found::PictureFirst;
            }
        } else if nal.len() >= 2 && nal[0] == 0x66 && nal[1] == 0x01 {
            let mut h264 = vec![6u8, 5];
            h264.extend_from_slice(&nal[2..]);
            if let Some(p) = tesla_payload(&h264) {
                return Found::Record(p);
            }
        } else if let Some(p) = hevc_sei_payload(nal) {
            return Found::Record(p);
        }
    }
    Found::Nothing
}

fn is_marker(nal: &[u8]) -> bool {
    nal == [0x61, 0x01, 0x80]
}

/// The record (protobuf bytes) of the first frame of each second; None for a
/// second without one. Err for anything unexpected (the caller falls back).
pub fn read_records(path: &Path) -> Result<Vec<Option<Vec<u8>>>> {
    let file = File::open(path).map_err(|e| mp4::Mp4Error(e.to_string()))?;
    let tree = mp4::open_tree(&file)?;
    let (track, _) = mp4::video_track(&tree)?;
    let samples = mp4::sample_index(&tree, track)?;
    if samples.is_empty() {
        return Ok(Vec::new());
    }
    let scale = mp4::timescale(&tree, track)? as u64;
    let Some(stsd) = track.first(b"stsd") else { return err("No stsd") };
    let desc = tree.payload(stsd)?;
    let codec: [u8; 4] = match desc.get(12..16) {
        Some(c) => c.try_into().unwrap(),
        None => return err("Unsupported codec"),
    };
    let find = |needle: &[u8]| desc.windows(4).position(|w| w == needle);
    let mut length_size = 4usize;
    if &codec == b"avc1" && find(b"avcC").is_some() {
        length_size = (desc.get(find(b"avcC").unwrap() + 8).copied().unwrap_or(0) & 3) as usize + 1;
    } else if &codec != b"avc1" && (&codec == b"hvc1" || &codec == b"hev1") && find(b"hvcC").is_some() {
        length_size = (desc.get(find(b"hvcC").unwrap() + 25).copied().unwrap_or(0) & 3) as usize + 1;
    } else if &codec != b"av01" {
        return err(format!("Unsupported codec {}", String::from_utf8_lossy(&codec)));
    }

    // the first frame of each second
    let mut picks: Vec<Option<&mp4::Sample>> = Vec::new();
    for s in &samples {
        let sec = (s.dts / scale) as usize;
        if sec > 7200 {
            break;
        }
        if picks.len() <= sec {
            picks.resize(sec + 1, None);
        }
        if picks[sec].is_none() {
            picks[sec] = Some(s);
        }
    }

    let mut carrier: Option<Vec<Option<Vec<u8>>>> = None;
    if &codec == b"av01" {
        let mdats: Vec<_> = tree.top.iter().filter(|b| &b.typ == b"mdat").collect();
        if mdats.len() < 2 || mdats[0].size > MAX_CARRIER {
            return err("No AV1 telemetry carrier");
        }
        let buf = read_at(&file, mdats[0].start + mdats[0].header, (mdats[0].size - mdats[0].header) as usize)?;
        let mut groups = Vec::new();
        let mut pending: Option<Vec<u8>> = None;
        for nal in nals(&buf, 4)?.0 {
            if is_marker(nal) {
                groups.push(pending.take());
            } else if let Some(p) = tesla_payload(nal) {
                pending = Some(p);
            }
        }
        if groups.len() != samples.len() {
            return err("AV1 carrier does not match the frames");
        }
        carrier = Some(groups);
    }

    let mut out = Vec::with_capacity(picks.len());
    for pick in picks {
        let Some(s) = pick else {
            out.push(None);
            continue;
        };
        let rec = if let Some(c) = &carrier {
            c[s.index as usize].clone()
        } else {
            let head = read_at(&file, s.offset, s.size.min(HEAD) as usize)?;
            let (list, cut) = nals(&head, length_size)?;
            match record_in(&list, &codec) {
                Found::Record(p) => Some(p),
                Found::PictureFirst => None,
                Found::Nothing if cut => {
                    let whole = read_at(&file, s.offset, s.size as usize)?;
                    match record_in(&nals(&whole, length_size)?.0, &codec) {
                        Found::Record(p) => Some(p),
                        _ => None,
                    }
                }
                Found::Nothing => None,
            }
        };
        out.push(rec);
    }
    Ok(out)
}

/// A protobuf varint read the way speedReader.js does it: in doubles.
struct Reader<'a> {
    buf: &'a [u8],
    p: f64,
}

impl Reader<'_> {
    fn len(&self) -> f64 {
        self.buf.len() as f64
    }
    fn vint(&mut self) -> Option<f64> {
        let mut n = 0f64;
        let mut mul = 1f64;
        loop {
            if self.p >= self.len() {
                return None;
            }
            let b = self.buf[self.p as usize];
            self.p += 1.0;
            n += (b & 0x7f) as f64 * mul;
            if b & 0x80 == 0 {
                return Some(n);
            }
            mul *= 128.0;
            if mul > 2f64.powi(63) {
                return None;
            }
        }
    }
    fn f32(&self) -> f64 {
        let at = self.p as usize;
        f32::from_le_bytes(self.buf[at..at + 4].try_into().unwrap()) as f64
    }
    fn f64(&self) -> f64 {
        let at = self.p as usize;
        f64::from_le_bytes(self.buf[at..at + 8].try_into().unwrap())
    }
}

/// The speed (field 4, float, m/s) in a record, or None (speedReader.js speedOfBytes).
pub fn speed_of_bytes(buf: &[u8]) -> Option<f64> {
    let mut r = Reader { buf, p: 0.0 };
    while r.p < r.len() {
        let tag = r.vint()?;
        let field = (tag / 8.0).floor();
        let typ = tag % 8.0;
        if typ == 5.0 {
            if r.p + 4.0 > r.len() {
                return None;
            }
            if field == 4.0 {
                return Some(r.f32());
            }
            r.p += 4.0;
        } else if typ == 0.0 {
            r.vint()?;
        } else if typ == 1.0 {
            r.p += 8.0;
        } else if typ == 2.0 {
            let n = r.vint()?;
            r.p += n;
        } else {
            return None;
        }
    }
    None
}

/// The fields the indexes use from a record (speedReader.js sampleOfBytes).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, serde::Deserialize)]
pub struct Sample {
    pub v: Option<f64>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub ax: Option<f64>,
    pub ay: Option<f64>,
}

pub fn sample_of_bytes(buf: &[u8]) -> Sample {
    let mut out = Sample::default();
    let mut r = Reader { buf, p: 0.0 };
    // (a short record: what was read)
    let _ = (|| -> Option<()> {
        while r.p < r.len() {
            let tag = r.vint()?;
            let field = (tag / 8.0).floor();
            let typ = tag % 8.0;
            if typ == 5.0 {
                if r.p + 4.0 > r.len() {
                    break;
                }
                if field == 4.0 {
                    out.v = Some(r.f32());
                }
                r.p += 4.0;
            } else if typ == 1.0 {
                if r.p + 8.0 > r.len() {
                    break;
                }
                let d = r.f64();
                match field as i64 {
                    11 => out.lat = Some(d),
                    12 => out.lon = Some(d),
                    14 => out.ax = Some(d),
                    15 => out.ay = Some(d),
                    _ => {}
                }
                r.p += 8.0;
            } else if typ == 0.0 {
                r.vint()?;
            } else if typ == 2.0 {
                let n = r.vint()?;
                r.p += n;
            } else {
                break;
            }
        }
        Some(())
    })();
    for x in [&mut out.v, &mut out.lat, &mut out.lon, &mut out.ax, &mut out.ay] {
        if x.is_some_and(|v| !v.is_finite()) {
            *x = None;
        }
    }
    out
}

/// JavaScript's Math.round: the nearest integer, halves toward +infinity.
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

pub fn r2(x: f64) -> f64 {
    js_round(x * 100.0) / 100.0
}

/// One speed a second (m/s, rounded to 0.01), or None when there is none at all.
pub fn read_speeds(path: &Path) -> Result<Option<Vec<Option<f64>>>> {
    let out: Vec<Option<f64>> = read_records(path)?
        .iter()
        .map(|r| r.as_deref().and_then(speed_of_bytes).filter(|v| v.is_finite()).map(r2))
        .collect();
    Ok(if out.iter().any(Option::is_some) { Some(out) } else { None })
}

/// The record of each second as sample_of_bytes reads it, or None when no second has a speed.
pub fn read_samples(path: &Path) -> Result<Option<Vec<Option<Sample>>>> {
    let out: Vec<Option<Sample>> = read_records(path)?.iter().map(|r| r.as_deref().map(sample_of_bytes)).collect();
    Ok(if out.iter().any(|x| x.is_some_and(|s| s.v.is_some())) { Some(out) } else { None })
}
