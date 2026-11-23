//! Read-only choice of event-centred preview clips from one vehicle's inventory.
use crate::app::{Vehicle, VehicleState};
use crate::converter::preview::PreviewClip;
use crate::converter::process::{BoundedRunner, RunOptions, Runner};
use crate::footage::{inventory::Recording, tz};
use crate::viewer::speed_index::SpeedIndex;
use chrono::{Datelike, NaiveDateTime, Timelike};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

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
