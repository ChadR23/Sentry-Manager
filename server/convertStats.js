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
// progress line shows). Clips a node converts are counted apart, per node
// (nodeSummary: the heartbeat's `nodes`): their speed and device are the
// node's, not this server's. What it last knew is kept in the settings
// table, so a restart (or a day without converting) still reports the latest
// numbers; nothing converted yet is all nulls.
//
// The device is worked out when a summary is asked for, from what the encode
// used (its render node or NVIDIA index, its API, or the CPU), so it is
// named as the heartbeat's `gpus` (or `cpu`) are named at that moment.

const { usableGpus, encodeGpuName } = require('./gpu');

const KEY = 'convert-stats';
const NODES_KEY = 'convert-stats-nodes';
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
// a node's lane ('node:<12 letters>@<its device>' or 'node:<id>'): the node and its own device
const NODE_LANE = /^node:([a-z0-9]{12})(?:@(pci:[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]|cpu))?$/;
const laneOf = (e) => NODE_LANE.exec(typeof e?.deviceId === 'string' ? e.deviceId : '');

/** The encoder most clips use right now (a GPU first when it is a tie). */
function topEncode(list) {
  const count = new Map();
  for (const e of list) count.set(e.encoder, (count.get(e.encoder) || 0) + 1);
  return list.slice().sort((a, b) => (count.get(b.encoder) - count.get(a.encoder)) || (Number(b.hardware === true) - Number(a.hardware === true)))[0];
}

/** One server's samples and latest encode: this one's, or one node's. */
function createTrack(windowMs, kept) {
  let samples = []; // [{ at, fps }] of the last windowMs
  let last = null; // { encoder, api, codec, fps, at, ref: { hardware, device, api } }
  function add(t, list) {
    const fps = list.reduce((n, e) => n + e.fps, 0);
    samples = samples.filter((s) => t - s.at < windowMs);
    samples.push({ at: t, fps });
    const top = topEncode(list);
    const api = apiOf(top.encoder);
    // what names the device later: a node's own device id, else the render node or NVIDIA index
    const device = laneOf(top)?.[2] || (typeof top.device === 'string' ? top.device : null);
    const hardware = top.hardware === true || (api !== null && api !== 'cpu');
    last = { encoder: top.encoder || null, api, codec: codecOf(top.encoder), fps: average(t), at: t, ref: { hardware: hardware && device !== 'cpu', device: device === 'cpu' ? null : device, api } };
    return last;
  }
  function average(t) {
    const recent = samples.filter((s) => t - s.at < windowMs);
    return recent.length ? r1(recent.reduce((n, s) => n + s.fps, 0) / recent.length) : null;
  }
  /** { fps, encoder, device, api, codec }; name(ref) names the device ({ hardware, device, api }). */
  function summary(t, name) {
    const k = last || kept();
    if (!k) return { ...EMPTY };
    const fps = average(t) ?? (Number.isFinite(k.fps) ? k.fps : null);
    // (a record kept before the device was worked out late: from its API)
    const ref = k.ref && typeof k.ref === 'object' ? k.ref : { hardware: Boolean(k.api && k.api !== 'cpu'), device: null, api: k.api ?? null };
    let device = null;
    if (k.encoder || k.api) {
      try { device = name(ref) || null; } catch { device = null; }
    }
    return { fps, encoder: k.encoder ?? null, device, api: k.api ?? null, codec: k.codec ?? null };
  }
  return { add, summary };
}

/**
 * db: { get, set } (optional); deviceName(ref): the GPU name of a hardware
 * encode ({ hardware, device: its render node or 'nvidia<N>' or null, api }),
 * or null; cpuName(): the CPU's model name. Both are asked when a summary is.
 */
