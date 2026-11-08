'use strict';

// Archive gaps (server/archiveGap.js): footage the car recorded that has not
// reached the share yet. Each signal, and the cases that must stay quiet: a
// car asleep all day, a day still within the grace time, a car without CAN data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const { analyze, createArchiveGap, stampSec } = require('../server/archiveGap');
const { Notifications } = require('../server/activity');

const CAMS = ['back', 'front', 'left_repeater', 'right_repeater'];
const NOW = Date.UTC(2026, 10, 8, 12, 0, 0); // 8 Nov 12:00 (the car's zone is UTC here)
const key = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
const at = (d, h, m = 0) => Date.UTC(2026, 10, d, h, m, 0);

/** Clips of every camera for each minute in [from, to), as the scanner records them. */
function drive(files, from, to, { cams = CAMS, type = 'RecentClips', arrival = null } = {}) {
  for (let t = from; t < to; t += 60_000) {
    const day = key(t).slice(0, 10);
    for (const camera of cams) {
      const rel = `Sentry/${type}/${day}/${key(t)}-${camera}.mp4`;
      files.set(rel, { rel, size: 30e6, mtimeMs: t + 60_000, ctimeMs: arrival ?? t + 61_000, birthtimeMs: arrival ?? t + 61_000, kind: 'clip', type, camera, day });
    }
  }
  return files;
}
const fronts = (files) => [...files.values()].filter((f) => f.camera === 'front').sort((a, b) => a.rel.localeCompare(b.rel));

test('a car asleep all day: no warning', () => {
  const files = drive(new Map(), at(6, 8), at(6, 8, 30)); // only an old drive
  const res = analyze({ files, nowMs: NOW, canDriving: [], speeds: new Map() });
  assert.deepEqual(res.days, {});
  assert.deepEqual(analyze({ files: new Map(), nowMs: NOW, canDriving: [] }).days, {}, 'no footage, no CAN driving: nothing');
});

test('CAN Bridge shows driving with no footage: the minutes count as missing, once old enough', () => {
  const files = drive(new Map(), at(7, 8), at(7, 9)); // 08:00-09:00 on the share
  drive(files, at(7, 18), at(7, 18, 10)); // and a later drive (the archive got past the gap)
  const can = [];
  for (let t = at(7, 9); t < at(7, 10); t += 60_000) can.push(stampSec(key(t))); // drove 09:00-10:00
  for (let t = at(7, 8); t < at(7, 9); t += 60_000) can.push(stampSec(key(t))); // (covered by footage)
  const res = analyze({ files, nowMs: NOW, canDriving: can });
  const d = res.days['2026-11-07'];
  assert.equal(d.state, 'partial');
  assert.equal(d.missingMinutes, 60);
  assert.deepEqual(d.can, [{ from: '2026-11-07_09-00-00', to: '2026-11-07_09-59-00', minutes: 60 }]);
  assert.match(d.summary, /About 60 minutes the car recorded are not on the share: CAN Bridge shows the car driving 09:00–09:59 with no footage\./);
  assert.equal(res.signals.can, true);

  // a day still within the grace time: the last hour's minutes wait
  const recent = [];
  for (let t = NOW - 3600_000; t < NOW; t += 60_000) recent.push(stampSec(key(t)));
  assert.deepEqual(analyze({ files, nowMs: NOW, canDriving: recent }).days, {}, 'within 3 h: not yet');
  // older than the grace time but nothing later on the share yet: the archive may not have got there
  const later = [];
  for (let t = at(8, 6); t < at(8, 7); t += 60_000) later.push(stampSec(key(t)));
  assert.deepEqual(analyze({ files, nowMs: NOW, canDriving: later }).days, {}, 'nothing newer on the share: wait a day');
  assert.equal(analyze({ files, nowMs: NOW + 24 * 3600_000, canDriving: later }).days['2026-11-08'].missingMinutes, 60, 'a day later: missing');
});

test('a car without CAN data, or whose archive leaves Recent clips out, is not checked for missing drives', () => {
  const files = drive(new Map(), at(7, 8), at(7, 9));
  const res = analyze({ files, nowMs: NOW, canDriving: null });
  assert.deepEqual(res.days, {});
  assert.equal(res.signals.can, false);
  const events = drive(new Map(), at(7, 8), at(7, 8, 10), { type: 'SentryClips' });
  const can = [stampSec(key(at(7, 12)))];
  assert.deepEqual(analyze({ files: events, nowMs: NOW, canDriving: can }).days, {}, 'no Recent clips at all: no drive is expected');
});

