'use strict';

// Missed snapshots: Sentry USB lists its snapshots in its status file
// (snapshot_interval_s, snapshots; server/sentryUsb.js). The car keeps only
// about an hour of RecentClips, so footage between two snapshots much further
// apart than the interval was overwritten before it was copied. The archive
// gap check (server/archiveGap.js) says so for the missing minutes it explains,
// the day tag reads "Pi missed snapshots" in every interface, and the Sentry
// USB details list the interval and the gaps. A file without the fields reads
// as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseStatus, snapshotGaps, snapshotInfo, apiView, createSentryUsbStatus, MAX_BYTES, SNAP_MARGIN_S, CAR_KEEPS_S } = require('../server/sentryUsb');
const { analyze, createArchiveGap, stampSec, footMinutes } = require('../server/archiveGap');

const REPO = path.join(__dirname, '..');
const TZ = 'America/Los_Angeles';
// the owner's car on Mon 9 Nov 2026 (Pacific time, UTC-8 then)
const TIMES = ['01:51', '04:45', '05:43', '06:04', '07:02', '08:58', '09:56', '12:50', '16:42', '17:40', '18:38', '18:40', '19:19'];
const unixAt = (hm, day = '2026-11-09') => Date.parse(`${day}T${hm}:00-08:00`) / 1000;
const SNAPS = TIMES.map((t, i) => ({ name: `snap-${String(i + 1).padStart(6, '0')}`, started_unix: unixAt(t) }));
const NOW = Date.parse('2026-11-10T12:00:00-08:00');
const BASE = { schema: 1, device: 'sentryusb', written_unix: unixAt('19:30'), archive: { result: 'ok', files_archived: 10 }, state: 'idle', transfer: null };
const WITH = { ...BASE, snapshot_interval_s: 3480, snapshots: SNAPS };

// clips of the car's wall clock (the names), as the scanner records them
const key = (wall) => new Date(wall).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
const wall = (hm, day = '2026-11-09') => Date.parse(`${day}T${hm}:00Z`);
function drive(files, from, to) {
  for (let t = from; t < to; t += 60_000) {
    for (const camera of ['front', 'back']) {
      const rel = `TeslaCam/RecentClips/${key(t).slice(0, 10)}/${key(t)}-${camera}.mp4`;
      files.set(rel, { rel, size: 30e6, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0, kind: 'clip', type: 'RecentClips', camera });
    }
  }
  return files;
}
const minutes = (from, to) => { const out = []; for (let t = from; t < to; t += 60_000) out.push(stampSec(key(t))); return out; };

test('snapshots: parsed and validated; bad entries left out, sorted, one per time, the newest 1000', () => {
  const s = parseStatus(WITH);
  assert.equal(s.snapshotIntervalS, 3480);
  assert.equal(s.snapshots.length, 13);
  assert.deepEqual(s.snapshots[0], { name: 'snap-000001', startedUnix: unixAt('01:51') });
  // absent: as before (null), and the rest of the file reads the same
  const old = parseStatus(BASE);
  assert.equal(old.snapshotIntervalS, null);
  assert.equal(old.snapshots, null);
  assert.equal(snapshotInfo(old), null);
  assert.deepEqual({ ...s, snapshotIntervalS: null, snapshots: null }, old);
  // bad entries
  const t = unixAt('10:00');
  const odd = parseStatus({ ...BASE, snapshot_interval_s: 30, snapshots: [
    { name: 'b', started_unix: t + 60 }, { name: 'a', started_unix: t }, { name: 'dup', started_unix: t },
    { name: 'x'.repeat(65), started_unix: t + 120 }, { name: '../etc', started_unix: t + 180 }, { name: 'sp ace', started_unix: t + 240 },
    { name: 5, started_unix: t + 300 }, { started_unix: t + 360 }, { name: 'f', started_unix: t + 0.5 }, { name: 'g', started_unix: String(t) },
    { name: 'h', started_unix: 12 }, { name: 'i', started_unix: 9e9 }, { name: 'j', started_unix: -1 }, null, 7, 'snap', ['a'], {}
  ] });
  assert.equal(odd.snapshotIntervalS, null, 'below 60 s: not an interval');
  assert.deepEqual(odd.snapshots, [{ name: 'a', startedUnix: t }, { name: 'b', startedUnix: t + 60 }, { name: null, startedUnix: t + 360 }]);
  assert.equal(parseStatus({ ...BASE, snapshot_interval_s: 86401 }).snapshotIntervalS, null);
  assert.equal(parseStatus({ ...BASE, snapshot_interval_s: '3480' }).snapshotIntervalS, null);
  assert.equal(parseStatus({ ...BASE, snapshot_interval_s: 86400 }).snapshotIntervalS, 86400);
  assert.equal(parseStatus({ ...BASE, snapshots: 'many' }).snapshots, null, 'not a list: none');
  assert.deepEqual(parseStatus({ ...BASE, snapshots: [] }).snapshots, [], 'an empty list: none taken');
  // more than 1000: the newest 1000, oldest first
  const many = Array.from({ length: 1200 }, (_, i) => ({ name: `snap-${String(i).padStart(6, '0')}`, started_unix: t - (1200 - i) * 300 })).reverse();
  const big = parseStatus({ ...BASE, snapshots: many });
  assert.equal(big.snapshots.length, 1000);
  assert.equal(big.snapshots[0].name, 'snap-000200');
  assert.equal(big.snapshots[999].name, 'snap-001199');
  assert.ok(big.snapshots.every((x, i, a) => !i || a[i - 1].startedUnix < x.startedUnix));
});

