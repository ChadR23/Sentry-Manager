//! src/main/converter/mp4Header.js: the video codec of an MP4 from its
//! header alone (the top-level box headers, then only the moov box, then the
//! first video track's sample entry). A few small reads per clip, so
//! discovery tells a converted clip from an original without ffprobe.
//! Anything unexpected answers None; file system errors (a share that is
//! down) are returned so the caller can wait for the share.

use std::fs::File;
use std::io;
use std::os::unix::fs::FileExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

pub const MAX_MOOV_BYTES: usize = 4 * 1024 * 1024;
const MAX_TOP_BOXES: usize = 64;
const HEAD_READ_BYTES: u64 = 4 * 1024;
const MOOV_READ_BYTES: u64 = 128 * 1024;

/// The error a cancel answers with (code CANCELLED).
pub fn cancelled() -> io::Error {
    io::Error::new(io::ErrorKind::Interrupted, "CANCELLED")
}

pub fn is_cancelled(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::Interrupted && e.to_string() == "CANCELLED"
}

/// The reads the header check makes (tests count them).
pub trait ReadAt {
    fn size(&self) -> io::Result<u64>;
    fn read_at(&self, buf: &mut [u8], at: u64) -> io::Result<usize>;
}

impl ReadAt for File {
    fn size(&self) -> io::Result<u64> {
        Ok(self.metadata()?.len())
    }
    fn read_at(&self, buf: &mut [u8], at: u64) -> io::Result<usize> {
        FileExt::read_at(self, buf, at)
    }
}

/// codecForSampleEntry
pub fn codec_for_sample_entry(entry: &str) -> Option<&'static str> {
    match entry {
        "avc1" | "avc3" => Some("h264"),
        "hvc1" | "hev1" => Some("h265"),
        "av01" => Some("av1"),
        _ => None,
    }
}

fn be32(b: &[u8], at: usize) -> u64 {
    u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]) as u64
}

fn be64(b: &[u8], at: usize) -> u64 {
    u64::from_be_bytes(b[at..at + 8].try_into().unwrap())
}

fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| c as char).collect()
}

struct Box_ {
    kind: String,
    start: usize,
    end: usize,
}

fn child_boxes(b: &[u8], start: usize, end: usize) -> Vec<Box_> {
    let mut out = vec![];
    let mut at = start;
    while at + 8 <= end {
        let mut size = be32(b, at);
        let kind = latin1(&b[at + 4..at + 8]);
        let mut header = 8u64;
        if size == 1 {
            if at + 16 > end {
                break;
            }
            let large = be64(b, at + 8);
            if large > (end - at) as u64 {
                break;
            }
            size = large;
            header = 16;
        } else if size == 0 {
            size = (end - at) as u64;
        }
        if size < header || at as u64 + size > end as u64 {
            break;
        }
        out.push(Box_ { kind, start: at + header as usize, end: at + size as usize });
        at += size as usize;
    }
    out
}

fn find_child(b: &[u8], bx: &Box_, kind: &str) -> Option<Box_> {
    child_boxes(b, bx.start, bx.end).into_iter().find(|c| c.kind == kind)
}

/// videoSampleEntry(moov payload)
pub fn video_sample_entry(moov: &[u8]) -> Option<String> {
    for trak in child_boxes(moov, 0, moov.len()) {
        if trak.kind != "trak" {
            continue;
        }
        let Some(mdia) = find_child(moov, &trak, "mdia") else { continue };
        let Some(hdlr) = find_child(moov, &mdia, "hdlr") else { continue };
        if hdlr.end - hdlr.start < 12 || &moov[hdlr.start + 8..hdlr.start + 12] != b"vide" {
            continue;
        }
        let stsd = find_child(moov, &mdia, "minf").and_then(|m| find_child(moov, &m, "stbl")).and_then(|s| find_child(moov, &s, "stsd"));
        let stsd = stsd?;
        if stsd.end - stsd.start < 16 || be32(moov, stsd.start + 4) < 1 {
            return None;
        }
        let entry_size = be32(moov, stsd.start + 8) as usize;
        if entry_size < 8 || stsd.start + 8 + entry_size > stsd.end {
            return None;
        }
        return Some(latin1(&moov[stsd.start + 12..stsd.start + 16]));
    }
    None
}

