'use strict';

// Decoding a 2026 Model Y's frames right (test/canModelY.js: its own frames):
// the firmware overrides (server/dbc/override.dbc) over model3dbc, frames
// decoded only on a bus the bus map names, and a series per message for a
// signal name two messages share. Each of these made every stat flip from
// one second (or clip) to the next: the pages of a message read with one
// layout, can1 and can3 frames of an id read as can0's, two messages' values
// in one series. An index written before (r1) is decoded again.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync, spawnSync } = require('child_process');
const { bundledDbc, decodeFrame } = require('../server/canDbc');
const { createCanIndex, busMapOf, FORMAT } = require('../server/canIndex');
const { PAGES, candump, EXPECTED } = require('./canModelY');

const skip = spawnSync('xz', ['--version']).status !== 0 && 'needs xz';
const near = (a, b, eps = 0.006) => Math.abs(a - b) < eps;
const decode = (id, hex) => Object.fromEntries(decodeFrame(bundledDbc().messages.get(id), Buffer.from(hex, 'hex')).map(([s, v]) => [s.series, Math.round(v * 1e4) / 1e4]));

test('the overrides: every page of 0x243, 0x261, 0x352 and 0x219 reads right, or not at all', () => {
  // 0x243: page 4 is not page 0 (that read 132 C)
  const cabin = PAGES['can0:243'].map((h) => decode(0x243, h).VCRIGHT_hvacCabinTempEst).filter((v) => v !== undefined);
  assert.deepEqual(cabin, [22.5]);
  // 0x261: page 5 is not page 1 (that read 3.6 V)
  const volts = PAGES['can0:261'].map((h) => decode(0x261, h).v12vBattVoltage261).filter((v) => v !== undefined);
  assert.equal(volts.length, 1);
  assert.ok(near(volts[0], 15.77, 0.01), `12 V: ${volts}`);
  // 0x352: full pack, remaining and ideal on page 0; buffer, expected and to-complete on page 1
  const e0 = decode(0x352, PAGES['can0:352'][0]);
  assert.deepEqual([e0.BMS_nominalFullPackEnergy, e0.BMS_nominalEnergyRemaining, e0.BMS_idealEnergyRemaining, e0.BMS_fullChargeComplete], [67.54, 59.92, 59.7, 1]);
  const e1 = decode(0x352, PAGES['can0:352'][1]);
  assert.deepEqual([e1.BMS_energyBuffer, e1.BMS_expectedEnergyRemaining, e1.BMS_energyToChargeComplete], [3.04, 59.7, 1.18]);
  for (const h of PAGES['can0:352'].slice(2)) assert.deepEqual(Object.keys(decode(0x352, h)), ['BMS_energyStatusIndex'], 'pages 2 and 3: not known, not read');
  assert.ok(near(e0.BMS_nominalEnergyRemaining / e0.BMS_nominalFullPackEnergy * 100, EXPECTED.SOCUI292, 0.1), 'agrees with the SOC');
  // 0x219: the pressures on page 5, the recommended ones on page 4, on the vehicle bus
  const tpms = bundledDbc().messages.get(0x219);
  assert.equal(tpms.bus, 'VehicleBus');
  const p5 = decode(0x219, PAGES['can0:219'][5]);
  assert.deepEqual([p5.VCSEC_TPMSPressure0, p5.VCSEC_TPMSPressure1, p5.VCSEC_TPMSPressure2, p5.VCSEC_TPMSPressure3], [2.575, 2.55, 2.5, 2.5]);
  assert.equal(decode(0x219, PAGES['can0:219'][4]).VCSEC_TPMSRecommendedPressure0, 2.9);
  for (const h of PAGES['can0:219'].slice(0, 4)) assert.equal(decode(0x219, h).VCSEC_TPMSPressure0, undefined);
  // the brick temperatures (the battery temperature now): right as they were
  const b = decode(0x332, PAGES['can0:332'][0]);
  assert.deepEqual([b.BattBrickTempMax332, b.BattBrickTempMin332], [21.5, 21]);
  assert.equal(decode(0x332, PAGES['can0:332'][1]).BattBrickVoltageMax332, 4.104);
  // layouts not known on this firmware: nothing read
  for (const id of [0x312, 0x3FE, 0x122, 0x123, 0x315, 0x376, 0x37D, 0x3A1, 0x3C3, 0x72A, 0x201, 0x2A8, 0x2B4]) {
    assert.equal(bundledDbc().messages.get(id).signals.length, 0, `0x${id.toString(16)}`);
  }
  // the base's value names still name what stays (0x261's battery states), the override's win (0x352's SNA)
  assert.equal(bundledDbc().messages.get(0x261).signals.find((s) => s.name === 'VCFRONT_batterySMState').values[3], 'STANDBY');
  assert.deepEqual(bundledDbc().messages.get(0x352).signals.find((s) => s.name === 'BMS_nominalEnergyRemaining').values, { 65535: 'SNA' });
});

