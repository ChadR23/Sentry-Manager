// Daylight: reads the car's driving data (speed, gear, Autopilot, ...) that
// GET /api/telemetry returns: one [timestampMs, base64 protobuf] per frame,
// in Tesla's SeiMetadata message. A tiny protobuf reader is all it takes.

const GEARS = ['P', 'D', 'R', 'N'];
const AUTOPILOT = ['', 'Self-driving', 'Autosteer', 'Cruise control'];

function b64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** SeiMetadata fields by number; unknown fields are skipped. */
export function decodeRecord(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = {};
  let i = 0;
  const varint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (i >= bytes.length) throw new Error('truncated');
      const b = bytes[i++];
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return result;
      shift += 7;
      if (shift > 63) throw new Error('bad varint');
    }
  };
  while (i < bytes.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    let value;
    if (wire === 0) value = varint();
    else if (wire === 5) { value = view.getFloat32(i, true); i += 4; }
    else if (wire === 1) { value = view.getFloat64(i, true); i += 8; }
    else if (wire === 2) { const len = varint(); i += len; continue; }
    else throw new Error('unknown wire type');
    switch (field) {
      case 2: out.gear = GEARS[value] ?? '?'; break;
      case 3: out.frame = value; break;
      case 4: out.speedMps = value; break;
      case 5: out.accelerator = value; break;
      case 6: out.steering = value; break;
      case 7: out.blinkLeft = Boolean(value); break;
      case 8: out.blinkRight = Boolean(value); break;
      case 9: out.brake = Boolean(value); break;
      case 10: out.autopilot = AUTOPILOT[value] ?? ''; break;
      case 11: out.lat = value; break;
      case 12: out.lon = value; break;
      case 13: out.heading = value; break;
      default: break;
    }
  }
  // proto3 leaves out zero values: fill the defaults
  return { gear: 'P', speedMps: 0, accelerator: 0, steering: 0, blinkLeft: false, blinkRight: false, brake: false, autopilot: '', ...out };
}

/** [{ t (ms), ...record }] sorted by time; [] when the clip has none. */
export function decodeTelemetry(json) {
  if (!json || !Array.isArray(json.frames)) return [];
  const out = [];
  for (const [t, data] of json.frames) {
    try { out.push({ t: Number(t), ...decodeRecord(b64(String(data))) }); } catch { /* a damaged record */ }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** The record shown at time ms (the last one at or before it). */
export function at(records, ms) {
  if (!records.length) return null;
  let lo = 0;
  let hi = records.length - 1;
  if (ms <= records[0].t) return records[0];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (records[mid].t <= ms) lo = mid;
    else hi = mid - 1;
  }
  return records[lo];
}
