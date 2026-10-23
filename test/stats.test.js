'use strict';

// Server monitor: the GET /api/stats body on five fake machines (Intel + Arc,
// AMD, NVIDIA, Raspberry Pi, a locked-down container) and on this machine.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createStats } = require('../server/stats');
const { parseStat } = require('../server/stats/procs');
const { parseCpuinfo, cleanModel } = require('../server/stats/cpu');
const { osFromKernel } = require('../server/stats/host');
const M = require('./fixtures/stats/machines');
const { setup, fakeFs, fakeClock, fakeSpawn } = require('./fixtures/stats/helpers');

const MiB = 1048576;
const SHARES = () => [{ label: 'Footage share', path: '/footage/tesla' }, { label: 'Data volume', path: '/data' }];

test('Intel desktop with an Arc A380 (xe): CPU, memory, GPUs, power, disks, network, sensors', async () => {
  const clock = fakeClock();
  const fsp = fakeFs(clock, { '/footage/tesla': { delayMs: 3, blocks: 2e9, bfree: 5e8 }, '/data': { blocks: 1.2e8, bfree: 9e7 } });
  const encodes = [{ jobId: 'j1', pid: 200, encoder: 'hevc_vaapi', hardware: true }, { jobId: 'j1', pid: 201, encoder: 'hevc_vaapi', hardware: true }];
  const s = setup(M.intelArc, { clock, pciIdsFiles: [], options: { fsp, readShares: SHARES, activeEncodes: () => encodes } });
  try {
    const snap = await s.run(2);
    assert.equal(snap.at, clock.t);
    assert.equal(snap.intervalMs, 2000);
    assert.deepEqual(snap.host, {
      hostname: 'nas-box', os: 'Ubuntu', kernel: '6.8.0-45-generic', arch: 'x86_64', uptimeS: 1000004,
      appUptimeS: 1000004 - 500, version: 'test', node: process.version, ffmpeg: '7.1.1-Jellyfin'
    });

    // CPU: the mockup's per-core loads, 39.25 % on the whole
    const { cpu } = snap;
    assert.equal(cpu.model, 'Intel Core i5-12500');
    assert.equal(cpu.cores, 6);
    assert.equal(cpu.threads, 12);
    assert.equal(cpu.usage, 39.3);
    assert.deepEqual(cpu.perCore, M.INTEL_LOADS);
    assert.equal(cpu.freqMHz, 4100, 'the fastest core');
    assert.equal(cpu.tempC, 58, 'coretemp Package id 0');
    assert.deepEqual(cpu.load, [2.4, 1.9, 1.6]);
    // app 4 % + ffmpeg 9 + 9 + 2 %; the parent supervisor and Plex are not ours
    assert.deepEqual(cpu.app, { usage: 24, ffmpegUsage: 20, ffmpegCount: 3 });
    assert.equal(cpu.throttling, false, 'power-limit counters rising is not throttling');

    assert.deepEqual(snap.memory, {
      totalB: 32820000 * 1024, usedB: (32820000 - 13700000) * 1024, availableB: 13700000 * 1024,
      cacheB: (200000 + 9000000 + 300000) * 1024, swapTotalB: 2097148 * 1024, swapUsedB: 0,
      appB: (233472 + 102400 + 101376 + 81920) * 1024
    });

    // GPUs: the Arc from xe's cycle counters, the iGPU from i915's nanoseconds
    const [arc, igpu] = snap.gpus;
    assert.equal(snap.gpus.length, 2);
    assert.deepEqual(arc, {
      id: 'card0', name: 'Intel Arc A380', vendor: 'intel', driver: 'xe', node: 'renderD128', busy: 12, video: 94,
      vramUsedB: null, vramTotalB: null, clockMHz: 1950, tempC: 61, powerW: 24, clients: 2, integrated: false
    });
    assert.equal(igpu.name, 'Intel graphics');
    assert.equal(igpu.driver, 'i915');
    assert.equal(igpu.node, 'renderD129');
    assert.equal(igpu.busy, 25);
    assert.equal(igpu.video, 40, 'two video engines: 80 % of one is 40 % of the class');
    assert.equal(igpu.clockMHz, 1450);
    assert.equal(igpu.clients, 1);
    assert.equal(igpu.powerW, null);

    // RAPL wrapped between phase 0 and 1 and still reads 41 W
    assert.equal(snap.power.cpuW, 41);
    assert.equal(snap.power.gpuW, 24);
    assert.equal(snap.power.totalW, 65);
    assert.equal(snap.power.cpuSource, 'rapl');
    assert.equal(snap.power.gpuSource, 'hwmon');
    assert.ok(snap.power.todayWh > 0);
    assert.equal(snap.power.todayCost, null, 'no electricity price set');
    assert.equal(snap.power.priceNow, null);

    assert.deepEqual(snap.disks, [
      { name: 'nvme0n1', model: 'Samsung SSD 980 PRO 1TB', readBps: 2 * MiB, writeBps: 14 * MiB, tempC: 71.9, kind: 'nvme', busy: 20 },
      { name: 'sda', model: 'WDC WD80EFZZ-68B', readBps: 0, writeBps: 0, tempC: 38, kind: 'hdd', busy: 0 }
    ], 'loop, dm and partitions are not disks');

    const [share, data] = snap.filesystems;
    assert.deepEqual(share, {
      label: 'Footage share', path: '/footage/tesla', vehicle: false, totalB: 2e9 * 4096, usedB: 1.5e9 * 4096, freeB: 5e8 * 4096,
      latencyMs: 3, reachable: true, fsType: 'cifs', source: '//nas/teslacam', disk: null, smbVersion: '3.1.1'
    });
    assert.equal(data.disk, 'nvme0n1', 'the data folder lives on a partition of the NVMe');
    assert.equal(data.fsType, 'ext4');

    // pid: host: the host's NIC, without docker0 / veth / lo
    // and the data used since the first sample (two 2 s steps)
    const used = { rxB: 2 * 2 * 112 * MiB, txB: 2 * 2 * 44 * MiB };
    assert.deepEqual(snap.network, { scope: 'host', interfaces: [{ name: 'enp3s0', speedMbps: 2500, rxBps: 112 * MiB, txBps: 44 * MiB }], today: used, week: used, month: used });

    const temps = Object.fromEntries(snap.sensors.map((x) => [`${x.chip}/${x.label}`, x.value]));
    assert.deepEqual(temps, {
      'coretemp/Package id 0': 58, 'coretemp/Core 0': 50, 'coretemp/Core 4': 63, 'nvme/nvme0n1': 71.9, 'nvme/nvme0n1 Sensor 1': 64.9,
      'drivetemp/sda': 38, 'nct6798/SYSTIN': 35, 'nct6798/Fan 1': 1180, 'nct6798/Fan 2': 910, 'xe/pkg': 61
    }, 'the unplugged input (127 °C) and the dead fan header are left out');
    assert.equal(snap.sensors.find((x) => x.label === 'Fan 1').kind, 'fan');

    assert.equal(snap.processes.scope, 'host');
    const top = snap.processes.top;
    assert.equal(top.length, 8);
    assert.deepEqual(top.slice(0, 5).map((p) => [p.pid, p.name, p.cpu, p.gpuVideo]), [
      [300, 'Plex Media Server', 9, null], [200, 'ffmpeg · hevc_vaapi', 9, 47], [201, 'ffmpeg · hevc_vaapi', 9, 47], [100, 'sentry-six-manager', 4, null], [202, 'ffmpeg', 2, 40]
    ], 'ffmpeg named by the encoder the converter says it runs');
    assert.equal(top.find((p) => p.pid === 300).memB, 300000 * 4096, 'memory from stat pages');
    assert.equal(top.find((p) => p.pid === 200).memB, 102400 * 1024, 'our own processes: VmRSS');
    assert.ok(!top.some((p) => [2, 3, 302].includes(p.pid)), 'no kernel threads, no zombies');
    assert.deepEqual(snap.unlock, [], 'RAPL readable and pid: host: nothing left to unlock');
    assert.deepEqual(snap.alerts, [], 'the hot NVMe must stay hot for 30 s first');
    assert.deepEqual(snap.sparks.cpu, [39.3, 39.3]);
    assert.deepEqual(snap.sparks.gpuVideo, [94, 94], 'a client seen for the first time is not "0 %"');
    assert.deepEqual(snap.sparks.rxBps.slice(-1), [112 * MiB]);
    assert.doesNotThrow(() => JSON.stringify(snap));
  } finally {
    s.done();
  }
});

