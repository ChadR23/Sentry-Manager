//! The parts of manager.db (server/db.js) the ops area reads and writes:
//! the settings table (JSON values under a key) and the notifications. The
//! schema is server/db.js's, word for word; core makes the whole of it, and
//! `ensure_schema` only makes these two tables for the stand-alone server and
//! the tests. A read tells a missing row from the database failing (an error),
//! and a write that was not kept is an error.

pub use crate::core::db::{DbError, DbResult};
use crate::core::db::{all, one};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, level TEXT NOT NULL, vehicle_id TEXT,
  title TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  resolved_at INTEGER, read_at INTEGER, dedupe_key TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_open ON notifications(dedupe_key) WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL;
";

pub fn ensure_schema(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(SCHEMA)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// db.get(key, fallback): the JSON value, or None when missing or not JSON.
pub fn get(db: &Connection, key: &str) -> DbResult<Option<Value>> {
    let text: Option<String> = one(db.query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0)))?;
    Ok(text.and_then(|t| serde_json::from_str(&t).ok()))
}

/// db.get(key, fallback) where a stored null also reads as null (JSON.parse('null')).
pub fn get_or(db: &Connection, key: &str, fallback: Value) -> DbResult<Value> {
    let text: Option<String> = one(db.query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0)))?;
    Ok(match text {
        Some(t) => serde_json::from_str(&t).unwrap_or(fallback),
        None => fallback,
    })
}

pub fn set(db: &Connection, key: &str, value: &Value) -> DbResult<()> {
    db.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value.to_string()],
    )?;
    Ok(())
}

// ---- notifications (db.js notify / resolve / resolveId / markRead / notifications)

#[derive(Clone, Debug, Default)]
pub struct Note {
    pub kind: String,
    pub level: String,
    pub vehicle_id: Option<String>,
    pub title: String,
    pub message: Option<String>,
    pub dedupe_key: Option<String>,
}

impl Note {
    pub fn new(kind: &str, level: &str, title: impl Into<String>) -> Note {
        Note { kind: kind.into(), level: level.into(), title: title.into(), ..Default::default() }
    }
    pub fn key(mut self, k: impl Into<String>) -> Note {
        self.dedupe_key = Some(k.into());
        self
    }
    pub fn message(mut self, m: impl Into<String>) -> Note {
        self.message = Some(m.into());
        self
    }
    pub fn vehicle(mut self, v: impl Into<String>) -> Note {
        self.vehicle_id = Some(v.into());
        self
    }
}

/// Opens (or refreshes) a notification, one open entry per dedupe key. An open
/// one raised again unchanged is left as it is: (id, changed).
pub fn notify(db: &Connection, n: &Note) -> DbResult<(i64, bool)> {
    let now = now_ms();
    if let Some(key) = &n.dedupe_key {
        let open: Option<i64> = one(db.query_row("SELECT id FROM notifications WHERE dedupe_key = ? AND resolved_at IS NULL", [key], |r| r.get(0)))?;
        if let Some(id) = open {
            let changes = db.execute(
                "UPDATE notifications SET level = ?, title = ?, message = ?, updated_at = ? WHERE id = ? AND (level IS NOT ? OR title IS NOT ? OR message IS NOT ?)",
                params![n.level, n.title, n.message, now, id, n.level, n.title, n.message],
            )?;
            return Ok((id, changes > 0));
        }
    }
    db.execute(
        "INSERT INTO notifications (kind, level, vehicle_id, title, message, created_at, updated_at, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        params![n.kind, n.level, n.vehicle_id, n.title, n.message, now, now, n.dedupe_key],
    )?;
    Ok((db.last_insert_rowid(), true))
}

pub fn resolve(db: &Connection, key: &str) -> DbResult<()> {
    db.execute("UPDATE notifications SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL", params![now_ms(), key])?;
    Ok(())
}

pub fn resolve_prefix(db: &Connection, prefix: &str) -> DbResult<()> {
    let mut like = String::new();
    for c in prefix.chars() {
        if matches!(c, '\\' | '%' | '_') {
            like.push('\\');
        }
        like.push(c);
    }
    like.push('%');
    db.execute("UPDATE notifications SET resolved_at = ? WHERE resolved_at IS NULL AND dedupe_key LIKE ? ESCAPE '\\'", params![now_ms(), like])?;
    Ok(())
}

pub fn resolve_id(db: &Connection, id: f64) -> DbResult<()> {
    let now = now_ms();
    // Number(params.id): NaN matches nothing (SQLite compares NULL)
    let id: Option<f64> = if id.is_finite() { Some(id) } else { None };
    db.execute(
        "UPDATE notifications SET resolved_at = COALESCE(resolved_at, ?), read_at = COALESCE(read_at, ?) WHERE id = ?",
        params![now, now, id],
    )?;
    Ok(())
}

/// All of them read, or none (rolled back on any failure, COMMIT's too).
pub fn mark_read(db: &Connection, ids: &[f64]) -> DbResult<()> {
    let now = now_ms();
    db.execute_batch("BEGIN")?;
    let done = ids
        .iter()
        .try_for_each(|id| db.execute("UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ?", params![now, id]).map(|_| ()))
        .and_then(|_| db.execute_batch("COMMIT"));
    if done.is_err() {
        let _ = db.execute_batch("ROLLBACK");
    }
    Ok(done?)
}

