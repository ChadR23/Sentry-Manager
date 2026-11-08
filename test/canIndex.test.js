'use strict';

// The CAN index's raw snapshots (the Viewer's nerd raw view): every id's
// payload as it changes, at most RAW_PER_SEC changes a second plus the last of
// each second; a log indexed before them gains them once, without its signal
// files being written again; indexing again does not count anything twice.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync, spawnSync } = require('child_process');
const { createCanIndex, FORMAT, RAW_PER_SEC } = require('../server/canIndex');

const skip = spawnSync('xz', ['--version']).status !== 0 && 'needs xz';
const T0 = Date.UTC(2020, 0, 1, 8, 0, 0); // a minute boundary
const hex2 = (n) => (n & 0xff).toString(16).padStart(2, '0').toUpperCase();

async function setup(name, lines) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'canindex-'));
  await fsp.mkdir(path.join(base, 'can', 'K'), { recursive: true });
  await fsp.writeFile(path.join(base, 'can', 'K', name), execFileSync('xz', ['-1', '-c'], { input: `${lines.join('\n')}\n` }));
  const idx = createCanIndex({ canDir: path.join(base, 'can'), dir: path.join(base, 'idx') });
  return { base, idx, rawFile: (m) => path.join(base, 'idx', 'K', `${m}.raw.json.gz`) };
}
const line = (ms, id, payload, bus = 'can0') => `(${Math.floor(ms / 1000)}.${String(Math.round((ms % 1000) * 1000)).padStart(6, '0')}) ${bus} ${id}#${payload}`;

