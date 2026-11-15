//! Parity with the Node converter on real encodes: testdata/telemetryFixtures.js
//! makes Tesla-like originals (keyframe first, lead-in, frame_num gaps, no
//! keyframe), encodes them with the converter's arguments and stores what the
//! Node code reads and writes. The Rust timeline must read the same, and the
//! Rust writer must produce the same bytes (or refuse with the same code).
//!
//! Skipped (with a note) without node and ffmpeg. Set
//! LEAN_CONVERTER_FIXTURES=<dir> to reuse fixtures made earlier.

use super::adapters::{telemetry_bytes, Codec};
use super::lead_in::{hold_frames, source_timing_for};
use super::timeline::extract;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

fn have(cmd: &str, arg: &str) -> bool {
    Command::new(cmd).arg(arg).output().map(|o| o.status.success()).unwrap_or(false)
}

pub fn fixtures() -> Option<&'static PathBuf> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        if let Ok(d) = std::env::var("LEAN_CONVERTER_FIXTURES") {
            let d = PathBuf::from(d);
            if d.join("cases.json").exists() {
                return Some(d);
            }
        }
        if !have("node", "--version") || !have("ffmpeg", "-version") {
            eprintln!("skipped: node and ffmpeg are needed to make the fixtures");
            return None;
        }
        let dir = std::env::temp_dir().join(format!("lean-converter-parity-{}", std::process::id()));
        let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/converter/testdata/telemetryFixtures.js");
        let out = Command::new("node").arg(script).arg(&dir).output().expect("run node");
        assert!(out.status.success(), "telemetryFixtures.js failed: {}", String::from_utf8_lossy(&out.stderr));
        Some(dir)
    })
    .as_ref()
}

/// Numbers as f64 and absent keys dropped, so 12 == 12.0 and undefined == missing.
pub fn norm(v: Value) -> Value {
    match v {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(a) => Value::Array(a.into_iter().map(norm).collect()),
        Value::Object(o) => Value::Object(o.into_iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k, norm(v))).collect()),
        other => other,
    }
}

fn read_json(p: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
}

#[test]
fn timeline_and_writers_match_node() {
    let Some(dir) = fixtures() else { return };
    let index = read_json(&dir.join("cases.json"));
    let codecs: Vec<String> = index["codecs"].as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_string()).collect();
    let mut checked = 0;
    for case in index["cases"].as_array().unwrap() {
        let name = case.as_str().unwrap();
        let source = std::fs::read(dir.join(format!("{name}.mp4"))).unwrap();
        let t = extract(&source).unwrap_or_else(|e| panic!("{name}: {e}"));
        let samples: Vec<Value> = t
            .samples
            .iter()
            .map(|s| {
                json!({
                    "ptsUs": s.pts_us, "durationUs": s.duration_us, "hasTelemetry": s.has_telemetry,
                    "fingerprints": s.sei_nals.iter().map(|r| r.fingerprint.clone()).collect::<Vec<_>>(),
                    "nals": s.sei_nals.iter().map(|r| super::tesla_sei::hex(&r.nal)).collect::<Vec<_>>(),
                })
            })
            .collect();
        let timing = source_timing_for(Some(&t.lead_in), Some(&t.undecodable));
        let rust = json!({
            "timescale": t.timescale,
            "lengthSize": t.length_size,
            "samples": samples,
            "events": t.events.len(),
            "leadIn": serde_json::to_value(&t.lead_in).unwrap(),
            "undecodable": serde_json::to_value(&t.undecodable).unwrap(),
            "sourceTiming": timing.map(|(ts, d)| json!({ "timescale": ts, "durationTicks": d })),
            "hold": hold_frames(Some(&t.lead_in)),
        });
        let node = read_json(&dir.join(format!("{name}.json")));
        assert_eq!(norm(rust), norm(node), "{name}: timeline");

        for codec in &codecs {
            let c = if codec == "h265" { Codec::H265 } else { Codec::Av1 };
            let enc = std::fs::read(dir.join(format!("{name}.{codec}.enc"))).unwrap();
            let mine = telemetry_bytes(&enc, &t, c);
            let err = dir.join(format!("{name}.{codec}.err"));
            if err.exists() {
                let code = std::fs::read_to_string(&err).unwrap();
                assert_eq!(mine.as_ref().err().map(|e| e.code.clone()), Some(code), "{name} {codec}: refused the same way");
            } else {
                let out = std::fs::read(dir.join(format!("{name}.{codec}.out"))).unwrap();
                let mine = mine.unwrap_or_else(|e| panic!("{name} {codec}: {e}"));
                assert!(mine == out, "{name} {codec}: output bytes differ from Node's ({} vs {})", mine.len(), out.len());
                let inspected = match c {
                    Codec::H265 => serde_json::to_value(super::h265::inspect(&mine).unwrap()).unwrap(),
                    Codec::Av1 => serde_json::to_value(super::av1::inspect(&mine)).unwrap(),
                };
                assert_eq!(norm(inspected), norm(read_json(&dir.join(format!("{name}.{codec}.inspect.json")))), "{name} {codec}: inspection");
                checked += 1;
            }
            // the raw encode, without telemetry
            let raw = match c {
                Codec::H265 => match super::h265::inspect(&enc) {
                    Ok(i) => serde_json::to_value(i).unwrap(),
                    Err(e) => json!({ "error": e.code_or("NO_CODE") }),
                },
                Codec::Av1 => serde_json::to_value(super::av1::inspect(&enc)).unwrap(),
            };
            assert_eq!(norm(raw), norm(read_json(&dir.join(format!("{name}.{codec}.raw-inspect.json")))), "{name} {codec}: raw inspection");
        }
    }
    eprintln!("telemetry parity: {checked} outputs byte-identical to Node's");
}
