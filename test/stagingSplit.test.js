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
  // what the converter asks the adapter for (moves and removals)
  const requests = [];
  const staging = createFileTransaction({
    tempRoot,
    validatePublicationArtifact: async () => true,
    removeOwned: { ...owned.removeOwned, remove: (request) => { requests.push({ op: 'remove', ...request }); return owned.removeOwned.remove(request); } },
    renameExclusive: { ...owned.renameExclusive, promote: (request) => { requests.push({ op: 'promote', ...request }); return owned.renameExclusive.promote(request); } },
    privateTempCleanup: 'identity'
  });
  const operation = {
    jobId: 'job-1', itemId: 'item-000001', codec: 'h265', source, sourceRoot: footage, expectedSource,
    publicationArtifact: artifact, persistTransaction: async (snapshot) => { writes.push(snapshot); }
  };
  return { root, footage, source, original, conversion, artifact, staging, operation, writes, requests,
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
    // in the slot only the original is read: the copy (read back by prepare)
    // and the backup (just hashed as it was moved aside) by identity and time
    const [backup, final, removal] = env.requests;
    assert.equal(env.requests.length, 3);
    assert.ok(/^BACKUP-/.test(path.basename(backup.to)) && !backup.identityOnly, 'the original: its full check');
    assert.ok(/^TEMP-/.test(path.basename(final.from)) && final.identityOnly === true && /^\d+$/.test(final.expectedSource.mtimeNs));
    assert.ok(removal.op === 'remove' && removal.identityOnly === true && removal.guard.identityOnly === true);
  } finally {
    env.done();
  }
});

test('a copy rewritten in place after prepare (same file, same size) is read again and refused before the original is touched', { skip }, async () => {
  const env = setup();
  try {
    const prepared = await env.staging.prepareReplacement(env.operation);
    const temp = path.join(env.footage, `TEMP-H265-${path.basename(env.source)}`);
    const rewritten = Buffer.from(env.conversion);
    rewritten[999] ^= 0xff;
    fs.writeFileSync(temp, rewritten);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(temp, later, later);
    env.requests.length = 0;
    // (the rewritten copy is no longer provably the converter's own: it is
    // left as it is and the clip waits for a decision, as before)
    await assert.rejects(env.staging.swapReplacement({ prepared, persistTransaction: env.operation.persistTransaction }),
      (error) => ['PUBLICATION_ARTIFACT_CHANGED', 'ROLLBACK_FAILED'].includes(error.code));
    assert.ok(!env.requests.some((request) => request.op === 'promote'), 'the original was never moved');
    assert.deepEqual(fs.readFileSync(env.source), env.original);
    assert.deepEqual(fs.readFileSync(temp), rewritten, 'the rewritten copy is not removed');
  } finally {
    env.done();
  }
});

test('a separate output: the .partial is read back by prepare and moved into place by identity and time', { skip }, async () => {
  const env = setup();
  try {
    const destination = path.join(env.root, 'out', 'clip.mp4');
    fs.mkdirSync(path.dirname(destination));
    const prepared = await env.staging.preparePublication({ ...env.operation, destination });
    assert.match(prepared.partialMtimeNs, /^\d+$/);
    const result = await env.staging.commitPublication({ prepared, persistTransaction: env.operation.persistTransaction });
    assert.equal(result.finalPath, destination);
    assert.deepEqual(fs.readFileSync(destination), env.conversion);
    assert.equal(env.requests.at(-1).identityOnly, true);

    // rewritten in place after prepare: hashed in full, refused
    const other = path.join(env.root, 'out', 'other.mp4');
    const env2 = setup();
    try {
      const again = await env2.staging.preparePublication({ ...env2.operation, destination: other });
      const later = new Date(Date.now() + 5000);
      fs.writeFileSync(again.partial, Buffer.alloc(env2.conversion.length, 7));
      fs.utimesSync(again.partial, later, later);
      await assert.rejects(env2.staging.commitPublication({ prepared: again, persistTransaction: env2.operation.persistTransaction }));
      assert.equal(env2.requests.at(-1).identityOnly, undefined, 'a changed time: the full check');
      assert.equal(fs.existsSync(other), false);
    } finally {
      env2.done();
    }
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
