'use strict';

// A columns log (canbridge-columns-xz/2) through the real server: uploaded by
// the upload API, indexed, listed with its format and why it was closed,
// downloaded exactly as received and as candump text (alone and in the
// bundle), and a malformed one refused cleanly.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { readZip } = require('../server/zip');

const REPO = path.join(__dirname, '..');
const SERVER = path.join(REPO, 'server', 'index.js');
const COLUMNS = path.join(__dirname, 'fixtures', 'columns-sample.log.xz');
const CANDUMP = path.join(__dirname, 'fixtures', 'columns-sample.candump.log.xz');
const SAMPLE_SHA256 = '94b7e2f631382aaf09df4303fc0256156759c64c20cd34397adbe4fb9b72a5a6';
const skip = spawnSync('xz', ['--version']).status !== 0 && 'needs xz';

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

async function startServer(dir) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'),
      VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: 'correct horse', TZ: 'UTC',
      SENTRY_NOREPLACE_RENAME: path.join(REPO, 'build', 'noreplace-rename'), LOG_LEVEL: 'warn', TLS_MODE: 'off', TRUST_PROXY: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  let cookie = '';
  const https = { 'X-Forwarded-Proto': 'https' };
  const call = async (method, p, body, { raw = false } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...https, 'X-Requested-With': 'sentry-six-manager', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (raw) return res;
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
  return { base, https, call, stop, output: () => output };
}

async function waitFor(fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 150));
  }
}