function createConvertStats({ db = null, now = () => Date.now(), everyMs = 30_000, windowMs = DAY_MS, deviceName = () => null, cpuName = () => null } = {}) {
  let lastAt = -Infinity;
  const read = (key) => {
    try { return db?.get(key, null) || null; } catch { return null; }
  };
  const own = createTrack(windowMs, () => read(KEY));
  const nodes = new Map(); // node id -> track
  const keptNodes = () => { const k = read(NODES_KEY); return k && typeof k === 'object' && !Array.isArray(k) ? k : {}; };
  const nodeTrack = (id) => {
    if (!nodes.has(id)) nodes.set(id, createTrack(windowMs, () => keptNodes()[id] || null));
    return nodes.get(id);
  };
  const running = (e) => e && e.started !== false && !e.waitingOnNode && Number.isFinite(e.fps) && e.fps > 0;

  /** Notes the live encodes (activeEncodes(), or a function giving them: only called when a sample is due); at most one sample every everyMs. */
  function sample(encodes) {
    const t = now();
    if (t - lastAt < everyMs) return false;
    const list = (() => { const l = typeof encodes === 'function' ? encodes() : encodes; return Array.isArray(l) ? l : []; })();
    const mine = list.filter((e) => running(e) && e.remote !== true && !e.node);
    // a node's clips, by the node (its lane says which)
    const byNode = new Map();
    for (const e of list) {
      if (!running(e) || e.remote !== true) continue;
      const lane = laneOf(e);
      if (!lane) continue;
      if (!byNode.has(lane[1])) byNode.set(lane[1], []);
      byNode.get(lane[1]).push(e);
    }
    if (!mine.length && !byNode.size) return false;
    lastAt = t;
    if (mine.length) {
      const last = own.add(t, mine);
      try { db?.set(KEY, last); } catch { /* next sample */ }
    }
    if (byNode.size) {
      const kept = keptNodes();
      for (const [id, l] of byNode) kept[id] = nodeTrack(id).add(t, l);
      try { db?.set(NODES_KEY, kept); } catch { /* next sample */ }
    }
    return mine.length > 0;
  }
  /**
   * This server's { fps, encoder, device, api, codec }: each null when not
   * known (nothing converted yet). name(ref), when given, names the device
   * in place of deviceName/cpuName.
   */
  function summary(name = null) {
    return own.summary(now(), name || ((ref) => (ref.hardware ? deviceName(ref) : cpuName())));
  }
  /**
   * A node's (its id, as paired): name(ref) names its device from what it
   * used ({ hardware, device: its own device id or null, api }).
   */
  function nodeSummary(id, name = () => null) {
    return nodeTrack(String(id)).summary(now(), name);
  }
  /** Forgets the numbers of nodes no longer paired. */
  function keepNodes(ids) {
    const keep = new Set((ids || []).map(String));
    for (const id of [...nodes.keys()]) if (!keep.has(id)) nodes.delete(id);
    const kept = keptNodes();
    if (Object.keys(kept).some((id) => !keep.has(id))) {
      try { db?.set(NODES_KEY, Object.fromEntries(Object.entries(kept).filter(([id]) => keep.has(id)))); } catch { /* next time */ }
    }
  }
  return { sample, summary, nodeSummary, keepNodes };
}

const API_MAKER = { nvenc: 'NVIDIA', qsv: 'Intel', amf: 'AMD' };
/**
 * A node's device by the hardware it reported (server/nodes.js hardware():
 * { cpu, gpus, devices: [{ id, name }] }, or null): its CPU for a CPU
 * encode; else the name it gave the device the clip ran on (one of its
 * gpus), its first GPU for a whole-node lane, its only GPU; else a generic
 * "NVIDIA GPU" / "Intel GPU" / "AMD GPU" / "GPU".
 */
function nodeDeviceName(hw, ref) {
  if (!ref?.hardware) return hw?.cpu || null;
  const devices = Array.isArray(hw?.devices) ? hw.devices : [];
  const d = ref.device ? devices.find((x) => x.id === ref.device) : devices.find((x) => x.id !== 'cpu');
  if (d?.name) return d.name;
  if (Array.isArray(hw?.gpus) && hw.gpus.length === 1) return hw.gpus[0];
  return API_MAKER[ref.api] ? `${API_MAKER[ref.api]} GPU` : 'GPU';
}

/**
 * The heartbeat's hardware and conversion fields (server/index.js
 * reportHeartbeat): { cpu, gpus, convert, nodes } from found (detectGpus()),
 * cpu (this server's CPU model), stats (createConvertStats) and paired
 * (server/nodes.js hardware(): [{ id, hardware }]). convert.device is one of
 * gpus, or cpu; each node's the same by its own. A node is only its
 * hardware and numbers: its id names its numbers here and goes no further.
 */
function heartbeatHardware({ found = null, cpu = null, stats, paired = [], maxNodes = 8 }) {
  const list = Array.isArray(paired) ? paired : [];
  stats.keepNodes(list.map((n) => n.id));
  return {
    cpu,
    gpus: usableGpus(found).map((g) => g.name),
    convert: stats.summary((ref) => (ref.hardware ? encodeGpuName(found, ref) : cpu)),
    nodes: list.slice(0, maxNodes).map(({ id, hardware: hw }) => ({
      cpu: hw?.cpu || null,
      gpus: Array.isArray(hw?.gpus) ? hw.gpus : [],
      convert: stats.nodeSummary(id, (ref) => nodeDeviceName(hw, ref))
    }))
  };
}

module.exports = { createConvertStats, heartbeatHardware, nodeDeviceName, apiOf, codecOf };
