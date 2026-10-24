'use strict';

// Server monitor, GPUs: per-process engine use from DRM fdinfo (i915 and
// amdgpu nanoseconds, xe cycles), sleeping GPUs left asleep, and the one
// long-running nvidia-smi (only on NVIDIA machines, restarted with backoff,
// killed on stop).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { parseFdinfo, engineUse, parseNvidiaLine, lookupPciIds, currentClock, NvidiaSmi } = require('../server/stats/gpu');
const M = require('./fixtures/stats/machines');
const { setup, fakeSpawn, fakeClock } = require('./fixtures/stats/helpers');

test('fdinfo: i915 and amdgpu count nanoseconds, xe counts cycles; capacity divides', () => {
  const a = parseFdinfo(M.i915Fdinfo(3, { render: 1e9, video: 2e9 }));
  const b = parseFdinfo(M.i915Fdinfo(3, { render: 1.5e9, video: 3.6e9 }));
  assert.equal(a.driver, 'i915');
  assert.equal(a.pdev, '0000:00:02.0');
  assert.equal(a.clientId, '3');
  assert.deepEqual(a.capacity, { video: 2 });
  assert.ok(!('capacity-video' in a.engines), 'the capacity line is not an engine');
  const u = engineUse(a, b, 2000);
  assert.equal(u.render, 0.25);
  assert.equal(u.video, 0.4, '1.6 s of 2 s on a class of two engines');
  assert.equal(u.copy, 0);

  const x0 = parseFdinfo(M.xeFdinfo(11, { rcs: 0, vcs: 0, total: 1000 }));
  const x1 = parseFdinfo(M.xeFdinfo(11, { rcs: 500, vcs: 1500, total: 2000 }));
  // wall time does not matter for xe: the GPU's own clock is the reference
  const ux = engineUse(x0, x1, 123456);
  assert.equal(ux.rcs, 0.5);
  assert.equal(ux.vcs, 0.75);
  assert.equal(ux.ccs, 0);

  const d0 = parseFdinfo(M.amdFdinfo({ gfx: 0, enc: 0, dec: 0 }));
  const d1 = parseFdinfo(M.amdFdinfo({ gfx: 2e9, enc: 3e9, dec: 1e9 }));
  assert.deepEqual(engineUse(d0, d1, 2000), { gfx: 1, compute: 0, enc: 1, dec: 0.5 }, 'over 100 % (a late read) is capped');

  // counters that went back (a restarted client) give nothing, never a negative %
  const back = engineUse(b, a, 2000);
  assert.ok(!('render' in back) && !('video' in back));
  assert.ok(Object.values(back).every((v) => v >= 0));
  assert.equal(parseFdinfo(''), null);
  assert.equal(parseFdinfo('pos:\t0\nflags:\t0100002\n'), null, 'not a DRM file');
});

test('a GPU client is counted once even through two fds, and only for the GPU it uses', async () => {
  const s = setup(M.intelArc);
  try {
    const snap = await s.run(2);
    const [arc, igpu] = snap.gpus;
    assert.equal(arc.clients, 2, 'ffmpeg 200 holds client 11 twice (dup), ffmpeg 201 holds client 12');
    assert.equal(arc.video, 94, 'not 141: the duplicated fd is not added again');
    assert.equal(igpu.clients, 1);
    // ffmpeg 201 closes its GPU fd: the Arc is down to one client
    s.m.remove('proc/201/fd/5');
    s.m.remove('proc/201/fdinfo/5');
    s.m.update(M.intelArc(3));
    s.m.remove('proc/201/fd/5');
    s.m.remove('proc/201/fdinfo/5');
    s.clock.advance(2000);
    s.stats.sampleNow();
    const after = s.stats.snapshot().gpus[0];
    assert.equal(after.clients, 1);
    assert.equal(after.video, 47);
    // all ffmpegs gone: idle for us, 0 % (not unknown)
    for (const pid of [200, 201, 202]) s.m.remove(`proc/${pid}`);
    s.clock.advance(2000);
    s.stats.sampleNow();
    const idle = s.stats.snapshot().gpus;
    assert.deepEqual(idle.map((g) => [g.busy, g.video, g.clients]), [[0, 0, 0], [0, 0, 0]]);
    assert.equal(s.stats.snapshot().cpu.app.ffmpegCount, 0);
  } finally {
    s.done();
  }
});

