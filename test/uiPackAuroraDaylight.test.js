'use strict';

// Layout fixes in the Aurora and Daylight interface packs (examples/ui-packs),
// checked in their sources: what a browser run found at phone and desktop sizes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'examples', 'ui-packs');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('aurora and daylight: the fixed top bar and side bar move down under the update and startup-check bars', () => {
  for (const js of ['aurora/web/aurora/main.js', 'daylight/web/dl/app.js']) {
    const src = read(js);
    assert.match(src, /'sentry-critical-update', 'sentry-health-bar'/, `${js} measures both bars`);
    assert.match(src, /setProperty\('--bars-top'/, `${js} publishes --bars-top`);
    assert.match(src, /addEventListener\('scroll', fitUnderBarsSoon/, `${js} follows the startup-check bar as it scrolls away`);
  }
  const aurora = read('aurora/web/aurora/app.css');
  assert.match(aurora, /\.topbar \{\s*position: fixed; top: var\(--bars-top, 0px\)/);
  const daylight = read('daylight/web/dl/app.css');
  assert.match(daylight, /\.side \{\s*position: fixed; inset: var\(--bars-top, 0px\) auto 0 0/);
  assert.match(daylight, /position: sticky; top: var\(--bars-top, 0px\)/);
});

test('aurora and daylight: a control reached with Tab scrolls clear of the fixed bars', () => {
  assert.match(read('aurora/web/aurora/app.css'), /html \{ scroll-padding: calc\(84px \+ var\(--bars-top, 0px\)\) 0 calc\(130px/);
  assert.match(read('daylight/web/dl/app.css'), /html \{ scroll-padding: calc\(64px \+ var\(--bars-top, 0px\)\) 0 calc\(90px/);
});

test('aurora: the floating car-data bar and List go under the control bar and the dock', () => {
  const css = read('aurora/web/aurora/app.css');
  const m = /body > \.sentry-sd\.float, body > \.sentry-sd\.sd-listpanel\.float \{ z-index: (\d+); \}/.exec(css);
  assert.ok(m, 'a z-index for both floating boxes, as specific as web/statDash.js\'s own');
  const z = (sel) => Number(new RegExp(`${sel} \\{[^}]*z-index: (\\d+)`).exec(css)[1]);
  assert.ok(Number(m[1]) < z('\\.ctrl') && Number(m[1]) < z('\\.dock') && Number(m[1]) < z('\\.topbar'));
});

test('aurora Viewer on a phone: the date stays beside the category, the time under them; a small front camera keeps only the speed', () => {
  const js = read('aurora/web/aurora/pages/viewer.js');
  assert.match(js, /<span class="d-long">\$\{esc\(dayTitle\(rec\.day\)\)\}<\/span><span class="d-short">\$\{esc\(shortDay\(rec\.day\)\)\}<\/span>/);
  const css = read('aurora/web/aurora/app.css');
  const phone = css.slice(css.indexOf('@media (max-width: 699px) and (orientation: portrait)'));
  assert.match(phone, /\.vw-title \{ flex-wrap: wrap;/);
  assert.match(phone, /\.vw-title > span\.muted \{ flex-basis: 100%; \}/);
  assert.match(phone, /\.vw-title \.d-short \{ display: inline; \}/);
  assert.match(js, /cockpit\.classList\.toggle\('compact', frontH < 300\)/);
  assert.match(css, /\.cockpit\.tiny \.hud \.hud-row \{ display: none; \}/);
});

test('aurora Viewer: a vehicle picker where it can be seen (the title bar is hidden there), and speed units like the car-data boxes', () => {
  const js = read('aurora/web/aurora/pages/viewer.js');
  assert.match(read('aurora/web/aurora/app.css'), /body\[data-route="viewer"\] \.win-head \{ display: none; \}/);
  assert.match(js, /<h3 id="list-title">Recordings that day<\/h3>\$\{vehiclePicker\('veh-pick-vw'\)\}/);
  // one choice for both and the car-data boxes (web/units.js, its default by the language as before)
  for (const f of ['aurora/web/aurora/pages/viewer.js', 'daylight/web/dl/pages/viewer.js']) {
    assert.match(read(f), /UNITS\.adopt\(savedUnits\(\)\) \? 'kmh' : 'mph'/, f);
  }
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'web', 'statDash.js'), 'utf8'), /return \{ metric: UNITS\.metric\(\), can:/, 'the same choice as the car-data boxes');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'web', 'units.js'), 'utf8'), /const MILES_LANG = \/\^en\(-\(US\|GB\|LR\|MM\)\)\?\$\/i;/, 'mph where miles are the custom');
});

test('aurora and daylight: long words wrap instead of widening a phone page', () => {
  assert.match(read('aurora/web/aurora/app.css'), /\.attn, \.note-item \{ overflow-wrap: anywhere; \}/);
  assert.match(read('aurora/web/aurora/app.css'), /\.veh-pick select \{[^}]*max-width: 100%/);
  assert.match(read('daylight/web/dl/app.css'), /@media \(max-width: 520px\) \{ \.btn \{ max-width: 100%; white-space: normal; text-align: center; \} \}/);
});

test('aurora and daylight: a server refusal written as a sentence is shown as written', () => {
  for (const f of ['aurora/web/aurora/conv.js', 'daylight/web/dl/convert.js']) {
    assert.match(read(f), /typeof err\?\.code === 'string' && \/\\s\/\.test\(err\.code\) \? err\.code :/, f);
  }
});

test('daylight Settings: a section that cannot load keeps the Settings sections on screen', () => {
  const js = read('daylight/web/dl/pages/settings.js');
  assert.match(js, /try \{\s*return await show\(\);\s*\} catch \(err\) \{/);
  assert.match(js, /el\.innerHTML = `<div class="note note-bad">/);
});

test('daylight Encoder: automatic conversion off says Off once', () => {
  assert.match(read('daylight/web/dl/pages/encoder.js'), /const statusLine = !s\.enabled \? ''/);
});
