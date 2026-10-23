'use strict';

// The Encoder's Hardware panel: what the running conversion uses (encoder,
// GPU, decoding) and what it has cost so far, put together from the stats
// engine's latest sample and the converter.

const RUNNING = new Set(['discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing']);

// The device of a running job's last encode, so the panel keeps naming it
// while a clip is verified or saved (no ffmpeg runs then).
const lastDevice = new Map();

/** The GPU a render node belongs to, or the only GPU there is. */
function gpuFor(gpus, node) {
  if (!Array.isArray(gpus) || !gpus.length) return null;
  return gpus.find((g) => node && g.node && (g.node === node || String(node).endsWith(`/${g.node}`) || String(g.node).endsWith(`/${node}`))) || (gpus.length === 1 ? gpus[0] : null);
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
 * known. `jobs` is the server's map of converter job snapshots.
 */
function encoderBlock({ snapshot, jobs, workers = [], energy = null }) {
  const list = [...(jobs?.values?.() || [])];
  const job = list.find((s) => RUNNING.has(s.state)) || list.find((s) => s.state === 'paused' || s.state === 'paused_network');
  if (!job && !workers.length) return null;
  const mine = job ? workers.filter((w) => w.jobId === job.id) : workers;
  for (const id of lastDevice.keys()) if (!job || id !== job.id) lastDevice.delete(id);
  if (job && mine[0]) lastDevice.set(job.id, mine[0]);
  const first = mine[0] || (job && RUNNING.has(job.state) ? lastDevice.get(job.id) : null) || null;
  const gpu = gpuFor(snapshot?.gpus, first?.device);
  let clips = 0;
  for (const item of job?.items || []) if (item?.kind === 'video' && item.state === 'completed' && item.eligibleVideo !== false) clips++;
  const run = job ? energy?.byJob?.[job.id] || null : null;
  const devices = deviceEntries(mine, snapshot?.gpus);
  return {
    jobId: job?.id || null,
    state: job?.state || null,
    running: Boolean(job && RUNNING.has(job.state)),
    workers: mine,
    device: first ? {
      encoder: first.encoder || null,
      hardware: first.hardware === true,
      gpuName: first.hardware ? gpu?.name || null : null,
      node: first.device || gpu?.node || null,
      decode: first.decode || null
    } : null,
    devices,
    run: job ? {
      wh: run ? Math.round(run.wh * 10) / 10 : null,
      avgW: run ? Math.round(run.avgW) : null,
      cost: run?.cost ?? null,
      clips,
      savedB: Number(job.counters?.savedBytes) || 0,
      startedAt: job.startedAt || job.createdAt || null
    } : null
  };
}

module.exports = { encoderBlock, gpuFor, RUNNING };
