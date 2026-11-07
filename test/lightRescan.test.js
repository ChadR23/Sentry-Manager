'use strict';

// The background rescan is light: a folder whose modified time is unchanged
// keeps what the last scan knew of its files (no stat per file), except files
// changed in the last two hours; a folder that changed is looked at in full.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { scanFootage } = require('../server/scanner');

const old = new Date(Date.now() - 24 * 3600 * 1000);
async function clip(file, bytes = 10, when = old) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, Buffer.alloc(bytes, 1));
  await fsp.utimes(file, when, when);
}

test('a light rescan reuses unchanged folders and still sees every change', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-rescan-'));
  const real = fsp.stat;
  const statted = [];
  fsp.stat = (p, ...rest) => { statted.push(String(p)); return real(p, ...rest); };
  try {
    const rc = path.join(root, 'TeslaCam/RecentClips');
    const ev = path.join(root, 'TeslaCam/SentryClips/2026-11-01_10-00-00');
    await clip(path.join(rc, '2026-11-01_09-00-00-front.mp4'));
    await clip(path.join(rc, '2026-11-01_09-01-00-front.mp4'));
    await clip(path.join(ev, '2026-11-01_09-59-00-front.mp4'));
    await fsp.utimes(ev, old, old);
    await fsp.utimes(rc, old, old);
    const first = await scanFootage(root);
    assert.equal(first.files.size, 3);

    // nothing changed: no file is looked at again, only the folders
    statted.length = 0;
    const quiet = await scanFootage(root, { previous: first });
    assert.equal(quiet.files.size, 3);
    assert.equal(quiet.reused, 3);
    assert.equal(statted.filter((p) => p.endsWith('.mp4')).length, 0, 'no clip stat');

    // a clip added to RecentClips and one replaced (the converter's swap): that folder in full
    await clip(path.join(rc, '2026-11-01_09-02-00-front.mp4'));
    const swapped = path.join(rc, '2026-11-01_09-00-00-front.mp4');
    await fsp.writeFile(`${swapped}.tmp`, Buffer.alloc(4, 2));
    await fsp.utimes(`${swapped}.tmp`, old, old);
    await fsp.rename(`${swapped}.tmp`, swapped);
    statted.length = 0;
    const changed = await scanFootage(root, { previous: quiet });
    assert.equal(changed.files.size, 4);
    assert.equal(changed.files.get('TeslaCam/RecentClips/2026-11-01_09-00-00-front.mp4').size, 4, 'the replaced clip is seen');
    assert.ok(changed.files.has('TeslaCam/RecentClips/2026-11-01_09-02-00-front.mp4'), 'the new clip is seen');
    assert.equal(statted.filter((p) => p.includes('SentryClips') && p.endsWith('.mp4')).length, 0, 'the unchanged event folder is reused');

    // a file being copied in (recent) is always looked at again, folder unchanged or not
    const copying = path.join(ev, '2026-11-01_10-00-00-front.mp4');
    await clip(copying, 5, new Date());
    await fsp.utimes(ev, old, old);
    const a = await scanFootage(root, { previous: changed });
    await fsp.appendFile(copying, Buffer.alloc(5, 1));
    await fsp.utimes(ev, old, old);
    const b = await scanFootage(root, { previous: a });
    assert.equal(b.files.get('TeslaCam/SentryClips/2026-11-01_10-00-00/2026-11-01_10-00-00-front.mp4').size, 10, 'its new size');

    // a removed clip is gone
    await fsp.unlink(path.join(rc, '2026-11-01_09-01-00-front.mp4'));
    const removed = await scanFootage(root, { previous: b });
    assert.equal(removed.files.has('TeslaCam/RecentClips/2026-11-01_09-01-00-front.mp4'), false);
  } finally {
    fsp.stat = real;
    await fsp.rm(root, { recursive: true, force: true });
  }
});
