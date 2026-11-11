'use strict';

// Sentry USB's list of what the car wrote (.sentryusb/car-files.tsv,
// server/carFiles.js) and how the archive gap check uses it
// (server/archiveGap.js carFilesPass): "Pi missed" (the car wrote it, the
// share hasn't got it), "car didn't record" (CAN driving, nothing in the list),
// unknown (the list can't speak for that time), and never anything for parked
// minutes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { parseCarFiles, clipPath, dailyCounts, createCarFilesReader, MAX_BYTES } = require('../server/carFiles');
const { analyze, stampSec, keyOfRel } = require('../server/archiveGap');
const { createSentryUsbStatus, archivedSince } = require('../server/sentryUsb');

const CAMS = ['back', 'front', 'left_repeater', 'right_repeater'];
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0); // 10 Nov 12:00 (the car's zone is UTC here)
const U = (ms) => Math.floor(ms / 1000);
const key = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
const at = (d, h, m = 0) => Date.UTC(2026, 10, d, h, m, 0);
const HEADER = '# first_seen_unix\tpath\tsize\tmtime_unix\n';

/** The share's clips of every camera for each minute in [from, to), as the scanner records them. */
function drive(files, from, to, { cams = CAMS, size = 30e6 } = {}) {
  for (let t = from; t < to; t += 60_000) {
    const day = key(t).slice(0, 10);
    for (const camera of cams) {
      const rel = `Car/RecentClips/${day}/${key(t)}-${camera}.mp4`;
      files.set(rel, { rel, size, mtimeMs: t + 60_000, ctimeMs: t + 61_000, birthtimeMs: t + 61_000, kind: 'clip', type: 'RecentClips', camera, day });
    }
  }
  return files;
}
/** The car's list lines for each minute in [from, to): flat RecentClips paths, seen a minute after. */
function carLines(from, to, { cams = CAMS, size = 30000000 } = {}) {
  const out = [];
  for (let t = from; t < to; t += 60_000) for (const cam of cams) out.push(`${U(t) + 60}\tRecentClips/${key(t)}-${cam}.mp4\t${size}\t${U(t) + 60}`);
  return out;
}
const minutes = (from, to) => { const out = []; for (let t = from; t < to; t += 60_000) out.push(stampSec(key(t))); return out; };
/** The list as sentryUsb.carFiles() gives it. */
const listOf = (lines, { fileUnix = U(NOW - 5 * 60_000), archivedUnix = U(NOW - 30 * 60_000) } = {}) => ({ present: true, list: parseCarFiles(HEADER + lines.join('\n') + '\n'), fileUnix, archivedUnix });

test('parsing: the header, repeated paths (the largest size), bad lines skipped quietly', () => {
  const text = [
    '# first_seen_unix\tpath\tsize\tmtime_unix',
    '1762790000\tRecentClips/2026-11-10_12-00-00-front.mp4\t1000\t1762789990',
    '1762790600\tRecentClips/2026-11-10_12-00-00-front.mp4\t30000000\t1762790060', // grew
    '1762791200\tRecentClips/2026-11-10_12-00-00-front.mp4\t20000000\t1762790060', // (smaller: keep the largest)
    '1762790000\tSentryClips/2026-11-10_11-58-12/2026-11-10_11-48-00-front.mp4\t25000000\t1762789000',
    '',
    'not a line',
    '1762790000\tRecentClips/2026-11-10_12-01-00-front.mp4\t-1\t1762790000', // bad size
    'x1762790000\tRecentClips/2026-11-10_12-02-00-front.mp4\t1\t1762790000', // bad time
    '1762790000\tRecentClips/2026-11-10_12-03-00-front.mp4\t1', // three fields
    '1762790000\tRecentClips/2026-11-10_12-04-00-front.mp4\t1\t1\textra', // five
    '1762790000\tRecentClips/notes.txt\t1\t1762790000', // not a clip
    '1762790000\tRecentClips/2026-11-10_12-05-00-front.MOV\t1\t1762790000',
    '99\tRecentClips/2026-11-10_12-06-00-front.mp4\t1\t1762790000', // 1970
    '1762790000\tRecentClips/2026-11-10_12-07-00-back.mp4\t5\t1762790000\r' // CRLF
  ].join('\n');
  const l = parseCarFiles(text);
  assert.equal(l.clips.size, 3);
  assert.equal(l.bad, 8);
  const front = l.clips.get('RecentClips/2026-11-10_12-00-00-front.mp4');
  assert.equal(front.size, 30000000, 'the largest size of a repeated path');
  assert.equal(front.firstSeenUnix, 1762790000);
  assert.equal(front.lastSeenUnix, 1762791200);
  assert.equal(front.type, 'RecentClips');
  const ev = l.clips.get('SentryClips/2026-11-10_11-58-12/2026-11-10_11-48-00-front.mp4');
  assert.equal(ev.event, '2026-11-10_11-58-12');
  assert.equal(l.firstSeenUnix, 1762790000);
  assert.equal(l.lastSeenUnix, 1762791200);
  // a header naming the columns in another order is followed
  const swapped = parseCarFiles('# path\tsize\tmtime_unix\tfirst_seen_unix\nRecentClips/2026-11-10_12-00-00-front.mp4\t7\t1762790000\t1762790100\n');
  assert.equal(swapped.clips.get('RecentClips/2026-11-10_12-00-00-front.mp4').size, 7);
  assert.equal(swapped.firstSeenUnix, 1762790100);
  assert.equal(parseCarFiles('').clips.size, 0);
  assert.equal(parseCarFiles(null).clips.size, 0);
});

