'use strict';

// The save of a replaced clip, measured: the one-clip-at-a-time save slot
// holds only the renames (another clip's copy to the share runs meanwhile),
// the share is read for 2 originals and 1 conversion per clip (it was about
// 7 + 7), of which only one read of the original is in the slot, and the
// job file is written at most 15 times per clip (about 42).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { open, makeBase, available, clipName, codecOf, sha256, leftovers } = require('./fixtures/crashPoints');
const { createJobStore } = require('../src/main/converter/jobStore');

const skip = available() ? false : 'needs ffmpeg and build/noreplace-rename';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bytes read in this process from files under a folder (the "share"),
// whatever opens them: the converter's own reads and the file adapter's.
function countReads(root) {
  const counted = { bytes: 0 };
  const inside = (file) => typeof file === 'string' && path.resolve(file).startsWith(`${root}${path.sep}`);
  const originalOpen = fsp.open;
  const originalReadFile = fsp.readFile;
  fsp.open = async function patchedOpen(file, ...rest) {
    const handle = await originalOpen.call(this, file, ...rest);
    if (inside(String(file))) {
      const read = handle.read.bind(handle);
      handle.read = async (...args) => {
        const result = await read(...args);
        counted.bytes += result?.bytesRead || 0;
        return result;
      };
    }
    return handle;
  };
  fsp.readFile = async function patchedReadFile(file, ...rest) {
    const bytes = await originalReadFile.call(this, file, ...rest);
    if (inside(String(file))) counted.bytes += bytes.length;
    return bytes;
  };
  counted.restore = () => { fsp.open = originalOpen; fsp.readFile = originalReadFile; };
  return counted;
}

