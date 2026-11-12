'use strict';

// The heartbeat's optional fields (server/reportsProtocol.js
// HEARTBEAT_OPTIONAL, docs/reports-api.md "The heartbeat"): a heartbeat
// without them is still right (older Managers); each one, when there, is
// checked strictly (exact keys at every level, types, limits, plain text);
// the worst case of every field at its limit fits in 4096 bytes; the Manager
// fills them in (normalizeHeartbeat, buildPayload: crashes from its own
// notes, text through the scrubber), anonymous ones included, with no
// identifiers; and convertStats.js gives the convert block.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../server/reportsProtocol');
const { createReports, normalizeHeartbeat, plainText } = require('../server/reports');
const { createConvertStats, apiOf, codecOf } = require('../server/convertStats');
const { usableGpus } = require('../server/gpu');
const { startReceiver } = require('./fixtures/reportsReceiver');

const L = P.HEARTBEAT_LIMITS;
const OLD = {
  uptimeSec: 7210, health: { overall: 'warn', warnings: 1, problems: 0 }, vehicles: 2, footageBytes: 812345678901, recordings: 4210,
  spaceSavedBytes: 301234567890, distanceKm: 18234.7, freeBytes: 1200000000000, totalBytes: 4000000000000, converting: false, jobsQueued: 0,
  features: { can: true, sentryUsbPaired: false, gpu: true }
};
const NEW = {
  footageSeconds: 912345, platform: 'linux', arch: 'x64', cpu: 'AMD Ryzen 7 5800X 8-Core Processor', gpus: ['NVIDIA GeForce RTX 4070', 'AMD Radeon Graphics (renoir)'],
  cars: [{ model: 'Model Y', firmware: '2025.14.3.1' }, { model: null, firmware: null }], clips24h: { sentry: 40, dashcam: 1200 },
  convert: { fps: 412.3, encoder: 'hevc_nvenc', device: 'NVIDIA GeForce RTX 4070', api: 'nvenc', codec: 'h265' }, crashes24h: 2,
  host: { os: 'truenas', docker: true }
};
const payload = (heartbeat) => ({
  kind: 'heartbeat', sentAt: '2026-11-11T21:04:07.112Z', install: 'ANON', anonymous: true,
  build: { build: 131, sha: '9b50039', builtAt: '2026-11-11T20:09:31Z', tag: 'latest' }, ui: 'horizon', heartbeat
});
const errsOf = (h) => P.validatePayload(payload(h));
const clone = (x) => structuredClone(x);

test('an old-style heartbeat without any of the new fields is right', () => {
  assert.deepEqual(errsOf(clone(OLD)), []);
});

test('one with every new field is right; any subset of them is right too', () => {
  assert.deepEqual(errsOf({ ...clone(OLD), ...clone(NEW) }), []);
  for (const k of Object.keys(NEW)) assert.deepEqual(errsOf({ ...clone(OLD), [k]: clone(NEW[k]) }), [], k);
  // the nullable ones as null, and empty lists
  assert.deepEqual(errsOf({ ...clone(OLD), cpu: null, gpus: [], cars: [], convert: { fps: null, encoder: null, device: null, api: null, codec: null }, host: { os: null, docker: false } }), []);
  // every host word is right, in a container or not
  for (const os of P.HEARTBEAT_HOST_OS) for (const docker of [true, false]) assert.deepEqual(errsOf({ ...clone(OLD), host: { os, docker } }), [], os);
  assert.deepEqual(P.HEARTBEAT_HOST_OS, ['truenas', 'unraid', 'synology', 'qnap', 'wsl', 'macos', 'raspberry-pi', 'ubuntu', 'debian', 'fedora', 'linux']);
  assert.deepEqual(Object.keys(P.HEARTBEAT_OPTIONAL).sort(), Object.keys(NEW).sort());
});

