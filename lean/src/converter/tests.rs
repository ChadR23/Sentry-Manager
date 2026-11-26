//! Parity with the Node converter on real encodes, frozen in
//! tests/fixtures/node-reference/converter-telemetry.tar.xz: Tesla-like
//! originals (keyframe first, lead-in, frame_num gaps, no keyframe), encoded
//! with the converter's arguments, and what the Node code read and wrote
//! (made by testdata/telemetryFixtures.js and verifierFixtures.js over
//! src/main/converter before it was removed). The Rust timeline must read
//! the same, and the Rust writer must produce the same bytes (or refuse with
//! the same code).
//!
//! The verifier needs ffprobe (skipped with a note without it). Set
//! LEAN_CONVERTER_FIXTURES=<dir> to use another unpacked copy.

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
        Some(crate::reference::unpack("converter-telemetry", "fixtures"))
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
            let Ok(enc) = std::fs::read(dir.join(format!("{name}.{codec}.enc"))) else { continue };
            let mine = telemetry_bytes(&enc, &t, c);
            let err = dir.join(format!("{name}.{codec}.err"));
            if err.exists() {
                let code = std::fs::read_to_string(&err).unwrap();
                // The frozen no-keyframe HEVC encode has no video track.
                // It remains refused, now explicitly as an empty encoder output.
                let expected = if name == "nokey" && codec == "h265" {
                    assert_eq!(code, "UNSUPPORTED_CONTAINER");
                    let tree = super::mp4w::parse(&enc).unwrap();
                    assert!(tree.find(super::mp4w::ROOT, b"trak").is_empty());
                    "ENCODED_NO_VIDEO_SAMPLES".into()
                } else { code };
                assert_eq!(mine.as_ref().err().map(|e| e.code.clone()), Some(expected), "{name} {codec}: refusal");
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

/// (frozen from testdata/verifierFixtures.js) the Node verifier's verdict on good,
/// raw (no telemetry), truncated and tampered candidates, Quick and Full,
/// with and without a size profile. The Rust verifier must decide the same,
/// reason and details included.
#[test]
fn verifier_matches_node() {
    if !have("ffprobe", "-version") {
        eprintln!("skipped: the verifier needs ffprobe");
        return;
    }
    let Some(dir) = fixtures() else { return };
    let vdir = dir.join("verify");
    let runner = super::process::BoundedRunner { timeout_ms: 120_000, max_output_bytes: 4 * 1024 * 1024, ..Default::default() };
    let snaps = std::env::temp_dir().join(format!("lean-verifier-parity-{}", std::process::id()));
    std::fs::create_dir_all(&snaps).unwrap();
    let registry = super::snapshot::Registry::new(snaps.clone());
    let list = read_json(&vdir.join("list.json"));
    let mut n = 0;
    for e in list.as_array().unwrap() {
        let s = |k: &str| e[k].as_str().unwrap().to_string();
        let o = super::verifier::VerifyOptions {
            source: dir.join(s("source")),
            candidate: vdir.join(s("candidate")),
            codec: if s("codec") == "h265" { Codec::H265 } else { Codec::Av1 },
            profile_id: s("profileId"),
            verify_mode: Some(s("mode")),
            keep_off_target: false,
            allow_larger: false,
            trusted_snapshot: false,
            adopt_candidate: false,
            decode_accel: vec![],
            source_duration_us: None,
            source_timeline: None,
            ffprobe_path: "ffprobe".into(),
            ffmpeg_path: "ffmpeg".into(),
            run_ffprobe: &runner,
            run_full_decode: &runner,
            registry: &registry,
            on_decode_accel_fallback: None,
            cancel: None,
        };
        let v = super::verifier::verify_candidate(&o);
        if let Some(a) = &v.publication_artifact {
            assert!(Path::new(&a.path).exists() && a.path.starts_with(&*snaps.to_string_lossy()));
            let _ = std::process::Command::new("chmod").arg("-R").arg("u+w").arg(&snaps).status();
            let _ = std::fs::remove_dir_all(Path::new(&a.path).parent().unwrap());
        }
        let mut mine = v.to_json();
        mine.as_object_mut().unwrap().remove("publicationArtifact");
        let node = read_json(&vdir.join(s("file")));
        assert_eq!(norm(mine), norm(node), "{}", s("file"));
        n += 1;
    }
    let _ = std::fs::remove_dir_all(&snaps);
    eprintln!("verifier parity: {n} verdicts the same as Node's");
}
