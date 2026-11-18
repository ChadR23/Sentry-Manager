'use strict';

// tools/contract/: the API contract read from the source, the normalisers
// and diff behind record.js / compare.js, and both tools end to end against
// a small fake server (a few milliseconds; the real server is not started).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const lib = require('../tools/contract/lib');
const routes = require('../tools/contract/routes');
const spec = require('../tools/contract/spec');
const { record, plan, allowed } = require('../tools/contract/record');
const { compare } = require('../tools/contract/compare');

test('normalise: server times go, footage times and durations stay', () => {
  const now = Date.UTC(2026, 10, 14, 12);
  const out = lib.normalise({
    checkedAt: now - 5000, // the server's clock: replaced
    mtimeMs: Date.UTC(2024, 4, 1, 8), // a clip's own time: kept
    eventAt: '2024-05-03 10:00:00',
    at: '2026-11-14T11:59:00Z',
    durationMs: 63000,
    seconds: 63,
    runAt: '03:30',
    note: 'made 2026-11-14T11:00:00.000Z from clip 2024-05-01T08:00:00',
    nested: { scannedAt: null, uptimeS: 99, fingerprint: 'AA:BB' }
  }, [], { now });
  assert.deepEqual(out, {
    at: '<time>', checkedAt: '<time>', durationMs: 63000, eventAt: '2024-05-03 10:00:00', mtimeMs: Date.UTC(2024, 4, 1, 8),
    nested: { fingerprint: '<id>', scannedAt: null, uptimeS: '<number>' },
    note: 'made <iso-time> from clip 2024-05-01T08:00:00', runAt: '03:30', seconds: 63
  });
});

test('normalise: path rules, folders in keys and values, shape, keys, sorting', () => {
  const replace = [['/srv/fx1/footage', '{root:car}'], ['/srv/fx1/data', '{data}']];
  const out = lib.normalise({
    speeds: { '/srv/fx1/footage/TeslaCam/a-front.mp4': [10, 11] },
    root: '/srv/fx1/footage',
    out: '/srv/fx1/data/converted',
    storage: { free: 123, total: 456 },
    cpu: { usage: 99, perCore: [1, 2], temp: null },
    disks: [{ name: 'vda', busy: null }, { name: 'vdb', busy: 3 }],
    list: [{ n: 'b' }, { n: 'a' }],
    detail: '29.0 GB free of 252.0 GB'
  }, [
    { path: 'storage.free', as: 'bytes' },
    { path: 'cpu', as: 'keys' },
    { path: 'disks', as: 'shape' },
    { path: 'list', sortBy: 'n' },
    { strings: [[/\d+(\.\d+)? ?[KMGT]?B free( of \d+(\.\d+)? ?[KMGT]?B)?/, '<space> free']] }
  ], { replace });
  assert.deepEqual(out, {
    cpu: { perCore: '<value>', temp: '<value>', usage: '<value>' },
    detail: '<space> free',
    disks: [{ busy: '<value>', name: '<value>' }],
    list: [{ n: 'a' }, { n: 'b' }],
    out: '{data}/converted',
    root: '{root:car}',
    speeds: { '{root:car}/TeslaCam/a-front.mp4': [10, 11] },
    storage: { free: '<bytes>', total: 456 }
  });
  assert.deepEqual(lib.normalise({ a: { b: 1 } }, [{ path: '**', as: 'shape' }]), { a: { b: '<value>' } });
  assert.throws(() => lib.normalise({ a: 1 }, [{ path: 'a', as: 'nonsense' }]), /Unknown normaliser/);
});

test('diff: changed values, missing keys and lengths', () => {
  assert.deepEqual(lib.diff({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }), []);
  const d = lib.diff({ a: 1, b: [1, 2], c: { x: 'y' }, gone: true }, { a: 2, b: [1], c: { x: 'z' }, extra: 0 });
  assert.deepEqual(d.map((x) => x.path), ['a', 'b.length', 'c.x', 'extra', 'gone']);
  assert.deepEqual(d.find((x) => x.path === 'gone'), { path: 'gone', golden: true, actual: '<absent>' });
  assert.deepEqual(lib.diff(null, {}), [{ path: '(root)', golden: null, actual: {} }]);
  assert.equal(lib.diff({ n: 1 }, { n: '1' }).length, 1, 'a number and its text differ');
});

