'use strict';

// The reporting opt-in on the first-run page (POST /api/auth/setup with
// `reports: { share, anonymous }`): off unless ticked, checked before the
// account is made, saved and audit-logged once it is, ignored when the
// build cannot report; and the two boxes on the built-in setup page (the
// only interface a first start shows).

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
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

/** A first start: no UI_PASSWORD, so the account is made with the setup code. */
async function firstStart(env = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-reports-setup-'));
  await fsp.mkdir(path.join(dir, 'footage', 'TeslaCam', 'RecentClips'), { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'),
      VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: '', UI_PASSWORD_FILE: '', TZ: 'UTC',
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
  let cookie = '';
  const call = async (method, p, body) => {
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
  const code = () => fs.readFileSync(path.join(dir, 'data', 'setup-code.txt'), 'utf8').trim();
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('exit', resolve);
    child.kill('SIGTERM');
  }).then(() => fsp.rm(dir, { recursive: true, force: true }));
  return { call, code, stop, output: () => output };
}
const account = (s, extra = {}) => ({ username: 'admin', password: 'a long password', code: s.code(), ...extra });
const settle = () => new Promise((r) => setTimeout(r, 300));

test('with a receiver: ticked at setup turns sharing on (audit-logged, the first heartbeat goes); left off stays off; bad values make no account', { timeout: 120000 }, async () => {
  const rec = await startReceiver({ difficulty: 6 });
  const env = { NODE_ENV: 'test', REPORTS_URL: rec.url, REPORTS_PUBLIC_KEY: rec.keys.publicInfo().line };
  try {
    // share on, anonymously
    let s = await firstStart(env);
    try {
      const me = (await s.call('GET', '/api/auth/me')).data;
      assert.equal(me.needsSetup, true);
      assert.deepEqual(me.reports, { configured: true }, 'the first-run page is told it may offer the opt-in');
      // bad values: 400, and nothing is made (the same setup code still works after)
      for (const bad of [true, 'yes', [], null, { share: 'yes' }, { share: 1 }, { anonymous: 'on' }, { share: true, extra: true }]) {
        const r = await s.call('POST', '/api/auth/setup', account(s, { reports: bad }));
        assert.equal(r.status, 400, JSON.stringify(bad));
        assert.equal((await s.call('GET', '/api/auth/me')).data.needsSetup, true, `no account after ${JSON.stringify(bad)}`);
      }
      const r = await s.call('POST', '/api/auth/setup', account(s, { reports: { share: true, anonymous: true } }));
      assert.equal(r.status, 200, JSON.stringify(r.data));
      const st = (await s.call('GET', '/api/reports')).data;
      assert.equal(st.settings.share, true);
      assert.equal(st.settings.anonymous, true);
      assert.ok(st.nextHeartbeatAt > Date.now(), 'the next heartbeat is scheduled');
      assert.equal((await s.call('GET', '/api/auth/me')).data.reports, undefined, 'only the first-run page is told');
      // the first heartbeat goes right away
      for (let i = 0; i < 100 && !rec.index.some((e) => e.kind === 'heartbeat'); i++) await new Promise((ok) => setTimeout(ok, 200));
      assert.equal(rec.index.filter((e) => e.kind === 'heartbeat').length, 1);
      assert.equal(rec.index.find((e) => e.kind === 'heartbeat').trust, 'anon');
      await settle();
      assert.match(s.output(), /\[audit\] Share diagnostics with the developers turned on at setup: admin from 127\.0\.0\.1/);
      assert.match(s.output(), /\[audit\] Send reports anonymously turned on at setup: admin from 127\.0\.0\.1/);
    } finally { await s.stop(); }

    // the boxes left off: sharing stays off, nothing goes
    const before = rec.index.length;
    s = await firstStart(env);
    try {
      assert.equal((await s.call('POST', '/api/auth/setup', account(s, { reports: { share: false, anonymous: false } }))).status, 200);
      const st = (await s.call('GET', '/api/reports')).data;
      assert.equal(st.settings.share, false);
      assert.equal(st.settings.anonymous, false);
      assert.equal(st.nextHeartbeatAt, null);
      await settle();
      assert.doesNotMatch(s.output(), /at setup/);
      assert.equal(rec.index.length, before, 'nothing was sent');
    } finally { await s.stop(); }

    // no field at all: setup works as before, sharing off
    s = await firstStart(env);
    try {
      assert.equal((await s.call('POST', '/api/auth/setup', account(s))).status, 200);
      assert.equal((await s.call('GET', '/api/auth/me')).data.user, 'admin');
      assert.equal((await s.call('GET', '/api/reports')).data.settings.share, false);
    } finally { await s.stop(); }
  } finally { await rec.close(); }
});

test('reporting not configured (REPORTS=off): the page is told, and a choice sent anyway is ignored', { timeout: 60000 }, async () => {
  const s = await firstStart({ REPORTS: 'off' });
  try {
    assert.deepEqual((await s.call('GET', '/api/auth/me')).data.reports, { configured: false });
    assert.equal((await s.call('POST', '/api/auth/setup', account(s, { reports: { share: true, anonymous: true } }))).status, 200);
    const st = (await s.call('GET', '/api/reports')).data;
    assert.equal(st.configured, false);
    assert.equal(st.settings.share, false);
    assert.equal(st.settings.anonymous, false);
    await settle();
    assert.doesNotMatch(s.output(), /at setup/);
  } finally { await s.stop(); }
});

// ---- the setup form (only the built-in interface: no pack can be chosen before the first account exists)
test('the built-in setup form has the opt-in, unticked, hidden unless the build can report', () => {
  const h = read('web/login.html');
  const m = /<div class="setup-optin" id="reports-row" hidden>([\s\S]*?)<\/div>/.exec(h);
  assert.ok(m, 'the opt-in, hidden until the page shows it');
  const box = m[1];
  assert.ok(box.includes('Share diagnostics with the developers'));
  assert.ok(box.includes('Crash reports, a daily summary and an hourly heartbeat (version, health, footage size, space saved, miles driven). Never passwords or keys. You can change this any time in Settings → Help &amp; feedback.'));
  assert.ok(box.includes('Send anonymously'));
  assert.match(box, /<input type="checkbox" name="share">/, 'off by default');
  assert.match(box, /<input type="checkbox" name="anonymous" disabled>/, 'off, and only usable with sharing on');
  assert.doesNotMatch(box, /checked/);
  // it sits in the setup form, after the setup code
  assert.ok(h.indexOf('id="code-row"') < h.indexOf('id="reports-row"') && h.indexOf('id="reports-row"') < h.indexOf('</form>'));
  assert.match(h, /\.setup-optin\[hidden\] \{ display: none; \}/, 'the box stays hidden although it is a grid');

  const j = read('web/login.js');
  assert.match(j, /if \(me\.reports\?\.configured\) \{/, 'shown only when the server can report');
  assert.match(j, /\$\('reports-row'\)\.hidden = false;/);
  assert.match(j, /optin\.anonymous\.disabled = !optin\.share\.checked;/);
  assert.match(j, /if \(!optin\.share\.checked\) optin\.anonymous\.checked = false;/);
  assert.match(j, /\{ reports: \{ share: \$\('form'\)\.share\.checked, anonymous: \$\('form'\)\.share\.checked && \$\('form'\)\.anonymous\.checked \} \}/);
  assert.match(j, /\.\.\.\(setup \? \{ code: [^}]*, \.\.\.optIn\(\) \} : \{\}\)/, 'sent with the setup request only');
  // the field is only sent when the box is shown
  assert.match(j, /\$\('reports-row'\)\.hidden \? \{\} :/);
});