test('snapshots: the owner\'s 9 Nov, every 58 min: four missed gaps with their lost windows', () => {
  assert.equal(SNAP_MARGIN_S, 7 * 60);
  assert.equal(CAR_KEEPS_S, 3600);
  const gaps = snapshotGaps(parseStatus(WITH).snapshots, 3480);
  const pt = (u) => new Date((u - 8 * 3600) * 1000).toISOString().slice(11, 16);
  assert.deepEqual(gaps.map((g) => [pt(g.fromUnix), pt(g.toUnix), g.seconds / 60, pt(g.lostToUnix)]), [
    ['01:51', '04:45', 174, '03:45'],
    ['07:02', '08:58', 116, '07:58'],
    ['09:56', '12:50', 174, '11:50'],
    ['12:50', '16:42', 232, '15:42']
  ]);
  // just over the margin, and a gap that loses nothing (the interval set below the car's hour)
  assert.equal(snapshotGaps([{ startedUnix: 0 }, { startedUnix: 3480 + 420 }], 3480).length, 0, '65 min: not missed');
  assert.equal(snapshotGaps([{ startedUnix: 0 }, { startedUnix: 3480 + 421 }], 3480).length, 1);
  assert.deepEqual(snapshotGaps([{ startedUnix: 0 }, { startedUnix: 2400 }], 1200), [{ fromUnix: 0, toUnix: 2400, seconds: 2400, lostToUnix: null }]);
  assert.deepEqual(snapshotGaps([{ startedUnix: 0 }], 3480), []);
  // no interval in the file: Sentry USB's default 3480 s
  const info = snapshotInfo(parseStatus({ ...WITH, snapshot_interval_s: undefined }));
  assert.equal(info.intervalS, 3480);
  assert.equal(info.reported, false);
  assert.equal(info.gaps.length, 4);
});

test('snapshots in GET /api/vehicles/:id/sentry-usb: interval, times and gaps in ms; null without the fields', () => {
  const view = apiView(parseStatus(WITH), { nowMs: NOW, tz: TZ });
  const s = view.snapshots;
  assert.equal(s.interval, 3480);
  assert.equal(s.intervalReported, true);
  assert.equal(s.count, 13);
  assert.equal(s.firstAt, unixAt('01:51') * 1000);
  assert.equal(s.lastAt, unixAt('19:19') * 1000);
  assert.equal(s.times.length, 13);
  assert.deepEqual(s.missed[2], { from: unixAt('09:56') * 1000, to: unixAt('12:50') * 1000, minutes: 174, lostTo: unixAt('11:50') * 1000 });
  assert.equal(apiView(parseStatus(BASE), { nowMs: NOW, tz: TZ }).snapshots, null);
});

