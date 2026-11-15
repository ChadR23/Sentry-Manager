'use strict';

// CAN fixtures for the lean backend's CAN area (lean/tests/can_parity.rs):
// a data folder of CAN Bridge logs (both formats, several cars, broken and
// cut-off logs, an internal GPS bus, a VIN, a legacy Model S), indexed by
// the Node code (server/canIndex.js), and what the Node code answers about it.
//
//   node lean/parity/canFixtures.js <out>
//
// <out>/can/                the logs (inputs; nothing changes them)
// <out>/node-1/             the Node index after indexing everything
// <out>/node-2/             ... after one log is taken out again (removeLog)
// <out>/answers.json        { phase1: {...}, phase2: {...} }: the reads, as JSON
//
// Everything is made the same way every run (a seeded generator, fixed times).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const { createCanIndex } = require(path.join(REPO, 'server/canIndex'));
const { encodeColumns } = require(path.join(REPO, 'test/fixtures/columnsEncode'));
const fmt = require(path.join(REPO, 'server/canFormat'));

const out = process.argv[2];
if (!out) { console.error('usage: canFixtures.js <out>'); process.exit(2); }
fs.rmSync(out, { recursive: true, force: true });
const CAN = path.join(out, 'can');

// a seeded generator (mulberry32)
let seed = 0x5eed;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const hex2 = (n) => (n & 0xff).toString(16).padStart(2, '0').toUpperCase();
const bytesHex = (b) => b.map(hex2).join('');
/** Little-endian bits into a payload. */
function put(b, start, len, raw) {
  for (let i = 0; i < len; i++) { const bit = start + i; if (Math.floor(raw / 2 ** i) % 2) b[bit >> 3] |= 1 << (bit & 7); }
}
const line = (us, bus, id, payload) => `(${Math.floor(us / 1e6)}.${String(us % 1e6).padStart(6, '0')}) ${bus} ${id}#${payload}`;

