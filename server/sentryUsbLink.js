'use strict';

// The management link to Sentry USB, the Pi in the car (docs/sentry-usb-link.md).
// The Pi connects out to the device port (CAN_PORT) at /api/sentryusb/link
// (WebSocket over TLS); both sides prove they hold a shared secret, then
// Manager sends requests and the Pi answers them and pushes its status.
//
// Pairing: an admin enters the Pi's web username and password; Manager
// derives K from them at once (PBKDF2), makes a one-time pairing code (60
// random bits) and keeps only P = HMAC(K, "pair-code|" + code) and the code,
// in memory, for 15 minutes; the password and K are forgotten at once. The
// owner types the code on the Pi. The first Pi that proves it holds P gets a
// random link key, stored with its device record; every later connection
// proves the link key instead. The code is shown only to the admin who opened
// the slot and is never stored or logged. The key never leaves this module except inside
// the TLS channel to its Pi: devices() and every API answer leave it out.

const crypto = require('crypto');
const { WsConnection, acceptKey } = require('./wsFrames');
const { cleanCar } = require('./sentryUsbCar');

const V = 2; // 2: pair mode is keyed by the pairing code (P), not K
const LINK_PATH = '/api/sentryusb/link';
const UNPAIRED_CLOSE = 4001; // either side: the link key is gone
const PBKDF2_ITERATIONS = 200_000;
const MIB = 1024 * 1024;
const MAX_FRAME = 2 * MIB; // a 1 MiB chunk in base64 inside JSON, with room
const MAX_HANDSHAKE_FRAME = 16 * 1024; // before the proof: no reason for more
const MAX_CHUNK = MIB;
const MAX_ANSWER = 64 * MIB;
const MAX_IN_FLIGHT = 8;
const MAX_BUFFERED = 96 * MIB; // chunked answers held at once for one Pi, all its requests together
const NOTICES = 20; // net and alert frames a Pi may send in NOTICE_MS; more are ignored
const NOTICE_MS = 10 * 60_000;
const MAX_STATUS = 256 * 1024;
const SLOT_FAILURES = 5; // a pairing slot closes after this many wrong proofs
const FAILS_PER_MINUTE = 10; // per address
const ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;