// [field, bad values (wrong type), out of range / too long]
const s = (n) => 'a'.repeat(n);
const BAD = {
  footageSeconds: { type: ['1', null, true, {}, 1.5], range: [-1, 1e12 + 1, Infinity] },
  platform: { type: [1, null, [], {}], range: ['', s(L.platform + 1)] },
  arch: { type: [64, null, ['x64']], range: ['', s(L.arch + 1)] },
  cpu: { type: [1, true, ['x']], range: ['', s(L.cpu + 1)] },
  gpus: { type: ['NVIDIA', null, {}, [1], [null], [{}]], range: [Array(L.gpus + 1).fill('GPU'), [s(L.gpu + 1)], ['']] },
  cars: { type: [{}, 'Model Y', null, ['Model Y'], [null], [{ model: 1, firmware: null }], [{ model: null, firmware: 2025 }]], range: [Array(L.cars + 1).fill({ model: null, firmware: null }), [{ model: s(L.model + 1), firmware: null }], [{ model: null, firmware: s(L.firmware + 1) }], [{ model: '', firmware: null }]] },
  clips24h: { type: [[], 5, null, { sentry: '1', dashcam: 0 }, { sentry: 0, dashcam: null }], range: [{ sentry: -1, dashcam: 0 }, { sentry: 0, dashcam: 1e6 + 1 }, { sentry: 0.5, dashcam: 0 }] },
  convert: {
    type: [[], 'nvenc', null, { ...NEW.convert, fps: '400' }, { ...NEW.convert, encoder: 5 }, { ...NEW.convert, device: [] }, { ...NEW.convert, api: true }, { ...NEW.convert, codec: {} }],
    range: [{ ...NEW.convert, fps: -1 }, { ...NEW.convert, fps: 100_000.1 }, { ...NEW.convert, fps: 1.23 }, { ...NEW.convert, fps: NaN }, { ...NEW.convert, encoder: s(L.encoder + 1) }, { ...NEW.convert, device: s(L.device + 1) }, { ...NEW.convert, api: s(L.api + 1) }, { ...NEW.convert, codec: s(L.codec + 1) }]
  },
  crashes24h: { type: ['0', null, false], range: [-1, 10_001, 0.5] },
  host: {
    type: [[], 'truenas', null, true, { os: 1, docker: true }, { os: ['wsl'], docker: false }, { os: 'wsl', docker: 'true' }, { os: 'wsl', docker: null }, { os: 'wsl', docker: 1 }],
    range: [{ os: 'windows', docker: false }, { os: 'TrueNAS', docker: true }, { os: '', docker: false }, { os: '6.6.44-production+truenas', docker: true }, { os: 'linux ', docker: false }]
  }
};

for (const [k, { type, range }] of Object.entries(BAD)) {
  test(`${k}: wrong types and out-of-range values are refused`, () => {
    for (const v of [...type, ...range]) {
      const errs = errsOf({ ...clone(OLD), ...clone(NEW), [k]: v });
      assert.ok(errs.length > 0, `${k} = ${JSON.stringify(v)} should be refused`);
      assert.ok(errs.every((e) => e.includes(`heartbeat.${k}`)), `${k}: ${errs.join(', ')}`);
    }
    // undefined (present but not JSON) is no value either
    assert.ok(errsOf({ ...clone(OLD), [k]: undefined }).length > 0);
  });
}

test('extra keys are refused at every level', () => {
  assert.match(errsOf({ ...clone(OLD), ...clone(NEW), vin: 'x' }).join(), /unknown field heartbeat\.vin/);
  assert.match(errsOf({ ...clone(OLD), ...clone(NEW), cars: [{ model: 'Model Y', firmware: null, name: 'Daily Driver' }] }).join(), /unknown field heartbeat\.cars\[0\]\.name/);
  assert.match(errsOf({ ...clone(OLD), ...clone(NEW), clips24h: { sentry: 1, dashcam: 2, saved: 3 } }).join(), /unknown field heartbeat\.clips24h\.saved/);
  assert.match(errsOf({ ...clone(OLD), ...clone(NEW), convert: { ...NEW.convert, node: 'Garage PC' } }).join(), /unknown field heartbeat\.convert\.node/);
  // and a missing key in an object with exact keys
  assert.match(errsOf({ ...clone(OLD), ...clone(NEW), cars: [{ model: 'Model Y' }] }).join(), /heartbeat\.cars\[0\]\.firmware missing/);
  assert.match(errsOf({ ...clone(OLD), ...clone(NEW), clips24h: { sentry: 1 } }).join(), /heartbeat\.clips24h\.dashcam missing/);
  assert.match(errsOf({ ...clone(OLD), ...clone(NEW), host: { os: 'wsl', docker: true, kernel: '5.15.153.1-microsoft-standard-WSL2' } }).join(), /unknown field heartbeat\.host\.kernel/);
  assert.match(errsOf({ ...clone(OLD), ...clone(NEW), host: { os: 'wsl', docker: true, hostname: 'tower' } }).join(), /unknown field heartbeat\.host\.hostname/);
  assert.match(errsOf({ ...clone(OLD), ...clone(NEW), host: { os: 'wsl' } }).join(), /heartbeat\.host\.docker missing/);
  assert.match(errsOf({ ...clone(OLD), ...clone(NEW), host: { docker: true } }).join(), /heartbeat\.host\.os missing/);
  const { codec: _c, ...noCodec } = NEW.convert;
  assert.match(errsOf({ ...clone(OLD), ...clone(NEW), convert: noCodec }).join(), /heartbeat\.convert\.codec missing/);
});

