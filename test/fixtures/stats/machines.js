'use strict';

// Fake machines for the server-monitor tests: /proc, /sys and /dev trees as
// the kernel lays them out (symlinks included), written to a temp folder.
// Each machine is a function of `phase`: phase n is the machine 2 s after
// phase n - 1, with every counter (CPU jiffies, GPU engine time, disk
// sectors, network bytes, energy) moved on by a known amount, so the tests
// can check the exact %, B/s and W the engine works out.
//
//   (a) intelArc  Intel i5-12500 + Intel Arc A380 (xe) + UHD iGPU (i915), two
//                 ffmpeg children on the Arc and one on the iGPU, NVMe + HDD,
//                 coretemp, a board chip with fans, readable RAPL, pid: host
//   (b) amd       Ryzen 7 5800X (k10temp) + Radeon RX 6600 (amdgpu sysfs,
//                 power1_average), one ffmpeg on the GPU, SATA SSD
//   (c) nvidia    Xeon + an NVIDIA card (stats come from a fake nvidia-smi)
//   (d) pi        Raspberry Pi 4: ARM cpuinfo, thermal zone only, V3D GPU
//   (e) bare      a container that can read almost nothing

const fs = require('fs');
const os = require('os');
const path = require('path');

const link = (target) => ({ link: target });

/** /proc/<pid>/stat as the kernel prints it (52 fields). */
function statLine({ pid, comm, ppid, state = 'S', utime = 0, stime = 0, start = 1000, rss = 1000, threads = 1 }) {
  const f = [pid, `(${comm})`, state, ppid, pid, pid, 0, -1, 4194560, 100, 0, 0, 0, utime, stime, 0, 0, 20, 0, threads, 0, start, 123456789, rss, '18446744073709551615'];
  while (f.length < 52) f.push(0);
  return `${f.join(' ')}\n`;
}

/** /proc/stat with one line per CPU: [user, nice, system, idle, iowait, irq, softirq, steal]. */
function procStat(cpus) {
  const total = cpus.reduce((acc, c) => acc.map((v, i) => v + (c[i] || 0)), new Array(8).fill(0));
  return [
    `cpu  ${total.join(' ')} 0 0`,
    ...cpus.map((c, i) => `cpu${i} ${c.join(' ')} 0 0`),
    'intr 123456 0 0', 'ctxt 987654', 'btime 1760000000', 'processes 4242', 'procs_running 2', 'procs_blocked 0', 'softirq 1 2 3', ''
  ].join('\n');
}

/** CPUs loaded by `loads` % over `phase` periods of 2 s (200 jiffies each). */
function loadedCpus(loads, phase) {
  return loads.map((load) => {
    const busy = load * 2 * phase;
    return [1000 + busy, 0, 500, 10000 + (200 * phase - busy), 100, 0, 50, 0];
  });
}

function meminfo({ total, available, cached = 0, buffers = 0, reclaimable = 0, swapTotal = 0, swapFree = 0 }) {
  return [
    `MemTotal:       ${total} kB`, `MemFree:        ${Math.round(available / 3)} kB`, `MemAvailable:   ${available} kB`,
    `Buffers:        ${buffers} kB`, `Cached:         ${cached} kB`, `SwapCached:            0 kB`,
    `SReclaimable:   ${reclaimable} kB`, `SwapTotal:      ${swapTotal} kB`, `SwapFree:       ${swapFree} kB`, ''
  ].join('\n');
}

/** A line of /proc/diskstats (kernel 5.5+: 20 fields). */
function diskLine(major, minor, name, { readSectors = 0, writeSectors = 0, ioMs = 0 } = {}) {
  return `${String(major).padStart(4)} ${String(minor).padStart(7)} ${name} 100 0 ${readSectors} 50 200 0 ${writeSectors} 80 0 ${ioMs} 130 0 0 0 0 0 0`;
}

function netDev(ifs) {
  return [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    ...Object.entries(ifs).map(([name, [rx, tx]]) => `${name.padStart(6)}: ${rx} 1000 0 0 0 0 0 0 ${tx} 900 0 0 0 0 0 0`), ''
  ].join('\n');
}

function cpuinfoX86({ threads, cores, model, vendor }) {
  const blocks = [];
  for (let i = 0; i < threads; i++) {
    blocks.push([
      `processor\t: ${i}`, `vendor_id\t: ${vendor}`, 'cpu family\t: 6', `model name\t: ${model}`, 'cpu MHz\t\t: 4100.000',
      'physical id\t: 0', `siblings\t: ${threads}`, `core id\t\t: ${i % cores}`, `cpu cores\t: ${cores}`, 'flags\t\t: fpu vme de pse'
    ].join('\n'));
  }
  return `${blocks.join('\n\n')}\n\n`;
}

