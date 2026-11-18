//! Time zones as the Node server uses them through Intl: a car's wall clock
//! (its clip names) to UTC and back. Read from the system's zoneinfo files
//! (TZif, with the POSIX rule at their end for times after the last
//! transition). An unknown zone is UTC, as the Node code falls back to.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Debug, Clone, Copy)]
struct Rule {
    kind: u8, // b'M' (month.week.day), b'J' (Julian, no Feb 29), b'n' (zero-based day)
    month: i64,
    week: i64,
    day: i64,
    time: i64, // seconds after local midnight
}

#[derive(Debug, Clone)]
struct Posix {
    std_off: i64, // seconds east of UTC
    dst: Option<(i64, Rule, Rule)>,
}

#[derive(Debug, Default)]
pub struct Zone {
    times: Vec<i64>,
    idx: Vec<u8>,
    types: Vec<(i64, bool)>,
    footer: Option<Posix>,
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// (year, month, day) of days since 1970-01-01.
pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Date.UTC(y, mo - 1, d, h, mi, s) in ms (months and days may overflow, as in JS).
pub fn utc_ms(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64) -> i64 {
    let mo0 = mo - 1;
    let yy = y + mo0.div_euclid(12);
    let mm = mo0.rem_euclid(12) + 1;
    (days_from_civil(yy, mm, 1) + d - 1) * 86_400_000 + h * 3_600_000 + mi * 60_000 + s * 1000
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn rule_day(y: i64, r: &Rule) -> i64 {
    match r.kind {
        b'J' => {
            // 1..365, Feb 29 never counted
            let mut d = r.day - 1;
            if is_leap(y) && r.day >= 60 {
                d += 1;
            }
            days_from_civil(y, 1, 1) + d
        }
        b'n' => days_from_civil(y, 1, 1) + r.day,
        _ => {
            let first = days_from_civil(y, r.month, 1);
            let wd = (first + 4).rem_euclid(7); // 1970-01-01 was a Thursday
            let mut d = first + (r.day - wd).rem_euclid(7) + (r.week - 1) * 7;
            let dim = days_from_civil(if r.month == 12 { y + 1 } else { y }, if r.month == 12 { 1 } else { r.month + 1 }, 1) - first;
            while d - first >= dim {
                d -= 7;
            }
            d
        }
    }
}

struct P<'a> {
    s: &'a [u8],
    i: usize,
}

impl P<'_> {
    fn name(&mut self) -> Option<()> {
        if self.s.get(self.i) == Some(&b'<') {
            while self.i < self.s.len() && self.s[self.i] != b'>' {
                self.i += 1;
            }
            self.i += 1;
            return Some(());
        }
        let start = self.i;
        while self.i < self.s.len() && self.s[self.i].is_ascii_alphabetic() {
            self.i += 1;
        }
        (self.i > start).then_some(())
    }
    fn hms(&mut self) -> Option<i64> {
        let mut sign = 1;
        match self.s.get(self.i) {
            Some(b'+') => self.i += 1,
            Some(b'-') => {
                sign = -1;
                self.i += 1;
            }
            _ => {}
        }
        let mut parts = [0i64; 3];
        for (k, p) in parts.iter_mut().enumerate() {
            if k > 0 {
                if self.s.get(self.i) != Some(&b':') {
                    break;
                }
                self.i += 1;
            }
            let start = self.i;
            while self.i < self.s.len() && self.s[self.i].is_ascii_digit() {
                *p = *p * 10 + (self.s[self.i] - b'0') as i64;
                self.i += 1;
            }
            if self.i == start {
                return None;
            }
        }
        Some(sign * (parts[0] * 3600 + parts[1] * 60 + parts[2]))
    }
    fn int(&mut self) -> Option<i64> {
        let start = self.i;
        let mut v = 0;
        while self.i < self.s.len() && self.s[self.i].is_ascii_digit() {
            v = v * 10 + (self.s[self.i] - b'0') as i64;
            self.i += 1;
        }
        (self.i > start).then_some(v)
    }
    fn rule(&mut self) -> Option<Rule> {
        let mut r = Rule { kind: b'n', month: 0, week: 0, day: 0, time: 7200 };
        match self.s.get(self.i)? {
            b'M' => {
                self.i += 1;
                r.kind = b'M';
                r.month = self.int()?;
                self.i += 1;
                r.week = self.int()?;
                self.i += 1;
                r.day = self.int()?;
            }
            b'J' => {
                self.i += 1;
                r.kind = b'J';
                r.day = self.int()?;
            }
            _ => r.day = self.int()?,
        }
        if self.s.get(self.i) == Some(&b'/') {
            self.i += 1;
            r.time = self.hms()?;
        }
        Some(r)
    }
}

