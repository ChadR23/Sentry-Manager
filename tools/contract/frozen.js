#!/usr/bin/env node
'use strict';

// The whole API contract against the Node server's frozen answers: the Rust
// server on the contract's fixture archive (lean/tests/fixtures/contract/
// footage.tar.xz) with its own HTTPS and a password, then
//   - every recorded answer replayed (goldens/: every GET route of
//     docs/api-contract.json the way spec.js asks it, and one request for each
//     other route from allow.json), compared by compare.js;
//   - the live checks (live.js: the event streams, a real conversion, tokens,
//     pairing, random answers) compared with what the Node server answered
//     (live.json);
//   - the 196 routes of the contract: none may differ (but for the owner's
//     accepted differences, lean/PORT_PLAN.md "Known differences"), and every
//     route compared when the answers were frozen (routes.json) still is.
// Exits 0 when everything answers the same, 1 when anything differs, 2 when it
// cannot run.
//
//   node tools/contract/frozen.js [--bin lean/target/release/sentry-lean] [--dir DIR] [--settle 75] [--keep] [--json out.json]
//   node tools/contract/frozen.js --base https://127.0.0.1:PORT --ca DATA/tls/ca.crt
//        [--settle 75] [--other-machine] (a server started elsewhere, e.g. the image, on the
//         unpacked fixture archive: --unpack DIR unpacks it, prints the
//         environment the server needs, and exits)
//
// Plain Node (22 or newer), no packages; needs tar with xz. The Node answers
// were recorded on 2026-11-19 from the Node server (tools/contract/fixture.js
// over server/index.js, both since removed); lean/PORT_PLAN.md says how.
// Passwords only go over HTTPS (127.0.0.1, the server's own CA).

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const FROZEN = path.join(REPO, 'lean', 'tests', 'fixtures', 'contract');
const lib = require('./lib');
const { compare } = require('./compare');
const { script, compareLive } = require('./live');
const PASSWORD = process.env.SM_CONTRACT_PASSWORD || 'contract fixture password';

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; };
const flag = (name) => process.argv.includes(`--${name}`);

// the owner's accepted differences (PORT_PLAN.md "Known differences"): route, the answer's
// field, why
const ACCEPTED = [
  ['GET /api/speeds/status', /^body\.readMode$/, 'readMode follows each server\'s own timing'],
  ['POST /api/speeds/index', /^body\.readMode$/, 'readMode follows each server\'s own timing'],
  ['GET /api/system', /^body\.nativeHelper$/, 'nativeHelper is true: renameat2 is called directly'],
  ['POST /api/nodes/worker/pair', /^body\.pairing\.code$/, 'a new random pairing code each time']
];

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
/**
 * What belongs to the machine the answers come from, not to the server: taken
 * out of both the frozen answer and this one before they are compared. The
 * disk's free space (its figures, and the low-space check, banner and
 * notification it raises on a nearly full disk: the answers were recorded on
 * one), the ffmpeg build, and with --other-machine (the image: the answers
 * were recorded from a server run by hand as root, on loopback, from a
 * checkout) what the container changes: the "Share set-up" note about an
 * unmounted share, the share's mount and file system, who the app runs as
 * (uid 1000 under the supervisor), the client's address (Docker's gateway)
 * and the build's branch and time.
 */
const CONTAINER_KEYS = [
  ['mounted', ['mounted', 'fsType', 'source', 'renameOverwrite', 'warning']], // a share's status (its note about an unmounted share)
  ['builtAt', ['branch', 'builtAt', 'image', 'sha', 'tag']], // the build (BUILD_INFO.json)
  ['runningAsRoot', ['runningAsRoot', 'supervised', 'uid']], // who the app runs as
  ['banKey', ['address', 'banKey']], // the client's address
  ['lastSeenAt', ['address']] // a main's address, as the worker saw it
];
const containerDrop = (o) => new Set(CONTAINER_KEYS.filter(([has]) => has in o).flatMap(([, keys]) => keys));
function machine(v, route, other = flag('other-machine')) {
  const space = (x) => x && typeof x === 'object' && (/^space-/.test(x.id || '') || /^(health:space-|space:)/.test(x.dedupeKey || '') || /Free space on the share/.test(`${x.label || ''} ${x.title || ''}`) || (other && /^warning-/.test(x.id || '')));
  if (typeof v === 'string') {
    return v.replace(/\d+(\.\d+)? [KMGT]?B free( of \d+(\.\d+)? [KMGT]?B)?/g, '<space> free').replace(/\b(ffmpeg|ffprobe) version \S+/g, '$1 version <version>');
  }
  if (Array.isArray(v)) return v.filter((x) => !space(x)).map((x) => machine(x, route, other));
  if (v && typeof v === 'object') {
    const drop = other ? containerDrop(v) : new Set();
    return Object.fromEntries(Object.entries(v).filter(([k]) => !drop.has(k)).map(([k, x]) => [k, machine(x, route, other)]));
  }
  return v;
}

const areaOf = (key) => (AREAS.find(([, re]) => re.test(key)) || ['other'])[0];

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const up = (base) => new Promise((resolve) => {
  // (the health check alone skips verification: it sends no password)
  const req = https.get(`${base}/healthz`, { rejectUnauthorized: false }, (res) => { res.resume(); resolve(res.statusCode === 200); });
  req.on('error', () => resolve(false));
  req.setTimeout(1000, () => { req.destroy(); resolve(false); });
});