/** A process: stat, status, cgroup, and optionally fds (target per fd) and fdinfo texts. */
function processFiles(p, { cgroup = '0::/\n', fds = {}, fdinfo = {}, mountinfo = null } = {}) {
  const base = `proc/${p.pid}`;
  const out = {
    [`${base}/stat`]: statLine(p),
    [`${base}/status`]: `Name:\t${p.comm}\nState:\tS (sleeping)\nPid:\t${p.pid}\nPPid:\t${p.ppid}\nVmRSS:\t${p.rssKb ?? p.rss * 4} kB\nThreads:\t1\n`,
    [`${base}/cgroup`]: cgroup
  };
  for (const [fd, target] of Object.entries(fds)) out[`${base}/fd/${fd}`] = link(target);
  for (const [fd, text] of Object.entries(fdinfo)) out[`${base}/fdinfo/${fd}`] = text;
  if (mountinfo) out[`${base}/mountinfo`] = mountinfo;
  return out;
}

/** A PCI GPU with its card and render node under /sys/devices, linked from /sys/class/drm. */
function pciGpu({ bus = 'pci0000:00/0000:00:01.0', bdf, vendor, device, driver, card, render, files = {}, hwmon = null }) {
  const dev = `sys/devices/${bus}/${bdf}`;
  const rel = `devices/${bus}/${bdf}`;
  const out = {
    [`${dev}/vendor`]: `${vendor}\n`,
    [`${dev}/device`]: `${device}\n`,
    [`${dev}/uevent`]: `DRIVER=${driver}\nPCI_CLASS=30000\nPCI_SLOT_NAME=${bdf}\n`,
    [`${dev}/driver`]: link(`../../../../bus/pci/drivers/${driver}`),
    [`${dev}/power/runtime_status`]: 'active\n',
    [`${dev}/drm/${card}/dev`]: '226:0\n',
    [`${dev}/drm/${card}/device`]: link('../..'),
    [`${dev}/drm/${render}/dev`]: '226:128\n',
    [`${dev}/drm/${render}/device`]: link('../..'),
    [`sys/class/drm/${card}`]: link(`../../${rel}/drm/${card}`),
    [`sys/class/drm/${render}`]: link(`../../${rel}/drm/${render}`)
  };
  for (const [name, text] of Object.entries(files)) out[`${dev}/${name}`] = text;
  if (hwmon) {
    out[`${dev}/hwmon/${hwmon.id}/device`] = link('../..');
    out[`sys/class/hwmon/${hwmon.id}`] = link(`../../${rel}/hwmon/${hwmon.id}`);
    for (const [name, text] of Object.entries(hwmon.files)) out[`${dev}/hwmon/${hwmon.id}/${name}`] = text;
  }
  return out;
}

/** A plain hwmon chip (board sensors, coretemp) under /sys/devices/platform. */
function platformHwmon(device, id, files) {
  const out = {
    [`sys/devices/platform/${device}/hwmon/${id}/device`]: link('../..'),
    [`sys/class/hwmon/${id}`]: link(`../../devices/platform/${device}/hwmon/${id}`)
  };
  for (const [name, text] of Object.entries(files)) out[`sys/devices/platform/${device}/hwmon/${id}/${name}`] = text;
  return out;
}

function cpufreq(n, khz, { throttle = null } = {}) {
  const out = {};
  for (let i = 0; i < n; i++) {
    out[`sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`] = `${typeof khz === 'function' ? khz(i) : khz}\n`;
    out[`sys/devices/system/cpu/cpu${i}/topology/core_id`] = `${i}\n`;
  }
  if (throttle) {
    out['sys/devices/system/cpu/cpu0/thermal_throttle/package_throttle_count'] = `${throttle.pkg}\n`;
    out['sys/devices/system/cpu/cpu0/thermal_throttle/core_throttle_count'] = `${throttle.core}\n`;
    out['sys/devices/system/cpu/cpu0/thermal_throttle/package_power_limit_count'] = `${throttle.powerLimit || 0}\n`;
  }
  return out;
}

const MiB = 1048576;
const PCI_IDS = [
  '# a few lines of pci.ids, enough for the name lookup',
  '8086  Intel Corporation',
  '\t4680  AlderLake-S GT1',
  '\t56a5  DG2 [Arc A380]',
  '\t\t8086 1020  Arc A380 reference',
  '1002  Advanced Micro Devices, Inc. [AMD/ATI]',
  '\t73ff  Navi 23 [Radeon RX 6600/6600 XT/6600M]',
  '10de  NVIDIA Corporation',
  '\t2504  GA106 [GeForce RTX 3060 Lite Hash Rate]',
  ''
].join('\n');

