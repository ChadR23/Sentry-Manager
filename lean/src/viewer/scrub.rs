//! Scrub previews (a port of server/scrubFrames.js, scrubKeyframes.js and
//! scrubPrepare.js): one small frame for every second of a clip in a single
//! JPEG grid (10 x 7 frames, 240 pixels wide), made with ffmpeg run as a
//! child process at low priority and cached in DATA_PATH/scrub under the
//! Node server's names. A clip with a keyframe at least every 1.1 s (Tesla's
//! own) is made from its keyframes alone: the sample table says where each
//! keyframe is, only those samples are read and ffmpeg gets them as an H.264
//! stream of one picture a second. Other clips have every frame decoded.
//! Making one also prepares the next clip of the same camera, and after each
//! scan the newest days are prepared ahead (newest first, one at a time).
//! ffmpeg only reads the clip; what it writes goes to the cache.

use super::ctx::Ctx;
use super::js;
use crate::mp4;
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime};

pub const COLS: u32 = 10;
pub const ROWS: u32 = 7;
pub const FRAME_WIDTH: u32 = 240;
const MAX_CACHED: usize = 6_000;
const MAX_QUEUED: usize = 200;
const TIMEOUT: Duration = Duration::from_secs(60);
const SETTLE_MS: f64 = 2.0 * 60_000.0;

/// A keyframe: (sample index, pts, duration, offset, size)
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Key {
    pub index: u32,
    pub pts: f64,
    pub duration: f64,
    pub offset: u64,
    pub size: u32,
}

/// round half away from zero (av_rescale_q_rnd AV_ROUND_NEAR_INF)
fn round_near(x: f64) -> f64 {
    if x < 0.0 { -(-x + 0.5).floor() } else { (x + 0.5).floor() }
}

/// The keyframe for each second shown, as FFmpeg's fps filter (round near, eof pass) picks it.
pub fn picks_for(keys: &[Key], scale: f64, edit_end: Option<f64>) -> Vec<Key> {
    let mut shown: Vec<Key> = keys.iter().filter(|k| edit_end.map_or(true, |e| k.pts < e)).copied().collect();
    shown.sort_by(|a, b| a.pts.partial_cmp(&b.pts).unwrap());
    let Some(last) = shown.last().copied() else { return Vec::new() };
    let second = |k: &Key| round_near(k.pts / scale);
    let end = ((last.pts + last.duration) / scale).ceil();
    let mut picks = Vec::new();
    let mut j = 0;
    let mut t = second(&shown[0]);
    while t < end && picks.len() < 7200 {
        while j + 1 < shown.len() && second(&shown[j + 1]) <= t {
            j += 1;
        }
        picks.push(shown[j]);
        t += 1.0;
    }
    picks
}

/// What the sample table says about a clip (keyframePlan): the longest gap between
/// keyframes (s), and for H.264 the picks and the SPS/PPS to write them with.
pub struct Plan {
    pub gap: f64,
    pub picks: Vec<Key>,
    pub config: Option<(usize, Vec<Vec<u8>>)>,
}

fn be16(b: &[u8], at: usize) -> Option<usize> {
    Some(u16::from_be_bytes(b.get(at..at + 2)?.try_into().ok()?) as usize)
}

