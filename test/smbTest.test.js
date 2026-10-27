'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createSmbTester, TEST_ID } = require('../server/smbTest');

const quiet = { info() {}, warn() {}, error() {} };

// a mounter that "mounts" a local folder: what mount.cifs would show
function fakeMounter(root, { result = { code: 0 }, files = {} } = {}) {
  const calls = [];
  return {
    calls,
    target: (id) => path.join(root, id),
    async mount(id, smb) {
      calls.push(['mount', id, smb]);
      if (result.code !== 0) return result;
      const dir = path.join(root, id);
      await fsp.mkdir(dir, { recursive: true });
      for (const [rel, data] of Object.entries(files)) {
        await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
        await fsp.writeFile(path.join(dir, rel), data);
      }
      return result;
    },
    async unmount(id, opts) { calls.push(['unmount', id, opts]); },
    async forget(id) { calls.push(['forget', id]); await fsp.rm(path.join(root, id), { recursive: true, force: true }); }
  };
}
const vehiclesWith = (list = []) => ({ get: (id) => list.find((v) => v.id === id) || null });
const SMB = { type: 'smb', share: '//192.168.1.50/TeslaCam', username: 'tesla', password: 'right', version: '3.1.1', encrypt: true };

test('connection test: mounts once with the typed details, finds the footage, checks writing, and always unmounts and forgets', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-smbtest-'));
  try {
    const mounter = fakeMounter(root, { files: { 'TeslaCam/RecentClips/2026-10-24_10-00-00-front.mp4': 'x' } });
    const r = await createSmbTester({ mounter, vehicles: vehiclesWith(), log: quiet }).test(SMB);
    assert.equal(r.ok, true);
    assert.equal(r.footage, 'TeslaCam');
    assert.equal(r.writable, true);
    assert.deepEqual(mounter.calls.map((c) => c[0]), ['mount', 'unmount', 'forget']);
    assert.equal(mounter.calls[0][1], TEST_ID);
    assert.equal(mounter.calls[0][2].password, 'right');
    assert.deepEqual(fs.readdirSync(root), [], 'nothing left behind, not even the write probe');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('connection test: a wrong password says so in plain words, and still unmounts and forgets', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-smbtest-'));
  try {
    const mounter = fakeMounter(root, { result: { code: 32, output: 'mount error(13): Permission denied\nRefer to the mount.cifs(8) manual page' } });
    const r = await createSmbTester({ mounter, vehicles: vehiclesWith(), log: quiet }).test({ ...SMB, password: 'wrong' });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'connect');
    assert.match(r.error, /Permission denied/);
    assert.match(r.hint, /user name or password/);
    assert.deepEqual(mounter.calls.map((c) => c[0]), ['mount', 'unmount', 'forget']);
    // a NAS that does not answer
    const silent = fakeMounter(root, { result: { code: -1, timedOut: true } });
    assert.match((await createSmbTester({ mounter: silent, vehicles: vehiclesWith(), log: quiet }).test(SMB)).error, /did not answer/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('connection test: bad details are refused without mounting; an edited vehicle uses its saved password when none is typed', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-smbtest-'));
  try {
    const mounter = fakeMounter(root);
    const saved = { id: 'car', source: { ...SMB, password: 'saved-secret' } };
    const tester = createSmbTester({ mounter, vehicles: vehiclesWith([saved]), log: quiet });
    for (const bad of [{ ...SMB, share: 'not a share' }, { ...SMB, version: '1.0' }, null]) {
      const r = await tester.test(bad);
      assert.equal(r.ok, false);
      assert.equal(r.stage, 'details');
    }
    assert.equal(mounter.calls.length, 0, 'nothing mounted for bad details');
    const { password: _omit, ...typed } = SMB;
    assert.equal((await tester.test(typed, 'car')).ok, true);
    assert.equal(mounter.calls[0][2].password, 'saved-secret');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('connection test: one at a time and a few a minute, so it cannot be used to guess NAS passwords quickly', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-smbtest-'));
  try {
    let release;
    const mounter = fakeMounter(root);
    const slow = { ...mounter, mount: async (...a) => { await new Promise((r) => { release = r; }); return mounter.mount(...a); } };
    let t = 0;
    const tester = createSmbTester({ mounter: slow, vehicles: vehiclesWith(), log: quiet, now: () => t });
    const first = tester.test(SMB);
    await new Promise((r) => setImmediate(r));
    await assert.rejects(tester.test(SMB), (err) => err.status === 429 && /already running/.test(err.message));
    release();
    await first;
    const quick = createSmbTester({ mounter, vehicles: vehiclesWith(), log: quiet, now: () => t });
    for (let i = 0; i < 6; i++) assert.equal((await quick.test(SMB)).ok, true);
    await assert.rejects(quick.test(SMB), (err) => err.status === 429 && /Too many/.test(err.message));
    t += 61_000;
    assert.equal((await quick.test(SMB)).ok, true, 'a minute later it works again');
    // and the mount point's name is never a vehicle's
    const taken = createSmbTester({ mounter, vehicles: vehiclesWith([{ id: TEST_ID, source: SMB }]), log: quiet, now: () => t });
    assert.match((await taken.test(SMB)).error, /Rename that vehicle/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('write check: names the step the share refuses (here: setting a file\'s date), and leaves no files behind', async () => {
  const { checkWritable } = require('../server/share');
  const fspMod = require('fs/promises');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sm-write-'));
  const realUtimes = fspMod.utimes;
  try {
    const good = await checkWritable(root);
    assert.deepEqual([good.ok, good.renameOverwrite], [true, true]);
    fspMod.utimes = async () => { throw Object.assign(new Error('EPERM: operation not permitted, utime'), { code: 'EPERM' }); };
    const bad = await checkWritable(root);
    assert.equal(bad.ok, false);
    assert.equal(bad.step, 'setting a file\'s date');
    assert.match(bad.error, /EPERM/);
    assert.match(bad.hint, /file dates/);
    assert.deepEqual(fs.readdirSync(root), [], 'its two check files are removed');
    // and Test connection says it in words
    fspMod.utimes = async () => { throw Object.assign(new Error('EPERM: operation not permitted, utime'), { code: 'EPERM' }); };
    const mounter = fakeMounter(root, { files: { 'TeslaCam/RecentClips/2026-10-24_10-00-00-front.mp4': 'x' } });
    const r = await createSmbTester({ mounter, vehicles: vehiclesWith(), log: quiet }).test(SMB);
    assert.deepEqual([r.ok, r.writable], [true, false]);
    assert.match(r.writeProblem, /^Read-only for this account: setting a file's date failed \(EPERM/);
  } finally {
    fspMod.utimes = realUtimes;
    await fsp.rm(root, { recursive: true, force: true });
  }
  // a folder that is not there: the first step
  assert.equal((await checkWritable(path.join(root, 'gone'))).step, 'writing a file');
});
