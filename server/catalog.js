'use strict';

// The footage catalog in the manager's database (db.js): every file the last
// scan of each car found (catalog_files) and the video codec read from each
// clip (clip_codecs), so codec answers survive a restart without the whole
// map being rewritten as one settings value each time one clip changes.
// Written as the scan goes, in batches; only what changed is written.
//
// The catalog only follows the scans: inventory.js still keeps the scan in
// memory (its Map is what every module reads), and nothing here is ever
// written to the footage folders.

const SCHEMA = `
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
`;

// What a scan row (catalog_scans) vouches for: catalog_files and catalog_dirs
// were written by one finished scan of this root (and kept in step by the
// Recycle Bin since), so the first scan after a restart may use them as its
// light rescan's previous (inventory.js). A version that writes them
// differently changes this number, and the scan after the upgrade is full.
const FORMAT = 1;

// rows per transaction: big enough to be quick, small enough not to hold up a request
const BATCH = 1000;

const num = (v) => (v === null || v === undefined ? null : Number(v));

class Catalog {
  /** `mdb`: the ManagerDB (its prepared-statement cache and transactions). */
  constructor(mdb) {
    this.mdb = mdb;
    mdb.db.exec(SCHEMA);
  }

  q(sql) {
    return this.mdb.q(sql);
  }

  each(list, fn) {
    for (let i = 0; i < list.length; i += BATCH) {
      const part = list.slice(i, i + BATCH);
      this.mdb.tx(() => { for (const x of part) fn(x); });
    }
  }

  // ---- files
  /** Add or update these file entries (inventory.js FileEntry or alike). */
  putFiles(vehicleId, entries) {
    const st = this.q(`INSERT INTO catalog_files (vehicle_id, rel, size, mtime_ms, ctime_ms, birthtime_ms, kind, type, day, camera, event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(vehicle_id, rel) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, ctime_ms = excluded.ctime_ms,
        birthtime_ms = excluded.birthtime_ms, kind = excluded.kind, type = excluded.type, day = excluded.day, camera = excluded.camera,
        event_id = excluded.event_id`);
    this.each(entries, (f) => st.run(vehicleId, f.rel, f.size, f.mtimeMs, num(f.ctimeMs), num(f.birthtimeMs), f.kind, f.type ?? null,
      f.day ?? null, f.camera ?? null, f.eventId ?? null));
  }

  removeFiles(vehicleId, rels) {
    const st = this.q('DELETE FROM catalog_files WHERE vehicle_id = ? AND rel = ?');
    this.each(rels, (rel) => st.run(vehicleId, rel));
  }

  /** Forget the files the latest scan did not find (`has(rel)` false); returns how many. */
  keepOnly(vehicleId, has) {
    const st = this.q('SELECT rel FROM catalog_files WHERE vehicle_id = ?');
    const gone = [];
    for (const r of st.iterate ? st.iterate(vehicleId) : st.all(vehicleId)) if (!has(r.rel)) gone.push(r.rel);
    this.removeFiles(vehicleId, gone);
    return gone.length;
  }

  /**
   * Bring a car's rows in line with the inventory's files (a Map rel -> entry)
   * after files moved without a scan (Recycle Bin, restore): rows for files no
   * longer there go, files without a row get one. Returns { added, removed }.
   */
  syncFiles(vehicleId, files) {
    const have = new Set();
    for (const r of this.q('SELECT rel FROM catalog_files WHERE vehicle_id = ?').all(vehicleId)) have.add(r.rel);
    const gone = [...have].filter((rel) => !files.has(rel));
    const added = [];
    for (const [rel, f] of files) if (!have.has(rel)) added.push(f);
    if (!gone.length && !added.length) return { added: 0, removed: 0 };
    // (the scan row goes first and comes back last: a write that stops halfway leaves none)
    const last = this.lastScan(vehicleId);
    this.invalidate(vehicleId);
    this.removeFiles(vehicleId, gone);
    this.putFiles(vehicleId, added);
    // the folders the files left or reached have new modified times: the next scan lists them afresh
    if (last && last.format === FORMAT) this.markScan(vehicleId, last);
    return { added: added.length, removed: gone.length };
  }

  // ---- the last finished scan (the first scan after a restart starts from it)
  /** Before a scan (or a Recycle Bin move) writes: the rows no longer vouch for one scan until it finishes. */
  invalidate(vehicleId) {
    this.q('DELETE FROM catalog_scans WHERE vehicle_id = ?').run(vehicleId);
  }

  totalsOf(vehicleId) {
    const r = this.q('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM catalog_files WHERE vehicle_id = ?').get(vehicleId);
    return { files: Number(r.files), bytes: Number(r.bytes) };
  }

  /**
   * A scan finished and its files are written: its folders' modified times
   * (`dirs`, rel -> ms) and a row saying so, written last.
   */
  putScan(vehicleId, { root, startedMs, scannedAt, dirs }) {
    this.invalidate(vehicleId);
    this.q('DELETE FROM catalog_dirs WHERE vehicle_id = ?').run(vehicleId);
    const st = this.q('INSERT INTO catalog_dirs (vehicle_id, rel, mtime_ms) VALUES (?, ?, ?)');
    this.each([...dirs], ([rel, ms]) => st.run(vehicleId, rel, ms));
    this.markScan(vehicleId, { root, startedMs, scannedAt });
  }

