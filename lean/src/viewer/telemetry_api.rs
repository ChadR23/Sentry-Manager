//! /api/telemetry (server/telemetry.js Telemetry.forFile): a clip's records
//! for the dashboard, [timestamp ms, base64 record] per frame, read with
//! telemetry.rs and cached under DATA_PATH/telemetry by file, size and
//! modification time (the Node server's names: sha1 of "t2|path|size|mtime"),
//! so a converted clip (new size and time) is read again. At most
//! `telemetryReads` clips are read at once; the cache keeps the newest 4,000.

use super::js;
use bytes::Bytes;
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};

const MAX_FILE: u64 = 1024 * 1024 * 1024;
const MAX_CACHE_FILES: usize = 4000;

/// scanner.js limiter: at most max() at once, read each time. Background readers (the speed
/// index's full reads) leave the way to someone waiting for a clip in the Viewer: a Viewer read
/// may take one slot over max() while background reads hold them all, and background reads
/// wait while a Viewer read waits.
pub struct Limiter {
    max: Box<dyn Fn() -> usize + Send + Sync>,
    busy: Mutex<Busy>,
    freed: Condvar,
}

#[derive(Default)]
struct Busy {
    now: usize,
    background: usize,
    waiting: usize,
}

pub struct Slot<'a>(&'a Limiter, bool);

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        let mut b = self.0.busy.lock().unwrap();
        b.now -= 1;
        if self.1 {
            b.background -= 1;
        }
        drop(b);
        self.0.freed.notify_all();
    }
}

impl Limiter {
    pub fn new(max: impl Fn() -> usize + Send + Sync + 'static) -> Arc<Limiter> {
        Arc::new(Limiter { max: Box::new(max), busy: Mutex::new(Busy::default()), freed: Condvar::new() })
    }
    /// Wait for a free slot; it is given back when the slot is dropped.
    pub fn take(&self) -> Slot<'_> {
        let mut b = self.busy.lock().unwrap();
        b.waiting += 1;
        loop {
            let max = (self.max)().max(1);
            let foreground = b.now - b.background;
            if b.now < max || (foreground < max && b.now < max + 1) {
                break;
            }
            b = self.freed.wait(b).unwrap();
        }
        b.waiting -= 1;
        b.now += 1;
        let last = b.waiting == 0;
        drop(b);
        if last {
            // (background readers wait for nobody to be waiting: a slot left free goes to them)
            self.freed.notify_all();
        }
        Slot(self, false)
    }
    /// A slot for background reading: only while nobody waits for one with take().
    pub fn take_background(&self) -> Slot<'_> {
        let mut b = self.busy.lock().unwrap();
        while b.now >= (self.max)().max(1) || b.waiting > 0 {
            b = self.freed.wait(b).unwrap();
        }
        b.now += 1;
        b.background += 1;
        Slot(self, true)
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

type Pending = Arc<(Mutex<Option<Result<Bytes, Refused>>>, Condvar)>;

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
    pub fn for_file(&self, real: &Path) -> Result<(String, Bytes), Refused> {
        let (md, key) = self.identity(real)?;
        self.body(real, &md, &key).map(|body| (key, body))
    }

    /// A clip's metadata and key (its ETag) after for_file's checks: what a conditional
    /// request is answered with before anything else is read.
    pub fn identity(&self, real: &Path) -> Result<(std::fs::Metadata, String), Refused> {
        let md = std::fs::metadata(real).map_err(|_| Refused(500, "Internal error".into()))?;
        if !md.is_file() {
            return Err(Refused(404, "Not a file".into()));
        }
        if md.size() > MAX_FILE {
            return Err(Refused(413, "File too large".into()));
        }
        let key = Self::key(real, &md);
        Ok((md, key))
    }

    /// The body of a clip as identity() found it: the cached one, else read once for every
    /// request waiting for it (they share the one body).
    pub fn body(&self, real: &Path, md: &std::fs::Metadata, key: &str) -> Result<Bytes, Refused> {
        let key = key.to_string();
        let cached = self.dir.join(format!("{key}.json"));
        if let Ok(body) = std::fs::read_to_string(&cached) {
            if !body.is_empty() {
                return Ok(Bytes::from(body));
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
                    Ok(frames) => Ok(Bytes::from(body_of(&frames))),
                    Err(crate::telemetry::Fail::Parse(_)) => Ok(Bytes::from(body_of(&[]))),
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
        r.clone().unwrap()
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
        assert_eq!(l.busy.lock().unwrap().now, 2);
        drop(a);
        let _c = l.take();
        assert_eq!(l.busy.lock().unwrap().now, 2);
    }

    #[test]
    fn a_viewer_read_does_not_wait_behind_background_reads() {
        let l = Limiter::new(|| 2);
        let _a = l.take_background();
        let _b = l.take_background();
        let v = l.take();
        assert_eq!(l.busy.lock().unwrap().now, 3, "one over the limit for the Viewer");
        // a second Viewer read waits for a slot, and background reads wait behind it
        let l2 = l.clone();
        let waiter = std::thread::spawn(move || {
            let _s = l2.take();
        });
        while l.busy.lock().unwrap().waiting == 0 {
            std::thread::yield_now();
        }
        drop(v);
        waiter.join().unwrap();
        assert_eq!(l.busy.lock().unwrap().now, 2);
        assert_eq!(l.busy.lock().unwrap().background, 2);
    }

    #[test]
    fn background_reads_wait_while_a_viewer_read_waits() {
        let l = Limiter::new(|| 1);
        let first = l.take();
        let order = Arc::new(Mutex::new(Vec::new()));
        let (l2, o2) = (l.clone(), order.clone());
        let viewer = std::thread::spawn(move || {
            let _s = l2.take();
            o2.lock().unwrap().push("viewer");
        });
        while l.busy.lock().unwrap().waiting == 0 {
            std::thread::yield_now();
        }
        let (l3, o3) = (l.clone(), order.clone());
        let background = std::thread::spawn(move || {
            let _s = l3.take_background();
            o3.lock().unwrap().push("background");
        });
        drop(first);
        viewer.join().unwrap();
        background.join().unwrap();
        // (one slot: the background read gets it only after the Viewer read let it go)
        assert_eq!(*order.lock().unwrap(), vec!["viewer", "background"]);
    }

    #[test]
    fn a_slot_left_free_when_the_last_waiting_viewer_read_gets_in_goes_to_a_background_read() {
        use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
        use std::time::{Duration, Instant};
        for _ in 0..50 {
            let l = Limiter::new(|| 2);
            let (f1, f2) = (l.take(), l.take());
            let (l2, l3) = (l.clone(), l.clone());
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            // a Viewer read waits for one of the two slots and keeps it until the background read is in
            let viewer = std::thread::spawn(move || {
                let s = l2.take();
                rx.recv().unwrap();
                drop(s);
            });
            while l.busy.lock().unwrap().waiting == 0 {
                std::thread::yield_now();
            }
            let got = Arc::new(AtomicBool::new(false));
            let g2 = got.clone();
            let background = std::thread::spawn(move || {
                let _s = l3.take_background();
                g2.store(true, SeqCst);
            });
            std::thread::sleep(Duration::from_millis(2));
            drop(f1);
            drop(f2);
            let t = Instant::now();
            while !got.load(SeqCst) {
                assert!(t.elapsed() < Duration::from_secs(2), "the background read was left waiting with a slot free");
                std::thread::yield_now();
            }
            tx.send(()).unwrap();
            viewer.join().unwrap();
            background.join().unwrap();
        }
    }
}
