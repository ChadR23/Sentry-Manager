'use strict';

// Place tags and drive ends with CAN Bridge GPS, Node against lean: the
// footage, speed index and CAN index of test/recordingPlace.test.js (the
// cameras' GPS, good and poor CAN fixes, a Model Y's can3 position, parked
// clips, events with event.json, a clip not indexed yet), two saved places,
// on both servers (each on its own copy, over HTTPS with its own CA), then
// every recording's place fields, the day cards (CAN tags) and the drives
// compared answer for answer.
//
//   node lean/parity/placeTags.js [--dir /tmp/sm-places]
//
// Needs the lean binary (LEAN_BIN or lean/target/release/sentry-lean) and xz.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const lib = require(path.join(REPO, 'tools', 'contract', 'lib'));
const fmt = require(path.join(REPO, 'server', 'canFormat'));
const { FORMAT, createCanIndex } = require(path.join(REPO, 'server', 'canIndex'));
const { PAGES, candump, gps04F } = require(path.join(REPO, 'test', 'canModelY'));
const LEAN = process.env.LEAN_BIN || path.join(REPO, 'lean', 'target', 'release', 'sentry-lean');
const PASSWORD = 'place tags password';
const HOME = { lat: 41.8781, lon: -87.6298 };
const WORK = { lat: 41.9, lon: -87.7 };
const DAY = '2026-10-05';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; };
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

function gpsMinute(t, at, acc) {
  const ms = Array.from({ length: 60 }, (_, i) => i * 1000 + 250);
  const minute = new Date(t).toISOString().slice(0, 16).replace(/[-:]/g, '');
  return fmt.packMinute({
    minute, trust: 'unsigned', logs: { 'K_x_1.log.xz': { fmt: FORMAT, span: [0, 59_999], ids: { 'can1:04F': 60 } } },
    signals: { GPSLatitude04F: ms.map((m) => [m, at.lat]), GPSLongitude04F: ms.map((m) => [m, at.lon]), GPSAccuracy04F: ms.map((m) => [m, acc]) },
    ids: { 'can1:04F': 60 }
  }).then((body) => [minute, body]);
}

