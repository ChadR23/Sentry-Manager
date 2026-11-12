'use strict';

// The feedback and diagnostics reports' wire protocol (v1), shared by the
// Manager (server/reports.js, the sender) and the developers' private
// receiver. docs/reports-api.md is the written-down version.
//
// The receiver keeps its own copy of this protocol (in its private
// repository): both must change together.
//
// In short:
//   - The report (a JSON object, see validatePayload) is gzipped and sealed
//     to the receiver: an ephemeral X25519 key, ECDH with the receiver's
//     static key, HKDF-SHA256 (salt = ephemeral public || receiver public,
//     info "sentry-reports v1", 32 bytes), AES-256-GCM with a random 12-byte
//     IV and AAD "sentry-reports v1|<kid>". Only the receiver's private key
//     opens it; nothing on the way can read it.
//   - The sealed envelope is signed with the install's own Ed25519 key (an
//     anonymous report: a second key kept only for anonymous reports), over
//     the envelope's hash, a timestamp and a random nonce.
//   - It carries a proof of work: sha256(envelope hash || nonce || pow) has
//     at least `bits` leading zero bits (the receiver says how many at
//     GET /v1/config).

const crypto = require('crypto');
const zlib = require('zlib');

const V = 1;
const INFO = 'sentry-reports v1';
const MAX_BODY = 8 * 1024 * 1024; // the POST body
const MAX_PLAIN = 100 * 1024 * 1024; // what the gzip may open to (zip bombs stop here)
const MAX_SKEW_MS = 10 * 60 * 1000; // a report's timestamp against the receiver's clock
const KINDS = ['feedback', 'support', 'crash', 'daily', 'heartbeat'];
const ANON = 'ANON';

const b64 = (buf) => Buffer.from(buf).toString('base64');
/** Standard base64 of exactly `len` bytes (when given), else null. */
function unb64(text, len = null) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  const buf = Buffer.from(text, 'base64');
  if (len !== null && buf.length !== len) return null;
  return buf;
}
const sha256 = (...parts) => {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

/** The key id of a receiver public key (32 raw bytes): the first 16 hex of its sha256. */
const kidOf = (pubRaw) => sha256(pubRaw).toString('hex').slice(0, 16);

const b64url = (buf) => Buffer.from(buf).toString('base64url');
/** A raw 32-byte public key as a KeyObject ('X25519' or 'Ed25519'). */
function publicKeyFromRaw(raw, crv) {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv, x: b64url(raw) }, format: 'jwk' });
}
/** A KeyObject's raw 32 public bytes. */
function rawPublic(key) {
  const pub = key.type === 'private' ? crypto.createPublicKey(key) : key;
  return Buffer.from(pub.export({ format: 'jwk' }).x, 'base64url');
}
/** A private KeyObject's raw 32 bytes (for deriving secrets from it). */
function rawPrivate(key) {
  return Buffer.from(key.export({ format: 'jwk' }).d, 'base64url');
}

/**
 * A receiver key as the Manager knows it: { kid, publicKey (base64 X25519),
 * signingKey (base64 Ed25519, optional) }. The receiver prints it as one
 * line, "sr1:<publicKey>:<signingKey>" (REPORTS_PUBLIC_KEY takes that line,
 * several separated by spaces; the first is used to seal).
 */
function parseKeyLine(text) {
  const out = [];
  for (const part of String(text || '').split(/[\s;,]+/).filter(Boolean)) {
    const m = /^(?:sr1:)?([A-Za-z0-9+/]{43}=)(?::([A-Za-z0-9+/]{43}=))?$/.exec(part);
    if (!m) throw new Error(`"${part.slice(0, 20)}…" is not a receiver key (sr1:<public key>:<signing key>).`);
    out.push(normalizeKey({ publicKey: m[1], signingKey: m[2] || null }));
  }
  return out;
}
/** { kid?, publicKey, signingKey? } checked, with the kid worked out (a given kid must match). */
function normalizeKey(k) {
  const pub = unb64(k?.publicKey, 32);
  if (!pub) throw new Error('A receiver key needs publicKey: 32 bytes in base64.');
  const kid = kidOf(pub);
  if (k.kid && k.kid !== kid) throw new Error(`The receiver key's kid ${k.kid} does not match its public key (${kid}).`);
  const sign = k.signingKey ? unb64(k.signingKey, 32) : null;
  if (k.signingKey && !sign) throw new Error('A receiver signingKey is 32 bytes in base64.');
  publicKeyFromRaw(pub, 'X25519');
  if (sign) publicKeyFromRaw(sign, 'Ed25519');
  return { kid, publicKey: b64(pub), signingKey: sign ? b64(sign) : null };
}
const keyLine = ({ publicKey, signingKey }) => `sr1:${publicKey}${signingKey ? `:${signingKey}` : ''}`;