fn parse_posix(s: &str) -> Option<Posix> {
    let mut p = P { s: s.as_bytes(), i: 0 };
    p.name()?;
    let std_off = -p.hms()?;
    if p.i >= p.s.len() {
        return Some(Posix { std_off, dst: None });
    }
    p.name()?;
    let mut dst_off = std_off + 3600;
    if p.i < p.s.len() && p.s[p.i] != b',' {
        dst_off = -p.hms()?;
    }
    if p.s.get(p.i) != Some(&b',') {
        return Some(Posix { std_off, dst: None });
    }
    p.i += 1;
    let a = p.rule()?;
    if p.s.get(p.i) != Some(&b',') {
        return None;
    }
    p.i += 1;
    let b = p.rule()?;
    Some(Posix { std_off, dst: Some((dst_off, a, b)) })
}

impl Posix {
    fn offset(&self, t: i64) -> i64 {
        let Some((dst_off, a, b)) = self.dst else { return self.std_off };
        let y = civil_from_days((t + self.std_off).div_euclid(86_400)).0;
        for yy in [y - 1, y, y + 1] {
            let _ = yy;
        }
        let start = rule_day(y, &a) * 86_400 + a.time - self.std_off;
        let end = rule_day(y, &b) * 86_400 + b.time - dst_off;
        let in_dst = if start < end { t >= start && t < end } else { !(t >= end && t < start) };
        if in_dst { dst_off } else { self.std_off }
    }
}

fn be(b: &[u8], at: usize, n: usize) -> Option<i64> {
    let s = b.get(at..at + n)?;
    Some(match n {
        4 => i32::from_be_bytes(s.try_into().ok()?) as i64,
        8 => i64::from_be_bytes(s.try_into().ok()?),
        _ => return None,
    })
}

fn parse_tzif(b: &[u8]) -> Option<Zone> {
    if b.get(0..4)? != b"TZif" {
        return None;
    }
    let counts = |at: usize| -> Option<[usize; 6]> {
        let mut c = [0usize; 6];
        for (k, x) in c.iter_mut().enumerate() {
            *x = be(b, at + 20 + 4 * k, 4)? as usize;
        }
        Some(c)
    };
    let c1 = counts(0)?;
    let v1_len = c1[3] * 4 + c1[3] + c1[4] * 6 + c1[5] + c1[2] * 8 + c1[1] + c1[0];
    let (base, c, tsize) = if b[4] >= b'2' {
        let at = 44 + v1_len;
        (at, counts(at)?, 8)
    } else {
        (0, c1, 4)
    };
    let [isut, isstd, leap, timecnt, typecnt, charcnt] = c;
    let mut at = base + 44;
    let mut z = Zone::default();
    for k in 0..timecnt {
        z.times.push(be(b, at + k * tsize, tsize)?);
    }
    at += timecnt * tsize;
    z.idx.extend_from_slice(b.get(at..at + timecnt)?);
    at += timecnt;
    for k in 0..typecnt {
        let off = be(b, at + k * 6, 4)?;
        z.types.push((off, *b.get(at + k * 6 + 4)? != 0));
    }
    at += typecnt * 6 + charcnt + leap * (tsize + 4) + isstd + isut;
    if tsize == 8 {
        if let Some(rest) = b.get(at..) {
            let text = String::from_utf8_lossy(rest);
            let line = text.trim_start_matches('\n').split('\n').next().unwrap_or("");
            if !line.is_empty() {
                z.footer = parse_posix(line);
            }
        }
    }
    if z.types.is_empty() {
        return None;
    }
    Some(z)
}

