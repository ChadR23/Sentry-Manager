//! Event-centred clip selection, preview scheduling and the private image route.
use crate::app::{Vehicle, VehicleState};
use crate::converter::preview::{LevelResult, PreviewClip};
use crate::converter::process::{BoundedRunner, RunOptions, Runner};
use crate::footage::{inventory::Recording, tz};
use crate::viewer::speed_index::SpeedIndex;
use chrono::{Datelike, NaiveDateTime, Timelike};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Borrow a snapshot from App::state_of for the selected vehicle. No scan or
/// speed-index pass is started; no inventory lock is held while decoding.
pub struct Inventory<'a> {
    pub vehicle: &'a Vehicle,
    pub state: &'a VehicleState,
    pub speed_index: Option<&'a SpeedIndex>,
    pub ffmpeg: &'a str,
}

/// Saved first, then Sentry, filling from the other kind when needed. A Recent
/// clip is a last resort, never a second pick beside an event. Event ids are
/// Recording::event_id; Recent drives use Recording::id (they have no event id).
/// The preview runner, not this selector, decides the actual six-second window.
pub fn pick_clips(inv: &Inventory<'_>, vehicle_tz: &str, exclude: &[String], want: usize) -> Vec<PreviewClip> {
    pick_clips_with(inv, vehicle_tz, exclude, want, &|path, at| frame_lumas(inv.ffmpeg, path, at))
}

type Decode<'a> = dyn Fn(&Path, [i64; 3]) -> Option<[f64; 3]> + 'a;

fn local_ms(t: NaiveDateTime, zone: &str) -> i64 {
    tz::zoned_to_utc(t.year(), t.month(), t.day(), t.hour(), t.minute(), t.second(), zone) as i64
        + t.and_utc().timestamp_subsec_millis() as i64
}

fn event_ms(stamp: &str, zone: &str) -> Option<i64> {
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(stamp) { return Some(t.timestamp_millis()); }
    NaiveDateTime::parse_from_str(stamp, "%Y-%m-%dT%H:%M:%S%.f").ok().map(|t| local_ms(t, zone))
}

fn clip_time(rel: &str) -> Option<NaiveDateTime> {
    let name = rel.rsplit('/').next()?;
    NaiveDateTime::parse_from_str(crate::footage::ts_from(name)?, "%Y-%m-%d_%H-%M-%S").ok()
}

fn inside(inv: &Inventory<'_>, rel: &str) -> Option<PathBuf> {
    let abs = inv.vehicle.root.join(rel);
    if crate::media::hidden_path(abs.to_str()?) { return None; }
    let real = crate::media::resolve_inside(abs.to_str()?, std::slice::from_ref(&inv.vehicle.root))?;
    (real.is_file() && !crate::media::hidden_path(real.to_str()?)).then_some(real)
}

fn original_front(inv: &Inventory<'_>, rel: &str) -> bool {
    inv.state.file_list.get(rel).is_some_and(|f| f.camera.as_deref() == Some("front"))
        && inv.state.codecs.get(rel).flatten() == Some("h264")
}

struct Source { path: PathBuf, duration_ms: i64, last_frame_ms: i64 }

fn source(inv: &Inventory<'_>, rel: &str) -> Option<Source> {
    if !original_front(inv, rel) { return None; }
    let path = inside(inv, rel)?;
    // Headers only. The catalog may predate a replacement, and a minute name
    // is not proof of a full minute: use the actual duration, with an open end.
    let info = crate::mp4::clip_info(&path).ok()?;
    if !matches!(info.entry.as_str(), "avc1" | "avc3") || !info.duration.is_finite() || info.duration <= 0.0 || info.timescale == 0 { return None; }
    let duration_ms = (info.duration * 1000.0).floor() as i64;
    let frame_ms = (info.samples.last()?.duration as f64 * 1000.0 / info.timescale as f64).ceil() as i64;
    Some(Source { path, duration_ms, last_frame_ms: (duration_ms - frame_ms.max(1)).max(0) })
}

fn visible(source: &Source, center_ms: i64, decode: &Decode<'_>) -> bool {
    if center_ms < 0 || center_ms >= source.duration_ms { return false; }
    let at = [-1000, 0, 1000].map(|d| (center_ms + d).clamp(0, source.last_frame_ms));
    let Some(luma) = decode(&source.path, at) else { return false };
    luma.iter().all(|v| v.is_finite() && (0.0..=255.0).contains(v)) && luma.iter().sum::<f64>() / 3.0 >= 16.0
}

struct Event<'a> { rec: &'a Recording, id: &'a str, when: String, at: i64, kind: &'static str }

fn event_clip(inv: &Inventory<'_>, event: &Event<'_>, zone: &str, decode: &Decode<'_>) -> Option<PreviewClip> {
    let mut clips: Vec<_> = event.rec.clip_rels().filter(|rel| original_front(inv, rel))
        .filter_map(|rel| Some((rel, local_ms(clip_time(rel)?, zone))))
        .filter(|(_, start)| *start <= event.at).collect();
    clips.sort_by_key(|(_, start)| std::cmp::Reverse(*start));
    for (rel, start) in clips {
        let Some(src) = source(inv, rel) else { continue };
        let center_ms = event.at - start;
        if visible(&src, center_ms, decode) {
            return Some(PreviewClip { source: src.path, center_ms, kind: event.kind, event_id: event.id.into(), when: event.when.clone() });
        }
    }
    None
}

fn pick_clips_with(inv: &Inventory<'_>, vehicle_tz: &str, exclude: &[String], want: usize, decode: &Decode<'_>) -> Vec<PreviewClip> {
    let zone = if vehicle_tz.is_empty() { "UTC" } else { vehicle_tz };
    if want == 0 || !tz::valid(zone) || !inv.state.scanned || inv.state.root != inv.vehicle.source_key() { return Vec::new(); }
    let recordings: Vec<_> = inv.state.recordings.iter().filter(|r| r.vehicle_id == inv.vehicle.id).collect();
    let mut events: Vec<_> = recordings.iter().filter_map(|&rec| {
        let kind = match rec.typ { "SavedClips" => "saved", "SentryClips" => "sentry", _ => return None };
        let id = rec.event_id.as_deref()?;
        if exclude.iter().any(|x| x == id) { return None; }
        inside(inv, rec.event_json()?)?;
        let data = crate::api::event_info(inv.vehicle, rec);
        let when = data.get("timestamp")?.as_str()?.to_string();
        Some(Event { rec, id, at: event_ms(&when, zone)?, when, kind })
    }).collect();
    events.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.rec.id.cmp(&b.rec.id)));
    let mut saved = events.iter().filter(|e| e.kind == "saved");
    let mut sentry = events.iter().filter(|e| e.kind == "sentry");
    let mut picks: Vec<PreviewClip> = Vec::new();
    loop {
        let before = picks.len();
        for events in [&mut saved as &mut dyn Iterator<Item = &Event<'_>>, &mut sentry] {
            if picks.len() == want { return picks; }
            for event in events {
                if picks.iter().any(|p| p.event_id == event.id) { continue; }
                if let Some(clip) = event_clip(inv, event, zone, decode) { picks.push(clip); break; }
            }
        }
        if picks.len() == before { break; }
    }
    if !picks.is_empty() { return picks; }

    // day() reads only existing entries, checking size and mtime against the
    // current scan. Never kick the index or read telemetry to fill a gap.
    let Some(index) = inv.speed_index else { return picks };
    let mut recent: Vec<_> = recordings.iter().filter(|r| r.typ == "RecentClips" && !exclude.contains(&r.id))
        .flat_map(|r| r.clip_rels().filter(|rel| original_front(inv, rel)).filter_map(|rel| Some((*r, rel, clip_time(rel)?))))
        .collect();
    recent.sort_by_key(|(_, _, time)| std::cmp::Reverse(local_ms(*time, zone)));
    let mut days: HashMap<String, HashMap<String, Value>> = HashMap::new();
    for (rec, rel, time) in recent {
        let day = &inv.state.file_list.get(rel).unwrap().day;
        let speeds = days.entry(day.clone()).or_insert_with(|| index.day(&inv.vehicle.id, day).into_iter().collect());
        let Some(speeds) = speeds.get(rel).and_then(Value::as_array) else { continue };
        // The speed index's values are metres/second, not km/h.
        let Some(second) = speeds.iter().position(|s| s.as_f64().is_some_and(|s| s.is_finite() && s > 10.0 / 3.6)) else { continue };
        let Some(src) = source(inv, rel) else { continue };
        let center_ms = second as i64 * 1000;
        if visible(&src, center_ms, decode) {
            picks.push(PreviewClip { source: src.path, center_ms, kind: "recent", event_id: rec.id.clone(),
                when: (time + chrono::Duration::seconds(second as i64)).format("%Y-%m-%dT%H:%M:%S").to_string() });
            break;
        }
    }
    picks
}

