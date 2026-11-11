'use strict';

// The public demo's attack log (the owner page, server/ownerPage.js): what
// was tried against the site, by real client address (server/clientAddress.js,
// Cloudflare-aware). Kept in the database, one row per address and kind with a
// count, the first and last time, the last sample tried (a path, or the user
// name of a failed sign-in: never a password or a body) and the user agent,
// clipped. At most MAX_ROWS rows, none older than KEEP_DAYS.
//
// What counts: failed sign-ins, public visits to the owner page, scanner
// paths, exploit patterns in paths, queries or form fields, oversized or
// malformed requests, locked demo features, rate-limit hits and bans.
// Ordinary use (signing in, pages that load) is never noted.

const { clientAddress, normalizeIp } = require('./clientAddress');

const MAX_ROWS = 20000;
const KEEP_DAYS = 30;
const KINDS = new Set(['login', 'owner-probe', 'scan', 'exploit', 'malformed', 'locked-feature', 'rate-limit', 'ban']);

// paths only scanners ask for (the app has none of them)
const SCAN_PATHS = [
  /^\/wp-(admin|login|content|includes|json)\b/, /\/wp-login\.php/, /\/xmlrpc\.php/, /\/\.env(\.|\/|$)/, /\/\.git(\/|$)/,
  /\/\.(svn|hg|aws|ssh|docker)(\/|$)/, /\/\.ds_store$/, /\/\.ht(access|passwd)$/, /\/(phpmyadmin|pma|myadmin|adminer)(\/|$|\.php)/,
  /\/cgi-bin(\/|$)/, /\/boaform/, /\/hnap1/, /\/actuator(\/|$)/, /\/vendor\/phpunit/, /\/server-(status|info)$/, /\.php\d?$/,
  /\.(asp|aspx|jsp|cgi|pl|do|action)$/, /\/(solr|jenkins|geoserver|druid|telescope|_ignition|owa|ecp|autodiscover|goform|evox|mgmt)(\/|$)/,
  /\/manager\/html/, /\/remote\/login/, /\.(sql|bak|old|swp)(\.gz)?$/, /\/(backup|dump|db)\.(zip|tar|tgz|gz|sql)$/, /\/setup\.cgi/,
  /\/(config|credentials|secrets?)\.(ya?ml|ini|xml|php)$/, /\/sdk$/, /\/console(\/|$)/
];
// the app's own prefixes: never a scanner path (exploit patterns still count)
const APP_PREFIXES = ['/api/', '/web/', '/studio/', '/assets/', '/shared/', '/v/', '/.well-known/acme-challenge/'];

