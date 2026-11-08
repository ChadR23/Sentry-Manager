'use strict';

// Trust in CAN Bridge logs: signatures, pairing and the chain
// (docs/can-bridge-api.md, "Signatures and pairing"; the bridge side is the
// "Integrity" section of docs/sentry-manager-format.md in SMO).
//
// Every finished log is signed on the Screenmate with an ECDSA P-256 key that
// never leaves its keystore. The signature is in the sidecar's `integrity`
// object, over these lines joined by LF with a trailing LF:
//
//   canbridge-log-sig-v1 / vehicle_key / log file name / log sha256 /
//   log length / index / prev_name / prev_sha256
//
// Pairing: the first signed log of a car key pins its public key (or the
// owner trusts a key in the Nerd settings); from then on only logs signed by
// that key are trusted. Each log gets a status:
//
//   verified  signed by the paired key, and the file is what was signed
//   failed    not what was signed, signed by another key, or unsigned after
//             pairing: kept and listed, never used unless the owner says so
//   unsigned  no signature, from a car not paired (an older bridge): used,
//             with a note
//   waiting   the log or its sidecar has not arrived yet
//
// The chain: `index` counts up by 1 per log of a key and each log names the
// previous one (`prev_name`, `prev_sha256`). A missing index, or a previous
// log that is not the one stored here, is reported (a log deleted, swapped
// or reordered). Logs received here and deleted later still count (their
// record is kept); logs the bridge dropped before sending are a gap.
//
//   <DATA>/can/<vehicleKey>/trust.json   { pin, newKey, logs: { name: record } }

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { parseName } = require('./canLogs');

const VERSION = 'canbridge-log-sig-v1';
const ALGORITHM = 'ECDSA-P256-SHA256';
const WAIT_MS = 10 * 60 * 1000; // a log without its sidecar this long: judged without it

/** SHA-256 of a public key's DER, hex in pairs with colons (as the app shows it). */
function fingerprintOf(der) {
  return crypto.createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g).join(':');
}
const sameFingerprint = (a, b) => String(a || '').replace(/[^0-9a-f]/gi, '').toLowerCase() === String(b || '').replace(/[^0-9a-f]/gi, '').toLowerCase();

/** The exact bytes the bridge signs. */
function signedMessage({ vehicleKey, name, sha256, length, index, prevName, prevSha256 }) {
  return `${[VERSION, vehicleKey, name, sha256, length, index, prevName, prevSha256].join('\n')}\n`;
}

async function hashFile(file) {
  const h = crypto.createHash('sha256');
  let length = 0;
  await new Promise((ok, fail) => fs.createReadStream(file).on('data', (b) => { h.update(b); length += b.length; }).on('end', ok).on('error', fail));
  return { sha256: h.digest('hex'), length };
}

/**
 * Check one log against its sidecar's signature (no pairing decisions here):
 * { signed, ok, reason, fingerprint, publicKey, index, prevName, prevSha256, sha256, length }
 */
