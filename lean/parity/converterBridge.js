'use strict';

// The server's converter channels (server/converterBridge.js over
// src/main/converter/ipc.js) on a stand-in job service, for the Rust
// bridge's parity test (lean/src/converter/ipc.rs tests):
//
//   node lean/parity/converterBridge.js corpus <base>          the requests, as JSON
//   node lean/parity/converterBridge.js run <base> <file>      every answer, in order
//
// <base>/allowed is the only folder the footage guard lets through.

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');

function fakeService() {
  const jobs = new Map();
  let n = 0;
  const notFound = () => Object.assign(new Error('JOB_NOT_FOUND'), { code: 'JOB_NOT_FOUND' });
  const get = async (id) => { if (!jobs.has(id)) throw notFound(); return JSON.parse(JSON.stringify(jobs.get(id))); };
  return {
    start: async (config) => {
      n += 1;
      const id = `job-${n}`;
      jobs.set(id, { id, state: n % 2 ? 'waiting' : 'completed', revision: n, updatedAt: 1000 + n, config, summary: null, items: [] });
      return id;
    },
    get, list: async () => [...jobs.values()].map((j) => JSON.parse(JSON.stringify(j))),
    listSummaries: async () => [...jobs.values()].map((j) => JSON.parse(JSON.stringify(j))),
    pause: get, resume: get, cancel: get, retryFailed: get, dismissSummary: get,
    setConcurrency: async (id, c) => { const j = await get(id); j.config.concurrency = c; jobs.set(id, j); return j; },
    discard: async (id) => { await get(id); jobs.delete(id); return { jobId: id, discarded: true }; },
    subscribe: () => () => {}
  };
}

function resolvePathFor(base) {
  const allowed = fs.realpathSync(path.join(base, 'allowed'));
  return async (p, { mustExist } = {}) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
    let cursor = path.resolve(p);
    const suffix = [];
    for (;;) {
      try {
        const real = path.resolve(fs.realpathSync(cursor), ...suffix);
        if (mustExist && suffix.length) return null;
        return real === allowed || real.startsWith(allowed + path.sep) ? real : null;
      } catch (_) {
        const parent = path.dirname(cursor);
        if (parent === cursor) return null;
        suffix.unshift(path.basename(cursor));
        cursor = parent;
      }
    }
  };
}

// what the devices channel answers (lean/src/converter/ipc.rs has the same)
const DEVICES = { devices: [{ id: 'pci:0000:01:00.0', kind: 'dri', name: 'Old GPU', encoders: { h265: null, av1: null } }] };

