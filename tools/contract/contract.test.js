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

const REPO = path.join(__dirname, '..', '..');
const lib = require('./lib');
const spec = require('./spec');
const { record, plan, allowed } = require('./record');
const { compare } = require('./compare');

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

test('spec: every GET route with parameters is recorded or skipped', () => {
  const contract = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'api-contract.json'), 'utf8'));
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
  const dir = path.join(REPO, 'lean', 'tests', 'fixtures', 'contract', 'goldens');
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

test('frozen: the host\'s own facts are kept as their type, nothing else', () => {
  const { machine } = require('./frozen');
  const recorded = { body: { runningAsRoot: true, other: 1 } };
  const here = { body: { runningAsRoot: false, other: 1 } };
  assert.deepEqual(machine(recorded, 'GET /api/security', false), machine(here, 'GET /api/security', false));
  assert.deepEqual(machine(here, 'GET /api/security', false), { body: { runningAsRoot: '<boolean>', other: 1 } });
  assert.deepEqual(here.body.runningAsRoot, false, 'the answer itself is not changed');
  // a missing field, or one of another type, still differs
  assert.notDeepEqual(machine(recorded, 'GET /api/security', false), machine({ body: { other: 1 } }, 'GET /api/security', false));
  assert.notDeepEqual(machine(recorded, 'GET /api/security', false), machine({ body: { runningAsRoot: 'yes', other: 1 } }, 'GET /api/security', false));
  // only on its route and at its place
  assert.deepEqual(machine({ body: { runningAsRoot: true } }, 'GET /api/system', false), { body: { runningAsRoot: true } });
  const info = (name) => ({ body: { hardware: { devices: [{ id: 'cpu', name }] }, name: 'main' } });
  assert.deepEqual(machine(info('Intel Xeon'), 'GET /node/v1/info', false), machine(info('AMD EPYC'), 'GET /node/v1/info', false));
  assert.equal(machine(info('Intel Xeon'), 'GET /node/v1/info', false).body.name, 'main');
  const limits = (memoryBytes, tier) => ({ body: { resources: { memoryBytes, cpus: 4 }, tier } });
  assert.deepEqual(machine(limits(16869126144, 'a'), 'GET /api/settings/work-limits', false), machine(limits(16760344576, 'a'), 'GET /api/settings/work-limits', false));
  assert.notDeepEqual(machine(limits(16869126144, 'a'), 'GET /api/settings/work-limits', false), machine(limits(16869126144, 'b'), 'GET /api/settings/work-limits', false), 'what the memory decides still counts');
});
