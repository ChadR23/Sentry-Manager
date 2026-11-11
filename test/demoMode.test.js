'use strict';

// The public demo (DEMO=1, server/demoMode.js): locked features refused with
// 403 (and working with DEMO off), the demo account and its hint, the reset
// (state back from the seed; TLS, the attack log, owner settings and
// signed-in sessions left alone), the conversion caps and no replace mode.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const demoMode = require('../server/demoMode');
const { ManagerDB } = require('../server/db');

const REPO = path.join(__dirname, '..');
const SERVER = path.join(REPO, 'server', 'index.js');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer(dir, env = {}) {
  const port = await freePort();
  await fsp.mkdir(path.join(dir, 'footage', 'TeslaCam', 'RecentClips'), { recursive: true });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env, DEMO: '', PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'),
      VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: 'correct horse', TZ: 'UTC',
      LOG_LEVEL: 'info', TLS_MODE: 'off', UPDATE_CHECK: 'off', ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const jar = new Map();
  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'X-Requested-With': 'sentry-six-manager', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual'
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (pair.slice(i + 1) && !/Max-Age=0/.test(c)) jar.set(pair.slice(0, i), pair.slice(i + 1)); else jar.delete(pair.slice(0, i));
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('exit', (code) => resolve(code));
    child.kill('SIGTERM');
  });
  return { base, call, stop, output: () => output };
}

// the main locked routes, as a visitor would send them
const LOCKED = [
  ['POST', '/api/vehicles/test-smb', { source: { type: 'smb', share: '//198.51.100.1/x', username: 'u', password: 'p' } }],
  ['POST', '/api/vehicles', { name: 'X', source: { type: 'path', path: '/etc' } }],
  ['POST', '/api/accounts', { username: 'eve', password: 'longpassword', role: 'admin' }],
  ['POST', '/api/auth/password', { current: 'x', password: 'yyyyyyyyyy' }],
  ['POST', '/api/auth/2fa/start', {}],
  ['GET', '/api/auth/sessions'],
  ['POST', '/api/nodes', { address: '198.51.100.2:9000' }],
  ['POST', '/api/sentryusb/pair', { name: 'pi' }],
  ['POST', '/api/can/tokens', { name: 't' }],
  ['POST', '/api/can/enable', {}],
  ['GET', '/api/support-bundle'],
  ['GET', '/api/logs'],
  ['GET', '/api/logs/download'],
  ['POST', '/api/snapshots', {}],
  ['POST', '/api/updates/check', {}],
  ['POST', '/api/metrics/enable', {}],
  ['PUT', '/api/security/hostnames', { hostnames: ['evil.example'] }],
  ['PUT', '/api/security/access', { settings: {} }],
  ['POST', '/api/ui-packs/upload', {}]
];

test('the lockdown list: main routes locked, ordinary use is not', () => {
  for (const [m, p, body] of LOCKED) assert.ok(demoMode.lockedFeature(m, p, body), `${m} ${p}`);
  assert.ok(demoMode.lockedFeature('PUT', '/api/vehicles/v1', { source: { type: 'path', path: '/' } }));
  assert.ok(demoMode.lockedFeature('DELETE', '/api/sentryusb/abc'));
  assert.ok(demoMode.lockedFeature('PUT', '/api/sentryusb/abc/proxy/api/system/update-source'));
  for (const [m, p, body] of [['GET', '/api/vehicles'], ['PUT', '/api/vehicles/v1', { name: 'New name' }], ['POST', '/api/auth/logout'], ['POST', '/api/auth/login'],
    ['POST', '/api/stars', {}], ['GET', '/api/sentryusb'], ['POST', '/api/sentryusb/abc/queue', {}], ['PUT', '/api/ui-packs/active', {}], ['POST', '/api/auth/confirm']]) {
    assert.equal(demoMode.lockedFeature(m, p, body), null, `${m} ${p}`);
  }
});

