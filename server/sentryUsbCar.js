'use strict';

// The `car` object in a Sentry USB's info file on the share (docs/sentry-usb.md,
// "The info file"; read by sentryUsbDevice.js): battery, temperatures, tire
// pressures and parked or driving, from the Pi's Tesla BLE telemetry.
// Everything in it is untrusted: only the keys below are kept, each with its
// type and range checked, and a reading with anything wrong in it is dropped
// (the rest are kept). A car with no valid reading left is no car.
//
//   const car = cleanCar(status.car, { now: Date.now() });   // object | null

const EARLIEST = 1_500_000_000; // Unix seconds, July 2017: older is a clock that was never set
const AHEAD = 86_400; // a Pi clock may run ahead of this server's, but not by more than a day
const TIRES = ['fl', 'fr', 'rl', 'rr'];
const TIRE_STATES = ['optimal', 'check', 'unsafe'];
const DRIVE_STATES = ['parked', 'driving'];

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const inRange = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * A reading: an object with only `keys`, each passing its check, the `required`
 * ones present, and `at` (if any) a sane Unix time. null when anything is wrong.
 */
function reading(v, checks, required, nowS) {
  if (!isObj(v)) return null;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === 'at') {
      if (!Number.isInteger(x) || x < EARLIEST || x > nowS + AHEAD) return null;
      out.at = x;
      continue;
    }
    const check = checks[k];
    if (!check) continue; // a key this Manager doesn't know: not kept
    const ok = check(x);
    if (ok === undefined) return null;
    out[k] = ok;
  }
  return required.every((k) => k in out) ? out : null;
}

const num = (lo, hi) => (x) => (inRange(x, lo, hi) ? round1(x) : undefined);
const bool = (x) => (typeof x === 'boolean' ? x : undefined);
const oneOf = (list) => (x) => (list.includes(x) ? x : undefined);

/** The checked car object, or null. */
function cleanCar(car, { now = Date.now() } = {}) {
  if (!isObj(car)) return null;
  const nowS = Math.floor(now / 1000);
  const out = {};
  const battery = reading(car.battery, { pct: num(0, 100), charging: bool }, ['pct'], nowS);
  if (battery) out.battery = battery;
  const interior = reading(car.interior, { c: num(-60, 100) }, ['c'], nowS);
  if (interior) out.interior = interior;
  const exterior = reading(car.exterior, { c: num(-70, 70) }, ['c'], nowS);
  if (exterior) out.exterior = exterior;
  if (isObj(car.tires)) {
    const tires = {};
    for (const p of TIRES) {
      const t = reading(car.tires[p], { kpa: num(0, 1000) }, ['kpa'], nowS);
      if (t) tires[p] = t;
    }
    if (Object.keys(tires).length) {
      if (TIRE_STATES.includes(car.tires.state)) tires.state = car.tires.state;
      out.tires = tires;
    }
  }
  const drive = reading(car.drive, {
    state: oneOf(DRIVE_STATES),
    since: (x) => (Number.isInteger(x) && x >= EARLIEST && x <= nowS + AHEAD ? x : undefined)
  }, ['state'], nowS);
  if (drive) out.drive = drive;
  if (!Object.keys(out).length) return null;
  const units = reading(car.units, { temp: oneOf(['F', 'C']), pressure: oneOf(['psi', 'bar']) }, [], nowS);
  if (units && Object.keys(units).length) { delete units.at; if (Object.keys(units).length) out.units = units; }
  return out;
}

module.exports = { cleanCar, EARLIEST, AHEAD };
