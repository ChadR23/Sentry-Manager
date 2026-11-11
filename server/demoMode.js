'use strict';

// The public demo (DEMO=1): anyone may sign in as "demo" (an admin), so
// everything that reaches outside the demo is refused here, the demo account
// is made on first start, and the demo's state is put back from a pristine
// copy every DEMO_RESET_MINUTES. With DEMO unset nothing in this file is used.
//
// What a reset puts back (resetScope): everything in the data folder except
// KEPT (TLS material, logs, the owner page's files, the seed itself), with
// manager.db replaced by the seed's copy while keeping its signed-in
// sessions, and the tables and settings named in KEPT_TABLES / KEPT_SETTINGS
// (attack log, owner settings, certificates); the footage folder too, when
// it is writable and a copy of it was seeded. The reset happens on the next
// start: reset() marks it and restarts the server (the supervisor starts it
// again at once), so no module ever runs on files changed under it.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const LOCKED_TEXT = 'Turned off in the demo.';
const RESET_EXIT_CODE = 75;
// never reset: certificates, logs, the owner page's own folder and the seed
const KEPT = new Set(['tls', 'logs', 'demo-keep', '.demo-seed', '.demo-reset-pending']);
const KEPT_TABLES = /^(attack|owner|acme|letsencrypt|tls)/i;
const KEPT_SETTINGS = /^(attack|owner|acme|letsencrypt|tls|hostnames)/i;
const DB_FILES = ['manager.db', 'manager.db-wal', 'manager.db-shm', 'manager.db-journal'];

function isDemo(env = process.env) {
  return env.DEMO === '1' || String(env.DEMO || '').toLowerCase() === 'true';
}

function resetMinutes(env = process.env) {
  const n = Number(env.DEMO_RESET_MINUTES);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : 60;
}

const seedDir = (dataDir, env = process.env) => path.resolve(env.DEMO_SEED_PATH || path.join(dataDir, '.demo-seed'));

