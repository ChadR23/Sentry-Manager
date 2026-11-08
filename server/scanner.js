'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { classify, localDay, shouldSkipDir, isConverterArtifact } = require('./footage');

/**
 * Tiny promise limiter: at most `max` calls of fn in flight. The queue is read
 * by an index, not shift(): a folder of 30,000 clips queues 30,000 stats at
 * once, and shift() moved the whole array for each (450 ms of an index).
 */
function limiter(max) {
  let active = 0;
  let waiting = [];
  let head = 0;
  const next = () => {
    if (active >= max || head >= waiting.length) return;
    active++;
    const { fn, resolve, reject } = waiting[head];
    waiting[head++] = null;
    // drop what has been taken, now and then
    if (head > 1024 && head * 2 > waiting.length) { waiting = waiting.slice(head); head = 0; }
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) => new Promise((resolve, reject) => {
    waiting.push({ fn, resolve, reject });
    next();
  });
}

/**
 * Walk the footage root. Network shares make every stat a round trip, so
 * directory reads and stats run in parallel (bounded by `concurrency`).
 */
//
// A light rescan (`previous`, from the last scan): a folder whose modified
// time is unchanged keeps what it knew of its files, except files changed in
// the last two hours (one still being copied grows without touching its
// folder). Adding, removing or replacing a file (the converter swapping a clip
// in) changes the folder's time, so such a folder is looked at in full. On a
// quiet share that is one call per folder instead of one per file (48,000
// files: 48,000 round trips to the NAS every 15 minutes).
const RECENT_MS = 2 * 3600 * 1000;
async function scanFootage(root, { concurrency = 16, onProgress, previous = null } = {}) {
  const started = Date.now();
  const limit = limiter(concurrency);
  const files = new Map();
  const dirs = new Map(); // relDir -> modified time
  const errors = [];
  let seen = 0;
  let reused = 0;

  async function visit(relDir) {
    let entries;
    let dirMtime = null;
    try {
      [entries, dirMtime] = await Promise.all([
        limit(() => fsp.readdir(path.join(root, relDir), { withFileTypes: true })),
        // (every scan notes it, for the next light one)
        limit(() => fsp.stat(path.join(root, relDir))).then((st) => st.mtimeMs, () => null)
      ]);
    } catch (err) {
      errors.push({ rel: relDir || '.', message: err.message, code: err.code });
      return;
    }
    if (dirMtime !== null) dirs.set(relDir, dirMtime);
    const unchanged = previous && dirMtime !== null && previous.dirs?.get(relDir) === dirMtime;
    const tasks = [];
    for (const ent of entries) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (!shouldSkipDir(ent.name)) tasks.push(visit(rel));
        continue;
      }
      if (!ent.isFile()) continue;
      if (isConverterArtifact(ent.name)) continue;
      const info = classify(rel);
      if (!info) continue;
      const known = unchanged ? previous.files.get(rel) : null;
      if (known && started - known.mtimeMs > RECENT_MS) {
        files.set(rel, known);
        seen++;
        reused++;
        continue;
      }
      tasks.push(limit(() => fsp.stat(path.join(root, rel))).then(
        (st) => {
          files.set(rel, {
            rel,
            size: st.size,
            mtimeMs: st.mtimeMs,
            // when it reached the share (the archive keeps mtime): archiveGap.js
            ctimeMs: st.ctimeMs,
            birthtimeMs: st.birthtimeMs,
            ...info,
            day: info.day || localDay(st.mtimeMs)
          });
          seen++;
          if (onProgress && seen % 500 === 0) onProgress(seen);
        },
        (err) => {
          if (err.code !== 'ENOENT') errors.push({ rel, message: err.message, code: err.code });
        }
      ));
    }
    await Promise.all(tasks);
  }

  await visit('');
  return { files, dirs, errors, reused, light: Boolean(previous), scannedAt: Date.now(), durationMs: Date.now() - started };
}

module.exports = { scanFootage, limiter };