pub struct ReadOptions<'a> {
    pub size: Option<u64>,
    pub cancel: Option<&'a AtomicBool>,
    pub max_moov_bytes: usize,
}

impl Default for ReadOptions<'_> {
    fn default() -> Self {
        ReadOptions { size: None, cancel: None, max_moov_bytes: MAX_MOOV_BYTES }
    }
}

/// readVideoSampleEntry over an open file
pub fn read_sample_entry_from(f: &dyn ReadAt, o: &ReadOptions) -> io::Result<Option<String>> {
    let size = match o.size {
        Some(s) => s,
        None => f.size()?,
    };
    if size < 8 {
        return Ok(None);
    }
    let check = || -> io::Result<()> {
        if o.cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
            return Err(cancelled());
        }
        Ok(())
    };
    let read = |position: u64, length: u64| -> io::Result<Vec<u8>> {
        check()?;
        let len = length.min(size.saturating_sub(position)) as usize;
        let mut buf = vec![0u8; len];
        let mut filled = 0;
        // a short read is not the end of the file on every filesystem (SMB)
        while filled < len {
            let n = f.read_at(&mut buf[filled..], position + filled as u64)?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        buf.truncate(filled);
        Ok(buf)
    };
    let mut chunk = read(0, HEAD_READ_BYTES)?;
    let mut chunk_at = 0u64;
    let mut at = 0u64;
    let mut index = 0;
    while index < MAX_TOP_BOXES && at + 8 <= size {
        index += 1;
        if at < chunk_at || at + 16 > chunk_at + chunk.len() as u64 {
            chunk = read(at, MOOV_READ_BYTES)?;
            chunk_at = at;
            if chunk.len() < 8 {
                return Ok(None);
            }
        }
        let offset = (at - chunk_at) as usize;
        let mut box_size = be32(&chunk, offset);
        let kind = &chunk[offset + 4..offset + 8];
        let mut header = 8u64;
        if box_size == 1 {
            if chunk.len() < offset + 16 {
                return Ok(None);
            }
            let large = be64(&chunk, offset + 8);
            if large > 9_007_199_254_740_991 {
                return Ok(None);
            }
            box_size = large;
            header = 16;
        } else if box_size == 0 {
            box_size = size - at;
        }
        if box_size < header || at + box_size > size {
            return Ok(None);
        }
        if kind == b"moov" {
            let length = box_size - header;
            if length > o.max_moov_bytes as u64 {
                return Ok(None);
            }
            let start = at + header;
            let moov = if start >= chunk_at && start + length <= chunk_at + chunk.len() as u64 {
                chunk[(start - chunk_at) as usize..(start - chunk_at + length) as usize].to_vec()
            } else {
                read(start, length)?
            };
            if moov.len() as u64 != length {
                return Ok(None);
            }
            return Ok(video_sample_entry(&moov));
        }
        at += box_size;
    }
    Ok(None)
}

/// readVideoSampleEntry(filePath, options)
pub fn read_video_sample_entry(path: &Path, o: &ReadOptions) -> io::Result<Option<String>> {
    if o.cancel.is_some_and(|c| c.load(Ordering::SeqCst)) {
        return Err(cancelled());
    }
    let f = File::open(path)?;
    read_sample_entry_from(&f, o)
}

/// readMp4VideoCodec: 'h264', 'h265', 'av1', or None
pub fn read_mp4_video_codec(path: &Path, o: &ReadOptions) -> io::Result<Option<&'static str>> {
    Ok(read_video_sample_entry(path, o)?.and_then(|e| codec_for_sample_entry(&e)))
}

