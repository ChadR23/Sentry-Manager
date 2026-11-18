//! The CAN index answers as the Node code does: lean/parity/canFixtures.js
//! makes CAN Bridge logs (both formats, broken ones, an internal GPS bus, a
//! VIN, a legacy Model S, the bridge's own test file), indexes them with
//! server/canIndex.js and stores its files and answers. The Rust index reads
//! the same logs: every index file must be the same (unpacked), and every
//! answer the same JSON, before and after a log is taken out again.

use sentry_lean::can::format;
use sentry_lean::can::index::CanIndex;
use sentry_lean::can::json::{self, n};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// The first place two JSON values differ, or None.
pub fn diff(a: &Value, b: &Value, at: &str) -> Option<String> {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            let kx: Vec<&String> = json::ordered_keys(x);
            let ky: Vec<&String> = json::ordered_keys(y);
            if kx != ky {
                return Some(format!("{}: keys node {:?} / lean {:?}", at, kx.iter().take(12).collect::<Vec<_>>(), ky.iter().take(12).collect::<Vec<_>>()));
            }
            for k in kx {
                if let Some(d) = diff(&x[k], &y[k], &format!("{}.{}", at, k)) {
                    return Some(d);
                }
            }
            None
        }
        (Value::Array(x), Value::Array(y)) => {
            for i in 0..x.len().min(y.len()) {
                if let Some(d) = diff(&x[i], &y[i], &format!("{}[{}]", at, i)) {
                    return Some(d);
                }
            }
            (x.len() != y.len()).then(|| format!("{}: node {} items / lean {}", at, x.len(), y.len()))
        }
        _ => {
            let (sa, sb) = (json::stringify(a), json::stringify(b));
            (sa != sb).then(|| format!("{}: node {} / lean {}", at, &sa[..sa.len().min(200)], &sb[..sb.len().min(200)]))
        }
    }
}

fn pts(v: &[(f64, f64)]) -> Value {
    Value::Array(v.iter().map(|p| json!([n(p.0), n(p.1)])).collect())
}

fn clip(idx: &CanIndex, keys: &[&str], a: f64, b: f64, names: Option<&[&str]>, step: f64, drop: bool, changing: bool) -> Value {
    let keys: Vec<String> = keys.iter().map(|s| s.to_string()).collect();
    let set: Option<HashSet<String>> = names.map(|n| n.iter().map(|s| s.to_string()).collect());
    let mut ch = Vec::new();
    let (series, trust) = idx.clip_data(&keys, a, b, set.as_ref(), step, drop, if changing { Some(&mut ch) } else { None });
    let mut o = Map::new();
    o.insert("series".into(), Value::Object(series.iter().map(|(k, v)| (k.clone(), pts(v))).collect()));
    o.insert("trust".into(), trust.map(Value::String).unwrap_or(Value::Null));
    if changing {
        o.insert("changing".into(), json!(ch));
    }
    Value::Object(o)
}

