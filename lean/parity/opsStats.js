'use strict';

// Records the Node server monitor (server/stats) on the fake machines of
// test/fixtures/stats/machines.js, phase by phase, for the lean port's
// replay test (lean/src/ops/stats/tests.rs): each scenario's file trees (the
// first phase whole, then what each phase changes), what else happens before
// each sample (share answers, RAPL readings from the supervisor, a job
// marked) and the GET /api/stats body Node built after it.
//
//   node lean/parity/opsStats.js [out dir]   (default lean/src/ops/stats/testdata)
//
// Times are the fake clock's; nothing leaves the machine.

process.env.TZ = process.env.TZ || 'UTC';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { createStats } = require(path.join(ROOT, 'server/stats'));
const M = require(path.join(ROOT, 'test/fixtures/stats/machines'));
const { fakeClock, fakeSpawn, fakeFs } = require(path.join(ROOT, 'test/fixtures/stats/helpers'));

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'src', 'ops', 'stats', 'testdata'));
const MAX = M.RAPL_MAX;
const held = () => ({ setTimeout: () => ({ unref() {} }), clearTimeout() {} });

const SHARES = [{ label: 'Footage share', path: '/footage/tesla' }, { label: 'Data volume', path: '/data' }];
const ARC_ENCODES = [{ jobId: 'j1', pid: 200, encoder: 'hevc_vaapi', hardware: true }, { jobId: 'j1', pid: 201, encoder: 'hevc_vaapi', hardware: true }];

const vm = (phase) => {
  const spec = M.amd(phase);
  spec['proc/cpuinfo'] = spec['proc/cpuinfo'].replace(/flags\t\t: fpu vme de pse/g, 'flags\t\t: fpu vme de pse hypervisor');
  return spec;
};
const wsl = (phase) => ({ ...M.amd(phase), 'proc/sys/kernel/osrelease': '5.15.153.1-microsoft-standard-WSL2\n' });
const withPciIds = (machine) => (phase) => ({ ...machine(phase), 'pci.ids': M.PCI_IDS });
const unraid = (phase) => ({
  ...M.amd(phase),
  'proc/1/net/dev': M.netDev({ lo: [1, 1], eth0: [1e6 + phase * 2e6, 0], bond0: [1e6 + phase * 2e6, 0], br0: [1e6 + phase * 2e6, 0], wg0: [5, 5 + phase * 2000], docker0: [0, 0] }),
  'proc/1/cgroup': '0::/init.scope\n'
});
const reading = (at, energyUj, name = 'package-0') => ({ at, packages: [{ name, energyUj, maxEnergyUj: MAX }] });

/**
 * name, machine(phase), last phase, and what else the run does:
 * appPid, touch (sampling as a page does, with timers that never fire),
 * nvidia lines, pciIds (the tree's own pci.ids), shares (fakeFs state),
 * before(p, ctx) (changes shares, sends RAPL, marks a job), price, progress.
 */
const SCENARIOS = [
  { name: 'intel-arc', machine: M.intelArc, to: 2, shares: { '/footage/tesla': { delayMs: 3, blocks: 2e9, bfree: 5e8 }, '/data': { blocks: 1.2e8, bfree: 9e7 } }, readShares: SHARES, encodes: ARC_ENCODES },
  { name: 'intel-arc-pciids', machine: withPciIds(M.intelArc), to: 1, pciIds: true },
  { name: 'intel-arc-long', machine: M.intelArc, to: 25 },
  { name: 'amd', machine: M.amd, appPid: 8, to: 2 },
  { name: 'amd-pciids', machine: withPciIds(M.amd), appPid: 8, to: 1, pciIds: true },
  { name: 'nvidia', machine: M.nvidia, appPid: 10, to: 16, touch: true, nvidia: M.NVIDIA_LINES },
  { name: 'pi', machine: M.pi, appPid: 20, to: 2 },
  { name: 'bare', machine: M.bare, to: 3 },
  { name: 'dual-xeon', machine: M.dualXeon, to: 2, touch: true, nvidia: M.DUALXEON_NVIDIA_LINES },
  { name: 'vm', machine: vm, appPid: 8, to: 4, touch: true },
  { name: 'wsl', machine: wsl, appPid: 8, to: 4, touch: true },
  { name: 'unraid-bridge', machine: unraid, appPid: 8, to: 1 },
  {
    name: 'nas-hangs', machine: M.amd, appPid: 8, to: 30,
    shares: { '/footage/tesla': { delayMs: 4, blocks: 1000, bfree: 500 }, '/data': { blocks: 1000, bfree: 900 } },
    readShares: [{ label: 'Footage share', path: '/footage/tesla' }, { label: 'Data', path: '/data' }],
    before: (p, x) => { if (p === 2) x.shares['/footage/tesla'] = { ...x.shares['/footage/tesla'], hung: true }; }
  },
  {
    name: 'share-back', machine: M.amd, appPid: 8, to: 41,
    shares: { '/footage/tesla': { error: 'EHOSTDOWN' } }, readShares: [{ label: 'Footage share', path: '/footage/tesla' }],
    before: (p, x) => { if (p === 21) x.shares['/footage/tesla'] = { delayMs: 2, blocks: 10, bfree: 5 }; }
  },
  {
    name: 'rapl-price-job', machine: M.amd, appPid: 8, to: 6, touch: true, price: 0.25,
    progress: true,
    before: (p, x) => {
      if (p === 1) x.mark('job-1');
      if (p >= 3) x.rapl(reading(x.clock.t - 1, 1e9 + p * 60e6));
      if (p === 5) x.mark(null);
    }
  }
];

