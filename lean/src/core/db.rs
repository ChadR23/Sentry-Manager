//! `DATA/manager.db`: the same SQLite file, schema and queries as
//! server/db.js (and the catalog tables of server/catalog.js), so the Node
//! server and this one can take turns on one database: settings, users,
//! sessions, protected clips, Recycle Bin items, jobs, notifications, stars
//! (a setting) and the footage catalog all carry over, both ways.
//!
//! Only `CREATE ... IF NOT EXISTS` and the same `ALTER TABLE ... ADD COLUMN`
//! as Node: nothing here changes a table Node made, and every table made
//! here is one Node makes the same way.

use rusqlite::{params, Connection, OptionalExtension, Row};
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

fn parse(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
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
    /// The stored value; None when there is no row or it is not JSON (db.js get's fallback).
    /// A stored `null` is Some(Value::Null), as in Node.
    pub fn get(&self, key: &str) -> Option<Value> {
        let c = self.reader();
        let text: Option<String> =
            c.prepare_cached("SELECT value FROM settings WHERE key = ?").and_then(|mut s| s.query_row([key], |r| r.get(0)).optional()).ok().flatten();
        text.and_then(|t| parse(&t))
    }

    /// db.get(key, fallback)
    pub fn get_or(&self, key: &str, fallback: Value) -> Value {
        self.get(key).unwrap_or(fallback)
    }

    /// The value as a type (None: missing, not JSON, or another shape).
    pub fn get_as<T: serde::de::DeserializeOwned>(&self, key: &str) -> Option<T> {
        self.get(key).and_then(|v| serde_json::from_value(v).ok())
    }

    pub fn set(&self, key: &str, value: &Value) {
        let c = self.conn();
        let _ = c
            .prepare_cached("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .and_then(|mut s| s.execute(params![key, value.to_string()]));
    }

    pub fn del(&self, key: &str) {
        let _ = self.conn().execute("DELETE FROM settings WHERE key = ?", [key]);
    }

    // ---- users / sessions
    pub fn get_user(&self, username: &str) -> Option<User> {
        let c = self.reader();
        c.prepare_cached("SELECT * FROM users WHERE username = ?")
            .and_then(|mut s| {
                s.query_row([username], |r| Ok(User { username: r.get("username")?, salt: r.get("salt")?, hash: r.get("hash")?, created_at: r.get("created_at")? }))
                    .optional()
            })
            .ok()
            .flatten()
    }

    pub fn user_count(&self) -> i64 {
        self.reader().query_row("SELECT COUNT(*) AS n FROM users", [], |r| r.get(0)).unwrap_or(0)
    }

    pub fn put_user(&self, username: &str, salt: &str, hash: &str) {
        let _ = self.conn().execute(
            "INSERT INTO users (username, salt, hash, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET salt = excluded.salt, hash = excluded.hash",
            params![username, salt, hash, now_ms()],
        );
    }

    pub fn add_session(&self, token_hash: &str, username: &str, expires_at: i64, agent: Option<&str>, ip: Option<&str>) {
        let now = now_ms();
        let _ = self.conn().execute(
            "INSERT INTO sessions (token_hash, username, created_at, expires_at, agent, ip, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![token_hash, username, now, expires_at, agent, ip, now],
        );
    }

    /// A session was used: when and from where (kept at most once a minute).
    pub fn touch_session(&self, token_hash: &str, ip: Option<&str>) {
        let now = now_ms();
        let _ = self.conn().execute(
            "UPDATE sessions SET seen_at = ?, ip = COALESCE(?, ip) WHERE token_hash = ? AND (seen_at IS NULL OR seen_at < ?)",
            params![now, ip, token_hash, now - 60_000],
        );
    }

    pub fn sessions_for(&self, username: &str) -> Vec<Session> {
        let c = self.reader();
        let mut s = match c.prepare_cached(
            "SELECT token_hash, created_at, expires_at, agent, ip, seen_at FROM sessions WHERE username = ? AND expires_at > ? ORDER BY COALESCE(seen_at, created_at) DESC",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = s.query_map(params![username, now_ms()], session_row);
        rows.map(|r| r.filter_map(Result::ok).map(|mut x| {
            x.username = username.to_string();
            x
        }).collect()).unwrap_or_default()
    }

    /// (username, created_at), oldest first
    pub fn list_users(&self) -> Vec<(String, i64)> {
        let c = self.reader();
        let mut s = match c.prepare_cached("SELECT username, created_at FROM users ORDER BY created_at") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)));
        rows.map(|r| r.filter_map(Result::ok).collect()).unwrap_or_default()
    }

    /// The user and their sessions, in one transaction: a read never sees a session of a user gone.
    pub fn delete_user(&self, username: &str) {
        let _ = self.tx(|c| {
            c.execute("DELETE FROM users WHERE username = ?", [username])?;
            c.execute("DELETE FROM sessions WHERE username = ?", [username])
        });
    }

    pub fn get_session(&self, token_hash: &str) -> Option<Session> {
        let c = self.reader();
        c.prepare_cached("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?")
            .and_then(|mut s| s.query_row(params![token_hash, now_ms()], session_row).optional())
            .ok()
            .flatten()
    }

    pub fn delete_session(&self, token_hash: &str) {
        let _ = self.conn().execute("DELETE FROM sessions WHERE token_hash = ?", [token_hash]);
    }

    pub fn delete_sessions_for(&self, username: &str) {
        let _ = self.conn().execute("DELETE FROM sessions WHERE username = ?", [username]);
    }

    pub fn prune_sessions(&self) {
        let _ = self.conn().execute("DELETE FROM sessions WHERE expires_at <= ?", [now_ms()]);
    }

    // ---- protected clips
    pub fn protected_set(&self, vehicle_id: &str) -> std::collections::HashSet<String> {
        let c = self.reader();
        let mut s = match c.prepare_cached("SELECT rel FROM protected WHERE vehicle_id = ?") {
            Ok(s) => s,
            Err(_) => return Default::default(),
        };
        let rows = s.query_map([vehicle_id], |r| r.get::<_, String>(0));
        rows.map(|r| r.filter_map(Result::ok).collect()).unwrap_or_default()
    }

    pub fn set_protected(&self, vehicle_id: &str, rels: &[String], on: bool) {
        let _ = self.tx(|c| {
            for rel in rels {
                if on {
                    c.execute("INSERT OR IGNORE INTO protected (vehicle_id, rel, created_at) VALUES (?, ?, ?)", params![vehicle_id, rel, now_ms()])?;
                } else {
                    c.execute("DELETE FROM protected WHERE vehicle_id = ? AND rel = ?", params![vehicle_id, rel])?;
                }
            }
            Ok(())
        });
    }

    pub fn rename_protected(&self, vehicle_id: &str, from_rel: &str, to_rel: &str) {
        let _ = self.conn().execute("UPDATE OR IGNORE protected SET rel = ? WHERE vehicle_id = ? AND rel = ?", params![to_rel, vehicle_id, from_rel]);
    }

    // ---- recycle bin
    pub fn add_bin_item(&self, item: &BinItem) {
        let _ = self.conn().execute(
            "INSERT INTO bin_items (id, vehicle_id, label, category, start_at, bytes, files, trashed_at, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![item.id, item.vehicle_id, item.label, item.category, item.start_at, item.bytes, item.files.to_string(), item.trashed_at, item.reason],
        );
    }

    pub fn bin_items(&self, vehicle_id: Option<&str>) -> Vec<BinItem> {
        let c = self.reader();
        let out = match vehicle_id {
            Some(v) if !v.is_empty() => c
                .prepare_cached("SELECT * FROM bin_items WHERE vehicle_id = ? ORDER BY trashed_at DESC")
                .and_then(|mut s| s.query_map([v], bin_row).map(|r| r.filter_map(Result::ok).collect())),
            _ => c.prepare_cached("SELECT * FROM bin_items ORDER BY trashed_at DESC").and_then(|mut s| s.query_map([], bin_row).map(|r| r.filter_map(Result::ok).collect())),
        };
        out.unwrap_or_default()
    }

    pub fn bin_item(&self, id: &str) -> Option<BinItem> {
        self.reader().prepare_cached("SELECT * FROM bin_items WHERE id = ?").and_then(|mut s| s.query_row([id], bin_row).optional()).ok().flatten()
    }

    pub fn remove_bin_item(&self, id: &str) {
        let _ = self.conn().execute("DELETE FROM bin_items WHERE id = ?", [id]);
    }

    pub fn update_bin_files(&self, id: &str, files: &Value, bytes: i64) {
        let _ = self.conn().execute("UPDATE bin_items SET files = ?, bytes = ? WHERE id = ?", params![files.to_string(), bytes, id]);
    }

    // ---- jobs
    /// One transaction: a read sees the job cleared or listed, never neither; 0 when it failed.
    pub fn start_job(&self, j: &NewJob) -> i64 {
        self.tx(|c| {
            if let Some(ext) = j.external_id.as_deref().filter(|e| !e.is_empty()) {
                if let Some(id) = c.query_row("SELECT id FROM jobs WHERE external_id = ?", [ext], |r| r.get::<_, i64>(0)).optional()? {
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
        })
        .unwrap_or(0)
    }

    pub fn update_job(&self, id: i64, u: &JobUpdate) {
        let c = self.conn();
        let row = c.query_row("SELECT * FROM jobs WHERE id = ?", [id], |r| {
            Ok((r.get::<_, String>("status")?, r.get::<_, Option<String>>("detail")?, r.get::<_, Option<String>>("result")?, r.get::<_, Option<i64>>("finished_at")?))
        });
        let Ok((status, detail, result, finished_at)) = row else { return };
        let _ = c.execute(
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
        );
    }

    pub fn job_by_external(&self, external_id: &str) -> Option<Job> {
        self.reader().prepare_cached("SELECT * FROM jobs WHERE external_id = ?").and_then(|mut s| s.query_row([external_id], job_row).optional()).ok().flatten()
    }

    pub fn jobs(&self, limit: i64, vehicle_id: Option<&str>) -> Vec<Job> {
        let c = self.reader();
        let out = match vehicle_id {
            Some(v) if !v.is_empty() => c
                .prepare_cached("SELECT * FROM jobs WHERE vehicle_id = ? OR vehicle_id IS NULL ORDER BY id DESC LIMIT ?")
                .and_then(|mut s| s.query_map(params![v, limit], job_row).map(|r| r.filter_map(Result::ok).collect())),
            _ => c
                .prepare_cached("SELECT * FROM jobs ORDER BY id DESC LIMIT ?")
                .and_then(|mut s| s.query_map(params![limit], job_row).map(|r| r.filter_map(Result::ok).collect())),
        };
        out.unwrap_or_default()
    }

    pub fn trim_jobs(&self, keep: i64) {
        let _ = self.conn().execute("DELETE FROM jobs WHERE status != 'running' AND id <= (SELECT MAX(id) FROM jobs) - ?", [keep]);
    }

    /// (id, external id) of the jobs Clear jobs takes off the list (db.js finishedJobs).
    pub fn finished_jobs(&self, vehicle_id: Option<&str>, keep_external: &[String]) -> Vec<(i64, Option<String>)> {
        let c = self.reader();
        finished_on(&c, vehicle_id, keep_external)
    }

    /// Clear jobs: only these rows go; a cleared conversion is remembered. Returns how many left the list.
    pub fn clear_jobs(&self, vehicle_id: Option<&str>, keep_external: &[String]) -> usize {
        self.tx(|c| {
            let gone = finished_on(c, vehicle_id, keep_external);
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
        })
        .unwrap_or(0)
    }

    pub fn job_cleared(&self, external_id: &str) -> bool {
        self.reader().query_row("SELECT 1 AS x FROM jobs_cleared WHERE external_id = ?", [external_id], |_| Ok(())).optional().ok().flatten().is_some()
    }

    /// At start: jobs of this process that a restart stopped are interrupted (conversions are the converter's).
    pub fn interrupt_jobs(&self) -> usize {
        self.conn()
            .execute(
                "UPDATE jobs SET status = 'interrupted', finished_at = ?,
      detail = CASE WHEN detail IS NULL OR detail = '' THEN 'stopped by a restart' ELSE detail || ' · stopped by a restart' END
      WHERE status = 'running' AND type != 'conversion'",
                [now_ms()],
            )
            .unwrap_or(0)
    }

    // ---- notifications
    /// Open (or refresh) a notification; one open entry per dedupe key (db.js notify).
    pub fn notify(&self, n: &NewNotification) -> i64 {
        let now = now_ms();
        let level = n.level.clone().unwrap_or_else(|| "warning".into());
        let c = self.conn();
        let mut changed = true;
        let mut out = None;
        if let Some(key) = n.dedupe_key.as_deref().filter(|k| !k.is_empty()) {
            if let Ok(Some(id)) = c.query_row("SELECT id FROM notifications WHERE dedupe_key = ? AND resolved_at IS NULL", [key], |r| r.get::<_, i64>(0)).optional() {
                let ch = c
                    .execute(
                        "UPDATE notifications SET level = ?, title = ?, message = ?, updated_at = ? WHERE id = ? AND (level IS NOT ? OR title IS NOT ? OR message IS NOT ?)",
                        params![level, n.title, n.message, now, id, level, n.title, n.message],
                    )
                    .unwrap_or(0);
                changed = ch > 0;
                out = Some(id);
            }
        }
        let id = match out {
            Some(id) => id,
            None => {
                let _ = c.execute(
                    "INSERT INTO notifications (kind, level, vehicle_id, title, message, created_at, updated_at, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    params![n.kind, level, n.vehicle_id, n.title, n.message, now, now, n.dedupe_key],
                );
                c.last_insert_rowid()
            }
        };
        *self.last_notify_changed.lock().unwrap() = changed;
        id
    }

    pub fn last_notify_changed(&self) -> bool {
        *self.last_notify_changed.lock().unwrap()
    }

    pub fn resolve(&self, dedupe_key: &str) {
        let _ = self.conn().execute("UPDATE notifications SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL", params![now_ms(), dedupe_key]);
    }

    /// Close every open notification whose key starts with `prefix`.
    pub fn resolve_prefix(&self, prefix: &str) {
        let mut like = String::new();
        for ch in prefix.chars() {
            if matches!(ch, '\\' | '%' | '_') {
                like.push('\\');
            }
            like.push(ch);
        }
        like.push('%');
        let _ = self
            .conn()
            .execute("UPDATE notifications SET resolved_at = ? WHERE resolved_at IS NULL AND dedupe_key LIKE ? ESCAPE '\\'", params![now_ms(), like]);
    }

    pub fn resolve_id(&self, id: i64) {
        let now = now_ms();
        let _ = self
            .conn()
            .execute("UPDATE notifications SET resolved_at = COALESCE(resolved_at, ?), read_at = COALESCE(read_at, ?) WHERE id = ?", params![now, now, id]);
    }

    pub fn mark_read(&self, ids: &[i64]) {
        let _ = self.tx(|c| {
            for id in ids {
                c.execute("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?", params![now_ms(), id])?;
            }
            Ok(())
        });
    }

    /// db.js notifications({ open, limit, vehicleId }), as its JSON rows.
    pub fn notifications(&self, open: bool, limit: i64, vehicle_id: Option<&str>) -> Vec<Value> {
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
        let Ok(mut s) = c.prepare(&sql) else { return Vec::new() };
        let rows = s.query_map(rusqlite::params_from_iter(args), |r| {
            Ok(json!({
                "id": r.get::<_, i64>("id")?, "kind": r.get::<_, String>("kind")?, "level": r.get::<_, String>("level")?,
                "vehicleId": r.get::<_, Option<String>>("vehicle_id")?, "title": r.get::<_, String>("title")?, "message": r.get::<_, Option<String>>("message")?,
                "createdAt": r.get::<_, i64>("created_at")?, "updatedAt": r.get::<_, i64>("updated_at")?,
                "resolvedAt": r.get::<_, Option<i64>>("resolved_at")?, "readAt": r.get::<_, Option<i64>>("read_at")?,
                "dedupeKey": r.get::<_, Option<String>>("dedupe_key")?
            }))
        });
        rows.map(|r| r.filter_map(Result::ok).collect()).unwrap_or_default()
    }
}

fn finished_on(c: &Connection, vehicle_id: Option<&str>, keep_external: &[String]) -> Vec<(i64, Option<String>)> {
    let map = |r: &Row| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?));
    let rows: rusqlite::Result<Vec<(i64, Option<String>)>> = match vehicle_id {
        Some(v) if !v.is_empty() => c
            .prepare_cached("SELECT id, external_id FROM jobs WHERE status != 'running' AND (vehicle_id = ? OR vehicle_id IS NULL)")
            .and_then(|mut s| s.query_map([v], map).map(|r| r.filter_map(Result::ok).collect())),
        _ => c.prepare_cached("SELECT id, external_id FROM jobs WHERE status != 'running'").and_then(|mut s| s.query_map([], map).map(|r| r.filter_map(Result::ok).collect())),
    };
    rows.unwrap_or_default()
        .into_iter()
        .filter(|(_, ext)| !matches!(ext.as_deref(), Some(e) if !e.is_empty() && keep_external.iter().any(|k| k == e)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_read_does_not_wait_for_a_write_that_waits_for_another_connection() {
        let dir = std::env::temp_dir().join(format!("lean-db-read-{}-{}", std::process::id(), now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        let db = std::sync::Arc::new(Db::open(&dir.join("manager.db")).unwrap());
        db.put_user("a", "s", "h");
        db.add_session("t1", "a", now_ms() + 60_000, None, None);
        db.set("x", &json!(1));
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
        assert_eq!(db.get_session("t1").map(|s| s.username), Some("a".into()));
        assert_eq!(db.get("x"), Some(json!(1)));
        assert!(db.get_user("a").is_some());
        assert_eq!((db.user_count(), db.sessions_for("a").len(), db.list_users().len()), (1, 1, 1));
        assert!(db.jobs(10, None).is_empty() && db.notifications(true, 10, None).is_empty());
        assert!(began.elapsed() < std::time::Duration::from_secs(1), "the reads waited {:?}", began.elapsed());
        other.execute_batch("ROLLBACK").unwrap();
        writer.join().unwrap();
        assert_eq!(db.get("x"), Some(json!(2)), "the write went through once the lock was free");
        drop(other);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_quick_check_waits_for_neither_shared_connection() {
        let dir = std::env::temp_dir().join(format!("lean-db-quick-{}-{}", std::process::id(), now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        let db = std::sync::Arc::new(Db::open(&dir.join("manager.db")).unwrap());
        db.set("x", &json!(1));
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
        assert_eq!(db.start_job(&job), 0);
        assert!(db.job_cleared("converter:1"));
        db.conn().execute_batch("DROP TRIGGER refused").unwrap();
        let id = db.start_job(&job);
        assert!(id > 0 && !db.job_cleared("converter:1") && db.job_by_external("converter:1").map(|j| j.id) == Some(id));
    }

    #[test]
    fn a_user_and_their_sessions_go_together() {
        let db = Db::memory().unwrap();
        db.put_user("a", "s", "h");
        db.add_session("t1", "a", now_ms() + 60_000, None, None);
        // (the sessions cannot go: then the user stays too)
        db.conn().execute_batch("CREATE TEMP TRIGGER kept BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'kept'); END;").unwrap();
        db.delete_user("a");
        assert!(db.get_user("a").is_some() && db.get_session("t1").is_some());
        db.conn().execute_batch("DROP TRIGGER kept").unwrap();
        db.delete_user("a");
        assert!(db.get_user("a").is_none() && db.get_session("t1").is_none());
    }

    #[test]
    fn settings_round_trip_and_null() {
        let db = Db::memory().unwrap();
        assert_eq!(db.get("x"), None);
        db.set("x", &json!({ "a": [1, 2] }));
        assert_eq!(db.get("x"), Some(json!({ "a": [1, 2] })));
        db.set("x", &Value::Null);
        assert_eq!(db.get_or("x", json!([])), Value::Null);
        db.conn().execute("INSERT INTO settings (key, value) VALUES ('bad', '{nope')", []).unwrap();
        assert_eq!(db.get_or("bad", json!(7)), json!(7));
        db.del("x");
        assert_eq!(db.get("x"), None);
    }

    #[test]
    fn jobs_external_clear_and_interrupt() {
        let db = Db::memory().unwrap();
        let a = db.start_job(&NewJob { kind: "scan".into(), title: "Scan".into(), vehicle_id: Some("car".into()), ..Default::default() });
        let b = db.start_job(&NewJob { kind: "conversion".into(), title: "Convert".into(), external_id: Some("converter:1".into()), ..Default::default() });
        assert_eq!(db.start_job(&NewJob { kind: "conversion".into(), title: "again".into(), external_id: Some("converter:1".into()), ..Default::default() }), b);
        db.update_job(b, &JobUpdate { status: Some("done".into()), result: Some(json!({ "ok": true })), finished: true, ..Default::default() });
        let j = db.job_by_external("converter:1").unwrap();
        assert_eq!(j.status, "done");
        assert_eq!(j.result, json!({ "ok": true }));
        assert!(j.finished_at.is_some());
        assert_eq!(db.finished_jobs(None, &[]).len(), 1);
        assert_eq!(db.finished_jobs(None, &["converter:1".into()]).len(), 0);
        assert_eq!(db.clear_jobs(Some("car"), &[]), 1);
        assert!(db.job_cleared("converter:1"));
        // running again: back on the list
        db.start_job(&NewJob { kind: "conversion".into(), title: "x".into(), external_id: Some("converter:1".into()), ..Default::default() });
        assert!(!db.job_cleared("converter:1"));
        assert_eq!(db.interrupt_jobs(), 1);
        let rows = db.jobs(200, None);
        let scan = rows.iter().find(|r| r.id == a).unwrap();
        assert_eq!(scan.status, "interrupted");
        assert_eq!(scan.detail.as_deref(), Some("stopped by a restart"));
    }

    #[test]
    fn notifications_dedupe() {
        let db = Db::memory().unwrap();
        let n = NewNotification { kind: "share".into(), title: "down".into(), dedupe_key: Some("share:a".into()), ..Default::default() };
        let id = db.notify(&n);
        assert!(db.last_notify_changed());
        assert_eq!(db.notify(&n), id);
        assert!(!db.last_notify_changed());
        assert_eq!(db.notify(&NewNotification { message: Some("more".into()), ..n.clone() }), id);
        assert!(db.last_notify_changed());
        db.resolve_prefix("share:");
        assert!(db.notifications(true, 200, None).is_empty());
        let all = db.notifications(false, 200, None);
        assert_eq!(all[0]["level"], "warning");
        assert!(all[0]["resolvedAt"].is_i64());
    }

    #[test]
    fn sessions() {
        let db = Db::memory().unwrap();
        db.put_user("a", "s", "h");
        db.add_session("t1", "a", now_ms() + 1000, Some("agent"), Some("10.0.0.1"));
        db.add_session("t0", "a", now_ms() - 1, None, None);
        assert_eq!(db.sessions_for("a").len(), 1);
        assert!(db.get_session("t0").is_none());
        db.prune_sessions();
        assert_eq!(db.conn().query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        db.delete_user("a");
        assert!(db.get_session("t1").is_none());
    }
}
