'use strict';

// DBC files: what each CAN message means. A DBC lists messages (BO_: id,
// name, length, bus) and their signals (SG_: bit position, length, byte
// order, sign, scale and offset, range, unit), with value names (VAL_) and
// comments (CM_). This reads one and decodes frames with it, multiplexed
// signals included (one signal says which of the others the frame carries).
//
// The bundled server/dbc/Model3CAN.dbc is the community model3dbc (MIT,
// LICENSE-model3dbc.txt, its latest commit c56c113, 2021), which the Screenmate
// CAN Bridge uses too; it names the buses VehicleBus and ChassisBus.
// server/dbc/override.dbc is read after it: the messages whose layout Tesla
// changed in newer firmware (checked against a real car's logs), each replacing
// the base message of its id. Other cars get other sets (PROFILES below).
//
// A signal name can be in more than one message (UI_cpuTemperature in 0x00C
// and 0x353): each signal has a series name of its own (sig.series), the name
// itself where it is unique, else the name and the message id
// (UI_cpuTemperature_353), so two messages' values are never mixed.

const fs = require('fs');
const path = require('path');

/** { messages: Map<id, { id, name, size, bus, signals }>, signals: Map<name, signal meta> } */
function parseDbc(text) {
  const messages = new Map();
  let current = null;
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    let m = /^BO_\s+(\d+)\s+(\w+)\s*:\s*(\d+)\s+(\w+)/.exec(line);
    if (m) {
      const raw = Number(m[1]);
      const id = raw >= 0x80000000 ? raw - 0x80000000 : raw; // extended ids carry bit 31
      current = { id, name: m[2], size: Number(m[3]), bus: m[4], signals: [], mux: null };
      messages.set(id, current);
      continue;
    }
    m = /^\s+SG_\s+(\w+)\s*(M|m\d+)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)\s*\)\s*\[\s*([-+0-9.eE]+)\s*\|\s*([-+0-9.eE]+)\s*\]\s*"([^"]*)"/.exec(line);
    if (m && current) {
      const sig = {
        name: m[1], message: current.name, messageId: current.id, bus: current.bus,
        start: Number(m[3]), length: Number(m[4]), little: m[5] === '1', signed: m[6] === '-',
        factor: Number(m[7]), offset: Number(m[8]), min: Number(m[9]), max: Number(m[10]), unit: m[11],
        mux: m[2] === 'M' ? 'M' : m[2] ? Number(m[2].slice(1)) : null, values: null, comment: null
      };
      current.signals.push(sig);
      if (sig.mux === 'M') current.mux = sig;
      continue;
    }
    if (!/^\s/.test(line)) current = null;
  }
  const byMsgSig = (id, name) => messages.get(id)?.signals.find((s) => s.name === name);
  // value names and comments (they may span lines: join the text first)
  const all = lines.join('\n');
  for (const v of all.matchAll(/^VAL_\s+(\d+)\s+(\w+)\s+((?:-?\d+\s+"[^"]*"\s*)+);/gm)) {
    const raw = Number(v[1]);
    const sig = byMsgSig(raw >= 0x80000000 ? raw - 0x80000000 : raw, v[2]);
    if (!sig) continue;
    sig.values = {};
    for (const p of v[3].matchAll(/(-?\d+)\s+"([^"]*)"/g)) sig.values[p[1]] = p[2];
  }
  for (const c of all.matchAll(/^CM_\s+SG_\s+(\d+)\s+(\w+)\s+"((?:[^"\\]|\\.)*)"\s*;/gm)) {
    const raw = Number(c[1]);
    const sig = byMsgSig(raw >= 0x80000000 ? raw - 0x80000000 : raw, c[2]);
    if (sig) sig.comment = c[3].replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  return { messages: withSeriesNames(messages) };
}

/** Give each signal its series name: its own name where unique, else name_ID (the message id in hex). */
function withSeriesNames(messages) {
  const count = new Map();
  for (const m of messages.values()) for (const s of m.signals) count.set(s.name, (count.get(s.name) || 0) + 1);
  for (const m of messages.values()) {
    const hex = m.id.toString(16).toUpperCase().padStart(3, '0');
    for (const s of m.signals) s.series = count.get(s.name) > 1 ? `${s.name}_${hex}` : s.name;
  }
  return messages;
}

