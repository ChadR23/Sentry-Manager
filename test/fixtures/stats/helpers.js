'use strict';

// Shared pieces for the stats tests: a clock the test moves by hand, timers
// that can be counted, a fake nvidia-smi / ffmpeg, and a fake share.

const fs = require('fs');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { createStats } = require('../../../server/stats');
const { build } = require('./machines');

function fakeClock(start = new Date(2026, 9, 23, 10, 0, 0).getTime()) {
  const c = { t: start, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
}

/** Real timers, but every live one is known (an unref'd timer hides from the event loop). */
function trackedTimers() {
  const live = new Set();
  return {
    live,
    setTimeout(fn, ms) {
      const h = setTimeout(() => {
        live.delete(h);
        fn();
      }, ms);
      live.add(h);
      return h;
    },
    clearTimeout(h) {
      live.delete(h);
      clearTimeout(h);
    }
  };
}

/**
 * A spawn() that answers like nvidia-smi (lines from `lines`, printed once
 * per start) and ffmpeg -version; every child is recorded.
 */
function fakeSpawn({ lines = [], exitAfterLines = false, ffmpeg = 'ffmpeg version 7.1.1-Jellyfin Copyright (c) 2000-2025 the FFmpeg developers\n' } = {}) {
  const calls = [];
  const spawn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.killed = false;
    child.kill = (sig) => {
      child.killed = sig || 'SIGTERM';
      setImmediate(() => {
        child.emit('exit', null, child.killed);
        child.emit('close', null, child.killed);
      });
      return true;
    };
    calls.push({ cmd, args, child });
    setImmediate(() => {
      if (cmd === 'nvidia-smi') {
        for (const l of lines) child.stdout.write(`${l}\n`);
        if (exitAfterLines) {
          child.emit('exit', 9, null);
          child.emit('close', 9, null);
        }
      } else if (/ffmpeg/.test(cmd)) {
        child.stdout.end(ffmpeg);
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      } else {
        const err = Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' });
        child.emit('error', err);
      }
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

/** A share that answers stat/statfs, after `delayMs` on the test clock, or never (hung). */
function fakeFs(clock, shares = {}) {
  return {
    readFile: fs.promises.readFile,
    async stat(p) {
      const s = shares[p];
      if (!s) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      if (s.hung) return new Promise(() => {});
      if (s.error) throw Object.assign(new Error(s.error), { code: s.error });
      clock.advance(s.delayMs || 0);
      return { isDirectory: () => true };
    },
    async statfs(p) {
      const s = shares[p];
      return { bsize: 4096, blocks: s.blocks, bfree: s.bfree, bavail: s.bavail ?? s.bfree };
    }
  };
}

/** A machine, a clock and a stats engine on them. */
function setup(machine, opts = {}) {
  const m = build(machine(0));
  const clock = opts.clock || fakeClock();
  const stats = createStats({
    procRoot: m.proc, sysRoot: m.sys, devRoot: m.dev, appPid: opts.appPid ?? 100, now: clock.now,
    spawn: opts.spawn || fakeSpawn(), ...(opts.probeFfmpeg ? {} : { ffmpegVersion: opts.ffmpegVersion === undefined ? '7.1.1-Jellyfin' : opts.ffmpegVersion }),
    version: 'test', dataDir: opts.dataDir ?? null, timers: opts.timers, pciIdsFiles: opts.pciIdsFiles || ['/nonexistent/pci.ids'],
    ...opts.options
  });
  /** Sample phases from..to, 2 s apart, letting the background reads land after each. */
  const run = async (to, from = 0) => {
    for (let p = from; p <= to; p++) {
      if (p) {
        m.update(machine(p));
        clock.advance(2000);
      }
      stats.sampleNow();
      await stats.settle();
    }
    return stats.snapshot();
  };
  const done = () => {
    stats.stop();
    m.cleanup();
  };
  return { m, clock, stats, run, done };
}

module.exports = { fakeClock, trackedTimers, fakeSpawn, fakeFs, setup };
