'use strict';

// The Encoder page's note about leftover files of an earlier replace
// (snapshot.backupCleanup): plain words, the kept names listed with why, and
// every interface (web/backupCleanup.js) says the same as the Studio page.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const studio = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/scripts/features/footageConverter.js')).href);
const shared = () => import(pathToFileURL(path.join(__dirname, '../web/backupCleanup.js')).href);

const CASES = [
  { removed: 2, restored: 1, binned: 1, kept: 1, keptWhy: [{ path: 'SentryClips/e/BACKUP-x-front.mp4', why: 'job 7 still names it in its record' }] },
  { removed: 1, restored: 0, binned: 0, kept: 0, keptWhy: [] },
  { removed: 0, restored: 2, binned: 0, kept: 0, keptWhy: [] },
  { removed: 0, restored: 0, binned: 0, kept: 23, keptWhy: Array.from({ length: 20 }, (_, i) => ({ path: `a/BACKUP-${i}`, why: 'a symbolic link (never followed)' })) },
  { removed: 0, restored: 0, binned: 0, kept: 0, keptWhy: [] },
  { removed: 1, restored: 0, binned: 0, kept: 3, unverified: 2, keptWhy: [{ path: 'a/BACKUP-x-front.mp4', why: 'the converted copy beside it is not verified (the H.265 copy "x-front.mp4" failed the check: decode-failed, non-zero-status)' }] },
  { removed: 0, restored: 0, binned: 0, kept: 1, unverified: 1, keptWhy: [] },
  { removed: 0, restored: 0, binned: 0, kept: 1, unverified: 5, keptWhy: [] },
  null,
  'nonsense',
];

test('the words say what was tidied, put back, moved and kept', async () => {
  const { backupCleanupWords } = await shared();
  const w = backupCleanupWords(CASES[0]);
  assert.equal(w.summary, 'Leftover files from an earlier replace: 2 tidied, 1 original put back, 1 moved to the Recycle Bin, 1 kept.');
  assert.deepEqual(w.kept, CASES[0].keptWhy);
  assert.equal(w.more, 0);
  assert.equal(backupCleanupWords(CASES[2]).summary, 'Leftover files from an earlier replace: 2 originals put back.');
  assert.equal(backupCleanupWords(CASES[3]).more, 3, 'the server sends the first 20');
  assert.equal(backupCleanupWords(CASES[4]), null, 'nothing done: nothing shown');
  assert.equal(backupCleanupWords(undefined), null);
  // originals beside a converted copy that is not proven good are counted on their own
  assert.equal(backupCleanupWords(CASES[5]).summary, 'Leftover files from an earlier replace: 1 tidied, 2 originals kept (the converted copies beside them are not verified), 1 kept.');
  assert.equal(backupCleanupWords(CASES[6]).summary, 'Leftover files from an earlier replace: 1 original kept (the converted copy beside it is not verified).');
  assert.equal(backupCleanupWords(CASES[7]).summary, 'Leftover files from an earlier replace: 1 original kept (the converted copy beside it is not verified).', 'never more than were kept');
  assert.match(backupCleanupWords(CASES[5]).kept[0].why, /^the converted copy beside it is not verified \(/);
});

test('the HTML escapes names and lists the kept ones under a details', async () => {
  const { backupCleanupHtml } = await shared();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = backupCleanupHtml({ removed: 0, restored: 0, binned: 0, kept: 1, keptWhy: [{ path: 'a/BACKUP-<b>.mp4', why: 'x & y' }] }, esc, 'note backup-cleanup');
  assert.match(html, /^<div class="note backup-cleanup" role="status"><span>Leftover files from an earlier replace: 1 kept\.<\/span><details><summary>Kept as they are, and why<\/summary><ul><li><code>a\/BACKUP-&#60;b&#62;\.mp4<\/code> x &#38; y<\/li><\/ul><\/details><\/div>$/);
  assert.equal(backupCleanupHtml(null, esc), '');
});

test('every interface says the same as the Studio page', async () => {
  const { backupCleanupWords: studioWords } = await studio();
  const { backupCleanupWords } = await shared();
  for (const c of CASES) assert.deepEqual(studioWords(c), backupCleanupWords(c), JSON.stringify(c));
  // and the Studio words can be translated
  const t = studioWords(CASES[1], (key) => `<${key}>`);
  assert.equal(t.summary, '<backupCleanup>');
});
