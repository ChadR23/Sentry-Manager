// test/driveData.test.js

use super::*;

const FR: f64 = 1800.0;

fn key_at(day: &str, hh: i64, mm: i64) -> String {
    let y: i64 = day[0..4].parse().unwrap();
    let mo: i64 = day[5..7].parse().unwrap();
    let d: i64 = day[8..10].parse().unwrap();
    let s = js::utc_seconds(y, mo, d, hh, mm, 0);
    js::iso(s * 1000.0)[..19].replace('T', "_").replace(':', "-")
}

fn b64(a: &[u8]) -> String {
    super::super::telemetry_api::base64(a)
}

struct R {
    lat0: f64,
    lon: f64,
    v: f64,
    n: usize,
    ap: Box<dyn Fn(usize, usize) -> u8>,
    gear_runs: Vec<(f64, f64)>,
    base64: bool,
    pascal: bool,
}

impl Default for R {
    fn default() -> R {
        R { lat0: 41.9, lon: -87.7, v: 10.0, n: 61, ap: Box::new(|_, _| 0), gear_runs: vec![(1.0, FR)], base64: true, pascal: false }
    }
}

fn route(key: &str, o: R) -> Value {
    let dt = 60.0 / (o.n - 1) as f64;
    let points: Vec<Value> = (0..o.n).map(|i| json!([o.lat0 + (i as f64 * o.v * dt) / 111195.0, o.lon])).collect();
    let aps: Vec<u8> = (0..o.n).map(|i| (o.ap)(i, o.n)).collect();
    let gears = vec![1u8; o.n];
    let gs = if o.base64 { json!(b64(&gears)) } else { json!(gears) };
    let apv = if o.base64 { json!(b64(&aps)) } else { json!(aps) };
    let runs: Vec<Value> = o.gear_runs.iter().map(|(g, f)| json!({ "gear": g, "frames": f })).collect();
    let park: f64 = o.gear_runs.iter().filter(|r| r.0 == 0.0).map(|r| r.1).sum();
    let file = format!("{}/{}-front.mp4", &key[..10], key);
    if o.pascal {
        let runs: Vec<Value> = o.gear_runs.iter().map(|(g, f)| json!({ "Gear": g, "Frames": f })).collect();
        return json!({ "File": file, "Date": &key[..10], "Points": points, "GearStates": gs, "AutopilotStates": apv, "Speeds": vec![o.v; o.n], "GearRuns": runs });
    }
    json!({ "file": file, "date": &key[..10], "points": points, "gearStates": gs, "autopilotStates": apv, "speeds": vec![o.v; o.n], "accelPositions": vec![0; o.n],
        "rawParkCount": park, "rawFrameCount": FR, "gearRuns": runs })
}

fn drives_of(routes: &[Value], gap: f64) -> Vec<UsbDrive> {
    group_drives(&finish_clips(routes.iter().filter_map(reduce_route).collect()), gap)
}

fn iso(ms: f64) -> String {
    js::iso(ms)[..19].to_string()
}

#[test]
fn the_format_base64_or_arrays_camel_or_pascal() {
    assert_eq!(bytes_of(Some(&json!("AAEAAA=="))), vec![0.0, 1.0, 0.0, 0.0]);
    assert_eq!(bytes_of(Some(&json!([0, 0, 0, 1]))), vec![0.0, 0.0, 0.0, 1.0]);
    assert!(bytes_of(Some(&json!("not base64!"))).is_empty());
    assert!(bytes_of(Some(&Value::Null)).is_empty());
    let k = key_at("2026-10-01", 8, 0);
    let a = reduce_route(&route(&k, R { ap: Box::new(|_, _| 1), ..R::default() })).unwrap();
    let b = reduce_route(&route(&k, R { ap: Box::new(|_, _| 1), base64: false, ..R::default() })).unwrap();
    let c = reduce_route(&route(&k, R { ap: Box::new(|_, _| 1), pascal: true, ..R::default() })).unwrap();
    assert_eq!(a["k"], json!(k));
    assert_eq!(a, b);
    assert_eq!(a["segs"], c["segs"]);
    assert_eq!(a["segs"].as_array().unwrap().len(), 1);
    assert!((a["segs"][0]["d"].as_f64().unwrap() - 600.0).abs() < 2.0);
    assert_eq!(a["segs"][0]["v"], json!(10));
    assert!(a["segs"][0]["ap"][0].as_f64().unwrap() > 590.0);
    for file in ["SentryClips/2026-10-01_08-00-00/2026-10-01_08-00-00-front.mp4", "SavedClips/x/2026-10-01_08-00-00-front.mp4", ".partial/2026-10-01_08-00-00-front.mp4", "RecentClips/front.mp4"] {
        let mut r = route(&k, R::default());
        r["file"] = json!(file);
        assert!(reduce_route(&r).is_none(), "{file}");
    }
    let mut r = route(&k, R::default());
    r["file"] = json!(format!("RecentClips/{k}-front.mp4"));
    assert!(reduce_route(&r).is_some());
}

