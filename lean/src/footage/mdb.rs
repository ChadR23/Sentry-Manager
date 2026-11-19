//! The parts of the manager database (server/db.js, the same schema and the
//! same SQL) the footage area reads and writes: settings values (JSON text),
//! the protected clips and the Recycle Bin items. The jobs table is here for
//! the test stand-in only (core owns it in the server).

pub use crate::core::db::{DbError, DbResult};
use crate::core::db::{all, one};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

/// The tables of server/db.js this area uses, exactly as Node creates them.
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS protected (
  vehicle_id TEXT NOT NULL, rel TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (vehicle_id, rel)
);
CREATE TABLE IF NOT EXISTS bin_items (
  id TEXT PRIMARY KEY, vehicle_id TEXT NOT NULL, label TEXT NOT NULL, category TEXT NOT NULL,
  start_at TEXT, bytes INTEGER NOT NULL, files TEXT NOT NULL, trashed_at INTEGER NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, vehicle_id TEXT, status TEXT NOT NULL,
  title TEXT NOT NULL, detail TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, result TEXT, external_id TEXT
);
";

pub struct ManagerDb {
    conn: Conn,
}

/// Its own connection (tests), or core's one connection to manager.db (the server).
enum Conn {
    Own(Mutex<Connection>),
    Core(std::sync::Arc<crate::core::db::Db>),
}

/// One file of a bin item (db.js stores the list as JSON).
#[derive(Debug, Clone, PartialEq)]
pub struct BinFile {
    pub rel: String,
    pub bin_rel: String,
    pub size: u64,
    pub pending: bool,
    pub conflict: bool,
}

impl BinFile {
    pub fn json(&self) -> Value {
        let mut v = json!({ "rel": self.rel, "binRel": self.bin_rel, "size": self.size });
        if self.pending {
            v["pending"] = json!(true);
        }
        if self.conflict {
            v["conflict"] = json!(true);
        }
        v
    }
    fn of(v: &Value) -> Option<BinFile> {
        Some(BinFile {
            rel: v.get("rel")?.as_str()?.to_string(),
            bin_rel: v.get("binRel")?.as_str()?.to_string(),
            size: v.get("size").and_then(Value::as_f64).unwrap_or(0.0) as u64,
            pending: v.get("pending").and_then(Value::as_bool).unwrap_or(false),
            conflict: v.get("conflict").and_then(Value::as_bool).unwrap_or(false),
        })
    }
}

/// A Recycle Bin item (db.js binRow).
#[derive(Debug, Clone, PartialEq)]
pub struct BinItem {
    pub id: String,
    pub vehicle_id: String,
    pub label: String,
    pub category: String,
    pub start_at: Option<String>,
    pub bytes: u64,
    pub files: Vec<BinFile>,
    pub trashed_at: f64,
    pub reason: String,
}

impl BinItem {
    /// As GET /api/bin lists it (binRow's fields, files as stored).
    pub fn json(&self) -> Value {
        json!({
            "id": self.id, "vehicleId": self.vehicle_id, "label": self.label, "category": self.category, "startAt": self.start_at,
            "bytes": self.bytes, "files": self.files.iter().map(BinFile::json).collect::<Vec<_>>(), "trashedAt": self.trashed_at as i64,
            "reason": self.reason
        })
    }
}

fn files_json(files: &[BinFile]) -> String {
    Value::Array(files.iter().map(BinFile::json).collect()).to_string()
}

fn bin_row(r: &rusqlite::Row) -> rusqlite::Result<BinItem> {
    let files: String = r.get("files")?;
    let files = serde_json::from_str::<Value>(&files).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
    Ok(BinItem {
        id: r.get("id")?,
        vehicle_id: r.get("vehicle_id")?,
        label: r.get("label")?,
        category: r.get("category")?,
        start_at: r.get("start_at")?,
        bytes: r.get::<_, i64>("bytes")? as u64,
        files: files.iter().filter_map(BinFile::of).collect(),
        trashed_at: r.get::<_, i64>("trashed_at")? as f64,
        reason: r.get("reason")?,
    })
}

fn now_ms() -> i64 {
    super::scanner::now_ms() as i64
}

