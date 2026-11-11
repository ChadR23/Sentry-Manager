'use strict';

// "Build 128 · Nov 11, 2026" (web/buildLabel.js), the same in every
// interface: the version people read out when they ask for help. The commit
// is only in the tooltip.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
// an ES module in a CommonJS package: loaded from its text, as the pack tests do
const load = () => import(`data:text/javascript,${encodeURIComponent(fs.readFileSync(path.join(REPO, 'web', 'buildLabel.js'), 'utf8'))}`);
const SHA = 'cb593ca1234567890abcdef1234567890abcdef0';

test('the running build: number and date, the commit only in the tooltip', async () => {
  const b = await load();
  assert.equal(b.buildText({ sha: SHA, build: 128, builtAt: '2026-11-11T04:12:00Z' }), 'Build 128 · Nov 11, 2026');
  assert.equal(b.buildText({ sha: SHA, build: 128 }), 'Build 128');
  assert.equal(b.buildTip({ sha: SHA, build: 128, tag: 'latest' }), `Commit ${SHA} · image tag latest`);
  assert.equal(b.buildTip({ sha: SHA }, null), `Commit ${SHA}`);
  // an image from before build numbers: its short commit, as before
  assert.equal(b.buildText({ sha: SHA, builtAt: '2026-11-01T04:00:00Z' }), 'cb593ca · built Nov 1, 2026');
  // a copy built from source
  assert.equal(b.buildText({}), 'built from source');
  assert.equal(b.buildText(undefined, 'development'), 'development');
  assert.equal(b.buildText({ builtAt: '2026-01-05T00:00:00Z' }), 'built from source · built Jan 5, 2026');
  assert.equal(b.buildTip({}), '');
  assert.equal(b.buildText({ build: 'x', sha: SHA }), 'cb593ca', 'a strange number is none');
  assert.equal(b.buildDate('2026-12-31T23:59:59Z'), 'Dec 31, 2026', 'the UTC day the build recorded');
  assert.equal(b.buildDate('nope'), '');
});

test('Settings > Updates: "N builds behind" only when both builds have numbers and a newer one is out', async () => {
  const b = await load();
  const u = (mine, latest) => ({ current: { sha: SHA, build: mine }, latest: latest === undefined ? null : { revision: 'f'.repeat(40), build: latest, created: '2026-11-14T04:00:00Z' } });
  assert.equal(b.behindText(u(128, 131)), 'Build 131 is out: you have Build 128 (3 builds behind)');
  assert.equal(b.behindText(u(130, 131)), 'Build 131 is out: you have Build 130 (1 build behind)');
  assert.equal(b.behindText(u(131, 131)), null);
  assert.equal(b.behindText(u(132, 131)), null);
  assert.equal(b.behindText(u(null, 131)), null, 'no number of its own: the wording of before');
  assert.equal(b.behindText(u(128, null)), null);
  assert.equal(b.behindText(u(128)), null, 'not checked yet');
  assert.equal(b.latestText(u(128, 131).latest), 'Build 131 · published Nov 14, 2026');
  assert.equal(b.latestText({ revision: 'f'.repeat(40), created: '2026-11-14T04:00:00Z' }), 'fffffff · published Nov 14, 2026');
  assert.equal(b.latestText({}), 'published ?');
  assert.equal(b.latestTip({ revision: 'f'.repeat(40) }), `Commit ${'f'.repeat(40)}`);
  assert.equal(b.hostVersion('Build 128'), 'Build 128');
  assert.equal(b.hostVersion('2026.26.35'), 'version 2026.26.35');
});

// Every interface: Settings > Updates and the Version row use the shared
// helper; no short commit is cut out by hand anywhere.
const SETTINGS = {
  builtin: 'web/app.js',
  aurora: 'examples/ui-packs/aurora/web/aurora/pages/settings.js',
  daylight: 'examples/ui-packs/daylight/web/dl/pages/settings.js',
  flux: 'examples/ui-packs/flux/web/flux/pages/settings.js',
  horizon: 'examples/ui-packs/horizon/web/hz/pages/settings.js'
};
const HOST_LINES = {
  builtin: 'web/app.js',
  daylight: 'examples/ui-packs/daylight/web/dl/pages/server.js',
  flux: 'examples/ui-packs/flux/web/flux/pages/overview.js',
  horizon: 'examples/ui-packs/horizon/web/hz/pages/dashboard.js'
};

for (const [name, file] of Object.entries(SETTINGS)) {
  test(`${name}: Settings shows "Build N · date" with the commit as a tooltip, and how many builds behind`, () => {
    const src = fs.readFileSync(path.join(REPO, file), 'utf8');
    assert.doesNotMatch(src, /\.sha\.slice\(0, 7\)|version\?\.sha|revision\.slice\(0, 7\)/, 'no hand-cut commit');
    if (name === 'builtin') assert.match(src, /import\('\/web\/buildLabel\.js'\)/);
    else assert.match(src, /^import \{ buildText, buildTip, behindText, latestText, latestTip \} from '\/web\/buildLabel\.js';$/m);
    const p = name === 'builtin' ? 'bl.' : '';
    for (const fn of ['buildText(cur', 'buildTip(cur, u.tag)', 'behindText(u)', 'latestText(', 'latestTip(']) assert.ok(src.includes(`${p}${fn}`), `${name} uses ${fn}`);
    assert.match(src, /title="\$\{(?:esc|h)\(/, 'the tooltip');
    if (name !== 'builtin') assert.match(src, /buildText\((?:sys\.version|s\.version|v), /, 'the Version row');
  });
}

for (const [name, file] of Object.entries(HOST_LINES)) {
  test(`${name}: the server line shows "Build N" as it is`, () => {
    const src = fs.readFileSync(path.join(REPO, file), 'utf8');
    assert.match(src, /\/\^Build \\d\/\.test\(/);
  });
}
