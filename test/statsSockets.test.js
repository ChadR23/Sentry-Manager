'use strict';

// Servers with two or more CPU sockets: each socket's use, temperature and
// package power in GET /api/stats (cpu.sockets, cpu.perSocket), the hottest
// CPU chip as the CPU temperature, and the Server page's CPU tile with a
// line per socket. A server with one socket gets the body and the tile it
// had before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseCpuinfo } = require('../server/stats/cpu');
const { packageWatts, socketWatts } = require('../server/stats/power');
const M = require('./fixtures/stats/machines');
const { setup, fakeSpawn } = require('./fixtures/stats/helpers');

const REPO = path.join(__dirname, '..');
const CPU_KEYS = ['model', 'cores', 'threads', 'usage', 'perCore', 'freqMHz', 'tempC', 'load', 'app', 'throttling'];
const MAX = 262143328850;
const sample = (name = '') => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `statsSample${name ? `-${name}` : ''}.json`), 'utf8'));
const SINGLE = ['', 'amd', 'nvidia', 'pi', 'idle'];

// app.js is one browser script; its drawing part has no DOM and runs here as is
function overview() {
  const app = fs.readFileSync(path.join(REPO, 'web/app.js'), 'utf8');
  const start = app.indexOf('// ---- server monitor: drawing');
  const end = app.indexOf('// ---- server monitor: end of drawing ----');
  assert.ok(start > 0 && end > start, 'the drawing block is marked in app.js');
  const helpers = ['esc', 'plural'].map((name) => app.match(new RegExp(`\\n  const ${name} = .*;\\n`))[0]).join('');
  return new Function(`${helpers}${app.slice(start, end)}
    return { serverBody, cpuTile };`)();
}

/** The CPU tile of a body, as the page draws it. */
const cpuHtml = (cpu) => overview().cpuTile(cpu, null, false);

/** Sample a machine phase by phase; `each(p)` runs before phase p is sampled. */
async function runPhases(s, machine, to, each = () => {}) {
  for (let p = 0; p <= to; p++) {
    if (p) {
      s.m.update(machine(p));
      s.clock.advance(2000);
    }
    each(p);
    s.stats.sampleNow();
    await s.stats.settle();
  }
  return s.stats.snapshot();
}

/** A machine without its coretemp chips or its RAPL folders (to put others in their place). */
function without(spec, re) {
  for (const k of Object.keys(spec)) if (re.test(k)) delete spec[k];
  return spec;
}

/** A hwmon chip on a PCI device (k10temp sits on the CPU's own PCI functions). */
function pciHwmon(bdf, id, files) {
  const dev = `sys/devices/pci0000:00/${bdf}`;
  const out = {
    [`${dev}/hwmon/${id}/device`]: { link: '../..' },
    [`sys/class/hwmon/${id}`]: { link: `../../devices/pci0000:00/${bdf}/hwmon/${id}` }
  };
  for (const [name, text] of Object.entries(files)) out[`${dev}/hwmon/${id}/${name}`] = text;
  return out;
}

test('dual Xeon: use, temperature and package power per socket; the CPU totals stay the whole server', async () => {
  const spawn = fakeSpawn({ lines: M.DUALXEON_NVIDIA_LINES });
  const s = setup(M.dualXeon, { spawn });
  try {
    s.stats.touch(); // starts nvidia-smi
    const snap = await s.run(2);
    const { cpu } = snap;
    assert.equal(cpu.model, 'Intel Xeon Gold 6130');
    assert.equal(cpu.cores, 32, 'both sockets, cores counted by socket and core id');
    assert.equal(cpu.threads, 64);
    assert.equal(cpu.usage, 37.5);
    assert.deepEqual(cpu.perCore, M.DUALXEON_LOADS);
    assert.equal(cpu.freqMHz, 3700);
    assert.equal(cpu.sockets, 2);
    assert.deepEqual(cpu.perSocket, [
      { socket: 0, cores: 16, threads: 32, usage: 45, tempC: 61, powerW: 85 },
      { socket: 1, cores: 16, threads: 32, usage: 30, tempC: 66, powerW: 62 }
    ]);
    // each socket's use is the time its own CPUs worked
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    assert.equal(mean(M.DUALXEON_LOADS.filter((_, n) => M.dualXeonSocket(n) === 0)), 45);
    assert.equal(cpu.tempC, 66, 'the hotter socket, whose coretemp chip is the second one');
    assert.equal(snap.power.cpuW, 147, 'both packages');
    assert.equal(snap.power.totalW, 202.6, 'CPU packages + Arc + T400');
    assert.deepEqual(snap.gpus.map((g) => [g.name, g.driver, g.node, g.video, g.powerW]), [
      ['Intel Arc A380', 'i915', 'renderD128', 85, 31], ['NVIDIA T400', 'nvidia', 'nvidia0', 74, 24.6]
    ]);
    assert.deepEqual(Object.keys(cpu), [...CPU_KEYS, 'sockets', 'perSocket'], 'the new fields come after the ones there were');
    assert.deepEqual(snap.sensors.filter((x) => /^Package id/.test(x.label)).map((x) => [x.label, x.value]), [['Package id 0', 61], ['Package id 1', 66]]);
    assert.doesNotThrow(() => JSON.stringify(snap));
  } finally {
    s.done();
  }
});

