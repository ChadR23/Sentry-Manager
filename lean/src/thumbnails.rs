//! Recording card thumbnails made from a clip when Tesla saved no thumb.png
//! (a port of server/thumbnails.js): one frame of the front camera, one
//! second in (else the first frame of a very short clip), 320 pixels wide,
//! made once with ffmpeg run as a child process and cached in
//! DATA_PATH/thumbnails under the same name the Node server gives it.
//!
//! ffmpeg only reads the clip (`-protocol_whitelist file`, the clip as its
//! only input); what it writes goes to the cache, never next to the footage.
//! Without ffmpeg there is no thumbnail, as on the Node server.

use std::collections::HashSet;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(60);

pub struct Thumbnails {
    pub dir: PathBuf,
    ffmpeg: String,
    /// clips being made now (by their cache file), and how many ffmpeg runs at once
    busy: Mutex<(HashSet<PathBuf>, usize)>,
    changed: Condvar,
    concurrency: usize,
}

/// Run a command without a shell; its exit code, -1 when it could not start or ran too long (proc.js run).
fn run(cmd: &str, args: &[&str]) -> i32 {
    let Ok(mut child) = Command::new(cmd).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else { return -1 };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.code().unwrap_or(-1),
            Ok(None) if started.elapsed() < TIMEOUT => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return -1;
            }
        }
    }
}

impl Thumbnails {
    pub fn new(dir: PathBuf, ffmpeg: String, concurrency: usize) -> Thumbnails {
        Thumbnails { dir, ffmpeg, busy: Mutex::new((HashSet::new(), 0)), changed: Condvar::new(), concurrency: concurrency.max(1) }
    }

    /// The cache file of a clip as it is now: sha1 of "real path|size|floor(mtimeMs)", as thumbnails.js names it.
    pub fn key(real: &Path, md: &std::fs::Metadata) -> String {
        let mtime = crate::scanner::ms_of(md.mtime(), md.mtime_nsec()).floor();
        let mut h = sha1_smol::Sha1::new();
        h.update(format!("{}|{}|{}", real.to_string_lossy(), md.size(), mtime as i64).as_bytes());
        h.digest().to_string()
    }

    /// A JPEG of this clip (made if needed); Ok(None) when ffmpeg cannot make one (or is not
    /// there); Err when ffmpeg ended well but wrote nothing (thumbnails.js: its rename
    /// throws, an internal error). `real`: the clip's checked real path.
    pub fn for_clip(&self, real: &Path) -> Result<Option<PathBuf>, String> {
        let Ok(md) = std::fs::metadata(real) else { return Ok(None) };
        let out = self.dir.join(format!("{}.jpg", Self::key(real, &md)));
        if out.exists() {
            return Ok(Some(out));
        }
        // one run per clip; at most `concurrency` runs at once
        {
            let mut b = self.busy.lock().unwrap();
            loop {
                if b.0.contains(&out) {
                    // (being made for another request: its answer)
                    while b.0.contains(&out) {
                        b = self.changed.wait(b).unwrap();
                    }
                    return Ok(out.exists().then_some(out));
                }
                if b.1 < self.concurrency {
                    break;
                }
                b = self.changed.wait(b).unwrap();
            }
            b.0.insert(out.clone());
            b.1 += 1;
        }
        let made = self.make(real, &out);
        {
            let mut b = self.busy.lock().unwrap();
            b.0.remove(&out);
            b.1 -= 1;
        }
        self.changed.notify_all();
        made.map(|ok| ok.then_some(out))
    }

    fn make(&self, real: &Path, out: &Path) -> Result<bool, String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let tmp = PathBuf::from(format!("{}.{}.tmp.jpg", out.to_string_lossy(), std::process::id()));
        let (clip, to) = (real.to_string_lossy(), tmp.to_string_lossy());
        let tail = ["-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "5", &to];
        let head = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
        let input = ["-protocol_whitelist", "file", "-i", &clip];
        let seek: Vec<&str> = head.iter().copied().chain(["-ss", "1"]).chain(input).chain(tail).collect();
        if run(&self.ffmpeg, &seek) != 0 {
            // very short clip: the first frame instead
            let first: Vec<&str> = head.iter().copied().chain(input).chain(tail).collect();
            if run(&self.ffmpeg, &first) != 0 {
                let _ = std::fs::remove_file(&tmp);
                return Ok(false);
            }
        }
        // (ffmpeg can end well and write nothing: a seek past the end of a clip under a second)
        std::fs::rename(&tmp, out).map(|_| true).map_err(|e| e.to_string())
    }
}
