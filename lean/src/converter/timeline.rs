//! src/main/converter/telemetryTimeline.js: every Tesla SEI record of an
//! H.264 original with its sample and time, and their mapping onto the
//! encoded file's samples (ordinal where the frame counts allow it, else by
//! nearest timestamp within one frame).

use super::error::{CError, CResult};
use super::frame_num::{undecodable_frames, FrameNumScanner, Undecodable};
use super::lead_in::{self, LeadIn};
use super::mp4w::{self, be32, to_number, Tree};
use super::tesla_sei::fingerprint;
use std::collections::HashSet;

fn terr(code: &str, m: impl Into<String>) -> CError {
    CError::new(if code.is_empty() { "INVALID_H264" } else { code }, m)
}

#[derive(Debug, Clone, PartialEq)]
pub struct SeiRecord {
    pub nal: Vec<u8>,
    pub fingerprint: String,
}

#[derive(Debug, Clone)]
pub struct TimelineSample {
    pub sample_index: usize,
    pub pts_us: i64,
    pub duration_us: i64,
    pub has_telemetry: bool,
    pub sei_nals: Vec<SeiRecord>,
}

#[derive(Debug, Clone)]
pub struct Event {
    pub source_sample_index: usize,
    pub source_pts_us: i64,
    pub nal: Vec<u8>,
    pub fingerprint: String,
}

#[derive(Debug, Clone)]
pub struct Timeline {
    pub timescale: u32,
    pub length_size: usize,
    pub samples: Vec<TimelineSample>,
    pub events: Vec<Event>,
    pub lead_in: LeadIn,
    pub undecodable: Undecodable,
}

#[derive(Debug, Clone)]
pub struct MappedSample {
    pub pts_us: f64,
    pub picture_marker: bool,
    pub sei_nals: Vec<SeiRecord>,
}

/// parseH264Nals with the length-prefixed format
pub fn parse_length_prefixed(buf: &[u8], ls: usize) -> CResult<Vec<&[u8]>> {
    if ![1, 2, 4].contains(&ls) {
        return Err(terr("UNSUPPORTED_AVC", "AVC NAL length size must be 1, 2, or 4 bytes"));
    }
    let mut out = Vec::new();
    let mut c = 0;
    while c < buf.len() {
        if buf.len() - c < ls {
            return Err(terr("", "Truncated NAL length prefix"));
        }
        let mut size = 0usize;
        for k in 0..ls {
            size = (size << 8) | buf[c + k] as usize;
        }
        c += ls;
        if size == 0 {
            return Err(terr("", "Zero-length NAL unit is not valid AVC"));
        }
        if size > buf.len() - c {
            return Err(terr("", "NAL length exceeds sample boundary"));
        }
        out.push(&buf[c..c + size]);
        c += size;
    }
    Ok(out)
}

fn start_code(b: &[u8], o: usize) -> usize {
    if o + 3 < b.len() && b[o] == 0 && b[o + 1] == 0 && b[o + 2] == 0 && b[o + 3] == 1 {
        return 4;
    }
    if o + 2 < b.len() && b[o] == 0 && b[o + 1] == 0 && b[o + 2] == 1 {
        return 3;
    }
    0
}

/// parseH264Nals with the Annex-B format
pub fn parse_annex_b(buf: &[u8]) -> CResult<Vec<&[u8]>> {
    if buf.is_empty() {
        return Ok(vec![]);
    }
    let mut starts = Vec::new();
    let mut c = 0;
    while c < buf.len() {
        let w = start_code(buf, c);
        if w > 0 {
            starts.push((c, c + w));
            c += w;
        } else {
            c += 1;
        }
    }
    if starts.is_empty() || buf[..starts[0].0].iter().any(|&b| b != 0) {
        return Err(terr("", "Annex-B sample is missing an initial start code"));
    }
    let mut out = Vec::new();
    for (i, &(_, ns)) in starts.iter().enumerate() {
        let mut end = if i + 1 < starts.len() { starts[i + 1].0 } else { buf.len() };
        if i == starts.len() - 1 {
            while end > ns && buf[end - 1] == 0 {
                end -= 1;
            }
        }
        if end == ns {
            return Err(terr("", "Zero-length Annex-B NAL unit is not valid AVC"));
        }
        out.push(&buf[ns..end]);
    }
    Ok(out)
}