fn avc_config(desc: &[u8]) -> Result<Option<(usize, Vec<Vec<u8>>)>, ()> {
    let Some(at) = desc.windows(4).position(|w| w == b"avcC") else { return Ok(None) };
    if at < 4 {
        return Ok(None);
    }
    let c = at + 4;
    let length_size = (*desc.get(c + 4).ok_or(())? & 3) as usize + 1;
    let mut sets = Vec::new();
    let mut p = c + 5;
    let sps = *desc.get(p).ok_or(())? & 31;
    p += 1;
    for _ in 0..sps {
        let n = be16(desc, p).ok_or(())?;
        sets.push(desc.get(p + 2..(p + 2 + n).min(desc.len())).ok_or(())?.to_vec());
        p += 2 + n;
    }
    let pps = *desc.get(p).ok_or(())?;
    p += 1;
    for _ in 0..pps {
        let n = be16(desc, p).ok_or(())?;
        sets.push(desc.get(p + 2..(p + 2 + n).min(desc.len())).ok_or(())?.to_vec());
        p += 2 + n;
    }
    if sets.is_empty() || p > desc.len() || length_size == 3 {
        return Ok(None);
    }
    Ok(Some((length_size, sets)))
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

pub fn keyframe_plan(path: &Path) -> Option<Plan> {
    let file = std::fs::File::open(path).ok()?;
    let tree = mp4::open_tree(&file).ok()?;
    let (track, _) = mp4::video_track(&tree).ok()?;
    let samples = mp4::sample_index(&tree, track).ok()?;
    if samples.is_empty() {
        return None;
    }
    let scale = mp4::timescale(&tree, track).ok()? as f64;
    let stss = track.find_all(b"stss");
    if stss.len() > 1 {
        return None;
    }
    let sync: Vec<usize> = match stss.first() {
        Some(b) => {
            let p = tree.payload(b).ok()?;
            let count = be32(p, 4)? as usize;
            if p.len() < 8 + count * 4 {
                return None;
            }
            (0..count).filter_map(|i| be32(p, 8 + i * 4)).filter(|&n| n >= 1 && n as usize <= samples.len()).map(|n| n as usize - 1).collect()
        }
        None => (0..samples.len()).collect(),
    };
    let keys: Vec<Key> = sync.iter().map(|&i| &samples[i]).map(|s| Key { index: s.index, pts: s.pts as f64, duration: s.duration as f64, offset: s.offset, size: s.size }).collect();
    if keys.is_empty() {
        return None;
    }
    let mut gap: f64 = 0.0;
    for w in keys.windows(2) {
        gap = gap.max((w[1].pts - w[0].pts) / scale);
    }
    let mut edit_end = None;
    if let Some(elst) = track.first(b"elst") {
        let e = tree.payload(elst).ok()?;
        let mvhd = tree.root.first(b"mvhd")?;
        let m = tree.payload(mvhd).ok()?;
        let movie_scale = if m.first() == Some(&1) { be32(m, 20)? } else { be32(m, 12)? } as f64;
        let segment = if e.first() == Some(&1) { u64::from_be_bytes(e.get(8..16)?.try_into().ok()?) as f64 } else { be32(e, 8)? as f64 };
        if movie_scale != 0.0 && segment != 0.0 {
            edit_end = Some(segment * scale / movie_scale);
        }
    }
    let desc = tree.payload(track.first(b"stsd")?).ok()?;
    let config = if desc.get(12..16) == Some(b"avc1") { avc_config(desc).ok()? } else { None };
    if config.is_none() {
        return Some(Plan { gap, picks: Vec::new(), config: None });
    }
    Some(Plan { gap, picks: picks_for(&keys, scale, edit_end), config })
}

/// The picked keyframes as an H.264 stream with start codes, written to `out`.
fn write_picks(path: &Path, plan: &Plan, out: &mut dyn Write) -> std::io::Result<()> {
    let file = std::fs::File::open(path)?;
    let (ls, sets) = plan.config.as_ref().unwrap();
    let mut last: Option<(u32, Vec<u8>)> = None;
    for k in &plan.picks {
        if last.as_ref().map_or(true, |l| l.0 != k.index) {
            let mut buf = vec![0u8; k.size as usize];
            let n = read_some(&file, &mut buf, k.offset)?;
            buf.truncate(n);
            last = Some((k.index, buf));
        }
        let data = &last.as_ref().unwrap().1;
        let mut chunk = Vec::with_capacity(data.len() + 64);
        for s in sets {
            chunk.extend([0, 0, 0, 1]);
            chunk.extend_from_slice(s);
        }
        let mut p = 0;
        while p + ls <= data.len() {
            let mut n = 0usize;
            for b in &data[p..p + ls] {
                n = n * 256 + *b as usize;
            }
            p += ls;
            if n == 0 || p + n > data.len() {
                break;
            }
            chunk.extend([0, 0, 0, 1]);
            chunk.extend_from_slice(&data[p..p + n]);
            p += n;
        }
        out.write_all(&chunk)?;
    }
    Ok(())
}

fn read_some(file: &std::fs::File, buf: &mut [u8], pos: u64) -> std::io::Result<usize> {
    use std::os::unix::fs::FileExt;
    let mut got = 0;
    while got < buf.len() {
        match file.read_at(&mut buf[got..], pos + got as u64)? {
            0 => break,
            n => got += n,
        }
    }
    Ok(got)
}

/// Wait for a child, killed after the timeout; its exit code, -1 when it did not end well.
fn wait(mut child: Child, limit: Duration) -> i32 {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(s)) => return s.code().unwrap_or(-1),
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return -1;
            }
        }
    }
}

