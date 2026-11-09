'use strict';

// Model 3, Y, S and X, each year (server/carModels.js), each decoded with its own
// DBC set (server/canDbc.js PROFILES): the car's VIN on the CAN bus says which,
// a vehicle setting overrides it, and a car whose set changes has its logs
// decoded again. The owner's Model Y decodes as it did before the sets (every
// signal, the same values), plus three messages from opendbc that checked out
// on its frames.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const fmt = require('../server/canFormat');
const { parseDbc, bundledDbc, dbcFor, decodeFrame, PROFILES } = require('../server/canDbc');
const { createCanIndex, FORMAT, CAR_FORMAT } = require('../server/canIndex');
const cars = require('../server/carModels');
const { PAGES, candump, EXPECTED, OPENDBC_PAGES, OPENDBC_EXPECTED } = require('./canModelY');

const skip = spawnSync('xz', ['--version']).status !== 0 && 'needs xz';
const DBC_DIR = path.join(__dirname, '..', 'server', 'dbc');
// the set as it was before the per-car sets: model3dbc and the firmware overrides
const before = parseDbc(`${fs.readFileSync(path.join(DBC_DIR, 'Model3CAN.dbc'), 'utf8')}\n${fs.readFileSync(path.join(DBC_DIR, 'override.dbc'), 'utf8')}\n`);
const decode = (dbc, key, hex) => {
  const msg = dbc.messages.get(parseInt(key.split(':')[1], 16));
  return msg ? Object.fromEntries(decodeFrame(msg, Buffer.from(hex, 'hex')).map(([s, v]) => [s.series, Math.round(v * 1e4) / 1e4])) : {};
};
const T0 = Date.UTC(2026, 10, 8, 1, 28, 0);
const stamp = (t) => `${Math.floor(t / 1000)}.${String(Math.round((t % 1000) * 1000)).padStart(6, '0')}`;
const hexOf = (bytes) => Buffer.from(bytes).toString('hex').toUpperCase();
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
// made-up VINs (no real car's): a 2022 Model Y from Austin, a 2017 Model S from Fremont
const VIN_Y = '7SAYGDEE5NA000001';
const VIN_S = '5YJSA1E25HF000001';
const vin405 = (v) => [hexOf([0x10, 0, 0, 0, 0, ...ascii(v.slice(0, 3))]), hexOf([0x11, ...ascii(v.slice(3, 10))]), hexOf([0x12, ...ascii(v.slice(10, 17))])];
const vin508 = (v) => [hexOf([0, ...ascii(v.slice(0, 7))]), hexOf([1, ...ascii(v.slice(7, 14))]), hexOf([2, ...ascii(v.slice(14, 17)), 0, 0, 0, 0])];

test('the VIN: model, model year and plant; the year letters of 2010 to 2039', () => {
  assert.deepEqual(cars.decodeVin(VIN_Y), { vin: VIN_Y, model: 'Y', year: 2022, plant: 'Tesla US' });
  assert.deepEqual(cars.decodeVin(VIN_S.toLowerCase()), { vin: VIN_S, model: 'S', year: 2017, plant: 'Fremont' });
  assert.equal(cars.decodeVin('LRW3E7FA1RC000001').model, '3');
  assert.equal(cars.decodeVin('LRW3E7FA1RC000001').year, 2024);
  assert.equal(cars.decodeVin('XP7YGCEK0SB000001').plant, 'Berlin');
  assert.equal(cars.decodeVin('XP7YGCEK0SB000001').year, 2025);
  assert.equal(cars.decodeVin('5YJXCAE2XLF000001').model, 'X');
  assert.equal(cars.decodeVin('5YJXCAE2XLF000001').year, 2020);
  for (const bad of ['', '5YJSA1E25HF00000', '5YJSA1E25HF0000O1', 'not a vin at all!']) assert.equal(cars.decodeVin(bad), null, bad);
  const years = { L: 2020, M: 2021, N: 2022, P: 2023, R: 2024, S: 2025, T: 2026, V: 2027, W: 2028, X: 2029, Y: 2030, 1: 2031, A: 2010, H: 2017, C: 2012 };
  for (const [c, y] of Object.entries(years)) assert.equal(cars.yearOf(c), y, c);
  for (const c of ['I', 'O', 'Q', 'U', 'Z', '0']) assert.equal(cars.yearOf(c), null, c);
  assert.equal(cars.maskVin(VIN_Y), '7SAYGDEE5NA******', 'the API shows no serial number');
});

