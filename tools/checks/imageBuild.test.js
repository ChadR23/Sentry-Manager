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
  assert.doesNotMatch(workflow, /npm test|server\/index\.js|test\/\*\*/, 'nothing of the Node server is left');
  assert.match(workflow, /push-by-digest=true/, 'the builds push untagged');
  assert.equal((workflow.match(/^\s+tags:/gm) || []).length, 1, 'only the local check image has a tag in a build');
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
