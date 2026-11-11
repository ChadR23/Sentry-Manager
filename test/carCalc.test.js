'use strict';

// The computed stats (web/carCalc.js): battery power from the pack's volts and
// amps (positive out of the pack), charging power only while charging, the
// 12 V battery's power, efficiency while moving, and the same definitions in
// the decoded CSV export (server/canCalc.js). With CAN_REAL_LOGS set to a
// folder of a car's .log.xz files (a 2026 Model Y parked at home, charge
// complete), the stats are checked against its own energy counter.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const carCalc = require('../web/carCalc');
const canCalc = require('../server/canCalc');

const calc = (id) => carCalc.CALCS.find((c) => c.id === id);
const getter = (o) => (n) => (n in o ? o[n] : null);
const near = (a, b, eps) => Math.abs(a - b) <= eps;

test('battery power: volts x amps in kW, positive out of the pack, no value without both', () => {
  const p = calc('calc.batteryPower');
  assert.ok(near(p.value(getter({ BattVoltage132: 395, SmoothBattCurrent132: 2.2 })), 0.869, 1e-9), 'parked, cabin warm: 0.87 kW out');
  assert.equal(p.value(getter({ BattVoltage132: 380, SmoothBattCurrent132: -100 })), -38, 'regenerating or charging: negative');
  assert.ok(near(p.value(getter({ BattVoltage132: 400, RawBattCurrent132: 10 })), 4, 1e-9), 'the raw current stands in for the smoothed one');
  assert.equal(p.value(getter({ BattVoltage132: 400, SmoothBattCurrent132: 10, RawBattCurrent132: 99 })), 4, 'the smoothed one first');
  assert.equal(p.value(getter({ BattVoltage132: 400 })), null);
  assert.equal(p.value(getter({ SmoothBattCurrent132: 3 })), null);
  assert.equal(p.value(getter({})), null);
  // drive and regen: each its own side, 0 on the other
  assert.equal(calc('calc.drivePower').value(getter({ BattVoltage132: 400, SmoothBattCurrent132: 50 })), 20);
  assert.equal(calc('calc.drivePower').value(getter({ BattVoltage132: 400, SmoothBattCurrent132: -50 })), 0);
  assert.equal(calc('calc.regenPower').value(getter({ BattVoltage132: 400, SmoothBattCurrent132: -50 })), 20);
  assert.equal(calc('calc.regenPower').value(getter({ BattVoltage132: 400, SmoothBattCurrent132: 50 })), 0);
  assert.equal(calc('calc.regenPower').value(getter({ BattVoltage132: 400, SmoothBattCurrent132: -50, BMS_uiChargeStatus: 3 })), 0, 'charging is not regen');
  assert.equal(calc('calc.regenPower').value(getter({})), null);
});

test('charging power: into the pack, only while the car says it charges; else no value (not 0)', () => {
  const c = calc('calc.chargingPower');
  const base = { BattVoltage132: 390, SmoothBattCurrent132: -28.2 };
  assert.ok(near(c.value(getter({ ...base, BMS_uiChargeStatus: 3 })), 11, 0.01), 'BMS_CHARGING: 11 kW in (AC)');
  assert.equal(c.value(getter({ ...base, BMS_uiChargeStatus: 4 })), null, 'charge complete');
  assert.equal(c.value(getter({ ...base, BMS_uiChargeStatus: 0 })), null, 'disconnected');
  assert.equal(c.value(getter(base)), null, 'nothing says');
  assert.ok(near(c.value(getter({ ...base, CP_hvChargeStatus_13D: 5 })), 11, 0.01), 'CP_CHARGE_ENABLED when there is no BMS status');
  assert.equal(c.value(getter({ ...base, BMS_uiChargeStatus: 4, CP_hvChargeStatus_13D: 5 })), null, 'the BMS decides first');
  assert.ok(near(c.value(getter({ ...base, PCS_hvChargeStatus: 2 })), 11, 0.01), 'PCS_CHARGE_ENABLED');
  assert.equal(c.value(getter({ BMS_uiChargeStatus: 3 })), null, 'no volts or amps');
  // a DC fast charger's own figure
  const dc = calc('calc.dcChargerPower');
  assert.ok(near(dc.value(getter({ CP_evseOutputDcVoltage: 400, CP_evseOutputDcCurrent: 250, CP_evseOutputDcCurrentStale: 0 })), 100, 1e-9));
  assert.equal(dc.value(getter({ CP_evseOutputDcVoltage: 400, CP_evseOutputDcCurrent: 250, CP_evseOutputDcCurrentStale: 1 })), null, 'stale');
  assert.equal(dc.value(getter({ CP_evseOutputDcVoltage: 0, CP_evseOutputDcCurrent: 0, CP_evseOutputDcCurrentStale: 1 })), null, 'parked at home: no value');
});

