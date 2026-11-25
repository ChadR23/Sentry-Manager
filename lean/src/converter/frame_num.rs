//! src/main/converter/frameNumGaps.js: which samples of a Tesla H.264
//! original FFmpeg never outputs because of a frame_num gap across the wrap,
//! proven from the SPS/PPS and the first slice header of each sample only.
//! Anything the model is not sure of answers "unknown" and excuses nothing.

use super::mp4w::Sample;
use super::tesla_sei::remove_emulation_prevention_bytes;
use std::collections::{HashMap, HashSet};

const UINT32_MAX: u64 = 0xffff_ffff;
const HEADER_BYTES: usize = 256;
const HIGH_PROFILES: [u64; 13] = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135];

#[derive(Debug)]
pub struct GapError {
    pub message: &'static str,
    pub truncated: bool,
}
type R<T> = Result<T, GapError>;
fn gap(message: &'static str) -> GapError {
    GapError { message, truncated: false }
}

struct Bits<'a> {
    b: &'a [u8],
    pos: usize,
}

impl<'a> Bits<'a> {
    fn bit(&mut self) -> R<u64> {
        if self.pos >= self.b.len() * 8 {
            return Err(GapError { message: "Header runs past its data", truncated: true });
        }
        let v = (self.b[self.pos >> 3] >> (7 - (self.pos & 7))) & 1;
        self.pos += 1;
        Ok(v as u64)
    }
    fn u(&mut self, n: u32) -> R<u64> {
        let mut v = 0u64;
        for _ in 0..n {
            v = v * 2 + self.bit()?;
        }
        Ok(v)
    }
    fn ue(&mut self) -> R<u64> {
        let mut zeros = 0u32;
        while self.bit()? == 0 {
            zeros += 1;
            if zeros > 31 {
                return Err(gap("Exp-Golomb code is too long"));
            }
        }
        Ok((1u64 << zeros) - 1 + self.u(zeros)?)
    }
    fn se(&mut self) -> R<i64> {
        let v = self.ue()?;
        Ok(if v % 2 == 1 { ((v + 1) / 2) as i64 } else { -((v / 2) as i64) })
    }
}

fn with_rbsp<T>(nal: &[u8], parse: impl Fn(&mut Bits) -> R<T>) -> R<T> {
    if nal.len() > 1 + HEADER_BYTES {
        if let Some(head) = remove_emulation_prevention_bytes(&nal[1..1 + HEADER_BYTES]) {
            match parse(&mut Bits { b: &head, pos: 0 }) {
                Ok(v) => return Ok(v),
                Err(e) if !e.truncated => return Err(e),
                Err(_) => {}
            }
        }
    }
    let rbsp = remove_emulation_prevention_bytes(&nal[1..]).ok_or(gap("Invalid emulation prevention"))?;
    parse(&mut Bits { b: &rbsp, pos: 0 })
}