/// db.notifications({ open, limit, vehicleId }): open ones first, newest first.
pub fn list(db: &Connection, open: bool, limit: i64, vehicle: Option<&str>) -> DbResult<Vec<Value>> {
    let mut sql = String::from("SELECT id, kind, level, vehicle_id, title, message, created_at, updated_at, resolved_at, read_at, dedupe_key FROM notifications WHERE 1 = 1");
    if open {
        sql.push_str(" AND resolved_at IS NULL");
    }
    let mut args: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(v) = vehicle {
        sql.push_str(" AND (vehicle_id = ? OR vehicle_id IS NULL)");
        args.push(v.to_string().into());
    }
    sql.push_str(" ORDER BY (resolved_at IS NULL) DESC, updated_at DESC LIMIT ?");
    args.push(limit.into());
    let mut st = db.prepare(&sql)?;
    let rows = st.query_map(rusqlite::params_from_iter(args), |r| {
        let n = |i: usize| -> rusqlite::Result<Value> { Ok(r.get::<_, Option<i64>>(i)?.map_or(Value::Null, |x| json!(x))) };
        let s = |i: usize| -> rusqlite::Result<Value> { Ok(r.get::<_, Option<String>>(i)?.map_or(Value::Null, Value::String)) };
        Ok(json!({
            "id": r.get::<_, i64>(0)?, "kind": s(1)?, "level": s(2)?, "vehicleId": s(3)?, "title": s(4)?, "message": s(5)?,
            "createdAt": n(6)?, "updatedAt": n(7)?, "resolvedAt": n(8)?, "readAt": n(9)?, "dedupeKey": s(10)?
        }))
    })?;
    Ok(all(rows)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        ensure_schema(&db).unwrap();
        db
    }

    #[test]
    fn settings_round_trip() {
        let db = mem();
        assert_eq!(get(&db, "x").unwrap(), None);
        set(&db, "x", &json!({ "a": [1, 2] })).unwrap();
        assert_eq!(get(&db, "x").unwrap(), Some(json!({ "a": [1, 2] })));
        set(&db, "x", &json!(null)).unwrap();
        assert_eq!(get_or(&db, "x", json!(5)).unwrap(), json!(null));
    }

    // test/notifyUnchanged.test.js
    #[test]
    fn same_open_warning_again_changes_nothing() {
        let db = mem();
        let n = Note::new("archive", "warning", "Car: Sat 7 Nov looks only partly archived").message("About 3 minutes ...").key("archive:car:2026-11-07");
        let (id, changed) = notify(&db, &n).unwrap();
        assert!(changed);
        let first = list(&db, true, 200, None).unwrap()[0].clone();
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert_eq!(notify(&db, &n).unwrap(), (id, false));
        assert_eq!(list(&db, true, 200, None).unwrap()[0]["updatedAt"], first["updatedAt"]);
        let (id2, changed) = notify(&db, &n.clone().message("About 4 minutes ...")).unwrap();
        assert_eq!((id2, changed), (id, true));
        let now = &list(&db, true, 200, None).unwrap()[0];
        assert_eq!(now["message"], "About 4 minutes ...");
        assert!(now["updatedAt"].as_i64() > first["updatedAt"].as_i64());
    }

    #[test]
    fn resolve_dismiss_read_and_order() {
        let db = mem();
        let (a, _) = notify(&db, &Note::new("share", "critical", "A").key("share:car").vehicle("car")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let (b, _) = notify(&db, &Note::new("update", "info", "B").key("image-update")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let (c, _) = notify(&db, &Note::new("share", "info", "C").vehicle("other")).unwrap();
        let ids = |v: Vec<Value>| v.iter().map(|x| x["id"].as_i64().unwrap()).collect::<Vec<_>>();
        assert_eq!(ids(list(&db, false, 200, None).unwrap()), vec![c, b, a]);
        assert_eq!(ids(list(&db, false, 200, Some("car")).unwrap()), vec![b, a], "a vehicle's and everyone's");
        resolve(&db, "image-update").unwrap();
        assert_eq!(ids(list(&db, true, 200, None).unwrap()), vec![c, a]);
        assert_eq!(ids(list(&db, false, 200, None).unwrap()), vec![c, a, b], "resolved ones last");
        resolve_id(&db, a as f64).unwrap();
        let all = list(&db, false, 200, None).unwrap();
        let row = all.iter().find(|x| x["id"] == a).unwrap();
        assert!(row["resolvedAt"].is_i64() && row["readAt"].is_i64());
        mark_read(&db, &[c as f64]).unwrap();
        assert!(list(&db, true, 200, None).unwrap()[0]["readAt"].is_i64());
        // a new one with a resolved key opens a new entry
        let (d, _) = notify(&db, &Note::new("share", "critical", "A").key("share:car")).unwrap();
        assert!(d > c);
        resolve_prefix(&db, "share:").unwrap();
        assert!(list(&db, true, 200, None).unwrap().iter().all(|x| x["id"] != d));
    }
}
