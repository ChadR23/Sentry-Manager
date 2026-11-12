'use strict';

// The Manager's report client (server/reports.js) against a stand-in
// receiver on localhost (test/fixtures/reportsReceiver.js, built only from the
// public protocol): the round trip, opt-in off sends nothing,
// anonymous reports, the support report's reference code, the outbox
// (sealed only, retried, capped), 429 and a changed difficulty, the
// per-hour limit on manual reports, and a signed move.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../server/reportsProtocol');
const { createReports, defaultTransport, OUTBOX_MAX } = require('../server/reports');
const { startReceiver: startFixture } = require('./fixtures/reportsReceiver');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sm-reports-'));
const memoryDb = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v) }; };
const quiet = { info() {}, warn() {}, error() {} };

async function startReceiver(opts = {}) {
  const rec = await startFixture({ difficulty: 6, ...opts });
  return { rec, url: rec.url, close: rec.close };
}

function client(r, { env = {}, transport = defaultTransport, db = memoryDb(), dataDir = tmp(), diagnostics, now } = {}) {
  const calls = [];
  const t = (req) => { calls.push(req); return transport(req); };
  const rep = createReports({
    db, dataDir, log: quiet, buildInfo: { build: 130, sha: '1345348abcdef0', builtAt: '2026-11-11T00:00:00Z', tag: 'latest' }, ui: () => 'flux',
    env: { NODE_ENV: 'test', ...(r ? { REPORTS_URL: r.url, REPORTS_PUBLIC_KEY: r.rec.keys.publicInfo().line } : {}), ...env },
    diagnostics: diagnostics || (async () => ({ system: { hostname: 'tower', os: 'Debian', ip: '192.168.1.9', note: 'smb password=hunter2 from 192.168.1.9' }, logs: ['WARN share //nas/TeslaCam (Daily Driver) gone at 10.0.0.2'] })),
    identifiers: async () => ['tower', 'Daily Driver', 'nas'],
    transport: t, ...(now ? { now } : {})
  });
  return { rep, calls, db, dataDir };
}

test('feedback and support: sealed, signed, stamped, received; the support report gets a reference code', async () => {
  const r = await startReceiver();
  try {
    const { rep } = client(r);
    assert.equal(rep.status().configured, true);
    const pv = await rep.preview({ kind: 'feedback', message: 'Love it', contact: 'me@example.org', attach: true });
    assert.equal(pv.payload.install.length, 32);
    assert.equal(pv.payload.contact, 'me@example.org');
    assert.equal(pv.payload.diagnostics.system.hostname, 'tower', 'not anonymous: identifiers stay');
    assert.match(pv.payload.diagnostics.system.note, /password=\[removed\]/, 'secrets never');
    const sent = await rep.sendPreview(pv.previewId);
    assert.equal(sent.result, 'sent');
    assert.match(sent.ref, /^SR-[0-9A-Z]{6}$/);
    const e = r.rec.index.at(-1);
    assert.equal(e.ref, sent.ref);
    assert.equal(e.trust, 'new');
    assert.deepEqual(r.rec.openReport(e), pv.payload, 'exactly what the preview showed');
    // the same preview is not sent twice
    await assert.rejects(rep.sendPreview(pv.previewId), /too old/);

    const sp = await rep.preview({ kind: 'support', message: 'Encoder stuck' });
    assert.ok(sp.payload.diagnostics, 'a support report always carries diagnostics');
    const s2 = await rep.sendPreview(sp.previewId);
    assert.equal(s2.result, 'sent');
    assert.notEqual(s2.ref, sent.ref);
    assert.equal(r.rec.index.at(-1).trust, 'verified', 'the same install and key as before');
    assert.equal(rep.status().lastSent.ref, s2.ref);
    assert.equal(rep.status().outbox.count, 0);
    // Settings → Your data: the install code and the reference codes, newest first
    assert.equal(rep.status().installCode, pv.payload.install.slice(0, 8));
    assert.deepEqual(rep.status().sentRefs.map((x) => [x.kind, x.ref, x.anonymous]), [['support', s2.ref, false], ['feedback', sent.ref, false]]);
  } finally { await r.close(); }
});

