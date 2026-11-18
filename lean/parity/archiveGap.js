'use strict';

// Archive gaps, Node against Rust (lean/tests/archive_gap_parity.rs runs this):
//
//   node lean/parity/archiveGap.js <out.json>
//
// Runs Node's own tests of the archive gap check (test/archiveGap, carFiles,
// deletedClips, sentryUsb and snapshotGaps) with server/archiveGap.js's
// analyze() watched: every call's input (the scan's files, the speeds, CAN
// Bridge's minutes, Sentry USB's transfer, snapshots and list of what the car
// wrote, the Recycle Bin, the deleted clips) and Node's answer are written to
// <out.json>, for the Rust analyze() to be given the same and to answer the
// same. The tests' own results are not this script's business (npm test).

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const out = process.argv[2];
if (!out) {
  console.error('usage: node lean/parity/archiveGap.js <out.json>');
  process.exit(2);
}

const gap = require(path.join(REPO, 'server', 'archiveGap'));
const real = gap.analyze;
const calls = [];

const list = (x) => (x == null ? x : Array.isArray(x) ? x : x instanceof Set || x instanceof Map ? [...x.values()] : Object.values(x));
function inputOf(o) {
  const cf = o.carFiles;
  return {
    files: list(o.files).map((f) => ({ rel: f.rel, size: f.size ?? 0, mtimeMs: f.mtimeMs ?? 0, ctimeMs: f.ctimeMs ?? 0, birthtimeMs: f.birthtimeMs ?? 0, kind: f.kind ?? null, type: f.type ?? null, camera: f.camera ?? null, day: f.day ?? null })),
    nowMs: o.nowMs,
    tz: o.tz ?? 'UTC',
    encoded: [...(o.encoded || [])],
    speeds: o.speeds ? [...o.speeds.entries()] : [],
    canDriving: o.canDriving === undefined ? null : o.canDriving && [...o.canDriving],
    canSentry: [...(o.canSentry || [])],
    canMinutes: o.canMinutes == null ? null : [...o.canMinutes],
    receivedMs: o.receivedMs ?? null,
    lastRecentS: o.lastRecentS ?? null,
    windowDays: o.windowDays ?? null,
    sentryUsb: o.sentryUsb ?? null,
    snapshots: o.snapshots ?? null,
    clock24: Boolean(o.clock24),
    carFiles: cf == null ? null : {
      error: cf.error ?? null, fileUnix: cf.fileUnix ?? null, archivedUnix: cf.archivedUnix ?? null,
      list: cf.list == null ? null : { firstSeenUnix: cf.list.firstSeenUnix ?? null, lastSeenUnix: cf.list.lastSeenUnix ?? null, clips: list(cf.list.clips) }
    },
    binned: o.binned == null ? null : [...o.binned],
    deleted: o.deleted == null ? null : [...o.deleted]
  };
}

gap.analyze = function analyze(o) {
  const res = real(o);
  try {
    calls.push({ input: inputOf(o || {}), output: JSON.parse(JSON.stringify({ days: res.days, stalled: res.stalled, signals: res.signals, carFiles: res.carFiles ?? null, newestRecent: res.newestRecent ?? null })) });
  } catch (err) {
    calls.push({ error: err.message });
  }
  return res;
};

process.on('exit', () => fs.writeFileSync(out, JSON.stringify(calls)));
for (const t of ['archiveGap', 'carFiles', 'deletedClips', 'sentryUsb', 'snapshotGaps']) require(path.join(REPO, 'test', `${t}.test.js`));
