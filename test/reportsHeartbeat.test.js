'use strict';

// The hourly heartbeat (server/reports.js): sent only while "Share
// diagnostics with the developers" is on, the first about 5 minutes after a
// start then every hour (each with a little jitter), stopped when sharing is
// turned off; anonymous when "Send anonymously" is on; at most one waiting in
// the outbox, and never pushing a real report out of it; the stand-in
// receiver (test/fixtures/reportsReceiver.js) accepts the kind.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../server/reportsProtocol');
const { createReports, normalizeHeartbeat, defaultTransport, OUTBOX_MAX, HEARTBEAT_FIRST_MS, HEARTBEAT_EVERY_MS } = require('../server/reports');
const { startReceiver } = require('./fixtures/reportsReceiver');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sm-heartbeat-'));
const memoryDb = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v) }; };
const quiet = { info() {}, warn() {}, error() {} };
const NUMBERS = {
  uptimeSec: 7200.4, health: { warnings: 1, problems: 0 }, vehicles: 2, footageBytes: 812345678901, recordings: 4210, spaceSavedBytes: 301234567890,
  distanceKm: 18234.71, freeBytes: 1.2e12, totalBytes: 4e12, converting: true, jobsQueued: 3, features: { can: true, sentryUsbPaired: true, gpu: false },
  // whatever else the caller had is left out
  hostname: 'tower', vehicleNames: ['Daily Driver']
};

/** A timer whose callbacks the test runs by hand: { pending: [{ fn, ms }] }. */
function fakeTimer() {
  const pending = [];
  return {
    pending,
    set: (fn, ms) => { const t = { fn, ms }; pending.push(t); return t; },
    clear: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
    /** Runs the one due callback and waits for its send. */
    async fire() { assert.equal(pending.length, 1, 'exactly one heartbeat scheduled'); const t = pending.shift(); await t.fn(); return t.ms; }
  };
}

function client(rec, { transport = defaultTransport, db = memoryDb(), timer = fakeTimer(), random = () => 0.5, now } = {}) {
  const calls = [];
  const rep = createReports({
    db, dataDir: tmp(), log: quiet, buildInfo: { build: 131, sha: '9b50039abcdef0', builtAt: '2026-11-11T00:00:00Z', tag: 'latest' }, ui: () => 'horizon',
    env: { NODE_ENV: 'test', REPORTS_URL: rec.url, REPORTS_PUBLIC_KEY: rec.keys.publicInfo().line },
    diagnostics: async () => { throw new Error('a heartbeat never asks for diagnostics'); },
    heartbeat: async () => NUMBERS,
    identifiers: async () => ['tower', 'Daily Driver'],
    transport: (req) => { calls.push(req); return transport(req); }, timer, random, ...(now ? { now } : {})
  });
  return { rep, calls, db, timer };
}
const posts = (calls) => calls.filter((c) => c.method === 'POST').length;

test('normalizeHeartbeat: exactly the protocol fields, whole numbers, distance to 0.1 km, overall from the counts', () => {
  const h = normalizeHeartbeat(NUMBERS);
  assert.deepEqual(Object.keys(h), Object.keys(P.HEARTBEAT_FIELDS));
  assert.equal(h.uptimeSec, 7200);
  assert.deepEqual(h.health, { overall: 'warn', warnings: 1, problems: 0 });
  assert.equal(h.distanceKm, 18234.7);
  assert.equal(h.freeBytes, 1.2e12);
  assert.equal(normalizeHeartbeat({ health: { problems: 2, warnings: 5 } }).health.overall, 'problem');
  const empty = normalizeHeartbeat({});
  assert.equal(empty.health.overall, 'ok');
  assert.equal(empty.freeBytes, null);
  assert.equal(empty.totalBytes, null);
  assert.deepEqual(empty.features, { can: false, sentryUsbPaired: false, gpu: false });
  assert.equal(normalizeHeartbeat({ freeBytes: 9, totalBytes: 5 }).freeBytes, 5, 'free never more than total');
  assert.equal(normalizeHeartbeat({ distanceKm: 3e7 }).distanceKm, 10_000_000);
});

