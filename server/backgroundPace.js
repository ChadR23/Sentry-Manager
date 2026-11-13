'use strict';

// How many clips background reading (the speed index) may read at once.
//
// It starts at one and adds one at a time while the server keeps up; it
// halves when the app starts to stall (the event loop runs late) or reads get
// much slower than they were, and it stops for a moment on a long stall. A
// step up that does not read more clips a minute than before is taken back.
// While someone plays footage in the Viewer it reads one clip at a time, until
// a while after they stop. A conversion or the benchmark pauses it outright
// (`busy`), as before.
//
// tick() runs once a second (start() sets the timer; tests call it themselves).

const { monitorEventLoopDelay } = require('perf_hooks');

const LAG_P99_MS = 100; // the loop this late, in 1 of 100 turns, for two seconds running: back off
const STALL_MS = 1000; // one turn this late: stop for a moment
const STALL_PAUSE_MS = 5000;
const CALM_MS = 10_000; // calm this long (and every slot in use) before one more
const HOLD_MS = 15_000; // no step up for this long after backing off
const TRIAL_MS = 20_000; // a step up is judged after this long
const RATE_MS = 10_000; // clips a minute, over the last this long (before the step and at its end)
const VIEWER_MS = 30_000; // one at a time until this long after the Viewer stops playing

function createBackgroundPace({ max = 4, busy = () => false, now = Date.now, lag = null } = {}) {
  const loop = lag || monitorEventLoopDelay({ resolution: 20 });
  if (!lag) loop.enable();
  let limit = 1;
  let strikes = 0;
  let calmSince = now();
  let holdUntil = 0;
  let pausedUntil = 0;
  let viewers = 0;
  let viewerUntil = 0;
  let active = 0; // the most clips in reading since the last tick
  let pending = false;
  // ms a clip takes: recent, and the best recent (rises slowly so it can recover)
  let recent = null;
  let best = null;
  // completions, for clips a minute
  const finished = [];
  // a step up on trial: { from, rate, until }
  let trial = null;
  let timer = null;

  const rate = (t, span) => finished.filter((x) => x > t - span).length / (span / 60_000);

  function tick(t = now()) {
    const busiest = active;
    active = 0;
    const p99 = loop.percentile(99) / 1e6;
    const worst = loop.max / 1e6;
    loop.reset();
    while (finished.length && finished[0] < t - 120_000) finished.shift();
    if (best !== null) best *= 1.002;
    if (worst > STALL_MS) {
      limit = 1;
      pausedUntil = t + STALL_PAUSE_MS;
      holdUntil = t + HOLD_MS;
      calmSince = t;
      strikes = 0;
      trial = null;
      return;
    }
    const slow = recent !== null && best !== null && recent > best * 2;
    if (p99 > LAG_P99_MS || slow) {
      calmSince = t;
      if (++strikes >= 2) {
        limit = Math.max(1, Math.floor(limit / 2));
        holdUntil = t + HOLD_MS;
        strikes = 0;
        trial = null;
      }
      return;
    }
    strikes = 0;
    if (trial && t >= trial.until) {
      // more slots that read no more clips than before: back to what it was
      if (rate(t, RATE_MS) < trial.rate * 1.1) {
        limit = trial.from;
        holdUntil = t + 4 * HOLD_MS;
      }
      trial = null;
      calmSince = t;
      return;
    }
    if (!trial && limit < max && pending && busiest >= limit && t >= holdUntil && t - calmSince >= CALM_MS) {
      trial = { from: limit, rate: rate(t, RATE_MS), until: t + TRIAL_MS };
      limit += 1;
      calmSince = t;
    }
  }

  return {
    tick,
    /** How many clips may be in reading now: 0 while paused. */
    allowed(t = now()) {
      if (busy() || t < pausedUntil) return 0;
      if (viewers > 0 || t < viewerUntil) return 1;
      return limit;
    },
    /** The reader's state: clips in reading, and whether more wait. */
    demand(inReading, more) {
      active = Math.max(active, inReading);
      pending = more;
    },
    /** A clip read, in ms. */
    done(ms, t = now()) {
      finished.push(t);
      recent = recent === null ? ms : recent * 0.8 + ms * 0.2;
      if (best === null || recent < best) best = recent;
    },
    /** Footage is playing in the Viewer until res closes. */
    viewer(res) {
      if (res.destroyed || res.writableEnded || res.closed) {
        viewerUntil = now() + VIEWER_MS;
        return;
      }
      viewers += 1;
      let open = true;
      const end = () => {
        if (!open) return;
        open = false;
        viewers -= 1;
        viewerUntil = now() + VIEWER_MS;
      };
      res.once('close', end);
      res.once('finish', end);
    },
    /** Under strain right now (backing off or stopped): other background work waits too. */
    strained(t = now()) {
      return t < pausedUntil || strikes > 0 || t < holdUntil;
    },
    status: () => ({ limit, viewers, paused: now() < pausedUntil }),
    start() {
      if (!timer) {
        timer = setInterval(() => tick(), 1000);
        timer.unref?.();
      }
    },
    stop() {
      clearInterval(timer);
      timer = null;
      if (!lag) loop.disable();
    },
  };
}

/** The old pace: one clip at a time, none while busy. */
function fixedPace(busy = () => false) {
  return { tick() {}, allowed: () => (busy() ? 0 : 1), demand() {}, done() {}, viewer() {}, strained: () => false, status: () => ({ limit: 1, viewers: 0, paused: false }), start() {}, stop() {} };
}

module.exports = { createBackgroundPace, fixedPace };
