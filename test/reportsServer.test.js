'use strict';

// Help & feedback through the real server: without a receiver key nothing
// can be sent; with one (the stand-in receiver in test/fixtures on
// localhost) an admin previews and
// sends, after the password; a watch-only account can neither see nor
// change any of it; changes are audit-logged; an anonymous preview carries
// none of this server's identifiers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { startReceiver } = require('./fixtures/reportsReceiver');

const REPO = path.join(__dirname, '..');
const SERVER = path.join(REPO, 'server', 'index.js');
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

async function startServer(dir, env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'),
      VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: 'correct horse', TZ: 'UTC',
      SENTRY_NOREPLACE_RENAME: path.join(REPO, 'build', 'noreplace-rename'), LOG_LEVEL: 'warn', TLS_MODE: 'off', TRUST_PROXY: 'true', REPORTS_URL: '', REPORTS_PUBLIC_KEY: '', ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const client = () => {
    let cookie = '';
    return async (method, p, body) => {
      const res = await fetch(base + p, {
        method,
        headers: { 'X-Forwarded-Proto': 'https', 'X-Requested-With': 'sentry-six-manager', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data };
    };
  };
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
  return { call: client(), client, stop, output: () => output };
}

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-reports-srv-'));
  await fsp.mkdir(path.join(dir, 'footage', 'TeslaCam', 'RecentClips'), { recursive: true });
  // two minutes of recent clips (two cameras) and one Sentry event clip, all just arrived
  for (const f of ['RecentClips/2026-11-10_10-00-00-front.mp4', 'RecentClips/2026-11-10_10-00-00-back.mp4', 'RecentClips/2026-11-10_10-01-00-front.mp4']) await fsp.writeFile(path.join(dir, 'footage', 'TeslaCam', f), 'x');
  await fsp.mkdir(path.join(dir, 'footage', 'TeslaCam', 'SentryClips', '2026-11-10_12-00-00'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'footage', 'TeslaCam', 'SentryClips', '2026-11-10_12-00-00', '2026-11-10_11-59-00-front.mp4'), 'x');
  return dir;
}

test('reporting turned off (REPORTS=off): nothing can be sent', { timeout: 60000 }, async () => {
  const s = await startServer(await setup(), { REPORTS: 'off' });
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    await s.call('POST', '/api/auth/confirm', { password: 'correct horse' });
    const st = (await s.call('GET', '/api/reports')).data;
    assert.equal(st.configured, false);
    assert.equal(st.notSetUpText, 'Reporting is turned off on this server (REPORTS=off).');
    assert.equal(st.settings.share, false, 'off by default');
    assert.equal((await s.call('POST', '/api/reports/preview', { kind: 'feedback', message: 'x' })).status, 409);
    assert.equal((await s.call('PUT', '/api/reports/settings', { share: true })).status, 409);
    assert.equal((await s.call('POST', '/api/reports/send', { previewId: 'x' })).status, 409);
  } finally { await s.stop(); }
});

