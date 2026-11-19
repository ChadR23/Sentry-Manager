'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTotal, shortCount, badgeSvg, fetchPage } = require('./downloadsBadge');

test('the package page total is read exactly when GitHub gives it, else from the short form', () => {
  assert.equal(parseTotal('<span class="d-block">Total downloads</span>\n  <h3 title="12345">12.3K</h3>'), 12345);
  assert.equal(parseTotal('<span>Total downloads</span><h3 title="1,234">1.2K</h3>'), 1234);
  assert.equal(parseTotal('<span>Total downloads</span>\n<h3>2.5K</h3>'), 2500);
  assert.equal(parseTotal('<span>Total downloads</span><h3>87</h3>'), 87);
  assert.equal(parseTotal('<html>Sign in</html>'), null);
});

test('counts read like other badges, and the badge escapes its text', () => {
  assert.deepEqual([0, 999, 1000, 1234, 12345, 1234567].map(shortCount), ['0', '999', '1k', '1.2k', '12k', '1.2M']);
  const svg = badgeSvg('downloads', '1.2k');
  assert.match(svg, /^<svg [^>]*aria-label="downloads: 1.2k"/);
  assert.equal(badgeSvg('a<b', '1').includes('a<b'), false);
});

test('the package page is asked again after a server error, 429 or no answer, and not after any other answer', async () => {
  const page = (status, body = '') => ({ ok: status === 200, status, text: async () => body });
  const run = async (answers) => {
    const asked = [];
    const slept = [];
    const get = async () => { const a = answers[asked.length]; asked.push(a); if (a instanceof Error) throw a; return page(a, 'the page'); };
    const opts = { get, waits: [1, 2, 3], sleep: async (ms) => { slept.push(ms); } };
    try { return { body: await fetchPage('u', opts), asked: asked.length, slept }; } catch (err) { return { error: err.message, asked: asked.length, slept }; }
  };
  assert.deepEqual(await run([200]), { body: 'the page', asked: 1, slept: [] });
  assert.deepEqual(await run([502, 503, 200]), { body: 'the page', asked: 3, slept: [1, 2] });
  assert.deepEqual(await run([429, new Error('socket hang up'), 200]), { body: 'the page', asked: 3, slept: [1, 2] });
  const gaveUp = await run([502, 502, 502, 502]);
  assert.equal(gaveUp.asked, 4);
  assert.match(gaveUp.error, /^u: HTTP 502 \(after 4 tries\)$/);
  const final = await run([404]);
  assert.deepEqual([final.asked, final.slept], [1, []]);
  assert.match(final.error, /HTTP 404 \(is the package public\?\)/);
});