fn frame_lumas(ffmpeg: &str, path: &Path, at: [i64; 3]) -> Option<[f64; 3]> {
    let runner = BoundedRunner { timeout_ms: 10_000, max_output_bytes: 16 * 1024, grace_ms: 200 };
    let mut means = [0.0; 3];
    for (mean, ms) in means.iter_mut().zip(at) {
        // Expand limited-range video to 0..255 before measuring: nominal black
        // at Y=16 must be rejected. Only text statistics leave the tiny filter.
        let seek = format!("{:.3}", ms as f64 / 1000.0);
        let args = ["-nostdin", "-v", "error", "-ss", &seek, "-i", path.to_str()?, "-map", "0:v:0", "-an", "-sn", "-dn",
            "-vf", "scale=64:-2:out_range=full,format=yuv444p,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=-",
            "-frames:v", "1", "-f", "null", "-"].map(String::from);
        let r = runner.run(ffmpeg, &args, &RunOptions::default()).ok()?;
        if r.status != Some(0) || r.error.is_some() || r.timed_out || r.aborted || r.output_limit_exceeded { return None; }
        *mean = r.stdout.lines().find_map(|l| l.strip_prefix("lavfi.signalstats.YAVG="))?.trim().parse().ok()?;
    }
    Some(means)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::footage::{inventory::Codecs, vehicles::folder_vehicle};
    use crate::viewer::{pace::Pace, telemetry_api::Limiter, testkit::{self, Car}};
    use serde_json::{json, Value};
    use std::{fs, path::PathBuf, sync::Arc};

    struct Fixture(Car);
    impl Fixture {
        fn new(name: &str) -> Self { Self(Car::new(name)) }
        fn clip(&self, folder: &str, start: &str, camera: &str, seconds: usize) -> String {
            let rel = format!("{folder}/{start}-{camera}.mp4");
            let path = self.0.root.join(&rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            testkit::clip(&path, 1, &vec![None; seconds], 1);
            rel
        }
        fn event(&self, kind: &str, day: &str, timestamp: Option<&str>) -> String {
            let id = format!("{day}_21-26-00");
            let folder = format!("{kind}/{id}");
            self.clip(&folder, &format!("{day}_21-25-00"), "front", 60);
            if let Some(t) = timestamp {
                fs::write(self.0.root.join(&folder).join("event.json"), json!({"timestamp": t, "reason": "synthetic"}).to_string()).unwrap();
            }
            id
        }
        fn snapshot(&self) -> (Vehicle, VehicleState) {
            self.0.scan();
            let list = self.0.ctx.files.lock().unwrap()["v1"].clone();
            let codecs = Codecs::new(list.clone(), list.iter().filter(|f| f.kind == crate::footage::Kind::Clip)
                .map(|f| (f.rel.clone(), crate::mp4::video_codec(&self.0.root.join(&f.rel)).unwrap())));
            let v = folder_vehicle("v1", "Synthetic car", "America/New_York", self.0.root.clone());
            let state = VehicleState { recordings: self.0.ctx.recs.lock().unwrap()["v1"].clone(), codecs: Arc::new(codecs),
                file_list: list, scanned: true, root: v.source_key(), ..Default::default() };
            (v, state)
        }
        fn index(&self, entries: &[(&str, Value, bool)]) -> Arc<SpeedIndex> {
            let idx = SpeedIndex::new(self.0.data.join("speeds"), self.0.ctx.clone(), Arc::new(Pace::fixed(|| false)), 0, Limiter::new(|| 1));
            let list = self.0.ctx.files.lock().unwrap()["v1"].clone();
            let mut days = std::collections::BTreeMap::<String, serde_json::Map<String, Value>>::new();
            for (rel, speeds, stale) in entries {
                let f = list.get(rel).unwrap();
                days.entry(f.day.clone()).or_default().insert(rel.to_string(),
                    json!([f.size + u64::from(*stale), crate::viewer::js::js_round(f.mtime_ms), speeds, null]));
            }
            for (day, data) in days {
                let path = idx.file_of("v1", &day);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, serde_json::to_vec(&data).unwrap()).unwrap();
            }
            idx
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(self.0.root.parent().unwrap()); }
    }
    fn bright(_: &Path, _: [i64; 3]) -> Option<[f64; 3]> { Some([60.0; 3]) }
    fn select(v: &Vehicle, state: &VehicleState, speed_index: Option<&SpeedIndex>, exclude: &[String], want: usize) -> Vec<PreviewClip> {
        pick_clips_with(&Inventory { vehicle: v, state, speed_index, ffmpeg: "ffmpeg" }, &v.timezone, exclude, want, &bright)
    }
    fn ids(picks: &[PreviewClip]) -> Vec<&str> { picks.iter().map(|p| p.event_id.as_str()).collect() }

    #[test]
    fn picks_one_saved_one_sentry() {
        let f = Fixture::new("preview-kinds");
        f.event("SavedClips", "2026-06-01", Some("2026-06-01T21:25:33"));
        let saved = f.event("SavedClips", "2026-06-02", Some("2026-06-02T21:25:03.250"));
        let sentry = f.event("SentryClips", "2026-06-03", Some("2026-06-03T21:25:47"));
        let (v, st) = f.snapshot();
        let picks = select(&v, &st, None, &[], 2);
        assert_eq!(ids(&picks), [saved, sentry]);
        assert_eq!((picks[0].kind, picks[1].kind), ("saved", "sentry"));
        assert_eq!((picks[0].center_ms, picks[1].center_ms), (3250, 47000));
        assert_eq!(picks[0].when, "2026-06-02T21:25:03.250");
        assert!(picks.iter().all(|p| p.source.to_str().unwrap().ends_with("-front.mp4")));
    }

    #[test]
    fn skips_missing_timestamp() {
        let f = Fixture::new("preview-timestamp");
        f.event("SavedClips", "2026-06-05", None);
        f.event("SavedClips", "2026-06-04", Some("not a timestamp"));
        f.event("SavedClips", "2026-06-03", Some("2026-02-30T21:25:00"));
        let good = f.event("SavedClips", "2026-06-02", Some("2026-06-02T21:25:10"));
        let (v, st) = f.snapshot();
        assert_eq!(ids(&select(&v, &st, None, &[], 2)), [good]);
    }

    #[test]
    fn skips_h265() {
        let f = Fixture::new("preview-codecs");
        let converted = f.event("SavedClips", "2026-06-03", Some("2026-06-03T21:25:03"));
        let path = f.0.root.join(format!("SavedClips/{converted}/2026-06-03_21-25-00-front.mp4"));
        testkit::clip_hevc(&path, 1, &vec![None; 60], 1, None);
        let good = f.event("SavedClips", "2026-06-02", Some("2026-06-02T21:25:03"));
        let (v, st) = f.snapshot();
        assert_eq!(ids(&select(&v, &st, None, &[], 2)), [good.clone()]);
        // A stale H.264 catalog entry must not admit an already converted source.
        let stale = VehicleState { codecs: Arc::new(Codecs::new(st.file_list.clone(), st.file_list.iter()
            .map(|f| (f.rel.clone(), Some("h264".into()))))), ..st.clone() };
        assert_eq!(ids(&select(&v, &stale, None, &[], 2)), [good]);
        let unknown = VehicleState { codecs: Arc::new(Codecs::default()), ..st };
        assert!(select(&v, &unknown, None, &[], 2).is_empty());
    }

    #[test]
    fn two_sentry_when_no_saved() {
        for kind in ["SentryClips", "SavedClips"] {
            let f = Fixture::new(kind);
            let old = f.event(kind, "2026-06-01", Some("2026-06-01T21:25:03"));
            let new = f.event(kind, "2026-06-02", Some("2026-06-02T21:25:03"));
            f.clip(&format!("{kind}/{new}"), "2026-06-02_21-24-00", "front", 60);
            let (v, st) = f.snapshot();
            assert_eq!(ids(&select(&v, &st, None, &[], 2)), [new, old]);
        }
    }

    #[test]
    fn recent_only_when_moving() {
        let f = Fixture::new("preview-recent");
        let rel = f.clip("RecentClips", "2026-06-02_21-25-00", "front", 60);
        let (v, st) = f.snapshot();
        assert!(select(&v, &st, None, &[], 2).is_empty());
        for speeds in [Value::Null, json!([null, 0, 1, 10.0 / 3.6])] {
            let idx = f.index(&[(&rel, speeds, false)]);
            assert!(select(&v, &st, Some(&idx), &[], 2).is_empty());
        }
        let speeds = json!([null, 0, 10.0 / 3.6, 3.0, 4.0]);
        let stale = f.index(&[(&rel, speeds.clone(), true)]);
        assert!(select(&v, &st, Some(&stale), &[], 2).is_empty());
        let idx = f.index(&[(&rel, speeds, false)]);
        let before = fs::read(idx.file_of("v1", "2026-06-02")).unwrap();
        let picks = select(&v, &st, Some(&idx), &[], 2);
        assert_eq!(picks.len(), 1);
        assert_eq!(picks[0].kind, "recent");
        assert_eq!(picks[0].center_ms, 3000);
        assert_eq!(picks[0].when, "2026-06-02T21:25:03");
        assert_eq!(picks[0].source, f.0.root.join(rel));
        assert!(select(&v, &st, Some(&idx), &[picks[0].event_id.clone()], 2).is_empty());
        assert_eq!(idx.status()["done"], 0);
        assert!(!idx.running());
        assert_eq!(fs::read(idx.file_of("v1", "2026-06-02")).unwrap(), before);
    }

    #[test]
    fn empty_when_nothing_suitable() {
        let f = Fixture::new("preview-empty");
        let (v, st) = f.snapshot();
        assert!(select(&v, &st, None, &[], 2).is_empty());
        let id = f.event("SavedClips", "2026-06-02", Some("2026-06-02T21:25:20"));
        fs::remove_file(f.0.root.join(format!("SavedClips/{id}/2026-06-02_21-25-00-front.mp4"))).unwrap();
        f.clip(&format!("SavedClips/{id}"), "2026-06-02_21-25-00", "back", 60);
        let (v, st) = f.snapshot();
        assert!(select(&v, &st, None, &[], 2).is_empty());
    }

    #[test]
    fn exclude_moves_to_next_event() {
        let f = Fixture::new("preview-exclude");
        let s1 = f.event("SavedClips", "2026-06-04", Some("2026-06-04T21:25:03"));
        let s2 = f.event("SavedClips", "2026-06-02", Some("2026-06-02T21:25:03"));
        let t1 = f.event("SentryClips", "2026-06-03", Some("2026-06-03T21:25:03"));
        let t2 = f.event("SentryClips", "2026-06-01", Some("2026-06-01T21:25:03"));
        let (v, st) = f.snapshot();
        assert_eq!(ids(&select(&v, &st, None, &[s1, t1], 2)), [s2, t2]);
        assert!(select(&v, &st, None, &[], 0).is_empty());
        assert_eq!(select(&v, &st, None, &[], 1).len(), 1);
    }

    #[test]
    fn containing_front_clip_uses_vehicle_timezone_and_real_duration() {
        let f = Fixture::new("preview-containing");
        let id = f.event("SavedClips", "2026-06-02", Some("2026-06-03T01:25:03Z"));
        f.clip(&format!("SavedClips/{id}"), "2026-06-02_21-24-00", "front", 60);
        f.clip(&format!("SavedClips/{id}"), "2026-06-02_21-25-00", "back", 60);
        let (v, st) = f.snapshot();
        let picks = select(&v, &st, None, &[], 2);
        assert_eq!(picks.len(), 1);
        assert_eq!(picks[0].center_ms, 3000);
        assert!(picks[0].source.ends_with("2026-06-02_21-25-00-front.mp4"));
        // End is exclusive; neither a short clip nor a gap contains the event.
        f.clip(&format!("SavedClips/{id}"), "2026-06-02_21-25-00", "front", 3);
        let (v, st) = f.snapshot();
        assert!(select(&v, &st, None, &[], 2).is_empty());
    }

    #[test]
    fn skips_near_black_but_keeps_dim_footage() {
        let f = Fixture::new("preview-luma");
        let dark = f.event("SavedClips", "2026-06-03", Some("2026-06-03T21:25:30"));
        let dim = f.event("SavedClips", "2026-06-02", Some("2026-06-02T21:25:30"));
        let (v, st) = f.snapshot();
        let inv = Inventory { vehicle: &v, state: &st, speed_index: None, ffmpeg: "ffmpeg" };
        let picks = pick_clips_with(&inv, &v.timezone, &[], 2, &|p, at| {
            assert_eq!(at, [29000, 30000, 31000]);
            Some(if p.to_str().unwrap().contains(&dark) { [15.9; 3] } else { [16.0; 3] })
        });
        assert_eq!(ids(&picks), [dim]);
        assert!(pick_clips_with(&inv, &v.timezone, &[], 2, &|_, _| None).is_empty());
    }

    #[test]
    fn real_ffmpeg_rejects_black_and_accepts_testsrc2() {
        let f = Fixture::new("preview-real-luma");
        let ffmpeg = std::env::var("FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".into());
        let mut outputs = Vec::<PathBuf>::new();
        for (name, source) in [("black", "color=c=black:s=160x90:r=10:d=4"), ("detail", "testsrc2=s=160x90:r=10:d=4")] {
            let path = f.0.root.join(format!("{name}.mp4"));
            let result = std::process::Command::new(&ffmpeg).args(["-nostdin", "-v", "error", "-f", "lavfi", "-i", source,
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]).arg(&path).output().unwrap();
            assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
            outputs.push(path);
        }
        let dark = frame_lumas(&ffmpeg, &outputs[0], [1000, 2000, 3000]).unwrap();
        let detail = frame_lumas(&ffmpeg, &outputs[1], [1000, 2000, 3000]).unwrap();
        assert!(dark.iter().all(|v| *v < 16.0), "{dark:?}");
        assert!(detail.iter().all(|v| *v > 16.0), "{detail:?}");
    }
}

