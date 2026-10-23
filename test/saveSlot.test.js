'use strict';

// The save of a replaced clip, measured: the one-clip-at-a-time save slot
// holds only the renames (another clip's copy to the share runs meanwhile),
// the share is read for 3 originals and 2 conversions per clip (it was about
// 7 + 7), and the job file is written at most 15 times per clip (about 42).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { open, makeBase, available, clipName, codecOf } = require('./fixtures/crashPoints');
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

test('replacing through staging reads each clip from the share 3 times and its conversion twice, with 15 job-file writes or fewer', { skip, timeout: 240_000 }, async (t) => {
  const clips = 3;
  const { base, folder } = await makeBase(clips);
  const sizes = fs.readdirSync(folder).map((name) => fs.statSync(path.join(folder, name)).size);
  let writes = 0;
  let env;
  const reads = countReads(fs.realpathSync(path.join(base, 'footage')));
  try {
    env = await open(base, { networkMode: 'staging', factories: {
      createJobStore: (options) => {
        const store = createJobStore(options);
        return Object.freeze({ ...store, transition: (...args) => { writes += 1; return store.transition(...args); } });
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
    t.diagnostic(`share reads ${reads.bytes} bytes (originals ${S}, conversions ${O}); ${writes} job-file writes for ${clips} clips`);
    // header checks while finding the clips: a few KB each
    assert.ok(reads.bytes <= 3 * S + 2 * O + clips * 256 * 1024,
      `read ${reads.bytes} bytes from the share; 3 originals + 2 conversions are ${3 * S + 2 * O}`);
    assert.ok(reads.bytes >= 3 * S + 2 * O, 'every check before a move or removal still reads the whole file');
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
