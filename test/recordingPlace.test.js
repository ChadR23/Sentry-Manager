'use strict';

// The Footage page's place tag for every recording, not only Sentry and Saved
// events: where a recording started and ended, from CAN Bridge GPS (good fixes
// only) over the cameras' GPS (the speed index) over an event's event.json.
// Parked at a saved place: place; Home to Work: from and to; no GPS: no tag.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const fmt = require('../server/canFormat');
const { FORMAT, createCanIndex } = require('../server/canIndex');
const { PAGES, candump, gps04F } = require('./canModelY');
const { fixesOf, frontClips, CAN_FIX_MAX_M } = require('../server/recordingPlace');

const REPO = path.join(__dirname, '..');
const HOME = { lat: 41.8781, lon: -87.6298 };
const WORK = { lat: 41.9, lon: -87.7 };
const DAY = '2026-10-05';

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

/** A CAN index minute (as canIndex.js writes it) with a GPS fix every second at `at`, of `acc` metres. */
function gpsMinute(t, at, acc) {
  const ms = Array.from({ length: 60 }, (_, i) => i * 1000 + 250);
  const minute = new Date(t).toISOString().slice(0, 16).replace(/[-:]/g, '');
  return fmt.packMinute({
    minute, trust: 'unsigned', logs: { 'K_x_1.log.xz': { fmt: FORMAT, span: [0, 59_999], ids: { 'can1:04F': 60 } } },
    signals: { GPSLatitude04F: ms.map((m) => [m, at.lat]), GPSLongitude04F: ms.map((m) => [m, at.lon]), GPSAccuracy04F: ms.map((m) => [m, acc]) },
    ids: { 'can1:04F': 60 }
  }).then((body) => [minute, body]);
}

test('fixesOf: lat, lon and accuracy of the same frame paired; poor, zero and missing ones left out', () => {
  const t = Date.UTC(2026, 9, 5, 11, 0);
  const sig = {
    GPSLatitude04F: [[0, 41.9], [1000, 41.9], [2000, 0], [3000, 41.9], [4000, 41.9]],
    GPSLongitude04F: [[0, -87.7], [1000, -87.7], [2000, 0], [3000, -87.7], [4000, -87.7]],
    GPSAccuracy04F: [[0, 2.4], [1000, CAN_FIX_MAX_M + 0.2], [2000, 1], [3000, CAN_FIX_MAX_M], [4400, 3]]
  };
  assert.deepEqual(fixesOf(sig, t), [[t, 41.9, -87.7, 2.4], [t + 3000, 41.9, -87.7, CAN_FIX_MAX_M], [t + 4000, 41.9, -87.7, 3]],
    'too inaccurate (15.2 m) and 0, 0 are not fixes; an accuracy 400 ms off is the same frame\'s');
  assert.deepEqual(fixesOf({ GPSLatitude04F: [[0, 41.9]], GPSLongitude04F: [[0, -87.7]] }, t), [], 'no accuracy: not known to be good');
  assert.deepEqual(fixesOf(undefined, t), []);
  // a longitude that stayed the same has no point of its own (the index keeps one a second): its last one holds
  assert.deepEqual(fixesOf({ GPSLatitude04F: [[0, 41.9], [700, 41.91]], GPSLongitude04F: [[0, -87.7]], GPSAccuracy04F: [[0, 2], [700, 2]] }, t),
    [[t, 41.9, -87.7, 2], [t + 700, 41.91, -87.7, 2]]);
  assert.deepEqual(fixesOf({ GPSLatitude04F: [[5000, 41.9]], GPSLongitude04F: [[0, -87.7]], GPSAccuracy04F: [[5000, 2]] }, t), [], 'not one from long before');
  assert.deepEqual(frontClips({ clipRels: ['R/2026-10-05_11-01-00-back.mp4', 'R/2026-10-05_11-01-00-front.mp4', 'R/2026-10-05_11-00-00-front.mp4'] }, new Map()).map((c) => c.stamp),
    ['2026-10-05_11-00-00', '2026-10-05_11-01-00']);
});