// Preview orchestration. The backend keeps inventory, the job service and media
// work replaceable in tests; scheduling and the public answers are shared.
type PreviewResult<T> = Result<T, String>;
type Levels = Vec<(&'static str, Value)>;
type Progress = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Clone)]
enum Blocker { Conversion(String), Benchmark }

trait PreviewBackend: Send + Sync {
    fn pick(&self, vehicle: &str, exclude: &[String], want: usize) -> PreviewResult<Vec<PreviewClip>>;
    fn run(&self, clip: &PreviewClip, levels: &[(&str, Value)], work: &Path, cancel: &AtomicBool,
        cached_only: bool, progress: &dyn Fn(Value)) -> PreviewResult<Option<Vec<LevelResult>>>;
    fn blocker(&self) -> PreviewResult<Option<Blocker>>;
    fn pause(&self, job: &str) -> PreviewResult<bool>;
    fn resume(&self, job: &str) -> PreviewResult<()>;
}

#[derive(Clone)]
pub struct Previews {
    backend: Arc<dyn PreviewBackend>,
    work: PathBuf,
    progress: Progress,
    jobs: Arc<(Mutex<PreviewJobs>, std::sync::Condvar)>,
}

#[derive(Default)]
struct PreviewJobs {
    active: Option<String>,
    shut: bool,
    entries: HashMap<String, PreviewJob>,
}
struct PreviewJob {
    answer: Value,
    cancel: Arc<AtomicBool>,
    pause: Arc<AtomicBool>,
    request: Value,
    assets: HashMap<String, PathBuf>,
    created: Instant,
}
struct Request { vehicle: String, levels: Levels, exclude: Vec<String>, pause: bool }

