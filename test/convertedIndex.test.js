'use strict';

// The converted-clips index: what it remembers survives a restart, and an
// entry only counts while the file is exactly the one that was recorded.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createConvertedIndex, KEEP_UNSEEN_DAYS } = require('../src/main/converter/convertedIndex');

const DAY = 24 * 60 * 60 * 1000;

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-index-'));
  return { dir, file: path.join(dir, 'converter-index', 'converted-clips.json') };
}

const clip = (name, extra = {}) => ({
  sourcePath: `/footage/TeslaCam/SentryClips/2026-10-20_07-44-14/${name}`,
  sourceBytes: 1234567,
  mtimeMs: 1760946254123.4567,
  ...extra
});

test('round trip: what was recorded is known after a restart, and nothing else', async () => {
  const { dir, file } = await setup();
  try {
    const index = createConvertedIndex({ file, flushDelayMs: 60_000 });
    assert.equal(await index.load(), 0, 'no file yet');
    assert.equal(index.add(clip('a-front.mp4', { ino: 42 }), 'h265'), true);
    assert.equal(index.add(clip('a-back.mp4'), 'av1'), true);
    assert.equal(index.add(clip('a-left.mp4'), 'h264'), false, 'only converted codecs are recorded');
    assert.equal(await index.flush(), true);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['converted-clips.json'], 'no temporary file left');

    const reopened = createConvertedIndex({ file });
    assert.equal(await reopened.load(), 2);
    assert.equal(reopened.has(clip('a-front.mp4', { ino: 42 })), 'h265');
    assert.equal(reopened.has(clip('a-back.mp4')), 'av1');
    assert.equal(reopened.has(clip('a-left.mp4')), null);
    assert.equal(reopened.has(clip('a-right.mp4')), null);
    assert.equal(reopened.has({}), null);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a file that changed (size, time or inode) is looked at again', async () => {
  const { dir, file } = await setup();
  try {
    const index = createConvertedIndex({ file, flushDelayMs: 60_000 });
    await index.load();
    for (const name of ['size.mp4', 'time.mp4', 'inode.mp4', 'same.mp4', 'no-inode.mp4']) index.add(clip(name, { ino: 7 }), 'h265');
    assert.equal(index.has(clip('size.mp4', { ino: 7, sourceBytes: 1234568 })), null);
    assert.equal(index.has(clip('time.mp4', { ino: 7, mtimeMs: 1760946254124.4567 })), null);
    assert.equal(index.has(clip('inode.mp4', { ino: 8 })), null, 'replaced by another file of the same size and time');
    assert.equal(index.has(clip('same.mp4', { ino: 7 })), 'h265');
    // a filesystem that reports no inode (some shares): size and time decide
    assert.equal(index.has(clip('no-inode.mp4')), 'h265');
    // the stale entries are gone, also after a restart
    assert.equal(index.has(clip('size.mp4', { ino: 7 })), null);
    await index.flush();
    const reopened = createConvertedIndex({ file });
    assert.equal(await reopened.load(), 2);
    assert.equal(reopened.has(clip('time.mp4', { ino: 7 })), null);
    assert.equal(reopened.has(clip('same.mp4', { ino: 7 })), 'h265');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('large inodes (64-bit, from a bigint stat or a share) still compare', async () => {
  const { dir, file } = await setup();
  try {
    const index = createConvertedIndex({ file });
    await index.load();
    index.add(clip('big.mp4', { ino: 18446744073709551000n }), 'h265');
    await index.flush();
    const reopened = createConvertedIndex({ file });
    await reopened.load();
    assert.equal(reopened.has(clip('big.mp4', { ino: 18446744073709551000n })), 'h265');
    assert.equal(reopened.has(clip('big.mp4', { ino: 18446744073709551001n })), null);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test(`entries not seen for ${KEEP_UNSEEN_DAYS} days are dropped when it is saved; a hit keeps one`, async () => {
  const { dir, file } = await setup();
  let now = Date.UTC(2026, 9, 1);
  try {
    const index = createConvertedIndex({ file, now: () => now });
    await index.load();
    index.add(clip('old.mp4'), 'h265');
    index.add(clip('kept.mp4'), 'h265');
    await index.flush();
    now += 20 * DAY;
    assert.equal(index.has(clip('kept.mp4')), 'h265', 'seen again on day 20');
    now += 15 * DAY;
    index.add(clip('new.mp4'), 'av1');
    await index.flush();
    assert.equal(index.size, 2);
    const reopened = createConvertedIndex({ file, now: () => now });
    await reopened.load();
    assert.equal(reopened.has(clip('old.mp4')), null);
    assert.equal(reopened.has(clip('kept.mp4')), 'h265');
    assert.equal(reopened.has(clip('new.mp4')), 'av1');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the index never grows past its cap; the least recently seen go first', async () => {
  const { dir, file } = await setup();
  let now = Date.UTC(2026, 9, 1);
  try {
    const index = createConvertedIndex({ file, now: () => now, maxEntries: 3 });
    await index.load();
    for (let n = 0; n < 5; n += 1) {
      index.add(clip(`${n}.mp4`), 'h265');
      now += DAY;
    }
    await index.flush();
    const reopened = createConvertedIndex({ file, now: () => now });
    assert.equal(await reopened.load(), 3);
    assert.deepEqual([0, 1, 2, 3, 4].map((n) => reopened.has(clip(`${n}.mp4`))), [null, null, 'h265', 'h265', 'h265']);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('many additions share one write; a damaged or foreign file starts over', async () => {
  const { dir, file } = await setup();
  try {
    let writes = 0;
    const counting = Object.create(fsp);
    counting.writeFile = async (...args) => { writes += 1; return fsp.writeFile(...args); };
    const index = createConvertedIndex({ file, fs: counting, flushDelayMs: 60_000 });
    await index.load();
    for (let n = 0; n < 5000; n += 1) index.add(clip(`${n}.mp4`), 'h265');
    await index.flush();
    await index.flush(); // nothing new: no write
    assert.equal(writes, 1);

    for (const damaged of ['{"v":1,"entries":', 'null', '{"v":99,"entries":{}}', '{"v":1,"entries":{"relative.mp4":[1,2,null,"h265",1]}}']) {
      await fsp.writeFile(file, damaged);
      const reopened = createConvertedIndex({ file });
      assert.equal(await reopened.load(), 0, damaged);
      assert.equal(reopened.has(clip('1.mp4')), null);
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a failed write is tried again with the next flush, and a pending one goes out by itself', async () => {
  const { dir, file } = await setup();
  try {
    let fail = true;
    const flaky = Object.create(fsp);
    flaky.rename = async (...args) => {
      if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return fsp.rename(...args);
    };
    const index = createConvertedIndex({ file, fs: flaky, flushDelayMs: 20 });
    await index.load();
    index.add(clip('a.mp4'), 'h265');
    assert.equal(await index.flush(), false);
    assert.equal(fs.existsSync(file), false);
    fail = false;
    index.add(clip('b.mp4'), 'h265'); // schedules a flush on its own
    for (let i = 0; i < 100 && !fs.existsSync(file); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    const reopened = createConvertedIndex({ file });
    assert.equal(await reopened.load(), 2, 'both, including the one whose write failed');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
