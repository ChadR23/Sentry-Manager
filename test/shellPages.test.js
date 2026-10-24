'use strict';

// The shell's pages as the owner asked for them (web/app.js): the Logs are
// part of the Overview's one window and left Settings, every old link to
// them lands there, they load after the page has shown and never empty,
// shrink or rewrite the box under a highlight; Footage opens no day by itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(REPO, 'web/app.js'), 'utf8');
const css = fs.readFileSync(path.join(REPO, 'web/shell.css'), 'utf8');
const fn = (name) => {
  const m = app.match(new RegExp(`\\n {2}(?:async )?function ${name}\\([\\s\\S]*?\\n {2}\\}\\n`));
  assert.ok(m, `${name}() is in app.js`);
  return m[0];
};

test('Logs: the last part of the Server section, Nerd stats on or off, and gone from Settings', () => {
  const section = fn('serverSection');
  assert.ok(section.indexOf('${logsPart()}') > section.indexOf('nd-body'), 'under the server\'s tiles');
  assert.ok(section.indexOf('${logsPart()}') < section.indexOf('</section>'), 'inside the same window');
  assert.doesNotMatch(section.slice(section.indexOf('${logsPart()}')).split('\n')[0], /\bon\b/, 'whatever the switch says');
  assert.match(fn('logsPart'), /id="log-all"[\s\S]*id="log-refresh"[\s\S]*href="\/api\/logs\/download" download[\s\S]*id="log-list"/, 'Everything, Refresh, Download and the lines');
  // Settings has no Logs section, tab or wiring any more
  const settings = app.match(/\n {2}pages\.settings = [\s\S]*?\n {2}\};\n/)[0];
  assert.doesNotMatch(settings, /\['logs'|data-section="logs"|log-list|log-all|\/api\/logs|wireLogs/);
  assert.doesNotMatch(app, /function wireLogs/);
});

