'use strict';

// The built-in Viewer gets English with the page and each other language on
// its own when it is first shown (server/studioTranslations.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createStudioTranslations } = require('../server/studioTranslations');

test('English in the page\'s module, every other language a null there and a file of its own', async () => {
  const file = path.join(__dirname, '..', 'src/renderer/scripts/data/translations.js');
  const t = createStudioTranslations(file);
  const mod = await t.module();
  const { translations } = await import(`data:text/javascript;base64,${Buffer.from(mod.body).toString('base64')}`);
  const full = (await import(`data:text/javascript;base64,${require('node:fs').readFileSync(file).toString('base64')}`)).translations;
  assert.deepEqual(Object.keys(translations), Object.keys(full), 'every language is listed');
  assert.deepEqual(translations.en, full.en, 'English whole');
  for (const lang of Object.keys(full).filter((l) => l !== 'en')) assert.equal(translations[lang], null, `${lang} left for later`);
  assert.ok(mod.body.length < 0.2 * require('node:fs').statSync(file).size, 'a fraction of the whole file');
  const es = await t.language('es');
  assert.deepEqual(JSON.parse(es.body), full.es);
  assert.notEqual(es.etag, mod.etag);
  assert.equal(await t.language('xx'), null);
});
