//! src/main/converter/contracts.js: profiles, size rules, verify modes,
//! device ids and lanes.

pub struct Profile {
    pub savings: f64,
    pub tolerance: f64,
}

pub const CUSTOM_PROFILE_ID: &str = "custom";
pub const QUALITY_PROFILE_ID: &str = "quality";
pub const QUALITY_LEVELS: [&str; 3] = ["high", "balanced", "small"];
pub const VERIFY_MODES: [&str; 3] = ["off", "quick", "full"];
pub const DEFAULT_VERIFY_MODE: &str = "quick";
pub const CUSTOM_BITRATE_KBPS_MIN: i64 = 250;
pub const CUSTOM_BITRATE_KBPS_MAX: i64 = 100_000;
pub const CONCURRENCY_MIN: i64 = 1;
pub const CONCURRENCY_MAX: i64 = 64;
pub const CONCURRENCY_FALLBACK: i64 = 1;
pub const CONCURRENCY_RECOMMENDED: i64 = 5;
pub const GROUPS: [&str; 3] = ["RecentClips", "SavedClips", "SentryClips"];
pub const TIMING_PHASES: [&str; 11] = ["inspect", "source", "timeline", "encode", "metadata", "checkWait", "picture", "verify", "saveWait", "save", "cleanup"];

pub fn profile(name: &str) -> Option<Profile> {
    match name {
        "conservative" => Some(Profile { savings: 0.05, tolerance: 0.02 }),
        "balanced" => Some(Profile { savings: 0.20, tolerance: 0.02 }),
        "aggressive" => Some(Profile { savings: 0.50, tolerance: 0.02 }),
        _ => None,
    }
}

pub fn has_size_target(profile_id: &str) -> bool {
    profile_id != CUSTOM_PROFILE_ID && profile_id != QUALITY_PROFILE_ID
}

/// Math.round as JS does it (half up, toward +infinity).
pub fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// targetOutputBytes (profile must exist)
pub fn target_output_bytes(source_bytes: u64, profile_id: &str) -> f64 {
    js_round(source_bytes as f64 * (1.0 - profile(profile_id).unwrap().savings))
}

/// isWithinProfile: only too big fails.
pub fn is_within_profile(source_bytes: u64, output_bytes: u64, profile_id: &str) -> bool {
    let p = profile(profile_id).unwrap();
    let target = target_output_bytes(source_bytes, profile_id);
    output_bytes as f64 <= target + source_bytes as f64 * p.tolerance
}

pub fn is_valid_verify_mode(m: &str) -> bool {
    VERIFY_MODES.contains(&m)
}

/// effectiveVerifyMode(config): replacing originals never runs with verification off.
pub fn effective_verify_mode(verify_mode: Option<&str>, output_mode: Option<&str>) -> &'static str {
    let mode = match verify_mode {
        Some("off") => "off",
        Some("quick") => "quick",
        Some("full") => "full",
        _ => "full",
    };
    if output_mode == Some("replace") && mode == "off" {
        "quick"
    } else {
        mode
    }
}

fn pci(s: &str) -> bool {
    // pci:[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]
    let b = s.as_bytes();
    if b.len() != 16 || !s.starts_with("pci:") {
        return false;
    }
    let hex = |r: std::ops::Range<usize>| b[r].iter().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(c));
    hex(4..8) && b[8] == b':' && hex(9..11) && b[11] == b':' && hex(12..14) && b[14] == b'.' && (b'0'..=b'7').contains(&b[15])
}

pub fn is_local_device_id(s: &str) -> bool {
    s == "cpu" || pci(s)
}

fn node_key(s: &str) -> bool {
    s.len() == 17 && s.starts_with("node:") && s[5..].bytes().all(|c| c.is_ascii_digit() || c.is_ascii_lowercase())
}

/// DEVICE_ID
pub fn is_device_id(s: &str) -> bool {
    if is_local_device_id(s) {
        return true;
    }
    match s.split_once('@') {
        None => node_key(s),
        Some((k, d)) => node_key(k) && is_local_device_id(d),
    }
}

