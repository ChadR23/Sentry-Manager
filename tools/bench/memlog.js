'use strict';

// The diagnostic run's preload: logs process.memoryUsage() of the Node
// process it is loaded into every 5 s, one JSON line each. Only for the
// "diagnostic" run (run.sh), never for the runs whose numbers are compared:
// the preload and the heap snapshots cost memory and time themselves.
//
// run.sh mounts this file read-only at /bench/memlog.js and sets
//   NODE_OPTIONS=--require=/bench/memlog.js --heapsnapshot-signal=SIGUSR2 --diagnostic-dir=/data/bench-diag
// NODE_OPTIONS reaches both Node processes in the image (the root
// supervisor and server/index.js, which the supervisor starts with the same
// environment), so each line names its process (role).
//
// Where the lines go: MEMLOG_FILE if set (one file per process:
// <MEMLOG_FILE>.<role>.<pid>.jsonl), else stderr, which `docker logs` keeps.
// MEMLOG_INTERVAL_MS changes the 5 s.
//
// Heap snapshots: `tools/bench/run.sh heapsnapshot --container <name>` sends
// SIGUSR2 to server/index.js; Node writes Heap.<date>.<pid>...heapsnapshot
// into --diagnostic-dir (it needs to exist and be writable by the app's
// user: this file creates it). A snapshot of a big heap takes seconds and
// about the heap's size again in memory.

const fs = require('fs');
const path = require('path');

const script = process.argv[1] || '';
const role = /server[\\/]index\.js$/.test(script) ? 'server'
  : /server[\\/]supervisor\.js$/.test(script) ? 'supervisor'
    : path.basename(script || 'node').replace(/\.js$/, '') || 'node';

const interval = Math.max(250, Number(process.env.MEMLOG_INTERVAL_MS) || 5000);

// --diagnostic-dir must exist for a heap snapshot to be written
const diagDir = (() => {
  const opts = `${process.env.NODE_OPTIONS || ''} ${process.execArgv.join(' ')}`;
  const m = opts.match(/--diagnostic-dir[= ](\S+)/);
  return m ? m[1] : null;
})();
if (diagDir) {
  try {
    fs.mkdirSync(diagDir, { recursive: true, mode: 0o777 });
    fs.chmodSync(diagDir, 0o1777); // the root supervisor may create it before the app's user writes to it
  } catch { /* not ours to change: the app writes there anyway, or says why */ }
}

let out = null;
if (process.env.MEMLOG_FILE) {
  try {
    out = fs.openSync(`${process.env.MEMLOG_FILE}.${role}.${process.pid}.jsonl`, 'a');
  } catch (err) {
    process.stderr.write(`[memlog] ${role}: cannot write ${process.env.MEMLOG_FILE}: ${err.message}; logging to stderr\n`);
  }
}

const started = Date.now();
let peak = { rss: 0, heapUsed: 0, arrayBuffers: 0, external: 0 };

function line() {
  const m = process.memoryUsage();
  for (const k of Object.keys(peak)) if (m[k] > peak[k]) peak[k] = m[k];
  const rec = {
    memlog: 1, t: new Date().toISOString(), up_s: Math.round((Date.now() - started) / 1000),
    role, pid: process.pid,
    rss: m.rss, heapTotal: m.heapTotal, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers,
    peak
  };
  const text = `${JSON.stringify(rec)}\n`;
  if (out !== null) {
    try { fs.writeSync(out, text); return; } catch { out = null; }
  }
  process.stderr.write(`[memlog] ${text}`);
}

line();
setInterval(line, interval).unref();
process.on('exit', line);