function deriveKey(shared, epkRaw, pubRaw) {
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([epkRaw, pubRaw]), Buffer.from(INFO), 32));
}
const aadOf = (kid) => Buffer.from(`${INFO}|${kid}`);

/** Seals a JSON-able payload to a receiver key ({ publicKey } base64): the envelope { v, kid, epk, iv, ct, tag }. */
function seal(payload, receiver) {
  const pubRaw = unb64(receiver.publicKey, 32);
  if (!pubRaw) throw new Error('No receiver key.');
  const kid = kidOf(pubRaw);
  const eph = crypto.generateKeyPairSync('x25519');
  const epkRaw = rawPublic(eph.publicKey);
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: publicKeyFromRaw(pubRaw, 'X25519') });
  const key = deriveKey(shared, epkRaw, pubRaw);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aadOf(kid));
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { v: V, kid, epk: b64(epkRaw), iv: b64(iv), ct: b64(ct), tag: b64(c.getAuthTag()) };
}

/**
 * Opens an envelope with the receiver's private X25519 KeyObject: the
 * payload object. Throws { code } BAD_TAG (tampered or not for this key),
 * TOO_BIG (opens to more than maxPlain), BAD_GZIP, BAD_JSON.
 */
function open(env, privateKey, { maxPlain = MAX_PLAIN } = {}) {
  const pubRaw = rawPublic(privateKey);
  const epkRaw = unb64(env.epk, 32);
  const shared = crypto.diffieHellman({ privateKey, publicKey: publicKeyFromRaw(epkRaw, 'X25519') });
  const key = deriveKey(shared, epkRaw, pubRaw);
  const d = crypto.createDecipheriv('aes-256-gcm', key, unb64(env.iv, 12));
  d.setAAD(aadOf(env.kid));
  d.setAuthTag(unb64(env.tag, 16));
  let gz;
  try {
    gz = Buffer.concat([d.update(unb64(env.ct)), d.final()]);
  } catch {
    throw Object.assign(new Error('The report does not open (tampered, or sealed to another key).'), { code: 'BAD_TAG' });
  }
  let text;
  try {
    text = zlib.gunzipSync(gz, { maxOutputLength: maxPlain });
  } catch (err) {
    if (err.code === 'ERR_BUFFER_TOO_LARGE' || /larger than|maxOutputLength/i.test(err.message)) throw Object.assign(new Error('The report opens to more than the limit.'), { code: 'TOO_BIG' });
    throw Object.assign(new Error('The report is not gzip.'), { code: 'BAD_GZIP' });
  }
  try {
    return JSON.parse(text.toString('utf8'));
  } catch {
    throw Object.assign(new Error('The report is not JSON.'), { code: 'BAD_JSON' });
  }
}

/** The envelope's hash (32 bytes): what the signature and the proof of work are over. */
const envelopeHash = (env) => sha256(`${INFO}|${env.v}|${env.kid}|${env.epk}|${env.iv}|${env.ct}|${env.tag}`);
/** The bytes the install's key signs. */
const signedBytes = (envHash, ts, nonce) => Buffer.from(`${INFO} sig|${envHash.toString('hex')}|${ts}|${nonce}`);