  markScan(vehicleId, { root, startedMs, scannedAt }) {
    const { files, bytes } = this.totalsOf(vehicleId);
    this.q(`INSERT INTO catalog_scans (vehicle_id, format, root, started_ms, scanned_at, files, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(vehicle_id) DO UPDATE SET format = excluded.format, root = excluded.root, started_ms = excluded.started_ms,
        scanned_at = excluded.scanned_at, files = excluded.files, bytes = excluded.bytes`)
      .run(vehicleId, FORMAT, root, startedMs, scannedAt, files, bytes);
  }

  /** The last finished scan's row ({ format, root, startedMs, scannedAt, files, bytes }), or null. */
  lastScan(vehicleId) {
    const r = this.q('SELECT * FROM catalog_scans WHERE vehicle_id = ?').get(vehicleId);
    return r ? { format: Number(r.format), root: r.root, startedMs: Number(r.started_ms), scannedAt: Number(r.scanned_at), files: Number(r.files), bytes: Number(r.bytes) } : null;
  }

  /**
   * What the last finished scan of this root knew, for the first scan after a
   * restart: { rows (catalog_files, as files() returns them), dirs (rel -> ms),
   * startedMs }, or null when the rows cannot vouch for it (no finished scan
   * since this version, another root, a write that did not finish, rows that
   * do not add up to what the scan wrote).
   */
  resume(vehicleId, root) {
    const last = this.lastScan(vehicleId);
    if (!last || last.format !== FORMAT || last.root !== root) return null;
    const now = this.totalsOf(vehicleId);
    if (now.files !== last.files || now.bytes !== last.bytes) return null;
    const dirs = new Map();
    for (const r of this.q('SELECT rel, mtime_ms FROM catalog_dirs WHERE vehicle_id = ?').all(vehicleId)) dirs.set(r.rel, Number(r.mtime_ms));
    if (!dirs.size) return null;
    return { rows: this.files(vehicleId), dirs, startedMs: last.startedMs };
  }

  /** Every file of a car, as the inventory holds them (sorted by path). */
  files(vehicleId) {
    return this.q('SELECT * FROM catalog_files WHERE vehicle_id = ? ORDER BY rel').all(vehicleId).map((r) => ({
      rel: r.rel, size: Number(r.size), mtimeMs: Number(r.mtime_ms), ctimeMs: num(r.ctime_ms), birthtimeMs: num(r.birthtime_ms),
      kind: r.kind, type: r.type, day: r.day, camera: r.camera, eventId: r.event_id
    }));
  }

  /** Files and bytes per day and kind, without loading the files. */
  summary(vehicleId) {
    const rows = this.q(`SELECT day, kind, COUNT(*) AS files, SUM(size) AS bytes FROM catalog_files
      WHERE vehicle_id = ? GROUP BY day, kind ORDER BY day`).all(vehicleId);
    const out = { files: 0, bytes: 0, days: {} };
    for (const r of rows) {
      const d = (out.days[r.day] = out.days[r.day] || { files: 0, bytes: 0, clips: 0 });
      d.files += Number(r.files);
      d.bytes += Number(r.bytes);
      if (r.kind === 'clip') d.clips += Number(r.files);
      out.files += Number(r.files);
      out.bytes += Number(r.bytes);
    }
    return out;
  }

  // ---- clip codecs
  /** The codecs read so far: [{ rel, size, mtimeMs, codec }]. */
  codecs(vehicleId) {
    const st = this.q('SELECT rel, size, mtime_ms, codec FROM clip_codecs WHERE vehicle_id = ?');
    const out = [];
    for (const r of st.iterate ? st.iterate(vehicleId) : st.all(vehicleId)) out.push({ rel: r.rel, size: Number(r.size), mtimeMs: Number(r.mtime_ms), codec: r.codec });
    return out;
  }

  hasCodecs(vehicleId) {
    return Boolean(this.q('SELECT 1 AS x FROM clip_codecs WHERE vehicle_id = ? LIMIT 1').get(vehicleId));
  }

  /** Remember codecs: [{ rel, size, mtimeMs, codec }]. */
  putCodecs(vehicleId, list) {
    const st = this.q(`INSERT INTO clip_codecs (vehicle_id, rel, size, mtime_ms, codec) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(vehicle_id, rel) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, codec = excluded.codec`);
    this.each(list, (c) => st.run(vehicleId, c.rel, c.size, c.mtimeMs, c.codec ?? null));
  }

  removeCodecs(vehicleId, rels) {
    const st = this.q('DELETE FROM clip_codecs WHERE vehicle_id = ? AND rel = ?');
    this.each(rels, (rel) => st.run(vehicleId, rel));
  }
}

module.exports = { Catalog, BATCH, FORMAT };