#[cfg(test)]
mod tests {
    //! test/mp4Header.test.js
    use super::*;
    use std::process::Command;
    use std::sync::atomic::AtomicUsize;

    fn has_encoder(name: &str) -> bool {
        Command::new("ffmpeg").args(["-hide_banner", "-encoders"]).output().map(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().any(|w| w == name)).unwrap_or(false)
    }

    fn encode(file: &Path, encoder: &str, extra: &[&str], source: &str) {
        let mut a: Vec<String> = ["-v", "error", "-y", "-f", "lavfi", "-i", source, "-c:v", encoder].iter().map(|s| s.to_string()).collect();
        match encoder {
            "libx265" => a.extend(["-preset", "ultrafast", "-x265-params", "log-level=error"].iter().map(|s| s.to_string())),
            "libsvtav1" => a.extend(["-preset", "12"].iter().map(|s| s.to_string())),
            _ => {}
        }
        a.extend(["-pix_fmt", "yuv420p"].iter().map(|s| s.to_string()));
        a.extend(extra.iter().map(|s| s.to_string()));
        a.push(file.to_string_lossy().to_string());
        let r = Command::new("ffmpeg").args(&a).output().unwrap();
        assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
    }

    const SRC: &str = "testsrc2=size=320x240:rate=12:duration=1";

    fn top_boxes(file: &Path) -> Vec<String> {
        let b = std::fs::read(file).unwrap();
        let mut out = vec![];
        let mut at = 0;
        while at + 8 <= b.len() {
            let size = be32(&b, at) as usize;
            out.push(latin1(&b[at + 4..at + 8]));
            if size < 8 {
                break;
            }
            at += size;
        }
        out
    }

    struct Counting(File, AtomicUsize, AtomicUsize);
    impl ReadAt for Counting {
        fn size(&self) -> io::Result<u64> {
            self.0.size()
        }
        fn read_at(&self, buf: &mut [u8], at: u64) -> io::Result<usize> {
            self.1.fetch_add(1, Ordering::SeqCst);
            let n = FileExt::read_at(&self.0, buf, at)?;
            self.2.fetch_add(n, Ordering::SeqCst);
            Ok(n)
        }
    }