test('replacing through staging reads each clip from the share twice and its conversion once (in the save slot: the original once), with 15 job-file writes or fewer', { skip, timeout: 240_000 }, async (t) => {
  const clips = 3;
  const { base, folder } = await makeBase(clips);
  const sizes = fs.readdirSync(folder).map((name) => fs.statSync(path.join(folder, name)).size);
  let writes = 0;
  let env;
  const reads = countReads(fs.realpathSync(path.join(base, 'footage')));
  // share reads from the slot's first record to the clip's result (one at a time)
  let slotStart = null;
  let slotBytes = 0;
  try {
    env = await open(base, { networkMode: 'staging', factories: {
      createJobStore: (options) => {
        const store = createJobStore(options);
        return Object.freeze({ ...store, transition: async (...args) => {
          writes += 1;
          const next = await store.transition(...args);
          if (slotStart === null && next.replacementPhase === 'candidate-written') slotStart = reads.bytes;
          else if (slotStart !== null && !next.replacementPhase) {
            slotBytes += reads.bytes - slotStart;
            slotStart = null;
          }
          return next;
        } });
      }
    } });
    await env.runtime.start();
    const id = await env.runtime.service.start(env.config);
    const job = await env.runtime.service.whenIdle(id);
    assert.equal(job.state, 'completed');
    assert.equal(job.items.filter((item) => item.resultCode === 'converted').length, clips);
    const outputs = job.items.map((item) => item.outputBytes);
    const S = sizes.reduce((a, b) => a + b, 0);
    const O = outputs.reduce((a, b) => a + b, 0);
    t.diagnostic(`share reads ${reads.bytes} bytes, ${slotBytes} in the save slot (originals ${S}, conversions ${O}); ${writes} job-file writes for ${clips} clips`);
    // header checks while finding the clips: a few KB each
    assert.ok(reads.bytes <= 2 * S + O + clips * 256 * 1024,
      `read ${reads.bytes} bytes from the share; 2 originals + 1 conversion are ${2 * S + O}`);
    // the staged copy and the slot's check of each original, the read-back of each copy
    assert.ok(reads.bytes >= 2 * S + O, 'each original and each copy is still read in full');
    assert.ok(slotBytes >= S && slotBytes <= S + clips * 64 * 1024,
      `${slotBytes} bytes read in the save slot; the originals are ${S}`);
    // per clip, plus the job's own: discovery, its end
    assert.ok(writes <= clips * 15 + 4, `${writes} job-file writes for ${clips} clips`);
    for (let index = 0; index < clips; index += 1) assert.equal(codecOf(path.join(folder, clipName(index))), 'hevc');
  } finally {
    reads.restore();
    await env?.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('while one clip holds the save slot, the next clip\'s copy to the share is made', { skip, timeout: 240_000 }, async () => {
  const { base, folder } = await makeBase(2);
  let env;
  try {
    let releaseSlot;
    const slotHeld = new Promise((resolve) => { releaseSlot = resolve; });
    let holding = null;
    env = await open(base, { concurrency: 2, networkMode: 'staging' });
    assert.equal(env.runtime.stagingManager.capabilities.splitSave, true);
    // the first clip to move its original aside waits here, holding the slot
    const realPromote = env.renameExclusive.promote;
    env.renameExclusive.promote = async (request) => {
      if (!holding && /^BACKUP-/.test(path.basename(request.to))) {
        holding = path.basename(request.from);
        await slotHeld;
      }
      return realPromote(request);
    };
    await env.runtime.start();
    const id = await env.runtime.service.start(env.config);
    const other = () => fs.readdirSync(folder).find((name) => name.startsWith('TEMP-') && !name.endsWith(holding));
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && !(holding && other())) await sleep(20);
    assert.ok(holding, 'a clip is in the save slot');
    assert.ok(other(), 'the other clip copied its conversion beside its original meanwhile');
    releaseSlot();
    const job = await env.runtime.service.whenIdle(id);
    assert.equal(job.state, 'completed');
    assert.equal(job.items.filter((item) => item.resultCode === 'converted').length, 2);
    assert.deepEqual(fs.readdirSync(folder).sort(), [clipName(0), clipName(1)]);
  } finally {
    await env?.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an original that changed after its copy was made beside it is kept, and the copy removed', { skip, timeout: 240_000 }, async () => {
  const { base, folder } = await makeBase(2);
  let env;
  try {
    let releaseSlot;
    const slotHeld = new Promise((resolve) => { releaseSlot = resolve; });
    let holding = null;
    env = await open(base, { concurrency: 2, networkMode: 'staging' });
    const realPromote = env.renameExclusive.promote;
    env.renameExclusive.promote = async (request) => {
      if (!holding && /^BACKUP-/.test(path.basename(request.to))) {
        holding = path.basename(request.from);
        await slotHeld;
      }
      return realPromote(request);
    };
    await env.runtime.start();
    const id = await env.runtime.service.start(env.config);
    const waiting = () => fs.readdirSync(folder).find((name) => name.startsWith('TEMP-') && !name.endsWith(holding));
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && !(holding && waiting())) await sleep(20);
    const changed = waiting().replace(/^TEMP-H265-/, '');
    // the car (or someone) writes to the other original while it waits
    fs.appendFileSync(path.join(folder, changed), Buffer.from('more'));
    const kept = fs.readFileSync(path.join(folder, changed));
    releaseSlot();
    const job = await env.runtime.service.whenIdle(id);
    assert.equal(job.state, 'completed');
    const failed = job.items.find((item) => item.relativePath.endsWith(changed));
    assert.equal(failed.state, 'failed');
    assert.equal(failed.failure.code, 'source-changed');
    assert.ok(Buffer.compare(fs.readFileSync(path.join(folder, changed)), kept) === 0, 'the changed original is untouched');
    assert.equal(codecOf(path.join(folder, holding)), 'hevc', 'the clip that held the slot was converted');
    assert.deepEqual(fs.readdirSync(folder).sort(), [clipName(0), clipName(1)], 'no copy or backup left');
    assert.equal(job.replacementPhase ?? null, null);
  } finally {
    await env?.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a put-back swap whose job record cannot be cleared stops the job there; the next start converts every clip', { skip, timeout: 240_000 }, async () => {
  const { base, folder } = await makeBase(2);
  const names = fs.readdirSync(folder).sort();
  const before = Object.fromEntries(names.map((name) => [name, sha256(path.join(folder, name))]));
  let env;
  try {
    let refused = 0;
    let last = null;
    env = await open(base, { factories: {
      createJobStore: (options) => {
        const store = createJobStore(options);
        return Object.freeze({ ...store, transition: async (id, patch) => {
          // the data disk is full for the write that ends the replacement record
          if (last?.replacementPhase === 'backup-restored' && patch && !patch.items && patch.replacementPhase === null
              && patch.state === 'waiting') {
            refused += 1;
            throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
          }
          last = await store.transition(id, patch);
          return last;
        } });
      }
    } });
    // the first clip's final rename fails: the swap puts its original back
    const realPromote = env.renameExclusive.promote;
    let failed = false;
    env.renameExclusive.promote = async (request) => {
      if (!failed && /^TEMP-/.test(path.basename(request.from))) {
        failed = true;
        throw Object.assign(new Error('refused'), { code: 'EPERM' });
      }
      return realPromote(request);
    };
    await env.runtime.start();
    const id = await env.runtime.service.start(env.config);
    await Promise.race([env.runtime.service.whenIdle(id), sleep(120_000)]);
    const stopped = await env.runtime.service.get(id);
    assert.ok(failed, 'the swap was put back');
    assert.equal(refused, 3, 'the record was tried three times');
    assert.equal(stopped.state, 'paused', 'the job does not carry on with the clip still recorded as mid-replacement');
    assert.equal(stopped.replacementPhase, 'backup-restored');
    assert.equal(stopped.items.filter((item) => item.state === 'completed').length, 0, 'no other clip saved meanwhile');
    for (const name of names) assert.equal(sha256(path.join(folder, name)), before[name], `${name} is untouched`);
    await env.runtime.shutdown();
    env = null;

    env = await open(base, {});
    await env.runtime.start();
    await Promise.race([env.runtime.service.whenIdle(id), sleep(120_000)]);
    const job = await env.runtime.service.get(id);
    assert.equal(job.state, 'completed', JSON.stringify(job.recovery || null));
    assert.equal(job.items.filter((item) => item.resultCode === 'converted').length, 2);
    for (const name of names) assert.equal(codecOf(path.join(folder, name)), 'hevc');
    assert.deepEqual(fs.readdirSync(folder).sort(), names);
    assert.deepEqual(leftovers(base, folder), []);
  } finally {
    await env?.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});
