'use strict';

// Background work limits picked from what the container has: its cgroup
// memory and CPU limits (v2 and v1), else the host's; the three sizes of
// server; an admin's numbers on top; and the limiter, the pace and the scrub
// previews reading a limit that changes. Files and os values are faked.

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickLimits, detectResources, tierFor, parseOverride, cleanOverride, TIERS } = require('../server/workLimits');
const { limiter } = require('../server/scanner');
const { createBackgroundPace } = require('../server/backgroundPace');

const GB = 1024 ** 3;
const fakeFs = (files) => ({
  readFileSync(p) {
    if (Object.hasOwn(files, p)) return files[p];
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  },
});
const fakeOs = (mem, cpus) => ({ totalmem: () => mem, availableParallelism: () => cpus, cpus: () => Array(cpus).fill({}) });

test('work limits: a normal PC gets the numbers every server had before', () => {
  for (const [mem, cpus] of [[8 * GB, 4], [7.6 * GB, 4], [32 * GB, 16], [64 * GB, 8]]) {
    const r = detectResources({ fs: fakeFs({ '/sys/fs/cgroup/memory.max': 'max\n', '/sys/fs/cgroup/cpu.max': 'max 100000\n' }), os: fakeOs(mem, cpus) });
    const p = pickLimits({ resources: r });
    assert.equal(p.tier, 'big', `${mem / GB} GB, ${cpus} CPUs`);
    assert.deepEqual(p.limits, { speedIndex: 4, codecChecks: 8, scrubPreviews: 3, telemetryReads: 2, thumbnails: 2 });
  }
  // no cgroup files at all (macOS, Windows, a bare host): the host's own numbers
  const r = detectResources({ fs: fakeFs({}), os: fakeOs(16 * GB, 8) });
  assert.deepEqual(r, { memoryBytes: 16 * GB, memoryFrom: 'host', cpus: 8, cpusFrom: 'host' });
});

test('work limits: the container limits count, not the host totals (cgroup v2)', () => {
  const host = fakeOs(64 * GB, 16);
  // docker run --memory 2g --cpus 1.5
  let r = detectResources({ fs: fakeFs({ '/sys/fs/cgroup/memory.max': String(2 * GB), '/sys/fs/cgroup/cpu.max': '150000 100000' }), os: host });
  assert.deepEqual(r, { memoryBytes: 2 * GB, memoryFrom: 'container', cpus: 1.5, cpusFrom: 'container' });
  assert.equal(pickLimits({ resources: r }).tier, 'small');
  assert.deepEqual(pickLimits({ resources: r }).limits, { speedIndex: 1, codecChecks: 2, scrubPreviews: 1, telemetryReads: 1, thumbnails: 1 });
  // the process's own cgroup folder (no cgroup namespace): its limit is read too
  r = detectResources({
    fs: fakeFs({ '/proc/self/cgroup': '0::/docker/abc\n', '/sys/fs/cgroup/docker/abc/memory.max': String(4 * GB), '/sys/fs/cgroup/docker/abc/cpu.max': '300000 100000' }),
    os: host,
  });
  assert.deepEqual(r, { memoryBytes: 4 * GB, memoryFrom: 'container', cpus: 3, cpusFrom: 'container' });
  assert.equal(pickLimits({ resources: r }).tier, 'medium');
  // a limit above what the host has: the host's
  r = detectResources({ fs: fakeFs({ '/sys/fs/cgroup/memory.max': String(128 * GB), '/sys/fs/cgroup/cpu.max': '3200000 100000' }), os: host });
  assert.deepEqual(r, { memoryBytes: 64 * GB, memoryFrom: 'host', cpus: 16, cpusFrom: 'host' });
});

