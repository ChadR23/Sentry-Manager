//! The `keepRecent` config field: shrink only footage older than `days`
//! days, counted on the calendar of `zone`.

use serde_json::Value;

pub const DAYS_MIN: i64 = 1;
pub const DAYS_MAX: i64 = 365;

/// True only for `{"days": int 1..=365, "zone": <IANA name>}` and nothing else.
pub fn valid(v: &Value) -> bool {
    let Some(m) = v.as_object() else { return false };
    m.len() == 2
        && m.get("days").and_then(Value::as_i64).is_some_and(|d| (DAYS_MIN..=DAYS_MAX).contains(&d))
        && m.get("zone").and_then(Value::as_str).is_some_and(crate::footage::tz::valid)
}

/// UTC ms of the local midnight that starts the oldest kept day: "last N days" is today plus the
/// N-1 calendar days before it, counted in `zone`.
pub fn cutoff_ms(days: i64, zone: &str, now_ms: i64) -> i64 {
    let today = crate::footage::tz::day_in_zone(now_ms as f64, zone);
    let n = |a: usize, z: usize| today[a..z].parse::<u32>().unwrap_or(1);
    let first = chrono::NaiveDate::from_ymd_opt(n(0, 4) as i32, n(5, 7), n(8, 10))
        .map(|d| d - chrono::Duration::days(days.max(1) - 1));
    use chrono::Datelike;
    first.map_or(f64::NAN, |d| crate::footage::tz::zoned_to_utc(d.year(), d.month(), d.day(), 0, 0, 0, zone)) as i64
}

/// True when the config keeps recent footage and this clip is inside the window. A clip whose
/// date cannot be read counts as inside: unknown dates are left alone.
pub fn is_young(config: &Value, d: &Value, now_ms: i64) -> bool {
    // Event metadata and thumbnails have no clip date and still accompany copies.
    if d["kind"] == "asset" { return false; }
    let Some(k) = config.get("keepRecent").filter(|k| valid(k)) else { return false };
    let (days, zone) = (k["days"].as_i64().unwrap_or(0), k["zone"].as_str().unwrap_or("UTC"));
    let t = d.get("timestampKey").and_then(Value::as_str).map_or(f64::NAN, |s| crate::viewer::recording_place::utc_of(s, zone));
    t.is_nan() || t >= cutoff_ms(days, zone, now_ms) as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn valid_accepts_days_and_zone() {
        assert!(valid(&json!({ "days": 30, "zone": "America/New_York" })));
        assert!(valid(&json!({ "days": 1, "zone": "UTC" })));
        assert!(valid(&json!({ "days": 365, "zone": "UTC" })));
    }

    #[test]
    fn valid_rejects_bad_shapes() {
        for bad in [
            json!({ "days": 0, "zone": "UTC" }),
            json!({ "days": 366, "zone": "UTC" }),
            json!({ "days": 30 }),
            json!({ "days": 30, "zone": "Mars/Base" }),
            json!({ "days": 30, "zone": "UTC", "x": 1 }),
            json!({ "days": "30", "zone": "UTC" }),
            json!({ "days": 30.5, "zone": "UTC" }),
            json!({ "days": 30, "zone": 5 }),
            json!("UTC"),
            Value::Null,
        ] {
            assert!(!valid(&bad), "{bad}");
        }
    }

    fn ms(y: i32, mo: u32, d: u32, h: u32) -> i64 {
        chrono::NaiveDate::from_ymd_opt(y, mo, d).unwrap().and_hms_opt(h, 0, 0).unwrap().and_utc().timestamp() * 1000
    }

    #[test]
    fn cutoff_is_local_midnight() {
        let now = ms(2026, 11, 21, 15);
        assert_eq!(cutoff_ms(1, "America/New_York", now), ms(2026, 11, 21, 5));
        assert_eq!(cutoff_ms(30, "America/New_York", now), ms(2026, 10, 23, 4));
        // 7 days back from Nov 3 reaches Oct 28 (EDT, UTC-4); 2 days back from Nov 2 is Nov 1 (the change day, midnight still EDT)
        assert_eq!(cutoff_ms(7, "America/New_York", ms(2026, 11, 3, 15)), ms(2026, 10, 28, 4));
        assert_eq!(cutoff_ms(2, "America/New_York", ms(2026, 11, 2, 15)), ms(2026, 11, 1, 4));
        assert_eq!(cutoff_ms(2, "America/New_York", ms(2026, 11, 3, 15)), ms(2026, 11, 2, 5));
    }

    #[test]
    fn assets_without_timestamps_remain_eligible_for_copying() {
        let c = json!({ "keepRecent": { "days": 30, "zone": "UTC" } });
        for name in ["event.json", "thumb.png"] {
            assert!(!is_young(&c, &json!({ "kind": "asset", "relativePath": name }), ms(2026, 11, 21, 12)));
        }
        assert!(is_young(&c, &json!({ "kind": "video" }), ms(2026, 11, 21, 12)));
    }
}
