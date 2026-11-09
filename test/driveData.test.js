'use strict';

// Sentry USB's drive data (server/driveData.js): drive-data.json on the
// car's share read a route at a time, grouped into drives as Sentry USB and
// Sentry Studio group them (the gap rule, Park splits by gear runs), with the
// Autopilot / FSD share, distance, top speed, route and drive tags; read in
// the background, cached under the data folder until the file changes, the
// last good read kept when a read fails; the Drives API says which source it
// used and falls back to the clips.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const dd = require('../server/driveData');

const REPO = path.join(__dirname, '..');
const FR = 1800; // raw frames in a clip
const b64 = (arr) => Buffer.from(arr).toString('base64');

/** A clip key `minutes` after day hh:mm. */
const keyAt = (day, hh, mm, plus = 0) => {
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, hh, mm + plus)).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
};
/**
 * A route as Sentry USB exports it: n points going north from lat0 at v m/s
 * (one point a second when n is 61), the gear runs, autopilot states.
 */
function route(key, { lat0 = 41.9, lon = -87.7, v = 10, n = 61, ap = 0, gearRuns = [{ gear: 1, frames: FR }], base64 = true, pascal = false } = {}) {
  const dt = 60 / (n - 1);
  const points = Array.from({ length: n }, (_, i) => [lat0 + (i * v * dt) / 111195, lon]);
  const aps = Array.from({ length: n }, (_, i) => (typeof ap === 'function' ? ap(i, n) : ap));
  const gears = Array.from({ length: n }, () => 1);
  const r = {
    file: `${key.slice(0, 10)}/${key}-front.mp4`, date: key.slice(0, 10), points,
    gearStates: base64 ? b64(gears) : gears, autopilotStates: base64 ? b64(aps) : aps,
    speeds: points.map(() => v), accelPositions: points.map(() => 0),
    rawParkCount: gearRuns.filter((x) => x.gear === 0).reduce((s, x) => s + x.frames, 0), rawFrameCount: FR, gearRuns
  };
  if (!pascal) return r;
  return { File: r.file, Date: r.date, Points: r.points, GearStates: r.gearStates, AutopilotStates: r.autopilotStates, Speeds: r.speeds, GearRuns: r.gearRuns.map((g) => ({ Gear: g.gear, Frames: g.frames })) };
}
/** Routes into drives, as the reader and the API do. */
function drivesOf(routes, gapS) {
  return dd.groupDrives(dd.finishClips(routes.map(dd.reduceRoute).filter(Boolean)), { gapS });
}
const iso = (ms) => new Date(ms).toISOString().slice(0, 19);

test('drive data: the format, Go base64 []uint8 fields or arrays, camelCase or PascalCase', () => {
  assert.deepEqual(dd.bytesOf('AAEAAA=='), [0, 1, 0, 0], 'Go writes []uint8 as base64');
  assert.deepEqual(dd.bytesOf([0, 0, 0, 1]), [0, 0, 0, 1]);
  assert.deepEqual(dd.bytesOf('not base64!'), []);
  assert.deepEqual(dd.bytesOf(null), []);
  const k = keyAt('2026-10-01', 8, 0);
  const a = dd.reduceRoute(route(k, { ap: 1 }));
  const b = dd.reduceRoute(route(k, { ap: 1, base64: false }));
  const c = dd.reduceRoute(route(k, { ap: 1, pascal: true }));
  assert.equal(a.k, k);
  assert.deepEqual(a, b, 'base64 and arrays read the same');
  assert.deepEqual(a.segs, c.segs, 'PascalCase reads the same');
  assert.equal(a.segs.length, 1);
  assert.ok(Math.abs(a.segs[0].d - 600) < 2, `10 m/s for a minute: ${a.segs[0].d}`);
  assert.equal(a.segs[0].v, 10);
  assert.equal(a.segs[0].ap[0] > 590, true, 'FSD distance');
  // left out: events, dot folders, names without a clip time
  for (const file of ['SentryClips/2026-10-01_08-00-00/2026-10-01_08-00-00-front.mp4', 'SavedClips/x/2026-10-01_08-00-00-front.mp4', '.partial/2026-10-01_08-00-00-front.mp4', 'RecentClips/front.mp4']) {
    assert.equal(dd.reduceRoute({ ...route(k), file }), null, file);
  }
  assert.ok(dd.reduceRoute({ ...route(k), file: `RecentClips/${k}-front.mp4` }));
});