// ---- (a) Intel desktop with an Arc A380 for encoding, seen with pid: host
const INTEL_LOADS = [41, 37, 55, 28, 61, 33, 47, 22, 39, 30, 52, 26]; // 39.25 % on average
const RAPL_MAX = 262143328850;
const RAPL_START = RAPL_MAX - 50000000; // wraps between phase 0 and 1

function xeFdinfo(client, { rcs, vcs, total }) {
  return [
    'pos:\t0', 'flags:\t02100002', 'mnt_id:\t26', 'ino:\t1048', 'drm-driver:\txe', `drm-client-id:\t${client}`, 'drm-pdev:\t0000:03:00.0',
    'drm-total-system:\t0', 'drm-total-gtt:\t192 KiB', 'drm-total-vram0:\t23992 KiB',
    `drm-cycles-rcs:\t${rcs}`, `drm-total-cycles-rcs:\t${total}`,
    'drm-cycles-bcs:\t0', `drm-total-cycles-bcs:\t${total}`,
    `drm-cycles-vcs:\t${vcs}`, `drm-total-cycles-vcs:\t${total}`, 'drm-engine-capacity-vcs:\t2',
    'drm-cycles-vecs:\t0', `drm-total-cycles-vecs:\t${total}`, 'drm-engine-capacity-vecs:\t2',
    'drm-cycles-ccs:\t0', `drm-total-cycles-ccs:\t${total}`, 'drm-engine-capacity-ccs:\t4', ''
  ].join('\n');
}

function i915Fdinfo(client, { render, video }) {
  return [
    'pos:\t0', 'flags:\t02100002', 'mnt_id:\t26', 'ino:\t1049', 'drm-driver:\ti915', 'drm-pdev:\t0000:00:02.0', `drm-client-id:\t${client}`,
    `drm-engine-render:\t${render} ns`, 'drm-engine-copy:\t0 ns', `drm-engine-video:\t${video} ns`, 'drm-engine-capacity-video:\t2',
    'drm-engine-video-enhance:\t0 ns', ''
  ].join('\n');
}

