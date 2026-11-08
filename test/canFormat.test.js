'use strict';

// The CAN index's file layout (server/canFormat.js): columns of time steps and
// values on disk, the older point lists still read, the top of a minute read
// without its signals, the archive check's `act` worked out when written, and
// old minutes repacked in the background with the same content.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync, spawnSync } = require('child_process');
const fmt = require('../server/canFormat');
const { createCanIndex } = require('../server/canIndex');

const skip = spawnSync('xz', ['--version']).status !== 0 && 'needs xz';
const T0 = Date.UTC(2020, 0, 1, 8, 0, 0);
const line = (ms, id, payload, bus = 'can0') => `(${Math.floor(ms / 1000)}.${String(Math.round((ms % 1000) * 1000)).padStart(6, '0')}) ${bus} ${id}#${payload}`;
const volts = (ms, v, bus = 'can0') => { const b = Buffer.alloc(8); b.writeUInt16LE(Math.round(v / 0.01), 0); return line(ms, '132', b.toString('hex').toUpperCase(), bus); };
// DI_speed (0x257): DI_vehicleSpeed (12 bits from bit 12, 0.08 kph, -40)
const speed = (ms, kph) => { const raw = Math.round((kph + 40) / 0.08); const b = Buffer.alloc(8); b.writeUInt32LE((raw & 0xfff) << 12, 0); return line(ms, '257', b.toString('hex').toUpperCase()); };

test('a minute round-trips through the columns layout; a file without "enc" (the older layout) reads as it is', async () => {
  const data = { minute: '20200101T0800', trust: 'verified', logs: { a: { span: [0, 59000], ids: { 'can0:132': 3 } } }, signals: { V: [[0, 380.5], [50, 380.6], [1050, 380.6]], DI_gear: [[7, 4]] }, ids: { 'can0:132': 3 } };
  const text = fmt.encodeMinute(data);
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed), ['minute', 'enc', 'act', 'trust', 'logs', 'signals', 'ids'], 'the top first, the frame counts last');
  assert.deepEqual(parsed.signals.V, [[0, 50, 1000], [380.5, 380.6, 380.6]]);
  assert.equal(parsed.act, 'd', 'gear D: driving');
  assert.deepEqual(fmt.decodeMinute(parsed), { minute: data.minute, act: 'd', trust: 'verified', logs: data.logs, signals: data.signals, ids: data.ids });
  const old = { minute: data.minute, logs: data.logs, signals: data.signals, ids: data.ids };
  assert.deepEqual(fmt.decodeMinute(JSON.parse(JSON.stringify(old))), old);
  const raw = { minute: data.minute, raw: { 'can0:132': [[5, 'AA'], [105, 'AB']] }, logs: data.logs };
  assert.deepEqual(fmt.decodeRaw(JSON.parse(fmt.encodeRaw(raw))), raw);
});

test('readHead: the top of a minute from its first KB, without its signals; idsOfHead sums each log\'s counts', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canfmt-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  // a busy minute: megabytes of signals after a small top
  const signals = {};
  for (let s = 0; s < 400; s++) signals[`S${s}`] = Array.from({ length: 600 }, (_, i) => [i * 100, Math.random()]);
  const logs = { 'K_20200101T075500Z_1.log.xz': { span: [0, 30000], ids: { 'can0:132': 300, 'can1:7FF': 3 }, trust: 'verified' }, 'K_20200101T080030Z_2.log.xz': { span: [30001, 59999], ids: { 'can0:132': 299 } } };
  const file = path.join(dir, 'm.json.gz');
  await fsp.writeFile(file, await fmt.packMinute({ minute: '20200101T0800', trust: 'verified', logs, signals, ids: { 'can0:132': 599, 'can1:7FF': 3 } }));
  assert.ok(fs.statSync(file).size > 200_000);
  const head = await fmt.readHead(file);
  assert.deepEqual(head, { minute: '20200101T0800', enc: 'c1', act: 'n', trust: 'verified', logs });
  assert.deepEqual(fmt.idsOfHead(head), { 'can0:132': 599, 'can1:7FF': 3 });
  // an older file: no act, its trust and logs still found; one before the per-log records has no ids there
  const old = path.join(dir, 'old.json.gz');
  await fsp.writeFile(old, zlib.gzipSync(JSON.stringify({ minute: 'x', trust: 'unsigned', signals: { A: [[0, 1]] }, ids: { 'can0:1': 1 } })));
  assert.deepEqual(await fmt.readHead(old), { minute: 'x', trust: 'unsigned' });
  assert.equal(fmt.idsOfHead(await fmt.readHead(old)), null);
  assert.equal(await fmt.readHead(path.join(dir, 'missing.json.gz')), null);
  await fsp.writeFile(path.join(dir, 'bad.json.gz'), 'not gzip');
  assert.equal(await fmt.readHead(path.join(dir, 'bad.json.gz')), null);
});

