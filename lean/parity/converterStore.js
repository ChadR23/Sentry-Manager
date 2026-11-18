'use strict';

// The Node job store (src/main/converter/jobStore.js) for the Rust store's
// parity test (lean/src/converter/jobstore/tests.rs):
//
//   node lean/parity/converterStore.js scenarios            the scenarios, as JSON
//   node lean/parity/converterStore.js run <dir>            runs them in <dir> (one job each)
//   node lean/parity/converterStore.js read <dir>           every job in <dir>: load, list, summaries
//   node lean/parity/converterStore.js step <dir> <json>    one more change of each job ({ id: step })
//   node lean/parity/converterStore.js corpus               damaged manifests, as JSON
//   node lean/parity/converterStore.js check <dir> <file>   what save() says of each ({ code } or the job)
//   node lean/parity/converterStore.js recover <dir> <file> recover() of each job with the given facts
//
// A step is { top: {...}, set: { index: changes }, add: [items] }: unchanged
// clips are handed back as the store returned them, a changed clip is the
// stored one with the changes (null: the field removed).

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const { createJobStore } = require(path.join(REPO, 'src/main/converter/jobStore'));
const { createEmptyCounters, addCompletedFile, serializeSummary } = require(path.join(REPO, 'src/main/converter/contracts'));

const sha = (c) => c.repeat(64);

function clip(i, extra = {}) {
  const ts = `2026-10-${String(1 + (i % 28)).padStart(2, '0')}_07-${String(i % 60).padStart(2, '0')}-00`;
  const camera = ['front', 'back', 'left_repeater', 'right_repeater'][i % 4];
  const rel = `SentryClips/${ts}/${ts}-${camera}.mp4`;
  return {
    id: `item-${String(i + 1).padStart(6, '0')}`, state: 'queued', kind: 'video', group: 'SentryClips', eventId: ts,
    relativePath: rel, sourcePath: `/footage/car/TeslaCam/${rel}`, sourceBytes: 40_000_000 + i * 7,
    mtimeMs: 1760000000000 + i * 1000 + 0.25, timestampKey: ts, camera, attempts: 0, ...extra
  };
}

function asset(i) {
  const rel = `SentryClips/2026-10-01_07-00-00/event${i}.json`;
  return {
    id: `asset-${String(i + 1).padStart(6, '0')}`, state: 'queued', kind: 'asset', group: 'SentryClips', eventId: '2026-10-01_07-00-00',
    relativePath: rel, sourcePath: `/footage/car/TeslaCam/${rel}`, sourceBytes: 312 + i, mtimeMs: 1760000000123, assetType: 'event-json'
  };
}

const separateConfig = {
  sourceRoot: '/footage/car/TeslaCam', destinationRoot: '/data/converted', codec: 'h265', profileId: 'balanced',
  networkMode: 'auto', outputMode: 'separate', includedGroups: ['SavedClips', 'SentryClips'], replacementConfirmed: false,
  concurrency: 3, verifyMode: 'quick', keepOffTarget: true
};
const replaceConfig = {
  sourceRoot: '/footage/car/TeslaCam', destinationRoot: null, codec: 'h265', profileId: 'custom', bitrateKbps: 2500,
  networkMode: 'direct', outputMode: 'replace', includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'],
  groupOrder: ['SentryClips', 'SavedClips', 'RecentClips'], replacementConfirmed: true,
  lanes: [{ device: 'pci:0000:03:00.0', concurrency: 2 }, { device: 'cpu', concurrency: 0 }, { device: 'node:abcdef012345@cpu', concurrency: 1 }],
  keepLarger: true, verifyMode: 'full'
};

function converted(item, out) {
  return {
    state: 'completed', eligibleVideo: true, outputPath: out, outputBytes: Math.round(item.sourceBytes * 0.6), attempts: 1,
    encoder: 'hevc_vaapi', resultCode: 'converted', ownedPaths: {}, ownedArtifacts: {},
    expectedSource: { size: item.sourceBytes, sha256: sha('b'), device: '2049', inode: String(5000 + item.sourceBytes % 1000) }
  };
}

