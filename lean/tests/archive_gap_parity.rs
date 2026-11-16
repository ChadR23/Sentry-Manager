//! Parity of the archive gap check with Node (lean/parity/archiveGap.js;
//! needs node): every analyze() call Node's own tests make (test/archiveGap,
//! carFiles, deletedClips, sentryUsb, snapshotGaps: CAN Bridge driving and
//! Sentry minutes, wrong time zones, cut-off drives, partial minutes, late
//! clips, Sentry USB's transfer, its missed snapshots and its list of what the
//! car wrote, the Recycle Bin and deleted clips, other time zones) is given to
//! the Rust analyze() too, and the answers must be Node's: every day, the
//! stalled share, the signals and the car-files pass, field for field.

use sentry_lean::can::sentry_usb::{CarClip, CarFiles};
use sentry_lean::footage::Kind;
use sentry_lean::scanner::FileEntry;
use sentry_lean::viewer::archive_gap::{analyze, CarFilesIn, Input, Pi, Snaps};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

fn node_available() -> bool {
    Command::new("node").arg("--version").output().is_ok_and(|o| o.status.success())
}

fn leak(s: &str) -> &'static str {
    Box::leak(s.to_string().into_boxed_str())
}

fn f(v: &Value) -> f64 {
    v.as_f64().unwrap_or(f64::NAN)
}

fn opt(v: &Value) -> Option<f64> {
    v.as_f64()
}

fn input_of(i: &Value) -> (Arc<HashMap<String, FileEntry>>, Input<'static>) {
    let mut files = HashMap::new();
    for x in i["files"].as_array().unwrap() {
        let rel = x["rel"].as_str().unwrap().to_string();
        files.insert(
            rel.clone(),
            FileEntry {
                rel,
                size: x["size"].as_f64().unwrap_or(0.0) as u64,
                mtime_ms: f(&x["mtimeMs"]),
                ctime_ms: f(&x["ctimeMs"]),
                birthtime_ms: f(&x["birthtimeMs"]),
                kind: if x["kind"] == json!("clip") { Kind::Clip } else { Kind::Asset },
                typ: leak(x["type"].as_str().unwrap_or("")),
                day: x["day"].as_str().unwrap_or("").to_string(),
                camera: x["camera"].as_str().map(String::from),
                event_id: None,
            },
        );
    }
    let nums = |v: &Value| v.as_array().map(|a| a.iter().map(f).collect::<Vec<f64>>());
    let strings = |v: &Value| v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect::<Vec<String>>());
    let speeds: HashMap<String, Vec<Value>> = i["speeds"].as_array().unwrap().iter().map(|e| (e[0].as_str().unwrap().to_string(), e[1].as_array().cloned().unwrap_or_default())).collect();
    let pi = i["sentryUsb"].as_object().filter(|p| p.get("transferring") == Some(&json!(true))).map(|p| Pi { overdue: p.get("overdue") == Some(&json!(true)), first_s: p.get("firstS").and_then(Value::as_f64).unwrap_or(f64::NAN), last_s: p.get("lastS").and_then(Value::as_f64) });
    let snaps = i["snapshots"].as_object().map(|s| Snaps {
        interval_s: s.get("intervalS").and_then(Value::as_f64).unwrap_or(f64::NAN),
        gaps: s.get("gaps").and_then(Value::as_array).into_iter().flatten().map(|g| (f(&g["fromUnix"]), f(&g["toUnix"]), f(&g["seconds"]), opt(&g["lostToUnix"]))).collect(),
    });
    let car_files = i["carFiles"].as_object().map(|c| CarFilesIn {
        list: c.get("list").filter(|l| l.is_object()).map(|l| {
            let mut cf = CarFiles { first_seen_unix: opt(&l["firstSeenUnix"]), last_seen_unix: opt(&l["lastSeenUnix"]), ..Default::default() };
            for e in l["clips"].as_array().into_iter().flatten() {
                let p = e["path"].as_str().unwrap_or("").to_string();
                cf.clips.insert(
                    p.clone(),
                    CarClip { path: p, kind: leak(e["type"].as_str().unwrap_or("")), event: e["event"].as_str().map(String::from), name: e["name"].as_str().unwrap_or("").to_string(), size: f(&e["size"]), mtime_unix: f(&e["mtimeUnix"]), first_seen_unix: f(&e["firstSeenUnix"]), last_seen_unix: f(&e["lastSeenUnix"]) },
                );
            }
            Arc::new(cf)
        }),
        error: c.get("error").and_then(Value::as_str).map(String::from),
        file_unix: c.get("fileUnix").and_then(Value::as_f64).unwrap_or(f64::NAN),
        archived_unix: c.get("archivedUnix").and_then(Value::as_f64),
    });
    let input = Input {
        now_ms: f(&i["nowMs"]),
        tz: leak(i["tz"].as_str().unwrap_or("UTC")),
        encoded: strings(&i["encoded"]).unwrap_or_default().into_iter().collect::<HashSet<String>>(),
        speeds,
        can_driving: nums(&i["canDriving"]),
        can_sentry: nums(&i["canSentry"]).unwrap_or_default(),
        can_minutes: nums(&i["canMinutes"]),
        received_ms: i["receivedMs"].as_f64().unwrap_or(0.0),
        last_recent_s: opt(&i["lastRecentS"]),
        sentry_usb: pi,
        snapshots: snaps,
        clock24: i["clock24"] == json!(true),
        car_files,
        binned: strings(&i["binned"]),
        deleted: strings(&i["deleted"]),
    };
    (Arc::new(files), input)
}

#[test]
fn every_analysis_of_nodes_tests_answers_as_node() {
    if !node_available() {
        eprintln!("node not found: skipped");
        return;
    }
    let out = std::env::temp_dir().join(format!("lean-archive-gap-parity-{}.json", std::process::id()));
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("parity/archiveGap.js");
    let run = Command::new("node").arg(script).arg(&out).output().expect("run node");
    assert!(run.status.success(), "{}", String::from_utf8_lossy(&run.stderr));
    let calls: Vec<Value> = serde_json::from_slice(&std::fs::read(&out).unwrap()).unwrap();
    let _ = std::fs::remove_file(&out);
    assert!(calls.len() >= 70, "only {} calls", calls.len());
    let mut differ = Vec::new();
    for (n, c) in calls.iter().enumerate() {
        assert!(c.get("error").is_none(), "call {n}: {}", c["error"]);
        let (files, input) = input_of(&c["input"]);
        let res = analyze(&files, &input);
        let days: serde_json::Map<String, Value> = res.days.into_iter().collect();
        let got = json!({ "days": days, "stalled": res.stalled, "signals": res.signals, "carFiles": res.car_files, "newestRecent": res.newest_recent.map(sentry_lean::inventory::num) });
        for k in ["days", "stalled", "signals", "carFiles", "newestRecent"] {
            if got[k] != c["output"][k] {
                differ.push(format!("call {n} {k}:\n  node {}\n  rust {}", c["output"][k], got[k]));
            }
        }
    }
    assert!(differ.is_empty(), "{} of {} answers differ:\n{}", differ.len(), calls.len() * 5, differ.join("\n"));
}