function leadingZeroBits(buf) {
  let n = 0;
  for (const b of buf) {
    if (b === 0) { n += 8; continue; }
    return n + Math.clz32(b) - 24;
  }
  return n;
}
/** Whether pow (base64 8 bytes) is a stamp of at least `bits` for this envelope hash and nonce. */
function powOk(envHash, nonce, pow, bits) {
  const p = unb64(pow, 8);
  const n = unb64(nonce, 16);
  if (!p || !n) return false;
  return leadingZeroBits(sha256(envHash, n, p)) >= bits;
}
/** Finds a stamp (synchronously: run it in a worker). */
function solvePow(envHash, nonce, bits, { maxTries = 2 ** 34 } = {}) {
  const n = unb64(nonce, 16);
  const p = Buffer.alloc(8);
  const start = crypto.randomBytes(4).readUInt32BE(0);
  for (let i = 0; i < maxTries; i++) {
    p.writeUInt32BE((start + i) >>> 0, 0);
    p.writeUInt32BE(Math.floor(i / 2 ** 32), 4);
    if (leadingZeroBits(sha256(envHash, n, p)) >= bits) return b64(p);
  }
  throw new Error('No proof of work found.');
}

/**
 * Signs and stamps an envelope with an install key (Ed25519 private
 * KeyObject): the request body. ts is the sender's clock (milliseconds),
 * corrected by what GET /v1/config said the time is.
 */
function sign(env, installKey, { ts = Date.now(), nonce = b64(crypto.randomBytes(16)), pow, bits }) {
  const h = envelopeHash(env);
  const sig = crypto.sign(null, signedBytes(h, ts, nonce), installKey);
  return { ...env, ts, nonce, ik: b64(rawPublic(installKey)), sig: b64(sig), pow, bits };
}

// ---- the request body, exactly
const BODY_FIELDS = { v: 'v', kid: 'kid', epk: 'b64:32', iv: 'b64:12', ct: 'b64', tag: 'b64:16', ts: 'int', nonce: 'b64:16', ik: 'b64:32', sig: 'b64:64', pow: 'b64:8', bits: 'bits' };
/** Errors in a request body (an empty list when it is right). */
function validateBody(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return ['not an object'];
  const errs = [];
  for (const k of Object.keys(b)) if (!(k in BODY_FIELDS)) errs.push(`unknown field ${k.slice(0, 40)}`);
  for (const [k, t] of Object.entries(BODY_FIELDS)) {
    const x = b[k];
    if (t === 'v') { if (x !== V) errs.push('v must be 1'); continue; }
    if (t === 'kid') { if (typeof x !== 'string' || !/^[0-9a-f]{16}$/.test(x)) errs.push('kid'); continue; }
    if (t === 'int') { if (!Number.isSafeInteger(x) || x < 0) errs.push(k); continue; }
    if (t === 'bits') { if (!Number.isInteger(x) || x < 0 || x > 40) errs.push(k); continue; }
    const len = t.includes(':') ? Number(t.split(':')[1]) : null;
    if (typeof x !== 'string' || x.length > MAX_BODY || !unb64(x, len)) errs.push(k);
  }
  return errs;
}

/** Verifies the signature of a body that passed validateBody. */
function verifySig(b) {
  try {
    return crypto.verify(null, signedBytes(envelopeHash(b), b.ts, b.nonce), publicKeyFromRaw(unb64(b.ik, 32), 'Ed25519'), unb64(b.sig, 64));
  } catch {
    return false;
  }
}

// ---- the payload (what is sealed), exactly
const LIMITS = { message: 5000, note: 1000, contact: 200, ui: 80, sentAt: 40, tag: 120, builtAt: 40, sha: 64, crashMessage: 4000, crashStack: 30000 };
const DIAG_KEYS = ['system', 'storage', 'counts', 'jobs', 'converter', 'settings', 'features', 'health', 'logs', 'crashes', 'can', 'sentryUsb', 'nodes', 'errors'];
const DIAG_MAX = { depth: 10, keys: 60_000, string: 40_000, array: 5_000, keyLen: 120 };

