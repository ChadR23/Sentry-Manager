'use strict';

// Pages moved inside others in every interface: Per car (Encoding per
// vehicle) is a sub-tab of Policies (Policies | Per car, web/subTabs.js), and
// its old addresses open it there; Nodes is a section of Settings. The page
// modules are reused as they were.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
const PACKS = { aurora: 'aurora', daylight: 'dl', flux: 'flux', horizon: 'hz' };
const shellOf = (pack) => read('examples', 'ui-packs', pack, 'web', PACKS[pack], pack === 'daylight' ? 'app.js' : 'main.js');

test('Per car: a sub-tab of Policies in every interface, not in the navigation; old addresses land there', () => {
  const app = read('web', 'app.js');
  assert.match(app, /const POLICY_TABS = \[\['retention', 'Policies'\], \['per-car', 'Per car'\]\];/);
  assert.match(app, /pickSubTab\('sentry-policies-tab'/);
  assert.match(app, /encoder\\\/vehicles[\s\S]{0,120}#\/policies\/per-car/, '#/encoder/vehicles opens Policies > Per car');
  assert.match(read('web', 'electronApiShim.js'), /href: '\/#\/policies\/per-car'/);
  for (const pack of Object.keys(PACKS)) {
    const shell = shellOf(pack);
    assert.doesNotMatch(shell, /\['vehicles', 'Per car'|\{ id: 'vehicles'|^\s+vehicles: \{ label/m, `${pack}: Per car is not in the navigation`);
    assert.doesNotMatch(shell, /MORE_ROUTES = \[[^\]]*'vehicles'/, `${pack}: nor in More`);
    assert.match(shell, /vehicles: 'policies\/per-car'/, `${pack}: #/vehicles opens Policies > Per car`);
    const pages = path.join('examples', 'ui-packs', pack, 'web', PACKS[pack], 'pages');
    const pol = read(pages, 'policies.js');
    assert.match(pol, /import (\* as )?perCar from '\.\/vehicles\.js';/, `${pack}: the Per car page as it was`);
    assert.match(pol, /POLICY_TABS = \[\['retention', '(Policies|Cleanup rules)', [^\]]+\], \['per-car', 'Per car', perCar\]\];/);
    assert.match(pol, /pickSubTab\('sentry-policies-tab'/, `${pack}: remembers the last sub-tab`);
    assert.match(read(pages, 'encoder.js'), /href: '#\/policies\/per-car'/, `${pack}: the Encoder's vehicle links go there`);
  }
  // the keyboard: g c still opens it where it had a shortcut
  assert.match(shellOf('aurora'), /\['policies\/per-car', 'Encoding per vehicle \(Policies → Per car\)', 'c'\]/);
  assert.match(shellOf('flux'), /\['policies\/per-car', 'Encoding per vehicle \(Policies → Per car\)', 'encoder', 'c'\]/);
});

test('Nodes: inside Settings in every interface, not in the navigation; old addresses land on Settings → Nodes', () => {
  const index = read('web', 'index.html');
  assert.doesNotMatch(index, /data-route="nodes"/, 'not in the built-in navigation');
  const app = read('web', 'app.js');
  assert.match(app, /if \(sub === 'nodes' \|\| sub\?\.startsWith\('nodes\/'\)\) return pages\.nodes\(\);/, 'Settings shows the Nodes page');
  assert.match(app, /nodes\\\/\?\(\\\?\.\*\)\?\$\/\.exec\(location\.hash\);\s+if \(nodesWas\) history\.replaceState\(null, '', `#\/settings\/nodes/);
  assert.match(app, /!location\.hash\.startsWith\('#\/settings\/nodes'\)/, 'its live follow-up stops when it is left');
  for (const pack of Object.keys(PACKS)) {
    const shell = shellOf(pack);
    assert.doesNotMatch(shell, /\['nodes', 'Nodes'|\{ id: 'nodes'|^\s+nodes: \{ label/m, `${pack}: Nodes is not in the navigation`);
    assert.doesNotMatch(shell, /MORE_ROUTES = \[[^\]]*'nodes'/, `${pack}: nor in More`);
    assert.match(shell, /nodes: 'settings\/nodes'/, `${pack}: #/nodes opens Settings → Nodes`);
    const settings = read('examples', 'ui-packs', pack, 'web', PACKS[pack], 'pages', 'settings.js');
    assert.match(settings, /import (\* as )?nodesPage from '\.\/nodes\.js';/, `${pack}: the Nodes page as it was`);
    assert.match(settings, /\['nodes', '(Nodes|Helper servers)'/, `${pack}: a Settings section`);
    if (pack !== 'daylight') assert.match(settings, /inner\?\.(destroy|unmount)\?\.\(\)/, `${pack}: its timers stop with Settings`);
  }
  assert.match(shellOf('aurora'), /\['settings\/nodes', 'Nodes \(Settings → Nodes\)', 'n'\]/);
  assert.match(shellOf('flux'), /\['settings\/nodes', 'Nodes \(Settings → Nodes\)', 'nodes', 'n'\]/);
});

test('Sentry USB: in the main navigation where Policies was, Policies further along, in every interface', () => {
  const order = (src, re) => [...src.matchAll(re)].map((m) => m[1]);
  const index = read('web', 'index.html');
  const builtin = order(index.slice(index.indexOf('id="nav"'), index.indexOf('</nav>', index.indexOf('id="nav"'))), /data-route="([\w-]+)"/g);
  assert.deepEqual(builtin.slice(0, 5), ['overview', 'footage', 'viewer', 'encoder', 'sentryusb']);
  assert.equal(builtin[builtin.indexOf('notifications') + 1], 'policies', 'built-in: Policies where Sentry USB was');
  // Horizon: Sentry USB ends the left group of the top bar; Policies starts the right one
  const hz = shellOf('horizon');
  const hzPages = order(hz.slice(hz.indexOf('export const PAGES'), hz.indexOf('];', hz.indexOf('export const PAGES'))), /\{ id: '([\w-]+)'/g);
  assert.deepEqual(hzPages.slice(0, 6), ['dashboard', 'footage', 'viewer', 'encoder', 'sentryusb', 'policies']);
  assert.match(hz, /\{ id: 'sentryusb', label: 'Sentry USB', icon: 'usb' \}/, 'horizon: in the top bar');
  assert.match(hz, /const SPLIT = PAGES\.findIndex\(\(p\) => p\.id === 'policies'\);/);
  assert.doesNotMatch(read('examples', 'ui-packs', 'horizon', 'web', 'hz', 'pages', 'settings.js'), /href="#\/sentryusb"/, 'horizon: not twice');
  // Aurora: first of the dock's middle group; Policies first of the last
  const au = shellOf('aurora');
  const groups = au.slice(au.indexOf('const DOCK'), au.indexOf('];', au.indexOf('const DOCK'))).split("'|'").map((g) => order(g, /\['([\w-]+)'/g));
  assert.equal(groups[1][0], 'sentryusb');
  assert.equal(groups[2][0], 'policies');
  // Flux: after Encoder in Process; Policies after Notifications in System
  const fx = shellOf('flux');
  assert.match(fx, /id: 'encoder'[^\n]+\n\s+\{ id: 'sentryusb'[^\n]+group: 'Process' \}/);
  assert.match(fx, /id: 'notifications'[^\n]+\n\s+\{ id: 'policies'[^\n]+group: 'System' \}/);
  // Daylight: in the side bar's main group after Encoder, first under More on phones; Cleanup rules first under Looking after
  const dl = shellOf('daylight');
  assert.match(dl, /sentryusb: \{ label: 'Sentry USB', icon: 'usb', group: 'main'/);
  assert.match(dl, /group: 'phone'[^\n]+\n\s+policies: \{ label: 'Cleanup rules', icon: 'rules', group: 'care'/);
  assert.match(dl, /MORE_ROUTES = \['sentryusb', 'policies',/);
});