test('Footage: Recent recordings get place (parked), from and to (Home to Work); the car\'s own GPS first, CAN Bridge GPS only where it has none; drives prefer CAN', { timeout: 120000, skip: spawnSync('xz', ['--version']).status !== 0 && 'needs xz' }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-recplace-'));
  const root = path.join(dir, 'footage');
  const recent = path.join(root, 'TeslaCam', 'RecentClips');
  await fsp.mkdir(recent, { recursive: true });
  const speeds = {};
  const moving = Array.from({ length: 60 }, () => 12);
  const parked = Array.from({ length: 60 }, () => 0);
  // a clip (front and back); g: its positions [second, lat, lon]; indexed: false leaves it out of the speed index
  const clip = async (key, sp, g, indexed = true) => {
    for (const cam of ['front', 'back']) await fsp.writeFile(path.join(recent, `${key}-${cam}.mp4`), crypto.randomBytes(2048));
    const st = await fsp.stat(path.join(recent, `${key}-front.mp4`));
    // sp null: read, with no telemetry at all (the car writes none while parked)
    if (indexed) speeds[`TeslaCam/RecentClips/${key}-front.mp4`] = sp === null ? [st.size, Math.round(st.mtimeMs), null, null] : [st.size, Math.round(st.mtimeMs), sp, { b: null, t: null, v: [0, Math.max(...sp)], g, k: 2 }];
  };
  const at = (p, s = 0) => [s, p.lat, p.lon];
  // 07:00-07:02 a drive from Home to Work (the cameras' GPS)
  await clip(`${DAY}_07-00-00`, moving, [at(HOME), at(HOME, 55)]);
  await clip(`${DAY}_07-01-00`, moving, [at(HOME, 0), at(WORK, 50)]);
  await clip(`${DAY}_07-02-00`, parked, [at(WORK), at(WORK, 55)]);
  // 09:00-09:02 parked at Work (the first clip with no GPS yet: the next one inward)
  await clip(`${DAY}_09-00-00`, parked, []);
  await clip(`${DAY}_09-01-00`, parked, [at(WORK)]);
  await clip(`${DAY}_09-02-00`, parked, [at(WORK, 30)]);
  // 11:00-11:01 the cameras say Home, CAN Bridge GPS (3 m) says Work
  await clip(`${DAY}_11-00-00`, moving, [at(HOME)]);
  await clip(`${DAY}_11-01-00`, moving, [at(HOME, 55)]);
  // 13:00-13:01 the cameras say Home, CAN Bridge GPS says Work but only to 20 m: not used
  await clip(`${DAY}_13-00-00`, parked, [at(HOME)]);
  await clip(`${DAY}_13-01-00`, parked, [at(HOME, 55)]);
  // 23:00-23:01 the cameras say Home, the Model Y's CAN Bridge log (its position on can3 only) says Work, 2.4 m;
  // 23:30 the cameras say Home, the log has the car's own garage frame (25 m: not used)
  await clip(`${DAY}_23-00-00`, moving, [at(HOME)]);
  await clip(`${DAY}_23-01-00`, moving, [at(HOME, 55)]);
  await clip(`${DAY}_23-30-00`, parked, [at(HOME), at(HOME, 55)]);
  // 20:00-20:02 parked (no telemetry), a drive from Work to Home, parked again: the parked clips are passed over
  await clip(`${DAY}_20-00-00`, null, null);
  await clip(`${DAY}_20-01-00`, moving, [at(WORK), at(HOME, 55)]);
  await clip(`${DAY}_20-02-00`, null, null);
  // 21:00 parked all through, no telemetry at all: where the car was last seen (Home, at 20:01)
  await clip(`${DAY}_21-00-00`, null, null);
  // 15:00 no GPS at all; 17:00 not read by the speed index yet
  await clip(`${DAY}_15-00-00`, parked, []);
  await clip(`${DAY}_17-00-00`, parked, [at(WORK)], false);
  // a Sentry event at 19:30: event.json says Home, CAN Bridge GPS at that time says Work
  const ev = path.join(root, 'TeslaCam', 'SentryClips', `${DAY}_19-30-00`);
  await fsp.mkdir(ev, { recursive: true });
  await fsp.writeFile(path.join(ev, `${DAY}_19-29-00-front.mp4`), crypto.randomBytes(2048));
  await fsp.writeFile(path.join(ev, 'event.json'), JSON.stringify({ timestamp: `${DAY}T19:30:00`, city: 'Chicago', est_lat: String(HOME.lat), est_lon: String(HOME.lon), reason: 'sentry_aware_object_detection' }));
  // and one at 21:30 with event.json only (no CAN data then)
  const ev2 = path.join(root, 'TeslaCam', 'SentryClips', `${DAY}_21-30-00`);
  await fsp.mkdir(ev2, { recursive: true });
  await fsp.writeFile(path.join(ev2, `${DAY}_21-29-00-front.mp4`), crypto.randomBytes(2048));
  await fsp.writeFile(path.join(ev2, 'event.json'), JSON.stringify({ timestamp: `${DAY}T21:30:00`, est_lat: String(HOME.lat), est_lon: String(HOME.lon), reason: 'sentry_aware_object_detection' }));

  const data = path.join(dir, 'data');
  await fsp.mkdir(path.join(data, 'speeds', 'daily-driver'), { recursive: true });
  await fsp.writeFile(path.join(data, 'speeds', 'daily-driver', `${DAY}.json`), JSON.stringify(speeds));
  // the CAN index (one key, the only car's): good fixes at Work 11:00-11:01 and 19:29-19:30, poor ones 13:00-13:01
  const keyDir = path.join(data, 'can-index', 'K');
  await fsp.mkdir(keyDir, { recursive: true });
  const minutes = [[11, 0, WORK, 3], [11, 1, WORK, 3], [13, 0, WORK, 20], [13, 1, WORK, 20], [15, 0, WORK, 3], [15, 1, WORK, 3], [19, 29, WORK, 2.2], [19, 30, WORK, 2.2]];
  for (const [hh, mm, p, acc] of minutes) {
    const [name, body] = await gpsMinute(Date.UTC(2026, 9, 5, hh, mm), p, acc);
    await fsp.writeFile(path.join(keyDir, `${name}.json.gz`), body);
  }

  // and two real CAN Bridge logs (the car's frames, all four buses, its sidecar) through the index
  const canK = path.join(data, 'can', 'K');
  await fsp.mkdir(canK, { recursive: true });
  const side = JSON.stringify({ bus: { can0: 'vehicle (inferred from IDs)', can1: 'chassis (inferred from IDs)', can3: 'screenmate-internal' } });
  const logs = [
    ['K_20261005T225950Z_1.log.xz', candump(Date.UTC(2026, 9, 5, 22, 59, 50), 1400, { ...PAGES, 'can3:04F': [gps04F(WORK.lat, WORK.lon, 2.4)] })],
    ['K_20261005T232950Z_2.log.xz', candump(Date.UTC(2026, 9, 5, 23, 29, 50), 800)]
  ];
  for (const [name, text] of logs) {
    await fsp.writeFile(path.join(canK, name), execFileSync('xz', ['-1', '-c'], { input: text }));
    await fsp.writeFile(path.join(canK, `${name}.json`), side);
  }
  await createCanIndex({ canDir: path.join(data, 'can'), dir: path.join(data, 'can-index') }).kick();

  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(REPO, 'server', 'index.js')], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: data, FOOTAGE_PATH: root,
      VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: 'correct horse', TZ: 'UTC',
      SENTRY_NOREPLACE_RENAME: path.join(REPO, 'build', 'noreplace-rename'), LOG_LEVEL: 'warn', TLS_MODE: 'off', UPDATE_CHECK: 'off'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { 'X-Requested-With': 'sentry-six-manager', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let out = text;
    try { out = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, data: out };
  };
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal((await call('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 200);
    for (let i = 0; i < 200; i++) {
      if ((await call('GET', '/api/vehicles/daily-driver/recordings')).data.total >= 10) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const recs = async () => Object.fromEntries((await call('GET', '/api/vehicles/daily-driver/recordings')).data.recordings
      .map((r) => [r.eventAt ? `event ${r.eventAt.slice(11, 16)}` : r.start.slice(11, 16), r]));
    const pick = (r) => ({ place: r.place ?? null, from: r.from, to: r.to, placeSource: r.placeSource });

    // no saved places: no place fields at all
    let all = await recs();
    assert.equal(Object.keys(all).length, 12, Object.keys(all).join(', '));
    assert.ok(Object.values(all).every((r) => !('place' in r) && !('placeSource' in r)));
    assert.equal(all['11:00'].can, true, 'the CAN tag (the index covers 11:00)');

    assert.equal((await call('POST', '/api/places', { name: 'Home', ...HOME })).status, 200);
    assert.equal((await call('POST', '/api/places', { name: 'Work', ...WORK })).status, 200);
    all = await recs();
    assert.deepEqual(pick(all['07:00']), { place: null, from: 'Home', to: 'Work', placeSource: 'video' }, 'a drive from Home to Work');
    assert.deepEqual(pick(all['09:00']), { place: 'Work', from: undefined, to: undefined, placeSource: 'video' }, 'parked at Work');
    assert.deepEqual(pick(all['11:00']), { place: 'Home', from: undefined, to: undefined, placeSource: 'video' }, 'the car\'s own GPS (the cameras) beats the Screenmate\'s (CAN Bridge)');
    assert.deepEqual(pick(all['13:00']), { place: 'Home', from: undefined, to: undefined, placeSource: 'video' }, 'a 20 m CAN fix is not used');
    assert.deepEqual(pick(all['15:00']), { place: 'Work', from: undefined, to: undefined, placeSource: 'can' }, 'no camera GPS: the CAN Bridge\'s');
    assert.deepEqual(pick(all['17:00']), { place: null, from: undefined, to: undefined, placeSource: undefined }, 'not indexed yet: no tag');
    assert.deepEqual(pick(all['20:00']), { place: null, from: 'Work', to: 'Home', placeSource: 'video' }, 'parked clips (no telemetry) at both ends are passed over');
    assert.deepEqual(pick(all['21:00']), { place: 'Home', from: undefined, to: undefined, placeSource: 'video' }, 'parked all through: where the car was last seen');
    assert.deepEqual(pick(all['event 19:30']), { place: 'Home', from: undefined, to: undefined, placeSource: 'event' }, 'the car\'s event.json beats CAN Bridge GPS');
    assert.deepEqual(pick(all['event 21:30']), { place: 'Home', from: undefined, to: undefined, placeSource: 'event' }, 'event.json as before');
    assert.equal(all['23:00'].can, true);
    assert.deepEqual(pick(all['23:00']), { place: 'Home', from: undefined, to: undefined, placeSource: 'video' }, 'the cameras\' GPS beats the position from can3 (the Screenmate\'s receiver)');
    assert.deepEqual(pick(all['23:30']), { place: 'Home', from: undefined, to: undefined, placeSource: 'video' }, 'the garage\'s 25 m fix is not used');

    // Drives: the 11:00 drive starts and ends at Work by CAN Bridge GPS (the cameras say Home)
    const drives = (await call('GET', '/api/vehicles/daily-driver/drives')).data.drives;
    const d11 = drives.find((d) => d.start.slice(11, 16) === '11:00');
    assert.ok(d11, JSON.stringify(drives.map((d) => d.start)));
    assert.equal(d11.can, true);
    assert.deepEqual([d11.from?.place, d11.to?.place], ['Work', 'Work']);
    const d07 = drives.find((d) => d.start.slice(11, 16) === '07:00');
    assert.deepEqual([d07.from?.place, d07.to?.place, d07.can], ['Home', 'Work', false], 'no CAN data: the cameras\' GPS');
    const d23 = drives.find((d) => d.start.slice(11, 16) === '23:00');
    assert.ok(d23, JSON.stringify(drives.map((d) => d.start)));
    assert.deepEqual([d23.from?.place, d23.to?.place, d23.can], ['Work', 'Work', true], 'the Model Y\'s can3 position');
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

test('every interface shows the place tag the same way: "at Work", else "Home → Work", "from Home" or "to Work"', () => {
  const fs = require('fs');
  const files = ['web/app.js', ...['aurora/web/aurora', 'daylight/web/dl', 'flux/web/flux', 'horizon/web/hz'].map((p) => `examples/ui-packs/${p}/pages/footage.js`)];
  const def = 'const placeText = (r) => (r.place ? `at ${r.place}` : r.from && r.to ? `${r.from} → ${r.to}` : r.from ? `from ${r.from}` : r.to ? `to ${r.to}` : \'\');';
  for (const f of files) {
    const src = fs.readFileSync(path.join(REPO, f), 'utf8');
    assert.ok(src.includes(def), `${f}: placeText`);
    assert.ok((src.match(/placeText\(r\)/g) || []).length >= 2, `${f}: used for the tag`);
    assert.doesNotMatch(src.replace(def, ''), /`at \$\{(esc\()?r\.place/, `${f}: no "at" tag of its own`);
  }
  const placeText = eval(def.replace('const placeText = ', '')); // eslint-disable-line no-eval
  assert.deepEqual([{ place: 'Work' }, { from: 'Home', to: 'Work' }, { from: 'Home', to: null }, { from: null, to: 'Work' }, { place: null }].map(placeText),
    ['at Work', 'Home → Work', 'from Home', 'to Work', '']);
});
