//! src/main/converter/leadIn.js: frames before a Tesla clip's first keyframe
//! (held by the encoder with tpad), and giving the encode the original's own
//! sample timing, one sample for one sample, proven after the rewrite.

use super::error::{CError, CResult};
use super::frame_num::{undecodable_frames, Undecodable};
use super::mp4w::{self, be32, serialized_header_size, Sample, Tree, ROOT};
use std::collections::HashMap;

const UINT32_MAX: u64 = 0xffff_ffff;

fn e(code: &str, m: impl Into<String>) -> CError {
    CError::new(code, m)
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeadIn {
    /// None: unknown (unreadable, no samples, no keyframe)
    pub frames: Option<usize>,
    pub hold: usize,
    pub sync_sample_index: Option<usize>,
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timescale: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ticks: Option<Vec<u64>>,
}

impl LeadIn {
    fn none() -> LeadIn {
        LeadIn { frames: Some(0), hold: 0, sync_sample_index: Some(0), reason: None, timescale: None, duration_ticks: None }
    }
    fn unknown(reason: &str) -> LeadIn {
        LeadIn { frames: None, hold: 0, sync_sample_index: None, reason: Some(reason.into()), timescale: None, duration_ticks: None }
    }
}

fn sync_sample_numbers(tree: &Tree, stbl: usize) -> CResult<Option<Vec<u32>>> {
    let t = tree.children_of(stbl, b"stss");
    if t.is_empty() {
        return Ok(None);
    }
    if t.len() > 1 {
        return Err(e("INVALID_MP4", "Duplicate stss boxes"));
    }
    let p = tree.payload(t[0])?;
    if p.len() < 8 || p[0] != 0 {
        return Err(e("UNSUPPORTED_CONTAINER", "Unsupported stss box"));
    }
    let count = be32(p, 4) as usize;
    if p.len() < 8 + count * 4 {
        return Err(e("INVALID_MP4", "Truncated stss table"));
    }
    Ok(Some((0..count).map(|i| be32(p, 8 + i * 4)).collect()))
}

/// describeLeadIn(buffer, track, samples, timescale)
pub fn describe(tree: &Tree, track: usize, samples: &[Sample], timescale: u32) -> LeadIn {
    let sync = match mp4w::sample_table(tree, track).and_then(|stbl| sync_sample_numbers(tree, stbl)) {
        Ok(s) => s,
        Err(_) => return LeadIn::unknown("unreadable"),
    };
    if samples.is_empty() {
        return LeadIn::unknown("no-samples");
    }
    let Some(sync) = sync else { return LeadIn::none() };
    let idx: Vec<usize> = sync.iter().filter(|&&n| n >= 1 && n as usize <= samples.len()).map(|&n| n as usize - 1).collect();
    if idx.is_empty() {
        return LeadIn::unknown("no-keyframe");
    }
    let first = *idx.iter().min().unwrap();
    if first == 0 {
        return LeadIn::none();
    }
    let tail = if samples.last().unwrap().duration == 0 { 1 } else { 0 };
    let real = samples.len() - tail;
    let mut r = LeadIn { frames: Some(first), sync_sample_index: Some(first), hold: 0, reason: None, timescale: None, duration_ticks: None };
    if first >= real {
        r.reason = Some("no-decodable-frame".into());
        return r;
    }
    for i in 1..samples.len() {
        if samples[i].pts <= samples[i - 1].pts {
            r.reason = Some("reordered".into());
            return r;
        }
    }
    let mut ticks = Vec::with_capacity(real);
    for s in &samples[..real] {
        if s.duration <= 0 || s.duration as u64 > UINT32_MAX {
            r.reason = Some("timing".into());
            return r;
        }
        ticks.push(s.duration as u64);
    }
    if samples[0].pts != 0 || timescale == 0 {
        r.reason = Some("timing".into());
        return r;
    }
    r.hold = first;
    r.timescale = Some(timescale);
    r.duration_ticks = Some(ticks);
    r
}

/// leadInHoldFrames(timeline)
pub fn hold_frames(lead_in: Option<&LeadIn>) -> usize {
    let Some(l) = lead_in else { return 0 };
    if l.hold == 0 {
        return 0;
    }
    match &l.duration_ticks {
        Some(t) if l.hold < t.len() => l.hold,
        _ => 0,
    }
}

/// The timing the encode takes (sourceTimingFor): (timescale, ticks), or None.
pub fn source_timing_for(lead_in: Option<&LeadIn>, undecodable: Option<&Undecodable>) -> Option<(u32, Vec<u64>)> {
    if undecodable_frames(undecodable) > 0 {
        let u = undecodable.unwrap();
        return match (&u.duration_ticks, u.timescale) {
            (Some(t), Some(ts)) => Some((ts, t.clone())),
            _ => None,
        };
    }
    if hold_frames(lead_in) > 0 {
        let l = lead_in.unwrap();
        return match (&l.duration_ticks, l.timescale) {
            (Some(t), Some(ts)) => Some((ts, t.clone())),
            _ => None,
        };
    }
    None
}

fn stts_payload(durations: &[u64]) -> Vec<u8> {
    let mut entries: Vec<(u32, u64)> = Vec::new();
    for &d in durations {
        match entries.last_mut() {
            Some(l) if l.1 == d => l.0 += 1,
            _ => entries.push((1, d)),
        }
    }
    let mut p = vec![0u8; 8 + entries.len() * 8];
    p[4..8].copy_from_slice(&(entries.len() as u32).to_be_bytes());
    for (i, (c, v)) in entries.iter().enumerate() {
        p[8 + i * 8..12 + i * 8].copy_from_slice(&c.to_be_bytes());
        p[12 + i * 8..16 + i * 8].copy_from_slice(&(*v as u32).to_be_bytes());
    }
    p
}

fn timed_header_payload(tree: &Tree, node: usize, timescale: Option<u32>, duration: u64) -> CResult<Vec<u8>> {
    let o = tree.payload(node)?;
    let typ = tree.typ(node);
    let v = o[0];
    if v != 0 && v != 1 {
        return Err(e("UNSUPPORTED_CONTAINER", format!("Unsupported {} version", mp4w::type_str(&typ))));
    }
    let wide = v == 1 || duration > UINT32_MAX;
    let tw = if v == 1 { 8 } else { 4 };
    let ntw = if wide { 8 } else { 4 };
    let hf = if &typ == b"tkhd" { 8 } else { 4 };
    let old_dur = 4 + tw * 2 + hf;
    let old_rest = old_dur + tw;
    if o.len() < old_rest {
        return Err(e("INVALID_MP4", format!("Truncated {} box", mp4w::type_str(&typ))));
    }
    let read_time = |at: usize| if v == 1 { mp4w::be64(o, at) } else { be32(o, at) as u64 };
    let rest = &o[old_rest..];
    let mut out = Vec::with_capacity(4 + ntw * 3 + hf + rest.len());
    out.push(if wide { 1 } else { 0 });
    out.extend_from_slice(&o[1..4]);
    for at in [4, 4 + tw] {
        let t = read_time(at);
        if wide {
            out.extend_from_slice(&t.to_be_bytes());
        } else {
            out.extend_from_slice(&(t as u32).to_be_bytes());
        }
    }
    let fields_at = out.len();
    out.extend_from_slice(&o[4 + tw * 2..4 + tw * 2 + hf]);
    if let Some(ts) = timescale {
        out[fields_at..fields_at + 4].copy_from_slice(&ts.to_be_bytes());
    }
    if wide {
        out.extend_from_slice(&duration.to_be_bytes());
    } else {
        out.extend_from_slice(&(duration as u32).to_be_bytes());
    }
    out.extend_from_slice(rest);
    Ok(out)
}

fn movie_timescale(tree: &Tree, mvhd: usize) -> CResult<u32> {
    let p = tree.payload(mvhd)?;
    let at = if p[0] == 1 { 20 } else { 12 };
    if p.len() < at + 4 {
        return Err(e("INVALID_MP4", "Truncated mvhd box"));
    }
    let v = be32(p, at);
    if v == 0 {
        return Err(e("INVALID_MP4", "Invalid movie timescale"));
    }
    Ok(v)
}

/// replacements: node -> Some(new payload) or None (leave the box out)
fn serialize(tree: &Tree, i: usize, repl: &HashMap<usize, Option<Vec<u8>>>, out: &mut Vec<u8>) -> CResult<()> {
    let n = tree.node(i);
    let payload: Vec<u8> = if let Some(Some(r)) = repl.get(&i) {
        r.clone()
    } else if !n.children.is_empty() {
        let mut p = Vec::new();
        for &c in &n.children {
            if !matches!(repl.get(&c), Some(None)) {
                serialize(tree, c, repl, &mut p)?;
            }
        }
        p
    } else {
        tree.payload(i)?.to_vec()
    };
    out.extend(mp4w::serialize_box(&n.typ, &payload, n.header)?);
    let _ = serialized_header_size;
    Ok(())
}

/// retimeToSource(encodedMp4, timing)
pub fn retime_to_source(encoded: &[u8], timescale: u32, ticks: &[u64]) -> CResult<Vec<u8>> {
    let tree = mp4w::parse(encoded)?;
    if tree.find(ROOT, b"trak").len() != 1 {
        return Err(e("CONTAINER_INVALID", "Encoded file must hold only the video track"));
    }
    let (track, _) = mp4w::select_video_track(&tree)?;
    if !tree.find(track, b"edts").is_empty() {
        return Err(e("CONTAINER_INVALID", "Encoded track has an edit list"));
    }
    let samples = mp4w::build_sample_index(&tree, track)?;
    if samples.len() != ticks.len() {
        return Err(e("FRAME_COUNT_MISMATCH", format!("Encoded {} frames, the original has {}", samples.len(), ticks.len())));
    }
    for i in 1..samples.len() {
        if samples[i].pts <= samples[i - 1].pts {
            return Err(e("CONTAINER_INVALID", "Encoded frames are reordered"));
        }
    }
    let moovs: Vec<usize> = tree.top().iter().copied().filter(|&c| &tree.typ(c) == b"moov").collect();
    let mdats: Vec<usize> = tree.top().iter().copied().filter(|&c| &tree.typ(c) == b"mdat").collect();
    if moovs.len() != 1 || mdats.is_empty() || mdats.iter().any(|&m| tree.node(m).end > tree.node(moovs[0]).start) {
        return Err(e("CONTAINER_INVALID", "Encoded moov must follow its media data"));
    }
    let stbl = mp4w::sample_table(&tree, track)?;
    let stts = tree.children_of(stbl, b"stts").first().copied();
    let ctts = tree.children_of(stbl, b"ctts");
    let mdhd = tree.find(track, b"mdhd").first().copied();
    let tkhd = tree.find(track, b"tkhd").first().copied();
    let mvhd = tree.find(ROOT, b"mvhd").first().copied();
    let (Some(stts), Some(mdhd), Some(tkhd), Some(mvhd)) = (stts, mdhd, tkhd, mvhd) else {
        return Err(e("CONTAINER_INVALID", "Encoded track is missing timing boxes"));
    };
    let total: u128 = ticks.iter().map(|&t| t as u128).sum();
    let mts = movie_timescale(&tree, mvhd)? as u128;
    let movie = ((total * mts + timescale as u128 / 2) / timescale as u128) as u64;
    let mut repl: HashMap<usize, Option<Vec<u8>>> = HashMap::new();
    repl.insert(stts, Some(stts_payload(ticks)));
    repl.insert(mdhd, Some(timed_header_payload(&tree, mdhd, Some(timescale), total as u64)?));
    repl.insert(tkhd, Some(timed_header_payload(&tree, tkhd, None, movie)?));
    repl.insert(mvhd, Some(timed_header_payload(&tree, mvhd, None, movie)?));
    for c in ctts {
        repl.insert(c, None);
    }
    let mut out = Vec::with_capacity(encoded.len() + 64);
    for &c in tree.top() {
        serialize(&tree, c, &repl, &mut out)?;
    }
    // Prove it: the same samples at the same bytes, the original timing.
    let t2 = mp4w::parse(&out)?;
    let (tr2, _) = mp4w::select_video_track(&t2)?;
    let check = mp4w::build_sample_index(&t2, tr2)?;
    let mut pts: i128 = 0;
    let same = check.len() == samples.len()
        && check.iter().enumerate().all(|(i, s)| {
            let expected = ticks[i] as i128;
            let ok = s.offset == samples[i].offset && s.size == samples[i].size && s.dts == pts && s.pts == pts && s.duration as i128 == expected;
            pts += expected;
            ok
        });
    if !same {
        return Err(e("CONTAINER_INVALID", "Retimed track does not match the original timing"));
    }
    Ok(out)
}