test('drive data: the streaming tokenizer reads routes one at a time, steps over everything else, in any chunk size', () => {
  const routes = [route(keyAt('2026-10-01', 8, 0)), { ...route(keyAt('2026-10-01', 8, 1)), source: 'a "quoted" }] value\\' }];
  const text = `﻿${JSON.stringify({ processedFiles: ['a', 'b]}'], routes, driveTags: { '2026-10-01T08:00:00.000': ['Work'] }, telemetrySamples: [{ t: 1, s: '{[' }], chargeCosts: { 1: { amount: 2 } }, x: null, y: 1.5 })}\n`;
  const buf = Buffer.from(text);
  for (const size of [1, 2, 3, 7, 64, 4096]) {
    const got = [];
    let tags = null;
    const s = new dd.StoreDataScanner({ onRoute: (r) => got.push(r), onTags: (t) => { tags = t; } });
    for (let i = 0; i < buf.length; i += size) s.push(buf.subarray(i, i + size));
    const out = s.end();
    assert.equal(out.routes, 2, `chunks of ${size}`);
    assert.deepEqual(got, routes);
    assert.deepEqual(tags, { '2026-10-01T08:00:00.000': ['Work'] });
    assert.deepEqual(out.keys, ['processedFiles', 'routes', 'driveTags', 'telemetrySamples', 'chargeCosts', 'x', 'y']);
  }
  // cut short, or not JSON: an error, never a half result taken as whole
  const cut = new dd.StoreDataScanner();
  cut.push(buf.subarray(0, buf.length - 30));
  assert.throws(() => cut.end(), /ends part way/);
  assert.throws(() => new dd.StoreDataScanner().push(Buffer.from('[1,2]')), /not a JSON object/);
  assert.throws(() => new dd.StoreDataScanner().push(Buffer.from('{"routes":[{"file":x}]}')), /not JSON/);
  // a route too big to keep is skipped, not held
  const big = new dd.StoreDataScanner({ maxRoute: 1000 });
  big.push(Buffer.from(JSON.stringify({ routes: [route(keyAt('2026-10-01', 8, 0)), { file: 'a' }] })));
  assert.deepEqual([big.end().routes, big.skipped], [1, 1]);
});

test('drive data: a clip starting more than the gap after the one before starts a new drive', () => {
  const D = '2026-10-01';
  const routes = [
    ...[0, 1, 2].map((m) => route(keyAt(D, 8, m))), // 08:00-08:03
    route(keyAt(D, 8, 7)), // 5 min after 08:02 started: same drive
    route(keyAt(D, 8, 13)), // 6 min after: a new drive
    route(keyAt(D, 23, 59)), route(keyAt(D, 23, 60)) // over midnight: one drive
  ];
  const out = drivesOf(routes);
  assert.deepEqual(out.map((d) => [iso(d.startMs), iso(d.endMs), d.routes]), [
    ['2026-10-01T23:59:00', '2026-10-02T00:01:00', 2],
    ['2026-10-01T08:13:00', '2026-10-01T08:14:00', 1],
    ['2026-10-01T08:00:00', '2026-10-01T08:08:00', 4]
  ], 'newest first');
  assert.equal(drivesOf(routes, 10 * 60).length, 2, 'a 10 minute gap joins the morning');
  assert.equal(drivesOf(routes, 2 * 60).length, 4, 'a 2 minute gap splits 08:02 from 08:07');
  // a clip that stopped early lasts until the next clip starts (Sentry USB's clip spans)
  const short = drivesOf([route(`${D}_09-00-00`), route(`${D}_09-00-40`)]);
  assert.equal(iso(short[0].endMs), '2026-10-01T09:01:40');
});

