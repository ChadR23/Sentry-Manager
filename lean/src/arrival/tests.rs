//! test/arrivalChecksums.test.js and the record tests of
//! test/sentryUsb.test.js, ported. Parity with Node: tests/arrival_parity.rs.

use super::ctx::*;
use super::engine::{Arrival, Options};
use super::record::{self, line_for, locate, parse_record, Located, Recorder};
use super::routes;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

const DAY: f64 = 86_400_000.0;

pub fn sha(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

pub fn random(n: usize) -> Vec<u8> {
    use rand_core::RngCore;
    let mut b = vec![0u8; n];
    rand_core::OsRng.fill_bytes(&mut b);
    b
}

fn now_ms() -> f64 {
    super::js::now_ms()
}

pub fn tmp(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("lean-arrival-{tag}-{}-{}", std::process::id(), &sha(&random(8))[..12]));
    fs::create_dir_all(&p).unwrap();
    fs::canonicalize(&p).unwrap()
}

fn pad(n: u32) -> String {
    format!("{n:02}")
}

/// YYYY-MM-DD_HH-MM-SS of ms (UTC)
pub fn stamp(ms: f64) -> String {
    use chrono::{Datelike, TimeZone, Timelike, Utc};
    let d = Utc.timestamp_millis_opt(ms as i64).single().unwrap();
    format!("{}-{}-{}_{}-{}-{}", d.year(), pad(d.month()), pad(d.day()), pad(d.hour()), pad(d.minute()), pad(d.second()))
}

fn set_mtime(abs: &Path, ms: f64) {
    let t = UNIX_EPOCH + Duration::from_secs_f64(ms / 1000.0);
    let f = fs::File::options().write(true).open(abs).unwrap();
    f.set_times(fs::FileTimes::new().set_accessed(t).set_modified(t)).unwrap();
}

/// A scan of the car's folder, every file (no dot-folder pruning here: the
/// hasher's own rules must leave those out).
fn scan(base: &Path) -> Vec<ArrivedFile> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<ArrivedFile>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        let mut names: Vec<_> = rd.filter_map(Result::ok).collect();
        names.sort_by_key(|e| e.file_name());
        for e in names {
            let p = e.path();
            let md = fs::symlink_metadata(&p).unwrap();
            if md.is_dir() {
                walk(base, &p, out);
            } else if md.is_file() {
                let rel = p.strip_prefix(base).unwrap().to_string_lossy().into_owned();
                let birth = md.created().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0.0, |d| super::js::stat_ms(d.as_secs() as i64, d.subsec_nanos() as i64));
                out.push(ArrivedFile {
                    clip: rel.to_lowercase().ends_with(".mp4"),
                    size: md.size(),
                    mtime_ms: super::js::stat_ms(md.mtime(), md.mtime_nsec()),
                    ctime_ms: super::js::stat_ms(md.ctime(), md.ctime_nsec()),
                    birthtime_ms: birth,
                    rel,
                });
            }
        }
    }
    let mut out = Vec::new();
    walk(base, base, &mut out);
    out
}

#[derive(Default)]
pub struct TestCtx {
    pub base: PathBuf,
    pub inv: Mutex<Option<InventoryView>>,
    pub held: Mutex<HashSet<String>>,
    pub busy: Mutex<HashSet<String>>,
    pub idle_flag: AtomicBool,
    pub idle_fn: Option<Box<dyn Fn() -> bool + Send + Sync>>,
    pub older: Option<Arc<AtomicBool>>,
    pub codecs: Mutex<HashMap<String, KnownCodec>>,
    pub audits: Mutex<Vec<String>>,
    pub settings: Mutex<HashMap<String, bool>>,
    pub converter_log: Mutex<Vec<(String, String)>>,
}

impl ArrivalCtx for TestCtx {
    fn vehicles(&self) -> Vec<Car> {
        vec![Car { id: "car1".into(), name: "Car".into(), timezone: "UTC".into() }]
    }
    fn root_of(&self, _vid: &str) -> PathBuf {
        self.base.clone()
    }
    fn vehicle_for_path(&self, p: &str) -> Option<String> {
        let a = super::js::resolve(p);
        let b = self.base.to_string_lossy();
        (a == b || a.starts_with(&format!("{b}/"))).then(|| "car1".to_string())
    }
    fn inventory(&self, _vid: &str) -> Option<InventoryView> {
        self.inv.lock().unwrap().clone()
    }
    fn codec(&self, _vid: &str, rel: &str) -> Option<KnownCodec> {
        self.codecs.lock().unwrap().get(rel).cloned()
    }
    fn holds(&self, abs: &str) -> bool {
        self.held.lock().unwrap().contains(super::js::basename(abs))
    }
    fn busy_paths(&self) -> Vec<String> {
        self.busy.lock().unwrap().iter().cloned().collect()
    }
    fn idle(&self) -> bool {
        match &self.idle_fn {
            Some(f) => f(),
            None => self.idle_flag.load(Ordering::SeqCst),
        }
    }
    fn older_of(&self, _vid: &str) -> bool {
        self.older.as_ref().is_none_or(|o| o.load(Ordering::SeqCst))
    }
    fn set_older(&self, vid: &str, older: bool) {
        self.settings.lock().unwrap().insert(vid.into(), older);
    }
    fn audit(&self, line: &str) {
        self.audits.lock().unwrap().push(line.into());
    }
    fn log_warn(&self, _line: &str) {}
    fn log_converter(&self, level: &str, line: &str) {
        self.converter_log.lock().unwrap().push((level.into(), line.into()));
    }
}

pub struct S {
    pub base: PathBuf,
    pub root: PathBuf,
    pub ctx: Arc<TestCtx>,
    pub arrival: Arrival,
    pub encoded: Arc<Mutex<HashSet<String>>>,
    pub data_dir: PathBuf,
    pub record_file: PathBuf,
}

#[derive(Default)]
pub struct Setup {
    pub no_sentry_usb: bool,
    pub tesla_cam: bool,
    pub tune: Option<Box<dyn FnOnce(&mut Options)>>,
    pub idle_fn: Option<Box<dyn Fn() -> bool + Send + Sync>>,
    pub older: Option<Arc<AtomicBool>>,
}

