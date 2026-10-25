'use strict';

// The Encoder's job is to get every clip into one codec. A clip that a quality
// level (or a custom bitrate) cannot make smaller is encoded again at a bitrate
// under the original's instead of staying H.264; only if that is still not
// smaller is the original kept.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, CPU } = require('./fixtures/lanesHarness');

const rate = (args) => (args.includes('-b:v') ? Number(args[args.indexOf('-b:v') + 1]) : null);
const notSmaller = { ok: false, reason: 'not-smaller', outputBytes: 4_500_000, retryable: false };

function harness(passWhen) {
  let h;
  h = createHarness({
    clips: 1,
    devices: [CPU],
    defaultDevice: null,
    gpuDecode: false,
    works: (encoder) => encoder.startsWith('lib'),
    copyAsset: async ({ destination }) => ({ finalPath: destination, outputBytes: 4_000_000, ownedPaths: {}, ownedArtifacts: {} }),
    verifier: async () => (passWhen(h.encodes().at(-1).args)
      ? { ok: true, outputBytes: 3_000_000, publicationArtifact: null }
      : notSmaller)
  });
  return h;
}

test('a clip constant quality cannot make smaller is encoded again under the original bitrate', async () => {
  // only a bitrate-limited encode comes out smaller
  const h = harness((args) => rate(args) !== null && !args.includes('-crf'));
  try {
    const id = await h.service.start(h.config({ profileId: 'quality', qualityLevel: 'balanced', bitrateKbps: undefined }));
    const job = await h.finishJob(id);
    const [item] = job.items.filter((entry) => entry.kind === 'video');
    assert.equal(item.resultCode, 'converted');
    const encodes = h.encodes().map((entry) => entry.args);
    assert.equal(encodes.length, 2);
    assert.ok(encodes[0].includes('-crf'), 'first the quality level');
    assert.ok(rate(encodes[1]) > 0 && !encodes[1].includes('-crf'), 'then a bitrate');
    // 85% of a 4 MB, 2 s clip is under the original's 16 Mbit/s
    assert.ok(rate(encodes[1]) < 4_000_000 * 8 / 2);
  } finally {
    await h.close();
  }
});

test('the bitrate steps down once more, then the original is kept as before', async () => {
  const h = harness(() => false);
  try {
    const id = await h.service.start(h.config({ profileId: 'quality', qualityLevel: 'balanced', bitrateKbps: undefined }));
    const job = await h.finishJob(id);
    const [item] = job.items.filter((entry) => entry.kind === 'video');
    assert.equal(item.resultCode, 'no-savings');
    const rates = h.encodes().map((entry) => rate(entry.args));
    assert.equal(rates.length, 3);
    assert.equal(rates[0], null);
    assert.ok(rates[2] < rates[1], `${rates[2]} < ${rates[1]}`);
  } finally {
    await h.close();
  }
});
