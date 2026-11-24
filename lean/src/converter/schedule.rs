//! Calendar schedules for automatic conversion: daily, weekly or monthly at an
//! hour of local time in a time zone. Pure maths; the caller decides what to run.

use crate::footage::tz::{parts, valid, zone, zoned_to_utc, Zone};
use chrono::{Datelike, NaiveDate};
use serde_json::{json, Map, Value};

const HOUR_MS: i64 = 3_600_000;
const STEP_MS: i64 = 15 * 60_000;

fn bad() -> String {
    "INVALID_AUTO_SCHEDULE".to_string()
}

fn int_in(m: &Map<String, Value>, key: &str, lo: i64, hi: i64) -> Result<i64, String> {
    let n = m.get(key).and_then(Value::as_i64).ok_or_else(bad)?;
    if (lo..=hi).contains(&n) {
        Ok(n)
    } else {
        Err(bad())
    }
}

/// The canonical schedule object, or INVALID_AUTO_SCHEDULE.
pub fn normalize(v: &Value) -> Result<Value, String> {
    let m = v.as_object().ok_or_else(bad)?;
    let kind = m.get("kind").and_then(Value::as_str).ok_or_else(bad)?;
    let (keys, extra): (usize, Option<(&str, i64, i64)>) = match kind {
        "daily" => (3, None),
        "weekly" => (4, Some(("weekday", 0, 6))),
        "monthly" => (4, Some(("day", 1, 28))),
        _ => return Err(bad()),
    };
    if m.len() != keys {
        return Err(bad());
    }
    let hour = int_in(m, "hour", 0, 23)?;
    let name = m.get("zone").and_then(Value::as_str).ok_or_else(bad)?;
    if !valid(name) {
        return Err(bad());
    }
    Ok(match extra {
        None => json!({"kind": kind, "hour": hour, "zone": name}),
        Some((k, lo, hi)) => {
            let n = int_in(m, k, lo, hi)?;
            json!({"kind": kind, k: n, "hour": hour, "zone": name})
        }
    })
}

/// The first instant at or after `hour:00` local on a date. A time that does not
/// exist (spring-forward gap) gives the end of the gap; a repeated one (fall back)
/// gives its first occurrence.
fn slot(date: NaiveDate, hour: u32, name: &str, z: Zone) -> i64 {
    let (y, mo, d) = (date.year(), date.month(), date.day());
    let guess = zoned_to_utc(y, mo, d, hour, 0, 0, name) as i64;
    let mut t = guess - 3 * HOUR_MS;
    for _ in 0..(6 * HOUR_MS / STEP_MS + 1) {
        let (py, pmo, pd, ph, ..) = parts(t as f64, z);
        if (py, pmo, pd, ph) >= (y, mo, d, hour) {
            return t;
        }
        t += STEP_MS;
    }
    guess
}

/// The first occurrence strictly after `after_ms`.
pub fn next_after(s: &Value, after_ms: i64) -> i64 {
    let name = s.get("zone").and_then(Value::as_str).unwrap_or("UTC");
    let z = zone(name).or_else(|| zone("UTC")).expect("UTC is a zone");
    let name = if zone(name).is_some() { name } else { "UTC" };
    let hour = s.get("hour").and_then(Value::as_i64).unwrap_or(0).clamp(0, 23) as u32;
    let kind = s.get("kind").and_then(Value::as_str).unwrap_or("daily");
    let n = s.get("weekday").or_else(|| s.get("day")).and_then(Value::as_i64).unwrap_or(0);
    let (y, mo, d, ..) = parts(after_ms as f64, z);
    let mut date = NaiveDate::from_ymd_opt(y, mo, d).unwrap_or_default() - chrono::Duration::days(1);
    for _ in 0..400 {
        let hit = match kind {
            "weekly" => date.weekday().num_days_from_sunday() as i64 == n,
            "monthly" => date.day() as i64 == n,
            _ => true,
        };
        if hit {
            let t = slot(date, hour, name, z);
            if t > after_ms {
                return t;
            }
        }
        date += chrono::Duration::days(1);
    }
    i64::MAX
}

/// True when a slot has come due since `last_ms`. Says nothing about how many.
pub fn missed(s: &Value, last_ms: i64, now_ms: i64) -> bool {
    next_after(s, last_ms) <= now_ms
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        NaiveDate::from_ymd_opt(y, mo, d).unwrap().and_hms_opt(h, mi, 0).unwrap().and_utc().timestamp() * 1000
    }

    #[test]
    fn daily_next() {
        let s = json!({"kind":"daily","hour":2,"zone":"America/New_York"});
        assert_eq!(next_after(&s, utc(2026, 11, 21, 7, 0)), utc(2026, 11, 22, 7, 0));
        assert_eq!(next_after(&s, utc(2026, 11, 21, 6, 59)), utc(2026, 11, 21, 7, 0));
    }

    #[test]
    fn daily_across_dst() {
        let s = json!({"kind":"daily","hour":2,"zone":"America/New_York"});
        assert_eq!(next_after(&s, utc(2026, 3, 7, 8, 0)), utc(2026, 3, 8, 7, 0));
    }

    #[test]
    fn fall_back_takes_first_occurrence() {
        // 01:00 on 2026-11-01 happens twice in New York; first is 05:00Z (EDT)
        let s = json!({"kind":"daily","hour":1,"zone":"America/New_York"});
        assert_eq!(next_after(&s, utc(2026, 10, 31, 12, 0)), utc(2026, 11, 1, 5, 0));
    }

    #[test]
    fn weekly_next() {
        let s = json!({"kind":"weekly","weekday":0,"hour":2,"zone":"UTC"});
        assert_eq!(next_after(&s, utc(2026, 11, 21, 12, 0)), utc(2026, 11, 22, 2, 0));
    }

    #[test]
    fn monthly_end() {
        let s = json!({"kind":"monthly","day":28,"hour":2,"zone":"UTC"});
        assert_eq!(next_after(&s, utc(2027, 2, 28, 3, 0)), utc(2027, 3, 28, 2, 0));
    }

    #[test]
    fn strictly_after() {
        let s = json!({"kind":"daily","hour":2,"zone":"UTC"});
        assert_eq!(next_after(&s, utc(2026, 5, 1, 2, 0)), utc(2026, 5, 2, 2, 0));
    }

    #[test]
    fn normalize_rejects() {
        for v in [
            json!({"kind":"monthly","day":29,"hour":2,"zone":"UTC"}),
            json!({"kind":"daily","hour":24,"zone":"UTC"}),
            json!({"kind":"weekly","weekday":7,"hour":2,"zone":"UTC"}),
            json!({"kind":"daily","hour":2,"zone":"Foo/Bar"}),
            json!({"kind":"daily","hour":2,"zone":"UTC","x":1}),
            json!({"kind":"hourly","hour":2,"zone":"UTC"}),
            json!({"kind":"daily","hour":2.0,"zone":"UTC"}),
        ] {
            assert_eq!(normalize(&v), Err("INVALID_AUTO_SCHEDULE".to_string()), "{v}");
        }
        let ok = json!({"kind":"weekly","weekday":0,"hour":2,"zone":"+05:00"});
        assert_eq!(normalize(&ok), Ok(ok.clone()));
    }

    #[test]
    fn missed_once() {
        let s = json!({"kind":"daily","hour":2,"zone":"UTC"});
        let now = utc(2026, 5, 10, 12, 0);
        assert!(missed(&s, now - 3 * 24 * HOUR_MS, now));
        assert!(!missed(&s, utc(2026, 5, 10, 3, 0), now));
    }
}
