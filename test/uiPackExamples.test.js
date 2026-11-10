'use strict';

// The interface packs that come with the app (examples/ui-packs): each zip
// holds exactly its folder, and the packs follow nodes that list their GPUs
// and CPU (grouped per node in the Encoder, nothing set on the Nodes page).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readZip } = require('../server/zip');

const ROOT = path.join(__dirname, '..', 'examples', 'ui-packs');
const PACKS = { daylight: 'dl', flux: 'flux', horizon: 'hz', aurora: 'aurora' };

function filesOf(dir, rel = '') {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? filesOf(dir, r) : [r];
  });
}

for (const [pack, mod] of Object.entries(PACKS)) {
  test(`${pack}: the zip holds the folder as it is`, () => {
    const entries = readZip(fs.readFileSync(path.join(ROOT, `${pack}.zip`))).filter((e) => !e.name.endsWith('/'));
    const files = filesOf(path.join(ROOT, pack)).sort();
    assert.deepEqual(entries.map((e) => e.name).sort(), files);
    for (const e of entries) assert.ok(e.data.equals(fs.readFileSync(path.join(ROOT, pack, e.name))), `${pack}/${e.name} is out of date in the zip`);
  });

  test(`${pack}: the Nodes page only turns node mode on and off; the Encoder groups node devices`, () => {
    const nodes = fs.readFileSync(path.join(ROOT, pack, 'web', mod, 'pages', 'nodes.js'), 'utf8');
    const encoder = fs.readFileSync(path.join(ROOT, pack, 'web', mod, 'pages', 'encoder.js'), 'utf8');
    assert.doesNotMatch(nodes, /slots: Number|use: |Clips at once<|Encode with|Convert with/);
    assert.match(nodes, /defaultLane/);
    assert.match(encoder, /from '\.\.\/nodelanes\.js'/);
    assert.match(encoder, /wireGroups\(/);
    assert.match(encoder, /data-node-group=/);
    assert.match(encoder, /aria-expanded="false" aria-controls=/);
  });
}

test('nodelanes: one group per node, defaults, and the whole-node number of before', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'flux', 'web', 'flux', 'nodelanes.js'), 'utf8');
  for (const [pack, mod] of Object.entries(PACKS)) assert.equal(fs.readFileSync(path.join(ROOT, pack, 'web', mod, 'nodelanes.js'), 'utf8'), src, `${pack} has the same nodelanes.js`);
  const m = await import(`data:text/javascript,${encodeURIComponent(src)}`);
  const node = (dev, extra = {}) => ({ id: `node:abcdefabcdef@${dev}`, kind: 'node', nodeId: 'abcdefabcdef', nodeName: 'nas', deviceId: dev, deviceName: dev === 'cpu' ? 'CPU' : `GPU ${dev}`, name: `nas · ${dev === 'cpu' ? 'CPU' : `GPU ${dev}`}`, online: true, ...extra });
  const devices = [
    { id: 'pci:0000:01:00.0', kind: 'gpu', name: 'Arc' },
    { id: 'cpu', kind: 'cpu', name: 'CPU' },
    node('pci:0000:03:00.0', { isDefault: true }), node('pci:0000:04:00.0'), node('cpu'),
    { id: 'node:000000000000', kind: 'node', nodeId: '000000000000', name: 'old (node)', online: false }
  ];
  const { own, nodes } = m.splitDevices(devices);
  assert.deepEqual(own.map((d) => d.id), ['pci:0000:01:00.0', 'cpu', 'node:000000000000']);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].key, 'node:abcdefabcdef');
  assert.equal(nodes[0].name, 'nas');
  assert.equal(nodes[0].online, true);
  assert.equal(nodes[0].devices.length, 3);
  assert.equal(m.deviceLabel({ name: 'nas · Big GPU', nodeName: 'nas' }), 'Big GPU');
  // first time: the node's default device gets the pack's number, its others are Off
  assert.equal(m.laneValue({}, devices[2], 2), 2);
  assert.equal(m.laneValue({}, devices[3], 2), 0);
  assert.equal(m.laneValue({}, devices[4], 2), 0);
  assert.equal(m.laneValue({}, devices[0], 2), 2);
  // a number saved for the whole node is its default device's
  assert.equal(m.laneValue({ 'node:abcdefabcdef': 5 }, devices[2], 2), 5);
  assert.equal(m.laneValue({ 'node:abcdefabcdef': 5 }, devices[3], 2), 0);
  assert.equal(m.laneValue({ [devices[3].id]: 3 }, devices[3], 2), 3);
  // a running job's whole-node lane shows on the default device's row
  const running = m.jobLanes(devices, [{ device: 'node:abcdefabcdef', concurrency: 4 }, { device: 'cpu', concurrency: 1 }]);
  assert.equal(running.get(devices[2].id), 4);
  assert.equal(running.get('cpu'), 1);
  assert.equal(m.groupBodyId('next', 'node:abcdefabcdef'), 'ng-next-node-abcdefabcdef');
  // open groups are remembered in the pack's store
  const mem = new Map();
  const g = m.groupMemory({ get: (k, d) => (mem.has(k) ? mem.get(k) : d), set: (k, v) => mem.set(k, v) }, 'groups');
  assert.equal(g.isOpen('next|node:abcdefabcdef'), false);
  g.set('next|node:abcdefabcdef', true);
  assert.equal(g.isOpen('next|node:abcdefabcdef'), true);
  g.set('next|node:abcdefabcdef', false);
  assert.deepEqual(mem.get('groups'), {});
});

