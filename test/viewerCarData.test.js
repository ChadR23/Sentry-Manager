'use strict';

// "Car data in the Viewer" (the Nerd settings): the Viewer's car-data bar and
// Every stat List (web/statDash.js) are a CAN feature, off on a new install and
// turned on by an admin in the Nerd panel. A server from before it starts on
// once when it already has CAN data (CAN Bridge logs, a CAN Bridge token) or a
// saved car-data dashboard, so a bar in use stays. The Viewer learns it from
// the bar's own GET /api/dashboards (carData) and every interface's Viewer
// makes the bar only while it is on (web/viewerExtras.js: followCarData).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { ManagerDB } = require('../server/db');

const REPO = path.join(__dirname, '..');
const SERVER = path.join(REPO, 'server', 'index.js');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

async function startServer(dir) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'),
      VEHICLE_NAME: 'Daily Driver', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: 'correct horse', TZ: 'UTC',
      SENTRY_NOREPLACE_RENAME: path.join(REPO, 'build', 'noreplace-rename'), LOG_LEVEL: 'info', TLS_MODE: 'off', TRUST_PROXY: 'true',
      UPDATE_CHECK: 'off', REPORTS: 'off'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c; });
  child.stderr.on('data', (c) => { output += c; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const client = () => {
    let cookie = '';
    return async (method, p, body) => {
      const res = await fetch(base + p, {
        method,
        headers: { 'X-Forwarded-Proto': 'https', 'X-Requested-With': 'sentry-six-manager', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data };
    };
  };
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
  return { client, stop, output: () => output };
}

async function newDir(t, seed) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-cardata-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  await fsp.mkdir(path.join(dir, 'footage', 'TeslaCam', 'RecentClips'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'data'), { recursive: true });
  if (seed) await seed(dir);
  return dir;
}
/** A database from before the setting, with these settings in it. */
function seedDb(dir, settings) {
  const db = new ManagerDB(path.join(dir, 'data', 'manager.db'));
  for (const [k, v] of Object.entries(settings)) db.set(k, v);
  db.close();
}

async function carDataOf(dir) {
  const s = await startServer(dir);
  try {
    const admin = s.client();
    assert.equal((await admin('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 200);
    const d = (await admin('GET', '/api/dashboards')).data;
    assert.equal(typeof d.carData?.enabled, 'boolean', JSON.stringify(d));
    return d.carData.enabled;
  } finally {
    await s.stop();
  }
}

test('a new install: car data in the Viewer is off; an admin turns it on in one click, audit-logged and live; watch-only accounts read it and may not change it', { timeout: 60000 }, async (t) => {
  const dir = await newDir(t);
  const s = await startServer(dir);
  try {
    const admin = s.client();
    assert.equal((await admin('POST', '/api/auth/login', { username: 'admin', password: 'correct horse' })).status, 200);
    const first = (await admin('GET', '/api/dashboards')).data;
    assert.deepEqual(first.carData, { enabled: false }, 'off by default');
    assert.deepEqual(first.boards, [], 'nothing saved yet');
    assert.equal((await admin('GET', '/api/can/settings')).data.viewerCarData.enabled, false, 'the Nerd panel sees it');
    for (const bad of [{}, { enabled: 'yes' }, { enabled: 1 }]) assert.equal((await admin('POST', '/api/can/viewer-car-data', bad)).status, 400, JSON.stringify(bad));
    // (no password asked: one click, as the panel's other switches when confirmed)
    const on = await admin('POST', '/api/can/viewer-car-data', { enabled: true });
    assert.equal(on.status, 200, JSON.stringify(on.data));
    assert.deepEqual(on.data, { enabled: true });
    assert.deepEqual((await admin('GET', '/api/dashboards')).data.carData, { enabled: true });
    assert.equal((await admin('GET', '/api/can/settings')).data.viewerCarData.enabled, true);
    // a watch-only account: reads it with the dashboards, cannot change it
    assert.equal((await admin('POST', '/api/auth/confirm', { password: 'correct horse' })).status, 200);
    assert.equal((await admin('POST', '/api/accounts', { username: 'kid', password: 'watching only', role: 'viewer' })).status, 200);
    const kid = s.client();
    assert.equal((await kid('POST', '/api/auth/login', { username: 'kid', password: 'watching only' })).status, 200);
    assert.deepEqual((await kid('GET', '/api/dashboards')).data.carData, { enabled: true });
    assert.equal((await kid('POST', '/api/can/viewer-car-data', { enabled: false })).status, 403);
    assert.equal((await kid('GET', '/api/can/settings')).status, 403);
    // a dashboard saved back with the answer's carData in it: the setting is not the account's
    const saved = await kid('PUT', '/api/dashboards', { boards: [{ id: 'default', name: 'Drive', blocks: [{ type: 'small', signals: ['speed'] }] }], active: 'default', carData: { enabled: false } });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.carData, undefined);
    assert.deepEqual((await kid('GET', '/api/dashboards')).data.carData, { enabled: true });
    // off again
    assert.deepEqual((await admin('POST', '/api/can/viewer-car-data', { enabled: false })).data, { enabled: false });
    assert.deepEqual((await kid('GET', '/api/dashboards')).data.carData, { enabled: false });
    const logged = fs.readFileSync(path.join(dir, 'data', 'logs', 'manager.log'), 'utf8');
    assert.match(logged, /\[audit\] Car data in the Viewer turned on: admin from/);
    assert.match(logged, /\[audit\] Car data in the Viewer turned off: admin from/);
    assert.equal(s.output().includes('TypeError'), false);
  } finally {
    await s.stop();
  }
  // kept across a restart (it was decided once; a dashboard saved since does not turn it on)
  assert.equal(await carDataOf(dir), false);
});

test('a server from before: on once when it has CAN Bridge logs, a CAN Bridge token or a saved dashboard; else off; decided only once', { timeout: 120000 }, async (t) => {
  // nothing of the car data: off
  assert.equal(await carDataOf(await newDir(t, (dir) => seedDb(dir, { appearance: { reduceEffects: false } }))), false, 'nothing: off');
  // CAN Bridge logs (a finished log in a car key's folder)
  assert.equal(await carDataOf(await newDir(t, async (dir) => {
    seedDb(dir, {});
    await fsp.mkdir(path.join(dir, 'data', 'can', 'OLD-car'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'data', 'can', 'OLD-car', 'OLD-car_20261108T005818Z_1.log.xz'), 'x');
  })), true, 'CAN logs: on');
  // only a log still arriving (.part) is not CAN data yet
  assert.equal(await carDataOf(await newDir(t, async (dir) => {
    await fsp.mkdir(path.join(dir, 'data', 'can', 'NEW-car'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'data', 'can', 'NEW-car', 'NEW-car_20261108T005818Z_1.log.xz.part'), 'x');
  })), false, 'a part: off');
  // a CAN Bridge token (uploads turned on once)
  assert.equal(await carDataOf(await newDir(t, (dir) => seedDb(dir, { can: { enabled: false, at: 1, tokens: [{ id: 'a1', hash: 'f'.repeat(64), vehicleId: null, key: null, label: 'Car', createdAt: 1, lastUsedAt: null }] } }))), true, 'a token: on');
  // the oldest form of the token
  assert.equal(await carDataOf(await newDir(t, (dir) => seedDb(dir, { can: { enabled: true, at: 1, tokenHash: 'e'.repeat(64) } }))), true, 'an old token: on');
  // a saved car-data dashboard (any account's)
  assert.equal(await carDataOf(await newDir(t, (dir) => seedDb(dir, { 'dash:someone': { boards: [{ id: 'default', name: 'Drive', blocks: [] }], active: 'default', rev: 2 } }))), true, 'a dashboard: on');
  // decided once: turned off by the owner, it stays off with all of them there
  const dir = await newDir(t, async (d) => {
    seedDb(d, { viewerCarData: { enabled: false, at: 1 }, 'dash:admin': { boards: [{ id: 'default', name: 'Drive', blocks: [] }], active: 'default', rev: 2 } });
    await fsp.mkdir(path.join(d, 'data', 'can', 'OLD-car'), { recursive: true });
    await fsp.writeFile(path.join(d, 'data', 'can', 'OLD-car', 'OLD-car_20261108T005818Z_1.log.xz'), 'x');
  });
  assert.equal(await carDataOf(dir), false, 'chosen before: kept');
});

// ---- the Viewer side: web/viewerExtras.js makes the bar only while it is on

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'viewerextras-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
async function freshExtras(tag) {
  const file = path.join(TMP, `viewerExtras-${tag}.mjs`);
  // (scrub.js as an .mjs copy too: the package itself is CommonJS)
  const scrub = path.join(TMP, 'scrub.mjs');
  if (!fs.existsSync(scrub)) fs.writeFileSync(scrub, read('web/scrub.js'));
  fs.writeFileSync(file, read('web/viewerExtras.js').replace("import { timeAfter } from '/web/scrub.js';", `import { timeAfter } from ${JSON.stringify(pathToFileURL(scrub).href)};`));
  return import(pathToFileURL(file).href);
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 10; i++) await tick(); }

test('the Viewer: off, no bar is made and statDash is not even loaded; turned on live, it comes; off again, it goes; the dashboards are asked for once per change', async (t) => {
  const win = new EventTarget();
  let enabled = false;
  let asked = 0;
  const realFetch = globalThis.fetch;
  globalThis.window = win;
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/dashboards');
    asked++;
    return { ok: true, json: async () => ({ boards: [], active: null, carData: { enabled } }) };
  };
  t.after(() => { globalThis.fetch = realFetch; delete globalThis.window; });
  const { followCarData, carDataOn } = await freshExtras('live');
  assert.equal(carDataOn(null), false);
  assert.equal(carDataOn({ boards: [] }), false, 'an older server, or no answer: off');
  assert.equal(carDataOn({ carData: { enabled: true } }), true);

  let loads = 0;
  const made = [];
  const load = async () => { loads++; return { mod: true }; };
  const attach = (mod, d) => { const bar = { d, destroyed: false, destroy() { this.destroyed = true; } }; made.push(bar); return bar; };
  const stop1 = followCarData(attach, { load });
  const stop2 = followCarData(attach, { load });
  await settle();
  assert.equal(asked, 1, 'one request for the page');
  assert.equal(loads, 0, 'off: the bar\'s module is not loaded');
  assert.equal(made.length, 0, 'off: no bar');

  // an unrelated live update changes nothing
  win.dispatchEvent(Object.assign(new Event('sentry:changed'), { detail: { topics: ['jobs'] } }));
  await settle();
  assert.equal(asked, 1);

  enabled = true;
  win.dispatchEvent(Object.assign(new Event('sentry:changed'), { detail: { topics: ['carData'] } }));
  await settle();
  assert.equal(asked, 2, 'asked again once, for both Viewers');
  assert.equal(made.length, 2, 'on: each Viewer\'s bar');
  assert.equal(made[0].d.carData.enabled, true, 'the answer goes to the bar (its dashboards, not asked again)');

  enabled = false;
  win.dispatchEvent(Object.assign(new Event('sentry:changed'), { detail: { topics: ['carData'] } }));
  await settle();
  assert.ok(made.every((b) => b.destroyed), 'off: the bars go');

  stop1();
  enabled = true;
  win.dispatchEvent(Object.assign(new Event('sentry:changed'), { detail: { topics: ['carData'] } }));
  await settle();
  assert.equal(made.length, 3, 'only the Viewer still open makes one');
  stop2();
  assert.equal(made[2].destroyed, true, 'closing the Viewer destroys its bar');
});

test('the Viewer: on from the start, the bar is made with the answer; an answer that fails is off', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.window = new EventTarget();
  t.after(() => { globalThis.fetch = realFetch; delete globalThis.window; });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ boards: [{ id: 'x' }], active: 'x', carData: { enabled: true } }) });
  let { followCarData } = await freshExtras('on');
  const made = [];
  followCarData((mod, d) => { made.push([mod, d]); return { destroy() {} }; }, { load: async () => 'statDash' });
  await settle();
  assert.equal(made.length, 1);
  assert.equal(made[0][0], 'statDash');
  assert.equal(made[0][1].boards[0].id, 'x');

  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
  ({ followCarData } = await freshExtras('fail'));
  let n = 0;
  followCarData(() => { n++; return { destroy() {} }; }, { load: async () => ({}) });
  await settle();
  assert.equal(n, 0);
});