test('with a receiver: preview, password, send; watch-only refused; audit-logged; anonymous previews carry no identifiers', { timeout: 90000 }, async () => {
  const rec = await startReceiver({ difficulty: 6 });
  const dir = await setup();
  const s = await startServer(dir, { NODE_ENV: 'test', REPORTS_URL: rec.url, REPORTS_PUBLIC_KEY: rec.keys.publicInfo().line });
  try {
    const admin = s.call;
    await admin('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    const st = (await admin('GET', '/api/reports')).data;
    assert.equal(st.configured, true);
    assert.equal(st.kid, rec.keys.current.kid);

    // the preview: the exact JSON, diagnostics included, no secrets
    const pv = (await admin('POST', '/api/reports/preview', { kind: 'feedback', message: 'Works great', contact: 'me@example.org', attach: true })).data;
    assert.equal(pv.payload.kind, 'feedback');
    assert.equal(pv.payload.contact, 'me@example.org');
    for (const k of ['system', 'storage', 'counts', 'settings', 'features', 'health', 'logs', 'crashes']) assert.ok(k in pv.payload.diagnostics, k);
    assert.equal(pv.payload.diagnostics.system.node, process.version);
    assert.ok(pv.payload.diagnostics.system.cores > 0);
    const text = JSON.stringify(pv.payload);
    assert.doesNotMatch(text, /correct horse/);
    // sending needs the password (a fresh sign-in counts for a few minutes, like every confirmed change)
    await admin('POST', '/api/auth/confirm', { password: 'correct horse' });
    const sent = (await admin('POST', '/api/reports/send', { previewId: pv.previewId })).data;
    assert.equal(sent.result, 'sent');
    assert.match(sent.ref, /^SR-/);
    assert.equal(sent.status.lastSent.ref, sent.ref);
    assert.deepEqual(rec.openReport(rec.index[0]), pv.payload);

    // a support report, anonymous
    assert.equal((await admin('PUT', '/api/reports/settings', { anonymous: true })).status, 200);
    const sp = (await admin('POST', '/api/reports/preview', { kind: 'support', message: 'the Daily Driver share is gone' })).data;
    assert.equal(sp.payload.install, 'ANON');
    const all = JSON.stringify(sp.payload);
    const word = (id) => new RegExp(`(?<![A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i');
    for (const id of [os.hostname(), 'Daily Driver', path.join(dir, 'footage'), path.join(dir, 'data'), 'admin', pv.payload.install]) assert.doesNotMatch(all, word(id), `${id} is not in an anonymous report`);
    const sup = (await admin('POST', '/api/reports/send', { previewId: sp.previewId })).data;
    assert.equal(sup.result, 'sent');
    assert.equal(rec.index[1].trust, 'anon');

    // the car's model, set by hand (its VIN would tell it with CAN data)
    const vid = (await admin('GET', '/api/vehicles')).data.vehicles[0].id;
    assert.equal((await admin('PUT', `/api/vehicles/${vid}`, { car: { model: 'Y', generation: 'auto' } })).status, 200);
    // opt-in: off by default; turned on and off, audit-logged
    assert.equal((await admin('PUT', '/api/reports/settings', { share: true })).data.settings.share, true);
    // turning it on sends the first heartbeat right away, new fields and all, and the receiver takes it
    for (let i = 0; i < 400 && !rec.index.some((e) => e.kind === 'heartbeat'); i++) await new Promise((r) => setTimeout(r, 25));
    const firstBeat = rec.index.find((e) => e.kind === 'heartbeat');
    assert.ok(firstBeat, 'the first heartbeat went at once');
    const fb = rec.openReport(firstBeat);
    assert.equal(fb.install, 'ANON');
    for (const k of ['footageSeconds', 'platform', 'arch', 'cpu', 'gpus', 'cars', 'clips24h', 'convert', 'crashes24h']) assert.ok(k in fb.heartbeat, k);
    assert.equal((await admin('PUT', '/api/reports/settings', { share: 'yes' })).status, 400);
    // the heartbeat the real server would send (a sample: nothing to send by hand); anonymous here
    // (once the footage is scanned)
    let hb = null;
    for (let i = 0; i < 100; i++) {
      hb = (await admin('POST', '/api/reports/preview', { kind: 'heartbeat' })).data;
      if (hb.payload?.heartbeat?.footageSeconds > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(hb.previewId, null);
    assert.equal(hb.payload.kind, 'heartbeat');
    assert.equal(hb.payload.install, 'ANON');
    assert.equal(hb.payload.heartbeat.vehicles, 1);
    assert.ok(hb.payload.heartbeat.uptimeSec >= 0);
    assert.ok(['ok', 'warn', 'problem'].includes(hb.payload.heartbeat.health.overall));
    assert.ok(Buffer.byteLength(JSON.stringify(hb.payload)) < 4096);
    // the new fields, from the server's own sources (anonymous, and still there)
    const h = hb.payload.heartbeat;
    assert.equal(h.footageSeconds, 3 * 60, 'three clip minutes (as the Dash counts footage hours)');
    assert.deepEqual(h.clips24h, { sentry: 1, dashcam: 3 });
    assert.equal(h.platform, process.platform);
    assert.equal(h.arch, process.arch);
    assert.equal(h.cpu, os.cpus()[0]?.model?.trim().replace(/\s+/g, ' ') || null);
    assert.ok(Array.isArray(h.gpus));
    assert.deepEqual(h.cars, [{ model: 'Model Y', firmware: null }]);
    assert.deepEqual(h.convert, { fps: null, encoder: null, device: null, api: null, codec: null }, 'nothing converted yet');
    assert.equal(h.crashes24h, 0);
    for (const id of [os.hostname(), 'Daily Driver', dir, 'admin']) assert.doesNotMatch(JSON.stringify(hb.payload), word(id), `${id} is not in a heartbeat`);
    const st2 = (await admin('GET', '/api/reports')).data;
    assert.ok(st2.nextHeartbeatAt > Date.now(), 'the first heartbeat is scheduled once sharing is on');

    // watch-only: cannot see or change any of it
    assert.equal((await admin('POST', '/api/accounts', { username: 'kid', password: 'watching only', role: 'viewer' })).status, 200);
    const kid = s.client();
    assert.equal((await kid('POST', '/api/auth/login', { username: 'kid', password: 'watching only' })).status, 200);
    await kid('POST', '/api/auth/confirm', { password: 'watching only' });
    assert.equal((await kid('GET', '/api/reports')).status, 403);
    assert.equal((await kid('POST', '/api/reports/preview', { kind: 'feedback', message: 'x' })).status, 403);
    assert.equal((await kid('POST', '/api/reports/send', { previewId: pv.previewId })).status, 403);
    assert.equal((await kid('PUT', '/api/reports/settings', { share: false })).status, 403);
    assert.equal((await admin('GET', '/api/reports')).data.settings.share, true, 'unchanged by the watch-only account');

    const logs = (await admin('GET', '/api/logs/search?level=info&q=developers')).data.lines.map((l) => l.message).join('\n');
    assert.match(logs, /Share diagnostics with the developers turned on: admin/);
    assert.match(logs, /Feedback sent to the developers \(SR-/);
    const logs2 = (await admin('GET', '/api/logs/search?level=info&q=anonymously')).data.lines.map((l) => l.message).join('\n');
    assert.match(logs2, /Send reports anonymously turned on: admin/);
  } finally {
    await s.stop();
    await rec.close();
  }
});
