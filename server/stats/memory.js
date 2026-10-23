'use strict';

// Memory of the whole server from /proc/meminfo; this app's share is the
// resident size of the app and its children (from the process table).

const { readText, parseKeyValues, join } = require('./util');

function readMemory(procRoot) {
  const m = parseKeyValues(readText(join(procRoot, 'meminfo')));
  const kb = (k) => (Number.isFinite(m[k]) ? m[k] * 1024 : null);
  const totalB = kb('MemTotal');
  if (!totalB) return { totalB: null, usedB: null, availableB: null, cacheB: null, swapTotalB: kb('SwapTotal'), swapUsedB: null };
  // MemAvailable is missing on kernels before 3.14
  let availableB = kb('MemAvailable');
  if (availableB === null) availableB = (kb('MemFree') || 0) + (kb('Buffers') || 0) + (kb('Cached') || 0);
  availableB = Math.min(totalB, Math.max(0, availableB));
  // "buff/cache" as free(1) counts it
  const cacheB = (kb('Buffers') || 0) + (kb('Cached') || 0) + (kb('SReclaimable') || 0);
  const swapTotalB = kb('SwapTotal');
  const swapFree = kb('SwapFree');
  return {
    totalB, usedB: totalB - availableB, availableB, cacheB,
    swapTotalB, swapUsedB: swapTotalB !== null && swapFree !== null ? Math.max(0, swapTotalB - swapFree) : null
  };
}

class MemoryProvider {
  constructor({ procRoot }) {
    this.procRoot = procRoot;
  }

  probe() {
    // nothing to find out: /proc/meminfo is there or it is not
  }

  /** The whole server's memory, and the resident size of the app and its children. */
  sample(procs) {
    const m = readMemory(this.procRoot);
    let appB = null;
    for (const pid of procs?.app || []) {
      const b = procs.byPid.get(pid)?.memB;
      if (Number.isFinite(b)) appB = (appB || 0) + b;
    }
    return { ...m, appB };
  }
}

module.exports = { MemoryProvider, readMemory };
