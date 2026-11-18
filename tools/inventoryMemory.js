'use strict';

// How much memory the footage inventory takes per file: builds a made-up
// archive of Tesla-named clips (every camera, Recent drives and Sentry /
// Saved events) the way a scan does, in memory only (nothing is read or
// written on disk), and prints the heap it holds per file.
//
// usage: node --expose-gc tools/inventoryMemory.js [files...]   (default 22000 100000)
//        add --legacy to measure the old plain-object entries

const { classify, localDay } = require('../server/footage');
const { buildRecordings } = require('../server/inventory');
const scanner = require('../server/scanner');

const CAMERAS = ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar'];
const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`;
};

// the entry a scan made before entries were compacted (scanner.js)
function legacyEntry(rel, st, info) {
  return { rel, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, birthtimeMs: st.birthtimeMs, ...info, day: info.day || localDay(st.mtimeMs) };
}

/** The (dir, name) pairs of an archive of about `count` files, as readdir gives them. */
function* archive(count) {
  let t = Date.UTC(2025, 0, 1, 8, 0, 0);
  let made = 0;
  let n = 0;
  while (made < count) {
    n++;
    // every third stretch is a Sentry event, every seventh a Saved one, else a drive
    const kind = n % 7 === 0 ? 'SavedClips' : n % 3 === 0 ? 'SentryClips' : 'RecentClips';
    const minutes = kind === 'RecentClips' ? 30 : 10;
    const event = stamp(t + minutes * 60_000);
    const dir = kind === 'RecentClips' ? 'TeslaCam/RecentClips' : `TeslaCam/${kind}/${event}`;
    for (let m = 0; m < minutes && made < count; m++) {
      for (const cam of CAMERAS) {
        if (made >= count) break;
        yield [dir, `${stamp(t + m * 60_000)}-${cam}.mp4`];
        made++;
      }
    }
    if (kind !== 'RecentClips') {
      for (const name of ['event.json', 'thumb.png', 'event.mp4']) {
        if (made >= count) break;
        yield [dir, name];
        made++;
      }
    }
    t += (minutes + 47) * 60_000;
  }
}

function build(count, make) {
  const files = new Map();
  const intern = scanner.interner();
  let i = 0;
  for (const [dir, name] of archive(count)) {
    // fresh strings each time, like readdir's
    const rel = `${dir}/${name.slice(0)}`;
    const info = classify(rel);
    if (!info) continue;
    const ms = 1762000000000 + (i++) * 60_013.37;
    const st = { size: 30_000_000 + (i * 7919) % 50_000_000, mtimeMs: ms + 0.123, ctimeMs: ms + 1000.456, birthtimeMs: ms + 999.789 };
    files.set(rel, make(rel, st, info, intern));
  }
  return files;
}

const heap = () => {
  global.gc();
  global.gc();
  return process.memoryUsage().heapUsed;
};

function measure(count, make, legacy) {
  const keep = {};
  const h0 = heap();
  keep.files = build(count, make);
  const h1 = heap();
  keep.recordings = buildRecordings(keep.files, { vehicleId: 'v1' });
  const h2 = heap();
  keep.codecs = new Map();
  if (legacy) {
    // as a restart loaded it: one settings value parsed, its own copy of every path
    const saved = {};
    for (const f of keep.files.values()) if (f.kind === 'clip') saved[f.rel] = [f.size, f.mtimeMs, 'h264'];
    for (const [rel, v] of Object.entries(JSON.parse(JSON.stringify(saved)))) keep.codecs.set(rel, { size: v[0], mtimeMs: v[1], codec: v[2] });
  } else {
    // inventory.js: the scan's own entry holds the codec
    for (const f of keep.files.values()) if (f.kind === 'clip') { f.codec = 'h264'; keep.codecs.set(f.rel, f); }
  }
  const h3 = heap();
  const n = keep.files.size;
  const per = (a, b) => ((b - a) / n).toFixed(0);
  console.log(`${n} files: files map ${per(h0, h1)} B/file, recordings ${per(h1, h2)} B/file (${keep.recordings.length} recordings), codec map ${per(h2, h3)} B/file; total ${((h3 - h0) / 1048576).toFixed(1)} MB (${per(h0, h3)} B/file)`);
  return keep;
}

if (require.main === module) {
  if (typeof global.gc !== 'function') {
    console.error('run with: node --expose-gc tools/inventoryMemory.js');
    process.exit(1);
  }
  const legacy = process.argv.includes('--legacy');
  const counts = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
  const make = legacy ? legacyEntry : scanner.fileEntry;
  console.log(legacy ? 'plain-object entries, codec map from one settings value (before):' : 'compact entries, codecs on the entries (now):');
  for (const count of counts.length ? counts : [22000, 100000]) measure(count, make, legacy);
}

module.exports = { archive, build };