test('parsing: absolute paths, "..", backslashes and empty parts are ignored', () => {
  for (const bad of ['/RecentClips/2026-11-10_12-00-00-front.mp4', '../RecentClips/2026-11-10_12-00-00-front.mp4', 'RecentClips/../../etc/2026-11-10_12-00-00-front.mp4',
    'RecentClips//2026-11-10_12-00-00-front.mp4', 'RecentClips\\2026-11-10_12-00-00-front.mp4', 'C:/RecentClips/2026-11-10_12-00-00-front.mp4', './RecentClips/2026-11-10_12-00-00-front.mp4',
    'RecentClips/2026-11-10_12-00-00-fr\u0001ont.mp4', 'a/b/c/d/2026-11-10_12-00-00-front.mp4', '']) {
    assert.equal(clipPath(bad), null, bad);
    assert.equal(parseCarFiles(`1762790000\t${bad}\t1\t1762790000\n`).clips.size, 0, bad);
  }
  assert.equal(clipPath('RecentClips/2026-11-10_12-00-00-front.mp4').type, 'RecentClips');
  assert.equal(clipPath('RecentClips/2026-11-10/2026-11-10_12-00-00-front.mp4').type, 'RecentClips', 'a dated folder too');
  assert.equal(clipPath('SavedClips/2026-11-10_12-00-00/2026-11-10_11-59-00-front.mp4').event, '2026-11-10_12-00-00');
});