test('drive data: Park of 2 seconds or more splits a drive inside a clip; shorter Park does not', () => {
  const D = '2026-10-02';
  const park = (frames) => [{ gear: 1, frames: 600 }, { gear: 0, frames }, { gear: 1, frames: FR - 600 - frames }];
  const routes = [route(keyAt(D, 10, 0)), route(keyAt(D, 10, 1), { gearRuns: park(600) }), route(keyAt(D, 10, 2))];
  const out = drivesOf(routes);
  assert.equal(out.length, 2);
  // the first ends when Park starts (20 s into 10:01), the next starts when it ends (40 s in)
  assert.deepEqual(out.map((d) => [iso(d.startMs), iso(d.endMs)]), [['2026-10-02T10:01:40', '2026-10-02T10:03:00'], ['2026-10-02T10:00:00', '2026-10-02T10:01:20']]);
  assert.equal(out[0].tagKey, '2026-10-02T10:01:40.000', 'Sentry USB\'s drive tag key: the start to the millisecond');
  assert.equal(drivesOf([route(keyAt(D, 10, 0)), route(keyAt(D, 10, 1), { gearRuns: park(30) }), route(keyAt(D, 10, 2))]).length, 1, '1 s of Park: one drive');
  // a clip all in Park at the end is not driving
  const tail = drivesOf([route(keyAt(D, 11, 0)), route(keyAt(D, 11, 1), { gearRuns: [{ gear: 0, frames: FR }] })]);
  assert.deepEqual(tail.map((d) => [iso(d.startMs), iso(d.endMs), d.routes]), [['2026-10-02T11:00:00', '2026-10-02T11:01:00', 1]]);
  // legacy files without gear runs: a clip mostly in Park is the boundary
  const legacy = (k, parked) => ({ ...route(k), gearRuns: undefined, rawParkCount: parked ? 1500 : 0 });
  assert.equal(drivesOf([legacy(keyAt(D, 12, 0)), legacy(keyAt(D, 12, 1), true), legacy(keyAt(D, 12, 2))]).length, 2);
});

test('drive data: Autopilot and FSD shares by distance, distance, top speed, the route and tags', () => {
  const D = '2026-10-03';
  // three minutes: manual, FSD, half Autosteer half TACC (by points)
  const routes = [
    route(keyAt(D, 7, 0), { v: 10, lat0: 41.9 }),
    route(keyAt(D, 7, 1), { v: 20, lat0: 41.9 + 600 / 111195, ap: 1 }),
    route(keyAt(D, 7, 2), { v: 10, lat0: 41.9 + 1800 / 111195, ap: (i, n) => (i < n / 2 ? 2 : 3) })
  ];
  const [d] = drivesOf(routes);
  assert.ok(Math.abs(d.distance - 2400) < 5, `distance ${d.distance}`);
  assert.equal(d.top, 20);
  const ap = d.autopilot;
  assert.ok(Math.abs(ap.fsd - 50) < 0.6, `FSD ${ap.fsd}`);
  assert.ok(Math.abs(ap.autosteer + ap.tacc - 25) < 0.6, `Autosteer + TACC ${ap.autosteer} + ${ap.tacc}`);
  assert.ok(Math.abs(ap.percent - 75) < 0.6, `assisted ${ap.percent}`);
  assert.ok(Math.abs(ap.fsdSeconds - 60) <= 1);
  assert.ok(d.route.length > 2 && d.route.length <= 96);
  assert.deepEqual(d.from, [41.9, -87.7]);
  assert.equal(drivesOf([route(keyAt(D, 9, 0), { ap: 0 })])[0].autopilot.percent, 0);
  // tags: by Sentry USB's key, the same second, or Studio's clip name
  const tags = dd.tagIndex({ '2026-10-03T07:00:00.000': ['Work', 'Work', ''], [keyAt(D, 9, 0)]: ['Gym'], junk: 'x' });
  assert.deepEqual(dd.tagsOf(tags, d), ['Work']);
  assert.deepEqual(dd.tagsOf(tags, drivesOf([route(keyAt(D, 9, 0))])[0]), ['Gym']);
  // described for the API: the Viewer opens the clip the drive starts in, when it is here
  const clip = { key: keyAt(D, 7, 0), t: Date.UTC(2026, 9, 3, 7) / 1000, day: D, rec: { id: 'r1', day: D } };
  const api = dd.describeDrive(d, { tags, clipOf: (k) => (k === clip.key ? clip : null), statsOf: () => ({ b: 1, t: 0 }) });
  assert.deepEqual([api.id, api.start, api.end, api.seconds, api.clips, api.footage, api.hardBrakes, api.tags], [`${D}_07-00-00`, `${D} 07:00:00`, `${D} 07:03:00`, 180, 3, 1, 1, ['Work']]);
  assert.deepEqual(api.open, { recording: 'r1', day: D, clip: clip.key, second: 0 });
  assert.equal(dd.describeDrive(d, {}).open, null, 'no footage here: nothing to open');
});