    #[test]
    fn codecs_with_the_moov_at_either_end_and_only_headers_read() {
        if !has_encoder("libx264") || !has_encoder("libx265") {
            eprintln!("skipped: needs ffmpeg with libx264 and libx265");
            return;
        }
        let dir = super::super::testutil::tempdir().unwrap();
        let cases: [(&str, &[&str], &str, &str, &str); 5] = [
            ("libx264", &[], "avc1", "h264", "end"),
            ("libx264", &["-movflags", "+faststart"], "avc1", "h264", "start"),
            ("libx265", &["-tag:v", "hvc1"], "hvc1", "h265", "end"),
            ("libx265", &["-tag:v", "hvc1", "-movflags", "+faststart"], "hvc1", "h265", "start"),
            ("libx265", &["-tag:v", "hev1"], "hev1", "h265", "end"),
        ];
        for (n, (enc, extra, entry, codec, wh)) in cases.iter().enumerate() {
            let file = dir.path().join(format!("{n}.mp4"));
            encode(&file, enc, extra, SRC);
            let boxes = top_boxes(&file);
            let moov = boxes.iter().position(|b| b == "moov").unwrap();
            let mdat = boxes.iter().position(|b| b == "mdat").unwrap();
            assert_eq!(moov < mdat, *wh == "start");
            assert_eq!(read_video_sample_entry(&file, &ReadOptions::default()).unwrap().as_deref(), Some(*entry));
            assert_eq!(read_mp4_video_codec(&file, &ReadOptions::default()).unwrap(), Some(*codec));
        }
        if has_encoder("libsvtav1") {
            for extra in [&[][..], &["-movflags", "+faststart"][..]] {
                let file = dir.path().join(format!("av1-{}.mp4", extra.len()));
                encode(&file, "libsvtav1", extra, SRC);
                assert_eq!(read_video_sample_entry(&file, &ReadOptions::default()).unwrap().as_deref(), Some("av01"));
                assert_eq!(read_mp4_video_codec(&file, &ReadOptions::default()).unwrap(), Some("av1"));
            }
        }
        // a few MB of media data in front of the moov: two small reads
        let big = dir.path().join("big.mp4");
        encode(&big, "libx264", &["-preset", "ultrafast", "-crf", "1"], "testsrc2=size=640x480:rate=12:duration=3,noise=alls=60:allf=t");
        let size = std::fs::metadata(&big).unwrap().len();
        assert!(size > 2 * 1024 * 1024);
        assert_eq!(top_boxes(&big).last().map(String::as_str), Some("moov"));
        let c = Counting(File::open(&big).unwrap(), AtomicUsize::new(0), AtomicUsize::new(0));
        let entry = read_sample_entry_from(&c, &ReadOptions { size: Some(size), ..Default::default() }).unwrap();
        assert_eq!(entry.as_deref().and_then(codec_for_sample_entry), Some("h264"));
        assert!(c.1.load(Ordering::SeqCst) <= 2 && c.2.load(Ordering::SeqCst) < 64 * 1024);

        // cut off, damaged, not an MP4: None
        let at_end = dir.path().join("whole-end.mp4");
        let at_start = dir.path().join("whole-start.mp4");
        encode(&at_end, "libx264", &[], SRC);
        encode(&at_start, "libx264", &["-movflags", "+faststart"], SRC);
        let end = std::fs::read(&at_end).unwrap();
        let start = std::fs::read(&at_start).unwrap();
        let moov_at = |b: &[u8]| b.windows(4).position(|w| w == b"moov").unwrap() - 4;
        let mut oversized = vec![0x7f, 0xff, 0xff, 0xff];
        oversized.extend(b"ftyp");
        oversized.extend([0u8; 32]);
        let mut damaged = start.clone();
        let stsd = damaged.windows(4).position(|w| w == b"stsd").unwrap();
        damaged[stsd + 16..stsd + 20].copy_from_slice(b"xyz1");
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("cut-before-moov", end[..end.len() / 2].to_vec()),
            ("cut-inside-moov", end[..moov_at(&end) + 64].to_vec()),
            ("cut-inside-faststart-moov", start[..moov_at(&start) + 64].to_vec()),
            ("only-ftyp", end[..be32(&end, 0) as usize].to_vec()),
            ("empty", vec![]),
            ("junk", b"not a video at all, just some bytes in a file".to_vec()),
            ("zeros", vec![0; 4096]),
            ("oversized-box", oversized),
            ("unknown-entry", damaged),
        ];
        for (name, bytes) in cases {
            let f = dir.path().join(format!("{name}.mp4"));
            std::fs::write(&f, bytes).unwrap();
            assert_eq!(read_mp4_video_codec(&f, &ReadOptions::default()).unwrap(), None, "{name}");
        }
        assert_eq!(read_video_sample_entry(&dir.path().join("unknown-entry.mp4"), &ReadOptions::default()).unwrap().as_deref(), Some("xyz1"));
        assert_eq!(read_mp4_video_codec(&at_start, &ReadOptions { max_moov_bytes: 64, ..Default::default() }).unwrap(), None);
        assert_eq!(codec_for_sample_entry("mp4v"), None);
        assert_eq!(codec_for_sample_entry("toString"), None);
    }

    #[test]
    fn a_missing_file_is_an_error_and_a_cancel_stops_it() {
        let e = read_mp4_video_codec(Path::new("/nonexistent/missing.mp4"), &ReadOptions::default()).unwrap_err();
        assert_eq!(e.kind(), io::ErrorKind::NotFound);
        let c = AtomicBool::new(true);
        let e = read_mp4_video_codec(Path::new("/share/clip.mp4"), &ReadOptions { cancel: Some(&c), ..Default::default() }).unwrap_err();
        assert!(is_cancelled(&e));
    }
}
