#!/usr/bin/env node
'use strict';

// Every interface in a real browser (Chromium, Playwright), on the Node
// server and on the lean server: Original (/original) and the five that
// come with the app, their main page, the Viewer and the Encoder page, and
// the sign-in page. For each page: did it load, which of its files failed,
// its script errors, and which API calls failed. A file of the pages (not
// under /api/) that fails only on lean, or a script error only on lean, is a
// difference. API calls the lean server does not answer yet (other areas)
// are listed, not counted.
//
//   node lean/parity/uiPages.js [--keep DIR] [--shots DIR]

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright');

const REPO = path.join(__dirname, '..', '..');
const fixture = require(path.join(REPO, 'tools/contract/fixture.js'));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const PASSWORD = 'contract fixture password';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the ui area's routes: a failure of one of these on lean counts
const UI_API = /^\/api\/(ui-packs|exports|settings(\/appearance|\/work-limits)?$|dashboards|vehicles\/[^/]+\/exports)/;

async function startLean(dir, footage) {
  const bin = process.env.LEAN_BIN || [path.join(REPO, 'lean/target/release/sentry-lean'), path.join(REPO, 'lean/target/debug/sentry-lean')].find((f) => fs.existsSync(f));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(bin, [], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), APP_ROOT: REPO, FOOTAGE_PATH: footage, VEHICLE_NAME: 'Contract Car', TZ: 'UTC', DEFAULT_UI: '', UI_PASSWORD: PASSWORD, RUN_DIR: path.join(dir, 'run'), LOG_LEVEL: 'warn' }, stdio: ['ignore', 'ignore', fs.openSync(path.join(dir, 'lean.log'), 'a')] });
  child.on('exit', (code, sig) => console.log(`lean server exited: ${code} ${sig}`));
  // (core's HTTPS, as the Node fixture's: the password only goes over it)
  const base = `https://127.0.0.1:${port}`;
  const up = () => new Promise((resolve) => {
    const req = require('https').get(`${base}/healthz`, { rejectUnauthorized: false }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
  });
  for (let i = 0; i < 100 && !(await up()); i++) await sleep(100);
  return { base, child };
}

async function visit(context, base, p, shot) {
  const page = await context.newPage();
  if (shot?.phone) await page.setViewportSize({ width: 390, height: 844 });
  const out = { path: p, status: null, staticFailed: [], apiFailed: [], errors: [], console: [] };
  page.on('pageerror', (e) => out.errors.push(String(e.message).split('\n')[0].slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') out.console.push(m.text().slice(0, 200)); });
  page.on('requestfailed', (r) => {
    const u = new URL(r.url());
    if (u.origin !== new URL(base).origin) return;
    if (/^\/api\/(events|converter\/events)/.test(u.pathname)) return; // (closed when the page goes)
    (u.pathname.startsWith('/api/') ? out.apiFailed : out.staticFailed).push(`${u.pathname} (${r.failure()?.errorText})`);
  });
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.origin !== new URL(base).origin || r.status() < 400) return;
    (u.pathname.startsWith('/api/') ? out.apiFailed : out.staticFailed).push(`${r.request().method()} ${u.pathname} ${r.status()}`);
  });
  try {
    const res = await page.goto(base + p, { waitUntil: 'load', timeout: 30000 });
    out.status = res?.status() ?? null;
    out.title = await page.title();
    await sleep(3000);
    if (shot) await page.screenshot({ path: shot.file, fullPage: false });
  } catch (err) {
    out.errors.push(`goto: ${err.message.split('\n')[0]}`);
  }
  await page.close();
  return out;
}

