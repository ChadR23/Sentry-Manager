#!/usr/bin/env node
'use strict';

// Same answers for the ui area (lean/src/ui/): starts the Node server on the
// contract fixture (tools/contract/fixture.js, HTTPS, signed in over HTTPS)
// and the lean server on a copy of the same footage, then asks both the
// same questions and prints every difference:
//
//   - every page and file under /web/, /studio/, /shared/ and /assets/, as
//     it is, versioned (/v/<version>/…), compressed (br, gzip), and again with
//     its ETag (304); in every interface: Original (/original), the five that
//     come with the app, and an uploaded one; the security headers and CSP;
//   - the routes: /api/ui-packs (list, choose, upload with its refusals,
//     delete, original.zip), /api/settings, /api/settings/appearance,
//     /api/dashboards, /api/settings/work-limits, /api/exports* (a real
//     export with ffmpeg), the Studio translations, the early-data hint.
//
// What changes by itself is normalised: each server's /v/<version>/ (its
// start time is in it), ids and times made at the moment, the Secure flag of
// cookies, compressed lengths. Both servers have HTTPS and sign-in.
//
//   node lean/parity/uiCompare.js [--keep DIR] [--json FILE]
//
// Exits 1 when anything differs.

const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const fixture = require(path.join(REPO, 'tools', 'contract', 'fixture.js'));
const { writeZip } = require(path.join(REPO, 'server', 'zip.js'));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };

const PASSWORD = 'contract fixture password';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(base, { cookie = '' } = {}) {
  const u = new URL(base);
  const secure = u.protocol === 'https:';
  const agent = secure ? new https.Agent({ keepAlive: true, rejectUnauthorized: false }) : new http.Agent({ keepAlive: true });
  let session = cookie;
  const jar = {};
  async function request(method, p, { headers = {}, body = null, raw = false } = {}) {
    const payload = body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const cookies = [session, ...Object.entries(jar).map(([k, v]) => `${k}=${v}`)].filter(Boolean).join('; ');
    const h = {
      'Accept-Encoding': 'identity',
      ...(method !== 'GET' && method !== 'HEAD' ? { 'X-Requested-With': 'sentry-six-manager' } : {}),
      ...(payload ? { 'Content-Type': raw ? 'application/zip' : 'application/json', 'Content-Length': payload.length } : {}),
      ...(cookies ? { Cookie: cookies } : {}),
      ...headers
    };
    return new Promise((resolve, reject) => {
      const req = (secure ? https : http).request(new URL(p, base), { method, headers: h, agent }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.setTimeout(60000, () => req.destroy(new Error(`${method} ${p}: timeout`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  return {
    request,
    setSession: (c) => { session = c; },
    setCookie: (k, v) => { if (v === null) delete jar[k]; else jar[k] = v; },
    close: () => agent.destroy()
  };
}

function freePort() {
  return new Promise((resolve) => {
    const s = require('net').createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function startLean(dir, footage) {
  const bin = process.env.LEAN_BIN || [path.join(REPO, 'lean/target/release/sentry-lean'), path.join(REPO, 'lean/target/debug/sentry-lean')].find((f) => fs.existsSync(f));
  if (!bin) throw new Error('Build the lean server first (cd lean && cargo build)');
  const port = await freePort();
  const child = spawn(bin, [], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), APP_ROOT: REPO, FOOTAGE_PATH: footage, VEHICLE_NAME: 'Contract Car', TZ: 'UTC', DEFAULT_UI: '',
      UI_PASSWORD: PASSWORD, RUN_DIR: path.join(dir, 'run'), LOG_LEVEL: 'warn', TLS_MODE: 'auto' },
    stdio: ['ignore', 'ignore', process.env.LEAN_LOG ? 'inherit' : 'ignore']
  });
  // (core's HTTPS, as the Node fixture's: the password only goes over it)
  const base = `https://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await client(base).request('GET', '/healthz')).status === 200) break; } catch { /* not yet */ }
    await sleep(100);
  }
  return { base, child };
}

// ---- normalising

const HEADERS = ['content-type', 'cache-control', 'content-disposition', 'location', 'etag', 'vary', 'content-encoding', 'x-content-type-options',
  'content-security-policy', 'referrer-policy', 'x-frame-options', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'permissions-policy', 'set-cookie', 'accept-ranges'];

function decoded(res) {
  const enc = res.headers['content-encoding'];
  try {
    if (enc === 'br') return zlib.brotliDecompressSync(res.body);
    if (enc === 'gzip') return zlib.gunzipSync(res.body);
  } catch (err) {
    return Buffer.from(`<undecodable ${enc}: ${err.message}>`);
  }
  return res.body;
}

function snapshot(res, { version, json = false, bodyHash = true, drop = [] } = {}) {
  const headers = {};
  for (const k of HEADERS) {
    let v = res.headers[k];
    if (v === undefined) continue;
    if (Array.isArray(v)) v = v.join(' | ');
    v = String(v);
    if (k === 'set-cookie') v = v.replace(/; Secure/g, '').replace(/sm_session=[^;]+/, 'sm_session=<session>');
    if (version) v = v.split(version).join('<v>');
    headers[k] = v;
  }
  let body = decoded(res);
  let text = null;
  if (/^(text\/|application\/(json|javascript))/.test(res.headers['content-type'] || '') || json) {
    text = body.toString('utf8');
    if (version) text = text.split(version).join('<v>');
  }
  let out = { status: res.status, headers };
  if (json) {
    try { out.body = normaliseJson(JSON.parse(text), drop); } catch { out.body = text; }
  } else if (text !== null) {
    out.body = bodyHash && text.length > 400 ? `sha256:${crypto.createHash('sha256').update(text).digest('hex')} (${text.length} chars)` : text;
    out.text = text;
  } else {
    out.body = `sha256:${crypto.createHash('sha256').update(body).digest('hex')} (${body.length} bytes)`;
  }
  return out;
}

function normaliseJson(v, drop = [], key = '') {
  if (Array.isArray(v)) return v.map((x) => normaliseJson(x, drop, key));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = drop.includes(k) && x !== null ? '<dropped>' : normaliseJson(x, drop, k);
    return o;
  }
  if (typeof v === 'string') return v.replace(/\b[a-z0-9-]+-[0-9a-f]{6}\b/g, (m) => (/-[0-9a-f]{6}$/.test(m) && /[a-z]/.test(m.slice(0, -7)) ? `${m.slice(0, -7)}-<id>` : m)).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<iso>');
  return v;
}

function diff(a, b, at = '', out = []) {
  if (a === b) return out;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    out.push({ path: at || '.', node: a, lean: b });
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (k === 'text') continue;
    diff(a[k], b[k], `${at}.${k}`, out);
  }
  if (Array.isArray(a) === Array.isArray(b) && !Array.isArray(a) && JSON.stringify(Object.keys(a).filter((k) => k !== 'text')) !== JSON.stringify(Object.keys(b).filter((k) => k !== 'text'))) out.push({ path: `${at} (key order)`, node: Object.keys(a).join(','), lean: Object.keys(b).join(',') });
  return out;
}

function brief(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

// a line-level hint for two texts that differ
function textHint(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return '';
  const la = a.split('\n');
  const lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i++) if (la[i] !== lb[i]) return ` (line ${i + 1}: node ${brief(la[i])} / lean ${brief(lb[i])})`;
  return '';
}

// ---- the files to ask for

function filesUnder(root, prefix) {
  const out = [];
  const walk = (abs, rel) => {
    let list = [];
    try { list = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(abs, e.name), r);
      else if (e.isFile()) out.push(`${prefix}${r}`);
    }
  };
  walk(root, '');
  return out;
}

async function main() {
  const keep = arg('keep', null);
  const dir = keep ? path.resolve(keep) : await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-ui-parity-'));
  await fsp.mkdir(dir, { recursive: true });
  const report = { same: 0, different: 0, diffs: [] };
  let node;
  let lean;
  try {
    console.log(`building the fixture and starting the Node server in ${dir}/node …`);
    const nodeDir = path.join(dir, 'node');
    await fsp.mkdir(nodeDir, { recursive: true });
    node = await fixture.start({ dir: nodeDir, env: { DEFAULT_UI: '' } });
    const leanFootage = path.join(dir, 'lean', 'footage');
    await fsp.mkdir(path.dirname(leanFootage), { recursive: true });
    spawnSync('cp', ['-a', path.join(nodeDir, 'footage'), leanFootage]);
    lean = await startLean(path.join(dir, 'lean'), leanFootage);
    console.log(`node ${node.base}, lean ${lean.base}`);

    const N = client(node.base);
    const L = client(lean.base);
    const login = await N.request('POST', '/api/auth/login', { body: { username: 'admin', password: PASSWORD } });
    const set = [].concat(login.headers['set-cookie'] || []).map((s) => s.split(';')[0]).find((s) => /^[^=]+=.{8,}/.test(s));
    if (!set) throw new Error(`sign-in on the Node server failed (${login.status})`);
    N.setSession(set);
    // (both servers have accounts: lean signs in through core as Node does)
    const leanLogin = await L.request('POST', '/api/auth/login', { body: { username: 'admin', password: PASSWORD } });
    const leanSet = [].concat(leanLogin.headers['set-cookie'] || []).map((s) => s.split(';')[0]).find((s) => /^[^=]+=.{8,}/.test(s));
    if (!leanSet) throw new Error(`sign-in on the lean server failed (${leanLogin.status})`);
    L.setSession(leanSet);
    const confirm = async () => {
      for (const c of [N, L]) {
        const r = await c.request('POST', '/api/auth/confirm', { body: { password: PASSWORD } });
        if (r.status !== 200) throw new Error(`confirm failed: ${r.status} ${r.body}`);
      }
    };
    await confirm();

    const versions = { node: null, lean: null };
    const learnVersion = async () => {
      for (const [name, c] of [['node', N], ['lean', L]]) {
        const page = (await c.request('GET', '/')).body.toString();
        const m = /\/v\/([A-Za-z0-9_-]+)\//.exec(page);
        versions[name] = m ? m[1] : null;
      }
    };

    // files an upload wrote: their times (in the ETag) are each server's own
    const ownTimes = new Set(['/web/shell.css', '/web/index.html', '/web/critical.js', '/studio/styles/footageConverter.css']);
    let uploadedOn = false;
    const check = async (label, method, p, opts = {}, snap = {}) => {
      const [a, b] = await Promise.all([N.request(method, p.replace('<v>', versions.node), opts.perServer ? opts.perServer.node : opts), L.request(method, p.replace('<v>', versions.lean), opts.perServer ? opts.perServer.lean : opts)]);
      const sa = snapshot(a, { ...snap, version: versions.node });
      const sb = snapshot(b, { ...snap, version: versions.lean });
      if (uploadedOn && ownTimes.has(p.replace(/^\/v\/<v>/, ''))) delete sa.headers.etag, delete sb.headers.etag;
      if (snap.ignoreBody) delete sa.body, delete sb.body;
      const d = diff(sa, sb);
      if (d.length) {
        report.different++;
        report.diffs.push({ label, diffs: d.map((x) => ({ ...x, hint: x.path === '.body' ? textHint(sa.text, sb.text) : '' })) });
      } else report.same++;
      return [a, b];
    };

    // ---- the API answers first (on a fresh server)
    const api = (label, method, p, body, drop = []) => check(label, method, p, body === undefined ? {} : { body }, { json: true, drop });
    await api('GET /api/ui-packs', 'GET', '/api/ui-packs');
    await api('GET /api/settings', 'GET', '/api/settings');
    await api('GET /api/dashboards (none yet)', 'GET', '/api/dashboards');
    await api('GET /api/settings/work-limits', 'GET', '/api/settings/work-limits');
    await api('GET /api/exports', 'GET', '/api/exports');
    await api('GET /api/exports?vehicle', 'GET', '/api/exports?vehicle=contract-car');
    await api('GET /api/exports/:id (none)', 'GET', '/api/exports/0000000000000000');
    await api('GET /api/exports/:id/file (none)', 'GET', '/api/exports/0000000000000000/file');
    await api('DELETE /api/exports/:id (none)', 'DELETE', '/api/exports/0000000000000000');
    await api('PUT /api/settings/appearance', 'PUT', '/api/settings/appearance', { clock24: 1, other: true });
    await api('PUT /api/settings/appearance (keeps)', 'PUT', '/api/settings/appearance', { reduceEffects: true });
    await api('PUT /api/settings/appearance (empty)', 'PUT', '/api/settings/appearance');
    await api('GET /api/settings (after)', 'GET', '/api/settings');
    await api('PUT /api/settings/appearance back', 'PUT', '/api/settings/appearance', { reduceEffects: false, clock24: false });
    for (const [i, b] of [
      { active: 'b2', boards: [{ id: 'b1', name: 'Drive', placement: 'below', blocks: [{ type: 'gauge', signals: ['dash.speed'] }, { type: 'wide', signals: ['a', 'b', 'c', 'd'] }, { type: 'evil', signals: ['x'] }] }, { id: 'b2', name: '  Battery\nnerd ', placement: 'sideways', metric: true, blocks: [{ type: 'small', signals: ['can.BattVoltage132', '<script>'] }] }] },
      { boards: [] },
      { boards: [{ placement: 'float', float: { wide: { x: 0.5, y: 0.2, top: 700, h: 'r', v: 'b', dx: 20.4, dy: -190, over: true }, narrow: { x: 7, y: -2 } }, size: { wide: { w: 640.4, h: 210 }, narrow: { h: 5 } }, listPlacement: 'float', listFloat: { wide: { h: 'R', v: 't', dx: 20, dy: 0, bar: { h: 'l', v: 'B', dx: 0, dy: 8, extra: 1 } } }, blocks: [{ type: 'list', signals: ['a'], q: 'volt\u0007age', changing: true }] }, { id: 7, name: 42, blocks: 'x' }] },
      'not an object',
      [1, 2]
    ].entries()) await api(`PUT /api/dashboards #${i}`, 'PUT', '/api/dashboards', b);
    await api('GET /api/dashboards (saved)', 'GET', '/api/dashboards');
    await api('PUT /api/settings/work-limits', 'PUT', '/api/settings/work-limits', { speedIndex: 2, codecChecks: ' 5 ', thumbnails: '' });
    await api('PUT /api/settings/work-limits (refused)', 'PUT', '/api/settings/work-limits', { codecChecks: 33 });
    await api('PUT /api/settings/work-limits (refused 2)', 'PUT', '/api/settings/work-limits', { speedIndex: 1.5 });
    await api('PUT /api/settings/work-limits (automatic)', 'PUT', '/api/settings/work-limits', {});
    await api('PUT /api/ui-packs/active (not a string)', 'PUT', '/api/ui-packs/active', { id: 7 });
    await api('PUT /api/ui-packs/active (none)', 'PUT', '/api/ui-packs/active', { id: 'nope' });
    await api('PUT /api/ui-packs/active (../x)', 'PUT', '/api/ui-packs/active', { id: '../x' });
    await api('DELETE /api/ui-packs/flux (built in)', 'DELETE', '/api/ui-packs/flux');
    await api('DELETE /api/ui-packs/nope', 'DELETE', '/api/ui-packs/nope');
    await api('GET /api/ui-packs/upload (not POST)', 'GET', '/api/ui-packs/upload');
    await api('PUT invalid JSON', 'PUT', '/api/settings/appearance', undefined);
    {
      const [a, b] = await Promise.all([N.request('PUT', '/api/dashboards', { body: Buffer.from('{nope'), headers: { 'Content-Type': 'application/json' } }), L.request('PUT', '/api/dashboards', { body: Buffer.from('{nope'), headers: { 'Content-Type': 'application/json' } })]);
      const d = diff(snapshot(a, { json: true }), snapshot(b, { json: true }));
      if (d.length) { report.different++; report.diffs.push({ label: 'PUT invalid JSON', diffs: d }); } else report.same++;
    }
    await check('GET /api/ui-packs/original.zip (headers)', 'GET', '/api/ui-packs/original.zip', {}, { ignoreBody: true });
    // (the zip itself: compared by its files)
    {
      const [a, b] = await Promise.all([N.request('GET', '/api/ui-packs/original.zip'), L.request('GET', '/api/ui-packs/original.zip')]);
      const { readZip } = require(path.join(REPO, 'server', 'zip.js'));
      const files = (r) => readZip(r.body).map((f) => `${f.name} ${crypto.createHash('sha256').update(f.data).digest('hex')}`).sort().join('\n');
      if (files(a) !== files(b)) { report.different++; report.diffs.push({ label: 'original.zip files', diffs: [{ path: 'files', node: files(a).slice(0, 300), lean: files(b).slice(0, 300) }] }); } else report.same++;
    }
    // uploads: refused ones, then a real one
    const upload = (label, bytes, name) => check(label, 'POST', '/api/ui-packs/upload', { body: bytes, raw: true, headers: { 'X-File-Name': encodeURIComponent(name) } }, { json: true, drop: ['uploadedAt'] });
    await upload('upload: not a zip', Buffer.from('not a zip, really not a zip'), 'x.zip');
    await upload('upload: no web/', writeZip([{ name: 'readme.txt', data: Buffer.from('x') }]), 'x.zip');
    await upload('upload: a path out', writeZip([{ name: 'web/../../evil.js', data: Buffer.from('x') }]), 'x.zip');
    await upload('upload: bad ui.json', writeZip([{ name: 'ui.json', data: Buffer.from('{') }, { name: 'web/a', data: Buffer.from('x') }]), 'x.zip');
    {
      const [a] = await Promise.all([N.request('POST', '/api/ui-packs/upload', { body: Buffer.from('x'), raw: true, headers: { 'X-Requested-With': '' } })]);
      const b = await L.request('POST', '/api/ui-packs/upload', { body: Buffer.from('x'), raw: true, headers: { 'X-Requested-With': '' } });
      const d = diff(snapshot(a, { json: true }), snapshot(b, { json: true }));
      if (d.length) { report.different++; report.diffs.push({ label: 'upload without X-Requested-With', diffs: d }); } else report.same++;
    }
    const red = writeZip([
      { name: 'Red Pack/ui.json', data: Buffer.from(JSON.stringify({ name: 'Red\n', description: 'A red one', author: 'Sam' })) },
      { name: 'Red Pack/web/shell.css', data: Buffer.from('body{background:red}') },
      { name: 'Red Pack/web/index.html', data: Buffer.from('<!doctype html><html><head><title>Red</title><link rel="stylesheet" href="shell.css"><script src="app.js" defer></script></head><body></body></html>') },
      { name: 'Red Pack/web/critical.js', data: Buffer.from('/* no bar */') },
      { name: 'Red Pack/studio/styles/footageConverter.css', data: Buffer.from('/* red encoder */') },
      { name: '__MACOSX/Red Pack/._shell.css', data: Buffer.from('junk') }
    ]);
    const [upA, upB] = await upload('upload: a pack', red, 'red.zip');
    const redIds = { node: JSON.parse(upA.body).pack?.id, lean: JSON.parse(upB.body).pack?.id };
    await api('GET /api/ui-packs (with the upload)', 'GET', '/api/ui-packs', undefined, ['uploadedAt']);

    // ---- every page and file, in every interface
    const builtin = [...filesUnder(path.join(REPO, 'web'), '/web/'), ...filesUnder(path.join(REPO, 'src/renderer'), '/studio/'), ...filesUnder(path.join(REPO, 'src/shared'), '/shared/'), ...filesUnder(path.join(REPO, 'assets'), '/assets/')];
    const pages = ['/', '/index.html', '/login', '/login/code', '/login/two-factor', '/studio', '/studio/', '/studio/?x=1', '/studio/index.html?embed=encoder&a=b', '/studio/scripts/data/translations.js', '/studio/i18n/es.json', '/studio/i18n/de.json', '/studio/i18n/xx.json', '/studio/i18n/EN.json',
      '/nope', '/web/nope.js', '/web/../server/index.js', '/web/%2e%2e/x', '/web//x', '/v/<v>/api/vehicles', '/v/oldversion1/web/app.js', '/v/<v>/web/app.js', '/v/<v>/web/viewerMap.js', '/v/<v>/studio/index.html', '/v/assets/icon.png', '/web/fonts/', '/web', '/assets/', '/shared/x/../y'];
    const interfaces = [['original (/original)', null], ['sentry-six', 'sentry-six'], ['aurora', 'aurora'], ['daylight', 'daylight'], ['flux', 'flux'], ['horizon', 'horizon'], ['uploaded', 'red'], ['none chosen (null)', 'null']];
    for (const [label, id] of interfaces) {
      uploadedOn = id === 'red';
      if (id === null) {
        // /original: the cookie
        const [a, b] = await check(`${label}: GET /original`, 'GET', '/original');
        const flag = (r) => [].concat(r.headers['set-cookie'] || [])[0]?.split(';')[0];
        N.setCookie('sm_ui_original', flag(a)?.split('=')[1] ?? null);
        L.setCookie('sm_ui_original', flag(b)?.split('=')[1] ?? null);
      } else {
        N.setCookie('sm_ui_original', null);
        L.setCookie('sm_ui_original', null);
        await confirm();
        const body = { id: id === 'red' ? undefined : id === 'null' ? null : id };
        const [a, b] = await Promise.all([N.request('PUT', '/api/ui-packs/active', { body: id === 'red' ? { id: redIds.node } : body }), L.request('PUT', '/api/ui-packs/active', { body: id === 'red' ? { id: redIds.lean } : body })]);
        const d = diff(snapshot(a, { json: true }), snapshot(b, { json: true }));
        if (d.length) { report.different++; report.diffs.push({ label: `${label}: PUT /api/ui-packs/active`, diffs: d }); } else report.same++;
      }
      await learnVersion();
      await api(`${label}: GET /api/ui-packs`, 'GET', '/api/ui-packs', undefined, ['uploadedAt']);
      const packRoot = id && id !== 'red' && id !== 'null' ? path.join(REPO, 'examples/ui-packs', id) : null;
      const own = packRoot ? [...filesUnder(path.join(packRoot, 'web'), '/web/'), ...filesUnder(path.join(packRoot, 'studio'), '/studio/')] : id === 'red' ? ['/web/shell.css', '/web/index.html', '/web/critical.js', '/studio/styles/footageConverter.css'] : [];
      const all = [...new Set([...pages, ...builtin, ...own])];
      for (const p of all) {
        await check(`${label}: GET ${p}`, 'GET', p);
        if (/\.(m?js|css)$/.test(p) && !p.startsWith('/v/')) await check(`${label}: GET /v/<v>${p}`, 'GET', `/v/<v>${p}`);
      }
      // compressed, HEAD and 304 on a few
      for (const p of ['/', '/web/app.js', '/web/shell.css', '/studio/index.html', '/studio/scripts/data/translations.js', '/web/icon.png', '/v/<v>/web/app.js', '/studio/i18n/es.json']) {
        await check(`${label}: GET ${p} (br)`, 'GET', p, { headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
        await check(`${label}: GET ${p} (gzip)`, 'GET', p, { headers: { 'Accept-Encoding': 'gzip' } });
        await check(`${label}: HEAD ${p}`, 'HEAD', p);
        const [a, b] = await Promise.all([N.request('GET', p.replace('<v>', versions.node)), L.request('GET', p.replace('<v>', versions.lean))]);
        const inm = (r) => ({ headers: { 'If-None-Match': `"x", ${r.headers.etag || '"none"'}` } });
        await check(`${label}: GET ${p} (If-None-Match)`, 'GET', p, { perServer: { node: inm(a), lean: inm(b) } });
      }
    }
    N.setCookie('sm_ui_original', null);
    L.setCookie('sm_ui_original', null);
    await confirm();
    {
      // (each server's own id)
      const [a, b] = await Promise.all([N.request('DELETE', `/api/ui-packs/${redIds.node}`), L.request('DELETE', `/api/ui-packs/${redIds.lean}`)]);
      const d = diff(snapshot(a, { json: true }), snapshot(b, { json: true }));
      if (d.length) { report.different++; report.diffs.push({ label: 'DELETE the uploaded pack', diffs: d }); } else report.same++;
    }
    await api('GET /api/ui-packs (after delete)', 'GET', '/api/ui-packs');

    // ---- early data: the main page asks for what it asked for the last two times
    const open = async (calls) => {
      const pages2 = await Promise.all([N.request('GET', '/'), L.request('GET', '/')]);
      for (const c of calls) await Promise.all([N.request('GET', c, { headers: { 'Sec-Fetch-Dest': 'empty' } }), L.request('GET', c, { headers: { 'Sec-Fetch-Dest': 'empty' } })]);
      await Promise.all([N.request('GET', '/api/settings', { headers: { 'Sec-Fetch-Dest': 'image' } }), L.request('GET', '/api/settings', { headers: { 'Sec-Fetch-Dest': 'image' } })]);
      await sleep(2300);
      return pages2;
    };
    await open(['/api/vehicles', '/api/settings?x=1']);
    await open(['/api/vehicles', '/api/settings?x=2']);
    await learnVersion();
    await check('early data: GET / after two openings', 'GET', '/');

    // ---- an export (ffmpeg): POST, the list, the file
    const vehicles = JSON.parse((await N.request('GET', '/api/vehicles')).body);
    const v = vehicles.vehicles[0];
    const clip = (root) => {
      const at = (cam) => path.join(root, 'TeslaCam', 'RecentClips', `2024-05-01_08-00-00-${cam}.mp4`);
      return { clips: [{ key: '2024-05-01_08-00-00', files: { front: at('front'), back: at('back') }, from: 0.5, to: 2.5 }, { key: '2024-05-01_08-01-00', files: { front: at('front').replace('08-00-00', '08-01-00') }, from: 0, to: 1.5 }] };
    };
    const nodeRoot = v.root;
    const leanRoot = path.join(dir, 'lean', 'footage');
    const startBoth = async (label, p, bodies) => {
      const [a, b] = await Promise.all([N.request('POST', p, { body: bodies[0] }), L.request('POST', p, { body: bodies[1] })]);
      const drop = ['id', 'jobId', 'createdAt', 'finishedAt'];
      const d = diff(snapshot(a, { json: true, drop }), snapshot(b, { json: true, drop }));
      if (d.length) { report.different++; report.diffs.push({ label, diffs: d }); } else report.same++;
      return [JSON.parse(a.body), JSON.parse(b.body)];
    };
    await startBoth('POST /api/vehicles/:id/exports (refused: no clips)', `/api/vehicles/${v.id}/exports`, [{ clips: [] }, { clips: [] }]);
    await startBoth('POST /api/vehicles/nope/exports', '/api/vehicles/nope/exports', [clip(nodeRoot), clip(leanRoot)]);
    await startBoth('POST /api/exports (not footage)', '/api/exports', [{ clips: [{ key: '2024-05-01_08-00-00', files: { front: '/etc/passwd' }, from: 0, to: 2 }] }, { clips: [{ key: '2024-05-01_08-00-00', files: { front: '/etc/passwd' }, from: 0, to: 2 }] }]);
    await startBoth('POST /api/vehicles/:id/exports (outside)', `/api/vehicles/${v.id}/exports`, [{ clips: [{ key: '2024-05-01_08-00-00', files: { front: '/etc/passwd' }, from: 0, to: 2 }] }, { clips: [{ key: '2024-05-01_08-00-00', files: { front: '/etc/passwd' }, from: 0, to: 2 }] }]);
    const [xa, xb] = await startBoth('POST /api/vehicles/:id/exports', `/api/vehicles/${v.id}/exports`, [clip(nodeRoot), clip(leanRoot)]);
    for (let i = 0; i < 300; i++) {
      const [a, b] = await Promise.all([N.request('GET', `/api/exports/${xa.id}`), L.request('GET', `/api/exports/${xb.id}`)]);
      if (!['waiting', 'running'].includes(JSON.parse(a.body).state) && !['waiting', 'running'].includes(JSON.parse(b.body).state)) break;
      await sleep(300);
    }
    {
      const drop = ['id', 'jobId', 'createdAt', 'finishedAt', 'bytes'];
      const [a, b] = await Promise.all([N.request('GET', `/api/exports/${xa.id}`), L.request('GET', `/api/exports/${xb.id}`)]);
      const d = diff(snapshot(a, { json: true, drop }), snapshot(b, { json: true, drop }));
      if (d.length) { report.different++; report.diffs.push({ label: 'GET /api/exports/:id (done)', diffs: d }); } else report.same++;
      const [la, lb] = await Promise.all([N.request('GET', '/api/exports'), L.request('GET', '/api/exports')]);
      const dl = diff(snapshot(la, { json: true, drop }), snapshot(lb, { json: true, drop }));
      if (dl.length) { report.different++; report.diffs.push({ label: 'GET /api/exports (one done)', diffs: dl }); } else report.same++;
      const [fa, fb] = await Promise.all([N.request('GET', `/api/exports/${xa.id}/file`), L.request('GET', `/api/exports/${xb.id}/file`)]);
      const probe = (buf) => {
        const f = path.join(dir, `probe-${crypto.randomBytes(4).toString('hex')}.mp4`);
        fs.writeFileSync(f, buf);
        const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_name', '-of', 'json', f], { encoding: 'utf8' });
        const j = JSON.parse(r.stdout || '{}');
        return { streams: j.streams, duration: Math.round(Number(j.format?.duration) * 10) / 10 };
      };
      const sa = { ...snapshot(fa), body: probe(fa.body) };
      const sb = { ...snapshot(fb), body: probe(fb.body) };
      const df = diff(sa, sb);
      if (df.length) { report.different++; report.diffs.push({ label: 'GET /api/exports/:id/file', diffs: df }); } else report.same++;
      console.log(`export: node ${fa.body.length} bytes, lean ${fb.body.length} bytes`);
    }
    await api('DELETE /api/exports/:id (done: false)', 'DELETE', `/api/exports/${xa.id}`);
    // one at a time: the second waits; cancelled while it waits, and while it runs
    {
      const one = (root) => ({ ...clip(root), camera: 'front', units: 'kmh', privacy: true });
      const [r1a, r1b] = await startBoth('POST /api/vehicles/:id/exports (a second, one camera)', `/api/vehicles/${v.id}/exports`, [one(nodeRoot), one(leanRoot)]);
      const [r2a, r2b] = await startBoth('POST /api/vehicles/:id/exports (a third: waits)', `/api/vehicles/${v.id}/exports`, [clip(nodeRoot), clip(leanRoot)]);
      const same = async (label, pa, pb, method = 'GET') => {
        const drop = ['id', 'jobId', 'createdAt', 'finishedAt', 'bytes', 'done', 'progress'];
        const [a, b] = await Promise.all([N.request(method, pa), L.request(method, pb)]);
        const d = diff(snapshot(a, { json: true, drop }), snapshot(b, { json: true, drop }));
        if (d.length) { report.different++; report.diffs.push({ label, diffs: d }); } else report.same++;
      };
      await same('DELETE a waiting export', `/api/exports/${r2a.id}`, `/api/exports/${r2b.id}`, 'DELETE');
      await same('GET a cancelled waiting export', `/api/exports/${r2a.id}`, `/api/exports/${r2b.id}`);
      await same('DELETE it again', `/api/exports/${r2a.id}`, `/api/exports/${r2b.id}`, 'DELETE');
      for (let i = 0; i < 300; i++) {
        const [a, b] = await Promise.all([N.request('GET', `/api/exports/${r1a.id}`), L.request('GET', `/api/exports/${r1b.id}`)]);
        if (!['waiting', 'running'].includes(JSON.parse(a.body).state) && !['waiting', 'running'].includes(JSON.parse(b.body).state)) break;
        await sleep(300);
      }
      await same('GET the one-camera privacy export (done)', `/api/exports/${r1a.id}`, `/api/exports/${r1b.id}`);
      const [fa, fb] = await Promise.all([N.request('GET', `/api/exports/${r1a.id}/file`), L.request('GET', `/api/exports/${r1b.id}/file`)]);
      const d = diff(snapshot(fa, { ignoreBody: true }), snapshot(fb));
      delete d.body;
      const dd = d.filter((x) => x.path !== '.body');
      if (dd.length) { report.different++; report.diffs.push({ label: 'GET the privacy export file', diffs: dd }); } else report.same++;
      console.log(`privacy export: node ${fa.body.length} bytes (x264 named: ${fa.body.includes('x264')}), lean ${fb.body.length} bytes (x264 named: ${fb.body.includes('x264')})`);
      await same('GET /api/exports (all)', '/api/exports', '/api/exports');
    }
  } finally {
    if (node) node.child.kill('SIGTERM');
    if (lean) lean.child.kill('SIGTERM');
    await sleep(300);
    if (!keep) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  for (const d of report.diffs) {
    console.log(`DIFF  ${d.label}`);
    for (const x of d.diffs.slice(0, 6)) console.log(`        ${x.path}: node ${brief(x.node)}, lean ${brief(x.lean)}${x.hint || ''}`);
  }
  console.log(`${report.different ? 'FAIL' : 'PASS'}: ${report.same} of ${report.same + report.different} answers the same.`);
  if (arg('json')) fs.writeFileSync(arg('json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

main().then((r) => process.exit(r.different ? 1 : 0), (err) => {
  console.error(err.stack || err.message);
  process.exit(2);
});