test('text: control, format and non-ASCII characters, quotes, backslashes and untrimmed text are refused', () => {
  const bad = ['line\nbreak', 'tab\there', 'nul\u0000', 'del\u007f', 'c1\u0085', 'zero​width', 'bidi‮override', 'line sep', 'Radeon™', 'café', 'quote"d', 'back\\slash', ' lead', 'trail ', '\ud800'];
  for (const t of bad) {
    for (const h of [{ cpu: t }, { platform: t }, { arch: t }, { gpus: [t] }, { cars: [{ model: t, firmware: null }] }, { cars: [{ model: null, firmware: t }] }, { convert: { ...NEW.convert, device: t } }, { convert: { ...NEW.convert, encoder: t } }]) {
      assert.ok(errsOf({ ...clone(OLD), ...h }).length > 0, `${JSON.stringify(h)} should be refused`);
    }
  }
  assert.equal(P.isPlain('Intel(R) Core(TM) i7-8700 CPU @ 3.20GHz', 120), true);
  // the Manager's side makes such text plain before it is checked
  assert.equal(plainText('  Intel(R)\tCore(TM)  i7 \n', 120), 'Intel(R) Core(TM) i7');
  assert.equal(plainText('AMD Radeon™ Graphics', 120), 'AMD RadeonTM Graphics');
  assert.equal(plainText('café "x" \\ \u0000‮', 120), 'cafe x');
  assert.equal(plainText('\u0000\u0001', 120), null);
  assert.equal(plainText(s(200), 120).length, 120);
});

test('the worst case of every field at its limit (the common fields at theirs too) fits in 4096 bytes', () => {
  const big = Number.MAX_SAFE_INTEGER;
  // a control character is 6 bytes as JSON: the common text fields' worst case
  const esc = (n) => '\u0001'.repeat(n);
  const p = {
    kind: 'heartbeat', sentAt: 'Wednesday, 11 November 2026 18:40:19 UTC', install: 'f'.repeat(32), anonymous: false,
    build: { build: big, sha: 'f'.repeat(64), builtAt: esc(P.LIMITS.builtAt), tag: esc(P.LIMITS.tag) }, ui: esc(P.LIMITS.ui),
    heartbeat: {
      uptimeSec: 100 * 365 * 86400, health: { overall: 'problem', warnings: 1000, problems: 1000 }, vehicles: 1000, footageBytes: big, recordings: 1e9,
      spaceSavedBytes: big, distanceKm: 9999999.9, freeBytes: big - 1, totalBytes: big, converting: false, jobsQueued: 100_000,
      features: { can: false, sentryUsbPaired: false, gpu: false },
      footageSeconds: 1e12, platform: s(L.platform), arch: s(L.arch), cpu: s(L.cpu), gpus: Array(L.gpus).fill(s(L.gpu)),
      cars: Array(L.cars).fill({ model: s(L.model), firmware: s(L.firmware) }), clips24h: { sentry: 1e6, dashcam: 1e6 },
      convert: { fps: 99999.9, encoder: s(L.encoder), device: s(L.device), api: s(L.api), codec: s(L.codec) }, crashes24h: 10_000,
      // the longest host word
      host: { os: [...P.HEARTBEAT_HOST_OS].sort((a, b) => b.length - a.length)[0], docker: false }
    }
  };
  assert.equal(p.sentAt.length, P.LIMITS.sentAt);
  assert.deepEqual(P.validatePayload(p), []);
  const size = Buffer.byteLength(JSON.stringify(p));
  assert.ok(size <= P.HEARTBEAT_MAX_BYTES, `${size} bytes`);
  assert.equal(size, 3812, 'the worst case docs/reports-api.md gives');
  // one more of anything that can grow is refused, not sent larger
  assert.ok(P.validatePayload({ ...p, heartbeat: { ...p.heartbeat, cars: [...p.heartbeat.cars, { model: null, firmware: null }] } }).length > 0);
});