function corpus(base) {
  const a = path.join(base, 'allowed');
  const src = path.join(a, 'TeslaCam');
  const out = path.join(a, 'out');
  const outside = path.join(base, 'outside');
  const good = {
    sourceRoot: src, destinationRoot: out, codec: 'h265', profileId: 'balanced', networkMode: 'auto',
    outputMode: 'separate', includedGroups: ['SentryClips'], replacementConfirmed: false
  };
  const replace = { ...good, destinationRoot: null, outputMode: 'replace', replacementConfirmed: true };
  const starts = [
    good, replace, { ...replace, verifyMode: 'off' }, { ...good, verifyMode: 'off' }, { ...good, verifyMode: 'full' },
    { ...good, groupOrder: ['RecentClips', 'SavedClips', 'SentryClips'] }, { ...good, groupOrder: ['RecentClips'] },
    { ...good, concurrency: 4 }, { ...good, concurrency: 0 }, { ...good, concurrency: 1.5 },
    { ...good, profileId: 'custom', bitrateKbps: 2500 }, { ...good, profileId: 'custom' }, { ...good, bitrateKbps: 2500 },
    { ...good, profileId: 'quality', qualityLevel: 'high' }, { ...good, profileId: 'quality', qualityLevel: 'x' },
    { ...good, keepOffTarget: true }, { ...good, profileId: 'custom', bitrateKbps: 300, keepOffTarget: true },
    { ...good, keepLarger: true }, { ...good, profileId: 'quality', qualityLevel: 'small', keepLarger: true },
    { ...good, profileId: 'smallest' }, { ...good, profileId: 'smallest', codec: 'av1' }, { ...good, profileId: 'smallest', keepLarger: true },
    { ...good, profileId: 'smallest', keepOffTarget: true }, { ...good, profileId: 'smallest', qualityLevel: 'small' },
    { ...good, profileId: 'smallest', bitrateKbps: 2500 }, { ...good, profileId: 'smallest', codec: 'av1', keepOffTarget: true },
    { ...good, profileId: 'smallest', lanes: [{ device: 'cpu', concurrency: 2 }] },
    // a GPU that cannot encode H.265 (DEVICES below): refused, but not for Smallest (CPU only), which does not use its lanes
    { ...good, lanes: [{ device: 'pci:0000:01:00.0', concurrency: 1 }] }, { ...good, profileId: 'smallest', lanes: [{ device: 'pci:0000:01:00.0', concurrency: 1 }] },
    { ...good, lanes: [{ device: 'cpu', concurrency: 2 }, { device: 'pci:0000:03:00.0', concurrency: 0 }] },
    { ...good, lanes: null }, { ...good, lanes: [] }, { ...good, codec: 'h264' }, { ...good, codec: 'av1' },
    { ...good, profileId: 'tiny' }, { ...good, networkMode: 'smb' }, { ...good, outputMode: 'both' },
    { ...good, includedGroups: [] }, { ...good, includedGroups: ['SentryClips', 'SentryClips'] }, { ...good, includedGroups: ['Other'] },
    { ...good, sourceRoot: outside }, { ...good, destinationRoot: outside }, { ...good, sourceRoot: path.join(a, 'missing') },
    { ...good, destinationRoot: path.join(out, 'new', 'deeper') }, { ...good, destinationRoot: path.join(src, 'inside') },
    { ...good, sourceRoot: 'relative/path' }, { ...good, replacementConfirmed: true }, { ...replace, replacementConfirmed: false },
    { ...replace, destinationRoot: out }, { ...good, extra: 1 }, { ...good, sourceRoot: path.join(a, 'link') },
    { ...good, sourceRoot: path.join(a, 'file.txt') }, { ...good, verifyMode: 'never' }, 'not an object', [good]
  ];
  const requests = [];
  for (const s of starts) requests.push(['start', s]);
  requests.push(['getCurrent', undefined], ['getCurrent', {}], ['getCapabilities', undefined]);
  for (const id of ['job-1', 'job-2', 'job-99', 'CON', '../x', 7]) {
    for (const name of ['pause', 'resume', 'cancel', 'retryFailed', 'dismissSummary']) requests.push([name, { jobId: id }]);
  }
  requests.push(['pause', { jobId: 'job-1', more: 1 }], ['pause', undefined], ['setConcurrency', { jobId: 'job-1', concurrency: 3 }],
    ['setConcurrency', { jobId: 'job-1', concurrency: 99 }], ['setConcurrency', { jobId: 'job-1' }],
    ['setLanes', { jobId: 'job-1', lanes: [{ device: 'cpu', concurrency: 1 }] }], ['setLanes', { jobId: 'job-1', lanes: [] }], ['setLanes', { jobId: 'job-1' }],
    ['chooseFolder', { purpose: 'source', defaultPath: src }], ['chooseFolder', { purpose: 'source' }], ['chooseFolder', { purpose: 'other' }],
    ['chooseFolder', { purpose: 'destination', defaultPath: outside }], ['chooseFolder', { purpose: 'source', defaultPath: 'x', more: 1 }],
    ['subscribeProgress', undefined], ['unsubscribeProgress', undefined], ['cancelBenchmark', undefined], ['devices', undefined],
    ['getAuto', undefined], ['checkAutoNow', undefined], ['forgetVehicle', { forgetSource: src }],
    ['nope', undefined], ['discard', { jobId: 'job-3' }], ['getCurrent', undefined], ['discard', { jobId: 'job-3' }],
    ['pause', { jobId: 'job-1', big: 'x'.repeat(40000) }], ['pause', { jobId: 1.5 }]);
  return requests.map(([name, payload]) => ({ name, payload }));
}

async function run(base, file) {
  const { createConverterBridge } = require(path.join(REPO, 'server/converterBridge'));
  const runtime = {
    service: fakeService(),
    capabilities: { separatePublication: 'native-atomic', ownershipCleanup: 'atomic-expected-ownership', replacement: 'available', destinationContainment: 'pathname-revalidated-non-atomic' },
    runBenchmark: async () => { throw Object.assign(new Error('x'), { code: 'BENCHMARK_UNAVAILABLE' }); },
    cancelBenchmark: () => {},
    auto: null,
    devices: async () => DEVICES
  };
  const bridge = createConverterBridge({ runtime, resolvePath: resolvePathFor(base), log: { error() {} } });
  const out = [];
  for (const { name, payload } of JSON.parse(fs.readFileSync(file, 'utf8'))) out.push(await bridge.invoke(name, payload, null));
  return out;
}

(async () => {
  const [mode, base, file] = process.argv.slice(2);
  const result = mode === 'corpus' ? corpus(base) : await run(base, file);
  process.stdout.write(JSON.stringify(result));
})().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(2);
});