fn lower_priority(child: &Child) {
    unsafe {
        libc::setpriority(libc::PRIO_PROCESS, child.id(), 10);
    }
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut b);
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

type Waiter = Arc<(Mutex<Option<Option<PathBuf>>>, Condvar)>;

struct Job {
    video: PathBuf,
    target: PathBuf,
    ahead: bool,
}

#[derive(Default)]
struct Queue {
    jobs: VecDeque<Job>,
    running: usize,
    in_flight: HashMap<PathBuf, Waiter>,
    written: usize,
    prepared: bool,
}

pub struct ScrubFrames {
    pub dir: PathBuf,
    ffmpeg: String,
    ffprobe: Option<String>,
    most: Box<dyn Fn() -> usize + Send + Sync>,
    q: Mutex<Queue>,
}

fn is_clip_name(name: &str) -> Option<String> {
    // ^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-([a-z_]+)\.mp4$ (any case)
    let lower = name.to_lowercase();
    let stem = lower.strip_suffix(".mp4")?;
    if stem.len() < 21 || !stem.is_char_boundary(19) || js::stamp_in(&stem[..19]).is_none() || stem.as_bytes()[19] != b'-' {
        return None;
    }
    let cam = &stem[20..];
    (!cam.is_empty() && cam.bytes().all(|c| c.is_ascii_lowercase() || c == b'_')).then(|| cam.to_string())
}

impl ScrubFrames {
    pub fn new(dir: PathBuf, ffmpeg: String, ffprobe: Option<String>, most: impl Fn() -> usize + Send + Sync + 'static) -> Arc<ScrubFrames> {
        Arc::new(ScrubFrames { dir, ffmpeg, ffprobe, most: Box::new(most), q: Mutex::new(Queue::default()) })
    }