#[test]
fn the_streaming_tokenizer_in_any_chunk_size() {
    let mut second = route(&key_at("2026-10-01", 8, 1), R::default());
    second["source"] = json!("a \"quoted\" }] value\\");
    let routes = vec![route(&key_at("2026-10-01", 8, 0), R::default()), second];
    let text = format!("\u{feff}{}\n", json!({ "processedFiles": ["a", "b]}"], "routes": routes, "driveTags": { "2026-10-01T08:00:00.000": ["Work"] }, "telemetrySamples": [{ "t": 1, "s": "{[" }], "chargeCosts": { "1": { "amount": 2 } }, "x": null, "y": 1.5 }));
    let buf = text.as_bytes();
    for size in [1, 2, 3, 7, 64, 4096] {
        let mut got = Vec::new();
        let mut tags = Value::Null;
        let (routes_n, keys) = {
            let mut s = Scanner::new(|r| got.push(r), |t| tags = t);
            for c in buf.chunks(size) {
                s.push(c).unwrap();
            }
            (s.end().unwrap().0, s.keys.clone())
        };
        assert_eq!(routes_n, 2, "chunks of {size}");
        assert_eq!(got, routes);
        assert_eq!(tags, json!({ "2026-10-01T08:00:00.000": ["Work"] }));
        assert_eq!(keys, vec!["processedFiles", "routes", "driveTags", "telemetrySamples", "chargeCosts", "x", "y"]);
    }
    let mut cut = Scanner::new(|_| {}, |_| {});
    cut.push(&buf[..buf.len() - 30]).unwrap();
    assert!(cut.end().unwrap_err().contains("ends part way"));
    assert!(Scanner::new(|_| {}, |_| {}).push(b"[1,2]").unwrap_err().contains("not a JSON object"));
    assert!(Scanner::new(|_| {}, |_| {}).push(br#"{"routes":[{"file":x}]}"#).unwrap_err().contains("not JSON"));
    let mut big = Scanner::new(|_| {}, |_| {});
    big.max_route = 1000;
    big.push(json!({ "routes": [route(&key_at("2026-10-01", 8, 0), R::default()), { "file": "a" }] }).to_string().as_bytes()).unwrap();
    assert_eq!((big.end().unwrap().0, big.skipped), (1, 1));
}

#[test]
fn a_clip_more_than_the_gap_after_starts_a_new_drive() {
    let d = "2026-10-01";
    let mut routes: Vec<Value> = [0, 1, 2].iter().map(|m| route(&key_at(d, 8, *m), R::default())).collect();
    routes.push(route(&key_at(d, 8, 7), R::default()));
    routes.push(route(&key_at(d, 8, 13), R::default()));
    routes.push(route(&key_at(d, 23, 59), R::default()));
    routes.push(route(&key_at(d, 23, 60), R::default()));
    let out = drives_of(&routes, DEFAULT_GAP_S);
    let got: Vec<(String, String, usize)> = out.iter().map(|x| (iso(x.start_ms), iso(x.end_ms), x.keys.len())).collect();
    assert_eq!(got, vec![
        ("2026-10-01T23:59:00".into(), "2026-10-02T00:01:00".into(), 2),
        ("2026-10-01T08:13:00".into(), "2026-10-01T08:14:00".into(), 1),
        ("2026-10-01T08:00:00".into(), "2026-10-01T08:08:00".into(), 4),
    ]);
    assert_eq!(drives_of(&routes, 600.0).len(), 2);
    assert_eq!(drives_of(&routes, 120.0).len(), 4);
    let short = drives_of(&[route(&format!("{d}_09-00-00"), R::default()), route(&format!("{d}_09-00-40"), R::default())], DEFAULT_GAP_S);
    assert_eq!(iso(short[0].end_ms), "2026-10-01T09:01:40");
}

#[test]
fn park_of_two_seconds_or_more_splits_a_drive() {
    let d = "2026-10-02";
    let park = |f: f64| vec![(1.0, 600.0), (0.0, f), (1.0, FR - 600.0 - f)];
    let routes = vec![route(&key_at(d, 10, 0), R::default()), route(&key_at(d, 10, 1), R { gear_runs: park(600.0), ..R::default() }), route(&key_at(d, 10, 2), R::default())];
    let out = drives_of(&routes, DEFAULT_GAP_S);
    assert_eq!(out.iter().map(|x| (iso(x.start_ms), iso(x.end_ms))).collect::<Vec<_>>(), vec![
        ("2026-10-02T10:01:40".to_string(), "2026-10-02T10:03:00".to_string()),
        ("2026-10-02T10:00:00".to_string(), "2026-10-02T10:01:20".to_string()),
    ]);
    assert_eq!(out[0].tag_key, "2026-10-02T10:01:40.000");
    let one = vec![route(&key_at(d, 10, 0), R::default()), route(&key_at(d, 10, 1), R { gear_runs: park(30.0), ..R::default() }), route(&key_at(d, 10, 2), R::default())];
    assert_eq!(drives_of(&one, DEFAULT_GAP_S).len(), 1);
    let tail = drives_of(&[route(&key_at(d, 11, 0), R::default()), route(&key_at(d, 11, 1), R { gear_runs: vec![(0.0, FR)], ..R::default() })], DEFAULT_GAP_S);
    assert_eq!(tail.iter().map(|x| (iso(x.start_ms), iso(x.end_ms), x.keys.len())).collect::<Vec<_>>(), vec![("2026-10-02T11:00:00".to_string(), "2026-10-02T11:01:00".to_string(), 1)]);
    let legacy = |k: String, parked: bool| {
        let mut r = route(&k, R::default());
        r.as_object_mut().unwrap().remove("gearRuns");
        r["rawParkCount"] = json!(if parked { 1500 } else { 0 });
        r
    };
    assert_eq!(drives_of(&[legacy(key_at(d, 12, 0), false), legacy(key_at(d, 12, 1), true), legacy(key_at(d, 12, 2), false)], DEFAULT_GAP_S).len(), 2);
}

#[test]
fn autopilot_shares_distance_top_speed_route_and_tags() {
    let d = "2026-10-03";
    let routes = vec![
        route(&key_at(d, 7, 0), R { v: 10.0, lat0: 41.9, ..R::default() }),
        route(&key_at(d, 7, 1), R { v: 20.0, lat0: 41.9 + 600.0 / 111195.0, ap: Box::new(|_, _| 1), ..R::default() }),
        route(&key_at(d, 7, 2), R { v: 10.0, lat0: 41.9 + 1800.0 / 111195.0, ap: Box::new(|i, n| if (i as f64) < n as f64 / 2.0 { 2 } else { 3 }), ..R::default() }),
    ];
    let dr = drives_of(&routes, DEFAULT_GAP_S).remove(0);
    assert!((dr.distance - 2400.0).abs() < 5.0, "distance {}", dr.distance);
    assert_eq!(dr.top, 20.0);
    let ap = &dr.autopilot;
    assert!((ap["fsd"].as_f64().unwrap() - 50.0).abs() < 0.6);
    assert!((ap["autosteer"].as_f64().unwrap() + ap["tacc"].as_f64().unwrap() - 25.0).abs() < 0.6);
    assert!((ap["percent"].as_f64().unwrap() - 75.0).abs() < 0.6);
    assert!((ap["fsdSeconds"].as_f64().unwrap() - 60.0).abs() <= 1.0);
    assert!(dr.route.len() > 2 && dr.route.len() <= 96);
    assert_eq!(dr.from, Some((41.9, -87.7)));
    assert_eq!(drives_of(&[route(&key_at(d, 9, 0), R::default())], DEFAULT_GAP_S)[0].autopilot["percent"], json!(0));
    let tags = tag_index(Some(&json!({ "2026-10-03T07:00:00.000": ["Work", "Work", ""], key_at(d, 9, 0): ["Gym"], "junk": "x" })));
    assert_eq!(tags_of(Some(&tags), &dr), json!(["Work"]));
    assert_eq!(tags_of(Some(&tags), &drives_of(&[route(&key_at(d, 9, 0), R::default())], DEFAULT_GAP_S)[0]), json!(["Gym"]));
    let key = key_at(d, 7, 0);
    let clip = super::super::drives::Clip { key: &key, t: js::utc_seconds(2026, 10, 3, 7, 0, 0), day: d, rel: "", front: true, rec_id: "r1", rec_day: d };
    let ck = clip.key.clone();
    let none = |_: f64, _: f64| (Value::Null, Value::Null);
    let api = describe_drive(&dr, Some(&tags), &|k| (k == ck).then(|| clip.clone()), &|_| Some(super::super::speed_index::Stats { n: 1, d: 0.0, m: 0, v: 0.0, f: -1, l: -1, a: None, z: None, b: 1, t: 0 }), &none);
    assert_eq!((api["id"].clone(), api["start"].clone(), api["end"].clone(), api["seconds"].clone(), api["clips"].clone(), api["footage"].clone(), api["hardBrakes"].clone(), api["tags"].clone()),
        (json!(format!("{d}_07-00-00")), json!(format!("{d} 07:00:00")), json!(format!("{d} 07:03:00")), json!(180), json!(3), json!(1), json!(1), json!(["Work"])));
    assert_eq!(api["open"], json!({ "recording": "r1", "day": d, "clip": clip.key, "second": 0 }));
    assert_eq!(describe_drive(&dr, None, &|_| None, &|_| None, &none)["open"], Value::Null);
}

#[test]
fn read_in_the_background_cached_and_read_again_only_when_it_changes() {
    let car = super::super::testkit::Car::new("dd-read");
    let file = car.root.join(FILE);
    let routes: Vec<Value> = (0..20).map(|i| route(&key_at("2026-09-01", 6 + i / 10, i % 10), R { n: 600, ..R::default() })).collect();
    std::fs::write(&file, json!({ "processedFiles": [], "routes": routes, "driveTags": { "2026-09-01T06:00:00.000": ["Commute"] } }).to_string()).unwrap();
    // an hour old: settled
    let old = std::time::SystemTime::now() - Duration::from_secs(3600);
    std::fs::File::options().write(true).open(&file).unwrap().set_modified(old).unwrap();
    let dd = DriveData::new(car.data.join("drive-data"), car.ctx.clone());
    assert!(!dd.view("v1").usable);
    dd.check("v1", true);
    dd.settled();
    let v = dd.view("v1");
    assert!(v.usable);
    assert_eq!(v.meta["routes"], json!(20));
    let drives = dd.drives("v1", DEFAULT_GAP_S);
    assert_eq!(drives.len(), 2);
    assert_eq!(tags_of(dd.tags("v1").as_ref(), &drives[1]), json!(["Commute"]));
    let cache: Value = serde_json::from_str(&std::fs::read_to_string(car.data.join("drive-data/v1.json")).unwrap()).unwrap();
    assert_eq!(cache["used"], json!(20));
    assert_eq!(cache["tags"], json!({ "2026-09-01T06:00:00.000": ["Commute"] }));
    // a restart reads the cache, not the file
    let again = DriveData::new(car.data.join("drive-data"), car.ctx.clone());
    again.load_cache("v1");
    assert_eq!(again.drives("v1", DEFAULT_GAP_S).len(), 2);
    // a broken file keeps the last good read
    std::fs::write(&file, "{\"routes\":[").unwrap();
    std::fs::File::options().write(true).open(&file).unwrap().set_modified(old).unwrap();
    dd.check("v1", true);
    dd.settled();
    let v = dd.view("v1");
    assert!(v.usable);
    assert!(v.meta["error"].as_str().unwrap().contains("ends part way"));
    assert_eq!(dd.drives("v1", DEFAULT_GAP_S).len(), 2);
}