function treeOf(spec) {
  const out = {};
  for (const [rel, v] of Object.entries(spec)) {
    if (v && typeof v === 'object' && 'link' in v) out[rel] = { link: v.link };
    else if (v && typeof v === 'object' && v.dir) out[rel] = { dir: true };
    else out[rel] = String(v);
  }
  return out;
}

async function record(sc) {
  const first = sc.machine(0);
  const m = M.build(first);
  const clock = fakeClock();
  const start = clock.t;
  const spawn = fakeSpawn({ lines: sc.nvidia || [] });
  const shares = JSON.parse(JSON.stringify(sc.shares || {}));
  const x = { shares, clock, phase: 0, events: [] };
  const fsp = fakeFs(clock, shares);
  // (fakeFs reads `shares` at each call: the scenario's changes land in it)
  const stats = createStats({
    procRoot: m.proc, sysRoot: m.sys, devRoot: m.dev, appPid: sc.appPid ?? 100, now: clock.now, spawn, ffmpegVersion: '7.1.1-Jellyfin',
    version: 'test', dataDir: null, timers: held(), pciIdsFiles: sc.pciIds ? [path.join(m.root, 'pci.ids')] : ['/nonexistent/pci.ids'],
    fsp, readShares: () => sc.readShares || [], activeEncodes: () => sc.encodes || [],
    priceAt: () => (sc.price === undefined ? null : sc.price),
    jobProgress: () => (sc.progress ? { clips: x.phase, savedB: x.phase * 1000 } : null)
  });
  x.mark = (job) => { x.events.push({ markJob: job }); stats.markJob(job); };
  x.rapl = (r) => { x.events.push({ rapl: r }); stats.setRapl(r); };
  const phases = [];
  const snapshots = [];
  let prev = treeOf(first);
  try {
    if (sc.touch) stats.touch();
    for (let p = 0; p <= sc.to; p++) {
      x.phase = p;
      x.events = [];
      let files = {};
      if (p) {
        const spec = sc.machine(p);
        const tree = treeOf(spec);
        for (const [k, v] of Object.entries(tree)) if (JSON.stringify(prev[k]) !== JSON.stringify(v)) files[k] = v;
        prev = { ...prev, ...tree };
        m.update(spec);
        clock.advance(2000);
      } else {
        files = prev;
      }
      const before = JSON.stringify(shares);
      sc.before?.(p, x);
      phases.push({ files, shares: JSON.stringify(shares) !== before || p === 0 ? JSON.parse(JSON.stringify(shares)) : undefined, events: x.events, at: clock.t });
      stats.sampleNow();
      await stats.settle();
      // the nvidia-smi lines arrive a moment after it started
      if (p === 0 && sc.nvidia) await new Promise((r) => setTimeout(r, 20));
      // (a long run keeps its first samples, every fifth, the last and each
      // one whose alerts or shares changed: the file stays small)
      const snap = JSON.parse(JSON.stringify(stats.snapshot()));
      const mark = JSON.stringify([snap.alerts, snap.filesystems.map((f) => [f.reachable, f.latencyMs])]);
      const keep = sc.to <= 6 || p <= 3 || p % 5 === 0 || p === sc.to || mark !== x.lastMark;
      x.lastMark = mark;
      snapshots.push(keep ? snap : null);
    }
  } finally {
    stats.stop();
    m.cleanup();
  }
  return {
    name: sc.name, appPid: sc.appPid ?? 100, start, touch: Boolean(sc.touch), nvidia: sc.nvidia || [], pciIds: Boolean(sc.pciIds),
    readShares: sc.readShares || [], encodes: (sc.encodes || []).map((e) => ({ pid: e.pid, encoder: e.encoder })), price: sc.price ?? null, progress: Boolean(sc.progress),
    spawned: spawn.calls.map((c) => ({ cmd: c.cmd, args: c.args })), phases, snapshots
  };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const sc of SCENARIOS) {
    const r = await record(sc);
    fs.writeFileSync(path.join(OUT, `${sc.name}.json.gz`), require('zlib').gzipSync(`${JSON.stringify(r)}\n`, { level: 9 }));
    console.log(`${sc.name}: ${r.snapshots.length} samples`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
