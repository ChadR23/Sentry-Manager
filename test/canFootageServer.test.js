'use strict';

// The green "CAN" tag on the Footage page, through the real server: a
// recording gets can: true (and its day canRecordings) when a usable CAN log
// of a key mapped to its car covers its clips, in the car's time zone; not for
// another car's key, a log that failed its check (until it is used anyway), or
// a log deleted; the answer follows each change at once.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fsp = require('fs/promises');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { signedMessage } = require('../server/canTrust');

const REPO = path.join(__dirname, '..');
const SERVER = path.join(REPO, 'server', 'index.js');
const skip = spawnSync('xz', ['--version']).status !== 0 && 'needs xz';

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

/** The server on `dir`; `jar` keeps the session cookie across restarts. */
async function startServer(dir, jar) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'),
      VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: 'correct horse', TZ: 'UTC',
      SENTRY_NOREPLACE_RENAME: path.join(REPO, 'build', 'noreplace-rename'), LOG_LEVEL: 'info', TLS_MODE: 'off', TRUST_PROXY: 'true', UPDATE_CHECK: 'off', FOLDER_ROOTS: path.join(dir, 'footage2')
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
  const https = { 'X-Forwarded-Proto': 'https' };
  const call = async (method, p, body, c = jar) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...https, 'X-Requested-With': 'sentry-six-manager', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(c.cookie ? { Cookie: c.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = res.headers.get('set-cookie');
    if (set) c.cookie = set.split(';')[0];
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  const put = (token, name, data) => fetch(`${base}/api/can/logs/${encodeURIComponent(name)}`, {
    method: 'POST', body: data,
    headers: { ...https, Authorization: `Bearer ${token}`, 'Upload-Offset': '0', 'Upload-Length': String(data.length), 'Upload-SHA256': crypto.createHash('sha256').update(data).digest('hex') }
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
  return { base, https, call, put, stop, output: () => output };
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


test('Footage: can: true on recordings a usable CAN log of the car covers, in its time zone; canRecordings per day; follows overrides, mapping and deletes', { skip, timeout: 180000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-cantag-'));
  const recent = path.join(dir, 'footage', 'TeslaCam', 'RecentClips');
  await fsp.mkdir(recent, { recursive: true });
  await fsp.mkdir(path.join(dir, 'footage2', 'TeslaCam', 'RecentClips'), { recursive: true });
  // the car is in New York (EST on 2026-11-08: UTC-5): clips named 10:00, 11:00 and 12:00 local are 15:00, 16:00 and 17:00 UTC
  for (const c of ['2026-11-08_10-00-00', '2026-11-08_10-01-00', '2026-11-08_11-00-00', '2026-11-08_12-00-00']) await fsp.writeFile(path.join(recent, `${c}-front.mp4`), 'x');
  // and one named at 15:00, which is the log's UTC minute but not the car's time
  await fsp.writeFile(path.join(recent, '2026-11-08_15-00-00-front.mp4'), 'x');
  const KEY = 'TAG-car';
  const logOf = (t0) => {
    const lines = [];
    for (let i = 0; i < 300; i++) {
      const b = Buffer.alloc(8);
      b.writeUInt16LE(Math.round(380 / 0.01), 0);
      lines.push(`(${(t0 / 1000 + i / 5).toFixed(6)}) can0 132#${b.toString('hex').toUpperCase()}`);
    }
    return execFileSync('xz', ['-6', '-c'], { input: `${lines.join('\n')}\n` });
  };
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const signed = (name, body) => {
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    const msg = signedMessage({ vehicleKey: KEY, name, sha256: sha, length: body.length, index: 0, prevName: '-', prevSha256: '0'.repeat(64) });
    const integrity = { signed: true, version: 'canbridge-log-sig-v1', algorithm: 'ECDSA-P256-SHA256', public_key: der.toString('base64'), vehicle_key: KEY, sha256: sha, length: body.length, index: 0, prev_name: '-', prev_sha256: '0'.repeat(64), signature: crypto.sign('sha256', Buffer.from(msg), privateKey).toString('base64') };
    return Buffer.from(JSON.stringify({ format: 'canbridge-candump-xz/1', frames: 300, integrity }));
  };
  const goodName = `${KEY}_20261108T150000Z_1.log.xz`; // 10:00 in New York
  const badName = `${KEY}_20261108T170000Z_2.log.xz`; // 12:00 in New York: no signature, after pairing
  const minuteFile = (hhmm) => path.join(dir, 'data', 'can-index', KEY, `20261108T${hhmm}.json.gz`);
  const jar = { cookie: '' };
  const s = await startServer(dir, jar);
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    await s.call('POST', '/api/auth/confirm', { password: 'correct horse' });
    const vid = (await s.call('GET', '/api/vehicles')).data.vehicles[0].id;
    assert.equal((await s.call('PUT', `/api/vehicles/${vid}`, { timezone: 'America/New_York' })).status, 200);
    const other = (await s.call('POST', '/api/vehicles', { name: 'Second car', source: { type: 'path', path: path.join(dir, 'footage2') } })).data;
    assert.ok(other.id, JSON.stringify(other));
    await s.call('POST', `/api/vehicles/${vid}/scan`, {});
    const recs = async () => {
      const r = await s.call('GET', `/api/vehicles/${vid}/recordings?limit=500`);
      return Object.fromEntries((r.data.recordings || []).map((x) => [x.startKey, x]));
    };
    const tags = async () => Object.fromEntries(Object.entries(await recs()).map(([k, x]) => [k, x.can === true]));
    const day = async () => (await s.call('GET', `/api/vehicles/${vid}/days`)).data.days.find((d) => d.day === '2026-11-08');
    await waitFor(async () => Object.keys(await recs()).length === 4);
    assert.deepEqual(Object.keys(await recs()).sort(), ['2026-11-08_10-00-00', '2026-11-08_11-00-00', '2026-11-08_12-00-00', '2026-11-08_15-00-00']);
    // no CAN data yet: no tag anywhere
    assert.ok(Object.values(await recs()).every((x) => !('can' in x)), 'left out when false');
    assert.equal((await day()).canRecordings, 0);

    const token = (await s.call('POST', '/api/can/enable', {})).data.token;
    const good = logOf(Date.UTC(2026, 10, 8, 15, 0, 0));
    assert.equal((await s.put(token, goodName, good)).status, 201);
    assert.equal((await s.put(token, `${goodName}.json`, signed(goodName, good))).status, 201);
    await waitFor(async () => fs.existsSync(minuteFile('1500')));
    // one car on its own would read an unmapped key as its own; with two cars, the key is mapped
    assert.equal((await s.call('POST', '/api/can/vehicle-map', { key: KEY, vehicleId: vid })).status, 200);
    assert.deepEqual(await tags(), { '2026-11-08_10-00-00': true, '2026-11-08_11-00-00': false, '2026-11-08_12-00-00': false, '2026-11-08_15-00-00': false }, 'the 10:00 local recording (10:00 and 10:01), not the one named 15:00');
    assert.equal((await day()).canRecordings, 1);

    // the same key mapped to the other car: not this car's data any more
    assert.equal((await s.call('POST', '/api/can/vehicle-map', { key: KEY, vehicleId: other.id })).status, 200);
    assert.equal((await tags())['2026-11-08_10-00-00'], false, 'another car\'s key');
    assert.equal((await day()).canRecordings, 0);
    assert.equal((await s.call('POST', '/api/can/vehicle-map', { key: KEY, vehicleId: vid })).status, 200);
    assert.equal((await tags())['2026-11-08_10-00-00'], true);

    // a log that failed its check (unsigned once the car is paired): no tag, until it is used anyway
    const bad = logOf(Date.UTC(2026, 10, 8, 17, 0, 0));
    assert.equal((await s.put(token, badName, bad)).status, 201);
    assert.equal((await s.put(token, `${badName}.json`, Buffer.from(JSON.stringify({ format: 'canbridge-candump-xz/1', frames: 300 })))).status, 201);
    const check = async (n) => (await s.call('GET', '/api/can/files')).data.logs?.find((l) => l.name === n)?.check;
    await waitFor(async () => (await check(badName))?.status === 'failed');
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(fs.existsSync(minuteFile('1700')), false, 'not indexed');
    assert.equal((await tags())['2026-11-08_12-00-00'], false, 'a failed log does not count');
    assert.equal((await s.call('POST', `/api/can/files/${badName}/use`, { use: true })).status, 200);
    await waitFor(async () => (await tags())['2026-11-08_12-00-00'] === true);
    assert.equal((await day()).canRecordings, 2);
    // no longer used: the tag goes with its data
    assert.equal((await s.call('POST', `/api/can/files/${badName}/use`, { use: false })).status, 200);
    assert.equal((await tags())['2026-11-08_12-00-00'], false, 'no longer used');

    // the log deleted: its recording has no CAN data any more
    assert.equal((await s.call('DELETE', `/api/can/files/${goodName}`)).status, 200);
    assert.equal((await tags())['2026-11-08_10-00-00'], false, 'a delete');
    assert.equal((await day()).canRecordings, 0);
    // uploaded again: back at once once indexed
    assert.equal((await s.put(token, goodName, good)).status, 201);
    assert.equal((await s.put(token, `${goodName}.json`, signed(goodName, good))).status, 201);
    await waitFor(async () => (await tags())['2026-11-08_10-00-00'] === true);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
