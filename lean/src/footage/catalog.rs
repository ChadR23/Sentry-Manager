//! The footage catalog (server/catalog.js) in the manager's database: every
//! file of the last scan (`catalog_files`), the folders' modified times
//! (`catalog_dirs`, for light rescans), the last finished scan
//! (`catalog_scans`: the first scan after a restart starts from it) and each
//! clip's codec (`clip_codecs`). The same tables, columns and FORMAT as Node,
//! so either server resumes from the other's last scan. Only the manager's
//! own data folder is written; the footage is only ever listed and read.
//!
//! It has its own connection to manager.db (WAL: the scan's writes do not
//! hold up core's), and writes in batches as catalog.js does.

use crate::footage::Kind;
use crate::scanner::{FileEntry, Previous, ScanResult};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

pub struct Catalog {
    db: Mutex<Connection>,
}

/// catalog.js FORMAT: what a scan row vouches for (Node's rows and these are the same).
const FORMAT: i64 = 1;
/// rows per transaction (catalog.js BATCH)
const BATCH: usize = 1000;

const UPSERT_FILE: &str = "INSERT INTO catalog_files (vehicle_id, rel, size, mtime_ms, ctime_ms, birthtime_ms, kind, type, day, camera, event_id)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
      ON CONFLICT(vehicle_id, rel) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, ctime_ms = excluded.ctime_ms,
        birthtime_ms = excluded.birthtime_ms, kind = excluded.kind, type = excluded.type, day = excluded.day, camera = excluded.camera,
        event_id = excluded.event_id";

pub type CodecMap = HashMap<String, (u64, f64, Option<String>)>;

fn type_of(s: &str) -> &'static str {
    match s {
        "RecentClips" => "RecentClips",
        "SentryClips" => "SentryClips",
        "SavedClips" => "SavedClips",
        _ => "Other",
    }
}

struct LastScan {
    format: i64,
    root: String,
    started_ms: f64,
    scanned_at: f64,
    files: i64,
    bytes: i64,
}

impl Catalog {
    /// `path`: DATA_PATH/manager.db (the tables are made as catalog.js makes them when missing).
    pub fn open(path: &Path) -> rusqlite::Result<Catalog> {
        let db = Connection::open(path)?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "NORMAL")?;
        db.busy_timeout(std::time::Duration::from_secs(10))?;
        // a small page cache: the catalog is read in a few big queries
        db.pragma_update(None, "cache_size", -2000)?;
        db.execute_batch(crate::core::db::CATALOG_SCHEMA)?;
        Ok(Catalog { db: Mutex::new(db) })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// catalog.js each: the list in transactions of BATCH rows.
    fn each<T>(&self, list: &[T], sql: &str, f: impl Fn(&mut rusqlite::Statement, &T) -> rusqlite::Result<()>) -> rusqlite::Result<()> {
        for part in list.chunks(BATCH) {
            let mut c = self.conn();
            let tx = c.transaction()?;
            {
                let mut st = tx.prepare_cached(sql)?;
                for x in part {
                    f(&mut st, x)?;
                }
            }
            tx.commit()?;
        }
        Ok(())
    }

    fn put_files(&self, vehicle: &str, files: &[&FileEntry]) -> rusqlite::Result<()> {
        self.each(files, UPSERT_FILE, |st, f| {
            st.execute(params![vehicle, f.rel, f.size as i64, f.mtime_ms, f.ctime_ms, f.birthtime_ms, f.kind.as_str(), f.typ, f.day, f.camera, f.event_id]).map(|_| ())
        })
    }

    fn remove_files(&self, vehicle: &str, rels: &[String]) -> rusqlite::Result<()> {
        self.each(rels, "DELETE FROM catalog_files WHERE vehicle_id = ?1 AND rel = ?2", |st, rel| st.execute(params![vehicle, rel]).map(|_| ()))
    }

    fn rels(&self, vehicle: &str) -> rusqlite::Result<HashSet<String>> {
        let c = self.conn();
        let mut q = c.prepare("SELECT rel FROM catalog_files WHERE vehicle_id = ?1")?;
        let rows = q.query_map([vehicle], |r| r.get::<_, String>(0))?;
        rows.collect()
    }

    fn invalidate(&self, vehicle: &str) -> rusqlite::Result<()> {
        self.conn().execute("DELETE FROM catalog_scans WHERE vehicle_id = ?1", [vehicle]).map(|_| ())
    }