const EXPLOITS = [
  ['traversal', /\.\.[/\\]|[/\\]\.\.$|\/etc\/(passwd|shadow)|\/proc\/self\/|win\.ini|boot\.ini/i],
  ['traversal', /%2e%2e|\.\.%2f|%252e|%c0%ae/i],
  ['script', /<\s*script|javascript:|<[^>]*\bon(error|load|mouseover)\s*=/i],
  ['sql', /'\s*(or|and)\s+'?\w+'?\s*=\s*'?\w+|\bunion\b[\s\S]{0,20}\bselect\b|\bor\s+1\s*=\s*1\b|;\s*(drop|delete|insert|update)\s+\w|\bsleep\s*\(\s*\d+\s*\)|\bbenchmark\s*\(|waitfor\s+delay|'\s*--|"\s*or\s*"/i],
  ['jndi', /\$\{\s*(jndi|\$\{|lower:|upper:|env:|sys:|::-)/i],
  ['shell', /(;|\|\|?|&&|`)\s*(cat|wget|curl|sh|bash|nc|ncat|rm|chmod|uname|whoami|busybox|tftp|python3?|perl|powershell|id)(\s|$|;|\||`)|\$\(\s*[a-z]/i],
  ['null byte', /\0|%00/]
];
// form fields never looked at (their values may be secrets)
const SECRET_FIELD = /pass|secret|token|code|key|otp|totp|recovery/i;

const decodeOnce = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * A short, safe copy of what was tried: control, bidi and other invisible
 * characters written as \u{..}, at most `n` characters.
 */
function clip(value, n = 160) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, (c) => `\\u{${c.charCodeAt(0).toString(16)}}`);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The exploit a text shows ('traversal', 'sql', ...), or null. */
function exploitIn(text) {
  const raw = String(text || '');
  const once = decodeOnce(raw.replace(/\+/g, ' '));
  const twice = decodeOnce(once);
  for (const [name, re] of EXPLOITS) if (re.test(raw) || re.test(once) || re.test(twice)) return name;
  return null;
}

/** Whether a path is one only scanners ask for. */
function isScanPath(pathname) {
  const p = decodeOnce(String(pathname || '')).toLowerCase();
  if (APP_PREFIXES.some((x) => p.startsWith(x))) return false;
  return SCAN_PATHS.some((re) => re.test(p));
}

/**
 * What a request's URL (as sent: req.url, before any normalizing) is:
 * { kind: 'exploit' | 'scan', detail } or null for an ordinary one.
 */
function classifyUrl(rawUrl) {
  const u = String(rawUrl || '');
  const q = u.indexOf('?');
  const pathPart = q < 0 ? u : u.slice(0, q);
  const what = exploitIn(u);
  if (what) return { kind: 'exploit', detail: `${what}: ${u}` };
  if (isScanPath(pathPart)) return { kind: 'scan', detail: u };
  return null;
}

/** An exploit pattern in a request body's fields (secret fields skipped): { kind, detail } or null. */
function classifyFields(body, depth = 0) {
  if (!body || typeof body !== 'object' || depth > 1) return null;
  let n = 0;
  for (const [k, v] of Object.entries(body)) {
    if (++n > 50) break;
    if (SECRET_FIELD.test(k)) continue;
    if (typeof v === 'string') {
      const what = exploitIn(v.slice(0, 4000));
      if (what) return { kind: 'exploit', detail: `${what}: ${k}=${v}` };
    } else if (v && typeof v === 'object') {
      const hit = classifyFields(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** A CSV cell: quoted, and never read as a formula by a spreadsheet. */
function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r|%]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * @param {{ db: any, log?: any, now?: () => number, addressOf?: (req: any) => string, maxRows?: number, keepDays?: number }} o
 */
function createAttackLog({ db, log = null, now = () => Date.now(), addressOf = (req) => clientAddress(req), maxRows = MAX_ROWS, keepDays = KEEP_DAYS } = {}) {
  const sql = db.db;
  sql.exec(`CREATE TABLE IF NOT EXISTS attack_log (
    ip TEXT NOT NULL, kind TEXT NOT NULL, sample TEXT NOT NULL DEFAULT '', agent TEXT NOT NULL DEFAULT '',
    count INTEGER NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (ip, kind));
    CREATE INDEX IF NOT EXISTS attack_log_last ON attack_log (last_seen);`);
  const q = (s) => db.q(s);
  let sinceprune = 0;

  function prune() {
    q('DELETE FROM attack_log WHERE last_seen < ?').run(now() - keepDays * 86400_000);
    const n = Number(q('SELECT COUNT(*) AS n FROM attack_log').get().n);
    if (n > maxRows) q('DELETE FROM attack_log WHERE rowid IN (SELECT rowid FROM attack_log ORDER BY last_seen ASC LIMIT ?)').run(n - maxRows);
  }
  prune();

  const addressFrom = (req) => {
    if (typeof req === 'string') return normalizeIp(req) || clip(req, 64);
    try {
      return addressOf(req) || '?';
    } catch {
      return '?';
    }
  };

  /** One attempt of this kind from this request's address (detail: never a password). */
  function note(kind, req, detail = '') {
    try {
      const k = KINDS.has(kind) ? kind : 'malformed';
      const ip = clip(addressFrom(req), 80);
      const agent = typeof req === 'string' ? '' : clip(req?.headers?.['user-agent'] || '', 200);
      const t = now();
      q(`INSERT INTO attack_log (ip, kind, sample, agent, count, first_seen, last_seen) VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (ip, kind) DO UPDATE SET count = count + 1, last_seen = excluded.last_seen, sample = excluded.sample,
         agent = CASE WHEN excluded.agent = '' THEN agent ELSE excluded.agent END`).run(ip, k, clip(detail), agent, t, t);
      if (++sinceprune >= 200) {
        sinceprune = 0;
        prune();
      }
    } catch (err) {
      log?.warn?.(`Attack log: ${err.message}`);
    }
  }

  /** Notes a scanner path or an exploit pattern in this request's URL; the kind, or null. */
  function inspect(req) {
    const hit = classifyUrl(req.url);
    if (hit) note(hit.kind, req, hit.detail);
    return hit?.kind || null;
  }

  /** Notes an exploit pattern in a request body's fields; the kind, or null. */
  function inspectFields(req, body) {
    const hit = classifyFields(body);
    if (hit) note(hit.kind, req, hit.detail);
    return hit?.kind || null;
  }

  const rowOut = (r) => ({ address: r.ip, kind: r.kind, count: Number(r.count), firstSeen: Number(r.first_seen), lastSeen: Number(r.last_seen), sample: r.sample, agent: r.agent });
  function rows({ kind = '', address = '' } = {}) {
    prune();
    const where = [];
    const args = [];
    if (kind && KINDS.has(kind)) { where.push('kind = ?'); args.push(kind); }
    if (address) { where.push('ip = ?'); args.push(String(address).slice(0, 80)); }
    return q(`SELECT * FROM attack_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_seen DESC LIMIT ${maxRows}`).all(...args).map(rowOut);
  }

  /**
   * The log grouped by address: newest first (sort 'newest') or the most
   * attempts first (sort 'active'), at most `limit` addresses.
   */
  function list({ kind = '', address = '', sort = 'newest', limit = 500 } = {}) {
    const groups = new Map();
    for (const r of rows({ kind, address })) {
      let g = groups.get(r.address);
      if (!g) groups.set(r.address, (g = { address: r.address, count: 0, firstSeen: r.firstSeen, lastSeen: r.lastSeen, kinds: {}, entries: [] }));
      g.count += r.count;
      g.firstSeen = Math.min(g.firstSeen, r.firstSeen);
      g.lastSeen = Math.max(g.lastSeen, r.lastSeen);
      g.kinds[r.kind] = (g.kinds[r.kind] || 0) + r.count;
      g.entries.push(r);
    }
    const out = [...groups.values()];
    out.sort(sort === 'active' ? (a, b) => b.count - a.count || b.lastSeen - a.lastSeen : (a, b) => b.lastSeen - a.lastSeen || b.count - a.count);
    return out.slice(0, Math.max(1, Math.min(Number(limit) || 500, 5000)));
  }

  /** The rows as CSV (cells escaped against formula injection). */
  function csv(filters = {}) {
    const head = ['address', 'kind', 'count', 'first_seen', 'last_seen', 'sample', 'user_agent'];
    const lines = [head.join(',')];
    for (const r of rows(filters)) {
      lines.push([r.address, r.kind, r.count, new Date(r.firstSeen).toISOString(), new Date(r.lastSeen).toISOString(), r.sample, r.agent].map(csvCell).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  // distinct real addresses today (every request, nothing kept but the count)
  let day = '';
  let today = new Set();
  function seen(req) {
    const d = new Date(now()).toDateString();
    if (d !== day) { day = d; today = new Set(); }
    if (today.size < 200000) today.add(addressFrom(req));
  }

  function stats() {
    prune();
    const byKind = {};
    for (const r of q('SELECT kind, COUNT(*) AS rows, SUM(count) AS n FROM attack_log GROUP BY kind').all()) byKind[r.kind] = Number(r.n);
    const d = new Date(now()).toDateString();
    return {
      rows: Number(q('SELECT COUNT(*) AS n FROM attack_log').get().n),
      addresses: Number(q('SELECT COUNT(DISTINCT ip) AS n FROM attack_log').get().n),
      last24h: Number(q('SELECT COUNT(DISTINCT ip) AS n FROM attack_log WHERE last_seen > ?').get(now() - 86400_000).n),
      byKind,
      visitorsToday: d === day ? today.size : 0
    };
  }

  return { note, inspect, inspectFields, list, csv, stats, seen, prune };
}

module.exports = { createAttackLog, classifyUrl, classifyFields, isScanPath, exploitIn, csvCell, clip, KINDS, MAX_ROWS, KEEP_DAYS };