    fn prune(&self) {
        let Ok(list) = std::fs::read_dir(&self.dir) else { return };
        let mut names: Vec<(f64, PathBuf)> = list
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".jpg"))
            .filter_map(|e| e.metadata().ok().map(|m| (crate::scanner::ms_of(m.mtime(), m.mtime_nsec()), e.path())))
            .collect();
        if names.len() <= MAX_CACHED {
            return;
        }
        names.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
        let n = names.len() - MAX_CACHED;
        for (_, p) in names.into_iter().take(n) {
            let _ = std::fs::remove_file(p);
        }
    }

    /// The cache file of a clip as it is now (None for an empty one)
    pub fn cache_path_for(&self, video: &Path) -> Option<PathBuf> {
        let md = std::fs::metadata(video).ok()?;
        if !md.is_file() || md.size() == 0 {
            return None;
        }
        let m = js::js_round(crate::scanner::ms_of(md.mtime(), md.mtime_nsec()));
        let key = js::sha1_hex(format!("scrub2\0{}\0{}\0{}", video.to_string_lossy(), md.size(), js::num(m)).as_bytes());
        Some(self.dir.join(format!("{key}.jpg")))
    }

    /// The longest gap between keyframes from the packets' flags (ffprobe); infinity when unknown.
    fn keyframe_gap(&self, video: &Path) -> f64 {
        let Some(probe) = &self.ffprobe else { return f64::INFINITY };
        let Ok(out) = Command::new(probe)
            .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", "-protocol_whitelist", "file"])
            .arg(video)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
        else {
            return f64::INFINITY;
        };
        if !out.status.success() {
            return f64::INFINITY;
        }
        let (mut last, mut gap) = (None::<f64>, 0f64);
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let mut it = line.split(',');
            let (t, flags) = (it.next().unwrap_or(""), it.next());
            if !flags.is_some_and(|f| f.contains('K')) {
                continue;
            }
            let at = js::number_str(t);
            if !at.is_finite() {
                continue;
            }
            if let Some(l) = last {
                gap = gap.max(at - l);
            }
            last = Some(at);
        }
        if last.is_some() { gap } else { f64::INFINITY }
    }

    fn generate(&self, video: &Path, target: &Path, ahead: bool) -> Option<PathBuf> {
        let tmp = PathBuf::from(format!("{}.{}.{}.tmp.jpg", target.display(), std::process::id(), random_hex(4)));
        let out = (|| {
            let plan = keyframe_plan(video);
            let gap = match &plan {
                Some(p) => p.gap,
                None => self.keyframe_gap(video),
            };
            let quick = gap <= 1.1;
            let vf_tile = format!("scale={FRAME_WIDTH}:-2,setsar=1,tile={COLS}x{ROWS}");
            let tail = ["-an", "-sn", "-dn", "-frames:v", "1", "-q:v", "6", "-y"];
            let status = match plan.as_ref().filter(|p| quick && p.config.is_some() && !p.picks.is_empty()) {
                Some(p) => {
                    let mut cmd = Command::new(&self.ffmpeg);
                    cmd.args(["-hide_banner", "-loglevel", "error", "-threads", "2", "-f", "h264", "-framerate", "1", "-i", "pipe:0", "-vf", &vf_tile]).args(tail).arg(&tmp);
                    let Ok(mut child) = cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else { return None };
                    lower_priority(&child);
                    let mut stdin = child.stdin.take().unwrap();
                    // (ffmpeg may stop reading once it has its grid: a closed pipe is no error)
                    let _ = write_picks(video, p, &mut stdin);
                    drop(stdin);
                    wait(child, TIMEOUT)
                }
                None => {
                    let mut cmd = Command::new(&self.ffmpeg);
                    cmd.args(["-nostdin", "-hide_banner", "-loglevel", "error"]);
                    if quick {
                        cmd.args(["-skip_frame", "nokey"]);
                    } else {
                        cmd.args(["-skip_loop_filter", "all"]);
                    }
                    cmd.args(["-threads", "2", "-protocol_whitelist", "file", "-i"]).arg(video).args(["-vf", &format!("fps=1:eof_action=pass,{vf_tile}")]).args(tail).arg(&tmp);
                    let Ok(child) = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else { return None };
                    lower_priority(&child);
                    wait(child, TIMEOUT)
                }
            };
            if status != 0 || std::fs::metadata(&tmp).map_or(true, |m| m.len() == 0) {
                return None;
            }
            if ahead {
                if let Ok(m) = std::fs::metadata(video).and_then(|m| m.modified()) {
                    let _ = std::fs::File::options().write(true).open(&tmp).and_then(|f| f.set_modified(m));
                }
            }
            std::fs::rename(&tmp, target).ok()?;
            let mut q = self.q.lock().unwrap();
            q.written += 1;
            if q.written % 200 == 0 {
                drop(q);
                self.prune();
            }
            Some(target.to_path_buf())
        })();
        let _ = std::fs::remove_file(&tmp);
        out
    }

    fn pump(self: &Arc<Self>) {
        let mut q = self.q.lock().unwrap();
        while q.running < (self.most)().max(1) {
            let Some(job) = q.jobs.pop_front() else { break };
            q.running += 1;
            let me = self.clone();
            std::thread::spawn(move || {
                let out = me.generate(&job.video, &job.target, job.ahead);
                let w = {
                    let mut q = me.q.lock().unwrap();
                    q.running -= 1;
                    q.in_flight.remove(&job.target)
                };
                if let Some(w) = w {
                    *w.0.lock().unwrap() = Some(out);
                    w.1.notify_all();
                }
                me.pump();
            });
        }
    }

    /// The next clip of the same camera in the same folder, if any.
    fn next_clip_of(video: &Path) -> Option<PathBuf> {
        let name = video.file_name()?.to_string_lossy().into_owned();
        let cam = is_clip_name(&name)?;
        let suffix = format!("-{cam}.mp4");
        let dir = video.parent()?;
        let mut names: Vec<String> = std::fs::read_dir(dir).ok()?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| is_clip_name(n).is_some() && n.to_lowercase().ends_with(&suffix) && *n > name).collect();
        names.sort();
        names.first().map(|n| dir.join(n))
    }

    /// The grid of a clip, made first when needed (None when it cannot be made).
    /// `urgent`: someone waits (goes first); `next`: prepare the camera's next clip too;
    /// `touch`: a grid used now is kept longest (one made ahead takes the clip's time).
    pub fn get(self: &Arc<Self>, video: &Path, urgent: bool, next: bool, touch: bool) -> Option<PathBuf> {
        let s = video.to_string_lossy();
        if !video.is_absolute() || !s.to_lowercase().ends_with(".mp4") {
            return None;
        }
        {
            let mut q = self.q.lock().unwrap();
            if !q.prepared {
                q.prepared = true;
                let _ = std::fs::create_dir_all(&self.dir);
                drop(q);
                self.prune();
            }
        }
        let target = self.cache_path_for(video)?;
        if next {
            if let Some(n) = Self::next_clip_of(video) {
                let me = self.clone();
                std::thread::spawn(move || {
                    me.get(&n, false, false, true);
                });
            }
        }
        if std::fs::metadata(&target).is_ok_and(|m| m.len() > 0) {
            if touch {
                let _ = std::fs::File::options().write(true).open(&target).and_then(|f| f.set_modified(SystemTime::now()));
            }
            return Some(target);
        }
        let waiter = {
            let mut q = self.q.lock().unwrap();
            match q.in_flight.get(&target).cloned() {
                Some(w) => {
                    if urgent {
                        if let Some(i) = q.jobs.iter().position(|j| j.target == target) {
                            let j = q.jobs.remove(i).unwrap();
                            q.jobs.push_front(j);
                        }
                    }
                    w
                }
                None => {
                    let job = Job { video: video.to_path_buf(), target: target.clone(), ahead: !touch };
                    if urgent {
                        q.jobs.push_front(job);
                    } else if q.jobs.len() < MAX_QUEUED {
                        q.jobs.push_back(job);
                    } else {
                        return None;
                    }
                    let w: Waiter = Arc::new((Mutex::new(None), Condvar::new()));
                    q.in_flight.insert(target.clone(), w.clone());
                    w
                }
            }
        };
        self.pump();
        let mut r = waiter.0.lock().unwrap();
        while r.is_none() {
            r = waiter.1.wait(r).unwrap();
        }
        r.clone().unwrap()
    }
}