/// The H.264/H.265 stand-in: the paths in `encoded` are H.265.
fn codec_of(encoded: &Arc<Mutex<HashSet<String>>>) -> super::engine::CodecOf {
    let e = encoded.clone();
    Box::new(move |p: &Path| Ok(Some(if e.lock().unwrap().contains(&*p.to_string_lossy()) { "h265".into() } else { "h264".into() })))
}

pub fn setup(o: Setup) -> S {
    let base = tmp("car");
    let root = if o.tesla_cam { base.join("TeslaCam") } else { base.clone() };
    fs::create_dir_all(&root).unwrap();
    if !o.no_sentry_usb {
        fs::create_dir(root.join(".sentryusb")).unwrap();
    }
    let ctx = Arc::new(TestCtx { base: base.clone(), idle_flag: AtomicBool::new(true), idle_fn: o.idle_fn, older: o.older, ..Default::default() });
    let data_dir = PathBuf::from(format!("{}-data", base.display()));
    let encoded = Arc::new(Mutex::new(HashSet::new()));
    let c = ctx.clone();
    let recorder = Arc::new(Recorder::new(move |d| c.vehicle_for_path(d).is_some()));
    let mut opts = Options::new(&data_dir);
    opts.settle_ms = 0.0;
    opts.rate = 0.0;
    opts.idle_wait_ms = 10;
    opts.next_cycle_ms = 10;
    opts.codec_of = codec_of(&encoded);
    if let Some(t) = o.tune {
        t(&mut opts);
    }
    let arrival = Arrival::new(ctx.clone(), recorder, opts);
    let record_file = root.join(".sentrymanager/original-checksums.sha256");
    S { base, root, ctx, arrival, encoded, data_dir, record_file }
}

impl S {
    pub fn clip_rel(&self, name: &str) -> String {
        format!("RecentClips/{}/{name}", &name[..10])
    }
    pub fn write(&self, rel: &str, bytes: &[u8]) -> PathBuf {
        let abs = self.root.join(rel);
        fs::create_dir_all(abs.parent().unwrap()).unwrap();
        // (a new file under the name, as an upload's final rename makes)
        let t = PathBuf::from(format!("{}.part-{}", abs.display(), &sha(&random(3))[..6]));
        fs::write(&t, bytes).unwrap();
        fs::rename(&t, &abs).unwrap();
        abs
    }
    pub fn scan(&self) {
        *self.ctx.inv.lock().unwrap() = Some(InventoryView { files: scan(&self.base), scanning: false });
    }
    /// Scan, every file's arrival (birth, change time) set to its mtime but those in `fresh`.
    pub fn scan_aged(&self, fresh: &[&str]) {
        self.scan();
        for f in self.ctx.inv.lock().unwrap().as_mut().unwrap().files.iter_mut() {
            if fresh.contains(&f.rel.as_str()) {
                continue;
            }
            f.birthtime_ms = f.mtime_ms;
            f.ctime_ms = f.mtime_ms;
        }
    }
    pub fn set_birth(&self, rel: &str, ms: f64) {
        for f in self.ctx.inv.lock().unwrap().as_mut().unwrap().files.iter_mut() {
            if f.rel == rel {
                f.birthtime_ms = ms;
            }
        }
    }
    pub fn lines(&self) -> Vec<(String, String)> {
        fs::read_to_string(&self.record_file).map(|t| parse_record(&t)).unwrap_or_default()
    }
    pub fn rels(&self) -> Vec<String> {
        self.lines().into_iter().map(|l| l.1).collect()
    }
    pub fn run(&self) {
        self.scan();
        self.arrival.kick_wait();
    }
    pub fn view(&self) -> Value {
        self.arrival.view("car1")
    }
    /// A hasher on the same index, whose record must not be called.
    pub fn again(&self, now: Option<f64>) -> Arrival {
        struct Never;
        impl super::RecordSink for Never {
            fn record(&self, _: &str, _: &str, _: &str) -> Result<(), super::RecordError> {
                panic!("no line expected")
            }
        }
        let mut o = Options::new(&self.data_dir);
        o.settle_ms = 0.0;
        o.rate = 0.0;
        o.codec_of = Box::new(|_| Ok(Some("h264".into())));
        if let Some(n) = now {
            o.now = Box::new(move || n);
        }
        Arrival::new(self.ctx.clone(), Arc::new(Never), o)
    }
}

impl Drop for S {
    fn drop(&mut self) {
        self.arrival.stop();
        let _ = fs::remove_dir_all(&self.base);
        let _ = fs::remove_dir_all(&self.data_dir);
    }
}

fn start_now() -> f64 {
    static NOW: std::sync::OnceLock<f64> = std::sync::OnceLock::new();
    *NOW.get_or_init(now_ms)
}

/// name(offset): a clip an hour ago plus offset
fn name(offset_ms: f64, cam: &str) -> String {
    format!("{}-{cam}.mp4", stamp(start_now() - 3_600_000.0 + offset_ms))
}

fn n(v: &Value, k: &str) -> f64 {
    v[k].as_f64().unwrap_or(f64::NAN)
}

#[test]
fn only_a_share_with_sentryusb_gets_a_record() {
    let off = setup(Setup { no_sentry_usb: true, ..Default::default() });
    off.write(&off.clip_rel(&name(0.0, "front")), &random(5000));
    off.run();
    assert!(!off.root.join(".sentrymanager").exists(), "no .sentrymanager/ on a share without Sentry USB");
    assert_eq!(off.view()["enabled"], json!(false));

    let on = setup(Setup { tesla_cam: true, ..Default::default() });
    let bytes = random(5000);
    let rel = on.clip_rel(&name(0.0, "front"));
    on.write(&rel, &bytes);
    on.run();
    assert_eq!(on.lines(), vec![(sha(&bytes), rel)], "at the share root (TeslaCam/), relpath from there");
    assert_eq!(on.view()["enabled"], json!(true));
}