test('the GPU name comes from pci.ids when the image has it', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sm-pciids-'));
  fs.writeFileSync(path.join(dir, 'pci.ids'), M.PCI_IDS);
  const s = setup(M.intelArc, { pciIdsFiles: [path.join(dir, 'pci.ids')] });
  const a = setup(M.amd, { appPid: 8, pciIdsFiles: [path.join(dir, 'pci.ids')] });
  try {
    const [arc, igpu] = (await s.run(0)).gpus;
    assert.equal(arc.name, 'Intel Arc A380');
    assert.equal(igpu.name, 'Intel AlderLake-S GT1');
    assert.equal((await a.run(0)).gpus[0].name, 'AMD Radeon RX 6600/6600 XT/6600M');
  } finally {
    s.done();
    a.done();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AMD desktop: k10temp, amdgpu sysfs and per-process video engine from fdinfo', async () => {
  const s = setup(M.amd, { appPid: 8 });
  try {
    const snap = await s.run(2);
    assert.equal(snap.cpu.model, 'AMD Ryzen 7 5800X');
    assert.equal(snap.cpu.cores, 8);
    assert.equal(snap.cpu.threads, 16);
    assert.equal(snap.cpu.usage, 25);
    assert.equal(snap.cpu.tempC, 65.3, 'Tctl when there is no Tdie');
    assert.deepEqual(snap.cpu.app, { usage: 12, ffmpegUsage: 10, ffmpegCount: 1 });
    assert.equal(snap.host.os, 'Debian');
    assert.deepEqual(snap.sensors.filter((x) => /acpitz|iwlwifi/.test(x.chip)).map((x) => [x.chip, x.label, x.value]),
      [['acpitz', 'acpitz', 27.8], ['iwlwifi_1', 'iwlwifi_1 1', 41], ['iwlwifi_1', 'iwlwifi_1 2', 42]]);
    assert.deepEqual(snap.gpus, [{
      id: 'card0', name: 'AMD graphics', vendor: 'amd', driver: 'amdgpu', node: 'renderD128', busy: 37, video: 60,
      vramUsedB: 1073741824, vramTotalB: 8573157376, clockMHz: 2044, tempC: 61, powerW: 85, clients: 1, integrated: false
    }]);
    assert.deepEqual(snap.power, {
      totalW: 85, cpuW: null, gpuW: 85, cpuSource: null, gpuSource: 'hwmon', todayWh: snap.power.todayWh, weekWh: snap.power.weekWh,
      todayCost: null, weekCost: null, priceNow: null
    });
    assert.deepEqual(snap.disks, [{ name: 'sdb', model: 'Samsung SSD 870', readBps: MiB, writeBps: 0, tempC: null, kind: 'ssd', busy: 0 }]);
    assert.equal(snap.network.scope, 'container');
    assert.deepEqual(snap.network.interfaces, [{ name: 'eth0', speedMbps: null, rxBps: 1000000, txBps: 100000 }], 'a veth has no real speed');
    assert.equal(snap.processes.scope, 'container');
    assert.deepEqual(snap.processes.top.map((p) => [p.name, p.cpu, p.gpuVideo]), [['ffmpeg', 10, 60], ['sentry-six-manager', 2, null], ['node', 0, null], ['tini', 0, null]]);
    assert.deepEqual(snap.unlock.map((u) => u.key), ['host-view'], 'cpu-power waits until sampling has run a few seconds');
  } finally {
    s.done();
  }
});