test('anonymous: ANON install, no contact, identifiers gone everywhere, a separate key', async () => {
  const r = await startReceiver();
  try {
    const db = memoryDb();
    const { rep } = client(r, { db });
    await rep.sendPreview((await rep.preview({ kind: 'feedback', message: 'named one' })).previewId);
    rep.setSettings({ anonymous: true });
    const pv = await rep.preview({ kind: 'feedback', message: 'from tower, my Daily Driver at 192.168.1.9', contact: 'me@example.org', attach: true });
    assert.equal(pv.payload.install, 'ANON');
    assert.equal(pv.payload.anonymous, true);
    assert.equal(pv.payload.contact, undefined);
    const all = JSON.stringify(pv.payload);
    for (const s of ['tower', 'Daily Driver', '192.168', '10.0.0.2', 'nas', 'hunter2', db.get('reports-state').installId]) assert.ok(!all.includes(s), s);
    const sent = await rep.sendPreview(pv.previewId);
    assert.equal(sent.result, 'sent');
    assert.match(sent.ref, /^SR-/, 'an anonymous report gets a code too');
    const [named, anon] = r.rec.index;
    assert.equal(anon.trust, 'anon');
    assert.equal(anon.install, 'ANON');
    assert.notEqual(anon.key, named.key, 'signed with a key of its own: not linkable to the install');
    assert.deepEqual(rep.status().sentRefs.map((x) => [x.ref, x.anonymous]).slice(0, 1), [[sent.ref, true]], 'kept locally, marked anonymous');
    // the preview no longer matches when the toggle changes in between
    const again = await rep.preview({ kind: 'support' });
    rep.setSettings({ anonymous: false });
    await assert.rejects(rep.sendPreview(again.previewId), /changed since the preview/);
  } finally { await r.close(); }
});

test('opt-in off: crashes and daily summaries make no network call at all', async () => {
  const r = await startReceiver();
  try {
    const { rep, calls, dataDir } = client(r);
    rep.noteCrash(new TypeError('boom at 192.168.1.4'), 'crash');
    rep.noteCrash(new Error('route failed'), 'error');
    assert.deepEqual(await rep.sendCrashes(), []);
    assert.equal(await rep.dailyIfDue(), null);
    await rep.flush({ all: true });
    assert.equal(calls.length, 0, 'nothing went out');
    // the crash is noted locally only (for diagnostics if a report is ever sent)
    assert.equal(rep.recentCrashes().length, 2);
    assert.equal(fs.statSync(path.join(dataDir, 'reports', 'crashes.json')).mode & 0o777, 0o600);
    // turned on: the noted crashes go (one report per distinct error), and the daily one a day later
    rep.setSettings({ share: true });
    const out = await rep.sendCrashes();
    assert.equal(out.length, 2);
    assert.ok(out.every((x) => x.result === 'sent'));
    const crash = r.rec.openReport(r.rec.index[0]);
    assert.equal(crash.kind, 'crash');
    assert.equal(crash.crash.name, 'TypeError');
    assert.equal(await rep.dailyIfDue(), null, 'not straight after turning it on');
    assert.deepEqual(await rep.sendCrashes(), [], 'each crash once');
  } finally { await r.close(); }
});

test('reporting turned off (REPORTS=off): nothing is built or sent', async () => {
  const { rep, calls } = client(null, { env: { REPORTS: 'off' } });
  const s = rep.status();
  assert.equal(s.configured, false);
  assert.equal(s.notSetUpText, 'Reporting is turned off on this server (REPORTS=off).');
  await assert.rejects(rep.preview({ kind: 'feedback', message: 'x' }), /turned off/);
  assert.throws(() => rep.setSettings({ share: true }), /turned off/);
  rep.noteCrash(new Error('x'));
  assert.deepEqual(await rep.sendCrashes(), []);
  assert.deepEqual(await rep.flush({ all: true }), []);
  assert.equal(calls.length, 0);
});