test('right after a start, before the first conversion: the GPU is idle for us (0 %), not unknown', async () => {
  // the owner's server after an update: no ffmpeg yet, so no GPU client has been seen
  const idle = (p) => {
    const files = M.amd(p);
    for (const k of Object.keys(files)) if (k.startsWith('proc/400/')) delete files[k];
    return files;
  };
  const s = setup(idle, { appPid: 8 });
  try {
    let [gpu] = (await s.run(1)).gpus;
    assert.deepEqual([gpu.video, gpu.clients, gpu.busy], [0, 0, 37], 'video engine 0 %, no clients; busy from the driver');
    // the first conversion starts: unknown for its first sample, then measured
    s.m.update(M.amd(2));
    fs.symlinkSync('/dev/dri/renderD128', `${s.m.proc}/400/fd/7`); // update() writes files only
    s.clock.advance(2000);
    s.stats.sampleNow();
    await s.stats.settle();
    [gpu] = s.stats.snapshot().gpus;
    assert.deepEqual([gpu.video, gpu.clients], [null, 1], 'a client seen for the first time: not known yet');
    s.m.update(M.amd(3));
    s.clock.advance(2000);
    s.stats.sampleNow();
    await s.stats.settle();
    [gpu] = s.stats.snapshot().gpus;
    assert.equal(gpu.clients, 1);
    assert.ok(gpu.video > 0, 'measured');
  } finally {
    s.done();
  }
});

test('a kernel that reports no GPU clients in fdinfo: with ffmpeg holding the GPU, its use stays unknown', async () => {
  const old = (p) => {
    const files = M.amd(p);
    files['proc/400/fdinfo/7'] = 'pos:\t0\nflags:\t02100002\nmnt_id:\t26\n';
    return files;
  };
  const s = setup(old, { appPid: 8 });
  try {
    const [gpu] = (await s.run(2)).gpus;
    assert.deepEqual([gpu.video, gpu.clients], [null, null], 'not 0: ffmpeg has the GPU open and its use cannot be read');
  } finally {
    s.done();
  }
});

test('a GPU in runtime suspend is not asked anything (that would wake it)', async () => {
  const asked = [];
  const fsp = { ...fs.promises, readFile: (file, enc) => { asked.push(file); return fs.promises.readFile(file, enc); } };
  const s = setup(M.amd, { appPid: 8, options: { fsp } });
  try {
    await s.run(1);
    s.m.update(M.amd(2));
    s.m.file('sys/devices/pci0000:00/0000:00:01.0/0000:0b:00.0/power/runtime_status', 'suspended\n');
    asked.length = 0;
    s.clock.advance(2000);
    s.stats.sampleNow();
    await s.stats.settle();
    const gpu = s.stats.snapshot().gpus[0];
    assert.equal(gpu.busy, 0);
    assert.equal(gpu.powerW, null);
    assert.ok(!asked.some((f) => /0000:0b:00\.0\/(gpu_busy_percent|mem_info|pp_dpm|hwmon)/.test(f)), asked.join('\n'));
  } finally {
    s.done();
  }
});

test('an AMD APU: its power reading is the whole chip, so it is not added to the CPU package', async () => {
  const apu = (phase) => {
    const spec = M.amd(phase);
    delete spec['sys/devices/pci0000:00/0000:00:01.0/0000:0b:00.0/hwmon/hwmon2/fan1_input'];
    spec['sys/devices/pci0000:00/0000:00:01.0/0000:0b:00.0/hwmon/hwmon2/power1_average'] = '30000000\n';
    return spec;
  };
  const s = setup(apu, { appPid: 8 });
  try {
    await s.run(1);
    const t = s.clock.t;
    s.stats.setRapl({ at: t - 2000, packages: [{ name: 'package-0', energyUj: 0, maxEnergyUj: 262143328850 }] });
    s.stats.setRapl({ at: t, packages: [{ name: 'package-0', energyUj: 50e6, maxEnergyUj: 262143328850 }] });
    s.clock.advance(500);
    s.stats.sampleNow();
    const { power, gpus } = s.stats.snapshot();
    assert.equal(gpus[0].integrated, true);
    assert.equal(power.cpuW, 25);
    assert.equal(power.gpuW, 30);
    assert.equal(power.totalW, 30, 'max of the two package readings, not 55');
  } finally {
    s.done();
  }
});

test('nvidia-smi is never started on a machine without an NVIDIA device', async () => {
  const spawn = fakeSpawn({ lines: M.NVIDIA_LINES });
  const s = setup(M.intelArc, { spawn, probeFfmpeg: true });
  try {
    s.stats.touch();
    await s.run(1);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(spawn.calls.map((c) => c.cmd), ['ffmpeg'], 'only the one-time ffmpeg -version');
    assert.equal(s.stats.snapshot().host.ffmpeg, '7.1.1-Jellyfin');
  } finally {
    s.done();
  }
});

