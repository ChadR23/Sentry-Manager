'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTotal, shortCount, badgeSvg } = require('../tools/downloadsBadge');

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
