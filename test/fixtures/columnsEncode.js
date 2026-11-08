'use strict';

// A test-only encoder for the CAN Bridge's columns format (canbridge-columns-xz/2),
// written from the spec (docs/can-bridge-api.md, and the bridge's
// docs/sentry-manager-format.md "Columns format"): candump text lines in, the
// decompressed columns body out. The bridge's own encoder is Kotlin; this one
// only has to make bodies the decoder reads back to the same lines.

const MAGIC = Buffer.from('CANBRIDGE-COLUMNS/2\n', 'ascii');
const FRAME = /^\(([1-9]\d{0,11})\.(\d{6})\) ([\x21-\x7e][\x20-\x7e]{0,63}?)#((?:[0-9A-F]{2}){0,64})$/;

function varint(out, v) {
  let n = BigInt(v);
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
}

/** Lines (without LF) -> the columns body (a Buffer). */
function encodeColumns(lines) {
  const keys = new Map();
  const keyList = [];
  const notes = [];
  const frames = [];
  for (const line of lines) {
    const m = FRAME.exec(line);
    if (!m || m[3].includes('#') || m[3].includes(')')) { notes.push([frames.length, Buffer.from(line, 'latin1')]); continue; }
    let k = keys.get(m[3]);
    if (k === undefined) { k = keyList.length; keys.set(m[3], k); keyList.push(m[3]); }
    frames.push({ t: BigInt(m[1]) * 1000000n + BigInt(m[2]), k, data: Buffer.from(m[4], 'hex') });
  }
  const out = [];
  varint(out, keyList.length);
  for (const k of keyList) { varint(out, k.length); for (const c of Buffer.from(k, 'latin1')) out.push(c); }
  varint(out, notes.length);
  for (const [p, b] of notes) { varint(out, p); varint(out, b.length); for (const c of b) out.push(c); }
  varint(out, frames.length);
  let prev = 0n;
  for (const f of frames) {
    const d = f.t - prev;
    prev = f.t;
    varint(out, d >= 0n ? d << 1n : ((-d) << 1n) - 1n);
  }
  for (const f of frames) varint(out, f.k);
  const byKey = keyList.map(() => []);
  for (const f of frames) byKey[f.k].push(f);
  for (const list of byKey) for (const f of list) out.push(f.data.length);
  for (const list of byKey) {
    const longest = list.reduce((a, f) => Math.max(a, f.data.length), 0);
    for (let j = 0; j < longest; j++) for (const f of list) if (f.data.length > j) out.push(f.data[j]);
  }
  return Buffer.concat([MAGIC, Buffer.from(out)]);
}

module.exports = { encodeColumns };