impl ManagerDb {
    pub fn open(path: &Path) -> rusqlite::Result<ManagerDb> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        Self::with(Connection::open(path)?)
    }

    pub fn memory() -> ManagerDb {
        Self::with(Connection::open_in_memory().expect("sqlite")).expect("schema")
    }

    fn with(conn: Connection) -> rusqlite::Result<ManagerDb> {
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")?;
        conn.execute_batch(SCHEMA)?;
        Ok(ManagerDb { conn: Conn::Own(Mutex::new(conn)) })
    }

    /// The server's: core's connection (core made these tables with the rest of db.js's schema).
    pub fn of_core(db: std::sync::Arc<crate::core::db::Db>) -> ManagerDb {
        ManagerDb { conn: Conn::Core(db) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        match &self.conn {
            Conn::Own(c) => c.lock().unwrap_or_else(|e| e.into_inner()),
            Conn::Core(db) => db.conn(),
        }
    }

    /// The connection for a read: core's reading one in the server.
    fn read_lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        match &self.conn {
            Conn::Own(c) => c.lock().unwrap_or_else(|e| e.into_inner()),
            Conn::Core(db) => db.reader(),
        }
    }

    // ---- settings (db.js get / set / del): None for no row (or not JSON), an error when the
    // database could not be read; a write that was not kept is an error
    pub fn get(&self, key: &str) -> DbResult<Option<Value>> {
        if let Conn::Core(db) = &self.conn {
            return db.get(key);
        }
        let c = self.lock();
        let text: Option<String> = one(c.query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0)))?;
        Ok(text.and_then(|t| serde_json::from_str(&t).ok()))
    }

    pub fn set(&self, key: &str, value: &Value) -> DbResult<()> {
        let c = self.lock();
        c.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value.to_string()])?;
        Ok(())
    }

    pub fn del(&self, key: &str) -> DbResult<()> {
        let c = self.lock();
        c.execute("DELETE FROM settings WHERE key = ?", [key])?;
        Ok(())
    }

    // ---- protected clips
    pub fn protected_set(&self, vehicle: &str) -> DbResult<HashSet<String>> {
        let c = self.read_lock();
        let mut q = c.prepare_cached("SELECT rel FROM protected WHERE vehicle_id = ?")?;
        let rows = all(q.query_map([vehicle], |r| r.get::<_, String>(0))?)?;
        Ok(rows.into_iter().collect())
    }

    /// The clips protected (or not) together, or none of them.
    pub fn set_protected(&self, vehicle: &str, rels: &[String], on: bool) -> DbResult<()> {
        let mut c = self.lock();
        let tx = c.transaction()?;
        for rel in rels {
            if on {
                tx.execute("INSERT OR IGNORE INTO protected (vehicle_id, rel, created_at) VALUES (?, ?, ?)", params![vehicle, rel, now_ms()])?;
            } else {
                tx.execute("DELETE FROM protected WHERE vehicle_id = ? AND rel = ?", params![vehicle, rel])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    // ---- recycle bin
    pub fn add_bin_item(&self, item: &BinItem) -> DbResult<()> {
        let c = self.lock();
        c.execute(
            "INSERT INTO bin_items (id, vehicle_id, label, category, start_at, bytes, files, trashed_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![item.id, item.vehicle_id, item.label, item.category, item.start_at, item.bytes as i64, files_json(&item.files), item.trashed_at as i64, item.reason],
        )?;
        Ok(())
    }

    /// The items (one whose columns do not fit is left out), an error when the database failed.
    pub fn bin_items(&self, vehicle: Option<&str>) -> DbResult<Vec<BinItem>> {
        let c = self.read_lock();
        let rows = match vehicle {
            Some(v) => {
                let mut q = c.prepare_cached("SELECT * FROM bin_items WHERE vehicle_id = ? ORDER BY trashed_at DESC")?;
                let rows = all(q.query_map([v], bin_row)?)?;
                rows
            }
            None => {
                let mut q = c.prepare_cached("SELECT * FROM bin_items ORDER BY trashed_at DESC")?;
                let rows = all(q.query_map([], bin_row)?)?;
                rows
            }
        };
        Ok(rows)
    }

    pub fn bin_item(&self, id: &str) -> DbResult<Option<BinItem>> {
        let c = self.read_lock();
        Ok(one(c.query_row("SELECT * FROM bin_items WHERE id = ?", [id], bin_row))?)
    }

    pub fn remove_bin_item(&self, id: &str) -> DbResult<()> {
        let c = self.lock();
        c.execute("DELETE FROM bin_items WHERE id = ?", [id])?;
        Ok(())
    }

    pub fn update_bin_files(&self, id: &str, files: &[BinFile], bytes: u64) -> DbResult<()> {
        let c = self.lock();
        c.execute("UPDATE bin_items SET files = ?, bytes = ? WHERE id = ?", params![files_json(files), bytes as i64, id])?;
        Ok(())
    }

    // ---- jobs (the test stand-in only: db.js startJob / updateJob; the server uses core's)
    pub fn job_start(&self, typ: &str, vehicle: Option<&str>, title: &str) -> DbResult<i64> {
        let c = self.lock();
        c.execute("INSERT INTO jobs (type, vehicle_id, status, title, detail, started_at, external_id) VALUES (?, ?, 'running', ?, NULL, ?, NULL)", params![typ, vehicle, title, now_ms()])?;
        Ok(c.last_insert_rowid())
    }

    pub fn job_finish(&self, id: i64, status: &str, detail: &str, result: Option<&Value>) -> DbResult<()> {
        let c = self.lock();
        c.execute(
            "UPDATE jobs SET status = ?, detail = ?, result = COALESCE(?, result), finished_at = ? WHERE id = ?",
            params![status, detail, result.map(|r| r.to_string()), now_ms(), id],
        )?;
        Ok(())
    }

    /// (tests) the jobs as (type, status, title, detail)
    pub fn jobs(&self) -> Vec<(String, String, String, Option<String>)> {
        let c = self.read_lock();
        let mut q = c.prepare("SELECT type, status, title, detail FROM jobs ORDER BY id").unwrap();
        q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().flatten().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str) -> BinItem {
        BinItem { id: id.into(), vehicle_id: "car".into(), label: id.into(), category: "Recent".into(), start_at: None, bytes: 5, files: vec![], trashed_at: 1.0, reason: "manual".into() }
    }

    #[test]
    fn a_read_that_fails_is_an_error_not_an_empty_answer_and_a_write_not_kept_is_one_too() {
        let db = ManagerDb::memory();
        assert_eq!(db.get("x").unwrap(), None, "no row");
        db.set("x", &json!({ "a": 1 })).unwrap();
        db.add_bin_item(&item("a")).unwrap();
        db.set_protected("car", &["r1".to_string()], true).unwrap();
        // a row whose columns do not fit is left out; the others stay listed
        db.lock().execute("INSERT INTO bin_items (id, vehicle_id, label, category, bytes, files, trashed_at, reason) VALUES ('odd', 'car', 'odd', 'Recent', 'many', '[]', 2, 'manual')", []).unwrap();
        assert_eq!(db.bin_items(None).unwrap().iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["a"]);
        assert_eq!(db.bin_item("odd").unwrap(), None);
        // clips are protected together or none of them
        db.lock().execute_batch("CREATE TEMP TRIGGER refused BEFORE INSERT ON protected WHEN NEW.rel = 'r3' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;").unwrap();
        assert!(db.set_protected("car", &["r2".to_string(), "r3".to_string()], true).is_err());
        assert_eq!(db.protected_set("car").unwrap(), HashSet::from(["r1".to_string()]));
        // tables that cannot be read (a broken disk): errors, never "nothing there"; nor kept
        let tables = ["settings", "protected", "bin_items"];
        let mut broken = String::from("DROP TRIGGER refused; CREATE TABLE gone (x);");
        for t in tables {
            broken.push_str(&format!(" ALTER TABLE {t} RENAME TO {t}_kept;"));
        }
        for t in tables {
            broken.push_str(&format!(" CREATE VIEW {t} AS SELECT * FROM gone;"));
        }
        db.lock().execute_batch(&format!("{broken} DROP TABLE gone;")).unwrap();
        assert!(db.get("x").is_err() && db.protected_set("car").is_err() && db.bin_items(None).is_err() && db.bin_items(Some("car")).is_err() && db.bin_item("a").is_err());
        assert!(db.set("x", &json!(2)).is_err() && db.del("x").is_err() && db.set_protected("car", &["r4".to_string()], true).is_err());
        assert!(db.add_bin_item(&item("b")).is_err() && db.remove_bin_item("a").is_err() && db.update_bin_files("a", &[], 0).is_err());
    }
}
