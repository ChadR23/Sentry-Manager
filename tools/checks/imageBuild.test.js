'use strict';

// The image build: only a release builds an image (never a timer), a release
// in a new week really fetches Debian's security fixes (its package step is
// not reused from the build cache), and CUDA keeps its own GPU order for
// every ffmpeg that names no GPU.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');

test('images come only from a push to main or a run by hand, never on a timer', () => {
  const workflow = fs.readFileSync(path.join(REPO, '.github/workflows/image.yml'), 'utf8');
  const on = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'));
  assert.match(on, /push:\n\s+branches: \[main\]/);
  assert.match(on, /workflow_dispatch:/);
  assert.doesNotMatch(on, /schedule:|cron:/, 'no scheduled rebuild: an update always means a release');
});

test('the package step runs again each week instead of coming from the build cache', () => {
  const dockerfile = fs.readFileSync(path.join(REPO, 'Dockerfile'), 'utf8');
  const arg = dockerfile.indexOf('ARG APT_REFRESH');
  const upgrade = dockerfile.indexOf('apt-get upgrade -y');
  const run = dockerfile.lastIndexOf('\nRUN ', upgrade);
  assert.ok(arg > 0 && arg < run, 'declared before the step that upgrades');
  assert.match(dockerfile.slice(run, upgrade), /\$\{APT_REFRESH/, 'and used by it');
  const workflow = fs.readFileSync(path.join(REPO, '.github/workflows/image.yml'), 'utf8');
  assert.match(workflow, /echo "week=\$\(date -u \+%G-W%V\)"/);
  assert.equal((workflow.match(/APT_REFRESH=\$\{\{ needs\.names\.outputs\.week \}\}/g) || []).length, 2, 'the checked build and the published one');
});

test('nothing is tagged before every test passed and both images were checked', () => {
  const workflow = fs.readFileSync(path.join(REPO, '.github/workflows/image.yml'), 'utf8');
  assert.match(workflow, /publish:\n\s+needs: \[names, rust-tests, build\]/);
  // the Rust server's tests (lean/), with the Node server's frozen answers, and the frozen API contract
  const rust = workflow.slice(workflow.indexOf('\n  rust-tests:'), workflow.indexOf('\n  build:'));
  assert.match(rust, /cd lean && LEAN_NEED_NODE=1 cargo test --release --locked/, 'the Rust tests run before anything is tagged');
  assert.match(rust, /node tools\/contract\/frozen\.js --bin lean\/target\/release\/sentry-lean/, 'and the whole contract against the frozen answers');
  assert.match(rust, /node --test "tools\/\*\*\/\*\.test\.js"/, 'and these checks');
  // on the ffmpeg the frozen answers were recorded with (not ubuntu-latest's), and it says so if not
  assert.match(rust, /^    runs-on: ubuntu-24\.04$/m, 'the Ubuntu whose ffmpeg recorded the answers');
  assert.match(rust, /"ffmpeg version 6\.1\.1-"\*\) ;;/, 'a different ffmpeg fails the job');
  assert.doesNotMatch(workflow, /npm test|server\/index\.js|test\/\*\*/, 'nothing of the Node server is left');
  assert.match(workflow, /push-by-digest=true/, 'the builds push untagged');
  assert.equal((workflow.match(/^\s+tags:/gm) || []).length, 1, 'only the local check image has a tag in a build');
});

test('the image keeps ffmpeg 8: Jellyfin\'s, no fallback to an older one, and the image check fails anything else', () => {
  const dockerfile = fs.readFileSync(path.join(REPO, 'Dockerfile'), 'utf8');
  const run = dockerfile.slice(dockerfile.indexOf('apt-get upgrade -y'), dockerfile.indexOf('find / -xdev'));
  assert.match(run, /apt-get install -y --no-install-recommends jellyfin-ffmpeg8 /, 'Jellyfin\'s ffmpeg 8 is installed');
  assert.doesNotMatch(dockerfile, /jellyfin-ffmpeg[0-7]\b|apt-cache show/, 'and nothing falls back to an older one');
  assert.doesNotMatch(run, /install[^\n]*\sffmpeg(\s|$)/m, 'nor Debian\'s own ffmpeg');
  const workflow = fs.readFileSync(path.join(REPO, '.github/workflows/image.yml'), 'utf8');
  const check = workflow.slice(workflow.indexOf('- name: Check the image'), workflow.indexOf('docker rm -f check'));
  const gate = check.split('\n').map((l) => l.trim()).find((l) => l.startsWith('major="$(printf '));
  assert.ok(gate, 'the image check looks at the ffmpeg version');
  const fed = check.indexOf('v="$(docker exec check ffmpeg -hide_banner -version | head -1)"');
  assert.ok(fed >= 0 && fed < check.indexOf(gate), 'of the image\'s own ffmpeg');
  const { spawnSync } = require('child_process');
  const passes = (v) => spawnSync('sh', ['-c', gate], { env: { ...process.env, v } }).status === 0;
  for (const v of ['ffmpeg version 8.1.3-Jellyfin Copyright (c) 2000-2026 the FFmpeg developers', 'ffmpeg version 9.0-Jellyfin', 'ffmpeg version 10.1', 'ffmpeg version n8.0', 'ffmpeg version n10.0', 'ffmpeg version 100.1', 'ffmpeg version n100.1',
    'ffmpeg version 8.0.1 Copyright (c) 2000-2025 the FFmpeg developers', 'ffmpeg version 8.1-1ubuntu1', 'ffmpeg version 8.1+git20260101', 'ffmpeg version 8.1~rc1']) {
    assert.ok(passes(v), `${v}: passes`);
  }
  // (only a version it knows to be 8 or newer: an unknown form, like a master build's N-..., fails)
  for (const v of ['ffmpeg version 7.1.2-Jellyfin', 'ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers', 'ffmpeg version n7.1',
    'ffmpeg version N-118000-gdeadbeef', 'ffmpeg version 7-Jellyfin', 'ffmpeg version 7:6.1.1-3ubuntu5', 'ffmpeg version 07.1', 'libva info: VA-API version 1.22.0', '',
    'ffmpeg version 8.not-a-version', 'ffmpeg version 8.', 'ffmpeg version 10.x', 'ffmpeg version n8.x', 'ffmpeg version 8:6.1.1', 'ffmpeg version 08.1', 'ffmpeg version 8.0garbage', 'ffmpeg version 8.1.3garbage', 'ffmpeg version 8.1.x',
    'ffmpeg version 8.1-', 'ffmpeg version 8.1+', 'ffmpeg version 8.1~', 'ffmpeg version 8.1- Copyright']) {
    assert.ok(!passes(v), `${v || '(nothing)'}: fails the check`);
  }
});

