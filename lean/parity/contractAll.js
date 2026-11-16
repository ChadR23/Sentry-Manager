'use strict';

// The whole API contract, Node against lean: the Node fixture
// (tools/contract/fixture.js) and the lean server on their own copies of the
// same made-up archive, both with their own HTTPS and the same password;
// tools/contract/record.js records every GET route from Node plus one request
// for each other route (lean/parity/contractAllow.json: refusals and checks
// that are the same each time), tools/contract/compare.js replays them against
// lean. Prints, for all 189 routes, which answer the same, which differ and
// which are not compared, by area.
//
//   node lean/parity/contractAll.js [--dir /tmp/sm-all] [--settle 75] [--json out.json]
//
// Needs the lean binary (cargo build --release in lean/, or LEAN_BIN), node
// and ffmpeg. Passwords only go over HTTPS (127.0.0.1, each server's own CA).

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const net = require('net');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const fixture = require(path.join(REPO, 'tools', 'contract', 'fixture'));
const lib = require(path.join(REPO, 'tools', 'contract', 'lib'));
const { record } = require(path.join(REPO, 'tools', 'contract', 'record'));
const { compare } = require(path.join(REPO, 'tools', 'contract', 'compare'));
const { live } = require('./contractLive');
const LEAN = process.env.LEAN_BIN || path.join(REPO, 'lean', 'target', 'release', 'sentry-lean');
const PASSWORD = process.env.SM_CONTRACT_PASSWORD || 'contract fixture password';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; };

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const up = (base) => new Promise((resolve) => {
  const req = https.get(`${base}/healthz`, { rejectUnauthorized: false }, (res) => { res.resume(); resolve(res.statusCode === 200); });
  req.on('error', () => resolve(false));
  req.setTimeout(1000, () => { req.destroy(); resolve(false); });
});

async function startLean(dir, settleMs, env = {}) {
  await fixture.buildFootage(path.join(dir, 'footage'));
  const port = await freePort();
  const child = spawn(LEAN, [], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'),
      VEHICLE_NAME: 'Contract Car', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: PASSWORD, TZ: 'UTC', LOG_LEVEL: 'warn', TLS_MODE: 'auto',
      APP_ROOT: REPO, ...env
    },
    stdio: ['ignore', 'ignore', fs.openSync(path.join(dir, 'lean.log'), 'a')]
  });
  const base = `https://127.0.0.1:${port}`;
  for (let i = 0; i < 300 && !(await up(base)); i++) {
    if (child.exitCode !== null) throw new Error(`lean exited (${child.exitCode}), see ${dir}/lean.log`);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
  return { base, child };
}

