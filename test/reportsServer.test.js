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
  return dir;
}

test('no receiver key in this build: "not set up", nothing can be sent', { timeout: 60000 }, async () => {
  const s = await startServer(await setup());
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    await s.call('POST', '/api/auth/confirm', { password: 'correct horse' });
    const st = (await s.call('GET', '/api/reports')).data;
    assert.equal(st.configured, false);
    assert.equal(st.notSetUpText, "Reporting isn't set up in this build.");
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

    // opt-in: off by default; turned on and off, audit-logged
    assert.equal((await admin('PUT', '/api/reports/settings', { share: true })).data.settings.share, true);
    assert.equal((await admin('PUT', '/api/reports/settings', { share: 'yes' })).status, 400);

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
