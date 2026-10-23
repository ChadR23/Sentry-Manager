'use strict';

// The cleanup rules a restart applies to a clip's leftovers. A copy of the
// verified conversion beside an original is removed only when it provably is
// one (its recorded identity and exactly the conversion's first bytes, or
// still empty); the converter's own work files go by their exact name and
// identity, even after the telemetry writer changed them; a backup that was
// only announced is forgotten when nothing is there, never removed.

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
const JOB = 'job-1';
const ITEM = 'item-000001';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function setup({ identity = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owned-cleanup-')));
  const tempRoot = path.join(root, 'tmp', 'sentry-six-converter');
  const footage = path.join(root, 'footage');
  const snapshotFolder = path.join(root, 'tmp', 'sentry-six-verification-abc');
  for (const dir of [tempRoot, footage, snapshotFolder]) fs.mkdirSync(dir, { recursive: true });
  const conversion = crypto.randomBytes(200_000);
  const token = crypto.randomUUID();
  const snapshotPath = path.join(snapshotFolder, `${token}.mp4`);
  fs.writeFileSync(snapshotPath, conversion, { mode: 0o400 });
  const artifact = { path: snapshotPath, token, sha256: sha(conversion), size: conversion.length };
  const source = path.join(footage, '2026-10-20_07-40-00-front.mp4');
  fs.writeFileSync(source, crypto.randomBytes(400_000));
  const writes = [];
  const owned = createPosixOwnedFs({ helperPath: HELPER });
  const staging = createFileTransaction({
    tempRoot,
    validatePublicationArtifact: async (value, context) => context.mode === 'reconcile'
      && JSON.stringify(value) === JSON.stringify(context.persistedArtifact),
    removeOwned: owned.removeOwned,
    renameExclusive: owned.renameExclusive,
    ...(identity ? { privateTempCleanup: 'identity' } : {}),
    persistTransaction: async (snapshot) => { writes.push(snapshot); }
  });
  const statOf = (file) => {
    const stat = fs.lstatSync(file, { bigint: true });
    return { device: String(stat.dev), inode: String(stat.ino), size: Number(stat.size) };
  };
  const snapshotRecord = { path: snapshotPath, nonce: 'n-snap', state: 'owned', sha256: artifact.sha256, ...statOf(snapshotPath) };
  const cleanup = (ownedPaths, ownedArtifacts) => staging.cleanupOwnedArtifacts({
    codec: 'h265', jobId: JOB, itemId: ITEM, source, sourceRoot: footage,
    ownedPaths, ownedArtifacts, publicationArtifact: artifact
  });
  return { root, tempRoot, footage, source, conversion, artifact, snapshotPath, snapshotRecord, statOf, cleanup, staging, writes,
    done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const candidateOf = (env) => path.join(env.footage, `TEMP-H265-${path.basename(env.source)}`);

test('an interrupted copy beside the original is removed when it holds exactly the conversion\'s first bytes', { skip }, async () => {
  const env = setup();
  try {
    const candidate = candidateOf(env);
    fs.writeFileSync(candidate, Buffer.alloc(0), { mode: 0o600 });
    const record = { path: candidate, nonce: 'n-cand', state: 'writing', size: 0, sha256: sha(Buffer.alloc(0)),
      ...env.statOf(candidate), journal: { committed: { size: 0, sha256: sha(Buffer.alloc(0)) }, pending: null } };
    record.size = 0;
    fs.appendFileSync(candidate, env.conversion.subarray(0, 77_777)); // a torn copy, any size
    const result = await env.cleanup(
      { replacementCandidate: candidate, publicationSnapshot: env.snapshotPath },
      { replacementCandidate: record, publicationSnapshot: env.snapshotRecord }
    );
    assert.deepEqual(result, { cleaned: true });
    assert.equal(fs.existsSync(candidate), false);
    assert.equal(fs.existsSync(env.snapshotPath), false, 'the snapshot went after it');
    assert.equal(fs.existsSync(path.dirname(env.snapshotPath)), false, 'with its folder');
    assert.deepEqual(fs.readdirSync(env.footage), [path.basename(env.source)]);
  } finally {
    env.done();
  }
});

test('a copy whose bytes are not the conversion\'s, or another file at its name, is never removed', { skip }, async () => {
  const env = setup();
  try {
    const candidate = candidateOf(env);
    fs.writeFileSync(candidate, Buffer.from(env.conversion.subarray(0, 50_000)).fill(7, 100, 200));
    const record = { path: candidate, nonce: 'n-cand', state: 'writing', size: 0, sha256: sha(Buffer.alloc(0)),
      ...env.statOf(candidate), journal: { committed: { size: 0, sha256: sha(Buffer.alloc(0)) }, pending: null } };
    record.size = 0;
    await assert.rejects(env.cleanup({ replacementCandidate: candidate }, { replacementCandidate: record }),
      { code: 'UNSAFE_OWNED_PATH' }, 'not a prefix of the conversion');
    assert.ok(fs.existsSync(candidate));

    // the same bytes in a file that is not the one recorded (another inode)
    fs.rmSync(candidate);
    fs.writeFileSync(path.join(env.footage, 'other'), 'x');
    fs.writeFileSync(candidate, env.conversion.subarray(0, 50_000));
    await assert.rejects(env.cleanup({ replacementCandidate: candidate }, { replacementCandidate: record }),
      { code: 'UNSAFE_OWNED_PATH' }, 'not the recorded file');
    assert.ok(fs.existsSync(candidate));
    assert.ok(fs.existsSync(env.source), 'the original is never touched');
  } finally {
    env.done();
  }
});

test('a copy only announced is removed while still empty, and kept once it holds anything', { skip }, async () => {
  const env = setup();
  try {
    const candidate = candidateOf(env);
    const intent = { path: candidate, nonce: 'n-cand', state: 'intent' };
    fs.writeFileSync(candidate, Buffer.alloc(0));
    assert.deepEqual(await env.cleanup({ replacementCandidate: candidate }, { replacementCandidate: intent }), { cleaned: true });
    assert.equal(fs.existsSync(candidate), false);

    fs.writeFileSync(candidate, 'not ours');
    await assert.rejects(env.cleanup({ replacementCandidate: candidate }, { replacementCandidate: intent }),
      { code: 'UNSAFE_OWNED_PATH' });
    assert.equal(fs.readFileSync(candidate, 'utf8'), 'not ours');

    fs.rmSync(candidate);
    assert.deepEqual(await env.cleanup({ replacementCandidate: candidate }, { replacementCandidate: intent }), { cleaned: true },
      'never created: nothing to do');
  } finally {
    env.done();
  }
});

test('an encode output the telemetry writer changed is removed by its exact name and identity', { skip }, async () => {
  const env = setup();
  try {
    const encoded = path.join(env.tempRoot, `${JOB}-${ITEM}-n-enc-encoded.mp4`);
    fs.writeFileSync(encoded, crypto.randomBytes(5000));
    const record = { path: encoded, nonce: 'n-enc', state: 'owned', sha256: sha(fs.readFileSync(encoded)), ...env.statOf(encoded) };
    fs.truncateSync(encoded, 0); // the writer emptied it, then the stop came
    const other = path.join(env.tempRoot, 'other'); // made now: an inode of its own
    fs.writeFileSync(other, 'x');
    assert.deepEqual(await env.cleanup({ encodedCandidate: encoded }, { encodedCandidate: record }), { cleaned: true });
    assert.equal(fs.existsSync(encoded), false);

    // another file at that name (a different inode) is refused
    fs.renameSync(other, encoded);
    await assert.rejects(env.cleanup({ encodedCandidate: encoded }, { encodedCandidate: record }), { code: 'UNSAFE_OWNED_PATH' });
    assert.ok(fs.existsSync(encoded));

    // the hash rule (no identity option) still refuses a changed file
    const strict = setup({ identity: false });
    try {
      const file = path.join(strict.tempRoot, `${JOB}-${ITEM}-n-enc-encoded.mp4`);
      fs.writeFileSync(file, 'abc');
      const owned = { path: file, nonce: 'n-enc', state: 'owned', sha256: sha('abc'), ...strict.statOf(file) };
      fs.writeFileSync(file, 'abcd');
      await assert.rejects(strict.cleanup({ encodedCandidate: file }, { encodedCandidate: owned }), { code: 'UNSAFE_OWNED_PATH' });
      assert.ok(fs.existsSync(file));
    } finally {
      strict.done();
    }
  } finally {
    env.done();
  }
});

test('a backup only announced is forgotten when nothing is there, and kept as the original when it is', { skip }, async () => {
  const env = setup();
  try {
    const backup = path.join(env.footage, `BACKUP-${path.basename(env.source)}`);
    const intent = { path: backup, nonce: 'n-back', state: 'intent' };
    assert.deepEqual(await env.cleanup({ replacementBackup: backup }, { replacementBackup: intent }), { cleaned: true });

    fs.renameSync(env.source, backup);
    const kept = await env.cleanup({ replacementBackup: backup }, { replacementBackup: intent });
    assert.equal(kept.cleaned, false);
    assert.deepEqual(kept.cleanupPending, ['replacementBackup']);
    assert.ok(fs.existsSync(backup), 'a possible original is never removed by generic cleanup');
  } finally {
    env.done();
  }
});
