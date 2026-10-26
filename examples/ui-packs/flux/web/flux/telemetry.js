// Tesla dashcam telemetry: a tiny protobuf reader for the SeiMetadata records
// that GET /api/telemetry returns as [timestampMs, base64] pairs.
const GEARS = ['P', 'D', 'R', 'N'];
const AUTOPILOT = ['Off', 'FSD', 'Autosteer', 'TACC'];

function b64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function decodeRecord(base64) {
  // (the server already removed the emulation-prevention bytes)
  const buf = b64(base64);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const rec = {};
  let i = 0;
  const varint = () => {
    let r = 0;
    let shift = 0;
    let b;
    do {
      if (i >= buf.length) throw new Error('truncated');
      b = buf[i++];
      r += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80 && shift < 64);
    return r;
  };
  try {
    while (i < buf.length) {
      const key = varint();
      const field = Math.floor(key / 8);
      const wire = key & 7;
      let val;
      if (wire === 0) val = varint();
      else if (wire === 1) { val = view.getFloat64(i, true); i += 8; }
      else if (wire === 5) { val = view.getFloat32(i, true); i += 4; }
      else if (wire === 2) { const n = varint(); i += n; continue; }
      else break;
      switch (field) {
        case 1: rec.version = val; break;
        case 2: rec.gear = GEARS[val] ?? String(val); break;
        case 3: rec.frame = val; break;
        case 4: rec.speed = val; break; // m/s
        case 5: rec.accel = val; break; // 0..1 (or %)
        case 6: rec.steering = val; break; // degrees
        case 7: rec.blinkL = Boolean(val); break;
        case 8: rec.blinkR = Boolean(val); break;
        case 9: rec.brake = Boolean(val); break;
        case 10: rec.autopilot = AUTOPILOT[val] ?? String(val); break;
        case 11: rec.lat = val; break;
        case 12: rec.lon = val; break;
        case 13: rec.heading = val; break;
        case 14: rec.ax = val; break;
        case 15: rec.ay = val; break;
        case 16: rec.az = val; break;
        default: break;
      }
    }
  } catch { /* partial record */ }
  if (rec.gear === undefined) rec.gear = 'P';
  if (rec.autopilot === undefined) rec.autopilot = 'Off';
  return rec;
}

const cache = new Map();
/** { times: [ms], recs: [record] } for a clip, or null without telemetry. */
export async function telemetryFor(path) {
  if (cache.has(path)) return cache.get(path);
  const p = (async () => {
    const res = await fetch(`/api/telemetry?path=${encodeURIComponent(path)}`, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const data = await res.json();
    const frames = Array.isArray(data.frames) ? data.frames : [];
    if (!frames.length) return null;
    const times = [];
    const recs = [];
    for (const [t, b] of frames) {
      times.push(Number(t));
      recs.push(decodeRecord(b));
    }
    return { times, recs };
  })().catch(() => null);
  cache.set(path, p);
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return p;
}

/** The record at time ms (binary search). */
export function recordAt(tel, ms) {
  if (!tel) return null;
  const t = tel.times;
  let lo = 0;
  let hi = t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t[mid] <= ms) lo = mid; else hi = mid - 1;
  }
  return tel.recs[lo];
}

/** Frames per second from the record timestamps (median spacing). */
export function fpsOf(tel) {
  if (!tel || tel.times.length < 3) return null;
  const d = [];
  for (let i = 1; i < Math.min(tel.times.length, 200); i++) d.push(tel.times[i] - tel.times[i - 1]);
  d.sort((a, b) => a - b);
  const m = d[d.length >> 1];
  return m > 0 ? 1000 / m : null;
}