/** A drive-data.json of `count` clips (a drive an hour of `per` clips) with a big telemetry section. */
async function writeStore(file, { count = 30, per = 10, telemetry = 0, routeOpts = {}, tags = {} } = {}) {
  const fh = await fsp.open(file, 'w');
  await fh.write('{"processedFiles":[],"routes":[');
  for (let i = 0; i < count; i++) {
    const hour = Math.floor(i / per);
    await fh.write((i ? ',' : '') + JSON.stringify(route(keyAt('2026-09-01', 6 + hour, i % per), { n: 600, ...routeOpts })));
  }
  await fh.write('],"driveTags":' + JSON.stringify(tags) + ',"telemetrySamples":[');
  const row = JSON.stringify({ ts: 1790000000, batteryPct: 80.5, interiorTemp: 21.5, exteriorTemp: 12.5, odometer: 12345.6 });
  for (let i = 0; i < telemetry; i += 1000) await fh.write((i ? ',' : '') + Array(Math.min(1000, telemetry - i)).fill(row).join(','));
  await fh.write(']}');
  await fh.close();
}

test('drive data: a large file is read in chunks with bounded memory', { timeout: 120000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-drivedata-big-'));
  try {
    const file = path.join(dir, 'drive-data.json');
    await writeStore(file, { count: 1500, per: 30, telemetry: 250000 });
    const size = (await fsp.stat(file)).size;
    assert.ok(size > 40e6, `a big file: ${size}`);
    const base = process.memoryUsage().heapUsed;
    let peak = 0;
    let routes = 0;
    const kept = [];
    const out = await dd.readStoreData(file, {
      chunk: 256 * 1024,
      onRoute: (r) => { routes++; const c = dd.reduceRoute(r); if (c) kept.push(c); },
      pause: () => { peak = Math.max(peak, process.memoryUsage().heapUsed - base); }
    });
    assert.equal(out.routes, 1500);
    assert.equal(routes, 1500);
    assert.ok(peak < size / 2, `heap grew ${Math.round(peak / 1e6)} MB reading ${Math.round(size / 1e6)} MB`);
    assert.ok(JSON.stringify(kept).length < size / 20, 'what is kept is a small part of the file');
    assert.equal(dd.groupDrives(dd.finishClips(kept)).length, 50);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

test('drive data: read in the background, cached on disk, read again only when it changes, the last good read kept', { timeout: 60000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-drivedata-'));
  const root = path.join(dir, 'footage');
  const tesla = path.join(root, 'TeslaCam');
  await fsp.mkdir(path.join(tesla, 'RecentClips'), { recursive: true });
  const v = { id: 'car', name: 'Car' };
  const vehicles = { list: () => [v], get: (id) => (id === 'car' ? v : null), rootOf: () => root, studioRoot: () => tesla };
  const logs = [];
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m) };
  const make = () => dd.createDriveData({ dir: path.join(dir, 'data'), vehicles, log, stableMs: 0, checkMs: 0, pauseMs: 0 });
  const file = path.join(tesla, 'drive-data.json');
  const past = (s) => fsp.utimes(file, new Date(Date.now() - s * 1000), new Date(Date.now() - s * 1000));
  const reads = () => logs.filter((m) => / read in /.test(m)).length;
  try {
    let a = make();
    await a.check('car');
    assert.deepEqual([a.view('car').usable, a.view('car').meta], [false, null], 'no file: no drive data');

    await writeStore(file, { count: 20, per: 10, tags: { '2026-09-01T06:00:00.000': ['Work'] } });
    await past(120);
    await a.check('car');
    await a.settled();
    assert.equal(a.view('car').usable, true);
    assert.equal(a.drives('car').length, 2);
    assert.deepEqual(a.view('car').meta.routes, 20);
    assert.deepEqual(dd.tagsOf(a.tags('car'), a.drives('car')[1]), ['Work']);
    assert.equal(reads(), 1);
    assert.ok(fs.existsSync(path.join(dir, 'data', 'car.json')), 'cached under the data folder');
    await a.check('car');
    await a.settled();
    assert.equal(reads(), 1, 'unchanged: not read again');
    a.stop();

    // a restart: the cache is used, the file not read again
    a = make();
    await a.check('car');
    await a.settled();
    assert.deepEqual([a.drives('car').length, reads()], [2, 1]);

    // rsync cut short (or mid-write): the last good read stays, the error is said
    const whole = await fsp.readFile(file);
    await fsp.writeFile(file, whole.subarray(0, Math.floor(whole.length * 0.6)));
    await past(60);
    await a.check('car');
    await a.settled();
    assert.equal(a.drives('car').length, 2, 'the last good read is kept');
    assert.match(a.view('car').meta.error, /ends part way/);
    assert.equal(a.view('car').usable, true);

    // a changed file is read again
    await writeStore(file, { count: 30, per: 10 });
    await past(30);
    await a.check('car');
    await a.settled();
    assert.deepEqual([a.drives('car').length, reads(), a.view('car').meta.error], [3, 2, null]);

    // a file changed a moment ago is left to settle
    const b = dd.createDriveData({ dir: path.join(dir, 'data2'), vehicles, log, stableMs: 60_000, checkMs: 0 });
    await b.check('car');
    await b.settled();
    await writeStore(file, { count: 40, per: 10 });
    await b.check('car');
    assert.equal(b.view('car').usable, false, 'just written: not read yet');
    b.stop();

    // a symlink is not followed; a missing file falls back
    await fsp.rm(file);
    await a.check('car');
    assert.equal(a.view('car').usable, false, 'gone: the clips again');
    await fsp.symlink(path.join(dir, 'elsewhere.json'), file);
    await a.check('car');
    assert.equal(a.view('car').usable, false);
    a.stop();
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test('drives API: from Sentry USB\'s drive data when the share has it, else from the clips, and says which', { timeout: 120000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-drivedata-api-'));
  const root = path.join(dir, 'footage');
  const recent = path.join(root, 'TeslaCam', 'RecentClips');
  await fsp.mkdir(recent, { recursive: true });
  const DAY = '2026-10-05';
  for (const m of [0, 1, 2]) for (const cam of ['front', 'back']) await fsp.writeFile(path.join(recent, `${keyAt(DAY, 8, m)}-${cam}.mp4`), crypto.randomBytes(2048));
  const data = path.join(dir, 'data');
  await fsp.mkdir(data, { recursive: true });
  const port = await freePort();
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: data, FOOTAGE_PATH: root,
    VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: 'correct horse', TZ: 'UTC',
    SENTRY_NOREPLACE_RENAME: path.join(REPO, 'build', 'noreplace-rename'), LOG_LEVEL: 'warn', TLS_MODE: 'off', UPDATE_CHECK: 'off'
  };
  let child = null;
  let output = '';
  const base = `http://127.0.0.1:${port}`;
  const start = async () => {
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(REPO, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    await until(async () => { try { return (await fetch(`${base}/healthz`)).ok; } catch { return false; } }, 20000);
  };
  const stop = () => new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
  let cookie = '';
  const api = async (method, p, body) => {
    const res = await fetch(base + p, {
      method, headers: { 'X-Requested-With': 'sentry-six-manager', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  try {
    await start();
    assert.equal((await api('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 200);
    await until(async () => (await api('GET', '/api/vehicles/daily-driver/recordings')).data.total >= 1);
    // no drive-data.json: the clips, and it says so
    let res = await api('GET', '/api/vehicles/daily-driver/drives');
    assert.equal(res.status, 200);
    assert.deepEqual([res.data.source, res.data.driveData, res.data.drives.length], ['clips', null, 1]);
    await stop();

    // Sentry USB's file at the share root: its drives (one here, one whose clips are gone), Park splitting the first
    const file = path.join(root, 'TeslaCam', 'drive-data.json');
    const routes = [
      route(keyAt(DAY, 8, 0), { ap: 1 }), route(keyAt(DAY, 8, 1), { gearRuns: [{ gear: 1, frames: 600 }, { gear: 0, frames: 600 }, { gear: 1, frames: 600 }] }), route(keyAt(DAY, 8, 2)),
      route(keyAt('2026-10-04', 17, 0), { ap: 2 }), route(keyAt('2026-10-04', 17, 1), { ap: 2 })
    ];
    await fsp.writeFile(file, JSON.stringify({ processedFiles: [], routes, driveTags: { [`${DAY}T08:00:00.000`]: ['Commute'] } }));
    const t = new Date(Date.now() - 600_000);
    await fsp.utimes(file, t, t);
    await start();
    assert.equal((await api('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 200);
    await until(async () => (await api('GET', '/api/vehicles/daily-driver/recordings')).data.total >= 1);
    res = await until(async () => { const r = await api('GET', '/api/vehicles/daily-driver/drives'); return r.data?.source === 'sentry-usb' ? r : null; });
    const list = res.data.drives;
    assert.deepEqual(list.map((d) => [d.start, d.end, d.clips]), [
      [`${DAY} 08:01:40`, `${DAY} 08:03:00`, 2], [`${DAY} 08:00:00`, `${DAY} 08:01:20`, 2], ['2026-10-04 17:00:00', '2026-10-04 17:02:00', 2]
    ]);
    assert.equal(res.data.driveData.file, 'TeslaCam/drive-data.json');
    assert.ok(Math.abs(res.data.driveData.updatedAt - t.getTime()) < 1000);
    assert.equal(res.data.driveData.routes, 5);
    const [later, first, old] = list;
    assert.deepEqual(first.tags, ['Commute']);
    assert.ok(first.autopilot.fsd > 30 && first.autopilot.autosteer === 0);
    assert.equal(old.autopilot.autosteer, 100);
    assert.deepEqual(first.open, { recording: first.open.recording, day: DAY, clip: keyAt(DAY, 8, 0), second: 0 });
    assert.deepEqual([later.open.clip, later.open.second], [keyAt(DAY, 8, 1), 40]);
    assert.equal(old.open, null, 'its clips are not here');
    assert.ok(first.route.length >= 2 && first.distance > 600);
    // a page at a time
    const one = (await api('GET', '/api/vehicles/daily-driver/drives?limit=1')).data;
    assert.deepEqual([one.drives.length, one.more, one.next], [1, true, `${DAY}_08-01-40`]);
    const two = (await api('GET', `/api/vehicles/daily-driver/drives?limit=2&before=${one.next}`)).data;
    assert.deepEqual([two.drives.map((d) => d.id), two.more], [[`${DAY}_08-00-00`, '2026-10-04_17-00-00'], false]);
    // nothing was written to the share
    assert.deepEqual((await fsp.readdir(path.join(root, 'TeslaCam'))).sort(), ['RecentClips', 'drive-data.json']);
  } catch (err) {
    console.error(output);
    throw err;
  } finally {
    await stop();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('Drives page: says where the drives come from, shows Autopilot / FSD and tags, no sideways scroll on a phone', () => {
  const src = fs.readFileSync(path.join(REPO, 'web', 'drives.js'), 'utf8');
  assert.match(src, /From Sentry USB's drive data/);
  assert.match(src, /From your clips/);
  assert.match(src, /FSD \$\{/);
  assert.match(src, /Autopilot \$\{/);
  assert.match(src, /sv-chip tag/);
  assert.match(src, /if \(d\?\.open\) open\(d\.open, d\)/, 'a drive without footage here does not open the Viewer');
  assert.match(src, /@media \(max-width:520px\)/);
});