test('dual Xeon before its second sample: the sockets are known, their numbers not yet', async () => {
  const s = setup(M.dualXeon);
  try {
    assert.deepEqual([s.stats.snapshot().cpu.sockets, s.stats.snapshot().cpu.perSocket], [1, null], 'nothing sampled: one socket, no list');
    const snap = await s.run(0);
    assert.equal(snap.cpu.sockets, 2);
    assert.deepEqual(snap.cpu.perSocket, [
      { socket: 0, cores: 16, threads: 32, usage: null, tempC: null, powerW: null },
      { socket: 1, cores: 16, threads: 32, usage: null, tempC: null, powerW: null }
    ]);
  } finally {
    s.done();
  }
});

test('coretemp chips go by the package they name, not by their hwmon number', async () => {
  const machine = (phase) => ({
    ...without(M.dualXeon(phase), /coretemp\.[01]|sys\/class\/hwmon\/hwmon[12]$/),
    // package 1 registered first and hotter; a core above its package is not the package
    ...M.platformHwmon('coretemp.1', 'hwmon1', { name: 'coretemp\n', temp1_input: '70000\n', temp1_label: 'Package id 1\n', temp2_input: '71000\n', temp2_label: 'Core 0\n' }),
    ...M.platformHwmon('coretemp.0', 'hwmon2', { name: 'coretemp\n', temp1_input: '55000\n', temp1_label: 'Package id 0\n' })
  });
  const s = setup(machine);
  try {
    const snap = await s.run(1);
    assert.deepEqual(snap.cpu.perSocket.map((x) => [x.socket, x.tempC]), [[0, 55], [1, 70]]);
    assert.equal(snap.cpu.tempC, 70, 'the hottest package of all the chips');
  } finally {
    s.done();
  }
});

test('two dies per socket (Xeon 9200): coretemp numbers its chips by die, so no socket is given another one\'s temperature', async () => {
  const chip = (n, hwmon, milli) => M.platformHwmon(`coretemp.${n}`, hwmon, { name: 'coretemp\n', temp1_input: `${milli}\n`, temp1_label: `Package id ${n}\n` });
  const machine = (phase) => ({
    ...without(M.dualXeon(phase), /coretemp\.[01]|sys\/class\/hwmon\/hwmon[12]$/),
    ...chip(0, 'hwmon1', 50000), ...chip(1, 'hwmon2', 74000), ...chip(2, 'hwmon5', 55000), ...chip(3, 'hwmon6', 58000)
  });
  const s = setup(machine);
  try {
    const snap = await s.run(1);
    assert.deepEqual(snap.cpu.perSocket.map((x) => [x.socket, x.tempC]), [[0, null], [1, null]], 'which die is on which socket cannot be told');
    assert.equal(snap.cpu.tempC, 74, 'the hottest die of all');
    // the Sensors tile keeps the dies' own numbers instead of calling them CPU 1 to 4
    const { serverBody } = overview();
    const page = serverBody({ ...sample('dualxeon'), sensors: snap.sensors }, { currency: '$' });
    assert.match(page, /<dt>CPU package 3<\/dt><dd>58 °C<\/dd>/);
    assert.doesNotMatch(page, /CPU [34] package/);
  } finally {
    s.done();
  }
});

