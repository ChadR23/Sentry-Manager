'use strict';

// The car's latest CAN values, for a Stream Deck (or anything that polls a
// URL): GET /api/can/now on the app's own port, with its own read-only token
// (docs/can-bridge-api.md, "Live stats for a Stream Deck"). The newest values
// the CAN index has decoded for a car, whether or not the log is paired with
// footage yet: as fresh as the CAN Bridge's last upload (a log is about a
// minute). The stats are the Viewer's popular ones, named for a URL (speed,
// battery, batteryPower...), each from the first of its signals that has a
// value, in the units asked for (miles: mph, °F, psi; kilometres: km/h, °C,
// bar), as the Viewer shows them.

const UNITS = require('../web/units.js');
const { CALCS } = require('../web/carCalc');

// [id, label, signals (the first with a value wins; calc.* are worked out)]
const STATS = [
  ['speed', 'Speed', ['DI_vehicleSpeed', 'DI_vehicleSpeed_116', 'DI_vehicleSpeed_118', 'UI_gpsVehicleSpeed']],
  ['battery', 'Battery', ['SOCUI292', 'UI_SOC', 'SOCave292', 'SOCUI302']],
  ['range', 'Range', ['UI_Range', 'UI_idealRange', 'RatedRange338', 'IdealRange338']],
  ['batteryPower', 'Battery power', ['calc.batteryPower']],
  ['gear', 'Gear', ['DI_gear', 'DI_gear_116', 'DI_gear_118']],
  ['batteryVoltage', 'Battery voltage', ['BattVoltage132', 'BattVoltage102']],
  ['batteryCurrent', 'Battery current', ['SmoothBattCurrent132', 'RawBattCurrent132']],
  ['batteryTemp', 'Battery temp', ['calc.battTemp', 'BattTemp102']],
  ['outsideTemp', 'Outside temp', ['VCFRONT_tempAmbientFiltered', 'VCFRONT_tempAmbient', 'VCRIGHT_tempAmbientRaw']],
  ['cabinTemp', 'Cabin temp', ['VCRIGHT_hvacCabinTempEst']],
  ['rearMotorPower', 'Rear motor power', ['RearPower266']],
  ['frontMotorPower', 'Front motor power', ['FrontPower2E5']],
  ['rearMotorTemp', 'Rear motor temp', ['DIR_statorEndWindingTemp', 'MotorTemp306']],
  ['frontMotorTemp', 'Front motor temp', ['DIF_statorEndWindingTemp']],
  ['lv12Current', '12V system current', ['PCS_dcdcLvOutputCurrent']],
  ['lv12Power', '12V system power', ['calc.lv12SystemPower']],
  ['lv12Voltage', '12V battery', ['v12vBattVoltage261']],
  ['lv12State', '12V battery state', ['calc.lv12State']],
  ['tire1', 'Tire 1', ['VCSEC_TPMSPressure0', 'TPMSFLpressure31F']],
  ['tire2', 'Tire 2', ['VCSEC_TPMSPressure1', 'TPMSFRpressure31F']],
  ['tire3', 'Tire 3', ['VCSEC_TPMSPressure2', 'TPMSRLpressure31F']],
  ['tire4', 'Tire 4', ['VCSEC_TPMSPressure3', 'TPMSRRpressure31F']],
  ['charging', 'Charging', ['BMS_uiChargeStatus', 'CP_hvChargeStatus_13D', 'CP_hvChargeStatus_23D', 'PCS_hvChargeStatus']],
  ['chargingPower', 'Charging power', ['calc.chargingPower', 'ChargerPower222']],
  ['chargeTimeLeft', 'Charge time left', ['ChargeHoursRemaining132']],
  ['energyRemaining', 'Energy remaining', ['BMS_nominalEnergyRemaining', 'BMS_expectedEnergyRemaining']],
  ['odometer', 'Odometer', ['UI_odometer', 'Odometer3B6', 'Odometer5D8']],
  ['setSpeed', 'Set speed', ['DAS_setSpeed', 'DAS_setSpeed_2BF', 'DAS_setSpeed_2B9']],
  ['speedLimit', 'Speed limit', ['DAS_fusedSpeedLimit', 'UI_mppSpeedLimit']],
  ['elevation', 'Elevation', ['Elevation3D8']]
].map(([id, label, names]) => ({ id, label, names }));
const STAT_IDS = STATS.map((s) => s.id);
// the Viewer's computed stats of one moment (not the ones that need the seconds before)
const CALC = new Map(CALCS.filter((c) => !c.window).map((c) => [c.id, c]));

// a DBC unit's conversion for each choice: [unit shown, value in it]
const MI = 1.609344;
const CONVERT = {
  C: { km: ['°C', (v) => v], mi: ['°F', (v) => v * 1.8 + 32] },
  F: { km: ['°C', (v) => (v - 32) / 1.8], mi: ['°F', (v) => v] },
  Cdelta: { km: ['°C', (v) => v], mi: ['°F', (v) => v * 1.8] },
  'km/h': { km: ['km/h', (v) => v], mi: ['mph', (v) => v / MI] },
  mph: { km: ['km/h', (v) => v * MI], mi: ['mph', (v) => v] },
  km: { km: ['km', (v) => v], mi: ['mi', (v) => v / MI] },
  mi: { km: ['km', (v) => v * MI], mi: ['mi', (v) => v] },
  m: { km: ['m', (v) => v], mi: ['ft', (v) => v * 3.28084] },
  kPa: { km: ['bar', (v) => v / 100], mi: ['psi', (v) => v * 0.1450377] },
  bar: { km: ['bar', (v) => v], mi: ['psi', (v) => v * 14.50377] },
  psi: { km: ['bar', (v) => v / 14.50377], mi: ['psi', (v) => v] }
};
const convertOf = (unit) => CONVERT[unit === 'Cdelta' ? 'Cdelta' : UNITS.canonUnit(unit) || unit] || null;

