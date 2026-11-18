//! What a file under the footage root is, from its path alone (a port of
//! server/footage.js): Tesla names clips YYYY-MM-DD_HH-MM-SS-<camera>.mp4
//! (car-local time), and Sentry / Saved events live in YYYY-MM-DD_HH-MM-SS
//! folders next to event.json / thumb.png.

use chrono::{Local, TimeZone};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Clip,
    Asset,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Clip => "clip",
            Kind::Asset => "asset",
        }
    }
}

/// RecentClips / SentryClips / SavedClips / Other
pub fn folder_type(dirs: &[&str]) -> &'static str {
    for d in dirs {
        match d.to_lowercase().as_str() {
            "recentclips" => return "RecentClips",
            "sentryclips" => return "SentryClips",
            "savedclips" => return "SavedClips",
            _ => {}
        }
    }
    "Other"
}

#[derive(Debug, Clone, PartialEq)]
pub struct Class {
    pub kind: Kind,
    pub typ: &'static str,
    pub day: Option<String>,
    pub camera: Option<String>,
    pub event_id: Option<String>,
}

fn digits(b: &[u8]) -> bool {
    b.iter().all(u8::is_ascii_digit)
}

/// "dddd-dd-dd"
fn day_shape(b: &[u8]) -> bool {
    b.len() == 10 && digits(&b[0..4]) && b[4] == b'-' && digits(&b[5..7]) && b[7] == b'-' && digits(&b[8..10])
}

/// "dddd-dd-dd_dd-dd-dd"
fn stamp_shape(b: &[u8]) -> bool {
    b.len() == 19 && day_shape(&b[0..10]) && b[10] == b'_' && digits(&b[11..13]) && b[13] == b'-' && digits(&b[14..16]) && b[16] == b'-' && digits(&b[17..19])
}

/// "YYYY-MM-DD" in shape (speedIndex.js DAY).
pub fn is_day_shape(day: &str) -> bool {
    day_shape(day.as_bytes())
}

/// A real calendar day from 2000 on.
pub fn is_valid_day(day: &str) -> bool {
    if !day_shape(day.as_bytes()) {
        return false;
    }
    let (y, m, d): (i32, u32, u32) = (day[0..4].parse().unwrap(), day[5..7].parse().unwrap(), day[8..10].parse().unwrap());
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || y < 2000 {
        return false;
    }
    chrono::NaiveDate::from_ymd_opt(y, m, d).is_some()
}

/// The first YYYY-MM-DD_HH-MM-SS in a name (inventory.js tsFrom).
pub fn ts_from(name: &str) -> Option<&str> {
    let b = name.as_bytes();
    (0..b.len().saturating_sub(18)).find(|&i| stamp_shape(&b[i..i + 19])).map(|i| &name[i..i + 19])
}

/// Seconds of a stamp read as UTC, with JavaScript Date.UTC's overflow (Feb 30 is Mar 2).
pub fn key_seconds(key: &str) -> i64 {
    let n = |a: usize, b: usize| key[a..b].parse::<i64>().unwrap();
    let (y, mo, d, h, mi, s) = (n(0, 4), n(5, 7), n(8, 10), n(11, 13), n(14, 16), n(17, 19));
    // (Date.UTC reads years 0..99 as 1900..1999)
    let y = if (0..=99).contains(&y) { y + 1900 } else { y };
    // months past 12 roll into years, days past the month's end roll forward
    let (y, mo) = (y + (mo - 1).div_euclid(12), (mo - 1).rem_euclid(12) + 1);
    let first = chrono::NaiveDate::from_ymd_opt(y as i32, mo as u32, 1).unwrap();
    let date = first + chrono::Duration::days(d - 1);
    date.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp() + h * 3600 + mi * 60 + s
}

pub fn should_skip_dir(name: &str) -> bool {
    if name.is_empty() || name.starts_with('.') || name.starts_with('@') {
        return true;
    }
    matches!(name.to_lowercase().as_str(), "#recycle" | "#snapshot" | "$recycle.bin" | "system volume information" | "lost+found")
}

/// Files the converter owns while it works: never listed.
pub fn is_converter_artifact(name: &str) -> bool {
    if name.starts_with("TEMP-H265-") || name.starts_with("TEMP-AV1-") || name.starts_with("BACKUP-") || name.starts_with(".sentry-owned-remove-") {
        return true;
    }
    if let Some(at) = name.find(".sentry-six-") {
        for end in [".partial", ".candidate", ".backup"] {
            if name.ends_with(end) && name.len() - end.len() >= at + ".sentry-six-".len() {
                return true;
            }
        }
    }
    false
}