test('the index writes columns, keeps act, and a change held back at the end of a minute stays in that minute', { skip }, async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'canfmt-'));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  await fsp.mkdir(path.join(base, 'can', 'K'), { recursive: true });
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push(speed(T0 + 20_000 + i * 1000, 50));
  // two changes 20 ms apart just before the minute ends: the second waits for 50 ms to pass,
  // and is written at its own time, in the minute it came in
  lines.push(volts(T0 + 59_960, 381), volts(T0 + 59_980, 382), volts(T0 + 60_100, 382));
  // a line whose interface is not a name: not indexed
  lines.push(`(${T0 / 1000 + 30}.000000) =1+1 7EF#00`);
  await fsp.writeFile(path.join(base, 'can', 'K', 'K_20200101T080020Z_1.log.xz'), execFileSync('xz', ['-1', '-c'], { input: `${lines.join('\n')}\n` }));
  const idx = createCanIndex({ canDir: path.join(base, 'can'), dir: path.join(base, 'idx') });
  const r = await idx.indexLog('K', 'K_20200101T080020Z_1.log.xz');
  assert.equal(r.frames, 43, 'the =1+1 line is not a frame');
  const file = path.join(base, 'idx', 'K', '20200101T0800.json.gz');
  const stored = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
  assert.equal(stored.enc, 'c1');
  assert.equal(stored.act, 'd', '50 km/h: driving');
  assert.ok(!Object.keys(stored.ids).some((k) => k.startsWith('=')));
  const s = await idx.series(['K'], T0 + 59_000, T0 + 60_500, ['BattVoltage132']);
  assert.deepEqual(s.BattVoltage132.map((p) => p[0] - T0), [59_960, 59_980, 60_100]);
});

test('repack: older minute files are written again as columns with the same content, once per car key', { skip }, async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'canfmt-'));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  await fsp.mkdir(path.join(base, 'can', 'K'), { recursive: true });
  const lines = [];
  for (let i = 0; i < 900; i++) lines.push(volts(T0 + i * 100, 380 + (i % 7)), line(T0 + i * 100, '6E3', `${(i & 0xff).toString(16).padStart(2, '0')}00`));
  await fsp.writeFile(path.join(base, 'can', 'K', 'K_20200101T080000Z_1.log.xz'), execFileSync('xz', ['-1', '-c'], { input: `${lines.join('\n')}\n` }));
  const idx = createCanIndex({ canDir: path.join(base, 'can'), dir: path.join(base, 'idx'), autoRepack: false });
  await idx.kick();
  const series = await idx.series(['K'], T0, T0 + 90_000, null);
  const raw = await idx.raw(['K'], T0, T0 + 90_000);
  // as an older version wrote them: point lists, no enc, no act
  const dirK = path.join(base, 'idx', 'K');
  for (const f of fs.readdirSync(dirK).filter((x) => x.endsWith('.json.gz'))) {
    const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dirK, f))).toString());
    if (f.endsWith('.raw.json.gz')) { fmt.decodeRaw(data); fs.writeFileSync(path.join(dirK, f), zlib.gzipSync(JSON.stringify(data))); } else {
      fmt.decodeMinute(data);
      delete data.act;
      fs.writeFileSync(path.join(dirK, f), zlib.gzipSync(JSON.stringify(data)));
    }
  }
  const older = createCanIndex({ canDir: path.join(base, 'can'), dir: path.join(base, 'idx'), autoRepack: false });
  assert.deepEqual(await older.series(['K'], T0, T0 + 90_000, null), series, 'the older layout reads the same');
  assert.equal((await fmt.readHead(path.join(dirK, '20200101T0800.json.gz'))).act, undefined);
  assert.equal(await older.repack(), 4, 'two minutes, each with its raw file');
  assert.equal(await older.repack(), 0, 'once');
  assert.deepEqual(await older.series(['K'], T0, T0 + 90_000, null), series);
  assert.deepEqual(await older.raw(['K'], T0, T0 + 90_000), raw);
  assert.equal((await fmt.readHead(path.join(dirK, '20200101T0800.json.gz'))).act, 'n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, 'idx', 'packed.json'), 'utf8')), { K: 'c1' });
});