test('outbox: sealed only, retried with backoff, then delivered; capped at 20', async () => {
  const r = await startReceiver();
  try {
    let down = true;
    const transport = (req) => (down ? Promise.reject(new Error('ECONNREFUSED')) : defaultTransport(req));
    let t = Date.now();
    const { rep, dataDir } = client(r, { transport, now: () => t });
    const pv = await rep.preview({ kind: 'feedback', message: 'secret plan: tower', attach: true });
    const res = await rep.sendPreview(pv.previewId);
    assert.equal(res.result, 'retry');
    assert.equal(rep.status().outbox.count, 1);
    // never plaintext on disk
    const dir = path.join(dataDir, 'reports', 'outbox');
    const file = fs.readdirSync(dir)[0];
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(raw, /secret plan|tower|hunter2|feedback.*message/);
    assert.deepEqual(Object.keys(JSON.parse(raw).env), ['v', 'kid', 'epk', 'iv', 'ct', 'tag']);
    assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600);
    // not due yet: nothing tried
    down = false;
    await rep.flush();
    assert.equal(rep.status().outbox.count, 1);
    t += 3 * 60_000;
    const out = await rep.flush();
    assert.equal(out[0].result, 'sent');
    assert.equal(rep.status().outbox.count, 0);
    assert.equal(r.rec.openReport(r.rec.index.at(-1)).message, 'secret plan: tower');

    // the caps: 20 reports; older than 7 days dropped
    down = true;
    for (let i = 0; i < OUTBOX_MAX + 4; i++) await rep.enqueue(await rep.buildPayload({ kind: 'feedback', message: `m${i}`, attach: false }));
    assert.equal(rep.status().outbox.count, OUTBOX_MAX);
    t += 8 * 86_400_000;
    rep.trimOutbox();
    assert.equal(rep.status().outbox.count, 0);
  } finally { await r.close(); }
});

test('429: kept for later with Retry-After; a changed difficulty: sent again at once', async () => {
  const r = await startReceiver({ limitHour: 2 });
  try {
    const { rep } = client(r);
    rep.setSettings({ share: true });
    const send = async () => rep.enqueue(await rep.buildPayload({ kind: 'daily' }));
    assert.equal((await send()).result, 'sent');
    // the config fetch is cached; one POST more is allowed, then 429
    assert.equal((await send()).result, 'sent');
    const third = await send();
    assert.equal(third.result, 'retry');
    assert.equal(third.status, 429);
    const e = rep.outbox()[0];
    assert.ok(e.nextAt - Date.now() > 50_000, 'not before Retry-After');
    assert.match(rep.status().lastError.message, /busy/);
  } finally { await r.close(); }

  const r2 = await startReceiver({ difficulty: 4 });
  try {
    const { rep } = client(r2);
    await rep.remoteConfig(); // cached at 4 bits
    r2.rec.opts.difficulty = 9; // the receiver raises it
    const res = await rep.enqueue(await rep.buildPayload({ kind: 'feedback', message: 'x', attach: false }));
    assert.equal(res.result, 'sent', 'refused once with POW, then stamped at the new difficulty');
  } finally { await r2.close(); }
});

test('manual reports: at most 5 an hour each kind (double clicks never spam)', async () => {
  const r = await startReceiver();
  try {
    const { rep } = client(r, { diagnostics: async () => ({}) });
    for (let i = 0; i < 5; i++) assert.equal((await rep.sendPreview((await rep.preview({ kind: 'support', message: `n${i}` })).previewId)).result, 'sent');
    const pv = await rep.preview({ kind: 'support' });
    await assert.rejects(rep.sendPreview(pv.previewId), (e) => e.status === 429 && /5 in the last hour/.test(e.message));
    // feedback has its own count
    assert.equal((await rep.sendPreview((await rep.preview({ kind: 'feedback', message: 'x', attach: false })).previewId)).result, 'sent');
  } finally { await r.close(); }
});

test('a signed "moved to" is followed; an unsigned or wrongly signed one is not', async () => {
  const target = await startReceiver();
  // the old address, announcing a move signed by its key
  const moved = await startReceiver({ movedTo: 'https://reports2.example.org' });
  try {
    const db = memoryDb();
    const line = moved.rec.keys.publicInfo().line;
    const transport = (req) => { return defaultTransport({ ...req, url: req.url.replace('https://reports2.example.org', target.url) }); };
    // REPORTS_URL set by hand is never moved
    const fixed = client(moved, { db: memoryDb(), transport });
    await fixed.rep.remoteConfig(true);
    assert.equal(fixed.rep.endpoint(), moved.url);
    // the built-in endpoint (here a test one) follows a signed move
    const rep = createReports({ db: memoryDb(), dataDir: tmp(), log: quiet, env: { NODE_ENV: 'test', REPORTS_PUBLIC_KEY: line }, transport, diagnostics: async () => ({}) });
    assert.equal(rep.endpoint(), 'https://reports.skittles.live');
    // stand in for the real domain: answer its config with the old receiver's
    const viaOld = createReports({ db, dataDir: tmp(), log: quiet, env: { NODE_ENV: 'test', REPORTS_PUBLIC_KEY: line }, transport: (req) => (req.url.startsWith('https://reports.skittles.live') ? defaultTransport({ ...req, url: req.url.replace('https://reports.skittles.live', moved.url) }) : transport(req)), diagnostics: async () => ({}) });
    await viaOld.remoteConfig(true);
    assert.equal(viaOld.endpoint(), 'https://reports2.example.org');
    assert.equal(db.get('reports-state').moved.url, 'https://reports2.example.org');

    // a move signed by some other key is ignored
    const forged = await startReceiver({ movedTo: 'https://evil.example.org' });
    try {
      const db2 = memoryDb();
      const other = createReports({ db: db2, dataDir: tmp(), log: quiet, env: { NODE_ENV: 'test', REPORTS_PUBLIC_KEY: line }, transport: (req) => defaultTransport({ ...req, url: req.url.replace('https://reports.skittles.live', forged.url) }), diagnostics: async () => ({}) });
      await other.remoteConfig(true);
      assert.equal(other.endpoint(), 'https://reports.skittles.live');
      assert.equal(db2.get('reports-state', {}).moved, undefined);
    } finally { await forged.close(); }
  } finally { await moved.close(); await target.close(); }
});

