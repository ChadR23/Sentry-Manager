'use strict';

// The two halves of a replacement: prepare (the copy beside the original,
// outside the save slot) and swap (the renames, inside it).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFileTransaction } = require('../src/main/converter/staging');
const { createPosixOwnedFs } = require('../server/posixOwnedFs');

const HELPER = path.join(__dirname, '..', 'build', 'noreplace-rename');
const skip = fs.existsSync(HELPER) ? false : 'needs build/noreplace-rename';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'staging-split-')));
  const tempRoot = path.join(root, 'tmp', 'sentry-six-converter');
  const footage = path.join(root, 'footage');
  const snapshotFolder = path.join(root, 'tmp', 'sentry-six-verification-abc');
  for (const dir of [tempRoot, footage, snapshotFolder]) fs.mkdirSync(dir, { recursive: true });
  const conversion = crypto.randomBytes(150_000);
  const token = crypto.randomUUID();
  const snapshotPath = path.join(snapshotFolder, `${token}.mp4`);
  fs.writeFileSync(snapshotPath, conversion, { mode: 0o400 });
  const artifact = { path: snapshotPath, token, sha256: sha(conversion), size: conversion.length };
  const source = path.join(footage, '2026-10-20_07-40-00-front.mp4');
  const original = crypto.randomBytes(400_000);
  fs.writeFileSync(source, original, { mode: 0o644 });
  const stat = fs.lstatSync(source, { bigint: true });
  const expectedSource = { size: original.length, sha256: sha(original), device: String(stat.dev), inode: String(stat.ino) };
  const writes = [];
  const owned = createPosixOwnedFs({ helperPath: HELPER });
  const staging = createFileTransaction({
    tempRoot,
    validatePublicationArtifact: async () => true,
    removeOwned: owned.removeOwned,
    renameExclusive: owned.renameExclusive,
    privateTempCleanup: 'identity'
  });
  const operation = {
    jobId: 'job-1', itemId: 'item-000001', codec: 'h265', source, sourceRoot: footage, expectedSource,
    publicationArtifact: artifact, persistTransaction: async (snapshot) => { writes.push(snapshot); }
  };
  return { root, footage, source, original, conversion, artifact, staging, operation, writes,
    done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('prepare copies the conversion beside the original and records it on the way; swap puts it in place', { skip }, async () => {
  const env = setup();
  try {
    const prepared = await env.staging.prepareReplacement(env.operation);
    const temp = path.join(env.footage, `TEMP-H265-${path.basename(env.source)}`);
    assert.deepEqual(fs.readFileSync(temp), env.conversion);
    assert.equal(fs.statSync(temp).mode & 0o777, 0o644, 'with the original\'s permissions');
    assert.deepEqual(fs.readFileSync(env.source), env.original, 'the original is untouched');
    assert.deepEqual(env.writes.map((write) => write.ownedArtifacts.replacementCandidate.state), ['intent', 'writing', 'owned'],
      'announced, created (its identity), complete; no progress records in between');
    assert.ok(env.writes.every((write) => !write.phase && !write.ownedPaths.replacementBackup), 'no backup and no phase before the slot');
    assert.equal(env.writes.at(-1).ownedArtifacts.replacementCandidate.sha256, env.artifact.sha256);

    env.writes.length = 0;
    const result = await env.staging.swapReplacement({ prepared, persistTransaction: env.operation.persistTransaction });
    assert.equal(result.phase, 'backup-deleted');
    assert.deepEqual(env.writes.map((write) => write.phase), ['candidate-written', 'original-backed-up', 'candidate-promoted'],
      'three records in the slot; the result is the caller\'s');
    assert.equal(env.writes[0].ownedArtifacts.replacementBackup.state, 'intent');
    assert.deepEqual(fs.readFileSync(env.source), env.conversion);
    assert.deepEqual(fs.readdirSync(env.footage), [path.basename(env.source)]);
    assert.deepEqual(Object.keys(result.ownedPaths), ['publicationSnapshot'], 'only the private snapshot is left to remove');
  } finally {
    env.done();
  }
});

test('an original rewritten in place after prepare (same file, same size) is refused by the full check and kept', { skip }, async () => {
  const env = setup();
  try {
    const prepared = await env.staging.prepareReplacement(env.operation);
    const rewritten = Buffer.from(env.original);
    rewritten[1234] ^= 0xff;
    fs.writeFileSync(env.source, rewritten); // same inode, same size: only the content tells
    await assert.rejects(env.staging.swapReplacement({ prepared, persistTransaction: env.operation.persistTransaction }),
      { code: 'SOURCE_CHANGED' });
    assert.deepEqual(fs.readFileSync(env.source), rewritten, 'the original stays as it is now');
    assert.deepEqual(fs.readdirSync(env.footage), [path.basename(env.source)], 'its copy and any backup are gone');
    assert.equal(env.writes.at(-1).phase, 'backup-restored');
  } finally {
    env.done();
  }
});

test('a copy that is not the verified conversion stops the save before anything is written beside the original', { skip }, async () => {
  const env = setup();
  try {
    fs.chmodSync(env.artifact.path, 0o600);
    fs.writeFileSync(env.artifact.path, Buffer.alloc(env.conversion.length, 1)); // same size, other bytes
    await assert.rejects(env.staging.prepareReplacement(env.operation), { code: 'PUBLICATION_ARTIFACT_CHANGED' });
    assert.deepEqual(fs.readdirSync(env.footage), [path.basename(env.source)], 'the copy was compared and removed');
    assert.deepEqual(fs.readFileSync(env.source), env.original);
  } finally {
    env.done();
  }
});