test('scheduled: about 5 minutes after the start, then hourly, only while sharing is on; off stops it', async () => {
  const rec = await startReceiver({ difficulty: 4 });
  const { rep, calls, timer } = client(rec);
  try {
    rep.start();
    // sharing off: the tick sends nothing at all (and keeps the hour going)
    const first = await timer.fire();
    assert.equal(first, HEARTBEAT_FIRST_MS, 'random 0.5: no jitter');
    assert.equal(calls.length, 0, 'sharing off: no network call');
    assert.equal(timer.pending[0].ms, HEARTBEAT_EVERY_MS);
    assert.equal(rep.status().nextHeartbeatAt, null);
    assert.equal(rep.status().lastHeartbeat, null);
    // turned on: the next one in about 5 minutes, not an hour
    rep.setSettings({ share: true });
    assert.equal(timer.pending.length, 1);
    assert.equal(timer.pending[0].ms, HEARTBEAT_FIRST_MS);
    assert.ok(rep.status().nextHeartbeatAt > Date.now());
    await timer.fire();
    assert.equal(posts(calls), 1);
    const e = rec.index.at(-1);
    assert.equal(e.kind, 'heartbeat');
    const p = rec.openReport(e);
    assert.deepEqual(P.validatePayload(p), [], 'the receiver accepted it as it is');
    assert.equal(p.ui, 'horizon');
    assert.equal(p.build.build, 131);
    assert.equal(p.diagnostics, undefined);
    assert.deepEqual(p.heartbeat, normalizeHeartbeat(NUMBERS));
    assert.ok(!JSON.stringify(p).includes('tower'));
    assert.ok(rep.status().lastHeartbeat.at > 0);
    assert.equal(rep.status().lastSent, null, 'a heartbeat never hides the last real report');
    // then hourly
    assert.equal(timer.pending[0].ms, HEARTBEAT_EVERY_MS);
    await timer.fire();
    assert.equal(posts(calls), 2);
    // turned off: the next tick sends nothing
    rep.setSettings({ share: false });
    await timer.fire();
    assert.equal(posts(calls), 2);
    assert.equal(rep.status().nextHeartbeatAt, null);
    // stopped: nothing is scheduled any more
    rep.stop();
    assert.equal(timer.pending.length, 0);
  } finally { rep.stop(); await rec.close(); }
});

test('the schedule has jitter: the first in 3 to 7 minutes, then 56 to 64 minutes', async () => {
  const rec = await startReceiver();
  try {
    for (const [r, first, every] of [[0, HEARTBEAT_FIRST_MS - 120_000, HEARTBEAT_EVERY_MS - 240_000], [1, HEARTBEAT_FIRST_MS + 120_000, HEARTBEAT_EVERY_MS + 240_000]]) {
      const { rep, timer } = client(rec, { random: () => r });
      rep.start();
      assert.equal(await timer.fire(), first);
      assert.equal(timer.pending[0].ms, every);
      rep.stop();
    }
  } finally { await rec.close(); }
});

test('anonymous: install ANON, a separate key, nothing identifying', async () => {
  const rec = await startReceiver();
  const { rep, db } = client(rec);
  try {
    rep.setSettings({ share: true });
    assert.equal((await rep.sendHeartbeat()).result, 'sent');
    rep.setSettings({ anonymous: true });
    assert.equal((await rep.sendHeartbeat()).result, 'sent');
    const [named, anon] = rec.index;
    assert.equal(named.trust, 'new');
    assert.equal(anon.trust, 'anon');
    assert.equal(anon.install, 'ANON');
    assert.notEqual(anon.key, named.key);
    const p = rec.openReport(anon);
    assert.equal(p.install, 'ANON');
    assert.equal(p.anonymous, true);
    const all = JSON.stringify(p);
    for (const s of ['tower', 'Daily Driver', db.get('reports-state').installId]) assert.ok(!all.includes(s), s);
    // the sample the preview shows is the same shape, and has nothing to send
    const pv = await rep.preview({ kind: 'heartbeat' });
    assert.equal(pv.previewId, null);
    assert.equal(pv.sample, true);
    assert.equal(pv.payload.install, 'ANON');
    assert.deepEqual(P.validatePayload(pv.payload), []);
  } finally { await rec.close(); }
});