test('conversions in the demo: never in place, one at a time, no lanes, no automatic or benchmark runs', () => {
  assert.equal(demoMode.converterRule('start', { outputMode: 'replace', replacementConfirmed: true }).error, 'replace in place');
  const ok = demoMode.converterRule('start', { outputMode: 'separate', concurrency: 4, lanes: [{ device: 'cpu', concurrency: 4 }] });
  assert.equal(ok.error, undefined);
  assert.equal(ok.payload.concurrency, 1);
  assert.equal('lanes' in ok.payload, false);
  assert.equal(demoMode.converterRule('setConcurrency', { jobId: 'j', concurrency: 8 }).payload.concurrency, 1);
  for (const n of ['setAuto', 'saveVehicle', 'runBenchmark', 'checkAutoNow', 'setLanes']) assert.ok(demoMode.converterRule(n, {}).error, n);
  assert.equal(demoMode.converterRule('getCurrent').error, undefined);
  assert.ok(demoMode.CONVERT.maxClips <= 20);
  // conversions an hour per client
  let t = 0;
  const rl = demoMode.createRateLimits({ now: () => t });
  for (let i = 0; i < demoMode.CONVERT.perHour; i++) assert.equal(rl.take('convert', 'a'), 0);
  assert.ok(rl.take('convert', 'a') > 0);
  assert.equal(rl.firstOver('convert', 'a'), true);
  assert.equal(rl.take('convert', 'b'), 0, 'per client');
  t += 3_600_001;
  assert.equal(rl.take('convert', 'a'), 0, 'a new hour');
});