test('snapshots: a status file with 1000 of them is read (the size limit has room)', async () => {
  assert.equal(MAX_BYTES, 256 * 1024);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapgap-'));
  try {
    const share = path.join(root, 'TeslaCam');
    fs.mkdirSync(path.join(share, '.sentryusb'), { recursive: true });
    const t = unixAt('10:00');
    // long names, the largest a list may be
    const list = Array.from({ length: 1000 }, (_, i) => ({ name: `snapshot-${'n'.repeat(45)}-${String(i).padStart(6, '0')}`, started_unix: t - (1000 - i) * 3480 }));
    const body = JSON.stringify({ ...WITH, snapshots: list }, null, 2);
    assert.ok(body.length > 64 * 1024 && body.length < MAX_BYTES, `${body.length} bytes`);
    fs.writeFileSync(path.join(share, '.sentryusb', 'archive-status.json'), body);
    const v = { id: 'car', timezone: TZ };
    const status = createSentryUsbStatus({ vehicles: { list: () => [v], get: () => v, rootOf: () => root, studioRoot: () => share }, now: () => NOW });
    const s = await status.refresh('car');
    assert.equal(s.snapshots.length, 1000);
    assert.equal(status.snapshots('car').count, 1000);
    assert.equal(status.api('car').snapshots.count, 1000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// a day like the owner's: footage from 12:50 to 13:50 and 19:20 to 19:40 only; CAN Bridge shows
// driving 10:00-11:39 (inside the lost window 9:56-11:50), 14:00-14:59 (inside 12:50-15:42) and
// 19:00-19:09 (no gap explains it)
function ownersDay() {
  const files = drive(new Map(), wall('12:50'), wall('13:50'));
  drive(files, wall('19:20'), wall('19:40'));
  const can = [...minutes(wall('10:00'), wall('11:40')), ...minutes(wall('14:00'), wall('15:00')), ...minutes(wall('19:00'), wall('19:10'))];
  return { files, can };
}

test('archive gaps: missing minutes in a lost window are explained by the missed snapshots, the count unchanged', () => {
  const { files, can } = ownersDay();
  const before = analyze({ files, nowMs: NOW, tz: TZ, canDriving: can });
  const d0 = before.days['2026-11-09'];
  assert.equal(d0.missingMinutes, 170);
  assert.deepEqual(d0.missedSnapshots, []);
  assert.equal(d0.summary, 'About 170 minutes the car recorded are not on the share: CAN Bridge shows the car driving 10:00–11:39, 14:00–14:59 and 19:00–19:09 with no footage.', 'without the fields: as before');

  const res = analyze({ files, nowMs: NOW, tz: TZ, canDriving: can, snapshots: snapshotInfo(parseStatus(WITH)) });
  const d = res.days['2026-11-09'];
  assert.equal(d.missingMinutes, 170, 'still missing');
  assert.equal(d.state, 'partial');
  assert.deepEqual(d.can, d0.can, 'the evidence lines kept');
  assert.deepEqual(d.missedSnapshots, [
    { from: '2026-11-09_09-56-00', to: '2026-11-09_12-50-00', lostTo: '2026-11-09_11-50-00', minutes: 174, missingMinutes: 100 },
    { from: '2026-11-09_12-50-00', to: '2026-11-09_16-42-00', lostTo: '2026-11-09_15-42-00', minutes: 232, missingMinutes: 60 }
  ]);
  assert.equal(d.missedSnapshotMinutes, 160);
  assert.equal(d.summary, 'About 170 minutes the car recorded are not on the share: CAN Bridge shows the car driving 10:00–11:39, 14:00–14:59 and 19:00–19:09 with no footage. '
    + 'Sentry USB took no snapshot between 9:56 AM and 12:50 PM (2 h 54 min) and between 12:50 and 4:42 PM (3 h 52 min); it should take one every 58 min, '
    + 'and the car keeps only about an hour, so the footage from 9:56 to about 11:50 AM and 12:50 to about 3:42 PM was overwritten before it was copied (160 of the 170 minutes).');

  // one gap, all of the missing minutes in it: the example sentence
  const one = analyze({ files, nowMs: NOW, tz: TZ, canDriving: minutes(wall('10:00'), wall('11:40')), snapshots: snapshotInfo(parseStatus(WITH)) }).days['2026-11-09'];
  assert.equal(one.summary, 'About 100 minutes the car recorded are not on the share: CAN Bridge shows the car driving 10:00–11:39 with no footage. '
    + 'Sentry USB took no snapshot between 9:56 AM and 12:50 PM (2 h 54 min; it should take one every 58 min), and the car keeps only about an hour, so the footage from 9:56 to about 11:50 AM was overwritten before it was copied.');
  // on the 24-hour clock
  const h24 = analyze({ files, nowMs: NOW, tz: TZ, canDriving: minutes(wall('10:00'), wall('11:40')), snapshots: snapshotInfo(parseStatus(WITH)), clock24: true }).days['2026-11-09'];
  assert.match(h24.summary, /between 09:56 and 12:50 \(2 h 54 min; it should take one every 58 min\), .* from 09:56 to about 11:50 was overwritten/);
  // missing minutes outside every lost window (12:50-16:42's window ends 15:42): not explained
  const outside = analyze({ files, nowMs: NOW, tz: TZ, canDriving: minutes(wall('19:00'), wall('19:10')), snapshots: snapshotInfo(parseStatus(WITH)) }).days['2026-11-09'];
  assert.deepEqual(outside.missedSnapshots, []);
  assert.doesNotMatch(outside.summary, /snapshot/);
  // a gap with nothing missing in it adds nothing; no missing minutes: no finding at all
  assert.deepEqual(analyze({ files, nowMs: NOW, tz: TZ, canDriving: [], snapshots: snapshotInfo(parseStatus(WITH)) }).days, {});
});

test('archive gaps: four gaps explaining missing minutes name three, then "and 1 more time"', () => {
  const files = drive(new Map(), wall('19:20'), wall('19:40'));
  const can = [...minutes(wall('02:00'), wall('02:30')), ...minutes(wall('07:10'), wall('07:20')), ...minutes(wall('10:00'), wall('10:30')), ...minutes(wall('13:00'), wall('13:30'))];
  const d = analyze({ files, nowMs: NOW, tz: TZ, canDriving: can, snapshots: snapshotInfo(parseStatus(WITH)) }).days['2026-11-09'];
  assert.equal(d.missedSnapshots.length, 4);
  assert.equal(d.missedSnapshotMinutes, d.missingMinutes);
  assert.match(d.summary, / Sentry USB took no snapshot between 1:51 and 4:45 AM \(2 h 54 min\), between 7:02 and 8:58 AM \(1 h 56 min\), between 9:56 AM and 12:50 PM \(2 h 54 min\), and 1 more time; it should take one every 58 min, and the car keeps only about an hour, so the footage from 1:51 to about 3:45 AM, 7:02 to about 7:58 AM and 9:56 to about 11:50 AM \(and more\) was overwritten before it was copied\.$/);
});

test('archive gaps: a drive cut off inside a lost window is explained too; a gap across midnight names the other day', () => {
  // the footage stops at 10:00 while moving; the next starts at 12:55, moving too
  const files = drive(new Map(), wall('09:59'), wall('10:00'));
  drive(files, wall('12:55'), wall('13:05'));
  drive(files, wall('19:20'), wall('19:40'));
  const speeds = new Map();
  // (moving at 10:00 and from 12:55, parked by 13:04: that drive ends properly)
  for (const f of files.values()) if (f.camera === 'front') speeds.set(f.rel, Array(60).fill(f.rel.includes('_13-04-') ? 0 : 20));
  const d = analyze({ files, nowMs: NOW, tz: TZ, speeds, snapshots: snapshotInfo(parseStatus(WITH)) }).days['2026-11-09'];
  assert.ok(d.cutoffs.length === 1 && d.missingMinutes > 100);
  assert.equal(d.missedSnapshots[0].from, '2026-11-09_09-56-00');
  assert.equal(d.missedSnapshots[0].missingMinutes, 110, '10:00 to 11:49');

  const late = [{ name: 'a', started_unix: unixAt('22:50', '2026-11-08') }, { name: 'b', started_unix: unixAt('03:10') }];
  const night = analyze({ files: drive(new Map(), wall('19:20'), wall('19:40')), nowMs: NOW, tz: TZ, canDriving: minutes(wall('00:30'), wall('00:40')), snapshots: snapshotInfo(parseStatus({ ...WITH, snapshots: late })) }).days['2026-11-09'];
  assert.match(night.summary, /Sentry USB took no snapshot between Sun 8 Nov 10:50 PM and 3:10 AM \(4 h 20 min; it should take one every 58 min\), .* the footage from Sun 8 Nov 10:50 PM to about 2:10 AM was overwritten/);
  assert.equal(footMinutes(1440), '1 day');
  assert.equal(footMinutes(174), '2 h 54 min');
});

test('archive gaps service: the day cards get the missed snapshots; none without the fields', async () => {
  // a drive cut off at 10:00 (the speed index), the next footage at 12:55
  const files = drive(new Map(), wall('09:59'), wall('10:00'));
  drive(files, wall('12:55'), wall('13:05'));
  drive(files, wall('19:20'), wall('19:40'));
  const speeds = {};
  for (const f of files.values()) if (f.camera === 'front') speeds[f.rel] = Array(60).fill(f.rel.includes('_13-04-') ? 0 : 20);
  const car = { id: 'car', name: 'Model Y', timezone: TZ };
  const make = (snapshotsFor) => {
    const rows = new Map();
    const db = { get: (k, d) => (rows.has(k) ? rows.get(k) : d), set: (k, v) => rows.set(k, v) };
    const notes = { list: () => [], raise: () => 1, resolve: () => {} };
    return createArchiveGap({
      inventory: { get: () => ({ files }), codecs: () => new Map() }, vehicles: { get: () => car }, notes, db, canDir: null, now: () => NOW,
      speedIndex: { day: async (vid, day) => (day === '2026-11-09' ? speeds : {}) }, snapshotsFor
    });
  };
  const gap = make(() => snapshotInfo(parseStatus(WITH)));
  await gap.check('car');
  const day = gap.forDays('car')['2026-11-09'];
  assert.equal(day.state, 'partial');
  assert.equal(day.missingMinutes, 175, '10:00 to 12:54');
  assert.equal(day.missedSnapshots.length, 2);
  assert.equal(day.missedSnapshotMinutes, 115, '10:00-11:49 and 12:50-12:54');
  assert.match(day.summary, /Sentry USB took no snapshot between 9:56 AM and 12:50 PM/);
  const plain = make(() => null);
  await plain.check('car');
  const p = plain.forDays('car')['2026-11-09'];
  assert.equal(p.missingMinutes, day.missingMinutes);
  assert.equal(p.missedSnapshots, null);
  assert.equal(p.missedSnapshotMinutes, 0);
  assert.doesNotMatch(p.summary, /snapshot/);
  const index = fs.readFileSync(path.join(REPO, 'server', 'index.js'), 'utf8');
  assert.match(index, /snapshotsFor: \(vid\) => sentryUsb\.snapshots\(vid\)/);
});

// the Sentry USB details (web/sentryUsb.js, the same in every interface)
const SRC = fs.readFileSync(path.join(REPO, 'web', 'sentryUsb.js'), 'utf8');
const load = () => import(`data:text/javascript,${encodeURIComponent(SRC)}`);

test('Sentry USB details: the snapshot interval and the missed snapshots of 7 days, only when the Pi lists them', async () => {
  const { sentryUsbView } = await load();
  const api = apiView(parseStatus(WITH), { nowMs: NOW, tz: TZ });
  const d = Object.fromEntries(sentryUsbView(api, { timeZone: TZ, now: NOW, locale: 'en-US' }).details);
  assert.equal(d.Snapshots, 'every 58 min');
  assert.equal(d['Missed snapshots (7 days)'], '4 · latest Nov 9, 12:50 PM to 4:42 PM (3 h 52 min)');
  const h24 = Object.fromEntries(sentryUsbView(api, { timeZone: TZ, now: NOW, locale: 'en-GB', h24: true }).details);
  assert.match(h24['Missed snapshots (7 days)'], /^4 · latest 9 Nov, 12:50 to 16:42 \(3 h 52 min\)$/);
  const none = Object.fromEntries(sentryUsbView(apiView(parseStatus({ ...WITH, snapshots: SNAPS.slice(0, 1) }), { nowMs: NOW, tz: TZ }), { timeZone: TZ, now: NOW, locale: 'en-US' }).details);
  assert.equal(none['Missed snapshots (7 days)'], 'none');
  const assumed = Object.fromEntries(sentryUsbView(apiView(parseStatus({ ...WITH, snapshot_interval_s: undefined }), { nowMs: NOW, tz: TZ }), { timeZone: TZ, now: NOW, locale: 'en-US' }).details);
  assert.equal(assumed.Snapshots, 'every 58 min (Sentry USB\'s default)');
  const old = Object.fromEntries(sentryUsbView(apiView(parseStatus(BASE), { nowMs: NOW, tz: TZ }), { timeZone: TZ, now: NOW, locale: 'en-US' }).details);
  assert.ok(!('Snapshots' in old) && !('Missed snapshots (7 days)' in old), 'an older Sentry USB: not shown');
  const lengthy = Object.fromEntries(sentryUsbView({ ...api, snapshots: { ...api.snapshots, missed: [{ from: NOW - 2 * 86400_000, to: NOW - 86400_000, minutes: 1440 }] } }, { timeZone: TZ, now: NOW, locale: 'en-US' }).details);
  assert.equal(lengthy['Missed snapshots (7 days)'], '1 · latest Nov 8, 12:00 PM to Nov 9, 12:00 PM (1 day)');
});

test('the "Pi missed snapshots" day tag in all five interfaces, in place of "Partly archived?"', () => {
  const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf8');
  const app = read('web', 'app.js');
  const chip = app.match(/\n {2}function dayArchiveChip\([\s\S]*?\n {2}\}\n/)[0];
  assert.match(chip, /a\.missedSnapshots\?\.length \? 'Pi missed snapshots' : 'Partly archived\?'/);
  assert.match(chip, /title="\$\{esc\(a\.summary\)\}"/);
  const packs = {
    aurora: ['aurora', /const gapLabel = \(a\) => \(!a \? '' : a\.state === 'partial' \? `\$\{a\.missedSnapshots\?\.length \? 'Pi missed snapshots' : 'Partly archived\?'\}/],
    daylight: ['dl', /chip-warn chip-gap[^\n]*\$\{a\.missedSnapshots\?\.length \? 'Pi missed snapshots' : 'Partly archived\?'\}/],
    flux: ['flux', /const gapLabel = \(a\) => \(a\.state === 'partial' \? `\$\{a\.missedSnapshots\?\.length \? 'Pi missed snapshots' : 'Partly archived\?'\}/],
    horizon: ['hz', /const gapWord = \(a\) => \(a\.state === 'partial' && a\.missedSnapshots\?\.length \? 'Pi missed snapshots' : GAP_WORD\[a\.state\] \|\| 'Still arriving'\);/]
  };
  for (const [pack, [mod, re]] of Object.entries(packs)) {
    const page = read('examples', 'ui-packs', pack, 'web', mod, 'pages', 'footage.js');
    assert.match(page, re, pack);
  }
  assert.match(read('examples', 'ui-packs', 'horizon', 'web', 'hz', 'pages', 'footage.js'), /title="\$\{h\(d\.archive\.summary\)\}">\$\{gapWord\(d\.archive\)\}<\/span>/);
  // the labels, worked out
  const label = (a) => (a.state === 'partial' ? `${a.missedSnapshots?.length ? 'Pi missed snapshots' : 'Partly archived?'}${a.missingMinutes ? ` ~${a.missingMinutes} min missing` : ''}` : '');
  assert.equal(label({ state: 'partial', missingMinutes: 808, missedSnapshots: [{}] }), 'Pi missed snapshots ~808 min missing');
  assert.equal(label({ state: 'partial', missingMinutes: 808, missedSnapshots: null }), 'Partly archived? ~808 min missing');
});
