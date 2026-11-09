'use strict';

// The Viewer's computed stats (web/carCalc.js: battery power, charging power,
// 12 V battery power, ...) in the decoded CSV export: the same definitions,
// worked out at each change of an input from the inputs' latest values. Only
// the stats of one moment (not efficiency or energy used, which need the
// seconds before: the Viewer's own).

const { CALCS } = require('../web/carCalc');

const POINT = CALCS.filter((c) => !c.window);
const BY_ID = new Map(POINT.map((c) => [c.id, c]));
// the export's unit for each (a temperature difference is in C too)
const UNIT = { kW: 'kW', W: 'W', C: 'C', Cdelta: 'C', kWh: 'kWh', '': '' };

/** Whether a name in an export's signal list is a computed stat. */
const isCalc = (name) => BY_ID.has(name);

/**
 * What an export works out: the computed stats asked for by id (all of them
 * when no list is given), and the CAN signals to read for them.
 */
function calcPlan(only) {
  const calcs = only ? POINT.filter((c) => only.has(c.id)) : POINT;
  const inputs = new Set();
  for (const c of calcs) for (const n of [...c.uses.flat(), ...(c.also || [])]) inputs.add(n);
  const byInput = new Map();
  for (const c of calcs) for (const n of [...c.uses.flat(), ...(c.also || [])]) (byInput.get(n) || byInput.set(n, []).get(n)).push(c);
  return { calcs, inputs, byInput };
}

// (two decimals more than the Viewer shows: an export is for working with)
const rounded = (c, v) => (typeof v === 'number' ? Number(v.toFixed((c.digits ?? 1) + 2)) : v);

/**
 * The computed stats' points for these (time-ordered) points [[ms, name, value], ...]:
 * at each point of an input, each stat that uses it from the latest values
 * (`state.latest`, carried across minutes). `every`: each time (when it has a
 * value); else only changes, a value that stays the same once every
 * `heartbeatMs`, and '' once when it stops having one.
 */
function calcPoints(pts, plan, state, every, heartbeatMs) {
  const out = [];
  if (!plan.calcs.length) return out;
  state.latest ||= new Map();
  state.last ||= new Map();
  const get = (n) => (state.latest.has(n) ? state.latest.get(n) : null);
  for (let k = 0; k < pts.length;) {
    // (the points of one moment together: a frame's volts and amps give one battery power)
    const at = pts[k][0];
    const touched = new Set();
    for (; k < pts.length && pts[k][0] === at; k++) {
      const users = plan.byInput.get(pts[k][1]);
      if (!users) continue;
      state.latest.set(pts[k][1], pts[k][2]);
      for (const c of users) touched.add(c);
    }
    for (const c of touched) {
      const raw = c.value(get);
      const val = raw == null ? null : rounded(c, raw);
      const l = state.last.get(c.id);
      if (every) {
        if (val !== null) out.push([at, c.id, val]);
        continue;
      }
      if (val === null) {
        if (l && l.v !== null) { out.push([at, c.id, '']); state.last.set(c.id, { v: null, at }); }
        continue;
      }
      if (l && l.v === val && at - l.at < heartbeatMs) continue;
      state.last.set(c.id, { v: val, at });
      out.push([at, c.id, val]);
    }
  }
  return out;
}

/** A computed stat's unit in the export. */
const calcUnit = (id) => UNIT[BY_ID.get(id)?.unit] ?? '';

module.exports = { isCalc, calcPlan, calcPoints, calcUnit, POINT };