fn skip_scaling_list(r: &mut Bits, size: usize) -> R<()> {
    let (mut last, mut next) = (8i64, 8i64);
    for _ in 0..size {
        if next != 0 {
            next = (last + r.se()? + 256).rem_euclid(256);
        }
        last = if next == 0 { last } else { next };
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct Sps {
    pub id: u64,
    pub chroma_array_type: u64,
    pub separate_colour_plane: u64,
    pub log2_max_frame_num: u64,
    pub poc_type: u64,
    pub log2_max_poc_lsb: u64,
    pub delta_poc_always_zero: u64,
    pub max_ref_frames: u64,
    pub gaps_allowed: u64,
    pub frame_mbs_only: u64,
}

pub fn parse_sps(nal: &[u8]) -> R<Sps> {
    with_rbsp(nal, |r| {
        let profile = r.u(8)?;
        r.u(16)?;
        let id = r.ue()?;
        let mut chroma = 1;
        let mut sep = 0;
        if HIGH_PROFILES.contains(&profile) {
            chroma = r.ue()?;
            if chroma == 3 {
                sep = r.u(1)?;
            }
            r.ue()?;
            r.ue()?;
            r.u(1)?;
            if r.u(1)? == 1 {
                for i in 0..(if chroma != 3 { 8 } else { 12 }) {
                    if r.u(1)? == 1 {
                        skip_scaling_list(r, if i < 6 { 16 } else { 64 })?;
                    }
                }
            }
        }
        let log2_max_frame_num = r.ue()? + 4;
        if log2_max_frame_num > 16 {
            return Err(gap("Invalid log2_max_frame_num"));
        }
        let poc_type = r.ue()?;
        let (mut lsb, mut dz) = (0, 0);
        if poc_type == 0 {
            lsb = r.ue()? + 4;
        } else if poc_type == 1 {
            dz = r.u(1)?;
            r.se()?;
            r.se()?;
            let cycle = r.ue()?;
            if cycle > 255 {
                return Err(gap("Invalid POC cycle"));
            }
            for _ in 0..cycle {
                r.se()?;
            }
        } else if poc_type != 2 {
            return Err(gap("Invalid pic_order_cnt_type"));
        }
        let max_ref_frames = r.ue()?;
        let gaps_allowed = r.u(1)?;
        r.ue()?;
        r.ue()?;
        let frame_mbs_only = r.u(1)?;
        Ok(Sps {
            id,
            chroma_array_type: if sep == 1 { 0 } else { chroma },
            separate_colour_plane: sep,
            log2_max_frame_num,
            poc_type,
            log2_max_poc_lsb: lsb,
            delta_poc_always_zero: dz,
            max_ref_frames,
            gaps_allowed,
            frame_mbs_only,
        })
    })
}

#[derive(Debug, Clone)]
pub struct Pps {
    pub id: u64,
    pub sps_id: u64,
    pub bottom_field_poc_present: u64,
    pub ref_idx_l0: u64,
    pub ref_idx_l1: u64,
    pub weighted_pred: u64,
    pub weighted_bipred: u64,
    pub redundant_pic_cnt: u64,
}

pub fn parse_pps(nal: &[u8]) -> R<Pps> {
    with_rbsp(nal, |r| {
        let id = r.ue()?;
        let sps_id = r.ue()?;
        r.u(1)?;
        let bfp = r.u(1)?;
        if r.ue()? + 1 != 1 {
            return Err(gap("Slice groups are not supported"));
        }
        let l0 = r.ue()? + 1;
        let l1 = r.ue()? + 1;
        let wp = r.u(1)?;
        let wb = r.u(2)?;
        r.se()?;
        r.se()?;
        r.se()?;
        r.u(1)?;
        r.u(1)?;
        let rpc = r.u(1)?;
        Ok(Pps { id, sps_id, bottom_field_poc_present: bfp, ref_idx_l0: l0, ref_idx_l1: l1, weighted_pred: wp, weighted_bipred: wb, redundant_pic_cnt: rpc })
    })
}

fn skip_ref_list_modification(r: &mut Bits) -> R<()> {
    if r.u(1)? == 0 {
        return Ok(());
    }
    let mut count = 0;
    loop {
        if count > 64 {
            return Err(gap("Too many reference list changes"));
        }
        let idc = r.ue()?;
        if idc == 3 {
            return Ok(());
        }
        if idc > 2 {
            return Err(gap("Invalid reference list change"));
        }
        r.ue()?;
        count += 1;
    }
}

fn skip_weights(r: &mut Bits, count: u64, chroma: bool) -> R<()> {
    for _ in 0..count {
        if r.u(1)? == 1 {
            r.se()?;
            r.se()?;
        }
        if chroma && r.u(1)? == 1 {
            for _ in 0..2 {
                r.se()?;
                r.se()?;
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
pub struct Picture {
    pub first_mb: u64,
    pub slice_type: u64,
    pub idr: bool,
    pub ref_idc: u8,
    pub frame_num: u64,
    pub field: u64,
    pub resets: bool,
}

pub struct ParameterSets {
    pub sps: HashMap<u64, Sps>,
    pub pps: HashMap<u64, Pps>,
}

pub fn parse_slice_header(nal: &[u8], sets: &ParameterSets) -> R<Picture> {
    let nal_type = nal[0] & 0x1f;
    let ref_idc = (nal[0] >> 5) & 3;
    let idr = nal_type == 5;
    with_rbsp(nal, |r| {
        let first_mb = r.ue()?;
        let slice_type = r.ue()?;
        if slice_type > 9 {
            return Err(gap("Invalid slice_type"));
        }
        let pps = sets.pps.get(&r.ue()?).ok_or(gap("Unknown picture parameter set"))?;
        let sps = sets.sps.get(&pps.sps_id).ok_or(gap("Unknown sequence parameter set"))?;
        if sps.separate_colour_plane == 1 {
            r.u(2)?;
        }
        let frame_num = r.u(sps.log2_max_frame_num as u32)?;
        let mut field = 0;
        if sps.frame_mbs_only == 0 {
            field = r.u(1)?;
            if field == 1 {
                r.u(1)?;
            }
        }
        if idr {
            r.ue()?;
        }
        if sps.poc_type == 0 {
            r.u(sps.log2_max_poc_lsb as u32)?;
            if pps.bottom_field_poc_present == 1 && field == 0 {
                r.se()?;
            }
        }
        if sps.poc_type == 1 && sps.delta_poc_always_zero == 0 {
            r.se()?;
            if pps.bottom_field_poc_present == 1 && field == 0 {
                r.se()?;
            }
        }
        if pps.redundant_pic_cnt == 1 {
            r.ue()?;
        }
        let kind = slice_type % 5;
        let (mut l0, mut l1) = (pps.ref_idx_l0, pps.ref_idx_l1);
        if kind == 1 {
            r.u(1)?;
        }
        if kind == 0 || kind == 1 || kind == 3 {
            if r.u(1)? == 1 {
                l0 = r.ue()? + 1;
                if kind == 1 {
                    l1 = r.ue()? + 1;
                }
            }
            if l0 > 32 || l1 > 32 {
                return Err(gap("Invalid reference count"));
            }
        }
        if kind != 2 && kind != 4 {
            skip_ref_list_modification(r)?;
            if kind == 1 {
                skip_ref_list_modification(r)?;
            }
        }
        if (pps.weighted_pred == 1 && (kind == 0 || kind == 3)) || (pps.weighted_bipred == 1 && kind == 1) {
            r.ue()?;
            if sps.chroma_array_type != 0 {
                r.ue()?;
            }
            skip_weights(r, l0, sps.chroma_array_type != 0)?;
            if kind == 1 {
                skip_weights(r, l1, sps.chroma_array_type != 0)?;
            }
        }
        let mut resets = false;
        if ref_idc != 0 {
            if idr {
                r.u(2)?;
            } else if r.u(1)? == 1 {
                let mut count = 0;
                loop {
                    if count > 64 {
                        return Err(gap("Too many memory operations"));
                    }
                    let op = r.ue()?;
                    if op == 0 {
                        break;
                    }
                    if op > 6 {
                        return Err(gap("Invalid memory operation"));
                    }
                    if op == 5 {
                        resets = true;
                    }
                    if op == 1 || op == 3 {
                        r.ue()?;
                    }
                    if op == 2 {
                        r.ue()?;
                    }
                    if op == 3 || op == 6 {
                        r.ue()?;
                    }
                    if op == 4 {
                        r.ue()?;
                    }
                    count += 1;
                }
            }
        }
        Ok(Picture { first_mb, slice_type, idr, ref_idc, frame_num, field, resets })
    })
}

/// avcParameterSets(avcC): (sps units, pps units)
pub fn avc_parameter_sets(avcc: &[u8]) -> R<(Vec<Vec<u8>>, Vec<Vec<u8>>)> {
    if avcc.len() < 7 || avcc[0] != 1 {
        return Err(gap("Invalid avcC configuration record"));
    }
    let mut c = 5;
    let read = |c: &mut usize, n: usize| -> R<Vec<Vec<u8>>> {
        let mut units = Vec::new();
        for _ in 0..n {
            if *c + 2 > avcc.len() {
                return Err(gap("Truncated avcC"));
            }
            let size = u16::from_be_bytes([avcc[*c], avcc[*c + 1]]) as usize;
            *c += 2;
            if size == 0 || *c + size > avcc.len() {
                return Err(gap("Truncated avcC"));
            }
            units.push(avcc[*c..*c + size].to_vec());
            *c += size;
        }
        Ok(units)
    };
    let n = (avcc[c] & 0x1f) as usize;
    c += 1;
    let sps = read(&mut c, n)?;
    if c >= avcc.len() {
        return Err(gap("Truncated avcC"));
    }
    let n = avcc[c] as usize;
    c += 1;
    let pps = read(&mut c, n)?;
    Ok((sps, pps))
}

/// droppedPictures(pictures, maxFrameNum, pocType)
pub fn dropped_pictures(pictures: &[Picture], max_frame_num: u64, poc_type: u64) -> R<Vec<usize>> {
    let mut dropped: Vec<usize> = Vec::new();
    let mut prev: Option<u64> = None;
    for (i, p) in pictures.iter().enumerate() {
        if p.field != 0 {
            return Err(gap("Field pictures are not supported"));
        }
        if p.resets {
            return Err(gap("Memory-management resets are not supported"));
        }
        if i > 0 && dropped.last() == Some(&(i - 1)) && !p.idr {
            return Err(gap("Pictures follow a dropped picture"));
        }
        if p.idr {
            if p.frame_num != 0 {
                return Err(gap("IDR picture with a non-zero frame_num"));
            }
            prev = Some(0);
            continue;
        }
        let Some(pr) = prev else { return Err(gap("No IDR picture before this one")) };
        if p.ref_idc == 0 {
            return Err(gap("Non-reference pictures are not supported"));
        }
        if p.frame_num == pr {
            if poc_type != 2 || p.slice_type % 5 != 0 {
                return Err(gap("Repeated frame_num"));
            }
            // A reference P picture with POC type 2 repeats the previous POC,
            // not its timestamp. FFmpeg outputs equal POCs (only a lower POC
            // is out of order), so both pictures and their telemetry survive.
            // It is not a gap and must not invalidate proven drops elsewhere.
            continue;
        }
        if p.frame_num != (pr + 1) % max_frame_num {
            if poc_type != 2 {
                return Err(gap("Gap with a picture order count FFmpeg is not modelled for"));
            }
            if p.frame_num < pr && p.frame_num != 0 {
                dropped.push(i);
            }
        }
        prev = Some(p.frame_num);
    }
    if !pictures.is_empty() && dropped.last() == Some(&(pictures.len() - 1)) {
        return Err(gap("The last picture is dropped"));
    }
    Ok(dropped)
}

fn first_vcl<'a>(nals: &[&'a [u8]]) -> Option<&'a [u8]> {
    nals.iter().copied().find(|n| {
        let t = n[0] & 0x1f;
        t == 1 || t == 5
    })
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Undecodable {
    /// None: the stream could not be modelled
    pub frames: Option<usize>,
    pub samples: Vec<usize>,
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timescale: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ticks: Option<Vec<u64>>,
}

impl Undecodable {
    fn none(reason: Option<&str>) -> Undecodable {
        Undecodable { frames: Some(0), samples: vec![], reason: reason.map(String::from), timescale: None, duration_ticks: None }
    }
    fn unknown(reason: &str) -> Undecodable {
        Undecodable { frames: None, samples: vec![], reason: Some(reason.into()), timescale: None, duration_ticks: None }
    }
}

/// createFrameNumScanner(avcC)
pub struct FrameNumScanner {
    reason: Option<&'static str>,
    units: Vec<Vec<u8>>,
    sps: Option<Sps>,
    sets: Option<ParameterSets>,
    pictures: Vec<Option<Picture>>,
}

impl FrameNumScanner {
    pub fn new(avcc: &[u8]) -> FrameNumScanner {
        let mut s = FrameNumScanner { reason: None, units: vec![], sps: None, sets: None, pictures: vec![] };
        match avc_parameter_sets(avcc) {
            Err(_) => s.reason = Some("unreadable"),
            Ok((sps_u, pps_u)) => {
                if sps_u.len() != 1 || pps_u.len() != 1 {
                    s.reason = Some("parameter-sets");
                } else {
                    match (parse_sps(&sps_u[0]), parse_pps(&pps_u[0])) {
                        (Ok(sps), Ok(pps)) => {
                            if pps.sps_id != sps.id {
                                s.reason = Some("parameter-sets");
                            }
                            let mut sm = HashMap::new();
                            sm.insert(sps.id, sps.clone());
                            let mut pm = HashMap::new();
                            pm.insert(pps.id, pps);
                            s.sets = Some(ParameterSets { sps: sm, pps: pm });
                            s.sps = Some(sps);
                            s.units = [sps_u, pps_u].concat();
                        }
                        _ => s.reason = Some("unreadable"),
                    }
                }
            }
        }
        if s.reason.is_none() && s.sps.as_ref().unwrap().gaps_allowed == 1 {
            s.reason = Some("gaps-allowed");
        }
        s
    }

    pub fn add(&mut self, nals: &[&[u8]]) {
        if self.reason.is_some() {
            return;
        }
        if nals.iter().any(|n| {
            let t = n[0] & 0x1f;
            (t == 7 || t == 8) && !self.units.iter().any(|u| u.as_slice() == *n)
        }) {
            self.reason = Some("parameter-sets");
            return;
        }
        let pic = first_vcl(nals).and_then(|n| parse_slice_header(n, self.sets.as_ref().unwrap()).ok());
        self.pictures.push(pic.filter(|p| p.first_mb == 0));
    }

    pub fn describe(&self, samples: &[Sample], timescale: u32, lead_in: &super::lead_in::LeadIn) -> Undecodable {
        if self.reason == Some("gaps-allowed") {
            return Undecodable::none(Some("gaps-allowed"));
        }
        if let Some(r) = self.reason {
            return Undecodable::unknown(r);
        }
        if self.pictures.len() != samples.len() {
            return Undecodable::unknown("unreadable");
        }
        let tail = if !samples.is_empty() && samples.last().unwrap().duration == 0 { 1 } else { 0 };
        let real = samples.len() - tail;
        let Some(start) = self.pictures.iter().position(|p| p.as_ref().is_some_and(|p| p.idr)) else { return Undecodable::none(None) };
        if start >= real {
            return Undecodable::none(None);
        }
        let decoded = &self.pictures[start..real];
        if decoded.iter().any(|p| p.is_none()) {
            return Undecodable::unknown("unreadable");
        }
        let decoded: Vec<Picture> = decoded.iter().map(|p| p.clone().unwrap()).collect();
        let sps = self.sps.as_ref().unwrap();
        let found: Vec<usize> = match dropped_pictures(&decoded, 1u64 << sps.log2_max_frame_num, sps.poc_type) {
            Ok(f) => f.into_iter().map(|p| p + start).collect(),
            Err(_) => return Undecodable::unknown("frame-num"),
        };
        if found.is_empty() {
            return Undecodable::none(None);
        }
        if lead_in.frames != Some(start) || (start > 0 && lead_in.hold != start) {
            return Undecodable::unknown("lead-in");
        }
        if samples[0].pts != 0 || timescale == 0 {
            return Undecodable::unknown("timing");
        }
        let dropped: HashSet<usize> = found.iter().copied().collect();
        let mut ticks: Vec<u64> = Vec::new();
        for i in 0..real {
            let s = &samples[i];
            if s.pts != s.dts || (i > 0 && s.pts <= samples[i - 1].pts) {
                return Undecodable::unknown("reordered");
            }
            if s.duration <= 0 || s.duration as u64 > UINT32_MAX {
                return Undecodable::unknown("timing");
            }
            if !dropped.contains(&i) {
                ticks.push(s.duration as u64);
            } else if let Some(l) = ticks.last_mut() {
                *l += s.duration as u64;
            } else {
                // durationTicks[-1] += d in JS gives NaN at the end: never
                // reached, a dropped picture always follows an IDR
                return Undecodable::unknown("timing");
            }
            if *ticks.last().unwrap() > UINT32_MAX {
                return Undecodable::unknown("timing");
            }
        }
        Undecodable { frames: Some(found.len()), samples: found, reason: None, timescale: Some(timescale), duration_ticks: Some(ticks) }
    }
}

/// undecodableFrames(timeline)
pub fn undecodable_frames(u: Option<&Undecodable>) -> usize {
    let Some(u) = u else { return 0 };
    let Some(frames) = u.frames else { return 0 };
    if frames == 0 || u.samples.len() != frames {
        return 0;
    }
    let ordered = u.samples.iter().enumerate().all(|(k, &i)| i > 0 && (k == 0 || i > u.samples[k - 1]));
    if ordered {
        u.samples.len()
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pic(idr: bool, frame_num: u64) -> Picture {
        Picture { first_mb: 0, slice_type: if idr { 7 } else { 5 }, idr, ref_idc: 3, frame_num, field: 0, resets: false }
    }

    #[test]
    fn dropped_only_across_the_wrap_before_an_idr() {
        // 16 frame numbers: 0..13, then 2 (skipped 14, 15 and the wrap), then an IDR
        let mut p: Vec<Picture> = (0..14).map(|n| pic(n == 0, n)).collect();
        p.push(pic(false, 2));
        p.push(pic(true, 0));
        p.push(pic(false, 1));
        assert_eq!(dropped_pictures(&p, 16, 2).unwrap(), vec![14]);
        // a gap without the wrap is concealed: nothing dropped
        let q = vec![pic(true, 0), pic(false, 1), pic(false, 5), pic(false, 6)];
        assert_eq!(dropped_pictures(&q, 16, 2).unwrap(), Vec::<usize>::new());
        // other POC types are not modelled
        assert!(dropped_pictures(&q, 16, 0).is_err());
        // more pictures after a dropped one
        let mut r = p.clone();
        r[15] = pic(false, 3);
        assert!(dropped_pictures(&r, 16, 2).is_err());
        // the last one dropped
        assert!(dropped_pictures(&p[..15], 16, 2).is_err());
        assert!(dropped_pictures(&[pic(false, 1)], 16, 2).is_err());
    }

    #[test]
    fn repeated_reference_pictures_keep_other_gaps_provable_only_for_poc_two() {
        // A normal wrap, then two reference P pictures numbered 1. Both
        // display; the later forward gap also displays. Only 15 -> 1 drops.
        let mut p: Vec<_> = (0..18).map(|n| pic(n == 0, n % 16)).collect();
        p.extend([pic(false, 1), pic(false, 2), pic(false, 4)]);
        p.extend((5..16).map(|n| pic(false, n)));
        p.extend([pic(false, 1), pic(true, 0), pic(false, 1)]);
        assert_eq!(dropped_pictures(&p, 16, 2).unwrap(), vec![32]);
        p[18].slice_type = 0; // Both encodings of a P slice (0 and 5).
        assert_eq!(dropped_pictures(&p, 16, 2).unwrap(), vec![32]);
        for poc in [0, 1] { assert!(dropped_pictures(&p, 16, poc).is_err()); }
        for bad in [
            Picture { ref_idc: 0, ..p[18].clone() },
            Picture { field: 1, ..p[18].clone() },
            Picture { resets: true, ..p[18].clone() },
            Picture { slice_type: 1, ..p[18].clone() },
        ] {
            let mut unknown = p.clone();
            unknown[18] = bad;
            assert!(dropped_pictures(&unknown, 16, 2).is_err());
        }
        p[33] = pic(false, 2);
        assert!(dropped_pictures(&p, 16, 2).is_err(), "a picture after a wrap gap remains unknown");
    }

    #[test]
    fn bit_reader() {
        let mut b = Bits { b: &[0b1010_0110, 0b0100_0000], pos: 0 };
        assert_eq!(b.ue().unwrap(), 0);
        assert_eq!(b.ue().unwrap(), 1);
        assert_eq!(b.ue().unwrap(), 2);
        assert_eq!(b.se().unwrap(), 2);
        assert!(b.u(16).unwrap_err().truncated);
    }

    #[test]
    fn undecodable_count_needs_ordered_samples() {
        let u = Undecodable { frames: Some(2), samples: vec![3, 9], reason: None, timescale: Some(1), duration_ticks: Some(vec![]) };
        assert_eq!(undecodable_frames(Some(&u)), 2);
        let v = Undecodable { samples: vec![9, 3], ..u.clone() };
        assert_eq!(undecodable_frames(Some(&v)), 0);
        let w = Undecodable { samples: vec![0, 3], ..u };
        assert_eq!(undecodable_frames(Some(&w)), 0);
        assert_eq!(undecodable_frames(None), 0);
    }
}
