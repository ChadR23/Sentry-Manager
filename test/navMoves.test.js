'use strict';

// Pages moved inside others in every interface: Per car (Encoding per
// vehicle) is a sub-tab of Policies (Policies | Per car, web/subTabs.js), and
// its old addresses open it there; the page module is reused as it was.

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
