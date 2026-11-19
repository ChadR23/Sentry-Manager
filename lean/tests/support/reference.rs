//! Node's answers, frozen: the reference files under
//! `tests/fixtures/node-reference/`, recorded from the Node server and its
//! converter (`server/`, `src/main/converter`) before they were removed from
//! the repository (lean/PORT_PLAN.md, "Node removed"). The checks that used
//! to run the Node code now compare the Rust result with these files.
//!
//! Included by path from the integration tests and the unit tests
//! (`#[path = ".../tests/support/reference.rs"] mod reference;`): no item of
//! the crate itself.
//!
//! - `answer`: Node's answer to one question (a JSON input), looked up by
//!   that input in a reference file `{ "recorded": ..., "calls": [{ "input",
//!   "output" }] }`. The input must be the recorded one: a changed scenario
//!   has no answer and fails (it needs a new reference, never a silent pass).
//!   Paths that differ per run (a temporary folder) are kept as placeholders
//!   such as `{DIR}`.
//! - `unpack`: a recorded folder (`.tar.xz`, file times kept to the
//!   nanosecond) unpacked into a fresh temporary folder.
#![allow(dead_code)]

use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};

/// `lean/tests/fixtures/node-reference`.
pub fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/node-reference")
}

/// A reference file's bytes (`name`, or `name.gz` unpacked).
pub fn read(name: &str) -> Vec<u8> {
    let p = dir().join(name);
    if let Ok(b) = std::fs::read(&p) {
        return b;
    }
    let gz = dir().join(format!("{name}.gz"));
    let raw = std::fs::read(&gz).unwrap_or_else(|e| panic!("node reference {name}: {e}"));
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(&raw[..]).read_to_end(&mut out).unwrap();
    out
}

/// A reference file as JSON.
pub fn json(name: &str) -> Value {
    serde_json::from_slice(&read(name)).unwrap_or_else(|e| panic!("node reference {name}: {e}"))
}

/// Replaces every `from` with `to` in the strings (and keys) of `v`.
pub fn subst(v: &Value, pairs: &[(String, String)]) -> Value {
    let s = |t: &str| pairs.iter().fold(t.to_string(), |acc, (a, b)| if a.is_empty() { acc } else { acc.replace(a.as_str(), b.as_str()) });
    match v {
        Value::String(t) => Value::String(s(t)),
        Value::Array(a) => Value::Array(a.iter().map(|x| subst(x, pairs)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (s(k), subst(x, pairs))).collect()),
        other => other.clone(),
    }
}

/// (this run's value -> placeholder), longer values first, so a folder
/// inside another is replaced as itself.
fn to_placeholders(places: &[(&str, String)]) -> Vec<(String, String)> {
    let mut p: Vec<(String, String)> = places.iter().map(|(ph, a)| (a.clone(), ph.to_string())).collect();
    p.sort_by_key(|x| std::cmp::Reverse(x.0.len()));
    p
}

fn from_placeholders(places: &[(&str, String)]) -> Vec<(String, String)> {
    let mut p: Vec<(String, String)> = places.iter().map(|(ph, a)| (ph.to_string(), a.clone())).collect();
    p.sort_by_key(|x| std::cmp::Reverse(x.0.len()));
    p
}

/// Node's answer to `input`, from `<file>.json` (or `.json.gz`); `places`
/// are this run's values of the reference's placeholders.
pub fn answer(file: &str, places: &[(&str, String)], input: &Value) -> Value {
    let doc = json(&format!("{file}.json"));
    let asked = subst(input, &to_placeholders(places));
    let calls = doc["calls"].as_array().unwrap_or_else(|| panic!("node reference {file}: no calls"));
    let call = calls.iter().find(|c| c["input"] == asked).unwrap_or_else(|| {
        let near = calls.iter().map(|c| first_difference(&c["input"], &asked, "input")).min_by_key(|d| std::cmp::Reverse(d.len())).unwrap_or_default();
        panic!("node reference {file}: nothing was recorded for this input ({} recorded; one differs at {near})", calls.len())
    });
    subst(&call["output"], &from_placeholders(places))
}

