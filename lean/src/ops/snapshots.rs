//! Database snapshots (server/snapshots.js): once a day a consistent copy of
//! manager.db goes to data/snapshots/manager-YYYY-MM-DD.db (VACUUM INTO, safe
//! while the app runs); the newest 7 are kept. Restoring puts the chosen one
//! next to the database as manager.db.restore and restarts; at the next
//! start, before the database is opened, `apply_pending_restore` moves the
//! current one aside (manager.db.before-restore) and puts the snapshot in
//! its place.

use rusqlite::Connection;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

pub const KEEP: usize = 7;

fn snapshot_day(name: &str) -> Option<&str> {
    let day = name.strip_prefix("manager-")?.strip_suffix(".db")?;
    let b = day.as_bytes();
    let ok = b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    ok.then_some(day)
}

/// Before the database is opened: put a snapshot chosen for restoring in place.
/// Returns whether one was (the caller logs the warning line).
pub fn apply_pending_restore(db_file: &Path) -> std::io::Result<bool> {
    let pending = PathBuf::from(format!("{}.restore", db_file.display()));
    if !pending.exists() {
        return Ok(false);
    }
    for ext in ["", "-wal", "-shm"] {
        let _ = fs::rename(format!("{}{ext}", db_file.display()), format!("{}.before-restore{ext}", db_file.display()));
    }
    fs::rename(&pending, db_file)?;
    Ok(true)
}

/// The warning apply_pending_restore's caller logs.
pub fn restored_line(db_file: &Path) -> String {
    format!(
        "Database restored from a snapshot; the one it replaced is kept as {}.before-restore",
        db_file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    )
}

pub struct Snapshots {
    pub db_file: PathBuf,
    pub dir: PathBuf,
    pub keep: usize,
}

#[derive(Debug)]
pub struct NoSuchSnapshot;

impl Snapshots {
    pub fn new(data: &Path) -> Snapshots {
        Snapshots { db_file: data.join("manager.db"), dir: data.join("snapshots"), keep: KEEP }
    }

    /// Newest first: { name, day, bytes, at }.
    pub fn list(&self) -> Vec<Value> {
        let Ok(rd) = fs::read_dir(&self.dir) else { return Vec::new() };
        let mut names: Vec<String> = rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| snapshot_day(n).is_some()).collect();
        names.sort();
        names.reverse();
        names
            .into_iter()
            .map(|name| {
                let st = fs::metadata(self.dir.join(&name)).ok();
                let day = snapshot_day(&name).unwrap().to_string();
                let at = st.as_ref().map(mtime_ms);
                json!({ "name": name, "day": day, "bytes": st.map(|m| m.len()), "at": super::js::num_or_null(at) })
            })
            .collect()
    }

    /// Today's snapshot (UTC day, as toISOString), unless there is one already (or `force`).
    pub fn take(&self, db: &Connection, today: &str, force: bool) -> Result<Option<String>, String> {
        fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let name = format!("manager-{today}.db");
        let file = self.dir.join(&name);
        if file.exists() && !force {
            return Ok(None);
        }
        let tmp = self.dir.join(format!(".{name}.{}.tmp", std::process::id()));
        let _ = fs::remove_file(&tmp);
        let quoted = tmp.to_string_lossy().replace('\'', "''");
        db.execute_batch(&format!("VACUUM INTO '{quoted}'")).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
        for old in self.list().iter().skip(self.keep) {
            if let Some(n) = old["name"].as_str() {
                let _ = fs::remove_file(self.dir.join(n));
            }
        }
        Ok(Some(name))
    }

    /// Chooses a snapshot to restore at the next start.
    pub fn prepare_restore(&self, name: &str) -> Result<(), NoSuchSnapshot> {
        if snapshot_day(name).is_none() || !self.list().iter().any(|x| x["name"] == name) {
            return Err(NoSuchSnapshot);
        }
        let tmp = format!("{}.restore.tmp", self.db_file.display());
        fs::copy(self.dir.join(name), &tmp).map_err(|_| NoSuchSnapshot)?;
        fs::rename(&tmp, format!("{}.restore", self.db_file.display())).map_err(|_| NoSuchSnapshot)?;
        Ok(())
    }
}

/// fs.statSync().mtimeMs as Node works it out: sec * 1e3 + nsec / 1e6.
pub fn mtime_ms(m: &fs::Metadata) -> f64 {
    use std::os::unix::fs::MetadataExt;
    m.mtime() as f64 * 1e3 + m.mtime_nsec() as f64 / 1e6
}

/// The UTC day of a time, as new Date().toISOString().slice(0, 10).
pub fn utc_day(ms: i64) -> String {
    super::js::iso(ms)[..10].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ops::store;

    // test/snapshots.test.js
    #[test]
    fn a_snapshot_a_day_the_newest_7_kept_restore_at_next_start() {
        let dir = std::env::temp_dir().join(format!("lean-snap-{}-{}", std::process::id(), store::now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let db_file = dir.join("manager.db");
        let db = Connection::open(&db_file).unwrap();
        db.execute_batch("PRAGMA journal_mode = WAL;").unwrap();
        store::ensure_schema(&db).unwrap();
        store::set(&db, "marker", &json!("monday"));
        let snaps = Snapshots { db_file: db_file.clone(), dir: dir.join("snapshots"), keep: KEEP };
        assert_eq!(snaps.take(&db, "2026-11-01", false).unwrap().as_deref(), Some("manager-2026-11-01.db"));
        assert_eq!(snaps.take(&db, "2026-11-01", false).unwrap(), None, "once a day");
        for d in 2..=9 {
            store::set(&db, "marker", &json!(format!("day {d}")));
            snaps.take(&db, &format!("2026-11-0{d}"), false).unwrap();
        }
        let days: Vec<String> = snaps.list().iter().map(|x| x["day"].as_str().unwrap().to_string()).collect();
        assert_eq!(days, ["2026-11-09", "2026-11-08", "2026-11-07", "2026-11-06", "2026-11-05", "2026-11-04", "2026-11-03"]);
        store::set(&db, "marker", &json!("broken later"));
        assert!(snaps.prepare_restore("manager-2026-11-01.db").is_err(), "an old one that was pruned");
        assert!(snaps.prepare_restore("../manager.db").is_err());
        snaps.prepare_restore("manager-2026-11-05.db").unwrap();
        drop(db);
        assert!(apply_pending_restore(&db_file).unwrap());
        let db = Connection::open(&db_file).unwrap();
        assert_eq!(store::get(&db, "marker"), Some(json!("day 5")));
        assert!(PathBuf::from(format!("{}.before-restore", db_file.display())).exists());
        assert!(!apply_pending_restore(&db_file).unwrap(), "nothing pending");
        drop(db);
        fs::remove_dir_all(&dir).unwrap();
    }
}
