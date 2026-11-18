'use strict';

// The lean backend (lean/, Rust) answers the footage routes as this server
// does: lean/parity/compare.js runs both on one archive and compares the
// answers. Skipped when the lean binary is not built (cargo build --release
// in lean/) or ffmpeg is missing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LEAN = path.join(__dirname, '..', 'lean', 'target', 'release', 'sentry-lean');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const skip = !fs.existsSync(LEAN) ? 'the lean binary is not built' : !hasFfmpeg ? 'no ffmpeg' : false;

test('lean backend: the footage routes answer as the Node server does', { skip, timeout: 300_000 }, () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'lean', 'parity', 'compare.js')], { encoding: 'utf8', timeout: 290_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /answer the same/);
});
