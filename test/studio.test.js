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
const WEB = path.join(__dirname, '..', 'web');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'vendor' ? [] : jsFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

/** The scripts, stylesheets, fonts and modules a page in src/renderer loads. */
function pageRefs(page) {
  const html = read(RENDERER, page);
  return [...html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:|data:|\/\/)/.test(u));
}
// served at /studio/<file>; /web/ is the manager's own folder
const refFile = (ref) => {
  const file = ref.split(/[?#]/)[0];
  return file.startsWith('/web/') ? path.join(WEB, file.slice(5)) : path.resolve(RENDERER, file);
};

test('every script, stylesheet and module Studio loads exists', () => {
  const refs = pageRefs('index.html');
  assert.ok(refs.includes('scripts/data/dashcam-mp4.js'));
  for (const ref of refs) assert.ok(fs.existsSync(refFile(ref)), `index.html loads ${ref}`);
  // the Encoder tab's page (encoder.html): the converter on its own
  const encoderRefs = pageRefs('encoder.html');
  for (const ref of ['encoder.js', 'styles/footageConverter.css', 'styles/encoderBase.css', 'styles/encoderPage.css', '/web/encoderSkeleton.css']) {
    assert.ok(encoderRefs.includes(ref), `encoder.html loads ${ref}`);
  }
  for (const ref of encoderRefs) assert.ok(fs.existsSync(refFile(ref)), `encoder.html loads ${ref}`);
  assert.ok(!encoderRefs.includes('script.js'), 'none of the viewer');
  for (const sheet of ['styles/encoderBase.css', 'styles/encoderPage.css']) {
    for (const m of read(RENDERER, sheet).matchAll(/url\('([^')]+)'\)/g)) {
      if (m[1].startsWith('data:')) continue;
      const file = m[1].startsWith('/web/') ? path.join(WEB, m[1].slice(5)) : path.resolve(RENDERER, 'styles', m[1]);
      assert.ok(fs.existsSync(file), `${sheet} loads ${m[1]}`);
    }
  }
  for (const file of [...jsFiles(RENDERER), ...jsFiles(path.join(RENDERER, '..', 'shared'))]) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), m[1])), `${path.relative(RENDERER, file)} imports ${m[1]}`);
    }
  }
});

test('the encoder page has every element the converter looks up, as in Studio', () => {
  const page = read(RENDERER, 'encoder.html');
  const controller = read(RENDERER, 'scripts', 'features', 'footageConverter.js');
  const collect = controller.slice(controller.indexOf('function collectElements('), controller.indexOf('function phaseFor('));
  const ids = [...collect.matchAll(/byId\('([\w-]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length > 80, 'found the controller\'s lookups');
  const pageIds = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const id of ids) assert.ok(pageIds.has(id), `encoder.html has #${id}`);
  // the same converter as Studio's: every element of index.html's converter
  // (a new one there belongs here too)
  const studio = read(RENDERER, 'index.html');
  const start = studio.indexOf('<section id="converterWorkspace"');
  const end = studio.indexOf('\n            </section>', start);
  assert.ok(start > 0 && end > start);
  // (lists the controller still accepts from older markup are absent in both)
  for (const attr of [...collect.matchAll(/all\('\[([\w-]+)\]'\)/g)].map((m) => m[1])) {
    if (studio.slice(start, end).includes(` ${attr}=`)) assert.ok(page.includes(` ${attr}=`), `encoder.html has [${attr}]`);
  }
  for (const m of studio.slice(start, end).matchAll(/\s(id|data-converter-[\w-]+)="([^"]*)"/g)) {
    if (m[1] === 'id' && m[2] === 'converterWorkspace') continue;
    assert.ok(page.includes(` ${m[1]}="${m[2]}"`), `encoder.html has ${m[1]}="${m[2]}" like Studio's converter`);
  }
});

test('the encoder page and the shell draw the same loading skeleton', () => {
  const bay = (html) => {
    const start = html.indexOf('<div class="enc-sk-bay"');
    let depth = 0;
    for (const m of html.slice(start).matchAll(/<(\/?)div\b[^>]*>/g)) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) return html.slice(start, start + m.index + m[0].length).replace(/>\s+</g, '><').replace(/\s+/g, ' ');
    }
    return null;
  };
  const page = bay(read(RENDERER, 'encoder.html'));
  assert.ok(page && page.includes('enc-sk-counters'));
  assert.equal(bay(read(WEB, 'index.html')), page);
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