test('series names: one per signal, the message id after a name two messages share', () => {
  const all = [...bundledDbc().messages.values()].flatMap((m) => m.signals);
  assert.equal(new Set(all.map((s) => s.series)).size, all.length, 'every series name is unique');
  const cpu = all.filter((s) => s.name === 'UI_cpuTemperature').map((s) => s.series).sort();
  assert.deepEqual(cpu, ['UI_cpuTemperature_00C', 'UI_cpuTemperature_353']);
  assert.equal(all.find((s) => s.name === 'DI_vehicleSpeed').series, 'DI_vehicleSpeed', 'a unique name stays as it is');
  // the names the sync and the archive check read are unique
  for (const n of Object.values(require('../server/canSync').SIG)) assert.equal(all.filter((s) => s.name === n).length, 1, n);
});

test('the bus map: an interface the sidecar calls internal is no DBC bus', () => {
  assert.deepEqual(busMapOf({}), { can0: 'VehicleBus', can1: 'ChassisBus' });
  assert.deepEqual(busMapOf({ bus: { can0: 'vehicle (inferred from IDs)', can1: 'chassis (inferred from IDs)', can3: 'screenmate-internal' } }), { can0: 'VehicleBus', can1: 'ChassisBus' });
  assert.deepEqual(busMapOf({ bus: { can0: 'chassis', can1: 'vehicle', can2: 'internal' } }), { can0: 'ChassisBus', can1: 'VehicleBus' });
});

async function setup(name, text, side = null) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'canfirmware-'));
  await fsp.mkdir(path.join(base, 'can', 'K'), { recursive: true });
  await fsp.writeFile(path.join(base, 'can', 'K', name), execFileSync('xz', ['-1', '-c'], { input: text }));
  if (side) await fsp.writeFile(path.join(base, 'can', 'K', `${name}.json`), JSON.stringify(side));
  const idx = createCanIndex({ canDir: path.join(base, 'can'), dir: path.join(base, 'idx') });
  return { base, idx };
}
const T0 = Date.UTC(2026, 10, 8, 1, 28, 0); // a minute boundary
const at = (pts, ms) => pts?.filter((p) => p[0] <= ms).pop()?.[1];