test('the VIN from the frames: 0x405 (Model 3/Y, 2021+ S/X) and 0x508 (legacy S/X), in any order', () => {
  const a = cars.vinCollector();
  const [p0, p1, p2] = vin405(VIN_Y);
  assert.equal(a.add(0x405, Buffer.from(p2, 'hex')), null);
  assert.equal(a.add(0x405, Buffer.from('0300000000000000', 'hex')), null, 'not a VIN page');
  assert.equal(a.add(0x405, Buffer.from(p0, 'hex')), null);
  assert.deepEqual(a.add(0x405, Buffer.from(p1, 'hex')), { vin: VIN_Y, model: 'Y', year: 2022, plant: 'Tesla US', via: '0x405' });
  const b = cars.vinCollector();
  for (const p of vin508(VIN_S)) b.add(0x508, Buffer.from(p, 'hex'));
  assert.equal(b.vin.model, 'S');
  assert.equal(b.vin.via, '0x508');
});

test('which car, which generation, which DBC set: Automatic follows the VIN, a setting wins', () => {
  const y = { ...cars.decodeVin(VIN_Y), via: '0x405' };
  const r = cars.resolveCar(undefined, y);
  assert.deepEqual([r.model, r.year, r.generation, r.profile, r.source], ['Y', 2022, 'Y-2020', 'tesla-3y', 'vin']);
  assert.equal(cars.resolveCar({ model: 'auto' }, { ...y, year: 2025 }).generation, 'Y-2025', 'Juniper');
  assert.equal(cars.resolveCar({ model: 'auto' }, { ...cars.decodeVin('LRW3E7FA1RC000001'), via: '0x405' }).generation, '3-2024', 'Highland');
  // a Model S or X: 0x508 is a legacy car whatever its year, 0x405 a refreshed one
  const s = { ...cars.decodeVin(VIN_S), via: '0x508' };
  assert.deepEqual([cars.resolveCar({}, s).generation, cars.resolveCar({}, s).profile], ['S-2015', 'tesla-sx-legacy']);
  assert.equal(cars.resolveCar({}, { ...s, year: 2021 }).generation, 'S-2015', 'a 2021 model year sending 0x508: legacy');
  assert.equal(cars.resolveCar({}, { ...s, year: 2021, via: '0x405' }).generation, 'S-2021');
  assert.equal(cars.resolveCar({}, { ...s, year: 2021, via: '0x405' }).profile, 'tesla-3y');
  assert.equal(cars.resolveCar({}, { ...s, year: 2013 }).generation, 'S-2012');
  assert.equal(cars.resolveCar({}, { ...cars.decodeVin('5YJXCAE2XLF000001'), via: '0x508' }).profile, 'tesla-sx-legacy');
  // the setting: a model and a year win over the VIN; a model alone takes the VIN's year when it is that model
  assert.deepEqual(Object.values(cars.normalizeCar({ model: 'S', generation: 'S-2012' })), ['S', 'S-2012']);
  assert.deepEqual(Object.values(cars.normalizeCar({ model: 'S', generation: 'Y-2020' })), ['S', 'auto'], 'another model\'s year');
  assert.deepEqual(Object.values(cars.normalizeCar({ model: 'Roadster' })), ['auto', 'auto']);
  const set = cars.resolveCar({ model: 'S', generation: 'S-2012' }, y);
  assert.deepEqual([set.model, set.generation, set.profile, set.source], ['S', 'S-2012', 'tesla-sx-legacy', 'setting']);
  assert.equal(cars.resolveCar({ model: 'Y' }, y).generation, 'Y-2020');
  assert.equal(cars.resolveCar({ model: 'S' }, y).generation, null, 'not the car the VIN says: no year');
  assert.equal(cars.resolveCar({ model: 'S' }, y).profile, 'tesla-3y');
  // nothing known: the Model 3/Y set (the one checked on a real car)
  assert.deepEqual([cars.resolveCar(null, null).model, cars.resolveCar(null, null).profile, cars.resolveCar(null, null).source], [null, 'tesla-3y', 'default']);
  // every generation's set exists
  for (const g of Object.values(cars.GENERATIONS).flat()) assert.ok(Object.hasOwn(PROFILES, g.profile), g.id);
  assert.deepEqual(cars.choices().map((c) => c.id), ['3', 'Y', 'S', 'X']);
});