function intelArc(phase = 0) {
  const ts = 1000000000 + phase * 38400000; // the GPU's 19.2 MHz clock, 2 s per phase
  const uptime = 1000000 + phase * 2;
  const xeA = xeFdinfo(11, { rcs: 1000 + phase * 4608000, vcs: 5000000 + phase * 36096000, total: ts }); // 12 % render, 47 % video
  const xeB = xeFdinfo(12, { rcs: 0, vcs: 7000000 + phase * 36096000, total: ts }); // 47 % video
  const igpu = i915Fdinfo(3, { render: 1e9 + phase * 5e8, video: 2e9 + phase * 1.6e9 }); // 25 % render, 40 % video
  const hostCg = '0::/init.scope\n';
  const appCg = '0::/system.slice/docker-0123abcd.scope\n';
  const mountinfo = [
    '22 1 0:21 / / rw,relatime - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/A',
    '30 22 259:2 /srv/sentry/data /data rw,relatime - ext4 /dev/nvme0n1p2 rw',
    '41 22 0:45 / /footage/tesla rw,relatime - cifs //nas/teslacam rw,vers=3.1.1,cache=strict,seal',
    ''
  ].join('\n');
  return {
    'proc/stat': procStat(loadedCpus(INTEL_LOADS, phase)),
    'proc/cpuinfo': cpuinfoX86({ threads: 12, cores: 6, model: '12th Gen Intel(R) Core(TM) i5-12500', vendor: 'GenuineIntel' }),
    'proc/loadavg': '2.40 1.90 1.60 3/512 4242\n',
    'proc/uptime': `${uptime}.00 11000000.00\n`,
    'proc/meminfo': meminfo({ total: 32820000, available: 13700000, cached: 9000000, buffers: 200000, reclaimable: 300000, swapTotal: 2097148, swapFree: 2097148 }),
    'proc/version': 'Linux version 6.8.0-45-generic (buildd@lcy02-amd64-075) (x86_64-linux-gnu-gcc-13 (Ubuntu 13.2.0-23ubuntu4) 13.2.0) #45-Ubuntu SMP PREEMPT_DYNAMIC\n',
    'proc/sys/kernel/hostname': 'nas-box\n',
    'proc/sys/kernel/osrelease': '6.8.0-45-generic\n',
    'proc/sys/kernel/arch': 'x86_64\n',
    'proc/diskstats': [
      diskLine(7, 0, 'loop0', { readSectors: 999999 }),
      diskLine(259, 0, 'nvme0n1', { readSectors: 100000 + phase * 8192, writeSectors: 500000 + phase * 57344, ioMs: 9000 + phase * 400 }),
      diskLine(259, 1, 'nvme0n1p1', { readSectors: 1000 }),
      diskLine(259, 2, 'nvme0n1p2', { readSectors: 99000 + phase * 8192, writeSectors: 500000 + phase * 57344 }),
      diskLine(8, 0, 'sda', { readSectors: 7777, writeSectors: 8888, ioMs: 10 }),
      diskLine(8, 1, 'sda1', { readSectors: 7700 }),
      diskLine(253, 0, 'dm-0', { readSectors: 5 }),
      ''
    ].join('\n'),
    'proc/net/dev': netDev({ lo: [5000, 5000], eth0: [1000 + phase * 1000, 2000 + phase * 1000] }),
    'proc/1/net/dev': netDev({
      lo: [5000, 5000], enp3s0: [10e9 + phase * 2 * 112 * MiB, 5e9 + phase * 2 * 44 * MiB],
      docker0: [300, 300], veth1a2b3c: [1e6 + phase * 999, 1e6]
    }),
    ...processFiles({ pid: 1, comm: 'systemd', ppid: 0, utime: 5000, rss: 3000 }, { cgroup: hostCg }),
    ...processFiles({ pid: 2, comm: 'kthreadd', ppid: 0, rss: 0 }, { cgroup: hostCg }),
    ...processFiles({ pid: 3, comm: 'kworker/0:0-events', ppid: 2, utime: 900000 + phase * 2400, rss: 0 }, { cgroup: hostCg }),
    ...processFiles({ pid: 98, comm: 'tini', ppid: 1, rss: 100 }, { cgroup: appCg }),
    ...processFiles({ pid: 99, comm: 'node', ppid: 98, utime: 300, rss: 9000 }, { cgroup: appCg }),
    ...processFiles({ pid: 100, comm: 'node', ppid: 99, utime: 20000 + phase * 96, stime: 4000, start: 50000, rss: 55000, rssKb: 233472 },
      { cgroup: appCg, mountinfo, fds: { 0: '/dev/null', 20: 'socket:[4242]' } }),
    ...processFiles({ pid: 200, comm: 'ffmpeg', ppid: 100, utime: 9000 + phase * 216, start: 99000000, rss: 25000, rssKb: 102400 },
      { cgroup: appCg, fds: { 0: '/dev/null', 3: '/footage/tesla/a-front.mp4', 5: '/dev/dri/renderD128', 6: '/dev/dri/renderD128' }, fdinfo: { 5: xeA, 6: xeA } }),
    ...processFiles({ pid: 201, comm: 'ffmpeg', ppid: 100, utime: 9100 + phase * 216, start: 99000100, rss: 25000, rssKb: 101376 },
      { cgroup: appCg, fds: { 0: '/dev/null', 5: '/dev/dri/renderD128' }, fdinfo: { 5: xeB } }),
    ...processFiles({ pid: 202, comm: 'ffmpeg', ppid: 100, utime: 3000 + phase * 48, start: 99000200, rss: 20000, rssKb: 81920 },
      { cgroup: appCg, fds: { 4: '/dev/dri/renderD129' }, fdinfo: { 4: igpu } }),
    ...processFiles({ pid: 300, comm: 'Plex Media Server', ppid: 1, utime: 70000 + phase * 216, rss: 300000 }, { cgroup: '0::/system.slice/docker-plex.scope\n' }),
    ...processFiles({ pid: 301, comm: 'weird ) name', ppid: 1, utime: 10, rss: 50 }, { cgroup: hostCg }),
    ...processFiles({ pid: 302, comm: 'defunct', ppid: 1, state: 'Z', utime: 10, rss: 0 }, { cgroup: hostCg }),

    ...cpufreq(12, (i) => (i === 4 ? 4100000 : 800000 + i * 1000), { throttle: { pkg: 5, core: 2, powerLimit: 10 + phase * 50 } }),
    'sys/firmware/devicetree/.keep': '',
    // Arc A380 on xe: actual clock under tile0, card energy in its hwmon
    ...pciGpu({
      bus: 'pci0000:00/0000:00:01.0/0000:01:00.0/0000:02:01.0', bdf: '0000:03:00.0', vendor: '0x8086', device: '0x56a5', driver: 'xe', card: 'card0', render: 'renderD128',
      files: { 'tile0/gt0/freq0/act_freq': '1950\n' },
      hwmon: {
        id: 'hwmon6',
        files: {
          name: 'xe\n', energy1_input: `${1000000000 + phase * 48000000}\n`, energy1_label: 'card\n',
          energy2_input: `${900000000 + phase * 40000000}\n`, energy2_label: 'pkg\n', temp2_input: '61000\n', temp2_label: 'pkg\n'
        }
      }
    }),
    // UHD 770 on i915: clock in the card folder, no energy counter
    ...pciGpu({ bdf: '0000:00:02.0', bus: 'pci0000:00', vendor: '0x8086', device: '0x4680', driver: 'i915', card: 'card1', render: 'renderD129' }),
    'sys/devices/pci0000:00/0000:00:02.0/drm/card1/gt_act_freq_mhz': '1450\n',
    // NVMe data disk (with a partition the data folder lives on) and an 8 TB WD Red
    'sys/devices/pci0000:00/0000:00:1d.0/0000:3d:00.0/nvme/nvme0/model': 'Samsung SSD 980 PRO 1TB                 \n',
    'sys/devices/pci0000:00/0000:00:1d.0/0000:3d:00.0/nvme/nvme0/nvme0n1/size': '1953525168\n',
    'sys/devices/pci0000:00/0000:00:1d.0/0000:3d:00.0/nvme/nvme0/nvme0n1/queue/rotational': '0\n',
    'sys/devices/pci0000:00/0000:00:1d.0/0000:3d:00.0/nvme/nvme0/nvme0n1/device': link('..'),
    'sys/devices/pci0000:00/0000:00:1d.0/0000:3d:00.0/nvme/nvme0/nvme0n1/nvme0n1p2/partition': '2\n',
    'sys/devices/pci0000:00/0000:00:1d.0/0000:3d:00.0/nvme/nvme0/hwmon2/name': 'nvme\n',
    'sys/devices/pci0000:00/0000:00:1d.0/0000:3d:00.0/nvme/nvme0/hwmon2/temp1_input': '71850\n',
    'sys/devices/pci0000:00/0000:00:1d.0/0000:3d:00.0/nvme/nvme0/hwmon2/temp1_label': 'Composite\n',
    'sys/devices/pci0000:00/0000:00:1d.0/0000:3d:00.0/nvme/nvme0/hwmon2/temp2_input': '64850\n',
    'sys/devices/pci0000:00/0000:00:1d.0/0000:3d:00.0/nvme/nvme0/hwmon2/temp2_label': 'Sensor 1\n',
    'sys/devices/pci0000:00/0000:00:1d.0/0000:3d:00.0/nvme/nvme0/hwmon2/device': link('..'),
    'sys/class/hwmon/hwmon2': link('../../devices/pci0000:00/0000:00:1d.0/0000:3d:00.0/nvme/nvme0/hwmon2'),
    'sys/block/nvme0n1': link('../devices/pci0000:00/0000:00:1d.0/0000:3d:00.0/nvme/nvme0/nvme0n1'),
    'sys/dev/block/259:2': link('../../devices/pci0000:00/0000:00:1d.0/0000:3d:00.0/nvme/nvme0/nvme0n1/nvme0n1p2'),
    'sys/devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/model': 'WDC WD80EFZZ-68B\n',
    'sys/devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/block/sda/size': '15628053168\n',
    'sys/devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/block/sda/queue/rotational': '1\n',
    'sys/devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/block/sda/device': link('../..'),
    'sys/devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/hwmon/hwmon3/name': 'drivetemp\n',
    'sys/devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/hwmon/hwmon3/temp1_input': '38000\n',
    'sys/devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/hwmon/hwmon3/device': link('../..'),
    'sys/class/hwmon/hwmon3': link('../../devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/hwmon/hwmon3'),
    'sys/block/sda': link('../devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0/block/sda'),
    'sys/devices/virtual/block/loop0/size': '0\n',
    'sys/block/loop0': link('../devices/virtual/block/loop0'),
    'sys/devices/virtual/block/dm-0/size': '1000\n',
    'sys/block/dm-0': link('../devices/virtual/block/dm-0'),
    // CPU package sensor and the board's chip (one unplugged input, one dead fan header)
    ...platformHwmon('coretemp.0', 'hwmon1', {
      name: 'coretemp\n', temp1_input: '58000\n', temp1_label: 'Package id 0\n', temp2_input: '50000\n', temp2_label: 'Core 0\n',
      temp3_input: '63000\n', temp3_label: 'Core 4\n'
    }),
    ...platformHwmon('nct6775.656', 'hwmon4', {
      name: 'nct6798\n', temp1_input: '35000\n', temp1_label: 'SYSTIN\n', temp2_input: '127000\n', temp2_label: 'AUXTIN0\n',
      fan1_input: '1180\n', fan2_input: '910\n', fan3_input: '0\n'
    }),
    'sys/class/thermal/thermal_zone0/type': 'x86_pkg_temp\n',
    'sys/class/thermal/thermal_zone0/temp': '58000\n',
    // RAPL, readable here (as on a host without the 5.10 restriction)
    'sys/class/powercap/intel-rapl:0/name': 'package-0\n',
    'sys/class/powercap/intel-rapl:0/energy_uj': `${(RAPL_START + phase * 82000000) % RAPL_MAX}\n`,
    'sys/class/powercap/intel-rapl:0/max_energy_range_uj': `${RAPL_MAX}\n`,
    'sys/class/powercap/intel-rapl:0:0/name': 'core\n',
    'sys/class/powercap/intel-rapl:0:0/energy_uj': `${1000 + phase * 60000000}\n`,
    // the container's veth claims 10 Gbit/s; the real NIC has a device and says 2.5
    'sys/class/net/eth0/speed': '10000\n',
    'sys/devices/pci0000:00/0000:04:00.0/net/enp3s0/speed': '2500\n',
    'sys/devices/pci0000:00/0000:04:00.0/net/enp3s0/device': link('../..'),
    'sys/class/net/enp3s0': link('../../devices/pci0000:00/0000:04:00.0/net/enp3s0'),
    'dev/dri/renderD128': '',
    'dev/dri/renderD129': ''
  };
}

