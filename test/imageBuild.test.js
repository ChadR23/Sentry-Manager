'use strict';

// The image build: the weekly rebuild really fetches Debian's security fixes
// (its package step is not reused from the build cache), and CUDA keeps its
// own GPU order for every ffmpeg that names no GPU.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');

test('the package step runs again each week instead of coming from the build cache', () => {
  const dockerfile = fs.readFileSync(path.join(REPO, 'Dockerfile'), 'utf8');
  const arg = dockerfile.indexOf('ARG APT_REFRESH');
  const upgrade = dockerfile.indexOf('apt-get upgrade -y');
  const run = dockerfile.lastIndexOf('\nRUN ', upgrade);
  assert.ok(arg > 0 && arg < run, 'declared before the step that upgrades');
  assert.match(dockerfile.slice(run, upgrade), /\$\{APT_REFRESH/, 'and used by it');
  const workflow = fs.readFileSync(path.join(REPO, '.github/workflows/image.yml'), 'utf8');
  assert.match(workflow, /echo "week=\$\(date -u \+%G-W%V\)"/);
  assert.equal((workflow.match(/APT_REFRESH=\$\{\{ steps\.names\.outputs\.week \}\}/g) || []).length, 2, 'the checked build and the published one');
});

test('CUDA\'s GPU order is not changed for the whole container', () => {
  const dockerfile = fs.readFileSync(path.join(REPO, 'Dockerfile'), 'utf8');
  assert.doesNotMatch(dockerfile, /CUDA_DEVICE_ORDER/, 'only an ffmpeg that names an NVIDIA GPU by index gets PCI order');
});
