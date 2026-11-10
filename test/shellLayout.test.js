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

test('Footage > a recording\'s files: the event line wraps, and a phone shows each clip\'s whole name on its own line', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'web/app.js'), 'utf8');
  assert.match(app, /const ev = d\.event \? `<li class="files-event"><span>/);
  assert.match(rule('.files li.files-event span:first-child'), /white-space: normal/);
  const phone = media('(max-width: 760px)');
  assert.match(phone, /\.files li:not\(\.files-head\) > span:first-child \{ grid-column: 1 \/ -1; \}/);
});

test('The startup check bar names the vehicle a share check is for, and has finger-sized buttons on touch screens', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server/index.js'), 'utf8');
  const route = server.slice(server.indexOf("r.add('GET', '/api/health/banner'"), server.indexOf("r.add('GET', '/api/snapshots'"));
  assert.match(route, /\/\^Vehicle: \/\.test\(c\.group \|\| ''\) \? `\$\{c\.group\.slice\(9\)\}: \$\{c\.label\}` : c\.label/);
  assert.match(route, /label: named\(c\)/);
  const critical = fs.readFileSync(path.join(__dirname, '..', 'web/critical.js'), 'utf8');
  assert.match(critical, /@media \(pointer:coarse\)\{#\$\{ID\} a,#\$\{ID\} button\{padding:8px 12px\}\}/);
});

test('Health and Settings > Security show times on the 12/24-hour clock chosen, in every interface', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const health = read('web/health.js');
  assert.doesNotMatch(health, /toLocaleString\(\)/, 'no time in the browser\'s own clock');
  assert.match(health, /hour12: !\(typeof h24 === 'function' \? h24\(\) : clock24\)/);
  assert.match(health, /api\('\/api\/settings'\)\.then\(\(st\) => \{ clock24 = Boolean\(st\?\.appearance\?\.clock24\)/, 'a pack that passes no h24: the setting');
  const access = read('web/accessSettings.js');
  assert.match(access, /hour12: !h24/);
  assert.match(access, /when\(b\.at, h24Now\(\)\)/);
  const app = read('web/app.js');
  assert.match(app, /m\.createHealthPage\(el, \{ h24: \(\) => clockPref\.h24 \}\)/);
  assert.match(app, /m\.createAccessSettings\(box, \{[^}]*\}, h24: \(\) => clockPref\.h24 \}\)/);
});

test('Account: a long list of signed-in devices scrolls in its own box', () => {
  const account = fs.readFileSync(path.join(__dirname, '..', 'web/account.js'), 'utf8');
  assert.match(account, /\.sentry-acct \[data-sessions\] \.sa-scroll\{max-height:min\(480px,60vh\);overflow-y:auto;/);
});