// ---- (b) AMD desktop with a Radeon RX 6600, in its own pid namespace
function amdFdinfo({ enc, dec, gfx }) {
  return [
    'pos:\t0', 'flags:\t02100002', 'mnt_id:\t24', 'ino:\t801', 'drm-driver:\tamdgpu', 'drm-client-id:\t55', 'drm-pdev:\t0000:0b:00.0',
    'pasid:\t32790', 'drm-memory-vram:\t30724 KiB', 'drm-memory-gtt:\t2048 KiB', `drm-engine-gfx:\t${gfx} ns`, 'drm-engine-compute:\t0 ns',
    `drm-engine-enc:\t${enc} ns`, `drm-engine-dec:\t${dec} ns`, ''
  ].join('\n');
}

function amd(phase = 0) {
  const cg = '0::/\n';
  const loads = new Array(16).fill(25);
  return {
    'proc/stat': procStat(loadedCpus(loads, phase)),
    'proc/cpuinfo': cpuinfoX86({ threads: 16, cores: 8, model: 'AMD Ryzen 7 5800X 8-Core Processor', vendor: 'AuthenticAMD' }),
    'proc/loadavg': '4.00 3.50 3.00 2/700 999\n',
    'proc/uptime': `${5000 + phase * 2}.50 70000.00\n`,
    'proc/meminfo': meminfo({ total: 16000000, available: 9000000, cached: 4000000, swapTotal: 0, swapFree: 0 }),
    'proc/version': 'Linux version 6.1.0-18-amd64 (debian-kernel@lists.debian.org) (gcc-12 (Debian 12.2.0-14) 12.2.0) #1 SMP PREEMPT_DYNAMIC Debian 6.1.76-1\n',
    'proc/sys/kernel/hostname': 'ryzen\n',
    'proc/sys/kernel/osrelease': '6.1.0-18-amd64\n',
    'proc/diskstats': `${diskLine(8, 16, 'sdb', { readSectors: 1000 + phase * 4096, writeSectors: 2000 })}\n`,
    'proc/net/dev': netDev({ lo: [1, 1], eth0: [1000 + phase * 2000000, 1000 + phase * 200000] }),
    'proc/1/net/dev': netDev({ lo: [1, 1], eth0: [1000 + phase * 2000000, 1000 + phase * 200000] }),
    ...processFiles({ pid: 1, comm: 'tini', ppid: 0, rss: 100 }, { cgroup: cg }),
    ...processFiles({ pid: 7, comm: 'node', ppid: 1, utime: 100, rss: 8000 }, { cgroup: cg }),
    ...processFiles({ pid: 8, comm: 'node', ppid: 7, utime: 5000 + phase * 64, start: 300000, rss: 40000 }, { cgroup: cg }),
    ...processFiles({ pid: 400, comm: 'ffmpeg', ppid: 8, utime: 900 + phase * 320, start: 450000, rss: 30000 },
      { cgroup: cg, fds: { 7: '/dev/dri/renderD128' }, fdinfo: { 7: amdFdinfo({ gfx: 5e6 + phase * 1e8, enc: 1e9 + phase * 1.2e9, dec: 8e8 + phase * 4e8 }) } }),
    ...cpufreq(16, 3800000),
    ...pciGpu({
      bdf: '0000:0b:00.0', vendor: '0x1002', device: '0x73ff', driver: 'amdgpu', card: 'card0', render: 'renderD128',
      files: {
        gpu_busy_percent: '37\n', mem_info_vram_used: '1073741824\n', mem_info_vram_total: '8573157376\n',
        pp_dpm_sclk: '0: 500Mhz\n1: 2044Mhz *\n2: 2491Mhz\n', product_name: '\n'
      },
      hwmon: {
        id: 'hwmon2',
        files: {
          name: 'amdgpu\n', power1_average: '85000000\n', power1_cap: '100000000\n', temp1_input: '61000\n', temp1_label: 'edge\n',
          temp2_input: '70000\n', temp2_label: 'junction\n', fan1_input: '1100\n'
        }
      }
    }),
    ...platformHwmon('k10temp', 'hwmon1', { name: 'k10temp\n', temp1_input: '65250\n', temp1_label: 'Tctl\n', temp3_input: '58000\n', temp3_label: 'Tccd1\n' }),
    'sys/devices/pci0000:00/0000:00:08.1/ata2/host1/target1:0:0/1:0:0:0/model': 'Samsung SSD 870\n',
    'sys/devices/pci0000:00/0000:00:08.1/ata2/host1/target1:0:0/1:0:0:0/block/sdb/size': '1953525168\n',
    'sys/devices/pci0000:00/0000:00:08.1/ata2/host1/target1:0:0/1:0:0:0/block/sdb/queue/rotational': '0\n',
    'sys/devices/pci0000:00/0000:00:08.1/ata2/host1/target1:0:0/1:0:0:0/block/sdb/device': link('../..'),
    'sys/block/sdb': link('../devices/pci0000:00/0000:00:08.1/ata2/host1/target1:0:0/1:0:0:0/block/sdb'),
    'sys/class/net/eth0/speed': '10000\n'
  };
}

