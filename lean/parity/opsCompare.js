'use strict';

// Same answers for the ops area (lean/src/ops): records goldens of its GET
// routes from the Node fixture server (tools/contract/fixture.js, record.js)
// and replays them against the lean server, started on the same footage and
// on a copy of the fixture's data folder (manager.db: the same
// notifications, settings and snapshots), with the normalisers of
// tools/contract/spec.js.
//
//   node lean/parity/opsCompare.js [--dir /tmp/sm-ops] [--bin lean/target/debug/sentry-lean] [--settle 75] [--json out.json]
//
// The fixture's password goes only over its own HTTPS (record.js refuses
// plain HTTP); the lean server has no sign-in yet and is asked over loopback
// HTTP. Nothing is sent anywhere else. Exits 1 when an answer differs.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const lib = require(path.join(REPO, 'tools/contract/lib'));
const spec = require(path.join(REPO, 'tools/contract/spec'));
const fixture = require(path.join(REPO, 'tools/contract/fixture'));
const { record } = require(path.join(REPO, 'tools/contract/record'));

// this area's GET routes
const OPS = /^GET \/(metrics|api\/(notification-rules|notifications|health|snapshots|metrics|stats|system|support-bundle|reports|updates|vehicles\/:id\/savings-by-month))/;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** GET /api/stats twice (3 s apart: the second has rates) and GET /api/health, as bodies. */
async function bodies(client) {
  const get = async (p) => lib.parseJson((await client.request('GET', p)).body);
  await get('/api/stats');
  await new Promise((r) => setTimeout(r, 3000));
  return { stats: await get('/api/stats'), health: await get('/api/health') };
}

const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** Every key path of a body with its kind (null and a number count as one: a reading may be missing). */
function shapeOf(v, at = '', out = new Map()) {
  const k = kind(v);
  out.set(at || '.', k === 'null' ? 'number?' : k === 'number' ? 'number?' : k);
  if (k === 'object') for (const [key, x] of Object.entries(v)) shapeOf(x, `${at}.${key}`, out);
  if (k === 'array' && v.length) shapeOf(v[0], `${at}[]`, out);
  return out;
}

/**
 * The fields of GET /api/stats that are the machine's, not the moment's
 * (host, CPU model and counts, memory size, GPUs, power sources, disks,
 * shares, interfaces, sensors' names, scopes, hints), and the health checks'
 * ids, groups, labels and states. The app's own process, uptimes, rates and
 * readings are left out.
 */
function deepCompare(a, b, data) {
  const out = { stats: [], health: [] };
  const push = (list, p, x, y) => { if (JSON.stringify(x) !== JSON.stringify(y)) list.push({ path: p, golden: x, actual: y }); };
  const sa = shapeOf(a.stats);
  const sb = shapeOf(b.stats);
  for (const [p, k] of sa) if (sb.get(p) !== k && !(k === 'array' && !sb.has(p))) push(out.stats, `shape ${p}`, k, sb.get(p) ?? 'missing');
  for (const [p, k] of sb) if (!sa.has(p)) push(out.stats, `shape ${p}`, 'missing', k);
  const own = (s, root) => ({
    intervalMs: s.intervalMs,
    host: { hostname: s.host.hostname, os: s.host.os, kernel: s.host.kernel, arch: s.host.arch, version: s.host.version, ffmpeg: s.host.ffmpeg },
    cpu: { model: s.cpu.model, cores: s.cpu.cores, threads: s.cpu.threads, sockets: s.cpu.sockets, perCore: s.cpu.perCore.length, perSocket: s.cpu.perSocket && s.cpu.perSocket.map((x) => x.socket) },
    memory: { totalB: s.memory.totalB, swapTotalB: s.memory.swapTotalB },
    gpus: s.gpus.map((g) => [g.id, g.name, g.vendor, g.driver, g.node, g.vramTotalB, g.integrated]),
    power: { cpuSource: s.power.cpuSource, gpuSource: s.power.gpuSource, cpuUnavailable: s.power.cpuUnavailable, priceNow: s.power.priceNow },
    disks: s.disks.map((d) => [d.name, d.model, d.kind]),
    filesystems: s.filesystems.map((f) => [f.label, String(f.path).split(root).join('<data>'), f.vehicle, f.totalB === null, f.fsType, f.source && String(f.source).split(root).join('<data>'), f.disk, f.smbVersion, f.mounted, f.checkEveryMs]),
    network: { scope: s.network.scope, interfaces: s.network.interfaces.map((i) => [i.name, i.speedMbps]) },
    sensors: s.sensors.map((x) => [x.chip, x.label, x.kind]),
    processes: s.processes.scope,
    unlock: s.unlock,
    alerts: s.alerts,
    price: s.price,
    encoder: s.encoder
  });
  const x = own(a.stats, data.node);
  const y = own(b.stats, data.lean);
  for (const k of Object.keys(x)) push(out.stats, k, x[k], y[k]);
  const checks = (h) => (h?.checks || []).map((c) => [c.id, c.group, c.label, c.status]);
  push(out.health, 'checks', checks(a.health), checks(b.health));
  return out;
}

