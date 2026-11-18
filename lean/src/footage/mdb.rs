//! The parts of the manager database (server/db.js, the same schema and the
//! same SQL) the footage area reads and writes: settings values (JSON text),
//! the protected clips and the Recycle Bin items. The jobs table is here for
//! the test stand-in only (core owns it in the server).

use rusqlite::{params, Connection, OptionalExtension};
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

    // ---- settings (db.js get / set / del)
    pub fn get(&self, key: &str) -> Option<Value> {
        let c = self.lock();
        let text: Option<String> = c.query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0)).optional().ok().flatten();
        text.and_then(|t| serde_json::from_str(&t).ok())
    }

    pub fn set(&self, key: &str, value: &Value) {
        let c = self.lock();
        let _ = c.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value.to_string()]);
    }

    pub fn del(&self, key: &str) {
        let c = self.lock();
        let _ = c.execute("DELETE FROM settings WHERE key = ?", [key]);
    }

    // ---- protected clips
    pub fn protected_set(&self, vehicle: &str) -> HashSet<String> {
        let c = self.lock();
        let mut q = c.prepare_cached("SELECT rel FROM protected WHERE vehicle_id = ?").unwrap();
        q.query_map([vehicle], |r| r.get::<_, String>(0)).map(|rows| rows.flatten().collect()).unwrap_or_default()
    }

    pub fn set_protected(&self, vehicle: &str, rels: &[String], on: bool) {
        let mut c = self.lock();
        let Ok(tx) = c.transaction() else { return };
        for rel in rels {
            let _ = if on {
                tx.execute("INSERT OR IGNORE INTO protected (vehicle_id, rel, created_at) VALUES (?, ?, ?)", params![vehicle, rel, now_ms()])
            } else {
                tx.execute("DELETE FROM protected WHERE vehicle_id = ? AND rel = ?", params![vehicle, rel])
            };
        }
        let _ = tx.commit();
    }

    // ---- recycle bin
    pub fn add_bin_item(&self, item: &BinItem) {
        let c = self.lock();
        let _ = c.execute(
            "INSERT INTO bin_items (id, vehicle_id, label, category, start_at, bytes, files, trashed_at, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![item.id, item.vehicle_id, item.label, item.category, item.start_at, item.bytes as i64, files_json(&item.files), item.trashed_at as i64, item.reason],
        );
    }

    pub fn bin_items(&self, vehicle: Option<&str>) -> Vec<BinItem> {
        let c = self.lock();
        let rows = match vehicle {
            Some(v) => c.prepare_cached("SELECT * FROM bin_items WHERE vehicle_id = ? ORDER BY trashed_at DESC").and_then(|mut q| q.query_map([v], bin_row)?.collect()),
            None => c.prepare_cached("SELECT * FROM bin_items ORDER BY trashed_at DESC").and_then(|mut q| q.query_map([], bin_row)?.collect()),
        };
        rows.unwrap_or_default()
    }

    pub fn bin_item(&self, id: &str) -> Option<BinItem> {
        let c = self.lock();
        c.query_row("SELECT * FROM bin_items WHERE id = ?", [id], bin_row).optional().ok().flatten()
    }

    pub fn remove_bin_item(&self, id: &str) {
        let c = self.lock();
        let _ = c.execute("DELETE FROM bin_items WHERE id = ?", [id]);
    }

    pub fn update_bin_files(&self, id: &str, files: &[BinFile], bytes: u64) {
        let c = self.lock();
        let _ = c.execute("UPDATE bin_items SET files = ?, bytes = ? WHERE id = ?", params![files_json(files), bytes as i64, id]);
    }

    // ---- jobs (the test stand-in only: db.js startJob / updateJob; the server uses core's)
    pub fn job_start(&self, typ: &str, vehicle: Option<&str>, title: &str) -> i64 {
        let c = self.lock();
        let _ = c.execute("INSERT INTO jobs (type, vehicle_id, status, title, detail, started_at, external_id) VALUES (?, ?, 'running', ?, NULL, ?, NULL)", params![typ, vehicle, title, now_ms()]);
        c.last_insert_rowid()
    }

    pub fn job_finish(&self, id: i64, status: &str, detail: &str, result: Option<&Value>) {
        let c = self.lock();
        let _ = c.execute(
            "UPDATE jobs SET status = ?, detail = ?, result = COALESCE(?, result), finished_at = ? WHERE id = ?",
            params![status, detail, result.map(|r| r.to_string()), now_ms(), id],
        );
    }

    /// (tests) the jobs as (type, status, title, detail)
    pub fn jobs(&self) -> Vec<(String, String, String, Option<String>)> {
        let c = self.lock();
        let mut q = c.prepare("SELECT type, status, title, detail FROM jobs ORDER BY id").unwrap();
        q.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().flatten().collect()
    }
}