fn read_ordinary_box(b: &[u8], c: usize, end: usize, ctx: &str) -> CResult<([u8; 4], usize, usize)> {
    if end - c < 8 {
        return Err(terr("", format!("Truncated {ctx} box header")));
    }
    let size = be32(b, c) as usize;
    let mut t = [0u8; 4];
    t.copy_from_slice(&b[c + 4..c + 8]);
    if size < 8 || c + size > end {
        return Err(terr("", format!("Invalid {ctx} box size: {}", mp4w::type_str(&t))));
    }
    Ok((t, c + 8, c + size))
}

/// readAvcConfig: (NAL length size, avcC record)
fn read_avc_config<'a>(tree: &Tree<'a>, track: usize) -> CResult<(usize, &'a [u8])> {
    let b = tree.find(track, b"stsd");
    if b.len() != 1 {
        return Err(terr("UNSUPPORTED_CONTAINER", "Video track must contain exactly one stsd box"));
    }
    let n = tree.node(b[0]);
    let (s, e) = (to_number(n.content, "stsd start").map_err(|_| terr("UNSUPPORTED_CONTAINER", "stsd start cannot be represented safely"))?, n.end as usize);
    let buf = tree.buf;
    if e - s < 8 {
        return Err(terr("", "Truncated stsd box"));
    }
    if buf[s] != 0 {
        return Err(terr("UNSUPPORTED_CONTAINER", "Unsupported stsd version"));
    }
    if be32(buf, s + 4) != 1 {
        return Err(terr("UNSUPPORTED_CONTAINER", "Exactly one AVC sample description is required"));
    }
    let (t, cs, ce) = read_ordinary_box(buf, s + 8, e, "sample description")?;
    if &t != b"avc1" && &t != b"avc3" {
        return Err(terr("UNSUPPORTED_CODEC", format!("Unsupported video sample description: {}", mp4w::type_str(&t))));
    }
    let child = cs + 78;
    if child > ce {
        return Err(terr("", format!("Truncated {} sample entry", mp4w::type_str(&t))));
    }
    let mut configs = Vec::new();
    let mut c = child;
    while c < ce {
        let (ct, ccs, cce) = read_ordinary_box(buf, c, ce, &format!("{} child", mp4w::type_str(&t)))?;
        if &ct == b"avcC" {
            configs.push((ccs, cce));
        }
        c = cce;
    }
    if configs.len() != 1 {
        return Err(terr("UNSUPPORTED_CONTAINER", "AVC sample description must contain exactly one avcC box"));
    }
    let (a, ae) = configs[0];
    if ae - a < 5 || buf[a] != 1 {
        return Err(terr("", "Invalid avcC configuration record"));
    }
    let lsm1 = buf[a + 4] & 3;
    if lsm1 == 2 {
        return Err(terr("UNSUPPORTED_AVC", "avcC declares the reserved 3-byte NAL length size"));
    }
    Ok((lsm1 as usize + 1, &buf[a..ae]))
}

/// The lenient unescape of telemetryTimeline.js (every 00 00 03 drops the 03).
fn unescape_lenient(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(b.len());
    let mut zeros = 0;
    for &x in b {
        if zeros >= 2 && x == 3 {
            zeros = 0;
            continue;
        }
        out.push(x);
        zeros = if x == 0 { zeros + 1 } else { 0 };
    }
    out
}

/// telemetryTimeline.js teslaPayload: any SEI NAL, any message in it.
pub fn timeline_tesla_payload(nal: &[u8]) -> Option<Vec<u8>> {
    if nal.len() < 5 || nal[0] & 0x1f != 6 {
        return None;
    }
    let rbsp = unescape_lenient(&nal[1..]);
    let mut c = 0;
    while c < rbsp.len() && rbsp[c] != 0x80 {
        let t = super::tesla_sei::read_sei_field(&rbsp, &mut c);
        let s = super::tesla_sei::read_sei_field(&rbsp, &mut c);
        let (Some(t), Some(s)) = (t, s) else { return None };
        if s > rbsp.len() - c {
            return None;
        }
        let p = &rbsp[c..c + s];
        c += s;
        if t != 5 {
            continue;
        }
        let mut m = 0;
        while m < p.len() && p[m] == 0x42 {
            m += 1;
        }
        if m == 0 || m >= p.len() || p[m] != 0x69 {
            continue;
        }
        return Some(p[m + 1..].to_vec());
    }
    None
}

