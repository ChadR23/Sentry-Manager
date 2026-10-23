'use strict';

// Remembers which clips are already H.265 / AV1, so a new run skips them while
// it discovers files instead of probing each one again (over a share that
// took ~3 s per clip and an encode slot). An entry is keyed by the clip's
// path and only counts while the file still has the size and modification
// time (and inode, when both sides know it) it had when it was recorded: a
// file that changed in any way is looked at again. Losing the file only
// costs speed, never correctness, so a damaged one is simply started over.

const nodeFs = require('fs');
const nodePath = require('path');

const VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_UNSEEN_DAYS = 30;
const MAX_ENTRIES = 250_000;
const FLUSH_DELAY_MS = 5_000;
const CODECS = new Set(['h265', 'av1']);

function inodeOf(value) {
  if (typeof value === 'bigint') return value > 0n ? String(value) : null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^\d{1,32}$/.test(value) && !/^0+$/.test(value)) return value;
  return null;
}

/**
 * options: { file (absolute path of the JSON file), fs (promises API), pathApi,
 * now, flushDelayMs, keepUnseenDays, maxEntries }.
 * Items are discovered clips: { sourcePath, sourceBytes, mtimeMs, ino? }.
 */
function createConvertedIndex(options = {}) {
  const fs = options.fs || nodeFs.promises;
  const pathApi = options.pathApi || nodePath;
  const now = options.now || Date.now;
  const file = options.file;
  if (typeof file !== 'string' || !pathApi.isAbsolute(file)) throw new TypeError('file must be an absolute path');
  const flushDelayMs = options.flushDelayMs ?? FLUSH_DELAY_MS;
  const keepUnseenDays = options.keepUnseenDays ?? KEEP_UNSEEN_DAYS;
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const entries = new Map(); // path -> { size, mtimeMs, ino, codec, seen (day number) }
  let dirty = false;
  let timer = null;
  let writing = Promise.resolve();
  let lastWriteMs = 0;
  let closed = false;

  const today = () => Math.floor(now() / DAY_MS);
  const keyOf = (item) => (typeof item?.sourcePath === 'string' && item.sourcePath.length > 0
    ? pathApi.resolve(item.sourcePath) : null);

  async function load() {
    entries.clear();
    let stored;
    try { stored = JSON.parse(await fs.readFile(file, 'utf8')); } catch (_) { return 0; }
    if (stored?.v !== VERSION || !stored.entries || typeof stored.entries !== 'object') return 0;
    for (const [key, value] of Object.entries(stored.entries)) {
      if (!Array.isArray(value) || value.length !== 5) continue;
      const [size, mtimeMs, ino, codec, seen] = value;
      if (!Number.isSafeInteger(size) || size < 0 || !Number.isFinite(mtimeMs) || !CODECS.has(codec)
          || !Number.isSafeInteger(seen) || !pathApi.isAbsolute(key)) continue;
      entries.set(key, { size, mtimeMs, ino: inodeOf(ino), codec, seen });
    }
    return entries.size;
  }

  /** 'h265' / 'av1' when the clip is recorded as converted and unchanged, else null. */
  function has(item) {
    const key = keyOf(item);
    const entry = key ? entries.get(key) : null;
    if (!entry) return null;
    const ino = inodeOf(item.ino);
    if (entry.size !== item.sourceBytes || entry.mtimeMs !== item.mtimeMs || (entry.ino && ino && entry.ino !== ino)) {
      // The file changed since: look at it again (and do not keep the stale entry).
      entries.delete(key);
      dirty = true;
      return null;
    }
    const day = today();
    if (entry.seen !== day) {
      entry.seen = day;
      dirty = true;
    }
    return entry.codec;
  }

  function add(item, codec) {
    const key = keyOf(item);
    if (!key || !CODECS.has(codec) || !Number.isSafeInteger(item.sourceBytes) || item.sourceBytes < 0
        || !Number.isFinite(item.mtimeMs)) return false;
    entries.set(key, { size: item.sourceBytes, mtimeMs: item.mtimeMs, ino: inodeOf(item.ino), codec, seen: today() });
    dirty = true;
    schedule();
    return true;
  }

  // Batched: a run that records thousands of clips writes the file every few
  // seconds, and less often while a write takes long (a large index).
  function schedule() {
    if (timer || closed) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, Math.max(flushDelayMs, lastWriteMs * 10));
    timer.unref?.();
  }

  function snapshot() {
    const oldest = today() - keepUnseenDays;
    let kept = [...entries].filter(([, entry]) => entry.seen >= oldest);
    if (kept.length > maxEntries) kept = kept.sort((left, right) => right[1].seen - left[1].seen).slice(0, maxEntries);
    if (kept.length !== entries.size) {
      const keep = new Set(kept.map(([key]) => key));
      for (const key of [...entries.keys()]) if (!keep.has(key)) entries.delete(key);
    }
    const out = {};
    for (const [key, entry] of kept) out[key] = [entry.size, entry.mtimeMs, entry.ino, entry.codec, entry.seen];
    return { v: VERSION, entries: out };
  }

  /** Writes pending changes (temp file + rename, so a crash never leaves half a file). */
  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    writing = writing.catch(() => undefined).then(async () => {
      if (!dirty) return true;
      dirty = false;
      const started = now();
      const temporary = `${file}.tmp`;
      try {
        await fs.mkdir(pathApi.dirname(file), { recursive: true });
        await fs.writeFile(temporary, JSON.stringify(snapshot()));
        await fs.rename(temporary, file);
        lastWriteMs = Math.max(0, now() - started);
        return true;
      } catch (_) {
        dirty = true; // tried again with the next flush
        return false;
      }
    });
    return writing;
  }

  async function close() {
    closed = true;
    await flush();
  }

  return Object.freeze({
    load,
    has,
    add,
    flush,
    close,
    get size() { return entries.size; }
  });
}

module.exports = { createConvertedIndex, KEEP_UNSEEN_DAYS };