/// nodeKeyOf: 'node:<id>' for any lane on a node, else None
pub fn node_key_of(id: &str) -> Option<&str> {
    let k = id.split_once('@').map(|(k, _)| k).unwrap_or(id);
    if node_key(k) && (id.len() == k.len() || id.len() > k.len() + 1) {
        Some(k)
    } else {
        None
    }
}

/// nodeDeviceOf
pub fn node_device_of(id: &str) -> Option<&str> {
    node_key_of(id)?;
    let (_, d) = id.split_once('@')?;
    if is_local_device_id(d) {
        Some(d)
    } else {
        None
    }
}

pub const LANES_MAX_ENTRIES: usize = 16;

fn lanes_error() -> super::error::CError {
    super::error::CError::code("INVALID_LANES")
}

/// normalizeLanes: None when there are no lanes; otherwise the lanes without
/// the devices set to 0. INVALID_LANES on anything else.
pub fn normalize_lanes(value: &serde_json::Value) -> Result<Option<serde_json::Value>, super::error::CError> {
    use serde_json::{Map, Value};
    if value.is_null() {
        return Ok(None);
    }
    let Some(list) = value.as_array() else { return Err(lanes_error()) };
    if list.is_empty() || list.len() > LANES_MAX_ENTRIES {
        return Err(lanes_error());
    }
    let mut seen = std::collections::HashSet::new();
    let mut lanes = Vec::new();
    for entry in list {
        let Some(m) = entry.as_object() else { return Err(lanes_error()) };
        if m.len() != 2 || !m.contains_key("device") || !m.contains_key("concurrency") {
            return Err(lanes_error());
        }
        let Some(device) = m["device"].as_str() else { return Err(lanes_error()) };
        if !is_device_id(device) || seen.contains(device) {
            return Err(lanes_error());
        }
        let c = super::jobstore::normalize::safe_int_of(&m["concurrency"]);
        let Some(c) = c.filter(|c| *c >= 0 && *c <= CONCURRENCY_MAX) else { return Err(lanes_error()) };
        seen.insert(device.to_string());
        if c > 0 {
            let mut lane = Map::new();
            lane.insert("device".into(), Value::from(device));
            lane.insert("concurrency".into(), Value::from(c));
            lanes.push(Value::Object(lane));
        }
    }
    let lanes = Value::Array(lanes);
    let total = lanes_total(&lanes);
    if lanes.as_array().unwrap().is_empty() || total < CONCURRENCY_MIN || total > CONCURRENCY_MAX {
        return Err(lanes_error());
    }
    Ok(Some(lanes))
}

pub fn lanes_total(lanes: &serde_json::Value) -> i64 {
    lanes.as_array().map(|a| a.iter().map(|l| l.get("concurrency").and_then(|c| c.as_f64()).unwrap_or(0.0) as i64).sum()).unwrap_or(0)
}

pub fn is_valid_concurrency(v: &serde_json::Value) -> bool {
    super::jobstore::normalize::safe_int_of(v).is_some_and(|c| (CONCURRENCY_MIN..=CONCURRENCY_MAX).contains(&c))
}

fn empty_group() -> serde_json::Value {
    serde_json::json!({ "files": 0, "sourceBytes": 0, "outputBytes": 0, "savedBytes": 0 })
}

/// createEmptyCounters
pub fn create_empty_counters() -> serde_json::Value {
    let mut groups = serde_json::Map::new();
    for g in GROUPS {
        groups.insert(g.into(), empty_group());
    }
    serde_json::json!({ "files": 0, "sourceVideoBytes": 0, "outputVideoBytes": 0, "savedBytes": 0, "copiedAssetBytes": 0, "groups": groups })
}

fn n(v: &serde_json::Value, k: &str) -> i64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0) as i64
}

