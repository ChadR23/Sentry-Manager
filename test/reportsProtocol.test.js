'use strict';

// The reports' wire protocol (server/reportsProtocol.js):
// sealing and opening, tampering, a wrong key, the zip-bomb cap, the
// signature, the proof of work, the "moved to" notice, reference codes and
// the exact payload schema.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const zlib = require('zlib');
const P = require('../server/reportsProtocol');
const { reportsConfig, checkEndpoint, RECEIVER_KEYS, DEFAULT_ENDPOINT } = require('../server/reportsConfig');

const receiver = () => {
  const { privateKey } = crypto.generateKeyPairSync('x25519');
  const pub = P.b64(P.rawPublic(privateKey));
  return { privateKey, key: { publicKey: pub, kid: P.kidOf(P.rawPublic(privateKey)) } };
};
const payload = (extra = {}) => ({ kind: 'feedback', sentAt: new Date().toISOString(), install: 'a'.repeat(32), anonymous: false, build: { build: 130, sha: '1345348', builtAt: null, tag: null }, ui: 'original', message: 'hello', ...extra });

test('seal and open: the payload comes back; the envelope is exactly the v1 fields', () => {
  const r = receiver();
  const env = P.seal(payload(), r.key);
  assert.deepEqual(Object.keys(env), ['v', 'kid', 'epk', 'iv', 'ct', 'tag']);
  assert.equal(env.v, 1);
  assert.equal(env.kid, r.key.kid);
  assert.equal(env.kid.length, 16);
  assert.equal(Buffer.from(env.iv, 'base64').length, 12);
  assert.equal(Buffer.from(env.tag, 'base64').length, 16);
  assert.doesNotMatch(Buffer.from(env.ct, 'base64').toString('latin1'), /hello/, 'not readable on the way');
  assert.deepEqual(P.open(env, r.privateKey), payload({ sentAt: P.open(env, r.privateKey).sentAt }));
  // the kid is the first 16 hex of sha256(public key)
  assert.equal(r.key.kid, crypto.createHash('sha256').update(Buffer.from(r.key.publicKey, 'base64')).digest('hex').slice(0, 16));
});

test('tampering, another key, a changed kid: it does not open', () => {
  const r = receiver();
  const env = P.seal(payload(), r.key);
  const flip = (b64) => { const b = Buffer.from(b64, 'base64'); b[0] ^= 1; return b.toString('base64'); };
  for (const bad of [{ ...env, tag: flip(env.tag) }, { ...env, ct: flip(env.ct) }, { ...env, iv: flip(env.iv) }, { ...env, kid: '0'.repeat(16) }]) {
    assert.throws(() => P.open(bad, r.privateKey), (e) => e.code === 'BAD_TAG');
  }
  assert.throws(() => P.open(env, receiver().privateKey), (e) => e.code === 'BAD_TAG');
});

test('a gzip bomb stops at the cap', () => {
  const r = receiver();
  // a sealed envelope whose gzip opens to 2 MB of zeros, with the cap at 1 MB
  const plain = zlib.gzipSync(Buffer.alloc(2 * 1024 * 1024));
  const eph = crypto.generateKeyPairSync('x25519');
  const epk = P.rawPublic(eph.publicKey);
  const pub = Buffer.from(r.key.publicKey, 'base64');
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: P.publicKeyFromRaw(pub, 'X25519') });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([epk, pub]), Buffer.from('sentry-reports v1'), 32));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(`sentry-reports v1|${r.key.kid}`));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const env = { v: 1, kid: r.key.kid, epk: P.b64(epk), iv: P.b64(iv), ct: P.b64(ct), tag: P.b64(c.getAuthTag()) };
  assert.throws(() => P.open(env, r.privateKey, { maxPlain: 1024 * 1024 }), (e) => e.code === 'TOO_BIG');
  assert.equal(P.MAX_PLAIN, 100 * 1024 * 1024);
});

