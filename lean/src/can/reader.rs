//! Reading a stored CAN Bridge log (<name>.log.xz) as candump text, in either
//! format the bridge writes (server/canLogReader.js): `xz -dc` and its lines
//! as they come (canbridge-candump-xz/1), or a columns body collected whole
//! (bounded) and decoded (canbridge-columns-xz/2). The format is told by the
//! first bytes. The stored file is never changed.
//!
//! Bounds as in Node: lines over 512 bytes skipped, at most 4 GB of text a
//! log, a columns body of at most 64 MB holding at most 8 million frames,
//! one decoder slot for the indexer and one for downloads.

use super::columns;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

pub const FORMAT_CANDUMP: &str = "canbridge-candump-xz/1";
pub const FORMAT_COLUMNS: &str = "canbridge-columns-xz/2";
pub const FORMATS: [&str; 2] = [FORMAT_CANDUMP, FORMAT_COLUMNS];
pub const MAX_LINE: usize = 512;
pub const MAX_UNPACKED: u64 = 4 * 1024 * 1024 * 1024;
pub const MAX_COLUMNS_BODY: u64 = 64 * 1024 * 1024;
pub const MAX_FRAMES: f64 = 8_000_000.0;
const CHUNK: usize = 256 * 1024;

#[derive(Debug, Clone)]
pub struct LogError {
    pub message: String,
    /// not the log's fault (xz could not start, or the decoder is busy): try again later
    pub retry: bool,
    pub busy: bool,
    /// CAN_LOG_REFUSED: a columns log this server will not read
    pub refused: bool,
}

impl LogError {
    fn retry(msg: String) -> Self {
        LogError { message: msg, retry: true, busy: false, refused: false }
    }
    fn refused(name: &str, why: &str) -> Self {
        LogError { message: format!("could not read {} ({}): {}", name, FORMAT_COLUMNS, why), retry: false, busy: false, refused: true }
    }
}

fn mb(n: u64) -> String {
    if n >= 1024 * 1024 {
        format!("{} MB", crate::can::json::num_str(crate::can::json::round(n as f64 / (1024.0 * 1024.0))))
    } else {
        format!("{} KB", crate::can::json::num_str(crate::can::json::round(n as f64 / 1024.0)))
    }
}

// ---- decoder slots: one for the indexer, one for downloads
struct Pool {
    busy: Mutex<bool>,
    cv: Condvar,
}
static INDEX: Pool = Pool { busy: Mutex::new(false), cv: Condvar::new() };
static DOWNLOAD: Pool = Pool { busy: Mutex::new(false), cv: Condvar::new() };

