'use strict';

// The car's GPS position from the Screenmate's own bus (index r3): on a 2026
// Model Y 0x04F comes only on can3, which the CAN Bridge's sidecar calls
// "screenmate-internal". The index decodes that one message there, and only
// its latitude, longitude and accuracy (INTERNAL_BUS_MESSAGES); a car bus's
// 0x04F wins where a car sends one; an index written by r2 is decoded again
// for it without losing what r2 decoded of logs that are gone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync, spawnSync } = require('child_process');
const fmt = require('../server/canFormat');
const { parseDbc, bundledDbc, decodeFrame } = require('../server/canDbc');
const { createCanIndex, FORMAT, CAR_FORMAT, INTERNAL_BUS_MESSAGES, INTERNAL_YIELD_MS } = require('../server/canIndex');
const { SYNC_FORMAT } = require('../server/canSync');
const { PAGES, candump, gps04F, EXPECTED } = require('./canModelY');

const skip = spawnSync('xz', ['--version']).status !== 0 && 'needs xz';
const SIDE = { bus: { can0: 'vehicle (inferred from IDs)', can1: 'chassis (inferred from IDs)', can3: 'screenmate-internal' } };
const T0 = Date.UTC(2026, 10, 8, 1, 28, 0);
const stamp = (t) => `${Math.floor(t / 1000)}.${String(Math.round((t % 1000) * 1000)).padStart(6, '0')}`;

async function setup(logs) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'caninternalgps-'));
  await fsp.mkdir(path.join(base, 'can', 'K'), { recursive: true });
  for (const [name, text, side] of logs) {
    await fsp.writeFile(path.join(base, 'can', 'K', name), execFileSync('xz', ['-1', '-c'], { input: text }));
    if (side) await fsp.writeFile(path.join(base, 'can', 'K', `${name}.json`), JSON.stringify(side));
  }
  return base;
}

test('the car\'s own can3 frame: 0x04F decodes to a position in Colorado, 25 m (parked in the garage)', () => {
  const msg = bundledDbc().messages.get(0x04F);
  const v = Object.fromEntries(decodeFrame(msg, Buffer.from(PAGES['can3:04F'][0], 'hex')).map(([s, x]) => [s.series, x]));
  // 28-bit signed, a millionth of a degree, Intel byte order: north and west come out right
  assert.ok(Math.abs(v.GPSLatitude04F - 40.2) < 0.01 && Math.abs(v.GPSLongitude04F + 107.52) < 0.01, JSON.stringify(v));
  assert.ok(Math.abs(v.GPSAccuracy04F - 25) < 1e-9, 'metres (0.2 m a step)');
  // the test's frame maker gives the car's frame back, bit for bit
  assert.equal(gps04F(v.GPSLatitude04F, v.GPSLongitude04F, v.GPSAccuracy04F), PAGES['can3:04F'][0]);
  assert.deepEqual([...INTERNAL_BUS_MESSAGES.keys()], [0x04F], 'only that message');
  assert.deepEqual([...INTERNAL_BUS_MESSAGES.get(0x04F)].sort(), ['GPSAccuracy04F', 'GPSLatitude04F', 'GPSLongitude04F']);
});