// how far back a signal's last value is looked for (some are sent once in minutes)
const LOOK_BACK_MS = 5 * 60_000;
// older than this: `stale` (the car is off, or out of reach of the upload)
const STALE_MS = 5 * 60_000;

const SNA = /(^|_)SNA$|NOT_?AVAILABLE|INVALID|UNKNOWN/i;
/**
 * A named state in words, without the words every name of the signal starts
 * with (as the Viewer shows it): DI_GEAR_D → "D", BMS_UI_CHARGE_STATUS_CHARGING
 * → "Charging", ..._NOT_CHARGING → "Not charging". `all`: the signal's names.
 */
function stateWords(name, all = [name]) {
  const split = (t) => String(t).split('_').filter(Boolean);
  const names = all.filter((t) => /^[A-Z0-9_]+$/.test(t) && !SNA.test(t)).map(split);
  let drop = 0;
  if (names.length >= 2) while (names.every((w) => w.length > drop + 1 && w[drop] === names[0][drop])) drop++;
  const words = split(name).slice(drop);
  if (!words.length) return String(name);
  if (words.length === 1 && words[0].length <= 2) return words[0];
  return words.map((w, k) => (k ? w.toLowerCase() : w[0] + w.slice(1).toLowerCase())).join(' ');
}

function digitsFor(id, unit, v) {
  if (/^tire/.test(id)) return unit === 'bar' ? 2 : 0;
  if (unit === '%' || unit === 'mph' || unit === 'km/h' || unit === 'W' || unit === 'mi' || unit === 'km' || unit === 'ft' || unit === 'm' || unit === '°F') return 0;
  return Math.abs(v) >= 100 ? 0 : 1;
}
const textOf = (value, unit) => (unit === '%' ? `${value}%` : unit ? `${value} ${unit}` : String(value));

/**
 * The latest values of one car from the index: { car key, at (UTC ms of the
 * newest point), stats: [{ id, label, value, unit, text }] } (a stat without a
 * value is left out), or null when the index has nothing for that car.
 * units: 'mi' or 'km'.
 */
async function latestStats({ index, key, units = 'mi', now = Date.now() }) {
  const minutes = await index.minuteTimes(key);
  if (!minutes.length) return null;
  const last = minutes[minutes.length - 1];
  const names = new Set();
  for (const s of STATS) {
    for (const n of s.names) {
      const c = CALC.get(n);
      if (c) for (const x of [...c.uses.flat(), ...(c.also || [])]) names.add(x);
      else names.add(n);
    }
  }
  const got = await index.clipData([key], last - LOOK_BACK_MS, last + 60_000, [...names]);
  const latest = new Map();
  let at = null;
  for (const [name, pts] of Object.entries(got.series || {})) {
    if (!pts?.length) continue;
    const [t, v] = pts[pts.length - 1];
    latest.set(name, v);
    if (at === null || t > at) at = t;
  }
  if (at === null) return null;
  const meta = await index.signals([key]).catch(() => ({}));
  const get = (n) => (latest.has(n) ? latest.get(n) : null);
  const stats = [];
  for (const s of STATS) {
    for (const n of s.names) {
      const c = CALC.get(n);
      let value;
      let unit;
      if (c) {
        try { value = c.value(get); } catch { value = null; }
        unit = c.unit;
      } else {
        value = get(n);
        const m = meta[n] || {};
        const named = m.values && typeof value === 'number' ? m.values[String(Math.round(value))] : null;
        if (named) {
          if (SNA.test(named)) value = null;
          else if (!Number.isFinite(m.factor) || Math.abs(m.factor) === 1) { value = stateWords(named, Object.values(m.values)); unit = ''; }
        }
        if (unit === undefined) unit = s.id === 'battery' ? '%' : m.unit || '';
      }
      if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) continue;
      if (typeof value === 'number') {
        const conv = convertOf(unit);
        if (conv) [unit, value] = [conv[units][0], conv[units][1](value)];
        else if (unit === 'Cdelta') unit = '°C';
        const d = digitsFor(s.id, unit, value);
        value = Math.round(value * 10 ** d) / 10 ** d;
        stats.push({ id: s.id, label: s.label, value, unit: unit || '', text: textOf(value.toFixed(d), unit || '') });
        break;
      }
      stats.push({ id: s.id, label: s.label, value, unit: unit || '', text: textOf(value, unit || '') });
      break;
    }
  }
  return { key, at, ageSec: Math.max(0, Math.round((now - at) / 1000)), stale: now - at > STALE_MS, stats };
}

module.exports = { latestStats, STATS, STAT_IDS, STALE_MS, stateWords };