test('NVIDIA: numbers from one nvidia-smi stream, [N/A] becomes null', async () => {
  const spawn = fakeSpawn({ lines: M.NVIDIA_LINES });
  const s = setup(M.nvidia, { appPid: 10, spawn });
  try {
    s.stats.touch(); // starts nvidia-smi
    const snap = await s.run(1);
    const smi = spawn.calls.filter((c) => c.cmd === 'nvidia-smi');
    assert.equal(smi.length, 1, 'one long-running process, not one per sample');
    assert.deepEqual(smi[0].args, [
      '--query-gpu=index,name,driver_version,utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total,temperature.gpu,power.draw,clocks.gr',
      '--format=csv,noheader,nounits', '-lms', '2000'
    ]);
    assert.deepEqual(snap.gpus, [
      {
        id: 'nvidia0', name: 'NVIDIA GeForce RTX 3060', vendor: 'nvidia', driver: 'nvidia', driverVersion: '550.54.14', node: 'nvidia0',
        busy: 23, video: 61, vramUsedB: 1650 * MiB, vramTotalB: 12288 * MiB, clockMHz: 1777, tempC: 54, powerW: 41.3, clients: null
      },
      {
        id: 'nvidia1', name: 'Tesla T4', vendor: 'nvidia', driver: 'nvidia', driverVersion: '550.54.14', node: 'nvidia1',
        busy: 0, video: null, vramUsedB: 3 * MiB, vramTotalB: 15360 * MiB, clockMHz: null, tempC: 33, powerW: null, clients: null
      }
    ], 'the nvidia DRM card in sysfs is not listed twice');
    assert.equal(snap.power.gpuSource, 'nvidia-smi');
    assert.equal(snap.power.totalW, 41.3);
  } finally {
    s.done();
  }
  assert.equal(spawn.calls.find((c) => c.cmd === 'nvidia-smi').child.killed, 'SIGTERM', 'killed on stop');
});