test('only the allowed signals of 0x04F, and no other message, are decoded on the internal bus', { skip }, async () => {
  // a DBC whose 0x04F has a fourth signal, and with the chassis bus's 0x3D9
  const dbc = parseDbc([
    'BO_ 79 ID04FGPSLatLong: 8 ChassisBus',
    ' SG_ GPSAccuracy04F : 57|7@1+ (0.2,0) [0|25.2] "m"  Receiver',
    ' SG_ GPSLongitude04F : 28|28@1- (1E-006,0) [-134.218|134.218] "Deg"  Receiver',
    ' SG_ GPSLatitude04F : 0|28@1- (1E-006,0) [-134.218|134.218] "Deg"  Receiver',
    ' SG_ GPSOther04F : 56|1@1+ (1,0) [0|1] ""  Receiver',
    '',
    'BO_ 985 ID3D9UI_gpsVehicleSpeed: 8 ChassisBus',
    ' SG_ UI_gpsHDOP : 0|8@1+ (0.1,0) [0|25.5] ""  Receiver',
    ''
  ].join('\n'));
  const lines = ['# canbridge v1'];
  for (let i = 0; i < 30; i++) lines.push(`(${stamp(T0 + i * 100)}) can3 04F#${PAGES['can3:04F'][0]}`, `(${stamp(T0 + i * 100)}) can3 3D9#${PAGES['can3:3D9'][0]}`);
  const base = await setup([['K_20261108T012800Z_1.log.xz', `${lines.join('\n')}\n`, SIDE]]);
  try {
    const idx = createCanIndex({ canDir: path.join(base, 'can'), dir: path.join(base, 'idx'), dbc: () => dbc });
    await idx.kick();
    const s = await idx.series(['K'], T0, T0 + 3000);
    assert.deepEqual(Object.keys(s).sort(), ['GPSAccuracy04F', 'GPSLatitude04F', 'GPSLongitude04F']);
    assert.deepEqual(Object.keys(await idx.signals(['K'])).sort(), ['GPSAccuracy04F', 'GPSLatitude04F', 'GPSLongitude04F']);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('a car bus\'s 0x04F wins: the internal one only fills in while the car bus sends none', { skip }, async () => {
  const car = gps04F(41.9, -87.7, 2.4);
  const own = gps04F(41.8781, -87.6298, 3);
  // 0-9 s: both (the car bus's at whole seconds, can3's 300 ms later); 10-19 s: can3 only; then the car bus again
  const lines = ['# canbridge v1'];
  for (let i = 0; i < 25; i++) {
    if (i < 10 || i >= 20) lines.push(`(${stamp(T0 + i * 1000)}) can1 04F#${car}`);
    lines.push(`(${stamp(T0 + i * 1000 + 300)}) can3 04F#${own}`);
  }
  const base = await setup([['K_20261108T012800Z_1.log.xz', `${lines.join('\n')}\n`, SIDE]]);
  try {
    const idx = createCanIndex({ canDir: path.join(base, 'can'), dir: path.join(base, 'idx') });
    await idx.kick();
    const lat = (await idx.series(['K'], T0, T0 + 30_000)).GPSLatitude04F;
    const src = lat.map(([t, v]) => [Math.round((t - T0) / 100) / 10, v === 41.9 ? 'car' : 'can3']);
    // the car bus's until it stops; can3's once the car bus has sent none for INTERNAL_YIELD_MS; the car bus's again
    for (const [sec, from] of src) {
      const want = sec < 9 + INTERNAL_YIELD_MS / 1000 || sec >= 20 ? 'car' : 'can3';
      assert.equal(from, want, `${sec} s: ${JSON.stringify(src)}`);
    }
    assert.ok(src.some(([, f]) => f === 'can3'), 'can3 filled the gap');
    assert.ok(!src.some(([sec, f]) => sec < 10 && f === 'can3'), 'no interleaving while both send');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('an index written by r2 is decoded again for the position; what r2 decoded of a log that is gone stays, and so does the sync', { skip }, async () => {
  assert.equal(CAR_FORMAT, 'r2');
  assert.equal(SYNC_FORMAT, '1/r2', 'sync.json files written by r2 stay good (the car\'s buses decode as they did)');
  const nameA = 'K_20261108T012750Z_1.log.xz'; // 01:27:50 to 01:28:10: stored
  const nameB = 'K_20261108T013000Z_2.log.xz'; // 01:30:00 to 01:30:05: pruned after r2 indexed it
  const base = await setup([[nameA, candump(T0 - 10_000, 200), SIDE], [nameB, candump(T0 + 120_000, 50), SIDE]]);
  try {
    const dir = path.join(base, 'idx');
    const dirK = path.join(dir, 'K');
    await createCanIndex({ canDir: path.join(base, 'can'), dir }).kick();
    // as r2 left it: its stamps and parts, no position anywhere, signals.json r2, packed for r2
    const doneFile = path.join(dir, 'done.json');
    const done = JSON.parse(fs.readFileSync(doneFile, 'utf8'));
    for (const k of Object.keys(done)) done[k] = done[k].replace(`/${FORMAT}`, '/r2');
    fs.writeFileSync(doneFile, JSON.stringify(done));
    fs.writeFileSync(path.join(dir, 'packed.json'), JSON.stringify({ K: `${fmt.ENC}/r2` }));
    const minutes = fs.readdirSync(dirK).filter((f) => /^\d{8}T\d{4}\.json\.gz$/.test(f)).sort();
    assert.deepEqual(minutes, ['20261108T0127.json.gz', '20261108T0128.json.gz', '20261108T0130.json.gz']);
    for (const f of minutes) {
      const m = await fmt.readMinuteFile(path.join(dirK, f));
      for (const p of Object.values(m.logs)) p.fmt = 'r2';
      for (const n of INTERNAL_BUS_MESSAGES.get(0x04F)) delete m.signals[n];
      fs.writeFileSync(path.join(dirK, f), await fmt.packMinute(m));
    }
    const sigFile = path.join(dirK, 'signals.json');
    const meta = JSON.parse(fs.readFileSync(sigFile, 'utf8'));
    for (const n of INTERNAL_BUS_MESSAGES.get(0x04F)) delete meta[n];
    for (const v of Object.values(meta)) v.fmt = 'r2';
    fs.writeFileSync(sigFile, JSON.stringify(meta));
    fs.rmSync(path.join(base, 'can', 'K', nameB));
    const beforeB = await fmt.readMinuteFile(path.join(dirK, '20261108T0130.json.gz'));
    assert.ok(beforeB.signals.SOCUI292.length);

    const told = [];
    const again = createCanIndex({ canDir: path.join(base, 'can'), dir, onIndexed: (k, a, z) => told.push([k, a, z]) });
    assert.deepEqual((await again.pendingLogs()).map((j) => [j.name, j.rawOnly]), [[nameA, false]], 'the stored log, decoded again whole');
    await again.kick();
    // log A: the position now, every car-bus value as it was
    const s = await again.series(['K'], T0 - 10_000, T0 + 10_000);
    assert.deepEqual([...new Set(s.GPSLatitude04F.map((p) => p[1]))], [40.199897]);
    for (const [n, want] of Object.entries(EXPECTED)) assert.ok(s[n]?.every((p) => Math.abs(p[1] - want) < 0.01), n);
    for (const f of ['20261108T0127.json.gz', '20261108T0128.json.gz']) {
      const head = await fmt.readHead(path.join(dirK, f));
      assert.equal(head.logs[nameA].fmt, FORMAT, f);
    }
    // log B (gone): its minute keeps every signal r2 decoded, its part says r2, it has no position
    const afterB = await fmt.readMinuteFile(path.join(dirK, '20261108T0130.json.gz'));
    assert.deepEqual(afterB.signals, beforeB.signals, 'nothing taken out');
    assert.deepEqual(afterB.ids, beforeB.ids);
    assert.equal(afterB.logs[nameB].fmt, 'r2');
    assert.equal(afterB.signals.GPSLatitude04F, undefined);
    // signals.json: r2's kept (now current), the position's added
    const metaAfter = JSON.parse(fs.readFileSync(sigFile, 'utf8'));
    for (const n of Object.keys(meta)) assert.equal(metaAfter[n]?.fmt, FORMAT, n);
    assert.equal(metaAfter.GPSAccuracy04F.unit, 'm');
    // repacked for r3 once, with nothing stripped (so the sync and the gap check are told only of log A's minutes)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'packed.json'), 'utf8')), { K: `${fmt.ENC}/${FORMAT}` });
    assert.ok(told.every(([, , z]) => z < T0 + 60_000), JSON.stringify(told));
    assert.equal(await again.repack(), 0);
    assert.deepEqual(await again.pendingLogs(), [], 'once');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('a minute still raw-gzipped by r2 (before columns) is laid out again, keeping r2\'s signals', { skip }, async () => {
  const name = 'K_20261108T013000Z_2.log.xz';
  const base = await setup([[name, candump(T0 + 120_000, 50), SIDE]]);
  try {
    const dir = path.join(base, 'idx');
    const file = path.join(dir, 'K', '20261108T0130.json.gz');
    await createCanIndex({ canDir: path.join(base, 'can'), dir }).kick();
    const m = await fmt.readMinuteFile(file);
    for (const p of Object.values(m.logs)) p.fmt = 'r2';
    delete m.act;
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(m))); // the older layout: plain point lists
    fs.rmSync(path.join(base, 'can', 'K', name));
    fs.rmSync(path.join(dir, 'packed.json'));
    const again = createCanIndex({ canDir: path.join(base, 'can'), dir });
    assert.equal(await again.repack(), 1, 'the minute (its raw file is current)');
    const after = await fmt.readMinuteFile(file);
    assert.equal((await fmt.readHead(file)).enc, fmt.ENC);
    assert.deepEqual(after.signals, m.signals);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});