fn request(p: &Value) -> PreviewResult<Request> {
    let invalid = || "INVALID_REQUEST".to_string();
    let m = p.as_object().ok_or_else(invalid)?;
    if m.keys().any(|k| !["vehicleId", "levels", "exclude", "pauseConversion"].contains(&k.as_str())) { return Err(invalid()); }
    let vehicle = m.get("vehicleId").and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 256).ok_or_else(invalid)?.to_string();
    let names = match m.get("levels") {
        None => vec!["std", "med", "high"],
        Some(v) => v.as_array().filter(|a| !a.is_empty() && a.len() <= 3).ok_or_else(invalid)?.iter()
            .map(|v| v.as_str().ok_or_else(invalid)).collect::<PreviewResult<Vec<_>>>()?,
    };
    let mut levels = vec![];
    for name in names {
        let (level, profile) = match name { "std" => ("std", "balanced"), "med" => ("med", "aggressive"), "high" => ("high", "smallest"), _ => return Err(invalid()) };
        if levels.iter().any(|(l, _)| *l == level) { return Err(invalid()); }
        levels.push((level, json!({"codec":"h265", "profileId":profile, "keepOffTarget":true})));
    }
    let exclude = match m.get("exclude") {
        None => vec![],
        Some(v) => v.as_array().filter(|a| a.len() <= 1000).ok_or_else(invalid)?.iter()
            .map(|v| v.as_str().filter(|s| !s.is_empty() && s.len() <= 256).map(String::from).ok_or_else(invalid)).collect::<PreviewResult<Vec<_>>>()?,
    };
    let pause = match m.get("pauseConversion") { None => false, Some(v) => v.as_bool().ok_or_else(invalid)? };
    Ok(Request { vehicle, levels, exclude, pause })
}

pub(crate) fn validate_start(p: &Value) -> PreviewResult<()> { request(p).map(|_| ()) }
fn preview_id(p: &Value) -> PreviewResult<&str> {
    p.as_object().filter(|m| m.len() == 1).and_then(|m| m.get("id")).and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        .ok_or_else(|| "INVALID_REQUEST".into())
}
fn public_error(e: &str) -> String {
    let code = e.split(':').next().unwrap_or("");
    if !code.is_empty() && code.len() <= 64 && code.bytes().all(|b| b.is_ascii_uppercase() || b == b'_') { code.into() }
    else { "PREVIEW_FAILED".into() }
}

impl Previews {
    fn new(backend: Arc<dyn PreviewBackend>, work: PathBuf, progress: Progress) -> PreviewResult<Self> {
        std::fs::create_dir_all(&work).map_err(|_| "PREVIEW_WORK_UNAVAILABLE")?;
        let work = std::fs::canonicalize(work).map_err(|_| "PREVIEW_WORK_UNAVAILABLE")?;
        crate::converter::preview::cleanup_all(&work)?;
        Ok(Self { backend, work, progress, jobs: Arc::new((Mutex::new(PreviewJobs::default()), std::sync::Condvar::new())) })
    }
    pub fn start(&self, p: &Value) -> PreviewResult<Value> {
        let req = request(p)?;
        let id = crate::core::auth::new_salt();
        let cancel = Arc::new(AtomicBool::new(false));
        let pause = Arc::new(AtomicBool::new(req.pause));
        let identity = json!([req.vehicle, req.levels, req.exclude]);
        {
            let mut jobs = self.jobs.0.lock().unwrap();
            if jobs.shut { return Err("PREVIEW_UNAVAILABLE".into()); }
            if let Some(active) = &jobs.active {
                let job = &jobs.entries[active];
                if req.pause && job.answer["state"] == "waiting" && job.request == identity && !job.cancel.load(Ordering::SeqCst) {
                    job.pause.store(true, Ordering::SeqCst); self.jobs.1.notify_all();
                    return Ok(json!({"id":active}));
                }
                return Err("PREVIEW_ACTIVE".into());
            }
            jobs.entries.retain(|_, j| j.created.elapsed() < Duration::from_secs(86_400));
            if jobs.entries.len() >= 32 {
                if let Some(old) = jobs.entries.iter().min_by_key(|(_, j)| j.created).map(|(id, _)| id.clone()) { jobs.entries.remove(&old); }
            }
            jobs.entries.insert(id.clone(), PreviewJob { answer: json!({"state":"running", "clips":[]}), cancel: cancel.clone(), pause: pause.clone(), request: identity, assets: HashMap::new(), created: Instant::now() });
            jobs.active = Some(id.clone());
        }
        // A cache lookup never falls through to extraction/encoding. Complete a
        // warm request before returning its id, even when the converter is busy.
        let prepared = self.prepare(&id, &req, &cancel);
        match prepared {
            Err(e) => self.finish(&id, Err(e)),
            Ok((clips, exclude)) => {
                for (clip, cached) in &clips { if let Some(results) = cached { self.add_clip(&id, clip, results); } }
                if clips.iter().all(|(_, result)| result.is_some()) { self.finish(&id, Ok(())); return Ok(json!({"id":id})); }
                match self.backend.blocker() {
                    Ok(Some(Blocker::Conversion(_))) => self.state(&id, "waiting", Some("conversion")),
                    Ok(Some(Blocker::Benchmark)) => self.state(&id, "waiting", Some("benchmark")),
                    Ok(None) => {},
                    Err(e) => { self.finish(&id, Err(e)); return Ok(json!({"id":id})); }
                }
                let me = self.clone(); let worker_id = id.clone();
                if std::thread::Builder::new().name("converter-preview".into()).spawn(move || {
                    me.run(&worker_id, req, clips, exclude, &cancel, &pause);
                }).is_err() { self.finish(&id, Err("PREVIEW_UNAVAILABLE".into())); }
            }
        }
        Ok(json!({"id":id}))
    }

    fn prepare(&self, id: &str, req: &Request, cancel: &AtomicBool) -> PreviewResult<(Vec<(PreviewClip, Option<Vec<LevelResult>>)>, Vec<String>)> {
        let mut exclude = req.exclude.clone();
        let picks = self.backend.pick(&req.vehicle, &exclude, 2)?;
        let mut events = picks.iter().filter(|p| p.kind != "recent").count();
        exclude.extend(picks.iter().map(|p| p.event_id.clone()));
        let mut clips = vec![];
        for mut clip in picks {
            loop {
                if cancel.load(Ordering::SeqCst) { return Err("CANCELLED".into()); }
                match self.backend.run(&clip, &req.levels, &self.work, cancel, true, &|e| self.event(id, &clip, e)) {
                    Err(e) if e == "PREVIEW_EVENT_OUTSIDE_WINDOW" => {
                        if clip.kind != "recent" { events -= 1; }
                        let Some(next) = self.backend.pick(&req.vehicle, &exclude, 1)?.pop() else { break };
                        // Excluding the other reserved event can make the picker
                        // offer Recent. It is still a last resort for the pair.
                        if next.kind == "recent" && events > 0 { break; }
                        if next.kind != "recent" { events += 1; }
                        exclude.push(next.event_id.clone()); clip = next;
                    }
                    Err(e) => return Err(e),
                    Ok(result) => { clips.push((clip, result)); break; }
                }
            }
        }
        Ok((clips, exclude))
    }

    fn wait(&self, id: &str, cancel: &AtomicBool, pause: &AtomicBool, paused: &mut Option<String>) -> PreviewResult<()> {
        loop {
            if cancel.load(Ordering::SeqCst) { return Err("CANCELLED".into()); }
            let Some(blocker) = self.backend.blocker()? else { self.state(id, "running", None); return Ok(()) };
            let waiting = match &blocker { Blocker::Conversion(_) => "conversion", Blocker::Benchmark => "benchmark" };
            self.state(id, "waiting", Some(waiting));
            if let Blocker::Conversion(job) = blocker {
                if pause.load(Ordering::SeqCst) && paused.is_none() && self.backend.pause(&job)? { *paused = Some(job); }
            }
            // pause() is a request. Do not begin until all workers have parked.
            let guard = self.jobs.0.lock().unwrap();
            let _ = self.jobs.1.wait_timeout(guard, Duration::from_millis(100)).unwrap();
        }
    }