/** test/recordingPlace.test.js's footage, speed index and CAN index. */
async function build(dir) {
  const root = path.join(dir, 'footage');
  const recent = path.join(root, 'TeslaCam', 'RecentClips');
  await fsp.mkdir(recent, { recursive: true });
  const speeds = {};
  const moving = Array.from({ length: 60 }, () => 12);
  const parked = Array.from({ length: 60 }, () => 0);
  const clip = async (key, sp, g, indexed = true) => {
    for (const cam of ['front', 'back']) await fsp.writeFile(path.join(recent, `${key}-${cam}.mp4`), crypto.randomBytes(2048));
    const st = await fsp.stat(path.join(recent, `${key}-front.mp4`));
    if (indexed) speeds[`TeslaCam/RecentClips/${key}-front.mp4`] = sp === null ? [st.size, Math.round(st.mtimeMs), null, null] : [st.size, Math.round(st.mtimeMs), sp, { b: null, t: null, v: [0, Math.max(...sp)], g, k: 2 }];
  };
  const at = (p, s = 0) => [s, p.lat, p.lon];
  await clip(`${DAY}_07-00-00`, moving, [at(HOME), at(HOME, 55)]);
  await clip(`${DAY}_07-01-00`, moving, [at(HOME, 0), at(WORK, 50)]);
  await clip(`${DAY}_07-02-00`, parked, [at(WORK), at(WORK, 55)]);
  await clip(`${DAY}_09-00-00`, parked, []);
  await clip(`${DAY}_09-01-00`, parked, [at(WORK)]);
  await clip(`${DAY}_09-02-00`, parked, [at(WORK, 30)]);
  await clip(`${DAY}_11-00-00`, moving, [at(HOME)]);
  await clip(`${DAY}_11-01-00`, moving, [at(HOME, 55)]);
  await clip(`${DAY}_13-00-00`, parked, [at(HOME)]);
  await clip(`${DAY}_13-01-00`, parked, [at(HOME, 55)]);
  await clip(`${DAY}_23-00-00`, moving, [at(HOME)]);
  await clip(`${DAY}_23-01-00`, moving, [at(HOME, 55)]);
  await clip(`${DAY}_23-30-00`, parked, [at(HOME), at(HOME, 55)]);
  await clip(`${DAY}_20-00-00`, null, null);
  await clip(`${DAY}_20-01-00`, moving, [at(WORK), at(HOME, 55)]);
  await clip(`${DAY}_20-02-00`, null, null);
  await clip(`${DAY}_21-00-00`, null, null);
  await clip(`${DAY}_15-00-00`, parked, []);
  await clip(`${DAY}_17-00-00`, parked, [at(WORK)], false);
  for (const [stamp, city] of [['19-30-00', 'Chicago'], ['21-30-00', null]]) {
    const ev = path.join(root, 'TeslaCam', 'SentryClips', `${DAY}_${stamp}`);
    await fsp.mkdir(ev, { recursive: true });
    const clipStamp = stamp.replace('-30-', '-29-');
    await fsp.writeFile(path.join(ev, `${DAY}_${clipStamp}-front.mp4`), crypto.randomBytes(2048));
    await fsp.writeFile(path.join(ev, 'event.json'), JSON.stringify({ timestamp: `${DAY}T${stamp.replace(/-/g, ':')}`, ...(city ? { city } : {}), est_lat: String(HOME.lat), est_lon: String(HOME.lon), reason: 'sentry_aware_object_detection' }));
  }
  const data = path.join(dir, 'data');
  await fsp.mkdir(path.join(data, 'speeds', 'daily-driver'), { recursive: true });
  await fsp.writeFile(path.join(data, 'speeds', 'daily-driver', `${DAY}.json`), JSON.stringify(speeds));
  const keyDir = path.join(data, 'can-index', 'K');
  await fsp.mkdir(keyDir, { recursive: true });
  for (const [hh, mm, p, acc] of [[11, 0, WORK, 3], [11, 1, WORK, 3], [13, 0, WORK, 20], [13, 1, WORK, 20], [15, 0, WORK, 3], [15, 1, WORK, 3], [19, 29, WORK, 2.2], [19, 30, WORK, 2.2]]) {
    const [name, body] = await gpsMinute(Date.UTC(2026, 9, 5, hh, mm), p, acc);
    await fsp.writeFile(path.join(keyDir, `${name}.json.gz`), body);
  }
  const canK = path.join(data, 'can', 'K');
  await fsp.mkdir(canK, { recursive: true });
  const side = JSON.stringify({ bus: { can0: 'vehicle (inferred from IDs)', can1: 'chassis (inferred from IDs)', can3: 'screenmate-internal' } });
  for (const [name, text] of [
    ['K_20261005T225950Z_1.log.xz', candump(Date.UTC(2026, 9, 5, 22, 59, 50), 1400, { ...PAGES, 'can3:04F': [gps04F(WORK.lat, WORK.lon, 2.4)] })],
    ['K_20261005T232950Z_2.log.xz', candump(Date.UTC(2026, 9, 5, 23, 29, 50), 800)]
  ]) {
    await fsp.writeFile(path.join(canK, name), execFileSync('xz', ['-1', '-c'], { input: text }));
    await fsp.writeFile(path.join(canK, `${name}.json`), side);
  }
  await createCanIndex({ canDir: path.join(data, 'can'), dir: path.join(data, 'can-index') }).kick();
  return { root, data };
}

const up = (base) => new Promise((resolve) => {
  const req = https.get(`${base}/healthz`, { rejectUnauthorized: false }, (res) => { res.resume(); resolve(res.statusCode === 200); });
  req.on('error', () => resolve(false));
  req.setTimeout(1000, () => { req.destroy(); resolve(false); });
});

