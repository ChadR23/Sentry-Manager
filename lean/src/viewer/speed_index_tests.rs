// test/speedIndex.test.js, the parts that hold in Rust

use super::*;
use serde_json::Map;
use crate::footage::Kind;
use crate::scanner::FileEntry;
use crate::viewer::pace::Pace;
use crate::viewer::telemetry_api::Limiter;
use crate::viewer::testkit::{self, Car, Rec};

fn entry(rel: &str, day: &str, size: u64, mtime: f64) -> (String, FileEntry) {
    let cam = if rel.contains("front") { Some("front".to_string()) } else { Some("back".to_string()) };
    (rel.to_string(), FileEntry { rel: rel.into(), size, mtime_ms: mtime, ctime_ms: mtime, birthtime_ms: 0.0, kind: Kind::Clip, typ: "RecentClips", day: day.into(), camera: cam, event_id: None })
}

fn set_files(car: &Car, list: Vec<(String, FileEntry)>) {
    car.ctx.files.lock().unwrap().insert("v1".into(), Arc::new(list.into_iter().collect()));
}

fn index(car: &Car) -> Arc<SpeedIndex> {
    SpeedIndex::new(car.data.join("speeds"), car.ctx.clone(), Arc::new(Pace::fixed(|| false)), 0, Limiter::new(|| 2))
}

fn run(idx: &Arc<SpeedIndex>) {
    idx.kick();
    idx.settled();
}

fn day_file(car: &Car, day: &str) -> Map<String, Value> {
    serde_json::from_str::<Value>(&std::fs::read_to_string(car.data.join("speeds/v1").join(format!("{day}.json"))).unwrap()).unwrap().as_object().unwrap().clone()
}

fn write_day(car: &Car, day: &str, v: Value) {
    std::fs::create_dir_all(car.data.join("speeds/v1")).unwrap();
    std::fs::write(car.data.join("speeds/v1").join(format!("{day}.json")), v.to_string()).unwrap();
}

#[test]
fn indexes_front_clips_once_and_again_when_they_change() {
    let car = Car::new("si-once");
    let clip = car.root.join("RecentClips/2026-10-11_10-00-11-front.mp4");
    let recs: Vec<Option<Rec>> = (0..16).map(|n| Some(Rec { v: 0.3 + n as f32, ..Rec::default() })).collect();
    testkit::clip(&clip, 4, &recs, 4);
    std::fs::write(car.root.join("RecentClips/2026-10-11_10-00-11-back.mp4"), "not read").unwrap();
    car.scan();
    let idx = index(&car);
    assert!(idx.day("v1", "2026-10-11").is_empty());
    assert_eq!(idx.status()["running"], json!(false));
    idx.kick();
    assert_eq!(idx.status()["running"], json!(true), "running as soon as it is started");
    idx.settled();
    let s = idx.status();
    assert_eq!((s["running"].clone(), s["done"].clone(), s["total"].clone(), s["last"].clone()), (json!(false), json!(1), json!(1), json!(1)));
    assert_eq!(idx.day("v1", "2026-10-11"), vec![("RecentClips/2026-10-11_10-00-11-front.mp4".to_string(), json!([0.3, 4.3, 8.3, 12.3]))]);

    // after a restart: read from disk, nothing read again
    let again = index(&car);
    assert_eq!(again.day("v1", "2026-10-11").len(), 1);
    let before = std::fs::metadata(car.data.join("speeds/v1/2026-10-11.json")).unwrap().modified().unwrap();
    run(&again);
    assert_eq!(std::fs::metadata(car.data.join("speeds/v1/2026-10-11.json")).unwrap().modified().unwrap(), before);
    assert_eq!(again.status()["total"], json!(0));

    // the clip changes: left out until read again; one the quick read cannot read goes to the full read
    std::fs::write(&clip, vec![1u8; 200]).unwrap();
    car.scan();
    assert!(again.day("v1", "2026-10-11").is_empty());
    run(&again);
    assert_eq!(again.day("v1", "2026-10-11"), vec![("RecentClips/2026-10-11_10-00-11-front.mp4".to_string(), Value::Null)]);
    assert!(again.day("v1", "nonsense").is_empty());
}