// ---- (c) a server with an NVIDIA card (its numbers come from nvidia-smi)
function nvidia(phase = 0) {
  return {
    'proc/stat': procStat(loadedCpus([20, 20, 20, 20], phase)),
    'proc/cpuinfo': cpuinfoX86({ threads: 4, cores: 4, model: 'Intel(R) Xeon(R) E-2236 CPU @ 3.40GHz', vendor: 'GenuineIntel' }),
    'proc/loadavg': '1.00 1.00 1.00 1/100 100\n',
    'proc/uptime': `${700 + phase * 2}.00 2000.00\n`,
    'proc/meminfo': meminfo({ total: 8000000, available: 300000, cached: 100000 }), // 3.75 % available: low
    'proc/driver/nvidia/version': 'NVRM version: NVIDIA UNIX x86_64 Kernel Module  550.54.14\n',
    ...processFiles({ pid: 1, comm: 'tini', ppid: 0 }),
    ...processFiles({ pid: 10, comm: 'node', ppid: 1, utime: 100 + phase * 8, start: 6000 }),
    ...pciGpu({ bdf: '0000:01:00.0', vendor: '0x10de', device: '0x2504', driver: 'nvidia', card: 'card0', render: 'renderD128' }),
    'dev/nvidia0': '',
    'dev/nvidiactl': ''
  };
}

