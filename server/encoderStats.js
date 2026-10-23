'use strict';

// The Encoder's Hardware panel: what the running conversion uses (encoder,
// GPU, decoding), what it has cost so far and what is holding it back, put
// together from the stats engine's latest sample and the converter.

const RUNNING = new Set(['discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing']);

const pct = (n) => (Number.isFinite(n) ? Math.round(n) : null);

// The device of a running job's last encode, so the panel keeps naming it
// while a clip is verified or saved (no ffmpeg runs then).
const lastDevice = new Map();

/** The GPU a render node belongs to, or the only GPU there is. */
function gpuFor(gpus, node) {
  if (!Array.isArray(gpus) || !gpus.length) return null;
  return gpus.find((g) => node && g.node && (g.node === node || String(node).endsWith(`/${g.node}`) || String(g.node).endsWith(`/${node}`))) || (gpus.length === 1 ? gpus[0] : null);
}

const engineUse = (gpu) => (gpu ? Math.max(gpu.video ?? -1, gpu.busy ?? -1) : -1);

/**
 * What is limiting the run right now, in words the owner can act on.
 * Only claimed when the numbers show it; otherwise "none". `gpus` are the
 * GPUs in use when the job runs on several (one set per GPU).
 */
function bottleneck({ workers, cpu, gpu, filesystems, gpus = null }) {
  if (!workers.length) return { kind: 'none', message: null };
  const several = Array.isArray(gpus) && gpus.length > 1;
  const busiest = several ? gpus.reduce((top, g) => (engineUse(g) > engineUse(top) ? g : top), gpus[0]) : null;
  const hardware = workers.some((w) => w.hardware);
  const video = several ? engineUse(busiest) : engineUse(gpu);
  const cpuUse = cpu?.usage ?? -1;
  const slowShare = (filesystems || []).find((f) => f && f.reachable !== false && Number(f.latencyMs) > 500);
  if (hardware && video >= 90) {
    return several
      ? { kind: 'gpu-video', message: `The ${busiest.name || 'GPU'}'s video engine is ${pct(video)}% busy, so more at once on it won't go faster.` }
      : { kind: 'gpu-video', message: `The GPU's video engine is ${pct(video)}% busy, so more conversions at once won't go faster.` };
  }
  if (cpuUse >= 90) {
    return {
      kind: 'cpu',
      message: hardware
        ? `The CPU is ${pct(cpuUse)}% busy (decoding, telemetry and checks), so more conversions at once won't go faster.`
        : `The CPU is ${pct(cpuUse)}% busy encoding; a GPU encoder or fewer conversions at once would help.`
    };
  }
  if (slowShare) {
    return { kind: 'source-read', message: `The footage share takes ${Math.round(slowShare.latencyMs)} ms to answer, so clips wait on the NAS.` };
  }
  // only claimed when the numbers are known
  const cpuKnown = cpuUse >= 0;
  // with several GPUs, every one in use must be known and below 60%
  const gpuKnown = !hardware || (several ? gpus.every((g) => engineUse(g) >= 0) : video >= 0);
  const gpuRoom = !hardware || (several ? gpus.every((g) => engineUse(g) < 60) : video < 60);
  if (cpuKnown && gpuKnown && cpuUse < 70 && gpuRoom && workers.length > 0) {
    return {
      kind: 'none',
      message: hardware
        ? 'Nothing is maxed out: the GPU and CPU have room, so more conversions at once may go faster (try the benchmark).'
        : 'Nothing is maxed out: the CPU has room, so more conversions at once may go faster (try the benchmark).'
    };
  }
  return { kind: 'none', message: null };
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
  // the GPUs in use, when the job runs on more than one
  const used = devices.filter((d) => d.hardware && d.name);
  const usedGpus = used.length > 1 ? used.map((d) => ({ name: d.name, video: d.video, busy: d.busy })) : null;
  // the GPU whose engine limits the clips: the one a GPU clip names (the
  // first clip may be one on the CPU, a CPU lane's or one redone there)
  const encoding = mine.find((w) => w.hardware && w.device) || mine.find((w) => w.hardware) || first;
  const engine = encoding === first ? gpu : gpuFor(snapshot?.gpus, encoding?.device);
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
    } : null,
    bottleneck: bottleneck({ workers: mine, cpu: snapshot?.cpu, gpu: engine, filesystems: snapshot?.filesystems, ...(usedGpus ? { gpus: usedGpus } : {}) })
  };
}

module.exports = { encoderBlock, bottleneck, gpuFor, RUNNING };
