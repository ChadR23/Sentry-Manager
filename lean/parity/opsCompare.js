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

async function main() {
  const dir = path.resolve(arg('dir', path.join(require('os').tmpdir(), 'sm-ops-compare')));
  const bin = path.resolve(arg('bin', path.join(REPO, 'lean/target/debug/sentry-lean')));
  const goldens = path.join(dir, 'goldens');
  fs.mkdirSync(dir, { recursive: true });

  // 1. the Node fixture, settled (the startup self-check and the first snapshot have run)
  const node = await fixture.start({ dir: path.join(dir, 'node'), settleMs: Number(arg('settle', 75)) * 1000 });
  process.env.SM_PASSWORD = process.env.SM_CONTRACT_PASSWORD || 'contract fixture password';
  try {
    await record({ base: node.base, ca: path.join(node.ca, 'ca.crt'), out: goldens, only: OPS.source });
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
  } finally {
    client.close();
    lean.kill('SIGTERM');
  }
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