test('normalizeHeartbeat fills in every optional field, plain and within the limits, and nothing else', () => {
  const h = normalizeHeartbeat({
    ...OLD, footageSeconds: 12.6, platform: 'linux', arch: 'arm64', cpu: ' Cortex-A76 ', gpus: ['A', '', null, 'B', 'C', 'D', 'E'],
    cars: [{ model: 'Y', firmware: '2025.14.3.1', vin: '7SAYGDEE1PA000001', name: 'Daily Driver' }, { model: 'Daily Driver', firmware: '/footage/car' }, { model: 'cybertruck' }],
    clips24h: { sentry: 3.4, dashcam: -2 }, convert: { fps: 1e9, encoder: 'libx265', device: 'AMD Ryzen', api: 'cpu', codec: 'h265', node: 'Garage PC' }, crashes24h: 99_999, hostname: 'tower',
    host: { os: 'unraid', docker: 1, kernel: '6.1.106-Unraid' }
  });
  assert.deepEqual(errsOf(h), []);
  assert.equal(h.footageSeconds, 13);
  assert.equal(h.cpu, 'Cortex-A76');
  assert.deepEqual(h.gpus, ['A', 'B', 'C', 'D'], `at most ${L.gpus}`);
  assert.deepEqual(h.cars, [{ model: 'Model Y', firmware: '2025.14.3.1' }, { model: null, firmware: null }, { model: 'Cybertruck', firmware: null }], 'a model from the list only, a firmware only as a version');
  assert.deepEqual(h.clips24h, { sentry: 3, dashcam: 0 });
  assert.deepEqual(h.convert, { fps: 100_000, encoder: 'libx265', device: 'AMD Ryzen', api: 'cpu', codec: 'h265' });
  assert.equal(h.crashes24h, L.crashes);
  assert.equal(h.hostname, undefined);
  assert.deepEqual(h.host, { os: 'unraid', docker: false }, 'exactly os and docker; docker only when true');
  assert.deepEqual(normalizeHeartbeat({ host: { os: '6.6.44-production+truenas', docker: true } }).host, { os: null, docker: true }, 'a word from the list only');
  // more cars than the limit: the first ones
  assert.equal(normalizeHeartbeat({ cars: Array(100).fill({ model: '3' }) }).cars.length, L.cars);
  // from nothing: still right (zeros, nulls, empty lists; no platform or arch it was not told)
  const empty = normalizeHeartbeat({});
  assert.deepEqual(errsOf(empty), []);
  assert.deepEqual(empty.convert, { fps: null, encoder: null, device: null, api: null, codec: null });
  assert.equal('platform' in empty, false);
  assert.equal('host' in empty, false);
  assert.equal(empty.crashes24h, 0);
});

const memoryDb = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, structuredClone(v)) }; };
const quiet = { info() {}, warn() {}, error() {} };
const timer = { set: () => ({}), clear() {} };

