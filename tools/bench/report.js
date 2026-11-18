#!/usr/bin/env node
'use strict';

// Run folders -> one markdown table, one column per run.
//
//   node tools/bench/report.js bench-runs/baseline-* bench-runs/constrained-2g-* [--out report.md] [--with-first]
//
// Each folder is what run.sh writes: meta.json (run name, image digest,
// cache state, limits), samples.csv (sample.js), latency.csv and index.json
// (latency.js), final.json (the container's last state). Missing files leave
// their rows as "–". --with-first adds each route's first call (rep 0).

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

function readRun(dir, { withFirst = false } = {}) {
  const read = (name) => { try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch { return null; } };
  const json = (name) => { const t = read(name); try { return t ? JSON.parse(t) : null; } catch { return null; } };
  const meta = json('meta.json') || { name: path.basename(dir) };
  const final = json('final.json');
  if (final?.state) meta.final = final.state;
  const samples = lib.parseCsv(read('samples.csv') || '');
  const latency = lib.parseCsv(read('latency.csv') || '').filter((r) => withFirst || r.rep !== '0');
  return lib.summarizeRun({ meta, samples, latency, index: json('index.json') });
}

function main() {
  const argv = process.argv.slice(2);
  let out = null;
  let withFirst = false;
  const dirs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--with-first') withFirst = true;
    else dirs.push(argv[i]);
  }
  if (!dirs.length) {
    console.error('usage: node tools/bench/report.js <run dir>... [--out report.md] [--with-first]');
    process.exit(2);
  }
  const runs = dirs.map((d) => readRun(d, { withFirst }));
  const notes = [
    '',
    'Container memory is `docker stats` (cgroup memory without inactive page cache); the cgroup peak includes page cache.',
    'Idle = the samples taken in the idle phase after the first index. Disk read counts from the container start.',
    ...runs.filter((r) => r.name === 'diagnostic').map(() => 'The diagnostic run carries the memlog preload: do not compare its numbers with the others.')
  ].join('\n');
  const text = `${lib.markdownReport(runs)}\n${notes}\n`;
  if (out) fs.writeFileSync(out, text);
  process.stdout.write(text);
}

if (require.main === module) main();

module.exports = { readRun };