    fn run(&self, id: &str, req: Request, clips: Vec<(PreviewClip, Option<Vec<LevelResult>>)>, mut exclude: Vec<String>, cancel: &AtomicBool, pause: &AtomicBool) {
        let mut paused = None;
        let mut made = vec![];
        let mut events = clips.iter().filter(|(clip, _)| clip.kind != "recent").count();
        let mut outcome = (|| {
            for (mut clip, cached) in clips {
                if cached.is_some() { continue; }
                loop {
                    self.wait(id, cancel, pause, &mut paused)?;
                    match self.backend.run(&clip, &req.levels, &self.work, cancel, false, &|e| self.event(id, &clip, e)) {
                        Err(e) if e == "PREVIEW_BUSY" => continue, // a job won admission after the idle check
                        Err(e) if e == "PREVIEW_EVENT_OUTSIDE_WINDOW" => {
                            if clip.kind != "recent" { events -= 1; }
                            let Some(next) = self.backend.pick(&req.vehicle, &exclude, 1)?.pop() else { break };
                            if next.kind == "recent" && events > 0 { break; }
                            if next.kind != "recent" { events += 1; }
                            exclude.push(next.event_id.clone()); clip = next;
                        }
                        Err(e) => return Err(e),
                        Ok(Some(results)) => {
                            made.extend(results.iter().filter_map(|r| r.frame.parent().map(Path::to_path_buf)));
                            self.add_clip(id, &clip, &results); break;
                        }
                        Ok(None) => return Err("PREVIEW_FAILED".into()),
                    }
                }
            }
            if cancel.load(Ordering::SeqCst) { Err("CANCELLED".into()) } else { Ok(()) }
        })();
        // The backend resumes only a pause it acquired, never a pre-paused job.
        if let Some(job) = paused {
            if self.backend.resume(&job).is_err() && outcome.is_ok() { outcome = Err("PREVIEW_RESUME_FAILED".into()); }
        }
        if outcome.is_err() {
            made.sort(); made.dedup();
            for path in made { if path.starts_with(&self.work) && path != self.work { let _ = std::fs::remove_dir_all(path); } }
        }
        self.finish(id, outcome);
    }

    fn state(&self, id: &str, state: &str, waiting: Option<&str>) {
        let changed = {
            let mut jobs = self.jobs.0.lock().unwrap(); let j = jobs.entries.get_mut(id).unwrap();
            if j.cancel.load(Ordering::SeqCst) { return; }
            let next = waiting.map(|v| json!(v)).unwrap_or(Value::Null);
            let changed = j.answer["state"] != state || j.answer["waitingFor"] != next;
            j.answer["state"] = json!(state);
            j.answer.as_object_mut().unwrap().remove("waitingFor");
            if let Some(w) = waiting { j.answer["waitingFor"] = json!(w); }
            changed
        };
        if changed {
            let mut e = json!({"type":"preview", "id":id, "state":state});
            if let Some(w) = waiting { e["waitingFor"] = json!(w); }
            (self.progress)(e);
        }
    }

    fn level(&self, id: &str, event: &str, result: &LevelResult) -> Value {
        let mut value = serde_json::to_value(result).unwrap();
        let mut jobs = self.jobs.0.lock().unwrap(); let job = jobs.entries.get_mut(id).unwrap();
        for (key, path) in [("frame", &result.frame), ("zoom", &result.zoom)] {
            // Public names are generated here; source and cache names never form URLs.
            let stem = crate::converter::tesla_sei::sha256_hex(format!("{event}:{}:{key}", result.level).as_bytes());
            let asset = format!("{}.jpg", &stem[..32]);
            if !job.cancel.load(Ordering::SeqCst) { job.assets.insert(asset.clone(), path.clone()); }
            value[key] = json!(format!("/api/converter/previews/{id}/images/{asset}"));
        }
        value
    }

    fn add_clip(&self, id: &str, clip: &PreviewClip, results: &[LevelResult]) {
        let results: Vec<_> = results.iter().map(|r| self.level(id, &clip.event_id, r)).collect();
        let mut jobs = self.jobs.0.lock().unwrap(); let job = jobs.entries.get_mut(id).unwrap();
        if !job.cancel.load(Ordering::SeqCst) {
            // moment is the event offset within the source clip, in milliseconds.
            job.answer["clips"].as_array_mut().unwrap().push(json!({"kind":clip.kind, "when":clip.when, "eventId":clip.event_id, "moment":clip.center_ms, "results":results}));
        }
    }

    fn event(&self, id: &str, clip: &PreviewClip, e: Value) {
        if self.jobs.0.lock().unwrap().entries[id].cancel.load(Ordering::SeqCst) { return; }
        let mut out = json!({"type":"preview", "id":id, "eventId":clip.event_id});
        for k in ["phase", "level", "profile", "encoder", "device", "window", "durationUs", "bitrate", "maxrate", "crop"] {
            if let Some(v) = e.get(k) { out[k] = v.clone(); }
        }
        if let Some(r) = e.get("result").and_then(|r| serde_json::from_value::<LevelResult>(r.clone()).ok()) { out["result"] = self.level(id, &clip.event_id, &r); }
        (self.progress)(out);
    }

    fn finish(&self, id: &str, result: PreviewResult<()>) {
        let answer = {
            let mut jobs = self.jobs.0.lock().unwrap(); let job = jobs.entries.get_mut(id).unwrap();
            let state = if job.cancel.load(Ordering::SeqCst) { "cancelled" } else if result.is_ok() { "done" } else { "failed" };
            job.created = Instant::now(); // terminal result retention starts after the wait/work
            job.answer["state"] = json!(state); job.answer.as_object_mut().unwrap().remove("waitingFor");
            if let Err(e) = result { if state != "cancelled" { job.answer["error"] = json!(public_error(&e)); } }
            if state != "done" { job.assets.clear(); job.answer["clips"] = json!([]); }
            let answer = job.answer.clone(); jobs.active = None; self.jobs.1.notify_all(); answer
        };
        let mut event = answer; event["type"] = json!("preview"); event["id"] = json!(id); (self.progress)(event);
    }

    pub fn get(&self, p: &Value) -> PreviewResult<Value> {
        let jobs = self.jobs.0.lock().unwrap();
        jobs.entries.get(preview_id(p)?).filter(|j| matches!(j.answer["state"].as_str(), Some("waiting" | "running")) || j.created.elapsed() < Duration::from_secs(86_400))
            .map(|j| j.answer.clone()).ok_or_else(|| "PREVIEW_NOT_FOUND".into())
    }

    pub fn cancel(&self, p: &Value) -> PreviewResult<Value> {
        let id = preview_id(p)?;
        let changed = {
            let mut jobs = self.jobs.0.lock().unwrap();
            let job = jobs.entries.get_mut(id).ok_or("PREVIEW_NOT_FOUND")?;
            if ["running", "waiting"].contains(&job.answer["state"].as_str().unwrap_or("")) {
                job.cancel.store(true, Ordering::SeqCst); job.answer["state"] = json!("cancelled");
                job.created = Instant::now();
                job.answer.as_object_mut().unwrap().remove("waitingFor"); job.answer["clips"] = json!([]); job.assets.clear(); true
            } else { false }
        };
        self.jobs.1.notify_all();
        if changed { (self.progress)(json!({"type":"preview", "id":id, "state":"cancelled"})); }
        Ok(Value::Null)
    }

    pub fn shutdown(&self) {
        let mut jobs = self.jobs.0.lock().unwrap(); jobs.shut = true;
        for job in jobs.entries.values() { job.cancel.store(true, Ordering::SeqCst); }
        self.jobs.1.notify_all();
        while jobs.active.is_some() { jobs = self.jobs.1.wait(jobs).unwrap(); }
    }

    fn image(&self, id: &str, asset: &str) -> PreviewResult<Vec<u8>> {
        let missing = || "PREVIEW_NOT_FOUND".to_string();
        let stem = asset.strip_suffix(".jpg").filter(|s| (1..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')).ok_or_else(missing)?;
        let _ = stem;
        let path = self.jobs.0.lock().unwrap().entries.get(id).filter(|j| !j.cancel.load(Ordering::SeqCst)
            && (matches!(j.answer["state"].as_str(), Some("waiting" | "running")) || j.created.elapsed() < Duration::from_secs(86_400)))
            .and_then(|j| j.assets.get(asset)).cloned().ok_or_else(missing)?;
        let real = std::fs::canonicalize(&path).map_err(|_| missing())?;
        if real != path || !real.starts_with(&self.work) { return Err(missing()); }
        use std::io::Read;
        use std::os::unix::fs::OpenOptionsExt;
        let file = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path).map_err(|_| missing())?;
        let mut bytes = vec![]; file.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| missing())?;
        if bytes.len() > 16 * 1024 * 1024 { return Err(missing()); }
        Ok(bytes)
    }
}