test('the 12 V battery: its power (positive giving) and state; battery temperature and spread', () => {
  const p = calc('calc.lv12Power');
  assert.ok(near(p.value(getter({ v12vBattVoltage261: 15.7, v12vBattCurrent261: -2 })), 31.4, 1e-9), 'discharging: 31 W out');
  assert.ok(near(p.value(getter({ v12vBattVoltage261: 15.7, v12vBattCurrent261: 3 })), -47.1, 1e-9), 'being charged: negative');
  assert.equal(p.value(getter({ v12vBattVoltage261: 15.7 })), null);
  const st = calc('calc.lv12State');
  assert.deepEqual([3, -3, 0.1, -0.1].map((i) => st.value(getter({ v12vBattCurrent261: i }))), ['Charging', 'Discharging', 'Resting', 'Resting']);
  assert.equal(st.value(getter({})), null);
  // the 12 V system: what the DC-DC gives it (a drive's frames, test/canFirmware.test.js: 15.99 V,
  // 74.8 A, the battery's own -0.445 A), its 12 V bus first, else the battery's volts
  const sys = calc('calc.lv12SystemPower');
  const drive = { PCS_dcdcLvBusVolt: 15.99, PCS_dcdcLvOutputCurrent: 74.8, v12vBattVoltage261: 15.77, v12vBattCurrent261: -0.445 };
  assert.ok(near(sys.value(getter(drive)), 1196.05, 0.01), 'about 1.2 kW driving');
  assert.ok(near(p.value(getter(drive)), 7.02, 0.01), 'the battery itself: 7 W');
  assert.ok(near(sys.value(getter({ v12vBattVoltage261: 15.77, PCS_dcdcLvOutputCurrent: 74.8 })), 1179.6, 0.01), 'the battery\'s volts stand in');
  assert.equal(sys.value(getter({ PCS_dcdcLvBusVolt: 15.99, v12vBattCurrent261: -0.445 })), null, 'not from the battery\'s current');
  assert.equal(canCalc.calcUnit('calc.lv12SystemPower'), 'W');
  assert.equal(calc('calc.battTemp').value(getter({ BattBrickTempMax332: 22, BattBrickTempMin332: 21 })), 21.5);
  assert.equal(calc('calc.battTempSpread').value(getter({ BattBrickTempMax332: 22, BattBrickTempMin332: 20.5 })), 1.5);
  assert.equal(calc('calc.battTemp').value(getter({ BattBrickTempMax332: 22 })), null);
});

/** A history: the series are functions of the time (ms from now, <= 0). */
const hist = (fns, since = 60_000) => ({ at: (n, dt) => (fns[n] ? fns[n](dt) : null), since });

test('efficiency, range now and energy used: over the seconds before, only while moving', () => {
  const eff = calc('calc.efficiency');
  // 20 kW at 100 km/h: 200 Wh/km = 321.9 Wh/mi
  const cruise = { BattVoltage132: () => 400, SmoothBattCurrent132: () => 50, DI_vehicleSpeed: () => 100 };
  assert.ok(near(eff.value(null, hist(cruise)), 321.87, 0.1));
  // parked, or slower than 5 mph on average: no value
  assert.equal(eff.value(null, hist({ ...cruise, DI_vehicleSpeed: () => 0 })), null);
  assert.equal(eff.value(null, hist({ ...cruise, DI_vehicleSpeed: () => 7 })), null, '7 km/h is under 5 mph');
  assert.equal(eff.value(null, hist({ BattVoltage132: () => 400, SmoothBattCurrent132: () => 50 })), null, 'no speed');
  assert.equal(eff.value(null, null), null);
  // smoothed: a spike of 1 s in 10 s moves it a little, not all the way
  const spike = { ...cruise, SmoothBattCurrent132: (dt) => (dt > -1000 ? 500 : 50) };
  const e = eff.value(null, hist(spike));
  assert.ok(e > 321.87 && e < 321.87 * 2, `smoothed: ${e}`);
  // regenerating downhill: negative
  assert.ok(eff.value(null, hist({ ...cruise, SmoothBattCurrent132: () => -20 })) < 0);
  // range now: the energy left less the buffer, at this efficiency (only while driving)
  const range = calc('calc.rangeNow');
  const left = getter({ BMS_nominalEnergyRemaining: 59.92, BMS_energyBuffer: 3.04 });
  assert.ok(near(range.value(left, hist(cruise)), (56.88 * 1000) / 321.87, 0.5));
  assert.equal(range.value(left, hist({ ...cruise, DI_vehicleSpeed: () => 0 })), null, 'parked');
  assert.equal(range.value(left, hist({ ...cruise, SmoothBattCurrent132: () => -20 })), null, 'regenerating: no range');
  assert.equal(range.value(getter({}), hist(cruise)), null, 'no energy left known');
  // energy used this clip: 20 kW for 30 s = 0.1667 kWh
  const used = calc('calc.energyClip');
  assert.ok(near(used.value(null, hist(cruise, 30_000)), 0.1667, 0.001));
  assert.equal(used.value(null, hist(cruise, 0)), null, 'nothing yet at the start');
  assert.ok(used.value(null, hist({ ...cruise, SmoothBattCurrent132: () => -50 }, 30_000)) < 0, 'more in than out: negative');
});

