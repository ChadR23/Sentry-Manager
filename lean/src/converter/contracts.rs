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
}