async function checkSignature(file, name, sidecar) {
  const n = parseName(name);
  const { sha256, length } = await hashFile(file);
  const base = { sha256, length };
  const g = sidecar && typeof sidecar === 'object' ? sidecar.integrity : null;
  if (!g || g.signed !== true) return { ...base, signed: false, ok: false, reason: g?.error ? `not signed: ${String(g.error).slice(0, 120)}` : 'not signed' };
  const fail = (reason, extra = {}) => ({ ...base, signed: true, ok: false, reason, ...extra });
  if (g.version !== VERSION) return fail(`unknown signature version ${String(g.version).slice(0, 40)}`);
  if (g.algorithm !== ALGORITHM) return fail(`unknown algorithm ${String(g.algorithm).slice(0, 40)}`);
  // the key first (a log that fails below is still placed in its key's chain)
  let der;
  let key;
  try {
    der = Buffer.from(String(g.public_key || ''), 'base64');
    key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch { return fail('the public key cannot be read'); }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return fail('not a P-256 key');
  const fingerprint = fingerprintOf(der);
  const index = Number(g.index);
  const prevName = String(g.prev_name ?? '');
  const prevSha256 = String(g.prev_sha256 ?? '').toLowerCase();
  const where = { fingerprint, index: Number.isSafeInteger(index) && index >= 0 ? index : null, prevName, prevSha256 };
  if (g.key_fingerprint && !sameFingerprint(g.key_fingerprint, fingerprint)) return fail('the key fingerprint does not match the key', where);
  // the signed fields must describe this file, as it is here
  if (g.vehicle_key !== n?.vehicleKey) return fail('signed for another car key', where);
  if (String(g.sha256 || '').toLowerCase() !== sha256) return fail('the file is not the one that was signed (SHA-256 differs)', where);
  if (Number(g.length) !== length) return fail('the file is not the one that was signed (length differs)', where);
  if (where.index === null) return fail('bad chain index', where);
  if (prevName.length > 200 || !/^[0-9a-f]{64}$/.test(prevSha256)) return fail('bad chain fields', where);
  const message = signedMessage({ vehicleKey: n.vehicleKey, name, sha256, length, index, prevName, prevSha256 });
  let good = false;
  try { good = crypto.verify('sha256', Buffer.from(message), key, Buffer.from(String(g.signature || ''), 'base64')); } catch { good = false; }
  const out = { ...base, signed: true, fingerprint, publicKey: der.toString('base64'), index, prevName, prevSha256 };
  return good ? { ...out, ok: true, reason: null } : { ...out, ok: false, reason: 'the signature does not match' };
}

function createCanTrust({ dir, log = null, now = () => Date.now() }) {
  const fileOf = (key) => path.join(dir, key, 'trust.json');
  const cache = new Map();
  const locks = new Map(); // key -> Promise (one change at a time per car key)
  async function load(key) {
    if (cache.has(key)) return cache.get(key);
    let t = null;
    try { t = JSON.parse(await fsp.readFile(fileOf(key), 'utf8')); } catch { /* none yet */ }
    if (!t || typeof t !== 'object') t = {};
    t = { pin: t.pin || null, newKey: t.newKey || null, logs: t.logs && typeof t.logs === 'object' ? t.logs : {} };
    cache.set(key, t);
    return t;
  }
  async function save(key) {
    const t = cache.get(key);
    await fsp.mkdir(path.join(dir, key), { recursive: true });
    const f = fileOf(key);
    const tmp = `${f}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(t));
    await fsp.rename(tmp, f);
  }
  const locked = (key, fn) => {
    const run = (locks.get(key) || Promise.resolve()).then(fn, fn);
    locks.set(key, run.catch(() => {}));
    return run;
  };

  /** Judge one log (after its log or sidecar arrived, or the pairing changed): its record. */
  function check(key, name) {
    return locked(key, async () => {
      const t = await load(key);
      const file = path.join(dir, key, name);
      const had = t.logs[name] || {};
      const st = await fsp.stat(file).catch(() => null);
      if (!st) return had; // not (or no longer) here
      let side = null;
      let sideHere = false;
      try { side = JSON.parse(await fsp.readFile(`${file}.json`, 'utf8')); sideHere = true; } catch { /* not yet */ }
      const rec = { ...had, checkedAt: now(), firstSeen: had.firstSeen || now() };
      if (!sideHere && now() - rec.firstSeen < WAIT_MS) {
        Object.assign(rec, { status: 'waiting', reason: 'waiting for its sidecar' });
        t.logs[name] = rec;
        await save(key);
        return rec;
      }
      const c = await checkSignature(file, name, side);
      Object.assign(rec, { sha256: c.sha256, length: c.length, signed: c.signed, fingerprint: c.fingerprint || null, index: c.index ?? null, prevName: c.prevName ?? null, prevSha256: c.prevSha256 ?? null });
      if (!c.signed) {
        // an older bridge, or no usable key on the device: fine before pairing, not after
        Object.assign(rec, t.pin ? { status: 'failed', reason: `${c.reason}, but this car is paired with a key` } : { status: 'unsigned', reason: c.reason });
      } else if (!c.ok) {
        Object.assign(rec, { status: 'failed', reason: c.reason });
      } else if (!t.pin) {
        // the first signed log pairs the car (the owner can compare the fingerprint with the app's)
        t.pin = { fingerprint: c.fingerprint, publicKey: c.publicKey, pinnedAt: now(), how: 'first signed upload' };
        t.newKey = null;
        log?.info?.(`CAN Bridge ${key}: paired with key ${c.fingerprint}`);
        Object.assign(rec, { status: 'verified', reason: null });
      } else if (sameFingerprint(c.fingerprint, t.pin.fingerprint)) {
        Object.assign(rec, { status: 'verified', reason: null });
      } else {
        // signed, but by another key: kept, and the owner may trust that key (a new Screenmate, the app reinstalled)
        t.newKey = { fingerprint: c.fingerprint, publicKey: c.publicKey, firstSeen: t.newKey?.fingerprint === c.fingerprint ? t.newKey.firstSeen : now(), log: name };
        Object.assign(rec, { status: 'failed', reason: 'signed by a key this car is not paired with' });
      }
      t.logs[name] = rec;
      await save(key);
      if (rec.status === 'failed') log?.warn?.(`CAN Bridge ${key}: ${name} failed: ${rec.reason}`);
      return rec;
    });
  }

  /** Whether a log's data may be used (decoded, synced): { use, trust } with trust verified | unsigned | override. */
  async function usable(key, name) {
    const t = await load(key);
    const r = t.logs[name];
    if (!r) return { use: false, trust: null };
    if (r.status === 'verified') return { use: true, trust: 'verified' };
    if (r.status === 'unsigned') return { use: true, trust: 'unsigned' };
    if (r.status === 'failed' && r.override) return { use: true, trust: 'override' };
    return { use: false, trust: null };
  }

  /** The chain of a car key, for the paired key's logs: { count, first, last, issues: [{ kind, … }] }. */
  async function chain(key) {
    const t = await load(key);
    const fp = t.pin?.fingerprint;
    // the paired key's logs (also ones that failed their check: here, but not what was signed)
    const mine = Object.entries(t.logs).filter(([, r]) => fp && r.fingerprint && sameFingerprint(r.fingerprint, fp) && Number.isSafeInteger(r.index));
    const byIndex = new Map();
    const issues = [];
    for (const [name, r] of mine) {
      const other = byIndex.get(r.index);
      if (other && other.name !== name) issues.push({ kind: 'duplicate', index: r.index, names: [other.name, name], text: `two logs with index ${r.index}` });
      else byIndex.set(r.index, { name, ...r });
    }
    const idx = [...byIndex.keys()].sort((a, b) => a - b);
    if (!idx.length) return { count: 0, first: null, last: null, issues };
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const cur = byIndex.get(i);
      if (k > 0 && i !== idx[k - 1] + 1) issues.push({ kind: 'gap', from: idx[k - 1] + 1, to: i - 1, text: i - 1 === idx[k - 1] + 1 ? `log ${idx[k - 1] + 1} is missing` : `logs ${idx[k - 1] + 1} to ${i - 1} are missing` });
      if (cur.status === 'failed') issues.push({ kind: 'failed', index: i, name: cur.name, text: `log ${i} (${cur.name}) failed its check: ${cur.reason}` });
      const prev = byIndex.get(i - 1);
      // (a failed log is already said: the one after it is compared with what was signed, not with it)
      if (prev && prev.status !== 'failed' && (cur.prevName !== prev.name || cur.prevSha256 !== prev.sha256)) {
        issues.push({ kind: 'mismatch', index: i, name: cur.name, text: `log ${i} (${cur.name}) does not follow the stored log ${i - 1} (${prev.name}): swapped or changed` });
      }
      // reordered: a later index must not start before an earlier one
      if (prev) {
        const a = parseName(prev.name)?.startedAt;
        const b = parseName(cur.name)?.startedAt;
        if (a && b && b < a) issues.push({ kind: 'reordered', index: i, name: cur.name, text: `log ${i} starts before log ${i - 1}` });
      }
    }
    return { count: idx.length, first: idx[0], last: idx[idx.length - 1], issues };
  }

  /** What the Nerd settings show for a car key. */
  async function summary(key) {
    const t = await load(key);
    const counts = { verified: 0, failed: 0, unsigned: 0, waiting: 0 };
    for (const r of Object.values(t.logs)) if (!r.deleted && counts[r.status] !== undefined) counts[r.status]++;
    return { key, pin: t.pin ? { fingerprint: t.pin.fingerprint, pinnedAt: t.pin.pinnedAt, how: t.pin.how } : null, newKey: t.newKey ? { fingerprint: t.newKey.fingerprint, firstSeen: t.newKey.firstSeen } : null, counts, chain: await chain(key) };
  }
  async function record(key, name) { return (await load(key)).logs[name] || null; }

  /** The owner trusts a key: the waiting new key (by its fingerprint), and every log it signed is judged again. */
  async function trustKey(key, fingerprint) {
    const names = await locked(key, async () => {
      const t = await load(key);
      if (!t.newKey || !sameFingerprint(t.newKey.fingerprint, fingerprint)) throw Object.assign(new Error('No such new key for this car.'), { status: 404 });
      t.pin = { fingerprint: t.newKey.fingerprint, publicKey: t.newKey.publicKey, pinnedAt: now(), how: 'confirmed by the owner' };
      t.newKey = null;
      await save(key);
      return Object.entries(t.logs).filter(([, r]) => r.status !== 'verified' && !r.deleted).map(([n]) => n);
    });
    for (const n of names) await check(key, n);
    return summary(key);
  }
  /** Forget the pairing: the next signed log pairs again (logs already verified stay verified). */
  async function forgetPin(key) {
    await locked(key, async () => { const t = await load(key); t.pin = null; t.newKey = null; await save(key); });
    return summary(key);
  }
  /** Use a failed log anyway (the dashboard warns), or stop using it. */
  async function setOverride(key, name, on) {
    return locked(key, async () => {
      const t = await load(key);
      const r = t.logs[name];
      if (!r || r.status !== 'failed') throw Object.assign(new Error('Only a failed log can be used anyway.'), { status: 409 });
      r.override = Boolean(on);
      await save(key);
      return r;
    });
  }
  /** A log deleted here: its record stays, for the chain. */
  async function deleted(key, name) {
    await locked(key, async () => { const t = await load(key); if (t.logs[name]) { t.logs[name].deleted = true; await save(key); } });
  }

  /** Every car key's logs not judged yet, or waiting (at start, and now and then). */
  async function pending() {
    const out = [];
    let keys = [];
    try { keys = (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
    for (const key of keys) {
      const t = await load(key);
      let names = [];
      try { names = await fsp.readdir(path.join(dir, key)); } catch { continue; }
      for (const name of names) {
        const n = parseName(name);
        if (!n || n.sidecar) continue;
        const r = t.logs[name];
        if (!r || r.status === 'waiting') out.push({ key, name });
      }
    }
    return out;
  }

  return { check, usable, chain, summary, record, trustKey, forgetPin, setOverride, deleted, pending };
}

module.exports = { createCanTrust, checkSignature, signedMessage, fingerprintOf, VERSION, ALGORITHM };