test('the owner\'s Model Y: every signal decodes as before the per-car sets, the same names and values', () => {
  const now = bundledDbc();
  assert.equal(dbcFor('tesla-3y'), now);
  // every message of before is there unchanged (bus, signals, series names, value names, comments)
  for (const [id, msg] of before.messages) assert.deepEqual(now.messages.get(id), msg, `0x${id.toString(16)}`);
  const added = [...now.messages.keys()].filter((id) => !before.messages.has(id)).sort((a, b) => a - b);
  assert.deepEqual(added, [0x343, 0x370, 0x488]);
  // the car's frames: the same values, signal for signal (and the popular stats' values among them)
  let seen = 0;
  for (const [key, pages] of Object.entries(PAGES)) {
    for (const hex of pages) {
      assert.deepEqual(decode(now, key, hex), decode(before, key, hex), `${key} ${hex}`);
      seen++;
    }
  }
  assert.ok(seen > 30);
  for (const [name, want] of Object.entries(EXPECTED)) {
    const got = Object.entries(PAGES).flatMap(([k, ps]) => ps.map((h) => decode(now, k, h)[name])).find((v) => v !== undefined);
    if (got !== undefined) assert.ok(Math.abs(got - want) < 0.01, `${name}: ${got} (want ${want})`);
  }
});

test('the opendbc messages on the owner\'s Model Y: steering, Autopilot request, 12 V supply, each sensible parked', () => {
  const now = bundledDbc();
  const got = {};
  for (const [key, pages] of Object.entries(OPENDBC_PAGES)) {
    // each frame's checksum is opendbc's Tesla checksum (the bytes and the id added up): these are those messages
    const id = parseInt(key.split(':')[1], 16);
    const at = { 0x370: 7, 0x488: 3 }[id];
    for (const hex of pages) {
      const b = Buffer.from(hex, 'hex');
      if (at !== undefined) {
        let sum = (id & 0xFF) + (id >> 8);
        b.forEach((x, i) => { if (i !== at) sum += x; });
        assert.equal(sum & 0xFF, b[at], `${key} ${hex}`);
      }
    }
    Object.assign(got, decode(now, key, pages[0]));
    // on its own bus only (0x370 and 0x488 came on the chassis bus, 0x343 on the vehicle bus)
    assert.equal(now.messages.get(id).bus, key.startsWith('can1') ? 'ChassisBus' : 'VehicleBus');
  }
  for (const [name, want] of Object.entries(OPENDBC_EXPECTED)) assert.ok(Math.abs(got[name] - want) < 1e-3, `${name}: ${got[name]} (want ${want})`);
  // the angles agree with each other within a few degrees (the wheel parked about 4-6 degrees off centre)
  assert.ok(Math.abs(got.EPAS3S_internalSAS - got.DAS_steeringAngleRequest) < 1);
  // and the 12 V supply with the 12 V battery's own reading (0x261 page 1: 15.77 V)
  assert.ok(Math.abs(got.VCRIGHT_vbatProt - EXPECTED.v12vBattVoltage261) < 0.2);
  assert.equal(got.VCRIGHT_pcbaTemperature, undefined, 'left out: it read -39 C in a 2 C garage');
});