/** One drive: `secs` seconds from `t0` (UTC ms), a frame mix like a Model 3/Y's. */
function drive(t0, secs, { internalGps = false, vin = null, legacy = false } = {}) {
  const lines = ['# canbridge v1 app=fixture', `# clock wall=${(t0 / 1000).toFixed(6)} mono_ns=1`];
  const vinParts = vin ? [[0x10, 0, 0, 0, 0, ...Buffer.from(vin.slice(0, 3))], [0x11, ...Buffer.from(vin.slice(3, 10))], [0x12, ...Buffer.from(vin.slice(10, 17))]] : [];
  for (let ms = 0; ms < secs * 1000; ms += 10) {
    const us = t0 * 1000 + ms * 1000 + Math.floor(rnd() * 900);
    const s = ms / 1000;
    const kph = Math.max(0, Math.min(140, 30 + 25 * Math.sin(s / 7) + rnd() * 0.3));
    if (ms % 20 === 0) { // 0x257 DI_speed: DI_vehicleSpeed 12|12 (0.08,-40)
      const b = [0, 0, 0, 0, 0, 0, 0, 0];
      put(b, 12, 12, Math.round((kph + 40) / 0.08));
      lines.push(line(us, 'can0', legacy ? '116' : '257', bytesHex(b)));
    }
    if (ms % 100 === 0) { // 0x118 DriveSystemStatus: DI_gear 21|3, DI_accelPedalPos 32|8 (0.4)
      const b = [0, 0, 0, 0, 0, 0, 0, 0];
      put(b, 21, 3, s < 2 ? 1 : 4);
      put(b, 32, 8, Math.round(Math.max(0, Math.min(100, 20 + 18 * Math.sin(s / 3))) / 0.4));
      lines.push(line(us + 1, 'can0', '118', bytesHex(b)));
    }
    if (ms % 50 === 0) { // 0x39D IBST_status (chassis): IBST_driverBrakeApply 16|2
      const b = [0, 0, 0, 0, 0];
      put(b, 16, 2, Math.floor(s / 4) % 3 === 0 ? 2 : 1);
      lines.push(line(us + 2, 'can1', '39D', bytesHex(b)));
    }
    if (ms % 100 === 0) { // 0x3F5 VCFRONT_lighting: turn signals 50|2, 52|2
      const b = [0, 0, 0, 0, 0, 0, 0, 0];
      const on = Math.floor(s / 0.7) % 2 === 1 && Math.floor(s / 10) % 2 === 0;
      put(b, 50, 2, on ? 1 : 0);
      lines.push(line(us + 3, 'can0', '3F5', bytesHex(b)));
    }
    if (ms % 10 === 0) { // 0x129 SteeringAngle 16|14 (0.1,-819.2), 100 Hz
      const b = [Math.floor(ms / 10) & 0xff, 0, 0, 0, 0, 0, 0, 0];
      put(b, 16, 14, Math.round((15 * Math.sin(s / 2) + 819.2) / 0.1));
      lines.push(line(us + 4, 'can0', '129', bytesHex(b)));
    }
    if (ms % 100 === 0) { // 0x04F GPS (chassis, or the Screenmate's own on can3)
      const b = [0, 0, 0, 0, 0, 0, 0, 0].map(() => Math.floor(rnd() * 256));
      lines.push(line(us + 5, internalGps && s > secs / 3 ? 'can3' : 'can1', '04F', bytesHex(b)));
      if (internalGps) lines.push(line(us + 6, 'can3', '3D9', `0${Math.floor(rnd() * 4)}000000`));
    }
    if (ms % 1000 === 0) { // unknown ids, a constant one, the VIN, a dup-named message
      lines.push(line(us + 7, 'can0', '6E3', `${hex2(ms / 1000)}0000${s > 5 ? '01' : '00'}`));
      lines.push(line(us + 8, 'can1', '7FF', '0102030405060708'));
      lines.push(line(us + 9, 'can0', '353', bytesHex([0, 0, 0, 0, 0, Math.floor(rnd() * 256), 0, 0])));
      lines.push(line(us + 10, 'can2', '123', bytesHex([1, 2, 3])));
      if (vinParts.length) lines.push(line(us + 11, 'can0', '405', bytesHex(vinParts[(ms / 1000) % 3])));
    }
    if (ms % 200 === 0) { // 0x132 HVBattAmpVolt: BattVoltage132 0|16 (0.01), SmoothBattCurrent132 16|16 signed (-0.1)
      const b = [0, 0, 0, 0, 0, 0, 0, 0];
      put(b, 0, 16, Math.round((390 + rnd()) / 0.01));
      put(b, 16, 16, (Math.round(rnd() * 300) + 65536) % 65536);
      lines.push(line(us + 12, 'can0', '132', bytesHex(b)));
    }
  }
  lines.push(`# clock wall=${((t0 + secs * 1000) / 1000).toFixed(6)} mono_ns=2 end`);
  return lines;
}

const xz = (text) => execFileSync('xz', ['-1', '-c'], { input: text, maxBuffer: 1 << 28 });
function writeLog(key, name, lines, { columns = false, side = null } = {}) {
  fs.mkdirSync(path.join(CAN, key), { recursive: true });
  const body = columns ? encodeColumns(lines) : Buffer.from(`${lines.join('\n')}\n`, 'latin1');
  fs.writeFileSync(path.join(CAN, key, name), xz(body));
  if (side) fs.writeFileSync(path.join(CAN, key, `${name}.json`), JSON.stringify(side));
}

const T = Date.UTC(2026, 10, 8, 14, 30, 0); // 2026-11-08 14:30 UTC
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
const name = (key, ms, seq) => `${key}_${stamp(ms)}_${seq}.log.xz`;

