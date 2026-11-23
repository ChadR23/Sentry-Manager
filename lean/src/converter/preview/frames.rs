//! Timestamp-proven native frames and a deterministic shared detail crop.
use super::{command, err, words, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::{Path, PathBuf}, sync::{Arc, atomic::AtomicBool}};

pub(super) struct Probe {
    pub width: usize,
    pub height: usize,
    pub times: Vec<i64>,
    pub duration_us: i64,
}
impl Probe {
    pub fn frame_duration(&self) -> i64 {
        self.times.windows(2).map(|t| t[1] - t[0]).max().unwrap_or(self.duration_us).max(1)
    }
    pub fn matches(&self, times: &[i64], width: usize, height: usize) -> Result<()> {
        if self.width != width || self.height != height || self.times.len() != times.len() || times.is_empty()
            || self.times.iter().zip(times).any(|(a,b)| a.abs_diff(*b) > 2) {
            return Err("PREVIEW_FRAME_TIMING_MISMATCH".into());
        }
        Ok(())
    }
}

pub(super) fn probe(ffprobe: &str, path: &Path, keyframes: bool, cancel: &Arc<AtomicBool>) -> Result<Probe> {
    let mut args = words(&["-v", "error", "-select_streams", "v:0"]);
    if keyframes { args.extend(words(&["-skip_frame", "nokey"])); }
    args.extend(words(&["-show_frames", "-show_entries", "frame=best_effort_timestamp_time:stream=width,height,duration:format=duration", "-of", "json", path.to_str().ok_or("INVALID_SOURCE_PATH")?]));
    let r = command(ffprobe, &args, cancel)?;
    let v: Value = serde_json::from_str(&r.stdout).map_err(err)?;
    let micros = |v: &Value| -> Result<i64> {
        let n = v.as_str().ok_or("PREVIEW_INVALID_TIMESTAMP")?.parse::<f64>().map_err(err)? * 1_000_000.0;
        if !n.is_finite() || n.abs() >= i64::MAX as f64 { return Err("PREVIEW_INVALID_TIMESTAMP".into()); }
        Ok(n.round() as i64)
    };
    let stream = &v["streams"][0];
    let times = v["frames"].as_array().ok_or("PREVIEW_NO_FRAMES")?.iter().map(|f| micros(&f["best_effort_timestamp_time"])).collect::<Result<Vec<_>>>()?;
    if times.is_empty() { return Err("PREVIEW_NO_FRAMES".into()); }
    Ok(Probe { width: stream["width"].as_u64().ok_or("PREVIEW_NO_DIMENSIONS")? as usize,
        height: stream["height"].as_u64().ok_or("PREVIEW_NO_DIMENSIONS")? as usize, times,
        duration_us: micros(stream.get("duration").unwrap_or(&v["format"]["duration"]))? })
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Crop { pub x: usize, pub y: usize, pub width: usize, pub height: usize }

/// Of 5x5 candidate centres, choose the highest grayscale variance in a 64x48
/// patch, breaking ties by mean brightness, then row/column order. Compute once
/// on the original RGB frame. Round 22% width to a multiple of four for exact 4:3.
fn detail_crop(rgb: &[u8], width: usize, height: usize) -> Result<Crop> {
    if width < 4 || height < 3 { return Err("PREVIEW_FRAME_TOO_SMALL".into()); }
    let units = ((width as f64 * 0.22 / 4.0).round() as usize).max(1).min(width / 4).min(height / 3);
    let (w, h) = (units * 4, units * 3);
    let mut best = Crop { x: 0, y: 0, width: w, height: h };
    let mut score = (-1.0, -1.0);
    for row in 0..5 {
        for col in 0..5 {
            let (x, y) = ((width - w) * col / 4, (height - h) * row / 4);
            let (pw, ph) = (64.min(width), 48.min(height));
            let px = (x + w / 2).saturating_sub(pw / 2).min(width - pw);
            let py = (y + h / 2).saturating_sub(ph / 2).min(height - ph);
            let (mut sum, mut square) = (0.0, 0.0);
            for yy in py..py + ph {
                for xx in px..px + pw {
                    let i = (yy * width + xx) * 3;
                    let gray = (77 * rgb[i] as u32 + 150 * rgb[i + 1] as u32 + 29 * rgb[i + 2] as u32) as f64 / 256.0;
                    sum += gray; square += gray * gray;
                }
            }
            let mean = sum / (pw * ph) as f64;
            let candidate = (square / (pw * ph) as f64 - mean * mean, mean);
            if candidate > score { score = candidate; best.x = x; best.y = y; }
        }
    }
    Ok(best)
}

pub(super) fn save(ffmpeg: &str, video: &Path, probe: &Probe, index: usize, crop: Option<Crop>, cancel: &Arc<AtomicBool>) -> Result<(PathBuf, PathBuf, Crop)> {
    if index >= probe.times.len() { return Err("PREVIEW_NO_FRAME_AT_TIMESTAMP".into()); }
    // The caller has compared every decoded presentation timestamp. This ordinal
    // therefore refers to the same source instant, including reordered encodes.
    let raw = video.with_extension("rgb");
    command(ffmpeg, &words(&["-nostdin", "-v", "error", "-n", "-i", video.to_str().unwrap(), "-vf", &format!("select=eq(n\\,{index})"),
        "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", raw.to_str().unwrap()]), cancel)?;
    let rgb = fs::read(&raw).map_err(err)?;
    if rgb.len() != probe.width.checked_mul(probe.height).and_then(|n| n.checked_mul(3)).ok_or("PREVIEW_FRAME_TOO_LARGE")? { return Err("PREVIEW_INVALID_FRAME".into()); }
    let crop = match crop { Some(c) => c, None => detail_crop(&rgb, probe.width, probe.height)? };
    let frame = video.with_extension("jpg");
    let zoom = video.with_file_name(format!("{}-zoom.jpg", video.file_stem().unwrap().to_string_lossy()));
    for (target, filter) in [(&frame, "null".into()), (&zoom, format!("crop={}:{}:{}:{}:exact=1", crop.width, crop.height, crop.x, crop.y))] {
        // Controller ruling: FFmpeg MJPEG qscale 2 is the accepted quality-90 equivalent.
        // Both images come from raw pixels; the zoom never recompresses the full JPEG.
        command(ffmpeg, &words(&["-nostdin", "-v", "error", "-n", "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", &format!("{}x{}", probe.width, probe.height),
            "-i", raw.to_str().unwrap(), "-vf", &filter, "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "2", "-pix_fmt", "yuvj444p", target.to_str().unwrap()]), cancel)?;
    }
    fs::remove_file(raw).map_err(err)?;
    Ok((frame, zoom, crop))
}
