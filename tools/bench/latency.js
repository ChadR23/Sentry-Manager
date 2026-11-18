#!/usr/bin/env node
'use strict';

// Signs in to a bench container over HTTPS and either times the pages' API
// calls or watches the first index.
//
//   node tools/bench/latency.js measure     --url https://localhost:9100 --ca <ca.crt> --env-file <run>/bench.env
//                                            --out <run dir> [--phase after-index] [--reps 10]
//   node tools/bench/latency.js watch-index --url ... --ca ... --env-file ... --out <run dir>
//                                            [--t0 <ISO start time>] [--interval 5] [--timeout-min 720]
//   node tools/bench/latency.js wait-ready  --url ... --ca ... --env-file ... [--timeout-min 5]
//   node tools/bench/latency.js routes      the routes it times, then stop
//
// The password is only sent over HTTPS, checked against the container's own
// certificate authority (<data>/tls/ca.crt, which run.sh copies out with
// docker exec): no plain HTTP and no turning certificate checks off. The
// certificate covers localhost and 127.0.0.1, so use https://localhost:<port>.
// The account is the one run.sh creates on first start (UI_USERNAME /
// UI_PASSWORD in <run>/bench.env, mode 600).
//
// Timed (each --reps times, after one untimed warm-up whose time is kept as rep 0):
//   footage-days    GET  /api/vehicles/:id/days?category=all&offset=0&limit=30   (Footage page)
//   footage-day     GET  /api/vehicles/:id/recordings?category=all&date=<day>&limit=500 (a day opened)
//   vehicles        GET  /api/vehicles
//   event-open      GET  /api/vehicles/:id/recordings/:rid  (newest Sentry/Saved event)
//   event-thumb     GET  /api/vehicles/:id/recordings/:rid/thumbnail
//   drives          GET  /api/vehicles/:id/driving?weeks=12  (Driving page)
//   encoder-status  POST /api/converter/invoke/getCurrent  (Encoder page)
//   speeds-status   GET  /api/speeds/status

const fs = require('fs');
const path = require('path');
const https = require('https');
const lib = require('./lib');

function args(argv) {
  const out = { mode: argv[0], reps: 10, interval: 5, timeoutMin: 720, phase: '' };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--url') out.url = val();
    else if (a === '--ca') out.ca = val();
    else if (a === '--env-file') out.envFile = val();
    else if (a === '--user') out.user = val();
    else if (a === '--password-file') out.passwordFile = val();
    else if (a === '--out') out.out = val();
    else if (a === '--phase') out.phase = val();
    else if (a === '--reps') out.reps = Number(val());
    else if (a === '--t0') out.t0 = val();
    else if (a === '--interval') out.interval = Number(val());
    else if (a === '--timeout-min') out.timeoutMin = Number(val());
    else throw new Error(`Unknown option ${a}`);
  }
  return out;
}

const ROUTES = [
  ['footage-days', 'GET', (c) => `/api/vehicles/${c.vid}/days?category=all&offset=0&limit=30`],
  ['footage-day', 'GET', (c) => (c.day ? `/api/vehicles/${c.vid}/recordings?category=all&date=${c.day}&limit=500` : null)],
  ['vehicles', 'GET', () => '/api/vehicles'],
  ['event-open', 'GET', (c) => (c.rid ? `/api/vehicles/${c.vid}/recordings/${c.rid}` : null)],
  ['event-thumb', 'GET', (c) => (c.rid ? `/api/vehicles/${c.vid}/recordings/${c.rid}/thumbnail` : null)],
  ['drives', 'GET', (c) => `/api/vehicles/${c.vid}/driving?weeks=12`],
  ['encoder-status', 'POST', () => '/api/converter/invoke/getCurrent'],
  ['speeds-status', 'GET', () => '/api/speeds/status']
];

