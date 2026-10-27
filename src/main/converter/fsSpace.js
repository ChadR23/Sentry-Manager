'use strict';

// Disk space from statfs, in bytes.
//
// statfs counts blocks in "fragment" units (f_frsize), but Node's statfs
// only reports f_bsize, the optimal transfer size. On ordinary Linux disks
// the two are the same (4 KiB). On Docker Desktop for Mac a bind-mounted
// folder (virtiofs) reports f_bsize = 1 MiB with blocks of 4 KiB, so
// blocks * bsize came out 256 times too large (a 450 GB disk showed as
// 115 TB, and free-space checks believed there was room there was not).
// On Linux the fragment size comes from `stat -f`, once per path.

const { execFile } = require('child_process');

const units = new Map(); // path -> Promise<number|null>
const RETRY_MS = 60_000;

function fragmentSize(target, { platform = process.platform, run = execFile } = {}) {
  if (platform !== 'linux') return Promise.resolve(null);
  const key = String(target);
  if (!units.has(key)) {
    const p = new Promise((resolve) => {
      try {
        run('stat', ['-f', '-c', '%S', '--', key], { timeout: 3000, windowsHide: true }, (err, stdout) => {
          const n = Number(String(stdout || '').trim());
          resolve(!err && Number.isSafeInteger(n) && n > 0 ? n : null);
        });
      } catch {
        resolve(null);
      }
    });
    units.set(key, p);
    // a failed lookup is tried again later; a good one is kept
    p.then((n) => {
      if (n === null) setTimeout(() => { if (units.get(key) === p) units.delete(key); }, RETRY_MS).unref?.();
    });
    if (units.size > 256) units.delete(units.keys().next().value);
  }
  return units.get(key);
}

/**
 * { total, free, used, type } in bytes (BigInt with `bigint: true`) for the
 * file system holding `target`. `fsp` is fs/promises (or a stand-in).
 */
async function diskSpace(fsp, target, { bigint = false, platform, run } = {}) {
  const [sfs, frag] = await Promise.all([
    fsp.statfs(target, bigint ? { bigint: true } : undefined),
    fragmentSize(target, { platform, run })
  ]);
  if (bigint) {
    const unit = frag ? BigInt(frag) : BigInt(sfs.bsize);
    return { total: BigInt(sfs.blocks) * unit, free: BigInt(sfs.bavail) * unit, used: (BigInt(sfs.blocks) - BigInt(sfs.bfree)) * unit, type: sfs.type, unit };
  }
  const unit = frag || Number(sfs.bsize);
  const blocks = Number(sfs.blocks);
  return { total: blocks * unit, free: Number(sfs.bavail) * unit, used: Math.max(0, blocks - Number(sfs.bfree)) * unit, type: sfs.type, unit };
}

module.exports = { diskSpace, fragmentSize, _units: units };
