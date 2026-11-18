'use strict';

// Every GET route of the contract, Node against lean, on a larger realistic
// archive (bigArchive.js: a few thousand clips, six cameras, Recent, Sentry
// and Saved clips with event.json and thumb.png) mounted read-only (a
// read-only bind mount: needs root), the converter idle. Both servers read the
// same mount (each with its own data folder, HTTPS and the same password);
// once both have scanned, read codecs and indexed speeds, record.js records
// every GET route from Node and compare.js replays them against lean.
//
//   node lean/parity/bigCompare.js [--dir /tmp/sm-big] [--clips 3000] [--json out.json]

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const lib = require(path.join(REPO, 'tools', 'contract', 'lib'));
const { record } = require(path.join(REPO, 'tools', 'contract', 'record'));
const { compare } = require(path.join(REPO, 'tools', 'contract', 'compare'));
const LEAN = process.env.LEAN_BIN || path.join(REPO, 'lean', 'target', 'release', 'sentry-lean');
const PASSWORD = 'big archive password';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; };
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = (base) => new Promise((resolve) => {
  const req = https.get(`${base}/healthz`, { rejectUnauthorized: false }, (res) => { res.resume(); resolve(res.statusCode === 200); });
  req.on('error', () => resolve(false));
  req.setTimeout(1000, () => { req.destroy(); resolve(false); });
});

async function start(kind, dir, footage) {
  fs.mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: footage, VEHICLE_NAME: 'Big Car',
    RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: PASSWORD, TZ: 'UTC', LOG_LEVEL: 'warn', TLS_MODE: 'auto', UPDATE_CHECK: 'off', APP_ROOT: REPO
  };
  const log = fs.openSync(path.join(dir, 'server.log'), 'a');
  const child = kind === 'node'
    ? spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(REPO, 'server', 'index.js')], { env, stdio: ['ignore', log, log] })
    : spawn(LEAN, [], { env, stdio: ['ignore', log, log] });
  const base = `https://127.0.0.1:${port}`;
  for (let i = 0; i < 600 && !(await up(base)); i++) await sleep(100);
  return { child, base, ca: path.join(dir, 'data', 'tls', 'ca.crt') };
}

/** Wait until the server has scanned and its speed index has read every front clip it will. */
async function settled(s, label) {
  const c = lib.createClient({ base: s.base, ca: s.ca });
  await c.login('admin', PASSWORD);
  const t0 = Date.now();
  let quiet = 0;
  while (quiet < 4 && Date.now() - t0 < 60 * 60_000) {
    const days = lib.parseJson((await c.request('GET', '/api/vehicles/big-car/days?limit=1')).body);
    const st = lib.parseJson((await c.request('GET', '/api/speeds/status')).body);
    const done = days && days.scannedAt && !days.scanning && st && !st.running && st.done >= st.total;
    quiet = done ? quiet + 1 : 0;
    await sleep(2000);
  }
  console.log(`${label}: settled in ${Math.round((Date.now() - t0) / 1000)} s`);
  c.close();
}

(async () => {
  const dir = path.resolve(arg('dir', null) || fs.mkdtempSync(path.join(os.tmpdir(), 'sm-big-')));
  const src = path.join(dir, 'archive');
  const ro = path.join(dir, 'footage-ro');
  if (!fs.existsSync(path.join(src, 'TeslaCam'))) execFileSync(process.execPath, [path.join(__dirname, 'bigArchive.js'), src, '--clips', String(arg('clips', 3000))], { stdio: 'inherit' });
  fs.mkdirSync(ro, { recursive: true });
  execFileSync('mount', ['--bind', src, ro]);
  const servers = [];
  try {
    execFileSync('mount', ['-o', 'remount,bind,ro', ro]);
    const node = await start('node', path.join(dir, 'node'), ro);
    servers.push(node);
    const lean = await start('lean', path.join(dir, 'lean'), ro);
    servers.push(lean);
    await Promise.all([settled(node, 'node'), settled(lean, 'lean')]);
    // a second scan on both: the archive gap check after it sees the speed index's work (the
    // first one ran right after the first scan, while the index was still reading)
    for (const s of [node, lean]) {
      const c = lib.createClient({ base: s.base, ca: s.ca });
      await c.login('admin', PASSWORD);
      await c.request('POST', '/api/vehicles/big-car/scan', { body: {} });
      c.close();
    }
    await Promise.all([settled(node, 'node'), settled(lean, 'lean')]);
    // (both check the archive gaps after their scans; a little more for the last of it)
    await sleep(15_000);
    process.env.SM_BIG_PASSWORD = PASSWORD;
    const goldens = path.join(dir, 'goldens');
    await record({ base: node.base, ca: node.ca, out: goldens, 'password-env': 'SM_BIG_PASSWORD' });
    const report = await compare({ base: lean.base, ca: lean.ca, goldens, 'password-env': 'SM_BIG_PASSWORD', max: 6 });
    if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(report, null, 2));
    const routes = Object.entries(report.byRoute);
    console.log(`\n${report.same + report.different} answers from ${routes.length} GET routes: ${report.same} the same, ${report.different} differ (${routes.filter(([, r]) => r.different).map(([k]) => k).join(', ') || 'none'})`);
  } finally {
    for (const s of servers) if (s.child.exitCode === null) s.child.kill('SIGTERM');
    await sleep(2000);
    try { execFileSync('umount', [ro]); } catch (err) { console.error(`umount ${ro}: ${err.message}`); }
  }
})().catch((err) => { console.error(err.stack || err.message); process.exit(2); });