test('Raspberry Pi: ARM board name, thermal zone as CPU temperature, V3D listed without stats', async () => {
  const s = setup(M.pi, { appPid: 20 });
  try {
    const snap = await s.run(2);
    assert.equal(snap.cpu.model, 'Raspberry Pi 4 Model B Rev 1.4');
    assert.equal(snap.cpu.cores, 4);
    assert.equal(snap.cpu.threads, 4);
    assert.deepEqual(snap.cpu.perCore, [50, 10, 10, 10]);
    assert.equal(snap.cpu.usage, 20);
    assert.equal(snap.cpu.freqMHz, 1500);
    assert.equal(snap.cpu.tempC, 52.6);
    assert.equal(snap.host.arch, 'aarch64');
    assert.equal(snap.host.os, 'Raspberry Pi OS');
    assert.deepEqual(snap.sensors, [{ chip: 'cpu-thermal', label: 'CPU', kind: 'temp', value: 52.6 }]);
    assert.deepEqual(snap.gpus, [{
      id: 'card0', name: 'Broadcom V3D', vendor: 'other', driver: 'v3d', node: 'renderD128', busy: null, video: null,
      vramUsedB: null, vramTotalB: null, clockMHz: null, tempC: null, powerW: null, clients: null, integrated: false
    }], 'VC4 only drives the display (no render node)');
    assert.deepEqual(snap.disks.map((d) => [d.name, d.model, d.kind]), [['mmcblk0', 'SC64G', 'other']]);
    assert.equal(snap.memory.swapUsedB, 51198 * 1024);
    assert.deepEqual(snap.power, { totalW: null, cpuW: null, gpuW: null, cpuSource: null, gpuSource: null, todayWh: 0, weekWh: 0, todayCost: null, weekCost: null, priceNow: null });
    assert.ok(!snap.unlock.some((u) => u.key === 'cpu-power'), 'no RAPL on ARM, so no hint for it');
  } finally {
    s.done();
  }
});

test('a container that can read almost nothing: every field empty, nothing throws', async () => {
  const s = setup(M.bare);
  try {
    const snap = await s.run(3);
    assert.equal(snap.cpu.usage, null);
    assert.deepEqual(snap.cpu.perCore, []);
    assert.equal(snap.cpu.model, null);
    assert.deepEqual(snap.cpu.app, { usage: null, ffmpegUsage: null, ffmpegCount: null });
    assert.equal(snap.memory.totalB, null);
    assert.deepEqual(snap.gpus, []);
    assert.deepEqual(snap.disks, []);
    assert.deepEqual(snap.network.interfaces, []);
    assert.deepEqual(snap.sensors, []);
    assert.deepEqual(snap.processes.top, []);
    assert.equal(snap.power.totalW, null);
    assert.deepEqual(snap.sparks, { cpu: [], gpuVideo: [], rxBps: [] });
    assert.equal(s.stats.history('15m').series.cpu.filter((v) => v !== null).length, 0);
    assert.match(s.stats.csv('15m'), /^time,cpu,memory,gpuBusy,gpuVideo,powerW,rxBps,txBps,tempMax\n/);
  } finally {
    s.done();
  }
});

test('garbage in every file of a full machine never throws', async () => {
  const s = setup(M.intelArc, { options: { readShares: SHARES } });
  try {
    await s.run(1);
    const junk = ['', '\u0000\u0000', 'NaN', '-1', '99999999999999999999999', 'cpu  1 2 3', '(((', 'a: b: c', ')) S', '[N/A]'];
    let k = 0;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(p);
        else fs.writeFileSync(p, junk[k++ % junk.length]);
      }
    };
    walk(s.m.root);
    for (let i = 0; i < 3; i++) {
      s.clock.advance(2000);
      assert.doesNotThrow(() => s.stats.sampleNow());
      await s.stats.settle();
    }
    // and a tree that vanished under it
    s.m.cleanup();
    s.clock.advance(2000);
    assert.doesNotThrow(() => s.stats.sampleNow());
    await s.stats.settle();
    assert.doesNotThrow(() => JSON.stringify(s.stats.snapshot()));
  } finally {
    s.done();
  }
});