test('new ids since a date: from per-day summaries, complete however long the history, made again when a day changes', { skip }, async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'canfmt-'));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  await fsp.mkdir(path.join(base, 'can', 'K'), { recursive: true });
  const day = 86_400_000;
  const log = (t0, extra) => {
    const lines = [];
    for (let i = 0; i < 20; i++) { lines.push(volts(t0 + i * 1000, 380)); if (extra) lines.push(line(t0 + i * 1000, extra, '01')); }
    return execFileSync('xz', ['-1', '-c'], { input: `${lines.join('\n')}\n` });
  };
  const nameAt = (ms, seq) => `K_${new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z_${seq}.log.xz`;
  await fsp.writeFile(path.join(base, 'can', 'K', nameAt(T0, 1)), log(T0));
  await fsp.writeFile(path.join(base, 'can', 'K', nameAt(T0 + 20 * day, 2)), log(T0 + 20 * day, '3A1'));
  const idx = createCanIndex({ canDir: path.join(base, 'can'), dir: path.join(base, 'idx') });
  await idx.kick();
  const got = await idx.newIds('K', T0 + 10 * day);
  assert.deepEqual(got.appeared.map((x) => [x.id, x.at, x.seenMinutes]), [['can0:3A1', T0 + 20 * day, 1]]);
  assert.equal(got.idCount, 2);
  assert.equal(got.complete, true);
  assert.ok(fs.existsSync(path.join(base, 'idx', 'K', 'ids-20200101.json')), 'the day summary is kept');
  // a log of that day indexed later: its summary is made again
  await fsp.writeFile(path.join(base, 'can', 'K', nameAt(T0 + 600_000, 3)), log(T0 + 600_000, '3A1'));
  await idx.kick();
  assert.equal(fs.existsSync(path.join(base, 'idx', 'K', 'ids-20200101.json')), false, 'removed when a minute of the day was written');
  const again = await idx.newIds('K', T0 + 10 * day);
  assert.deepEqual(again.appeared, [], '3A1 was there on the first day too');
  assert.deepEqual((await idx.newIds('K', T0 - day)).appeared.map((x) => x.id), ['can0:132', 'can0:3A1']);
});

test('repack keeps a minute from before the per-log records as it was: indexing its log again counts nothing twice', { skip }, async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'canfmt-'));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  await fsp.mkdir(path.join(base, 'can', 'K'), { recursive: true });
  const name = 'K_20200101T080010Z_1.log.xz';
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(volts(T0 + 10_000 + i * 100, 380 + i));
  await fsp.writeFile(path.join(base, 'can', 'K', name), execFileSync('xz', ['-1', '-c'], { input: `${lines.join('\n')}\n` }));
  const idx = createCanIndex({ canDir: path.join(base, 'can'), dir: path.join(base, 'idx'), autoRepack: false });
  await idx.indexLog('K', name, { trust: 'verified' });
  const f = path.join(base, 'idx', 'K', '20200101T0800.json.gz');
  const now = fmt.decodeMinute(JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString()));
  fs.writeFileSync(f, zlib.gzipSync(JSON.stringify({ minute: now.minute, signals: now.signals, ids: now.ids, trust: 'verified' })));
  assert.equal(await idx.repack(), 1);
  const head = await fmt.readHead(f);
  assert.equal(head.logs, undefined, 'still no per-log records');
  assert.equal(head.trust, 'verified');
  await idx.indexLog('K', name, { trust: 'verified' });
  const after = fmt.decodeMinute(JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString()));
  assert.deepEqual(after.ids, { 'can0:132': 30 });
});
