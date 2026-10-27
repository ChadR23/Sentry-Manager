'use strict';

// "Test connection" in a vehicle's settings: mounts the share once with the
// details typed in (nothing is saved), says whether the NAS accepted the
// user name and password, whether Tesla footage is there and whether files
// can be written, then unmounts and forgets the details again.

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { normalizeSmb } = require('./mountSpec');
const { explainMountError } = require('./share');
const { findClipRoot } = require('./vehicles');
const { tail } = require('./proc');

// the mount point the test uses (<footage root>/<id>); no vehicle may have it
const TEST_ID = 'x-smb-test';
// tests a minute, from everyone: a stolen session cannot use this to guess
// NAS passwords quickly
const PER_MINUTE = 6;

function createSmbTester({ mounter, vehicles, log = console, now = Date.now }) {
  let running = false;
  let recent = [];

  /**
   * `source`: the SMB fields as typed ({ share, username, password, domain,
   * version, encrypt, port }); `vehicleId`: the vehicle being edited, whose
   * stored password is used when none is typed.
   */
  async function test(source, vehicleId = null) {
    const existing = vehicleId ? vehicles.get(vehicleId)?.source : null;
    let smb;
    try {
      smb = normalizeSmb(source || {}, existing?.type === 'smb' ? existing : null);
    } catch (err) {
      return { ok: false, stage: 'details', error: err.message };
    }
    if (vehicles.get(TEST_ID)) return { ok: false, stage: 'details', error: `A vehicle uses the id "${TEST_ID}", which the test needs. Rename that vehicle first.` };
    if (running) throw Object.assign(new Error('A connection test is already running. Try again in a moment.'), { status: 429 });
    recent = recent.filter((t) => now() - t < 60_000);
    if (recent.length >= PER_MINUTE) throw Object.assign(new Error('Too many connection tests. Try again in a minute.'), { status: 429 });
    recent.push(now());
    running = true;
    const started = now();
    try {
      let res;
      try {
        res = await mounter.mount(TEST_ID, smb);
      } catch (err) {
        res = { code: -1, output: err.message };
      }
      if (res.code !== 0) {
        const output = String(res.output || '');
        const error = res.notFound ? 'The mount command is missing from the image (cifs-utils).'
          : res.timedOut ? 'The NAS did not answer (is port 445 reachable from the Docker host?).'
            : tail(output, 2) || `mount exited with ${res.code}`;
        log.info?.(`SMB test of ${smb.share} as ${smb.username || '(guest)'}: failed (${error})`);
        return { ok: false, stage: 'connect', error, hint: explainMountError(output), ms: now() - started };
      }
      const root = mounter.target(TEST_ID);
      let entries = 0;
      try {
        entries = (await fsp.readdir(root)).length;
      } catch (err) {
        return { ok: false, stage: 'read', error: `Connected, but the share could not be read (${err.code || err.message}).`, ms: now() - started };
      }
      const clips = findClipRoot(root);
      // a file of our own, made and removed at once: Recycle Bin, Protect
      // and replacing originals need to write
      let writable = false;
      const probe = path.join(root, `.sentry-six-test-${crypto.randomBytes(4).toString('hex')}`);
      try {
        await fsp.writeFile(probe, '', { flag: 'wx' });
        writable = true;
      } catch { /* read-only for this user */ } finally {
        await fsp.rm(probe, { force: true }).catch(() => {});
      }
      log.info?.(`SMB test of ${smb.share} as ${smb.username || '(guest)'}: connected${clips ? ', footage found' : ''}${writable ? '' : ', read-only'}`);
      return {
        ok: true, entries, writable, ms: now() - started,
        footage: clips ? path.relative(root, clips).split(path.sep).join('/') || '.' : null
      };
    } finally {
      await mounter.unmount(TEST_ID, { lazy: true }).catch(() => {});
      await mounter.forget(TEST_ID).catch(() => {});
      running = false;
    }
  }

  return { test, TEST_ID };
}

module.exports = { createSmbTester, TEST_ID };