test('snapshot: JSON, text and bytes, with only the headers that matter', () => {
  const res = (type, body, extra = {}) => ({ status: 200, headers: { 'content-type': type, date: 'now', 'content-length': '9', ...extra }, body: Buffer.from(body) });
  const j = lib.snapshot(res('application/json', '{"at":1,"n":[2]}'), {}, {});
  assert.deepEqual(j, { status: 200, headers: { 'content-type': 'application/json' }, body: { at: 1, n: [2] } });
  assert.equal(lib.snapshot(res('text/csv', 'a,b\n1,2\n'), { text: 'firstLine' }).body, 'a,b');
  const v = lib.snapshot(res('video/mp4', 'xyz', { 'content-range': 'bytes 0-2/3', 'accept-ranges': 'bytes' }));
  assert.equal(v.body.bytes, 3);
  assert.match(v.body.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(v.headers).sort(), ['accept-ranges', 'content-range', 'content-type']);
  assert.equal(lib.snapshot(res('image/jpeg', 'x'), { body: 'ignore' }).body, '<ignored>');
});

test('client: never sends a password over plain HTTP', async () => {
  const c = lib.createClient({ base: 'http://127.0.0.1:9' });
  await assert.rejects(c.login('admin', 'secret'), /plain HTTP/);
  c.close();
});

test('the contract: every router route found, every UI call has a route', () => {
  const c = routes.build();
  const src = fs.readFileSync(path.join(REPO, 'server', 'index.js'), 'utf8');
  const adds = [...src.matchAll(/^\s*r\.add\('(\w+)', '([^']+)'/gm)].map((m) => `${m[1]} ${m[2]}`);
  const found = new Set(c.routes.map((r) => `${r.method} ${r.path}`));
  for (const a of adds) assert.ok(found.has(a), `${a} is in the contract`);
  assert.equal(c.totals.serverRouterRoutes, adds.length);
  for (const p of ['GET /api/events', 'GET /api/converter/events', 'GET /api/media', 'GET /api/scrub', 'POST /api/ui-packs/upload', 'GET /healthz', 'POST /api/can/logs/:name', 'GET /node/v1/info']) {
    assert.ok(found.has(p), `${p} (answered by hand) is in the contract`);
  }
  assert.ok(c.totals.serverDistinctApiPaths >= 150, 'about 157 distinct /api paths');
  assert.deepEqual(c.mismatches.uiCallsWithoutRoute, [], 'every page call has a server route');
  assert.equal(c.liveChannels.length, 2);
  assert.ok(c.liveChannels[0].events.find((e) => e.event === 'changed').topics.includes('inventory'));
  const me = c.routes.find((r) => r.path === '/api/auth/me');
  assert.equal(me.access, 'public');
  assert.equal(c.routes.find((r) => r.method === 'GET' && r.path === '/api/accounts').access, 'admin');
  assert.equal(c.routes.find((r) => r.method === 'POST' && r.path === '/api/ui-packs/upload').confirmPassword, true);
});

test('UI calls: the method is read from the call', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-contract-ui-'));
  const f = path.join(dir, 'page.js');
  fs.writeFileSync(f, [
    "api('/api/vehicles');",
    "api(`/api/vehicles/${id}/scan`, { body: {} });",
    "api(`/api/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' });",
    "call('POST', vid ? `/api/vehicles/${encodeURIComponent(vid)}/exports` : '/api/exports', { a: 1 });",
    "api('/api/bin/' + encodeURIComponent(id) + '/' + action, { body: {} });",
    "const html = `<a href=\"/api/logs/archive/${encodeURIComponent(a.name)}\" download>`;",
    "fetch(`${location.origin}/healthz`);",
    "// api('/api/not-a-call')",
    "if (p.startsWith('/api/')) x();"
  ].join('\n'));
  const calls = routes.uiCalls([f]).map((c) => `${c.method} ${c.path}`);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(calls, [
    'GET /api/vehicles', 'POST /api/vehicles/{…}/scan', 'DELETE /api/nodes/{…}',
    'POST /api/vehicles/{…}/exports', 'POST /api/exports', 'POST /api/bin/{…}/{…}',
    'GET /api/logs/archive/{…}', 'GET /healthz'
  ]);
});