test('reading: over the size cap is refused, the parse is cached by size and time, the file is read in a dot folder', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'carfiles-'));
  const sub = path.join(dir, '.sentryusb');
  await fsp.mkdir(sub);
  const r = createCarFilesReader();
  assert.equal(await r.read(sub), null, 'no file: null');
  const file = path.join(sub, 'car-files.tsv');
  await fsp.writeFile(file, `${HEADER}1762790000\tRecentClips/2026-11-10_12-00-00-front.mp4\t1\t1762790000\n`);
  const a = await r.read(sub);
  assert.equal(a.list.clips.size, 1);
  assert.equal(await r.read(sub).then((x) => x.list), a.list, 'unchanged: the same parse');
  await fsp.appendFile(file, '1762790060\tRecentClips/2026-11-10_12-01-00-front.mp4\t1\t1762790060\n');
  assert.equal((await r.read(sub)).list.clips.size, 2, 'changed: parsed again');
  const fh = await fsp.open(file, 'r+');
  await fh.truncate(MAX_BYTES + 1);
  await fh.close();
  const big = await r.read(sub);
  assert.equal(big.list, null);
  assert.equal(big.error, 'too large');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('the status service reads car-files.tsv beside archive-status.json', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'carfiles-share-'));
  await fsp.mkdir(path.join(root, '.sentryusb'));
  await fsp.writeFile(path.join(root, '.sentryusb', 'archive-status.json'), JSON.stringify({ schema: 1, state: 'idle', archive: { result: 'ok', started_unix: 1762790000, finished_unix: 1762790300 } }));
  await fsp.writeFile(path.join(root, '.sentryusb', 'car-files.tsv'), `${HEADER}1762780000\tRecentClips/2026-11-10_09-00-00-front.mp4\t1\t1762780000\n`);
  const v = { id: 'car', name: 'Car' };
  const changes = [];
  const svc = createSentryUsbStatus({ vehicles: { list: () => [v], get: () => v, rootOf: () => root }, onChange: (vid) => changes.push(vid) });
  await svc.refresh('car');
  const cf = svc.carFiles('car');
  assert.equal(cf.list.clips.size, 1);
  assert.equal(cf.archivedUnix, 1762790000, 'the start of the last archive that went through');
  assert.equal(changes.length, 1);
  await svc.refresh('car');
  assert.equal(changes.length, 1, 'nothing changed: no new check');
  await fsp.appendFile(path.join(root, '.sentryusb', 'car-files.tsv'), '1762780060\tRecentClips/2026-11-10_09-01-00-front.mp4\t1\t1762780060\n');
  await svc.refresh('car');
  assert.equal(changes.length, 2, 'the list changed: checked again');
  assert.equal(svc.carFiles('car').list.clips.size, 2);
  await fsp.rm(root, { recursive: true, force: true });
  // when an archive counts as gone through
  assert.equal(archivedSince({ state: 'idle', archive: { result: 'failed', filesNotArchived: 3, startedUnix: 5 } }), null);
  assert.equal(archivedSince({ state: 'idle', archive: { result: 'nothing_new', startedUnix: 5 } }), 5);
  assert.equal(archivedSince({ state: 'transferring', archive: {}, transfer: { startedUnix: 9 } }), 9);
  assert.equal(archivedSince(null), null);
});

test('Recent clips are matched by name, flat on the car and in date folders on the share; re-encoded sizes do not matter', () => {
  // the share has 08:00-08:30, re-encoded to a third of the size
  const files = drive(new Map(), at(9, 8), at(9, 8, 30), { size: 10e6 });
  drive(files, at(9, 18), at(9, 18, 5));
  const cf = listOf([...carLines(at(9, 8), at(9, 8, 30)), ...carLines(at(9, 18), at(9, 18, 5))], { archivedUnix: U(at(9, 19)) });
  const res = analyze({ files, nowMs: NOW, canDriving: minutes(at(9, 8), at(9, 8, 30)), carFiles: cf });
  assert.deepEqual(res.days, {}, 'every clip the car wrote is here: nothing');
  const day = res.carFiles.days['2026-11-09'];
  assert.equal(day.piMissed, 0);
  assert.deepEqual(day.car, { recentFiles: 140, minutes: 35, sentryEvents: 0, savedEvents: 0 });
  assert.deepEqual(day.share, day.car, 'the share counts as the Pi does');
  assert.equal(day.carText, '140 RecentClips files covering 35 minutes, 0 Sentry events, 0 saved clips');
  assert.equal(keyOfRel('Car/RecentClips/2026-11-09/2026-11-09_08-00-00-front.mp4'), 'R|2026-11-09_08-00-00-front.mp4');
  assert.equal(keyOfRel('Car/SentryClips/2026-11-09_08-10-00/2026-11-09_08-00-00-front.mp4.binned'), 'SentryClips|2026-11-09_08-10-00|2026-11-09_08-00-00-front.mp4');
});