// CAR1: a drive over three minutes (one log a minute, the second as columns), one starting mid-minute
const car1 = [];
for (let k = 0; k < 3; k++) {
  const t0 = T + k * 60_000;
  const lines = drive(t0, 60, { vin: k === 0 ? '7SAYGDEE2NA000001' : null });
  const nm = name('CAR1', t0, k + 1);
  writeLog('CAR1', nm, lines, { columns: k === 1, side: { format: k === 1 ? 'canbridge-columns-xz/2' : 'canbridge-candump-xz/1', frames: lines.length - 3, closed_because: 'rotate', app_version: '1.0' } });
  car1.push(nm);
}
// a second log in the first minute (another seq, its own span) and one straddling two minutes
{
  const t0 = T + 20_000;
  writeLog('CAR1', name('CAR1', t0, 9), drive(t0, 5).map((l) => l.replace(' can0 6E3#', ' can0 6E4#')));
  const t1 = T + 3 * 60_000 + 30_000;
  writeLog('CAR1', name('CAR1', t1, 4), drive(t1, 50, { internalGps: true }), { side: { bus: { can0: 'vehicle', can1: 'chassis', can3: 'screenmate-internal' }, frames: 1 } });
}
// odd lines: too long, garbage, out of order, lowercase hex, bad interface names, a cut-off log
{
  const t0 = T + 5 * 60_000;
  const lines = drive(t0, 8);
  lines.splice(50, 0, `(${t0 / 1000}.000001) can0 257#${'0'.repeat(600)}`, 'garbage line', '(1.2) can0 xyz#00', `(${t0 / 1000 + 3}.5) 9bad 101#00`, `(${t0 / 1000 + 3}.5) can0 2e5#0a0b`, `(${t0 / 1000 - 70}.000000) can0 257#00a0000000000000`);
  writeLog('CAR1', name('CAR1', t0, 5), lines);
  const cut = xz(Buffer.from(`${drive(T + 6 * 60_000, 20).join('\n')}\n`));
  fs.writeFileSync(path.join(CAN, 'CAR1', name('CAR1', T + 6 * 60_000, 6)), cut.subarray(0, Math.floor(cut.length * 0.6)));
  fs.writeFileSync(path.join(CAN, 'CAR1', name('CAR1', T + 7 * 60_000, 7)), Buffer.from('not xz at all'));
  // a columns body that is malformed (refused)
  const bad = encodeColumns(drive(T + 8 * 60_000, 2));
  fs.writeFileSync(path.join(CAN, 'CAR1', name('CAR1', T + 8 * 60_000, 8)), xz(bad.subarray(0, bad.length - 5)));
}
// LEGACY: a Model S (its own DBC set), with a VIN in 0x508 style unknown here; K2: the bridge's own test file
writeLog('LEGACY', name('LEGACY', T, 1), drive(T, 30, { legacy: true }));
fs.mkdirSync(path.join(CAN, 'K2'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'test/fixtures/columns-sample.log.xz'), path.join(CAN, 'K2', 'K2_20261108T005818Z_1.log.xz'));
fs.mkdirSync(path.join(CAN, 'K3'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'test/fixtures/columns-sample.candump.log.xz'), path.join(CAN, 'K3', 'K3_20261108T005818Z_1.log.xz'));

const profileOf = async (key) => (key === 'LEGACY' ? 'tesla-sx-legacy' : 'tesla-3y');

function copyDir(a, b) {
  fs.mkdirSync(b, { recursive: true });
  for (const e of fs.readdirSync(a, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(a, e.name), path.join(b, e.name));
    else fs.copyFileSync(path.join(a, e.name), path.join(b, e.name));
  }
}