test('the export: the same definitions (one table), at each change of an input, by id or all', () => {
  // one table: the server's are the Viewer's own (not a copy)
  for (const c of canCalc.POINT) assert.equal(c, calc(c.id));
  assert.ok(!canCalc.POINT.some((c) => c.window), 'the stats over seconds are the Viewer\'s only');
  assert.equal(canCalc.isCalc('calc.batteryPower'), true);
  assert.equal(canCalc.isCalc('calc.efficiency'), false);
  assert.equal(canCalc.calcUnit('calc.lv12Power'), 'W');
  assert.equal(canCalc.calcUnit('calc.battTempSpread'), 'C');
  const plan = canCalc.calcPlan(new Set(['calc.batteryPower']));
  assert.deepEqual(plan.calcs.map((c) => c.id), ['calc.batteryPower']);
  assert.deepEqual([...plan.inputs].sort(), ['BattVoltage132', 'RawBattCurrent132', 'SmoothBattCurrent132']);
  assert.ok(canCalc.calcPlan(null).calcs.length >= 9, 'all of them with every signal');
  // a frame's volts and amps at the same moment: one value; then changes only, once a minute, '' when it stops
  const pts = [[0, 'BattVoltage132', 400], [0, 'SmoothBattCurrent132', 10], [100, 'SmoothBattCurrent132', 10], [200, 'SmoothBattCurrent132', 20], [70_000, 'SmoothBattCurrent132', 20]];
  assert.deepEqual(canCalc.calcPoints(pts, plan, {}, false, 60_000), [[0, 'calc.batteryPower', 4], [200, 'calc.batteryPower', 8], [70_000, 'calc.batteryPower', 8]]);
  assert.deepEqual(canCalc.calcPoints(pts, plan, {}, true, 60_000).map((p) => p[0]), [0, 100, 200, 70_000], 'every: each time');
  // the latest values carry across minutes (one state)
  const state = {};
  canCalc.calcPoints([[0, 'BattVoltage132', 400]], plan, state, false, 60_000);
  assert.deepEqual(canCalc.calcPoints([[60_000, 'SmoothBattCurrent132', 5]], plan, state, false, 60_000), [[60_000, 'calc.batteryPower', 2]]);
  // charging power: none while not charging, then a value, then '' once when it stops
  const ch = canCalc.calcPlan(new Set(['calc.chargingPower']));
  const seq = [[0, 'BattVoltage132', 400], [0, 'SmoothBattCurrent132', -25], [0, 'BMS_uiChargeStatus', 4], [10, 'BMS_uiChargeStatus', 3], [20, 'BMS_uiChargeStatus', 4], [30, 'BMS_uiChargeStatus', 4]];
  assert.deepEqual(canCalc.calcPoints(seq, ch, {}, false, 60_000), [[10, 'calc.chargingPower', 10], [20, 'calc.chargingPower', '']]);
});