test('signature and proof of work: over the envelope, the time and the nonce', () => {
  const r = receiver();
  const env = P.seal(payload(), r.key);
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const nonce = P.b64(crypto.randomBytes(16));
  const h = P.envelopeHash(env);
  const pow = P.solvePow(h, nonce, 8);
  assert.ok(P.powOk(h, nonce, pow, 8));
  assert.ok(P.leadingZeroBits(P.sha256(h, Buffer.from(nonce, 'base64'), Buffer.from(pow, 'base64'))) >= 8);
  const body = P.sign(env, privateKey, { ts: Date.now(), nonce, pow, bits: 8 });
  assert.deepEqual(P.validateBody(body), []);
  assert.ok(P.verifySig(body));
  // any change breaks it
  assert.equal(P.verifySig({ ...body, ts: body.ts + 1 }), false);
  assert.equal(P.verifySig({ ...body, nonce: P.b64(crypto.randomBytes(16)) }), false);
  assert.equal(P.verifySig({ ...body, ct: P.seal(payload(), r.key).ct }), false);
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.equal(P.verifySig({ ...body, ik: P.b64(P.rawPublic(other)) }), false, 'another install cannot claim the signature');
  // the stamp is for this envelope and nonce only
  assert.equal(P.powOk(P.envelopeHash(P.seal(payload(), r.key)), nonce, pow, 8) && P.powOk(h, P.b64(crypto.randomBytes(16)), pow, 8), false);
  // an exact body: no extra fields, the right lengths
  assert.notDeepEqual(P.validateBody({ ...body, extra: 1 }), []);
  assert.notDeepEqual(P.validateBody({ ...body, sig: P.b64(crypto.randomBytes(10)) }), []);
  assert.notDeepEqual(P.validateBody({ ...body, v: 2 }), []);
});

test('payload schema: exact fields, types and lengths; ANON and contact; support and crash', () => {
  assert.deepEqual(P.validatePayload(payload()), []);
  assert.ok(P.validatePayload(payload({ extra: 1 })).some((e) => /unknown field/.test(e)));
  assert.ok(P.validatePayload(payload({ message: '' })).includes('message'));
  assert.ok(P.validatePayload(payload({ message: 'x'.repeat(5001) })).includes('message'));
  assert.deepEqual(P.validatePayload(payload({ message: 'x'.repeat(5000) })), []);
  assert.ok(P.validatePayload(payload({ install: 'ANON' })).includes('anonymous'), 'ANON goes with anonymous: true');
  assert.deepEqual(P.validatePayload(payload({ install: 'ANON', anonymous: true })), []);
  assert.ok(P.validatePayload(payload({ install: 'ANON', anonymous: true, contact: 'me@x.org' })).some((e) => /never when anonymous/.test(e)));
  assert.deepEqual(P.validatePayload(payload({ contact: 'me@x.org' })), []);
  assert.ok(P.validatePayload(payload({ contact: 'x'.repeat(201) })).includes('contact'));
  assert.ok(P.validatePayload(payload({ build: { build: 1, sha: 'zz', builtAt: null, tag: null } })).includes('build.sha'));
  assert.ok(P.validatePayload(payload({ build: { build: 1, sha: null, builtAt: null, tag: null, x: 1 } })).some((e) => /build\.x/.test(e)));
  // support: diagnostics required, an optional short note
  const sup = { kind: 'support', sentAt: new Date().toISOString(), install: 'ANON', anonymous: true, build: { build: null, sha: null, builtAt: null, tag: null }, ui: 'flux' };
  assert.ok(P.validatePayload(sup).includes('diagnostics missing'));
  assert.deepEqual(P.validatePayload({ ...sup, diagnostics: { system: { os: 'x' } } }), []);
  assert.deepEqual(P.validatePayload({ ...sup, message: 'broken', diagnostics: {} }), []);
  assert.ok(P.validatePayload({ ...sup, message: 'x'.repeat(1001), diagnostics: {} }).includes('message'));
  assert.ok(P.validatePayload({ ...sup, diagnostics: { secrets: 1 } }).some((e) => /diagnostics\.secrets/.test(e)));
  assert.ok(P.validatePayload({ ...sup, contact: 'x', diagnostics: {} }).some((e) => /feedback only/.test(e)));
  // crash: its block, and only there
  const crash = { ...sup, kind: 'crash', diagnostics: {}, crash: { at: new Date().toISOString(), name: 'TypeError', message: 'x', stack: 'at y' } };
  assert.deepEqual(P.validatePayload(crash), []);
  assert.ok(P.validatePayload({ ...crash, crash: { ...crash.crash, more: 1 } }).some((e) => /crash\.more/.test(e)));
  assert.ok(P.validatePayload({ ...sup, diagnostics: {}, crash: crash.crash }).some((e) => /crash reports only/.test(e)));
  // free-form diagnostics stay bounded
  let deep = {};
  for (let i = 0; i < 15; i++) deep = { d: deep };
  assert.ok(P.validatePayload({ ...sup, diagnostics: { system: deep } }).some((e) => /too deep/.test(e)));
  assert.ok(P.validatePayload({ ...sup, diagnostics: { logs: Array(6000).fill('x') } }).some((e) => /list is too long/.test(e)));
  assert.ok(P.validatePayload({ ...sup, kind: 'nope', diagnostics: {} }).includes('kind'));
});