test('this machine: a sample of the real /proc and /sys (no GPU here)', async () => {
  const spawn = fakeSpawn();
  const stats = createStats({ spawn, ffmpegVersion: null, readShares: () => [{ label: 'Temp', path: require('os').tmpdir() }] });
  try {
    stats.sampleNow();
    await stats.settle();
    await new Promise((r) => setTimeout(r, 300));
    const snap = stats.sampleNow();
    await stats.settle();
    assert.ok(snap.cpu.threads >= 1);
    assert.ok(snap.cpu.usage === null || (snap.cpu.usage >= 0 && snap.cpu.usage <= 100));
    assert.ok(snap.memory.totalB > 0);
    assert.ok(snap.memory.appB > 0, 'this test process is the app');
    assert.ok(snap.host.kernel);
    assert.ok(Array.isArray(snap.disks) && Array.isArray(snap.gpus) && Array.isArray(snap.network.interfaces));
    assert.ok(snap.processes.top.length <= 8);
    assert.ok(snap.processes.top.every((p) => p.pid !== process.pid || p.name === 'sentry-six-manager'), 'the app is named, not "node"');
    assert.ok(snap.cpu.app.usage === null || snap.cpu.app.usage >= 0);
    const fsEntry = stats.snapshot().filesystems[0];
    assert.ok(fsEntry && fsEntry.label === 'Temp');
    if (!fs.existsSync('/dev/nvidia0') && !fs.existsSync('/proc/driver/nvidia/version')) {
      assert.ok(!spawn.calls.some((c) => c.cmd === 'nvidia-smi'), 'no NVIDIA device, no nvidia-smi');
    }
    assert.doesNotThrow(() => JSON.stringify(stats.snapshot()));
  } finally {
    stats.stop();
  }
});

test('small parsers: stat names with ")" and spaces, CPU names, the host OS', () => {
  const p = parseStat(M.statLine({ pid: 7, comm: 'weird ) name', ppid: 1, utime: 5, stime: 6, start: 99, rss: 12 }));
  assert.deepEqual(p, { pid: 7, comm: 'weird ) name', state: 'S', ppid: 1, ticks: 11, start: 99, rssPages: 12 });
  assert.equal(parseStat('garbage'), null);
  assert.equal(parseStat('12 (x) S 1'), null);
  assert.equal(cleanModel('Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz'), 'Intel Xeon E5-2680 v4');
  assert.equal(cleanModel('AMD Ryzen 5 PRO 4650G with Radeon Graphics'), 'AMD Ryzen 5 PRO 4650G');
  assert.equal(cleanModel('Intel(R) Celeron(R) J4125 CPU @ 2.00GHz'), 'Intel Celeron J4125');
  assert.equal(parseCpuinfo('processor\t: 0\nmodel name\t: ARMv7 Processor rev 3 (v7l)\nCPU implementer\t: 0x41\n\nModel\t: Raspberry Pi 3 Model B Plus Rev 1.3\n').model, 'Raspberry Pi 3 Model B Plus Rev 1.3');
  assert.equal(osFromKernel('6.1.106-Unraid', ''), 'Unraid');
  assert.equal(osFromKernel('6.6.44-production+truenas', ''), 'TrueNAS');
  assert.equal(osFromKernel('6.8.12-4-pve', ''), 'Proxmox VE');
  assert.equal(osFromKernel('6.11.4-301.fc41.x86_64', ''), 'Fedora');
  assert.equal(osFromKernel('5.10.0', 'Linux version 5.10.0'), 'Linux');
  assert.equal(osFromKernel(null, null), null);
});