// ---- the owner's own logs (CAN_REAL_LOGS: a folder of .log.xz files from one car)
const REAL = process.env.CAN_REAL_LOGS;
const skipReal = !REAL ? 'set CAN_REAL_LOGS to a folder of a car\'s .log.xz files' : spawnSync('xz', ['--version']).status !== 0 && 'needs xz';
test('real logs: battery power agrees with the car\'s own discharge counter; 12 V power is small and steady', { skip: skipReal, timeout: 600_000 }, async (t) => {
  const { createCanIndex } = require('../server/canIndex');
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'carcalc-real-'));
  try {
    // (copies: the folder given is only read)
    await fsp.mkdir(path.join(base, 'can', 'CAR'), { recursive: true });
    for (const f of fs.readdirSync(REAL).filter((x) => x.endsWith('.log.xz'))) await fsp.copyFile(path.join(REAL, f), path.join(base, 'can', 'CAR', f));
    const idx = createCanIndex({ canDir: path.join(base, 'can'), dir: path.join(base, 'idx') });
    await idx.kick();
    const times = await idx.minuteTimes('CAR');
    assert.ok(times.length > 2, `minutes: ${times.length}`);
    const from = times[0] + 60_000;
    const to = times[times.length - 1];
    const s = await idx.series(['CAR'], from, to, null);
    const at = (n, t) => {
      const pts = s[n] || [];
      if (!pts.length || pts[0][0] > t) return null;
      let lo = 0;
      let hi = pts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pts[mid][0] <= t) lo = mid; else hi = mid - 1; }
      return pts[lo][1];
    };
    const p = calc('calc.batteryPower');
    const lv = calc('calc.lv12Power');
    let kwh = 0;
    let n = 0;
    const lvW = [];
    for (let ms = from; ms < to; ms += 1000) {
      const get = (name) => at(name, ms);
      const kw = p.value(get);
      if (kw === null) continue;
      kwh += kw / 3600;
      n++;
      const w = lv.value(get);
      if (w !== null) lvW.push(w);
    }
    const counter = at('TotalDischargeKWh3D2', to) - at('TotalDischargeKWh3D2', from);
    const charged = at('TotalChargeKWh3D2', to) - at('TotalChargeKWh3D2', from);
    const meanKw = (kwh / n) * 3600;
    t.diagnostic(`battery: ${(kwh).toFixed(4)} kWh over ${n} s (mean ${meanKw.toFixed(3)} kW), discharge counter ${counter.toFixed(4)} kWh, charge counter ${charged.toFixed(4)} kWh`);
    assert.ok(n > 300, `seconds with battery power: ${n}`);
    assert.ok(meanKw > 0, 'parked with the cabin kept warm: power out of the pack (positive)');
    assert.equal(charged, 0, 'nothing went in');
    assert.ok(near(kwh, counter, Math.max(0.02, counter * 0.1)), `V x I gives ${kwh} kWh, the car counted ${counter} kWh out`);
    const lvMean = lvW.reduce((a, b) => a + b, 0) / lvW.length;
    t.diagnostic(`12 V battery: mean ${lvMean.toFixed(2)} W, from ${Math.min(...lvW).toFixed(1)} to ${Math.max(...lvW).toFixed(1)} W over ${lvW.length} s`);
    assert.ok(lvW.length > 300 && Math.abs(lvMean) < 50 && lvW.every((w) => Math.abs(w) < 200), 'small: the DC-DC carries the 12 V loads');
    // the 12 V system's current is the DC-DC's: tens of amps (24-48 A on the owner's car, cabin kept
    // warm), its power some hundreds of watts; the battery's own current stays under a few amps
    const sysA = [];
    const sysW = [];
    const ownA = [];
    for (let ms = from; ms < to; ms += 1000) {
      const get = (name) => at(name, ms);
      const a = get('PCS_dcdcLvOutputCurrent');
      if (a !== null) sysA.push(a);
      const w = calc('calc.lv12SystemPower').value(get);
      if (w !== null) sysW.push(w);
      const o = get('v12vBattCurrent261');
      if (o !== null) ownA.push(Math.abs(o));
    }
    const mean = (xs) => xs.reduce((x, y) => x + y, 0) / xs.length;
    t.diagnostic(`12 V system: mean ${mean(sysA).toFixed(1)} A (${Math.min(...sysA)}-${Math.max(...sysA)} A), ${mean(sysW).toFixed(0)} W; the battery's own: mean |${mean(ownA).toFixed(2)}| A`);
    assert.ok(sysA.length > 300 && mean(sysA) > 10 && mean(sysA) < 150, 'tens of amps');
    assert.ok(mean(sysW) > 150 && mean(sysW) < 2500, 'hundreds of watts');
    assert.ok(mean(ownA) < 2 && mean(sysA) > 10 * mean(ownA), 'the battery\'s own current is a small part of it');
    const temp = calc('calc.battTemp').value((name) => at(name, to));
    assert.ok(temp > 0 && temp < 45, `battery temp ${temp}`);
    assert.equal(calc('calc.chargingPower').value((name) => at(name, to)), null, 'charge complete: no charging power');
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});
