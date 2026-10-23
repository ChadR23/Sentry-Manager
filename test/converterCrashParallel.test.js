'use strict';

// docker kill with six clips converting at once: whatever each clip was doing
// (staging, encoding, copying beside its original, or the one clip in the
// save slot), the restart cleans up and re-queues the clips that had not
// reached the save slot, finishes or rolls back the one that had, and the job
// completes with every clip converted and nothing left behind.

const test = require('node:test');
const { crashAndRecover, assertRecovered, available } = require('./fixtures/crashPoints');

const skip = available() ? false : 'needs ffmpeg and build/noreplace-rename';

for (const [label, point, mode = 'replace'] of [
  ['the first encode started', 'encode'],
  ['a copy beside its original was half written', 'temp-torn'],
  ['a complete copy waited for the save slot', 'copy-recorded'],
  ['a clip entered the save slot', 'slot-entered'],
  ['the original was moved to its backup name', 'backup-renamed'],
  ['a conversion was about to take its original\'s name', 'before-final'],
  ['a backup was half removed', 'quarantined'],
  ['the backup was gone and the result about to be written', 'before-result'],
  ['a clip\'s result was written', 'after-result'],
  ['a clip\'s private files were being removed', 'cleanup-unrecorded'],
  ['a .partial copy was half written', 'temp-torn', 'separate'],
  ['a complete .partial copy waited for the save slot', 'copy-recorded', 'separate'],
  ['a clip entered the save slot', 'slot-entered', 'separate'],
  ['a copy had just been published', 'after-final', 'separate'],
  ['a clip\'s result was written', 'after-result', 'separate']
]) {
  test(`six at once (${mode}), killed when ${label}: the job finishes by itself`, { skip, timeout: 240_000 }, async () => {
    assertRecovered(await crashAndRecover({ point, mode, networkMode: 'staging', concurrency: 6 }), { mode });
  });
}

test('three clips under way, lowered to one at once, then killed: all three are cleaned up and converted', { skip, timeout: 240_000 }, async () => {
  assertRecovered(await crashAndRecover({ point: 'lowered', networkMode: 'staging', concurrency: 3 }));
});
