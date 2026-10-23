'use strict';

// The Encoder's Hardware panel: what the running conversion uses (encoder,
// GPU, decoding), what it has cost so far and what is holding it back, put
// together from the stats engine's latest sample and the converter.

const RUNNING = new Set(['discovering', 'waiting', 'staging', 'encoding', 'writing-telemetry', 'verifying', 'copying', 'replacing']);

const pct = (n) => (Number.isFinite(n) ? Math.round(n) : null);

/** The GPU a render node belongs to, or the only GPU there is. */
function gpuFor(gpus, node) {
  if (!Array.isArray(gpus) || !gpus.length) return null;
  return gpus.find((g) => node && g.node && (g.node === node || String(node).endsWith(`/${g.node}`) || String(g.node).endsWith(`/${node}`))) || (gpus.length === 1 ? gpus[0] : null);
}

/**
 * What is limiting the run right now, in words the owner can act on.
 * Only claimed when the numbers show it; otherwise "none".
 */
function bottleneck({ workers, cpu, gpu, filesystems }) {
  if (!workers.length) return { kind: 'none', message: null };
  const hardware = workers.some((w) => w.hardware);
  const video = gpu ? Math.max(gpu.video ?? -1, gpu.busy ?? -1) : -1;
  const cpuUse = cpu?.usage ?? -1;
  const slowShare = (filesystems || []).find((f) => f && f.reachable !== false && Number(f.latencyMs) > 500);
  if (hardware && video >= 90) {
    return { kind: 'gpu-video', message: `The GPU's video engine is ${pct(video)}% busy, so more conversions at once won't go faster.` };
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
  const roomy = (video < 0 || video < 60) && (cpuUse < 0 || cpuUse < 70);
  if (roomy && workers.length > 0) {
    return { kind: 'none', message: 'Nothing is maxed out: the GPU and CPU have room, so more conversions at once may go faster (try the benchmark).' };
  }
  return { kind: 'none', message: null };
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
  const first = mine[0] || null;
  const gpu = gpuFor(snapshot?.gpus, first?.device);
  let clips = 0;
  for (const item of job?.items || []) if (item?.kind === 'video' && item.state === 'completed' && item.eligibleVideo !== false) clips++;
  const run = job ? energy?.byJob?.[job.id] || null : null;
  return {
    jobId: job?.id || null,
    running: Boolean(job && RUNNING.has(job.state)),
    workers: mine,
    device: first ? {
      encoder: first.encoder || null,
      hardware: first.hardware === true,
      gpuName: first.hardware ? gpu?.name || null : null,
      node: first.device || gpu?.node || null,
      decode: first.decode || null
    } : null,
    run: job ? {
      wh: run ? Math.round(run.wh * 10) / 10 : null,
      avgW: run ? Math.round(run.avgW) : null,
      clips,
      savedB: Number(job.counters?.savedBytes) || 0,
      startedAt: job.startedAt || job.createdAt || null
    } : null,
    bottleneck: bottleneck({ workers: mine, cpu: snapshot?.cpu, gpu, filesystems: snapshot?.filesystems })
  };
}

module.exports = { encoderBlock, bottleneck, gpuFor, RUNNING };
