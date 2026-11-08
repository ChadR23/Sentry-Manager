'use strict';

// How the CAN index's minute files are kept on disk (canIndex.js writes them;
// canSearch.js and archiveGap.js read them too).
//
// In memory every series is a list of points [[ms since the minute, value], …]
// (raw payloads: [[ms, "HEX"], …]). On disk, since enc "c1", each one is two
// columns: the times as steps from the one before (the first from the start of
// the minute) and the values, { name: [[dt, …], [v, …]] }. CAN messages come
// at steady rates, so the steps repeat and pack far better: measured on a real
// 10-minute log of the owner's car, the signal files are about half the size
// and the raw files about a third smaller. A file without "enc" is the older
// point-list layout, still read as it is.
//
// The top of a minute file is { minute, enc, act, trust, logs, … } and the
// signals come after: readHead() unpacks only the first few KB for the logs'
// spans and id counts, the trust and `act`, what the minute shows of the car
// (classify: 'd' driving, 's' Sentry Mode, 'n' neither), worked out once when
// it is written. The id counts stay last for canSearch.js's tail read.

const fsp = require('fs/promises');
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const ENC = 'c1';
const GZIP = { level: 6 };

const MOVING_KPH = 3;
const MAX_KPH = 285; // DI_vehicleSpeed's range ends here; 4095 raw (287.6 km/h) is "not available"

/** What a CAN minute shows: 'drive', 'sentry' or 'none' (signals as point lists). */
function classify(sig) {
  const speed = (sig.DI_vehicleSpeed || []).map((p) => p[1]);
  const gear = (sig.DI_gear || []).map((p) => p[1]);
  const moving = speed.some((x) => x > MOVING_KPH && x <= MAX_KPH); // not "not available" (287.6)
  const inDR = gear.some((x) => x === 4 || x === 2);
  const parked = gear.length > 0 && gear.every((x) => x === 1);
  if (inDR || (moving && !parked)) return 'drive';
  if ((sig.UI_autopilotPowerStateRequest || []).some((p) => p[1] === 1) || (sig.UIsentryMode284 || []).some((p) => p[1] === 1)) return 'sentry';
  return 'none';
}
const ACT = { drive: 'd', sentry: 's', none: 'n' };
const KIND = { d: 'drive', s: 'sentry', n: 'none' };

function toColumns(series) {
  const out = {};
  for (const [name, pts] of Object.entries(series || {})) {
    if (!Array.isArray(pts)) continue;
    const dt = new Array(pts.length);
    const vs = new Array(pts.length);
    let prev = 0;
    for (let i = 0; i < pts.length; i++) {
      const t = Math.round(pts[i][0]);
      dt[i] = t - prev;
      prev = t;
      vs[i] = pts[i][1];
    }
    out[name] = [dt, vs];
  }
  return out;
}

function fromColumns(series) {
  const out = {};
  for (const [name, c] of Object.entries(series || {})) {
    if (!Array.isArray(c) || !Array.isArray(c[0]) || !Array.isArray(c[1])) continue;
    const [dt, vs] = c;
    const n = Math.min(dt.length, vs.length);
    const pts = new Array(n);
    let t = 0;
    for (let i = 0; i < n; i++) {
      t += dt[i];
      pts[i] = [t, vs[i]];
    }
    out[name] = pts;
  }
  return out;
}

/**
 * A signals minute as stored: { minute, trust?, logs, signals, ids } (signals as point
 * lists) to the file's text, its activity worked out from the signals.
 */
function encodeMinute({ minute, trust, logs, signals, ids }) {
  const act = ACT[classify(signals || {})];
  return JSON.stringify({ minute, enc: ENC, act, ...(trust ? { trust } : {}), logs, signals: toColumns(signals), ids });
}
/** A parsed signals minute, either layout, with point lists. */
function decodeMinute(data) {
  if (data && data.enc === ENC) {
    data.signals = fromColumns(data.signals);
    delete data.enc;
  }
  return data;
}
/** A raw minute ({ minute, raw, logs }) to the file's text. */
function encodeRaw(data) {
  const { minute, raw, logs, ...rest } = data;
  return JSON.stringify({ minute, enc: ENC, ...rest, raw: toColumns(raw), logs });
}
function decodeRaw(data) {
  if (data && data.enc === ENC) {
    data.raw = fromColumns(data.raw);
    delete data.enc;
  }
  return data;
}

const packMinute = (data) => gzip(encodeMinute(data), GZIP);
const packRaw = (data) => gzip(encodeRaw(data), GZIP);
/** Read and unpack a minute file (null when it is not there or unreadable). */
async function readMinuteFile(file) {
  try { return decodeMinute(JSON.parse((await gunzip(await fsp.readFile(file))).toString('utf8'))); } catch { return null; }
}
async function readRawFile(file) {
  try { return decodeRaw(JSON.parse((await gunzip(await fsp.readFile(file))).toString('utf8'))); } catch { return null; }
}

const HEAD_END = ',"signals":';
/**
 * The top of a minute file without its signals: { minute, act?, trust?, logs? }
 * (`act` only in files written since it was kept), or null. Only the first KB
 * are read and unpacked, more only when the logs take more room.
 */
async function readHead(file, first = 16 * 1024) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const size = (await fh.stat()).size;
    for (let want = first; ; want *= 4) {
      const len = Math.min(size, want);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, 0);
      let text;
      try {
        text = zlib.gunzipSync(buf.subarray(0, bytesRead), { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf8');
      } catch { return null; }
      const at = text.indexOf(HEAD_END);
      if (at > 0) {
        try { return JSON.parse(`${text.slice(0, at)}}`); } catch { return null; }
      }
      if (len >= size) {
        // no signals at all (or not this layout): the whole file
        try {
          const all = JSON.parse(text);
          delete all.signals;
          delete all.ids;
          return all;
        } catch { return null; }
      }
    }
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** A head's per-log id counts as one map, or null when a log of it has none (written before they were kept). */
function idsOfHead(head) {
  const logs = head?.logs;
  if (!logs || typeof logs !== 'object') return null;
  const parts = Object.values(logs);
  if (!parts.length || parts.some((p) => !p?.ids)) return null;
  const out = {};
  for (const p of parts) for (const [k, n] of Object.entries(p.ids)) out[k] = (out[k] || 0) + n;
  return out;
}

module.exports = {
  ENC, classify, ACT, KIND, encodeMinute, decodeMinute, encodeRaw, decodeRaw, packMinute, packRaw,
  readMinuteFile, readRawFile, readHead, idsOfHead, toColumns, fromColumns, gzip, gunzip
};