test('a bridge, its bond and its port carry the same bytes: counted once', async () => {
  // Unraid with pid: host: eth0 in bond0 in br0, seen without the host's sysfs
  const unraid = (phase) => ({
    ...M.amd(phase),
    'proc/1/net/dev': M.netDev({ lo: [1, 1], eth0: [1e6 + phase * 2e6, 0], bond0: [1e6 + phase * 2e6, 0], br0: [1e6 + phase * 2e6, 0], wg0: [5, 5 + phase * 2000], docker0: [0, 0] }),
    'proc/1/cgroup': '0::/init.scope\n'
  });
  const s = setup(unraid, { appPid: 8 });
  try {
    const snap = await s.run(1);
    assert.equal(snap.network.scope, 'host');
    assert.deepEqual(snap.network.interfaces.map((i) => [i.name, i.rxBps]), [['br0', 1e6], ['wg0', 0]]);
  } finally {
    s.done();
  }
  // its own links, where sysfs knows the master: the enslaved port is left out
  const own = (phase) => ({
    ...M.amd(phase),
    'proc/net/dev': M.netDev({ lo: [1, 1], eth0: [phase * 2e6, 0], br0: [phase * 2e6, 0], eth1: [phase * 4e6, 0] }),
    'proc/1/net/dev': M.netDev({ lo: [1, 1], eth0: [phase * 2e6, 0], br0: [phase * 2e6, 0], eth1: [phase * 4e6, 0] }),
    'sys/class/net/eth0/master': { link: '../br0' },
    'sys/class/net/br0/bridge/.keep': '',
    'sys/class/net/eth1/speed': '1000\n'
  });
  const t = setup(own, { appPid: 8 });
  try {
    const snap = await t.run(1);
    assert.deepEqual(snap.network.interfaces.map((i) => [i.name, i.rxBps]), [['br0', 1e6], ['eth1', 2e6]]);
  } finally {
    t.done();
  }
});

test('a virtual machine gets no "CPU power" hint (there is nothing to bind there)', async () => {
  const vm = (phase) => {
    const spec = M.amd(phase);
    spec['proc/cpuinfo'] = spec['proc/cpuinfo'].replace(/flags\t\t: fpu vme de pse/g, 'flags\t\t: fpu vme de pse hypervisor');
    return spec;
  };
  const held = { setTimeout: () => ({ unref() {} }), clearTimeout() {} };
  const s = setup(vm, { appPid: 8, timers: held });
  try {
    s.stats.touch();
    for (let p = 1; p <= 4; p++) {
      s.m.update(vm(p));
      s.clock.advance(2000);
      s.stats.sampleNow();
    }
    assert.deepEqual(s.stats.snapshot().unlock.map((u) => u.key), ['host-view']);
  } finally {
    s.done();
  }
});

test('a 128-thread server: the clock is read from 32 cores, not all of them', () => {
  const { CpuProvider } = require('../server/stats/cpu');
  const spec = { 'proc/cpuinfo': '', 'proc/stat': '' };
  for (let i = 0; i < 128; i++) spec[`sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`] = `${i === 127 ? 3700000 : 1500000}\n`;
  const m = M.build(spec);
  try {
    const c = new CpuProvider({ procRoot: m.proc, sysRoot: m.sys, now: () => 0 });
    c.probe();
    assert.equal(c.freqFiles.length, 32);
    assert.equal(c.info.threads, 128, 'without cpuinfo the CPU folders count');
    assert.ok(c.freqFiles.some((f) => f.includes('/cpu0/')));
  } finally {
    m.cleanup();
  }
});

test('background reads: a hung sensor holds at most a few threads and never the others', async () => {
  const { BackgroundReads } = require('../server/stats/util');
  let t = 0;
  let inFlight = 0;
  let most = 0;
  const hung = new Set(['/hwmon/a', '/hwmon/b', '/hwmon/c']);
  const readFile = (file) => {
    inFlight++;
    most = Math.max(most, inFlight);
    if (hung.has(file)) return new Promise(() => {});
    return new Promise((resolve) => setImmediate(() => {
      inFlight--;
      resolve(`${file}:${t}`);
    }));
  };
  const r = new BackgroundReads({ now: () => t, readFile, limit: 4 });
  for (const f of ['/hwmon/a', '/hwmon/b', '/hwmon/c', '/cpu/temp', '/gpu/busy']) r.get(f);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(r.get('/cpu/temp').text, '/cpu/temp:0', 'one slot is left for the rest');
  assert.equal(r.get('/gpu/busy').text, '/gpu/busy:0');
  t = 2000;
  for (let i = 0; i < 5; i++) r.get('/hwmon/a');
  assert.ok(most <= 4, `at most 4 reads at once (${most})`);
  assert.equal(r.text('/hwmon/a', 0, 60000), null, 'a hung sensor shows nothing rather than an old value forever');
});