async function main() {
  const dir = path.resolve(arg('dir', path.join(require('os').tmpdir(), 'sm-ops-compare')));
  const bin = path.resolve(arg('bin', path.join(REPO, 'lean/target/debug/sentry-lean')));
  const goldens = path.join(dir, 'goldens');
  fs.mkdirSync(dir, { recursive: true });

  // 1. the Node fixture, settled (the startup self-check and the first snapshot have run)
  const node = await fixture.start({ dir: path.join(dir, 'node'), settleMs: Number(arg('settle', 75)) * 1000 });
  process.env.SM_PASSWORD = process.env.SM_CONTRACT_PASSWORD || 'contract fixture password';
  const deep = {};
  try {
    await record({ base: node.base, ca: path.join(node.ca, 'ca.crt'), out: goldens, only: OPS.source });
    // the whole bodies too, for the field-by-field pass below (a first
    // request starts the sampler; the second, 3 s on, has its rates)
    const c = await lib.connect({ base: node.base, ca: path.join(node.ca, 'ca.crt') });
    try {
      deep.node = await bodies(c);
    } finally {
      c.close();
    }
  } finally {
    node.child.kill('SIGTERM');
    await new Promise((r) => node.child.once('exit', r));
  }

  // 2. the lean server on the same footage and a copy of the data folder
  const data = path.join(dir, 'lean-data');
  fs.rmSync(data, { recursive: true, force: true });
  fs.cpSync(path.join(dir, 'node', 'data'), data, { recursive: true, filter: (src) => !/[\\/](scrub|thumbnails|converter-temp|logs)$/.test(src) });
  const port = await freePort();
  const footage = path.join(dir, 'node', 'footage');
  const lean = spawn(bin, [], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: data, FOOTAGE_PATH: footage, VEHICLE_NAME: 'Contract Car', TZ: 'UTC', APP_ROOT: REPO }, stdio: ['ignore', 'ignore', 'inherit'] });
  const client = lib.createClient({ base: `http://127.0.0.1:${port}` });
  const report = { same: 0, different: 0, byRoute: {} };
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await client.request('GET', '/healthz')).status === 200) break; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    // what a server does by itself a minute after it starts (the startup
    // self-check, the first snapshot): done before comparing, as for the fixture
    await new Promise((r) => setTimeout(r, Number(arg('lean-settle', 65)) * 1000));
    const vehicles = lib.parseJson((await client.request('GET', '/api/vehicles')).body)?.vehicles || [];
    const folders = spec.folders({ vehicles: vehicles.map((v) => ({ id: v.id, root: v.root })), data });
    const index = JSON.parse(fs.readFileSync(path.join(goldens, 'index.json'), 'utf8'));
    for (const g of index.goldens) {
      const golden = JSON.parse(fs.readFileSync(path.join(goldens, g.file), 'utf8'));
      if (golden.method !== 'GET') continue;
      const s = spec.ROUTES[golden.route] || {};
      const res = await client.request('GET', lib.requestUrl(golden.request, folders), { headers: golden.request.headers || {} });
      const actual = lib.snapshot(res, s, { replace: folders, strings: [], now: Date.now() });
      const diffs = lib.diff(golden.response, actual);
      const r = (report.byRoute[golden.route] ||= { same: 0, different: 0, answers: [] });
      if (diffs.length) { report.different++; r.different++; r.answers.push({ label: g.label, diffs }); } else { report.same++; r.same++; }
    }
    deep.lean = await bodies(client);
  } finally {
    client.close();
    lean.kill('SIGTERM');
  }
  // GET /api/stats and /api/health field by field, where the answer does not
  // depend on the moment (both servers run on this machine)
  const deepDiffs = deepCompare(deep.node, deep.lean, { node: path.join(dir, 'node', 'data'), lean: data });
  fs.writeFileSync(path.join(dir, 'deep.json'), `${JSON.stringify({ ...deep, diffs: deepDiffs }, null, 2)}\n`);
  const r = (report.byRoute['GET /api/stats (fields)'] = { same: deepDiffs.stats.length ? 0 : 1, different: deepDiffs.stats.length ? 1 : 0, answers: deepDiffs.stats.length ? [{ label: '/api/stats', diffs: deepDiffs.stats }] : [] });
  const h = (report.byRoute['GET /api/health (checks)'] = { same: deepDiffs.health.length ? 0 : 1, different: deepDiffs.health.length ? 1 : 0, answers: deepDiffs.health.length ? [{ label: '/api/health', diffs: deepDiffs.health }] : [] });
  report.same += r.same + h.same;
  report.different += r.different + h.different;
  for (const [route, r] of Object.entries(report.byRoute).sort()) {
    if (!r.different) { console.log(`ok    ${route}${r.same > 1 ? ` (${r.same} answers)` : ''}`); continue; }
    console.log(`DIFF  ${route} (${r.different} of ${r.same + r.different} answers differ)`);
    for (const a of r.answers) {
      console.log(`      ${a.label}`);
      for (const d of a.diffs.slice(0, 12)) console.log(`        ${d.path}: golden ${lib.brief(d.golden)}, now ${lib.brief(d.actual)}`);
      if (a.diffs.length > 12) console.log(`        … ${a.diffs.length - 12} more`);
    }
  }
  console.log(`${report.different ? 'FAIL' : 'PASS'}: ${report.same} of ${report.same + report.different} answers the same.`);
  if (arg('json')) fs.writeFileSync(arg('json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

main().then((r) => process.exit(r.different ? 1 : 0), (err) => { console.error(err.stack || err.message); process.exit(2); });
