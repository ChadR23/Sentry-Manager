//! `DATA/manager.db`: the same SQLite file, schema and queries as
//! server/db.js (and the catalog tables of server/catalog.js), so the Node
//! server and this one can take turns on one database: settings, users,
//! sessions, protected clips, Recycle Bin items, jobs, notifications, stars
//! (a setting) and the footage catalog all carry over, both ways.
//!
//! Only `CREATE ... IF NOT EXISTS` and the same `ALTER TABLE ... ADD COLUMN`
//! as Node: nothing here changes a table Node made, and every table made
//! here is one Node makes the same way.

use rusqlite::{params, Connection, Row};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
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
CREATE INDEX IF NOT EXISTS jobs_started ON jobs(started_at);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_external ON jobs(external_id) WHERE external_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS jobs_cleared (external_id TEXT PRIMARY KEY, cleared_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, level TEXT NOT NULL, vehicle_id TEXT,
  title TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  resolved_at INTEGER, read_at INTEGER, dedupe_key TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_open ON notifications(dedupe_key) WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL;
";

/// server/catalog.js: the footage catalog's tables (made here if missing).
pub const CATALOG_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS catalog_files (
  vehicle_id TEXT NOT NULL, rel TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL,
  ctime_ms REAL, birthtime_ms REAL, kind TEXT NOT NULL, type TEXT, day TEXT, camera TEXT, event_id TEXT,
  PRIMARY KEY (vehicle_id, rel)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS catalog_files_day ON catalog_files(vehicle_id, day);
CREATE TABLE IF NOT EXISTS clip_codecs (
  vehicle_id TEXT NOT NULL, rel TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, codec TEXT,
  PRIMARY KEY (vehicle_id, rel)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS catalog_dirs (
  vehicle_id TEXT NOT NULL, rel TEXT NOT NULL, mtime_ms REAL NOT NULL,
  PRIMARY KEY (vehicle_id, rel)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS catalog_scans (
  vehicle_id TEXT PRIMARY KEY, format INTEGER NOT NULL, root TEXT NOT NULL, started_ms REAL NOT NULL,
  scanned_at REAL NOT NULL, files INTEGER NOT NULL, bytes INTEGER NOT NULL
);
";

/// conversions taken off Jobs by Clear jobs that are remembered (see clear_jobs)
const CLEARED_KEPT: i64 = 2000;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Debug, Clone, PartialEq)]
pub struct User {
    pub username: String,
    pub salt: String,
    pub hash: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Session {
    pub token_hash: String,
    pub username: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub agent: Option<String>,
    pub ip: Option<String>,
    pub seen_at: Option<i64>,
}

/// A job as db.js jobRow gives it.
#[derive(Debug, Clone, PartialEq)]
pub struct Job {
    pub id: i64,
    pub kind: String,
    pub vehicle_id: Option<String>,
    pub status: String,
    pub title: String,
    pub detail: Option<String>,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub result: Value,
    pub external_id: Option<String>,
}

impl Job {
    /// jobRow's JSON (the key order of the Node answer).
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "type": self.kind, "vehicleId": self.vehicle_id, "status": self.status, "title": self.title,
            "detail": self.detail, "startedAt": self.started_at, "finishedAt": self.finished_at, "result": self.result,
            "externalId": self.external_id })
    }
}

#[derive(Debug, Clone, Default)]
pub struct NewJob {
    pub kind: String,
    pub vehicle_id: Option<String>,
    pub title: String,
    pub detail: Option<String>,
    pub external_id: Option<String>,
}

/// updateJob's fields: None keeps what the row has.
#[derive(Debug, Clone, Default)]
pub struct JobUpdate {
    pub status: Option<String>,
    pub detail: Option<String>,
    /// Some(value): stored as JSON (Some(Value::Null) stores "null")
    pub result: Option<Value>,
    pub finished: bool,
}

#[derive(Debug, Clone, Default)]
pub struct NewNotification {
    pub kind: String,
    /// default "warning"
    pub level: Option<String>,
    pub vehicle_id: Option<String>,
    pub title: String,
    pub message: Option<String>,
    pub dedupe_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BinItem {
    pub id: String,
    pub vehicle_id: String,
    pub label: String,
    pub category: String,
    pub start_at: Option<String>,
    pub bytes: i64,
    pub files: Value,
    pub trashed_at: i64,
    pub reason: String,
}

impl BinItem {
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "vehicleId": self.vehicle_id, "label": self.label, "category": self.category, "startAt": self.start_at,
            "bytes": self.bytes, "files": self.files, "trashedAt": self.trashed_at, "reason": self.reason })
    }
}

pub struct Db {
    conn: Mutex<Connection>,
    /// A second connection to the file, for reads: in WAL a read does not wait for a write, while
    /// a write through `conn` holds it as long as it waits (up to the busy timeout) for another
    /// connection's write, the footage catalog's (None: an in-memory database)
    read: Option<Mutex<Connection>>,
    /// the file (None: an in-memory database)
    file: Option<std::path::PathBuf>,
    /// notify(): whether the last call changed anything (db.js lastNotifyChanged)
    last_notify_changed: Mutex<bool>,
}

/// manager.db could not be read or written (busy past the wait, read-only, full,
/// damaged): never the same as a missing row or a write that was kept.
#[derive(Debug)]
pub struct DbError(pub rusqlite::Error);

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "manager.db: {}", self.0)
    }
}

impl std::error::Error for DbError {}

impl From<rusqlite::Error> for DbError {
    fn from(e: rusqlite::Error) -> DbError {
        DbError(e)
    }
}

pub type DbResult<T> = Result<T, DbError>;

/// Reads and writes that repeat (every minute, every sample, every scan): a failure is logged the
/// first time, then again only after one has worked.
#[derive(Default)]
pub struct LogOnce(Mutex<std::collections::HashSet<String>>);

impl LogOnce {
    /// Whether `what` failed this time: true only when it did and had not the time before (the
    /// one time to log it).
    pub fn first(&self, what: &str, failed: bool) -> bool {
        let mut f = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if failed {
            f.insert(what.to_string())
        } else {
            f.remove(what);
            false
        }
    }
}

fn parse(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}

