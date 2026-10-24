'use strict';

// Automatic conversion gives up on a clip that failed three runs, or that was
// kept as the original because the encode was not smaller. Those clips are
// tried again once the converter changes (CONVERTER_REVISION), and an old
// index, which mixed them with converted clips, starts over, so clips that
// failed before a fix (Tesla's mid-GOP lead-in) are not skipped for good.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createAutoConverter, CONVERTER_REVISION } = require('../src/main/converter/autoConvert');

const config = (dir) => ({ sourceRoot: path.join(dir, 'src'), destinationRoot: null, codec: 'h265', profileId: 'balanced', networkMode: 'direct', outputMode: 'replace',
  includedGroups: ['RecentClips'], groupOrder: ['SavedClips', 'SentryClips', 'RecentClips'], replacementConfirmed: true, concurrency: 2, verifyMode: 'quick', autoConvert: true });
const keyOf = (c) => crypto.createHash('sha256').update(JSON.stringify([c.sourceRoot, c.destinationRoot, c.codec, c.outputMode])).digest('hex').slice(0, 24);
const clip = (rel, size = 100, mtimeMs = 5) => ({ relativePath: rel, sourceBytes: size, mtimeMs });

function setup(dir, job) {
  const jobs = [job];
  const service = { list: async () => jobs, get: async (id) => jobs.find((j) => j.id === id), start: async () => 'new', pause: async () => {}, resume: async () => {} };
  const auto = createAutoConverter({
    service, scanner: async function* () {}, fs: fs.promises, directory: dir,
    timers: { setInterval: () => null, clearInterval: () => {} }, now: () => 0, isBusy: async () => true
  });
  return { auto, jobs };
}

test('given-up clips are skipped until the converter changes; converted ones stay skipped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-giveup-'));
  try {
    const c = config(dir);
    const job = { id: 'a1', state: 'encoding', config: c, items: [] };
    const { auto } = setup(dir, job);
    await auto.start();
    job.state = 'completed';
    job.items = [
      { state: 'completed', relativePath: 'RecentClips/ok.mp4', sourcePath: path.join(dir, 'missing.mp4'), sourceBytes: 100, mtimeMs: 5 },
      { state: 'skipped', resultCode: 'already-converted', relativePath: 'RecentClips/h265.mp4', sourceBytes: 100, mtimeMs: 5 },
      { state: 'skipped', resultCode: 'no-savings', relativePath: 'RecentClips/big.mp4', sourceBytes: 100, mtimeMs: 5 }
    ];
    await auto.tick();
    assert.equal(auto.isKnown(c, clip('RecentClips/h265.mp4')), true, 'an encoded clip stays skipped');
    assert.equal(auto.isKnown(c, clip('RecentClips/big.mp4')), true, 'not smaller: skipped while the converter is the same');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, `index-${keyOf(c)}.json`), 'utf8'));
    assert.equal(saved.v, 2);
    assert.deepEqual(saved.gaveUp['RecentClips/big.mp4'], [100, 5, CONVERTER_REVISION]);
    assert.ok(saved.files['RecentClips/h265.mp4']);

    // the same index read by a later converter: the given-up clip is tried again
    saved.gaveUp['RecentClips/big.mp4'][2] = CONVERTER_REVISION - 1;
    fs.writeFileSync(path.join(dir, `index-${keyOf(c)}.json`), JSON.stringify(saved));
    const later = setup(dir, { id: 'a2', state: 'encoding', config: c, items: [] });
    await later.auto.start();
    assert.equal(later.auto.isKnown(c, clip('RecentClips/big.mp4')), false, 'tried again after a converter change');
    assert.equal(later.auto.isKnown(c, clip('RecentClips/h265.mp4')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a clip that failed three runs is given up, and an old (version 1) index starts over', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-giveup-'));
  try {
    const c = config(dir);
    // version 1: a clip given up on before the lead-in fix looked like a converted one
    fs.writeFileSync(path.join(dir, `index-${keyOf(c)}.json`), JSON.stringify({ v: 1, files: { 'RecentClips/repeater.mp4': [100, 5] }, failures: {} }));
    let run = setup(dir, { id: 'r0', state: 'encoding', config: c, items: [] });
    await run.auto.start();
    assert.equal(run.auto.isKnown(c, clip('RecentClips/repeater.mp4')), false, 'the old index is not trusted');
    for (let i = 1; i <= 3; i++) {
      run.jobs[0].state = 'completed';
      run.jobs[0].items = [{ state: 'failed', relativePath: 'RecentClips/repeater.mp4', sourceBytes: 100, mtimeMs: 5 }];
      await run.auto.tick();
      assert.equal(run.auto.isKnown(c, clip('RecentClips/repeater.mp4')), i === 3, `after ${i} failed run(s)`);
      if (i < 3) {
        run = setup(dir, { id: `r${i}`, state: 'encoding', config: c, items: [] });
        await run.auto.start();
      }
    }
    const saved = JSON.parse(fs.readFileSync(path.join(dir, `index-${keyOf(c)}.json`), 'utf8'));
    assert.deepEqual(saved.gaveUp['RecentClips/repeater.mp4'], [100, 5, CONVERTER_REVISION]);
    assert.equal(saved.files['RecentClips/repeater.mp4'], undefined);
    // a changed file is always looked at again
    assert.equal(run.auto.isKnown(c, clip('RecentClips/repeater.mp4', 101)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