pub fn ticks_to_us(ticks: i128, timescale: u32) -> CResult<i64> {
    let scaled = ticks * 1_000_000;
    let d = timescale as i128;
    let r = if scaled >= 0 { (scaled + d / 2) / d } else { -((-scaled + d / 2) / d) };
    if r.abs() > mp4w::MAX_SAFE as i128 {
        return Err(terr("UNSUPPORTED_CONTAINER", "Sample timestamp cannot be represented safely"));
    }
    Ok(r as i64)
}

/// extractH264TelemetryTimeline(mp4Buffer)
pub fn extract(buf: &[u8]) -> CResult<Timeline> {
    let tree = mp4w::parse(buf)?;
    let (track, _) = mp4w::select_video_track(&tree)?;
    let samples = mp4w::build_sample_index(&tree, track)?;
    let timescale = mp4w::track_timescale(&tree, track, |c, m| terr(c, m))?;
    let (ls, avcc) = read_avc_config(&tree, track)?;
    let mut frames = FrameNumScanner::new(avcc);
    let mut out = Vec::with_capacity(samples.len());
    let mut events = Vec::new();
    for s in &samples {
        let start = to_number(s.offset, "Sample offset").map_err(|_| terr("UNSUPPORTED_CONTAINER", "Sample offset cannot be represented safely"))?;
        let au = &buf[start..start + s.size as usize];
        let nals = parse_length_prefixed(au, ls)?;
        frames.add(&nals);
        let mut seis = Vec::new();
        for n in &nals {
            if let Some(p) = timeline_tesla_payload(n) {
                seis.push(SeiRecord { nal: n.to_vec(), fingerprint: fingerprint(&p) });
            }
        }
        let pts = ticks_to_us(s.pts, timescale)?;
        let dur = ticks_to_us(s.duration as i128, timescale)?;
        for r in &seis {
            events.push(Event { source_sample_index: s.index, source_pts_us: pts, nal: r.nal.clone(), fingerprint: r.fingerprint.clone() });
        }
        out.push(TimelineSample { sample_index: s.index, pts_us: pts, duration_us: dur, has_telemetry: !seis.is_empty(), sei_nals: seis });
    }
    let lead = lead_in::describe(&tree, track, &samples, timescale);
    let undecodable = frames.describe(&samples, timescale, &lead);
    Ok(Timeline { timescale, length_size: ls, samples: out, events, lead_in: lead, undecodable })
}

/// An output sample for mapping: its time and (when known) duration, in µs.
#[derive(Debug, Clone, Copy)]
pub struct OutputSample {
    pub pts_us: f64,
    pub duration_us: Option<f64>,
}

