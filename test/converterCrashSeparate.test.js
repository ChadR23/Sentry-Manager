'use strict';

// docker kill at every step of converting into a separate folder: after the
// restart the job finishes by itself, each clip's conversion is in the output
// folder, the originals are untouched and no .partial or work file is left.

const test = require('node:test');
const { crashAndRecover, assertRecovered, available } = require('./fixtures/crashPoints');

const skip = available() ? false : 'needs ffmpeg and build/noreplace-rename';

for (const [label, point, networkMode = 'direct'] of [
  ['the encode', 'encode'],
  ['the telemetry writer (it had just emptied the encoded file)', 'writer'],
  ['the telemetry writer, staged', 'writer', 'staging'],
  ['the save was recorded, its copy not yet created', 'save-recorded'],
  ['the .partial copy was just created', 'temp-created'],
  ['the .partial copy was half written', 'temp-torn'],
  ['the .partial copy was complete', 'temp-complete'],
  ['that copy was recorded and the clip waited for the save slot', 'copy-recorded'],
  ['the clip entered the save slot', 'slot-entered'],
  ['the copy had just been published', 'after-final'],
  ['the clip\'s result was written', 'after-result'],
  ['the clip\'s private files were being removed', 'cleanup-unrecorded']
]) {
  test(`a separate output folder, killed when ${label}: the job finishes by itself`, { skip, timeout: 180_000 }, async () => {
    assertRecovered(await crashAndRecover({ point, mode: 'separate', networkMode }), { mode: 'separate' });
  });
}