/// addCompletedFile(counters, file)
pub fn add_completed_file(counters: &serde_json::Value, file: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    if file.get("state").and_then(Value::as_str) != Some("completed") {
        return counters.clone();
    }
    let source = n(file, "sourceBytes");
    let output = n(file, "outputBytes");
    let kind = file.get("kind").and_then(Value::as_str);
    let is_asset = kind == Some("asset") || file.get("eligibleVideo") == Some(&Value::Bool(false));
    if !is_asset && kind != Some("video") {
        return counters.clone();
    }
    let mut next = counters.clone();
    let add = |o: &mut Value, k: &str, d: i64| {
        let cur = n(o, k);
        o[k] = Value::from(cur + d);
    };
    if is_asset {
        add(&mut next, "copiedAssetBytes", output);
        return next;
    }
    let saved = source - output;
    add(&mut next, "files", 1);
    add(&mut next, "sourceVideoBytes", source);
    add(&mut next, "outputVideoBytes", output);
    add(&mut next, "savedBytes", saved);
    if let Some(g) = file.get("group").and_then(Value::as_str).filter(|g| GROUPS.contains(g)) {
        let current = counters.get("groups").and_then(|x| x.get(g)).cloned().unwrap_or_else(empty_group);
        next["groups"][g] = serde_json::json!({
            "files": n(&current, "files") + 1,
            "sourceBytes": n(&current, "sourceBytes") + source,
            "outputBytes": n(&current, "outputBytes") + output,
            "savedBytes": n(&current, "savedBytes") + saved,
        });
    }
    next
}

/// Number.prototype.toFixed(2) for a non-negative finite number: the nearest
/// multiple of 0.01, the larger one on an exact tie.
pub fn js_to_fixed2(x: f64) -> String {
    let exact = format!("{:.80}", x);
    let (int, frac) = exact.split_once('.').unwrap();
    let digits: Vec<u8> = int.bytes().chain(frac.bytes().take(2)).map(|b| b - b'0').collect();
    let rest = &frac[2..];
    let up = rest.as_bytes().first().is_some_and(|d| *d >= b'5');
    let mut digits = digits;
    if up {
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, 1);
                break;
            }
            i -= 1;
            if digits[i] == 9 {
                digits[i] = 0;
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
    let s: String = digits.iter().map(|d| (d + b'0') as char).collect();
    let (a, b) = s.split_at(s.len() - 2);
    let a = a.trim_start_matches('0');
    format!("{}.{}", if a.is_empty() { "0" } else { a }, b)
}

/// formatBytes (bytes must be non-negative and finite)
pub fn format_bytes(bytes: f64) -> String {
    let units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
    let mut value = bytes;
    let mut unit = 0;
    while value >= 1024.0 && unit < units.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    let rendered = if unit == 0 {
        format!("{}", js_round(value) as i64)
    } else {
        let f = js_to_fixed2(value);
        if let Some(stripped) = f.strip_suffix(".00") {
            stripped.to_string()
        } else if f.ends_with('0') {
            f[..f.len() - 1].to_string()
        } else {
            f
        }
    };
    format!("{} {}", rendered, units[unit])
}

/// serializeSummary(counters)
pub fn serialize_summary(c: &serde_json::Value) -> serde_json::Value {
    let saved = n(c, "savedBytes");
    serde_json::json!({
        "files": n(c, "files"),
        "sourceVideoBytes": n(c, "sourceVideoBytes"),
        "outputVideoBytes": n(c, "outputVideoBytes"),
        "savedBytes": saved,
        "copiedAssetBytes": n(c, "copiedAssetBytes"),
        "source": format_bytes(n(c, "sourceVideoBytes") as f64),
        "output": format_bytes(n(c, "outputVideoBytes") as f64),
        "saved": if saved < 0 { format!("-{}", format_bytes(-saved as f64)) } else { format_bytes(saved as f64) },
        "copiedAssets": format_bytes(n(c, "copiedAssetBytes") as f64),
        "groups": c.get("groups").cloned().unwrap_or(serde_json::Value::Null),
    })
}