function scenarios() {
  const sep = Array.from({ length: 6 }, (_, i) => clip(i));
  const replace = Array.from({ length: 4 }, (_, i) => clip(i + 10));
  const done = Array.from({ length: 3 }, (_, i) => clip(i + 20));
  return [
    {
      name: 'separate', create: { id: 'job-separate', state: 'discovering', config: separateConfig, items: sep.slice(0, 2), discoveryComplete: false, createdAt: 1760000000000, updatedAt: 1760000000000 },
      steps: [
        { top: { updatedAt: 1760000000500 }, add: sep.slice(2, 4) },
        { top: { updatedAt: 1760000000600 }, add: [...sep.slice(4), asset(0)] },
        { top: { state: 'waiting', discoveryComplete: true } },
        { top: { state: 'encoding', activeItemId: 'item-000001', ownedPaths: { stagedSource: '/data/converter-temp/job-separate-item-000001-source.mp4' } }, set: { 0: { state: 'processing', ownedPaths: { encodedCandidate: '/data/tmp/sentry-six-converter/x-encoded.mp4' }, ownedArtifacts: { encodedCandidate: { path: '/data/tmp/sentry-six-converter/x-encoded.mp4', nonce: 'abc123', state: 'intent' } } } } },
        { top: {}, set: { 0: { ownedArtifacts: { encodedCandidate: { path: '/data/tmp/sentry-six-converter/x-encoded.mp4', nonce: 'abc123', state: 'writing', size: 1000, sha256: sha('c'), device: 64769, inode: '99', journal: { committed: { size: 500, sha256: sha('d') }, pending: null } } } } } },
        { top: { state: 'waiting', activeItemId: null, ownedPaths: null }, set: { 0: { ...converted(sep[0], '/data/converted/SentryClips/a-front.mp4'), offTarget: { savedPercent: 12.5, targetPercent: 20 } }, 1: { state: 'failed', failure: { code: 'encode-failed', retryable: true }, resultCode: 'encode-failed' } } },
        { top: { state: 'paused', pausedMs: 1200, timings: { files: 1, totalMs: { encode: 1500, verify: 300 } } } }
      ]
    },
    {
      name: 'replace', create: { id: 'job-replace', state: 'waiting', config: replaceConfig, items: replace, discoveryComplete: true },
      steps: [
        { top: { state: 'replacing', activeItemId: 'item-000011', replacementPhase: 'candidate-written', ownedPaths: { replacementCandidate: '/footage/car/TeslaCam/SentryClips/TEMP-H265-x.mp4', replacementBackup: '/footage/car/TeslaCam/SentryClips/BACKUP-x.mp4' }, ownedArtifacts: { replacementCandidate: { path: '/footage/car/TeslaCam/SentryClips/TEMP-H265-x.mp4', nonce: 'n1', state: 'owned', size: 24000000, sha256: sha('e'), device: '2049', inode: '77' } } }, set: { 0: { state: 'processing', expectedSource: { size: replace[0].sourceBytes, sha256: sha('f'), device: '2049', inode: '12' } } } },
        { top: { replacementPhase: 'original-backed-up' } },
        { top: { replacementPhase: 'candidate-promoted' } },
        { top: { replacementPhase: null, state: 'waiting', activeItemId: null, ownedPaths: null, ownedArtifacts: null }, set: { 0: converted(replace[0], replace[0].sourcePath) } },
        { top: { state: 'paused', recovery: { fromState: 'waiting', action: 'resume-queue' } } }
      ]
    },
    {
      name: 'completed', create: { id: 'job-completed', state: 'waiting', config: { ...separateConfig, profileId: 'quality', qualityLevel: 'high', keepOffTarget: false }, items: done, discoveryComplete: true, moreAfter: 'SentryClips/2026-10-03_07-22-00/2026-10-03_07-22-00-front.mp4' },
      steps: [
        { top: {}, set: Object.fromEntries(done.map((item, i) => [i, converted(item, `/data/converted/${item.relativePath}`)])) },
        { complete: true }
      ]
    },
    {
      name: 'interrupted-replace', create: { id: 'job-interrupted-replace', state: 'waiting', config: replaceConfig, items: [clip(50), clip(51)] },
      steps: [
        { top: { state: 'replacing', activeItemId: 'item-000051', replacementPhase: 'candidate-promoted', ownedPaths: { replacementBackup: '/footage/car/TeslaCam/SentryClips/BACKUP-y.mp4' }, ownedArtifacts: { replacementBackup: { path: '/footage/car/TeslaCam/SentryClips/BACKUP-y.mp4', nonce: 'n2', state: 'owned', size: 40000350, sha256: sha('a'), device: '2049', inode: '88' } } }, set: { 0: { state: 'processing', expectedSource: { size: 40000350, sha256: sha('a'), device: '2049', inode: '88' } } } }
      ]
    },
    {
      name: 'interrupted-encode', create: { id: 'job-interrupted-encode', state: 'waiting', config: separateConfig, items: [clip(60)] },
      steps: [
        { top: { state: 'verifying', activeItemId: 'item-000061' }, set: { 0: { state: 'processing', ownedPaths: { encodedCandidate: '/data/tmp/e.mp4' } } } }
      ]
    },
    {
      name: 'failed', create: { id: 'job-failed', state: 'waiting', config: { ...replaceConfig, lanes: undefined, concurrency: 1 }, items: [clip(40)] },
      steps: [{ top: { state: 'failed', failure: { code: 'source-changed' } } }]
    }
  ];
}

function itemsFor(previous, step) {
  if (!step.set && !step.add) return undefined;
  const items = previous.items.map((item, index) => {
    const changes = step.set?.[index];
    if (!changes) return item;
    const next = { ...item };
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete next[key]; else next[key] = value;
    }
    return next;
  });
  return step.add ? [...items, ...step.add] : items;
}