test('Pi missed: in the list, not on the share, and the Pi archived since', () => {
  const files = drive(new Map(), at(9, 8), at(9, 8, 40));
  drive(files, at(9, 18), at(9, 18, 5));
  const lines = [...carLines(at(9, 8), at(9, 8, 50)), ...carLines(at(9, 18), at(9, 18, 5))];
  // CAN shows the drive, 08:00-08:50: 08:40-08:49 have no footage
  const can = minutes(at(9, 8), at(9, 8, 50));
  const res = analyze({ files, nowMs: NOW, canDriving: can, carFiles: listOf(lines, { archivedUnix: U(at(9, 19)) }) });
  const d = res.days['2026-11-09'];
  assert.equal(d.state, 'partial');
  assert.equal(d.missingMinutes, 10);
  assert.equal(d.carFiles.piMissed, 10);
  assert.equal(d.carFiles.carMissed, 0);
  assert.deepEqual(d.carFiles.runs.map((r) => [r.kind, r.when, r.why]), [['pi', '8:40–8:49 AM', 'The car wrote these clips, but Sentry USB didn\'t keep or upload them.']]);
  assert.match(d.summary, /Sentry USB's list shows the car wrote 10 minutes of it \(8:40–8:49 AM\), but Sentry USB didn't keep or upload them/);
  assert.ok(d.sources.includes('carfiles'));
  assert.equal(res.carFiles.days['2026-11-09'].piMissedClips, 40);
  // without CAN data the list alone finds them
  const alone = analyze({ files, nowMs: NOW, canDriving: null, carFiles: listOf(lines, { archivedUnix: U(at(9, 19)) }) });
  assert.equal(alone.days['2026-11-09'].missingMinutes, 10);
  // the same clips in the Recycle Bin: not missed
  const binned = carLines(at(9, 8, 40), at(9, 8, 50)).map((l) => `Car/RecentClips/2026-11-09/${l.split('\t')[1].split('/')[1]}`);
  assert.equal(analyze({ files, nowMs: NOW, canDriving: null, carFiles: listOf(lines, { archivedUnix: U(at(9, 19)) }), binned }).days['2026-11-09'], undefined);
});

test('in the list but the Pi has not archived since: waiting, not missed', () => {
  const files = drive(new Map(), at(9, 8), at(9, 8, 40));
  drive(files, at(9, 18), at(9, 18, 5));
  const lines = carLines(at(9, 8), at(9, 8, 50));
  const can = minutes(at(9, 8), at(9, 8, 50));
  for (const archivedUnix of [U(at(9, 8, 30)), null]) {
    const res = analyze({ files, nowMs: NOW, canDriving: can, carFiles: listOf(lines, { archivedUnix }) });
    assert.equal(res.days['2026-11-09'], undefined, 'nothing missing yet');
    assert.equal(res.carFiles.days['2026-11-09'].waiting, 10);
    assert.equal(res.carFiles.days['2026-11-09'].piMissed, 0);
  }
});

