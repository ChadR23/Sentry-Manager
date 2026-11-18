//! Clips the manager deleted for good, per car (a port of
//! server/deletedClips.js), so the archive check never calls a clip "Pi
//! missed" because the manager itself took it off the share. Kept in the
//! setting deleted-clips:<vehicle> as [[rel, deletedAt ms], ...]: only clips
//! named at most RECENT_DAYS before the delete, entries dropped KEEP_MS after
//! it, at most MAX_ENTRIES (the newest).

use super::mdb::ManagerDb;
use serde_json::{json, Value};

pub const KEEP_MS: f64 = 8.0 * 24.0 * 3600.0 * 1000.0;
pub const RECENT_DAYS: f64 = 9.0;
pub const MAX_ENTRIES: usize = 50_000;

fn key(vid: &str) -> String {
    format!("deleted-clips:{vid}")
}

/// The day of a Tesla clip name (YYYY-MM-DD_HH-MM-SS-<camera>.mp4), as Date.UTC ms.
fn clip_day_ms(rel: &str) -> Option<f64> {
    let name = rel.rsplit('/').next()?;
    let b = name.as_bytes();
    if b.len() < 25 || !name.ends_with(".mp4") || b[19] != b'-' {
        return None;
    }
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    if !(digits(0..4) && b[4] == b'-' && digits(5..7) && b[7] == b'-' && digits(8..10) && b[10] == b'_' && digits(11..13) && b[13] == b'-' && digits(14..16) && b[16] == b'-' && digits(17..19)) {
        return None;
    }
    let cam = &name[20..name.len() - 4];
    if cam.is_empty() || !cam.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
        return None;
    }
    let (y, m, d): (i64, i64, i64) = (name[0..4].parse().ok()?, name[5..7].parse().ok()?, name[8..10].parse().ok()?);
    // Date.UTC(y, m - 1, d): months and days roll over as JavaScript's do
    let (yy, mm) = (y + (m - 1).div_euclid(12), (m - 1).rem_euclid(12) + 1);
    let first = chrono::NaiveDate::from_ymd_opt(yy as i32, mm as u32, 1)?;
    let date = first + chrono::Duration::days(d - 1);
    Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis() as f64)
}

fn read(db: &ManagerDb, vid: &str) -> Vec<(String, f64)> {
    match db.get(&key(vid)) {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|e| {
                let e = e.as_array()?;
                Some((e.first()?.as_str()?.to_string(), e.get(1)?.as_f64().filter(|x| x.is_finite())?))
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn pruned(mut list: Vec<(String, f64)>, now: f64) -> Vec<(String, f64)> {
    let from = now - KEEP_MS;
    list.retain(|e| e.1 >= from);
    if list.len() > MAX_ENTRIES {
        list.sort_by(|a, b| a.1.total_cmp(&b.1));
        list = list.split_off(list.len() - MAX_ENTRIES);
    }
    list
}

fn write(db: &ManagerDb, vid: &str, list: &[(String, f64)]) {
    db.set(&key(vid), &Value::Array(list.iter().map(|(r, t)| json!([r, super::js::num(*t)])).collect()));
}

/// Clip rels deleted for good just now; how many were recorded.
pub fn add(db: &ManagerDb, vid: &str, rels: &[String], now: f64) -> usize {
    if vid.is_empty() {
        return 0;
    }
    let oldest = now - RECENT_DAYS * 86_400_000.0;
    let fresh: Vec<(String, f64)> = rels.iter().filter(|r| clip_day_ms(r).is_some_and(|d| d >= oldest - 86_400_000.0)).map(|r| (r.clone(), now)).collect();
    let before = read(db, vid);
    let n = before.len();
    let added = fresh.len();
    let next = pruned(before.into_iter().chain(fresh).collect(), now);
    if added > 0 || next.len() != n {
        write(db, vid, &next);
    }
    added
}

/// The rels deleted for good in the last KEEP_MS.
pub fn list(db: &ManagerDb, vid: &str, now: f64) -> Vec<String> {
    pruned(read(db, vid), now).into_iter().map(|e| e.0).collect()
}

pub fn forget(db: &ManagerDb, vid: &str) {
    db.set(&key(vid), &json!([]));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_clips_only_and_kept_eight_days() {
        let db = ManagerDb::memory();
        let now = chrono::NaiveDate::from_ymd_opt(2025, 3, 20).unwrap().and_hms_opt(12, 0, 0).unwrap().and_utc().timestamp_millis() as f64;
        let rels: Vec<String> = ["TeslaCam/RecentClips/2025-03-19_10-00-00-front.mp4", "TeslaCam/RecentClips/2025-03-01_10-00-00-front.mp4", "TeslaCam/SentryClips/x/event.json", "TeslaCam/RecentClips/2025-03-11_10-00-00-back.mp4", "TeslaCam/RecentClips/2025-03-10_10-00-00-back.mp4"]
            .iter().map(|s| s.to_string()).collect();
        // (the 11th is within 9 days and one more of the 20th at noon; the 10th and the 1st are not)
        assert_eq!(add(&db, "car", &rels, now), 2);
        assert_eq!(list(&db, "car", now).len(), 2);
        assert_eq!(list(&db, "car", now + KEEP_MS + 1.0).len(), 0);
        assert_eq!(add(&db, "car", &[], now + KEEP_MS + 1.0), 0);
        assert_eq!(db.get("deleted-clips:car").unwrap(), json!([]));
        forget(&db, "car");
        assert_eq!(add(&db, "", &rels, now), 0);
    }
}
