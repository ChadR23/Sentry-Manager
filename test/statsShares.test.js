'use strict';

// Server monitor, Storage: a vehicle's network share that is not mounted is
// only an empty folder on the server's own disk. Seen: BingBong offline,
// shown with the data disk's space and "answers in under 1 ms".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FilesystemsProvider } = require('../server/stats/filesystems');

const ROOT = '1 0 259:2 / / rw,relatime - ext4 /dev/nvme0n1p2 rw';
const SHARE = '40 1 0:52 / /footage/bingbong rw,nosuid - cifs //nas/teslacam rw,vers=3.1.1';

test('a network share that is not mounted shows as not connected, never with the disk under it', async () => {
  const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shares-'));
  fs.mkdirSync(path.join(procRoot, '7'));
  const mountinfo = (lines) => fs.writeFileSync(path.join(procRoot, '7', 'mountinfo'), `${lines.join('\n')}\n`);
  let t = 100000;
  const fsp = {
    stat: async () => ({}),
    // the root disk: 1.8 TB, 0.7 used
    statfs: async () => ({ bsize: 4096, blocks: 1.8e12 / 4096, bfree: 1.1e12 / 4096, bavail: 1.1e12 / 4096 })
  };
  const p = new FilesystemsProvider({
    procRoot, sysRoot: '/nonexistent', appPid: 7, fsp, now: () => t,
    readShares: () => [{ label: 'Data volume', path: '/data' }, { label: 'BingBong', path: '/footage/bingbong', vehicle: true, network: true }]
  });
  const settle = () => new Promise((r) => setImmediate(r));
  try {
    mountinfo([ROOT]);
    p.sample(t);
    await settle();
    let [data, car] = p.sample(t);
    assert.equal(data.reachable, true);
    assert.equal(data.totalB, 1.8e12);
    assert.equal(data.mounted, null, 'a local folder: nothing to mount');
    assert.deepEqual([car.mounted, car.reachable, car.totalB, car.latencyMs], [false, false, null, null]);

    // the share comes back: within one check
    mountinfo([ROOT, SHARE]);
    t += 10000;
    p.sample(t);
    await settle();
    [, car] = p.sample(t);
    assert.deepEqual([car.mounted, car.reachable, car.fsType, car.smbVersion], [true, true, 'cifs', '3.1.1']);

    // and goes away again: what was measured is not the share's any more
    mountinfo([ROOT]);
    t += 10000;
    [, car] = p.sample(t);
    assert.deepEqual([car.mounted, car.reachable, car.totalB, car.latencyMs], [false, false, null, null]);
  } finally {
    fs.rmSync(procRoot, { recursive: true, force: true });
  }
});
