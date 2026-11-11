'use strict';

// Clips Sentry Six Manager deleted for good, per car: so the archive check
// (archiveGap.js) never calls a clip "Pi missed" because Manager itself took it
// off the share. Sentry USB's list of what the car wrote (carFiles.js) keeps a
// clip 7 days, also after it is gone from the share.
//
// Every delete for good goes through the Recycle Bin (recycleBin.js
// deleteLocked): deleting an item by hand, emptying the bin, the bin emptied
// after N days, and the policies (which move recordings to the bin and empty
// it). "Delete its CAN data" removes CAN logs only, never clips.
//
// Kept in the database (settings key deleted-clips:<vehicle>) as
// [[rel, deletedAt ms], …]: only clips whose name is at most RECENT_DAYS old
// when deleted (an older clip is out of the Pi's list anyway, which keeps a
// policy that deletes old footage from filling it), entries KEEP_MS after
// their delete dropped, and at most MAX_ENTRIES (the newest kept).

const path = require('path');

const KEEP_MS = 8 * 24 * 3600 * 1000;
const RECENT_DAYS = 9; // the Pi's 7 days, and a day either side for time zones
const MAX_ENTRIES = 50_000; // ~3 MB of JSON at most
const CLIP = /^(\d{4})-(\d{2})-(\d{2})_\d{2}-\d{2}-\d{2}-[A-Za-z0-9_]+\.mp4$/;
const keyOf = (vid) => `deleted-clips:${vid}`;

function createDeletedClips({ db, now = () => Date.now(), keepMs = KEEP_MS, max = MAX_ENTRIES } = {}) {
  const usable = db && typeof db.get === 'function' && typeof db.set === 'function';
  const read = (vid) => {
    const raw = usable ? db.get(keyOf(vid), []) : [];
    return Array.isArray(raw) ? raw.filter((e) => Array.isArray(e) && typeof e[0] === 'string' && Number.isFinite(e[1])) : [];
  };
  const pruned = (list) => {
    const from = now() - keepMs;
    const kept = list.filter((e) => e[1] >= from);
    return kept.length > max ? kept.sort((a, b) => a[1] - b[1]).slice(-max) : kept;
  };
  return {
    /** Clip rels (relative to the car's folder) deleted for good just now. */
    add(vid, rels) {
      if (!usable || !vid) return 0;
      const at = now();
      const oldest = at - RECENT_DAYS * 86400_000;
      const fresh = [];
      for (const rel of rels || []) {
        const m = CLIP.exec(path.posix.basename(String(rel || '')));
        if (!m || Date.UTC(+m[1], +m[2] - 1, +m[3]) < oldest - 86400_000) continue;
        fresh.push([String(rel), at]);
      }
      const before = read(vid);
      const next = pruned([...before, ...fresh]);
      if (fresh.length || next.length !== before.length) db.set(keyOf(vid), next);
      return fresh.length;
    },
    /** The rels deleted for good in the last KEEP_MS. */
    list(vid) { return pruned(read(vid)).map((e) => e[0]); },
    forget(vid) { if (usable) db.set(keyOf(vid), []); }
  };
}

module.exports = { createDeletedClips, KEEP_MS, MAX_ENTRIES, RECENT_DAYS };