test('CUDA\'s GPU order is not changed for the whole container', () => {
  const dockerfile = fs.readFileSync(path.join(REPO, 'Dockerfile'), 'utf8');
  assert.doesNotMatch(dockerfile, /CUDA_DEVICE_ORDER/, 'only an ffmpeg that names an NVIDIA GPU by index gets PCI order');
});

test('every image gets the run number as its build number: build arg, label and a build-N tag on releases', () => {
  const workflow = fs.readFileSync(path.join(REPO, '.github/workflows/image.yml'), 'utf8');
  assert.match(workflow, /echo "build=\$GITHUB_RUN_NUMBER"/);
  assert.match(workflow, /^\s+build: \$\{\{ steps\.names\.outputs\.build \}\}$/m);
  assert.equal((workflow.match(/BUILD_NUMBER=\$\{\{ needs\.names\.outputs\.build \}\}/g) || []).length, 2, 'the checked build and the published one');
  assert.equal((workflow.match(/GIT_SHA=\$\{\{ needs\.names\.outputs\.sha \}\}/g) || []).length, 2);
  assert.match(workflow, /org\.opencontainers\.image\.version=build-\$\{\{ needs\.names\.outputs\.build \}\}/);
  const publish = workflow.slice(workflow.indexOf('\n  publish:'));
  assert.match(publish, /-t "\$image:\$\{\{ needs\.names\.outputs\.tag \}\}" -t "\$image:sha-\$\{\{ needs\.names\.outputs\.short \}\}"/, 'the old tags stay');
  assert.match(publish, /if \[ "\$\{\{ needs\.names\.outputs\.tag \}\}" = latest \]; then tags\+=\(-t "\$image:build-\$\{\{ needs\.names\.outputs\.build \}\}"\); fi/, 'build-N only for a release');
  assert.match(publish, /imagetools create "\$\{tags\[@\]\}"/, 'put on at the end, with the others');
});

test('BUILD_INFO.json has "build" as a number, and none for a local build', () => {
  // (the Rust server reads it, with its own tests in lean/)
  const dockerfile = fs.readFileSync(path.join(REPO, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^ARG BUILD_NUMBER=""$/m);
  const start = dockerfile.indexOf('\nRUN build=""');
  assert.ok(start > 0);
  const end = dockerfile.indexOf('/app/BUILD_INFO.json', start) + '/app/BUILD_INFO.json'.length;
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sm-build-'));
  // the Dockerfile's own RUN step, under the image's /bin/sh
  const step = dockerfile.slice(start + 5, end).replace(/\\\n/g, ' ').replace('/app/BUILD_INFO.json', JSON.stringify(path.join(dir, 'BUILD_INFO.json')));
  const run = (BUILD_NUMBER) => {
    require('child_process').execFileSync('sh', ['-c', step], { env: { ...process.env, GIT_SHA: 'cb593ca'.padEnd(40, '0'), GIT_BRANCH: 'main', BUILD_DATE: '2026-11-11T04:00:00Z', IMAGE: 'ghcr.io/o/r', IMAGE_TAG: 'latest', BUILD_NUMBER } });
    return fs.readFileSync(path.join(dir, 'BUILD_INFO.json'), 'utf8');
  };
  try {
    assert.deepEqual(JSON.parse(run('128')), { sha: 'cb593ca'.padEnd(40, '0'), branch: 'main', builtAt: '2026-11-11T04:00:00Z', image: 'ghcr.io/o/r', tag: 'latest', build: 128 });
    for (const n of ['', '0', '012', '12a', '1;2']) {
      const info = JSON.parse(run(n));
      assert.equal('build' in info, false, JSON.stringify(n));
      assert.equal(info.sha, 'cb593ca'.padEnd(40, '0'));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