/** The fixture archive, unpacked (its file times kept) into <dir>. */
function unpack(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync('tar', ['-xJf', path.join(FROZEN, 'footage.tar.xz'), '-C', dir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('unpacking footage.tar.xz failed (tar with xz is needed)');
}

/** The CAN Bridge device port the answers were recorded with (CAN_PORT; GET /api/can/settings shows it). */
function canPort() {
  const g = fs.readdirSync(path.join(FROZEN, 'goldens')).find((f) => /^api_can_settings\./.test(f));
  return JSON.parse(fs.readFileSync(path.join(FROZEN, 'goldens', g), 'utf8')).response.body.port.port;
}

async function startLean(bin, dir, settleMs) {
  unpack(path.join(dir, 'footage'));
  const port = await freePort();
  const child = spawn(bin, [], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'),
      VEHICLE_NAME: 'Contract Car', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: PASSWORD, TZ: 'UTC', LOG_LEVEL: 'warn', TLS_MODE: 'auto',
      CAN_PORT: String(canPort()), APP_ROOT: REPO
    },
    stdio: ['ignore', 'ignore', fs.openSync(path.join(dir, 'lean.log'), 'a')]
  });
  const base = `https://127.0.0.1:${port}`;
  for (let i = 0; i < 300 && !(await up(base)); i++) {
    if (child.exitCode !== null) throw new Error(`the server exited (${child.exitCode}), see ${dir}/lean.log`);
    await new Promise((r) => setTimeout(r, 100));
  }
  // what a server does by itself a minute after it starts (the health
  // self-check, the first database snapshot, the CAN index pass) is done
  // before anything is compared, as it was when the answers were recorded
  if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
  return { base, ca: path.join(dir, 'data', 'tls', 'ca.crt'), child };
}

async function main() {
  if (arg('unpack')) {
    unpack(path.resolve(arg('unpack')));
    // what a server started elsewhere needs to answer as the recorded one
    console.log(JSON.stringify({ footage: path.resolve(arg('unpack')), env: { VEHICLE_NAME: 'Contract Car', TZ: 'UTC', CAN_PORT: String(canPort()), UI_PASSWORD: '<SM_CONTRACT_PASSWORD>' } }));
    return 0;
  }
  const dir = path.resolve(arg('dir', null) || fs.mkdtempSync(path.join(os.tmpdir(), 'sm-frozen-')));
  fs.mkdirSync(dir, { recursive: true });
  process.env.SM_PASSWORD = PASSWORD;
  let server;
  if (arg('base')) {
    server = { base: arg('base'), ca: path.resolve(arg('ca')), child: null };
    if (!server.base.startsWith('https://')) throw new Error('--base must be https:// (a password is sent)');
    // (--settle N: the seconds the server still needs to settle, counted from now)
    if (arg('settle')) await new Promise((r) => setTimeout(r, Number(arg('settle')) * 1000));
  } else {
    const bin = path.resolve(arg('bin', process.env.LEAN_BIN || path.join(REPO, 'lean', 'target', 'release', 'sentry-lean')));
    server = await startLean(bin, dir, Number(arg('settle', 75)) * 1000);
  }
  const stop = () => { if (server.child && server.child.exitCode === null) server.child.kill('SIGTERM'); };
  process.on('exit', stop);
  try {
    const goldens = path.join(FROZEN, 'goldens');
    const report = await compare({ base: server.base, ca: server.ca, goldens, 'allow-mutating': true, max: 4, machine, 'no-verdict': true });
    // the routes goldens cannot hold (live streams, tokens, random answers)
    const frozenLive = JSON.parse(fs.readFileSync(path.join(FROZEN, 'live.json'), 'utf8'));
    const now = await script(server, PASSWORD);
    if (arg('json')) fs.writeFileSync(`${arg('json')}.live.json`, JSON.stringify(now, null, 2));
    const live = compareLive(frozenLive.answers, now, machine);
    for (const [route, r] of Object.entries(live.byRoute)) {
      const into = (report.byRoute[route] ||= { same: 0, different: 0, answers: [] });
      into.same += r.same;
      into.different += r.different;
      into.answers.push(...r.answers);
      console.log(`${r.different ? 'DIFF ' : 'ok   '} ${route} (live: ${r.same + r.different} answers)`);
      for (const a of r.answers) {
        console.log(`      ${a.label}`);
        for (const d of a.diffs.slice(0, 6)) console.log(`        ${d.path}: node ${lib.brief(d.golden)}, now ${lib.brief(d.actual)}`);
      }
    }
    // differences the owner accepted: counted apart, so that anything else still shows
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
    // every route compared when the answers were frozen still is
    const was = JSON.parse(fs.readFileSync(path.join(FROZEN, 'routes.json'), 'utf8')).routes;
    const lost = rows.filter((r) => r.state === 'not compared' && was[r.key] && was[r.key] !== 'not compared').map((r) => r.key);
    const gone = Object.keys(was).filter((k) => !rows.some((r) => r.key === k));
    for (const k of lost) console.log(`  no longer compared: ${k}`);
    for (const k of gone) console.log(`  not in docs/api-contract.json any more: ${k}`);
    if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify({ rows, report }, null, 2));
    const failed = count('different') + lost.length + gone.length;
    console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${failed ? `${count('different')} routes differ, ${lost.length + gone.length} no longer compared` : 'every compared route answers as the Node server did'}`);
    return failed ? 1 : 0;
  } finally {
    stop();
    if (!flag('keep') && !arg('dir') && !arg('base')) fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err.stack || err.message);
    process.exit(2);
  });
}

module.exports = { ACCEPTED, AREAS, areaOf, unpack };