test('buildPayload: the heartbeat source fills the fields, crashes24h from the crash notes; anonymous carries no identifiers but keeps the models', async () => {
  const rec = await startReceiver();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-hbfields-'));
  let t = Date.parse('2026-11-12T12:00:00Z');
  const ids = ['tower', 'Daily Driver', '/footage/daily', '192.168.1.20', 'nas.local'];
  // a source that tries to slip identifiers in (they never get through)
  const source = async () => ({
    ...OLD, footageSeconds: 3600, platform: 'linux', arch: 'x64', cpu: 'Intel(R) Core(TM) i5-12400 on tower', gpus: ['Intel graphics (iHD)', 'NVIDIA GeForce RTX 3060 at 192.168.1.20'],
    cars: [{ model: 'Model 3', firmware: null }, { model: 'Daily Driver', firmware: 'nas.local' }], clips24h: { sentry: 5, dashcam: 60 },
    convert: { fps: 250.04, encoder: 'hevc_qsv', device: 'Intel graphics (iHD) in /footage/daily', api: 'qsv', codec: 'h265' }
  });
  const rep = createReports({
    db: memoryDb(), dataDir, log: quiet, buildInfo: { build: 131, sha: '9b50039abcdef0', builtAt: '2026-11-11T00:00:00Z', tag: 'latest' }, ui: () => 'original',
    env: { NODE_ENV: 'test', REPORTS_URL: rec.url, REPORTS_PUBLIC_KEY: rec.keys.publicInfo().line },
    heartbeat: source, identifiers: async () => ids, timer, now: () => t
  });
  try {
    // two notes today, one from two days ago
    t -= 2 * 86_400_000;
    rep.noteCrash(new Error('old one'), 'crash');
    t += 2 * 86_400_000 - 3600_000;
    rep.noteCrash(new Error('one'), 'crash');
    rep.noteCrash(new Error('two'), 'crash');
    t += 3600_000;
    const named = (await rep.buildPayload({ kind: 'heartbeat' })).heartbeat;
    assert.equal(named.crashes24h, 2);
    assert.equal(named.footageSeconds, 3600);
    assert.deepEqual(named.clips24h, { sentry: 5, dashcam: 60 });
    assert.equal(named.convert.fps, 250);
    assert.equal(named.convert.api, 'qsv');
    // no identifiers even when not anonymous: a heartbeat's text is always scrubbed as an anonymous report's
    for (const id of ids) assert.ok(!JSON.stringify(named).includes(id), `${id} is not in a heartbeat`);
    assert.match(named.convert.device, /^Intel graphics \(iHD\) in ANON/);
    assert.deepEqual(named.cars, [{ model: 'Model 3', firmware: null }, { model: null, firmware: null }], 'never a name, even when not anonymous');

    rep.setSettings({ anonymous: true });
    const p = await rep.buildPayload({ kind: 'heartbeat' });
    assert.deepEqual(P.validatePayload(p), []);
    const all = JSON.stringify(p);
    for (const id of ids) assert.ok(!all.includes(id), `${id} is not in an anonymous heartbeat`);
    const h = p.heartbeat;
    assert.equal(h.platform, 'linux');
    assert.equal(h.arch, 'x64');
    assert.match(h.cpu, /^Intel\(R\) Core\(TM\) i5-12400/, 'the CPU model stays');
    assert.equal(h.gpus[0], 'Intel graphics (iHD)', 'GPU models stay');
    assert.match(h.gpus[1], /^NVIDIA GeForce RTX 3060/);
    assert.deepEqual(h.cars, [{ model: 'Model 3', firmware: null }, { model: null, firmware: null }], 'the model stays');
    assert.equal(h.convert.encoder, 'hevc_qsv');
    // and it is what the receiver takes
    rep.setSettings({ share: true });
    assert.equal((await rep.sendHeartbeat()).result, 'sent');
    const sent = rec.openReport(rec.index.find((e) => e.kind === 'heartbeat'));
    assert.deepEqual(P.validatePayload(sent), []);
    assert.equal(sent.heartbeat.crashes24h, 2);
    for (const id of ids) assert.ok(!JSON.stringify(sent).includes(id), id);
  } finally { rep.stop(); await rec.close(); }
});

