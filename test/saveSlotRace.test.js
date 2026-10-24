'use strict';

// The save slot checks the copy by device, inode, size and modification time
// instead of reading it again, because prepare read it back in full. That is
// only sound if the time it records is the time the read-back proved: a copy
// written to in place while it was being read back (a region already read,
// same size) must not pass as the verified conversion, and the original must
// never be removed for it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { open, makeBase, available, clipName } = require('./fixtures/crashPoints');

const skip = available() ? false : 'needs ffmpeg and build/noreplace-rename';

test('a copy changed in place during its read-back is not accepted by the quick check; the original stays', { skip, timeout: 240_000 }, async () => {
  const { base, folder } = await makeBase(1);
  const original = fs.readFileSync(path.join(folder, clipName(0)));
  let tampered = false;
  const originalOpen = fsp.open;
  fsp.open = async function patchedOpen(file, flags, ...rest) {
    const handle = await originalOpen.call(this, file, flags, ...rest);
    if (!tampered && flags === 'r' && /^TEMP-/.test(path.basename(String(file))) && path.dirname(String(file)) === folder) {
      const read = handle.read.bind(handle);
      let reads = 0;
      handle.read = async (...args) => {
        const result = await read(...args);
        reads += 1;
        if (reads === 1 && !tampered) {
          // someone writes over bytes this read-back has already passed
          tampered = true;
          const fd = fs.openSync(String(file), 'r+');
          const byte = Buffer.alloc(1);
          fs.readSync(fd, byte, 0, 1, 64);
          byte[0] ^= 0xff;
          fs.writeSync(fd, byte, 0, 1, 64);
          fs.closeSync(fd);
          const later = new Date(Date.now() + 2000);
          fs.utimesSync(String(file), later, later);
        }
        return result;
      };
    }
    return handle;
  };
  let env;
  try {
    env = await open(base, { networkMode: 'staging' });
    await env.runtime.start();
    const id = await env.runtime.service.start(env.config);
    const job = await env.runtime.service.whenIdle(id);
    assert.ok(tampered, 'the read-back was intercepted');
    const files = fs.readdirSync(folder).filter((name) => !name.startsWith('.'));
    const clip = path.join(folder, clipName(0));
    const item = job.items[0];
    assert.notEqual(item.resultCode, 'converted', `the tampered copy replaced the original (files: ${files.join(', ')})`);
    assert.ok(fs.existsSync(clip), 'the clip is still there');
    assert.equal(Buffer.compare(fs.readFileSync(clip), original), 0, 'the original is untouched');
  } finally {
    fsp.open = originalOpen;
    await env?.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an original written to as it is moved aside is not removed by the quick check', { skip, timeout: 240_000 }, async () => {
  const { base, folder } = await makeBase(1);
  let env;
  let edited = null;
  try {
    env = await open(base, { networkMode: 'staging' });
    const realPromote = env.renameExclusive.promote;
    env.renameExclusive.promote = async (request) => {
      const out = await realPromote(request);
      if (!edited && /^BACKUP-/.test(path.basename(request.to))) {
        // the adapter has just hashed and moved it; someone writes to it now
        const fd = fs.openSync(request.to, 'r+');
        const byte = Buffer.alloc(1);
        fs.readSync(fd, byte, 0, 1, 64);
        byte[0] ^= 0xff;
        fs.writeSync(fd, byte, 0, 1, 64);
        fs.closeSync(fd);
        const later = new Date(Date.now() + 2000);
        fs.utimesSync(request.to, later, later);
        edited = fs.readFileSync(request.to);
      }
      return out;
    };
    await env.runtime.start();
    const id = await env.runtime.service.start(env.config);
    const job = await env.runtime.service.whenIdle(id);
    assert.ok(edited, 'the backup was written to');
    const files = fs.readdirSync(folder).filter((name) => !name.startsWith('.'));
    assert.notEqual(job.items[0].resultCode, 'converted', `the edited original was removed (files: ${files.join(', ')})`);
    // it no longer matches what was converted, so it is not even put back by
    // itself: it stays, as it now is, for the owner to look at
    const kept = files.map((name) => fs.readFileSync(path.join(folder, name))).some((bytes) => Buffer.compare(bytes, edited) === 0);
    assert.ok(kept, `the edited original is kept (files: ${files.join(', ')})`);
  } finally {
    await env?.runtime.shutdown().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});