test('the "moved to" notice: only the receiver\'s signing key makes one that checks out', () => {
  const sign = crypto.generateKeyPairSync('ed25519');
  const keys = [{ publicKey: receiver().key.publicKey, signingKey: P.b64(P.rawPublic(sign.privateKey)) }];
  const m = P.signMoved('https://reports2.example.org', 1700000000000, sign.privateKey);
  assert.ok(P.verifyMoved(m, keys));
  assert.equal(P.verifyMoved({ ...m, url: 'https://evil.example' }, keys), false);
  assert.equal(P.verifyMoved({ ...m, at: m.at + 1 }, keys), false);
  assert.equal(P.verifyMoved(P.signMoved('https://evil.example', 1, crypto.generateKeyPairSync('ed25519').privateKey), keys), false, 'a hijacked domain has no key to sign with');
  assert.equal(P.verifyMoved(m, [{ publicKey: keys[0].publicKey, signingKey: null }]), false);
});

test('reference codes: SR- and six Crockford letters, typed loosely', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const c = P.refCode();
    assert.match(c, /^SR-[0-9A-HJKMNP-TV-Z]{6}$/);
    seen.add(c);
  }
  assert.ok(seen.size > 190);
  assert.equal(P.normalizeRef('sr-7k2q9f'), 'SR-7K2Q9F');
  assert.equal(P.normalizeRef('7K2Q9F'), 'SR-7K2Q9F');
  assert.equal(P.normalizeRef('SR 7K2Q9O'), 'SR-7K2Q90');
  assert.equal(P.normalizeRef('hello'), null);
});

test('config: the built-in endpoint, keys from one line, https only', () => {
  assert.equal(DEFAULT_ENDPOINT, 'https://reports.skittles.live');
  assert.ok(Array.isArray(RECEIVER_KEYS));
  const none = reportsConfig({});
  assert.equal(none.endpoint, 'https://reports.skittles.live');
  assert.equal(none.keys.length, RECEIVER_KEYS.length);
  const sign = crypto.generateKeyPairSync('ed25519');
  const a = receiver().key.publicKey;
  const b = receiver().key.publicKey;
  const line = `${P.keyLine({ publicKey: a, signingKey: P.b64(P.rawPublic(sign.privateKey)) })} sr1:${b}`;
  const c = reportsConfig({ REPORTS_PUBLIC_KEY: line, REPORTS_URL: 'https://r.example.org/' });
  assert.equal(c.error, null);
  assert.equal(c.endpoint, 'https://r.example.org');
  assert.deepEqual(c.keys.map((k) => k.publicKey), [a, b], 'the first one seals; the others are kept for a rotation');
  assert.equal(c.keys[0].kid, P.kidOf(Buffer.from(a, 'base64')));
  assert.throws(() => checkEndpoint('http://r.example.org', {}), /https/);
  assert.throws(() => checkEndpoint('http://127.0.0.1:9', {}), /https/, 'plain http only for a localhost test');
  assert.equal(checkEndpoint('http://127.0.0.1:9', { NODE_ENV: 'test' }), 'http://127.0.0.1:9');
  assert.throws(() => checkEndpoint('https://u:p@r.example.org', {}));
  const bad = reportsConfig({ REPORTS_PUBLIC_KEY: 'not a key' });
  assert.ok(bad.error);
  assert.equal(bad.keys.length, 0, 'a bad key turns reporting off');
  assert.throws(() => P.normalizeKey({ kid: '0'.repeat(16), publicKey: a }), /does not match/);
});