/// Where two values first differ, as a path (for messages).
pub fn first_difference(a: &Value, b: &Value, at: &str) -> String {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for (k, v) in x {
                match y.get(k) {
                    Some(w) if w == v => {}
                    Some(w) => return first_difference(v, w, &format!("{at}.{k}")),
                    None => return format!("{at}.{k} (missing)"),
                }
            }
            y.keys().find(|k| !x.contains_key(*k)).map(|k| format!("{at}.{k} (extra)")).unwrap_or_else(|| at.to_string())
        }
        (Value::Array(x), Value::Array(y)) => {
            for (i, (v, w)) in x.iter().zip(y).enumerate() {
                if v != w {
                    return first_difference(v, w, &format!("{at}[{i}]"));
                }
            }
            format!("{at} ({} vs {} entries)", x.len(), y.len())
        }
        _ => format!("{at}: {} vs {}", short(a), short(b)),
    }
}

fn short(v: &Value) -> String {
    v.to_string().chars().take(120).collect()
}

/// The files under `dir` (relative path -> text, or `{ "base64": ... }` for
/// bytes that are not UTF-8), in name order; `null` when `dir` is missing.
pub fn snapshot(dir: &Path) -> Value {
    fn walk(base: &Path, d: &Path, out: &mut serde_json::Map<String, Value>) {
        let mut entries: Vec<_> = std::fs::read_dir(d).map(|r| r.flatten().collect()).unwrap_or_default();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let p = e.path();
            let ft = e.file_type().unwrap();
            if ft.is_dir() {
                walk(base, &p, out);
            } else if ft.is_file() {
                let rel = p.strip_prefix(base).unwrap().to_string_lossy().into_owned();
                let b = std::fs::read(&p).unwrap();
                let v = match String::from_utf8(b) {
                    Ok(t) => Value::String(t),
                    Err(e) => {
                        use base64::Engine;
                        json!({ "base64": base64::engine::general_purpose::STANDARD.encode(e.as_bytes()) })
                    }
                };
                out.insert(rel, v);
            }
        }
    }
    if !dir.is_dir() {
        return Value::Null;
    }
    let mut out = serde_json::Map::new();
    walk(dir, dir, &mut out);
    Value::Object(out)
}

/// Makes `dir` hold exactly the files of `snap` (a `snapshot`).
pub fn restore(dir: &Path, snap: &Value) {
    let Some(files) = snap.as_object() else { return };
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).unwrap();
    for (rel, v) in files {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let bytes = match v {
            Value::String(t) => t.clone().into_bytes(),
            other => {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD.decode(other["base64"].as_str().unwrap()).unwrap()
            }
        };
        std::fs::write(&p, bytes).unwrap();
    }
}

/// The SHA-256 of each file under `dir` (relative path -> hex), or `null`.
pub fn digests(dir: &Path) -> Value {
    use sha2::{Digest, Sha256};
    let snap = snapshot(dir);
    let Some(files) = snap.as_object() else { return Value::Null };
    Value::Object(files.iter().map(|(k, v)| (k.clone(), json!(format!("{:x}", Sha256::digest(v.to_string().as_bytes()))))).collect())
}

/// Unpacks `node-reference/<name>.tar.xz` (file times kept) into a new
/// folder `<tmp>/lean-ref-<name>-<tag>-<pid>` and returns it.
pub fn unpack(name: &str, tag: &str) -> PathBuf {
    let to = std::env::temp_dir().join(format!("lean-ref-{name}-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&to);
    std::fs::create_dir_all(&to).unwrap();
    let archive = dir().join(format!("{name}.tar.xz"));
    let st = std::process::Command::new("tar").arg("-xJf").arg(&archive).arg("-C").arg(&to).status().expect("tar (with xz) is needed");
    assert!(st.success(), "unpacking {}", archive.display());
    std::fs::canonicalize(&to).unwrap()
}