test('outbox: only the latest heartbeat waits; it never pushes a real report out; off drops it', async () => {
  const rec = await startReceiver();
  let down = true;
  const transport = (req) => (down ? Promise.reject(new Error('ECONNREFUSED')) : defaultTransport(req));
  let t = Date.now();
  const { rep } = client(rec, { transport, now: () => t });
  try {
    rep.setSettings({ share: true });
    const r1 = await rep.sendHeartbeat();
    assert.equal(r1.result, 'retry');
    assert.match(rep.status().lastHeartbeat.error.message, /Could not reach/);
    assert.equal(rep.status().lastError, null, 'a heartbeat problem has its own line');
    t += 60_000;
    await rep.sendHeartbeat();
    t += 60_000;
    await rep.sendHeartbeat();
    const beats = rep.outbox().filter((e) => e.kind === 'heartbeat');
    assert.equal(beats.length, 1, 'a failed heartbeat is replaced by the next');
    // a full outbox of real reports: a heartbeat does not push one out
    for (let i = 0; i < OUTBOX_MAX; i++) await rep.enqueue(await rep.buildPayload({ kind: 'feedback', message: `m${i}`, attach: false }));
    let list = rep.outbox();
    assert.equal(list.length, OUTBOX_MAX);
    assert.equal(list.filter((e) => e.kind === 'heartbeat').length, 0, 'the heartbeat made room');
    await rep.sendHeartbeat();
    list = rep.outbox();
    assert.equal(list.length, OUTBOX_MAX);
    assert.equal(list.filter((e) => e.kind === 'feedback').length, OUTBOX_MAX, 'every real report kept');
    // with room: one waits, and goes with the others when the receiver is back
    rep.trimOutbox();
    for (const e of rep.outbox().slice(0, 2)) fs.unlinkSync(e.file);
    await rep.sendHeartbeat();
    assert.equal(rep.outbox().filter((e) => e.kind === 'heartbeat').length, 1);
    // turning sharing off drops the waiting heartbeat (the feedback stays)
    rep.setSettings({ share: false });
    assert.equal(rep.outbox().filter((e) => e.kind === 'heartbeat').length, 0);
    assert.equal(rep.outbox().length, OUTBOX_MAX - 2);
    down = false;
    t += 7 * 3600_000;
    const out = await rep.flush();
    assert.ok(out.every((x) => x.result === 'sent'));
    assert.equal(rec.index.filter((e) => e.kind === 'heartbeat').length, 0, 'no heartbeat went after sharing was off');
  } finally { await rec.close(); }
});

test('sharing off or no key: sendHeartbeat makes no call', async () => {
  const rec = await startReceiver();
  try {
    const { rep, calls } = client(rec);
    assert.equal(await rep.sendHeartbeat(), null);
    assert.equal(calls.length, 0);
  } finally { await rec.close(); }
  const off = createReports({ db: memoryDb(), dataDir: tmp(), log: quiet, env: { NODE_ENV: 'test', REPORTS_URL: '', REPORTS_PUBLIC_KEY: '' }, heartbeat: async () => NUMBERS, timer: fakeTimer() });
  assert.equal(await off.sendHeartbeat(), null);
  await assert.rejects(off.preview({ kind: 'heartbeat' }), /isn't set up/);
});