fn reads(idx: &CanIndex, t: f64, dir: &Path) -> Value {
    let keys = ["CAR1", "LEGACY", "K2", "K3"];
    let s = idx.status();
    let mut o = Map::new();
    o.insert("status".into(), json!({ "indexed": s.indexed, "pending": s.pending, "running": s.running }));
    o.insert("minuteTimes".into(), Value::Object(keys.iter().map(|k| (k.to_string(), Value::Array(idx.minute_times(k, f64::NEG_INFINITY, f64::INFINITY).into_iter().map(n).collect()))).collect()));
    o.insert("signals".into(), Value::Object(keys.iter().map(|k| (k.to_string(), Value::Object(idx.signals(&[k.to_string()])))).collect()));
    let windows = [(t - 2000.0, t + 70_000.0), (t + 50_000.0, t + 130_000.0), (t + 205_000.0, t + 280_000.0), (t + 300_000.0, t + 390_000.0)];
    let mut clips = Vec::new();
    for (a, b) in windows {
        clips.push(clip(idx, &["CAR1"], a, b, Some(&["DI_vehicleSpeed", "IBST_driverBrakeApply", "GPSLatitude04F", "UI_cpuTemperature_353", "nope"]), 0.0, false, false));
        clips.push(clip(idx, &["CAR1"], a, b, None, 250.0, true, true));
        clips.push(clip(idx, &["CAR1"], a, b, None, 1000.0, false, false));
    }
    clips.push(clip(idx, &["CAR1", "LEGACY"], t, t + 40_000.0, Some(&["DI_vehicleSpeed", "DI_vehicleSpeed_116", "DI_gear"]), 0.0, false, false));
    let k2 = sentry_lean::can::tz::utc_ms(2026, 11, 8, 0, 58, 0) as f64;
    clips.push(clip(idx, &["K2"], k2, k2 + 120_000.0, None, 0.0, false, false));
    o.insert("clips".into(), Value::Array(clips));
    let mut raw = Vec::new();
    for (a, b) in windows {
        raw.push(Value::Array(idx.raw(&["CAR1".into()], a, b)));
    }
    raw.push(Value::Array(idx.raw(&["K2".into(), "K3".into()], k2, k2 + 120_000.0)));
    o.insert("raw".into(), Value::Array(raw));
    let sum = |v: Vec<sentry_lean::can::index::IdSum>| -> Value {
        Value::Array(v.into_iter().map(|e| json!({ "key": e.key, "bus": e.bus, "id": e.id, "name": e.name, "frames": n(e.frames), "hz": n(e.hz), "firstSeen": n(e.first_seen), "lastSeen": n(e.last_seen), "minutes": e.minutes })).collect())
    };
    o.insert("idSummary".into(), Value::Object(keys.iter().map(|k| (k.to_string(), sum(idx.id_summary(k, f64::NEG_INFINITY, f64::INFINITY, &|| false)))).collect()));
    o.insert("idSummaryRange".into(), sum(idx.id_summary("CAR1", t + 60_000.0, t + 180_000.0, &|| false)));
    let mut ni = Vec::new();
    for (k, since) in [("CAR1", t), ("CAR1", t + 180_000.0), ("K2", 0.0), ("LEGACY", t + 3_600_000.0)] {
        ni.push(idx.new_ids(k, since, 1000, &|| false).unwrap());
    }
    o.insert("newIds".into(), Value::Array(ni));
    let names: Vec<Value> = ["can0:257", "can1:257", "can1:04F", "can3:04F", "can0:6E3", "can0:2B4", "can0:116"]
        .iter()
        .map(|id| {
            let b: indexmap::IndexMap<String, String> = [("can0".to_string(), "VehicleBus".to_string()), ("can3".to_string(), "x".to_string())].into_iter().collect();
            json!([idx.message_name(id, None, &[], "tesla-3y"), idx.message_name(id, Some(&b), &["can3".to_string()], "tesla-3y"), idx.message_name(id, None, &[], "tesla-sx-legacy")])
        })
        .collect();
    o.insert("names".into(), Value::Array(names));
    let mut heads = Map::new();
    for k in keys {
        for m in idx.minute_times(k, f64::NEG_INFINITY, f64::INFINITY) {
            let h = format::read_head(&dir.join(k).join(format!("{}.json.gz", sentry_lean::can::index::minute_key(m))));
            heads.insert(format!("{}/{}", k, json::num_str(m)), h.map(Value::Object).unwrap_or(Value::Null));
        }
    }
    o.insert("heads".into(), Value::Object(heads));
    o.insert(
        "cars".into(),
        Value::Object(
            keys.iter()
                .map(|k| {
                    let c = idx.car_of(k).map(|mut c| {
                        c.as_object_mut().unwrap().insert("seenAt".into(), json!(0));
                        c
                    });
                    (k.to_string(), c.unwrap_or(Value::Null))
                })
                .collect(),
        ),
    );
    Value::Object(o)
}