test('Logs: every old link to Settings > Logs leads to the Overview', () => {
  // the alerts link to the logs on the same page
  assert.match(app, /<a href="#\/overview\/logs">Logs<\/a>/);
  // old addresses are rewritten before the route is picked, and the logs scrolled into view
  const render = fn('render');
  assert.match(render, /if \(\/\^#\\\/\?settings\\\/logs\\\/\?\$\/\.test\(location\.hash\)\) history\.replaceState\(null, '', '#\/overview\/logs'\);/);
  assert.ok(render.indexOf('replaceState') < render.indexOf("location.hash.replace(/^#\\/?/, '')"), 'before the route is read');
  const LOGS_HASH = new RegExp(app.match(/const LOGS_HASH = \/(.*)\/;/)[1]);
  for (const hash of ['#/overview/logs', '#/settings/logs', '#settings/logs', '#/settings/logs/']) assert.ok(LOGS_HASH.test(hash), hash);
  for (const hash of ['#/overview', '#/settings', '#/settings/logsx']) assert.ok(!LOGS_HASH.test(hash), hash);
  // and nothing in the app, the docs or the README links to the old place
  const files = ['README.md', 'web/index.html', 'docs/plans/server-monitor-mock.js'];
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(REPO, f), 'utf8'), /#\/settings\/logs"|Settings > Logs lists/, f);
  assert.doesNotMatch(app, /href="#\/settings\/logs"/);
});

test('Logs: loaded after the page shows, never emptied by a redraw, never shorter, held under a highlight', () => {
  const mount = fn('mountLogs');
  assert.match(mount, /requestAnimationFrame\(\(\) => setTimeout\(loadLogs, 0\)\)/, 'after the first paint');
  assert.match(fn('logsPart'), /\$\{logs\.html \|\| '<p class="muted small">Loading…<\/p>'\}/, 'a redraw shows the last lines at once');
  const draw = fn('drawLogs');
  assert.match(draw, /if \(selecting\(box\)\) \{\s*held\.logs = true;/, 'a highlight holds the new lines');
  assert.match(draw, /keepScroll\(/);
  assert.match(draw, /logs\.tallest = Math\.max\(logs\.tallest, box\.offsetHeight\);\s*box\.style\.minHeight = `\$\{logs\.tallest\}px`;/, 'never shorter while the page is open');
  assert.match(draw, /logs\.drawn\.html !== logs\.html/, 'the same lines are not drawn again');
  assert.match(fn('catchUp'), /if \(held\.logs && !selecting\(\$\('log-list'\)\)\) \{\s*held\.logs = false;\s*drawLogs\(\);/);
  // a highlight in the logs (or the vehicle tiles) does not hold the server's numbers
  assert.match(app, /const monitorSelecting = \(root\) => Boolean\(root\) && \(selecting\(root\.querySelector\('\.nd-head'\)\) \|\| selecting\(root\.querySelector\('\.nd-body'\)\)\);/);
  assert.match(fn('drawMonitor'), /if \(monitorSelecting\(root\)\) \{/);
  // every line from the server is escaped
  const line = app.match(/const logLine = \(l\) => `(.*)`;/)[1];
  for (const field of ['l.level', 'when(l.at)', 'l.scope', 'l.message']) assert.ok(line.includes(`\${esc(${field})}`), field);
  assert.match(css, /\.nd-logs \{ margin-top: 16px; \}/);
});

test('Footage: no day opens by itself; a date picked in the filter opens that day', () => {
  const footage = app.match(/\n {2}pages\.footage = [\s\S]*?\n {2}\};\n/)[0];
  assert.doesNotMatch(footage, /f\.open\.add\(data\.days/, 'the newest day is not opened for the reader');
  assert.doesNotMatch(app, /\bopened: false\b|f\.opened\b/);
  assert.match(footage, /\$\('f-date'\)\.onchange = \(e\) => \{ f\.date = e\.target\.value; f\.offset = 0; if \(f\.date\) f\.open\.add\(f\.date\); render\(\); \};/);
  assert.match(footage, /el\.querySelector\('\[data-toggle\]'\)\.onclick = \(\) => \{ if \(f\.open\.has\(day\)\) f\.open\.delete\(day\); else f\.open\.add\(day\); render\(\); \};/, 'the reader opens and closes days');
});

test('Jobs: a Clear jobs button, only with finished jobs, and a confirmation first', () => {
  const jobs = app.match(/\n {2}pages\.jobs = [\s\S]*?\n {2}\};\n/)[0];
  assert.match(jobs, /id="jobs-clear"/);
  assert.match(jobs, /const finished = jobs\.some\(\(j\) => j\.status !== 'running'\);/);
  const clear = fn('clearJobs');
  assert.ok(clear.indexOf('preview: true') < clear.indexOf('confirmDialog') && clear.indexOf('confirmDialog') < clear.lastIndexOf("api('/api/jobs/clear'"), 'count, confirm, then clear');
  assert.match(clear, /if \(!ok\) return;/);
  assert.match(clear, /esc\(v\.name\)/);
});

test('Logs on phones: nothing is cut off and the box never scrolls sideways', () => {
  const phone = css.slice(css.indexOf('@media (max-width: 760px)'), css.indexOf('@media (max-width: 374px)'));
  // the time, level and scope wrap instead of sitting in fixed columns; a long scope breaks
  assert.match(phone, /\.logline \{ display: flex; flex-wrap: wrap; column-gap: 8px; \}/);
  assert.match(phone, /\.logscope \{ min-width: 0; overflow-wrap: anywhere; \}/);
  assert.match(phone, /\.logmsg \{ flex: 1 1 100%; min-width: 0; \}/);
  // the lines take the tile's whole width, as wide as Settings > Logs had them
  assert.match(phone, /\.nd-logs \.logbox \{ margin: 14px -16px -16px; border-width: 1px 0 0; border-radius: 0 0 13px 13px; \}/);
  assert.match(css, /\.nd-tile \{[^}]*padding: 16px;[^}]*border-radius: 14px|\.nd-tile \{[^}]*border-radius: 14px;[^}]*padding: 16px;/, 'the bleed matches the tile\'s padding and corners');
  assert.match(css, /\.logwhen \{[^}]*white-space: nowrap;/);
});

test('Logs: not a live region; a short status only after Refresh or Everything', () => {
  const part = fn('logsPart');
  assert.doesNotMatch(part, /aria-live/, 'the 300-line box is not read out when a live update replaces it');
  assert.match(part, /<p class="sr-only" id="log-status" role="status"><\/p>/);
  assert.match(css, /\.sr-only \{ position: absolute; width: 1px; height: 1px;/);
  const mount = fn('mountLogs');
  assert.match(mount, /loadLogs\(\{ tell: true \}\);\s*\};\s*\$\('log-refresh'\)\.onclick = \(\) => loadLogs\(\{ tell: true \}\);/, 'Everything and Refresh tell');
  assert.match(mount, /setTimeout\(loadLogs, 0\)/, 'the load of a redraw does not');
  const load = fn('loadLogs');
  assert.match(load, /async function loadLogs\(\{ tell = false \} = \{\}\)/);
  assert.match(load, /if \(tell\) sayLogs\(said\);/);
  assert.ok(load.indexOf('if (gen !== logs.gen) return;') < load.indexOf('sayLogs'), 'only the newest answer is told');
  assert.match(fn('sayLogs'), /status\.textContent = '';[\s\S]*status\.textContent = text;/, 'the same words are read out again');
});

test('Jobs: Clear jobs confirms in its request; the count does not', () => {
  const clear = fn('clearJobs');
  assert.match(clear, /api\('\/api\/jobs\/clear', \{ body: \{ \.\.\.body, preview: true \} \}\)/);
  assert.match(clear, /api\('\/api\/jobs\/clear', \{ body: \{ \.\.\.body, confirm: true \} \}\)/);
  assert.ok(clear.indexOf('if (!ok) return;') < clear.indexOf('confirm: true'));
});