/** Whether a free-form diagnostics value stays inside the bounds (depth, sizes, plain JSON). */
function boundedJson(value, errs, where) {
  let keys = 0;
  const walk = (v, depth) => {
    if (errs.length > 20) return;
    if (depth > DIAG_MAX.depth) { errs.push(`${where}: nested too deep`); return; }
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number') { if (!Number.isFinite(v)) errs.push(`${where}: not a finite number`); return; }
    if (typeof v === 'string') { if (v.length > DIAG_MAX.string) errs.push(`${where}: a string is too long`); return; }
    if (Array.isArray(v)) {
      if (v.length > DIAG_MAX.array) { errs.push(`${where}: a list is too long`); return; }
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (++keys > DIAG_MAX.keys) { errs.push(`${where}: too many fields`); return; }
        if (k.length > DIAG_MAX.keyLen) { errs.push(`${where}: a field name is too long`); return; }
        walk(x, depth + 1);
      }
      return;
    }
    errs.push(`${where}: not JSON`);
  };
  walk(value, 0);
}

const isStr = (x, max, min = 0) => typeof x === 'string' && x.length >= min && x.length <= max;
const nullOr = (x, test) => x === null || test(x);

// ---- the hourly heartbeat: a few numbers, exactly these, nothing free-form
// the whole heartbeat payload as JSON (8 KB since `nodes`: eight nodes' hardware
// and speeds do not fit in the 4 KB before it at any useful length)
const HEARTBEAT_MAX_BYTES = 8192;
const HEALTH_OVERALL = ['ok', 'warn', 'problem'];
/** The overall health for these counts: any problem is 'problem', else any warning 'warn', else 'ok'. */
const healthOverall = (warnings, problems) => (problems > 0 ? 'problem' : warnings > 0 ? 'warn' : 'ok');
const intIn = (x, max) => Number.isSafeInteger(x) && x >= 0 && x <= max;
const BYTES_MAX = Number.MAX_SAFE_INTEGER;
const HEARTBEAT_FIELDS = {
  uptimeSec: (x) => intIn(x, 100 * 365 * 86400),
  health: null, // below
  vehicles: (x) => intIn(x, 1000),
  footageBytes: (x) => intIn(x, BYTES_MAX),
  recordings: (x) => intIn(x, 1e9),
  spaceSavedBytes: (x) => intIn(x, BYTES_MAX),
  // total distance driven in all the footage, in km to 0.1 (a total only: never routes or places)
  distanceKm: (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 10_000_000 && Math.abs(x * 10 - Math.round(x * 10)) < 1e-6,
  freeBytes: (x) => x === null || intIn(x, BYTES_MAX),
  totalBytes: (x) => x === null || intIn(x, BYTES_MAX),
  converting: (x) => typeof x === 'boolean',
  jobsQueued: (x) => intIn(x, 100_000),
  features: null // below
};
const HEARTBEAT_FEATURES = ['can', 'sentryUsbPaired', 'gpu'];
const isObj = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);