fn nearest_output(unique: &[(f64, usize)], target: f64) -> Option<(f64, usize)> {
    let (mut lo, mut hi) = (0, unique.len());
    while lo < hi {
        let mid = (lo + hi) / 2;
        if unique[mid].0 < target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    let mut c = Vec::new();
    if lo < unique.len() {
        c.push(unique[lo]);
    }
    if lo > 0 {
        c.push(unique[lo - 1]);
    }
    c.sort_by(|a, b| {
        let d = (a.0 - target).abs() - (b.0 - target).abs();
        let d = if d != 0.0 { d } else if a.0 != b.0 { a.0 - b.0 } else { a.1 as f64 - b.1 as f64 };
        d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
    });
    c.first().copied()
}

fn nearest_distance(sorted: &[f64], target: f64) -> f64 {
    let (mut lo, mut hi) = (0, sorted.len());
    while lo < hi {
        let mid = (lo + hi) / 2;
        if sorted[mid] < target {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    let mut d = f64::INFINITY;
    if lo < sorted.len() {
        d = (sorted[lo] - target).abs();
    }
    if lo > 0 {
        d = d.min((sorted[lo - 1] - target).abs());
    }
    d
}

fn copy(r: &SeiRecord) -> SeiRecord {
    SeiRecord { nal: r.nal.clone(), fingerprint: r.fingerprint.clone() }
}

/// mapTimelineToOutput(sourceTimeline, outputSamples)
/// The output samples in the order their pictures are shown (by time; equal
/// times keep file order). With B-frames an encoder stores a frame before the
/// ones shown ahead of it, so the n-th frame shown is not the n-th sample.
fn display_order(outputs: &[OutputSample]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..outputs.len()).collect();
    order.sort_by(|&a, &b| outputs[a].pts_us.partial_cmp(&outputs[b].pts_us).unwrap().then(a.cmp(&b)));
    order
}

pub fn map_to_output(src: &Timeline, outputs: &[OutputSample]) -> CResult<Vec<MappedSample>> {
    for o in outputs {
        if !o.pts_us.is_finite() {
            return Err(CError::type_error("Every output sample must have a finite ptsUs"));
        }
    }
    let mut mapped: Vec<MappedSample> = outputs.iter().map(|o| MappedSample { pts_us: o.pts_us, picture_marker: true, sei_nals: vec![] }).collect();
    let shown = display_order(outputs);
    let ss = &src.samples;
    let tail = if ss.last().is_some_and(|s| s.duration_us == 0) { 1 } else { 0 };
    if undecodable_frames(Some(&src.undecodable)) > 0 {
        let dropped: HashSet<usize> = src.undecodable.samples.iter().copied().collect();
        if dropped.iter().all(|&i| i < ss.len() - tail) && ss.len() - tail - dropped.len() == outputs.len() {
            let mut out: isize = -1;
            for (i, s) in ss.iter().enumerate() {
                if i < ss.len() - tail && !dropped.contains(&i) {
                    out += 1;
                }
                for r in &s.sei_nals {
                    if out < 0 {
                        // mapped[-1] throws in Node (a dropped sample is never
                        // the first): refuse the same way
                        return Err(CError::type_error("Cannot read properties of undefined (reading 'seiNals')"));
                    }
                    mapped[shown[out as usize]].sei_nals.push(copy(r));
                }
            }
            return Ok(mapped);
        }
    }
    let ordinal = if ss.len() == outputs.len() && ss.len() > 10 {
        outputs.len()
    } else if ss.len() == outputs.len() + 1 && ss.last().is_some_and(|s| s.duration_us == 0) {
        outputs.len()
    } else {
        0
    };
    if ordinal > 0 {
        for i in 0..ordinal {
            for r in &ss[i].sei_nals {
                mapped[shown[i]].sei_nals.push(copy(r));
            }
        }
        if ss.len() == ordinal + 1 && ss.last().unwrap().duration_us == 0 {
            let last = shown[shown.len() - 1];
            for r in &ss.last().unwrap().sei_nals {
                mapped[last].sei_nals.push(copy(r));
            }
        }
        return Ok(mapped);
    }
    // outputTimingIndex
    let mut sorted: Vec<(f64, usize)> = outputs.iter().enumerate().map(|(i, o)| (o.pts_us, i)).collect();
    sorted.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap().then(a.1.cmp(&b.1)));
    let mut unique: Vec<(f64, usize)> = Vec::new();
    for (k, s) in sorted.iter().enumerate() {
        if k == 0 || s.0 != sorted[k - 1].0 {
            unique.push(*s);
        }
    }
    let mut inferred = 0.0;
    for k in 1..unique.len() {
        let d = unique[k].0 - unique[k - 1].0;
        if d > 0.0 && (inferred == 0.0 || d < inferred) {
            inferred = d;
        }
    }
    let durations: Vec<f64> = outputs.iter().map(|o| match o.duration_us { Some(d) if d.is_finite() && d > 0.0 => d, _ => inferred }).collect();
    let mut gaps: Vec<f64> = ss.iter().filter(|s| !s.has_telemetry).map(|s| s.pts_us as f64).collect();
    gaps.sort_by(|a, b| a.partial_cmp(b).unwrap());
    for ev in &src.events {
        let t = ev.source_pts_us as f64;
        let best = nearest_output(&unique, t);
        let Some(best) = best else { continue };
        let ed = (best.0 - t).abs();
        let gd = nearest_distance(&gaps, best.0);
        if ed <= durations[best.1] && gd > ed {
            mapped[best.1].sei_nals.push(SeiRecord { nal: ev.nal.clone(), fingerprint: ev.fingerprint.clone() });
        }
    }
    Ok(mapped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(n: u8) -> SeiRecord {
        SeiRecord { nal: vec![6, n], fingerprint: format!("f{n}") }
    }
    fn timeline(samples: Vec<(i64, i64, Vec<SeiRecord>)>) -> Timeline {
        let mut events = vec![];
        let ss = samples
            .into_iter()
            .enumerate()
            .map(|(i, (pts, dur, seis))| {
                for r in &seis {
                    events.push(Event { source_sample_index: i, source_pts_us: pts, nal: r.nal.clone(), fingerprint: r.fingerprint.clone() });
                }
                TimelineSample { sample_index: i, pts_us: pts, duration_us: dur, has_telemetry: !seis.is_empty(), sei_nals: seis }
            })
            .collect();
        Timeline {
            timescale: 1000,
            length_size: 4,
            samples: ss,
            events,
            lead_in: LeadIn { frames: Some(0), hold: 0, sync_sample_index: Some(0), reason: None, timescale: None, duration_ticks: None },
            undecodable: Undecodable { frames: Some(0), samples: vec![], reason: None, timescale: None, duration_ticks: None },
        }
    }
    fn outs(n: usize) -> Vec<OutputSample> {
        (0..n).map(|i| OutputSample { pts_us: i as f64 * 33_333.0, duration_us: Some(33_333.0) }).collect()
    }

    #[test]
    fn zero_duration_tail_goes_to_the_last_picture() {
        let t = timeline(vec![(0, 33_333, vec![rec(1)]), (33_333, 33_333, vec![rec(2)]), (66_666, 0, vec![rec(3)])]);
        let m = map_to_output(&t, &outs(2)).unwrap();
        assert_eq!(m[0].sei_nals, vec![rec(1)]);
        assert_eq!(m[1].sei_nals, vec![rec(2), rec(3)]);
    }

    #[test]
    fn dropped_sample_records_go_to_the_frame_before() {
        let mut t = timeline((0..5).map(|i| (i * 33_333, 33_333, vec![rec(i as u8)])).collect());
        t.undecodable = Undecodable { frames: Some(1), samples: vec![2], reason: None, timescale: Some(1000), duration_ticks: Some(vec![33, 67, 33, 33]) };
        let m = map_to_output(&t, &outs(4)).unwrap();
        assert_eq!(m[1].sei_nals, vec![rec(1), rec(2)]);
        assert_eq!(m[2].sei_nals, vec![rec(3)]);
    }

    // B-frames: the encoder stores pictures 0 3 1 2 6 4 5 ... (each P before
    // the B pictures shown ahead of it), so sample n is not the n-th picture shown
    fn reordered(shown_at: &[usize]) -> Vec<OutputSample> {
        shown_at.iter().map(|&k| OutputSample { pts_us: k as f64 * 33_333.0, duration_us: Some(33_333.0) }).collect()
    }

    #[test]
    fn each_record_goes_to_the_picture_shown_in_its_place() {
        let order = [0, 3, 1, 2, 6, 4, 5, 9, 7, 8, 11, 10];
        let t = timeline((0..12).map(|i| (i * 33_333, 33_333, vec![rec(i as u8)])).collect());
        let m = map_to_output(&t, &reordered(&order)).unwrap();
        for (sample, &k) in order.iter().enumerate() {
            assert_eq!(m[sample].sei_nals, vec![rec(k as u8)], "sample {sample} is the picture shown {k}th");
        }
        let mut tail = timeline((0..13).map(|i| (i * 33_333, if i == 12 { 0 } else { 33_333 }, vec![rec(i as u8)])).collect());
        tail.samples[12].pts_us = 12 * 33_333;
        let m = map_to_output(&tail, &reordered(&order)).unwrap();
        assert_eq!(m[10].sei_nals, vec![rec(11), rec(12)], "the zero-duration tail goes to the last picture shown, not the last sample");
        assert_eq!(m[11].sei_nals, vec![rec(10)]);
    }

    #[test]
    fn a_dropped_sample_goes_to_the_picture_shown_before_it() {
        let mut t = timeline((0..13).map(|i| (i * 33_333, 33_333, vec![rec(i as u8)])).collect());
        t.undecodable = Undecodable { frames: Some(1), samples: vec![4], reason: None, timescale: Some(1000), duration_ticks: None };
        let order = [0, 3, 1, 2, 6, 4, 5, 9, 7, 8, 11, 10];
        let m = map_to_output(&t, &reordered(&order)).unwrap();
        assert_eq!(m[1].sei_nals, vec![rec(3), rec(4)], "sample 1 is the 4th picture shown");
        assert_eq!(m[5].sei_nals, vec![rec(5)]);
        assert_eq!(m[4].sei_nals, vec![rec(7)]);
    }

    #[test]
    fn timestamp_mapping_within_one_frame_and_not_nearer_a_gap() {
        // 3 samples, 2 outputs: not ordinal
        let t = timeline(vec![(0, 33_333, vec![rec(1)]), (33_333, 33_333, vec![]), (500_000, 33_333, vec![rec(3)])]);
        let m = map_to_output(&t, &outs(2)).unwrap();
        assert_eq!(m[0].sei_nals, vec![rec(1)]);
        assert!(m[1].sei_nals.is_empty(), "too far, and the gap sample is as near");
    }
}