test('convertStats: the average speed of the last day, the latest encoder, device, API and codec; kept across a restart', () => {
  let t = 1_000_000;
  const db = memoryDb();
  const gpus = { '/dev/dri/renderD128': 'AMD Radeon Graphics (renoir)' };
  const make = () => createConvertStats({ db, now: () => t, deviceName: (e) => gpus[e.device] || null, cpuName: () => 'AMD Ryzen 7 5800X' });
  const cs = make();
  assert.deepEqual(cs.summary(), { fps: null, encoder: null, device: null, api: null, codec: null }, 'nothing converted yet');
  // two clips on the GPU together: one sample of their sum
  assert.equal(cs.sample([{ encoder: 'hevc_vaapi', hardware: true, device: '/dev/dri/renderD128', fps: 200, started: true }, { encoder: 'hevc_vaapi', hardware: true, device: '/dev/dri/renderD128', fps: 100, started: true }]), true);
  let asked = 0;
  assert.equal(cs.sample(() => { asked++; return [{ encoder: 'hevc_vaapi', hardware: true, device: '/dev/dri/renderD128', fps: 999 }]; }), false, 'at most one sample every 30 s');
  assert.equal(asked, 0, 'the encodes are not even asked for before a sample is due');
  t += 30_000;
  // a node's clip and one not started are left out
  cs.sample(() => [{ encoder: 'hevc_vaapi', hardware: true, device: '/dev/dri/renderD128', fps: 100 }, { encoder: 'hevc_nvenc', hardware: true, remote: true, node: 'Garage PC', fps: 900 }, { encoder: 'x', fps: 50, started: false }]);
  assert.deepEqual(cs.summary(), { fps: 200, encoder: 'hevc_vaapi', device: 'AMD Radeon Graphics (renoir)', api: 'vaapi', codec: 'h265' });
  t += 30_000;
  cs.sample([{ encoder: 'libsvtav1', hardware: false, fps: 30.06 }]);
  assert.deepEqual(cs.summary(), { fps: 143.4, encoder: 'libsvtav1', device: 'AMD Ryzen 7 5800X', api: 'cpu', codec: 'av1' });
  // a restart: the latest numbers are still known
  const again = make();
  assert.deepEqual(again.summary(), { fps: 143.4, encoder: 'libsvtav1', device: 'AMD Ryzen 7 5800X', api: 'cpu', codec: 'av1' });
  // a day later the old samples are out of the window, the last average stays
  t += 2 * 86_400_000;
  assert.equal(cs.summary().fps, 143.4);
  t += 30_000;
  cs.sample([{ encoder: 'hevc_nvenc', hardware: true, device: 'nvidia0', fps: 480 }]);
  assert.deepEqual(cs.summary(), { fps: 480, encoder: 'hevc_nvenc', device: null, api: 'nvenc', codec: 'h265' });
  assert.deepEqual(errsOf({ ...clone(OLD), convert: cs.summary() }), []);
  for (const [e, api, codec] of [['hevc_qsv', 'qsv', 'h265'], ['av1_amf', 'amf', 'av1'], ['hevc_videotoolbox', 'videotoolbox', 'h265'], ['libx265', 'cpu', 'h265'], ['libaom-av1', 'cpu', 'av1'], ['copy', null, null]]) {
    assert.equal(apiOf(e), api, e);
    assert.equal(codecOf(e), codec, e);
  }
});

test('usableGpus: the passed-in /dev/dri GPUs (not the WSL bridge, NVIDIA left to nvidia-smi) and the NVIDIA ones, as the Health check counts them', () => {
  const found = {
    gpus: [
      { node: '/dev/dri/renderD128', vendor: 'amd', vendorName: 'AMD', name: 'AMD Radeon Graphics (renoir)', passedThrough: true },
      { node: '/dev/dri/renderD129', vendor: 'intel', vendorName: 'Intel', name: null, passedThrough: true },
      { node: '/dev/dri/renderD130', vendor: 'intel', vendorName: 'Intel', name: 'Intel graphics (iHD)', passedThrough: false },
      { node: '/dev/dri/renderD131', vendor: null, vendorName: 'unknown', name: 'Windows (WSL) graphics bridge', passedThrough: true, virtual: true },
      { node: '/dev/dri/renderD132', vendor: 'nvidia', vendorName: 'NVIDIA', name: null, passedThrough: true }
    ],
    nvidia: [{ name: 'NVIDIA GeForce RTX 4070', driver: '560.35' }]
  };
  assert.deepEqual(usableGpus(found).map((g) => g.name), ['AMD Radeon Graphics (renoir)', 'Intel GPU', 'NVIDIA GeForce RTX 4070']);
  assert.deepEqual(usableGpus(null), []);
});