async function reads(idx) {
  const o = {};
  const keys = ['CAR1', 'LEGACY', 'K2', 'K3'];
  o.status = (({ indexed, pending, running }) => ({ indexed, pending, running }))(idx.status());
  o.minuteTimes = {};
  for (const k of keys) o.minuteTimes[k] = await idx.minuteTimes(k);
  o.signals = {};
  for (const k of keys) o.signals[k] = await idx.signals([k]);
  o.clips = [];
  const windows = [[T - 2000, T + 70_000], [T + 50_000, T + 130_000], [T + 3 * 60_000 + 25_000, T + 4 * 60_000 + 40_000], [T + 5 * 60_000, T + 6 * 60_000 + 30_000]];
  for (const [a, b] of windows) {
    o.clips.push(await idx.clipData(['CAR1'], a, b, ['DI_vehicleSpeed', 'IBST_driverBrakeApply', 'GPSLatitude04F', 'UI_cpuTemperature_353', 'nope']));
    const changing = new Set();
    const every = await idx.clipData(['CAR1'], a, b, null, { step: 250, dropRepeats: true, changing });
    o.clips.push({ ...every, changing: [...changing] });
    o.clips.push(await idx.clipData(['CAR1'], a, b, null, { step: 1000 }));
  }
  o.clips.push(await idx.clipData(['CAR1', 'LEGACY'], T, T + 40_000, ['DI_vehicleSpeed', 'DI_vehicleSpeed_116', 'DI_gear']));
  o.clips.push(await idx.clipData(['K2'], Date.UTC(2026, 10, 8, 0, 58, 0), Date.UTC(2026, 10, 8, 1, 0, 0), null));
  o.raw = [];
  for (const [a, b] of windows) o.raw.push(await idx.raw(['CAR1'], a, b));
  o.raw.push(await idx.raw(['K2', 'K3'], Date.UTC(2026, 10, 8, 0, 58, 0), Date.UTC(2026, 10, 8, 1, 0, 0)));
  o.idSummary = {};
  for (const k of keys) o.idSummary[k] = await idx.idSummary(k, -Infinity, Infinity);
  o.idSummaryRange = await idx.idSummary('CAR1', T + 60_000, T + 3 * 60_000);
  o.newIds = [];
  for (const [k, since] of [['CAR1', T], ['CAR1', T + 3 * 60_000], ['K2', 0], ['LEGACY', T + 3600_000]]) o.newIds.push(await idx.newIds(k, since));
  o.names = ['can0:257', 'can1:257', 'can1:04F', 'can3:04F', 'can0:6E3', 'can0:2B4', 'can0:116'].map((id) => [idx.messageName(id), idx.messageName(id, { can0: 'VehicleBus', can3: 'x' }, ['can3']), idx.messageName(id, undefined, [], 'tesla-sx-legacy')]);
  o.heads = {};
  for (const k of keys) for (const t of await idx.minuteTimes(k)) o.heads[`${k}/${t}`] = await fmt.readHead(path.join(idx === null ? '' : DIRS.cur, k, `${new Date(t).toISOString().slice(0, 16).replace(/[-:]/g, '')}.json.gz`));
  o.cars = {};
  for (const k of keys) { const c = await idx.carOf(k); o.cars[k] = c ? { ...c, seenAt: 0 } : null; }
  return o;
}
const DIRS = { cur: path.join(out, 'idx') };

(async () => {
  const idx = createCanIndex({ canDir: CAN, dir: DIRS.cur, profileOf, idle: () => true });
  await idx.kick();
  const phase1 = await reads(idx);
  phase1.lastError = idx.status().lastError;
  copyDir(DIRS.cur, path.join(out, 'node-1'));
  const removed = await idx.removeLog('CAR1', car1[0]);
  await idx.repack();
  const phase2 = { removed, ...(await reads(idx)) };
  copyDir(DIRS.cur, path.join(out, 'node-2'));
  fs.rmSync(DIRS.cur, { recursive: true, force: true });
  fs.writeFileSync(path.join(out, 'answers.json'), JSON.stringify({ T, car1, phase1, phase2 }));
  console.log(JSON.stringify({ ok: true, out }));
})().catch((err) => { console.error(err); process.exit(1); });
