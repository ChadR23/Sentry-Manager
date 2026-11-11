'use strict';

// Decoding a 2026 Model Y's frames right (test/canModelY.js: its own frames):
// the firmware overrides (server/dbc/override.dbc) over model3dbc, frames
// decoded only on a bus the bus map names, and a series per message for a
// signal name two messages share. Each of these made every stat flip from
// one second (or clip) to the next: the pages of a message read with one
// layout, can1 and can3 frames of an id read as can0's, two messages' values
// in one series. An index written before (r1) is decoded again. Of can3 only
// 0x04F, the car's GPS position, is decoded (r3; test/canInternalGps.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync, spawnSync } = require('child_process');
const { bundledDbc, decodeFrame } = require('../server/canDbc');
const { createCanIndex, busMapOf, internalBusesOf, FORMAT } = require('../server/canIndex');
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
  for (const id of [0x312, 0x3FE, 0x122, 0x123, 0x315, 0x376, 0x37D, 0x3A1, 0x3C3, 0x72A, 0x201, 0x2A8]) {
    assert.equal(bundledDbc().messages.get(id).signals.length, 0, `0x${id.toString(16)}`);
  }
  // the base's value names still name what stays (0x261's battery states), the override's win (0x352's SNA)
  assert.equal(bundledDbc().messages.get(0x261).signals.find((s) => s.name === 'VCFRONT_batterySMState').values[3], 'STANDBY');
  assert.deepEqual(bundledDbc().messages.get(0x352).signals.find((s) => s.name === 'BMS_nominalEnergyRemaining').values, { 65535: 'SNA' });
});

// The same moment of a drive on 2026-11-09 (12:18:32 UTC, 96 km/h), frames byte for byte
// from the car's log: the DC-DC (0x2B4), the 12 V battery's pages 0 and 1 (0x261), the pack (0x132).
const DRIVE = {
  dcdc: ['3F06010FEC020000', '4106070F1D030000'],
  battPage0: '0010A7FFFF4FE009',
  battPage1: '311847FF514BF848',
  pack: 'D49534FD943A0000'
};
// and parked with the cabin kept warm (2026-11-08 01:18:48 UTC)
const PARKED_DCDC = '3906680F9F010000';

