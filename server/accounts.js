'use strict';

// Accounts beyond the first: roles, two-step sign-in and signed-in devices.
//
// Roles: 'admin' (everything, as before) or 'viewer' (watch-only: footage,
// the Viewer, exports, maps, starred moments; no deleting, converting or
// changing settings). Accounts from before roles are admins. There is
// always at least one admin.
//
// Two-step sign-in (TOTP, RFC 6238: the 6-digit codes of an authenticator
// app, made on the phone, nothing sent anywhere): turned on per account. A
// right password then gives a "pending" sign-in for 5 minutes, and the
// sign-in finishes on /login/code with a code (or one of ten one-time
// recovery codes). The secret and the recovery codes (hashed) are kept with
// the account in the database.

const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** The 6-digit code of a secret for a time step. */
function totp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = (h.readUInt32BE(o) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, '0');
}

/** The time step a code matches (this one, or one before or after), or null. */
function matchTotp(secret, code, now = Date.now()) {
  const given = String(code || '').replace(/\D/g, '');
  if (given.length !== 6) return null;
  const c = Math.floor(now / 1000 / STEP);
  for (const d of [0, -1, 1]) {
    const want = totp(secret, c + d);
    if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(given))) return c + d;
  }
  return null;
}

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
/** A recovery code as kept: its 10 letters and digits, so a dash or space typed or not is the same. */
const recoveryKey = (code) => String(code || '').toLowerCase().replace(/[^0-9a-f]/g, '');
const ROLES = ['admin', 'viewer'];

