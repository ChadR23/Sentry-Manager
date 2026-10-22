'use strict';

// The embedded Sentry Studio: every file its page loads is in the repository
// (a missing script stops Studio before it starts: no clips, dead buttons),
// and the Viewer finds a vehicle's clip folders wherever they are on the share.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { findClipRoot } = require('../server/vehicles');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'vendor' ? [] : jsFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

test('every script, stylesheet and module Studio loads exists', () => {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:|data:|\/\/)/.test(u));
  assert.ok(refs.includes('scripts/data/dashcam-mp4.js'));
  for (const ref of refs) assert.ok(fs.existsSync(path.resolve(RENDERER, ref.split(/[?#]/)[0])), `index.html loads ${ref}`);
  for (const file of [...jsFiles(RENDERER), ...jsFiles(path.join(RENDERER, '..', 'shared'))]) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), m[1])), `${path.relative(RENDERER, file)} imports ${m[1]}`);
    }
  }
});

test('the Viewer opens the folder that holds the clip folders, wherever it is on the share', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-studio-'));
  const mk = (...p) => fsp.mkdir(path.join(dir, ...p), { recursive: true });
  try {
    await mk('direct', 'RecentClips');
    await mk('teslacam', 'TeslaCam', 'SentryClips');
    await mk('deeper', 'Archive', 'TeslaCam', 'SavedClips');
    await mk('deeper', '.hidden', 'RecentClips'); // never inside hidden folders
    await mk('two', 'b-copy', 'RecentClips');
    await mk('two', 'TeslaCam', 'RecentClips');
    await mk('empty', 'Pictures');
    assert.equal(findClipRoot(path.join(dir, 'direct')), path.join(dir, 'direct'));
    assert.equal(findClipRoot(path.join(dir, 'teslacam')), path.join(dir, 'teslacam', 'TeslaCam'));
    assert.equal(findClipRoot(path.join(dir, 'deeper')), path.join(dir, 'deeper', 'Archive', 'TeslaCam'));
    assert.equal(findClipRoot(path.join(dir, 'two')), path.join(dir, 'two', 'TeslaCam'), 'TeslaCam wins among equals');
    assert.equal(findClipRoot(path.join(dir, 'empty')), null);
    assert.equal(findClipRoot(path.join(dir, 'missing')), null);
    assert.equal(findClipRoot(path.join(dir, 'deeper'), { maxDepth: 1 }), null, 'bounded depth');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