test('heartbeat schema: exactly its fields, strict types and ranges, no diagnostics, under 4 KB', () => {
  const hb = (h = {}, extra = {}) => ({
    kind: 'heartbeat', sentAt: new Date().toISOString(), install: 'b'.repeat(32), anonymous: false, build: { build: 130, sha: '1345348', builtAt: null, tag: 'latest' }, ui: 'horizon',
    heartbeat: {
      uptimeSec: 3600, health: { overall: 'warn', warnings: 2, problems: 0 }, vehicles: 2, footageBytes: 812345678901, recordings: 4210,
      spaceSavedBytes: 301234567890, distanceKm: 18234.7, freeBytes: 1200000000000, totalBytes: 4000000000000, converting: false, jobsQueued: 1,
      features: { can: true, sentryUsbPaired: false, gpu: true }, ...h
    },
    ...extra
  });
  const good = hb();
  assert.deepEqual(P.validatePayload(good), []);
  assert.ok(Buffer.byteLength(JSON.stringify(good)) < 1024, 'compact');
  assert.deepEqual(P.validatePayload(hb({}, { install: 'ANON', anonymous: true })), []);
  assert.deepEqual(P.validatePayload(hb({ freeBytes: null, totalBytes: null, distanceKm: 0 })), [], 'no storage known yet');
  assert.ok(P.KINDS.includes('heartbeat'));
  const bad = (h, extra, re) => assert.ok(P.validatePayload(hb(h, extra)).some((e) => re.test(e)), `${re}: ${JSON.stringify(P.validatePayload(hb(h, extra)))}`);
  // extra fields, anywhere
  bad({ hostname: 'tower' }, {}, /unknown field heartbeat\.hostname/);
  bad({ health: { overall: 'ok', warnings: 0, problems: 0, list: [] } }, {}, /heartbeat\.health\.list/);
  bad({ features: { can: true, sentryUsbPaired: true, gpu: true, nodes: true } }, {}, /heartbeat\.features\.nodes/);
  bad({}, { diagnostics: {} }, /never in a heartbeat/);
  bad({}, { message: 'hi' }, /^message/);
  bad({}, { contact: 'me@x.org' }, /feedback only/);
  assert.ok(P.validatePayload({ ...hb(), heartbeat: undefined }).includes('heartbeat'));
  assert.ok(P.validatePayload(payload({ heartbeat: good.heartbeat })).some((e) => /heartbeats only/.test(e)), 'not in other kinds');
  // missing fields
  const { recordings: _r, ...noRec } = good.heartbeat;
  assert.ok(P.validatePayload({ ...good, heartbeat: noRec }).includes('heartbeat.recordings missing'));
  // wrong types and ranges
  bad({ uptimeSec: -1 }, {}, /heartbeat\.uptimeSec/);
  bad({ vehicles: 1.5 }, {}, /heartbeat\.vehicles/);
  bad({ vehicles: 1001 }, {}, /heartbeat\.vehicles/);
  bad({ footageBytes: '12' }, {}, /heartbeat\.footageBytes/);
  bad({ footageBytes: 2 ** 60 }, {}, /heartbeat\.footageBytes/);
  bad({ recordings: null }, {}, /heartbeat\.recordings/);
  bad({ spaceSavedBytes: -5 }, {}, /heartbeat\.spaceSavedBytes/);
  bad({ distanceKm: 12.34 }, {}, /heartbeat\.distanceKm/);
  bad({ distanceKm: 10_000_000.1 }, {}, /heartbeat\.distanceKm/);
  bad({ distanceKm: -0.1 }, {}, /heartbeat\.distanceKm/);
  bad({ distanceKm: '5' }, {}, /heartbeat\.distanceKm/);
  bad({ converting: 1 }, {}, /heartbeat\.converting/);
  bad({ jobsQueued: 100_001 }, {}, /heartbeat\.jobsQueued/);
  bad({ freeBytes: 5, totalBytes: 4 }, {}, /more than totalBytes/);
  bad({ freeBytes: null, totalBytes: 4 }, {}, /both or neither/);
  bad({ health: { overall: 'bad', warnings: 0, problems: 1 } }, {}, /health\.overall/);
  bad({ health: { overall: 'ok', warnings: 0, problems: 1 } }, {}, /does not match the counts/);
  bad({ health: { overall: 'ok', warnings: -1, problems: 0 } }, {}, /health\.warnings/);
  bad({ features: { can: 'yes', sentryUsbPaired: false, gpu: false } }, {}, /features\.can/);
  bad({ features: { can: true, gpu: false } }, {}, /features\.sentryUsbPaired/);
  // oversize: strings past their limits, and the whole payload past 4 KB
  bad({}, { ui: 'x'.repeat(81) }, /^ui$/);
  bad({}, { build: { build: 1, sha: null, builtAt: null, tag: 'x'.repeat(121) } }, /build\.tag/);
  assert.equal(P.HEARTBEAT_MAX_BYTES, 4096);
});