#[test]
fn a_footage_folder_a_level_up_or_down_keeps_what_was_read() {
    let car = Car::new("si-move");
    let day = "2026-10-11";
    let sum = json!({ "b": null, "t": null, "v": [3, 20], "g": [], "k": 2 });
    write_day(&car, day, json!({
        "RecentClips/2026-10-11_10-00-11-front.mp4": [1000, 5000, [1, 2], sum],
        "SavedClips/2026-10-11_10-05-00/2026-10-11_10-00-11-front.mp4": [1000, 5000, [9], sum],
    }));
    set_files(&car, vec![entry("TeslaCam/RecentClips/2026-10-11_10-00-11-front.mp4", day, 1000, 5000.4)]);
    let idx = index(&car);
    run(&idx);
    assert_eq!(idx.status()["total"], json!(0), "nothing to read again");
    assert_eq!(idx.day("v1", day), vec![("TeslaCam/RecentClips/2026-10-11_10-00-11-front.mp4".to_string(), json!([1, 2]))]);
    let mut keys: Vec<String> = day_file(&car, day).keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, vec!["SavedClips/2026-10-11_10-05-00/2026-10-11_10-00-11-front.mp4", "TeslaCam/RecentClips/2026-10-11_10-00-11-front.mp4"]);

    // a clip under its old path that has changed since is read again
    let mut data = day_file(&car, day);
    data.insert("RecentClips/2026-10-11_11-00-00-front.mp4".into(), json!([1000, 5000, [4], sum]));
    write_day(&car, day, Value::Object(data));
    set_files(&car, vec![entry("TeslaCam/RecentClips/2026-10-11_10-00-11-front.mp4", day, 1000, 5000.4), entry("TeslaCam/RecentClips/2026-10-11_11-00-00-front.mp4", day, 2000, 5000.4)]);
    let fresh = index(&car);
    run(&fresh);
    assert_eq!(fresh.status()["total"], json!(1));
}

#[test]
fn a_move_is_not_taken_for_a_clip_still_there() {
    let car = Car::new("si-move2");
    let day = "2026-10-11";
    write_day(&car, day, json!({ "RecentClips/a-front.mp4": [1000, 5000, [1], null] }));
    set_files(&car, vec![entry("RecentClips/a-front.mp4", day, 1000, 5000.0), entry("TeslaCam/RecentClips/a-front.mp4", day, 1000, 5000.0)]);
    let idx = index(&car);
    run(&idx);
    assert_eq!(idx.status()["total"], json!(1), "the other path is a clip of its own: read");
    let mut keys: Vec<String> = idx.day("v1", day).into_iter().map(|x| x.0).collect();
    keys.sort();
    assert_eq!(keys, vec!["RecentClips/a-front.mp4", "TeslaCam/RecentClips/a-front.mp4"]);

    set_files(&car, vec![entry("RecentClips/b-front.mp4", day, 1000, 5000.0)]);
    run(&idx);
    set_files(&car, vec![entry("TeslaCam/RecentClips/b-front.mp4", day, 1000, 5000.0)]);
    run(&idx);
    assert_eq!(idx.status()["total"], json!(0), "found under the old path, not read again");
    assert_eq!(idx.day("v1", day).into_iter().map(|x| x.0).collect::<Vec<_>>(), vec!["TeslaCam/RecentClips/b-front.mp4"]);
}

