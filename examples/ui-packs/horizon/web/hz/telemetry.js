// Tesla dashcam telemetry for the heads-up display. GET /api/telemetry?path=
// returns { frames: [[timestampMs, base64 SeiMetadata], ...] }; this decodes the
// protobuf records (see dashcam.proto: gear, speed, pedals, blinkers, autopilot,
// GPS, heading, acceleration).

const GEAR = ['P', 'D', 'R', 'N'];
const PILOT = ['off', 'FSD', 'Autosteer', 'TACC'];
const KEYS = { 1: 'version', 2: 'gear', 3: 'frame', 4: 'speed', 5: 'pedal', 6: 'steer', 7: 'left', 8: 'right', 9: 'brake', 10: 'pilot', 11: 'lat', 12: 'lon', 13: 'heading', 14: 'ax', 15: 'ay', 16: 'az' };

function bytesOf(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** One record as a plain object. */
export function decode(b64) {
  const buf = bytesOf(b64);
  const dv = new DataView(buf.buffer);
  const r = {};
  let p = 0;
  const vint = () => {
    let n = 0;
    let mul = 1;
    for (;;) {
      if (p >= buf.length) throw new RangeError('short');
      const b = buf[p++];
      n += (b & 0x7f) * mul;
      if (!(b & 0x80)) return n;
      mul *= 128;
      if (mul > 2 ** 63) throw new RangeError('long');
    }
  };
  try {
    while (p < buf.length) {
      const tag = vint();
      const field = Math.floor(tag / 8);
      const type = tag % 8;
      let val;
      if (type === 0) val = vint();
      else if (type === 1) { val = dv.getFloat64(p, true); p += 8; }
      else if (type === 5) { val = dv.getFloat32(p, true); p += 4; }
      else if (type === 2) { p += vint(); continue; }
      else break;
      const k = KEYS[field];
      if (k) r[k] = val;
    }
  } catch { /* keep what was read */ }
  r.gear = GEAR[r.gear ?? 0] ?? String(r.gear);
  r.pilot = PILOT[r.pilot ?? 0] ?? String(r.pilot);
  r.left = Boolean(r.left);
  r.right = Boolean(r.right);
  r.brake = Boolean(r.brake);
  return r;
}

const memo = new Map();
/** { t: [ms], r: [records] } for a clip, or null when it has none. */
export function load(path) {
  if (memo.has(path)) return memo.get(path);
  const job = fetch(`/api/telemetry?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const fr = Array.isArray(data?.frames) ? data.frames : [];
      if (!fr.length) return null;
      return { t: fr.map((x) => Number(x[0])), r: fr.map((x) => decode(x[1])) };
    })
    .catch(() => null);
  memo.set(path, job);
  if (memo.size > 30) memo.delete(memo.keys().next().value);
  return job;
}

/** The record shown at media time ms. */
export function at(tel, ms) {
  if (!tel) return null;
  let lo = 0;
  let hi = tel.t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tel.t[mid] <= ms) lo = mid; else hi = mid - 1;
  }
  return tel.r[lo];
}

/** Frames per second from the record spacing. */
export function rate(tel) {
  if (!tel || tel.t.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < Math.min(tel.t.length, 120); i++) gaps.push(tel.t[i] - tel.t[i - 1]);
  gaps.sort((a, b) => a - b);
  const g = gaps[gaps.length >> 1];
  return g > 0 ? 1000 / g : null;
}
