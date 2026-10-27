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