/** The raw (unscaled) bits of a signal in a frame's bytes. */
function rawBits(bytes, sig) {
  const { start, length, little } = sig;
  let value = 0;
  if (little) {
    // Intel: bits counted from the least significant bit of byte 0 upward
    for (let i = 0; i < length; i++) {
      const bit = start + i;
      const byte = bit >> 3;
      if (byte >= bytes.length) return null;
      if ((bytes[byte] >> (bit & 7)) & 1) value += 2 ** i;
    }
  } else {
    // Motorola: start is the most significant bit; walk toward the least
    let bit = start;
    for (let i = length - 1; i >= 0; i--) {
      const byte = bit >> 3;
      if (byte >= bytes.length) return null;
      if ((bytes[byte] >> (bit & 7)) & 1) value += 2 ** i;
      // the next bit: down within the byte, then the next byte's top bit
      bit = (bit & 7) === 0 ? bit + 15 : bit - 1;
    }
  }
  if (sig.signed && length > 0 && value >= 2 ** (length - 1)) value -= 2 ** length;
  return value;
}

/** A signal's value in a frame: scaled number (null when it does not fit). */
function signalValue(bytes, sig) {
  const raw = rawBits(bytes, sig);
  if (raw === null) return null;
  return raw * sig.factor + sig.offset;
}

/** Every signal a frame carries: [[signal, value], …] (multiplexed ones by the frame's mux value). */
function decodeFrame(msg, bytes) {
  const out = [];
  const muxValue = msg.mux ? rawBits(bytes, msg.mux) : null;
  for (const sig of msg.signals) {
    if (sig.mux !== null && sig.mux !== 'M' && sig.mux !== muxValue) continue;
    const v = signalValue(bytes, sig);
    if (v !== null && Number.isFinite(v)) out.push([sig, v]);
  }
  return out;
}

// The DBC sets, one per kind of car (server/carModels.js says which a car gets): files read in
// order, as one text (a BO_ read later replaces the message of its id, its bus included, and the
// VAL_ and CM_ lines of every file name the signals of the messages that stay; a later file's
// own come last, so they win). `bus` (optional) names the bus of every message of that file, for
// a file whose BO_ lines name the sending ECU instead (opendbc's).
//
//   tesla-3y: Model 3 and Model Y of every year, and the 2021+ Model S and X (as close to the 3
//     and Y as the public sources know; not checked on one). model3dbc, the messages it lacks from
//     opendbc (checked against the owner's Model Y), then the firmware overrides (checked on it).
//   tesla-sx-legacy: Model S and X before the 2021 refresh. opendbc's chassis and powertrain
//     files, then sx-legacy.dbc (from OVMS; not checked on a car).
const PROFILES = {
  'tesla-3y': {
    files: [{ file: 'Model3CAN.dbc' }, { file: 'model3y-opendbc.dbc' }, { file: 'override.dbc' }],
    buses: { can0: 'VehicleBus', can1: 'ChassisBus' }
  },
  'tesla-sx-legacy': {
    files: [{ file: 'opendbc-tesla_can.dbc', bus: 'ChassisBus' }, { file: 'opendbc-tesla_powertrain.dbc', bus: 'PowertrainBus' }, { file: 'sx-legacy.dbc' }],
    buses: { can0: 'PowertrainBus', can1: 'ChassisBus' }
  }
};
const DEFAULT_PROFILE = 'tesla-3y';
const BO_LINE = /^(BO_\s+\d+\s+\w+\s*:\s*\d+\s+)\w+/gm;

const parsed = new Map();
/** A DBC set by its name (PROFILES), parsed once; an unknown name is the default set. */
function dbcFor(profile = DEFAULT_PROFILE) {
  const name = Object.hasOwn(PROFILES, profile) ? profile : DEFAULT_PROFILE;
  if (!parsed.has(name)) {
    const read = ({ file, bus }) => {
      const text = fs.readFileSync(path.join(__dirname, 'dbc', file), 'utf8');
      return bus ? text.replace(BO_LINE, `$1${bus}`) : text;
    };
    const dbc = parseDbc(`${PROFILES[name].files.map(read).join('\n')}\n`);
    dbc.profile = name;
    dbc.buses = { ...PROFILES[name].buses };
    parsed.set(name, dbc);
  }
  return parsed.get(name);
}
/** The Model 3/Y set (model3dbc, the opendbc messages checked on a Model Y, the firmware overrides), parsed once. */
const bundledDbc = () => dbcFor(DEFAULT_PROFILE);

module.exports = { parseDbc, decodeFrame, signalValue, rawBits, bundledDbc, dbcFor, PROFILES, DEFAULT_PROFILE };
