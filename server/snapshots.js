'use strict';

// Database snapshots: once a day a consistent copy of manager.db (accounts,
// vehicles, settings, policies, starred moments, job history) goes to
// data/snapshots/manager-YYYY-MM-DD.db; the newest KEEP are kept. A copy is
// made with SQLite's VACUUM INTO, which is safe while the app runs.
//
// Restoring cannot swap the database under the running app: the chosen
// snapshot is put next to it as manager.db.restore, and the app restarts
// (the supervisor, or Docker's restart policy, starts it again). At the next
// start applyPendingRestore() moves the current database aside
// (manager.db.before-restore) and puts the snapshot in its place, before the
// database is opened.

const fs = require('fs');
const path = require('path');

const KEEP = 7;
const NAME = /^manager-(\d{4}-\d{2}-\d{2})\.db$/;

/** Before the database is opened: put a snapshot chosen for restoring in place. */
function applyPendingRestore(dbFile, log) {
  const pending = `${dbFile}.restore`;
  if (!fs.existsSync(pending)) return false;
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.renameSync(`${dbFile}${ext}`, `${dbFile}.before-restore${ext}`); } catch { /* none */ }
  }
  fs.renameSync(pending, dbFile);
  log?.warn?.(`Database restored from a snapshot; the one it replaced is kept as ${path.basename(dbFile)}.before-restore`);
  return true;
}

// `secret`: settings keys whose values a snapshot must not keep, each with a
// function that returns the value without its secrets (the Sentry USB link
// keys: a restored snapshot shows those devices unpaired, to be paired again)
function createSnapshots({ db, dbFile, dir, log, now = () => new Date(), keep = KEEP, secret = {} }) {
  const day = () => now().toISOString().slice(0, 10);

  function list() {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => NAME.test(n)); } catch { return []; }
    return names.sort().reverse().map((name) => {
      let st = null;
      try { st = fs.statSync(path.join(dir, name)); } catch { /* gone */ }
      return { name, day: NAME.exec(name)[1], bytes: st ? st.size : null, at: st ? st.mtimeMs : null };
    });
  }

  /** Today's snapshot, unless there is one already (or `force`). */
  function take({ force = false } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const name = `manager-${day()}.db`;
    const file = path.join(dir, name);
    if (fs.existsSync(file) && !force) return null;
    const tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
    try { fs.unlinkSync(tmp); } catch { /* none */ }
    db.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    if (Object.keys(secret).length) {
      const { DatabaseSync } = require('node:sqlite');
      const copy = new DatabaseSync(tmp);
      try {
        for (const [key, strip] of Object.entries(secret)) {
          const row = copy.prepare('SELECT value FROM settings WHERE key = ?').get(key);
          if (!row) continue;
          let value = null;
          try { value = strip(JSON.parse(row.value)); } catch { value = null; }
          copy.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify(value), key);
        }
        copy.exec('VACUUM'); // the old values are not left in free pages
      } finally {
        copy.close();
      }
    }
    fs.renameSync(tmp, file);
    for (const old of list().slice(keep)) {
      try { fs.unlinkSync(path.join(dir, old.name)); } catch { /* gone */ }
    }
    log?.info?.(`Database snapshot ${name} saved`);
    return name;
  }

  /** Choose a snapshot to restore at the next start. */
  function prepareRestore(name) {
    if (!NAME.test(String(name || '')) || !list().some((x) => x.name === name)) throw Object.assign(new Error('No such snapshot.'), { status: 404 });
    fs.copyFileSync(path.join(dir, name), `${dbFile}.restore.tmp`);
    fs.renameSync(`${dbFile}.restore.tmp`, `${dbFile}.restore`);
  }

  // once a day, checked every hour (and soon after a start)
  let timer = null;
  const tick = () => { try { take(); } catch (err) { log?.warn?.(`Database snapshot failed: ${err.message}`); } };
  function start() {
    setTimeout(tick, 60_000).unref?.();
    timer = setInterval(tick, 60 * 60 * 1000);
    timer.unref?.();
  }
  function stop() { clearInterval(timer); }

  return { list, take, prepareRestore, start, stop };
}

module.exports = { createSnapshots, applyPendingRestore, KEEP };
