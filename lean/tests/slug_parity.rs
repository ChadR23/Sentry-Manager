//! Vehicle names and ids against the Node code: server/vehicles.js
//! normalizeVehicle (the name kept) and slug (the id made from it), run by
//! node on the same names. Skipped (with a note) when node is not installed.

use sentry_lean::app::{slug, vehicle_name};
use serde_json::Value;
use std::path::Path;
use std::process::Command;

const NAMES: &[&str] = &[
    "Daily Driver",
    "My car",
    "Café",
    "Ölçü Ğüzel",
    "Renée's Model Y",
    "Škoda Enyaq",
    "Åsa & Øyvind",
    "straße",
    "Æon",
    "ﬁne ﬂow",
    "Ⅸ Roman",
    "ℌilbert",
    "Ｆｕｌｌ ｗｉｄｔｈ",
    "x²",
    "İstanbul",
    "ΣΊΣΥΦΟΣ",
    "Москва",
    "東京",
    "🚗 Tesla 🚗",
    "",
    "   ",
    "\u{feff} bom \u{3000}",
    "\u{85}nel\u{85}",
    "  spaced   out  ",
    "---dashes---",
    "a_b.c/d",
    "0123456789012345678901234567890123456789tail",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbb",
    "ééééééééééééééééééééééééééééééééééééééééééé",
    "a very long vehicle name that goes on and on and on past sixty characters for sure",
    "ﾊﾝｶｸ",
    "Ǆemal",
];

#[test]
fn vehicle_ids_match_node() {
    if !Command::new("node").arg("--version").output().is_ok_and(|o| o.status.success()) {
        eprintln!("skipped: node is needed");
        return;
    }
    let vehicles = Path::new(env!("CARGO_MANIFEST_DIR")).join("../server/vehicles.js");
    let script = r#"
const { slug, normalizeVehicle } = require(process.argv[1]);
const names = JSON.parse(require('fs').readFileSync(0, 'utf8'));
console.log(JSON.stringify(names.map((raw) => {
  let name = null;
  try { name = normalizeVehicle({ name: raw || 'My car', timezone: 'UTC', source: { type: 'path', path: '/footage' } }).name; } catch {}
  return [name, name === null ? null : slug(name)];
})));
"#;
    let mut child = Command::new("node")
        .args(["-e", script, vehicles.to_str().unwrap()])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("node");
    use std::io::Write;
    child.stdin.take().unwrap().write_all(serde_json::to_string(NAMES).unwrap().as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "node failed");
    let want: Vec<(Option<String>, Option<String>)> = serde_json::from_slice::<Value>(&out.stdout)
        .map(|v| serde_json::from_value(v).unwrap())
        .unwrap();
    let mut bad = Vec::new();
    for (raw, w) in NAMES.iter().zip(want) {
        // (VEHICLE_NAME empty: "My car", as both servers read the environment)
        let name = vehicle_name(if raw.is_empty() { "My car" } else { raw });
        let got = (name.clone(), name.as_deref().map(slug));
        if got != w {
            bad.push(format!("{raw:?}: node {w:?} / lean {got:?}"));
        }
    }
    assert!(bad.is_empty(), "{} difference(s):\n{}", bad.len(), bad.join("\n"));
}