// The optional heartbeat fields (added later: a heartbeat without
// any of them is still right, so older Managers keep working). Each one, when
// present, is checked as strictly as the required ones: exactly these keys at
// every level, these types and these limits. Text is plain: printable ASCII
// (space to ~) without " and \ (so a character is one byte as JSON), 1 to
// `max` characters, no space at either end; nothing else (no control,
// format, private-use or non-ASCII characters). The limits keep the worst
// case of every field at its limit (with the common fields at theirs) under
// HEARTBEAT_MAX_BYTES (test/reportsHeartbeatFields.test.js builds it).
// convert.device is the name of one of `gpus` or the `cpu` exactly, so it
// is as long as the longer of them may be (and a node's as its own).
const HEARTBEAT_LIMITS = {
  footageSeconds: 1e12, platform: 32, arch: 16, cpu: 120,
  gpus: 4, gpu: 80, // GPU names (at most 4 of them)
  cars: 12, model: 16, firmware: 24, // { model, firmware } per vehicle (at most 12)
  clips: 1e6, fps: 100_000, encoder: 40, device: 120, api: 12, codec: 10, crashes: 10_000,
  // { cpu, gpus, convert } per paired encoding node (at most 8): shorter
  // names than this server's own, so eight of them fit
  nodes: 8, nodeCpu: 60, nodeGpus: 4, nodeGpu: 60, nodeDevice: 60
};
const PLAIN_RE = /^[\x20\x21\x23-\x5b\x5d-\x7e]+$/;
/** Whether x is plain text of 1 to max characters (see HEARTBEAT_LIMITS above). */
const isPlain = (x, max) => typeof x === 'string' && x.length >= 1 && x.length <= max && PLAIN_RE.test(x) && x.trim() === x;
const plainOrNull = (x, max) => x === null || isPlain(x, max);
/** An object with exactly these keys (errors for any other or a missing one); false when it is no object. */
function exactKeys(o, keys, where, errs) {
  if (!isObj(o)) { errs.push(where); return false; }
  for (const k of Object.keys(o)) if (!keys.includes(k)) errs.push(`unknown field ${where}.${k.slice(0, 40)}`);
  for (const k of keys) if (!(k in o)) errs.push(`${where}.${k} missing`);
  return true;
}
const HL = HEARTBEAT_LIMITS;
/** A list of at most `count` GPU names of 1 to `max` characters each. */
function checkGpus(x, count, max, where, errs) {
  if (!Array.isArray(x) || x.length > count) { errs.push(where); return; }
  x.forEach((g, i) => { if (!isPlain(g, max)) errs.push(`${where}[${i}]`); });
}
/** A convert block { fps, encoder, device, api, codec } (device of 1 to deviceMax characters). */
function checkConvert(x, deviceMax, where, errs) {
  if (!exactKeys(x, ['fps', 'encoder', 'device', 'api', 'codec'], where, errs)) return;
  // frames a second, to 0.1
  if ('fps' in x && !nullOr(x.fps, (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= HL.fps && Math.abs(n * 10 - Math.round(n * 10)) < 1e-6)) errs.push(`${where}.fps`);
  const max = { encoder: HL.encoder, device: deviceMax, api: HL.api, codec: HL.codec };
  for (const k of ['encoder', 'device', 'api', 'codec']) if (k in x && !plainOrNull(x[k], max[k])) errs.push(`${where}.${k}`);
}
// the kind of host the Manager runs on (server/hostInfo.js works it out):
// one of these words or null, never the kernel string or a host name
const HEARTBEAT_HOST_OS = ['truenas', 'unraid', 'synology', 'qnap', 'wsl', 'macos', 'raspberry-pi', 'ubuntu', 'debian', 'fedora', 'linux'];
const HEARTBEAT_OPTIONAL = {
  // the length of all the footage, in seconds (the Dash's "footage hours" x 3600)
  footageSeconds: (x, errs) => { if (!intIn(x, HL.footageSeconds)) errs.push('heartbeat.footageSeconds'); },
  platform: (x, errs) => { if (!isPlain(x, HL.platform)) errs.push('heartbeat.platform'); },
  arch: (x, errs) => { if (!isPlain(x, HL.arch)) errs.push('heartbeat.arch'); },
  cpu: (x, errs) => { if (!plainOrNull(x, HL.cpu)) errs.push('heartbeat.cpu'); },
  gpus: (x, errs) => checkGpus(x, HL.gpus, HL.gpu, 'heartbeat.gpus', errs),
  cars: (x, errs) => {
    if (!Array.isArray(x) || x.length > HL.cars) { errs.push('heartbeat.cars'); return; }
    x.forEach((c, i) => {
      const where = `heartbeat.cars[${i}]`;
      if (!exactKeys(c, ['model', 'firmware'], where, errs)) return;
      if ('model' in c && !plainOrNull(c.model, HL.model)) errs.push(`${where}.model`);
      if ('firmware' in c && !plainOrNull(c.firmware, HL.firmware)) errs.push(`${where}.firmware`);
    });
  },
  clips24h: (x, errs) => {
    if (!exactKeys(x, ['sentry', 'dashcam'], 'heartbeat.clips24h', errs)) return;
    for (const k of ['sentry', 'dashcam']) if (k in x && !intIn(x[k], HL.clips)) errs.push(`heartbeat.clips24h.${k}`);
  },
  // how this server's own conversions ran (its device: one of `gpus`, or the `cpu`)
  convert: (x, errs) => checkConvert(x, HL.device, 'heartbeat.convert', errs),
  crashes24h: (x, errs) => { if (!intIn(x, HL.crashes)) errs.push('heartbeat.crashes24h'); },
  // { os: one of HEARTBEAT_HOST_OS or null, docker: in a container }
  host: (x, errs) => {
    if (!exactKeys(x, ['os', 'docker'], 'heartbeat.host', errs)) return;
    if ('os' in x && !(x.os === null || HEARTBEAT_HOST_OS.includes(x.os))) errs.push('heartbeat.host.os');
    if ('docker' in x && typeof x.docker !== 'boolean') errs.push('heartbeat.host.docker');
  },
  // one { cpu, gpus, convert } per paired encoding node (Nodes): its
  // hardware and how the clips it converted ran, never its name, address
  // or id; its convert.device is one of its own gpus, or its cpu
  nodes: (x, errs) => {
    if (!Array.isArray(x) || x.length > HL.nodes) { errs.push('heartbeat.nodes'); return; }
    x.forEach((n, i) => {
      const where = `heartbeat.nodes[${i}]`;
      if (!exactKeys(n, ['cpu', 'gpus', 'convert'], where, errs)) return;
      if ('cpu' in n && !plainOrNull(n.cpu, HL.nodeCpu)) errs.push(`${where}.cpu`);
      if ('gpus' in n) checkGpus(n.gpus, HL.nodeGpus, HL.nodeGpu, `${where}.gpus`, errs);
      if ('convert' in n) checkConvert(n.convert, HL.nodeDevice, `${where}.convert`, errs);
    });
  }
};
/** Errors in a heartbeat block (pushed onto errs). */
function checkHeartbeat(h, errs) {
  if (!isObj(h)) { errs.push('heartbeat'); return; }
  for (const k of Object.keys(h)) if (!(k in HEARTBEAT_FIELDS) && !(k in HEARTBEAT_OPTIONAL)) errs.push(`unknown field heartbeat.${k.slice(0, 40)}`);
  for (const [k, test] of Object.entries(HEARTBEAT_FIELDS)) {
    if (!(k in h)) { errs.push(`heartbeat.${k} missing`); continue; }
    if (test && !test(h[k])) errs.push(`heartbeat.${k}`);
  }
  // the optional ones: each checked when it is there
  for (const [k, check] of Object.entries(HEARTBEAT_OPTIONAL)) if (Object.hasOwn(h, k)) check(h[k], errs);
  if (h.freeBytes !== null && h.totalBytes !== null && intIn(h.freeBytes, BYTES_MAX) && intIn(h.totalBytes, BYTES_MAX) && h.freeBytes > h.totalBytes) errs.push('heartbeat.freeBytes (more than totalBytes)');
  if ((h.freeBytes === null) !== (h.totalBytes === null)) errs.push('heartbeat.freeBytes and totalBytes (both or neither)');
  const hl = h.health;
  if (!isObj(hl)) errs.push('heartbeat.health');
  else {
    for (const k of Object.keys(hl)) if (!['overall', 'warnings', 'problems'].includes(k)) errs.push(`unknown field heartbeat.health.${k.slice(0, 40)}`);
    const okCounts = intIn(hl.warnings, 1000) && intIn(hl.problems, 1000);
    if (!intIn(hl.warnings, 1000)) errs.push('heartbeat.health.warnings');
    if (!intIn(hl.problems, 1000)) errs.push('heartbeat.health.problems');
    if (!HEALTH_OVERALL.includes(hl.overall)) errs.push('heartbeat.health.overall');
    else if (okCounts && hl.overall !== healthOverall(hl.warnings, hl.problems)) errs.push('heartbeat.health.overall (does not match the counts)');
  }
  const f = h.features;
  if (!isObj(f)) errs.push('heartbeat.features');
  else {
    for (const k of Object.keys(f)) if (!HEARTBEAT_FEATURES.includes(k)) errs.push(`unknown field heartbeat.features.${k.slice(0, 40)}`);
    for (const k of HEARTBEAT_FEATURES) if (typeof f[k] !== 'boolean') errs.push(`heartbeat.features.${k}`);
  }
}

/**
 * Errors in a payload (an empty list when it is right). Exactly these
 * fields, of these types and lengths:
 *   kind: feedback | support | crash | daily | heartbeat; sentAt: ISO time;
 *   install: 32 hex (a random id made once per install) or "ANON";
 *   anonymous: true exactly when install is "ANON";
 *   build: { build: number|null, sha: hex|null, builtAt: string|null, tag: string|null };
 *   ui: the interface in use;
 *   message: feedback (required, 1-5000) or support (the "what's wrong" note, up to 1000);
 *   contact: feedback only, never when anonymous (up to 200);
 *   crash: crash only, { at, name, message, stack };
 *   diagnostics: required for support, crash and daily, optional for feedback,
 *     never in a heartbeat; an object of the DIAG_KEYS, each free-form JSON
 *     within bounds;
 *   heartbeat: heartbeat only (and required there), exactly the
 *     HEARTBEAT_FIELDS, plus any of the HEARTBEAT_OPTIONAL ones
 *     (checkHeartbeat); a heartbeat is at most 8 KB as JSON.
 */
function validatePayload(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['not an object'];
  const errs = [];
  const allowed = new Set(['kind', 'sentAt', 'install', 'anonymous', 'build', 'ui', 'message', 'contact', 'crash', 'diagnostics', 'heartbeat']);
  for (const k of Object.keys(p)) if (!allowed.has(k)) errs.push(`unknown field ${k.slice(0, 40)}`);
  if (!KINDS.includes(p.kind)) errs.push('kind');
  if (!isStr(p.sentAt, LIMITS.sentAt, 10) || !Number.isFinite(Date.parse(p.sentAt))) errs.push('sentAt');
  if (!(p.install === ANON || (typeof p.install === 'string' && /^[0-9a-f]{32}$/.test(p.install)))) errs.push('install');
  if (typeof p.anonymous !== 'boolean' || p.anonymous !== (p.install === ANON)) errs.push('anonymous');
  const b = p.build;
  if (!b || typeof b !== 'object' || Array.isArray(b)) errs.push('build');
  else {
    for (const k of Object.keys(b)) if (!['build', 'sha', 'builtAt', 'tag'].includes(k)) errs.push(`unknown field build.${k.slice(0, 40)}`);
    if (!nullOr(b.build, (x) => Number.isSafeInteger(x) && x > 0)) errs.push('build.build');
    if (!nullOr(b.sha, (x) => typeof x === 'string' && /^[0-9a-f]{7,64}$/.test(x))) errs.push('build.sha');
    if (!nullOr(b.builtAt, (x) => isStr(x, LIMITS.builtAt))) errs.push('build.builtAt');
    if (!nullOr(b.tag, (x) => isStr(x, LIMITS.tag))) errs.push('build.tag');
    for (const k of ['build', 'sha', 'builtAt', 'tag']) if (!(k in b)) errs.push(`build.${k} missing`);
  }
  if (!isStr(p.ui, LIMITS.ui)) errs.push('ui');
  if (p.kind === 'feedback') {
    if (!isStr(p.message, LIMITS.message, 1) || !p.message.trim()) errs.push('message');
  } else if (p.kind === 'support') {
    if (p.message !== undefined && !isStr(p.message, LIMITS.note)) errs.push('message');
  } else if (p.message !== undefined) errs.push('message (feedback and support only)');
  if (p.contact !== undefined) {
    if (p.kind !== 'feedback') errs.push('contact (feedback only)');
    else if (p.anonymous) errs.push('contact (never when anonymous)');
    else if (!isStr(p.contact, LIMITS.contact)) errs.push('contact');
  }
  if (p.kind === 'crash') {
    const c = p.crash;
    if (!c || typeof c !== 'object' || Array.isArray(c)) errs.push('crash');
    else {
      for (const k of Object.keys(c)) if (!['at', 'name', 'message', 'stack', 'source'].includes(k)) errs.push(`unknown field crash.${k.slice(0, 40)}`);
      if (!isStr(c.at, 40, 10)) errs.push('crash.at');
      if (!isStr(c.name, 120)) errs.push('crash.name');
      if (!isStr(c.message, LIMITS.crashMessage)) errs.push('crash.message');
      if (!isStr(c.stack, LIMITS.crashStack)) errs.push('crash.stack');
      if (c.source !== undefined && !['crash', 'error'].includes(c.source)) errs.push('crash.source');
    }
  } else if (p.crash !== undefined) errs.push('crash (crash reports only)');
  if (p.kind === 'heartbeat') {
    checkHeartbeat(p.heartbeat, errs);
    if (p.diagnostics !== undefined) errs.push('diagnostics (never in a heartbeat)');
    let size = Infinity;
    try { size = Buffer.byteLength(JSON.stringify(p)); } catch { /* not JSON */ }
    if (size > HEARTBEAT_MAX_BYTES) errs.push(`heartbeat: larger than ${HEARTBEAT_MAX_BYTES} bytes`);
    return errs;
  }
  if (p.heartbeat !== undefined) errs.push('heartbeat (heartbeats only)');
  if (p.diagnostics === undefined) {
    if (p.kind !== 'feedback') errs.push('diagnostics missing');
  } else if (!p.diagnostics || typeof p.diagnostics !== 'object' || Array.isArray(p.diagnostics)) errs.push('diagnostics');
  else {
    for (const k of Object.keys(p.diagnostics)) {
      if (!DIAG_KEYS.includes(k)) errs.push(`unknown field diagnostics.${k.slice(0, 40)}`);
      else boundedJson(p.diagnostics[k], errs, `diagnostics.${k}`);
    }
  }
  return errs;
}

// ---- the receiver's own signature: a "moved to" notice at GET /v1/config
const movedBytes = (url, at) => Buffer.from(`${INFO} moved|${url}|${at}`);
function signMoved(url, at, signingPrivateKey) {
  return { url, at, sig: b64(crypto.sign(null, movedBytes(url, at), signingPrivateKey)) };
}
/** Whether a { url, at, sig } notice is signed by one of these keys ({ signingKey } base64 Ed25519). */
function verifyMoved(m, keys) {
  if (!m || typeof m.url !== 'string' || m.url.length > 300 || !Number.isSafeInteger(m.at) || typeof m.sig !== 'string') return false;
  const sig = unb64(m.sig, 64);
  if (!sig) return false;
  for (const k of keys) {
    const raw = k.signingKey && unb64(k.signingKey, 32);
    if (!raw) continue;
    try {
      if (crypto.verify(null, movedBytes(m.url, m.at), publicKeyFromRaw(raw, 'Ed25519'), sig)) return true;
    } catch { /* not this key */ }
  }
  return false;
}

// ---- the reference code people quote to support: "SR-" and 6 letters/digits
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function refCode(bytes = crypto.randomBytes(4)) {
  let n = Buffer.from(bytes).readUInt32BE(0) >>> 2; // 30 bits
  let out = '';
  for (let i = 0; i < 6; i++) { out = CROCKFORD[n & 31] + out; n >>>= 5; }
  return `SR-${out}`;
}
/** A typed code in its one spelling (SR-7K2Q9F; o/i/l read as 0/1/1), or null. */
function normalizeRef(text) {
  const t = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/^SR/, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return /^[0-9A-HJKMNP-TV-Z]{6}$/.test(t) ? `SR-${t}` : null;
}

module.exports = {
  V, INFO, MAX_BODY, MAX_PLAIN, MAX_SKEW_MS, KINDS, ANON, LIMITS, DIAG_KEYS, HEARTBEAT_MAX_BYTES, HEARTBEAT_FIELDS, HEARTBEAT_FEATURES, HEARTBEAT_OPTIONAL, HEARTBEAT_LIMITS, HEARTBEAT_HOST_OS, isPlain, healthOverall,
  b64, unb64, sha256, kidOf, publicKeyFromRaw, rawPublic, rawPrivate, parseKeyLine, normalizeKey, keyLine,
  seal, open, envelopeHash, signedBytes, leadingZeroBits, powOk, solvePow, sign, validateBody, verifySig, validatePayload,
  signMoved, verifyMoved, refCode, normalizeRef
};