struct HostPreview {
    srv: std::sync::Weak<super::Server>,
    runtime: Arc<crate::converter::runtime::Converter>,
    ctx: Arc<dyn crate::converter::ctx::ConverterCtx>,
    pauses: Mutex<HashMap<String, u64>>,
}

impl PreviewBackend for HostPreview {
    fn pick(&self, vehicle: &str, exclude: &[String], want: usize) -> PreviewResult<Vec<PreviewClip>> {
        let srv = self.srv.upgrade().ok_or("PREVIEW_UNAVAILABLE")?;
        let vehicle = srv.app().vehicle(vehicle).ok_or("VEHICLE_NOT_FOUND")?;
        self.ctx.resolve_path(&vehicle.root.to_string_lossy(), true).ok_or("PATH_NOT_ALLOWED")?;
        let Some(state) = srv.app().state_of(&vehicle.id) else { return Ok(vec![]) };
        let speed_index = srv.viewer().map(|v| v.speed_index.as_ref());
        let inv = Inventory { vehicle: &vehicle, state: &state, speed_index, ffmpeg: &srv.state.config.ffmpeg };
        Ok(pick_clips(&inv, &vehicle.timezone, exclude, want))
    }
    fn run(&self, clip: &PreviewClip, levels: &[(&str, Value)], work: &Path, cancel: &AtomicBool,
        cached_only: bool, progress: &dyn Fn(Value)) -> PreviewResult<Option<Vec<LevelResult>>> {
        // Recheck the footage guard after a wait: a vehicle may have been removed
        // or the source's link changed since the inventory was selected.
        let source = clip.source.to_str().ok_or("PATH_NOT_ALLOWED")?;
        if self.ctx.resolve_path(source, true).as_deref() != Some(source) { return Err("PATH_NOT_ALLOWED".into()); }
        if cached_only { crate::converter::preview::cached_preview(clip, levels, work, cancel, progress) }
        else {
            let _lease = self.runtime.try_preview()?.ok_or("PREVIEW_BUSY")?;
            crate::converter::preview::run_preview(clip, levels, work, cancel, progress).map(Some)
        }
    }
    fn blocker(&self) -> PreviewResult<Option<Blocker>> {
        if self.runtime.benchmark_active() { return Ok(Some(Blocker::Benchmark)); }
        crate::converter::runtime::preview_conversion(&self.runtime.service).map(|id| id.map(Blocker::Conversion))
            .map_err(|_| "PREVIEW_JOB_CHECK_FAILED".into())
    }
    fn pause(&self, job: &str) -> PreviewResult<bool> {
        let token = self.runtime.service.pause_for_preview(job).map_err(|_| "PREVIEW_PAUSE_FAILED")?;
        if let Some(t) = token { self.pauses.lock().unwrap().insert(job.into(), t); }
        Ok(token.is_some())
    }
    fn resume(&self, job: &str) -> PreviewResult<()> {
        if let Some(token) = self.pauses.lock().unwrap().remove(job) {
            self.runtime.service.resume_after_preview(job, token).map_err(|_| "PREVIEW_RESUME_FAILED")?;
        }
        Ok(())
    }
}

pub fn mount(srv: &Arc<super::Server>, runtime: &Arc<crate::converter::runtime::Converter>, ctx: Arc<dyn crate::converter::ctx::ConverterCtx>, bridge: &Arc<crate::converter::ipc::Bridge>) -> PreviewResult<Arc<Previews>> {
    let backend = Arc::new(HostPreview { srv: Arc::downgrade(srv), runtime: runtime.clone(), ctx, pauses: Mutex::new(HashMap::new()) });
    let weak = Arc::downgrade(bridge);
    Previews::new(backend, runtime.temp_path.join("previews"), Arc::new(move |e| {
        if let Some(b) = weak.upgrade() { b.preview_progress(e); }
    })).map(Arc::new)
}

/// The router has already applied sign-in and viewer checks, including HEAD.
pub fn image(srv: &Arc<super::Server>, c: &mut crate::core::Ctx) -> Result<crate::core::Reply, crate::core::HttpError> {
    let missing = || crate::core::HttpError::new(404, "Not found");
    let previews = srv.converter().and_then(|c| c.bridge.previews()).ok_or_else(missing)?;
    let bytes = previews.image(c.params.get("id").ok_or_else(missing)?, c.params.get("asset").ok_or_else(missing)?).map_err(|_| missing())?;
    Ok(crate::core::Reply::Raw(axum::http::Response::builder().status(200)
        .header("Content-Type", "image/jpeg").header("Cache-Control", "private, no-store").header("X-Content-Type-Options", "nosniff")
        .body(axum::body::Body::from(bytes)).unwrap()))
}

#[cfg(test)]
mod channel_tests {
    use super::*;
    use crate::converter::testutil::{tempdir, TempDir};
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn preview_lease_serializes_conversion_and_benchmark_admission() {
        use crate::converter::runtime::{BenchRequest, Converter, RuntimeOptions};
        let dir = tempdir().unwrap();
        let mut o = RuntimeOptions::new(dir.path().into(), dir.path().into(), "ffmpeg", "ffprobe"); o.auto_timer = false;
        let c = Converter::open(o).unwrap();
        let lease = c.try_preview().unwrap().expect("idle converter grants a preview");
        assert!(c.try_preview().unwrap().is_none());
        assert_eq!(c.service.start(&json!({})).unwrap_err().code.as_deref(), Some("JOB_ACTIVE"));
        let req = BenchRequest { codecs: vec!["h265".into()], profile_id: "balanced".into(), bitrate_kbps: None, quality_level: None, verify_mode: "quick".into(), source_root: None };
        assert_eq!(c.run_benchmark(&req, &|_| {}).unwrap_err(), "JOB_ACTIVE");
        drop(lease);
        assert!(c.try_preview().unwrap().is_some());
    }

    #[test]
    fn preview_pause_ownership_survives_only_without_owner_intervention() {
        use crate::converter::runtime::{Converter, RuntimeOptions};
        let dir = tempdir().unwrap();
        let mut o = RuntimeOptions::new(dir.path().into(), dir.path().into(), "ffmpeg", "ffprobe"); o.auto_timer = false;
        let c = Converter::open(o).unwrap();
        let m = c.store.create(json!({"state":"waiting", "items":[], "config": {"sourceRoot":dir.path(), "destinationRoot":null, "codec":"h265", "profileId":"balanced", "networkMode":"direct", "outputMode":"replace", "includedGroups":["SavedClips"], "concurrency":1, "replacementConfirmed":true}}).as_object().unwrap()).unwrap();
        let id = m.id();
        let rt = c.service.ensure_runtime(id).unwrap(); rt.lock().running = true;
        let token = c.service.pause_for_preview(id).unwrap().expect("this preview requested the pause");
        assert!(rt.lock().pause_requested);
        assert!(c.service.pause_for_preview(id).unwrap().is_none());
        c.service.resume_after_preview(id, token).unwrap();
        assert!(!rt.lock().pause_requested);
        let token = c.service.pause_for_preview(id).unwrap().unwrap();
        c.service.pause(id).unwrap(); // owner explicitly wants it to stay paused
        c.service.resume_after_preview(id, token).unwrap();
        assert!(rt.lock().pause_requested);
        assert!(c.service.pause_for_preview(id).unwrap().is_none());
        rt.lock().running = false;
    }

