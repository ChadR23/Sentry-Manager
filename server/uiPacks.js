'use strict';

// UI packs: an interface of the owner's choosing in place of the built-in
// one, for everyone, switched in Settings > Interface without a restart.
//
// A pack is a .zip whose files take the place of the built-in files of the
// same path: `web/...` for the manager's pages (web/index.html is the main
// page, web/app.js its script, web/shell.css its look) and `studio/...` for
// the Viewer and the Encoder. A file the pack leaves out is the built-in one,
// so a pack can change one stylesheet or the whole interface. An optional
// `ui.json` gives its name and description.
//
// A pack's scripts run as the signed-in owner (they can do anything the
// pages can), so installing or choosing one asks for the password again.
// The address /original always shows the built-in interface in that
// browser, so a broken pack never locks anyone out.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { readZip, writeZip, ZipError } = require('./zip');

const KINDS = ['web', 'studio'];
const MAX_ZIP_BYTES = 64 * 1024 * 1024;
const MAX_PACKS = 20;
const ID = /^[a-z0-9-]{1,48}$/;

class PackError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/** A text of the pack's own, cleaned for showing (no control characters). */
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

/** A path inside the pack, or null for one that could leave it. */
function safeRel(name) {
  if (typeof name !== 'string' || !name || name.length > 300 || name.includes('\0') || name.includes('\\') || name.startsWith('/')) return null;
  const parts = name.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || /^[a-zA-Z]:$/.test(p))) return null;
  return parts.join('/');
}

function createUiPacks({ dir, db, log = console }) {
  const metaFile = (id) => path.join(dir, id, 'pack.json');
  let installing = false;

  function readMeta(id) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile(id), 'utf8'));
      return meta && meta.id === id ? meta : null;
    } catch {
      return null;
    }
  }

  /** The installed packs, newest first. */
  function list() {
    let ids = [];
    try {
      ids = fs.readdirSync(dir).filter((id) => ID.test(id));
    } catch {
      return [];
    }
    return ids.map(readMeta).filter(Boolean).sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
  }

  /** The chosen pack's id, or null for the built-in interface. */
  function active() {
    const id = db.get('ui-pack', null);
    return typeof id === 'string' && ID.test(id) && readMeta(id) ? id : null;
  }

  function setActive(id) {
    if (id === null) {
      db.set('ui-pack', null);
      return null;
    }
    if (typeof id !== 'string' || !ID.test(id) || !readMeta(id)) throw new PackError('No such interface.');
    db.set('ui-pack', id);
    return id;
  }

  /** The folder the chosen pack serves `kind` ('web', 'studio') from, or null. */
  function root(kind) {
    const id = active();
    if (!id || !KINDS.includes(kind)) return null;
    const folder = path.join(dir, id, 'files', kind);
    return fs.existsSync(folder) ? folder : null;
  }

  /** Install a pack from a .zip (Buffer); `fileName` names it without a ui.json. */
  async function install(zip, fileName = '') {
    if (installing) throw new PackError('Another interface is being installed. Try again when it is done.');
    installing = true;
    try {
      if (list().length >= MAX_PACKS) throw new PackError(`There are ${MAX_PACKS} interfaces already: delete one first.`);
      let entries;
      try {
        entries = readZip(zip);
      } catch (err) {
        if (err instanceof ZipError) throw new PackError(err.message);
        throw err;
      }
      // leave out what a Mac or Windows adds, and a folder the whole pack is in
      entries = entries.filter((e) => !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/.test(e.name));
      const tops = new Set(entries.map((e) => e.name.split('/')[0]));
      if (tops.size === 1 && entries.every((e) => e.name.includes('/')) && !KINDS.includes([...tops][0])) {
        const top = [...tops][0].length + 1;
        entries = entries.map((e) => ({ ...e, name: e.name.slice(top) }));
      }
      let manifest = {};
      const files = [];
      for (const e of entries) {
        const rel = safeRel(e.name);
        if (!rel) throw new PackError(`"${cleanText(e.name, 120)}" is not a path a pack can use.`);
        if (rel === 'ui.json') {
          try {
            manifest = JSON.parse(e.data.toString('utf8')) || {};
          } catch {
            throw new PackError('ui.json is not valid JSON.');
          }
        } else if (KINDS.includes(rel.split('/')[0]) && rel.includes('/')) files.push({ rel, data: e.data });
      }
      if (!files.length) throw new PackError('The pack has no files in web/ or studio/. Download the original interface to see how a pack is laid out.');
      const name = cleanText(manifest.name, 64) || cleanText(path.basename(String(fileName)).replace(/\.zip$/i, ''), 64) || 'Custom interface';
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'ui';
      const id = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
      const meta = {
        id, name,
        description: cleanText(manifest.description, 300),
        author: cleanText(manifest.author, 64),
        files: files.length,
        bytes: files.reduce((sum, f) => sum + f.data.length, 0),
        replaces: KINDS.filter((k) => files.some((f) => f.rel.startsWith(`${k}/`))),
        uploadedAt: new Date().toISOString()
      };
      // unpacked next to the others, then put in place in one rename
      const tmp = path.join(dir, `.incoming-${crypto.randomBytes(4).toString('hex')}`);
      await fsp.mkdir(tmp, { recursive: true });
      try {
        for (const f of files) {
          const abs = path.join(tmp, 'files', ...f.rel.split('/'));
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          await fsp.writeFile(abs, f.data, { flag: 'wx' });
        }
        await fsp.writeFile(path.join(tmp, 'pack.json'), JSON.stringify(meta, null, 2));
        await fsp.rename(tmp, path.join(dir, id));
      } catch (err) {
        await fsp.rm(tmp, { recursive: true, force: true });
        if (err.code === 'EEXIST') throw new PackError('The pack has the same file twice.');
        throw err;
      }
      log.info?.(`UI pack "${name}" (${id}) installed: ${meta.files} files`);
      return meta;
    } finally {
      installing = false;
    }
  }

  async function remove(id) {
    if (typeof id !== 'string' || !ID.test(id) || !readMeta(id)) throw new PackError('No such interface.');
    if (active() === id) db.set('ui-pack', null);
    await fsp.rm(path.join(dir, id), { recursive: true, force: true });
  }

  /** Leftovers of an install a restart cut short. */
  async function tidy() {
    await fsp.mkdir(dir, { recursive: true });
    for (const name of await fsp.readdir(dir)) {
      if (name.startsWith('.incoming-')) await fsp.rm(path.join(dir, name), { recursive: true, force: true });
    }
  }

  return { list, active, setActive, root, install, remove, tidy };
}