// The one change that ends a job: its summary from the counters.
function completePatch(manifest) {
  let counters = createEmptyCounters();
  for (const item of manifest.items) counters = addCompletedFile(counters, item);
  return { state: 'completed', counters, summary: serializeSummary(counters) };
}

async function applyStep(store, previous, step) {
  if (step.complete) return store.transition(previous.id, completePatch(previous));
  const patch = { ...step.top };
  const items = itemsFor(previous, step);
  if (items) patch.items = items;
  return store.transition(previous.id, patch);
}

function strip(value) {
  return JSON.parse(JSON.stringify(value));
}

async function run(dir) {
  const store = createJobStore({ rootDir: dir, fs: fs.promises, onUnreadable() {} });
  const out = {};
  for (const scenario of scenarios()) {
    let manifest = await store.create(strip(scenario.create));
    for (const step of scenario.steps) manifest = await applyStep(store, manifest, step);
    out[scenario.name] = JSON.stringify(manifest);
  }
  return out;
}

async function read(dir) {
  const store = createJobStore({ rootDir: dir, fs: fs.promises, onUnreadable() {} });
  const list = await store.list();
  const loads = {};
  for (const manifest of list) loads[manifest.id] = JSON.stringify(await store.load(manifest.id));
  return { ids: list.map((m) => m.id), loads, summaries: (await store.summaries()).map((s) => JSON.stringify(s)) };
}

async function step(dir, steps) {
  const store = createJobStore({ rootDir: dir, fs: fs.promises, onUnreadable() {} });
  const out = {};
  for (const [id, change] of Object.entries(steps)) {
    const current = await store.load(id);
    out[id] = JSON.stringify(await applyStep(store, current, change));
  }
  return out;
}

// Damaged copies of the scenarios' manifests: every field removed, nulled or
// given a value of another kind, unknown and private fields added.
async function corpus() {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'converter-store-corpus-'));
  try {
    const finals = Object.values(await run(dir)).map((text) => JSON.parse(text));
    const cases = [];
    const replacements = [null, '', 'x', -1, 0, 1.5, 2 ** 53, true, {}, [], 'x'.repeat(300), '/abs/path', 'rel/path', 'payload'];
    const walk = (root, node, trail) => {
      if (Array.isArray(node)) {
        node.slice(0, 2).forEach((child, i) => walk(root, child, [...trail, i]));
        return;
      }
      if (!node || typeof node !== 'object') return;
      for (const key of Object.keys(node)) {
        const at = [...trail, key];
        cases.push({ base: root, at, op: 'delete' });
        for (const value of replacements) cases.push({ base: root, at, op: 'set', value });
        walk(root, node[key], at);
      }
      for (const key of ['foo', 'stderr', 'authToken']) cases.push({ base: root, at: [...trail, key], op: 'set', value: 1 });
    };
    finals.forEach((manifest, index) => walk(index, manifest, []));
    const out = [];
    for (const entry of cases) {
      const manifest = strip(finals[entry.base]);
      let node = manifest;
      for (const key of entry.at.slice(0, -1)) node = node[key];
      const last = entry.at[entry.at.length - 1];
      if (entry.op === 'delete') delete node[last]; else node[last] = entry.value;
      out.push(manifest);
    }
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function check(dir, file) {
  const manifests = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (let index = 0; index < manifests.length; index += 1) {
    const store = createJobStore({ rootDir: path.join(dir, `case-${index}`), fs: fs.promises, onUnreadable() {} });
    try {
      out.push({ ok: JSON.stringify(await store.save(manifests[index])) });
    } catch (error) {
      out.push({ code: error.code || 'NONE' });
    }
  }
  return out;
}

async function recover(dir, file) {
  const { facts, reinspect } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const store = createJobStore({ rootDir: dir, fs: fs.promises, onUnreadable() {} });
  const out = {};
  for (const [id, given] of Object.entries(facts)) {
    try {
      out[id] = JSON.stringify(await store.recover(id, async () => given, { reinspectReplacement: reinspect === true }));
    } catch (error) {
      out[id] = `error ${error.code}`;
    }
  }
  return out;
}

(async () => {
  const [mode, dir, extra] = process.argv.slice(2);
  let result;
  if (mode === 'scenarios') result = scenarios().map(strip);
  else if (mode === 'run') result = await run(path.resolve(dir));
  else if (mode === 'read') result = await read(path.resolve(dir));
  else if (mode === 'step') result = await step(path.resolve(dir), JSON.parse(fs.readFileSync(extra, 'utf8')));
  else if (mode === 'corpus') result = await corpus();
  else if (mode === 'check') result = await check(path.resolve(dir), extra);
  else if (mode === 'recover') result = await recover(path.resolve(dir), extra);
  else throw new Error(`unknown mode ${mode}`);
  process.stdout.write(JSON.stringify(result));
})().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(2);
});