    #[derive(Default)]
    struct FakeBackend {
        busy: Mutex<Option<Blocker>>,
        calls: Mutex<Vec<String>>,
        release: AtomicBool,
        entered: AtomicUsize,
        cached: AtomicBool,
        cached_sentry: AtomicBool,
        outside: AtomicBool,
        outside_only_running: AtomicBool,
        outside_sentry: AtomicBool,
        recent_fallback: AtomicBool,
        fail: AtomicBool,
    }
    impl PreviewBackend for FakeBackend {
        fn pick(&self, vehicle: &str, exclude: &[String], want: usize) -> PreviewResult<Vec<PreviewClip>> {
            if vehicle != "car" { return Err("VEHICLE_NOT_FOUND".into()); }
            let mut ids = ["saved", "sentry", "next"].into_iter()
                .filter(|id| !exclude.iter().any(|e| e == id) && (*id != "next" || !self.recent_fallback.load(Ordering::SeqCst)))
                .take(want).collect::<Vec<_>>();
            if ids.is_empty() && self.recent_fallback.load(Ordering::SeqCst) && !exclude.iter().any(|e| e == "recent") { ids.push("recent"); }
            Ok(ids.into_iter()
                .map(|id| PreviewClip { source: PathBuf::from(format!("/synthetic/{id}.mp4")), center_ms: 3500,
                    kind: match id { "sentry" => "sentry", "recent" => "recent", _ => "saved" }, event_id: id.into(), when: "2026-06-01T00:00:03.500Z".into() }).collect())
        }
        fn run(&self, clip: &PreviewClip, levels: &[(&str, Value)], work: &Path, cancel: &AtomicBool,
            cached_only: bool, progress: &dyn Fn(Value)) -> PreviewResult<Option<Vec<LevelResult>>> {
            if (clip.event_id == "saved" && self.outside.load(Ordering::SeqCst) || clip.event_id == "sentry" && self.outside_sentry.load(Ordering::SeqCst))
                && (!cached_only || !self.outside_only_running.load(Ordering::SeqCst)) { return Err("PREVIEW_EVENT_OUTSIDE_WINDOW".into()); }
            if cached_only && !(self.cached.load(Ordering::SeqCst) || (clip.kind == "sentry" && self.cached_sentry.load(Ordering::SeqCst))) { return Ok(None); }
            if !cached_only {
                self.entered.fetch_add(1, Ordering::SeqCst);
                while !self.release.load(Ordering::SeqCst) {
                    if cancel.load(Ordering::SeqCst) { return Err("CANCELLED".into()); }
                    std::thread::sleep(Duration::from_millis(2));
                }
                if self.fail.load(Ordering::SeqCst) { return Err("PREVIEW_PROCESS_FAILED: private/path".into()); }
            }
            let dir = work.join(&clip.event_id);
            std::fs::create_dir_all(&dir).unwrap();
            let results = std::iter::once(("orig", "".to_string())).chain(levels.iter().map(|(l, c)| (*l, c["profileId"].as_str().unwrap().into())))
                .map(|(level, profile)| {
                    let frame = dir.join(format!("{level}.jpg"));
                    let zoom = dir.join(format!("{level}-zoom.jpg"));
                    std::fs::write(&frame, b"frame").unwrap(); std::fs::write(&zoom, b"zoom").unwrap();
                    LevelResult { level: level.into(), profile, before_bytes: 100, after_bytes: 60, saved_percent: 40.0,
                        device: "CPU".into(), frame, zoom, crop: serde_json::from_value(json!({"x":12,"y":16,"width":72,"height":54})).ok(), window_start_us: 0, window_end_us: 6_000_000, duration_us: 6_000_000 }
                }).collect::<Vec<_>>();
            progress(json!({"phase": if cached_only { "cached" } else { "level" }, "result": results[0]}));
            Ok(Some(results))
        }
        fn blocker(&self) -> PreviewResult<Option<Blocker>> { Ok(self.busy.lock().unwrap().clone()) }
        fn pause(&self, job: &str) -> PreviewResult<bool> {
            self.calls.lock().unwrap().push(format!("pause({job})"));
            *self.busy.lock().unwrap() = None;
            Ok(true)
        }
        fn resume(&self, job: &str) -> PreviewResult<()> {
            self.calls.lock().unwrap().push(format!("resume({job})")); Ok(())
        }
    }
    struct Harness { previews: Previews, backend: Arc<FakeBackend>, events: Arc<Mutex<Vec<Value>>>, _dir: TempDir }
    impl Drop for Harness { fn drop(&mut self) { self.previews.shutdown(); } }
    impl Harness {
        fn new() -> Self {
            let dir = tempdir().unwrap();
            let backend = Arc::new(FakeBackend::default());
            let events = Arc::new(Mutex::new(vec![])); let e = events.clone();
            let previews = Previews::new(backend.clone(), dir.path().join("previews"), Arc::new(move |v| e.lock().unwrap().push(v))).unwrap();
            Self { previews, backend, events, _dir: dir }
        }
        fn start(&self, pause: bool) -> Value { self.previews.start(&json!({"vehicleId":"car", "pauseConversion":pause})).unwrap() }
        fn until(&self, id: &Value, state: &str) -> Value {
            let start = Instant::now();
            loop {
                let v = self.previews.get(id).unwrap();
                if v["state"] == state { return v; }
                assert!(start.elapsed() < Duration::from_secs(5), "expected {state}: {v}");
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
    #[test]
    fn start_get_cancel_flow() {
        let h = Harness::new(); let id = h.start(false);
        assert!(id["id"].as_str().is_some_and(|s| !s.is_empty()));
        h.until(&id, "running");
        h.backend.release.store(true, Ordering::SeqCst);
        let result = h.until(&id, "done");
        assert_eq!(result["clips"].as_array().unwrap().len(), 2);
        for clip in result["clips"].as_array().unwrap() {
            assert_eq!(clip["moment"], 3500);
            let results = clip["results"].as_array().unwrap();
            assert_eq!(results.iter().map(|r| r["level"].as_str().unwrap()).collect::<Vec<_>>(), ["orig", "std", "med", "high"]);
            assert_eq!(results[1]["profile"], "balanced"); assert_eq!(results[2]["profile"], "aggressive"); assert_eq!(results[3]["profile"], "smallest");
            assert!(results[0]["frame"].as_str().unwrap().starts_with(&format!("/api/converter/previews/{}/images/", id["id"].as_str().unwrap())));
        }
        assert!(!result.to_string().contains("/synthetic"));
        assert!(h.events.lock().unwrap().iter().any(|e| e["type"] == "preview" && e["id"] == id["id"]));
        assert!(!h.events.lock().unwrap().iter().any(|e| e.to_string().contains(h._dir.path().to_str().unwrap())));
        h.backend.release.store(false, Ordering::SeqCst);
        let cancel = h.start(false); h.until(&cancel, "running");
        h.previews.cancel(&cancel).unwrap(); h.until(&cancel, "cancelled");
    }
    #[test]
    fn preview_invoke_and_progress_use_existing_bridge() {
        use crate::converter::{ctx::ConverterCtx, ipc::Bridge, runtime::{Converter, RuntimeOptions}};
        struct Ctx(PathBuf);
        impl ConverterCtx for Ctx {
            fn data_path(&self) -> PathBuf { self.0.clone() }
            fn temp_path(&self) -> PathBuf { self.0.clone() }
            fn resolve_path(&self, _: &str, _: bool) -> Option<String> { None }
        }
        let mut h = Harness::new();
        let mut o = RuntimeOptions::new(h._dir.path().into(), h._dir.path().into(), "ffmpeg", "ffprobe"); o.auto_timer = false;
        let runtime = Converter::open(o).unwrap();
        let bridge = Bridge::new(Arc::new(runtime.service.clone()), Arc::new(Ctx(h._dir.path().into())), json!({}));
        let weak = Arc::downgrade(&bridge);
        h.previews.progress = Arc::new(move |e| { if let Some(b) = weak.upgrade() { b.preview_progress(e); } });
        bridge.mount_previews(Arc::new(h.previews.clone()));
        let stream = Arc::new(Mutex::new(String::new())); let sink = stream.clone();
        bridge.attach_events("preview-test", Box::new(move |text| { sink.lock().unwrap().push_str(text); true }));
        assert_eq!(bridge.invoke("subscribeProgress", None, Some("preview-test"))["ok"], true);
        let answer = bridge.invoke("previewStart", Some(json!({"vehicleId":"car", "levels":["med"]})), None);
        assert_eq!(answer["ok"], true); let id = answer["value"].clone();
        h.backend.release.store(true, Ordering::SeqCst); h.until(&id, "done");
        let answer = bridge.invoke("previewGet", Some(id), None);
        assert_eq!(answer["value"]["clips"][0]["results"].as_array().unwrap().len(), 2);
        assert!(stream.lock().unwrap().contains("event: converter:progress\ndata: "));
        assert!(stream.lock().unwrap().contains("\"type\":\"preview\""));
        h.backend.release.store(false, Ordering::SeqCst);
        let id = bridge.invoke("previewStart", Some(json!({"vehicleId":"car"})), None)["value"].clone();
        h.until(&id, "running");
        assert_eq!(bridge.invoke("previewCancel", Some(id.clone()), None)["ok"], true);
        h.until(&id, "cancelled"); bridge.detach("preview-test");
    }
    #[test]
    fn waits_behind_conversion() {
        let h = Harness::new(); *h.backend.busy.lock().unwrap() = Some(Blocker::Conversion("job".into()));
        let id = h.start(false); let status = h.previews.get(&id).unwrap();
        assert_eq!(status["state"], "waiting");
        assert_eq!(status["waitingFor"], "conversion"); assert_eq!(h.backend.entered.load(Ordering::SeqCst), 0);
        *h.backend.busy.lock().unwrap() = None; h.backend.release.store(true, Ordering::SeqCst); h.until(&id, "done");
        assert!(h.backend.calls.lock().unwrap().is_empty());
    }
    #[test]
    fn preview_shows_cached_second_clip_while_first_waits() {
        let h = Harness::new(); *h.backend.busy.lock().unwrap() = Some(Blocker::Conversion("job".into()));
        h.backend.cached_sentry.store(true, Ordering::SeqCst);
        let id = h.start(false); let status = h.previews.get(&id).unwrap();
        assert_eq!(status["state"], "waiting");
        assert_eq!(status["clips"].as_array().unwrap().len(), 1);
        assert_eq!(status["clips"][0]["kind"], "sentry");
        h.previews.cancel(&id).unwrap();
    }
    #[test]
    fn preview_remains_followable_through_a_day_long_conversion() {
        for cancel in [false, true] {
            let h = Harness::new(); *h.backend.busy.lock().unwrap() = Some(Blocker::Conversion("job".into()));
            let id = h.start(false);
            h.previews.jobs.0.lock().unwrap().entries.get_mut(id["id"].as_str().unwrap()).unwrap().created = Instant::now() - Duration::from_secs(86_401);
            assert_eq!(h.previews.get(&id).unwrap()["waitingFor"], "conversion");
            if cancel {
                h.previews.cancel(&id).unwrap(); assert_eq!(h.previews.get(&id).unwrap()["state"], "cancelled");
            } else {
                *h.backend.busy.lock().unwrap() = None; h.backend.release.store(true, Ordering::SeqCst);
                let status = h.until(&id, "done");
                let asset = status["clips"][0]["results"][0]["frame"].as_str().unwrap().rsplit('/').next().unwrap();
                assert_eq!(h.previews.image(id["id"].as_str().unwrap(), asset).unwrap(), b"frame");
            }
        }
    }
    #[test]
    fn pause_then_resume() {
        let h = Harness::new(); *h.backend.busy.lock().unwrap() = Some(Blocker::Conversion("job".into()));
        h.backend.release.store(true, Ordering::SeqCst); let id = h.start(true); h.until(&id, "done");
        assert_eq!(*h.backend.calls.lock().unwrap(), ["pause(job)", "resume(job)"]);
    }
    #[test]
    fn preview_start_again_can_upgrade_our_waiting_request_to_pause() {
        let h = Harness::new(); *h.backend.busy.lock().unwrap() = Some(Blocker::Conversion("job".into()));
        let id = h.start(false); h.until(&id, "waiting");
        let upgraded = h.start(true);
        assert_eq!(upgraded, id, "the waiting request keeps its single preview slot");
        h.backend.release.store(true, Ordering::SeqCst); h.until(&id, "done");
        assert_eq!(*h.backend.calls.lock().unwrap(), ["pause(job)", "resume(job)"]);
    }
    #[test]
    fn rejects_paths() {
        let h = Harness::new();
        for p in [json!({"vehicleId":"car","path":"/tmp/x"}), json!({"vehicleId":"car","levels":["custom"]}),
            json!({"vehicleId":"car","exclude":"saved"}), json!({"vehicleId":"car","pauseConversion":1}), json!({"vehicleId":"car","levels":[]})] {
            assert_eq!(h.previews.start(&p).unwrap_err(), "INVALID_REQUEST");
        }
    }
    #[test]
    fn cache_bypasses_conversion_and_benchmark_without_pausing() {
        for busy in [Blocker::Conversion("job".into()), Blocker::Benchmark] {
            let h = Harness::new(); *h.backend.busy.lock().unwrap() = Some(busy); h.backend.cached.store(true, Ordering::SeqCst);
            let id = h.start(true); h.until(&id, "done");
            assert_eq!(h.backend.entered.load(Ordering::SeqCst), 0); assert!(h.backend.calls.lock().unwrap().is_empty());
            assert!(h.events.lock().unwrap().iter().any(|e| e["phase"] == "cached"));
        }
    }
    #[test]
    fn single_preview_and_waiting_cancel() {
        let h = Harness::new(); *h.backend.busy.lock().unwrap() = Some(Blocker::Benchmark);
        let id = h.start(true); assert_eq!(h.until(&id, "waiting")["waitingFor"], "benchmark");
        assert_eq!(h.previews.start(&json!({"vehicleId":"car"})).unwrap_err(), "PREVIEW_ACTIVE");
        h.previews.cancel(&id).unwrap(); h.until(&id, "cancelled");
        assert_eq!(h.backend.entered.load(Ordering::SeqCst), 0); assert!(h.backend.calls.lock().unwrap().is_empty());
    }
    #[test]
    fn retries_outside_window_for_that_slot() {
        let h = Harness::new(); h.backend.outside.store(true, Ordering::SeqCst); h.backend.release.store(true, Ordering::SeqCst);
        let id = h.start(false); let status = h.until(&id, "done");
        let mut ids = status["clips"].as_array().unwrap().iter().map(|c| c["eventId"].as_str().unwrap()).collect::<Vec<_>>(); ids.sort();
        assert_eq!(ids, ["next", "sentry"]);
    }
    #[test]
    fn preview_retry_preserves_recent_as_last_resort() {
        for (running, bad_sentry) in [(false, false), (true, false), (false, true), (true, true)] {
            let h = Harness::new(); h.backend.outside.store(true, Ordering::SeqCst);
            h.backend.outside_only_running.store(running, Ordering::SeqCst);
            h.backend.outside_sentry.store(bad_sentry, Ordering::SeqCst);
            h.backend.recent_fallback.store(true, Ordering::SeqCst); h.backend.release.store(true, Ordering::SeqCst);
            let id = h.start(false); let status = h.until(&id, "done");
            let clips = status["clips"].as_array().unwrap();
            assert_eq!(clips.len(), 1, "a Recent fallback must not be paired with a usable event");
            assert_eq!(clips[0]["kind"], if bad_sentry { "recent" } else { "sentry" });
        }
    }
    #[test]
    fn failure_and_cancel_resume_only_our_job() {
        for fail in [false, true] {
            let h = Harness::new(); *h.backend.busy.lock().unwrap() = Some(Blocker::Conversion("job".into()));
            let id = h.start(true); h.until(&id, "running");
            if fail { h.backend.fail.store(true, Ordering::SeqCst); h.backend.release.store(true, Ordering::SeqCst); }
            else { h.previews.cancel(&id).unwrap(); }
            let status = h.until(&id, if fail { "failed" } else { "cancelled" });
            let deadline = Instant::now();
            while h.backend.calls.lock().unwrap().len() < 2 { assert!(deadline.elapsed() < Duration::from_secs(5)); std::thread::sleep(Duration::from_millis(5)); }
            assert_eq!(*h.backend.calls.lock().unwrap(), ["pause(job)", "resume(job)"]);
            if fail { assert_eq!(status["error"], "PREVIEW_PROCESS_FAILED"); }
        }
    }
    #[test]
    fn images_are_preview_owned_and_jpegs_only() {
        let h = Harness::new(); h.backend.release.store(true, Ordering::SeqCst);
        let id = h.start(false); let status = h.until(&id, "done"); let name = id["id"].as_str().unwrap();
        let url = status["clips"][0]["results"][0]["frame"].as_str().unwrap(); let asset = url.rsplit('/').next().unwrap();
        assert_eq!(h.previews.image(name, asset).unwrap(), b"frame");
        for bad in ["../orig.jpg", "a/b.jpg", "a.JPG", "a.mp4", ".jpg", "not-produced.jpg"] { assert!(h.previews.image(name, bad).is_err()); }
        assert!(h.previews.image("other", asset).is_err());
        let path = h.previews.work.join("saved/orig.jpg"); std::fs::remove_file(&path).unwrap();
        let secret = h._dir.path().join("secret.jpg"); std::fs::write(&secret, b"secret").unwrap();
        std::os::unix::fs::symlink(&secret, &path).unwrap();
        assert!(h.previews.image(name, asset).is_err());
    }
}