test('nvidia-smi: restarted with growing backoff, once a minute is healthy, never after stop', async () => {
  const clock = fakeClock();
  const pending = [];
  const timers = {
    setTimeout: (fn, ms) => {
      const h = { fn, ms, cleared: false, unref() {} };
      pending.push(h);
      return h;
    },
    clearTimeout: (h) => {
      if (h) h.cleared = true;
    }
  };
  const spawn = fakeSpawn({ lines: [M.NVIDIA_LINES[0]], exitAfterLines: true });
  const warnings = [];
  const smi = new NvidiaSmi({ spawn, timers, now: clock.now, intervalMs: 2000, log: { warn: (m) => warnings.push(m) } });
  const tick = () => new Promise((r) => setImmediate(r));
  smi.start();
  await tick();
  assert.equal(smi.read()[0].busy, 23);
  const delays = [];
  for (let i = 0; i < 4; i++) {
    const h = pending.shift();
    delays.push(h.ms);
    h.fn();
    await tick();
  }
  assert.deepEqual(delays, [2000, 4000, 8000, 16000]);
  // one that ran for over a minute starts the backoff again
  clock.advance(61000);
  pending.shift().fn();
  clock.advance(61000);
  await tick();
  assert.equal(pending[pending.length - 1].ms, 2000);
  // the reading is too old to show
  clock.advance(7000);
  assert.equal(smi.read()[0].busy, null);
  assert.equal(smi.read()[0].name, 'NVIDIA GeForce RTX 3060');

  smi.stop();
  assert.ok(pending.every((h) => h.cleared), 'the restart timer is cancelled');
  const before = spawn.calls.length;
  await tick();
  assert.equal(spawn.calls.length, before);

  // no nvidia-smi in the container: said once, retried rarely
  const missing = new NvidiaSmi({ spawn: fakeSpawn(), timers, now: clock.now, intervalMs: 2000, log: { warn: (m) => warnings.push(m) } });
  missing.spawn = (cmd, args) => fakeSpawn()(`${cmd}-missing`, args);
  missing.start();
  await tick();
  assert.equal(pending[pending.length - 1].ms, 600000);
  pending[pending.length - 1].fn();
  await tick();
  assert.equal(warnings.length, 1);
  missing.stop();
});

test('stopping the stats kills a running nvidia-smi', async () => {
  const spawn = fakeSpawn({ lines: M.NVIDIA_LINES });
  const s = setup(M.nvidia, { appPid: 10, spawn });
  s.stats.touch();
  await s.stats.settle();
  const child = spawn.calls.find((c) => c.cmd === 'nvidia-smi').child;
  assert.equal(child.killed, false);
  s.done();
  assert.equal(child.killed, 'SIGTERM');
  await new Promise((r) => setImmediate(r));
  assert.equal(spawn.calls.filter((c) => c.cmd === 'nvidia-smi').length, 1, 'not restarted after stop');
});

test('small parsers: nvidia-smi lines, pci.ids, the current shader clock', () => {
  assert.deepEqual(parseNvidiaLine('0, NVIDIA RTX A2000, 12GB, 550.54.14, 5, 0, 0, 100, 12288, 40, 20.5, 210'), {
    index: 0, name: 'NVIDIA RTX A2000, 12GB', driverVersion: '550.54.14', busy: 5, encoder: 0, decoder: 0,
    vramUsedB: 100 * 1048576, vramTotalB: 12288 * 1048576, tempC: 40, powerW: 20.5, clockMHz: 210
  });
  assert.equal(parseNvidiaLine('NVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver.'), null);
  assert.equal(parseNvidiaLine('x, a, b, c, d, e, f, g, h, i, j'), null);
  assert.equal(parseNvidiaLine('0, T4, 550, [N/A], [N/A], [N/A], [N/A], [N/A], [N/A], [N/A], [N/A]').busy, null);
  assert.equal(lookupPciIds(M.PCI_IDS, '0x8086', '0x56a5', 'intel'), 'Intel Arc A380');
  assert.equal(lookupPciIds(M.PCI_IDS, '0x8086', '0x1020', 'intel'), null, 'subsystem lines are not devices');
  assert.equal(lookupPciIds(M.PCI_IDS, '0x10de', '0x2504', 'nvidia'), 'NVIDIA GeForce RTX 3060 Lite Hash Rate');
  assert.equal(lookupPciIds(null, '0x8086', '0x56a5', 'intel'), null);
  assert.equal(currentClock('0: 500Mhz\n1: 2044Mhz *\n2: 2491Mhz\n'), 2044);
  assert.equal(currentClock('0: 500Mhz\n'), null);
});