/// Previews made ahead after each scan: the newest `days` days, newest clip first, one at a time.
pub struct ScrubPrepare {
    ctx: Arc<dyn Ctx>,
    frames: Arc<ScrubFrames>,
    pub days: usize,
    pub max: usize,
    pub pause_ms: u64,
    idle: Box<dyn Fn() -> bool + Send + Sync>,
    run: Mutex<(bool, bool)>,
    done: Mutex<HashMap<PathBuf, String>>,
    pub stopped: std::sync::atomic::AtomicBool,
}

impl ScrubPrepare {
    pub fn new(ctx: Arc<dyn Ctx>, frames: Arc<ScrubFrames>, days: usize, idle: impl Fn() -> bool + Send + Sync + 'static) -> Arc<ScrubPrepare> {
        Arc::new(ScrubPrepare { ctx, frames, days, max: 5000, pause_ms: 50, idle: Box::new(idle), run: Mutex::new((false, false)), done: Mutex::new(HashMap::new()), stopped: Default::default() })
    }

    /// SCRUB_PREPARE_DAYS (2; 0 turns it off; at most 30)
    pub fn days_from_env() -> usize {
        match std::env::var("SCRUB_PREPARE_DAYS").ok().map(|s| s.trim().to_string()) {
            None => 2,
            Some(s) => {
                let digits: String = s.chars().enumerate().take_while(|(i, c)| c.is_ascii_digit() || (*i == 0 && (*c == '-' || *c == '+'))).map(|x| x.1).collect();
                match digits.parse::<i64>() {
                    Ok(n) => n.clamp(0, 30) as usize,
                    Err(_) => 2,
                }
            }
        }
    }

