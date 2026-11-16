//! speedReader.js readRecords with its two read modes: "short" (one short
//! read a second, as sei.rs does it) and "straight" (the frames' heads from a
//! few long reads, front to back, the gaps between them read and dropped,
//! which beats a seek a second on spinning disks and network shares). Both
//! give the same records; the speed index times both and uses the faster.

use crate::mp4::{self, err, read_at, Result};
use crate::sei::{sample_of_bytes, tesla_payload, Sample};
use std::collections::HashMap;
use std::fs::File;
use std::path::Path;

const HEAD: u32 = 4096;
const STRAIGHT_GAP: u64 = 4 * 1024 * 1024;
const STRAIGHT_SPAN: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Short,
    Straight,
}

impl Mode {
    pub fn name(self) -> &'static str {
        match self {
            Mode::Short => "short",
            Mode::Straight => "straight",
        }
    }
}

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

/// Some(Some(record)), Some(None) when the picture came first, None for neither (undefined).
fn record_in(list: &[&[u8]], codec: &[u8; 4]) -> Option<Option<Vec<u8>>> {
    for nal in list {
        if codec == b"avc1" {
            let t = nal[0] & 31;
            if t == 6 {
                if let Some(p) = tesla_payload(nal) {
                    return Some(Some(p));
                }
            } else if t == 1 || t == 5 {
                return Some(None);
            }
        } else if nal.len() >= 2 && nal[0] == 0x66 && nal[1] == 0x01 {
            let mut h = vec![6u8, 5];
            h.extend_from_slice(&nal[2..]);
            if let Some(p) = tesla_payload(&h) {
                return Some(Some(p));
            }
        }
    }
    None
}

/// headsStraight: the heads of the picked frames, by offset, from long reads that cover several.
fn heads_straight(file: &File, picks: &[Option<&mp4::Sample>]) -> Result<HashMap<u64, Vec<u8>>> {
    let mut want: Vec<(u64, u64)> = picks.iter().flatten().map(|s| (s.offset, s.size.min(HEAD) as u64)).collect();
    want.sort_by_key(|w| w.0);
    let mut out = HashMap::new();
    let mut i = 0;
    while i < want.len() {
        let first = want[i].0;
        let mut end = first + want[i].1;
        let mut j = i + 1;
        while j < want.len() && want[j].0 <= end + STRAIGHT_GAP && want[j].0 + want[j].1 - first <= STRAIGHT_SPAN {
            end = end.max(want[j].0 + want[j].1);
            j += 1;
        }
        let buf = read_at(file, first, (end - first) as usize)?;
        while i < j {
            let (at, len) = want[i];
            out.insert(at, buf[(at - first) as usize..(at - first + len) as usize].to_vec());
            i += 1;
        }
    }
    Ok(out)
}

/// The record of the first frame of each second (None for a second without one); Err for
/// anything unexpected (the caller then reads the whole clip).
pub fn read_records(path: &Path, mode: Mode) -> Result<Vec<Option<Vec<u8>>>> {
    if mode == Mode::Short {
        return crate::sei::read_records(path);
    }
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
    if &codec == b"av01" {
        // all the records sit in the first mdat: one read in either mode
        return crate::sei::read_records(path);
    }
    let find = |needle: &[u8]| desc.windows(4).position(|w| w == needle);
    let length_size = if &codec == b"avc1" && find(b"avcC").is_some() {
        (desc.get(find(b"avcC").unwrap() + 8).copied().unwrap_or(0) & 3) as usize + 1
    } else if (&codec == b"hvc1" || &codec == b"hev1") && find(b"hvcC").is_some() {
        (desc.get(find(b"hvcC").unwrap() + 25).copied().unwrap_or(0) & 3) as usize + 1
    } else {
        return err(format!("Unsupported codec {}", String::from_utf8_lossy(&codec)));
    };
    let picks = crate::sei::first_shown_each_second(&samples, scale);
    let heads = heads_straight(&file, &picks)?;
    let mut out = Vec::with_capacity(picks.len());
    for pick in picks {
        let Some(s) = pick else {
            out.push(None);
            continue;
        };
        let head = match heads.get(&s.offset) {
            Some(h) => h.clone(),
            None => read_at(&file, s.offset, s.size.min(HEAD) as usize)?,
        };
        let (list, cut) = nals(&head, length_size)?;
        let rec = match record_in(&list, &codec) {
            Some(r) => r,
            None if cut => {
                let whole = read_at(&file, s.offset, s.size as usize)?;
                record_in(&nals(&whole, length_size)?.0, &codec).flatten()
            }
            None => None,
        };
        out.push(rec);
    }
    Ok(out)
}

/// readSamples: each second's record as sampleOfBytes reads it, or None when no second has a speed.
pub fn read_samples(path: &Path, mode: Mode) -> Result<Option<Vec<Option<Sample>>>> {
    let out: Vec<Option<Sample>> = read_records(path, mode)?.iter().map(|r| r.as_deref().map(sample_of_bytes)).collect();
    Ok(if out.iter().any(|x| x.is_some_and(|s| s.v.is_some())) { Some(out) } else { None })
}