#[test]
fn every_new_clip_gets_exactly_one_line_unchanged_ones_not_hashed_again() {
    let s = setup(Setup::default());
    let mut clips = HashMap::new();
    for (i, group) in [(0.0, "RecentClips"), (60_000.0, "RecentClips"), (120_000.0, "SentryClips"), (180_000.0, "SavedClips"), (240_000.0, "TeslaTrackMode")] {
        let nm = name(i, if group == "SentryClips" { "back" } else { "front" });
        let rel = match group {
            "RecentClips" => s.clip_rel(&nm),
            "TeslaTrackMode" => format!("TeslaTrackMode/{nm}"),
            g => format!("{g}/{}/{nm}", stamp(start_now() - 3_000_000.0)),
        };
        let b = random(3000 + (i / 1000.0) as usize);
        s.write(&rel, &b);
        clips.insert(rel, sha(&b));
    }
    s.run();
    let got: HashMap<String, String> = s.lines().into_iter().map(|(h, r)| (r, h)).collect();
    assert_eq!(s.lines().len(), 5);
    assert_eq!(got, clips);
    let v = s.view();
    assert_eq!(n(&v, "today"), 5.0);
    assert_eq!(n(&v, "pending"), 0.0);
    assert!(n(&v, "lastAt") > start_now() - 60_000.0);
    let bytes = s.arrival.hashed_bytes();
    s.run();
    s.run();
    assert_eq!(s.lines().len(), 5, "no second line");
    assert_eq!(s.arrival.hashed_bytes(), bytes, "nothing read again");
    // the index survives a restart: a new hasher on the same folder reads nothing either
    let again = s.again(None);
    again.kick_wait();
    assert_eq!(again.hashed_bytes(), 0);
}

#[test]
fn a_re_upload_gets_a_new_line_the_later_one_wins() {
    let s = setup(Setup::default());
    let rel = s.clip_rel(&name(0.0, "front"));
    let damaged = random(4000);
    s.write(&rel, &damaged);
    s.run();
    let good = random(4000);
    s.write(&rel, &good);
    s.run();
    assert_eq!(s.lines().into_iter().map(|l| l.0).collect::<Vec<_>>(), vec![sha(&damaged), sha(&good)]);
}

#[test]
fn clips_sentry_usb_is_still_copying_wait_and_a_busy_clip_waits_too() {
    let s = setup(Setup::default());
    let a = name(0.0, "front");
    let b = name(60_000.0, "front");
    s.write(&s.clip_rel(&a), &random(1000));
    s.write(&s.clip_rel(&b), &random(1000));
    s.ctx.held.lock().unwrap().insert(a.clone());
    s.ctx.busy.lock().unwrap().insert(s.root.join(s.clip_rel(&b)).to_string_lossy().into_owned());
    s.run();
    assert!(s.lines().is_empty());
    assert_eq!(n(&s.view(), "pending"), 2.0, "both waiting");
    s.ctx.held.lock().unwrap().clear();
    s.run();
    assert_eq!(s.rels().iter().map(|r| super::js::basename(r).to_string()).collect::<Vec<_>>(), vec![a]);
    s.ctx.busy.lock().unwrap().clear();
    s.run();
    assert_eq!(s.lines().len(), 2);
    assert_eq!(n(&s.view(), "pending"), 0.0);
}

#[test]
fn our_own_in_place_conversion_never_gets_a_line_of_the_converted_bytes() {
    let s = setup(Setup::default());
    let rel = s.clip_rel(&name(0.0, "front"));
    let abs = s.root.join(&rel);
    let original = random(6000);
    s.write(&rel, &original);
    // the converter: the original's line first, then the replace (a new inode), then onClipConverted
    let rec = Recorder::new(|_| true);
    rec.record(&abs.to_string_lossy(), Some(&s.base.to_string_lossy()), &sha(&original)).unwrap();
    s.write(&rel, &random(2000));
    s.encoded.lock().unwrap().insert(abs.to_string_lossy().into_owned());
    s.arrival.converted(&abs.to_string_lossy());
    s.run();
    assert_eq!(s.lines(), vec![(sha(&original), rel.clone())]);
    // also when the hasher had recorded the original before it was converted
    let rel2 = s.clip_rel(&name(60_000.0, "front"));
    let abs2 = s.root.join(&rel2);
    let orig2 = random(6000);
    s.write(&rel2, &orig2);
    s.run();
    rec.record(&abs2.to_string_lossy(), Some(&s.base.to_string_lossy()), &sha(&orig2)).unwrap();
    s.write(&rel2, &random(1500));
    s.encoded.lock().unwrap().insert(abs2.to_string_lossy().into_owned());
    s.arrival.converted(&abs2.to_string_lossy());
    s.run();
    let got: Vec<String> = s.lines().into_iter().filter(|l| l.1 == rel2).map(|l| l.0).collect();
    assert_eq!(got, vec![sha(&orig2), sha(&orig2)], "only the original's hash, ever");
    assert_eq!(s.arrival.hashed_bytes(), 6000, "only the second original was read: never a converted file");
}

#[test]
fn an_h265_clip_we_did_not_convert_is_skipped_one_kept_as_h264_is_hashed() {
    let s = setup(Setup::default());
    let rel = s.clip_rel(&name(0.0, "front"));
    let abs = s.write(&rel, &random(3000));
    s.encoded.lock().unwrap().insert(abs.to_string_lossy().into_owned());
    s.run();
    assert!(s.lines().is_empty());
    assert_eq!(n(&s.view(), "pending"), 0.0, "not counted as waiting");
    // the codec the inventory already knows is used for an unchanged file (no read)
    let rel2 = s.clip_rel(&name(60_000.0, "front"));
    let abs2 = s.write(&rel2, &random(3000));
    let md = fs::metadata(&abs2).unwrap();
    s.ctx.codecs.lock().unwrap().insert(rel2.clone(), KnownCodec { size: md.size(), mtime_ms: super::js::stat_ms(md.mtime(), md.mtime_nsec()), codec: Some("av1".into()) });
    s.run();
    assert!(s.lines().is_empty());
    // onClipConverted for a clip that kept its original (no savings): still the original, hashed
    let rel3 = s.clip_rel(&name(120_000.0, "front"));
    let bytes3 = random(3000);
    let abs3 = s.write(&rel3, &bytes3);
    s.arrival.converted(&abs3.to_string_lossy());
    s.run();
    assert_eq!(s.lines(), vec![(sha(&bytes3), rel3)]);
}