test('a drive whose footage stops while moving, the next footage much later: cut off', () => {
  const files = drive(new Map(), at(7, 14), at(7, 14, 3)); // 14:00-14:02
  drive(files, at(7, 15, 10), at(7, 15, 20)); // next footage 15:10
  const speeds = new Map();
  for (const f of fronts(files)) speeds.set(f.rel, Array(60).fill(17.5)); // moving all along (63 km/h)
  const res = analyze({ files, nowMs: NOW, speeds, canDriving: null });
  const d = res.days['2026-11-07'];
  assert.equal(d.state, 'partial');
  assert.equal(d.cutoffs.length, 1);
  assert.equal(d.cutoffs[0].kph, 63);
  assert.equal(d.missingMinutes, 67, 'moving at both ends: every minute in between (14:03-15:09)');
  assert.match(d.summary, /the footage stops at 14:03 while the car is moving \(63 km\/h\), and the next is at 15:10/);

  // a drive that ends parked: nothing
  const parked = new Map();
  for (const f of fronts(files)) parked.set(f.rel, [...Array(55).fill(10), 0, 0, 0, 0, 0]);
  assert.deepEqual(analyze({ files, nowMs: NOW, speeds: parked, canDriving: null }).days, {}, 'stopped at the end: a normal end of a drive');
  // the next drive starts from a standstill: at least the one minute is missing, not the whole gap
  const startStill = new Map(speeds);
  for (const f of fronts(files)) if (f.rel.includes('_15-')) startStill.set(f.rel, Array(60).fill(0));
  assert.equal(analyze({ files, nowMs: NOW, speeds: startStill, canDriving: null }).days['2026-11-07'].missingMinutes, 1);
});

test('a minute with only some of the cameras its neighbours have: partial; one alone is not enough', () => {
  const files = drive(new Map(), at(7, 8), at(7, 8, 20));
  const drop = (t, cam) => files.delete(`Sentry/RecentClips/2026-11-07/${key(t)}-${cam}.mp4`);
  drop(at(7, 8, 5), 'right_repeater');
  assert.deepEqual(analyze({ files, nowMs: NOW }).days, {}, 'one minute short a camera: a camera can miss a minute');
  drop(at(7, 8, 9), 'left_repeater');
  drop(at(7, 8, 9), 'right_repeater');
  const d = analyze({ files, nowMs: NOW }).days['2026-11-07'];
  assert.equal(d.state, 'partial');
  assert.equal(d.partialMinutes, 2);
  assert.equal(d.missingMinutes, 0);
  assert.deepEqual(d.partial[1], { at: '2026-11-07_08-09-00', cameras: 2, of: 4, lacking: ['left_repeater', 'right_repeater'] });
  assert.match(d.summary, /^Some footage looks only partly copied: 2 minutes have only some cameras\.$/);

  // a car with 6 cameras now and 4 before is not "missing" the pillars on the older minutes
  const mixed = drive(new Map(), at(7, 8), at(7, 8, 10));
  drive(mixed, at(7, 9), at(7, 9, 10), { cams: [...CAMS, 'left_pillar', 'right_pillar'] });
  assert.deepEqual(analyze({ files: mixed, nowMs: NOW }).days, {});
});

test('the last minute of a folder short a camera waits: it may still be being copied', () => {
  const files = drive(new Map(), at(8, 8), at(8, 8, 3), { arrival: NOW - 30 * 60_000 });
  files.delete(`Sentry/RecentClips/2026-11-08/${key(at(8, 8, 1))}-right_repeater.mp4`);
  files.delete(`Sentry/RecentClips/2026-11-08/${key(at(8, 8, 2))}-left_repeater.mp4`);
  const d = analyze({ files, nowMs: NOW }).days['2026-11-08'];
  assert.equal(d.state, 'filling', 'arrived half an hour ago (hours late): still being copied');
  assert.equal(d.partialMinutes, 1, '08:02, the last, waits; 08:01 has 08:02 after it');
  const later = drive(new Map(), at(8, 8), at(8, 8, 3), { arrival: NOW - 3 * 3600_000 });
  later.delete(`Sentry/RecentClips/2026-11-08/${key(at(8, 8, 1))}-right_repeater.mp4`);
  later.delete(`Sentry/RecentClips/2026-11-08/${key(at(8, 8, 2))}-left_repeater.mp4`);
  assert.equal(analyze({ files: later, nowMs: NOW }).days['2026-11-08'].partialMinutes, 2, 'nothing more came for hours: the last counts too');
});

