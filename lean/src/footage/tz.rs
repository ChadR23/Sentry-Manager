//! Time zones as JavaScript's Intl reads them: IANA names in any letter case
//! and offsets (+01:00, -0530, +02). Used for a vehicle's time zone
//! (vehicles.js validTimezone), the policy's "today" (policies.js dayInZone)
//! and the end of a day in the car's time (index.js zonedToUtc).

use chrono::{Datelike, FixedOffset, Offset, TimeZone, Timelike, Utc};
use chrono_tz::Tz;

#[derive(Debug, Clone, Copy)]
pub enum Zone {
    Named(Tz),
    Fixed(FixedOffset),
}

fn offset(s: &str) -> Option<FixedOffset> {
    let (sign, rest) = match s.as_bytes().first()? {
        b'+' => (1, &s[1..]),
        b'-' => (-1, &s[1..]),
        _ => return None,
    };
    let digits = rest.replace(':', "");
    if !digits.bytes().all(|b| b.is_ascii_digit()) || rest.matches(':').count() > 1 || (rest.contains(':') && rest.find(':') != Some(2)) {
        return None;
    }
    let (h, m) = match digits.len() {
        2 => (digits.parse::<i32>().ok()?, 0),
        4 => (digits[0..2].parse::<i32>().ok()?, digits[2..4].parse::<i32>().ok()?),
        _ => return None,
    };
    if h > 23 || m > 59 {
        return None;
    }
    FixedOffset::east_opt(sign * (h * 3600 + m * 60))
}

/// The zone of a name, or None where Intl.DateTimeFormat throws.
pub fn zone(name: &str) -> Option<Zone> {
    if let Some(o) = offset(name) {
        return Some(Zone::Fixed(o));
    }
    if name.is_empty() || name.trim() != name {
        return None;
    }
    name.parse::<Tz>().ok().or_else(|| Tz::from_str_insensitive(name).ok()).map(Zone::Named)
}

pub fn valid(name: &str) -> bool {
    zone(name).is_some()
}

/// (y, m, d, h, mi, s) of a moment in the zone.
fn parts(ms: f64, z: Zone) -> (i32, u32, u32, u32, u32, u32) {
    let t = Utc.timestamp_millis_opt(ms as i64).single().unwrap_or_default();
    match z {
        Zone::Named(tz) => {
            let l = t.with_timezone(&tz);
            (l.year(), l.month(), l.day(), l.hour(), l.minute(), l.second())
        }
        Zone::Fixed(o) => {
            let l = t.with_timezone(&o);
            (l.year(), l.month(), l.day(), l.hour(), l.minute(), l.second())
        }
    }
}

/// policies.js dayInZone: "YYYY-MM-DD" of `ms` in the zone (UTC for an unknown one).
pub fn day_in_zone(ms: f64, name: &str) -> String {
    let z = zone(name).unwrap_or(Zone::Fixed(Utc.fix()));
    let (y, m, d, ..) = parts(ms, z);
    format!("{y:04}-{m:02}-{d:02}")
}

fn utc_ms(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> f64 {
    let date = chrono::NaiveDate::from_ymd_opt(y, mo, 1).map(|f| f + chrono::Duration::days(d as i64 - 1));
    date.map_or(f64::NAN, |dt| (dt.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp() * 1000 + (h as i64 * 3600 + mi as i64 * 60 + s as i64) * 1000) as f64)
}

/// index.js zonedToUtc: the UTC ms of a wall-clock time in the zone (offset 0 for an unknown one).
pub fn zoned_to_utc(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32, name: &str) -> f64 {
    let z = zone(name);
    let offset_at = |ms: f64| -> f64 {
        let Some(z) = z else { return 0.0 };
        let (py, pm, pd, ph, pmi, ps) = parts(ms, z);
        utc_ms(py, pm, pd, ph, pmi, ps) - ms
    };
    let guess = utc_ms(y, mo, d, h, mi, s);
    let first = guess - offset_at(guess);
    guess - offset_at(first)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zones_as_intl_reads_them() {
        for ok in ["utc", "europe/berlin", "+01:00", "GMT", "EST", "Etc/GMT+1", "UTC", "-0530", "+02"] {
            assert!(valid(ok), "{ok}");
        }
        for bad in ["Foo/Bar", "UTC+1", " UTC", "", "+1:00", "+25:00"] {
            assert!(!valid(bad), "{bad}");
        }
        // 2025-03-01 23:30 UTC is already the 2nd in Berlin
        let ms = utc_ms(2025, 3, 1, 23, 30, 0);
        assert_eq!(day_in_zone(ms, "Europe/Berlin"), "2025-03-02");
        assert_eq!(day_in_zone(ms, "UTC"), "2025-03-01");
        // the end of 2025-07-01 in Berlin (summer time, +2)
        assert_eq!(zoned_to_utc(2025, 7, 1, 23, 59, 59, "Europe/Berlin"), utc_ms(2025, 7, 1, 21, 59, 59));
    }
}