// ---- lockdown: method + path (the decoded API path) -> the feature's name, or null
const LOCKS = [
  // shares: mounting, changing or testing makes the server connect anywhere
  ['POST', /^\/api\/vehicles\/test-smb$/, 'share test'],
  ['POST', /^\/api\/vehicles$/, 'add vehicle'],
  ['DELETE', /^\/api\/vehicles\/[^/]+$/, 'remove vehicle'],
  // nodes and Sentry USB pairing
  ['*', /^\/api\/nodes(\/|$)/, 'nodes'],
  ['POST', /^\/api\/sentryusb\/pair$/, 'Sentry USB pairing'],
  ['DELETE', /^\/api\/sentryusb\/pair$/, 'Sentry USB pairing'],
  ['DELETE', /^\/api\/sentryusb\/[^/]+$/, 'Sentry USB unpairing'],
  ['PUT', /^\/api\/sentryusb\/security\/settings$/, 'Sentry USB security settings'],
  ['GET', /^\/api\/sentryusb\/security\.csv$/, 'Sentry USB security log download'],
  // a Pi's settings that send it to other addresses
  ['*', /^\/api\/sentryusb\/[^/]+\/proxy\/api\/(system\/update-source|notifications\/settings|setup\/run)$/, 'Sentry USB outbound settings'],
  // interface packs run code in every visitor's browser
  ['POST', /^\/api\/ui-packs\/upload$/, 'interface upload'],
  ['DELETE', /^\/api\/ui-packs\/[^/]+$/, 'interface removal'],
  // CAN Bridge
  ['POST', /^\/api\/can\/(tokens|enable|disable)$/, 'CAN Bridge'],
  ['DELETE', /^\/api\/can\/tokens\/[^/]+$/, 'CAN Bridge'],
  ['POST', /^\/api\/can\/pairing\//, 'CAN Bridge'],
  // accounts and sign-in (signing out stays)
  ['*', /^\/api\/accounts(\/|$)/, 'accounts'],
  ['POST', /^\/api\/auth\/(setup|password)$/, 'accounts'],
  ['POST', /^\/api\/auth\/2fa\//, 'two-step sign-in'],
  // every visitor is "demo": the devices list is other visitors'
  ['*', /^\/api\/auth\/sessions/, 'signed-in devices'],
  // security, TLS and host names; the bans list holds visitors' addresses
  ['*', /^\/api\/security\/(access|hostnames|unban)$/, 'security settings'],
  // logs (visitors' addresses), support bundle, snapshots, metrics
  ['*', /^\/api\/logs(\/|$)/, 'logs'],
  ['GET', /^\/api\/support-bundle$/, 'support bundle'],
  ['POST', /^\/api\/snapshots(\/|$)/, 'database snapshots'],
  ['*', /^\/api\/metrics\//, 'metrics'],
  // updates (outbound) and restarts
  ['POST', /^\/api\/updates\//, 'updates'],
  ['POST', /^\/api\/(system\/)?(restart|update|settings\/import)$/, 'restart or update'],
  // exports write whole days of video (disk) for anyone
  ['POST', /^\/api\/(vehicles\/[^/]+\/)?exports$/, 'exports']
];

/** The locked feature a request asks for, or null. `body` for the few decided by it. */
function lockedFeature(method, p, body) {
  for (const [m, re, name] of LOCKS) if ((m === '*' || m === method) && re.test(p)) return name;
  // a vehicle's name or time zone may change, never its share or folder
  if (method === 'PUT' && /^\/api\/vehicles\/[^/]+$/.test(p) && body && typeof body === 'object' && body.source !== undefined) return 'vehicle share settings';
  return null;
}

// ---- conversions: one job, a few clips, niced, never in place
const CONVERT = { maxClips: 20, perHour: 6, nice: 19 };
const CONVERTER_LOCKED = new Set(['setAuto', 'saveVehicle', 'forgetVehicle', 'checkAutoNow', 'runBenchmark', 'setLanes']);

/**
 * A converter call in the demo: { error } to refuse it, else { payload }
 * (changed: one conversion at a time, no GPU lanes, output to a separate folder).
 */
function converterRule(name, payload) {
  if (CONVERTER_LOCKED.has(name)) return { error: 'converter ' + name };
  if (name === 'start') {
    if (!payload || typeof payload !== 'object') return { payload };
    if (payload.outputMode === 'replace') return { error: 'replace in place' };
    const out = { ...payload, concurrency: 1 };
    delete out.lanes;
    return { payload: out };
  }
  if (name === 'setConcurrency' && payload && typeof payload === 'object') return { payload: { ...payload, concurrency: 1 } };
  return { payload };
}

// ---- rate limits for a public site: fixed windows per key
function createRateLimits({ now = Date.now } = {}) {
  const LIMITS = { login: [10, 60_000], api: [1200, 60_000], convert: [CONVERT.perHour, 3_600_000], convertAll: [CONVERT.perHour * 4, 3_600_000] };
  const hits = new Map(); // kind|key -> { n, until }
  /** Counts one; the seconds to wait when over the limit, else 0. */
  function take(kind, key) {
    const [max, windowMs] = LIMITS[kind];
    const k = `${kind}|${key}`;
    const t = now();
    let h = hits.get(k);
    if (!h || h.until <= t) {
      if (hits.size > 20_000) for (const [x, v] of hits) if (v.until <= t) hits.delete(x);
      h = { n: 0, until: t + windowMs };
      hits.set(k, h);
    }
    h.n += 1;
    return h.n > max ? Math.ceil((h.until - t) / 1000) : 0;
  }
  /** Just went over (after a take): note it once per window, not on every refusal. */
  const firstOver = (kind, key) => hits.get(`${kind}|${key}`)?.n === LIMITS[kind][0] + 1;
  return { take, firstOver, LIMITS };
}

// ---- the demo account
const DEMO_USER = 'demo';
const DEMO_PASSWORD = 'demo';
function ensureDemoAccount({ db, accounts, hashPassword }) {
  if (db.getUser(DEMO_USER)) return false;
  // (shorter than the 8 characters a real account needs: it is printed on the sign-in page)
  const { salt, hash } = hashPassword(DEMO_PASSWORD);
  db.putUser(DEMO_USER, salt, hash);
  accounts.setRole(DEMO_USER, 'admin');
  return true;
}
// (only the banner's interval: visitors are signed in automatically, the password is shown nowhere)
const hint = (env = process.env) => ({ resetMinutes: resetMinutes(env) });

// ---- automatic demo sessions: every visitor is signed in as "demo"
const DEMO_SESSION = { perAddressHour: 20, total: 2000, idleMs: 2 * 3600_000 };
/** Pages and calls that sign a visitor in (never the owner page, nodes or the device port). */
function autoSignIn(p) {
  if (p === '/owner' || p.startsWith('/owner/') || p.startsWith('/api/owner')) return false;
  return p === '/' || p === '/index.html' || p === '/login' || p === '/api/auth/me' || /^\/[^/]*\.html?$/i.test(p) || p === '/studio' || p.startsWith('/studio/');
}
/**
 * New demo sessions, capped per address an hour and in total (the oldest
 * go first), and ended after DEMO_SESSION.idleMs without use.
 */
function createDemoSessions({ db, now = Date.now, limits = DEMO_SESSION } = {}) {
  const made = new Map(); // address -> { n, until }
  const q = (sql) => db.db.prepare(sql);
  const lastUse = 'COALESCE(seen_at, created_at)';
  function prune() {
    q(`DELETE FROM sessions WHERE username = ? AND (expires_at <= ? OR ${lastUse} < ?)`).run(DEMO_USER, now(), now() - limits.idleMs);
  }
  /** Whether this session (a sessions row) has been idle too long: then it is ended. */
  function idle(row) {
    if (!row || row.username !== DEMO_USER) return false;
    if (Math.max(row.seen_at || 0, row.created_at || 0) >= now() - limits.idleMs) return false;
    q('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return true;
  }
  /** A new session for this address: its token, or null when the address has had its share. */
  function start(address, { agent = null } = {}) {
    const t = now();
    let m = made.get(address);
    if (!m || m.until <= t) {
      if (made.size > 50_000) for (const [k, v] of made) if (v.until <= t) made.delete(k);
      m = { n: 0, until: t + 3600_000 };
      made.set(address, m);
    }
    if (m.n >= limits.perAddressHour) return null;
    m.n += 1;
    prune();
    const live = q('SELECT count(*) AS n FROM sessions WHERE username = ?').get(DEMO_USER).n;
    if (live >= limits.total) {
      q(`DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE username = ? ORDER BY ${lastUse} ASC LIMIT ?)`).run(DEMO_USER, live - limits.total + 1);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    db.addSession(crypto.createHash('sha256').update(token).digest('hex'), DEMO_USER, t + 7 * 24 * 3600_000, { agent, ip: address });
    return token;
  }
  return { start, idle, prune };
}

// ---- seed and reset
function copyTree(from, to) {
  fs.cpSync(from, to, { recursive: true, force: true, errorOnExist: false, verbatimSymlinks: true, preserveTimestamps: true });
}

/** Make `dir` hold exactly what `seed` holds (except names in `keep`). */
function mirror(seed, dir, keep = new Set()) {
  fs.mkdirSync(dir, { recursive: true });
  const want = new Set(fs.readdirSync(seed));
  for (const name of fs.readdirSync(dir)) {
    if (keep.has(name) || want.has(name)) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  for (const name of want) {
    if (keep.has(name)) continue;
    const dst = path.join(dir, name);
    fs.rmSync(dst, { recursive: true, force: true });
    copyTree(path.join(seed, name), dst);
  }
}

const writable = (dir) => {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The pristine copy, taken once (the first start after the demo data is
 * made): the data folder without KEPT and the database (a consistent copy of
 * it, VACUUM INTO), and the footage folder when it is writable.
 */
function takeSeed({ dataDir, db, footageDir = null, env = process.env, force = false }) {
  const seed = seedDir(dataDir, env);
  if (!force && fs.existsSync(path.join(seed, 'ready'))) return false;
  fs.rmSync(seed, { recursive: true, force: true });
  fs.mkdirSync(path.join(seed, 'data'), { recursive: true });
  for (const name of fs.readdirSync(dataDir)) {
    if (KEPT.has(name) || DB_FILES.includes(name)) continue;
    const from = path.join(dataDir, name);
    if (path.resolve(from) === seed) continue;
    copyTree(from, path.join(seed, 'data', name));
  }
  const dbOut = path.join(seed, 'manager.db');
  if (db) db.db.exec(`VACUUM INTO '${dbOut.replace(/'/g, "''")}'`);
  if (footageDir && fs.existsSync(footageDir) && writable(footageDir)) copyTree(footageDir, path.join(seed, 'footage'));
  fs.writeFileSync(path.join(seed, 'ready'), `${new Date().toISOString()}\n`);
  return true;
}

const resetPendingFile = (dataDir) => path.join(dataDir, '.demo-reset-pending');
function markReset(dataDir) {
  fs.writeFileSync(resetPendingFile(dataDir), `${new Date().toISOString()}\n`);
}

/** Rows of the kept tables, the kept settings and the sessions, from the database now. */
function keptRows(file) {
  if (!fs.existsSync(file)) return null;
  const d = new DatabaseSync(file);
  try {
    const tables = d.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    const kept = tables.filter((t) => KEPT_TABLES.test(t.name)).map((t) => ({ name: t.name, sql: t.sql, rows: d.prepare(`SELECT * FROM "${t.name}"`).all() }));
    const has = (n) => tables.some((t) => t.name === n);
    const settings = has('settings') ? d.prepare('SELECT key, value FROM settings').all().filter((s) => KEPT_SETTINGS.test(s.key)) : [];
    const sessions = has('sessions') ? d.prepare('SELECT * FROM sessions').all() : [];
    return { kept, settings, sessions };
  } finally {
    d.close();
  }
}

function insertAll(d, table, rows) {
  for (const row of rows) {
    const cols = Object.keys(row);
    if (!cols.length) continue;
    d.prepare(`INSERT OR REPLACE INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
  }
}

/**
 * Before anything opens the data folder: the reset reset() asked for. Returns
 * what was reset (a list of names), or null when none was pending.
 */
function applyPendingReset({ dataDir, footageDir = null, env = process.env, log = null, force = false }) {
  const pending = resetPendingFile(dataDir);
  if (!force && !fs.existsSync(pending)) return null;
  const seed = seedDir(dataDir, env);
  if (!fs.existsSync(path.join(seed, 'ready'))) {
    fs.rmSync(pending, { force: true });
    log?.warn('Demo reset skipped: no seed copy yet');
    return null;
  }
  const done = [];
  const dbFile = path.join(dataDir, 'manager.db');
  const before = keptRows(dbFile);
  for (const f of DB_FILES) fs.rmSync(path.join(dataDir, f), { force: true });
  fs.copyFileSync(path.join(seed, 'manager.db'), dbFile);
  done.push('manager.db');
  if (before) {
    const d = new DatabaseSync(dbFile);
    try {
      d.exec('BEGIN');
      for (const t of before.kept) {
        d.exec(`DROP TABLE IF EXISTS "${t.name}"`);
        d.exec(t.sql);
        insertAll(d, t.name, t.rows);
      }
      const users = new Set(d.prepare('SELECT username FROM users').all().map((u) => u.username));
      insertAll(d, 'settings', before.settings);
      // signed-in devices stay signed in (accounts the seed has)
      insertAll(d, 'sessions', before.sessions.filter((s) => users.has(s.username)));
      d.exec('COMMIT');
    } finally {
      d.close();
    }
  }
  const keep = new Set([...KEPT, ...DB_FILES]);
  const seedData = path.join(seed, 'data');
  fs.mkdirSync(seedData, { recursive: true });
  for (const name of fs.readdirSync(dataDir)) if (!keep.has(name) && path.resolve(dataDir, name) !== seed) done.push(name);
  for (const name of fs.readdirSync(seedData)) if (!done.includes(name)) done.push(name);
  mirror(seedData, dataDir, new Set([...keep, path.basename(seed)]));
  if (footageDir && fs.existsSync(path.join(seed, 'footage')) && writable(footageDir)) {
    mirror(path.join(seed, 'footage'), footageDir);
    done.push(`footage (${footageDir})`);
  }
  fs.rmSync(pending, { force: true });
  log?.info(`Demo reset: ${done.join(', ')}`);
  return done;
}

// ---- what the server provides at start-up (index.js)
let provided = {};
/** index.js: { reset, pairStandIn } */
function provide(fns) {
  provided = { ...provided, ...fns };
}
/** Put the demo back now (the owner page's Reset now; the hourly timer). */
async function reset() {
  if (!provided.reset) throw new Error('The demo is not running.');
  return provided.reset();
}
/** Pair the demo's stand-in Sentry USB (server side only, never an HTTP route): its pairing code. */
async function pairStandIn(opts = {}) {
  if (!provided.pairStandIn) throw new Error('The demo is not running.');
  return provided.pairStandIn(opts);
}
const resetScope = () => ({
  reset: ['manager.db (except signed-in sessions and the kept tables and settings)', 'every other file and folder in the data folder', 'the footage folder, when writable and seeded'],
  kept: [...KEPT], keptTables: String(KEPT_TABLES), keptSettings: String(KEPT_SETTINGS)
});

module.exports = {
  isDemo, resetMinutes, seedDir, LOCKED_TEXT, RESET_EXIT_CODE, lockedFeature, converterRule, CONVERT, createRateLimits,
  ensureDemoAccount, hint, autoSignIn, createDemoSessions, DEMO_SESSION, DEMO_USER, DEMO_PASSWORD, takeSeed, markReset, applyPendingReset, provide, reset, pairStandIn, resetScope, KEPT
};