#[test]
fn a_clip_checked_in_the_very_millisecond_it_was_written_is_not_still_settling() {
    let clock = Arc::new(Mutex::new(now_ms()));
    let c = clock.clone();
    let s = setup(Setup { tune: Some(Box::new(move |o| o.now = Box::new(move || *c.lock().unwrap()))), ..Default::default() });
    let rel = s.clip_rel(&name(0.0, "front"));
    let bytes = random(1000);
    let abs = s.write(&rel, &bytes);
    let md = fs::metadata(&abs).unwrap();
    let x = super::js::stat_ms(md.ctime(), md.ctime_nsec()).floor() + 5000.0;
    set_mtime(&abs, x + 0.5);
    let md = fs::metadata(&abs).unwrap();
    let m = super::js::stat_ms(md.mtime(), md.mtime_nsec());
    assert!(m > x && m < x + 1.0 && super::js::stat_ms(md.ctime(), md.ctime_nsec()) < x, "a fraction of a millisecond into x");
    *clock.lock().unwrap() = x;
    s.run();
    assert_eq!(s.lines(), vec![(sha(&bytes), rel)]);
}

#[test]
fn mismatch_copies_dot_names_converter_names_and_other_folders_are_skipped() {
    let s = setup(Setup::default());
    let nm = name(0.0, "front");
    let dir = format!("RecentClips/{}", &nm[..10]);
    for rel in [
        format!("{dir}/{nm}.mismatch-1762646400"),
        format!("{dir}/.sentryusb-partial/{nm}"),
        format!(".sentryusbtmp/{nm}"),
        format!("{dir}/TEMP-H265-{nm}"),
        format!("{dir}/BACKUP-{nm}"),
        format!("{dir}/.{nm}"),
        format!("Other/{nm}"),
        format!("{dir}/notes.mp4"),
    ] {
        s.write(&rel, &random(500));
    }
    s.run();
    assert!(s.lines().is_empty());
    assert_eq!(s.arrival.hashed_bytes(), 0);
}

#[test]
fn a_file_replaced_while_it_is_being_hashed_is_dropped_then_hashed_as_the_new_file() {
    let calls = Arc::new(AtomicUsize::new(0));
    let replaced: Arc<Mutex<Option<Vec<u8>>>> = Arc::new(Mutex::new(None));
    let target: Arc<Mutex<Option<PathBuf>>> = Arc::new(Mutex::new(None));
    let (c, r, t) = (calls.clone(), replaced.clone(), target.clone());
    let idle = move || {
        let k = c.fetch_add(1, Ordering::SeqCst) + 1;
        let mut r = r.lock().unwrap();
        // mid-hash (the second chunk of a 3 MiB file): a new file under the name
        if r.is_none() && k == 3 {
            if let Some(abs) = t.lock().unwrap().clone() {
                let b = random(1000);
                let new = PathBuf::from(format!("{}.new", abs.display()));
                fs::write(&new, &b).unwrap();
                fs::rename(&new, &abs).unwrap();
                *r = Some(b);
            }
        }
        true
    };
    let s = setup(Setup { idle_fn: Some(Box::new(idle)), ..Default::default() });
    let rel = s.clip_rel(&name(0.0, "front"));
    let abs = s.write(&rel, &random(3 * 1024 * 1024));
    *target.lock().unwrap() = Some(abs);
    calls.store(0, Ordering::SeqCst);
    s.scan();
    s.arrival.kick_wait();
    let new = replaced.lock().unwrap().clone().expect("replaced mid-hash");
    assert!(s.lines().is_empty(), "the old file's hash is not written");
    assert_eq!(n(&s.view(), "pending"), 1.0);
    s.run();
    assert_eq!(s.lines(), vec![(sha(&new), rel)]);
}

struct Old {
    rel: String,
    abs: PathBuf,
    bytes: Vec<u8>,
}

/// A clip `age_ms` old (its name, modification and arrival time), in group/day folders.
fn old_clip(s: &S, age_ms: f64, group: &str, cam: &str, bytes: Option<Vec<u8>>) -> Old {
    let t = start_now() - age_ms;
    let nm = format!("{}-{cam}.mp4", stamp(t));
    let rel = if group == "RecentClips" { format!("RecentClips/{}/{nm}", &nm[..10]) } else { format!("{group}/{}/{nm}", stamp(t + 60_000.0)) };
    let bytes = bytes.unwrap_or_else(|| random(1500));
    let abs = s.write(&rel, &bytes);
    set_mtime(&abs, t);
    Old { rel, abs, bytes }
}

#[test]
fn every_clip_gets_a_line_by_default_however_old_the_backlog_shows_its_progress() {
    let s = setup(Setup::default());
    let mut clips = Vec::new();
    for age in [3.0 * DAY, 20.0 * DAY, 200.0 * DAY, 3.0 * 365.0 * DAY] {
        clips.push(old_clip(&s, age, "RecentClips", "front", None));
    }
    clips.push(old_clip(&s, 400.0 * DAY, "SentryClips", "back", None));
    s.scan_aged(&[]);
    s.arrival.kick_wait();
    let got: HashMap<String, String> = s.lines().into_iter().map(|(h, r)| (r, h)).collect();
    let want: HashMap<String, String> = clips.iter().map(|c| (c.rel.clone(), sha(&c.bytes))).collect();
    assert_eq!(got, want, "all ages, one line each");
    let v = s.view();
    assert_eq!(v["older"], json!(true));
    assert_eq!(v["backlog"], json!({ "total": 4, "done": 4, "left": 0, "failed": 0, "bytesLeft": 0, "etaMinutes": 0 }), "the 4 older than the 7-day window, all done");
    assert_eq!(n(&v, "lines"), 5.0);
}