test('clips arriving hours after they were recorded: still filling (a tag, no notification); converted clips are left out', () => {
  const files = drive(new Map(), at(8, 1), at(8, 1, 10), { arrival: NOW - 10 * 60_000 }); // recorded 01:00, arrived 11:50
  const res = analyze({ files, nowMs: NOW });
  const d = res.days['2026-11-08'];
  assert.equal(d.state, 'filling');
  assert.equal(d.lateClips, 40);
  assert.ok(d.maxLateHours > 10 && d.maxLateHours < 11);
  assert.match(d.summary, /^Still being copied: clips are reaching the share up to 10\.\d h after they were recorded\.$/);
  assert.equal(res.signals.arrival, true);
  // converted: the converter rewrote them
  const encoded = new Set([...files.keys()]);
  assert.deepEqual(analyze({ files, nowMs: NOW, encoded }).days, {});
  // the same, but the last one arrived hours ago: the archive caught up
  assert.deepEqual(analyze({ files, nowMs: NOW + 3 * 3600_000 }).days, {});
  // a share whose file times are the copy's (no arrival time): nothing
  const plain = drive(new Map(), at(8, 1), at(8, 1, 10));
  assert.deepEqual(analyze({ files: plain, nowMs: NOW }).days, {});
});

test('stalled: a car with footage most days and nothing new for two days is reported (no notification)', () => {
  const files = new Map();
  for (let d = 1; d <= 6; d++) drive(files, at(d, 8), at(d, 8, 5));
  for (let d = 23; d <= 31; d++) drive(files, Date.UTC(2026, 9, d, 8), Date.UTC(2026, 9, d, 8, 5));
  const res = analyze({ files, nowMs: NOW });
  assert.ok(res.stalled, 'quiet for two days');
  assert.ok(res.stalled.hours >= 36);
  assert.deepEqual(res.days, {});
  assert.equal(analyze({ files, nowMs: at(6, 20) }).stalled, null);
});

// ---- the service: notifications through the notification rules

function fakeDb() {
  const store = new Map();
  const rows = [];
  return {
    store, rows,
    get: (k, d) => (store.has(k) ? store.get(k) : d),
    set: (k, v) => store.set(k, v),
    notify(n) {
      const open = rows.find((r) => r.dedupeKey === n.dedupeKey && !r.resolvedAt);
      if (open) { Object.assign(open, n); return open.id; }
      rows.push({ ...n, id: rows.length + 1, resolvedAt: null });
      return rows.length;
    },
    resolve(k) { for (const r of rows) if (r.dedupeKey === k && !r.resolvedAt) r.resolvedAt = Date.now(); },
    resolveId(id) { const r = rows.find((x) => x.id === id); if (r) r.resolvedAt = Date.now(); },
    resolvePrefix(p) { for (const r of rows) if (r.dedupeKey?.startsWith(p)) r.resolvedAt = Date.now(); },
    notifications: ({ open }) => rows.filter((r) => !open || !r.resolvedAt)
  };
}

async function canSetup(minutes) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'archivegap-'));
  await fsp.mkdir(path.join(dir, 'K'));
  for (const [t, kph, gear] of minutes) {
    const name = `${new Date(t).toISOString().slice(0, 16).replace(/[-:]/g, '')}.json.gz`;
    const body = { minute: t, logs: {}, signals: { DI_vehicleSpeed: [[0, kph], [30_000, kph]], DI_gear: [[0, gear]] }, ids: {} };
    await fsp.writeFile(path.join(dir, 'K', name), zlib.gzipSync(JSON.stringify(body)));
  }
  return dir;
}

function service({ files, db, dir, now = NOW }) {
  const car = { id: 'car', name: 'Model Y', timezone: 'UTC' };
  const notes = new Notifications({ db });
  const inventory = { get: () => ({ files }), codecs: () => new Map() };
  const vehicles = { get: (id) => (id === 'car' ? car : null) };
  const gap = createArchiveGap({ inventory, vehicles, notes, db, canKeysFor: async () => ['K'], canDir: dir, now: () => now });
  return { gap, notes };
}