test('spec: every GET route with parameters is recorded or skipped', () => {
  const contract = routes.build();
  const ctx = { vehicles: [{ id: 'car', root: '/r', days: ['2024-05-01'], categories: ['Recent'], recordings: ['r1'], clips: ['TeslaCam/RecentClips/a-front.mp4'] }], data: '/d' };
  const { missing, routes: p } = plan(contract, ctx);
  assert.deepEqual(missing, []);
  for (const r of p) if (!r.skip) assert.ok(r.requests.length, `${r.key} asks something`);
  assert.throws(() => allowed(contract, writeTmp([{ method: 'GET', path: '/api/vehicles' }])), /only non-GET/);
  assert.throws(() => allowed(contract, writeTmp([{ method: 'POST', path: '/api/nothing' }])), /not a route/);
  assert.equal(allowed(contract, writeTmp([{ method: 'POST', path: '/api/vehicles/car/scan', body: {} }]))[0].key, 'POST /api/vehicles/:id/scan');
});

function writeTmp(value) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sm-contract-')), 'allow.json');
  fs.writeFileSync(f, JSON.stringify(value));
  return f;
}

test('the committed sample goldens are well formed', () => {
  const dir = path.join(__dirname, 'fixtures', 'contract');
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.ok(index.goldens.length >= 5);
  for (const g of index.goldens) {
    const golden = JSON.parse(fs.readFileSync(path.join(dir, g.file), 'utf8'));
    assert.equal(golden.route, g.route);
    assert.equal(typeof golden.response.status, 'number');
    assert.ok(!JSON.stringify(golden).includes(os.tmpdir()), `${g.file}: no machine folder in it`);
  }
  const speeds = JSON.parse(fs.readFileSync(path.join(dir, index.goldens.find((g) => g.route === 'GET /api/vehicles/:id/speeds').file), 'utf8'));
  assert.deepEqual(Object.values(speeds.response.body.speeds), [[10, 11, 12], [14, 15, 16], [0, 1]]);
});

test('record and compare against a fake server: the same passes, a changed speed fails', async () => {
  let speeds = [10, 11, 12];
  const root = '/srv/one/footage';
  const answers = () => ({
    '/api/studio/context': { version: 'x', vehicles: [{ id: 'car', root }], outputRoots: ['/srv/one/data/converted'] },
    '/api/vehicles': { vehicles: [{ id: 'car', root, share: { checkedAt: Date.now() } }] },
    '/api/vehicles/car/days': { days: [{ day: '2024-05-01' }] },
    '/api/vehicles/car/recordings': { recordings: [{ id: 'r1', category: 'Recent' }] },
    '/api/vehicles/car/recordings/r1': { files: [{ rel: 'TeslaCam/RecentClips/2024-05-01_08-00-00-front.mp4' }] },
    '/api/vehicles/car/speeds': { speeds: { [`${root}/TeslaCam/RecentClips/2024-05-01_08-00-00-front.mp4`]: speeds } },
    '/api/speeds/status': { running: false, done: 1, total: 1, finishedAt: Date.now() }
  });
  const seen = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push(`${req.method} ${u.pathname} ${req.headers.cookie || ''}`);
    const body = answers()[u.pathname];
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json', Date: new Date().toUTCString() });
    res.end(JSON.stringify(body || { error: 'Not found' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-contract-rec-'));
  const contractFile = path.join(dir, 'contract.json');
  fs.writeFileSync(contractFile, JSON.stringify({
    totals: {},
    routes: [
      { method: 'GET', path: '/api/vehicles/:id/speeds' },
      { method: 'GET', path: '/api/speeds/status' },
      { method: 'POST', path: '/api/vehicles/:id/scan' }
    ]
  }));
  process.env.SM_CONTRACT_TEST_COOKIE = 'sm_session=abcdefghijklmnop';
  const args = { base: `http://127.0.0.1:${server.address().port}`, 'cookie-env': 'SM_CONTRACT_TEST_COOKIE', contract: contractFile, out: path.join(dir, 'g'), goldens: path.join(dir, 'g') };
  const log = console.log;
  console.log = () => {};
  try {
    const index = await record(args);
    assert.equal(index.goldens.length, 2);
    assert.ok(seen.every((s) => s.startsWith('GET ')), 'nothing but GET without an allow file');
    assert.ok(seen.every((s) => s.endsWith('sm_session=abcdefghijklmnop')), 'signed in on every call');
    assert.equal((await compare(args)).different, 0);
    speeds = [10, 11, 13];
    const r = await compare(args);
    assert.equal(r.different, 1);
    assert.deepEqual(r.byRoute['GET /api/vehicles/:id/speeds'].answers[0].diffs.map((d) => d.path), ['body.speeds.{root:car}/TeslaCam/RecentClips/2024-05-01_08-00-00-front.mp4[2]']);
  } finally {
    console.log = log;
    delete process.env.SM_CONTRACT_TEST_COOKIE;
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