const NVIDIA_LINES = [
  '0, NVIDIA GeForce RTX 3060, 550.54.14, 23, 61, 12, 1650, 12288, 54, 41.27, 1777',
  '1, Tesla T4, 550.54.14, 0, [N/A], [N/A], 3, 15360, 33, [N/A], [Not Supported]'
];

// ---- (d) Raspberry Pi 4 (64-bit OS): no hwmon, a thermal zone, V3D GPU
function pi(phase = 0) {
  const cpu = (n) => [
    `processor\t: ${n}`, 'BogoMIPS\t: 108.00', 'Features\t: fp asimd evtstrm crc32 cpuid', 'CPU implementer\t: 0x41',
    'CPU architecture: 8', 'CPU variant\t: 0x0', 'CPU part\t: 0xd08', 'CPU revision\t: 3'
  ].join('\n');
  return {
    'proc/stat': procStat(loadedCpus([50, 10, 10, 10], phase)),
    'proc/cpuinfo': `${[0, 1, 2, 3].map(cpu).join('\n\n')}\n\nHardware\t: BCM2835\nRevision\t: c03114\nSerial\t\t: 10000000abcdef01\nModel\t\t: Raspberry Pi 4 Model B Rev 1.4\n`,
    'proc/loadavg': '0.50 0.40 0.30 1/150 900\n',
    'proc/uptime': `${86400 + phase * 2}.00 300000.00\n`,
    'proc/meminfo': meminfo({ total: 3884000, available: 2900000, cached: 500000, swapTotal: 102396, swapFree: 51198 }),
    'proc/version': 'Linux version 6.6.31+rpt-rpi-v8 (serge@raspberrypi.com) (aarch64-linux-gnu-gcc-12 (Debian 12.2.0-14) 12.2.0) #1 SMP PREEMPT Debian 1:6.6.31-1+rpt1\n',
    'proc/sys/kernel/hostname': 'raspberrypi\n',
    'proc/sys/kernel/osrelease': '6.6.31+rpt-rpi-v8\n',
    'proc/sys/kernel/arch': 'aarch64\n',
    'proc/diskstats': `${diskLine(179, 0, 'mmcblk0', { readSectors: 5000 + phase * 100, writeSectors: 9000 + phase * 300 })}\n`,
    'proc/net/dev': netDev({ lo: [1, 1], eth0: [5000 + phase * 20000, 3000 + phase * 10000] }),
    ...processFiles({ pid: 1, comm: 'tini', ppid: 0 }),
    ...processFiles({ pid: 20, comm: 'node', ppid: 1, utime: 2000 + phase * 16, start: 40000, rss: 20000 }),
    ...cpufreq(4, 1500000),
    'sys/firmware/devicetree/base/model': 'Raspberry Pi 4 Model B Rev 1.4\0',
    'sys/class/thermal/thermal_zone0/type': 'cpu-thermal\n',
    'sys/class/thermal/thermal_zone0/temp': '52582\n',
    // V3D renders (has a render node); VC4 only drives the display
    'sys/devices/platform/v3dbus/fec00000.v3d/uevent': 'DRIVER=v3d\nOF_NAME=v3d\nOF_COMPATIBLE_0=brcm,2711-v3d\n',
    'sys/devices/platform/v3dbus/fec00000.v3d/drm/card0/device': link('../..'),
    'sys/devices/platform/v3dbus/fec00000.v3d/drm/renderD128/device': link('../..'),
    'sys/class/drm/card0': link('../../devices/platform/v3dbus/fec00000.v3d/drm/card0'),
    'sys/class/drm/renderD128': link('../../devices/platform/v3dbus/fec00000.v3d/drm/renderD128'),
    'sys/devices/platform/gpu/uevent': 'DRIVER=vc4-drm\nOF_NAME=gpu\n',
    'sys/devices/platform/gpu/drm/card1/device': link('../..'),
    'sys/class/drm/card1': link('../../devices/platform/gpu/drm/card1'),
    'sys/devices/platform/emmc2bus/fe340000.mmc/mmc_host/mmc0/mmc0:aaaa/name': 'SC64G\n',
    'sys/devices/platform/emmc2bus/fe340000.mmc/mmc_host/mmc0/mmc0:aaaa/block/mmcblk0/size': '124735488\n',
    'sys/devices/platform/emmc2bus/fe340000.mmc/mmc_host/mmc0/mmc0:aaaa/block/mmcblk0/queue/rotational': '0\n',
    'sys/devices/platform/emmc2bus/fe340000.mmc/mmc_host/mmc0/mmc0:aaaa/block/mmcblk0/device': link('../..'),
    'sys/block/mmcblk0': link('../devices/platform/emmc2bus/fe340000.mmc/mmc_host/mmc0/mmc0:aaaa/block/mmcblk0')
  };
}