pub struct Slot(&'static Pool);
impl Drop for Slot {
    fn drop(&mut self) {
        *self.0.busy.lock().unwrap() = false;
        self.0.cv.notify_one();
    }
}

fn slot(download: bool, wait: Option<Duration>) -> Result<Slot, LogError> {
    let p = if download { &DOWNLOAD } else { &INDEX };
    let mut b = p.busy.lock().unwrap();
    let until = wait.map(|w| Instant::now() + w);
    while *b {
        match until {
            None => b = p.cv.wait(b).unwrap(),
            Some(u) => {
                let now = Instant::now();
                if now >= u {
                    return Err(LogError { message: "the columns decoder is busy with another download".into(), retry: true, busy: true, refused: false });
                }
                b = p.cv.wait_timeout(b, u - now).unwrap().0;
            }
        }
    }
    *b = true;
    Ok(Slot(p))
}

#[derive(Debug, Clone)]
pub struct Opts {
    pub xz: String,
    pub max_unpacked: u64,
    pub max_body: u64,
    pub max_frames: f64,
    pub download: bool,
    pub slot_wait: Option<Duration>,
}

impl Default for Opts {
    fn default() -> Self {
        Opts { xz: "xz".into(), max_unpacked: MAX_UNPACKED, max_body: MAX_COLUMNS_BODY, max_frames: MAX_FRAMES, download: false, slot_wait: None }
    }
}

/// What reading found: the format (None for an empty file) and why a candump text log ended early.
#[derive(Debug, Default, Clone)]
pub struct Found {
    pub format: Option<&'static str>,
    pub truncated: Option<String>,
}

/// The candump text of a log, in chunks given to `on_chunk` (return false to stop: Ok then).
/// `found` is filled as it goes (the format once the first bytes are in).
pub fn read_chunks(file: &Path, opts: &Opts, found: &mut Found, mut on_chunk: impl FnMut(&[u8]) -> bool) -> Result<(), LogError> {
    let name = file.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut child = Command::new(&opts.xz)
        .arg("-dc")
        .arg(file)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| LogError::retry(format!("xz could not be started for {}: {}", name, e)))?;
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let errs = std::thread::spawn(move || {
        let mut s = Vec::new();
        let _ = (&mut err).take(4096).read_to_end(&mut s);
        let mut sink = [0u8; 4096];
        while matches!(err.read(&mut sink), Ok(n) if n > 0) {}
        String::from_utf8_lossy(&s).into_owned()
    });
    let mut head: Vec<u8> = Vec::new();
    let mut columns: Option<bool> = None;
    let mut body: Vec<u8> = Vec::new();
    let mut total: u64 = 0;
    let mut too_big = false;
    let mut stopped = false;
    let mut _slot: Option<Slot> = None;
    let mut buf = vec![0u8; 64 * 1024];
    let finish = |child: &mut std::process::Child, kill: bool| {
        if kill {
            let _ = child.kill();
        }
        child.wait().ok().and_then(|s| s.code())
    };
    loop {
        let n = match out.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        total += n as u64;
        let mut c: &[u8] = &buf[..n];
        let joined;
        if columns.is_none() {
            head.extend_from_slice(c);
            if head.len() < columns::MAGIC.len() {
                continue;
            }
            joined = std::mem::take(&mut head);
            c = &joined;
            let is = columns::is_columns(c);
            columns = Some(is);
            found.format = Some(if is { FORMAT_COLUMNS } else { FORMAT_CANDUMP });
            if is {
                match slot(opts.download, opts.slot_wait) {
                    Ok(s) => _slot = Some(s),
                    Err(e) => {
                        finish(&mut child, true);
                        return Err(e);
                    }
                }
            }
        }
        let is = columns == Some(true);
        if total > if is { opts.max_body } else { opts.max_unpacked } {
            too_big = true;
            break;
        }
        if is {
            body.extend_from_slice(c);
        } else if !on_chunk(c) {
            stopped = true;
            break;
        }
    }
    if stopped {
        finish(&mut child, true);
        return Ok(());
    }
    if columns.is_none() && !head.is_empty() {
        found.format = Some(FORMAT_CANDUMP);
        if !on_chunk(&head) {
            finish(&mut child, true);
            return Ok(());
        }
    }
    let code = finish(&mut child, too_big);
    let stderr = errs.join().unwrap_or_default();
    let why = {
        let t = stderr.trim();
        if t.is_empty() { format!("exit {}", code.map_or("null".to_string(), |c| c.to_string())) } else { t.chars().take(200).collect() }
    };
    if columns == Some(true) {
        if too_big {
            return Err(LogError::refused(&name, &format!("it unpacks to more than {}, more than the CAN Bridge writes", mb(opts.max_body))));
        }
        if code != Some(0) {
            return Err(LogError::refused(&name, &format!("xz: {}", why)));
        }
        let frames = columns::frame_count(&body);
        if frames > opts.max_frames {
            return Err(LogError::refused(&name, &format!("it holds {} frames, more than the {} a log of the CAN Bridge can", group(frames), group(opts.max_frames))));
        }
        let mut text: Vec<u8> = Vec::with_capacity(CHUNK + 1024);
        let mut sent: u64 = 0;
        let mut over = false;
        let mut stop = false;
        let r = columns::decode(&body, |line| {
            text.extend_from_slice(line);
            text.push(b'\n');
            if text.len() >= CHUNK {
                sent += text.len() as u64;
                if sent > opts.max_unpacked {
                    over = true;
                    return false;
                }
                if !on_chunk(&text) {
                    stop = true;
                    return false;
                }
                text.clear();
            }
            true
        });
        if over {
            return Err(LogError::refused(&name, &format!("it decodes to more than {}", mb(opts.max_unpacked))));
        }
        if stop {
            return Ok(());
        }
        if let Err(e) = r {
            return Err(LogError::refused(&name, &e.chars().take(200).collect::<String>()));
        }
        if !text.is_empty() {
            sent += text.len() as u64;
            if sent > opts.max_unpacked {
                return Err(LogError::refused(&name, &format!("it decodes to more than {}", mb(opts.max_unpacked))));
            }
            on_chunk(&text);
        }
    } else if code != Some(0) || too_big {
        found.truncated = Some(if too_big { format!("it unpacks to more than {} (stopped there)", mb(opts.max_unpacked)) } else { why });
    }
    Ok(())
}

/// toLocaleString('en') of a whole number.
fn group(n: f64) -> String {
    let s = format!("{}", n as i64);
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// The lines of a log (without LF), each at most `max_line` bytes (longer ones skipped).
pub fn read_lines(file: &Path, opts: &Opts, found: &mut Found, max_line: usize, mut on_line: impl FnMut(&[u8]) -> bool) -> Result<(), LogError> {
    let mut rest: Vec<u8> = Vec::new();
    let mut skipping = false;
    let mut stopped = false;
    read_chunks(file, opts, found, |chunk| {
        let mut start = 0;
        while let Some(off) = memchr(b'\n', &chunk[start..]) {
            let nl = start + off;
            if skipping {
                skipping = false;
            } else if rest.is_empty() {
                let line = &chunk[start..nl];
                if line.len() <= max_line && !on_line(line) {
                    stopped = true;
                    return false;
                }
            } else {
                rest.extend_from_slice(&chunk[start..nl]);
                if rest.len() <= max_line && !on_line(&rest) {
                    stopped = true;
                    return false;
                }
            }
            rest.clear();
            start = nl + 1;
        }
        if !skipping {
            rest.extend_from_slice(&chunk[start..]);
            if rest.len() > max_line {
                rest.clear();
                skipping = true;
            }
        }
        true
    })?;
    if !stopped && !skipping && !rest.is_empty() {
        on_line(&rest);
    }
    Ok(())
}

fn memchr(b: u8, s: &[u8]) -> Option<usize> {
    s.iter().position(|&x| x == b)
}