    /// The clips still to prepare: (real, key, day, rel), newest first.
    pub fn todo(&self) -> Vec<(PathBuf, String, String, String)> {
        let now = js::now_ms();
        let mut all = Vec::new();
        for v in self.ctx.vehicles() {
            let Some(files) = self.ctx.files(&v.id) else { continue };
            let clips: Vec<_> = files.values().filter(|f| f.kind == crate::footage::Kind::Clip && f.size > 0 && crate::footage::is_day_shape(&f.day) && f.rel.to_lowercase().ends_with(".mp4")).collect();
            let mut days: Vec<&str> = clips.iter().map(|f| f.day.as_str()).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
            days.reverse();
            days.truncate(self.days);
            for f in clips {
                if !days.contains(&f.day.as_str()) || now - f.mtime_ms < SETTLE_MS {
                    continue;
                }
                all.push((v.root.join(&f.rel), format!("{}/{}", f.size, js::num(js::js_round(f.mtime_ms))), f.day.clone(), f.rel.clone()));
            }
        }
        all.sort_by(|a, b| if a.2 == b.2 { js::locale_cmp(&b.3, &a.3) } else { js::locale_cmp(&b.2, &a.2) });
        all.truncate(self.max);
        let done = self.done.lock().unwrap();
        all.into_iter().filter(|c| done.get(&c.0) != Some(&c.1)).collect()
    }

    fn pass(&self) -> usize {
        let mut made = 0;
        for (real, key, _, _) in self.todo() {
            use std::sync::atomic::Ordering;
            if self.stopped.load(Ordering::SeqCst) {
                break;
            }
            while !(self.idle)() && !self.stopped.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_secs(5));
            }
            let started = Instant::now();
            let grid = self.frames.get(&real, false, false, false);
            let mut done = self.done.lock().unwrap();
            done.insert(real, key);
            if done.len() > 50_000 {
                if let Some(k) = done.keys().next().cloned() {
                    done.remove(&k);
                }
            }
            drop(done);
            if grid.is_some() && started.elapsed() > Duration::from_millis(20) {
                made += 1;
                if self.pause_ms > 0 {
                    std::thread::sleep(Duration::from_millis(self.pause_ms));
                }
            }
        }
        made
    }

    /// Prepare what is new; again after this pass if more came meanwhile.
    pub fn kick(self: &Arc<Self>) {
        if self.days == 0 || self.stopped.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        {
            let mut r = self.run.lock().unwrap();
            if r.0 {
                r.1 = true;
                return;
            }
            if self.todo().is_empty() {
                return;
            }
            *r = (true, false);
        }
        let me = self.clone();
        std::thread::spawn(move || loop {
            me.run.lock().unwrap().1 = false;
            let n = me.pass();
            if n > 0 {
                eprintln!("Timeline previews: {n} clip(s) prepared ahead");
            }
            let mut r = me.run.lock().unwrap();
            if !(r.1 && !me.stopped.load(std::sync::atomic::Ordering::SeqCst)) {
                r.0 = false;
                return;
            }
        });
    }

    pub fn running(&self) -> bool {
        self.run.lock().unwrap().0
    }
}

#[cfg(test)]
mod tests {
    // test/scrubKeyframes.test.js, test/scrubFrames.test.js
    use super::*;
    use crate::viewer::testkit;

    fn k(index: u32, pts: f64, duration: f64) -> Key {
        Key { index, pts, duration, offset: 0, size: 1 }
    }

    #[test]
    fn which_keyframe_shows_each_second() {
        // a keyframe every second, at 0, 1, 2 (scale 1000, 0.25 s frames)
        let keys = [k(0, 0.0, 250.0), k(4, 1000.0, 250.0), k(8, 2000.0, 250.0)];
        assert_eq!(picks_for(&keys, 1000.0, None).iter().map(|x| x.index).collect::<Vec<_>>(), vec![0, 4, 8]);
        // every two seconds: each shown twice, the last one's time rounded up
        let keys = [k(0, 0.0, 1000.0), k(2, 2000.0, 1000.0), k(4, 4000.0, 1000.0)];
        assert_eq!(picks_for(&keys, 1000.0, None).iter().map(|x| x.index).collect::<Vec<_>>(), vec![0, 0, 2, 2, 4]);
        // a keyframe at 1.5 s belongs to second 2 (round half away from zero)
        let keys = [k(0, 0.0, 500.0), k(3, 1500.0, 500.0)];
        assert_eq!(picks_for(&keys, 1000.0, None).iter().map(|x| x.index).collect::<Vec<_>>(), vec![0, 0]);
        // after the edit list's end: left out
        let keys = [k(0, 0.0, 1000.0), k(1, 1000.0, 1000.0), k(2, 2000.0, 1000.0)];
        assert_eq!(picks_for(&keys, 1000.0, Some(1500.0)).len(), 2);
        assert!(picks_for(&[], 1000.0, None).is_empty());
        assert_eq!(round_near(-1.5), -2.0);
        assert_eq!(round_near(2.5), 3.0);
    }

