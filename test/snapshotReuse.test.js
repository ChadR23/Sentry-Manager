'use strict';

// The live job snapshot reuses the job store's frozen items instead of copying
// them. Finished clips keep empty ownership ({}); they used to be copied again
// on every update, so a 30,000-clip job got slower the further it went.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createJobStore } = require('../src/main/converter/jobStore');
const { createEmptyCounters } = require('../src/main/converter/contracts');
const { publicSnapshot } = require('../src/main/converter/jobService');

const sha = 'a'.repeat(64);
function item(i) {
  const ts = `2025-01-${String(1 + (i % 28)).padStart(2, '0')}_${String(i % 24).padStart(2, '0')}-${String(i % 60).padStart(2, '0')}-00`;
  const rel = `SavedClips/${ts}/${ts}-front-${i}.mp4`;
  return {
    id: `item-${String(i + 1).padStart(6, '0')}`, state: 'queued', kind: 'video', group: 'SavedClips', eventId: ts,
    relativePath: rel, sourcePath: `/footage/car/TeslaCam/${rel}`, sourceBytes: 60_000_000 + i,
    mtimeMs: 1735700000000 + i, timestampKey: ts, camera: 'front', attempts: 0
  };
}
function converted(it) {
  return {
    ...it, state: 'completed', eligibleVideo: true, outputPath: it.sourcePath, outputBytes: 24_000_000, attempts: 1,
    encoder: 'hevc_qsv', resultCode: 'converted', ownedPaths: {}, ownedArtifacts: {},
    expectedSource: { size: it.sourceBytes, sha256: sha, device: '52', inode: String(100000 + Number(it.id.slice(5))) }
  };
}

async function bigJob(total, done) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-reuse-'));
  const store = createJobStore({ rootDir: root, fs: fs.promises, onUnreadable() {} });
  const items = [];
  for (let i = 0; i < total; i++) items.push(i < done ? converted(item(i)) : item(i));
  const created = await store.create({
    state: 'waiting', items, counters: createEmptyCounters(), discoveryComplete: true,
    config: {
      sourceRoot: '/footage/car/TeslaCam', destinationRoot: null, codec: 'h265', profileId: 'balanced',
      networkMode: 'auto', outputMode: 'replace', includedGroups: ['SavedClips', 'SentryClips', 'RecentClips'],
      replacementConfirmed: true, concurrency: 2, verifyMode: 'quick'
    }
  });
  // a running job's manifest comes from transitions: their items are frozen
  const manifest = await store.transition(created.id, { state: 'waiting' });
  return { root, manifest };
}

test('finished clips with empty ownership are reused, not copied, in every snapshot', async () => {
  const { root, manifest } = await bigJob(6000, 5000);
  try {
    const finished = manifest.items.filter((i) => i.state === 'completed');
    assert.equal(finished.length, 5000);
    assert.ok(finished.every((i) => Object.isFrozen(i) && i.ownedPaths && Object.keys(i.ownedPaths).length === 0),
      'the store keeps converted clips frozen with empty ownership');
    const snap = publicSnapshot(manifest);
    for (let n = 0; n < manifest.items.length; n += 1) assert.equal(snap.items[n], manifest.items[n]);
    // a second snapshot of the same job copies nothing either
    const again = publicSnapshot(manifest);
    assert.equal(again.items[1234], manifest.items[1234]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a clip that owns files is still copied without its private paths', () => {
  const inFlight = Object.freeze({
    ...item(1), state: 'processing',
    ownedPaths: Object.freeze({ stagedSource: '/data/converter-temp/job-1-source.mp4' }),
    ownedArtifacts: Object.freeze({})
  });
  const publishing = Object.freeze({ ...item(2), state: 'processing', publicationArtifact: Object.freeze({ path: '/data/x' }) });
  const done = Object.freeze({ ...converted(item(3)), publicationArtifact: null });
  const snap = publicSnapshot(Object.freeze({ id: 'job', items: Object.freeze([inFlight, publishing, done]) }));
  assert.notEqual(snap.items[0], inFlight);
  assert.equal(Object.prototype.hasOwnProperty.call(snap.items[0], 'ownedPaths'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(snap.items[0], 'ownedArtifacts'), false);
  assert.notEqual(snap.items[1], publishing);
  assert.equal(Object.prototype.hasOwnProperty.call(snap.items[1], 'publicationArtifact'), false);
  // empty ownership and a null publication carry nothing: reused as they are
  assert.equal(snap.items[2], done);
  assert.ok(Object.isFrozen(snap.items[0]) && Object.isFrozen(snap.items[1]));
});

test('a snapshot of a 30,000-clip job stays cheap however far it has got', async () => {
  const { root, manifest } = await bigJob(30000, 29000);
  try {
    publicSnapshot(manifest);
    const start = process.hrtime.bigint();
    for (let n = 0; n < 5; n += 1) publicSnapshot(manifest);
    const perSnapshotMs = Number(process.hrtime.bigint() - start) / 1e6 / 5;
    // copying 29,000 converted clips took about 400 ms per snapshot; reusing them a few ms
    assert.ok(perSnapshotMs < 100, `one snapshot took ${perSnapshotMs.toFixed(1)} ms`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