function client(opt) {
  const base = lib.checkBaseUrl(opt.url);
  if (!base.ok) throw new Error(base.problem);
  if (!opt.ca) throw new Error('--ca <ca.crt> is needed (run.sh copies it to <run>/ca.crt)');
  const agent = new https.Agent({ ca: fs.readFileSync(opt.ca), keepAlive: true, maxSockets: 1 });
  let cookies = new Map();
  async function request(method, route, body) {
    const url = new URL(route, base.url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const started = process.hrtime.bigint();
    return new Promise((resolve, reject) => {
      const req = https.request(url, {
        method, agent,
        headers: {
          Accept: 'application/json',
          'X-Requested-With': 'sentry-six-manager',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...(cookies.size ? { Cookie: lib.cookieHeader([], cookies).header } : {})
        },
        timeout: 120_000
      }, (res) => {
        const ttfb = Number(process.hrtime.bigint() - started) / 1e6;
        cookies = lib.cookieHeader(res.headers['set-cookie'], cookies).jar;
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          let json = null;
          if (/json/.test(res.headers['content-type'] || '')) { try { json = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ } }
          resolve({ status: res.statusCode, ms, ttfb, bytes: buf.length, json });
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error(`${method} ${route}: timed out`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  async function login() {
    let user = opt.user;
    let password = opt.passwordFile ? fs.readFileSync(opt.passwordFile, 'utf8').trim() : null;
    if (opt.envFile) {
      const env = lib.parseEnvFile(fs.readFileSync(opt.envFile, 'utf8'));
      user ||= env.UI_USERNAME;
      password ||= env.UI_PASSWORD;
    }
    if (!user || !password) throw new Error('No account: give --env-file <run>/bench.env (or --user and --password-file)');
    const res = await request('POST', '/api/auth/login', { username: user, password });
    if (res.status !== 200) throw new Error(`Sign-in failed (${res.status}${res.json?.error ? `: ${res.json.error}` : ''})`);
    if (res.json?.twoFactor) throw new Error('This account has two-step sign-in; use the bench account run.sh made');
  }
  return { request, login, close: () => agent.destroy() };
}

async function context(c) {
  const v = (await c.request('GET', '/api/vehicles')).json?.vehicles?.[0];
  if (!v) throw new Error('No vehicle yet (FOOTAGE_PATH did not create one?)');
  const days = (await c.request('GET', `/api/vehicles/${v.id}/days?category=all&offset=0&limit=30`)).json?.days || [];
  const day = days[0]?.day || null;
  let rid = null;
  if (day) {
    const recs = (await c.request('GET', `/api/vehicles/${v.id}/recordings?category=all&date=${day}&limit=500`)).json?.recordings || [];
    let ev = lib.pickEvent(recs.filter((r) => r.category === 'Sentry' || r.category === 'Saved'));
    if (!ev) {
      // the newest day may have none: look through the recordings list
      const all = (await c.request('GET', `/api/vehicles/${v.id}/recordings?limit=500`)).json?.recordings || [];
      ev = lib.pickEvent(all);
    }
    rid = ev ? encodeURIComponent(ev.id) : null;
  }
  return { vid: encodeURIComponent(v.id), day, rid };
}

async function measure(opt) {
  const c = client(opt);
  await c.login();
  const ctx = await context(c);
  fs.mkdirSync(opt.out, { recursive: true });
  const file = path.join(opt.out, 'latency.csv');
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${lib.LATENCY_COLUMNS.join(',')}\n`);
  const out = fs.createWriteStream(file, { flags: 'a' });
  for (const [label, method, make] of ROUTES) {
    const route = make(ctx);
    if (!route) { console.log(`${label}: skipped (no ${label.startsWith('event') ? 'event' : 'day'} in the archive)`); continue; }
    const times = [];
    for (let rep = 0; rep <= opt.reps; rep++) {
      const r = await c.request(method, route, method === 'POST' ? {} : undefined).catch((err) => ({ status: 'error', ms: null, ttfb: null, bytes: 0, error: err.message }));
      // rep 0 is the first call (cold caches inside the app); report.js leaves it out
      out.write(lib.csvLine(lib.LATENCY_COLUMNS, {
        ts: new Date().toISOString(), phase: opt.phase, label: rep === 0 ? `${label} (first)` : label, method, route, rep,
        status: r.status, ms: r.ms === null ? '' : r.ms.toFixed(1), ttfb_ms: r.ttfb === null ? '' : r.ttfb.toFixed(1), bytes: r.bytes
      }));
      if (rep > 0 && r.ms !== null) times.push(r.ms);
    }
    console.log(`${label.padEnd(15)} median ${Math.round(lib.median(times) ?? NaN)} ms  p95 ${Math.round(lib.percentile(times, 95) ?? NaN)} ms  ${route}`);
  }
  await new Promise((r) => out.end(r));
  c.close();
}

async function watchIndex(opt) {
  const c = client(opt);
  await c.login();
  fs.mkdirSync(opt.out, { recursive: true });
  const file = path.join(opt.out, 'index.csv');
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${lib.INDEX_COLUMNS.join(',')}\n`);
  const t0 = opt.t0 ? Date.parse(opt.t0) : Date.now();
  const deadline = Date.now() + opt.timeoutMin * 60_000;
  let state = {};
  for (;;) {
    const at = Date.now();
    const [vehicles, speeds] = await Promise.all([
      c.request('GET', '/api/vehicles').then((r) => r.json).catch(() => null),
      c.request('GET', '/api/speeds/status').then((r) => r.json).catch(() => null)
    ]);
    const step = lib.indexStep(state, { at, t0, vehicles, speeds });
    state = step.state;
    fs.appendFileSync(file, lib.csvLine(lib.INDEX_COLUMNS, step.row));
    fs.writeFileSync(path.join(opt.out, 'index.json'), `${JSON.stringify({ ...step.summary, complete: step.done }, null, 2)}\n`);
    if (step.done) {
      console.log(`first index complete after ${lib.fmtSeconds(step.summary.indexDoneS)} (scan ${lib.fmtSeconds(step.summary.scanDoneS)}, ${step.summary.speedTotal ?? 0} clips speed-indexed)`);
      break;
    }
    if (Date.now() > deadline) { console.log('gave up waiting for the first index (--timeout-min)'); break; }
    await new Promise((r) => setTimeout(r, opt.interval * 1000));
  }
  c.close();
}

// /healthz over HTTPS (checked against the CA) and a working sign-in, retried
async function waitReady(opt) {
  const deadline = Date.now() + opt.timeoutMin * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const c = client(opt);
      const h = await c.request('GET', '/healthz');
      if (h.status === 200) {
        await c.login();
        c.close();
        console.log('ready');
        return;
      }
      last = `healthz ${h.status}`;
      c.close();
    } catch (err) {
      last = err.message;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`not ready in ${opt.timeoutMin} min (${last})`);
}

async function main() {
  const opt = args(process.argv.slice(2));
  if (opt.mode === 'wait-ready') return waitReady(opt);
  if (opt.mode === 'routes') {
    for (const [label, method, make] of ROUTES) console.log(`${label.padEnd(15)} ${method.padEnd(4)} ${make({ vid: ':id', day: '<day>', rid: ':rid' })}`);
    return;
  }
  if (!['measure', 'watch-index'].includes(opt.mode)) {
    console.log(lib.usage(__filename));
    process.exit(2);
  }
  if (!opt.out) throw new Error('--out <run dir> is needed');
  if (opt.mode === 'measure') await measure(opt);
  else await watchIndex(opt);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`latency.js: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { ROUTES };