async function main() {
  const keep = arg('keep', null);
  const shots = arg('shots', null);
  if (shots) await fsp.mkdir(shots, { recursive: true });
  const dir = keep ? path.resolve(keep) : await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-ui-pages-'));
  let node;
  let lean;
  let browser;
  const results = [];
  let differences = 0;
  try {
    node = await fixture.start({ dir: path.join(dir, 'node'), env: { DEFAULT_UI: '' } });
    await fsp.mkdir(path.join(dir, 'lean'), { recursive: true });
    spawnSync('cp', ['-a', path.join(dir, 'node', 'footage'), path.join(dir, 'lean', 'footage')]);
    lean = await startLean(path.join(dir, 'lean'), path.join(dir, 'lean', 'footage'));
    browser = await chromium.launch();
    const servers = { node: { base: node.base }, lean: { base: lean.base } };
    for (const [name, s] of Object.entries(servers)) {
      s.context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 } });
      // (both servers have accounts: lean signs in through core as Node does)
      const r = await s.context.request.post(`${s.base}/api/auth/login`, { data: { username: 'admin', password: PASSWORD }, headers: { 'X-Requested-With': 'sentry-six-manager' } });
      if (!r.ok()) throw new Error(`${name} sign-in: ${r.status()}`);
    }
    const choose = async (s, name, id) => {
      await s.context.request.post(`${s.base}/api/auth/confirm`, { data: { password: PASSWORD }, headers: { 'X-Requested-With': 'sentry-six-manager' } });
      const r = await s.context.request.put(`${s.base}/api/ui-packs/active`, { data: { id }, headers: { 'X-Requested-With': 'sentry-six-manager' } });
      if (!r.ok()) throw new Error(`${name}: choosing ${id}: ${r.status()} ${await r.text()}`);
    };
    const interfaces = ['original', 'sentry-six', 'aurora', 'daylight', 'flux', 'horizon'];
    const pages = ['/', '/#/settings', '/studio/index.html', '/studio/encoder.html', '/login'];
    for (const ui of interfaces) {
      for (const [name, s] of Object.entries(servers)) {
        await s.context.clearCookies({ name: 'sm_ui_original' }).catch(async () => {
          const keepCookies = (await s.context.cookies()).filter((c) => c.name !== 'sm_ui_original');
          await s.context.clearCookies();
          await s.context.addCookies(keepCookies);
        });
        if (ui === 'original') {
          const p = await s.context.newPage();
          await p.goto(`${s.base}/original`);
          await p.close();
        } else await choose(s, name, ui);
      }
      for (const p of pages) {
        const got = {};
        for (const [name, s] of Object.entries(servers)) {
          const safe = `${ui}${p.replace(/[^a-z0-9]+/gi, '-')}`.replace(/-+$/, '');
          const shot = shots && name === 'lean' && ['/', '/studio/index.html', '/#/settings'].includes(p) ? { file: path.join(shots, `${safe}-desktop.png`) } : null;
          got[name] = await visit(s.context, s.base, p, shot);
          if (shots && name === 'lean' && ['/', '/studio/index.html'].includes(p)) await visit(s.context, s.base, p, { phone: true, file: path.join(shots, `${safe}-phone.png`) });
        }
        const only = (a, b) => b.filter((x) => !a.includes(x));
        const staticOnlyLean = only(got.node.staticFailed, got.lean.staticFailed);
        const errorsOnlyLean = only(got.node.errors, got.lean.errors);
        const uiApiOnlyLean = only(got.node.apiFailed, got.lean.apiFailed).filter((x) => UI_API.test(x.split(' ')[1] || x));
        const otherApi = only(got.node.apiFailed, got.lean.apiFailed).filter((x) => !UI_API.test(x.split(' ')[1] || x));
        // (titles are drawn from live data: notification counts, other areas' answers; shown, not counted)
        const diff = got.node.status !== got.lean.status || staticOnlyLean.length || uiApiOnlyLean.length || errorsOnlyLean.length;
        if (diff) differences++;
        results.push({ ui, page: p, node: got.node, lean: got.lean, staticOnlyLean, errorsOnlyLean, uiApiOnlyLean, otherApi });
        console.log(`${diff ? 'DIFF' : 'ok  '}  ${ui.padEnd(10)} ${p.padEnd(22)} node ${got.node.status} "${got.node.title}" errors ${got.node.errors.length}, lean ${got.lean.status} "${got.lean.title}" errors ${got.lean.errors.length}; lean-only: files ${staticOnlyLean.length}, ui API ${uiApiOnlyLean.length}, other areas' API ${otherApi.length}`);
        for (const x of [...staticOnlyLean, ...uiApiOnlyLean]) console.log(`        ${x}`);
        for (const x of errorsOnlyLean) console.log(`        script error only on lean: ${x}`);
      }
    }
  } finally {
    if (browser) await browser.close();
    if (node) node.child.kill('SIGTERM');
    if (lean) lean.child.kill('SIGTERM');
    await sleep(300);
    if (!keep) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  const other = new Map();
  for (const r of results) for (const x of r.otherApi) other.set(x.replace(/\/api\/vehicles\/[^/]+/, '/api/vehicles/:id'), (other.get(x) || 0) + 1);
  console.log(`\nAPI calls of other areas the lean server does not answer yet (${other.size}): ${[...other.keys()].sort().join(', ')}`);
  if (arg('json')) fs.writeFileSync(arg('json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`${differences ? 'FAIL' : 'PASS'}: ${results.length - differences} of ${results.length} pages load the same.`);
  return differences;
}

main().then((d) => process.exit(d ? 1 : 0), (err) => {
  console.error(err.stack || err.message);
  process.exit(2);
});