test('dual EPYC: a k10temp chip per socket in device order, RAPL per package from the supervisor', async () => {
  const machine = (phase) => ({
    ...without(M.dualXeon(phase), /coretemp\.[01]|sys\/class\/hwmon\/hwmon[12]$|powercap/),
    'proc/cpuinfo': M.cpuinfoSockets({ sockets: 2, coreIds: Array.from({ length: 16 }, (_, i) => i), model: 'AMD EPYC 7302 16-Core Processor', vendor: 'AuthenticAMD' }),
    // socket 1's chip happens to be registered first
    ...pciHwmon('0000:00:19.3', 'hwmon1', { name: 'k10temp\n', temp1_input: '58000\n', temp1_label: 'Tctl\n', temp3_input: '55000\n', temp3_label: 'Tccd1\n' }),
    ...pciHwmon('0000:00:18.3', 'hwmon2', { name: 'k10temp\n', temp1_input: '52250\n', temp1_label: 'Tctl\n', temp3_input: '50000\n', temp3_label: 'Tccd1\n' })
  });
  const s = setup(machine);
  const rapl = (p) => ({
    at: s.clock.t,
    packages: [{ name: 'package-0', energyUj: 1e9 + p * 180e6, maxEnergyUj: MAX }, { name: 'package-1', energyUj: 3e9 + p * 150e6, maxEnergyUj: MAX }]
  });
  try {
    const snap = await runPhases(s, machine, 2, (p) => s.stats.setRapl(rapl(p)));
    assert.equal(snap.cpu.model, 'AMD EPYC 7302');
    assert.deepEqual(snap.cpu.perSocket, [
      { socket: 0, cores: 16, threads: 32, usage: 45, tempC: 52.3, powerW: 90 },
      { socket: 1, cores: 16, threads: 32, usage: 30, tempC: 58, powerW: 75 }
    ]);
    assert.equal(snap.cpu.tempC, 58);
    assert.equal(snap.power.cpuW, 165);
    assert.equal(snap.power.cpuSource, 'rapl');
  } finally {
    s.done();
  }
});

test('per-socket fields that cannot be told are null: k10temp chips that do not match the sockets, no RAPL', async () => {
  const machine = (phase) => ({
    ...without(M.dualXeon(phase), /coretemp\.[01]|sys\/class\/hwmon\/hwmon[12]$|powercap/),
    // one chip for two sockets: whose is it?
    ...pciHwmon('0000:00:18.3', 'hwmon2', { name: 'k10temp\n', temp1_input: '52000\n', temp1_label: 'Tctl\n' })
  });
  const s = setup(machine);
  try {
    const snap = await s.run(1);
    assert.deepEqual(snap.cpu.perSocket.map((x) => [x.usage, x.tempC, x.powerW]), [[45, null, null], [30, null, null]]);
    assert.equal(snap.cpu.tempC, 52, 'the CPU temperature is still shown');
    assert.equal(snap.power.cpuW, null);
  } finally {
    s.done();
  }
});

test('one socket: the body is the one it was (sockets 1, no per-socket list, the same CPU fields)', async () => {
  const machines = [
    ['intelArc', M.intelArc, {}, { tempC: 58, usage: 39.3, cores: 6, threads: 12 }],
    ['amd', M.amd, { appPid: 8 }, { tempC: 65.3, usage: 25, cores: 8, threads: 16 }],
    ['nvidia', M.nvidia, { appPid: 10, spawn: fakeSpawn({ lines: M.NVIDIA_LINES }) }, { tempC: null, usage: 20, cores: 4, threads: 4 }],
    ['pi', M.pi, { appPid: 20 }, { tempC: 52.6, usage: 20, cores: 4, threads: 4 }],
    ['bare', M.bare, {}, { tempC: null, usage: null, cores: null, threads: null }]
  ];
  for (const [name, machine, opts, want] of machines) {
    const s = setup(machine, opts);
    try {
      const snap = await s.run(2);
      assert.deepEqual(Object.keys(snap.cpu), [...CPU_KEYS, 'sockets', 'perSocket'], name);
      assert.equal(snap.cpu.sockets, 1, name);
      assert.equal(snap.cpu.perSocket, null, name);
      for (const [k, v] of Object.entries(want)) assert.equal(snap.cpu[k], v, `${name} ${k}`);
    } finally {
      s.done();
    }
  }
  const arc = setup(M.intelArc);
  try {
    assert.equal((await arc.run(2)).power.cpuW, 41, 'one RAPL package, as before');
  } finally {
    arc.done();
  }
});

test('a virtual machine with several virtual sockets counts as one', async () => {
  const vm = (phase) => {
    const spec = M.dualXeon(phase);
    spec['proc/cpuinfo'] = spec['proc/cpuinfo'].replace(/flags\t\t: fpu vme de pse/g, 'flags\t\t: fpu vme de pse hypervisor');
    return spec;
  };
  const s = setup(vm);
  try {
    const snap = await s.run(1);
    assert.equal(snap.cpu.sockets, 1);
    assert.equal(snap.cpu.perSocket, null);
    assert.equal(snap.cpu.cores, 32);
    assert.equal(snap.cpu.threads, 64);
    assert.doesNotMatch(cpuHtml(snap.cpu), / × |nd-sockets/);
  } finally {
    s.done();
  }
});

