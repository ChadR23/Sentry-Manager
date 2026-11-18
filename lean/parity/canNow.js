'use strict';

// Live CAN stats for a Stream Deck, Node against lean: both servers on the
// same footage archive and the same CAN Bridge logs (lean/parity/canFixtures.js,
// its CAR1 drive made "now", so its logs are the fresh ones the index takes
// first), each with its own HTTPS and the same password. Compared: the Stream
// Deck link (GET/POST/DELETE /api/can/stream-deck, the pin against each server's
// own certificate authority, the plugin's files), GET /api/can/now with every
// stat, units, car, Bearer and ?token=, the errors and their headers, the
// certificate for the pin, and the live readings while a CAN Bridge upload
// arrives (a fresh log uploaded to both: their answers once it is indexed).
// The server's own clock (ageSec) is compared to within a few seconds; the
// data's own times (at) exactly.
//
//   node lean/parity/canNow.js [--keep]
//
// Needs the lean binary (cargo build --release in lean/, or LEAN_BIN), xz.
// Exit 0 when every answer matches, 1 with the differences listed.

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const lib = require(path.join(REPO, 'tools', 'contract', 'lib'));
const { readZip } = require(path.join(REPO, 'server', 'zip'));
const LEAN = process.env.LEAN_BIN || path.join(REPO, 'lean', 'target', 'release', 'sentry-lean');
const PASSWORD = 'correct horse battery';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function start(kind, work, footage) {
  const port = await freePort();
  const data = path.join(work, `${kind}-data`);
  fs.mkdirSync(data, { recursive: true });
  fs.cpSync(path.join(work, 'fx', 'can'), path.join(data, 'can'), { recursive: true, preserveTimestamps: true });
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: data, FOOTAGE_PATH: footage, VEHICLE_NAME: 'Daily Driver', TZ: 'UTC', APP_ROOT: REPO,
    RUN_DIR: path.join(work, `${kind}-run`), UI_PASSWORD: PASSWORD, LOG_LEVEL: 'warn', TLS_MODE: 'auto', CAN_PORT: String(await freePort()), UPDATE_CHECK: 'off', REPORTS: 'off'
  };
  const child = kind === 'node'
    ? spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(REPO, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(LEAN, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });
  const base = `https://127.0.0.1:${port}`;
  const ca = path.join(data, 'tls', 'ca.crt');
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error(`${kind} exited: ${log}`);
    if (fs.existsSync(ca)) {
      const ok = await new Promise((resolve) => {
        const req = https.get(`${base}/healthz`, { ca: fs.readFileSync(ca) }, (res) => { res.resume(); resolve(res.statusCode === 200); });
        req.on('error', () => resolve(false));
      });
      if (ok) break;
    }
    await sleep(100);
  }
  const c = lib.createClient({ base, ca });
  await c.login('admin', PASSWORD);
  /** a request with no cookie (as a Stream Deck asks) */
  const bare = (method, p, headers = {}, body = null) => new Promise((resolve) => {
    const req = https.request(new URL(p, base), { method, ca: fs.readFileSync(ca), headers: { 'Accept-Encoding': 'identity', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (x) => chunks.push(x));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', (err) => resolve({ status: 0, headers: {}, body: Buffer.from(String(err.code || err.message)) }));
    if (body) req.write(body);
    req.end();
  });
  return { kind, base, ca, data, child, c, bare, log: () => log, stop: () => new Promise((r) => { if (child.exitCode !== null) return r(); child.once('exit', r); child.kill('SIGTERM'); }) };
}

const diffs = [];
let checked = 0;
function compare(where, a, b) {
  const t = (x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x);
  if (t(a) !== t(b)) return diffs.push(`${where}: node ${JSON.stringify(a)?.slice(0, 300)} / lean ${JSON.stringify(b)?.slice(0, 300)}`);
  if (t(a) === 'array') {
    if (a.length !== b.length) diffs.push(`${where}: node has ${a.length} items, lean ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) compare(`${where}[${i}]`, a[i], b[i]);
  } else if (t(a) === 'object') {
    const [ka, kb] = [Object.keys(a), Object.keys(b)];
    if (ka.join() !== kb.join() && ka.length === kb.length && ka.every((k) => k in b)) diffs.push(`${where}: key order node ${ka.join()} / lean ${kb.join()}`);
    for (const k of new Set([...ka, ...kb])) {
      if (!(k in a)) diffs.push(`${where}.${k}: only lean has it`);
      else if (!(k in b)) diffs.push(`${where}.${k}: only node has it`);
      else compare(`${where}.${k}`, a[k], b[k]);
    }
  } else if (a !== b) diffs.push(`${where}: node ${JSON.stringify(a)?.slice(0, 300)} / lean ${JSON.stringify(b)?.slice(0, 300)}`);
  return undefined;
}

const HEADERS = ['content-type', 'cache-control', 'access-control-allow-origin', 'content-encoding', 'vary', 'content-disposition'];
/** An answer as compared: status, the headers that matter, the body (JSON, or text); ageSec apart. */
function view(res) {
  let raw = res.body;
  if (res.headers['content-encoding'] === 'gzip') raw = zlib.gunzipSync(raw);
  const text = raw.toString('utf8');
  let body = text;
  try { body = JSON.parse(text); } catch { /* text */ }
  let age = null;
  if (body && typeof body === 'object' && 'ageSec' in body) { age = body.ageSec; body = { ...body, ageSec: '<seconds>' }; }
  return { status: res.status, headers: Object.fromEntries(HEADERS.map((h) => [h, res.headers[h] ?? null])), body, age };
}
function same(label, a, b) {
  checked++;
  const [x, y] = [view(a), view(b)];
  compare(label, { status: x.status, headers: x.headers, body: x.body }, { status: y.status, headers: y.headers, body: y.body });
  if ((x.age === null) !== (y.age === null) || (x.age !== null && Math.abs(x.age - y.age) > 5)) diffs.push(`${label}: ageSec node ${x.age} / lean ${y.age}`);
  return [x.body, y.body];
}

// ---- a fresh CAN Bridge log (as canFixtures.js writes them): speed, gear, the pack's volts and amps
const hex2 = (n) => (n & 0xff).toString(16).padStart(2, '0').toUpperCase();
function put(b, start, len, raw) {
  for (let i = 0; i < len; i++) { const bit = start + i; if (Math.floor(raw / 2 ** i) % 2) b[bit >> 3] |= 1 << (bit & 7); }
}
const line = (us, bus, id, b) => `(${Math.floor(us / 1e6)}.${String(us % 1e6).padStart(6, '0')}) ${bus} ${id}#${b.map(hex2).join('')}`;
function freshLog(t0, secs) {
  const lines = ['# canbridge v1 app=parity', `# clock wall=${(t0 / 1000).toFixed(6)} mono_ns=1`];
  for (let ms = 0; ms < secs * 1000; ms += 100) {
    const us = (t0 + ms) * 1000;
    let b = [0, 0, 0, 0, 0, 0, 0, 0];
    put(b, 12, 12, Math.round((88.5 + 40) / 0.08));
    lines.push(line(us, 'can0', '257', b));
    b = [0, 0, 0, 0, 0, 0, 0, 0];
    put(b, 21, 3, 4);
    lines.push(line(us + 1, 'can0', '118', b));
    b = [0, 0, 0, 0, 0, 0, 0, 0];
    put(b, 0, 16, Math.round(391.27 / 0.01));
    put(b, 16, 16, (65536 - 123) % 65536);
    lines.push(line(us + 2, 'can0', '132', b));
  }
  return execFileSync('xz', ['-1', '-c'], { input: `${lines.join('\n')}\n` });
}
const stampOf = (ms) => `${new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;

async function upload(s, token, name, data) {
  const sha = crypto.createHash('sha256').update(data).digest('hex');
  const r = await s.bare('POST', `/api/can/logs/${encodeURIComponent(name)}`, {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Content-Length': data.length,
    'Upload-Offset': '0', 'Upload-Length': String(data.length), 'Upload-SHA256': sha
  }, data);
  return { status: r.status, body: lib.parseJson(r.body) };
}

async function settled(s, want) {
  for (let i = 0; i < 900; i++) {
    const st = lib.parseJson((await s.c.request('GET', '/api/can/settings')).body);
    if (st?.index && !st.index.running && st.index.indexed >= want && st.trust.every((t) => t.counts.waiting === 0)) return st;
    await sleep(300);
  }
  throw new Error(`${s.kind} did not index the CAN logs:\n${s.log().slice(-3000)}`);
}

async function main() {
  if (!fs.existsSync(LEAN)) { console.error(`No lean binary at ${LEAN} (cargo build --release in lean/)`); process.exit(2); }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-cannow-'));
  const footage = path.join(work, 'footage');
  if (spawnSync(process.execPath, [path.join(__dirname, 'makeArchive.js'), footage], { stdio: 'inherit' }).status !== 0) process.exit(2);
  // the CAR1 drive twelve minutes ago: its logs are fresh (the index takes them first, newest
  // first) and its newest value more than 5 minutes old (stale)
  const t0 = Math.floor(Date.now() / 60_000) * 60_000 - 12 * 60_000;
  if (spawnSync(process.execPath, [path.join(__dirname, 'canFixtures.js'), path.join(work, 'fx')], { stdio: 'inherit', env: { ...process.env, CAN_T0: new Date(t0).toISOString() } }).status !== 0) process.exit(2);
  for (const key of fs.readdirSync(path.join(work, 'fx', 'can'))) {
    for (const f of fs.readdirSync(path.join(work, 'fx', 'can', key))) {
      const side = path.join(work, 'fx', 'can', key, `${f}.json`);
      if (f.endsWith('.log.xz') && !fs.existsSync(side)) fs.writeFileSync(side, JSON.stringify({ format: 'canbridge-candump-xz/1', frames: 100, closed_because: 'stop' }));
    }
  }
  const [node, lean] = await Promise.all([start('node', work, footage), start('lean', work, footage)]);
  const both = (fn) => Promise.all([fn(node), fn(lean)]);
  try {
    // off: no link yet
    same('GET /api/can/now (off)', ...(await both((s) => s.bare('GET', '/api/can/now?token=x'))));
    same('GET /api/can/now/ca.crt (off)', ...(await both((s) => s.bare('GET', '/api/can/now/ca.crt'))));
    same('GET /api/can/stream-deck/plugin (no session)', ...(await both((s) => s.bare('GET', '/api/can/stream-deck/plugin'))));
    const deck = (s, method) => s.c.request(method, '/api/can/stream-deck', method === 'GET' ? {} : { body: {} });
    const pinOf = (s, res) => {
      const body = lib.parseJson(res.body);
      const want = `ca:${new crypto.X509Certificate(fs.readFileSync(s.ca)).fingerprint256.replace(/:/g, '').toLowerCase()}`;
      if (body?.pin !== want) diffs.push(`${s.kind}: pin ${body?.pin} is not its own certificate authority's ${want}`);
      return { status: res.status, headers: res.headers, body: Buffer.from(JSON.stringify({ ...body, pin: '<pin>', at: body?.at ? '<time>' : body?.at, token: body?.token ? '<token>' : body?.token })) };
    };
    {
      const [a, b] = await both((s) => deck(s, 'GET'));
      same('GET /api/can/stream-deck (off)', pinOf(node, a), pinOf(lean, b));
    }
    const made = await both((s) => deck(s, 'POST'));
    same('POST /api/can/stream-deck', pinOf(node, made[0]), pinOf(lean, made[1]));
    for (const [s, r] of [[node, made[0]], [lean, made[1]]]) s.token = lib.parseJson(r.body).token;
    for (const s of [node, lean]) if (!/^[A-Za-z0-9_-]{32}$/.test(s.token)) diffs.push(`${s.kind}: token ${s.token}`);
    {
      const [a, b] = await both((s) => deck(s, 'GET'));
      same('GET /api/can/stream-deck (on)', pinOf(node, a), pinOf(lean, b));
    }
    // the certificate for the pin: each server's own, as the pin says
    {
      const [a, b] = await both((s) => s.bare('GET', '/api/can/now/ca.crt'));
      same('GET /api/can/now/ca.crt', { ...a, body: Buffer.from('<pem>') }, { ...b, body: Buffer.from('<pem>') });
      for (const [s, r] of [[node, a], [lean, b]]) if (!r.body.equals(fs.readFileSync(s.ca))) diffs.push(`${s.kind}: /api/can/now/ca.crt is not DATA/tls/ca.crt`);
    }
    // the plugin: the same files, in the same order, with the same bytes
    {
      const [a, b] = await both((s) => s.c.request('GET', '/api/can/stream-deck/plugin'));
      same('GET /api/can/stream-deck/plugin', { ...a, body: Buffer.from('<zip>') }, { ...b, body: Buffer.from('<zip>') });
      const [x, y] = [readZip(a.body), readZip(b.body)];
      compare('plugin files', x.map((e) => e.name), y.map((e) => e.name));
      for (let i = 0; i < Math.min(x.length, y.length); i++) if (!x[i].data.equals(y[i].data)) diffs.push(`plugin ${x[i].name}: the bytes differ`);
      if (Number(a.headers['content-length']) !== a.body.length || Number(b.headers['content-length']) !== b.body.length) diffs.push('plugin: Content-Length is not the size');
    }
    // the Nerd panel's script and the plugin's own files, served as they are
    for (const p of ['/web/nerd.js', '/assets/streamdeck/com.sentrysix.canstats.sdPlugin/manifest.json', '/assets/streamdeck/com.sentrysix.canstats.sdPlugin/bin/plugin.js', '/assets/streamdeck/com.sentrysix.canstats.sdPlugin/images/key@2x.png']) {
      same(`GET ${p}`, ...(await both((s) => s.c.request('GET', p))));
    }
    // the token: none, wrong, ?token=, Bearer
    const ask = (p, headers = {}) => both((s) => s.bare('GET', p.replace('<tok>', encodeURIComponent(s.token)), typeof headers === 'function' ? headers(s) : headers));
    same('GET /api/can/now (no token)', ...(await ask('/api/can/now')));
    same('GET /api/can/now (wrong token)', ...(await ask('/api/can/now?token=wrong')));
    same('GET /api/can/now (wrong Bearer)', ...(await ask('/api/can/now', { Authorization: 'Bearer wrong' })));
    same('GET /api/can/now (Bearer)', ...(await ask('/api/can/now/battery', (s) => ({ Authorization: `bearer  ${s.token}` }))));
    same('POST /api/can/now', ...(await both((s) => s.bare('POST', `/api/can/now?token=${encodeURIComponent(s.token)}`))));
    same('HEAD /api/can/now', ...(await both((s) => s.bare('HEAD', `/api/can/now?token=${encodeURIComponent(s.token)}`))));
    same('GET /api/can/now/%E0 (bad encoding)', ...(await ask('/api/can/now/%E0?token=<tok>')));

    // the fixtures indexed (CAR1's fresh logs first): every stat of every car, both units
    await Promise.all([settled(node, 10), settled(lean, 10)]);
    await sleep(3200); // (past the answers worked out before the index was done)
    const cars = ['', 'CAR1', 'k2', 'K3', 'LEGACY', 'Daily Driver', 'daily-driver', ' car1 ', 'nope'];
    const stats = JSON.parse(made[0].body.toString()).stats.map((x) => x.id);
    for (const car of cars) {
      for (const units of ['', 'mi', 'km', 'KM']) {
        const q = `token=<tok>${car ? `&car=${encodeURIComponent(car)}` : ''}${units ? `&units=${units}` : ''}`;
        const [x] = same(`GET /api/can/now?${q}`, ...(await ask(`/api/can/now?${q}`)));
        if (!units) console.log(`car "${car}": ${x?.car ?? '-'} at ${x?.at}, ${Object.keys(x?.stats || {}).length} stats (${Object.values(x?.stats || {}).map((v) => v.text).join(', ')})`);
        same(`GET /api/can/now?${q} (gzip)`, ...(await ask(`/api/can/now?${q}`, { 'Accept-Encoding': 'gzip' })));
      }
      for (const st of [...stats, 'nope', 'ca.crt.txt']) same(`GET /api/can/now/${st}?car=${car}`, ...(await ask(`/api/can/now/${st}?token=<tok>&car=${encodeURIComponent(car)}&units=km`)));
    }
    same('GET /api/can/now/battery.txt', ...(await ask('/api/can/now/battery.txt?token=<tok>&car=k2')));
    same('GET /api/can/now?stat=gear', ...(await ask('/api/can/now?token=<tok>&car=CAR1&stat=gear')));
    same('GET /api/can/now/?stat=gear', ...(await ask('/api/can/now/?token=<tok>&car=CAR1&stat=gear')));
    same('GET /api/can/now/%62attery', ...(await ask('/api/can/now/%62attery?token=<tok>&car=k2')));
    same('GET /api/can/now?token+units', ...(await ask('/api/can/now?units=km&token=<tok>&car=k2&units=mi')));

    // while uploads arrive: a fresh log of CAR1 uploaded to both, then read back live
    await both((s) => s.c.request('POST', '/api/auth/confirm', { body: { password: PASSWORD } }));
    const enabled = await both((s) => s.c.request('POST', '/api/can/enable', { body: { vehicleId: 'daily-driver' } }));
    for (const [s, r] of [[node, enabled[0]], [lean, enabled[1]]]) s.canToken = lib.parseJson(r.body)?.token;
    const start = Math.floor(Date.now() / 1000) * 1000 - 12_000;
    const name = `CAR1_${stampOf(start)}_77.log.xz`;
    const log = freshLog(start, 10);
    const side = Buffer.from(JSON.stringify({ format: 'canbridge-candump-xz/1', frames: 300, closed_because: 'rotate' }));
    for (const s of [node, lean]) {
      const a = await upload(s, s.canToken, name, log);
      const b = await upload(s, s.canToken, `${name}.json`, side);
      if (a.status !== 201 || b.status !== 201) diffs.push(`${s.kind}: upload ${a.status} ${JSON.stringify(a.body)} / ${b.status} ${JSON.stringify(b.body)}`);
    }
    const until = start; // (constant values: the index keeps a change and a repeat now and then, not every frame)
    const seen = await both(async (s) => {
      for (let i = 0; i < 400; i++) {
        const r = await s.bare('GET', `/api/can/now?token=${encodeURIComponent(s.token)}&car=CAR1`);
        const body = lib.parseJson(r.body);
        if (body?.at && Date.parse(body.at) >= until) return Date.now();
        await sleep(250);
      }
      const files = lib.parseJson((await s.c.request('GET', '/api/can/files?limit=500')).body);
      const st = lib.parseJson((await s.c.request('GET', '/api/can/settings')).body);
      const last = lib.parseJson((await s.bare('GET', `/api/can/now?token=${encodeURIComponent(s.token)}&car=CAR1`)).body);
      diffs.push(`${s.kind}: the uploaded log's values never showed in /api/can/now (at ${last?.at}, want ${new Date(until).toISOString()}; index ${JSON.stringify(st?.index)}; the log ${JSON.stringify((files?.logs || []).find((f) => f.name === name))})`);
      return null;
    });
    console.log(`the upload showed after ${seen.map((t) => (t ? `${((t - start - 12_000) / 1000).toFixed(1)} s` : 'never')).join(' (node) / ')} (lean)`);
    await sleep(3200);
    for (const units of ['mi', 'km']) {
      const [x] = same(`GET /api/can/now?car=CAR1&units=${units} (live)`, ...(await ask(`/api/can/now?token=<tok>&car=CAR1&units=${units}`)));
      if (x?.stale !== false) diffs.push(`live: stale ${x?.stale}`);
      console.log(`live (${units}): ${x?.at}, ${Object.values(x?.stats || {}).map((v) => v.text).join(', ')}`);
      same(`GET /api/can/now?units=${units} (live, the newest car)`, ...(await ask(`/api/can/now?token=<tok>&units=${units}`)));
      for (const st of ['speed', 'gear', 'batteryVoltage', 'batteryCurrent', 'batteryPower', 'chargingPower']) same(`GET /api/can/now/${st} (live, ${units})`, ...(await ask(`/api/can/now/${st}?token=<tok>&car=car1&units=${units}`)));
    }
    await both((s) => s.c.request('POST', '/api/auth/confirm', { body: { password: PASSWORD } }));
    await both((s) => s.c.request('POST', '/api/can/disable', { body: {} }));

    // a new link: the old token stops; off: 404 again
    const again = await both((s) => deck(s, 'POST'));
    same('GET /api/can/now (the old token)', ...(await ask('/api/can/now?token=<tok>')));
    for (const [s, r] of [[node, again[0]], [lean, again[1]]]) s.token = lib.parseJson(r.body).token;
    same('GET /api/can/now/battery (the new token)', ...(await ask('/api/can/now/battery?token=<tok>&car=k2')));
    same('DELETE /api/can/stream-deck', ...(await both((s) => deck(s, 'DELETE'))));
    same('GET /api/can/now (off again)', ...(await ask('/api/can/now?token=<tok>')));
    same('GET /api/can/now/ca.crt (off again)', ...(await ask('/api/can/now/ca.crt')));
    // the audit lines
    const audit = await both(async (s) => lib.parseJson((await s.c.request('GET', '/api/logs?limit=1000')).body));
    const lines = (x) => JSON.stringify(x || {}).match(/Stream Deck link [^"\\]*/g) || [];
    compare('audit lines', lines(audit[0]), lines(audit[1]));
  } finally {
    await Promise.all([node.stop(), lean.stop()]);
    if (!process.argv.includes('--keep')) fs.rmSync(work, { recursive: true, force: true });
    else console.log(`kept ${work}`);
  }
  console.log(`${checked} answers compared, ${diffs.length} differences`);
  for (const d of diffs.slice(0, 200)) console.log(`  ${d}`);
  process.exit(diffs.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
