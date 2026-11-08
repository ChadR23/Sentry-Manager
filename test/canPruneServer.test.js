'use strict';

// CAN logs live and die with their footage, through the real server: a log
// uploaded, indexed and paired with its clip stays while the clip is in the
// Recycle Bin, and goes with it when the bin is emptied, the same way as a
// delete in the Nerd settings (the file and its sidecar, its minutes in the
// index, its trust record kept as deleted). The setting is on by default and
// shown with each log's pairing.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const SERVER = path.join(REPO, 'server', 'index.js');
const COLUMNS = path.join(__dirname, 'fixtures', 'columns-sample.log.xz');
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

/** Another browser on the same server (its own cookie). */
async function startClient(s) {
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(s.base + p, {
      method,
      headers: { ...s.https, 'X-Requested-With': 'sentry-six-manager', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  return { call };
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

test('emptying the Recycle Bin deletes the paired CAN log through the server: file, index, trust record; the bin alone keeps it', { skip, timeout: 120000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-canprune-'));
  const recent = path.join(dir, 'footage', 'TeslaCam', 'RecentClips');
  await fsp.mkdir(recent, { recursive: true });
  // the log's minute (00:58 UTC), and later footage that stays
  for (const c of ['2026-11-08_00-58-00', '2026-11-08_02-00-00']) await fsp.writeFile(path.join(recent, `${c}-front.mp4`), 'x');
  const s = await startServer(dir);
  const put = (token, name, body) => fetch(`${s.base}/api/can/logs/${encodeURIComponent(name)}`, {
    method: 'POST', body,
    headers: { ...s.https, Authorization: `Bearer ${token}`, 'Upload-Offset': '0', 'Upload-Length': String(body.length), 'Upload-SHA256': crypto.createHash('sha256').update(body).digest('hex') }
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    await s.call('POST', '/api/auth/confirm', { password: 'correct horse' });
    const token = (await s.call('POST', '/api/can/enable', {})).data.token;
    const vid = (await s.call('GET', '/api/vehicles')).data.vehicles[0].id;
    const key = 'PAIR-car';
    const name = `${key}_20261108T005818Z_1.log.xz`;
    assert.equal((await put(token, name, fs.readFileSync(COLUMNS))).status, 201);
    assert.equal((await put(token, `${name}.json`, Buffer.from(JSON.stringify({ format: 'canbridge-columns-xz/2', frames: 10_847 })))).status, 201);
    assert.equal((await s.call('POST', '/api/can/vehicle-map', { key, vehicleId: vid })).status, 200);
    const minute = path.join(dir, 'data', 'can-index', key, '20261108T0058.json.gz');
    await waitFor(async () => fs.existsSync(minute));

    // on by default, and the log is paired with its clip
    const st = (await s.call('GET', '/api/can/settings')).data;
    assert.equal(st.keep.withFootage, true);
    const listed = async () => (await s.call('GET', '/api/can/files')).data.logs.find((l) => l.name === name);
    await waitFor(async () => (await listed())?.footage === 'paired');

    // its clip to the Recycle Bin: the log stays
    const recs = (await s.call('GET', `/api/vehicles/${vid}/recordings?limit=500`)).data.recordings;
    const rec = recs.find((r) => r.startKey === '2026-11-08_00-58-00');
    assert.ok(rec, JSON.stringify(recs.map((r) => r.startKey)));
    assert.equal((await s.call('POST', `/api/vehicles/${vid}/trash`, { ids: [rec.id] })).status, 200);
    await waitFor(async () => (await s.call('GET', '/api/bin')).data.items.length === 1);
    assert.equal((await listed())?.footage, 'paired', 'footage in the bin still pairs');

    // the bin emptied: the log goes with it, as a delete in the Nerd settings
    assert.equal((await s.call('POST', '/api/bin/empty', { confirm: true })).status, 200);
    const logFile = path.join(dir, 'data', 'can', key, name);
    await waitFor(async () => !fs.existsSync(logFile), 20000);
    assert.equal(fs.existsSync(`${logFile}.json`), false, 'and its sidecar');
    await waitFor(async () => !fs.existsSync(minute), 10000);
    const trust = JSON.parse(await fsp.readFile(path.join(dir, 'data', 'can', key, 'trust.json'), 'utf8'));
    assert.equal(trust.logs[name].deleted, true, 'its trust record is kept, marked deleted');
    assert.equal(await listed(), undefined);
    const after = (await s.call('GET', '/api/can/settings')).data.keep.cars[vid];
    assert.equal(after.removed, 1);
    assert.equal(after.footage, 1);
    // and it can be turned off (with the password, as the other CAN changes)
    assert.equal((await s.call('POST', '/api/can/keep', { withFootage: false })).data.withFootage, false);
    assert.equal(s.output().includes('TypeError'), false);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('"Also delete its CAN data": Move to trash and Delete through this date take the car\'s logs with them; counted first; watch-only accounts may not; the keep settings checked', { skip, timeout: 120000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-canwith-'));
  const recent = path.join(dir, 'footage', 'TeslaCam', 'RecentClips');
  await fsp.mkdir(recent, { recursive: true });
  // TZ is UTC: a clip's name is its UTC minute
  for (const c of ['2026-11-06_10-00-00', '2026-11-07_10-00-00', '2026-11-08_00-58-00', '2026-11-08_02-00-00']) await fsp.writeFile(path.join(recent, `${c}-front.mp4`), 'x');
  const s = await startServer(dir);
  const body = fs.readFileSync(COLUMNS);
  const put = (token, name, data) => fetch(`${s.base}/api/can/logs/${encodeURIComponent(name)}`, {
    method: 'POST', body: data,
    headers: { ...s.https, Authorization: `Bearer ${token}`, 'Upload-Offset': '0', 'Upload-Length': String(data.length), 'Upload-SHA256': crypto.createHash('sha256').update(data).digest('hex') }
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  try {
    await s.call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' });
    await s.call('POST', '/api/auth/confirm', { password: 'correct horse' });
    const token = (await s.call('POST', '/api/can/enable', {})).data.token;
    const vid = (await s.call('GET', '/api/vehicles')).data.vehicles[0].id;
    const key = 'WITH-car';
    const names = { d6: `${key}_20261106T100018Z_1.log.xz`, d7: `${key}_20261107T100018Z_1.log.xz`, gap: `${key}_20261107T150018Z_1.log.xz`, m: `${key}_20261108T005818Z_1.log.xz`, later: `${key}_20261108T020018Z_1.log.xz` };
    for (const n of Object.values(names)) {
      assert.equal((await put(token, n, body)).status, 201, n);
      assert.equal((await put(token, `${n}.json`, Buffer.from(JSON.stringify({ format: 'canbridge-columns-xz/2', frames: 10_847 })))).status, 201);
    }
    const file = (n) => path.join(dir, 'data', 'can', key, n);
    const recs = (await s.call('GET', `/api/vehicles/${vid}/recordings?limit=500`)).data.recordings;
    const rec = (k) => recs.find((r) => r.startKey === k);
    // no key mapped to the car: nothing to offer (the token's car maps it; taken off here)
    assert.equal((await s.call('POST', '/api/can/vehicle-map', { key, vehicleId: null })).status, 200);
    assert.equal((await s.call('POST', `/api/vehicles/${vid}/trash-preview`, { ids: [rec('2026-11-08_00-58-00').id] })).data.can, null);
    assert.equal((await s.call('POST', `/api/vehicles/${vid}/trash-days`, { day: '2026-11-07', through: true, preview: true })).data.can, null);
    assert.equal((await s.call('POST', '/api/can/vehicle-map', { key, vehicleId: vid })).status, 200);
    // the logs are judged (an unsigned bridge) before they may go
    await waitFor(async () => (await s.call('GET', '/api/can/files')).data.logs?.filter((l) => l.key === key || l.vehicleKey === key).length === 5 && (await s.call('GET', '/api/can/files')).data.logs.every((l) => l.footage));

    // a watch-only account may not delete footage, nor count what would go with it
    assert.equal((await s.call('POST', '/api/accounts', { username: 'kid', password: 'watching only', role: 'viewer' })).status, 200);
    const admin = s.call;
    const kid = (await startClient(s)).call;
    assert.equal((await kid('POST', '/api/auth/login', { username: 'kid', password: 'watching only' })).status, 200);
    for (const [p, b] of [['trash', { ids: [rec('2026-11-08_00-58-00').id], withCan: true }], ['trash-days', { day: '2026-11-07', through: true, withCan: true }], ['trash-preview', { ids: [rec('2026-11-08_00-58-00').id] }]]) {
      assert.equal((await kid('POST', `/api/vehicles/${vid}/${p}`, b)).status, 403, p);
    }
    assert.ok(fs.existsSync(file(names.m)));

    // Move to trash with its CAN data: counted first, then deleted now; the other logs stay
    const one = rec('2026-11-08_00-58-00');
    assert.deepEqual((await admin('POST', `/api/vehicles/${vid}/trash-preview`, { ids: [one.id] })).data.can, { logs: 1, kept: 0 });
    const out = (await admin('POST', `/api/vehicles/${vid}/trash`, { ids: [one.id], withCan: true })).data;
    assert.deepEqual(out.moved, [one.id]);
    assert.deepEqual(out.can, { removed: 1, kept: 0, pending: 0 });
    assert.ok(!fs.existsSync(file(names.m)) && fs.existsSync(file(names.later)) && fs.existsSync(file(names.d7)));
    // a restore does not bring it back
    const item = (await admin('GET', '/api/bin')).data.items[0];
    assert.equal((await admin('POST', `/api/bin/${item.id}/restore`, {})).status, 200);
    assert.ok(!fs.existsSync(file(names.m)));

    // without the box: the footage moves, its logs stay
    const plain = rec('2026-11-06_10-00-00');
    assert.deepEqual((await admin('POST', `/api/vehicles/${vid}/trash`, { ids: [plain.id] })).data.moved, [plain.id]);
    assert.ok(fs.existsSync(file(names.d6)));
    assert.equal((await admin('POST', `/api/bin/${(await admin('GET', '/api/bin')).data.items.find((i) => i.category === 'Recent').id}/restore`, {})).status, 200);

    // Delete this day (the 7th, no "through"): only the minutes of its recordings, not the gap of that day
    await waitFor(async () => (await admin('GET', `/api/vehicles/${vid}/recordings?limit=500`)).data.recordings.length === 4);
    const day = (await admin('POST', `/api/vehicles/${vid}/trash-days`, { day: '2026-11-07', preview: true })).data;
    assert.deepEqual([day.recordings, day.can], [1, { logs: 1, kept: 0 }]);
    // Delete through this date (the 7th): the 6th and 7th, the gap too; the 8th stays
    const thru = (await admin('POST', `/api/vehicles/${vid}/trash-days`, { day: '2026-11-07', through: true, preview: true })).data;
    assert.deepEqual([thru.recordings, thru.can], [2, { logs: 3, kept: 0 }]);
    assert.equal((await admin('POST', `/api/vehicles/${vid}/trash-days`, { day: '2026-11-07', through: true, withCan: true })).data.started, true);
    await waitFor(async () => !fs.existsSync(file(names.d6)) && !fs.existsSync(file(names.d7)) && !fs.existsSync(file(names.gap)), 20000);
    assert.ok(fs.existsSync(file(names.later)), 'the 8th stays');

    // the keep settings: each alone, days 1-365, anything else refused
    for (const bad of [{}, { unlinkedDays: 0 }, { unlinkedDays: 366 }, { unlinkedDays: 2.5 }, { unlinkedDays: '7' }, { deleteUnlinked: 'yes' }, { deleteUnlinked: true, unlinkedDays: -1 }]) {
      assert.equal((await admin('POST', '/api/can/keep', bad)).status, 400, JSON.stringify(bad));
    }
    const kept = (await admin('POST', '/api/can/keep', { deleteUnlinked: false, unlinkedDays: 14 })).data;
    assert.deepEqual([kept.withFootage, kept.deleteUnlinked, kept.unlinkedDays], [true, false, 14]);
    assert.equal((await admin('GET', '/api/can/settings')).data.keep.unlinkedDays, 14);
    assert.equal((await kid('POST', '/api/can/keep', { deleteUnlinked: true })).status, 403, 'watch-only: no');
    assert.equal(s.output().includes('TypeError'), false);
  } finally {
    await s.stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
