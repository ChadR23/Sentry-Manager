//! src/main/converter/converterAdapters.js: the encode's sample times, and
//! the telemetry writer that rewrites a candidate in place (refusing when
//! the file changed identity while it was being rewritten).

use super::error::{CError, CResult};
use super::lead_in::{retime_to_source, source_timing_for};
use super::mp4w::{self, be32};
use super::timeline::{map_to_output, OutputSample, Timeline};
use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

fn safe_time(value: i128, timescale: u32) -> CResult<f64> {
    // BigInt division truncates toward zero
    let micros = (value * 1_000_000) / timescale as i128;
    if micros.abs() > mp4w::MAX_SAFE as i128 {
        return Err(CError::new("INVALID_MP4", "unsafe sample time"));
    }
    Ok(micros as f64)
}

/// outputTiming(bytes)
pub fn output_timing(bytes: &[u8]) -> CResult<Vec<OutputSample>> {
    let tree = mp4w::parse(bytes)?;
    let (track, _) = mp4w::select_video_track(&tree)?;
    let mdhd = tree.find(track, b"mdhd");
    if mdhd.len() != 1 {
        return Err(CError::new("INVALID_MP4", "missing media timescale"));
    }
    let n = tree.node(mdhd[0]);
    let off = n.content as usize;
    let v = bytes[off];
    if v != 0 && v != 1 {
        return Err(CError::new("INVALID_MP4", "unsupported media header"));
    }
    let at = off + if v == 1 { 20 } else { 12 };
    if at + 4 > n.end as usize {
        return Err(CError::new("INVALID_MP4", "truncated media header"));
    }
    let ts = be32(bytes, at);
    if ts == 0 {
        return Err(CError::new("INVALID_MP4", "invalid media timescale"));
    }
    mp4w::build_sample_index(&tree, track)?
        .iter()
        .map(|s| Ok(OutputSample { pts_us: safe_time(s.pts, ts)?, duration_us: Some(safe_time(s.duration as i128, ts)?) }))
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    H265,
    Av1,
}

/// The encode with the original's telemetry (and, where needed, timing).
pub fn telemetry_bytes(encoded: &[u8], timeline: &Timeline, codec: Codec) -> CResult<Vec<u8>> {
    let timing = source_timing_for(Some(&timeline.lead_in), Some(&timeline.undecodable));
    let retimed;
    let bytes: &[u8] = match timing {
        Some((ts, ticks)) => {
            retimed = retime_to_source(encoded, ts, &ticks)?;
            &retimed
        }
        None => encoded,
    };
    let mapped = map_to_output(timeline, &output_timing(bytes)?)?;
    match codec {
        Codec::H265 => super::h265::inject(bytes, &mapped),
        Codec::Av1 => super::av1::inject(bytes, &mapped),
    }
}

/// writer(inject)({ candidatePath, timeline, signal })
pub fn write_telemetry(candidate: &Path, timeline: &Timeline, codec: Codec, cancelled: &AtomicBool) -> CResult<()> {
    if cancelled.load(Ordering::SeqCst) {
        return Err(CError::new("CANCELLED", "cancelled"));
    }
    let mut f = OpenOptions::new().read(true).write(true).open(candidate)?;
    let before = f.metadata()?;
    let mut encoded = Vec::with_capacity(before.len() as usize);
    f.read_to_end(&mut encoded)?;
    let output = telemetry_bytes(&encoded, timeline, codec)?;
    if cancelled.load(Ordering::SeqCst) {
        return Err(CError::new("CANCELLED", "cancelled"));
    }
    let same = |m: &std::fs::Metadata| m.dev() == before.dev() && m.ino() == before.ino();
    if !same(&f.metadata()?) {
        return Err(CError::new("CANDIDATE_CHANGED", "candidate changed"));
    }
    f.set_len(0)?;
    super::fs_hook::event("truncated", candidate);
    f.seek(SeekFrom::Start(0))?;
    f.write_all(&output)?;
    f.sync_all()?;
    let after = f.metadata()?;
    if !same(&after) || after.size() != output.len() as u64 {
        return Err(CError::new("CANDIDATE_CHANGED", "candidate changed"));
    }
    Ok(())
}