// ---- every interface's Viewer goes through it (the source, as the other pack tests)

test('every interface\'s Viewer makes the car data only through followCarData; each shell passes its live updates on', () => {
  const x = read('web/viewerExtras.js');
  // the one place the bar is made: inside followCarData, never at the module's import
  assert.match(x, /cleanups\.push\(followCarData\(\(\{ attachStatDash, primeBoards \}, d\) => \{\s*primeBoards\(d\);[\s\S]*?return attachStatDash\(/);
  assert.equal((x.match(/attachStatDash\(/g) || []).length, 1, 'statDash attached in one place');
  assert.equal((x.match(/import\('\/web\/statDash\.js'\)/g) || []).length, 1, 'and loaded in one place (followCarData\'s load)');
  assert.match(x, /if \(!carDataOn\(d\)\) \{ dash\?\.destroy\(\); dash = null; return null; \}\s*if \(dash\) return null;\s*return load\(\)/, 'loaded only when on');
  assert.match(read('web/statDash.js'), /export function primeBoards\(d\)/);
  // the Viewers: the built-in one (the Studio Viewer, through the web shim) and the four packs
  const viewers = {
    builtin: 'web/electronApiShim.js',
    horizon: 'examples/ui-packs/horizon/web/hz/pages/viewer.js',
    flux: 'examples/ui-packs/flux/web/flux/pages/viewer.js',
    aurora: 'examples/ui-packs/aurora/web/aurora/pages/viewer.js',
    daylight: 'examples/ui-packs/daylight/web/dl/pages/viewer.js'
  };
  for (const [name, file] of Object.entries(viewers)) {
    const src = read(file);
    assert.match(src, /attachViewerExtras\(\{/, `${name}: the shared Viewer parts`);
    assert.equal(/import\(['"]\/web\/statDash\.js['"]\)|from ['"]\/web\/statDash\.js['"]|attachStatDash/.test(src), false, `${name}: never the bar on its own`);
  }
  // nothing else in any interface makes it
  const all = [...fs.readdirSync(path.join(REPO, 'web')).filter((f) => f.endsWith('.js')).map((f) => `web/${f}`)];
  for (const p of ['horizon/web/hz', 'flux/web/flux', 'aurora/web/aurora', 'daylight/web/dl']) {
    const walk = (d) => fs.readdirSync(path.join(REPO, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith('.js') ? [`${d}/${e.name}`] : []));
    all.push(...walk(`examples/ui-packs/${p}`));
  }
  for (const f of all) if (!['web/statDash.js', 'web/viewerExtras.js'].includes(f)) assert.equal(/attachStatDash\(/.test(read(f)), false, f);
  // the shells hand every live update on (the built-in Viewer, in its frame, hears its page's)
  const shells = ['web/app.js', 'examples/ui-packs/horizon/web/hz/main.js', 'examples/ui-packs/flux/web/flux/main.js', 'examples/ui-packs/aurora/web/aurora/main.js', 'examples/ui-packs/daylight/web/dl/app.js'];
  for (const f of shells) assert.match(read(f), /window\.dispatchEvent\(new CustomEvent\('sentry:changed', \{ detail: \{ topics \} \}\)\);/, f);
  assert.match(x, /window\.top[\s\S]{0,200}addEventListener\?\.\('sentry:changed', carDataTopics\)/);
});

test('the Nerd panel: a "Car data in the Viewer" switch, one click, live', () => {
  const n = read('web/nerd.js');
  assert.match(n, /<h3>Car data in the Viewer<\/h3>/);
  assert.match(n, /<input type="checkbox" data-cardata\$\{on \? ' checked' : ''\}> Car data in the Viewer<\/label>/);
  assert.match(n, /Shows the CAN stats bar and the Every stat list under the cameras/);
  assert.match(n, /const on = st\.viewerCarData\?\.enabled === true;/);
  assert.match(n, /e\.target\.closest\('\[data-cardata\]'\);\s*if \(car\) \{\s*await confirmThen\('\/api\/can\/viewer-car-data', post\('', \{ enabled: car\.checked \}\)\);/);
  const handler = n.slice(n.indexOf("closest('[data-cardata]')"), n.indexOf("const keep = e.target.closest('[data-keep]')"));
  assert.ok(handler.length > 0 && handler.length < 400);
  assert.equal(/[^.\w]confirm\(/.test(handler), false, 'no "are you sure"');
  assert.match(n, /topics\.includes\('carData'\)\) live\(\);/);
  assert.match(n, /\$\{carDataHtml\(\)\}/);
});