    fn totals(&self, vehicle: &str) -> rusqlite::Result<(i64, i64)> {
        self.conn().query_row("SELECT COUNT(*), COALESCE(SUM(size), 0) FROM catalog_files WHERE vehicle_id = ?1", [vehicle], |r| Ok((r.get(0)?, r.get(1)?)))
    }

    fn mark_scan(&self, vehicle: &str, root: &str, started_ms: f64, scanned_at: f64) -> rusqlite::Result<()> {
        let (files, bytes) = self.totals(vehicle)?;
        self.conn().execute(
            "INSERT INTO catalog_scans (vehicle_id, format, root, started_ms, scanned_at, files, bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(vehicle_id) DO UPDATE SET format = excluded.format, root = excluded.root, started_ms = excluded.started_ms,
               scanned_at = excluded.scanned_at, files = excluded.files, bytes = excluded.bytes",
            params![vehicle, FORMAT, root, started_ms, scanned_at, files, bytes],
        )?;
        Ok(())
    }

    fn last_scan(&self, vehicle: &str) -> rusqlite::Result<Option<LastScan>> {
        self.conn()
            .query_row("SELECT format, root, started_ms, scanned_at, files, bytes FROM catalog_scans WHERE vehicle_id = ?1", [vehicle], |r| {
                Ok(LastScan { format: r.get(0)?, root: r.get(1)?, started_ms: r.get(2)?, scanned_at: r.get(3)?, files: r.get(4)?, bytes: r.get(5)? })
            })
            .optional()
    }