/// A copy Sentry USB set aside: <clip>.mp4.mismatch-<time>.
pub fn is_sentry_usb_artifact(name: &str) -> bool {
    name.to_lowercase().contains(".mp4.mismatch-")
}

/// (day, camera) of a Tesla clip name, if it is one.
fn tesla_clip(name: &str) -> Option<(&str, &str)> {
    let b = name.as_bytes();
    if b.len() < 19 + 1 + 1 + 4 || !stamp_shape(&b[0..19]) || b[19] != b'-' {
        return None;
    }
    let rest = &name[20..];
    if !rest.is_char_boundary(rest.len() - 4) || !rest[rest.len() - 4..].eq_ignore_ascii_case(".mp4") {
        return None;
    }
    let camera = &rest[..rest.len() - 4];
    if camera.is_empty() || !camera.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
        return None;
    }
    Some((&name[0..10], camera))
}

/// Classify a path relative to the footage root; None for files to leave out.
pub fn classify(rel: &str) -> Option<Class> {
    let segments: Vec<&str> = rel.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
    let name = *segments.last()?;
    if name.starts_with('.') || is_sentry_usb_artifact(name) {
        return None;
    }
    let dirs = &segments[..segments.len() - 1];
    if dirs.iter().any(|d| d.starts_with('.')) {
        return None;
    }
    let typ = folder_type(dirs);
    let parent = dirs.last().copied().unwrap_or("");
    let event_id = (stamp_shape(parent.as_bytes()) && is_valid_day(&parent[0..10])).then(|| parent.to_string());

    if let Some((day, camera)) = tesla_clip(name) {
        if is_valid_day(day) {
            return Some(Class { kind: Kind::Clip, typ, day: Some(day.into()), camera: Some(camera.to_lowercase()), event_id });
        }
    }
    if let Some(ev) = &event_id {
        if typ != "Other" {
            return Some(Class { kind: Kind::Asset, typ, day: Some(ev[0..10].into()), camera: None, event_id });
        }
    }
    if !name.to_lowercase().ends_with(".mp4") || typ == "Other" {
        return None;
    }
    let date_dir = dirs.iter().rev().find(|d| day_shape(d.as_bytes()) && is_valid_day(d));
    Some(Class { kind: Kind::Clip, typ, day: date_dir.map(|d| d.to_string()), camera: None, event_id })
}

/// The local calendar day of a time in ms (footage.js localDay; TZ decides).
pub fn local_day(mtime_ms: f64) -> String {
    let ms = mtime_ms.trunc() as i64;
    match Local.timestamp_millis_opt(ms) {
        chrono::LocalResult::Single(t) | chrono::LocalResult::Ambiguous(t, _) => t.format("%Y-%m-%d").to_string(),
        chrono::LocalResult::None => "1970-01-01".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clips_assets_and_left_out() {
        let c = classify("TeslaCam/RecentClips/2025-03-01_08-00-00-FRONT.mp4").unwrap();
        assert_eq!((c.kind, c.typ, c.day.as_deref(), c.camera.as_deref()), (Kind::Clip, "RecentClips", Some("2025-03-01"), Some("front")));
        let e = classify("TeslaCam/SentryClips/2025-03-04_12-30-00/event.json").unwrap();
        assert_eq!((e.kind, e.event_id.as_deref(), e.day.as_deref()), (Kind::Asset, Some("2025-03-04_12-30-00"), Some("2025-03-04")));
        assert!(classify("TeslaCam/RecentClips/a.mp4.mismatch-1").is_none());
        assert!(classify("TeslaCam/.x/2025-03-01_08-00-00-front.mp4").is_none());
        assert!(classify("Other/foo.mp4").is_none());
        assert!(classify("notes.txt").is_none());
        let d = classify("TeslaCam/RecentClips/2025-03-04/dashcam.mp4").unwrap();
        assert_eq!((d.day.as_deref(), d.camera), (Some("2025-03-04"), None));
        assert!(is_converter_artifact("x.sentry-six-.partial") && is_converter_artifact("BACKUP-a.mp4") && !is_converter_artifact("a.sentry-six.partial"));
    }

    #[test]
    fn stamps_overflow_like_javascript() {
        assert_eq!(key_seconds("2025-02-30_10-00-00"), key_seconds("2025-03-02_10-00-00"));
        assert_eq!(ts_from("x 2025-03-01_08-00-00-front.mp4"), Some("2025-03-01_08-00-00"));
        assert!(!is_valid_day("2025-02-30") && is_valid_day("2024-02-29") && !is_valid_day("1999-01-01"));
    }
}