/// addItemTimings(previous, phases)
pub fn add_item_timings(previous: Option<&serde_json::Value>, phases: &serde_json::Value) -> serde_json::Value {
    use super::jobstore::normalize::safe_int_of;
    let mut total = serde_json::Map::new();
    for phase in TIMING_PHASES {
        let raw = phases.get(phase).and_then(|v| v.as_f64()).filter(|f| f.is_finite()).unwrap_or(0.0);
        let added = js_round(raw).max(0.0) as i64;
        let prev = previous.and_then(|p| p.get("totalMs")).and_then(|t| t.get(phase)).and_then(safe_int_of).unwrap_or(0);
        total.insert(phase.into(), serde_json::Value::from(prev + added));
    }
    let files = previous.and_then(|p| p.get("files")).and_then(safe_int_of).unwrap_or(0) + 1;
    serde_json::json!({ "files": files, "totalMs": total })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_and_ids() {
        assert_eq!(target_output_bytes(1000, "balanced"), 800.0);
        assert!(is_within_profile(1000, 820, "balanced"));
        assert!(!is_within_profile(1000, 821, "balanced"));
        assert!(is_within_profile(1000, 1, "aggressive"));
        assert!(!has_size_target("custom") && !has_size_target("quality") && has_size_target("balanced"));
        assert_eq!(effective_verify_mode(Some("off"), Some("replace")), "quick");
        assert_eq!(effective_verify_mode(Some("off"), Some("separate")), "off");
        assert_eq!(effective_verify_mode(None, None), "full");
        assert!(is_device_id("cpu") && is_device_id("pci:0000:01:00.0") && is_device_id("node:abcdef012345") && is_device_id("node:abcdef012345@cpu"));
        assert!(!is_device_id("pci:0000:01:00.8") && !is_device_id("node:ABCDEF012345") && !is_device_id("node:abcdef012345@") && !is_device_id("gpu"));
        assert_eq!(node_key_of("node:abcdef012345@pci:0000:01:00.0"), Some("node:abcdef012345"));
        assert_eq!(node_key_of("cpu"), None);
        assert_eq!(node_device_of("node:abcdef012345@cpu"), Some("cpu"));
        assert_eq!(node_device_of("node:abcdef012345@x"), None);
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
    }

    #[test]
    fn bytes_and_lanes() {
        // (Node: formatBytes)
        assert_eq!(format_bytes(0.0), "0 B");
        assert_eq!(format_bytes(1023.0), "1023 B");
        assert_eq!(format_bytes(1024.0), "1 KiB");
        assert_eq!(format_bytes(1152.0), "1.13 KiB", "an exact tie rounds up as toFixed does");
        assert_eq!(format_bytes(1536.0), "1.5 KiB");
        assert_eq!(format_bytes(1048575.0), "1024 KiB");
        assert_eq!(format_bytes(5.0 * 1024.0 * 1024.0 * 1024.0 * 1024.0 * 1024.0 * 1024.0), "6144 PiB");
        let v = serde_json::json!([{ "device": "pci:0000:03:00.0", "concurrency": 3 }, { "device": "cpu", "concurrency": 0 }]);
        assert_eq!(normalize_lanes(&v).unwrap().unwrap(), serde_json::json!([{ "device": "pci:0000:03:00.0", "concurrency": 3 }]));
        for bad in [serde_json::json!([]), serde_json::json!([{ "device": "cpu", "concurrency": 0 }]), serde_json::json!([{ "device": "cpu", "concurrency": 1, "x": 1 }]), serde_json::json!([{ "device": "gpu", "concurrency": 1 }]), serde_json::json!([{ "device": "cpu", "concurrency": 1 }, { "device": "cpu", "concurrency": 1 }]), serde_json::json!([{ "device": "cpu", "concurrency": 65 }]), serde_json::json!({})] {
            assert_eq!(normalize_lanes(&bad).unwrap_err().code, "INVALID_LANES", "{bad}");
        }
        assert_eq!(normalize_lanes(&serde_json::Value::Null).unwrap(), None);
    }
}
