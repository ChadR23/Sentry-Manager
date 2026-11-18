'use strict';

// Settings → Advanced → Background work on the real server: the limits in
// use with the memory and CPUs they were picked from, an admin's numbers
// checked and saved, back to automatic, and hidden from watch-only accounts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, '..', 'server', 'index.js');
const HELPER = path.join(__dirname, '..', 'build', 'noreplace-rename');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test('work limits: shown with what they were picked from, set by an admin, back to automatic', { timeout: 60000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-limits-'));
  const root = path.join(dir, 'footage');
  await fsp.mkdir(path.join(root, 'TeslaCam'), { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: root,
      VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: 'correct horse', TZ: 'UTC',
      SENTRY_NOREPLACE_RENAME: HELPER, LOG_LEVEL: 'warn', TLS_MODE: 'off'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const base = `http://127.0.0.1:${port}`;
  const client = () => {
    let cookie = '';
    return async (method, p, body) => {
      const res = await fetch(base + p, {
        method, redirect: 'manual',
        headers: { 'X-Requested-With': 'sentry-six-manager', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let data = text;
      try { data = JSON.parse(text); } catch { /* text */ }
      return { status: res.status, data };
    };
  };
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    const admin = client();
    assert.equal((await admin('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 200);

    let w = (await admin('GET', '/api/settings/work-limits')).data;
    assert.ok(['small', 'medium', 'big'].includes(w.tier));
    assert.deepEqual(Object.keys(w.limits), ['speedIndex', 'codecChecks', 'scrubPreviews', 'telemetryReads', 'thumbnails']);
    assert.deepEqual(w.limits, w.auto, 'automatic until an admin sets a number');
    assert.deepEqual(w.override, {});
    assert.ok(w.resources.memoryBytes > 0 && w.resources.cpus > 0);
    assert.ok(['container', 'host'].includes(w.resources.memoryFrom));
    assert.equal(w.max.speedIndex, 8);

    for (const bad of [{ speedIndex: 0 }, { speedIndex: 9 }, { codecChecks: 'lots' }, { thumbnails: 1.5 }]) {
      assert.equal((await admin('PUT', '/api/settings/work-limits', bad)).status, 400, JSON.stringify(bad));
    }
    w = (await admin('PUT', '/api/settings/work-limits', { speedIndex: 2, codecChecks: '', telemetryReads: '1' })).data;
    assert.deepEqual(w.override, { speedIndex: 2, telemetryReads: 1 });
    assert.equal(w.limits.speedIndex, 2);
    assert.equal(w.limits.codecChecks, w.auto.codecChecks, 'left empty: automatic');
    assert.deepEqual((await admin('GET', '/api/settings/work-limits')).data.override, { speedIndex: 2, telemetryReads: 1 }, 'saved');

    assert.equal((await admin('POST', '/api/accounts', { username: 'kid', password: 'watching only', role: 'viewer' })).status, 200);
    const kid = client();
    assert.equal((await kid('POST', '/api/auth/login', { username: 'kid', password: 'watching only' })).status, 200);
    assert.equal((await kid('GET', '/api/settings/work-limits')).status, 403, 'admins only');
    assert.equal((await kid('PUT', '/api/settings/work-limits', {})).status, 403);

    w = (await admin('PUT', '/api/settings/work-limits', {})).data;
    assert.deepEqual(w.override, {});
    assert.deepEqual(w.limits, w.auto, 'all automatic again');
  } catch (err) {
    console.error(output);
    throw err;
  } finally {
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill('SIGTERM');
    });
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