    #[test]
    fn a_plan_from_the_sample_table() {
        let dir = testkit::tmp("scrub-plan");
        let p = dir.join("2026-10-01_10-00-00-front.mp4");
        testkit::clip(&p, 4, &vec![None; 16], 4);
        let plan = keyframe_plan(&p).unwrap();
        assert_eq!(plan.gap, 1.0);
        assert_eq!(plan.picks.iter().map(|x| x.index).collect::<Vec<_>>(), vec![0, 4, 8, 12]);
        let (ls, sets) = plan.config.as_ref().unwrap();
        assert_eq!((*ls, sets.len()), (4, 2));
        let mut out = Vec::new();
        write_picks(&p, &plan, &mut out).unwrap();
        assert!(out.starts_with(&[0, 0, 0, 1, 0x67]));
        assert_eq!(out.windows(5).filter(|w| *w == [0, 0, 0, 1, 0x65]).count(), 4);
        let sparse = dir.join("2026-10-01_10-01-00-front.mp4");
        testkit::clip(&sparse, 4, &vec![None; 16], 8);
        assert_eq!(keyframe_plan(&sparse).unwrap().gap, 2.0);
        std::fs::write(dir.join("bad.mp4"), b"not a clip").unwrap();
        assert!(keyframe_plan(&dir.join("bad.mp4")).is_none());
    }

    #[test]
    fn names_and_the_next_clip() {
        assert_eq!(is_clip_name("2026-10-01_10-00-00-FRONT.mp4").as_deref(), Some("front"));
        assert_eq!(is_clip_name("2026-10-01_10-00-00-left_repeater.mp4").as_deref(), Some("left_repeater"));
        assert!(is_clip_name("2026-10-01_10-00-00.mp4").is_none());
        assert!(is_clip_name("x2026-10-01_10-00-00-front.mp4").is_none());
        let dir = testkit::tmp("scrub-next");
        for n in ["2026-10-01_10-00-00-front.mp4", "2026-10-01_10-01-00-back.mp4", "2026-10-01_10-02-00-front.mp4", "2026-10-01_10-03-00-front.mp4"] {
            std::fs::write(dir.join(n), b"x").unwrap();
        }
        assert_eq!(ScrubFrames::next_clip_of(&dir.join("2026-10-01_10-00-00-front.mp4")), Some(dir.join("2026-10-01_10-02-00-front.mp4")));
        assert_eq!(ScrubFrames::next_clip_of(&dir.join("2026-10-01_10-03-00-front.mp4")), None);
    }

    #[test]
    fn a_grid_per_clip_cached_and_remade_when_it_changes() {
        if Command::new("ffmpeg").arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().map_or(true, |s| !s.success()) {
            eprintln!("needs ffmpeg");
            return;
        }
        let dir = testkit::tmp("scrub-grid");
        let clip = dir.join("RecentClips/2026-10-01_10-00-00-front.mp4");
        std::fs::create_dir_all(clip.parent().unwrap()).unwrap();
        let ok = Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=12:duration=3", "-c:v", "libx264", "-g", "12", "-pix_fmt", "yuv420p", "-y"])
            .arg(&clip)
            .status()
            .is_ok_and(|s| s.success());
        if !ok {
            eprintln!("needs libx264");
            return;
        }
        let frames = ScrubFrames::new(dir.join("scrub"), "ffmpeg".into(), Some("ffprobe".into()), || 2);
        let grid = frames.get(&clip, true, false, true).expect("a grid");
        assert!(grid.starts_with(dir.join("scrub")));
        let jpeg = std::fs::read(&grid).unwrap();
        assert_eq!(&jpeg[..2], &[0xff, 0xd8]);
        assert_eq!(frames.get(&clip, true, false, true), Some(grid.clone()), "cached");
        // the clip changes: another grid
        let old = SystemTime::now() - Duration::from_secs(3600);
        std::fs::File::options().write(true).open(&clip).unwrap().set_modified(old).unwrap();
        let again = frames.get(&clip, true, false, true).unwrap();
        assert_ne!(again, grid);
        assert!(frames.get(Path::new("relative.mp4"), true, false, true).is_none());
        assert!(frames.get(&dir.join("nothing.mp4"), true, false, true).is_none());
    }
}
