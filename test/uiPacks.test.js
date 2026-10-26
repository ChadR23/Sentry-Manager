'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { readZip, writeZip } = require('../server/zip');
const { createUiPacks, originalPack, safeRel } = require('../server/uiPacks');

const memDb = () => {
  const m = new Map();
  return { get: (k, d = null) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v) };
};
const quiet = { info() {}, warn() {}, error() {} };
const zip = (files) => writeZip(Object.entries(files).map(([name, data]) => ({ name, data: Buffer.from(data) })));
const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'sm-ui-'));

test('zip: what is written reads back, byte for byte', () => {
  const big = Buffer.alloc(300_000, 'abc');
  const files = readZip(writeZip([{ name: 'web/app.js', data: Buffer.from('console.log(1)') }, { name: 'web/fonts/x.woff2', data: big }, { name: 'ünï.txt', data: Buffer.alloc(0) }]));
  assert.deepEqual(files.map((f) => f.name), ['web/app.js', 'web/fonts/x.woff2', 'ünï.txt']);
  assert.equal(files[0].data.toString(), 'console.log(1)');
  assert.ok(files[1].data.equals(big));
  assert.equal(files[2].data.length, 0);
});

test('zip: damaged, encrypted, oversized and bomb archives are refused before they fill the disk', () => {
  assert.throws(() => readZip(Buffer.from('not a zip at all, just some text here')), /not a \.zip/);
  const good = zip({ 'a.txt': 'hello hello hello' });
  // a flipped byte in the packed data: the CRC check catches it
  const bad = Buffer.from(good);
  bad[30 + 5 + 2] ^= 0xff;
  assert.throws(() => readZip(bad), /damaged/);
  // encrypted flag
  const enc = Buffer.from(good);
  const cd = enc.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  enc.writeUInt16LE(1, cd + 8);
  assert.throws(() => readZip(enc), /Encrypted/);
  // a file that claims to be small but inflates to more: only its declared size comes out, and fails
  const bomb = Buffer.from(zip({ 'b.txt': Buffer.alloc(1_000_000) }));
  const cd2 = bomb.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(10, cd2 + 24);
  assert.throws(() => readZip(bomb), /damaged/);
  assert.throws(() => readZip(zip({ 'c.txt': Buffer.alloc(2000) }), { maxFile: 1000 }), /too large/);
  assert.throws(() => readZip(zip({ a: '1', b: '2', c: '3' }), { maxFiles: 2 }), /Too many/);
  assert.throws(() => readZip(zip({ a: Buffer.alloc(600), b: Buffer.alloc(600) }), { maxTotal: 1000 }), /too large/);
});

test('zip: a symbolic link in the archive is left out', () => {
  const buf = Buffer.from(zip({ 'web/link.js': '/etc/passwd', 'web/app.js': 'x' }));
  const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buf.writeUInt16LE((3 << 8) | 20, cd + 4);
  buf.writeUInt32LE((0o120777 << 16) >>> 0, cd + 38);
  assert.deepEqual(readZip(buf).map((f) => f.name), ['web/app.js']);
});

test('pack paths: nothing can leave the pack folder', () => {
  for (const bad of ['../x', 'web/../../x', '/etc/passwd', 'web\\..\\x', 'web//x', 'web/./x', 'C:/x', '', 'a\0b']) assert.equal(safeRel(bad), null, bad);
  assert.equal(safeRel('web/fonts/a.woff2'), 'web/fonts/a.woff2');
});

test('packs: install, choose, serve from, delete; a broken upload leaves nothing behind', async () => {
  const dir = await tmp();
  try {
    const db = memDb();
    const packs = createUiPacks({ dir, db, log: quiet });
    await packs.tidy();
    assert.equal(packs.active(), null);
    assert.equal(packs.root('web'), null);
    // a zip of a folder (one folder around everything), with Mac leftovers
    const meta = await packs.install(zip({
      'Dark Mint/ui.json': JSON.stringify({ name: 'Dark Mint\n', description: 'Greener', author: 'Sam' }),
      'Dark Mint/web/shell.css': 'body{background:#012}',
      'Dark Mint/README.md': 'ignored',
      '__MACOSX/Dark Mint/._shell.css': 'junk',
      'Dark Mint/.DS_Store': 'junk'
    }), 'whatever.zip');
    assert.equal(meta.name, 'Dark Mint');
    assert.equal(meta.author, 'Sam');
    assert.deepEqual(meta.replaces, ['web']);
    assert.equal(meta.files, 1);
    assert.match(meta.id, /^dark-mint-[0-9a-f]{6}$/);
    assert.deepEqual(packs.list().map((x) => x.id), [meta.id]);
    assert.equal(packs.active(), null, 'installing does not switch');
    packs.setActive(meta.id);
    assert.equal(packs.active(), meta.id);
    assert.equal(fs.readFileSync(path.join(packs.root('web'), 'shell.css'), 'utf8'), 'body{background:#012}');
    assert.equal(packs.root('studio'), null, 'the pack changes no Studio file');
    assert.throws(() => packs.setActive('nope'), /No such/);
    assert.throws(() => packs.setActive('../x'), /No such/);
    // no ui.json: named after the file
    const second = await packs.install(zip({ 'studio/styles/x.css': 'a{}' }), 'Night Viewer.zip');
    assert.equal(second.name, 'Night Viewer');
    // refused: a path out of the pack, nothing usable, a file twice, not a zip
    await assert.rejects(packs.install(zip({ 'web/../../evil.js': 'x' })), /not a path/);
    await assert.rejects(packs.install(zip({ 'readme.txt': 'x' })), /no files in web\/ or studio\//);
    await assert.rejects(packs.install(Buffer.from('nope'.repeat(10))), /not a \.zip/);
    await assert.rejects(packs.install(zip({ 'ui.json': '{', 'web/a': 'x' })), /ui\.json/);
    assert.deepEqual(fs.readdirSync(dir).sort(), [meta.id, second.id].sort(), 'no half-unpacked pack is left');
    // deleting the pack in use goes back to the original
    await packs.remove(meta.id);
    assert.equal(packs.active(), null);
    assert.equal(packs.root('web'), null);
    await assert.rejects(packs.remove(meta.id), /No such/);
    // a restart after a cut-short install tidies up
    await fsp.mkdir(path.join(dir, '.incoming-abcd'));
    await packs.tidy();
    assert.deepEqual(fs.readdirSync(dir), [second.id]);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('packs: the original download is a pack that installs as is', async () => {
  const dir = await tmp();
  try {
    const repo = path.join(__dirname, '..');
    const buf = await originalPack({ web: path.join(repo, 'web'), studio: path.join(repo, 'src', 'renderer') });
    const names = readZip(buf).map((f) => f.name);
    for (const n of ['README.txt', 'ui.json', 'web/index.html', 'web/app.js', 'web/shell.css', 'studio/index.html', 'studio/encoder.html']) assert.ok(names.includes(n), n);
    assert.equal(readZip(buf).find((f) => f.name === 'web/app.js').data.toString(), fs.readFileSync(path.join(repo, 'web', 'app.js'), 'utf8'));
    const packs = createUiPacks({ dir, db: memDb(), log: quiet });
    const meta = await packs.install(buf);
    assert.equal(meta.name, 'My interface');
    assert.deepEqual(meta.replaces, ['web', 'studio']);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