function createAccounts({ db, issuer = 'Sentry Six Manager', now = () => Date.now() }) {
  const metaKey = (u) => `account:${u}`;
  const meta = (u) => ({ role: 'admin', ...(db.get(metaKey(u), {}) || {}) });
  const setMeta = (u, m) => db.set(metaKey(u), m);
  const pending = new Map(); // pending sign-ins: token hash -> { username, until, tries }

  function roleOf(username) {
    if (!username) return null;
    const r = meta(username).role;
    return ROLES.includes(r) ? r : 'admin';
  }
  function list() {
    return db.listUsers().map((u) => ({ username: u.username, createdAt: u.created_at, role: roleOf(u.username), twoFactor: Boolean(meta(u.username).totp?.enabled) }));
  }
  const admins = () => list().filter((u) => u.role === 'admin').length;
  function setRole(username, role) {
    if (!ROLES.includes(role)) throw Object.assign(new Error('The role is admin or viewer.'), { status: 400 });
    if (!db.getUser(username)) throw Object.assign(new Error('No such account.'), { status: 404 });
    if (role !== 'admin' && roleOf(username) === 'admin' && admins() <= 1) throw Object.assign(new Error('There must be one admin left: make another account admin first.'), { status: 409 });
    setMeta(username, { ...meta(username), role });
  }
  function remove(username) {
    if (!db.getUser(username)) throw Object.assign(new Error('No such account.'), { status: 404 });
    if (roleOf(username) === 'admin' && admins() <= 1) throw Object.assign(new Error('The last admin cannot be removed.'), { status: 409 });
    db.deleteUser(username);
    db.set(metaKey(username), null);
  }

  // ---- two-step sign-in
  /** A new secret to scan or type (not on until confirmed with a code). */
  function startTotp(username) {
    const secret = base32(crypto.randomBytes(20));
    setMeta(username, { ...meta(username), totpSetup: { secret, at: now() } });
    const label = encodeURIComponent(`${issuer}:${username}`);
    return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}` };
  }
  /** Turn it on with the first code; returns the recovery codes (shown once). */
  function enableTotp(username, code) {
    const m = meta(username);
    const setup = m.totpSetup;
    if (!setup || now() - setup.at > 15 * 60 * 1000) throw Object.assign(new Error('Start again: the set-up waited too long.'), { status: 400 });
    const step = matchTotp(setup.secret, code, now());
    if (step === null) throw Object.assign(new Error('That code is not right. Check the phone\'s clock, and use the newest code.'), { status: 400 });
    const recovery = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').replace(/(.{5})/, '$1-'));
    setMeta(username, { ...m, totpSetup: undefined, totp: { secret: setup.secret, enabled: true, last: step }, recovery: recovery.map((c) => sha(recoveryKey(c))), recoveryV: 2 });
    return recovery;
  }
  function disableTotp(username) {
    const m = meta(username);
    setMeta(username, { ...m, totp: undefined, totpSetup: undefined, recovery: undefined });
  }
  const twoFactorOn = (username) => Boolean(meta(username).totp?.enabled);
  /** A code (or a recovery code) for this account; each is used once. */
  function verifyCode(username, code) {
    const m = meta(username);
    if (!m.totp?.enabled) return false;
    const step = matchTotp(m.totp.secret, code, now());
    if (step !== null) {
      if (step <= (m.totp.last ?? -1)) return false; // used already
      setMeta(username, { ...m, totp: { ...m.totp, last: step } });
      return true;
    }
    // codes kept before recoveryV 2 were hashed with the dash
    const given = recoveryKey(code);
    if (given.length !== 10) return false;
    const h = sha(m.recoveryV === 2 ? given : `${given.slice(0, 5)}-${given.slice(5)}`);
    const i = (m.recovery || []).indexOf(h);
    if (i < 0) return false;
    const rest = [...m.recovery];
    rest.splice(i, 1);
    setMeta(username, { ...m, recovery: rest });
    return true;
  }
  const recoveryLeft = (username) => (meta(username).recovery || []).length;

  // ---- pending sign-ins (password right, code still to come)
  function startPending(username) {
    const token = crypto.randomBytes(24).toString('base64url');
    pending.set(sha(token), { username, until: now() + 5 * 60 * 1000, tries: 0 });
    for (const [k, v] of pending) if (v.until < now()) pending.delete(k);
    return token;
  }
  function pendingUser(token) {
    const p = token && pending.get(sha(token));
    return p && p.until > now() ? p.username : null;
  }
  /** The code for a pending sign-in: the user name when right; five wrong ones end it. */
  function finishPending(token, code) {
    const p = token && pending.get(sha(token));
    if (!p || p.until < now()) throw Object.assign(new Error('The sign-in waited too long: sign in again.'), { status: 401, expired: true });
    if (!verifyCode(p.username, code)) {
      if (++p.tries >= 5) pending.delete(sha(token));
      throw Object.assign(new Error(p.tries >= 5 ? 'Too many wrong codes: sign in again.' : 'That code is not right.'), { status: 401, expired: p.tries >= 5 });
    }
    pending.delete(sha(token));
    return p.username;
  }

  return { roleOf, list, setRole, remove, startTotp, enableTotp, disableTotp, twoFactorOn, verifyCode, recoveryLeft, startPending, pendingUser, finishPending };
}

/**
 * What a watch-only (viewer) account may do: read (GET) except the server's
 * logs, snapshots, support bundle and security settings, and these actions.
 */
const VIEWER_POSTS = [
  /^\/api\/auth\/(logout|confirm|password|2fa\/.*|sessions\/.*|sessions-end-others)$/,
  /^\/api\/telemetry\/speeds$/,
  /^\/api\/vehicles\/[^/]+\/exports$/,
  /^\/api\/exports(\/[^/]+)?$/,
  /^\/api\/stars(\/[^/]+)?$/,
  /^\/api\/places(\/[^/]+)?$/,
  /^\/api\/dashboards$/,
  /^\/api\/notifications\/[^/]+\/(read|dismiss)$/,
  /^\/api\/notifications\/read$/
];
// the CAN Bridge's logs, tokens and pairing are for admins; its signals, clips
// and searches (what the Viewer shows) stay readable
const VIEWER_HIDDEN = [/^\/api\/metrics/, /^\/api\/can\/(settings|files|tokens|pairing)(\/|$)/, /^\/api\/logs/, /^\/api\/support-bundle/, /^\/api\/snapshots/, /^\/api\/security/, /^\/api\/accounts/, /^\/api\/ui-packs\/original\.zip/, /^\/api\/nodes/];
function viewerMay(method, p) {
  if (method === 'GET' || method === 'HEAD') return !VIEWER_HIDDEN.some((re) => re.test(p));
  return VIEWER_POSTS.some((re) => re.test(p));
}

module.exports = { createAccounts, viewerMay, totp, matchTotp, base32, unbase32 };
