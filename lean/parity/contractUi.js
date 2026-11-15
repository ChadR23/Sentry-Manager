#!/usr/bin/env node
'use strict';

// The contract tools (tools/contract/) for the ui area's routes: record.js
// records goldens from the Node fixture server (HTTPS, signed in), then the
// goldens are replayed against the lean server the way compare.js does
// (lib.snapshot, lib.diff, spec.ROUTES). compare.js itself first asks
// /api/studio/context to learn the folders, which the lean server does not
// answer yet (the viewer area's), so the folders come from /api/vehicles here.
//
//   node lean/parity/contractUi.js [--keep DIR]

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const lib = require(path.join(REPO, 'tools/contract/lib.js'));
const spec = require(path.join(REPO, 'tools/contract/spec.js'));
const fixture = require(path.join(REPO, 'tools/contract/fixture.js'));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const ONLY = '^(GET|PUT|POST|DELETE) /api/(ui-packs|exports|settings(/appearance|/work-limits)?$|dashboards|vehicles/:id/exports)';
const PASSWORD = 'contract fixture password';

async function main() {
  const keep = arg('keep', null);
  const dir = keep ? path.resolve(keep) : await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-ui-contract-'));
  let node;
  let lean;
  try {
    node = await fixture.start({ dir: path.join(dir, 'node'), env: { DEFAULT_UI: '' } });
    // the changes replayed too (the same on both servers, in this order)
    const allow = path.join(dir, 'allow.json');
    fs.writeFileSync(allow, JSON.stringify([
      { method: 'PUT', path: '/api/settings/appearance', body: { clock24: true } },
      { method: 'PUT', path: '/api/dashboards', body: { active: 'b2', boards: [{ id: 'b1', name: 'Drive', blocks: [{ type: 'wide', signals: ['a', 'b', 'c', 'd'] }] }, { id: 'b2', name: ' Two\n', placement: 'float', float: { wide: { x: 2, y: 0.5 } }, blocks: [] }] } },
      { method: 'PUT', path: '/api/settings/work-limits', body: { speedIndex: 2 } },
      { method: 'PUT', path: '/api/ui-packs/active', body: { id: 'nope' } },
      { method: 'DELETE', path: '/api/ui-packs/aurora' },
      { method: 'POST', path: '/api/vehicles/contract-car/exports', body: { clips: [] } },
      { method: 'POST', path: '/api/exports', body: { clips: [{ key: '2024-05-01_08-00-00', files: { front: '/etc/passwd' }, from: 0, to: 2 }] } },
      { method: 'DELETE', path: '/api/exports/0000000000000000' }
    ]));
    const goldens = path.join(dir, 'goldens');
    const rec = spawnSync(process.execPath, [path.join(REPO, 'tools/contract/record.js'), '--base', node.base, '--insecure-self-signed', '--out', goldens, '--only', ONLY, '--allow', allow], { env: { ...process.env, SM_PASSWORD: PASSWORD }, encoding: 'utf8' });
    process.stdout.write(rec.stdout);
    if (rec.status !== 0) throw new Error(`record.js: ${rec.stderr}`);

    const leanDir = path.join(dir, 'lean');
    await fsp.mkdir(leanDir, { recursive: true });
    spawnSync('cp', ['-a', path.join(dir, 'node', 'footage'), path.join(leanDir, 'footage')]);
    const bin = [path.join(REPO, 'lean/target/release/sentry-lean'), path.join(REPO, 'lean/target/debug/sentry-lean')].find((f) => fs.existsSync(f));
    const port = 20000 + Math.floor(Math.random() * 20000);
    lean = spawn(bin, [], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(leanDir, 'data'), APP_ROOT: REPO, FOOTAGE_PATH: path.join(leanDir, 'footage'), VEHICLE_NAME: 'Contract Car', TZ: 'UTC', DEFAULT_UI: '', UI_PASSWORD: PASSWORD, RUN_DIR: path.join(leanDir, 'run'), LOG_LEVEL: 'warn' }, stdio: 'ignore' });
    // (core's HTTPS with its own certificate authority: the password only goes over it)
    const base = `https://127.0.0.1:${port}`;
    const up = () => new Promise((resolve) => {
      const req = require('https').get(`${base}/healthz`, { rejectUnauthorized: false }, (res) => { res.resume(); resolve(res.statusCode === 200); });
      req.on('error', () => resolve(false));
    });
    for (let i = 0; i < 100 && !(await up()); i++) await new Promise((r) => setTimeout(r, 100));
    process.env.SM_PASSWORD = PASSWORD;
    const client = await lib.connect({ base, ca: path.join(leanDir, 'data', 'tls', 'ca.crt') });
    const vehicles = lib.parseJson((await client.request('GET', '/api/vehicles')).body).vehicles;
    const folders = spec.folders({ vehicles: vehicles.map((v) => ({ id: v.id, root: v.root })), data: null });
    const index = JSON.parse(fs.readFileSync(path.join(goldens, 'index.json'), 'utf8'));
    let same = 0;
    let different = 0;
    // the GETs first (as recorded: on the fresh server), then the changes
    const order = [...index.goldens.filter((g) => !g.mutating), ...index.goldens.filter((g) => g.mutating)];
    for (const g of order) {
      const golden = JSON.parse(fs.readFileSync(path.join(goldens, g.file), 'utf8'));
      const s = golden.method === 'GET' ? spec.ROUTES[golden.route] || {} : {};
      const res = await client.request(golden.method, lib.requestUrl(golden.request, folders), { body: golden.body, headers: golden.request.headers || {} });
      const actual = lib.snapshot(res, s, { replace: folders, strings: [], now: Date.now() });
      const diffs = lib.diff(golden.response, actual);
      if (diffs.length) {
        different++;
        console.log(`DIFF  ${g.label}`);
        for (const d of diffs.slice(0, 8)) console.log(`        ${d.path}: golden ${lib.brief(d.golden)}, now ${lib.brief(d.actual)}`);
      } else {
        same++;
        console.log(`ok    ${g.label}`);
      }
    }
    client.close();
    console.log(`${different ? 'FAIL' : 'PASS'}: ${same} of ${same + different} recorded answers the same.`);
    return different;
  } finally {
    if (node) node.child.kill('SIGTERM');
    if (lean) lean.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (!keep) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

main().then((d) => process.exit(d ? 1 : 0), (err) => {
  console.error(err.stack || err.message);
  process.exit(2);
});
