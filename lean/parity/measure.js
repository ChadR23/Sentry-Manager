'use strict';

// Memory and scan time of the Node and lean servers on the same synthetic
// archive (about N sparse clip files over many days), one server at a time:
//
//   node lean/parity/measure.js [N]       (default 4000)
//
// For each: the time until the footage list is ready (scan, clip codecs and
// speed index done), then the resident memory once idle (VmRSS of the server
// and any processes it started) and its peak (VmHWM).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { start, settled, LEAN } = require('./compare');

const N = Number(process.argv[2] || 4000);

function tree(pid) {
  const out = [pid];
  for (const p of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const ppid = Number(fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1].split(' ')[1]);
      if (ppid === pid) out.push(...tree(Number(p)));
    } catch { /* gone */ }
  }
  return out;
}

function kb(pid, field) {
  try {
    return Number((fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(new RegExp(`${field}:\\s+(\\d+)`)) || [])[1] || 0);
  } catch {
    return 0;
  }
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-measure-'));
  const footage = path.join(work, 'footage');
  spawnSync(process.execPath, [path.join(__dirname, 'makeArchive.js'), footage, '--many', String(N)], { stdio: 'inherit' });
  const files = spawnSync('find', [footage, '-type', 'f']).stdout.toString().trim().split('\n').length;
  const rows = [];
  for (const kind of ['node', 'lean']) {
    const t0 = Date.now();
    const s = await start(kind, work, footage);
    await settled(s);
    const ready = Date.now() - t0;
    await new Promise((r) => setTimeout(r, 5000));
    const pids = tree(s.child.pid);
    const rss = pids.reduce((n, p) => n + kb(p, 'VmRSS'), 0);
    const hwm = pids.reduce((n, p) => n + kb(p, 'VmHWM'), 0);
    const days = (await s.json('/api/vehicles/daily-driver/days?limit=100')).body;
    rows.push({ kind, processes: pids.length, readyMs: ready, idleRssMB: +(rss / 1024).toFixed(1), peakRssMB: +(hwm / 1024).toFixed(1), recordings: days.recordings });
    await s.stop();
  }
  console.log(JSON.stringify({ files, leanBinaryBytes: fs.statSync(LEAN).size, rows }, null, 1));
  fs.rmSync(work, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
