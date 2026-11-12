'use strict';

// How this server's conversions have been running, for the hourly heartbeat
// (server/index.js reportHeartbeat; docs/reports-api.md, `convert`): the
// average speed of the last 24 hours of converting, and the encoder, device,
// API and codec of the latest conversion.
//
// It is fed the converter's live encodes (jobService activeEncodes(): one
// entry per running ffmpeg, with its -progress fps) while a job runs, one
// sample at most every `everyMs`. A sample's speed is the frames a second of
// every clip encoding here at that moment together (what the Encoder's
// progress line shows). Clips a node converts are left out: their speed and
// device are the node's, not this server's. What it last knew is kept in the
// settings table, so a restart (or a day without converting) still reports
// the latest numbers; nothing converted yet is all nulls.

const KEY = 'convert-stats';
const DAY_MS = 86_400_000;

// the ffmpeg encoder's API by its suffix; a CPU encoder is a library (libx265, libsvtav1, libaom-av1)
const API_RE = /_(nvenc|vaapi|qsv|amf|videotoolbox|mf|v4l2m2m)$/;
/** The API an ffmpeg encoder uses: nvenc, vaapi, qsv, amf, videotoolbox, ..., cpu, or null. */
function apiOf(encoder) {
  const e = String(encoder || '');
  const m = API_RE.exec(e);
  if (m) return m[1];
  return /^lib[a-z0-9-]+$/.test(e) ? 'cpu' : null;
}
/** The codec an ffmpeg encoder writes: h265, av1, h264, or null. */
function codecOf(encoder) {
  const e = String(encoder || '');
  if (/^(hevc_|libx265$|libkvazaar$)/.test(e)) return 'h265';
  if (/^(av1_|libsvtav1$|libaom-av1$|librav1e$)/.test(e)) return 'av1';
  if (/^(h264_|libx264$|libopenh264$)/.test(e)) return 'h264';
  return null;
}
const r1 = (n) => Math.round(n * 10) / 10;
const EMPTY = Object.freeze({ fps: null, encoder: null, device: null, api: null, codec: null });

/**
 * db: { get, set } (optional); deviceName(entry): the GPU name of a hardware
 * encode's render node (or null); cpuName(): the CPU's model name.
 */
function createConvertStats({ db = null, now = () => Date.now(), everyMs = 30_000, windowMs = DAY_MS, deviceName = () => null, cpuName = () => null } = {}) {
  let samples = []; // [{ at, fps }] of the last windowMs
  let last = null; // { encoder, device, api, codec, at }
  let lastAt = -Infinity;
  const kept = () => {
    try { return db?.get(KEY, null) || null; } catch { return null; }
  };

  /** Notes the live encodes (activeEncodes(), or a function giving them: only called when a sample is due); at most one sample every everyMs. */
  function sample(encodes) {
    const t = now();
    if (t - lastAt < everyMs) return false;
    const list = typeof encodes === 'function' ? encodes() : encodes;
    const mine = (Array.isArray(list) ? list : []).filter((e) => e && e.remote !== true && !e.node && e.started !== false && !e.waitingOnNode && Number.isFinite(e.fps) && e.fps > 0);
    if (!mine.length) return false;
    lastAt = t;
    const fps = mine.reduce((n, e) => n + e.fps, 0);
    samples = samples.filter((s) => t - s.at < windowMs);
    samples.push({ at: t, fps });
    // the encoder most clips use right now (a GPU first when it is a tie)
    const count = new Map();
    for (const e of mine) count.set(e.encoder, (count.get(e.encoder) || 0) + 1);
    const top = mine.slice().sort((a, b) => (count.get(b.encoder) - count.get(a.encoder)) || (Number(b.hardware === true) - Number(a.hardware === true)))[0];
    let device = null;
    try { device = top.hardware === true ? deviceName(top) : cpuName(); } catch { device = null; }
    last = { encoder: top.encoder || null, device: device || null, api: apiOf(top.encoder), codec: codecOf(top.encoder), fps: average(), at: t };
    try { db?.set(KEY, last); } catch { /* next sample */ }
    return true;
  }
  function average() {
    const t = now();
    const recent = samples.filter((s) => t - s.at < windowMs);
    return recent.length ? r1(recent.reduce((n, s) => n + s.fps, 0) / recent.length) : null;
  }
  /** { fps, encoder, device, api, codec }: each null when not known (nothing converted yet). */
  function summary() {
    const k = last || kept();
    if (!k) return { ...EMPTY };
    const fps = average() ?? (Number.isFinite(k.fps) ? k.fps : null);
    return { fps, encoder: k.encoder ?? null, device: k.device ?? null, api: k.api ?? null, codec: k.codec ?? null };
  }
  return { sample, summary };
}

module.exports = { createConvertStats, apiOf, codecOf };
