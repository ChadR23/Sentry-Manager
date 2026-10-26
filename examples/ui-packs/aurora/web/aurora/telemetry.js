// Aurora: Tesla driving data. GET /api/telemetry?path= answers
// { v: 1, frames: [[ms from clip start, base64 SeiMetadata record], ...] };
// each record is a small protobuf message decoded here.

const GEAR = { 0: 'P', 1: 'D', 2: 'R', 3: 'N' };
const PILOT = { 0: 'Off', 1: 'Self-driving', 2: 'Autosteer', 3: 'TACC' };

function bytesOf(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** One record: { gear, speed (m/s), accel (0..1), steer (deg), left, right, brake, pilot, lat, lon, heading }. */
export function decode(b64) {
  const buf = bytesOf(b64);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const r = { gear: 'P', pilot: 'Off' };
  let p = 0;
  const vint = () => {
    let v = 0;
    let mul = 1;
    for (let n = 0; n < 10; n++) {
      if (p >= buf.length) throw new RangeError('short');
      const b = buf[p++];
      v += (b & 127) * mul;
      if (!(b & 128)) return v;
      mul *= 128;
    }
    return v;
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
      if (field === 2) r.gear = GEAR[val] || String(val);
      else if (field === 3) r.frame = val;
      else if (field === 4) r.speed = val;
      else if (field === 5) r.accel = val;
      else if (field === 6) r.steer = val;
      else if (field === 7) r.left = Boolean(val);
      else if (field === 8) r.right = Boolean(val);
      else if (field === 9) r.brake = Boolean(val);
      else if (field === 10) r.pilot = PILOT[val] || String(val);
      else if (field === 11) r.lat = val;
      else if (field === 12) r.lon = val;
      else if (field === 13) r.heading = val;
    }
  } catch { /* a cut record keeps what it had */ }
  return r;
}

const cache = new Map();
/** { t: [ms], rec: [record] } for a clip, or null when it carries none. */
export function load(path) {
  if (cache.has(path)) return cache.get(path);
  const job = fetch(`/api/telemetry?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const frames = Array.isArray(data?.frames) ? data.frames : [];
      if (!frames.length) return null;
      return { t: frames.map((f) => Number(f[0])), rec: frames.map((f) => decode(f[1])) };
    })
    .catch(() => null);
  cache.set(path, job);
  if (cache.size > 30) cache.delete(cache.keys().next().value);
  return job;
}

/** The record shown at `ms` into the clip. */
export function at(tel, ms) {
  if (!tel) return null;
  let lo = 0;
  let hi = tel.t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tel.t[mid] <= ms) lo = mid;
    else hi = mid - 1;
  }
  return tel.rec[lo];
}

/** Frame rate from the record times (median gap), for frame stepping. */
export function fps(tel) {
  if (!tel || tel.t.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < Math.min(tel.t.length, 120); i++) gaps.push(tel.t[i] - tel.t[i - 1]);
  gaps.sort((a, b) => a - b);
  const g = gaps[gaps.length >> 1];
  return g > 0 ? 1000 / g : null;
}
