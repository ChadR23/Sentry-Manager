//! test/benchmark.test.js (runConverterBenchmark over stand-in level runs)

use super::*;
use crate::converter::testutil::{tempdir, TempDir};
use std::os::unix::fs::MetadataExt;
use std::sync::Mutex;

fn setup(names: &[(&str, &str)]) -> (TempDir, Vec<(PathBuf, String)>) {
    let d = tempdir().unwrap();
    let clips = names
        .iter()
        .map(|(n, body)| {
            let p = d.path().join(n);
            std::fs::write(&p, body).unwrap();
            (p, n.to_string())
        })
        .collect();
    (d, clips)
}

fn one() -> (TempDir, Vec<(PathBuf, String)>) {
    setup(&[("2026-10-20_17-00-00-front.mp4", "clip")])
}

fn names(r: &Path) -> Vec<String> {
    let mut n: Vec<String> = std::fs::read_dir(r.join("RecentClips")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
    n.sort();
    n
}

fn items(r: &Path, f: impl Fn(&str) -> Value) -> Value {
    json!({ "items": names(r).iter().map(|n| f(n)).collect::<Vec<_>>() })
}

fn run(clips: &[(PathBuf, String)], dir: &Path, level: &RunLevel, now: &(dyn Fn() -> f64 + Sync), meter: Option<Arc<dyn PowerMeter>>) -> Result<Value, String> {
    run_converter_benchmark(&BenchOptions {
        clips: clips.to_vec(),
        run_level: level,
        count_frames: &|_p: &Path| 100,
        encoder: Value::Null,
        temp_root: dir.to_path_buf(),
        cancel: Arc::new(AtomicBool::new(false)),
        on_progress: &|_v: Value| {},
        now,
        power_meter: meter,
        compare_verify_modes: vec![],
    })
}

fn real_now() -> f64 {
    super::super::jobstore::now_ms() as f64
}

#[test]
fn speed_test_recommendation_chooses_lightest_within_five_percent() {
    let (d, clips) = one();
    let clock = Mutex::new(0.0);
    let level = |r: &LevelRequest, _: &Arc<AtomicBool>| {
        let rate = match r.level {1 => 8.0, 2 => 9.6, 4 => 10.0, 6 => 9.8, _ => 9.9};
        *clock.lock().unwrap() += (r.level.max(2) as f64) / rate * 60_000.0;
        Ok(items(r.source_root, done))
    };
    let result = run(&clips, d.path(), &level, &|| *clock.lock().unwrap(), None).unwrap();
    assert_eq!(result["best"]["level"], 2);
    assert_eq!(result["best"]["filesPerMinute"], 9.6);
}

fn done(n: &str) -> Value {
    json!({ "state": "completed", "relativePath": format!("RecentClips/{n}") })
}

#[test]
fn every_level_runs_with_a_clip_of_its_own_for_each_slot() {
    let (d, clips) = one();
    let seen = Mutex::new(vec![]);
    let level = |r: &LevelRequest, _c: &Arc<AtomicBool>| {
        let n = names(r.source_root);
        let inodes: std::collections::HashSet<u64> = n.iter().map(|x| std::fs::metadata(r.source_root.join("RecentClips").join(x)).unwrap().ino()).collect();
        seen.lock().unwrap().push((r.level, n.clone(), inodes.len()));
        Ok(items(r.source_root, done))
    };
    let out = run(&clips, d.path(), &level, &real_now, None).unwrap();
    assert_eq!(out["results"].as_array().unwrap().iter().map(|r| r["level"].clone()).collect::<Vec<_>>(), vec![json!(1), json!(2), json!(4), json!(6), json!(8)]);
    let seen = seen.lock().unwrap();
    assert_eq!(seen.iter().map(|s| s.1.len()).collect::<Vec<_>>(), vec![2, 2, 4, 6, 8]);
    for s in seen.iter() {
        assert_eq!(s.2, s.1.len(), "separate files");
        assert!(s.1.iter().all(|n| tesla_stamp(n) && n.ends_with("-front.mp4")));
    }
}

#[test]
fn a_failing_level_ends_the_sweep_and_a_bad_clip_is_left_out() {
    let (d, clips) = one();
    let level = |r: &LevelRequest, _c: &Arc<AtomicBool>| Ok(items(r.source_root, |n| json!({ "state": if r.level >= 6 { "failed" } else { "completed" }, "relativePath": format!("RecentClips/{n}") })));
    let out = run(&clips, d.path(), &level, &real_now, None).unwrap();
    assert_eq!(out["results"].as_array().unwrap().iter().map(|r| json!([r["level"], r["ok"]])).collect::<Vec<_>>(), vec![json!([1, true]), json!([2, true]), json!([4, true]), json!([6, false])]);

    let (d, clips) = setup(&[("2026-10-20_17-00-00-front.mp4", "front"), ("2026-10-20_17-00-00-back.mp4", "back"), ("2026-10-20_17-00-00-left_repeater.mp4", "left_repeater")]);
    let level = |r: &LevelRequest, _c: &Arc<AtomicBool>| {
        Ok(items(r.source_root, |n| {
            if std::fs::read_to_string(r.source_root.join("RecentClips").join(n)).unwrap() == "back" {
                json!({ "state": "failed", "relativePath": format!("RecentClips/{n}"), "failure": { "code": "duration-mismatch" } })
            } else {
                done(n)
            }
        }))
    };
    let out = run(&clips, d.path(), &level, &real_now, None).unwrap();
    assert!(out["results"].as_array().unwrap().iter().all(|r| r["ok"] == true && r.get("failedItems").is_none()));
    assert_eq!(out["results"].as_array().unwrap().len(), 5);
    assert_eq!(out["skipped"], json!([{ "name": "2026-10-20_17-00-00-back.mp4", "code": "duration-mismatch" }]));
    assert_eq!(out["clips"], 2);
    assert!(!out["best"].is_null());

    let (d, clips) = one();
    let level = |r: &LevelRequest, _c: &Arc<AtomicBool>| Ok(items(r.source_root, |n| json!({ "state": "failed", "relativePath": format!("RecentClips/{n}"), "failure": { "code": "duration-mismatch" } })));
    let out = run(&clips, d.path(), &level, &real_now, None).unwrap();
    assert_eq!(out["results"].as_array().unwrap().iter().map(|r| json!([r["level"], r["ok"], r["failures"]])).collect::<Vec<_>>(), vec![json!([1, false, ["duration-mismatch"]])]);
    assert!(out["best"].is_null());

    let (d, clips) = one();
    let level = |r: &LevelRequest, _c: &Arc<AtomicBool>| Ok(items(r.source_root, |n| if r.level >= 6 { json!({ "state": "failed", "relativePath": format!("RecentClips/{n}"), "failure": { "code": "decode-failed" } }) } else { done(n) }));
    let out = run(&clips, d.path(), &level, &real_now, None).unwrap();
    assert_eq!(out["results"].as_array().unwrap().len(), 4);
    assert_eq!(out["skipped"], json!([]));
    assert_eq!(out["clips"], 1);
}

struct Meter {
    readings: Vec<Result<Option<Value>, String>>,
    started: Mutex<usize>,
    stopped: Mutex<Vec<Value>>,
    fail_start: bool,
}
impl PowerMeter for Meter {
    fn start(&self) -> Result<Value, String> {
        if self.fail_start {
            return Err("no RAPL".into());
        }
        let mut s = self.started.lock().unwrap();
        *s += 1;
        Ok(json!(format!("token-{s}")))
    }
    fn stop(&self, t: &Value) -> Result<Option<Value>, String> {
        self.stopped.lock().unwrap().push(t.clone());
        let n: usize = t.as_str().unwrap()[6..].parse().unwrap();
        self.readings.get(n - 1).cloned().unwrap_or(Ok(None))
    }
}

fn meter(readings: Vec<Result<Option<Value>, String>>) -> Arc<Meter> {
    Arc::new(Meter { readings, started: Mutex::new(0), stopped: Mutex::new(vec![]), fail_start: false })
}

fn timed(clips: &[(PathBuf, String)], d: &Path, m: Option<Arc<dyn PowerMeter>>) -> Value {
    let clock = Mutex::new(0.0f64);
    let secs = |l: i64| match l {
        1 => 10.0,
        2 => 5.0,
        4 => 8.0,
        6 => 9.0,
        _ => 10.0,
    };
    let level = |r: &LevelRequest, _c: &Arc<AtomicBool>| {
        *clock.lock().unwrap() += secs(r.level) * 1000.0;
        Ok(items(r.source_root, done))
    };
    let now = || *clock.lock().unwrap();
    run(clips, d, &level, &now, m).unwrap()
}

#[test]
fn energy_per_level_the_most_efficient_beside_the_fastest_and_a_failing_meter_never_fails_it() {
    let (d, clips) = one();
    let r = |wh: f64, w: f64| Ok(Some(json!({ "wh": wh, "avgW": w })));
    let m = meter(vec![r(0.2, 72.0), r(0.1, 72.0), r(0.16, 72.0), r(0.3, 120.0), r(0.5, 180.0)]);
    let out = timed(&clips, d.path(), Some(m.clone()));
    assert_eq!(out["results"].as_array().unwrap().iter().map(|r| json!([r["level"], r["wh"], r["avgW"], r["filesPerWh"]])).collect::<Vec<_>>(), vec![json!([1, 0.2, 72, 10]), json!([2, 0.1, 72, 20]), json!([4, 0.16, 72, 25]), json!([6, 0.3, 120, 20]), json!([8, 0.5, 180, 16])]);
    assert_eq!(out["best"]["level"], 8);
    assert_eq!(out["efficient"]["level"], 4);
    assert_eq!(*m.started.lock().unwrap(), 5);
    assert_eq!(m.stopped.lock().unwrap().len(), 5);

    let m = meter(vec![r(0.2, 72.0), r(0.1, 72.0), r(0.16, 72.0), Ok(None), Err("sensor gone".into())]);
    let out = timed(&clips, d.path(), Some(m));
    assert_eq!(out["results"].as_array().unwrap().iter().map(|r| r["filesPerWh"].clone()).collect::<Vec<_>>(), vec![json!(10), json!(20), json!(25), Value::Null, Value::Null]);
    assert!(out["efficient"].is_null());
    assert_eq!(out["best"]["level"], 8);
    let plain = timed(&clips, d.path(), None);
    assert!(plain["results"].as_array().unwrap().iter().all(|r| r["wh"].is_null() && r["avgW"].is_null() && r["filesPerWh"].is_null()));
    let broken = Arc::new(Meter { readings: vec![], started: Mutex::new(0), stopped: Mutex::new(vec![]), fail_start: true });
    let out = timed(&clips, d.path(), Some(broken));
    assert_eq!(out["results"].as_array().unwrap().len(), 5);
}

#[test]
fn the_meter_is_stopped_when_a_level_is_cancelled() {
    let (d, clips) = one();
    let m = meter(vec![Ok(Some(json!({ "wh": 0.1, "avgW": 50 }))), Ok(Some(json!({ "wh": 0.1, "avgW": 50 })))]);
    let level = |r: &LevelRequest, _c: &Arc<AtomicBool>| if r.level == 2 { Err("CANCELLED".to_string()) } else { Ok(items(r.source_root, done)) };
    assert_eq!(run(&clips, d.path(), &level, &real_now, Some(m.clone())).unwrap_err(), "CANCELLED");
    assert_eq!(*m.stopped.lock().unwrap(), vec![json!("token-1"), json!("token-2")]);
    // and nothing is left in the temp folder
    assert!(std::fs::read_dir(d.path()).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().starts_with("benchmark-")));
}