const AREAS = [
  ['core', /^(GET|POST|PUT|PATCH|DELETE) \/(api\/(auth|accounts|security|logs|jobs|events)|healthz)/],
  ['converter', / \/api\/converter\//],
  ['nodes', / \/(api\/nodes|node\/v1)/],
  ['can', / \/api\/(can\/|sentryusb|vehicles\/:id\/sentry-usb)/],
  ['ops', / \/(metrics|api\/(notification|notifications|health|snapshots|metrics|stats|system|support-bundle|reports|settings\/power|vehicles\/:id\/savings-by-month|updates))/],
  ['ui', / \/api\/(ui-packs|exports|vehicles\/:id\/exports|dashboards|settings$|settings\/appearance)/],
  ['viewer', / \/api\/(telemetry|scrub|speeds|places|settings\/work-limits|studio|media|vehicles\/:id\/(speeds|moments|driving|event-map|drives|archive-gaps))/],
  ['footage', / \/api\/(vehicles|bin|stars)/]
];
// the owner's accepted differences (PORT_PLAN.md "Known differences"): route, the answer's
// field, why
const ACCEPTED = [
  ['GET /api/speeds/status', /^body\.readMode$/, 'readMode follows each server\'s own timing'],
  ['POST /api/speeds/index', /^body\.readMode$/, 'readMode follows each server\'s own timing'],
  ['GET /api/system', /^body\.nativeHelper$/, 'nativeHelper is true: renameat2 is called directly'],
  ['POST /api/nodes/worker/pair', /^body\.pairing\.code$/, 'a new random pairing code each time']
];
const areaOf = (key) => (AREAS.find(([, re]) => re.test(key)) || ['other'])[0];

(async () => {
  const dir = path.resolve(arg('dir', null) || fs.mkdtempSync(path.join(os.tmpdir(), 'sm-all-')));
  const settleMs = Number(arg('settle', 75)) * 1000;
  fs.mkdirSync(dir, { recursive: true });
  process.env.SM_CONTRACT_PASSWORD = PASSWORD;
  process.env.SM_PASSWORD = PASSWORD;
  // (one CAN Bridge device port for both: the live checks turn it on on one server at a time)
  const canPort = await freePort();
  const [nodeCan, leanCan] = [canPort, canPort];
  const [node, lean] = await Promise.all([
    fixture.start({ dir: path.join(dir, 'node'), settleMs, env: { CAN_PORT: String(nodeCan) } }),
    startLean(path.join(dir, 'lean'), settleMs, { CAN_PORT: String(leanCan) })
  ]);
  const stop = () => { for (const c of [node.child, lean.child]) if (c.exitCode === null) c.kill('SIGTERM'); };
  process.on('exit', stop);
  try {
    const goldens = path.join(dir, 'goldens');
    await record({ base: node.base, ca: path.join(dir, 'node', 'data', 'tls', 'ca.crt'), out: goldens, allow: path.join(__dirname, 'contractAllow.json') });
    const report = await compare({ base: lean.base, ca: path.join(dir, 'lean', 'data', 'tls', 'ca.crt'), goldens, 'allow-mutating': true, max: 4 });
    // the routes goldens cannot hold (live streams, tokens, random answers), asked of both now
    const nodeCa = path.join(dir, 'node', 'data', 'tls', 'ca.crt');
    const leanCa = path.join(dir, 'lean', 'data', 'tls', 'ca.crt');
    const now = await live({ node: { base: node.base, ca: nodeCa }, lean: { base: lean.base, ca: leanCa }, password: PASSWORD });
    if (arg('json')) fs.writeFileSync(`${arg('json')}.live.json`, JSON.stringify(now, null, 2));
    for (const [route, r] of Object.entries(now.byRoute)) {
      const into = (report.byRoute[route] ||= { same: 0, different: 0, answers: [] });
      into.same += r.same;
      into.different += r.different;
      into.answers.push(...r.answers);
      console.log(`${r.different ? 'DIFF ' : 'ok   '} ${route} (live: ${r.same + r.different} answers)`);
      for (const a of r.answers) {
        console.log(`      ${a.label}`);
        for (const d of a.diffs.slice(0, 6)) console.log(`        ${d.path}: node ${lib.brief(d.golden)}, lean ${lib.brief(d.actual)}`);
      }
    }
    // differences the owner accepted (PORT_PLAN.md "Known differences"): counted apart, so
    // that anything else still shows
    for (const [route, r] of Object.entries(report.byRoute)) {
      const left = [];
      for (const a of r.answers) {
        const rest = a.diffs.filter((d) => !ACCEPTED.some(([k, re]) => k === route && re.test(d.path)));
        if (rest.length) left.push({ ...a, diffs: rest });
        else { r.accepted = (r.accepted || 0) + 1; r.different--; r.same++; }
      }
      r.answers = left;
    }
    const contract = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'api-contract.json'), 'utf8'));
    const index = JSON.parse(fs.readFileSync(path.join(goldens, 'index.json'), 'utf8'));
    const rows = contract.routes.map((r) => {
      const key = `${r.method} ${r.path}`;
      const got = report.byRoute[key];
      const state = got ? (got.different ? 'different' : got.accepted ? 'accepted' : 'same') : 'not compared';
      return { key, area: areaOf(key), state, why: got ? undefined : index.routes[key]?.skipped || 'no request recorded', answers: got?.answers };
    });
    const count = (s) => rows.filter((r) => r.state === s).length;
    console.log(`\n${rows.length} routes: ${count('same')} answer the same, ${count('accepted')} the same but for an accepted difference, ${count('different')} differ, ${count('not compared')} not compared`);
    const by = {};
    for (const r of rows) ((by[r.area] ||= { same: 0, accepted: [], different: [], 'not compared': [] }), r.state === 'same' ? by[r.area].same++ : by[r.area][r.state].push(r.key));
    for (const [a, v] of Object.entries(by)) {
      console.log(`\n${a}: ${v.same} same, ${v.accepted.length} accepted, ${v.different.length} differ, ${v['not compared'].length} not compared`);
      for (const k of v.accepted) console.log(`  accepted difference: ${k} (${ACCEPTED.filter(([r]) => r === k).map(([, , why]) => why).join('; ')})`);
      for (const k of v.different) console.log(`  differs: ${k}`);
      for (const k of v['not compared']) console.log(`  not compared: ${k}`);
    }
    if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify({ rows, report }, null, 2));
  } finally {
    stop();
  }
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(2);
});
