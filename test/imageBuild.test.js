'use strict';

// The image build: only a release builds an image (never a timer), a release
// in a new week really fetches Debian's security fixes (its package step is
// not reused from the build cache), and CUDA keeps its own GPU order for
// every ffmpeg that names no GPU.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');

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
  assert.match(workflow, /publish:\n\s+needs: \[names, tests, build\]/);
  assert.match(workflow, /push-by-digest=true/, 'the builds push untagged');
  assert.equal((workflow.match(/^\s+tags:/gm) || []).length, 1, 'only the local check image has a tag in a build');
  assert.match(workflow, /--test-shard=\$\{\{ matrix\.shard \}\}\/3/);
  assert.deepEqual([...workflow.matchAll(/^\s+shard: \[(.*)\]/gm)].map((m) => m[1]), ['1, 2, 3'], 'every part of the tests runs');
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
  const { readBuildInfo, buildName } = require('../server/buildInfo');
  const { appVersion } = require('../server/stats/host');
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
    assert.deepEqual(readBuildInfo(dir).build, 128);
    assert.equal(buildName(readBuildInfo(dir)), 'Build 128 (cb593ca)');
    assert.equal(appVersion(dir), 'Build 128');
    for (const n of ['', '0', '012', '12a', '1;2']) {
      const info = JSON.parse(run(n));
      assert.equal('build' in info, false, JSON.stringify(n));
      assert.equal(info.sha, 'cb593ca'.padEnd(40, '0'));
    }
    assert.equal(buildName(readBuildInfo(dir)), 'cb593ca', 'an image from before build numbers: its commit');
    assert.equal(appVersion(dir), 'cb593ca');
    fs.writeFileSync(path.join(dir, 'BUILD_INFO.json'), JSON.stringify({ sha: 'abc', build: 'build-7x' }));
    assert.deepEqual(readBuildInfo(dir), { sha: 'abc' }, 'a strange build is dropped');
    fs.writeFileSync(path.join(dir, 'BUILD_INFO.json'), JSON.stringify({ build: '42' }));
    assert.deepEqual(readBuildInfo(dir), { build: 42 });
    fs.rmSync(path.join(dir, 'BUILD_INFO.json'));
    assert.deepEqual(readBuildInfo(dir), {}, 'a copy built from source');
    assert.equal(buildName({}), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the startup line names the build and its commit', () => {
  const src = fs.readFileSync(path.join(REPO, 'server', 'index.js'), 'utf8');
  assert.match(src, /log\.info\(`Sentry Six Manager on https:\/\/\$\{HOST\}:\$\{PORT\} \(\$\{buildName\(buildInfo\) \|\| 'dev'\}\)`\)/);
  assert.match(src, /version: buildInfo,/, '/api/system has the whole BUILD_INFO (the build, the full commit)');
  assert.match(src, /made: new Date\(\)\.toISOString\(\), version: buildInfo,/, 'and the support bundle');
});
