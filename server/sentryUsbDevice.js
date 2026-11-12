'use strict';

// Sentry USB's info file on the archive share, beside its status file
// (docs/sentry-usb.md, "The info file"):
//
//   <share root>/.sentryusb/device-status.json
//
// The Pi writes it while it reaches the share: its version, its storage, the
// size of the car's drives, its CPU temperature and the car's readings (the
// Car card). There is no pairing and no link: this file is all Sentry Six
// Manager knows about the Pi. Everything in it is untrusted: only the keys
// below are kept, each with its type and range checked; a bad field is
// dropped, the rest kept. A file without schema 1 and a sane written_unix is
// no file.
//
//   const d = parseDevice(text, { now: Date.now() });   // object | null

const { cleanCar, EARLIEST, AHEAD } = require('./sentryUsbCar');

const FILE = 'device-status.json';
const MAX_BYTES = 16 * 1024;
const DRIVE_NAMES = ['cam', 'music', 'lightshow', 'boombox'];
const MAX_DRIVES = 8;
const MAX_BYTES_VALUE = 2 ** 53 - 1;

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const bytes = (v) => (Number.isSafeInteger(v) && v >= 0 && v <= MAX_BYTES_VALUE ? v : null);
// printable text only, trimmed and capped
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim().slice(0, max) : '');

/** The checked info file, or null. */
function parseDevice(json, { now = Date.now() } = {}) {
  let raw;
  try { raw = typeof json === 'string' ? JSON.parse(json) : json; } catch { return null; }
  if (!isObj(raw) || raw.schema !== 1) return null;
  const nowS = Math.floor(now / 1000);
  const written = raw.written_unix;
  if (!Number.isInteger(written) || written < EARLIEST || written > nowS + AHEAD) return null;
  const out = { writtenUnix: written, version: text(raw.version, 64) || null, storage: null, drives: [], cpuTempC: null, car: null };
  if (isObj(raw.storage)) {
    const s = { totalBytes: bytes(raw.storage.total_bytes), usedBytes: bytes(raw.storage.used_bytes), freeBytes: bytes(raw.storage.free_bytes) };
    // a total smaller than what it holds is not believed
    if (s.totalBytes !== null && ((s.usedBytes ?? 0) > s.totalBytes || (s.freeBytes ?? 0) > s.totalBytes)) s.totalBytes = null;
    if (s.totalBytes !== null || s.usedBytes !== null || s.freeBytes !== null) out.storage = s;
  }
  if (Array.isArray(raw.drives)) {
    const seen = new Set();
    for (const d of raw.drives.slice(0, MAX_DRIVES)) {
      if (!isObj(d) || !DRIVE_NAMES.includes(d.name) || seen.has(d.name)) continue;
      const size = bytes(d.size_bytes);
      if (size === null) continue;
      seen.add(d.name);
      out.drives.push({ name: d.name, sizeBytes: size });
    }
  }
  if (typeof raw.cpu_temp_c === 'number' && Number.isFinite(raw.cpu_temp_c) && raw.cpu_temp_c >= -40 && raw.cpu_temp_c <= 125) out.cpuTempC = Math.round(raw.cpu_temp_c * 10) / 10;
  const car = cleanCar(raw.car, { now });
  if (car) { delete car.units; out.car = car; }
  return out;
}

module.exports = { parseDevice, FILE, MAX_BYTES, DRIVE_NAMES };