test('raw snapshots: every change up to the limit a second, the last of each second, unknown ids too', { skip }, async () => {
  const lines = [];
  // 6E3 (no DBC knows it): a counter in byte 0 at 100 Hz for 3 s; byte 3 goes
  // from 00 to 01 at 1.5 s (the "brake pedal"); 7FF: the same payload all along
  for (let i = 0; i < 300; i++) {
    const ms = T0 + 10_000 + i * 10;
    lines.push(line(ms, '6E3', `${hex2(i)}0000${i >= 150 ? '01' : '00'}`));
    if (i % 10 === 0) lines.push(line(ms, '7FF', '0102030405060708', 'can1'));
  }
  const { base, idx, rawFile } = await setup('K_20200101T080000Z_1.log.xz', lines);
  try {
    const r = await idx.indexLog('K', 'K_20200101T080000Z_1.log.xz');
    assert.equal(r.frames, 330);
    const file = JSON.parse(zlib.gunzipSync(fs.readFileSync(rawFile('20200101T0800'))).toString());
    const pts = file.raw['can0:6E3'];
    for (let s = 10; s < 13; s++) {
      const inSec = pts.filter((p) => Math.floor(p[0] / 1000) === s);
      assert.equal(inSec.length, RAW_PER_SEC + 1, `second ${s}: the first ${RAW_PER_SEC} changes and the last`);
      assert.equal(inSec[inSec.length - 1][0], s * 1000 + 990, 'the last payload of the second is kept');
    }
    assert.deepEqual(file.raw['can1:7FF'], [[10_000, '0102030405060708']], 'an id that never changes: once');
    assert.deepEqual(file.logs['K_20200101T080000Z_1.log.xz'].ids, { 'can0:6E3': 300, 'can1:7FF': 30 });

    const got = await idx.raw(['K'], T0 + 10_000, T0 + 13_000);
    assert.deepEqual(got.map((e) => [e.key, e.name]), [['can0:6E3', null], ['can1:7FF', null]], 'sorted by id; 7FF is a Vehicle bus message, and can1 is the Chassis bus: unknown there');
    const brake = got[0].changes;
    // the payload at 1.6 s into the burst has byte 3 at 01 (the limit may hold a change back, never past its second)
    const at = (utc) => brake.filter((c) => c[0] <= utc).pop()[1];
    assert.equal(at(T0 + 11_400).slice(6, 8), '00');
    assert.equal(at(T0 + 12_000).slice(6, 8), '01');
    assert.ok(got[0].changes.every((c, i, a) => i === 0 || c[0] > a[i - 1][0]), 'in time order');
    assert.ok(got[1].hz > 9 && got[1].hz < 11, `about 10 Hz (${got[1].hz})`);
    assert.ok(got[0].hz > 95 && got[0].hz < 105, `about 100 Hz (${got[0].hz})`);
    // the payload from before the window
    const later = await idx.raw(['K'], T0 + 30_000, T0 + 40_000);
    assert.deepEqual(later.find((e) => e.key === 'can1:7FF').changes, [[T0 + 10_000, '0102030405060708']]);

    // indexing the same log again changes nothing (no frames counted twice)
    await idx.indexLog('K', 'K_20200101T080000Z_1.log.xz');
    assert.deepEqual(await idx.raw(['K'], T0 + 10_000, T0 + 13_000), got);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('raw snapshots: a minute two logs share has both; each minute starts with every payload', { skip }, async () => {
  const a = [line(T0 + 50_000, '6E3', 'AA'), line(T0 + 70_000, '6E3', 'AA')];
  const { base, idx, rawFile } = await setup('K_20200101T080050Z_1.log.xz', a);
  try {
    await fsp.writeFile(path.join(base, 'can', 'K', 'K_20200101T080055Z_2.log.xz'), execFileSync('xz', ['-1', '-c'], { input: `${line(T0 + 55_000, '5A1', '01')}\n` }));
    await idx.kick();
    const m0 = JSON.parse(zlib.gunzipSync(fs.readFileSync(rawFile('20200101T0800'))).toString());
    assert.deepEqual(Object.keys(m0.raw).sort(), ['can0:5A1', 'can0:6E3']);
    assert.deepEqual(Object.keys(m0.logs).sort(), ['K_20200101T080050Z_1.log.xz', 'K_20200101T080055Z_2.log.xz']);
    const m1 = JSON.parse(zlib.gunzipSync(fs.readFileSync(rawFile('20200101T0801'))).toString());
    assert.deepEqual(m1.raw['can0:6E3'], [[10_000, 'AA']], 'the next minute has the payload again (same as before)');
    const got = await idx.raw(['K'], T0 + 60_000, T0 + 80_000);
    assert.deepEqual(got.find((e) => e.key === 'can0:6E3').changes, [[T0 + 50_000, 'AA']], 'but only real changes are sent');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('raw snapshots: a log indexed before them gains them once, its signal minutes untouched', { skip }, async () => {
  const lines = [];
  for (let i = 0; i < 50; i++) {
    const b = Buffer.alloc(8);
    b.writeUInt16LE(38000 + i, 0);
    lines.push(line(T0 + i * 100, '132', b.toString('hex').toUpperCase()));
  }
  const name = 'K_20200101T080000Z_1.log.xz';
  const { base, idx, rawFile } = await setup(name, lines);
  try {
    await idx.kick();
    const doneFile = path.join(base, 'idx', 'done.json');
    const stamp = JSON.parse(fs.readFileSync(doneFile, 'utf8'))[`K/${name}`];
    assert.match(stamp, new RegExp(`/${FORMAT}$`), 'the stamp names the index format');
    // as an older version left it: an old stamp and no raw file
    fs.writeFileSync(doneFile, JSON.stringify({ [`K/${name}`]: stamp.replace(`/${FORMAT}`, '') }));
    fs.rmSync(rawFile('20200101T0800'));
    const sigFile = path.join(base, 'idx', 'K', '20200101T0800.json.gz');
    const before = fs.readFileSync(sigFile);
    const old = new Date('2001-01-01');
    fs.utimesSync(sigFile, old, old);
    const again = createCanIndex({ canDir: path.join(base, 'can'), dir: path.join(base, 'idx') });
    const todo = await again.pendingLogs();
    assert.deepEqual(todo.map((j) => [j.name, j.rawOnly]), [[name, true]]);
    await again.kick();
    assert.ok(fs.existsSync(rawFile('20200101T0800')), 'raw snapshots written');
    assert.deepEqual(fs.readFileSync(sigFile), before);
    assert.equal(fs.statSync(sigFile).mtimeMs, old.getTime(), 'the signal minute was not written again');
    assert.equal(JSON.parse(fs.readFileSync(doneFile, 'utf8'))[`K/${name}`], stamp);
    assert.deepEqual(await again.pendingLogs(), [], 'once');
    assert.equal((await again.raw(['K'], T0, T0 + 5000))[0].changes.length, 50);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

// ---- indexing again, sidecars after their log, xz that fails

const volts = (ms, v, bus = 'can0') => {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(Math.round(v / 0.01), 0);
  return line(ms, '132', b.toString('hex').toUpperCase(), bus);
};
const minuteFile = (base, m) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(base, 'idx', 'K', `${m}.json.gz`))).toString());

test('indexing a log again replaces its own part: no frame counted twice, the other log of a minute untouched', { skip }, async () => {
  const a = [];
  for (let i = 0; i < 40; i++) a.push(volts(T0 + 10_000 + i * 100, 380 + i));
  const name = 'K_20200101T080010Z_1.log.xz';
  const { base, idx } = await setup(name, a);
  try {
    const other = 'K_20200101T080050Z_2.log.xz';
    const b = [];
    for (let i = 0; i < 20; i++) b.push(volts(T0 + 50_000 + i * 100, 300 + i));
    await fsp.writeFile(path.join(base, 'can', 'K', other), execFileSync('xz', ['-1', '-c'], { input: `${b.join('\n')}\n` }));
    await idx.kick();
    const once = minuteFile(base, '20200101T0800');
    assert.deepEqual(once.ids, { 'can0:132': 60 });
    const series = await idx.series(['K'], T0, T0 + 59_000);
    await idx.indexLog('K', name);
    await idx.indexLog('K', name);
    const twice = minuteFile(base, '20200101T0800');
    assert.deepEqual(twice.ids, { 'can0:132': 60 }, 'each frame counted once');
    assert.deepEqual(Object.keys(twice.logs).sort(), [name, other]);
    assert.deepEqual(await idx.series(['K'], T0, T0 + 59_000), series, 'the same points, the other log\'s too');
    assert.ok(series.BattVoltage132.some((p) => p[1] === 300), 'the other log is there');
    assert.equal(Object.keys(twice).pop(), 'ids', 'the frame counts last (canSearch.js reads them from the end)');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('indexing again a minute written before the per-log records: its frames taken out by the raw record', { skip }, async () => {
  const a = [];
  for (let i = 0; i < 30; i++) a.push(volts(T0 + 10_000 + i * 100, 380 + i));
  const name = 'K_20200101T080010Z_1.log.xz';
  const { base, idx } = await setup(name, a);
  try {
    await idx.indexLog('K', name, { trust: 'verified' });
    // as an older version wrote it: no per-log records, the frame counts and trust only
    const f = path.join(base, 'idx', 'K', '20200101T0800.json.gz');
    const old = minuteFile(base, '20200101T0800');
    fs.writeFileSync(f, zlib.gzipSync(JSON.stringify({ minute: old.minute, signals: old.signals, ids: old.ids, trust: 'verified' })));
    await idx.indexLog('K', name, { trust: 'verified' });
    const now = minuteFile(base, '20200101T0800');
    assert.deepEqual(now.ids, { 'can0:132': 30 });
    assert.equal(now.signals.BattVoltage132.length, old.signals.BattVoltage132.length);
    assert.equal(now.trust, 'verified');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('a sidecar that comes after its log: the log is indexed again with its bus map, nothing counted twice', { skip }, async () => {
  // the battery voltage (a Vehicle bus message) on can1, which is the Chassis bus unless the sidecar says otherwise
  const a = [];
  for (let i = 0; i < 30; i++) a.push(volts(T0 + 10_000 + i * 100, 380 + i, 'can1'));
  const name = 'K_20200101T080010Z_1.log.xz';
  const { base, idx, rawFile } = await setup(name, a);
  try {
    await idx.kick();
    assert.equal((await idx.series(['K'], T0, T0 + 59_000)).BattVoltage132, undefined, 'by the default bus map: not the Vehicle bus');
    const rawBefore = await idx.raw(['K'], T0, T0 + 59_000);
    assert.equal(rawBefore[0].name, null);
    fs.writeFileSync(path.join(base, 'can', 'K', `${name}.json`), JSON.stringify({ busMap: { can0: 'ChassisBus', can1: 'VehicleBus' } }));
    assert.deepEqual((await idx.pendingLogs()).map((j) => [j.name, j.rawOnly]), [[name, false]], 'pending again');
    await idx.kick();
    assert.equal((await idx.series(['K'], T0, T0 + 59_000)).BattVoltage132.length, 30);
    assert.deepEqual(minuteFile(base, '20200101T0800').ids, { 'can1:132': 30 });
    const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(rawFile('20200101T0800'))).toString());
    assert.equal(raw.logs[name].buses.can1, 'VehicleBus', 'the raw view\'s bus too');
    assert.deepEqual(raw.logs[name].ids, { 'can1:132': 30 });
    const rawAfter = await idx.raw(['K'], T0, T0 + 59_000);
    assert.equal(rawAfter[0].name, 'ID132HVBattAmpVolt');
    assert.deepEqual(rawAfter[0].changes, rawBefore[0].changes, 'no payload twice');
    assert.deepEqual(await idx.pendingLogs(), [], 'once');
    // a sidecar that changes: again
    fs.writeFileSync(path.join(base, 'can', 'K', `${name}.json`), JSON.stringify({ busMap: { can0: 'VehicleBus', can1: 'ChassisBus' } }));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(base, 'can', 'K', `${name}.json`), later, later);
    await idx.kick();
    assert.equal((await idx.series(['K'], T0, T0 + 59_000)).BattVoltage132, undefined, 'its points taken out again');
    assert.deepEqual(minuteFile(base, '20200101T0800').ids, { 'can1:132': 30 });
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

// minutes of the battery voltage at 100 Hz, with a counter so xz cannot squeeze it to nothing
const longLog = (minutes, hz = 100) => {
  const out = [];
  for (let i = 0; i < minutes * 60 * hz; i++) {
    const ms = T0 + i * (1000 / hz);
    out.push(volts(ms, 350 + (i % 997) / 10), line(ms, '6E3', `${hex2(i)}${hex2(i >> 8)}${hex2(i * 7)}${hex2(i * 13)}`));
  }
  return out;
};

test('a log cut off (xz ends early): what was read is indexed, signals.json too, and the sync is told', { skip }, async () => {
  const name = 'K_20200101T080000Z_1.log.xz';
  const { base } = await setup(name, longLog(6));
  try {
    const file = path.join(base, 'can', 'K', name);
    const whole = fs.readFileSync(file);
    fs.writeFileSync(file, whole.subarray(0, Math.floor(whole.length * 0.75)));
    const told = [];
    const idx = createCanIndex({ canDir: path.join(base, 'can'), dir: path.join(base, 'idx'), onIndexed: (k, from, to) => told.push([k, from, to]) });
    const r = await idx.indexLog('K', name);
    assert.ok(r.frames > 0 && r.truncated, 'a partial result, flagged');
    assert.ok(r.minutes >= 2);
    for (let m = 0; m < r.minutes; m++) assert.ok(minuteFile(base, `20200101T080${m}`).ids['can0:132'] > 0, `minute ${m} written`);
    assert.ok(JSON.parse(fs.readFileSync(path.join(base, 'idx', 'K', 'signals.json'), 'utf8')).BattVoltage132);
    fs.rmSync(path.join(base, 'idx'), { recursive: true });
    await idx.kick();
    assert.equal(told.length, 1, 'the sync works the drives out');
    assert.equal(told[0][0], 'K');
    assert.match(idx.status().lastError, /stopped early/);
    assert.deepEqual(await idx.pendingLogs(), []);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('xz that cannot be started: an error for that log, not a crash, and tried again later', { skip }, async () => {
  const name = 'K_20200101T080000Z_1.log.xz';
  const { base } = await setup(name, [volts(T0, 380)]);
  try {
    const idx = createCanIndex({ canDir: path.join(base, 'can'), dir: path.join(base, 'idx'), xz: 'no-such-xz-binary' });
    await assert.rejects(idx.indexLog('K', name), /could not be started.*ENOENT/);
    await idx.kick();
    assert.match(idx.status().lastError, /ENOENT/);
    assert.equal((await idx.pendingLogs()).length, 1, 'not marked done');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('a write that fails partway: xz is stopped, no .tmp file left behind', { skip }, async () => {
  const name = 'K_20200101T080000Z_1.log.xz';
  const { base } = await setup(name, longLog(8));
  try {
    // xz through a script that says its process id
    const pidFile = path.join(base, 'xz.pid');
    const wrapper = path.join(base, 'xz.sh');
    fs.writeFileSync(wrapper, `#!/bin/sh\necho $$ > '${pidFile}'\nexec xz "$@"\n`, { mode: 0o755 });
    // the first minute's file cannot be written (a folder is in its way)
    fs.mkdirSync(path.join(base, 'idx', 'K', '20200101T0800.json.gz', 'x'), { recursive: true });
    const idx = createCanIndex({ canDir: path.join(base, 'can'), dir: path.join(base, 'idx'), xz: wrapper });
    await assert.rejects(idx.indexLog('K', name));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(), false, 'xz is not left running');
    assert.deepEqual(fs.readdirSync(path.join(base, 'idx', 'K')).filter((f) => f.endsWith('.tmp')), []);
  } finally {
    try { process.kill(Number(fs.readFileSync(path.join(base, 'xz.pid'), 'utf8'))); } catch { /* gone */ }
    await fsp.rm(base, { recursive: true, force: true });
  }
});
