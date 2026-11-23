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
}