/// A row that is there but does not fit the type read (a column of another type): read as
/// before (no row, or left out of a list), not as the database failing.
fn misfit(e: &rusqlite::Error) -> bool {
    use rusqlite::Error::*;
    matches!(e, FromSqlConversionFailure(..) | IntegralValueOutOfRange(..) | Utf8Error(_) | InvalidColumnIndex(_) | InvalidColumnName(_) | InvalidColumnType(..))
}

/// query_row's answer: None for no row (or one that does not fit), an error when the database failed.
pub(crate) fn one<T>(r: rusqlite::Result<T>) -> rusqlite::Result<Option<T>> {
    match r {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) if misfit(&e) => Ok(None),
        Err(e) => Err(e),
    }
}

/// A query's rows: one that does not fit is left out (as before); the database failing
/// part way is an error, not a shorter list.
pub(crate) fn all<T>(rows: impl Iterator<Item = rusqlite::Result<T>>) -> rusqlite::Result<Vec<T>> {
    let mut out = Vec::new();
    for r in rows {
        match r {
            Ok(v) => out.push(v),
            Err(e) if misfit(&e) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}

fn job_row(r: &Row) -> rusqlite::Result<Job> {
    let result: Option<String> = r.get("result")?;
    Ok(Job {
        id: r.get("id")?,
        kind: r.get("type")?,
        vehicle_id: r.get("vehicle_id")?,
        status: r.get("status")?,
        title: r.get("title")?,
        detail: r.get("detail")?,
        started_at: r.get("started_at")?,
        finished_at: r.get("finished_at")?,
        // `r.result ? parse(r.result, null) : null`
        result: result.filter(|s| !s.is_empty()).and_then(|s| parse(&s)).unwrap_or(Value::Null),
        external_id: r.get("external_id")?,
    })
}

fn bin_row(r: &Row) -> rusqlite::Result<BinItem> {
    let files: String = r.get("files")?;
    Ok(BinItem {
        id: r.get("id")?,
        vehicle_id: r.get("vehicle_id")?,
        label: r.get("label")?,
        category: r.get("category")?,
        start_at: r.get("start_at")?,
        bytes: r.get("bytes")?,
        files: parse(&files).unwrap_or_else(|| json!([])),
        trashed_at: r.get("trashed_at")?,
        reason: r.get("reason")?,
    })
}

fn session_row(r: &Row) -> rusqlite::Result<Session> {
    Ok(Session {
        token_hash: r.get("token_hash")?,
        username: r.get("username").unwrap_or_default(),
        created_at: r.get("created_at")?,
        expires_at: r.get("expires_at")?,
        agent: r.get("agent")?,
        ip: r.get("ip")?,
        seen_at: r.get("seen_at")?,
    })
}

impl Db {
    pub fn open(file: &Path) -> rusqlite::Result<Db> {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let mut db = Db::from_conn(Connection::open(file)?)?;
        let read = Connection::open(file)?;
        read.busy_timeout(std::time::Duration::from_secs(5))?;
        read.execute_batch("PRAGMA query_only = ON;")?;
        db.read = Some(Mutex::new(read));
        db.file = Some(file.to_path_buf());
        Ok(db)
    }

    pub fn memory() -> rusqlite::Result<Db> {
        Db::from_conn(Connection::open_in_memory()?)
    }

    fn from_conn(conn: Connection) -> rusqlite::Result<Db> {
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        // sessions know the device they are on (signed-in devices); added to databases from before
        for col in ["agent TEXT", "ip TEXT", "seen_at INTEGER"] {
            let _ = conn.execute_batch(&format!("ALTER TABLE sessions ADD COLUMN {col}"));
        }
        conn.execute_batch(CATALOG_SCHEMA)?;
        Ok(Db { conn: Mutex::new(conn), read: None, file: None, last_notify_changed: Mutex::new(true) })
    }

    /// The connection, for an area's own queries (keep the lock short).
    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The connection for a read: the reading one, when there is one.
    pub(crate) fn reader(&self) -> MutexGuard<'_, Connection> {
        match &self.read {
            Some(r) => r.lock().unwrap_or_else(|e| e.into_inner()),
            None => self.conn(),
        }
    }

    /// (tests) A read of the setting `key` fails ("malformed JSON") on the reading connection,
    /// while writes go on: a read-modify-write must not write over what it could not read.
    #[cfg(test)]
    pub(crate) fn fail_setting_reads(&self, key: &str) {
        assert!(self.read.is_some(), "a file database: reads have a connection of their own");
        let key = key.replace('\'', "''");
        self.reader()
            .execute_batch(&format!(
                "PRAGMA query_only = OFF; DROP VIEW IF EXISTS temp.settings; CREATE TEMP VIEW settings AS SELECT key, CASE WHEN key = '{key}' THEN json('{{') ELSE value END AS value FROM main.settings; PRAGMA query_only = ON;"
            ))
            .unwrap();
    }

    /// (tests) Reads work again.
    #[cfg(test)]
    pub(crate) fn mend_reads(&self) {
        self.reader().execute_batch("PRAGMA query_only = OFF; DROP VIEW IF EXISTS temp.settings; PRAGMA query_only = ON;").unwrap();
    }

    /// PRAGMA quick_check (its first line: "ok" when intact) on a connection of its own: it reads
    /// the whole file, a third of a second on a real install, while the shared ones go on.
    pub fn quick_check(&self) -> rusqlite::Result<String> {
        let Some(file) = &self.file else { return self.reader().query_row("PRAGMA quick_check", [], |r| r.get(0)) };
        // (never made: a file gone is an error, not a new empty database that checks out)
        let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_URI | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let c = Connection::open_with_flags(file, flags)?;
        c.busy_timeout(std::time::Duration::from_secs(5))?;
        c.execute_batch("PRAGMA query_only = ON;")?;
        c.query_row("PRAGMA quick_check", [], |r| r.get(0))
    }

    /// db.js tx: BEGIN, COMMIT, or ROLLBACK when `f` (or the commit) fails. IMMEDIATE: the write
    /// lock is waited for (busy timeout) at the start, so a transaction that reads before it writes
    /// is not refused when another connection wrote in between.
    pub fn tx<T>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> rusqlite::Result<T> {
        let c = self.conn();
        c.execute_batch("BEGIN IMMEDIATE")?;
        match f(&c).and_then(|v| c.execute_batch("COMMIT").map(|_| v)) {
            Ok(v) => Ok(v),
            Err(e) => {
                let _ = c.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    // ---- settings
    /// The stored value; None when there is no row or it is not JSON (db.js get's fallback),
    /// an error when the database could not be read. A stored `null` is Some(Value::Null), as in Node.
    pub fn get(&self, key: &str) -> DbResult<Option<Value>> {
        let c = self.reader();
        let mut s = c.prepare_cached("SELECT value FROM settings WHERE key = ?")?;
        let text: Option<String> = one(s.query_row([key], |r| r.get(0)))?;
        Ok(text.and_then(|t| parse(&t)))
    }

    /// db.get(key, fallback)
    pub fn get_or(&self, key: &str, fallback: Value) -> DbResult<Value> {
        Ok(self.get(key)?.unwrap_or(fallback))
    }

    /// The value as a type (None: missing, not JSON, or another shape).
    pub fn get_as<T: serde::de::DeserializeOwned>(&self, key: &str) -> DbResult<Option<T>> {
        Ok(self.get(key)?.and_then(|v| serde_json::from_value(v).ok()))
    }

    pub fn set(&self, key: &str, value: &Value) -> DbResult<()> {
        set_on(&self.conn(), key, value)?;
        Ok(())
    }

    pub fn del(&self, key: &str) -> DbResult<()> {
        self.conn().execute("DELETE FROM settings WHERE key = ?", [key])?;
        Ok(())
    }

    // ---- users / sessions
    pub fn get_user(&self, username: &str) -> DbResult<Option<User>> {
        let c = self.reader();
        let mut s = c.prepare_cached("SELECT * FROM users WHERE username = ?")?;
        Ok(one(s.query_row([username], |r| Ok(User { username: r.get("username")?, salt: r.get("salt")?, hash: r.get("hash")?, created_at: r.get("created_at")? })))?)
    }

    pub fn user_count(&self) -> DbResult<i64> {
        Ok(self.reader().query_row("SELECT COUNT(*) AS n FROM users", [], |r| r.get(0))?)
    }

    pub fn put_user(&self, username: &str, salt: &str, hash: &str) -> DbResult<()> {
        put_user_on(&self.conn(), username, salt, hash)?;
        Ok(())
    }

    /// A user and the settings that go with it (its account record), kept together or not at all.
    pub fn put_user_with(&self, username: &str, salt: &str, hash: &str, settings: &[(&str, &Value)]) -> DbResult<()> {
        self.tx(|c| {
            put_user_on(c, username, salt, hash)?;
            for (k, v) in settings {
                set_on(c, k, v)?;
            }
            Ok(())
        })?;
        Ok(())
    }

    pub fn add_session(&self, token_hash: &str, username: &str, expires_at: i64, agent: Option<&str>, ip: Option<&str>) -> DbResult<()> {
        let now = now_ms();
        self.conn().execute(
            "INSERT INTO sessions (token_hash, username, created_at, expires_at, agent, ip, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![token_hash, username, now, expires_at, agent, ip, now],
        )?;
        Ok(())
    }

    /// A session was used: when and from where (kept at most once a minute).
    pub fn touch_session(&self, token_hash: &str, ip: Option<&str>) -> DbResult<()> {
        let now = now_ms();
        self.conn().execute(
            "UPDATE sessions SET seen_at = ?, ip = COALESCE(?, ip) WHERE token_hash = ? AND (seen_at IS NULL OR seen_at < ?)",
            params![now, ip, token_hash, now - 60_000],
        )?;
        Ok(())
    }

    pub fn sessions_for(&self, username: &str) -> DbResult<Vec<Session>> {
        let c = self.reader();
        let mut s = c.prepare_cached(
            "SELECT token_hash, created_at, expires_at, agent, ip, seen_at FROM sessions WHERE username = ? AND expires_at > ? ORDER BY COALESCE(seen_at, created_at) DESC",
        )?;
        let rows = all(s.query_map(params![username, now_ms()], session_row)?)?;
        Ok(rows.into_iter().map(|mut x| {
            x.username = username.to_string();
            x
        }).collect())
    }

    /// (username, created_at), oldest first
    pub fn list_users(&self) -> DbResult<Vec<(String, i64)>> {
        let c = self.reader();
        let mut s = c.prepare_cached("SELECT username, created_at FROM users ORDER BY created_at")?;
        let rows = all(s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?)?;
        Ok(rows)
    }

    /// The account and its sessions, together or not at all.
    pub fn delete_user(&self, username: &str) -> DbResult<()> {
        self.delete_user_with(username, &[])
    }

    /// The account, its sessions and the settings written with it (its account record cleared),
    /// together or not at all.
    pub fn delete_user_with(&self, username: &str, settings: &[(&str, &Value)]) -> DbResult<()> {
        self.tx(|c| {
            c.execute("DELETE FROM users WHERE username = ?", [username])?;
            c.execute("DELETE FROM sessions WHERE username = ?", [username])?;
            for (k, v) in settings {
                set_on(c, k, v)?;
            }
            Ok(())
        })?;
        Ok(())
    }

    pub fn get_session(&self, token_hash: &str) -> DbResult<Option<Session>> {
        let c = self.reader();
        let mut s = c.prepare_cached("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?")?;
        Ok(one(s.query_row(params![token_hash, now_ms()], session_row))?)
    }

    pub fn delete_session(&self, token_hash: &str) -> DbResult<()> {
        self.conn().execute("DELETE FROM sessions WHERE token_hash = ?", [token_hash])?;
        Ok(())
    }

    pub fn delete_sessions_for(&self, username: &str) -> DbResult<()> {
        self.conn().execute("DELETE FROM sessions WHERE username = ?", [username])?;
        Ok(())
    }

    pub fn prune_sessions(&self) -> DbResult<()> {
        self.conn().execute("DELETE FROM sessions WHERE expires_at <= ?", [now_ms()])?;
        Ok(())
    }

    // ---- protected clips
    pub fn protected_set(&self, vehicle_id: &str) -> DbResult<std::collections::HashSet<String>> {
        let c = self.reader();
        let mut s = c.prepare_cached("SELECT rel FROM protected WHERE vehicle_id = ?")?;
        let rows = all(s.query_map([vehicle_id], |r| r.get::<_, String>(0))?)?;
        Ok(rows.into_iter().collect())
    }

    pub fn set_protected(&self, vehicle_id: &str, rels: &[String], on: bool) -> DbResult<()> {
        self.tx(|c| {
            for rel in rels {
                if on {
                    c.execute("INSERT OR IGNORE INTO protected (vehicle_id, rel, created_at) VALUES (?, ?, ?)", params![vehicle_id, rel, now_ms()])?;
                } else {
                    c.execute("DELETE FROM protected WHERE vehicle_id = ? AND rel = ?", params![vehicle_id, rel])?;
                }
            }
            Ok(())
        })?;
        Ok(())
    }

    pub fn rename_protected(&self, vehicle_id: &str, from_rel: &str, to_rel: &str) -> DbResult<()> {
        self.conn().execute("UPDATE OR IGNORE protected SET rel = ? WHERE vehicle_id = ? AND rel = ?", params![to_rel, vehicle_id, from_rel])?;
        Ok(())
    }

    // ---- recycle bin
    pub fn add_bin_item(&self, item: &BinItem) -> DbResult<()> {
        self.conn().execute(
            "INSERT INTO bin_items (id, vehicle_id, label, category, start_at, bytes, files, trashed_at, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![item.id, item.vehicle_id, item.label, item.category, item.start_at, item.bytes, item.files.to_string(), item.trashed_at, item.reason],
        )?;
        Ok(())
    }

    pub fn bin_items(&self, vehicle_id: Option<&str>) -> DbResult<Vec<BinItem>> {
        let c = self.reader();
        let out = match vehicle_id {
            Some(v) if !v.is_empty() => {
                let mut s = c.prepare_cached("SELECT * FROM bin_items WHERE vehicle_id = ? ORDER BY trashed_at DESC")?;
                let rows = all(s.query_map([v], bin_row)?)?;
                rows
            }
            _ => {
                let mut s = c.prepare_cached("SELECT * FROM bin_items ORDER BY trashed_at DESC")?;
                let rows = all(s.query_map([], bin_row)?)?;
                rows
            }
        };
        Ok(out)
    }

    pub fn bin_item(&self, id: &str) -> DbResult<Option<BinItem>> {
        let c = self.reader();
        let mut s = c.prepare_cached("SELECT * FROM bin_items WHERE id = ?")?;
        Ok(one(s.query_row([id], bin_row))?)
    }

    pub fn remove_bin_item(&self, id: &str) -> DbResult<()> {
        self.conn().execute("DELETE FROM bin_items WHERE id = ?", [id])?;
        Ok(())
    }

    pub fn update_bin_files(&self, id: &str, files: &Value, bytes: i64) -> DbResult<()> {
        self.conn().execute("UPDATE bin_items SET files = ?, bytes = ? WHERE id = ?", params![files.to_string(), bytes, id])?;
        Ok(())
    }

    // ---- jobs
    /// The job's id: the row it was given, or the one its external id already has. One transaction:
    /// a read sees the job cleared or listed, never neither; an error (no id) when it failed.
    pub fn start_job(&self, j: &NewJob) -> DbResult<i64> {
        Ok(self.tx(|c| {
            if let Some(ext) = j.external_id.as_deref().filter(|e| !e.is_empty()) {
                if let Some(id) = one(c.query_row("SELECT id FROM jobs WHERE external_id = ?", [ext], |r| r.get::<_, i64>(0)))? {
                    return Ok(id);
                }
                // cleared before, running again: it is on the list once more
                c.execute("DELETE FROM jobs_cleared WHERE external_id = ?", [ext])?;
            }
            c.execute(
                "INSERT INTO jobs (type, vehicle_id, status, title, detail, started_at, external_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
                params![j.kind, j.vehicle_id, "running", j.title, j.detail, now_ms(), j.external_id],
            )?;
            Ok(c.last_insert_rowid())
        })?)
    }

    /// A job that is no longer there is left as it is (Ok).
    pub fn update_job(&self, id: i64, u: &JobUpdate) -> DbResult<()> {
        let c = self.conn();
        let row = one(c.query_row("SELECT * FROM jobs WHERE id = ?", [id], |r| {
            Ok((r.get::<_, String>("status")?, r.get::<_, Option<String>>("detail")?, r.get::<_, Option<String>>("result")?, r.get::<_, Option<i64>>("finished_at")?))
        }))?;
        let Some((status, detail, result, finished_at)) = row else { return Ok(()) };
        c.execute(
            "UPDATE jobs SET status = ?, detail = ?, result = ?, finished_at = ? WHERE id = ?",
            params![
                u.status.clone().unwrap_or(status),
                u.detail.clone().or(detail),
                match &u.result {
                    Some(v) => Some(v.to_string()),
                    None => result,
                },
                if u.finished { Some(now_ms()) } else { finished_at },
                id
            ],
        )?;
        Ok(())
    }

    pub fn job_by_external(&self, external_id: &str) -> DbResult<Option<Job>> {
        let c = self.reader();
        let mut s = c.prepare_cached("SELECT * FROM jobs WHERE external_id = ?")?;
        Ok(one(s.query_row([external_id], job_row))?)
    }

    pub fn jobs(&self, limit: i64, vehicle_id: Option<&str>) -> DbResult<Vec<Job>> {
        let c = self.reader();
        let out = match vehicle_id {
            Some(v) if !v.is_empty() => {
                let mut s = c.prepare_cached("SELECT * FROM jobs WHERE vehicle_id = ? OR vehicle_id IS NULL ORDER BY id DESC LIMIT ?")?;
                let rows = all(s.query_map(params![v, limit], job_row)?)?;
                rows
            }
            _ => {
                let mut s = c.prepare_cached("SELECT * FROM jobs ORDER BY id DESC LIMIT ?")?;
                let rows = all(s.query_map(params![limit], job_row)?)?;
                rows
            }
        };
        Ok(out)
    }

    pub fn trim_jobs(&self, keep: i64) -> DbResult<()> {
        self.conn().execute("DELETE FROM jobs WHERE status != 'running' AND id <= (SELECT MAX(id) FROM jobs) - ?", [keep])?;
        Ok(())
    }

    /// (id, external id) of the jobs Clear jobs takes off the list (db.js finishedJobs).
    pub fn finished_jobs(&self, vehicle_id: Option<&str>, keep_external: &[String]) -> DbResult<Vec<(i64, Option<String>)>> {
        let c = self.reader();
        Ok(finished_on(&c, vehicle_id, keep_external)?)
    }

    /// Clear jobs: only these rows go; a cleared conversion is remembered. Returns how many left the list.
    pub fn clear_jobs(&self, vehicle_id: Option<&str>, keep_external: &[String]) -> DbResult<usize> {
        Ok(self.tx(|c| {
            let gone = finished_on(c, vehicle_id, keep_external)?;
            let at = now_ms();
            for (id, ext) in &gone {
                if let Some(ext) = ext.as_deref().filter(|e| !e.is_empty()) {
                    c.execute(
                        "INSERT INTO jobs_cleared (external_id, cleared_at) VALUES (?, ?) ON CONFLICT(external_id) DO UPDATE SET cleared_at = excluded.cleared_at",
                        params![ext, at],
                    )?;
                }
                c.execute("DELETE FROM jobs WHERE id = ?", [id])?;
            }
            c.execute(
                "DELETE FROM jobs_cleared WHERE external_id NOT IN (SELECT external_id FROM jobs_cleared ORDER BY cleared_at DESC, rowid DESC LIMIT ?)",
                [CLEARED_KEPT],
            )?;
            Ok(gone.len())
        })?)
    }

    pub fn job_cleared(&self, external_id: &str) -> DbResult<bool> {
        Ok(one(self.reader().query_row("SELECT 1 AS x FROM jobs_cleared WHERE external_id = ?", [external_id], |_| Ok(())))?.is_some())
    }

    /// At start: jobs of this process that a restart stopped are interrupted (conversions are the converter's).
    pub fn interrupt_jobs(&self) -> DbResult<usize> {
        Ok(self.conn().execute(
            "UPDATE jobs SET status = 'interrupted', finished_at = ?,
      detail = CASE WHEN detail IS NULL OR detail = '' THEN 'stopped by a restart' ELSE detail || ' · stopped by a restart' END
      WHERE status = 'running' AND type != 'conversion'",
            [now_ms()],
        )?)
    }

    // ---- notifications
    /// Open (or refresh) a notification; one open entry per dedupe key (db.js notify).
    pub fn notify(&self, n: &NewNotification) -> DbResult<i64> {
        let now = now_ms();
        let level = n.level.clone().unwrap_or_else(|| "warning".into());
        let c = self.conn();
        let mut changed = true;
        let mut out = None;
        if let Some(key) = n.dedupe_key.as_deref().filter(|k| !k.is_empty()) {
            if let Some(id) = one(c.query_row("SELECT id FROM notifications WHERE dedupe_key = ? AND resolved_at IS NULL", [key], |r| r.get::<_, i64>(0)))? {
                let ch = c.execute(
                    "UPDATE notifications SET level = ?, title = ?, message = ?, updated_at = ? WHERE id = ? AND (level IS NOT ? OR title IS NOT ? OR message IS NOT ?)",
                    params![level, n.title, n.message, now, id, level, n.title, n.message],
                )?;
                changed = ch > 0;
                out = Some(id);
            }
        }
        let id = match out {
            Some(id) => id,
            None => {
                c.execute(
                    "INSERT INTO notifications (kind, level, vehicle_id, title, message, created_at, updated_at, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    params![n.kind, level, n.vehicle_id, n.title, n.message, now, now, n.dedupe_key],
                )?;
                c.last_insert_rowid()
            }
        };
        *self.last_notify_changed.lock().unwrap() = changed;
        Ok(id)
    }

    pub fn last_notify_changed(&self) -> bool {
        *self.last_notify_changed.lock().unwrap()
    }

    pub fn resolve(&self, dedupe_key: &str) -> DbResult<()> {
        self.conn().execute("UPDATE notifications SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL", params![now_ms(), dedupe_key])?;
        Ok(())
    }

    /// Close every open notification whose key starts with `prefix`.
    pub fn resolve_prefix(&self, prefix: &str) -> DbResult<()> {
        let mut like = String::new();
        for ch in prefix.chars() {
            if matches!(ch, '\\' | '%' | '_') {
                like.push('\\');
            }
            like.push(ch);
        }
        like.push('%');
        self.conn().execute("UPDATE notifications SET resolved_at = ? WHERE resolved_at IS NULL AND dedupe_key LIKE ? ESCAPE '\\'", params![now_ms(), like])?;
        Ok(())
    }

    pub fn resolve_id(&self, id: i64) -> DbResult<()> {
        let now = now_ms();
        self.conn().execute("UPDATE notifications SET resolved_at = COALESCE(resolved_at, ?), read_at = COALESCE(read_at, ?) WHERE id = ?", params![now, now, id])?;
        Ok(())
    }

    pub fn mark_read(&self, ids: &[i64]) -> DbResult<()> {
        self.tx(|c| {
            for id in ids {
                c.execute("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?", params![now_ms(), id])?;
            }
            Ok(())
        })?;
        Ok(())
    }

    /// db.js notifications({ open, limit, vehicleId }), as its JSON rows.
    pub fn notifications(&self, open: bool, limit: i64, vehicle_id: Option<&str>) -> DbResult<Vec<Value>> {
        let mut sql = String::from("SELECT * FROM notifications WHERE 1 = 1");
        let mut args: Vec<rusqlite::types::Value> = Vec::new();
        if open {
            sql.push_str(" AND resolved_at IS NULL");
        }
        if let Some(v) = vehicle_id.filter(|v| !v.is_empty()) {
            sql.push_str(" AND (vehicle_id = ? OR vehicle_id IS NULL)");
            args.push(v.to_string().into());
        }
        sql.push_str(" ORDER BY (resolved_at IS NULL) DESC, updated_at DESC LIMIT ?");
        args.push(limit.into());
        let c = self.reader();
        let mut s = c.prepare(&sql)?;
        let rows = s.query_map(rusqlite::params_from_iter(args), |r| {
            Ok(json!({
                "id": r.get::<_, i64>("id")?, "kind": r.get::<_, String>("kind")?, "level": r.get::<_, String>("level")?,
                "vehicleId": r.get::<_, Option<String>>("vehicle_id")?, "title": r.get::<_, String>("title")?, "message": r.get::<_, Option<String>>("message")?,
                "createdAt": r.get::<_, i64>("created_at")?, "updatedAt": r.get::<_, i64>("updated_at")?,
                "resolvedAt": r.get::<_, Option<i64>>("resolved_at")?, "readAt": r.get::<_, Option<i64>>("read_at")?,
                "dedupeKey": r.get::<_, Option<String>>("dedupe_key")?
            }))
        })?;
        Ok(all(rows)?)
    }
}

fn set_on(c: &Connection, key: &str, value: &Value) -> rusqlite::Result<()> {
    c.prepare_cached("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")?.execute(params![key, value.to_string()])?;
    Ok(())
}

fn put_user_on(c: &Connection, username: &str, salt: &str, hash: &str) -> rusqlite::Result<()> {
    c.execute(
        "INSERT INTO users (username, salt, hash, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET salt = excluded.salt, hash = excluded.hash",
        params![username, salt, hash, now_ms()],
    )?;
    Ok(())
}

fn finished_on(c: &Connection, vehicle_id: Option<&str>, keep_external: &[String]) -> rusqlite::Result<Vec<(i64, Option<String>)>> {
    let map = |r: &Row| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?));
    let rows = match vehicle_id {
        Some(v) if !v.is_empty() => {
            let mut s = c.prepare_cached("SELECT id, external_id FROM jobs WHERE status != 'running' AND (vehicle_id = ? OR vehicle_id IS NULL)")?;
            let rows = all(s.query_map([v], map)?)?;
            rows
        }
        _ => {
            let mut s = c.prepare_cached("SELECT id, external_id FROM jobs WHERE status != 'running'")?;
            let rows = all(s.query_map([], map)?)?;
            rows
        }
    };
    Ok(rows.into_iter().filter(|(_, ext)| !matches!(ext.as_deref(), Some(e) if !e.is_empty() && keep_external.iter().any(|k| k == e))).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_read_does_not_wait_for_a_write_that_waits_for_another_connection() {
        let dir = std::env::temp_dir().join(format!("lean-db-read-{}-{}", std::process::id(), now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        let db = std::sync::Arc::new(Db::open(&dir.join("manager.db")).unwrap());
        db.put_user("a", "s", "h").unwrap();
        db.add_session("t1", "a", now_ms() + 60_000, None, None).unwrap();
        db.set("x", &json!(1)).unwrap();
        // another connection (the footage catalog's) holds the write lock, and a write here waits for it
        let other = Connection::open(dir.join("manager.db")).unwrap();
        other.execute_batch("BEGIN IMMEDIATE").unwrap();
        let writer = {
            let db = db.clone();
            std::thread::spawn(move || db.set("x", &json!(2)))
        };
        let began = std::time::Instant::now();
        while db.conn.try_lock().is_ok() {
            assert!(began.elapsed() < std::time::Duration::from_secs(2), "the write never started");
            std::thread::yield_now();
        }
        let began = std::time::Instant::now();
        assert_eq!(db.get_session("t1").unwrap().map(|s| s.username), Some("a".into()));
        assert_eq!(db.get("x").unwrap(), Some(json!(1)));
        assert!(db.get_user("a").unwrap().is_some());
        assert_eq!((db.user_count().unwrap(), db.sessions_for("a").unwrap().len(), db.list_users().unwrap().len()), (1, 1, 1));
        assert!(db.jobs(10, None).unwrap().is_empty() && db.notifications(true, 10, None).unwrap().is_empty());
        assert!(began.elapsed() < std::time::Duration::from_secs(1), "the reads waited {:?}", began.elapsed());
        other.execute_batch("ROLLBACK").unwrap();
        writer.join().unwrap().unwrap();
        assert_eq!(db.get("x").unwrap(), Some(json!(2)), "the write went through once the lock was free");
        drop(other);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_quick_check_waits_for_neither_shared_connection() {
        let dir = std::env::temp_dir().join(format!("lean-db-quick-{}-{}", std::process::id(), now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        let db = std::sync::Arc::new(Db::open(&dir.join("manager.db")).unwrap());
        db.set("x", &json!(1)).unwrap();
        let held = (db.conn.lock().unwrap(), db.read.as_ref().unwrap().lock().unwrap());
        let (tx, rx) = std::sync::mpsc::channel();
        {
            let db = db.clone();
            std::thread::spawn(move || {
                let _ = tx.send(db.quick_check());
            });
        }
        let got = rx.recv_timeout(std::time::Duration::from_secs(3));
        drop(held);
        assert_eq!(got.expect("it waited for a shared connection").unwrap(), "ok");
        // the file gone (the server's connections still open): an error, and nothing made
        for f in ["manager.db", "manager.db-wal", "manager.db-shm"] {
            let _ = std::fs::remove_file(dir.join(f));
        }
        assert!(db.quick_check().is_err());
        assert!(!dir.join("manager.db").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_job_that_cannot_be_listed_stays_cleared() {
        let db = Db::memory().unwrap();
        db.conn().execute("INSERT INTO jobs_cleared (external_id, cleared_at) VALUES ('converter:1', 1)", []).unwrap();
        // (the insert fails: the clear-marker stays, and no job id comes back)
        db.conn().execute_batch("CREATE TEMP TRIGGER refused BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'refused'); END;").unwrap();
        let job = NewJob { kind: "convert".into(), vehicle_id: None, title: "t".into(), detail: None, external_id: Some("converter:1".into()) };
        assert!(db.start_job(&job).is_err());
        assert!(db.job_cleared("converter:1").unwrap());
        db.conn().execute_batch("DROP TRIGGER refused").unwrap();
        let id = db.start_job(&job).unwrap();
        assert!(id > 0 && !db.job_cleared("converter:1").unwrap() && db.job_by_external("converter:1").unwrap().map(|j| j.id) == Some(id));
    }

    #[test]
    fn settings_round_trip_and_null() {
        let db = Db::memory().unwrap();
        assert_eq!(db.get("x").unwrap(), None);
        db.set("x", &json!({ "a": [1, 2] })).unwrap();
        assert_eq!(db.get("x").unwrap(), Some(json!({ "a": [1, 2] })));
        db.set("x", &Value::Null).unwrap();
        assert_eq!(db.get_or("x", json!([])).unwrap(), Value::Null);
        db.conn().execute("INSERT INTO settings (key, value) VALUES ('bad', '{nope')", []).unwrap();
        assert_eq!(db.get_or("bad", json!(7)).unwrap(), json!(7));
        db.del("x").unwrap();
        assert_eq!(db.get("x").unwrap(), None);
    }

    #[test]
    fn jobs_external_clear_and_interrupt() {
        let db = Db::memory().unwrap();
        let a = db.start_job(&NewJob { kind: "scan".into(), title: "Scan".into(), vehicle_id: Some("car".into()), ..Default::default() }).unwrap();
        let b = db.start_job(&NewJob { kind: "conversion".into(), title: "Convert".into(), external_id: Some("converter:1".into()), ..Default::default() }).unwrap();
        assert_eq!(db.start_job(&NewJob { kind: "conversion".into(), title: "again".into(), external_id: Some("converter:1".into()), ..Default::default() }).unwrap(), b);
        db.update_job(b, &JobUpdate { status: Some("done".into()), result: Some(json!({ "ok": true })), finished: true, ..Default::default() }).unwrap();
        let j = db.job_by_external("converter:1").unwrap().unwrap();
        assert_eq!(j.status, "done");
        assert_eq!(j.result, json!({ "ok": true }));
        assert!(j.finished_at.is_some());
        assert_eq!(db.finished_jobs(None, &[]).unwrap().len(), 1);
        assert_eq!(db.finished_jobs(None, &["converter:1".into()]).unwrap().len(), 0);
        assert_eq!(db.clear_jobs(Some("car"), &[]).unwrap(), 1);
        assert!(db.job_cleared("converter:1").unwrap());
        // running again: back on the list
        db.start_job(&NewJob { kind: "conversion".into(), title: "x".into(), external_id: Some("converter:1".into()), ..Default::default() }).unwrap();
        assert!(!db.job_cleared("converter:1").unwrap());
        assert_eq!(db.interrupt_jobs().unwrap(), 1);
        let rows = db.jobs(200, None).unwrap();
        let scan = rows.iter().find(|r| r.id == a).unwrap();
        assert_eq!(scan.status, "interrupted");
        assert_eq!(scan.detail.as_deref(), Some("stopped by a restart"));
    }

    #[test]
    fn notifications_dedupe() {
        let db = Db::memory().unwrap();
        let n = NewNotification { kind: "share".into(), title: "down".into(), dedupe_key: Some("share:a".into()), ..Default::default() };
        let id = db.notify(&n).unwrap();
        assert!(db.last_notify_changed());
        assert_eq!(db.notify(&n).unwrap(), id);
        assert!(!db.last_notify_changed());
        assert_eq!(db.notify(&NewNotification { message: Some("more".into()), ..n.clone() }).unwrap(), id);
        assert!(db.last_notify_changed());
        db.resolve_prefix("share:").unwrap();
        assert!(db.notifications(true, 200, None).unwrap().is_empty());
        let all = db.notifications(false, 200, None).unwrap();
        assert_eq!(all[0]["level"], "warning");
        assert!(all[0]["resolvedAt"].is_i64());
    }

    #[test]
    fn sessions() {
        let db = Db::memory().unwrap();
        db.put_user("a", "s", "h").unwrap();
        db.add_session("t1", "a", now_ms() + 1000, Some("agent"), Some("10.0.0.1")).unwrap();
        db.add_session("t0", "a", now_ms() - 1, None, None).unwrap();
        assert_eq!(db.sessions_for("a").unwrap().len(), 1);
        assert!(db.get_session("t0").unwrap().is_none());
        db.prune_sessions().unwrap();
        assert_eq!(db.conn().query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        db.delete_user("a").unwrap();
        assert!(db.get_session("t1").unwrap().is_none());
    }

    /// A manager.db file of its own (the folder goes when the test is done).
    struct FileDb {
        dir: std::path::PathBuf,
        db: Db,
    }

    impl FileDb {
        fn new(name: &str) -> FileDb {
            let dir = std::env::temp_dir().join(format!("lean-db-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            let db = Db::open(&dir.join("manager.db")).unwrap();
            FileDb { dir, db }
        }
        /// Another connection to the same file (Node's server, a backup, a second process).
        fn other(&self) -> Connection {
            Connection::open(self.dir.join("manager.db")).unwrap()
        }
    }

    impl Drop for FileDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn code(e: &DbError) -> Option<rusqlite::ErrorCode> {
        e.0.sqlite_error_code()
    }

    #[test]
    fn a_missing_setting_is_none_and_a_failed_read_is_an_error() {
        let t = FileDb::new("read");
        let db = &t.db;
        db.set("kept", &json!({ "on": true })).unwrap();
        assert_eq!(db.get("missing").unwrap(), None);
        assert_eq!(db.get_or("missing", json!(7)).unwrap(), json!(7));
        assert_eq!(db.get_as::<Vec<i64>>("kept").unwrap(), None, "another shape is still None");
        assert_eq!(db.get_user("nobody").unwrap(), None);
        assert_eq!(db.get_session("nothing").unwrap(), None);
        assert_eq!(db.bin_item("none").unwrap(), None);
        assert_eq!(db.job_by_external("converter:none").unwrap(), None);
        // damaged storage: the tables are gone
        for t in ["settings", "users", "sessions", "bin_items", "jobs", "jobs_cleared", "protected", "notifications"] {
            db.conn().execute_batch(&format!("DROP TABLE {t}")).unwrap();
        }
        assert!(db.get("kept").is_err(), "a failed read is not a missing setting");
        assert!(db.get_or("kept", json!(7)).is_err(), "nor the fallback");
        assert!(db.get_as::<Value>("kept").is_err());
        assert!(db.get_user("nobody").is_err(), "nor a missing user");
        assert!(db.user_count().is_err(), "nor no accounts at all");
        assert!(db.list_users().is_err());
        assert!(db.get_session("nothing").is_err(), "nor a signed-out session");
        assert!(db.sessions_for("a").is_err());
        assert!(db.protected_set("car").is_err(), "nor nothing protected");
        assert!(db.bin_items(Some("car")).is_err(), "nor an empty Recycle Bin");
        assert!(db.bin_item("none").is_err());
        assert!(db.jobs(10, None).is_err());
        assert!(db.job_by_external("converter:none").is_err());
        assert!(db.job_cleared("converter:none").is_err());
        assert!(db.notifications(true, 10, None).is_err());
        assert!(db.get("kept").unwrap_err().to_string().starts_with("manager.db: "));
    }

    #[test]
    fn a_read_only_database_fails_every_write_and_keeps_what_was_there() {
        let t = FileDb::new("readonly");
        let db = &t.db;
        db.set("theme", &json!("dark")).unwrap();
        db.put_user("a", "s", "h").unwrap();
        db.add_session("t1", "a", now_ms() + 60_000, None, None).unwrap();
        let job = db.start_job(&NewJob { kind: "scan".into(), title: "Scan".into(), ..Default::default() }).unwrap();
        db.conn().execute_batch("PRAGMA query_only = ON").unwrap();
        let e = db.set("theme", &json!("light")).unwrap_err();
        assert_eq!(code(&e), Some(rusqlite::ErrorCode::ReadOnly));
        assert!(db.del("theme").is_err());
        assert!(db.put_user("b", "s", "h").is_err());
        assert!(db.add_session("t2", "a", now_ms() + 60_000, None, None).is_err(), "a sign-in that was not kept is not a session");
        assert!(db.touch_session("t1", Some("10.0.0.2")).is_err());
        assert!(db.delete_session("t1").is_err(), "a sign-out that was not kept");
        assert!(db.delete_sessions_for("a").is_err());
        assert!(db.delete_user("a").is_err());
        assert!(db.prune_sessions().is_err());
        assert!(db.set_protected("car", &["a.mp4".into()], true).is_err());
        assert!(db.rename_protected("car", "a.mp4", "b.mp4").is_err());
        let item = BinItem { id: "i".into(), vehicle_id: "car".into(), label: "x".into(), category: "sentry".into(), start_at: None, bytes: 1, files: json!([]), trashed_at: 1, reason: "manual".into() };
        assert!(db.add_bin_item(&item).is_err());
        assert!(db.remove_bin_item("i").is_err());
        assert!(db.update_bin_files("i", &json!([]), 0).is_err());
        assert!(db.start_job(&NewJob { kind: "scan".into(), title: "Scan".into(), ..Default::default() }).is_err(), "no job id for a job that was not kept");
        assert!(db.update_job(job, &JobUpdate { status: Some("done".into()), finished: true, ..Default::default() }).is_err(), "a job update that was not kept");
        assert!(db.trim_jobs(0).is_err());
        assert!(db.clear_jobs(None, &[]).is_err());
        assert!(db.interrupt_jobs().is_err());
        assert!(db.notify(&NewNotification { kind: "share".into(), title: "x".into(), ..Default::default() }).is_err());
        assert!(db.resolve("k").is_err());
        assert!(db.resolve_prefix("k").is_err());
        assert!(db.resolve_id(1).is_err());
        assert!(db.mark_read(&[1]).is_err());
        // reads still answer, and nothing changed
        db.conn().execute_batch("PRAGMA query_only = OFF").unwrap();
        assert_eq!(db.get("theme").unwrap(), Some(json!("dark")));
        assert_eq!(db.list_users().unwrap().len(), 1);
        assert!(db.get_session("t1").unwrap().is_some());
        assert_eq!(db.jobs(10, None).unwrap()[0].status, "running");
        assert!(db.get("missing").unwrap().is_none());
    }

    #[test]
    fn a_write_while_another_connection_holds_the_write_lock_fails_busy_and_reads_go_on() {
        let t = FileDb::new("busy");
        let db = &t.db;
        db.set("theme", &json!("dark")).unwrap();
        db.conn().busy_timeout(std::time::Duration::from_millis(50)).unwrap();
        let other = t.other();
        other.execute_batch("BEGIN IMMEDIATE; INSERT INTO settings (key, value) VALUES ('other', '1')").unwrap();
        let e = db.set("theme", &json!("light")).unwrap_err();
        assert_eq!(code(&e), Some(rusqlite::ErrorCode::DatabaseBusy));
        assert!(db.start_job(&NewJob { kind: "scan".into(), title: "Scan".into(), ..Default::default() }).is_err());
        // (WAL: the readers are not held up; a missing row is still just missing)
        assert_eq!(db.get("theme").unwrap(), Some(json!("dark")));
        assert_eq!(db.get("missing").unwrap(), None);
        other.execute_batch("ROLLBACK").unwrap();
        db.set("theme", &json!("light")).unwrap();
        assert_eq!(db.get("theme").unwrap(), Some(json!("light")));
    }

    #[test]
    fn a_commit_that_fails_is_rolled_back_so_later_writes_are_kept() {
        let t = FileDb::new("commit");
        let db = &t.db;
        // (a deferred foreign key is checked at COMMIT: that COMMIT fails and leaves the transaction open)
        db.conn()
            .execute_batch("CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE ch (p INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)")
            .unwrap();
        let r = db.tx(|c| c.execute("INSERT INTO ch (p) VALUES (5)", []));
        assert!(r.is_err());
        assert!(db.conn().is_autocommit(), "no transaction is left open");
        db.set("after", &json!(1)).unwrap();
        assert_eq!(t.other().query_row("SELECT value FROM settings WHERE key = 'after'", [], |r| r.get::<_, String>(0)).unwrap(), "1", "the next write is kept");
    }

    #[test]
    fn rows_that_do_not_fit_are_left_out_as_before_without_failing_the_list() {
        let db = Db::memory().unwrap();
        db.conn()
            .execute_batch(
                "INSERT INTO bin_items (id, vehicle_id, label, category, start_at, bytes, files, trashed_at, reason) VALUES ('ok', 'car', 'a', 'sentry', NULL, 1, '[]', 2, 'manual');
                 INSERT INTO bin_items (id, vehicle_id, label, category, start_at, bytes, files, trashed_at, reason) VALUES ('odd', 'car', 'b', 'sentry', NULL, 'many', '[]', 1, 'manual');",
            )
            .unwrap();
        let ids: Vec<String> = db.bin_items(Some("car")).unwrap().into_iter().map(|b| b.id).collect();
        assert_eq!(ids, vec!["ok"]);
        assert_eq!(db.bin_item("odd").unwrap(), None);
    }
}