test('reset: the data folder and footage come back from the seed; TLS, logs, the attack log, owner settings and sessions stay', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-demo-reset-'));
  const data = path.join(base, 'data');
  const footage = path.join(base, 'footage');
  const env = {};
  try {
    fs.mkdirSync(path.join(data, 'tls'), { recursive: true });
    fs.mkdirSync(path.join(data, 'demo-pi'), { recursive: true });
    fs.mkdirSync(path.join(footage, 'TeslaCam', 'SavedClips'), { recursive: true });
    fs.writeFileSync(path.join(data, 'tls', 'key.pem'), 'KEY-1');
    fs.writeFileSync(path.join(data, 'demo-pi', 'state.json'), '{"paired":false}');
    fs.writeFileSync(path.join(footage, 'TeslaCam', 'SavedClips', 'a.mp4'), 'clip');
    let db = new ManagerDB(path.join(data, 'manager.db'));
    db.putUser('demo', 's', 'h');
    db.set('appearance', { clock24: false });
    db.set('owner-settings', { banner: 'one' });
    db.db.exec('CREATE TABLE attack_log (id INTEGER PRIMARY KEY, kind TEXT)');
    assert.equal(demoMode.takeSeed({ dataDir: data, db, footageDir: footage, env }), true);
    assert.equal(demoMode.takeSeed({ dataDir: data, db, footageDir: footage, env }), false, 'taken once');
    // visitors change things; the owner side goes on too
    db.set('appearance', { clock24: true });
    db.putUser('eve', 's', 'h');
    db.addSession('tok-demo', 'demo', Date.now() + 3600_000);
    db.db.prepare('INSERT INTO attack_log (kind) VALUES (?)').run('login');
    db.set('owner-settings', { banner: 'two' });
    db.close();
    fs.writeFileSync(path.join(data, 'tls', 'key.pem'), 'KEY-2');
    fs.writeFileSync(path.join(data, 'demo-pi', 'state.json'), '{"paired":true}');
    fs.writeFileSync(path.join(data, 'junk.txt'), 'x');
    fs.mkdirSync(path.join(data, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(data, 'logs', 'manager.log'), 'log');
    fs.rmSync(path.join(footage, 'TeslaCam', 'SavedClips', 'a.mp4'));
    fs.writeFileSync(path.join(footage, 'TeslaCam', 'new.mp4'), 'x');

    assert.equal(demoMode.applyPendingReset({ dataDir: data, footageDir: footage, env }), null, 'nothing pending');
    demoMode.markReset(data);
    const done = demoMode.applyPendingReset({ dataDir: data, footageDir: footage, env });
    assert.ok(done.includes('manager.db') && done.includes('demo-pi') && done.includes('junk.txt'), done.join());
    assert.equal(fs.existsSync(path.join(data, '.demo-reset-pending')), false);
    assert.equal(fs.existsSync(path.join(data, 'junk.txt')), false);
    assert.equal(fs.readFileSync(path.join(data, 'demo-pi', 'state.json'), 'utf8'), '{"paired":false}', 'the stand-in Pi state too');
    assert.equal(fs.readFileSync(path.join(data, 'tls', 'key.pem'), 'utf8'), 'KEY-2', 'TLS untouched');
    assert.equal(fs.readFileSync(path.join(data, 'logs', 'manager.log'), 'utf8'), 'log');
    assert.ok(fs.existsSync(path.join(footage, 'TeslaCam', 'SavedClips', 'a.mp4')));
    assert.equal(fs.existsSync(path.join(footage, 'TeslaCam', 'new.mp4')), false);
    const d = new DatabaseSync(path.join(data, 'manager.db'));
    try {
      assert.equal(JSON.parse(d.prepare("SELECT value FROM settings WHERE key = 'appearance'").get().value).clock24, false);
      assert.equal(d.prepare("SELECT count(*) AS n FROM users WHERE username = 'eve'").get().n, 0);
      assert.equal(d.prepare('SELECT count(*) AS n FROM attack_log').get().n, 1, 'the attack log kept');
      assert.equal(JSON.parse(d.prepare("SELECT value FROM settings WHERE key = 'owner-settings'").get().value).banner, 'two');
      assert.equal(d.prepare("SELECT count(*) AS n FROM sessions WHERE token_hash = 'tok-demo'").get().n, 1, 'signed in still');
    } finally {
      d.close();
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('DEMO on: the demo account and its hint, locked routes 403, conversions capped; DEMO off: the same routes are not locked', { timeout: 180000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-demo-'));
  let s = await startServer(dir, { DEMO: '1', DEMO_RESET_MINUTES: '30' });
  try {
    let r = await s.call('GET', '/api/auth/me');
    assert.deepEqual(r.data.demo, { username: 'demo', password: 'demo', resetMinutes: 30 });
    const login = await s.call('GET', '/login');
    assert.match(login.data, /<script src="[^"]*\/web\/demo\.js"><\/script>/);
    const js = await fetch(`${s.base}/web/demo.js`);
    assert.equal(js.status, 200);
    assert.match(await js.text(), /Try the demo/);
    r = await s.call('POST', '/api/auth/login', { username: 'demo', password: 'demo' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    r = await s.call('GET', '/api/auth/me');
    assert.equal(r.data.user, 'demo');
    assert.equal(r.data.role, 'admin');
    await s.call('POST', '/api/auth/confirm', { password: 'demo' });
    for (const [m, p, body] of LOCKED) {
      r = await s.call(m, p, body);
      assert.equal(r.status, 403, `${m} ${p}: ${JSON.stringify(r.data)}`);
      assert.equal(r.data.code, 'DEMO_LOCKED', `${m} ${p}`);
      assert.equal(r.data.error, 'Turned off in the demo.');
    }
    const vs = (await s.call('GET', '/api/vehicles')).data;
    const vid = (vs.vehicles || vs)[0].id;
    r = await s.call('PUT', `/api/vehicles/${vid}`, { source: { type: 'path', path: '/' } });
    assert.equal(r.status, 403);
    assert.equal((await fetch(`${s.base}/metrics`)).status, 403);
    r = await s.call('POST', '/api/converter/invoke/start', { outputMode: 'replace' });
    assert.equal(r.status, 403);
    assert.equal(r.data.feature, 'replace in place');
    assert.equal((await s.call('POST', '/api/converter/invoke/setAuto', {})).status, 403);
    // still usable
    assert.equal((await s.call('GET', '/api/vehicles')).status, 200);
    assert.equal((await s.call('POST', '/api/auth/logout', {})).status, 200);
    // the seed was taken
    assert.ok(fs.existsSync(path.join(dir, 'data', '.demo-seed', 'ready')));
  } finally {
    await s.stop();
  }
  // DEMO off: none of this
  const dir2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-demo-off-'));
  s = await startServer(dir2);
  try {
    let r = await s.call('GET', '/api/auth/me');
    assert.equal(r.data.demo, undefined);
    assert.doesNotMatch((await s.call('GET', '/login')).data, /demo\.js/);
    assert.notEqual((await fetch(`${s.base}/web/demo.js`, { redirect: 'manual' })).status, 200, 'no demo script');
    assert.equal((await s.call('POST', '/api/auth/login', { username: 'demo', password: 'demo' })).status, 401, 'no demo account');
    assert.equal((await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 200);
    await s.call('POST', '/api/auth/confirm', { password: 'correct horse' });
    for (const [m, p] of [['GET', '/api/auth/sessions'], ['GET', '/api/logs'], ['POST', '/api/snapshots'], ['POST', '/api/can/tokens'], ['POST', '/api/accounts']]) {
      const body = m === 'GET' ? undefined : p === '/api/accounts' ? { username: 'viewer1', password: 'longpassword', role: 'viewer' } : p === '/api/can/tokens' ? { name: 't' } : {};
      r = await s.call(m, p, body);
      assert.equal(r.status, 200, `${m} ${p}: ${JSON.stringify(r.data)}`);
    }
    r = await s.call('POST', '/api/vehicles/test-smb', { source: { type: 'smb' } });
    assert.notEqual(r.data?.code, 'DEMO_LOCKED');
    assert.notEqual(r.status, 403);
    assert.equal(fs.existsSync(path.join(dir2, 'data', '.demo-seed')), false);
  } finally {
    await s.stop();
  }
});
