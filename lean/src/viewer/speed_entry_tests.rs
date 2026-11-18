use super::*;
use serde_json::json;

fn clip() -> Value {
    json!([24117248, 1762956011000u64, [0, 12.34, null, 61.07, -3.5],
        { "b": [3, 4.21], "t": null, "v": [3, 61.07], "g": [[0, 37.77493, -122.41942], [5, 37.7751, -122.41899]], "k": 2 }])
}

#[test]
fn a_clip_is_kept_as_numbers_and_comes_back_the_same() {
    let e = Entry::from_value(clip());
    assert!(matches!(e, Entry::Clip { sum: Sum::Typed(_), .. }));
    assert_eq!(e.value(), clip());
    assert_eq!(e.value().to_string(), clip().to_string());
    assert_eq!((e.num(0), e.num(1), e.complete()), (Some(24117248.0), Some(1762956011000.0), true));
    assert_eq!(e.speeds(), json!([0, 12.34, null, 61.07, -3.5]));
    assert_eq!(e.summary_version(), Some(2.0));
    assert!(e.summary_truthy() && e.summary_is_object() && !e.summary_is_null());
    assert_eq!(e.positions().to_vec(), vec![[0.0, 37.77493, -122.41942], [5.0, 37.7751, -122.41899]]);
    assert!(e.can_brake());
}

#[test]
fn null_speeds_and_summary() {
    let v = json!([10, 20, null, null]);
    let e = Entry::from_value(v.clone());
    assert!(matches!(e, Entry::Clip { speeds: None, sum: Sum::Null, .. }));
    assert_eq!(e.value(), v);
    assert!(e.summary_is_null() && !e.summary_truthy() && !e.can_brake());
    assert_eq!((e.speeds(), e.summary()), (Value::Null, Value::Null));
}

#[test]
fn shapes_it_does_not_model_stay_as_read() {
    for v in [json!([10, 20]), json!([10, 20, null, null, "x"]), json!([10.0, 20, null, null]), json!({ "a": 1 }), json!([10, 20, [1, "2"], null])] {
        let e = Entry::from_value(v.clone());
        assert!(matches!(e, Entry::Raw(_)), "{v}");
        assert_eq!(e.value(), v);
    }
    let old = json!([10, 20, [5, 4], { "b": [1, 1], "v": [0, 5] }]);
    let e = Entry::from_value(old.clone());
    assert!(matches!(e, Entry::Clip { sum: Sum::Raw(_), .. }));
    assert_eq!(e.value(), old);
    assert_eq!(e.summary_version(), None);
    assert!(e.summary_is_object() && e.summary_truthy());
}

#[test]
fn an_older_summary_marked_version_2() {
    let mut e = Entry::from_value(json!([10, 20, [5, 5], { "b": null, "t": null, "v": [0, 5], "g": [], "k": 1 }]));
    assert_eq!(e.summary_version(), Some(1.0));
    assert!(!e.can_brake());
    e.mark_version_2();
    assert_eq!(e.value(), json!([10, 20, [5, 5], { "b": null, "t": null, "v": [0, 5], "g": [], "k": 2 }]));

    let mut raw = Entry::from_value(json!([10, 20, [5, 5], { "v": [0, 5] }]));
    raw.mark_version_2();
    assert_eq!(raw.value(), json!([10, 20, [5, 5], { "v": [0, 5], "k": 2 }]));
}

#[test]
fn a_day_file_round_trips() {
    let text = json!({ "RecentClips/a-front.mp4": clip(), "RecentClips/b-front.mp4": [1, 2, null, null], "odd": [1] }).to_string();
    let day = parse_day(&text).unwrap();
    assert_eq!(day.keys().collect::<Vec<_>>(), ["RecentClips/a-front.mp4", "RecentClips/b-front.mp4", "odd"]);
    assert_eq!(day_value(&day).to_string(), text);
    assert!(parse_day("[1]").is_none());
}

#[test]
fn a_summary_in_another_key_order_stays_as_read() {
    let text = r#"[10,20,[1,2],{"k":2,"g":[],"v":[0,2],"t":null,"b":null}]"#;
    let e = Entry::from_value(serde_json::from_str(text).unwrap());
    assert!(matches!(e, Entry::Clip { sum: Sum::Raw(_), .. }));
    assert_eq!(e.value().to_string(), text);
}

#[test]
fn stats_from_the_numbers_are_the_ones_from_json() {
    let entries = [
        clip(),
        json!([1, 2, [0, 0.4, 0.6, null, 3, -2.5], { "b": [2, 3.9], "t": [1, 4], "v": [4, 3], "g": [[0, 1.5, 2.5]], "k": 2 }]),
        json!([1, 2, [0.1, 0.2], { "b": null, "t": [0, 3.99], "v": [0, 0.2], "g": [], "k": 2 }]),
        json!([1, 2, [null, null], null]),
        json!([1, 2, [5, 6], null]),
        json!([1, 2, null, null]),
        json!([1, 2, [5, 6], { "v": [0, 6] }]),
        json!([1, 2, [5, 6], { "b": [0, 5], "t": [1, 4.5], "g": [[0, 1, 2], [5, "3", null]], "k": 1 }]),
        json!([1, 2, [5, null, 7], 5]),
        json!([1, 2, [5, 6], { "b": [0, 5] }, "raw"]),
    ];
    for v in entries {
        let e = Entry::from_value(v.clone());
        assert_eq!(e.stats(), stats_of(&v[2], &v[3]), "{v}");
    }
}

#[test]
fn a_summary_counts_as_there_as_before() {
    for (sum, there) in [(json!(null), false), (json!(false), false), (json!(0), false), (json!(""), false), (json!(0.0), true), (json!(1), true), (json!("x"), true), (json!({}), true), (json!([]), true)] {
        let old = !sum.is_null() && sum != json!(false) && sum != json!(0) && sum != json!("");
        assert_eq!(old, there, "{sum}");
        assert_eq!(Entry::from_value(json!([1, 2, [3], sum.clone()])).summary_truthy(), there, "{sum}");
        assert_eq!(Entry::from_value(json!([1, 2, [3], sum.clone(), "raw"])).summary_truthy(), there, "{sum}");
    }
}
