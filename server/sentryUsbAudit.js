'use strict';

// The Sentry USB security log (docs/sentry-usb-link.md, 6b): every event on
// the device port, every action sent to a Pi, the network each Pi says it is
// on, and three flags: "new address", "outside home" and "possible hijack
// attempt". Kept in its own table, 180 days by default and at most `maxRows`
// rows; identical failures from one address within an hour share one row
// (count, last time), so a flood cannot fill the disk.
//
// Everything a Pi or a stranger sent is untrusted text: cut, stripped of
// control characters, and never used to decide who a Pi is.

const { ipPermitted } = require('./tls');

const DAY = 86_400_000;
const COLLAPSE_MS = 3600_000;
const BURST = 3; // failed proofs from one address within 10 minutes: a hijack attempt
const FLAGS = { new: 'new address', outside: 'outside home', hijack: 'possible hijack attempt' };
const clean = (s, max = 120) => (s === null || s === undefined ? null : String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim().slice(0, max) || null);
const plainIp = (ip) => clean(String(ip || '').replace(/^::ffff:/, ''), 64);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sentryusb_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, last_at INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL, flags TEXT NOT NULL DEFAULT '', device_id TEXT, ip TEXT, port INTEGER, who TEXT, detail TEXT, collapse TEXT
);
CREATE INDEX IF NOT EXISTS sentryusb_audit_at ON sentryusb_audit(at);
CREATE INDEX IF NOT EXISTS sentryusb_audit_collapse ON sentryusb_audit(collapse, last_at);
CREATE INDEX IF NOT EXISTS sentryusb_audit_device ON sentryusb_audit(device_id, kind, at);
`;

// what each kind is, for people (and the filters)
const KINDS = {
  open: 'connection opened', 'fail-proof': 'handshake failed: bad proof', 'fail-id': 'handshake failed: unknown Sentry USB id',
  'fail-version': 'handshake failed: wrong version', 'fail-noslot': 'pairing with no pairing open', 'fail-timeout': 'handshake timed out',
  'fail-garbage': 'handshake failed: garbage frame', 'fail-oversized': 'handshake failed: oversized frame', 'fail-rate': 'refused: too many failures',
  'pair-ok': 'paired', 'pair-fail': 'pairing failed: wrong pairing code or password', connected: 'connected', disconnected: 'disconnected', replaced: 'replaced by a newer connection',
  unpaired: 'unpaired', net: 'network', alert: 'the Sentry USB reported', action: 'action', queued: 'queued action'
};
const ATTEMPT = (k) => k.startsWith('fail-') || k === 'pair-fail' || k === 'alert';

/**
 * @param {object} o
 * @param {import('./db').ManagerDB} o.db  (its SQLite handle, db.db)
 * @param {(n: object) => void} o.notify  raise a notification
 * @param {(id: string) => object|null} o.device  { name, notifyNetwork, home: { ssid, gw } } of a paired Pi
 * @param {{ info: Function, warn: Function }} o.log  each event also goes to the log (log search)
 */
function createSentryUsbAudit({ db, notify = () => {}, device = () => null, log = null, now = () => Date.now(), keepDays = 180, maxRows = 20_000 }) {
  const sql = db.db;
  sql.exec(SCHEMA);
  const q = (s) => db.q(s);

  function insert(row) {
    const r = q('INSERT INTO sentryusb_audit (at, last_at, count, kind, flags, device_id, ip, port, who, detail, collapse) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.at, row.at, row.kind, row.flags.join(','), row.deviceId, row.ip, row.port, row.who, row.detail, row.collapse);
    return Number(r.lastInsertRowid);
  }

  let added = 0;
  /**
   * One event. Returns its row id. { kind, deviceId, ip, port, who, detail, flags }
   * Failures and nets with the same kind, address, Pi and detail within an hour share a row.
   */
  function record(e) {
    const at = now();
    const row = {
      at, kind: KINDS[e.kind] ? e.kind : 'action', deviceId: clean(e.deviceId, 128), ip: plainIp(e.ip), port: Number.isInteger(e.port) ? e.port : null,
      who: clean(e.who, 64), detail: clean(e.detail, 300), flags: [...new Set(e.flags || [])].filter((f) => FLAGS[f])
    };
    // a stranger's failures from one address share a row whatever id it claims
    // (otherwise each made-up id is a new row and a new log line)
    const stranger = ATTEMPT(row.kind) && !row.deviceId;
    row.collapse = ATTEMPT(row.kind) || row.kind === 'net' || row.kind === 'open' ? [row.kind, row.ip, row.deviceId, stranger ? '' : row.detail, row.flags.join(',')].join('|') : null;
    let id = null;
    let fresh = true;
    if (row.collapse) {
      const same = q('SELECT id FROM sentryusb_audit WHERE collapse = ? AND last_at > ? ORDER BY last_at DESC LIMIT 1').get(row.collapse, at - COLLAPSE_MS);
      if (same) {
        q('UPDATE sentryusb_audit SET count = count + 1, last_at = ? WHERE id = ?').run(at, same.id);
        id = Number(same.id);
        fresh = false;
      }
    }
    if (id === null) id = insert(row);
    if (fresh) {
      const text = `${KINDS[row.kind]}${row.deviceId ? ` (${device(row.deviceId)?.name || row.deviceId})` : ''}${row.ip ? ` from ${row.ip}${row.port ? `:${row.port}` : ''}` : ''}${row.who ? ` by ${row.who}` : ''}${row.detail ? `: ${row.detail}` : ''}${row.flags.length ? ` [${row.flags.map((f) => FLAGS[f]).join(', ')}]` : ''}`;
      (row.flags.includes('hijack') ? log?.warn : log?.info)?.call(log, `Sentry USB security: ${text}`);
      raise(row, text);
    }
    if (++added % 200 === 0) prune();
    return id;
  }

  function raise(row, text) {
    const name = device(row.deviceId)?.name || 'a Sentry USB';
    if (row.flags.includes('hijack')) {
      // always on: a warning, one open per Pi and kind at a time (strangers
      // share one per kind: many addresses must not mean many notifications)
      notify({ kind: 'security', level: 'warning', always: true, dedupeKey: `sentryusb-hijack:${row.deviceId || 'stranger'}:${row.kind}`, title: `Possible hijack attempt on ${name}`, message: `${text}. Settings → Sentry USB → Security log has the details.` });
    } else if ((row.flags.includes('new') || row.flags.includes('outside')) && device(row.deviceId)?.notifyNetwork !== false) {
      notify({ kind: 'sentryusb', level: 'info', dedupeKey: `sentryusb-net:${row.deviceId}:${row.flags.join(',')}:${row.ip}:${row.detail}`, title: `${name}: ${row.flags.map((f) => FLAGS[f]).join(', ')}`, message: text });
    }
  }

  // ---- what the link reports
  const seenSince = (deviceId, column, value, since) => Boolean(q(`SELECT 1 FROM sentryusb_audit WHERE device_id = ? AND ${column} = ? AND last_at > ? AND kind IN ('connected', 'net') LIMIT 1`).get(deviceId, value, since));
  const outsideIp = (ip) => Boolean(ip) && !ipPermitted(ip);

  /** The Pi's usual home network: set by hand, else the one seen most in the last 30 days. */
  function home(deviceId) {
    const set = device(deviceId)?.home;
    if (set && (set.ssid || set.gw)) return { ssid: clean(set.ssid, 64), gw: clean(set.gw, 64), byHand: true };
    const rows = q("SELECT detail, SUM(count) AS n FROM sentryusb_audit WHERE device_id = ? AND kind = 'net' AND last_at > ? GROUP BY detail ORDER BY n DESC LIMIT 1").all(deviceId, now() - 30 * DAY);
    if (!rows.length) return null;
    const m = /^wifi "(.*)" via (\S*) /.exec(rows[0].detail || '');
    return m ? { ssid: m[1] || null, gw: m[2] === '-' ? null : m[2], byHand: false } : null;
  }

  const netDetail = (n) => `wifi "${n.ssid || ''}" via ${n.gw || '-'} on ${n.iface || '-'} as ${n.ip || '-'}`;

  /** Link events (server/sentryUsbLink.js onEvent). */
  function linkEvent(ev) {
    const base = { deviceId: ev.id || null, ip: ev.ip, port: ev.port };
    switch (ev.type) {
      case 'open': return record({ ...base, kind: 'open' });
      case 'fail': {
        const flags = [];
        // a failed handshake with a paired Pi's id, or pairing with nothing open
        if ((ev.why === 'bad proof' && ev.paired) || ev.why === 'no slot') flags.push('hijack');
        if (ev.why === 'bad proof' || ev.why === 'wrong password') {
          const burst = q("SELECT SUM(count) AS n FROM sentryusb_audit WHERE ip = ? AND kind IN ('fail-proof', 'pair-fail') AND last_at > ?").get(plainIp(ev.ip), now() - 10 * 60_000);
          if ((Number(burst?.n) || 0) + 1 >= BURST) flags.push('hijack');
        }
        const kind = { 'bad proof': 'fail-proof', 'unknown id': 'fail-id', version: 'fail-version', 'no slot': 'fail-noslot', timeout: 'fail-timeout', garbage: 'fail-garbage', oversized: 'fail-oversized', 'rate limited': 'fail-rate', 'wrong password': 'pair-fail' }[ev.why] || 'fail-garbage';
        return record({ ...base, kind, flags, detail: ev.claimed ? `claimed id ${ev.claimed}` : null });
      }
      case 'paired': return record({ ...base, kind: 'pair-ok', detail: ev.again ? 'paired again: the old link key was replaced' : null });
      case 'connected': {
        const flags = [];
        const ip = plainIp(ev.ip);
        if (ip && !seenSince(ev.id, 'ip', ip, now() - 90 * DAY) && q("SELECT 1 FROM sentryusb_audit WHERE device_id = ? AND kind = 'connected' LIMIT 1").get(ev.id)) flags.push('new');
        if (outsideIp(ip)) flags.push('outside');
        return record({ ...base, kind: 'connected', flags, detail: ev.version ? `version ${clean(ev.version, 40)}` : null });
      }
      case 'disconnected': return record({ ...base, kind: 'disconnected', detail: ev.reason || null });
      case 'replaced': return record({ ...base, kind: 'replaced' });
      case 'unpaired': return record({ ...base, kind: 'unpaired', who: ev.who || null, detail: ev.byPi ? 'unpaired on the Sentry USB itself' : null });
      case 'net': {
        const n = { ssid: clean(ev.ssid, 64), iface: clean(ev.iface, 16), ip: clean(ev.netIp, 64), gw: clean(ev.gw, 64) };
        const flags = [];
        const known = q("SELECT 1 FROM sentryusb_audit WHERE device_id = ? AND kind = 'net' LIMIT 1").get(ev.id);
        const recentNets = q("SELECT detail FROM sentryusb_audit WHERE device_id = ? AND kind = 'net' AND last_at > ?").all(ev.id, now() - 90 * DAY).map((r) => r.detail || '');
        const seen = (what, v) => recentNets.some((d) => (what === 'ssid' ? d.startsWith(`wifi "${v}" `) : d.includes(` via ${v} `)));
        if (known && ((n.ssid && !seen('ssid', n.ssid)) || (n.gw && !seen('gw', n.gw)))) flags.push('new');
        const h = home(ev.id);
        if (h && ((h.ssid && n.ssid && h.ssid !== n.ssid) || (h.gw && n.gw && h.gw !== n.gw))) flags.push('outside');
        return record({ ...base, kind: 'net', flags, detail: netDetail(n) });
      }
      case 'alert': {
        const what = ev.kind === 'fingerprint' ? 'a certificate fingerprint that did not match (a possible fake Manager)' : ev.kind === 'proof' ? 'a Manager proof that failed' : 'an alert';
        const when = Number.isFinite(ev.at) && ev.at > 0 ? ` at ${new Date(ev.at * 1000).toISOString()}` : '';
        return record({ ...base, kind: 'alert', flags: ['hijack'], detail: `${what}${ev.seen ? `, saw ${clean(ev.seen, 100)}` : ''}${when}` });
      }
      default: return null;
    }
  }

  /** An action sent to a Pi (proxied or queued): who, which route, the result. */
  const action = ({ deviceId, who, route, result, queued = false }) => record({ kind: queued ? 'queued' : 'action', deviceId, who, detail: `${clean(route, 120)}${result !== undefined ? ` → ${clean(result, 120)}` : ''}` });

  // ---- reading
  const FILTERS = {
    all: '1 = 1',
    attempts: "(kind LIKE 'fail-%' OR kind IN ('pair-fail', 'alert') OR flags LIKE '%hijack%')",
    network: "(flags LIKE '%new%' OR flags LIKE '%outside%')",
    actions: "kind IN ('action', 'queued')"
  };
  function list({ filter = 'all', deviceId = null, limit = 200, before = null } = {}) {
    const where = [FILTERS[filter] || FILTERS.all];
    const args = [];
    if (deviceId) { where.push('device_id = ?'); args.push(deviceId); }
    if (Number.isFinite(Number(before)) && before) { where.push('id < ?'); args.push(Number(before)); }
    const n = Math.max(1, Math.min(Number(limit) || 200, 1000));
    return sql.prepare(`SELECT * FROM sentryusb_audit WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${n}`).all(...args).map((r) => ({
      id: Number(r.id), at: Number(r.at), lastAt: Number(r.last_at), count: Number(r.count), kind: r.kind, what: KINDS[r.kind] || r.kind,
      flags: r.flags ? r.flags.split(',').filter(Boolean) : [], deviceId: r.device_id, ip: r.ip, port: r.port === null ? null : Number(r.port), who: r.who, detail: r.detail
    }));
  }

  /** CSV, every cell quoted; a cell starting = + - @ (or a tab/CR) gets a ' so a spreadsheet shows it as text. */
  function csv(rows, name = (id) => id) {
    const cell = (v) => {
      let s = v === null || v === undefined ? '' : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const head = ['first', 'last', 'count', 'event', 'flags', 'sentry_usb', 'address', 'port', 'who', 'detail'];
    const lines = rows.map((r) => [new Date(r.at).toISOString(), new Date(r.lastAt).toISOString(), r.count, r.what, r.flags.map((f) => FLAGS[f]).join('; '), r.deviceId ? name(r.deviceId) : '', r.ip, r.port, r.who, r.detail].map(cell).join(','));
    return `${head.map(cell).join(',')}\r\n${lines.join('\r\n')}${lines.length ? '\r\n' : ''}`;
  }

  function prune() {
    q('DELETE FROM sentryusb_audit WHERE last_at < ?').run(now() - keepDays * DAY);
    const n = Number(q('SELECT COUNT(*) AS n FROM sentryusb_audit').get().n);
    if (n <= maxRows) return;
    // over the cap: strangers' rows go first, so a flood from many addresses
    // cannot push out the paired Pis' history (pairing, connections, actions)
    const r = q('DELETE FROM sentryusb_audit WHERE id IN (SELECT id FROM sentryusb_audit WHERE device_id IS NULL ORDER BY id ASC LIMIT ?)').run(n - maxRows);
    const left = n - maxRows - Number(r.changes);
    if (left > 0) q('DELETE FROM sentryusb_audit WHERE id IN (SELECT id FROM sentryusb_audit ORDER BY id ASC LIMIT ?)').run(left);
  }

  return { record, linkEvent, action, list, csv, prune, home, FLAGS, KINDS, setKeepDays: (d) => { keepDays = Math.max(7, Math.min(Number(d) || 180, 3650)); } };
}

module.exports = { createSentryUsbAudit, AUDIT_FLAGS: FLAGS };
