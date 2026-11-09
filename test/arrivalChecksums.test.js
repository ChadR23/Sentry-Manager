'use strict';

// Every clip that reaches a Sentry USB share gets a line in the checksum
// record (server/arrivalChecksums.js; docs/sentry-usb.md): the Pi verifies it
// from that line and never reads it back over the network. Converted or not;
// our own in-place output never gets a line of the converted bytes.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const { createArrivalChecksums } = require('../server/arrivalChecksums');
const { createOriginalChecksums, parseRecord } = require('../server/originalChecksums');
const { scanFootage } = require('../server/scanner');
const { viewerMay } = require('../server/accounts');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arrival-')));
const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`; };

/** A car whose folder holds `layout` (relpath -> bytes), with or without .sentryusb/. */
async function setup({ sentryUsb = true, teslaCam = false, options = {} } = {}) {
  const base = tmp();
  const root = teslaCam ? path.join(base, 'TeslaCam') : base;
  await fsp.mkdir(root, { recursive: true });
  if (sentryUsb) await fsp.mkdir(path.join(root, '.sentryusb'));
  const v = { id: 'car1', name: 'Car', timezone: 'UTC', source: { type: 'path', path: base } };
  const vehicles = {
    list: () => [v], get: (id) => (id === v.id ? v : null), rootOf: () => base,
    vehicleForPath: (p) => { const a = path.resolve(p); return a === base || a.startsWith(base + path.sep) ? v : null; }
  };
  let entry = null;
  const codecMap = new Map();
  const inventory = {
    async scan() { entry = { files: (await scanFootage(base)).files }; return entry; },
    get: () => entry,
    codecs: () => codecMap
  };
  const record = createOriginalChecksums({ allowedRoot: (d) => Boolean(vehicles.vehicleForPath(d)) });
  const held = new Set();
  const busy = new Set();
  const encoded = new Set(); // absolute paths codecOf calls H.265
  const state = { idle: true };
  const arrival = createArrivalChecksums({
    dir: path.join(base, '..', `${path.basename(base)}-data`), vehicles, inventory, record: (r) => record.record(r),
    holds: (abs) => held.has(path.basename(abs)), busyPaths: () => busy, idle: () => state.idle,
    settleMs: 0, rate: 0, idleWaitMs: 10, nextCycleMs: 10,
    codecOf: async (abs) => (encoded.has(abs) ? 'h265' : 'h264'), ...options
  });
  const clipRel = (name, group = 'RecentClips', sub = null) => `${group}/${sub || name.slice(0, 10)}/${name}`;
  const write = async (rel, bytes) => {
    const abs = path.join(root, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    // (a new file under the name, as an upload's final rename makes)
    const t = `${abs}.part-${crypto.randomBytes(3).toString('hex')}`;
    await fsp.writeFile(t, bytes);
    await fsp.rename(t, abs);
    return abs;
  };
  const recordFile = path.join(root, '.sentrymanager', 'original-checksums.sha256');
  const lines = async () => { try { return parseRecord(await fsp.readFile(recordFile, 'utf8')); } catch { return []; } };
  const run = async () => { await inventory.scan(); await arrival.kick(); await arrival.settled(); };
  return { base, root, v, vehicles, inventory, arrival, held, busy, encoded, state, codecMap, clipRel, write, lines, run, recordFile };
}

const NOW = Date.now();
const name = (offsetMs = 0, cam = 'front') => `${stamp(NOW - 3600_000 + offsetMs)}-${cam}.mp4`;

test('arrival: only a share with .sentryusb/ gets a record; nothing is created elsewhere', async () => {
  const off = await setup({ sentryUsb: false });
  await off.write(off.clipRel(name()), crypto.randomBytes(5000));
  await off.run();
  assert.equal(fs.existsSync(path.join(off.root, '.sentrymanager')), false, 'no .sentrymanager/ on a share without Sentry USB');
  assert.equal(off.arrival.view('car1').enabled, false);

  const on = await setup({ teslaCam: true });
  const bytes = crypto.randomBytes(5000);
  const rel = on.clipRel(name());
  await on.write(rel, bytes);
  await on.run();
  assert.deepEqual(await on.lines(), [{ sha256: sha(bytes), rel }], 'at the share root (TeslaCam/), relpath from there');
  assert.equal(on.arrival.view('car1').enabled, true);
});

test('arrival: every new clip gets exactly one line with its true SHA-256; unchanged ones are not hashed again', async () => {
  const s = await setup();
  const clips = {};
  for (const [i, group] of [[0, 'RecentClips'], [60_000, 'RecentClips'], [120_000, 'SentryClips'], [180_000, 'SavedClips'], [240_000, 'TeslaTrackMode']]) {
    const n = name(i, group === 'SentryClips' ? 'back' : 'front');
    const rel = group === 'RecentClips' ? s.clipRel(n) : group === 'TeslaTrackMode' ? `TeslaTrackMode/${n}` : s.clipRel(n, group, stamp(NOW - 3000_000));
    clips[rel] = crypto.randomBytes(3000 + i / 1000);
    await s.write(rel, clips[rel]);
  }
  await s.run();
  const got = await s.lines();
  assert.equal(got.length, 5);
  assert.deepEqual(Object.fromEntries(got.map((l) => [l.rel, l.sha256])), Object.fromEntries(Object.entries(clips).map(([r, b]) => [r, sha(b)])));
  const v = s.arrival.view('car1');
  assert.equal(v.today, 5);
  assert.equal(v.pending, 0);
  assert.ok(v.lastAt > NOW - 60_000);
  const bytes = s.arrival.stats().bytes;
  await s.run();
  await s.run();
  assert.equal((await s.lines()).length, 5, 'no second line');
  assert.equal(s.arrival.stats().bytes, bytes, 'nothing read again');
  // the index survives a restart: a new hasher on the same folder reads nothing either
  const again = createArrivalChecksums({ dir: path.join(s.base, '..', `${path.basename(s.base)}-data`), vehicles: s.vehicles, inventory: s.inventory, record: () => { throw new Error('no line expected'); }, settleMs: 0, rate: 0, codecOf: async () => 'h264' });
  await again.kick(); await again.settled();
  assert.equal(again.stats().bytes, 0);
});

test('arrival: a re-upload (new file under the name) gets a new line; the later one wins', async () => {
  const s = await setup();
  const rel = s.clipRel(name());
  const damaged = crypto.randomBytes(4000);
  await s.write(rel, damaged);
  await s.run();
  const good = crypto.randomBytes(4000);
  await s.write(rel, good); // the Pi renamed the bad copy aside and sent it again
  await s.run();
  assert.deepEqual((await s.lines()).map((l) => l.sha256), [sha(damaged), sha(good)]);
});

test('arrival: clips Sentry USB is still copying wait until the transfer is done; a busy clip waits too', async () => {
  const s = await setup();
  const a = name(0);
  const b = name(60_000);
  await s.write(s.clipRel(a), crypto.randomBytes(1000));
  await s.write(s.clipRel(b), crypto.randomBytes(1000));
  s.held.add(a);
  s.busy.add(path.join(s.root, s.clipRel(b)));
  await s.run();
  assert.deepEqual(await s.lines(), []);
  assert.equal(s.arrival.view('car1').pending, 2, 'both waiting');
  s.held.clear();
  await s.run();
  assert.deepEqual((await s.lines()).map((l) => path.posix.basename(l.rel)), [a]);
  s.busy.clear();
  await s.run();
  assert.equal((await s.lines()).length, 2);
  assert.equal(s.arrival.view('car1').pending, 0);
});

test('arrival: our own in-place conversion never gets a line of the converted bytes; the original\'s stays last', async () => {
  const s = await setup();
  const rel = s.clipRel(name());
  const abs = path.join(s.root, rel);
  const original = crypto.randomBytes(6000);
  await s.write(rel, original);
  // the converter: the original's line first, then the replace (a new inode), then onClipConverted
  const rec = createOriginalChecksums({ allowedRoot: () => true });
  await rec.record({ source: abs, sourceRoot: s.base, sha256: sha(original) });
  const converted = crypto.randomBytes(2000);
  await s.write(rel, converted);
  s.encoded.add(abs);
  await s.arrival.converted(abs);
  await s.run();
  let got = await s.lines();
  assert.deepEqual(got, [{ sha256: sha(original), rel }]);
  // also when the hasher had recorded the original before it was converted
  const rel2 = s.clipRel(name(60_000));
  const abs2 = path.join(s.root, rel2);
  const orig2 = crypto.randomBytes(6000);
  await s.write(rel2, orig2);
  await s.run();
  await rec.record({ source: abs2, sourceRoot: s.base, sha256: sha(orig2) });
  await s.write(rel2, crypto.randomBytes(1500));
  s.encoded.add(abs2);
  await s.arrival.converted(abs2);
  await s.run();
  got = (await s.lines()).filter((l) => l.rel === rel2);
  assert.deepEqual(got.map((l) => l.sha256), [sha(orig2), sha(orig2)], 'only the original\'s hash, ever');
  assert.equal(s.arrival.stats().bytes, 6000, 'only the second original was read: never a converted file');
});

test('arrival: an H.265 clip we did not convert is skipped (unknown origin); one kept as H.264 is hashed', async () => {
  const s = await setup();
  const rel = s.clipRel(name());
  const abs = await s.write(rel, crypto.randomBytes(3000));
  s.encoded.add(abs);
  await s.run();
  assert.deepEqual(await s.lines(), []);
  assert.equal(s.arrival.view('car1').pending, 0, 'not counted as waiting');
  // the codec the inventory already knows is used for an unchanged file (no read)
  const rel2 = s.clipRel(name(60_000));
  const abs2 = await s.write(rel2, crypto.randomBytes(3000));
  const st = await fsp.stat(abs2);
  s.codecMap.set(rel2, { size: st.size, mtimeMs: st.mtimeMs, codec: 'av1' });
  await s.run();
  assert.deepEqual(await s.lines(), []);
  // onClipConverted for a clip that kept its original (no savings): still the original, hashed
  const rel3 = s.clipRel(name(120_000));
  const bytes3 = crypto.randomBytes(3000);
  const abs3 = await s.write(rel3, bytes3);
  await s.arrival.converted(abs3);
  await s.run();
  assert.deepEqual(await s.lines(), [{ sha256: sha(bytes3), rel: rel3 }]);
});

test('arrival: a clip checked in the very millisecond it was written is not still settling (file times have a fraction of a millisecond)', async () => {
  // now() is in whole milliseconds; the file's times are not: mtime X.5 ms with now() X
  let clock = Date.now();
  const s = await setup({ options: { now: () => clock } });
  const rel = s.clipRel(name());
  const bytes = crypto.randomBytes(1000);
  const abs = await s.write(rel, bytes);
  const x = Math.floor((await fsp.stat(abs)).ctimeMs) + 5000;
  await fsp.utimes(abs, (x + 0.5) / 1000, (x + 0.5) / 1000);
  const st = await fsp.stat(abs);
  assert.ok(st.mtimeMs > x && st.mtimeMs < x + 1 && st.ctimeMs < x, 'a fraction of a millisecond into x');
  clock = x;
  await s.run();
  assert.deepEqual(await s.lines(), [{ sha256: sha(bytes), rel }]);
});

test('arrival: mismatch copies, dot-named files and folders, converter temp/backup names and other folders are skipped', async () => {
  const s = await setup();
  const n = name();
  const dir = `RecentClips/${n.slice(0, 10)}`;
  for (const rel of [`${dir}/${n}.mismatch-1762646400`, `${dir}/.sentryusb-partial/${n}`, `.sentryusbtmp/${n}`, `${dir}/TEMP-H265-${n}`, `${dir}/BACKUP-${n}`, `${dir}/.${n}`, `Other/${n}`, `${dir}/notes.mp4`]) {
    await s.write(rel, crypto.randomBytes(500));
  }
  await s.run();
  assert.deepEqual(await s.lines(), []);
  assert.equal(s.arrival.stats().bytes, 0);
});

test('arrival: a file replaced while it is being hashed is dropped, then hashed as the new file', async () => {
  let calls = 0;
  let s;
  let replaced = null;
  s = await setup({ options: {
    idle: () => {
      calls++;
      // mid-hash (the second chunk of a 3 MiB file): a new file under the name
      if (!replaced && calls === 3) {
        replaced = crypto.randomBytes(1000);
        const abs = path.join(s.root, s.clipRel(name()));
        fs.writeFileSync(`${abs}.new`, replaced);
        fs.renameSync(`${abs}.new`, abs);
      }
      return true;
    }
  } });
  const rel = s.clipRel(name());
  await s.write(rel, crypto.randomBytes(3 * 1024 * 1024));
  await s.inventory.scan();
  await s.arrival.kick(); await s.arrival.settled();
  assert.ok(replaced, 'replaced mid-hash');
  assert.deepEqual(await s.lines(), [], 'the old file\'s hash is not written');
  assert.equal(s.arrival.view('car1').pending, 1);
  await s.run();
  assert.deepEqual(await s.lines(), [{ sha256: sha(replaced), rel }]);
});

test('arrival: older clips are not read by default; backfill(N days) records them once; bad days refused', async () => {
  const s = await setup();
  const old = NOW - 20 * DAY;
  const n = `${stamp(old)}-front.mp4`;
  const rel = `RecentClips/${n.slice(0, 10)}/${n}`;
  const bytes = crypto.randomBytes(2000);
  const abs = await s.write(rel, bytes);
  await fsp.utimes(abs, new Date(old), new Date(old));
  const age = async () => { await s.inventory.scan(); for (const f of s.inventory.get().files.values()) { f.birthtimeMs = old; f.ctimeMs = old; } };
  await age();
  await s.arrival.kick(); await s.arrival.settled();
  assert.deepEqual(await s.lines(), [], 'outside the 7 days');
  // one that arrived only now (birth time), though recorded 20 days ago: in
  assert.throws(() => s.arrival.backfill('car1', 0), (e) => e.status === 400);
  assert.throws(() => s.arrival.backfill('car1', 9999), (e) => e.status === 400);
  const v = s.arrival.backfill('car1', 30);
  assert.equal(v.backfill.days, 30);
  await s.arrival.settled();
  assert.deepEqual(await s.lines(), [{ sha256: sha(bytes), rel }]);
  const after = s.arrival.view('car1').backfill;
  assert.ok(after.finishedAt);
  assert.equal(after.done, 1);
  assert.equal(after.total, 1);
  const n2 = `${stamp(old - 60_000)}-front.mp4`;
  const rel2 = `RecentClips/${n2.slice(0, 10)}/${n2}`;
  const abs2 = await s.write(rel2, bytes);
  await fsp.utimes(abs2, new Date(old), new Date(old));
  await age();
  await s.arrival.kick(); await s.arrival.settled();
  assert.equal((await s.lines()).length, 1, 'the backfill was once; the window is back to 7 days');
});

test('arrival: a clip that arrived recently (birth time) is recorded even when its own time is old', async () => {
  const s = await setup();
  const old = NOW - 10 * DAY;
  const n = `${stamp(old)}-front.mp4`;
  const rel = `RecentClips/${n.slice(0, 10)}/${n}`;
  const abs = await s.write(rel, crypto.randomBytes(800));
  await fsp.utimes(abs, new Date(old), new Date(old)); // rsync keeps the clip's mtime
  await s.inventory.scan();
  const f = s.inventory.get().files.get(rel);
  f.birthtimeMs = NOW - 3600_000;
  await s.arrival.kick(); await s.arrival.settled();
  assert.equal((await s.lines()).length, 1);
});

test('arrival: nothing is read while a conversion or the benchmark runs (idle), then it goes on', async () => {
  const s = await setup();
  await s.write(s.clipRel(name()), crypto.randomBytes(1000));
  await s.inventory.scan();
  s.state.idle = false;
  const p = s.arrival.kick();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(s.arrival.stats().bytes, 0);
  assert.deepEqual(await s.lines(), []);
  s.state.idle = true;
  await p; await s.arrival.settled();
  assert.equal((await s.lines()).length, 1);
});

test('arrival: a pass stops at its cap and the next one carries on; the rate limit holds', async () => {
  const s = await setup({ options: { perCycle: 2, rate: 4 * 1024 * 1024 } });
  for (let i = 0; i < 5; i++) await s.write(s.clipRel(name(i * 60_000)), crypto.randomBytes(1024 * 1024));
  await s.inventory.scan();
  const t0 = Date.now();
  await s.arrival.kick();
  assert.equal((await s.lines()).length, 2, 'first pass: 2');
  assert.equal(s.arrival.view('car1').pending, 3);
  assert.ok(Date.now() - t0 >= 400, '2 MiB at 4 MiB/s takes about half a second');
  for (let i = 0; i < 100 && (await s.lines()).length < 5; i++) await new Promise((r) => setTimeout(r, 50));
  await s.arrival.settled();
  assert.equal((await s.lines()).length, 5, 'the next passes carry on by themselves');
  await s.arrival.stop();
});

test('arrival: index entries of gone clips are dropped; the API route is a POST a watch-only account may not make', async () => {
  const s = await setup();
  const rel = s.clipRel(name());
  await s.write(rel, crypto.randomBytes(1000));
  await s.run();
  assert.equal(s.arrival.view('car1').lines, 1);
  await fsp.unlink(path.join(s.root, rel));
  await s.run();
  assert.equal(s.arrival.view('car1').lines, 0);

  assert.equal(viewerMay('POST', '/api/vehicles/car1/sentry-usb/record'), false);
  assert.equal(viewerMay('GET', '/api/vehicles/car1/sentry-usb'), true);
  const src = fs.readFileSync(path.join(REPO, 'server', 'index.js'), 'utf8');
  assert.match(src, /r\.add\('POST', '\/api\/vehicles\/:id\/sentry-usb\/record'/);
  assert.match(src, /canBackfill: accounts\.roleOf\(user\) === 'admin'/);
  assert.match(src, /onClipConverted: \(outputPath\) => \{ arrivalRef\?\.converted\(outputPath\)/);
  assert.match(src, /idle: \(\) => !speedIndexBusy\(\)/);
});
