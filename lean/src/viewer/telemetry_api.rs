//! /api/telemetry (server/telemetry.js Telemetry.forFile): a clip's records
//! for the dashboard, [timestamp ms, base64 record] per frame, read with
//! telemetry.rs and cached under DATA_PATH/telemetry by file, size and
//! modification time (the Node server's names: sha1 of "t2|path|size|mtime"),
//! so a converted clip (new size and time) is read again. At most
//! `telemetryReads` clips are read at once; the cache keeps the newest 4,000.

use super::js;
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};

const MAX_FILE: u64 = 1024 * 1024 * 1024;
const MAX_CACHE_FILES: usize = 4000;

/// scanner.js limiter: at most max() at once, read each time.
pub struct Limiter {
    max: Box<dyn Fn() -> usize + Send + Sync>,
    busy: Mutex<usize>,
    freed: Condvar,
}

pub struct Slot<'a>(&'a Limiter);

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        *self.0.busy.lock().unwrap() -= 1;
        self.0.freed.notify_all();
    }
}

impl Limiter {
    pub fn new(max: impl Fn() -> usize + Send + Sync + 'static) -> Arc<Limiter> {
        Arc::new(Limiter { max: Box::new(max), busy: Mutex::new(0), freed: Condvar::new() })
    }
    /// Wait for a free slot; it is given back when the slot is dropped.
    pub fn take(&self) -> Slot<'_> {
        let mut b = self.busy.lock().unwrap();
        while *b >= (self.max)().max(1) {
            b = self.freed.wait(b).unwrap();
        }
        *b += 1;
        Slot(self)
    }
}

pub fn base64(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Why there is no answer: (HTTP status, message)
#[derive(Debug, Clone)]
pub struct Refused(pub u16, pub String);

type Pending = Arc<(Mutex<Option<Result<String, Refused>>>, Condvar)>;

pub struct Telemetry {
    pub dir: PathBuf,
    pub limit: Arc<Limiter>,
    pending: Mutex<HashMap<String, Pending>>,
    since_sweep: Mutex<usize>,
}

/// The records as the dashboard takes them: {"v":1,"frames":[[ms, base64], …]}
pub fn body_of(frames: &[(f64, Vec<u8>)]) -> String {
    let mut s = String::from("{\"v\":1,\"frames\":[");
    for (i, (t, rec)) in frames.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push('[');
        s.push_str(&js::num(*t).to_string());
        s.push_str(",\"");
        s.push_str(&base64(rec));
        s.push_str("\"]");
    }
    s.push_str("]}");
    s
}

impl Telemetry {
    pub fn new(dir: PathBuf, limit: Arc<Limiter>) -> Telemetry {
        Telemetry { dir, limit, pending: Mutex::new(HashMap::new()), since_sweep: Mutex::new(0) }
    }

    /// Telemetry.key: the cache key of a file as it is now
    pub fn key(real: &Path, md: &std::fs::Metadata) -> String {
        let m = js::js_round(crate::scanner::ms_of(md.mtime(), md.mtime_nsec()));
        js::sha1_hex(format!("t2|{}|{}|{}", real.to_string_lossy(), md.size(), js::num(m)).as_bytes())
    }

    /// (key, body) for a clip; real must already be checked.
    pub fn for_file(&self, real: &Path) -> Result<(String, String), Refused> {
        let md = std::fs::metadata(real).map_err(|_| Refused(500, "Internal error".into()))?;
        if !md.is_file() {
            return Err(Refused(404, "Not a file".into()));
        }
        if md.size() > MAX_FILE {
            return Err(Refused(413, "File too large".into()));
        }
        let key = Self::key(real, &md);
        let cached = self.dir.join(format!("{key}.json"));
        if let Ok(body) = std::fs::read_to_string(&cached) {
            if !body.is_empty() {
                return Ok((key, body));
            }
        }
        let (job, mine) = {
            let mut p = self.pending.lock().unwrap();
            match p.get(&key) {
                Some(j) => (j.clone(), false),
                None => {
                    let j: Pending = Arc::new((Mutex::new(None), Condvar::new()));
                    p.insert(key.clone(), j.clone());
                    (j, true)
                }
            }
        };
        if mine {
            let out = {
                let _slot = self.limit.take();
                match crate::telemetry::read_records(real, md.size()) {
                    Ok(frames) => Ok(body_of(&frames)),
                    Err(crate::telemetry::Fail::Parse(_)) => Ok(body_of(&[])),
                    Err(crate::telemetry::Fail::Io(e)) => {
                        eprintln!("GET /api/telemetry: {e}");
                        Err(Refused(500, "Internal error".into()))
                    }
                }
            };
            if let Ok(body) = &out {
                let _ = std::fs::create_dir_all(&self.dir);
                let tmp = PathBuf::from(format!("{}.{}.tmp", cached.display(), std::process::id()));
                if std::fs::write(&tmp, body).is_ok() {
                    let _ = std::fs::rename(&tmp, &cached);
                }
                let mut n = self.since_sweep.lock().unwrap();
                *n += 1;
                if *n >= 100 {
                    *n = 0;
                    self.sweep();
                }
            }
            *job.0.lock().unwrap() = Some(out);
            job.1.notify_all();
            self.pending.lock().unwrap().remove(&key);
        }
        let mut r = job.0.lock().unwrap();
        while r.is_none() {
            r = job.1.wait(r).unwrap();
        }
        r.clone().unwrap().map(|b| (key, b))
    }

    /// Keep the cache to the newest MAX_CACHE_FILES results.
    pub fn sweep(&self) {
        let Ok(list) = std::fs::read_dir(&self.dir) else { return };
        let mut names: Vec<(f64, PathBuf)> = list
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
            .map(|e| (e.metadata().map(|m| crate::scanner::ms_of(m.mtime(), m.mtime_nsec())).unwrap_or(0.0), e.path()))
            .collect();
        if names.len() <= MAX_CACHE_FILES {
            return;
        }
        names.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let n = names.len() - MAX_CACHE_FILES;
        for (_, p) in names.into_iter().take(n) {
            let _ = std::fs::remove_file(p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn base64_as_buffer_writes_it() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(&[0xff, 0xfe, 0xfd, 0x00]), "//79AA==");
        assert_eq!(body_of(&[(0.0, vec![8, 1]), (83.33333333333333, vec![1])]), r#"{"v":1,"frames":[[0,"CAE="],[83.33333333333333,"AQ=="]]}"#);
    }
    #[test]
    fn a_limiter_lets_max_at_once() {
        let l = Limiter::new(|| 2);
        let a = l.take();
        let _b = l.take();
        assert_eq!(*l.busy.lock().unwrap(), 2);
        drop(a);
        let _c = l.take();
        assert_eq!(*l.busy.lock().unwrap(), 2);
    }
}
