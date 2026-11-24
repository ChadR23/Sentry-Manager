'use strict';

// The Encoder page's failed clips: an unsafe-owned-path refusal shows why, in
// plain words, with the check's own words under them.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/scripts/features/footageConverter.js')).href);

test('a refusal detail reads in plain words, with the check kept', async () => {
  const { refusalWhy } = await load();
  const why = (detail) => refusalWhy({ code: 'unsafe-owned-path', retryable: false, detail });
  assert.deepEqual(why('remove-exact-owned: nlink 2 != 1 (state owned)'), {
    plain: 'The file has a second name (a hard link, often left by a backup or deduplication), so it was not touched.',
    detail: 'remove-exact-owned: nlink 2 != 1 (state owned)',
  });
  assert.match(why('assert-regular-unaliased: realpath differs from path (linked folder)').plain, /linked folder/);
  assert.match(why('copy-asset: destination is outside the destination root').plain, /outside the folder/);
  assert.match(why('assert-regular-unaliased: dev 41 != 40').plain, /replaced or moved/);
  assert.match(why('read-exact: size 10 != 12').plain, /changed while/);
  assert.match(why('something new').plain, /safety check/);
  assert.equal(why('something new').detail, 'something new');
});

test('a reason lost to a restart says so; a failure without a detail shows nothing more', async () => {
  const { refusalWhy } = await load();
  const lost = refusalWhy({ code: 'unsafe-owned-path', detail: 'not known: this clip failed before the server last restarted; run it again (Retry failed, or a new job if Retry failed is refused) to see why' });
  assert.match(lost.plain, /not known.*restarted.*Retry failed/);
  assert.equal(lost.detail, '');
  assert.equal(refusalWhy({ code: 'source-changed', retryable: false }), null);
  assert.equal(refusalWhy(undefined), null);
});

test('the words can be translated', async () => {
  const { refusalWhy } = await load();
  const why = refusalWhy({ detail: 'x: nlink 3 != 1' }, (key) => `<${key}>`);
  assert.equal(why.plain, '<refusalHardLink>');
});

// source-changed: the original is not provably the version converted. The
// Studio page and the other interfaces (web/clipFailure.js) say the same.
const loadShared = () => import(pathToFileURL(path.join(__dirname, '../web/clipFailure.js')).href);
const CHANGED = [
  ['capture-source: ctime_ns changed while hashed 1 -> 2 (dev, ino, size and mtime unchanged); read again: ctime_ns changed while hashed 2 -> 3 (dev, ino, size and mtime unchanged); contents the same both times', /metadata time \(ctime\) changed, its contents did not/],
  ['source-identity: nlink 2 != 1 (also named "BACKUP-2026-08-30_20-53-04-back.mp4" (the Encoder\'s backup name for the original, left by an earlier replace that did not finish) in its folder)', /second name \(a hard link\), BACKUP-… beside it, left by an earlier Encoder replace/],
  ['source-identity: nlink 2 != 1 (no other name for it in its folder: the other link is elsewhere, e.g. a backup or deduplication tool)', /second name \(a hard link\), often made by a backup/],
  ['source-identity: ino 5 != 4', /replaced by another file/],
  ['source-identity: dev 44 != 42', /mounted again/],
  ['source-identity: size 10 != 12', /its size changed/],
  ['verify-source: bytes read 10 != size 12 (stat)', /its size changed/],
  ['source-identity: lstat ENOENT (no file at its name now: moved or deleted)', /moved or deleted/],
  ['link-backup: full hash: sha256 differs from record', /its contents changed/],
  ['capture-source: ctime_ns changed while hashed 1 -> 2 (dev, ino, size and mtime unchanged); read again: its bytes differ (sha256)', /its contents changed/],
  ['capture-source: mtime_ns changed while hashed 1 -> 2', /written to while it was read/],
  ['source-identity: realpath differs from path (linked folder)', /linked folder/],
  ['something new', /^The file changed after it was checked\. The original was kept/],
];

test('a source-changed detail reads in plain words, and the original was kept', async () => {
  const { refusalWhy } = await load();
  for (const [detail, words] of CHANGED) {
    const why = refusalWhy({ code: 'source-changed', retryable: false, detail });
    assert.match(why.plain, words, detail);
    assert.match(why.plain, /original was kept as it is, not replaced/, detail);
    assert.equal(why.detail, detail);
  }
  const lost = refusalWhy({ code: 'source-changed', detail: 'not known: this clip failed before the server last restarted; run it again (Retry failed, or a new job if Retry failed is refused) to see why' });
  assert.match(lost.plain, /not known/);
  assert.equal(lost.detail, '');
  // an unsafe-owned-path detail keeps its own words
  assert.match(refusalWhy({ code: 'unsafe-owned-path', detail: 'x: nlink 2 != 1' }).plain, /so it was not touched/);
});

test('every interface says the same as the Studio page', async () => {
  const { refusalWhy } = await load();
  const { clipFailureWhy } = await loadShared();
  const unsafe = ['remove-exact-owned: nlink 2 != 1 (state owned)', 'a: realpath differs from path (linked folder)', 'copy-asset: destination is outside the destination root', 'a: dev 41 != 40', 'read-exact: size 10 != 12', 'something new', 'not known: x'];
  for (const [code, details] of [['source-changed', CHANGED.map(([d]) => d).concat('not known: x')], ['unsafe-owned-path', unsafe]]) {
    for (const detail of details) assert.deepEqual(clipFailureWhy({ code, detail }), refusalWhy({ code, detail }), `${code} ${detail}`);
  }
  assert.equal(clipFailureWhy({ code: 'source-changed' }), null);
  assert.equal(clipFailureWhy(undefined), null);
});

test('the clips tables of the other interfaces show a failed clip\'s reason', () => {
  const fs = require('node:fs');
  for (const page of ['flux/web/flux', 'horizon/web/hz', 'aurora/web/aurora', 'daylight/web/dl']) {
    const src = fs.readFileSync(path.join(__dirname, `../examples/ui-packs/${page}/pages/encoder.js`), 'utf8');
    assert.match(src, /import \{ clipFailureWhy \} from '\/web\/clipFailure\.js';/, page);
    assert.match(src, /clipFailureWhy\(i\.failure\)/, page);
  }
});