test('0x2B4: the DC-DC gives the 12 V system tens of amps while the 12 V battery\'s own current is near 0', () => {
  const d = decode(0x2B4, DRIVE.dcdc[0]);
  assert.deepEqual(d, { PCS_dcdcLvBusVolt: 15.99, PCS_dcdcHvBusVolt: 384.1, PCS_dcdcLvOutputCurrent: 74.8 });
  assert.equal(decode(0x2B4, DRIVE.dcdc[1]).PCS_dcdcLvOutputCurrent, 79.7, 'about 80 A, as another logger showed for this drive');
  // the HV input is the pack's voltage (0x132), the 12 V bus a little above the battery's (0x261)
  const pack = decode(0x132, DRIVE.pack);
  assert.ok(near(d.PCS_dcdcHvBusVolt, pack.BattVoltage132, 1.5), `${d.PCS_dcdcHvBusVolt} V vs the pack's ${pack.BattVoltage132} V`);
  const lv = decode(0x261, DRIVE.battPage1).v12vBattVoltage261;
  assert.ok(d.PCS_dcdcLvBusVolt > lv && d.PCS_dcdcLvBusVolt - lv < 0.5, `${d.PCS_dcdcLvBusVolt} V vs the battery's ${lv} V`);
  // the 12 V battery's own current: under half an amp (what "12V Battery Current" showed)
  const own = decode(0x261, DRIVE.battPage0).v12vBattCurrent261;
  assert.equal(own, -0.445);
  // parked, cabin kept warm: about 40 A (read with the base's 10/12/12 bits this frame gave a
  // 22 V bus and 386 A)
  assert.deepEqual(decode(0x2B4, PARKED_DCDC), { PCS_dcdcLvBusVolt: 15.93, PCS_dcdcHvBusVolt: 394.4, PCS_dcdcLvOutputCurrent: 41.5 });
  // named for what they are (the base's comments called the battery's current "12V Battery Current")
  const msg = (id) => bundledDbc().messages.get(id).signals;
  assert.equal(msg(0x2B4).find((s) => s.name === 'PCS_dcdcLvOutputCurrent').comment, '12V system current');
  assert.equal(msg(0x261).find((s) => s.name === 'v12vBattCurrent261').comment, "12V battery's own current");
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
  // (where 0x04F's position is decoded as well, and only there)
  assert.deepEqual(internalBusesOf({ bus: { can0: 'vehicle (inferred from IDs)', can1: 'chassis (inferred from IDs)', can3: 'screenmate-internal' } }), ['can3']);
  assert.deepEqual(internalBusesOf({}), [], 'no sidecar: no internal bus');
  assert.deepEqual(internalBusesOf({ bus: { 'can3;x': 'internal' } }), [], 'not a plain interface name');
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
    // what is not decoded: the old pack temperatures, the 0x3FE "brake temperatures", and a name that
    // two messages share
    for (const n of ['BMSmaxPackTemperature', 'BMSminPackTemperature', 'BrakeTempFL3FE', 'UI_cpuTemperature']) assert.equal(clipB[n], undefined, n);
    // can3's 0x04F is (the car's position: only there on this car), and nothing else of can3: its 0x3D9
    // would give an HDOP of 6.3
    assert.deepEqual([...new Set(clipB.GPSLatitude04F.map((p) => p[1]))], [40.199897]);
    assert.deepEqual([...new Set(clipB.GPSLongitude04F.map((p) => p[1]))], [-107.523232]);
    assert.deepEqual([...new Set(clipB.GPSAccuracy04F.map((p) => p[1]))], [25]);
    assert.deepEqual([...new Set(clipB.UI_gpsHDOP.map((p) => p[1]))], [0]);
    // the chassis bus's 0x219 counter is not read as tires: one value per slot, all the time
    assert.equal(new Set(clipB.VCSEC_TPMSPressure0.map((p) => p[1])).size, 1);
    // signals.json: a series of its own for each message, with what the display needs
    const meta = await idx.signals(['K']);
    assert.equal(meta.UI_cpuTemperature_353.signal, 'UI_cpuTemperature');
    assert.equal(meta.UI_cpuTemperature_353.message, 'ID353UI_status');
    assert.equal(meta.BMS_nominalEnergyRemaining.factor, 0.02);
    assert.equal(meta.BMS_nominalEnergyRemaining.fmt, FORMAT);
    assert.deepEqual([meta.GPSLatitude04F.unit, meta.GPSAccuracy04F.unit, meta.GPSLatitude04F.fmt], ['Deg', 'm', FORMAT]);
    // the raw view and the ids list: can3's ids are counted, with no DBC name (not decoded there), but 0x04F
    const raw = await idx.raw(['K'], T0, T0 + 5000);
    const named = Object.fromEntries(raw.map((e) => [e.key, e.name]));
    assert.equal(named['can3:3D9'], null);
    assert.equal(named['can3:04F'], 'ID04FGPSLatLong');
    assert.equal(named['can1:3D9'], 'ID3D9UI_gpsVehicleSpeed');
    assert.equal(named['can0:312'], null, 'a layout not known: unknown');
    assert.equal(named['can1:219'], null, '0x219 is a vehicle bus message now');
    assert.equal(named['can0:219'], 'ID219VCSEC_TPMSData');
    const ids = Object.fromEntries((await idx.idSummary('K', T0 - 10_000, T0 + 10_000)).map((e) => [e.key, e.name]));
    assert.equal(ids['can3:3D9'], null);
    assert.equal(ids['can3:04F'], 'ID04FGPSLatLong');
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
    assert.equal(s.GPSLatitude04F, undefined, '0x04F is only on can3, which no sidecar calls internal here');
    const named = Object.fromEntries((await idx.raw(['K'], T0 - 10_000, T0 - 5000)).map((e) => [e.key, e.name]));
    assert.equal(named['can3:04F'], null);
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
    assert.ok(stamp.endsWith(`/${FORMAT}`), stamp);
    // as r1 left it: its stamp, the flat 0x312 pack temperatures and one UI_cpuTemperature in the minutes, no fmt in signals.json
    fs.writeFileSync(doneFile, JSON.stringify({ [`K/${name}`]: stamp.replace(new RegExp(`${FORMAT}$`), 'r1') }));
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

test('an r1 index of stored logs ends up wholly current: every minute, signals.json, the summaries, and what the sync and the gap check learned', { skip }, async () => {
  const fmt = require('../server/canFormat');
  const { SYNC_FORMAT } = require('../server/canSync');
  const nameA = 'K_20261108T012750Z_1.log.xz'; // 01:27:50 to 01:28:10, stored
  const nameB = 'K_20261108T013000Z_2.log.xz'; // 01:30:00 to 01:30:05, then gone (cannot be decoded again)
  const side = { bus: { can0: 'vehicle (inferred from IDs)', can1: 'chassis (inferred from IDs)', can3: 'screenmate-internal' } };
  const { base, idx } = await setup(nameA, candump(T0 - 10_000, 200), side);
  try {
    await fsp.writeFile(path.join(base, 'can', 'K', nameB), execFileSync('xz', ['-1', '-c'], { input: candump(T0 + 120_000, 50) }));
    await idx.kick();
    const dirK = path.join(base, 'idx', 'K');
    const doneFile = path.join(base, 'idx', 'done.json');
    // as r1 left it: stamps, minutes in the older layout with parts that say no fmt and what its
    // decoding made of these frames (can3's position, the flat pack temperatures, page 5 of 0x261 as
    // page 1: 3.6 V), signals.json without fmt, no packed.json
    const done = JSON.parse(fs.readFileSync(doneFile, 'utf8'));
    for (const k of Object.keys(done)) done[k] = done[k].replace(`/${FORMAT}`, '/r1');
    fs.writeFileSync(doneFile, JSON.stringify(done));
    fs.rmSync(path.join(base, 'idx', 'packed.json'), { force: true });
    const minutes = fs.readdirSync(dirK).filter((f) => /^\d{8}T\d{4}\.json\.gz$/.test(f));
    assert.deepEqual(minutes.sort(), ['20261108T0127.json.gz', '20261108T0128.json.gz', '20261108T0130.json.gz']);
    for (const f of minutes) {
      const m = fmt.decodeMinute(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dirK, f))).toString()));
      delete m.act;
      for (const p of Object.values(m.logs)) delete p.fmt;
      m.signals.GPSLatitude04F = [[0, 40.2]];
      m.signals.BMSmaxPackTemperature = [[1000, 15], [2000, -25]];
      m.signals.v12vBattVoltage261 = [[0, 15.77], [500, 3.6], [1000, 15.77], [1500, 3.6]];
      fs.writeFileSync(path.join(dirK, f), zlib.gzipSync(JSON.stringify(m)));
    }
    const sigFile = path.join(dirK, 'signals.json');
    const meta = JSON.parse(fs.readFileSync(sigFile, 'utf8'));
    for (const v of Object.values(meta)) delete v.fmt;
    meta.GPSLatitude04F = { unit: 'Deg' };
    fs.writeFileSync(sigFile, JSON.stringify(meta));
    fs.writeFileSync(path.join(dirK, 'ids-20261108.json'), JSON.stringify({ v: 'v1', ids: { 'can9:123': [T0, T0, 1] } }));
    fs.rmSync(path.join(base, 'can', 'K', nameB)); // log B is gone: its part cannot be decoded again

    const told = [];
    const again = createCanIndex({ canDir: path.join(base, 'can'), dir: path.join(base, 'idx'), onIndexed: (k, a, b) => told.push([k, a, b]) });
    assert.deepEqual((await again.pendingLogs()).map((j) => j.name), [nameA], 'the stored log, decoded again');
    await again.kick();

    // every minute: columns, its activity, every part current, nothing of the r1 decoding left
    for (const f of minutes) {
      const file = path.join(dirK, f);
      const head = await fmt.readHead(file);
      assert.equal(head.enc, fmt.ENC, f);
      assert.ok(head.act, `${f}: act`);
      assert.ok(Object.values(head.logs).every((p) => p.fmt === FORMAT), `${f}: ${JSON.stringify(head.logs)}`);
      const m = await fmt.readMinuteFile(file);
      assert.equal(m.signals.BMSmaxPackTemperature, undefined, f);
      // (log A's position is decoded again from its can3 frames: the car's, not r1's 40.2)
      assert.ok((m.signals.GPSLatitude04F || []).every((p) => p[1] === 40.199897), `${f}: ${JSON.stringify(m.signals.GPSLatitude04F?.slice(0, 3))}`);
      assert.ok(!(m.signals.v12vBattVoltage261 || []).some((p) => p[1] < 10), `${f}: no 3.6 V`);
    }
    // log B's minute: its frame counts kept (not decoded), its signals gone
    const b = await fmt.readMinuteFile(path.join(dirK, '20261108T0130.json.gz'));
    assert.deepEqual(Object.keys(b.signals), []);
    assert.ok(b.ids['can0:243'] > 0);
    // log A's values: steady, as the car sent them
    const s = await again.series(['K'], T0 - 10_000, T0 + 10_000);
    for (const [n, want] of Object.entries(EXPECTED)) {
      for (let t = T0 - 9000; t < T0 + 9000; t += 1000) {
        const v = at(s[n], t);
        assert.ok(v !== undefined && near(v, want, 0.01), `${n} at ${new Date(t).toISOString()}: ${v}, not ${want}`);
      }
    }
    // signals.json: only current names (the position's from log A's decoding)
    const metaAfter = JSON.parse(fs.readFileSync(sigFile, 'utf8'));
    assert.equal(metaAfter.GPSLatitude04F.factor, 1e-6);
    assert.ok(Object.values(metaAfter).every((v) => v.fmt === FORMAT));
    // per-day id summaries: made again (the made-up id is gone)
    const fresh = await again.newIds('K', T0 - 86400_000);
    assert.ok(!fresh.appeared.some((x) => x.id === 'can9:123'), 'the day summary was made again');
    assert.ok(fresh.appeared.some((x) => x.id === 'can0:243'));
    // packed once for this layout and decoding; the sync and the gap check told of both logs' minutes
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, 'idx', 'packed.json'), 'utf8')), { K: `${fmt.ENC}/${FORMAT}` });
    const covers = (t) => told.some(([k, a, z]) => k === 'K' && a <= t && t <= z);
    assert.ok(covers(T0) && covers(T0 + 121_000), `told: ${JSON.stringify(told)}`);
    assert.equal(await again.repack(), 0, 'nothing more to do');
    // the sync's stored offsets are kept by the index's decoding of the car's buses: an r1 sync.json is
    // worked out again (r3 changed only the internal bus: test/canInternalGps.test.js)
    assert.ok(SYNC_FORMAT.endsWith(`/${require('../server/canIndex').CAR_FORMAT}`), SYNC_FORMAT);
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});