async function start(kind, dir, { root, data }) {
  const port = await freePort();
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: data, FOOTAGE_PATH: root, VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'),
    UI_PASSWORD: PASSWORD, TZ: 'UTC', LOG_LEVEL: 'warn', TLS_MODE: 'auto', UPDATE_CHECK: 'off', APP_ROOT: REPO
  };
  const child = kind === 'node'
    ? spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(REPO, 'server', 'index.js')], { env, stdio: ['ignore', 'ignore', fs.openSync(path.join(dir, 'server.log'), 'a')] })
    : spawn(LEAN, [], { env, stdio: ['ignore', 'ignore', fs.openSync(path.join(dir, 'server.log'), 'a')] });
  const base = `https://127.0.0.1:${port}`;
  for (let i = 0; i < 300 && !(await up(base)); i++) await new Promise((r) => setTimeout(r, 100));
  const client = lib.createClient({ base, ca: path.join(data, 'tls', 'ca.crt') });
  await client.login('admin', PASSWORD);
  return { child, client };
}

async function answers(client) {
  const get = async (p) => {
    const res = await client.request('GET', p);
    return lib.snapshot(res, { normalise: [] }, { now: Date.now() });
  };
  for (let i = 0; i < 200; i++) {
    const r = lib.parseJson((await client.request('GET', '/api/vehicles/daily-driver/recordings')).body);
    if (r?.total >= 12) break;
    await new Promise((res) => setTimeout(res, 150));
  }
  const out = {};
  out['recordings, no places'] = await get('/api/vehicles/daily-driver/recordings');
  await client.request('POST', '/api/places', { body: { name: 'Home', ...HOME } });
  await client.request('POST', '/api/places', { body: { name: 'Work', ...WORK } });
  out.recordings = await get('/api/vehicles/daily-driver/recordings');
  out.days = await get('/api/vehicles/daily-driver/days');
  out.drives = await get('/api/vehicles/daily-driver/drives');
  out['drives, gap 30'] = await get('/api/vehicles/daily-driver/drives?gap=30');
  // (the place ids are each server's own)
  for (const k of Object.keys(out)) out[k] = JSON.parse(JSON.stringify(out[k]).replace(/"placeId":"[^"]+"/g, '"placeId":"<id>"'));
  return out;
}

(async () => {
  const dir = path.resolve(arg('dir', null) || fs.mkdtempSync(path.join(os.tmpdir(), 'sm-places-')));
  const made = await build(path.join(dir, 'node'));
  await fsp.cp(path.join(dir, 'node'), path.join(dir, 'lean'), { recursive: true, preserveTimestamps: true });
  const servers = [];
  try {
    const node = await start('node', path.join(dir, 'node'), made);
    servers.push(node);
    const lean = await start('lean', path.join(dir, 'lean'), { root: path.join(dir, 'lean', 'footage'), data: path.join(dir, 'lean', 'data') });
    servers.push(lean);
    const [a, b] = [await answers(node.client), await answers(lean.client)];
    let differ = 0;
    for (const k of Object.keys(a)) {
      const d = lib.diff(a[k], b[k]);
      console.log(`${d.length ? 'DIFF' : 'ok  '} ${k}`);
      for (const x of d.slice(0, 12)) console.log(`      ${x.path}: node ${lib.brief(x.golden)}, lean ${lib.brief(x.actual)}`);
      if (d.length) differ++;
    }
    console.log(`${Object.keys(a).length} answers, ${differ} differ`);
    process.exitCode = differ ? 1 : 0;
  } finally {
    for (const s of servers) { s.client.close(); if (s.child.exitCode === null) s.child.kill('SIGTERM'); }
  }
})().catch((err) => { console.error(err.stack || err.message); process.exit(2); });
