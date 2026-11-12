'use strict';

// Recycle Bin. "Move to trash" renames a recording's files into
// <vehicle root>/.sentry-recycle-bin/<item>/<original path>.binned — a rename
// on the same share, so it is instant. The .binned suffix keeps the files
// invisible to the converter and the viewer. Nothing in here ever deletes on
// its own: files only go away when the user deletes them forever or empties
// the bin (or the bin is emptied after N days, policies.js). Each item deleted
// for good is reported (onDeleted), so its CAN logs can go with it.
//
// Crash safety: the bin item is written to the database (its files marked
// pending) before the first file moves, so a crash or power cut in the middle
// leaves a record; reconcile() settles it on the next start, and adopts bin
// folders the database does not know about. Protect and trash take the same
// per-vehicle lock, so a recording protected while a trash or policy run is
// going is never moved. Every rename and delete first checks that its folder
// really is inside the share (a symlink planted on the share cannot redirect
// it).

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { safeJoin, TYPE_BY_FOLDER } = require('./footage');
const { renameInside, unlinkInside, rmdirInside, mkdirpInside, rmrfInside } = require('./safeFs');
const { createDeletedClips } = require('./deletedClips');

const BIN_DIR = '.sentry-recycle-bin';
const JUNK_RE = /^(\._.+|\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

function isKeptDir(rel) {
  if (!rel || rel === '.' || !rel.includes('/')) return true; // root and its direct children
  const name = rel.split('/').pop().toLowerCase();
  return Boolean(TYPE_BY_FOLDER[name]) || name === 'teslacam' || name === 'teslausb';
}

/** rmdir folders left empty under `root`, deepest first, never recursively. */
async function removeEmptyDirs(root, rels, { keep = isKeptDir } = {}) {
  const dirs = new Set();
  for (const rel of rels) {
    for (let d = path.posix.dirname(rel); d && d !== '.' && !keep(d); d = path.posix.dirname(d)) dirs.add(d);
  }
  for (const d of [...dirs].sort((a, b) => b.split('/').length - a.split('/').length)) {
    const abs = safeJoin(root, d);
    try {
      const names = await fsp.readdir(abs);
      // every file op follows no symlink out of the share (safeFs)
      if (names.length && names.every((n) => JUNK_RE.test(n))) await Promise.all(names.map((n) => unlinkInside(root, path.join(abs, n)).catch(() => {})));
      await rmdirInside(root, abs);
    } catch {
      // not empty, a planted symlink, or already gone
    }
  }
}

async function exists(p) {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}

const SKIP_WORDS = { protected: 'protected', converting: 'being converted right now', missing: 'a file is no longer there (refresh the inventory)', error: 'could not be moved' };
/** Why recordings were not moved, counted: "3 protected, 1 could not be moved (EACCES: ...)". */
function skipWhy(skipped) {
  const by = new Map();
  for (const s of skipped) {
    const k = SKIP_WORDS[s.reason] ? s.reason : 'error';
    if (!by.has(k)) by.set(k, { n: 0, message: s.message });
    by.get(k).n++;
  }
  return [...by].map(([k, { n, message }]) => `${n} ${SKIP_WORDS[k]}${k === 'error' && message ? ` (${String(message).slice(0, 160)})` : ''}`).join(', ');
}

class RecycleBin {
  // onDeleted(item): an item was deleted for good (its CAN logs may go with it: canPrune.js)
  constructor({ db, vehicles, inventory, jobs, log, busyPaths = () => new Set(), onDeleted = () => {}, deletedClips = null }) {
    Object.assign(this, { db, vehicles, inventory, jobs, log, busyPaths, onDeleted });
    // the clips deleted for good, so the archive check never calls them "Pi missed" (deletedClips.js)
    this.deletedClips = deletedClips || createDeletedClips({ db });
    this.locks = new Map(); // vehicle id -> tail of its lock chain
  }

  /** Run fn while holding the vehicle's lock (shared by protect and trash). */
  withLock(vehicleId, fn) {
    const prev = this.locks.get(vehicleId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tailP = next.catch(() => {});
    this.locks.set(vehicleId, tailP);
    tailP.then(() => { if (this.locks.get(vehicleId) === tailP) this.locks.delete(vehicleId); });
    return next;
  }

  /** Protect or unprotect files, never in the middle of moving one of their recordings. */
  setProtected(vehicleId, rels, on) {
    return this.withLock(vehicleId, () => this.db.setProtected(vehicleId, rels, on));
  }

  rootOf(vehicleId) {
    const v = this.vehicles.get(vehicleId);
    if (!v) throw Object.assign(new Error('No such vehicle.'), { status: 404 });
    const share = this.vehicles.share(vehicleId);
    if (share && !share.isWritable()) throw Object.assign(new Error(`${v.name}: the share is not writable right now.`), { status: 503 });
    return { vehicle: v, root: this.vehicles.rootOf(v) };
  }

  /** Move recordings to the bin. Protected or busy recordings are refused. */
  async trash(vehicleId, recordingIds, { reason = 'manual' } = {}) {
    const { vehicle, root } = this.rootOf(vehicleId);
    const inv = this.inventory.get(vehicleId);
    if (!inv?.recordings) throw Object.assign(new Error('Footage has not been scanned yet.'), { status: 409 });
    const wanted = new Set(recordingIds);
    const recordings = inv.recordings.filter((r) => wanted.has(r.id));
    const result = { moved: [], skipped: [], bytes: 0 };
    const jobId = this.jobs.start({ type: reason === 'policy' ? 'policy' : 'trash', vehicleId, title: `Move ${recordings.length} recording(s) to the Recycle Bin` });
    const realRoot = await fsp.realpath(root).catch(() => root);
    for (const rec of recordings) {
      await this.withLock(vehicleId, async () => {
        // protection is read again here: it may have been set after this run started
        const protectedRels = this.db.protectedSet(vehicleId);
        if (rec.protected || rec.files.some((rel) => protectedRels.has(rel))) {
          result.skipped.push({ id: rec.id, reason: 'protected' });
          return;
        }
        // only a clip a conversion is working on right now; a queued one may go
        const inHand = this.busyPaths();
        const busy = inHand.size && rec.files.find((rel) => inHand.has(path.join(root, rel)) || inHand.has(path.join(realRoot, rel)));
        if (busy) {
          result.skipped.push({ id: rec.id, reason: 'converting' });
          return;
        }
        const itemId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
        const planned = rec.files.map((rel) => ({ rel, binRel: `${BIN_DIR}/${itemId}/${rel}.binned`, size: inv.files.get(rel)?.size ?? 0, pending: true }));
        const record = {
          id: itemId, vehicleId, label: `${rec.category} ${rec.start || ''}`.trim(), category: rec.category,
          startAt: rec.start, bytes: planned.reduce((n, f) => n + f.size, 0), files: planned, trashedAt: Date.now(), reason
        };
        this.db.addBinItem(record);
        const moved = [];
        try {
          for (const f of planned) {
            const from = safeJoin(root, f.rel);
            const to = safeJoin(root, f.binRel);
            // safeFs creates the bin folder and moves the file following no
            // symlink out of the share (a swapped directory is refused)
            await mkdirpInside(root, path.dirname(to));
            const size = inv.files.get(f.rel)?.size ?? (await fsp.lstat(from)).size;
            await renameInside(root, from, to);
            moved.push({ rel: f.rel, binRel: f.binRel, size });
          }
        } catch (err) {
          // put back whatever moved so a recording is never split
          for (const m of moved.reverse()) await renameInside(root, safeJoin(root, m.binRel), safeJoin(root, m.rel)).catch(() => {});
          await rmrfInside(root, safeJoin(root, `${BIN_DIR}/${itemId}`)).catch(() => {});
          this.db.removeBinItem(itemId);
          result.skipped.push({ id: rec.id, reason: err.code === 'ENOENT' ? 'missing' : 'error', message: err.message });
          return;
        }
        const bytes = moved.reduce((n, m) => n + m.size, 0);
        this.db.updateBinFiles(itemId, moved, bytes);
        for (const m of moved) inv.files.delete(m.rel);
        result.moved.push(rec.id);
        result.bytes += bytes;
        await removeEmptyDirs(root, rec.files);
      });
    }
    this.inventory.rebuild(vehicleId);
    this.jobs.finish(jobId, {
      status: result.skipped.some((s) => s.reason === 'error') ? 'failed' : 'done',
      detail: `${result.moved.length} moved (${formatBytes(result.bytes)})${result.skipped.length ? `, ${result.skipped.length} skipped: ${skipWhy(result.skipped)}` : ''}`,
      result
    });
    if (result.skipped.length) this.log.warn(`${vehicle.name}: ${result.skipped.length} recording(s) not moved to the Recycle Bin: ${skipWhy(result.skipped)}`);
    this.log.info(`${vehicle.name}: ${result.moved.length} recording(s) moved to the Recycle Bin (${reason})`);
    return result;
  }

  /** Locate a readable thumbnail without requiring write access to the share. */
  async thumbnailSource(itemId) {
    const item = this.db.binItem(itemId);
    if (!item) return null;
    const vehicle = this.vehicles.get(item.vehicleId);
    if (!vehicle) return null;
    const root = this.vehicles.rootOf(vehicle);
    const itemRoot = safeJoin(root, BIN_DIR + '/' + item.id);
    const realItem = await fsp.realpath(itemRoot).catch(() => null);
    const realRoot = await fsp.realpath(root).catch(() => null);
    if (!realItem || !realRoot || !realItem.startsWith(realRoot + path.sep)) return null;
    const candidates = [...item.files.filter(f => /(^|\/)thumb\.png$/i.test(f.rel)), ...item.files.filter(f => /-front\.mp4$/i.test(f.rel))];
    for (const f of candidates) {
      if (f.pending || !f.binRel.startsWith(BIN_DIR + '/' + item.id + '/')) continue;
      const abs = await fsp.realpath(safeJoin(root, f.binRel)).catch(() => null);
      if (!abs || !abs.startsWith(realItem + path.sep)) continue;
      if (!(await fsp.stat(abs).catch(() => null))?.isFile()) continue;
      return { kind: /thumb\.png$/i.test(f.rel) ? 'image' : 'clip', abs };
    }
    return null;
  }

  list(vehicleId) {
    return this.db.binItems(vehicleId);
  }

  /**
   * After a restart: finish bin items a crash interrupted (keep what moved,
   * drop what did not), and list bin folders the database does not know.
   */
  async reconcile(vehicleId) {
    const { root } = this.rootOf(vehicleId);
    return this.withLock(vehicleId, async () => {
      let fixed = 0;
      let adopted = 0;
      for (const item of this.db.binItems(vehicleId)) {
        if (!item.files.some((f) => f.pending)) continue;
        const moved = [];
        for (const f of item.files) {
          const st = await fsp.lstat(safeJoin(root, f.binRel)).catch(() => null);
          if (st?.isFile()) moved.push({ rel: f.rel, binRel: f.binRel, size: st.size });
        }
        if (moved.length) this.db.updateBinFiles(item.id, moved, moved.reduce((n, m) => n + m.size, 0));
        else this.db.removeBinItem(item.id);
        fixed++;
      }
      const known = new Set(this.db.binItems(vehicleId).map((i) => i.id));
      const binRoot = safeJoin(root, BIN_DIR);
      for (const ent of await fsp.readdir(binRoot, { withFileTypes: true }).catch(() => [])) {
        if (!ent.isDirectory() || known.has(ent.name) || !/^[a-z0-9]+-[a-f0-9]{8}$/.test(ent.name)) continue;
        const files = [];
        const walk = async (relDir) => {
          for (const e of await fsp.readdir(safeJoin(root, relDir), { withFileTypes: true }).catch(() => [])) {
            const rel = `${relDir}/${e.name}`;
            if (e.isDirectory()) await walk(rel);
            else if (e.isFile() && e.name.endsWith('.binned')) {
              const st = await fsp.lstat(safeJoin(root, rel)).catch(() => null);
              if (st) files.push({ rel: rel.slice(`${BIN_DIR}/${ent.name}/`.length, -'.binned'.length), binRel: rel, size: st.size });
            }
          }
        };
        await walk(`${BIN_DIR}/${ent.name}`);
        if (!files.length) {
          await rmrfInside(root, safeJoin(root, `${BIN_DIR}/${ent.name}`)).catch(() => {});
          continue;
        }
        const first = files[0].rel;
        const category = /SentryClips/i.test(first) ? 'Sentry' : /SavedClips/i.test(first) ? 'Saved' : /RecentClips/i.test(first) ? 'Recent' : 'Other';
        this.db.addBinItem({
          id: ent.name, vehicleId, label: `${category} (recovered after a restart)`, category, startAt: null,
          bytes: files.reduce((n, f) => n + f.size, 0), files, trashedAt: Date.now(), reason: 'recovered'
        });
        adopted++;
      }
      if (fixed || adopted) this.log.warn(`Recycle Bin: settled ${fixed} interrupted move(s), recovered ${adopted} unlisted item(s)`);
      return { fixed, adopted };
    });
  }

  /** Put an item back where it was; files whose spot is taken stay in the bin. */
  async restore(itemId) {
    const item = this.db.binItem(itemId);
    if (!item) throw Object.assign(new Error('Not in the Recycle Bin.'), { status: 404 });
    return this.withLock(item.vehicleId, () => this.restoreLocked(itemId));
  }

  async restoreLocked(itemId) {
    const item = this.db.binItem(itemId);
    if (!item) throw Object.assign(new Error('Not in the Recycle Bin.'), { status: 404 });
    if (item.files.some((f) => f.pending)) throw Object.assign(new Error('This item is still being moved to the Recycle Bin.'), { status: 409 });
    const { root } = this.rootOf(item.vehicleId);
    const left = [];
    const restored = [];
    for (const f of item.files) {
      const from = safeJoin(root, f.binRel);
      const to = safeJoin(root, f.rel);
      if (!(await exists(from))) continue;
      if (await exists(to)) {
        left.push({ ...f, conflict: true });
        continue;
      }
      try {
        // following no symlink out of the share (safeFs)
        await mkdirpInside(root, path.dirname(to));
        await renameInside(root, from, to);
      } catch (err) {
        this.log.warn(`Restore of ${f.rel} refused: ${err.message}`);
        left.push({ ...f, conflict: true });
        continue;
      }
      restored.push(f.rel);
    }
    if (left.length) this.db.updateBinFiles(itemId, left, left.reduce((n, f) => n + f.size, 0));
    else this.db.removeBinItem(itemId);
    await removeEmptyDirs(root, item.files.map((f) => f.binRel), { keep: (d) => d === BIN_DIR || isKeptDir(d) });
    const jobId = this.jobs.start({ type: 'restore', vehicleId: item.vehicleId, title: `Restore ${item.label}` });
    this.jobs.finish(jobId, { status: left.length ? 'failed' : 'done', detail: `${restored.length} file(s) restored${left.length ? `, ${left.length} could not (a file with that name exists)` : ''}` });
    this.inventory.scan(item.vehicleId).catch(() => {});
    return { restored: restored.length, conflicts: left.length };
  }

  /** Permanently delete one item (user action only). */
  async deleteForever(itemId) {
    const item = this.db.binItem(itemId);
    if (!item) throw Object.assign(new Error('Not in the Recycle Bin.'), { status: 404 });
    return this.withLock(item.vehicleId, () => this.deleteLocked(itemId));
  }

  async deleteLocked(itemId) {
    const item = this.db.binItem(itemId);
    if (!item) throw Object.assign(new Error('Not in the Recycle Bin.'), { status: 404 });
    if (item.files.some((f) => f.pending)) throw Object.assign(new Error('This item is still being moved to the Recycle Bin.'), { status: 409 });
    const { root } = this.rootOf(item.vehicleId);
    let bytes = 0;
    for (const f of item.files) {
      try {
        const target = safeJoin(root, f.binRel);
        await unlinkInside(root, target);
        bytes += f.size;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    await rmrfInside(root, safeJoin(root, `${BIN_DIR}/${itemId}`));
    this.db.removeBinItem(itemId);
    try { this.deletedClips.add(item.vehicleId, item.files.map((f) => f.rel)); } catch (err) { this.log.warn(`Deleted-clips record: ${err.message}`); }
    // every delete for good comes here (by hand, emptying the bin, the bin emptied after N days)
    try { this.onDeleted(item); } catch (err) { this.log.warn(`After deleting ${item.label}: ${err.message}`); }
    return { bytes };
  }

  async empty(vehicleId) {
    const items = this.db.binItems(vehicleId);
    const jobId = this.jobs.start({ type: 'empty-bin', vehicleId, title: `Empty the Recycle Bin (${items.length} item(s))` });
    let bytes = 0;
    let failed = 0;
    for (const item of items) {
      try {
        bytes += (await this.deleteForever(item.id)).bytes;
      } catch (err) {
        failed++;
        this.log.warn(`Could not delete ${item.label}: ${err.message}`);
      }
    }
    this.jobs.finish(jobId, { status: failed ? 'failed' : 'done', detail: `${formatBytes(bytes)} freed${failed ? `, ${failed} failed` : ''}` });
    return { deleted: items.length - failed, failed, bytes };
  }

  binBytes(vehicleId) {
    return this.db.binItems(vehicleId).reduce((n, i) => n + i.bytes, 0);
  }
}

function formatBytes(n) {
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

module.exports = { RecycleBin, removeEmptyDirs, BIN_DIR, formatBytes };
