'use strict';

// Footage check: finds clips that cannot play: empty files, files that are
// not MP4, and clips cut off part way (the car lost power or the USB drive
// was pulled while recording: the index at the end, "moov", is missing, or
// the video data runs past the end of the file). Only the files' box headers
// are read (a few bytes each), nothing is decoded.
//
// Results are kept per vehicle in data/integrity/<vehicle>.json
// ({ rel: [size, mtimeMs, problem | null] }), so a check that a restart cut
// short goes on where it was, and unchanged files are not read again.

const fsp = require('fs/promises');
const path = require('path');

/** What is wrong with an MP4 file (null: nothing found). */
async function checkFile(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const { size } = await fh.stat();
    if (size === 0) return 'empty file';
    const head = Buffer.alloc(16);
    let pos = 0;
    let first = true;
    let moov = false;
    let boxes = 0;
    while (pos < size) {
      if (size - pos < 8) return first ? 'not an MP4 file' : 'cut off: the file ends part way through';
      const { bytesRead } = await fh.read(head, 0, 16, pos);
      if (bytesRead < 8) return 'cut off: the file ends part way through';
      let len = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (!/^[\x20-\x7e]{4}$/.test(type)) return first ? 'not an MP4 file' : 'damaged: unreadable data in the file';
      if (first && type !== 'ftyp') return 'not an MP4 file';
      first = false;
      if (len === 1) {
        if (bytesRead < 16) return 'cut off: the file ends part way through';
        len = Number(head.readBigUInt64BE(8));
      } else if (len === 0) len = size - pos; // to the end of the file
      if (len < 8) return 'damaged: unreadable data in the file';
      if (pos + len > size) return type === 'mdat' && !moov ? 'cut off while recording (no index): it will not play' : 'cut off: the file ends part way through';
      if (type === 'moov') moov = true;
      pos += len;
      if (++boxes > 10000) break;
    }
    return moov ? null : 'no index (moov): it will not play';
  } catch (err) {
    return `could not be read (${err.code || err.message})`;
  } finally {
    await fh?.close().catch(() => {});
  }
}

function createIntegrity({ dir, inventory, vehicles, log, concurrency = 4, marks = null }) {
  const loaded = new Map(); // vehicle -> data
  const runs = new Map(); // vehicle -> { running, done, total, startedAt, finishedAt }
  const fileOf = (vid) => path.join(dir, `${String(vid).replace(/[^\w-]/g, '_')}.json`);

  async function load(vid) {
    if (loaded.has(vid)) return loaded.get(vid);
    let data = {};
    try { data = JSON.parse(await fsp.readFile(fileOf(vid), 'utf8')) || {}; } catch { /* none yet */ }
    loaded.set(vid, data);
    return data;
  }
  async function save(vid) {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${fileOf(vid)}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(loaded.get(vid) || {}));
    await fsp.rename(tmp, fileOf(vid));
  }

  const clipsOf = (vid) => [...(inventory.get(vid)?.files?.values() || [])].filter((f) => f.kind === 'clip' && /\.mp4$/i.test(f.rel));
  const fresh = (had, f) => had && had[0] === f.size && had[1] === Math.round(f.mtimeMs);

  /** Check what is new or changed; one run per vehicle at a time. */
  function start(vid) {
    const cur = runs.get(vid);
    if (cur?.running) return status(vid);
    const run = { running: true, done: 0, total: 0, startedAt: Date.now(), finishedAt: null, promise: null };
    runs.set(vid, run);
    // a check a restart cuts short is started again (resume()), and goes on where it was
    marks?.set(vid, true);
    run.promise = (async () => {
      const data = await load(vid);
      const root = vehicles.rootOf(vehicles.get(vid));
      const todo = clipsOf(vid).filter((f) => !fresh(data[f.rel], f));
      run.total = todo.length;
      let next = 0;
      let sinceSave = 0;
      const work = async () => {
        while (next < todo.length) {
          const f = todo[next++];
          data[f.rel] = [f.size, Math.round(f.mtimeMs), await checkFile(path.join(root, f.rel))];
          run.done++;
          if (++sinceSave >= 200) { sinceSave = 0; await save(vid); }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, work));
      // files that are gone are forgotten
      const present = new Set(clipsOf(vid).map((f) => f.rel));
      for (const rel of Object.keys(data)) if (!present.has(rel)) delete data[rel];
      await save(vid);
      const bad = Object.values(data).filter((x) => x[2]).length;
      log?.info?.(`Footage check of ${vid}: ${run.total} file(s) read, ${bad} that will not play`);
      marks?.set(vid, false);
    })().catch((err) => log?.warn?.(`Footage check of ${vid}: ${err.message}`)).finally(() => {
      run.running = false;
      run.finishedAt = Date.now();
    });
    return status(vid);
  }

  function status(vid) {
    const r = runs.get(vid);
    return r ? { running: r.running, done: r.done, total: r.total, startedAt: r.startedAt, finishedAt: r.finishedAt } : { running: false, done: 0, total: 0 };
  }

  /** The clips found broken (still the same file), with how many were checked. */
  async function results(vid) {
    const data = await load(vid);
    const files = inventory.get(vid)?.files;
    const problems = [];
    let checked = 0;
    for (const f of clipsOf(vid)) {
      const had = data[f.rel];
      if (!fresh(had, f)) continue;
      checked++;
      if (had[2]) problems.push({ rel: f.rel, day: f.day || null, camera: f.camera || null, size: f.size, problem: had[2] });
    }
    problems.sort((a, b) => b.rel.localeCompare(a.rel));
    return { checked, files: files ? clipsOf(vid).length : 0, problems: problems.slice(0, 500), more: Math.max(0, problems.length - 500), ...status(vid) };
  }

  /** After a start: a check that was running when the app stopped goes on (once its files are known). */
  function resume(vid) {
    if (marks?.get(vid) && !runs.get(vid)?.running && inventory.get(vid)?.files) {
      log?.info?.(`Footage check of ${vid}: going on after the restart`);
      start(vid);
    }
  }

  return { start, status, results, resume, checkFile, wait: (vid) => runs.get(vid)?.promise };
}

module.exports = { createIntegrity, checkFile };
