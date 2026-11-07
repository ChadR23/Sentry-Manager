'use strict';

// Timeline previews made ahead of time: after each scan, the newest days of
// every vehicle's footage get their scrub previews (server/scrubFrames.js)
// in the background, newest clip first, one at a time, so the first drag
// across a new drive shows frames at once instead of waiting for them to be
// made. It waits while a conversion runs (`idle`), a clip someone opens
// still goes first, and clips that may still be copying are left for the
// next pass. SCRUB_PREPARE_DAYS sets how many days (0 turns it off).

const path = require('path');

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SETTLE_MS = 2 * 60_000; // a clip changed this recently may still be copying

function createScrubPrepare({ inventory, vehicles, scrubFrames, days = 2, max = 1500, idle = () => true, log, pauseMs = 50, now = Date.now }) {
  let running = null;
  let again = false;
  let stopped = false;
  const done = new Map(); // full path -> `${size}/${mtime}` already prepared this run

  /** The clips to prepare: the newest `days` days of each vehicle, newest first. */
  function todo() {
    const out = [];
    for (const v of vehicles.list()) {
      const root = vehicles.rootOf(v);
      const files = root && inventory.get(v.id)?.files;
      if (!files) continue;
      const clips = [];
      for (const f of files.values()) if (f.kind === 'clip' && f.size > 0 && f.day && DAY.test(f.day) && /\.mp4$/i.test(f.rel)) clips.push(f);
      const newest = [...new Set(clips.map((f) => f.day))].sort().reverse().slice(0, days);
      for (const f of clips) {
        if (!newest.includes(f.day) || now() - f.mtimeMs < SETTLE_MS) continue;
        const real = path.join(root, f.rel);
        if (done.get(real) === `${f.size}/${Math.round(f.mtimeMs)}`) continue;
        out.push({ real, key: `${f.size}/${Math.round(f.mtimeMs)}`, day: f.day, rel: f.rel });
      }
    }
    return out.sort((a, b) => (a.day === b.day ? b.rel.localeCompare(a.rel) : b.day.localeCompare(a.day))).slice(0, max);
  }

  async function pass() {
    const list = todo();
    let made = 0;
    for (const c of list) {
      if (stopped) break;
      while (!idle() && !stopped) await new Promise((r) => setTimeout(r, 5000));
      if (stopped) break;
      const started = Date.now();
      const grid = await scrubFrames.get(c.real, { urgent: false, next: false, touch: false });
      done.set(c.real, c.key);
      if (done.size > 50_000) done.delete(done.keys().next().value);
      // only a grid it had to make takes time; leave the disk a moment then
      if (grid && Date.now() - started > 20) {
        made += 1;
        if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
      }
    }
    return made;
  }

  /** Prepare what is new; again after this pass if more came meanwhile. */
  function kick() {
    if (days <= 0 || stopped) return Promise.resolve();
    if (running) { again = true; return running; }
    running = (async () => {
      do {
        again = false;
        try {
          const n = await pass();
          if (n) log?.info(`Timeline previews: ${n} clip(s) prepared ahead`);
        } catch (err) {
          log?.warn(`Timeline previews: ${err.message}`);
        }
      } while (again && !stopped);
    })().finally(() => { running = null; });
    return running;
  }

  return { kick, stop() { stopped = true; } };
}

module.exports = { createScrubPrepare };
