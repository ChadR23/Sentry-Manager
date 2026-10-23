'use strict';

// docker kill (SIGKILL, the whole container) at every step of replacing
// originals, one clip at a time. After the restart the job finishes by itself
// (no Resume, no Cancel), every clip holds its verified H.265 conversion, and
// nothing is left behind: no TEMP- or BACKUP- file beside the clips, no
// half-removed file, no private work file. Before a clip's save the original
// is never touched; inside it the original is always either at its name or
// kept as BACKUP- until the conversion has taken its place and been checked.

const test = require('node:test');
const { crashAndRecover, assertRecovered, available } = require('./fixtures/crashPoints');

const skip = available() ? false : 'needs ffmpeg and build/noreplace-rename';

const CASES = [
  // before the clip's save: its private files are removed and it starts over
  ['the encode', 'encode'],
  ['the telemetry writer (it had just emptied the encoded file)', 'writer'],
  ['the verification', 'verify'],
  ['the conversion\'s copy beside the original was just created', 'temp-created'],
  ['that copy was half written', 'temp-torn'],
  ['that copy was complete', 'temp-complete'],
  // in the save slot
  ['the clip entered the save slot', 'slot-entered'],
  ['the original was just moved to its backup name (not yet recorded)', 'backup-renamed'],
  ['the backup was recorded', 'backup-recorded'],
  ['the conversion was about to take the original\'s name', 'before-final'],
  ['the conversion had just taken the original\'s name', 'after-final'],
  ['that was recorded', 'final-recorded'],
  ['the backup was half removed (renamed for removal, not yet unlinked)', 'quarantined'],
  ['the backup was removed and the clip\'s result was about to be written', 'before-result'],
  ['the clip\'s result was written', 'after-result']
];

for (const [label, point] of CASES) {
  test(`replacing originals, killed when ${label}: the job finishes by itself`, { skip, timeout: 180_000 }, async () => {
    assertRecovered(await crashAndRecover({ point }));
  });
}

// The share as the converter sees an SMB one: every clip copied to local
// staging first.
for (const [label, point] of [
  ['the staging copy was half written', 'staging-copy'],
  ['the encode', 'encode'],
  ['the telemetry writer', 'writer'],
  ['the conversion had just taken the original\'s name', 'after-final']
]) {
  test(`replacing originals through local staging, killed when ${label}: the job finishes by itself`, { skip, timeout: 180_000 }, async () => {
    assertRecovered(await crashAndRecover({ point, networkMode: 'staging' }));
  });
}

// Jobs an earlier version stopped and left waiting for a decision (Resume and
// Cancel both refused) carry on by themselves once this version starts.
for (const [label, point, fromState] of [
  ['an encode', 'encode', 'encoding'],
  ['the copy beside the original (half written)', 'temp-torn', 'copying']
]) {
  test(`a job an earlier version parked after a stop during ${label} finishes by itself`, { skip, timeout: 180_000 }, async () => {
    assertRecovered(await crashAndRecover({
      point,
      networkMode: 'staging',
      beforeStart: async (env) => {
        const [job] = await env.runtime.store.list();
        await env.runtime.store.transition(job.id, { state: 'paused', recovery: { fromState, action: 'manual-intervention' } });
      }
    }));
  });
}
