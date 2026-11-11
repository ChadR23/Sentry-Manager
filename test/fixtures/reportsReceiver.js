'use strict';

// A small stand-in receiver for the client tests, built only from the public
// wire protocol (server/reportsProtocol.js, docs/reports-api.md). It is not
// the developers' receiver (that is a private service): it does just what the
// Manager's client needs to be tested against a real HTTP peer.
//
//   POST /v1/report  the envelope checks (validateBody, time, kid, proof of
//                    work, signature, a nonce replay check, the size caps),
//                    then open + validatePayload; 202 { ok, id, ref }.
//                    `limitHour` reports at most per hour, then 429 with
//                    Retry-After.
//   GET  /v1/config  { v, difficulty, maxBytes, kids, time, moved? }; the
//                    difficulty is read from opts each time (tests change it),
//                    `movedTo` adds a "moved to" notice signed by its key.
//
// Trust labels as the client expects them: an install's key is remembered the
// first time ("new"), the same install and key again is "verified", another
// key for a known install is refused (403), anonymous reports are "anon".
//
// Exposes: url, keys (publicInfo().line, current.kid), index (what was
// received: ref, kind, trust, install, key, kid, at), openReport(entry),
// config(), close().

const crypto = require('crypto');
const http = require('http');
const P = require('../../server/reportsProtocol');

function makeKeys() {
  const priv = crypto.generateKeyPairSync('x25519').privateKey;
  const signing = crypto.generateKeyPairSync('ed25519').privateKey;
  const pub = P.rawPublic(priv);
  const current = { priv, publicKey: P.b64(pub), kid: P.kidOf(pub) };
  const signingKey = P.b64(P.rawPublic(signing));
  return {
    current, signing, signingKey, byKid: new Map([[current.kid, current]]),
    publicInfo: () => ({ kid: current.kid, publicKey: current.publicKey, signingKey, line: P.keyLine({ publicKey: current.publicKey, signingKey }) })
  };
}

const fail = (status, error, code, extra = {}) => Object.assign(new Error(error), { status, code, extra });

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > max) { reject(fail(413, 'The report is larger than 8 MB.', 'TOO_LARGE')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

/**
 * opts: difficulty (bits, default 6, read on every request), limitHour
 * (reports per hour before 429, default unlimited), movedTo (a https://
 * address to announce, signed), maxPlain (the open cap).
 */
async function startReceiver(opts = {}) {
  const keys = makeKeys();
  const index = [];
  const raws = new Map();
  const nonces = new Set();
  const installs = new Map(); // install id -> key hash
  let hour = { n: 0, until: 0 };
  const bits = () => (Number.isInteger(Number(opts.difficulty)) ? Number(opts.difficulty) : 6);
  const movedAt = Date.now();
  const keyHash = (ik) => crypto.createHash('sha256').update(String(ik)).digest('hex').slice(0, 20);

  const config = () => ({
    v: P.V, difficulty: bits(), maxBytes: P.MAX_BODY, kids: [...keys.byKid.keys()], time: Date.now(),
    ...(opts.movedTo ? { moved: P.signMoved(opts.movedTo, movedAt, keys.signing) } : {})
  });

  async function receive(req) {
    if (opts.limitHour !== undefined) {
      const t = Date.now();
      if (hour.until <= t) hour = { n: 0, until: t + 3600_000 };
      hour.n += 1;
      if (hour.n > opts.limitHour) throw fail(429, 'Too many reports. Try again later.', 'RATE', { retryAfter: Math.ceil((hour.until - t) / 1000) });
    }
    const raw = await readBody(req, P.MAX_BODY);
    let b;
    try { b = JSON.parse(raw.toString('utf8')); } catch { throw fail(400, 'Not JSON.', 'BAD_BODY'); }
    const errs = P.validateBody(b);
    if (errs.length) throw fail(400, `Not a report: ${errs.slice(0, 3).join(', ')}.`, 'BAD_BODY');
    if (Math.abs(b.ts - Date.now()) > P.MAX_SKEW_MS) throw fail(400, 'The time is off.', 'TIME', { time: Date.now() });
    const key = keys.byKid.get(b.kid);
    if (!key) throw fail(400, 'Sealed to a key this receiver does not have.', 'KID');
    const envHash = P.envelopeHash(b);
    if (b.bits < bits() || !P.powOk(envHash, b.nonce, b.pow, b.bits)) throw fail(400, 'The proof of work is missing or too small.', 'POW', { difficulty: bits() });
    if (!P.verifySig(b)) throw fail(400, 'The signature does not check out.', 'SIG');
    if (nonces.has(b.nonce)) throw fail(400, 'This report was sent before.', 'REPLAY');
    nonces.add(b.nonce);
    let payload;
    try {
      payload = P.open(b, key.priv, opts.maxPlain ? { maxPlain: opts.maxPlain } : undefined);
    } catch (err) {
      if (err.code === 'TOO_BIG') throw fail(413, 'The report opens to too much.', 'TOO_LARGE');
      throw fail(400, err.message, err.code || 'BAD_TAG');
    }
    const perr = P.validatePayload(payload);
    if (perr.length) throw fail(400, `The report is not right: ${perr.slice(0, 3).join(', ')}.`, 'SCHEMA');

    const kh = keyHash(b.ik);
    let trust;
    if (payload.anonymous) trust = 'anon';
    else {
      const known = installs.get(payload.install);
      if (known && known !== kh) throw fail(403, 'This install id belongs to another key.', 'KEY_MISMATCH');
      trust = known ? 'verified' : 'new';
      installs.set(payload.install, kh);
    }
    let ref;
    do ref = P.refCode(); while (index.some((e) => e.ref === ref));
    const id = `r-${crypto.randomBytes(6).toString('hex')}`;
    const entry = { id, ref, kind: payload.kind, trust, install: payload.anonymous ? P.ANON : payload.install, anonymous: payload.anonymous, key: kh, kid: b.kid, at: Date.now() };
    index.push(entry);
    raws.set(id, raw);
    return { ok: true, id, ref };
  }

  const srv = http.createServer(async (req, res) => {
    const p = String(req.url || '/').split('?')[0];
    try {
      if (p === '/v1/config' && req.method === 'GET') return send(res, 200, config());
      if (p === '/v1/report' && req.method === 'POST') return send(res, 202, await receive(req));
      req.resume();
      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      if (res.headersSent) return res.end();
      const extra = err.extra || {};
      return send(res, err.status || 500, { ok: false, error: err.status ? err.message : 'Internal error', ...(err.code ? { code: err.code } : {}), ...extra },
        extra.retryAfter ? { 'Retry-After': String(extra.retryAfter) } : {});
    }
  }).listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));

  /** A received report, opened: its payload. */
  const openReport = (entry) => {
    const b = JSON.parse(raws.get(entry.id).toString('utf8'));
    return P.open(b, keys.byKid.get(b.kid).priv);
  };

  return {
    url: `http://127.0.0.1:${srv.address().port}`, keys, index, openReport, config, opts,
    close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); })
  };
}

module.exports = { startReceiver };
