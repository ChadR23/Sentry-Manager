'use strict';

// The Encoder's Hardware panel: what the running conversion uses (encoder,
// GPU, decoding) and what it has cost so far, put together from the stats
// engine's latest sample and the converter.

const RUNNING = new Set(['discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing']);

// The device of a running job's last encode, so the panel keeps naming it
// while a clip is verified or saved (no ffmpeg runs then).
const lastDevice = new Map();

// Whether a job's energy includes the CPU's, as last known: a sample with
// no power reading cannot tell, and once the CPU has been measured a stale
// reading does not make the run GPU only for a poll.
const cpuKnown = new Map();

/** The GPU a render node belongs to, or the only GPU there is. */
function gpuFor(gpus, node) {
  if (!Array.isArray(gpus) || !gpus.length) return null;
  return gpus.find((g) => node && g.node && (g.node === node || String(node).endsWith(`/${g.node}`) || String(g.node).endsWith(`/${node}`))) || (gpus.length === 1 ? gpus[0] : null);
}

/** A job's clips converted so far and the bytes they saved. */
function jobProgress(job) {
  let clips = 0;
  for (const item of job?.items || []) if (item?.kind === 'video' && item.state === 'completed' && item.eligibleVideo !== false) clips++;
  return { clips, savedB: Number(job?.counters?.savedBytes) || 0 };
}

const r1 = (n) => Math.round(n * 10) / 10;

/**
 * How many clips the job converts at once, or null: as the converter runs it
 * (`slots`, which leaves out a lane whose GPU is not in the container), else
 * its concurrency, else its lanes together.
 */
function concurrencyOf(job, slots = null) {
  if (Number.isSafeInteger(slots) && slots > 0) return slots;
  const config = job?.config;
  const n = Number(config?.concurrency);
  if (Number.isSafeInteger(n) && n > 0) return n;
  const lanes = Array.isArray(config?.lanes) ? config.lanes.reduce((sum, lane) => sum + (Number.isSafeInteger(lane?.concurrency) && lane.concurrency > 0 ? lane.concurrency : 0), 0) : 0;
  return lanes > 0 ? lanes : null;
}

/**
 * One entry per device the job's running clips use: one per GPU set in the
 * Encoder (grouped by lane), else just the one a job without lanes uses,
 * however its clips decode (a clip decoded or redone on the CPU names no
 * GPU, and is still that job's).
 */
function deviceEntries(workers, gpus) {
  const lanes = workers.some((w) => w.deviceId !== null && w.deviceId !== undefined);
  const groups = new Map();
  for (const w of workers) {
    const key = lanes ? w.deviceId ?? null : null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }
  const entries = [];
  for (const [id, list] of groups) {
    // the clip that names its GPU (one redone on the CPU names none)
    const first = list.find((w) => w.hardware && w.device) || list.find((w) => w.hardware) || list[0];
    const gpu = first.hardware ? gpuFor(gpus, first.device) : null;
    entries.push({
      id,
      name: first.hardware ? gpu?.name || null : 'CPU',
      node: first.device || (first.hardware ? gpu?.node || null : null),
      encoder: first.encoder || null,
      hardware: first.hardware === true,
      workers: list.length,
      video: gpu ? gpu.video ?? null : null,
      busy: gpu ? gpu.busy ?? null : null
    });
  }
  // GPUs first, in a steady order; the CPU last
  const rank = (e) => (e.hardware ? 0 : 1);
  return entries.sort((a, b) => rank(a) - rank(b) || String(a.id ?? '').localeCompare(String(b.id ?? '')));
}

/**
 * The `encoder` block of GET /api/stats, or null when no conversion job is
 * known. `jobs` is the server's map of converter job snapshots; `slotsOf(id)`
 * (optional) says how many clips the converter runs at once for a job.
 */
function encoderBlock({ snapshot, jobs, workers = [], energy = null, slotsOf = null }) {
  const list = [...(jobs?.values?.() || [])];
  const job = list.find((s) => RUNNING.has(s.state)) || list.find((s) => s.state === 'paused' || s.state === 'paused_network');
  if (!job && !workers.length) return null;
  // (a clip sent ahead that waits in a node's queue converts nowhere yet)
  const mine = (job ? workers.filter((w) => w.jobId === job.id) : workers).filter((w) => !w.waitingOnNode);
  for (const known of [lastDevice, cpuKnown]) for (const id of known.keys()) if (!job || id !== job.id) known.delete(id);
  if (job && mine[0]) lastDevice.set(job.id, mine[0]);
  const first = mine[0] || (job && RUNNING.has(job.state) ? lastDevice.get(job.id) : null) || null;
  const gpu = gpuFor(snapshot?.gpus, first?.device);
  const now = jobProgress(job);
  const run = job ? energy?.byJob?.[job.id] || null : null;
  // With the energy measured, clips and space count from where the job
  // stood when measuring began (its baseline), against the energy measured
  // since: clips per kWh start at 0 and rise as clips finish. Not measured:
  // the job's own totals, as there is nothing to divide.
  const base = run?.base || null;
  const power = snapshot?.power || null;
  // without the CPU's power, the energy is the GPU's alone (a built-in GPU's
  // reading is the whole chip's, CPU included)
  const measured = power?.cpuSource || Number.isFinite(power?.chipW) ? true : power?.gpuSource ? false : null;
  if (job && measured !== null && cpuKnown.get(job.id) !== true) cpuKnown.set(job.id, measured);
  const cpuMeasured = job ? cpuKnown.get(job.id) ?? null : measured;
  let slots = null;
  try {
    slots = job && typeof slotsOf === 'function' ? slotsOf(job.id) : null;
  } catch {
    slots = null;
  }
  const devices = deviceEntries(mine, snapshot?.gpus);
  return {
    jobId: job?.id || null,
    state: job?.state || null,
    running: Boolean(job && RUNNING.has(job.state)),
    workers: mine,
    // the Hardware panel keeps a row for each, a clip in it or not
    concurrency: concurrencyOf(job, slots),
    device: first ? {
      encoder: first.encoder || null,
      hardware: first.hardware === true,
      gpuName: first.hardware ? gpu?.name || null : null,
      node: first.device || gpu?.node || null,
      decode: first.decode || null
    } : null,
    devices,
    run: job ? {
      wh: run ? r1(run.wh) : null,
      avgW: run ? Math.round(run.avgW) : null,
      cost: run?.cost ?? null,
      clips: run ? (base ? Math.max(0, now.clips - base.clips) : 0) : now.clips,
      savedB: run ? (base ? Math.max(0, now.savedB - base.savedB) : 0) : now.savedB,
      // the energy the clips above were converted with
      sinceWh: run ? (base ? r1(Math.max(0, run.wh - base.wh)) : 0) : null,
      cpuMeasured,
      startedAt: job.startedAt || job.createdAt || null
    } : null
  };
}

module.exports = { encoderBlock, gpuFor, jobProgress, RUNNING };
