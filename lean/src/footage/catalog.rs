//! The footage catalog in SQLite (WAL): every file of the last scan, the
//! folders' modified times (for light rescans), each clip's codec and the
//! speed index. Only the manager's own data folder is written; the footage
//! is only ever listed and read.

use crate::footage::Kind;
use crate::scanner::{FileEntry, Previous, ScanResult};
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

pub struct Catalog {
    db: Mutex<Connection>,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS files (
  vehicle TEXT NOT NULL, rel TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, ctime_ms REAL NOT NULL,
  kind TEXT NOT NULL, type TEXT NOT NULL, day TEXT NOT NULL, camera TEXT, event_id TEXT,
  PRIMARY KEY (vehicle, rel)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS files_day ON files (vehicle, day);
CREATE TABLE IF NOT EXISTS dirs (vehicle TEXT NOT NULL, rel TEXT NOT NULL, mtime_ms REAL NOT NULL, PRIMARY KEY (vehicle, rel)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS codecs (vehicle TEXT NOT NULL, rel TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, codec TEXT,
  PRIMARY KEY (vehicle, rel)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS speeds (vehicle TEXT NOT NULL, rel TEXT NOT NULL, day TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL,
  speeds TEXT, summary TEXT, PRIMARY KEY (vehicle, rel)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS speeds_day ON speeds (vehicle, day);
";

pub type CodecMap = HashMap<String, (u64, f64, Option<String>)>;

/// A front-camera clip for the speed index.
pub struct Front {
    pub day: String,
    pub rel: String,
    pub size: u64,
    pub mtime: i64,
}

fn type_of(s: &str) -> &'static str {
    match s {
        "RecentClips" => "RecentClips",
        "SentryClips" => "SentryClips",
        "SavedClips" => "SavedClips",
        _ => "Other",
    }
}

impl Catalog {
    pub fn open(path: &Path) -> rusqlite::Result<Catalog> {
        let db = Connection::open(path)?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "NORMAL")?;
        // a small page cache: the catalog is read in a few big queries
        db.pragma_update(None, "cache_size", -2000)?;
        db.execute_batch(SCHEMA)?;
        Ok(Catalog { db: Mutex::new(db) })
    }

    /// What the last scan of a vehicle found, for a light rescan and for start-up.
    pub fn previous(&self, vehicle: &str) -> rusqlite::Result<Previous> {
        let db = self.db.lock().unwrap();
        let mut prev = Previous::default();
        let mut q = db.prepare("SELECT rel, size, mtime_ms, ctime_ms, kind, type, day, camera, event_id FROM files WHERE vehicle = ?1")?;
        let rows = q.query_map([vehicle], |r| {
            Ok(FileEntry {
                rel: r.get(0)?,
                size: r.get::<_, i64>(1)? as u64,
                mtime_ms: r.get(2)?,
                ctime_ms: r.get(3)?,
                kind: if r.get::<_, String>(4)? == "clip" { Kind::Clip } else { Kind::Asset },
                typ: type_of(&r.get::<_, String>(5)?),
                day: r.get(6)?,
                camera: r.get(7)?,
                event_id: r.get(8)?,
            })
        })?;
        for f in rows {
            let f = f?;
            prev.files.insert(f.rel.clone(), f);
        }
        let mut q = db.prepare("SELECT rel, mtime_ms FROM dirs WHERE vehicle = ?1")?;
        for d in q.query_map([vehicle], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))? {
            let (rel, m) = d?;
            prev.dirs.insert(rel, m);
        }
        Ok(prev)
    }

    /// Replace a vehicle's files and folders with a scan's.
    pub fn save_scan(&self, vehicle: &str, scan: &ScanResult) -> rusqlite::Result<()> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        tx.execute("DELETE FROM files WHERE vehicle = ?1", [vehicle])?;
        tx.execute("DELETE FROM dirs WHERE vehicle = ?1", [vehicle])?;
        {
            let mut ins = tx.prepare("INSERT INTO files VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)")?;
            for f in &scan.files {
                ins.execute(params![vehicle, f.rel, f.size as i64, f.mtime_ms, f.ctime_ms, f.kind.as_str(), f.typ, f.day, f.camera, f.event_id])?;
            }
            let mut ins = tx.prepare("INSERT INTO dirs VALUES (?1, ?2, ?3)")?;
            for (rel, m) in &scan.dirs {
                ins.execute(params![vehicle, rel, m])?;
            }
        }
        tx.commit()
    }

    /// The clip codecs read so far: rel -> (size, mtime, codec).
    pub fn codecs(&self, vehicle: &str) -> rusqlite::Result<CodecMap> {
        let db = self.db.lock().unwrap();
        let mut q = db.prepare("SELECT rel, size, mtime_ms, codec FROM codecs WHERE vehicle = ?1")?;
        let rows = q.query_map([vehicle], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)? as u64, r.get::<_, f64>(2)?, r.get::<_, Option<String>>(3)?))))?;
        rows.collect()
    }

    pub fn update_codecs(&self, vehicle: &str, set: &[(String, u64, f64, Option<String>)], gone: &[String]) -> rusqlite::Result<()> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        {
            let mut del = tx.prepare("DELETE FROM codecs WHERE vehicle = ?1 AND rel = ?2")?;
            for rel in gone {
                del.execute(params![vehicle, rel])?;
            }
            let mut ins = tx.prepare("INSERT OR REPLACE INTO codecs VALUES (?1, ?2, ?3, ?4, ?5)")?;
            for (rel, size, m, codec) in set {
                ins.execute(params![vehicle, rel, *size as i64, m, codec])?;
            }
        }
        tx.commit()
    }

    /// Front-camera clips with a size, newest day first (speedIndex.js fronts), with
    /// whether the index already has them as they are now.
    pub fn fronts(&self, vehicle: &str) -> rusqlite::Result<Vec<(Front, bool)>> {
        let db = self.db.lock().unwrap();
        let mut q = db.prepare(
            "SELECT f.day, f.rel, f.size, f.mtime_ms, s.size, s.mtime FROM files f
             LEFT JOIN speeds s ON s.vehicle = f.vehicle AND s.rel = f.rel
             WHERE f.vehicle = ?1 AND f.kind = 'clip' AND f.camera = 'front' AND f.size > 0",
        )?;
        let rows = q.query_map([vehicle], |r| {
            let mtime = crate::sei::js_round(r.get::<_, f64>(3)?) as i64;
            let size = r.get::<_, i64>(2)? as u64;
            let had = r.get::<_, Option<i64>>(4)? == Some(size as i64) && r.get::<_, Option<i64>>(5)? == Some(mtime);
            Ok((Front { day: r.get(0)?, rel: r.get(1)?, size, mtime }, had))
        })?;
        let mut out: Vec<(Front, bool)> = rows.collect::<rusqlite::Result<_>>()?;
        out.retain(|(f, _)| crate::footage::is_day_shape(&f.day));
        out.sort_by(|(a, _), (b, _)| if a.day == b.day { b.rel.cmp(&a.rel) } else { b.day.cmp(&a.day) });
        Ok(out)
    }

    pub fn put_speeds(&self, vehicle: &str, f: &Front, speeds: Option<&str>, summary: Option<&str>) -> rusqlite::Result<()> {
        let db = self.db.lock().unwrap();
        db.execute("INSERT OR REPLACE INTO speeds VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", params![vehicle, f.rel, f.day, f.size as i64, f.mtime, speeds, summary])?;
        Ok(())
    }

    /// How far each day is indexed: day -> (front clips, indexed).
    pub fn progress(&self, vehicle: &str, days: &[String]) -> rusqlite::Result<HashMap<String, (u64, u64)>> {
        let mut out = HashMap::new();
        for (f, had) in self.fronts(vehicle)? {
            if days.contains(&f.day) {
                let e = out.entry(f.day).or_insert((0, 0));
                e.0 += 1;
                if had {
                    e.1 += 1;
                }
            }
        }
        Ok(out)
    }

    /// A day's indexed speeds (the clip as it is now): rel -> speeds JSON (or None).
    pub fn day_speeds(&self, vehicle: &str, day: &str) -> rusqlite::Result<Vec<(String, Option<String>)>> {
        let db = self.db.lock().unwrap();
        let mut q = db.prepare(
            "SELECT s.rel, s.speeds, s.size, s.mtime, f.size, f.mtime_ms FROM speeds s
             JOIN files f ON f.vehicle = s.vehicle AND f.rel = s.rel
             WHERE s.vehicle = ?1 AND s.day = ?2",
        )?;
        let rows = q.query_map(params![vehicle, day], |r| {
            let same = r.get::<_, i64>(2)? == r.get::<_, i64>(4)? && r.get::<_, i64>(3)? == crate::sei::js_round(r.get::<_, f64>(5)?) as i64;
            Ok((same, r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (same, rel, sp) = row?;
            if same {
                out.push((rel, sp));
            }
        }
        Ok(out)
    }
}