test('a columns log through the server: uploaded, indexed, listed with its format, downloaded as received and as candump text', { skip, timeout: 90000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-columns-'));
  await fsp.mkdir(path.join(dir, 'footage'), { recursive: true });
  const s = await startServer(dir);
  const put = (token, name, body) => fetch(`${s.base}/api/can/logs/${encodeURIComponent(name)}`, {
    method: 'POST', body,
    headers: { ...s.https, Authorization: `Bearer ${token}`, 'Upload-Offset': '0', 'Upload-Length': String(body.length), 'Upload-SHA256': crypto.createHash('sha256').update(body).digest('hex') }
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    await s.call('POST', '/api/auth/confirm', { password: 'correct horse' });
    const token = (await s.call('POST', '/api/can/enable', {})).data.token;
    const ping = await (await fetch(`${s.base}/api/can/logs/ping`, { headers: { ...s.https, Authorization: `Bearer ${token}` } })).json();
    assert.equal(ping.api, 1);

    const key = 'COLS-car';
    const name = `${key}_20261108T005818Z_1.log.xz`;
    const log = fs.readFileSync(COLUMNS);
    const text = execFileSync('xz', ['-dc', CANDUMP]);
    assert.equal((await put(token, name, log)).status, 201);
    const side = Buffer.from(JSON.stringify({ format: 'canbridge-columns-xz/2', frames: 10_847, dropped_chunks: 0, app_version: '0.2.130', closed_because: 'size' }));
    assert.equal((await put(token, `${name}.json`, side)).status, 201);
    // a malformed one beside it (the magic, then nothing that adds up)
    const bad = `${key}_20261108T010000Z_2.log.xz`;
    const badLog = execFileSync('xz', ['-1', '-c'], { input: Buffer.concat([Buffer.from('CANBRIDGE-COLUMNS/2\n'), Buffer.from([3, 1])]) });
    assert.equal((await put(token, bad, badLog)).status, 201);
    assert.equal((await put(token, `${bad}.json`, Buffer.from(JSON.stringify({ format: 'canbridge-columns-xz/2' })))).status, 201);

    // indexed: its minutes are there, as for a candump text log
    await waitFor(async () => {
      const st = (await s.call('GET', '/api/can/settings')).data;
      return st.index.indexed >= 1 && st.index.lastError && !st.index.running;
    });
    const minutes = await fsp.readdir(path.join(dir, 'data', 'can-index', key));
    assert.ok(minutes.includes('20261108T0058.json.gz') && minutes.includes('20261108T0058.raw.json.gz'), minutes.join(','));
    const st = (await s.call('GET', '/api/can/settings')).data;
    assert.match(st.index.lastError, new RegExp(`${bad}.*could not read`), 'the malformed one is an error of its own');
    assert.equal(s.output().includes('TypeError'), false);

    // listed with its format and why it was closed
    const files = Object.fromEntries((await s.call('GET', '/api/can/files')).data.logs.map((l) => [l.name, l]));
    assert.deepEqual([files[name].format, files[name].closedBecause, files[name].frames], ['canbridge-columns-xz/2', 'size', 10_847]);

    // exactly as received (the signed bytes)
    const asIs = await s.call('GET', `/api/can/files/${name}/download`, undefined, { raw: true });
    assert.ok(Buffer.from(await asIs.arrayBuffer()).equals(log));
    // as candump text: the same lines a candump text log holds
    const dump = await s.call('GET', `/api/can/files/${name}/candump`, undefined, { raw: true });
    assert.equal(dump.status, 200);
    assert.match(dump.headers.get('content-type'), /^text\/plain/);
    assert.match(dump.headers.get('content-disposition'), /filename="COLS-car_20261108T005818Z_1\.log"/);
    const got = Buffer.from(await dump.arrayBuffer());
    assert.equal(crypto.createHash('sha256').update(got).digest('hex'), SAMPLE_SHA256);
    assert.ok(got.equals(text));
    // a candump text log comes out as it is (xz -dc)
    const v1 = `${key}_20261108T005900Z_3.log.xz`;
    assert.equal((await put(token, v1, fs.readFileSync(CANDUMP))).status, 201);
    assert.ok(Buffer.from(await (await s.call('GET', `/api/can/files/${v1}/candump`, undefined, { raw: true })).arrayBuffer()).equals(text));
    // the malformed one: an error, not an empty file
    const refused = await s.call('GET', `/api/can/files/${bad}/candump`);
    assert.equal(refused.status, 422);
    assert.match(JSON.stringify(refused.data), /cannot be turned into candump text/);
    assert.equal((await s.call('GET', `/api/can/files/${name}.json/candump`)).status, 400, 'a sidecar has no candump text');
    assert.equal((await s.call('GET', `/api/can/files/${key}_20261108T020000Z_9.log.xz/candump`)).status, 404);

    // the bundle, with the candump text of each log beside it
    const q = `key=${key}&from=2026-11-08T00:50:00Z&to=2026-11-08T01:10:00Z`;
    const check = (await s.call('GET', `/api/can/export/bundle?${q}&candump=1&check=1`)).data;
    assert.equal(check.logs, 3);
    assert.ok(check.candumpBytes > 400_000, `an estimate of the text (${check.candumpBytes})`);
    const zip = Buffer.from(await (await s.call('GET', `/api/can/export/bundle?${q}&candump=1`, undefined, { raw: true })).arrayBuffer());
    const entries = Object.fromEntries(readZip(zip).map((e) => [e.name, e.data]));
    assert.ok(entries[`${key}/${name}`].equals(log), 'the log exactly as received');
    assert.ok(entries[`${key}/${name.replace(/\.xz$/, '')}`].equals(text), 'and as candump text');
    assert.ok(entries[`${key}/${v1.replace(/\.xz$/, '')}`].equals(text));
    assert.match(entries[`${key}/${bad.replace(/\.xz$/, '')}`].toString(), /^\n# Sentry Six Manager: could not read this log as candump text: .*columns/, 'one unreadable log does not stop the bundle');
    const manifest = JSON.parse(entries['manifest.json']);
    assert.equal(manifest.logs.find((l) => l.name === name).format, 'canbridge-columns-xz/2');
    // without the option: only the files as received
    const plain = readZip(Buffer.from(await (await s.call('GET', `/api/can/export/bundle?${q}`, undefined, { raw: true })).arrayBuffer())).map((e) => e.name);
    assert.equal(plain.filter((n) => n.endsWith('.log')).length, 0);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
