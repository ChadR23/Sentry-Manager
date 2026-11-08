'use strict';

// Footage lengths (web/duration.js): days, hours and minutes in words for
// totals, and a clock (m:ss, then h:mm:ss) for a recording's length. Every
// interface pack carries the same file, and the built-in Footage page (a
// classic script) its own copy of footMinutes, checked here to agree.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'web', 'duration.js'), 'utf8');
const PACKS = { horizon: 'hz', flux: 'flux', aurora: 'aurora', daylight: 'dl' };
const load = () => import(`data:text/javascript,${encodeURIComponent(SRC)}`);

const WORDS = [
  [0, '0 min'], [1, '1 min'], [59, '59 min'], [60, '1 h'], [120, '2 h'], [61, '1 h 1 min'], [731, '12 h 11 min'],
  [1439, '23 h 59 min'], [1440, '1 day'], [1441, '1 day 1 min'], [1500, '1 day 1 h'], [1501, '1 day 1 h 1 min'],
  [2880, '2 days'], [2940, '2 days 1 h'], [16214, '11 days 6 h 14 min'],
  [59.4, '59 min'], [59.6, '1 h'], [-3, '0 min'], [null, '0 min'], [undefined, '0 min'], [NaN, '0 min']
];

test('footMinutes: days, hours and minutes, zero parts left out', async () => {
  const { footMinutes } = await load();
  for (const [min, text] of WORDS) assert.equal(footMinutes(min), text, `${min} min`);
});

test('trackLength: m:ss under an hour, h:mm:ss from an hour on, hours past 24', async () => {
  const { trackLength } = await load();
  for (const [sec, text] of [[0, '0:00'], [59, '0:59'], [180, '3:00'], [3599, '59:59'], [3600, '1:00:00'], [290 * 60, '4:50:00'],
    [731 * 60, '12:11:00'], [1452 * 60, '24:12:00'], [61.9, '1:01'], [-5, '0:00'], [NaN, '0:00']]) assert.equal(trackLength(sec), text, `${sec} s`);
});

test('every pack has the same duration.js and its core exports it', () => {
  for (const [pack, mod] of Object.entries(PACKS)) {
    const dir = path.join(ROOT, 'examples', 'ui-packs', pack, 'web', mod);
    assert.equal(fs.readFileSync(path.join(dir, 'duration.js'), 'utf8'), SRC, `${pack} has the same duration.js`);
    assert.match(fs.readFileSync(path.join(dir, 'core.js'), 'utf8'), /export \{ footMinutes, trackLength \} from '\.\/duration\.js';/);
  }
});

test('the built-in Footage page words minutes the same way', async () => {
  const app = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
  const m = app.match(/const minutesText = (\(min\) => \{[\s\S]*?\n {2}\});/);
  assert.ok(m, 'minutesText in app.js');
  const minutesText = new Function(`return ${m[1]};`)();
  for (const [min, text] of WORDS) assert.equal(minutesText(min), text, `${min} min`);
  assert.match(app, /\$\{minutesText\(d\.minutes\)\}/);
});

test('no footage page shows bare minutes or minutes as m:00 any more', () => {
  for (const [pack, mod] of Object.entries(PACKS)) {
    const dir = path.join(ROOT, 'examples', 'ui-packs', pack, 'web', mod, 'pages');
    for (const file of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.doesNotMatch(src, /\$\{(d|r)\.minutes\} min|\$\{(mins|minutes)\} min|\$\{r\.minutes\}m<|\$\{Math\.floor\(min\)\}:00/, `${pack}/${file}`);
    }
  }
  const hz = fs.readFileSync(path.join(ROOT, 'examples', 'ui-packs', 'horizon', 'web', 'hz', 'pages', 'footage.js'), 'utf8');
  assert.match(hz, /const dur = \(min\) => trackLength\(Math\.floor\(min\) \* 60\);/);
  for (const file of ['driving.js', 'moments.js']) assert.match(fs.readFileSync(path.join(ROOT, 'web', file), 'utf8'), /import \{ footMinutes \} from '\/web\/duration\.js';/);
});