test('cpuinfo: sockets from the physical ids; boards without them have one', () => {
  const two = parseCpuinfo(M.cpuinfoSockets({ sockets: 2, coreIds: [0, 1, 4, 5], model: 'Intel(R) Xeon(R) Silver 4110 CPU @ 2.10GHz', vendor: 'GenuineIntel' }));
  assert.equal(two.sockets, 2);
  assert.equal(two.cores, 8);
  assert.equal(two.threads, 16);
  assert.deepEqual(two.socketList, [{ socket: 0, cores: 4, threads: 8 }, { socket: 1, cores: 4, threads: 8 }]);
  assert.deepEqual(two.packageCpus, [0, 4], 'the first CPU of each socket (the throttle counters), as before');
  assert.equal(two.socketOf.get(5), 1);
  assert.equal(two.socketOf.get(8), 0, 'second threads follow the first threads of every socket');
  const one = parseCpuinfo(M.intelArc(0)['proc/cpuinfo']);
  assert.deepEqual([one.sockets, one.socketList], [1, []]);
  const pi = parseCpuinfo(M.pi(0)['proc/cpuinfo']);
  assert.deepEqual([pi.sockets, pi.socketList], [1, []], 'ARM: no physical id');
  assert.deepEqual([parseCpuinfo('').sockets, parseCpuinfo(null).sockets], [1, 1], 'unknown: one');
});

test('RAPL per socket: dies of a package together, other zones and bad readings left out', () => {
  const at = (t, zones) => ({ at: t, packages: Object.entries(zones).map(([name, energyUj]) => ({ name, energyUj, maxEnergyUj: MAX })) });
  const a = at(0, { 'package-0-die-0': 0, 'package-0-die-1': 0, 'package-1': MAX - 10e6, psys: 0, dram: 0 });
  const b = at(2000, { 'package-0-die-0': 60e6, 'package-0-die-1': 40e6, 'package-1': 70e6, psys: 900e6, dram: 30e6 });
  assert.deepEqual([...socketWatts(a, b)], [[0, 50], [1, 40]], 'package-1 wrapped and still reads 40 W');
  assert.equal(packageWatts(a, b), 90, 'the CPU is still every package together');
  const absurd = at(2000, { 'package-0-die-0': 60e6, 'package-0-die-1': 40e6, 'package-1': 5e12, psys: 0, dram: 0 });
  assert.equal(packageWatts(a, absurd), null);
  assert.equal(socketWatts(a, absurd).size, 0, 'no per-socket numbers when the total is no answer');
  assert.equal(socketWatts(null, b).size, 0);
});