/** Every file under `folder` as [{ name: prefix + relative path, data }]. */
async function filesUnder(folder, prefix) {
  const out = [];
  const walk = async (abs, rel) => {
    for (const entry of await fsp.readdir(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(childAbs, childRel);
      else if (entry.isFile()) out.push({ name: `${prefix}${childRel}`, data: await fsp.readFile(childAbs) });
    }
  };
  await walk(folder, '');
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The built-in interface as a pack to start from (a .zip Buffer). */
async function originalPack({ web, studio, version = '' }) {
  const readme = [
    'Sentry Six Manager interface pack',
    '',
    'This is the built-in interface. Change any file, zip the folder and',
    'upload it under Settings > Interface. Files you delete from the pack',
    'stay the built-in ones, so a pack can be as small as one stylesheet:',
    '',
    '  web/      the manager: index.html, app.js (pages), shell.css (look)',
    '  studio/   the Viewer (index.html) and the Encoder (encoder.html)',
    '  ui.json   the name shown in Settings',
    '',
    'Scripts must be files of the pack (<script src="...">): the pages',
    'run no inline scripts and nothing from other sites.',
    'If a pack breaks the pages, open /original on the server: that',
    'browser then shows the built-in interface, and Settings > Interface',
    'can switch back for everyone.',
    ''
  ].join('\n');
  const files = [
    { name: 'README.txt', data: Buffer.from(readme) },
    { name: 'ui.json', data: Buffer.from(`${JSON.stringify({ name: 'My interface', description: `Based on the built-in interface${version ? ` of ${version}` : ''}.`, author: '' }, null, 2)}\n`) },
    ...await filesUnder(web, 'web/'),
    ...await filesUnder(studio, 'studio/')
  ];
  return writeZip(files);
}

module.exports = { createUiPacks, originalPack, PackError, MAX_ZIP_BYTES, safeRel };
