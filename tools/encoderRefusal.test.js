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
  const lost = refusalWhy({ code: 'unsafe-owned-path', detail: 'not known: this clip failed before the server last restarted. Retry failed to see why' });
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
