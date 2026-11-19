//! TEMPORARY: records Node's answers into tests/fixtures/node-reference
//! (LEAN_RECORD_NODE=1, one test thread). Removed with Node.
#![allow(dead_code)]

use serde_json::{json, Value};
use std::path::Path;
use std::sync::Mutex;

pub fn recording() -> bool {
    std::env::var("LEAN_RECORD_NODE").is_ok()
}

static LOCK: Mutex<()> = Mutex::new(());

fn places_to(places: &[(&str, String)]) -> Vec<(String, String)> {
    let mut p: Vec<(String, String)> = places.iter().map(|(ph, a)| (a.clone(), ph.to_string())).collect();
    p.sort_by_key(|x| std::cmp::Reverse(x.0.len()));
    p
}

/// Stores Node's `output` for `input` in `<file>.json` (replacing a call with the same input).
pub fn record(file: &str, what: &str, places: &[(&str, String)], input: &Value, output: &Value) {
    let _g = LOCK.lock().unwrap();
    let p = super::reference::dir().join(format!("{file}.json"));
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    let mut doc: Value = std::fs::read(&p).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({ "recorded": what, "calls": [] }));
    doc["recorded"] = json!(what);
    let pl = places_to(places);
    let input = super::reference::subst(input, &pl);
    let output = super::reference::subst(output, &pl);
    let calls = doc["calls"].as_array_mut().unwrap();
    calls.retain(|c| c["input"] != input);
    calls.push(json!({ "input": input, "output": output }));
    std::fs::write(&p, serde_json::to_string(&doc).unwrap()).unwrap();
}

/// Packs `from` (its contents) as `node-reference/<name>.tar.xz`, file times to the nanosecond.
pub fn pack(name: &str, from: &Path) {
    let to = super::reference::dir().join(format!("{name}.tar.xz"));
    let st = std::process::Command::new("tar")
        .args(["--format=posix", "--sort=name", "--owner=0", "--group=0", "--numeric-owner", "-cJf"])
        .arg(&to)
        .arg("-C")
        .arg(from)
        .arg(".")
        .status()
        .unwrap();
    assert!(st.success());
}