fn files(dir: &Path, rel: &str, out: &mut Vec<(String, PathBuf)>) {
    let mut names: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap()).collect();
    names.sort_by_key(|e| e.file_name());
    for e in names {
        let r = format!("{}{}", rel, e.file_name().to_string_lossy());
        if e.file_type().unwrap().is_dir() {
            files(&e.path(), &format!("{}/", r), out);
        } else {
            out.push((r, e.path()));
        }
    }
}

fn same_files(node: &Path, lean: &Path) -> Vec<String> {
    let mut a = Vec::new();
    let mut b = Vec::new();
    files(node, "", &mut a);
    files(lean, "", &mut b);
    let mut out = Vec::new();
    let na: Vec<&String> = a.iter().map(|x| &x.0).collect();
    let nb: Vec<&String> = b.iter().map(|x| &x.0).collect();
    if na != nb {
        out.push(format!("files: node {:?}\n lean {:?}", na, nb));
        return out;
    }
    for ((r, pa), (_, pb)) in a.iter().zip(&b) {
        let read = |p: &Path| {
            let b = std::fs::read(p).unwrap();
            if r.ends_with(".gz") { format::gunzip(&b).unwrap() } else { b }
        };
        let (ta, tb) = (read(pa), read(pb));
        if ta != tb {
            let (va, vb) = (serde_json::from_slice::<Value>(&ta), serde_json::from_slice::<Value>(&tb));
            if r.ends_with("car.json") {
                let (mut va, mut vb) = (va.as_ref().unwrap().clone(), vb.as_ref().unwrap().clone());
                va["seenAt"] = json!(0);
                vb["seenAt"] = json!(0);
                if va == vb {
                    continue;
                }
            }
            let d = match (va, vb) {
                (Ok(va), Ok(vb)) => diff(&va, &vb, r).unwrap_or_else(|| format!("{}: same JSON, other bytes", r)),
                _ => format!("{}: differs", r),
            };
            out.push(d);
        }
    }
    out
}

#[test]
fn can_index_matches_node() {
    if Command::new("xz").arg("--version").output().is_err() || Command::new("node").arg("--version").output().is_err() {
        eprintln!("skipped: needs xz and node");
        return;
    }
    let work = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("can-parity");
    let st = Command::new("node").arg(repo().join("lean/parity/canFixtures.js")).arg(&work).status().unwrap();
    assert!(st.success(), "canFixtures.js failed");
    let answers: Value = serde_json::from_slice(&std::fs::read(work.join("answers.json")).unwrap()).unwrap();
    let t = answers["T"].as_f64().unwrap();
    let lean = work.join("lean");
    let _ = std::fs::remove_dir_all(&lean);
    let mut idx = CanIndex::new(work.join("can"), lean.clone());
    idx.profile_of = Box::new(|_, k| if k == "LEGACY" { "tesla-sx-legacy".into() } else { "tesla-3y".into() });
    let idx = Arc::new(idx);
    idx.kick_and_wait();
    let mut p1 = reads(&idx, t, &lean);
    p1.as_object_mut().unwrap().insert("lastError".into(), idx.status().last_error.map(Value::String).unwrap_or(Value::Null));
    let mut problems = Vec::new();
    if let Some(d) = diff(&answers["phase1"], &p1, "phase1") {
        problems.push(d);
    }
    problems.extend(same_files(&work.join("node-1"), &lean));
    let car1 = answers["car1"][0].as_str().unwrap();
    let removed = idx.remove_log("CAR1", car1);
    idx.repack(&|| false);
    let mut p2 = reads(&idx, t, &lean);
    let mut m = Map::new();
    m.insert("removed".into(), json!(removed));
    for (k, v) in p2.as_object_mut().unwrap().iter() {
        m.insert(k.clone(), v.clone());
    }
    p2 = Value::Object(m);
    if let Some(d) = diff(&answers["phase2"], &p2, "phase2") {
        problems.push(d);
    }
    problems.extend(same_files(&work.join("node-2"), &lean));
    assert!(problems.is_empty(), "differences:\n{}", problems.join("\n"));
}
