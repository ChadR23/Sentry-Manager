//! Vehicle names and ids against the Node code: server/vehicles.js
//! normalizeVehicle (the name kept) and slug (the id made from it), on the
//! same names; Node's answers are frozen in
//! tests/fixtures/node-reference/slug.json.

#[path = "support/reference.rs"]
mod reference;

use sentry_lean::app::{slug, vehicle_name};

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
    let places: [(&str, String); 0] = [];
    let input = serde_json::json!(NAMES);
    let want: Vec<(Option<String>, Option<String>)> = serde_json::from_value(reference::answer("slug", &places, &input)).unwrap();
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