// only a string or a number becomes text: String() of a deeply nested array
// from the Pi recurses until the stack overflows, which would end the process
const text = (v) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
/** True when v nests deeper than `max` (checked only that far down). */
function tooDeep(v, max = 16) {
  if (!v || typeof v !== 'object') return false;
  if (max <= 0) return true;
  for (const x of Array.isArray(v) ? v : Object.values(v)) if (tooDeep(x, max - 1)) return true;
  return false;
}
const clean = (s, max) => text(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim().slice(0, max);

/** K: PBKDF2-HMAC-SHA256(password, "sentryusb-link|" + username, 200000, 32). */
function pairingKey(username, password, iterations = PBKDF2_ITERATIONS) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(Buffer.from(String(password), 'utf8'), Buffer.from(`sentryusb-link|${username}`, 'utf8'), iterations, 32, 'sha256', (err, key) => (err ? reject(err) : resolve(key)));
  });
}
// ---- the pairing code: 12 characters of Crockford base32 (60 bits), shown as XXXX-XXXX-XXXX
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const CODE_INVALID = 'That isn\'t a valid pairing code';
/** A new code, 12 characters from CODE_ALPHABET (crypto.randomInt). */
function newPairingCode() {
  let c = '';
  for (let i = 0; i < 12; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return c;
}
/** As both sides use it: upper case, no spaces or dashes, O -> 0, I and L -> 1; null unless 12 alphabet characters. */
function normalizePairingCode(input) {
  if (typeof input !== 'string' || input.length > 64) return null;
  const c = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE_RE.test(c) ? c : null;
}
/** For people: three groups of 4 joined by "-". */
const codeGroups = (code) => (code.match(/.{1,4}/g) || []).join('-');
/** P = HMAC-SHA256(K, "pair-code|" + normalized code): the pair-mode secret. */
const pairCodeSecret = (k, code) => crypto.createHmac('sha256', k).update(`pair-code|${code}`, 'utf8').digest();

const piProof = (secret, managerNonce, piNonce, fp, id) => crypto.createHmac('sha256', secret).update(`pi|${managerNonce}|${piNonce}|${fp}|${id}`, 'utf8').digest('hex');
const managerProof = (secret, managerNonce, piNonce, fp, id) => crypto.createHmac('sha256', secret).update(`mgr|${piNonce}|${managerNonce}|${fp}|${id}`, 'utf8').digest('hex');
/** Constant time; false for anything that is not 64 hex digits. */
function sameHex(given, expected) {
  if (typeof given !== 'string' || !HEX64.test(given)) return false;
  return crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}
/** "AB:CD:…" (Node's fingerprint256) or any hex -> 64 lowercase hex digits. */
const fpHex = (fp) => String(fp || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
/** For people, as the Pi shows it: 16 groups of 4 upper-case hex digits. */
const fpGroups = (hex) => (hex.toUpperCase().match(/.{1,4}/g) || []).join(' ');

// ---- Manager's copy of the allowlist (section 5); the Pi enforces its own
const NAME = '[A-Za-z0-9][A-Za-z0-9_.-]{0,63}';
const ALLOW = [
  // status
  ['GET', '/api/health'], ['GET', '/api/status'], ['GET', '/api/status/storage'], ['GET', '/api/profile'], ['GET', '/api/config'], ['GET', '/api/memory'],
  ['GET', '/api/system/version'], ['GET', '/api/system/clock-status'], ['GET', '/api/system/rtc-status'], ['GET', '/api/system/ping'], ['GET', '/api/backingfiles/free-space'],
  // settings
  ['GET', '/api/setup/config'], ['PUT', '/api/setup/config'], ['GET', '/api/setup/status'], ['GET', '/api/setup/phases'], ['POST', '/api/setup/run'],
  ['POST', '/api/setup/test-archive'], ['POST', '/api/setup/preflight'], ['GET', '/api/config/preference'], ['PUT', '/api/config/preference'],
  ['GET', '/api/notifications/settings'], ['PUT', '/api/notifications/settings'], ['GET', '/api/system/keep-accessory-config'], ['PUT', '/api/system/keep-accessory-config'],
  ['GET', '/api/system/update-source'], ['PUT', '/api/system/update-source'],
  // diagnostics
  ['GET', '/api/diagnostics'], ['POST', '/api/diagnostics/refresh'], ['POST', '/api/diagnostics/download'], ['GET', '/api/system/health-check'], ['GET', '/api/storage/health'],
  ['GET', `/api/logs/${NAME}`], ['GET', `/api/logs/${NAME}/page`], ['GET', `/api/logs/${NAME}/tail`],
  // updates
  ['POST', '/api/system/check-update'], ['POST', '/api/system/update'], ['GET', '/api/system/update-status'], ['GET', '/api/system/check-internet'],
  // actions
  ['POST', '/api/system/reboot'], ['POST', '/api/system/shutdown'], ['POST', '/api/system/trigger-sync'], ['POST', '/api/system/cancel-archive'],
  ['POST', '/api/system/toggle-drives'], ['POST', '/api/system/gadget-enable'], ['POST', '/api/system/gadget-disable'],
  // snapshots
  ['GET', '/api/snapshots'], ['GET', '/api/snapshots/live'], ['DELETE', `/api/snapshots/${NAME}`],
  // backups
  // (no GET /api/system/backup/{date}: a backup holds every secret and the car key; it stays on the Pi)
  ['POST', '/api/system/backup'], ['GET', '/api/system/backups']
].map(([method, p]) => ({ method, re: new RegExp(`^${p}$`) }));
// a few names the patterns above would let through but that are never meant
const NEVER = [/^\/api\/logs\/bluetooth(\/|$)/, /^\/api\/manager-link/, /\.\./];

/**
 * The Pi path for a proxied request, from the raw request target after
 * `/api/sentryusb/<id>/proxy` (still percent-encoded): '/api/…' or an Error
 * with .status. Encoded slashes, backslashes, dots, double slashes, control
 * characters and anything off the allowlist are refused.
 */
function proxyTarget(method, rawRest) {
  const bad = (status, msg) => Object.assign(new Error(msg), { status });
  const s = String(rawRest || '');
  if (!s.startsWith('/') || s.length > 300) return bad(400, 'Bad path.');
  // only plain path characters: no %-escapes at all, so nothing decodes into a slash or a dot
  if (!/^[A-Za-z0-9/_.-]+$/.test(s)) return bad(400, 'Bad path.');
  if (s.includes('//') || s.split('/').some((seg) => seg === '.' || seg === '..') || s.endsWith('/')) return bad(400, 'Bad path.');
  const p = `/api${s}`;
  if (NEVER.some((re) => re.test(p))) return bad(403, 'Not allowed over the Sentry Manager link.');
  if (!ALLOW.some((a) => a.method === method && a.re.test(p))) return bad(403, 'Not allowed over the Sentry Manager link.');
  return p;
}

/**
 * Manager's own check of a proxied PUT /api/setup/config body (the Pi checks
 * it too): an object of setup keys to plain values with no control
 * characters, which could start a new line in sentryusb.conf. null when
 * it is fine, else what is wrong.
 */
function badSetupBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'The settings must be an object.';
  const keys = Object.keys(body);
  if (keys.length > 500) return 'Too many settings.';
  for (const k of keys) {
    if (!/^[A-Z][A-Z0-9_]{0,63}(__set)?$/.test(k)) return `Bad setting ${k.slice(0, 64)}.`;
    const v = body[k];
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) continue;
    if (typeof v !== 'string' || v.length > 4096 || /[\u0000-\u001f\u007f]/.test(v)) return `Bad value for ${k}.`;
  }
  return null;
}

/** The Pi's status as this server answers it: an informational (1xx) one is no answer. */
const answerStatus = (status) => (status === 401 || status === 407 || status < 200 ? 502 : status);