impl Zone {
    /// Seconds east of UTC at a UTC time (seconds).
    pub fn offset(&self, t: i64) -> i64 {
        if self.times.is_empty() || t < self.times[0] {
            if self.times.is_empty() {
                if let Some(f) = &self.footer {
                    return f.offset(t);
                }
            }
            return self.types[0].0;
        }
        if t >= *self.times.last().unwrap() {
            if let Some(f) = &self.footer {
                return f.offset(t);
            }
        }
        let i = self.times.partition_point(|&x| x <= t) - 1;
        self.types.get(self.idx[i] as usize).map_or(0, |x| x.0)
    }
}

fn zones() -> &'static Mutex<HashMap<String, Option<Arc<Zone>>>> {
    static Z: OnceLock<Mutex<HashMap<String, Option<Arc<Zone>>>>> = OnceLock::new();
    Z.get_or_init(|| Mutex::new(HashMap::new()))
}

fn zone_dir() -> String {
    std::env::var("TZDIR").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/usr/share/zoneinfo".into())
}

/// The zone of an IANA name, or None (unknown: the callers use UTC).
pub fn zone(name: &str) -> Option<Arc<Zone>> {
    if name.is_empty() || name.len() > 64 || name.starts_with('/') || name.split('/').any(|p| p == ".." || p == "." || p.is_empty()) || !name.bytes().all(|c| c.is_ascii_alphanumeric() || b"/_+-".contains(&c)) {
        return None;
    }
    let mut m = zones().lock().unwrap();
    if let Some(z) = m.get(name) {
        return z.clone();
    }
    let z = std::fs::read(format!("{}/{}", zone_dir(), name)).ok().and_then(|b| parse_tzif(&b)).map(Arc::new);
    if m.len() > 256 {
        m.clear();
    }
    m.insert(name.to_string(), z.clone());
    z
}

/// Whether Intl would know the zone (an unknown one makes Intl throw).
pub fn known(name: &str) -> bool {
    zone(name).is_some()
}

/// The offset (ms) of a zone at a UTC time (0 for an unknown zone).
pub fn offset_ms(name: &str, ms: i64) -> i64 {
    zone(name).map_or(0, |z| z.offset(ms.div_euclid(1000)) * 1000)
}

/// The wall clock of a UTC time in a zone: (y, mo, d, h, mi, s) (seconds truncated, as Intl shows them).
pub fn parts(name: &str, ms: i64) -> (i64, i64, i64, i64, i64, i64) {
    let local = ms + offset_ms(name, ms);
    let secs = local.div_euclid(1000);
    let (y, mo, d) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    (y, mo, d, rem / 3600, rem % 3600 / 60, rem % 60)
}

/// index.js zonedToUtc: a wall-clock time in a zone to UTC ms.
pub fn zoned_to_utc(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64, name: &str) -> i64 {
    let offset_at = |ms: i64| -> i64 {
        if !known(name) {
            return 0;
        }
        let (py, pmo, pd, ph, pmi, ps) = parts(name, ms);
        utc_ms(py, pmo, pd, ph, pmi, ps) - ms
    };
    let guess = utc_ms(y, mo, d, h, mi, s);
    let first = guess - offset_at(guess);
    guess - offset_at(first)
}

/// new Date(ms).toISOString().
pub fn iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (y, mo, d) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    let yy = if (0..=9999).contains(&y) { format!("{:04}", y) } else if y < 0 { format!("-{:06}", -y) } else { format!("+{:06}", y) };
    format!("{}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", yy, mo, d, rem / 3600, rem % 3600 / 60, rem % 60, ms.rem_euclid(1000))
}