#[test]
fn each_clip_keeps_braking_sideways_top_speed_and_where_it_was() {
    let car = Car::new("si-sum");
    let speeds = [20.0f32, 20.0, 12.0, 11.0];
    let recs: Vec<Option<Rec>> = (0..48)
        .map(|n| {
            let sec = n / 12;
            Some(Rec { v: speeds[sec], lat: Some(37.7749 + sec as f64 * 0.001), lon: Some(-122.4194), ax: Some(-1.0), ay: Some(if sec == 1 { -3.0 } else { 0.5 }) })
        })
        .collect();
    testkit::clip(&car.root.join("RecentClips/2026-10-11_10-00-11-front.mp4"), 12, &recs, 12);
    car.scan();
    let idx = index(&car);
    run(&idx);
    assert_eq!(idx.day("v1", "2026-10-11")[0].1, json!([20, 20, 12, 11]));
    assert_eq!(idx.summaries("v1", "2026-10-11")[0].1, json!({ "b": [1, 8], "t": [1, 3], "v": [0, 20], "g": [[0, 37.7749, -122.4194]], "k": 2 }));

    // an entry from before summaries existed is read again
    let mut data = day_file(&car, "2026-10-11");
    let e = data.get_mut("RecentClips/2026-10-11_10-00-11-front.mp4").unwrap().as_array_mut().unwrap();
    e.truncate(3);
    write_day(&car, "2026-10-11", Value::Object(data));
    let again = index(&car);
    assert!(again.summaries("v1", "2026-10-11").is_empty());
    run(&again);
    assert_eq!(again.summaries("v1", "2026-10-11").len(), 1);

    // and one from an older summary
    let mut data = day_file(&car, "2026-10-11");
    let e = &mut data["RecentClips/2026-10-11_10-00-11-front.mp4"][3];
    e.as_object_mut().unwrap().remove("k");
    e["b"] = Value::Null;
    write_day(&car, "2026-10-11", Value::Object(data));
    let third = index(&car);
    run(&third);
    assert_eq!(third.summaries("v1", "2026-10-11")[0].1["b"], json!([1, 8]));
}

#[test]
fn moments_and_places_near() {
    let car = Car::new("si-moments");
    let clip = |n: u32| format!("RecentClips/2026-10-11_10-0{n}-00-front.mp4");
    set_files(&car, (1..=5).map(|n| entry(&clip(n), "2026-10-11", 100 + n as u64, 1000.0)).collect());
    let sum = |b: Value, t: Value, v: Value, g: Value| json!({ "b": b, "t": t, "v": v, "g": g });
    write_day(&car, "2026-10-11", json!({
        clip(1): [101, 1000, [], sum(json!([12, 3.0]), json!([3, 2]), json!([0, 20]), json!([]))],
        clip(2): [102, 1000, [], sum(json!([30, 7.2]), json!([5, 1]), json!([10, 25]), json!([[0, 37.7749, -122.4194], [5, 37.7760, -122.4194]]))],
        clip(3): [103, 1000, [], sum(json!([2, 4.5]), json!([40, 5.1]), json!([20, 31]), json!([]))],
        clip(4): [104, 1000, [], sum(Value::Null, Value::Null, json!([1, 33]), json!([]))],
        clip(5): [999, 1000, [], sum(json!([1, 9]), Value::Null, json!([1, 40]), json!([]))],
    }));
    let idx = index(&car);
    let got: Vec<(&str, String, Value, f64)> = idx.moments("v1", "2026-10-11").into_iter().map(|m| (m.kind, m.rel[23..31].to_string(), m.second, m.value)).collect();
    let want = vec![("brake", "10-02-00", 30, 7.2), ("swerve", "10-03-00", 40, 5.1), ("brake", "10-03-00", 2, 4.5), ("speed", "10-04-00", 1, 33.0), ("speed", "10-03-00", 20, 31.0), ("speed", "10-02-00", 10, 25.0)];
    assert_eq!(got, want.into_iter().map(|(k, r, s, v)| (k, r.to_string(), json!(s), v)).collect::<Vec<_>>());
    let near = idx.near(&["v1".into()], 37.7759, -122.4194, 150.0, 300);
    assert_eq!(near.iter().map(|h| (h.rel[23..31].to_string(), h.second, h.metres)).collect::<Vec<_>>(), vec![("10-02-00".to_string(), 5.0, 11.0)]);
    assert!(idx.near(&["v1".into()], 40.0, -100.0, 150.0, 300).is_empty());
}