#[test]
fn newest_first_and_what_arrived_lately_always_before_the_backlog() {
    let s = setup(Setup::default());
    let a = old_clip(&s, 300.0 * DAY, "RecentClips", "front", None);
    let b = old_clip(&s, 30.0 * DAY, "RecentClips", "front", None);
    let c = old_clip(&s, 90.0 * DAY, "RecentClips", "front", None);
    let d = old_clip(&s, 2.0 * DAY, "RecentClips", "front", None);
    let e = old_clip(&s, 500.0 * DAY, "RecentClips", "front", None); // reached the share just now
    s.scan_aged(&[&e.rel]);
    s.set_birth(&e.rel, start_now() - 600_000.0);
    s.arrival.kick_wait();
    assert_eq!(s.rels(), vec![e.rel, d.rel, b.rel, c.rel, a.rel], "fresh arrival, then the window, then the backlog newest first");

    // a pass reading the backlog stops for new arrivals (a kick): the next pass takes them first
    let t = setup(Setup { tune: Some(Box::new(|o| o.rate = 2.0 * 1024.0 * 1024.0)), ..Default::default() });
    let mut old = Vec::new();
    for i in 0..4 {
        old.push(old_clip(&t, (30 + i) as f64 * DAY, "RecentClips", "front", Some(random(1024 * 1024))));
    }
    t.scan_aged(&[]);
    t.arrival.kick();
    for _ in 0..200 {
        if !t.lines().is_empty() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let fresh = t.write(&t.clip_rel(&name(0.0, "front")), &random(1000));
    let fresh_rel = fresh.strip_prefix(&t.root).unwrap().to_string_lossy().into_owned();
    t.scan_aged(&[&fresh_rel]);
    t.arrival.kick();
    t.arrival.settled();
    let rels = t.rels();
    assert_eq!(rels.len(), 5);
    let at = rels.iter().position(|r| *r == fresh_rel).unwrap();
    assert!((1..=2).contains(&at), "the new arrival came straight after the clip being read (at {at} of {rels:?})");
    let rest: Vec<String> = rels.iter().enumerate().filter(|(i, _)| *i != at).map(|(_, r)| r.clone()).collect();
    assert_eq!(rest, old.iter().map(|o| o.rel.clone()).collect::<Vec<_>>(), "the backlog newest first");
}

#[test]
fn an_unchanged_clip_keeps_its_entry_past_45_days_gone_clips_lose_theirs() {
    let clock: Arc<Mutex<Option<f64>>> = Arc::new(Mutex::new(None));
    let c = clock.clone();
    let s = setup(Setup { tune: Some(Box::new(move |o| o.now = Box::new(move || c.lock().unwrap().unwrap_or_else(now_ms)))), ..Default::default() });
    let _a = old_clip(&s, 10.0 * DAY, "RecentClips", "front", None);
    let b = old_clip(&s, 11.0 * DAY, "RecentClips", "front", None);
    s.scan_aged(&[]);
    s.arrival.kick_wait();
    assert_eq!(s.lines().len(), 2);
    let bytes = s.arrival.hashed_bytes();
    // 60 days on: the record's lines may be pruned, the clips are the same
    let later = now_ms() + 60.0 * DAY;
    *clock.lock().unwrap() = Some(later);
    fs::write(&s.record_file, "").unwrap();
    s.arrival.kick_wait();
    assert_eq!(s.arrival.hashed_bytes(), bytes, "nothing read again");
    assert!(s.lines().is_empty(), "no new line");
    assert_eq!(n(&s.view(), "lines"), 2.0, "both entries kept");
    // a new hasher on the same index (a restart) knows them too
    let again = s.again(Some(later));
    again.kick_wait();
    assert_eq!(again.hashed_bytes(), 0);
    // gone from the share: its entry goes (and stays gone after a restart)
    fs::remove_file(&b.abs).unwrap();
    s.scan_aged(&[]);
    s.arrival.kick_wait();
    assert_eq!(n(&s.view(), "lines"), 1.0);
    s.arrival.stop();
    let third = s.again(Some(later));
    assert_eq!(n(&third.view("car1"), "lines"), 1.0);
}

#[test]
fn older_clips_off_only_the_7_day_window_on_again_the_rest_follows() {
    let older = Arc::new(AtomicBool::new(false));
    let s = setup(Setup { older: Some(older.clone()), ..Default::default() });
    let recent = old_clip(&s, 3.0 * DAY, "RecentClips", "front", None);
    let old = old_clip(&s, 20.0 * DAY, "RecentClips", "front", None);
    s.scan_aged(&[]);
    s.arrival.kick_wait();
    assert_eq!(s.rels(), vec![recent.rel.clone()], "outside the 7 days: not read");
    let v = s.view();
    assert_eq!(v["older"], json!(false));
    assert_eq!(v["backlog"], Value::Null);
    // one that arrived only now (birth time), though recorded 20 days ago: in
    let late = old_clip(&s, 25.0 * DAY, "RecentClips", "front", None);
    s.scan_aged(&[&late.rel]);
    s.set_birth(&late.rel, start_now() - 3_600_000.0);
    s.arrival.kick_wait();
    assert_eq!(s.rels(), vec![recent.rel.clone(), late.rel.clone()]);
    older.store(true, Ordering::SeqCst);
    s.scan_aged(&[]);
    s.arrival.kick_wait();
    assert_eq!(s.rels(), vec![recent.rel, late.rel, old.rel]);
    let v = s.view();
    assert_eq!(v["backlog"]["done"], v["backlog"]["total"]);
}

#[test]
fn backlog_progress_while_it_runs() {
    let s = setup(Setup {
        tune: Some(Box::new(|o| {
            o.per_cycle = 2;
            o.next_cycle_ms = 60_000;
        })),
        ..Default::default()
    });
    for i in 0..5 {
        old_clip(&s, (30 + i) as f64 * DAY, "RecentClips", "front", Some(random(1000 + i)));
    }
    s.scan_aged(&[]);
    s.arrival.kick_wait();
    let v = s.view();
    assert_eq!(n(&v["backlog"], "total"), 5.0);
    assert_eq!(n(&v["backlog"], "done"), 2.0, "the cap: 2 a pass");
    assert_eq!(n(&v["backlog"], "left"), 3.0);
    assert_eq!(n(&v["backlog"], "bytesLeft"), (1002 + 1003 + 1004) as f64, "the oldest three are left (newest first)");
    assert!(n(&v["backlog"], "etaMinutes") >= 1.0, "at least a minute (the next passes)");
    assert_eq!(n(&v, "pending"), 0.0, "the backlog is not \"waiting\"");
}

#[test]
fn a_clip_that_arrived_recently_is_recorded_even_when_its_own_time_is_old() {
    let s = setup(Setup::default());
    let old = start_now() - 10.0 * DAY;
    let nm = format!("{}-front.mp4", stamp(old));
    let rel = format!("RecentClips/{}/{nm}", &nm[..10]);
    let abs = s.write(&rel, &random(800));
    set_mtime(&abs, old); // rsync keeps the clip's mtime
    s.scan();
    s.set_birth(&rel, start_now() - 3_600_000.0);
    s.arrival.kick_wait();
    assert_eq!(s.lines().len(), 1);
}

#[test]
fn nothing_is_read_while_a_conversion_or_the_benchmark_runs() {
    let s = setup(Setup::default());
    s.write(&s.clip_rel(&name(0.0, "front")), &random(1000));
    s.scan();
    s.ctx.idle_flag.store(false, Ordering::SeqCst);
    s.arrival.kick();
    std::thread::sleep(Duration::from_millis(120));
    assert_eq!(s.arrival.hashed_bytes(), 0);
    assert!(s.lines().is_empty());
    s.ctx.idle_flag.store(true, Ordering::SeqCst);
    s.arrival.settled();
    assert_eq!(s.lines().len(), 1);
}

#[test]
fn a_pass_stops_at_its_cap_and_the_next_one_carries_on_the_rate_limit_holds() {
    let s = setup(Setup {
        tune: Some(Box::new(|o| {
            o.per_cycle = 2;
            o.rate = 4.0 * 1024.0 * 1024.0;
        })),
        ..Default::default()
    });
    for i in 0..5 {
        s.write(&s.clip_rel(&name(i as f64 * 60_000.0, "front")), &random(1024 * 1024));
    }
    s.scan();
    let t0 = std::time::Instant::now();
    s.arrival.kick_wait();
    assert_eq!(s.lines().len(), 2, "first pass: 2");
    assert_eq!(n(&s.view(), "pending"), 3.0);
    assert!(t0.elapsed() >= Duration::from_millis(400), "2 MiB at 4 MiB/s takes about half a second");
    for _ in 0..100 {
        if s.lines().len() >= 5 {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    s.arrival.settled();
    assert_eq!(s.lines().len(), 5, "the next passes carry on by themselves");
}

#[test]
fn the_index_is_compact_and_written_in_batches_a_v1_index_is_read() {
    let s = setup(Setup {
        tune: Some(Box::new(|o| {
            o.save_every = 10;
            o.compact_min = 25;
        })),
        ..Default::default()
    });
    // the 12 clips share one day's folder
    let crosses = name(0.0, "front")[..10] != name(11.0 * 60_000.0, "front")[..10];
    let first = if crosses { -13.0 * 60_000.0 } else { 0.0 };
    for i in 0..12 {
        s.write(&s.clip_rel(&name(first + i as f64 * 60_000.0, "front")), &random(200));
    }
    s.run();
    let snap: Value = serde_json::from_str(&fs::read_to_string(s.data_dir.join("car1.json")).unwrap()).unwrap();
    assert_eq!(snap["v"], json!(2));
    let dirs = snap["dirs"].as_object().unwrap();
    assert_eq!(dirs.len(), 1, "by folder");
    assert_eq!(dirs.values().next().unwrap().as_object().unwrap().len(), 10, "the first batch (10) in the snapshot");
    let journal = fs::read_to_string(s.data_dir.join("car1.log")).unwrap();
    assert_eq!(journal.trim().split('\n').count(), 2, "the rest appended");
    for i in 12..40 {
        s.write(&s.clip_rel(&name(i as f64 * 60_000.0, "front")), &random(200));
    }
    s.run();
    let snap2: Value = serde_json::from_str(&fs::read_to_string(s.data_dir.join("car1.json")).unwrap()).unwrap();
    let in_snap: usize = snap2["dirs"].as_object().unwrap().values().map(|d| d.as_object().unwrap().len()).sum();
    let in_log = fs::read_to_string(s.data_dir.join("car1.log")).map(|t| t.trim().split('\n').filter(|l| !l.is_empty()).count()).unwrap_or(0);
    assert!(in_snap >= 30 && in_snap + in_log >= 40, "{in_snap} + {in_log}");
    // a torn journal line is skipped; a v1 index is read and rewritten as v2
    let mut f = fs::OpenOptions::new().append(true).create(true).open(s.data_dir.join("car1.log")).unwrap();
    std::io::Write::write_all(&mut f, b"[\"RecentClips/x.mp4\",1,").unwrap();
    drop(f);
    let v1dir = PathBuf::from(format!("{}-v1", s.base.display()));
    fs::create_dir_all(&v1dir).unwrap();
    let one = s.ctx.inv.lock().unwrap().as_ref().unwrap().files.iter().find(|f| f.clip && f.rel.starts_with("RecentClips/")).unwrap().clone();
    let md = fs::metadata(s.base.join(&one.rel)).unwrap();
    let entry = json!([md.size(), super::js::stat_ms(md.mtime(), md.mtime_nsec()), md.ino(), start_now(), "h"]);
    fs::write(v1dir.join("car1.json"), json!({ "v": 1, "files": { one.rel.clone(): entry } }).to_string()).unwrap();
    let reread = s.again(None);
    assert_eq!(n(&reread.view("car1"), "lines"), 40.0);
    struct Count(AtomicUsize);
    impl super::RecordSink for Count {
        fn record(&self, _: &str, _: &str, _: &str) -> Result<(), super::RecordError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }
    let count = Arc::new(Count(AtomicUsize::new(0)));
    let mut o = Options::new(&v1dir);
    o.settle_ms = 0.0;
    o.rate = 0.0;
    o.codec_of = Box::new(|_| Ok(Some("h264".into())));
    let from_v1 = Arrival::new(s.ctx.clone(), count.clone(), o);
    assert_eq!(n(&from_v1.view("car1"), "lines"), 1.0);
    from_v1.kick_wait();
    assert_eq!(count.0.load(Ordering::SeqCst), 39, "the clip the v1 index knew is not read again");
    let v: Value = serde_json::from_str(&fs::read_to_string(v1dir.join("car1.json")).unwrap()).unwrap();
    assert_eq!(v["v"], json!(2));
    let _ = fs::remove_dir_all(&v1dir);
}

#[test]
fn index_entries_of_gone_clips_are_dropped_and_the_route_logic() {
    let s = setup(Setup::default());
    let rel = s.clip_rel(&name(0.0, "front"));
    s.write(&rel, &random(1000));
    s.run();
    assert_eq!(n(&s.view(), "lines"), 1.0);
    fs::remove_file(s.root.join(&rel)).unwrap();
    s.run();
    assert_eq!(n(&s.view(), "lines"), 0.0);
    // POST /api/vehicles/:id/sentry-usb/record
    let e = routes::post_record(&s.arrival, &*s.ctx, "car1", "Car", &json!({ "older": "yes" }), "admin").unwrap_err();
    assert_eq!((e.status, e.message.as_str()), (400, routes::OLDER_REQUIRED));
    routes::post_record(&s.arrival, &*s.ctx, "car1", "Car", &json!({ "older": false }), "admin (from 10.0.0.2)").unwrap();
    s.arrival.settled();
    assert_eq!(s.ctx.settings.lock().unwrap().get("car1"), Some(&false));
    assert_eq!(s.ctx.audits.lock().unwrap().as_slice(), ["Checksum record of \"Car\": older clips off: admin (from 10.0.0.2)"]);
    let v = routes::record_view(&s.arrival, "car1", true);
    let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["enabled", "today", "lastAt", "pending", "lines", "windowDays", "older", "backlog", "canBackfill"]);
    assert_eq!(v["windowDays"], json!(7));
    // a vehicle removed: its index files go
    s.write(&s.clip_rel(&name(60_000.0, "front")), &random(1000));
    s.run();
    let (snap, _) = s.arrival.index_files("car1");
    assert!(snap.exists());
    routes::vehicle_removed(&s.arrival, &*s.ctx, "car1");
    assert!(!snap.exists());
}

// ---- the checksum record (test/sentryUsb.test.js) -------------------------------

#[test]
fn record_share_root_is_the_folder_above_the_group_folder() {
    let l = |root: &str, rel: &str| Some(Located { root: root.into(), rel: rel.into() });
    assert_eq!(locate("/footage/car/RecentClips/2026-11-08/2026-11-08_12-59-00-front.mp4", Some("/footage/car")), l("/footage/car", "RecentClips/2026-11-08/2026-11-08_12-59-00-front.mp4"));
    assert_eq!(
        locate("/footage/car/TeslaCam/SentryClips/2026-11-08_13-00-00/2026-11-08_12-59-00-back.mp4", Some("/footage/car")),
        l("/footage/car/TeslaCam", "SentryClips/2026-11-08_13-00-00/2026-11-08_12-59-00-back.mp4")
    );
    assert_eq!(
        locate("/footage/car/TeslaCam/RecentClips/2026-11-08_12-59-00-front.mp4", Some("/footage/car/TeslaCam/RecentClips")),
        l("/footage/car/TeslaCam", "RecentClips/2026-11-08_12-59-00-front.mp4"),
        "a job of one group folder still records at the share root"
    );
    assert_eq!(locate("/footage/car/misc/clip.mp4", Some("/footage/car")), l("/footage/car", "misc/clip.mp4"), "no group folder: the job folder");
    assert_eq!(locate("/elsewhere/clip.mp4", Some("/footage/car")), None);
    assert_eq!(locate("/RecentClips/clip.mp4", None), None);
    assert_eq!(line_for(&"A".repeat(64), "RecentClips/x.mp4").unwrap(), format!("{}  RecentClips/x.mp4\n", "a".repeat(64)), "lowercase hex, two spaces, LF");
    assert!(line_for(&"a".repeat(64), "RecentClips/a\nb.mp4").is_err());
    assert!(line_for("xyz", "RecentClips/a.mp4").is_err());
    assert!(line_for(&"a".repeat(64), "./a.mp4").is_err());
}

#[test]
fn record_appended_fsynced_folder_created_concurrent_appends_are_whole_lines() {
    let root = tmp("rec");
    let share = root.join("car/TeslaCam");
    let clips = share.join("RecentClips/2026-11-08");
    fs::create_dir_all(&clips).unwrap();
    let car = root.join("car").to_string_lossy().into_owned();
    let c2 = car.clone();
    let rec = Arc::new(Recorder::new(move |d| d.starts_with(&c2)));
    let names: Vec<String> = (0..40).map(|i| format!("2026-11-08_12-{i:02}-00-front.mp4")).collect();
    let handles: Vec<_> = names
        .iter()
        .map(|nm| {
            let (rec, src, car) = (rec.clone(), clips.join(nm).to_string_lossy().into_owned(), car.clone());
            let h = sha(nm.as_bytes());
            std::thread::spawn(move || rec.record(&src, Some(&car), &h).unwrap())
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    let file = share.join(".sentrymanager/original-checksums.sha256");
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.ends_with('\n'));
    let lines: Vec<&str> = text.split('\n').filter(|l| !l.is_empty()).collect();
    assert_eq!(lines.len(), 40, "every append is one whole line");
    let got: HashSet<String> = parse_record(&text).into_iter().map(|l| l.1).collect();
    assert_eq!(got, names.iter().map(|n| format!("RecentClips/2026-11-08/{n}")).collect::<HashSet<_>>());
    // the same clip again: appended, the last one counts
    let rel = format!("RecentClips/2026-11-08/{}", names[0]);
    rec.record(&clips.join(&names[0]).to_string_lossy(), Some(&car), &"b".repeat(64)).unwrap();
    let all: Vec<String> = parse_record(&fs::read_to_string(&file).unwrap()).into_iter().filter(|l| l.1 == rel).map(|l| l.0).collect();
    assert_eq!(all, vec![sha(names[0].as_bytes()), "b".repeat(64)], "never deduped: the later line wins for the reader");
    assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o644 & !umask());
    assert!(!fs::read_dir(share.join(".sentrymanager")).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().contains(".tmp-")), "no temporary files left");
    // a group folder above the vehicle's own folder: the job's folder then; outside it: refused
    let e = rec.record("/elsewhere/RecentClips/x.mp4", Some(&car), &"c".repeat(64)).unwrap_err();
    assert_eq!(e.message, "No share root for /elsewhere/RecentClips/x.mp4");
    let _ = fs::remove_dir_all(&root);
}

fn umask() -> u32 {
    let m = unsafe { libc::umask(0o022) };
    unsafe { libc::umask(m) };
    m as u32
}

#[test]
fn record_pruning_keeps_45_days_by_when_lines_were_written() {
    let root = tmp("prune");
    let share = root.join("car");
    fs::create_dir_all(share.join("RecentClips")).unwrap();
    let base = 1_767_268_800_000.0; // Date.UTC(2026, 0, 1, 12)
    let clock = Arc::new(Mutex::new(base));
    let c = clock.clone();
    let rec = Recorder::new(|_| true).with_clock(move || *c.lock().unwrap());
    let add = |nm: &str, h: &str| rec.record(&share.join("RecentClips").join(nm).to_string_lossy(), Some(&share.to_string_lossy()), h).unwrap();
    let file = share.join(".sentrymanager/original-checksums.sha256");
    add("2020-05-05_10-00-00-front.mp4", &"1".repeat(64));
    add("2026-01-01_10-00-00-front.mp4", &"2".repeat(64));
    for day in 1..=60 {
        *clock.lock().unwrap() = base + day as f64 * DAY;
        add(&format!("2026-01-{:02}_11-00-00-front.mp4", 1 + (day % 28)), &sha(day.to_string().as_bytes()));
        let kept: HashSet<String> = parse_record(&fs::read_to_string(&file).unwrap()).into_iter().map(|l| l.0).collect();
        for back in 0..30 {
            if day - back >= 1 {
                assert!(kept.contains(&sha((day - back).to_string().as_bytes())), "day {day}: the line of day {} is kept", day - back);
            }
        }
        if day < 45 {
            assert!(kept.contains(&"1".repeat(64)), "day {day}: the backlog clip of day 0 is still kept");
        }
    }
    let lines = parse_record(&fs::read_to_string(&file).unwrap());
    assert!(!lines.iter().any(|l| l.0 == "1".repeat(64)), "after 52+ days the oldest lines went");
    assert!(lines.len() < 62 && lines.len() >= 45, "pruned to the last weeks ({} lines)", lines.len());
    assert!(!fs::read_dir(share.join(".sentrymanager")).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().contains(".tmp-")));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn record_a_torn_last_line_gets_a_line_of_its_own() {
    let root = tmp("torn");
    let dir = root.join(".sentrymanager");
    fs::create_dir_all(&dir).unwrap();
    fs::create_dir_all(root.join("RecentClips")).unwrap();
    fs::write(dir.join(record::FILE), "abc").unwrap();
    let rec = Recorder::new(|_| true).with_clock(|| 1_767_268_800_000.0);
    rec.record(&root.join("RecentClips/a.mp4").to_string_lossy(), None, &"d".repeat(64)).unwrap();
    assert_eq!(fs::read_to_string(dir.join(record::FILE)).unwrap(), format!("abc\n{}  RecentClips/a.mp4\n", "d".repeat(64)));
    assert_eq!(fs::read_to_string(dir.join(record::MARKS)).unwrap(), r#"{"v":1,"marks":[{"day":"2026-01-01","offset":4}]}"#);
    let _ = fs::remove_dir_all(&root);
}

// ---- the converter's before-replace hook ----------------------------------------

#[test]
fn before_replace_records_the_original_or_keeps_it_with_the_error_line() {
    let root = tmp("hook");
    let clips = root.join("car/RecentClips/2026-11-08");
    fs::create_dir_all(&clips).unwrap();
    let src = clips.join("2026-11-08_12-59-00-front.mp4").to_string_lossy().into_owned();
    let car = root.join("car").to_string_lossy().into_owned();
    let rec = Arc::new(Recorder::new(|_| true));
    let errors: Arc<Mutex<Vec<String>>> = Arc::default();
    let e2 = errors.clone();
    let hook = record::before_replace_fn(rec, Arc::new(move |l| e2.lock().unwrap().push(l.to_string())));
    let req = |sha: &str| {
        let r = crate::converter::staging::BeforeReplace { source: &src, source_root: &car, sha256: sha, size: 1, job_id: "job-1", item_id: "item-000001" };
        hook(&r)
    };
    req(&"e".repeat(64)).unwrap();
    assert_eq!(fs::read_to_string(root.join("car/.sentrymanager/original-checksums.sha256")).unwrap(), format!("{}  RecentClips/2026-11-08/2026-11-08_12-59-00-front.mp4\n", "e".repeat(64)));
    assert!(req("nope").is_err());
    assert_eq!(errors.lock().unwrap().as_slice(), ["Could not record the original's checksum for Sentry USB, so it was kept: 2026-11-08_12-59-00-front.mp4: Not a SHA-256"]);
    // a share that cannot be written: the code, as Node's err.code
    let ro = root.join("ro");
    fs::create_dir_all(ro.join("RecentClips")).unwrap();
    fs::set_permissions(&ro, fs::Permissions::from_mode(0o555)).unwrap();
    let is_root = unsafe { libc::geteuid() } == 0;
    let r = record::before_replace_original(&Recorder::new(|_| true), &ro.join("RecentClips/a.mp4").to_string_lossy(), &ro.to_string_lossy(), &"f".repeat(64), &|l| errors.lock().unwrap().push(l.into()));
    if !is_root {
        assert!(r.is_err());
        assert!(errors.lock().unwrap().last().unwrap().ends_with(": a.mp4: EACCES"));
    }
    fs::set_permissions(&ro, fs::Permissions::from_mode(0o755)).unwrap();
    let _ = fs::remove_dir_all(&root);
}