/// Date.parse of an ISO time with a zone ("2026-11-08T14:30:00Z", "...+01:00", ".123"), or None.
pub fn parse_iso(t: &str) -> Option<i64> {
    let b = t.as_bytes();
    let num = |a: usize, n: usize| -> Option<i64> { std::str::from_utf8(b.get(a..a + n)?).ok()?.parse().ok() };
    if b.len() < 16 || b[4] != b'-' || b[7] != b'-' || !(b[10] == b'T' || b[10] == b't') || b[13] != b':' {
        return None;
    }
    let (y, mo, d, h, mi) = (num(0, 4)?, num(5, 2)?, num(8, 2)?, num(11, 2)?, num(14, 2)?);
    let mut i = 16;
    let mut s = 0;
    let mut frac = 0;
    if b.get(i) == Some(&b':') {
        s = num(i + 1, 2)?;
        i += 3;
        if b.get(i) == Some(&b'.') {
            let start = i + 1;
            let mut j = start;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            let digits = std::str::from_utf8(&b[start..j]).ok()?;
            if digits.is_empty() {
                return None;
            }
            let ms3: String = digits.chars().chain("000".chars()).take(3).collect();
            frac = ms3.parse().ok()?;
            i = j;
        }
    }
    let rest = &t[i..];
    let off = if rest.eq_ignore_ascii_case("z") {
        0
    } else {
        let sign = match rest.as_bytes().first()? {
            b'+' => 1,
            b'-' => -1,
            _ => return None,
        };
        let r = &rest[1..];
        let (hh, mm) = if r.len() == 5 && r.as_bytes()[2] == b':' { (&r[0..2], &r[3..5]) } else if r.len() == 4 { (&r[0..2], &r[2..4]) } else { return None };
        sign * (hh.parse::<i64>().ok()? * 60 + mm.parse::<i64>().ok()?) * 60_000
    };
    if mo < 1 || mo > 12 || d < 1 || d > 31 || h > 24 || mi > 59 || s > 59 {
        return None;
    }
    Some(utc_ms(y, mo, d, h, mi, s) + frac - off)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zones_and_dst() {
        // Berlin: CET in winter, CEST in summer
        assert_eq!(zoned_to_utc(2026, 1, 15, 12, 0, 0, "Europe/Berlin"), utc_ms(2026, 1, 15, 11, 0, 0));
        assert_eq!(zoned_to_utc(2026, 7, 15, 12, 0, 0, "Europe/Berlin"), utc_ms(2026, 7, 15, 10, 0, 0));
        // far in the future: the POSIX rule
        assert_eq!(zoned_to_utc(2060, 7, 15, 12, 0, 0, "Europe/Berlin"), utc_ms(2060, 7, 15, 10, 0, 0));
        assert_eq!(zoned_to_utc(2026, 7, 15, 12, 0, 0, "America/Los_Angeles"), utc_ms(2026, 7, 15, 19, 0, 0));
        assert_eq!(zoned_to_utc(2026, 7, 15, 12, 0, 0, "Nope/Zone"), utc_ms(2026, 7, 15, 12, 0, 0));
        assert_eq!(parts("Australia/Sydney", utc_ms(2026, 1, 1, 0, 0, 0)), (2026, 1, 1, 11, 0, 0));
        assert_eq!(iso(utc_ms(2026, 11, 8, 14, 30, 0) + 5), "2026-11-08T14:30:00.005Z");
        assert_eq!(parse_iso("2026-11-08T14:30:00+01:00"), Some(utc_ms(2026, 11, 8, 13, 30, 0)));
        assert_eq!(parse_iso("2026-11-08T14:30Z"), Some(utc_ms(2026, 11, 8, 14, 30, 0)));
    }
}