test('work limits: cgroup v1 files, and its "no limit" number', () => {
  const host = fakeOs(16 * GB, 8);
  let r = detectResources({
    fs: fakeFs({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': String(1 * GB), '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us': '200000', '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us': '100000' }),
    os: host,
  });
  assert.deepEqual(r, { memoryBytes: 1 * GB, memoryFrom: 'container', cpus: 2, cpusFrom: 'container' });
  r = detectResources({
    fs: fakeFs({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712', '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '-1', '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000' }),
    os: host,
  });
  assert.deepEqual(r, { memoryBytes: 16 * GB, memoryFrom: 'host', cpus: 8, cpusFrom: 'host' });
  // garbage in the files: ignored
  r = detectResources({ fs: fakeFs({ '/sys/fs/cgroup/memory.max': 'lots', '/sys/fs/cgroup/cpu.max': 'x y' }), os: host });
  assert.deepEqual(r, { memoryBytes: 16 * GB, memoryFrom: 'host', cpus: 8, cpusFrom: 'host' });
});

test('work limits: the size of server goes by the smaller of memory and CPUs', () => {
  const t = (gb, cpus) => tierFor({ memoryBytes: gb * GB, cpus });
  assert.equal(t(1, 4), 'small', 'Raspberry Pi 3 / 1 GB');
  assert.equal(t(1.8, 4), 'small', 'Pi 4, 2 GB');
  assert.equal(t(3.7, 4), 'medium', 'Pi 4, 4 GB');
  assert.equal(t(7.8, 4), 'big', 'Pi 5, 8 GB');
  assert.equal(t(16, 2), 'small', 'two CPUs');
  assert.equal(t(16, 3), 'medium');
  assert.equal(t(6, 8), 'medium');
  assert.equal(tierFor({ memoryBytes: 0, cpus: 8 }), 'big', 'memory unknown: as before');
  assert.deepEqual(TIERS.big, { speedIndex: 4, codecChecks: 8, scrubPreviews: 3, telemetryReads: 2, thumbnails: 2 });
});

test('work limits: an admin sets some numbers; the rest stay automatic', () => {
  const resources = { memoryBytes: 2 * GB, memoryFrom: 'container', cpus: 2, cpusFrom: 'container' };
  const p = pickLimits({ resources, override: { speedIndex: 3, thumbnails: 2, codecChecks: 0, nonsense: 5, scrubPreviews: 99 } });
  assert.deepEqual(p.override, { speedIndex: 3, thumbnails: 2 }, 'out of range and unknown keys are dropped');
  assert.deepEqual(p.limits, { speedIndex: 3, codecChecks: 2, scrubPreviews: 1, telemetryReads: 1, thumbnails: 2 });
  assert.deepEqual(p.auto, TIERS.small);
  assert.deepEqual(cleanOverride(null), {});
  assert.deepEqual(cleanOverride('x'), {});

  assert.deepEqual(parseOverride({ speedIndex: '3', codecChecks: '', scrubPreviews: null, telemetryReads: 2 }), { speedIndex: 3, telemetryReads: 2 });
  assert.deepEqual(parseOverride({}), {});
  for (const bad of [{ speedIndex: 0 }, { speedIndex: 9 }, { codecChecks: 33 }, { thumbnails: 1.5 }, { scrubPreviews: 'many' }, { telemetryReads: [2] }]) {
    assert.throws(() => parseOverride(bad), TypeError, JSON.stringify(bad));
  }
});

test('the limiter reads a limit that changes', async () => {
  let max = 1;
  const limit = limiter(() => max);
  let running = 0;
  let most = 0;
  const gates = [];
  const job = () => limit(() => new Promise((resolve) => {
    running++;
    most = Math.max(most, running);
    gates.push(() => { running--; resolve(); });
  }));
  const all = Array.from({ length: 6 }, job);
  await new Promise((r) => setImmediate(r));
  assert.equal(running, 1);
  max = 3;
  gates.shift()();
  await new Promise((r) => setImmediate(r));
  assert.equal(running, 3, 'the next start reads the new limit');
  while (gates.length) { gates.shift()(); await new Promise((r) => setImmediate(r)); }
  await Promise.all(all);
  assert.equal(most, 3);
});

test('the background pace never allows more than its limit, read each time', () => {
  let t = 1_000_000;
  const lag = { percentile: () => 5e6, max: 20e6, reset() {} };
  let max = 3;
  const pace = createBackgroundPace({ max: () => max, now: () => t, lag });
  let most = 0;
  for (let i = 0; i < 400; i++) {
    // a clip every 400 ms in each slot: more slots read more clips
    for (let at = 0; at < 1000; at += Math.round(400 / Math.max(1, pace.allowed(t)))) pace.done(400, t + at);
    t += 1000;
    pace.demand(pace.allowed(t), true);
    pace.tick(t);
    most = Math.max(most, pace.allowed(t));
  }
  assert.equal(most, 3, 'it climbs to the limit and no further');
  max = 1;
  assert.equal(pace.allowed(t), 1, 'a lower limit applies at once');
  pace.tick(t + 1000);
  assert.equal(pace.status().limit, 1);
});
