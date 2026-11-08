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