for (const [pack, mod] of Object.entries(PACKS)) {
  test(`${pack}: the Encoder setup stays usable while a job runs; only Start waits, with a note`, () => {
    const encoder = fs.readFileSync(path.join(ROOT, pack, 'web', mod, 'pages', 'encoder.js'), 'utf8');
    // no fieldset (the whole setup) disabled because a job is active
    assert.doesNotMatch(encoder, /<fieldset[^>]*\$\{[^}]*busy[^}]*\?[^}]*disabled/i);
    assert.doesNotMatch(encoder, /title: 'Something is converting already'/);
    assert.match(encoder, /Start this one when it finishes, or turn on Automatic conversion for this vehicle/);
  });
}

// Live redraws (stats polls, server events, timers) wait while the reader is
// highlighting text in what they would redraw, then catch up: the packs had
// the bug the built-in interface fixed, a highlight wiped within seconds.
const LIVE_PAGES = {
  flux: ['pages/overview.js', 'pages/encoder.js', 'pages/jobs.js', 'pages/nodes.js', 'pages/footage.js', 'pages/bin.js', 'pages/notifications.js', 'pages/policies.js', 'pages/settings.js'],
  horizon: ['pages/dashboard.js', 'pages/encoder.js', 'pages/jobs.js', 'pages/nodes.js', 'pages/footage.js', 'pages/bin.js', 'pages/alerts.js', 'pages/policies.js', 'pages/settings.js'],
  aurora: ['main.js', 'pages/sky.js', 'pages/encoder.js', 'pages/nodes.js'],
  daylight: ['pages/home.js', 'pages/server.js', 'pages/encoder.js', 'pages/jobs.js', 'pages/nodes.js', 'pages/footage.js', 'pages/bin.js', 'pages/notifications.js', 'pages/more.js', 'pages/settings.js']
};
for (const [pack, mod] of Object.entries(PACKS)) {
  test(`${pack}: live redraws hold while text is highlighted, then catch up`, () => {
    const dir = path.join(ROOT, pack, 'web', mod);
    const core = fs.readFileSync(path.join(dir, 'core.js'), 'utf8');
    assert.match(core, /export function selecting\(region\)/);
    assert.match(core, /export function liveDraw\(region, draw, key = draw\)/);
    assert.match(core, /sel\.isCollapsed/);
    for (const ev of ['pointerdown', 'pointerup', 'pointercancel', 'selectionchange']) assert.match(core, new RegExp(`addEventListener\\('${ev}'`), `${pack}: core listens to ${ev}`);
    for (const file of LIVE_PAGES[pack]) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.match(src, /\bliveDraw\(/, `${pack}/${file} holds its live redraws`);
      assert.match(src, /import \{[^}]*\bliveDraw\b[^}]*\} from '\.\.?\/core\.js'/, `${pack}/${file} imports liveDraw`);
    }
    // every page with a timer, a poll or a server event uses it
    for (const file of filesOf(path.join(dir, 'pages'))) {
      const src = fs.readFileSync(path.join(dir, 'pages', file), 'utf8');
      const live = /setInterval\(|ctx\.every\(|onTopics|ctx\.on\('(topics|vehicles|notes)'|follow\(|onBenchmark\(|converter:progress/.test(src);
      // (the Viewer's readout follows the video being played, not a timer)
      if (live && file !== 'viewer.js') assert.match(src, /\bliveDraw\(/, `${pack}/pages/${file} updates live but never holds`);
    }
  });
}

for (const [pack, mod] of Object.entries(PACKS)) {
  test(`${pack}: the Viewer shows the drive on the shared MapLibre map, and closes it on leaving`, () => {
    const src = fs.readFileSync(path.join(ROOT, pack, 'web', mod, 'pages', 'viewer.js'), 'utf8');
    assert.match(src, /import \{ createViewerMap \} from '\/web\/viewerMap\.js';/);
    assert.match(src, /createViewerMap\(/, 'the map is made');
    assert.match(src, /\.addRoute\(/, 'the route is drawn');
    assert.match(src, /\.setPosition\(/, 'the car follows the playhead');
    assert.match(src, /map\.destroy\(\)/, 'and the map is closed with the page');
    assert.match(src, /id="vw-map"/);
  });
}

test('viewerMap: the packs\' map module uses the Viewer\'s own MapLibre helpers and maps', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'viewerMap.js'), 'utf8');
  // loaded when the map is needed (a route with GPS, on screen), not with the page
  assert.match(src, /import\('\/studio\/scripts\/ui\/mapGl\.js'\)/);
  assert.doesNotMatch(src, /from '\/studio\/scripts\/ui\/mapGl\.js'/, 'not with the page');
  assert.match(src, /import '\/shared\/mapProviders\.js'/);
  assert.match(src, /\/studio\/vendor\/maplibre\/maplibre-gl\.css/, 'and MapLibre\'s stylesheet');
  assert.match(src, /\/api\/studio\/settings/, 'the street / satellite choice is the Viewer\'s setting');
});

// A whole day (hundreds of clips): the clip bar stays visible and each block
// is its true length before it is played.
for (const [pack, bar] of [['horizon', 'vw-tlc'], ['flux', 'vw-tl-segs']]) {
  test(`${pack}: a day of hundreds of clips draws a solid clip bar, every block its own length`, () => {
    const mod = PACKS[pack];
    const src = fs.readFileSync(path.join(ROOT, pack, 'web', mod, 'pages', 'viewer.js'), 'utf8');
    assert.match(src, new RegExp(`const bar = \\$\\('#${bar}'\\);\\n\\s+bar\\.classList\\.toggle\\('dense', st\\.\\w+\\.length > \\(bar\\.clientWidth \\|\\| 800\\) / 6\\);`), 'no gaps below 6 px a clip');
    assert.doesNotMatch(src, /knownLen|knownDur/, 'one clip\'s length is never used for all');
    assert.match(src, /\/speeds\?date=/, 'lengths from the speed index');
    const css = fs.readFileSync(path.join(ROOT, pack, 'web', pack === 'flux' ? 'flux.css' : `${mod}/app.css`), 'utf8');
    assert.match(css, /\.dense \{ gap: 0; \}/);
  });
}

test('aurora: a day of hundreds of clips draws no clip dividers, and lengths come from the speed index', () => {
  const src = fs.readFileSync(path.join(ROOT, 'aurora', 'web', 'aurora', 'pages', 'viewer.js'), 'utf8');
  assert.match(src, /const dividers = clips\.length > 1 && clips\.length <= \(q\('#track'\)\.clientWidth \|\| 800\) \/ 6;/);
  assert.match(src, /\/speeds\?date=/);
});

// A whole day plays on past a clip that can't be opened (a damaged file):
// it is skipped with a note while playing; three in a row stop playback.
for (const [pack, mod] of Object.entries(PACKS)) {
  test(`${pack}: a clip that can't be played is skipped while playing, three in a row stop`, () => {
    const src = fs.readFileSync(path.join(ROOT, pack, 'web', mod, 'pages', 'viewer.js'), 'utf8');
    assert.match(src, /const MAX_SKIPS = 3;/);
    assert.match(src, /skipped >= MAX_SKIPS|skipped < MAX_SKIPS/, 'the skips are counted');
    assert.match(src, /skipped = 0/, 'and reset when a clip plays');
    assert.match(src, /Skipped the clip at \$\{/, 'the skipped clip is named');
  });
}

// Export: every Viewer opens the shared panel (web/exportPanel.js) with its
// playlist and playhead, and closes it with the page.
for (const [pack, mod] of Object.entries(PACKS)) {
  test(`${pack}: the Viewer has Export, wired to the shared panel`, () => {
    const src = fs.readFileSync(path.join(ROOT, pack, 'web', mod, 'pages', 'viewer.js'), 'utf8');
    assert.match(src, /import \{ createExportPanel \} from '\/web\/exportPanel\.js';/);
    assert.match(src, /createExportPanel\(\{[\s\S]*?clips: \(\) =>[\s\S]*?position: \(\) =>/);
    assert.match(src, /xp\.destroy\(\)/, 'closed with the page');
    assert.match(src, /xp\.toggle\(\)/, 'a button or key opens it');
  });
}

test('the built-in Viewer\'s Export button opens the shared panel in the web version', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'script.js'), 'utf8');
  assert.match(src, /if \(window\.__SENTRY_WEB__\) \{\s*openWebExport\(\);/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'studioEmbed.css'), 'utf8');
  assert.doesNotMatch(css, /#exportBtn[^{]*\{[^}]*display:\s*none/, 'the button is no longer hidden');
});

// HW3 or HW4 from the footage, as the built-in Viewer does: only HW4 cars
// record the pillar cameras, so without them a pack shows no pillar tiles.
for (const [pack, mod] of [['horizon', 'hz'], ['flux', 'flux'], ['aurora', 'aurora']]) {
  test(`${pack}: the Viewer shows pillar cameras only for footage that has them (HW4)`, () => {
    const src = fs.readFileSync(path.join(ROOT, pack, 'web', mod, 'pages', 'viewer.js'), 'utf8');
    assert.match(src, /\.some\(\(\w\) => \w\.(files|cams)\.left_pillar \|\| \w\.(files|cams)\.right_pillar\)/, 'decided from the playlist');
    assert.match(src, /classList\.toggle\('hw3'/);
    const css = fs.readFileSync(path.join(ROOT, pack, 'web', pack === 'flux' ? 'flux.css' : `${mod}/app.css`), 'utf8');
    assert.match(css, /\.hw3/, 'and laid out without them');
  });
}

// Horizon's Footage: the Days column beside the track list takes ~380 px from
// a 1024 px window up, so the list's own width (a container query) picks the
// row layout, never the window's: a 1300 px window has a ~920 px list.
test('horizon: the Footage track rows are laid out by the list\'s own width', () => {
  const css = fs.readFileSync(path.join(ROOT, 'horizon', 'web', 'hz', 'app.css'), 'utf8');
  assert.match(css, /\.tracks \{ container: tracks \/ inline-size; \}/);
  assert.match(css, /@container tracks \(max-width: 1100px\) \{\s*\.track \{ grid-template-columns: 44px 46px 64px minmax\(0, 1fr\)/, 'fewer columns below 1100 px of list');
  assert.match(css, /@container tracks \(max-width: 860px\) \{\s*\.track \{[^}]*grid-template-areas:/, 'two lines a row below 860 px of list');
  // only the phone layout (the list as wide as the window) still goes by the window
  for (const m of css.matchAll(/@media \(max-width: (\d+)px\) \{\s*\.track \{/g)) assert.ok(Number(m[1]) <= 700, `a window-wide .track rule at ${m[1]} px`);
});

// Horizon's Viewer on a touch screen: the frame-step buttons of a paused video
// sit at the sides, not over the speed and P R N D line along the bottom.
test('horizon: the frame-step buttons leave the heads-up display readable', () => {
  const css = fs.readFileSync(path.join(ROOT, 'horizon', 'web', 'hz', 'app.css'), 'utf8');
  assert.match(css, /\.cam\.main \.sentry-x-steps \{ top: 50%; bottom: auto; transform: translateY\(-50%\); justify-content: space-between;/);
});

// Horizon's top bar picks one row or two by measuring each part; the car is
// counted as wide as it really shows on one row (the name up to the CSS
// max-width, the picker of two or more vehicles at its set width), or the left
// page group slides under the brand on a 1300-1600 px window.
test('horizon: the top bar counts the car name and the vehicle picker at their real width', () => {
  const main = fs.readFileSync(path.join(ROOT, 'horizon', 'web', 'hz', 'main.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'horizon', 'web', 'hz', 'app.css'), 'utf8');
  const max = Number(/const CAR_MAX = (\d+);/.exec(main)?.[1]);
  assert.equal(max, Number(/\.car-one \{[^}]*max-width: (\d+)px/.exec(css)?.[1]), 'CAR_MAX is .car-one\'s max-width');
  assert.match(main, /const carSize = \(k\) => \(k\.id === 'car-one' \? Math\.min\(k\.scrollWidth, CAR_MAX\) : w\(k\)\);/, 'the picker is not capped');
});

// Flux's top bar on a phone: one vehicle's name is held to the same width as
// the picker of two, so a long name never pushes the bell and shortcuts
// buttons off a 320-390 px screen.
test('flux: a long vehicle name fits the phone top bar', () => {
  const css = fs.readFileSync(path.join(ROOT, 'flux', 'web', 'flux.css'), 'utf8');
  assert.match(css, /@media \(max-width: 860px\) \{[\s\S]*?\.veh-pick select, \.veh-name \{ max-width: 96px; \}/);
  assert.match(css, /@media \(max-width: 360px\) \{[^}]*\}\s*\.veh-pick \.ico \{ display: none; \}\s*\.veh-pick select, \.veh-name \{ max-width: 80px; \}/);
});
