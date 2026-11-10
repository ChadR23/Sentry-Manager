'use strict';

// The built-in interface's layout at the edges (web/shell.css): long words in
// notifications, the section counts when only icons show, a short window,
// and tap targets on touch screens.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'web/shell.css'), 'utf8');
const rule = (sel) => {
  const i = css.indexOf(`${sel} {`);
  assert.ok(i >= 0, `${sel} is styled`);
  return css.slice(i, css.indexOf('}', i) + 1);
};
const media = (q) => {
  const i = css.indexOf(`@media ${q} {`);
  assert.ok(i >= 0, `@media ${q}`);
  return css.slice(i, css.indexOf('\n}', i) + 2);
};

test('Notifications: a long path or word wraps inside its row, the Dismiss button stays on the page', () => {
  assert.match(rule('.alert-item'), /grid-template-columns: 10px minmax\(0, 1fr\) auto/, 'the text column may shrink below its longest word');
  assert.match(rule('.alert-item > div'), /overflow-wrap: anywhere/);
});

test('Section counts show on the icons when the sidebar is collapsed and on phones', () => {
  assert.doesNotMatch(css, /\.app\.collapsed \.nav \.count[^{]*\{[^}]*display: none/, 'collapsed: not hidden');
  assert.match(rule('.app.collapsed .nav .count'), /position: absolute/);
  const phone = media('(max-width: 760px)');
  assert.doesNotMatch(phone, /\.nav \.count[^{]*\{[^}]*display: none/, 'phone bar: not hidden');
  assert.match(phone, /\.nav \.count \{ position: absolute;/);
  assert.match(rule('.nav a'), /position: relative/, 'placed on its own section');
});

test('A short window: the sidebar sections scroll inside the card instead of running out of reach', () => {
  assert.match(rule('.side-card'), /overflow-y: auto/);
  assert.match(media('(max-height: 720px) and (min-width: 761px)'), /\.nav a, \.collapse \{ padding-top: 8px; padding-bottom: 8px; \}/);
});

test('Touch screens: a check box line is at least 32 px tall', () => {
  assert.match(media('(pointer: coarse)'), /\.check \{ min-height: 32px; \}/);
});