test('CPU tile: "2 × <model>", the counts as totals, and a line per socket', () => {
  const s = sample('dualxeon');
  const html = cpuHtml(s.cpu);
  assert.match(html, /<span class="muted" title="2 × Intel Xeon Gold 6130 · 32 cores \/ 64 threads">2 × Intel Xeon Gold 6130 · 32 cores \/ 64 threads<\/span>/);
  assert.match(html, /<div class="nd-sockets"><div title="16 cores \/ 32 threads"><span>CPU 1<\/span><span>48%<\/span><span>61 °C<\/span><span>85 W<\/span><\/div><div title="16 cores \/ 32 threads"><span>CPU 2<\/span><span>35%<\/span><span>68 °C<\/span><span>72 W<\/span><\/div><\/div>/);
  assert.ok(html.indexOf('nd-cores') < html.indexOf('nd-sockets') && html.indexOf('nd-sockets') < html.indexOf('nd-kv'), 'under the per-core strip, above the rows');
  assert.equal((html.match(/<i style="--v:/g) || []).length, 64, 'one bar per thread');
  assert.match(html, /<dt>Temp<\/dt><dd>68 °C<\/dd>/, 'the hottest socket');
  const { serverBody } = overview();
  const page = serverBody(s, { currency: '$' });
  assert.doesNotMatch(page, /NaN|undefined|null|Infinity/);
  // the Sensors tile names the packages with the same numbers
  assert.match(page, /<dt>CPU 1 package<\/dt><dd>61 °C<\/dd>/);
  assert.match(page, /<dt>CPU 2 package<\/dt><dd>68 °C<\/dd>/);
  assert.doesNotMatch(page, /CPU package 1/);
  assert.match(page, /ffmpeg · hevc_qsv ×3.*ffmpeg · hevc_nvenc ×2/, 'each GPU\'s clips under their own encoder');
});

test('CPU tile: a socket line goes by the kernel\'s physical id', () => {
  const s = sample('dualxeon');
  const html = cpuHtml({ ...s.cpu, perSocket: [{ ...s.cpu.perSocket[0], socket: 0 }, { ...s.cpu.perSocket[1], socket: 3 }] });
  assert.match(html, /<span>CPU 1<\/span>.*<span>CPU 4<\/span>/);
  assert.match(cpuHtml({ ...s.cpu, perSocket: [{ ...s.cpu.perSocket[0], socket: 'a' }, { ...s.cpu.perSocket[1], socket: null }] }), /<span>CPU 1<\/span>.*<span>CPU 2<\/span>/, 'no usable id: in list order');
});

test('CPU tile: per-socket fields that are missing are left out, a hot socket stands out, names are text', () => {
  const s = sample('dualxeon');
  const cpu = {
    ...s.cpu,
    perSocket: [{ socket: 0, cores: 16, threads: 32, usage: 12, tempC: null, powerW: null }, { socket: 1, cores: 16, threads: 32, usage: 97, tempC: 92.4, powerW: 8.25 }]
  };
  const html = cpuHtml(cpu);
  assert.match(html, /<span>CPU 1<\/span><span>12%<\/span><\/div>/);
  assert.match(html, /<span>CPU 2<\/span><span>97%<\/span><span><span class="nd-warn">92 °C<\/span><\/span><span>8\.3 W<\/span>/);
  // a socket with nothing to show has no line; a list without sockets > 1 is not drawn
  assert.doesNotMatch(cpuHtml({ ...s.cpu, perSocket: [null, { socket: 1, usage: null, tempC: null, powerW: null }] }), /nd-sockets/);
  assert.doesNotMatch(cpuHtml({ ...s.cpu, sockets: 1 }), /nd-sockets| × /);
  assert.match(cpuHtml({ ...s.cpu, model: null, perSocket: null }), /title="2 CPUs · 32 cores \/ 64 threads"/);
  assert.doesNotMatch(cpuHtml({ ...s.cpu, model: null, perSocket: null }), /nd-sockets/);
  const evil = cpuHtml({ ...s.cpu, model: '<img src=x onerror=alert(1)>', perSocket: [{ socket: 0, cores: '<script>', threads: 2, usage: 5 }, { socket: 1, usage: 'x', tempC: {}, powerW: [] }] });
  assert.doesNotMatch(evil, /<img|<script|NaN|undefined/);
  assert.match(evil, /2 × &lt;img src=x onerror=alert\(1\)&gt;/);
});

test('CPU tile with one socket: exactly the tile it was', () => {
  const { serverBody } = overview();
  for (const name of SINGLE) {
    const before = sample(name);
    const after = { ...before, cpu: { ...before.cpu, sockets: 1, perSocket: null } };
    assert.equal(serverBody(after, { currency: '$' }), serverBody(before, { currency: '$' }), `statsSample ${name}`);
    // a list sent for one socket is not drawn either
    const odd = { ...before, cpu: { ...before.cpu, sockets: 1, perSocket: [{ socket: 0, usage: 50, tempC: 60, powerW: 40 }] } };
    assert.equal(serverBody(odd, { currency: '$' }), serverBody(before, { currency: '$' }), `statsSample ${name} with a list`);
  }
  assert.match(cpuHtml(sample().cpu), /title="Intel Core i5-12500 · 6 cores \/ 12 threads"/);
});

test('the socket lines wrap on a phone and take their colours from the theme', () => {
  const css = fs.readFileSync(path.join(REPO, 'web/shell.css'), 'utf8');
  const rules = css.split('\n').filter((l) => l.startsWith('.nd-sockets'));
  assert.ok(rules.length >= 3);
  assert.ok(rules.some((l) => /^\.nd-sockets > div \{[^}]*flex-wrap: wrap/.test(l)), 'a line wraps instead of overflowing');
  assert.ok(rules.some((l) => /^\.nd-sockets \{[^}]*minmax\(0, 1fr\)/.test(l)), 'the list never widens the tile');
  for (const l of rules) assert.doesNotMatch(l, /#[0-9a-f]{3,8}\b|rgba?\(/i, `theme tokens only: ${l}`);
});