test('the install key is made once and kept private', async () => {
  const r = await startReceiver();
  try {
    const { rep, dataDir } = client(r);
    await rep.sendPreview((await rep.preview({ kind: 'feedback', message: 'x', attach: false })).previewId);
    const f = path.join(dataDir, 'reports', 'install-key.pem');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dataDir, 'reports')).mode & 0o777, 0o700);
    const k = crypto.createPrivateKey(fs.readFileSync(f));
    assert.equal(k.asymmetricKeyType, 'ed25519');
    assert.ok(P.b64(P.rawPublic(k)));
  } finally { await r.close(); }
});

test('the transport gives up after its timeout even while the receiver keeps sending a byte now and then', async () => {
  const http = require('http');
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const t = setInterval(() => res.write(' '), 50);
    res.on('close', () => clearInterval(t));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const t0 = Date.now();
    await assert.rejects(defaultTransport({ method: 'GET', url: `http://127.0.0.1:${srv.address().port}/v1/config`, timeoutMs: 400 }), /in time/);
    assert.ok(Date.now() - t0 < 3000, 'within about the timeout');
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});

test('an automatic report on its way when sharing is turned off is not sent', async () => {
  const r = await startReceiver();
  try {
    const calls = [];
    const realPow = require('../server/reports').workerPow;
    // sharing is turned off while the proof of work runs
    const rep2 = createReports({
      db: memoryDb(), dataDir: tmp(), log: quiet, env: { NODE_ENV: 'test', REPORTS_URL: r.url, REPORTS_PUBLIC_KEY: r.rec.keys.publicInfo().line },
      diagnostics: async () => ({}), heartbeat: async () => ({}),
      transport: (req) => { calls.push(req); return defaultTransport(req); },
      pow: async (h, n, b) => { rep2.setSettings({ share: false }); return realPow(h, n, b); }
    });
    rep2.setSettings({ share: true });
    const before = r.rec.index.length;
    const out = await rep2.sendHeartbeat();
    assert.equal(out.result, 'dropped');
    assert.equal(r.rec.index.length, before, 'nothing reached the receiver');
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
    assert.equal(rep2.outbox().length, 0, 'and nothing waits');
  } finally {
    await r.close();
  }
});

test('a receiver answering null or a list is junk, not a crash: the report waits for a later try', async () => {
  const transport = async (req) => ({ status: req.method === 'GET' ? 200 : 400, headers: {}, body: Buffer.from(req.method === 'GET' ? '{"difficulty":0}' : 'null') });
  const rep = createReports({ db: memoryDb(), dataDir: tmp(), log: quiet, env: { NODE_ENV: 'test', REPORTS_PUBLIC_KEY: P.keyLine({ publicKey: P.b64(P.rawPublic(crypto.generateKeyPairSync('x25519').publicKey)) }) }, transport, diagnostics: async () => ({}), pow: async () => P.b64(Buffer.alloc(8)) });
  const pv = await rep.preview({ kind: 'support' });
  const out = await rep.sendPreview(pv.previewId);
  assert.equal(out.result, 'dropped', 'a 400 is refused for good, read as such');
  assert.match(out.message, /400/);
});

test('this build has the receiver key for reports.skittles.live', () => {
  const { reportsConfig } = require('../server/reportsConfig');
  const c = reportsConfig({});
  assert.equal(c.endpoint, 'https://reports.skittles.live');
  assert.equal(c.keys[0].kid, '208993f9bb2c38d1');
  assert.equal(c.error, null);
});