    /// Every file and folder the catalog has for a vehicle.
    pub fn previous(&self, vehicle: &str) -> rusqlite::Result<Previous> {
        let c = self.conn();
        let mut prev = Previous::default();
        let mut q = c.prepare("SELECT rel, size, mtime_ms, ctime_ms, kind, type, day, camera, event_id, birthtime_ms FROM catalog_files WHERE vehicle_id = ?1")?;
        let rows = q.query_map([vehicle], |r| {
            Ok(FileEntry {
                rel: r.get(0)?,
                size: r.get::<_, i64>(1)? as u64,
                mtime_ms: r.get(2)?,
                ctime_ms: r.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
                birthtime_ms: r.get::<_, Option<f64>>(9)?.unwrap_or(0.0),
                kind: if r.get::<_, String>(4)? == "clip" { Kind::Clip } else { Kind::Asset },
                typ: type_of(&r.get::<_, Option<String>>(5)?.unwrap_or_default()),
                day: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                camera: r.get(7)?,
                event_id: r.get(8)?,
            })
        })?;
        for f in rows {
            let f = f?;
            prev.files.insert(f.rel.clone(), f);
        }
        let mut q = c.prepare("SELECT rel, mtime_ms FROM catalog_dirs WHERE vehicle_id = ?1")?;
        for d in q.query_map([vehicle], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))? {
            let (rel, m) = d?;
            prev.dirs.insert(rel, m);
        }
        Ok(prev)
    }

    /// What the last finished scan of this root knew, for the first scan after a restart
    /// (catalog.js resume): None for another root or format, or rows that do not add up to that scan.
    pub fn resume(&self, vehicle: &str, root: &str) -> rusqlite::Result<Option<Previous>> {
        let Some(last) = self.last_scan(vehicle)? else { return Ok(None) };
        if last.format != FORMAT || last.root != root {
            return Ok(None);
        }
        if self.totals(vehicle)? != (last.files, last.bytes) {
            return Ok(None);
        }
        let mut prev = self.previous(vehicle)?;
        if prev.dirs.is_empty() {
            return Ok(None);
        }
        prev.started_ms = Some(last.started_ms);
        Ok(Some(prev))
    }

    /// A finished scan of `root`: its files (only what changed is written), its folders
    /// and the scan row, written last (inventory.js and catalog.js putScan).
    pub fn save_scan(&self, vehicle: &str, root: &str, scan: &ScanResult) -> rusqlite::Result<()> {
        // (the scan row goes first and comes back last: a write that stops halfway leaves none)
        self.invalidate(vehicle)?;
        let known = self.previous(vehicle)?;
        let present: HashSet<&str> = scan.files.iter().map(|f| f.rel.as_str()).collect();
        let gone: Vec<String> = known.files.keys().filter(|r| !present.contains(r.as_str())).cloned().collect();
        let changed: Vec<&FileEntry> = scan.files.iter().filter(|f| known.files.get(&f.rel).is_none_or(|k| !same_entry(k, f))).collect();
        self.remove_files(vehicle, &gone)?;
        self.put_files(vehicle, &changed)?;
        self.conn().execute("DELETE FROM catalog_dirs WHERE vehicle_id = ?1", [vehicle])?;
        let dirs: Vec<(&String, &f64)> = scan.dirs.iter().collect();
        self.each(&dirs, "INSERT INTO catalog_dirs (vehicle_id, rel, mtime_ms) VALUES (?1, ?2, ?3)", |st, (rel, m)| st.execute(params![vehicle, rel, m]).map(|_| ()))?;
        self.mark_scan(vehicle, root, scan.started_at, scan.scanned_at)
    }

    /// The files moved without a scan (Recycle Bin, restore): the rows follow the inventory's
    /// files, and the scan row its totals (catalog.js syncFiles).
    pub fn sync_files(&self, vehicle: &str, files: &[FileEntry]) -> rusqlite::Result<()> {
        let have = self.rels(vehicle)?;
        let now: HashSet<&str> = files.iter().map(|f| f.rel.as_str()).collect();
        let gone: Vec<String> = have.iter().filter(|r| !now.contains(r.as_str())).cloned().collect();
        let added: Vec<&FileEntry> = files.iter().filter(|f| !have.contains(&f.rel)).collect();
        if gone.is_empty() && added.is_empty() {
            return Ok(());
        }
        let last = self.last_scan(vehicle)?;
        self.invalidate(vehicle)?;
        self.remove_files(vehicle, &gone)?;
        self.put_files(vehicle, &added)?;
        if let Some(l) = last.filter(|l| l.format == FORMAT) {
            self.mark_scan(vehicle, &l.root, l.started_ms, l.scanned_at)?;
        }
        Ok(())
    }

    /// The clip codecs read so far: rel -> (size, mtime, codec).
    pub fn codecs(&self, vehicle: &str) -> rusqlite::Result<CodecMap> {
        let c = self.conn();
        let mut q = c.prepare("SELECT rel, size, mtime_ms, codec FROM clip_codecs WHERE vehicle_id = ?1")?;
        let rows = q.query_map([vehicle], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)? as u64, r.get::<_, f64>(2)?, r.get::<_, Option<String>>(3)?))))?;
        rows.collect()
    }

    pub fn codec(&self, vehicle: &str, rel: &str) -> rusqlite::Result<Option<(u64, f64, Option<String>)>> {
        self.conn()
            .query_row("SELECT size, mtime_ms, codec FROM clip_codecs WHERE vehicle_id = ?1 AND rel = ?2", [vehicle, rel], |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, f64>(1)?, r.get::<_, Option<String>>(2)?)))
            .optional()
    }

    pub fn update_codecs(&self, vehicle: &str, set: &[(String, u64, f64, Option<String>)], gone: &[String]) -> rusqlite::Result<()> {
        self.each(gone, "DELETE FROM clip_codecs WHERE vehicle_id = ?1 AND rel = ?2", |st, rel| st.execute(params![vehicle, rel]).map(|_| ()))?;
        self.each(
            set,
            "INSERT INTO clip_codecs (vehicle_id, rel, size, mtime_ms, codec) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(vehicle_id, rel) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, codec = excluded.codec",
            |st, (rel, size, m, codec)| st.execute(params![vehicle, rel, *size as i64, m, codec]).map(|_| ()),
        )
    }
}

fn same_entry(a: &FileEntry, b: &FileEntry) -> bool {
    a.size == b.size && a.mtime_ms == b.mtime_ms && a.ctime_ms == b.ctime_ms && a.birthtime_ms == b.birthtime_ms && a.kind == b.kind && a.typ == b.typ && a.day == b.day && a.camera == b.camera && a.event_id == b.event_id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_codec_is_the_row_the_whole_table_has() {
        let dir = std::env::temp_dir().join(format!("catalog-codec-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cat = Catalog::open(&dir.join("manager.db")).unwrap();
        let set = vec![("SentryClips/a/x-front.mp4".to_string(), 10, 1.5, Some("hevc".to_string())), ("RecentClips/y-front.mp4".to_string(), 20, 2.0, None)];
        cat.update_codecs("v1", &set, &[]).unwrap();
        let all = cat.codecs("v1").unwrap();
        for (rel, ..) in &set {
            assert_eq!(cat.codec("v1", rel).unwrap().as_ref(), all.get(rel));
        }
        assert_eq!(cat.codec("v1", "missing.mp4").unwrap(), None);
        assert_eq!(cat.codec("v2", "RecentClips/y-front.mp4").unwrap(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