test('the notification: raised once per car and day, muted by the rules, kept dismissed, resolved when the footage arrives', async () => {
  const files = drive(new Map(), at(7, 8), at(7, 9));
  drive(files, at(7, 18), at(7, 18, 10));
  const minutes = [];
  for (let t = at(7, 9); t < at(7, 9, 30); t += 60_000) minutes.push([t, 50, 4]); // driving 09:00-09:29
  for (let t = at(7, 22); t < at(7, 22, 30); t += 60_000) minutes.push([t, 0, 1]); // awake in Park: no alarm
  const dir = await canSetup(minutes);
  try {
    const db = fakeDb();
    const { gap, notes } = service({ files, db, dir });
    let res = await gap.check('car');
    assert.equal(res.days['2026-11-07'].missingMinutes, 30, 'only the driving minutes, not the ones awake in Park');
    let open = db.rows.filter((r) => !r.resolvedAt);
    assert.equal(open.length, 1);
    assert.equal(open[0].kind, 'archive');
    assert.equal(open[0].level, 'warning');
    assert.equal(open[0].dedupeKey, 'archive:car:2026-11-07');
    assert.equal(open[0].title, 'Model Y: Sat 7 Nov looks only partly archived');
    assert.match(open[0].message, /About 30 minutes the car recorded are not on the share: CAN Bridge shows the car driving 09:00–09:29 with no footage\. Check the Sentry USB .*Logs page, its archive settings and its Wi-Fi to the NAS\. Clips it recycles before copying them are lost\./);
    assert.deepEqual(gap.forDays('car')['2026-11-07'].state, 'partial');

    await gap.check('car');
    assert.equal(db.rows.length, 1, 'checked again: the same notification, not a second one');

    // dismissed: not back on the next check ...
    notes.dismiss(open[0].id);
    await gap.check('car');
    assert.equal(db.rows.filter((r) => !r.resolvedAt).length, 0, 'dismissed stays dismissed');
    // ... unless the gap grows a good deal
    const more = [];
    for (let t = at(7, 10); t < at(7, 11); t += 60_000) more.push([t, 60, 4]);
    const dir2 = await canSetup([...minutes, ...more]);
    const again = service({ files, db, dir: dir2 });
    res = await again.gap.check('car');
    assert.equal(res.days['2026-11-07'].missingMinutes, 90);
    assert.equal(db.rows.filter((r) => !r.resolvedAt).length, 1, '30 -> 90 minutes: raised again');

    // the footage arrives: resolved
    drive(files, at(7, 9), at(7, 11));
    await again.gap.check('car');
    assert.equal(db.rows.filter((r) => !r.resolvedAt).length, 0, 'caught up: resolved');
    assert.deepEqual(again.gap.forDays('car'), {});
    await fsp.rm(dir2, { recursive: true, force: true });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('notification rules: archive turned off raises nothing (the tag still shows)', async () => {
  const files = drive(new Map(), at(7, 8), at(7, 9));
  drive(files, at(7, 18), at(7, 18, 10));
  const dir = await canSetup([[at(7, 9, 30), 40, 4], [at(7, 9, 31), 40, 4]]);
  try {
    const db = fakeDb();
    db.set('notify-muted', ['archive']);
    const { gap } = service({ files, db, dir });
    const res = await gap.check('car');
    assert.equal(res.days['2026-11-07'].missingMinutes, 2);
    assert.equal(db.rows.length, 0);
    assert.equal(gap.forDays('car')['2026-11-07'].state, 'partial');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a car without CAN data: the service checks the rest and stays quiet when all is there', async () => {
  const files = drive(new Map(), at(7, 8), at(7, 9));
  const db = fakeDb();
  const notes = new Notifications({ db });
  const gap = createArchiveGap({
    inventory: { get: () => ({ files }), codecs: () => new Map() }, vehicles: { get: () => ({ id: 'car', name: 'Car' }) },
    notes, db, canKeysFor: async () => [], canDir: os.tmpdir(), now: () => NOW
  });
  const res = await gap.check('car');
  assert.deepEqual(res.days, {});
  assert.equal(res.signals.can, false);
  assert.equal(db.rows.length, 0);
  assert.ok(notes instanceof EventEmitter);
});

test('a share copied or restored on the NAS (old clips "arriving" too) is not an archive running behind', () => {
  const files = drive(new Map(), at(8, 1), at(8, 1, 10), { arrival: NOW - 10 * 60_000 });
  drive(files, Date.UTC(2026, 9, 20, 8), Date.UTC(2026, 9, 20, 8, 10), { arrival: NOW - 10 * 60_000 }); // three weeks old, copied now
  assert.deepEqual(analyze({ files, nowMs: NOW }).days, {});
});

test('several CAN stretches read as one list', () => {
  const files = drive(new Map(), at(7, 8), at(7, 9));
  drive(files, at(7, 18), at(7, 18, 10));
  const can = [at(7, 9), at(7, 9, 1), at(7, 10), at(7, 11, 30), at(7, 11, 31)].map((t) => stampSec(key(t)));
  assert.match(analyze({ files, nowMs: NOW, canDriving: can }).days['2026-11-07'].summary, /CAN Bridge shows the car driving 09:00–09:01, 10:00 and 11:30–11:31 with no footage\./);
});