const SAFE_TYPES = new Set(['application/json', 'text/plain', 'application/zip', 'application/gzip', 'application/x-gzip', 'application/x-tar', 'application/octet-stream']);
/** The Pi's content type, cut to a type the browser can be given safely. */
function safeType(type) {
  const t = text(type).split(';')[0].trim().toLowerCase();
  return SAFE_TYPES.has(t) ? t : 'application/octet-stream';
}

// setup fields that hold a secret, as the Pi decides (manager_link secrets.rs
// is_secret_key): masked here as well, whatever the Pi sent
const isSecretKey = (k) => k.includes('PASS') || k.includes('TOKEN') || k.includes('SECRET') || k.endsWith('_KEY') || k.endsWith('_KEY_ID') || k.endsWith('WEBHOOK_URL') || k === 'NTFY_URL' || k === 'IFTTT_KEY';
// the setup keys Manager may change (the Pi's SETTABLE list); every other key is read-only over the link
const SETTABLE = new Set([
  'SSID', 'WIFIPASS', 'AP_SSID', 'AP_PASS', 'AP_IP', 'SENTRYUSB_HOSTNAME', 'TIME_ZONE',
  'ARCHIVE_SYSTEM', 'ARCHIVE_SERVER', 'SHARE_NAME', 'SHARE_USER', 'SHARE_PASSWORD', 'SHARE_DOMAIN', 'CIFS_VERSION', 'CIFS_SEC', 'CIFS_NOSERVERINO', 'RSYNC_USER',
  'RSYNC_SERVER', 'RSYNC_PATH', 'RSYNC_SSH_PORT', 'RCLONE_DRIVE', 'RCLONE_PATH', 'MUSIC_SHARE_NAME', 'ARCHIVE_DELAY', 'ARCHIVE_STALL_GRACE_SECONDS',
  'ARCHIVE_RECENTCLIPS', 'ARCHIVE_SAVEDCLIPS', 'ARCHIVE_SENTRYCLIPS', 'ARCHIVE_TRACKMODECLIPS', 'ARCHIVE_VERIFY', 'ARCHIVE_VERIFY_MODE',
  'ARCHIVE_VERIFY_MAX_SECONDS', 'ARCHIVE_VERIFY_RECHECK_SECONDS', 'ARCHIVE_VERIFY_PARALLEL', 'ARCHIVE_VERIFY_MANAGER_WAIT_HOURS', 'ARCHIVE_AUTO_DELETE_VERIFIED', 'SNAPSHOT_INTERVAL',
  'TRIGGER_FILE_SAVED', 'TRIGGER_FILE_SENTRY', 'TRIGGER_FILE_RECENT', 'TRIGGER_FILE_ANY', 'SENTRY_CASE', 'DRIVE_MAP_ENABLED', 'DRIVE_MAP_UNIT', 'DRIVE_MAP_WHILE_AWAY',
  'NOTIFICATION_TITLE', 'PUSHOVER_ENABLED', 'PUSHOVER_USER_KEY', 'PUSHOVER_APP_KEY', 'GOTIFY_ENABLED', 'GOTIFY_DOMAIN', 'GOTIFY_APP_TOKEN', 'GOTIFY_PRIORITY',
  'DISCORD_ENABLED', 'DISCORD_WEBHOOK_URL', 'TELEGRAM_ENABLED', 'TELEGRAM_CHAT_ID', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_SILENT_NOTIFY', 'IFTTT_ENABLED', 'IFTTT_EVENT_NAME',
  'IFTTT_KEY', 'SLACK_ENABLED', 'SLACK_WEBHOOK_URL', 'SIGNAL_ENABLED', 'SIGNAL_URL', 'SIGNAL_FROM_NUM', 'SIGNAL_TO_NUM', 'MATRIX_ENABLED', 'MATRIX_SERVER_URL',
  'MATRIX_USERNAME', 'MATRIX_PASSWORD', 'MATRIX_ROOM', 'SNS_ENABLED', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SNS_TOPIC_ARN', 'WEBHOOK_ENABLED',
  'WEBHOOK_URL', 'NTFY_ENABLED', 'NTFY_URL', 'NTFY_TOKEN', 'NTFY_PRIORITY', 'MOBILE_PUSH_ENABLED', 'KEEP_AWAKE_WEBHOOK_URL', 'TESLAFI_API_TOKEN', 'TESSIE_API_TOKEN',
  'TESSIE_VIN', 'TESLA_BLE_VIN', 'TEMPERATURE_WARNING', 'TEMPERATURE_CAUTION', 'TEMPERATURE_INTERVAL', 'TEMPERATURE_POSTARCHIVE', 'TEMPERATURE_UNIT', 'SYSTEM_TEMPERATURE_UNIT', 'PRESSURE_UNIT'
]);
// a stored secret cannot follow a changed destination: changing one of these needs the secret again
const SECRET_TARGETS = {
  SHARE_PASSWORD: ['ARCHIVE_SYSTEM', 'ARCHIVE_SERVER', 'SHARE_USER', 'SHARE_DOMAIN'], WIFIPASS: ['SSID'], MATRIX_PASSWORD: ['MATRIX_SERVER_URL', 'MATRIX_USERNAME'],
  GOTIFY_APP_TOKEN: ['GOTIFY_DOMAIN'], NTFY_TOKEN: ['NTFY_URL'], AWS_SECRET_ACCESS_KEY: ['AWS_REGION', 'AWS_ACCESS_KEY_ID']
};
/** The secrets a set of changed keys needs sent again: [[secret, [changed targets]]]. */
function secretsNeeded(changed, given) {
  return Object.entries(SECRET_TARGETS).map(([sec, targets]) => [sec, targets.filter((t) => changed.has(t))]).filter(([sec, hit]) => hit.length && !given(sec));
}
/**
 * The Pi's setup config ({ KEY: { value, active } }) with every secret value
 * emptied and "<KEY>__set": true where one exists (section 5).
 */
function maskConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return {};
  const out = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k.replace(/__set$/, ''))) continue;
    if (k.endsWith('__set')) { if (v === true || v?.value === true) out[k] = true; continue; }
    if (!v || typeof v !== 'object') continue;
    const value = typeof v.value === 'boolean' ? String(v.value) : text(v.value);
    const entry = { value: value.slice(0, 4096), active: Boolean(v.active) };
    // a Pi that masks sends secrets empty; one that sent a value is not trusted
    // to keep a secret it gets back empty, so the page will not save (__unmasked)
    if (isSecretKey(k) && entry.value) {
      out[`${k}__set`] = true;
      out.__unmasked = true;
      entry.value = '';
    }
    out[k] = entry;
  }
  return out;
}

/**
 * @param {object} o
 * @param {{ get: Function, set: Function }} o.db
 * @param {{ info: Function, warn: Function }} o.log
 * @param {() => void} [o.onChange]  devices, the slot or the connections changed
 * @param {(id: string, first: boolean) => void} [o.onStatus]  a Pi pushed its status (first: since it connected)
 * @param {(e: object) => void} [o.onEvent]  every device-port event, for the security log (server/sentryUsbAudit.js)
 */
function createSentryUsbLink({
  db, log, onChange = () => {}, onStatus = () => {}, onEvent = () => {}, now = () => Date.now(), iterations = PBKDF2_ITERATIONS,
  slotMs = 15 * 60_000, handshakeMs = 10_000, requestMs = 60_000, pingMs = 30_000, silentMs = 90_000
}) {
  const KEY = 'sentryusb';
  const load = () => {
    const d = db.get(KEY, null);
    return { devices: Array.isArray(d?.devices) ? d.devices : [] };
  };
  let store = load();
  const save = () => db.set(KEY, store);
  const byId = (id) => store.devices.find((d) => d.id === id) || null;

  let slot = null; // { name, p, code, by, expiresAt, failures, timer }; p and code in memory only
  let lastPairing = null; // { ok, why, deviceId, name, at } shown to the admin
  const links = new Map(); // device id -> link
  const failures = new Map(); // address -> [times]
  const statusSavedAt = new Map();

  const changed = () => { try { onChange(); } catch { /* the caller's */ } };
  const event = (e) => { try { onEvent(e); } catch (err) { log.warn(`Sentry USB security log: ${err.message}`); } };

  // ---- failures per address: at most FAILS_PER_MINUTE a minute
  const recent = (ip) => (failures.get(ip) || []).filter((t) => t > now() - 60_000);
  const limited = (ip) => recent(ip).length >= FAILS_PER_MINUTE;
  const noteFailure = (ip) => {
    const list = recent(ip);
    list.push(now());
    failures.set(ip, list);
    if (failures.size > 10_000) for (const [k] of failures) { failures.delete(k); if (failures.size < 5000) break; }
  };

  function closeSlot(why) {
    if (!slot) return;
    clearTimeout(slot.timer);
    slot.p.fill(0);
    if (why) lastPairing = { ok: false, why, name: slot.name, at: now() };
    slot = null;
    changed();
  }

  async function openPairing({ name, username, password, by = null }) {
    const label = clean(name, 40);
    if (!label) throw Object.assign(new Error('Give it a name.'), { status: 400 });
    if (typeof username !== 'string' || !username || username.length > 128) throw Object.assign(new Error('Enter the Pi\'s web username.'), { status: 400 });
    if (typeof password !== 'string' || !password || password.length > 1024) throw Object.assign(new Error('Enter the Pi\'s web password. A Pi with no web password cannot be paired: set one on the Pi first.'), { status: 400 });
    const k = await pairingKey(username, password, iterations);
    // a new slot, a new code; K is not kept, only P
    const code = newPairingCode();
    const p = pairCodeSecret(k, code);
    k.fill(0);
    if (slot) { clearTimeout(slot.timer); slot.p.fill(0); }
    const expiresAt = now() + slotMs;
    const timer = setTimeout(() => closeSlot('expired'), slotMs);
    timer.unref?.();
    slot = { name: label, p, code, by: by ?? null, expiresAt, failures: 0, timer };
    lastPairing = null;
    changed();
    return pairing({ codeFor: slot.by });
  }

  /**
   * The slot's state. The code is in it only for the admin who opened the
   * slot: pass codeFor (that account's name) when the caller is an admin.
   */
  const pairing = ({ codeFor } = {}) => ({
    open: Boolean(slot), name: slot?.name || null, expiresAt: slot?.expiresAt || null, failures: slot?.failures || 0,
    ...(slot && codeFor !== undefined && codeFor === slot.by ? { code: codeGroups(slot.code) } : {}),
    last: lastPairing && lastPairing.at > now() - 30 * 60_000 ? { ...lastPairing } : null
  });

  function devices() {
    return store.devices.map((d) => {
      const l = links.get(d.id);
      return {
        id: d.id, name: d.name, hostname: d.hostname || null, paired: Boolean(d.key), online: Boolean(l), lastSeen: l ? now() : d.lastSeen || null,
        connectedAt: l?.since || null, address: l?.ip || d.address || null, version: d.version || null, pairedAt: d.pairedAt || null,
        status: d.status ?? null, statusAt: d.statusAt || null, protocolError: d.protocolError || null,
        net: d.net || null, notifyNetwork: d.notifyNetwork !== false, home: d.home || null
      };
    });
  }

  function rename(id, name) {
    const d = byId(id);
    if (!d) return null;
    const label = clean(name, 40);
    if (!label) throw Object.assign(new Error('Give it a name.'), { status: 400 });
    d.name = label;
    save();
    changed();
    return d.name;
  }

  function unpair(id, who = null) {
    const d = byId(id);
    if (!d) return false;
    event({ type: 'unpaired', id, who });
    store.devices = store.devices.filter((x) => x.id !== id);
    save();
    const l = links.get(id);
    if (l) l.drop(UNPAIRED_CLOSE, 'unpaired');
    changed();
    return true;
  }

  // ---- one Pi's connection after its handshake
  function makeLink(ws, id, ip, port) {
    const pending = new Map(); // request id -> { resolve, timer, chunks, bytes, res }
    let stray = 0;
    let notices = []; // times of its net and alert frames
    // every frame of these is a database write, a security-log row and maybe a notification
    const noticeOk = () => {
      notices = notices.filter((t) => t > now() - NOTICE_MS);
      if (notices.length >= NOTICES) {
        if (notices.length === NOTICES) { notices.push(now()); log.warn(`Sentry USB ${id}: over ${NOTICES} network reports or alerts in 10 minutes, the rest ignored`); }
        return false;
      }
      notices.push(now());
      return true;
    };
    const buffered = () => { let n = 0; for (const p of pending.values()) n += p.bytes; return n; };
    const link = { ws, id, ip, port, since: now(), pending };
    const settle = (rid, out) => {
      const p = pending.get(rid);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(rid);
      p.resolve(out);
    };
    const failAll = (status, error) => { for (const rid of [...pending.keys()]) settle(rid, { status, error }); };
    link.drop = (code, reason) => {
      ws.close(code, reason);
      ws.terminate?.();
    };
    link.request = ({ method, path, query = '', body = null }) => new Promise((resolve) => {
      if (pending.size >= MAX_IN_FLIGHT) return resolve({ status: 429, error: 'The Sentry USB is busy with 8 requests: try again in a moment.' });
      const rid = crypto.randomBytes(12).toString('hex');
      const timer = setTimeout(() => settle(rid, { status: 504, error: 'The Sentry USB did not answer within 60 seconds.' }), requestMs);
      timer.unref?.();
      pending.set(rid, { resolve, timer, chunks: null, bytes: 0, res: null, seq: 0 });
      if (!ws.send(JSON.stringify({ t: 'req', id: rid, method, path, query, body: body ?? null }))) settle(rid, { status: 502, error: 'The Sentry USB is not connected.' });
    });
    // a Pi that sends something wrong: what for, then closed
    const violation = (why) => {
      const d = byId(id);
      if (d) { d.protocolError = { why: clean(why, 120), at: now() }; save(); }
      log.warn(`Sentry USB ${id}: closed the link (${why})`);
      failAll(502, 'The Sentry USB sent a broken answer.');
      link.drop(1008, 'protocol');
    };
    link.violation = violation;
    const strayFrame = () => { if (++stray > 20) violation('answers for requests it was not asked'); };
    link.onMessage = (m) => {
      if (m.t === 'status') {
        const d = byId(id);
        if (!d) return;
        // (a status nested deeper than any real one would only break the page that shows it;
        // checked first, as stringifying one thousands deep can overflow the stack)
        if (tooDeep(m.body)) return;
        const text = JSON.stringify(m.body ?? null);
        if (text.length > MAX_STATUS) return;
        d.status = JSON.parse(text);
        // the car readings (section 4, "The car"): known keys in range only
        if (d.status && typeof d.status === 'object' && !Array.isArray(d.status) && 'car' in d.status) {
          const car = cleanCar(d.status.car, { now: now() });
          if (car) d.status.car = car; else delete d.status.car;
        }
        d.statusAt = now();
        d.lastSeen = now();
        // kept in memory at once; written at most once a minute
        if (!(statusSavedAt.get(id) > now() - 60_000)) { statusSavedAt.set(id, now()); save(); }
        changed();
        link.statuses = (link.statuses || 0) + 1;
        try { onStatus(id, link.statuses === 1); } catch (err) { log.warn(`Sentry USB ${id}: ${err.message}`); }
        return;
      }
      if ((m.t === 'net' || m.t === 'alert') && !noticeOk()) return;
      if (m.t === 'net') {
        // untrusted detail for the log, never used to tell who the Pi is
        const d = byId(id);
        const n = { ssid: clean(m.ssid, 64) || null, iface: clean(m.iface, 16) || null, ip: clean(m.ip, 64) || null, gw: clean(m.gw, 64) || null };
        if (d) { d.net = { ...n, at: now() }; save(); changed(); }
        event({ type: 'net', id, ip, port, ssid: n.ssid, iface: n.iface, netIp: n.ip, gw: n.gw });
        return;
      }
      if (m.t === 'alert') {
        event({ type: 'alert', id, ip, port, kind: m.kind === 'fingerprint' || m.kind === 'proof' ? m.kind : 'other', seen: clean(m.seen, 128) || null, at: typeof m.at === 'number' && Number.isFinite(m.at) ? m.at : null });
        return;
      }
      if (m.t === 'ping') { ws.send('{"t":"pong"}'); return; }
      if (m.t === 'pong') return;
      if (m.t === 'res') {
        const p = typeof m.id === 'string' ? pending.get(m.id) : null;
        if (!p || p.res) return strayFrame();
        const status = Number.isInteger(m.status) && m.status >= 100 && m.status <= 599 ? m.status : 502;
        const type = safeType(m.type);
        if (m.chunked === true) {
          p.res = { status, type };
          p.chunks = [];
          return undefined;
        }
        if (typeof m.bodyB64 === 'string') {
          const buf = Buffer.from(m.bodyB64, 'base64');
          return settle(m.id, { status, type, buf });
        }
        return settle(m.id, { status, type, body: m.body ?? null });
      }
      if (m.t === 'chunk') {
        const p = typeof m.id === 'string' ? pending.get(m.id) : null;
        if (!p || !p.chunks) return strayFrame();
        if (m.seq !== p.seq || typeof m.data !== 'string') return violation('chunks out of order');
        const buf = Buffer.from(m.data, 'base64');
        if (buf.length > MAX_CHUNK) return violation('a chunk over 1 MiB');
        p.bytes += buf.length;
        if (p.bytes > MAX_ANSWER) {
          settle(m.id, { status: 502, error: 'The Sentry USB\'s answer is over 64 MiB.' });
          return undefined;
        }
        if (buffered() > MAX_BUFFERED) {
          settle(m.id, { status: 502, error: 'The Sentry USB is sending too much at once: try again in a moment.' });
          return undefined;
        }
        p.chunks.push(buf);
        p.seq += 1;
        return undefined;
      }
      if (m.t === 'end') {
        const p = typeof m.id === 'string' ? pending.get(m.id) : null;
        if (!p || !p.chunks) return strayFrame();
        // an answer cut short on the Pi ("too large", "read failed") failed
        if (m.error !== undefined && m.error !== null) return settle(m.id, { status: 502, error: `The Sentry USB could not send the whole answer (${clean(m.error, 40) || 'error'}).` });
        return settle(m.id, { ...p.res, buf: Buffer.concat(p.chunks, p.bytes) });
      }
      if (m.t === 'auth' || m.t === 'hello' || m.t === 'ok') return violation('a second handshake');
      return strayFrame();
    };
    link.onClose = () => failAll(502, 'The Sentry USB disconnected before it answered.');
    return link;
  }

  // ---- the device port: a WebSocket upgrade at /api/sentryusb/link
  function handleUpgrade(req, socket, head) {
    const refuse = (code, text) => {
      try { socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
      socket.destroy();
    };
    const p = String(req.url || '').split('?')[0];
    if (p !== LINK_PATH) return refuse(404, 'Not Found');
    if (req.method !== 'GET' || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !/\bupgrade\b/i.test(String(req.headers.connection || ''))) return refuse(400, 'Bad Request');
    const key = String(req.headers['sec-websocket-key'] || '');
    if (req.headers['sec-websocket-version'] !== '13' || Buffer.from(key, 'base64').length !== 16) return refuse(400, 'Bad Request');
    // TLS only: the proof covers the certificate this connection uses
    const cert = typeof socket.getCertificate === 'function' ? socket.getCertificate() : null;
    const fp = fpHex(cert?.fingerprint256);
    if (!HEX64.test(fp)) return refuse(400, 'Bad Request');
    const ip = String(socket.remoteAddress || '?').replace(/^::ffff:/, '');
    const port = socket.remotePort || null;
    if (limited(ip)) {
      event({ type: 'fail', why: 'rate limited', ip, port });
      return refuse(429, 'Too Many Requests');
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    const ws = new WsConnection(socket, { role: 'server', maxMessage: MAX_HANDSHAKE_FRAME, head });
    event({ type: 'open', ip, port });
    run(ws, fp, ip, port);
    return undefined;
  }

  function run(ws, fp, ip, port) {
    const managerNonce = crypto.randomBytes(32).toString('hex');
    let link = null;
    let done = false; // handshake over (either way)
    // why: what the Pi is told; kind: the security log's (6b)
    const deny = (why, { count = true, kind = why, id = null } = {}) => {
      if (done) return;
      done = true;
      if (count) noteFailure(ip);
      const paired = Boolean(id && byId(id));
      event({ type: 'fail', why: kind === 'not paired' ? (paired ? 'bad proof' : 'unknown id') : kind, paired, id: paired ? id : null, claimed: !paired && id ? clean(id, 128) : null, ip, port });
      ws.send(JSON.stringify({ t: 'denied', why }));
      ws.close(1008, 'denied');
    };
    const shake = setTimeout(() => deny('timeout'), handshakeMs);
    shake.unref?.();
    let beat = null;
    ws.on('close', (code, _reason, byPeer) => {
      clearTimeout(shake);
      clearInterval(beat);
      if (!link && !done) {
        // closed during the handshake: a frame too large or broken, or simply gone
        done = true;
        if (code === 1009 || code === 1002 || code === 1003 || code === 1007) {
          noteFailure(ip);
          event({ type: 'fail', why: code === 1009 ? 'oversized' : 'garbage', ip, port });
        }
      }
      if (!link) return;
      link.onClose();
      if (links.get(link.id) === link) {
        links.delete(link.id);
        const d = byId(link.id);
        if (d) { d.lastSeen = now(); save(); }
        log.info(`Sentry USB "${d?.name || link.id}" disconnected`);
        event({ type: 'disconnected', id: link.id, ip, port, reason: `code ${code}` });
        // unpaired on the Pi: it has no key and never connects again, so forget it here too
        if (byPeer && code === UNPAIRED_CLOSE && d) {
          log.warn(`Sentry USB "${d.name}" (${link.id}) was unpaired on the Sentry USB itself`);
          event({ type: 'unpaired', id: link.id, ip, port, byPi: true });
          store.devices = store.devices.filter((x) => x.id !== link.id);
          save();
        }
        changed();
      }
    });
    ws.on('message', (text) => {
      let m;
      try { m = JSON.parse(text); } catch { m = null; }
      if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') {
        if (!done) return deny('bad message', { kind: 'garbage' });
        return link?.onMessage({ t: '?' });
      }
      if (link) {
        // whatever a Pi sends must not throw out of here (it would end the process): it is a broken link
        try { return link.onMessage(m); } catch (err) {
          log.warn(`Sentry USB ${link.id}: ${err.message}`);
          return link.violation('a message that could not be handled');
        }
      }
      if (done) return undefined;
      if (m.t !== 'auth') return deny('bad message', { kind: 'garbage' });
      return auth(m);
    });
    ws.send(JSON.stringify({ t: 'hello', v: V, nonce: managerNonce, fp }));

    function auth(m) {
      if (typeof m.v !== 'number') return deny('bad message', { kind: 'garbage' });
      // any v other than 2 (v1, pair mode keyed by K, a newer one, or nonsense such as 0): the other side needs updating
      if (m.v !== V) {
        if (slot) { lastPairing = { ok: false, why: 'version', name: slot.name, at: now() }; changed(); }
        return deny('version', { count: false, id: typeof m.id === 'string' ? m.id : null });
      }
      const id = typeof m.id === 'string' && ID_RE.test(m.id) ? m.id : null;
      const piNonce = typeof m.nonce === 'string' && HEX64.test(m.nonce) && m.nonce !== managerNonce ? m.nonce : null;
      if (!id || !piNonce || (m.mode !== 'pair' && m.mode !== 'key')) return deny('bad message', { kind: 'garbage' });
      if (m.mode === 'key') {
        const d = byId(id);
        if (!d?.key || !sameHex(m.proof, piProof(Buffer.from(d.key, 'hex'), managerNonce, piNonce, fp, id))) {
          log.warn(`Sentry USB link: a handshake from ${ip} was refused (not paired)`);
          return deny('not paired', { id });
        }
        return welcome(d, Buffer.from(d.key, 'hex'), piNonce, m, null);
      }
      // pair mode: only while an admin holds a slot open
      if (!slot) {
        log.warn(`Sentry USB link: ${ip} asked to pair with no pairing open`);
        return deny('no pairing open', { kind: 'no slot', id });
      }
      // (one answer for a wrong code and a wrong password: the proof cannot tell them apart, and neither is revealed)
      if (!sameHex(m.proof, piProof(slot.p, managerNonce, piNonce, fp, id))) {
        slot.failures += 1;
        log.warn(`Sentry USB link: pairing from ${ip} refused (wrong pairing code or password, ${slot.failures} of ${SLOT_FAILURES})`);
        lastPairing = { ok: false, why: 'wrong password', name: slot.name, at: now() };
        if (slot.failures >= SLOT_FAILURES) closeSlot('too many tries');
        else changed();
        return deny('wrong password', { id });
      }
      const k = slot.p;
      const name = slot.name;
      clearTimeout(slot.timer);
      slot = null; // used once
      let linkKey = crypto.randomBytes(32).toString('hex');
      while (/^0+$/.test(linkKey)) linkKey = crypto.randomBytes(32).toString('hex'); // never all zero
      let d = byId(id);
      event({ type: 'paired', id, ip, port, again: Boolean(d) });
      if (d) log.warn(`Sentry USB "${d.name}" (${id}) paired again: its old link key is replaced`);
      else { d = { id, name }; store.devices.push(d); }
      Object.assign(d, { name, key: linkKey, pairedAt: now(), protocolError: null });
      lastPairing = { ok: true, deviceId: id, name, at: now() };
      const ok = welcome(d, k, piNonce, m, linkKey);
      k.fill(0);
      return ok;
    }

    function welcome(d, secret, piNonce, m, linkKey) {
      done = true;
      clearTimeout(shake);
      d.hostname = clean(m.name, 64) || d.hostname || null;
      d.version = clean(m.version, 64) || d.version || null;
      d.lastSeen = now();
      d.address = ip;
      save();
      ws.send(JSON.stringify({ t: 'ok', proof: managerProof(secret, managerNonce, piNonce, fp, d.id), ...(linkKey ? { linkKey } : {}) }));
      ws.maxMessage = MAX_FRAME;
      const old = links.get(d.id);
      link = makeLink(ws, d.id, ip, port);
      links.set(d.id, link);
      if (old) { event({ type: 'replaced', id: d.id, ip: old.ip, port: old.port }); old.drop(4000, 'replaced'); }
      event({ type: 'connected', id: d.id, ip, port, version: d.version });
      log.info(`Sentry USB "${d.name}" connected from ${ip}${linkKey ? ' and paired' : ''} (${d.version || 'version unknown'})`);
      // liveness: a ping every 30 s, closed after 90 s of silence
      beat = setInterval(() => {
        if (Date.now() - ws.lastHeard > silentMs) return link.drop(1001, 'silent');
        ws.ping();
        return undefined;
      }, pingMs);
      beat.unref?.();
      changed();
      return true;
    }
  }

  /** One request to a Pi: { status, type, body } | { status, type, buf } | { status, error }. */
  async function request(id, req) {
    const l = links.get(id);
    if (!byId(id)) return { status: 404, error: 'No such Sentry USB.' };
    if (!l) return { status: 503, error: 'The Sentry USB is offline: it connects when it is on a network that reaches this server.' };
    return l.request(req);
  }

  return {
    handleUpgrade, request, openPairing, cancelPairing: () => closeSlot(null), pairing, devices, rename, unpair,
    has: (id) => Boolean(byId(id)),
    name: (id) => byId(id)?.name || null,
    /** for the security log: its name, whether network notices are on, its home network set by hand */
    info: (id) => { const d = byId(id); return d ? { name: d.name, notifyNetwork: d.notifyNetwork !== false, home: d.home || null } : null; },
    configure: (id, { notifyNetwork, home } = {}) => {
      const d = byId(id);
      if (!d) return null;
      if (typeof notifyNetwork === 'boolean') d.notifyNetwork = notifyNetwork;
      if (home !== undefined) d.home = home && (home.ssid || home.gw) ? { ssid: clean(home.ssid, 64) || null, gw: clean(home.gw, 64) || null } : null;
      save();
      changed();
      return { notifyNetwork: d.notifyNetwork !== false, home: d.home || null };
    },
    // the last setup config read from it (masked), for editing while it is away
    keepConfig: (id, cfg) => {
      const d = byId(id);
      if (!d) return;
      const m = maskConfig(cfg);
      if (JSON.stringify(m).length > MAX_STATUS) return;
      d.config = m;
      d.configAt = now();
      save();
    },
    lastConfig: (id) => { const d = byId(id); return d?.config ? { config: d.config, at: d.configAt || null } : { config: null, at: null }; },
    status: (id) => byId(id)?.status ?? null,
    online: (id) => links.has(id),
    /** the device port must listen: a slot is open or a Sentry USB is paired */
    wanted: () => Boolean(slot) || store.devices.length > 0,
    close: () => { closeSlot(null); for (const l of links.values()) l.drop(1001, 'shutting down'); }
  };
}

/** The stored settings without link keys (database snapshots, exports). */
function withoutKeys(value) {
  if (!value || !Array.isArray(value.devices)) return value;
  return { ...value, devices: value.devices.map(({ key: _key, ...d }) => d) };
}

module.exports = {
  createSentryUsbLink, newPairingCode, normalizePairingCode, codeGroups, pairCodeSecret, CODE_ALPHABET, CODE_INVALID, V, proxyTarget, badSetupBody, answerStatus, maskConfig, isSecretKey, SETTABLE, SECRET_TARGETS, secretsNeeded, safeType, pairingKey, piProof, managerProof, sameHex, fpHex, fpGroups, withoutKeys,
  LINK_PATH, MAX_FRAME, MAX_HANDSHAKE_FRAME, MAX_ANSWER, MAX_BUFFERED, NOTICES, MAX_IN_FLIGHT, SLOT_FAILURES, FAILS_PER_MINUTE
};
