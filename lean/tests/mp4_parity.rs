//! The Rust MP4 and telemetry readers against the Node ones, on the same
//! files, frozen in tests/fixtures/node-reference/mp4.tar.xz: the former
//! lean/parity/mp4Fixtures.js wrote the fixtures (real ffmpeg
//! encodes and synthetic ones from test/fixtures/fixtureBuilders.js) and
//! expected.json, what server/mp4codec.js, server/speedReader.js, src/main/converter/mp4.js and
//! server/telemetry.js (the full read) get from each, and what server/speedIndex.js keeps
//! for it (the quick read, else the full one) and its summarize of the samples;
//! every value here must match exactly.

#[path = "support/reference.rs"]
mod reference;

use sentry_lean::viewer::speed_index::{speeds_for, summarize};
use sentry_lean::viewer::{speed_reader::Mode, telemetry_api::Limiter};
use sentry_lean::{mp4, sei, telemetry};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn fixtures() -> Option<PathBuf> {
    Some(reference::unpack("mp4", "parity"))
}

/// Numbers as f64 everywhere: Node writes 12 where serde writes 12.0.
fn norm(v: Value) -> Value {
    match v {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(a) => Value::Array(a.into_iter().map(norm).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, norm(v))).collect()),
        other => other,
    }
}

fn error() -> Value {
    json!({ "error": true })
}

fn rust_side(file: &Path) -> Value {
    let codec = match mp4::video_codec(file) {
        Ok(c) => json!(c),
        Err(_) => error(),
    };
    let (samples, summary) = match sei::read_samples(file) {
        Ok(Some(s)) => (serde_json::to_value(&s).unwrap(), summarize(&s)),
        Ok(None) => (Value::Null, Value::Null),
        Err(_) => (error(), Value::Null),
    };
    let speeds = match sei::read_speeds(file) {
        Ok(s) => json!(s),
        Err(_) => error(),
    };
    let info = match mp4::clip_info(file) {
        Ok(i) => json!({
            "trackId": i.track_id, "entry": i.entry, "timescale": i.timescale, "mdhdDuration": i.mdhd_duration,
            "durationTicks": i.duration_ticks, "duration": i.duration, "keyframes": i.keyframes,
            "samples": i.samples.iter().map(|s| json!([s.offset, s.size, s.dts, s.pts, s.duration, s.description])).collect::<Vec<_>>()
        }),
        Err(_) => error(),
    };
    let size = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0);
    let records = match telemetry::read_records(file, size) {
        Ok(r) => json!(r.iter().map(|(t, rec)| json!([t, rec.iter().map(|b| format!("{b:02x}")).collect::<String>()])).collect::<Vec<_>>()),
        Err(_) => error(),
    };
    let (sp, sum) = speeds_for(file, size, Mode::Short, &Limiter::new(|| 1), false);
    let index = json!([sp, sum]);
    json!({ "codec": codec, "samples": samples, "summary": summary, "speeds": speeds, "info": info, "records": records, "index": index })
}

#[test]
fn mp4_and_telemetry_match_node() {
    let Some(dir) = fixtures() else { return };
    let expected: serde_json::Map<String, Value> = serde_json::from_slice(&std::fs::read(dir.join("expected.json")).unwrap()).unwrap();
    assert!(expected.len() > 30, "fixtures were made");
    let mut failures = Vec::new();
    for (name, want) in &expected {
        let got = rust_side(&dir.join(name));
        for key in ["codec", "samples", "summary", "speeds", "info", "records", "index"] {
            let (w, g) = (norm(want[key].clone()), norm(got[key].clone()));
            if w != g {
                let show = |v: &Value| v.to_string().chars().take(400).collect::<String>();
                failures.push(format!("{name} {key}:\n  node: {}\n  rust: {}", show(&w), show(&g)));
            }
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
    assert!(failures.is_empty(), "{} differences:\n{}", failures.len(), failures.join("\n"));
    eprintln!("{} fixtures x 7 readers: identical", expected.len());
}

#[test]
fn tesla_payload_strips_emulation_prevention() {
    // 06 05 size 42 42 69 <00 00 03 01> 80: the 03 goes, the size counts the bytes without it
    let nal = [0x06, 0x05, 0x06, 0x42, 0x42, 0x69, 0x00, 0x00, 0x03, 0x01, 0x80];
    assert_eq!(sei::tesla_payload(&nal), Some(vec![0x00, 0x00, 0x01]));
    // not type 6 / not payload 5 / no 0x80 end / no 69 marker
    assert_eq!(sei::tesla_payload(&[0x01, 0x05, 0x04, 0x42, 0x69, 0x01, 0x80]), None);
    assert_eq!(sei::tesla_payload(&[0x06, 0x04, 0x04, 0x42, 0x69, 0x01, 0x80]), None);
    assert_eq!(sei::tesla_payload(&[0x06, 0x05, 0x04, 0x42, 0x69, 0x01, 0x81]), None);
    assert_eq!(sei::tesla_payload(&[0x06, 0x05, 0x04, 0x42, 0x68, 0x01, 0x80]), None);
}

#[test]
fn js_rounding() {
    assert_eq!(sei::js_round(2.5), 3.0);
    assert_eq!(sei::js_round(-2.5), -2.0);
    assert_eq!(sei::js_round(-0.4), -0.0);
    assert_eq!(sei::r2(1.005), 1.0); // 1.005 * 100 = 100.49999999999999
}