test('a legacy Model S set: opendbc\'s chassis and powertrain files and the OVMS messages, the speed in km/h', () => {
  const s = dbcFor('tesla-sx-legacy');
  assert.deepEqual(s.buses, { can0: 'PowertrainBus', can1: 'ChassisBus' });
  const v = (id, hex) => Object.fromEntries(decodeFrame(s.messages.get(id), Buffer.from(hex, 'hex')).map(([g, x]) => [g.series, Math.round(x * 1000) / 1000]));
  // 0x116 DI_torque2: gear D (4), 50 mph (raw 1500 at 0.05 mph from -25 mph) -> 80.467 km/h
  const speed = 1500;
  assert.deepEqual([v(0x116, hexOf([0, 0x40, speed & 0xFF, speed >> 8, 0, 0])).DI_gear_116, v(0x116, hexOf([0, 0x40, speed & 0xFF, speed >> 8, 0, 0])).DI_vehicleSpeed_116], [4, 80.467]);
  assert.equal(s.messages.get(0x116).signals.find((g) => g.name === 'DI_vehicleSpeed').unit, 'kph');
  // 0x302 SOC 81.3 % (bits 10-19), 0x102 351.27 V, 0x338 ideal 230 mi / rated 210 mi, 0x5D8 12,345.678 mi
  const soc = 813;
  assert.equal(v(0x302, hexOf([0, (soc & 0x3F) << 2, soc >> 6, 0, 0, 0, 0, 0])).SOCUI302, 81.3);
  assert.equal(v(0x102, hexOf([0x37, 0x89, 0, 0, 0, 0, 0, 0])).BattVoltage102, 351.27);
  assert.deepEqual(v(0x338, hexOf([230, 0, 210, 0, 0x2C, 0x01, 0, 0])), { IdealRange338: 230, RatedRange338: 210, RatedConsumption338: 300 });
  assert.equal(v(0x5D8, hexOf([0x4E, 0x61, 0xBC, 0x00, 0, 0, 0, 0])).Odometer5D8, 12345.678);
  // 0x6F2 page 0: four brick voltages, 0.000305 V a step (3.9 V is 12787)
  const b = 12787;
  const page = Buffer.alloc(8);
  let bits = BigInt(b) | (BigInt(b) << 14n) | (BigInt(b) << 28n) | (BigInt(b) << 42n);
  for (let i = 1; i < 8; i++) { page[i] = Number(bits & 0xFFn); bits >>= 8n; }
  const p0 = v(0x6F2, page.toString('hex'));
  assert.deepEqual([p0.BrickVoltage1_6F2, p0.BrickVoltage4_6F2, p0.BrickVoltage5_6F2], [3.9, 3.9, undefined]);
  // the one clash (0x338 is the range on the powertrain bus) is the OVMS one
  assert.equal(s.messages.get(0x338).bus, 'PowertrainBus');
  // the Model 3/Y messages are not in it (0x405 VIN, 0x292 SOC)
  assert.equal(s.messages.get(0x292), undefined);
});

async function setup(logs) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'canmodels-'));
  for (const [key, name, text, side] of logs) {
    await fsp.mkdir(path.join(base, 'can', key), { recursive: true });
    await fsp.writeFile(path.join(base, 'can', key, name), execFileSync('xz', ['-1', '-c'], { input: text }));
    if (side) await fsp.writeFile(path.join(base, 'can', key, `${name}.json`), JSON.stringify(side));
  }
  return base;
}
const lines = (rows) => `${['# canbridge v1', ...rows.map(([t, bus, id, hex]) => `(${stamp(t)}) ${bus} ${id}#${hex}`)].join('\n')}\n`;