#[test]
fn the_place_search_cache_is_filled_ahead() {
    let car = Car::new("si-warm");
    for day in ["2026-11-01", "2026-11-02"] {
        let dir = car.data.join("speeds/car");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{day}.json")), json!({ format!("TeslaCam/RecentClips/{day}_10-00-00-front.mp4"): [1, 1, [10], { "b": null, "t": null, "v": [0, 10], "g": [[0, 37.788, -122.4193], [5, 37.8, -122.5]] }] }).to_string()).unwrap();
    }
    let idx = index(&car);
    idx.warm(&["car".into()], 0);
    assert_eq!(idx.inner.lock().unwrap().geo.len(), 2, "both days in the cache");
    let hits = idx.near(&["car".into()], 37.788, -122.4193, 100.0, 300);
    assert_eq!(hits.iter().map(|h| (h.day.clone(), h.second, h.metres)).collect::<Vec<_>>(), vec![("2026-11-02".to_string(), 0.0, 0.0), ("2026-11-01".to_string(), 0.0, 0.0)]);
}

#[test]
fn an_older_summary_without_a_slowing_second_is_upgraded_in_place() {
    let car = Car::new("si-upgrade");
    let rel = |n: u32| format!("RecentClips/2026-10-11_10-0{n}-00-front.mp4");
    set_files(&car, (1..=2).map(|n| entry(&rel(n), "2026-10-11", 100 + n as u64, 1000.0)).collect());
    let parked = json!({ "b": null, "t": [3, 0.2], "v": [0, 0], "g": [] });
    write_day(&car, "2026-10-11", json!({
        rel(1): [101, 1000, [0, 0, 0, 0.1, 0.2], parked],
        rel(2): [102, 1000, [20, 18, 16], { "b": [0, 2], "t": null, "v": [0, 20], "g": [] }],
    }));
    let idx = index(&car);
    run(&idx);
    assert_eq!(idx.status()["total"], json!(1), "only the one that slows is read again");
    let saved = day_file(&car, "2026-10-11");
    assert_eq!(saved[&rel(1)], json!([101, 1000, [0, 0, 0, 0.1, 0.2], { "b": null, "t": [3, 0.2], "v": [0, 0], "g": [], "k": 2 }]));
}

#[test]
fn several_clips_at_once_each_from_another_day_all_kept_and_both_modes_read_the_same() {
    let car = Car::new("si-many");
    for d in 1..=4 {
        let recs: Vec<Option<Rec>> = (0..8).map(|n| Some(Rec { v: d as f32 + n as f32, lat: Some(30.0), lon: Some(-97.0), ..Rec::default() })).collect();
        testkit::clip(&car.root.join(format!("RecentClips/2026-10-0{d}_10-00-00-front.mp4")), 4, &recs, 4);
    }
    car.scan();
    let pace = Arc::new(Pace::new(|| 4, || false, crate::scanner::now_ms, crate::viewer::pace::SleepLag::start()));
    let idx = SpeedIndex::new(car.data.join("speeds"), car.ctx.clone(), pace, 0, Limiter::new(|| 2));
    run(&idx);
    for d in 1..=4 {
        assert_eq!(idx.day("v1", &format!("2026-10-0{d}"))[0].1, json!([d, d + 4]));
    }
    let p = car.root.join("RecentClips/2026-10-01_10-00-00-front.mp4");
    let a = speed_reader::read_records(&p, Mode::Short).unwrap();
    let b = speed_reader::read_records(&p, Mode::Straight).unwrap();
    assert_eq!(a, b);
    // the status says which read was faster once both were tried
    assert!(idx.status()["readMode"].is_string());
}

#[test]
fn stats_of_a_clip() {
    let s = stats_of(&json!([0, 1, 2, null, 0.4, 3]), &json!({ "b": [1, 4], "t": [0, 1], "g": [[0, 1, 2], [5, 3, 4]] })).unwrap();
    assert_eq!(s, Stats { n: 5, d: 6.4, m: 3, v: 3.0, f: 1, l: 5, a: Some((1.0, 2.0)), z: Some((3.0, 4.0)), b: 1, t: 0 });
    assert!(stats_of(&json!([null]), &Value::Null).is_none());
    assert!(stats_of(&Value::Null, &Value::Null).is_none());
}