test('a multi-bus log through the index: every value steady from second to second, across minutes and clips', { skip }, async () => {
  // 01:27:50 to 01:28:10 (a minute boundary in the middle), all four buses, the pages in turn
  const name = 'K_20261108T012750Z_1.log.xz';
  const { base, idx } = await setup(name, candump(T0 - 10_000, 200), { bus: { can0: 'vehicle (inferred from IDs)', can1: 'chassis (inferred from IDs)', can3: 'screenmate-internal' } });
  try {
    await idx.kick();
    // two clips' windows, as /api/can/clip asks them (the one before the boundary, the one after)
    const clipA = await idx.series(['K'], T0 - 10_000, T0);
    const clipB = await idx.series(['K'], T0, T0 + 10_000);
    for (const [n, want] of Object.entries(EXPECTED)) {
      for (const [clip, from] of [[clipA, T0 - 9000], [clipB, T0]]) {
        for (let t = from; t < from + 9000; t += 1000) {
          const v = at(clip[n], t);
          assert.ok(v !== undefined && near(v, want, 0.01), `${n} at ${new Date(t).toISOString()}: ${v}, not ${want}`);
        }
      }
    }
    // what is not decoded: the can3 position, the old pack temperatures, the 0x3FE "brake temperatures",
    // and a name that two messages share
    for (const n of ['GPSLatitude04F', 'GPSLongitude04F', 'BMSmaxPackTemperature', 'BMSminPackTemperature', 'BrakeTempFL3FE', 'UI_cpuTemperature']) assert.equal(clipB[n], undefined, n);
    // the chassis bus's 0x219 counter is not read as tires: one value per slot, all the time
    assert.equal(new Set(clipB.VCSEC_TPMSPressure0.map((p) => p[1])).size, 1);
    // signals.json: a series of its own for each message, with what the display needs
    const meta = await idx.signals(['K']);
    assert.equal(meta.UI_cpuTemperature_353.signal, 'UI_cpuTemperature');
    assert.equal(meta.UI_cpuTemperature_353.message, 'ID353UI_status');
    assert.equal(meta.BMS_nominalEnergyRemaining.factor, 0.02);
    assert.equal(meta.BMS_nominalEnergyRemaining.fmt, FORMAT);
    assert.equal(meta.GPSLatitude04F, undefined);
    // the raw view and the ids list: can3's ids are counted, with no DBC name (not decoded there)
    const raw = await idx.raw(['K'], T0, T0 + 5000);
    const named = Object.fromEntries(raw.map((e) => [e.key, e.name]));
    assert.equal(named['can3:3D9'], null);
    assert.equal(named['can3:04F'], null);
    assert.equal(named['can1:3D9'], 'ID3D9UI_gpsVehicleSpeed');
    assert.equal(named['can0:312'], null, 'a layout not known: unknown');
    assert.equal(named['can1:219'], null, '0x219 is a vehicle bus message now');
    assert.equal(named['can0:219'], 'ID219VCSEC_TPMSData');
    const ids = Object.fromEntries((await idx.idSummary('K', T0 - 10_000, T0 + 10_000)).map((e) => [e.key, e.name]));
    assert.equal(ids['can3:3D9'], null);
    assert.equal(ids['can1:3D9'], 'ID3D9UI_gpsVehicleSpeed');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('a bus nobody named is not decoded (no sidecar: only can0 and can1 are)', { skip }, async () => {
  const name = 'K_20261108T012750Z_1.log.xz';
  const { base, idx } = await setup(name, candump(T0 - 10_000, 50));
  try {
    await idx.kick();
    const s = await idx.series(['K'], T0 - 10_000, T0 - 5000);
    assert.equal(s.GPSLatitude04F, undefined, '0x04F is only on can3');
    assert.deepEqual([...new Set(s.UI_gpsHDOP.map((p) => p[1]))], [0], 'the HDOP from can1 only (can3 has 6.3)');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('an index written by r1 is decoded again: the old names go, from the minutes and signals.json', { skip }, async () => {
  const name = 'K_20261108T012750Z_1.log.xz';
  const { base, idx } = await setup(name, candump(T0 - 10_000, 200));
  try {
    await idx.kick();
    const doneFile = path.join(base, 'idx', 'done.json');
    const stamp = JSON.parse(fs.readFileSync(doneFile, 'utf8'))[`K/${name}`];
    assert.match(stamp, /\/r2$/);
    // as r1 left it: its stamp, the flat 0x312 pack temperatures and one UI_cpuTemperature in the minutes, no fmt in signals.json
    fs.writeFileSync(doneFile, JSON.stringify({ [`K/${name}`]: stamp.replace(/r2$/, 'r1') }));
    const file = path.join(base, 'idx', 'K', '20261108T0128.json.gz');
    const m = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
    m.signals.BMSmaxPackTemperature = [[1000, 15], [2000, -25]];
    m.signals.UI_cpuTemperature = [[1000, 30], [1100, 50]];
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(m)));
    const sigFile = path.join(base, 'idx', 'K', 'signals.json');
    const meta = JSON.parse(fs.readFileSync(sigFile, 'utf8'));
    meta.BMSmaxPackTemperature = { unit: 'C', min: -25, max: 100 };
    meta.UI_cpuTemperature = { unit: 'C' };
    fs.writeFileSync(sigFile, JSON.stringify(meta));

    const again = createCanIndex({ canDir: path.join(base, 'can'), dir: path.join(base, 'idx') });
    assert.deepEqual((await again.pendingLogs()).map((j) => [j.name, j.rawOnly]), [[name, false]], 'read again whole');
    await again.kick();
    const after = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
    assert.equal(after.signals.BMSmaxPackTemperature, undefined);
    assert.equal(after.signals.UI_cpuTemperature, undefined);
    assert.ok(after.signals.BattBrickTempMax332.length);
    const metaAfter = JSON.parse(fs.readFileSync(sigFile, 'utf8'));
    assert.equal(metaAfter.BMSmaxPackTemperature, undefined);
    assert.equal(metaAfter.UI_cpuTemperature, undefined);
    assert.ok(metaAfter.UI_cpuTemperature_353);
    assert.equal(JSON.parse(fs.readFileSync(doneFile, 'utf8'))[`K/${name}`], stamp);
    assert.deepEqual(await again.pendingLogs(), [], 'once');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});