test('a legacy Model S\'s log: its VIN picks the legacy set, the log is decoded again with it; a setting changes it back', { skip }, async () => {
  const soc = 813;
  const rows = [];
  for (let i = 0; i < 30; i++) {
    const t = T0 + i * 100;
    rows.push([t, 'can0', '508', vin508(VIN_S)[i % 3]]);
    rows.push([t, 'can0', '302', hexOf([0, (soc & 0x3F) << 2, soc >> 6, 0, 0, 0, 0, 0])]);
    rows.push([t, 'can0', '116', hexOf([0, 0x10, 500 & 0xFF, 500 >> 8, 0, 0])]); // P, 0 mph
  }
  const base = await setup([['S1', 'S1_20261108T012800Z_1.log.xz', lines(rows)]]);
  try {
    const dir = path.join(base, 'idx');
    const setting = {};
    let idx = null;
    const profileOf = async (key) => cars.resolveCar(setting[key], await idx.carOf(key)).profile;
    idx = createCanIndex({ canDir: path.join(base, 'can'), dir, profileOf });
    await idx.kick();
    assert.equal((await idx.carOf('S1')).model, 'S');
    assert.equal((await idx.carOf('S1')).via, '0x508');
    assert.equal(await idx.profileFor('S1'), 'tesla-sx-legacy');
    const done = JSON.parse(fs.readFileSync(path.join(dir, 'done.json'), 'utf8'));
    assert.match(done['S1/S1_20261108T012800Z_1.log.xz'], new RegExp(`/${FORMAT}/tesla-sx-legacy$`), 'decoded again with its own set');
    const s = await idx.series(['S1'], T0, T0 + 3000);
    assert.equal(s.SOCUI302.at(-1)[1], 81.3);
    assert.equal(s.DI_vehicleSpeed_116.at(-1)[1], 0);
    assert.equal(s.SOCUI292, undefined);
    const meta = await idx.signals(['S1']);
    assert.equal(meta.SOCUI302.fmt, `${FORMAT}/tesla-sx-legacy`);
    assert.equal(meta.DI_vehicleSpeed_116.unit, 'kph');
    const m = await fmt.readMinuteFile(path.join(dir, 'S1', '20261108T0128.json.gz'));
    assert.deepEqual(Object.values(m.logs).map((p) => p.fmt), [`${FORMAT}/tesla-sx-legacy`]);
    assert.deepEqual(await idx.pendingLogs(), [], 'nothing left to do');
    // the owner says it is a Model 3 after all: decoded again with the Model 3/Y set (nothing of the legacy one stays)
    setting.S1 = { model: '3', generation: '3-2017' };
    assert.equal((await idx.pendingLogs()).length, 1);
    await idx.kick();
    const after = await idx.series(['S1'], T0, T0 + 3000);
    assert.equal(after.SOCUI302, undefined);
    assert.equal((await idx.signals(['S1'])).SOCUI302, undefined);
    assert.match(JSON.parse(fs.readFileSync(path.join(dir, 'done.json'), 'utf8'))['S1/S1_20261108T012800Z_1.log.xz'], new RegExp(`/${FORMAT}$`));
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('the owner\'s Model Y in the index: the same series as the set before, plus the opendbc ones; its VIN keeps the stamps as they were', { skip }, async () => {
  const side = { bus: { can0: 'vehicle', can1: 'chassis', can3: 'screenmate-internal' } };
  const all = { ...PAGES, ...OPENDBC_PAGES, 'can0:405': vin405(VIN_Y) };
  const base = await setup([['Y1', 'Y1_20261108T012800Z_1.log.xz', candump(T0, 100, all), side], ['Y0', 'Y0_20261108T012800Z_1.log.xz', candump(T0, 100, all), side]]);
  try {
    let idx = null;
    const profileOf = async (key) => cars.resolveCar(undefined, await idx.carOf(key)).profile;
    idx = createCanIndex({ canDir: path.join(base, 'can'), dir: path.join(base, 'idx'), profileOf, dbc: (p) => (p === 'old' ? before : dbcFor(p)) });
    await idx.kick();
    const car = await idx.carOf('Y1');
    assert.deepEqual([car.model, car.year, car.via], ['Y', 2022, '0x405']);
    assert.equal(await idx.profileFor('Y1'), 'tesla-3y');
    const done = JSON.parse(fs.readFileSync(path.join(base, 'idx', 'done.json'), 'utf8'));
    assert.match(done['Y1/Y1_20261108T012800Z_1.log.xz'], new RegExp(`/${FORMAT}/\\d+-\\d+$`), 'no set in the stamp: the default one');
    // the same log decoded with the set of before (key Y0)
    const old = createCanIndex({ canDir: path.join(base, 'can'), dir: path.join(base, 'idx-old'), dbc: () => before });
    await old.kick();
    const now = await idx.series(['Y1'], T0, T0 + 10_000);
    const was = await old.series(['Y0'], T0, T0 + 10_000);
    for (const [name, pts] of Object.entries(was)) assert.deepEqual(now[name], pts, name);
    const extra = Object.keys(now).filter((n) => !Object.hasOwn(was, n)).sort();
    assert.ok(extra.length > 0 && extra.every((n) => /^(EPAS3S_|DAS_steering|VCRIGHT_(5AVoltage|loadShedPriority|rearDefrostState|vbatProt|mirrorHeatState|OTAState|footwellLightCurrent))/.test(n)), extra.join(','));
    assert.equal(CAR_FORMAT, 'r2', 'the sync and the gap check keep their answers');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});