// ---- (e) a locked-down container: almost nothing readable, some of it garbage
function bare() {
  return {
    'proc/stat': 'cpu  abc def\ncpu0 1 2\n',
    'proc/meminfo': { dir: true }, // EISDIR
    'proc/diskstats': link('/nonexistent/diskstats'),
    'proc/cpuinfo': '\u0000\u0001\u0002 garbage :::\n',
    'proc/net/dev': 'no interfaces here\n',
    'proc/self': { dir: true },
    'sys/.keep': '',
    'dev/.keep': ''
  };
}

/** Write a machine into a fresh temp folder. update() rewrites its files for another phase. */
function build(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-stats-'));
  const write = (s, { links = true } = {}) => {
    for (const [rel, v] of Object.entries(s)) {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (v && typeof v === 'object' && 'link' in v) {
        if (links && !fs.existsSync(p) && !isLink(p)) fs.symlinkSync(v.link, p);
      } else if (v && typeof v === 'object' && v.dir) {
        fs.mkdirSync(p, { recursive: true });
      } else {
        fs.writeFileSync(p, String(v));
      }
    }
  };
  write(spec);
  return {
    root,
    proc: path.join(root, 'proc'),
    sys: path.join(root, 'sys'),
    dev: path.join(root, 'dev'),
    update: (s) => write(s, { links: false }),
    file: (rel, text) => write({ [rel]: text }),
    remove: (rel) => fs.rmSync(path.join(root, rel), { recursive: true, force: true }),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

module.exports = {
  build, intelArc, amd, nvidia, pi, bare, NVIDIA_LINES, PCI_IDS, INTEL_LOADS, RAPL_MAX,
  statLine, procStat, xeFdinfo, i915Fdinfo, amdFdinfo, netDev, diskLine, processFiles, MiB
};