test('car didn\'t record: CAN driving, the list covers the time and has nothing; not missing from the share', () => {
  const files = drive(new Map(), at(9, 17), at(9, 17, 30));
  drive(files, at(9, 20), at(9, 20, 5));
  const lines = [...carLines(at(8, 6), at(8, 6, 5)), ...carLines(at(9, 17), at(9, 17, 30)), ...carLines(at(9, 20), at(9, 20, 5))];
  const can = minutes(at(9, 17), at(9, 17, 45)); // drove until 17:45; the car stopped writing at 17:30
  const res = analyze({ files, nowMs: NOW, canDriving: can, carFiles: listOf(lines, { archivedUnix: U(at(9, 21)) }) });
  const d = res.days['2026-11-09'];
  assert.equal(d.state, 'car', 'a note for the car, nothing missing');
  assert.equal(d.missingMinutes, 0);
  assert.deepEqual(d.can, []);
  assert.equal(d.carFiles.carMissed, 15);
  assert.deepEqual(d.carFiles.runs.map((r) => [r.kind, r.when, r.why]), [['car', '5:30–5:44 PM', 'The car was driving but didn\'t save video to the USB drive (car or USB drive problem).']]);
  assert.match(d.summary, /^The car was driving 5:30–5:44 PM but didn't save video to the USB drive/);
  // without the list the same minutes are missing, as before
  assert.equal(analyze({ files, nowMs: NOW, canDriving: can }).days['2026-11-09'].missingMinutes, 15);
});

test('unknown, never "car didn\'t record": no list, a day before it starts, after its last update, the Pi off', () => {
  const files = drive(new Map(), at(9, 17), at(9, 17, 30));
  drive(files, at(10, 7), at(10, 7, 5));
  const can = minutes(at(9, 17), at(9, 17, 45));
  // the list starts the next day: the 9th is not covered
  const late = listOf(carLines(at(10, 7), at(10, 7, 5)), { archivedUnix: U(at(10, 8)) });
  let res = analyze({ files, nowMs: NOW, canDriving: can, carFiles: late });
  let d = res.days['2026-11-09'];
  assert.equal(d.state, 'partial', 'as before: the minutes are missing');
  assert.equal(d.missingMinutes, 15);
  assert.equal(d.carFiles.carMissed, 0);
  assert.equal(d.carFiles.unknown, 15);
  assert.equal(d.carFiles.runs[0].kind, 'unknown');
  assert.match(d.carFiles.runs[0].why, /doesn't cover this time/);
  assert.equal(res.carFiles.days['2026-11-09'].coverage, 'none');
  // after the list's last update: unknown
  const early = listOf(carLines(at(8, 6), at(8, 6, 5)), { fileUnix: U(at(9, 12)), archivedUnix: U(at(9, 12)) });
  res = analyze({ files, nowMs: NOW, canDriving: can, carFiles: early });
  assert.equal(res.days['2026-11-09'].carFiles.carMissed, 0);
  assert.equal(res.days['2026-11-09'].carFiles.unknown, 15);
  // the Pi off (no snapshot 16:30-19:00): unknown
  const covered = listOf([...carLines(at(8, 6), at(8, 6, 5)), ...carLines(at(9, 17), at(9, 17, 30))], { archivedUnix: U(at(10, 8)) });
  const snapshots = { intervalS: 3480, gaps: [{ fromUnix: U(at(9, 16, 30)), toUnix: U(at(9, 19)), seconds: 9000, lostToUnix: U(at(9, 18)) }] };
  res = analyze({ files, nowMs: NOW, canDriving: can, carFiles: covered, snapshots });
  d = res.days['2026-11-09'];
  assert.equal(d.carFiles.carMissed, 0);
  assert.equal(d.carFiles.unknown, 15);
  assert.match(d.carFiles.runs.find((r) => r.kind === 'unknown').why, /off or restarting/);
  assert.equal(res.carFiles.days['2026-11-09'].coverage, 'partial');
  // no list at all: no carFiles anywhere
  res = analyze({ files, nowMs: NOW, canDriving: can });
  assert.equal(res.carFiles, null);
  assert.equal(res.days['2026-11-09'].carFiles, null);
});

test('parked minutes are never missing, Sentry Mode included', () => {
  const files = drive(new Map(), at(9, 8), at(9, 8, 10));
  drive(files, at(9, 20), at(9, 20, 5));
  const lines = [...carLines(at(8, 6), at(8, 6, 5)), ...carLines(at(9, 8), at(9, 8, 10)), ...carLines(at(9, 20), at(9, 20, 5))];
  // parked 10:00-16:00 in Sentry (CAN: Sentry, not driving), nothing written: nothing to say
  const res = analyze({ files, nowMs: NOW, canDriving: [], canSentry: minutes(at(9, 10), at(9, 10, 30)), carFiles: listOf(lines, { archivedUnix: U(at(9, 21)) }) });
  assert.equal(res.days['2026-11-09'], undefined);
  const day = res.carFiles.days['2026-11-09'];
  assert.equal(day.carMissed + day.unknown + day.piMissed, 0);
});

test('Sentry and Saved events: matched by event folder and name; counted per day as the Pi does', () => {
  const files = drive(new Map(), at(9, 8), at(9, 8, 5));
  drive(files, at(9, 20), at(9, 20, 5));
  const ev = (type, folder, t) => { for (const cam of CAMS) { const rel = `Car/${type}/${folder}/${key(t)}-${cam}.mp4`; files.set(rel, { rel, size: 1e6, mtimeMs: t, kind: 'clip', type, camera: cam }); } };
  ev('SentryClips', '2026-11-09_12-10-00', at(9, 12));
  ev('SavedClips', '2026-11-09_08-04-30', at(9, 8, 4));
  const lines = [...carLines(at(8, 6), at(8, 6, 5)), ...carLines(at(9, 8), at(9, 8, 5)), ...carLines(at(9, 20), at(9, 20, 5))];
  for (const cam of CAMS) {
    lines.push(`${U(at(9, 12, 11))}\tSentryClips/2026-11-09_12-10-00/${key(at(9, 12))}-${cam}.mp4\t1000\t${U(at(9, 12, 11))}`);
    lines.push(`${U(at(9, 14, 11))}\tSentryClips/2026-11-09_14-10-00/${key(at(9, 14))}-${cam}.mp4\t1000\t${U(at(9, 14, 11))}`); // not on the share
    lines.push(`${U(at(9, 8, 5))}\tSavedClips/2026-11-09_08-04-30/${key(at(9, 8, 4))}-${cam}.mp4\t1000\t${U(at(9, 8, 5))}`);
  }
  const res = analyze({ files, nowMs: NOW, canDriving: [], carFiles: listOf(lines, { archivedUnix: U(at(9, 21)) }) });
  const day = res.carFiles.days['2026-11-09'];
  assert.deepEqual(day.car, { recentFiles: 40, minutes: 10, sentryEvents: 2, savedEvents: 1 });
  assert.deepEqual(day.share, { recentFiles: 40, minutes: 10, sentryEvents: 1, savedEvents: 1 });
  assert.equal(day.piMissed, 1, 'the 14:00 Sentry event');
  assert.equal(day.piMissedClips, 4);
  assert.equal(res.days['2026-11-09'].state, 'partial');
  assert.deepEqual(dailyCounts([]), {});
});

test('a drive cut off where the list shows the car wrote nothing more: not missing, and not "car didn\'t record" without CAN', () => {
  const files = drive(new Map(), at(9, 14), at(9, 14, 3));
  drive(files, at(9, 15, 10), at(9, 15, 20));
  const speeds = new Map();
  for (const f of files.values()) if (f.camera === 'front') speeds.set(f.rel, Array(60).fill(17.5));
  const lines = [...carLines(at(8, 6), at(8, 6, 5)), ...carLines(at(9, 14), at(9, 14, 3)), ...carLines(at(9, 15, 10), at(9, 15, 20))];
  assert.equal(analyze({ files, nowMs: NOW, speeds }).days['2026-11-09'].missingMinutes, 67, 'without the list: missing');
  const res = analyze({ files, nowMs: NOW, speeds, carFiles: listOf(lines, { archivedUnix: U(at(9, 16)) }) });
  assert.equal(res.days['2026-11-09'], undefined);
  assert.equal(res.carFiles.days['2026-11-09'].carMissed, 0);
});

test('all five interfaces show the car\'s list per day ("Pi missed", "Car didn\'t record", unknown only counted)', () => {
  const read = (...p) => require('fs').readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const pages = {
    builtin: read('web', 'app.js'),
    aurora: read('examples', 'ui-packs', 'aurora', 'web', 'aurora', 'pages', 'footage.js'),
    daylight: read('examples', 'ui-packs', 'daylight', 'web', 'dl', 'pages', 'footage.js'),
    flux: read('examples', 'ui-packs', 'flux', 'web', 'flux', 'pages', 'footage.js'),
    horizon: read('examples', 'ui-packs', 'horizon', 'web', 'hz', 'pages', 'footage.js')
  };
  for (const [ui, page] of Object.entries(pages)) {
    assert.match(page, /c\.carText/, `${ui}: the car's counts`);
    assert.match(page, /c\.shareText/, `${ui}: beside the share's`);
    assert.match(page, /r\.why/, `${ui}: each marked stretch in words`);
    assert.match(page, /Pi missed/, ui);
    assert.match(page, /carMissed/, ui);
    // unknown minutes: never the warning tone
    const kinds = /CF_KIND = \{([^}]*)\}/.exec(page)[1];
    assert.doesNotMatch(/unknown: [^,\]]*(?:,[^\]]*)?\]?/.exec(kinds)[0], /amber|warn|org/, `${ui}: unknown is neutral`);
  }
  assert.match(pages.daylight, /gaps\?\.carFiles\?\.days/, 'Daylight reads the day from archive-gaps');
});
