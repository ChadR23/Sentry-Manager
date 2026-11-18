'use strict';

// A footage archive for comparing the Node and lean servers:
//
//   node lean/parity/makeArchive.js <dir>             the parity archive (edge cases, real clips)
//   node lean/parity/makeArchive.js <dir> --many N    plus about N small files over many days
//                                                      (the scan and memory measurement)
//
// Every file gets a fixed modified time (with a fraction of a millisecond),
// so both servers see the same days and times.

const fs = require('fs');
const path = require('path');
const { teslaH264, converted, drivePattern } = require('./clips');

const root = path.resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('usage: node lean/parity/makeArchive.js <dir> [--many N]');
  process.exit(2);
}
const manyAt = process.argv.indexOf('--many');
const many = manyAt > 0 ? Number(process.argv[manyAt + 1]) : 0;

const T = path.join(root, 'TeslaCam');
const BASE = Date.UTC(2025, 2, 1, 8, 0, 0) / 1000; // 2025-03-01 08:00 UTC
let tick = 0;
/** A fixed modified time, a bit later for each file (seconds, with a fraction). */
const nextTime = () => BASE + 3600 * 24 * 10 + (tick++) * 61 + 0.123456;

function write(rel, data, time = nextTime()) {
  const file = path.join(T, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  fs.utimesSync(file, time, time);
  return file;
}
const junk = (n = 2048) => Buffer.alloc(n, 0x5a);

async function main() {
  fs.mkdirSync(T, { recursive: true });
  const cache = path.join(root, '..', '.clip-cache');
  fs.mkdirSync(cache, { recursive: true });
  // the real clips are made once and copied
  const src = path.join(cache, 'h264.mp4');
  const src2 = path.join(cache, 'h264-b.mp4');
  if (!fs.existsSync(src)) await teslaH264(src, { pattern: drivePattern(48, { seed: 0.3 }) });
  if (!fs.existsSync(src2)) await teslaH264(src2, { seconds: 3, pattern: drivePattern(36, { gap: [12, 24], seed: 2 }) });
  const h265 = path.join(cache, 'h265.mp4');
  const av1 = path.join(cache, 'av1.mp4');
  if (!fs.existsSync(h265)) await converted(src, h265, 'h265');
  if (!fs.existsSync(av1)) await converted(src, av1, 'av1');
  const real = (f) => fs.readFileSync(f);

  // Recent: one drive (front real, back junk), a gap over 90 s, another drive
  write('RecentClips/2025-03-01_08-00-00-front.mp4', real(src));
  write('RecentClips/2025-03-01_08-00-00-back.mp4', junk());
  write('RecentClips/2025-03-01_08-01-00-front.mp4', real(src2));
  write('RecentClips/2025-03-01_08-01-00-left_repeater.mp4', junk(4096));
  write('RecentClips/2025-03-01_08-02-30-front.mp4', junk());
  write('RecentClips/2025-03-01_09-30-00-front.mp4', junk(1));
  write('RecentClips/2025-03-02_23-59-00-front.mp4', Buffer.alloc(0)); // empty: not speed-indexed
  // converted clips
  if (fs.existsSync(h265)) write('RecentClips/2025-03-03_10-00-00-front.mp4', real(h265));
  if (fs.existsSync(av1)) write('RecentClips/2025-03-03_10-01-00-front.mp4', real(av1));
  write('RecentClips/2025-03-03_10-01-00-back.mp4', real(src));
  // not Tesla-named: a date folder's day, else the modified time's
  write('RecentClips/2025-03-04/dashcam.mp4', junk());
  write('RecentClips/random name.mp4', junk(), BASE + 0.5);
  // a date that does not exist: no clip name, but still a time stamp
  write('RecentClips/2025-02-30_10-00-00-front.mp4', junk());
  // left out: converter work files, Sentry USB's aside copies, dot files and folders, NAS folders
  write('RecentClips/TEMP-H265-2025-03-01_08-00-00-front.mp4', junk());
  write('RecentClips/BACKUP-2025-03-01_08-00-00-front.mp4', junk());
  write('RecentClips/2025-03-01_08-00-00-front.mp4.sentry-six-1.partial', junk());
  write('RecentClips/2025-03-01_08-00-00-front.mp4.mismatch-1740000000', junk());
  write('RecentClips/.hidden-2025-03-01_08-00-00-front.mp4', junk());
  write('.sentryusb/2025-03-01_08-00-00-front.mp4', junk());
  write('RecentClips/#recycle/2025-03-01_08-00-00-front.mp4', junk());
  write('RecentClips/@eaDir/2025-03-01_08-00-00-front.mp4', junk());
  write('notes.txt', 'not footage');
  write('RecentClips/readme.txt', 'not footage either');

  // Sentry: an event with event.json, thumb.png and three cameras
  write('SentryClips/2025-03-04_12-30-00/2025-03-04_12-29-00-front.mp4', real(src));
  write('SentryClips/2025-03-04_12-30-00/2025-03-04_12-29-00-back.mp4', junk());
  write('SentryClips/2025-03-04_12-30-00/2025-03-04_12-29-00-left_repeater.mp4', junk());
  write('SentryClips/2025-03-04_12-30-00/2025-03-04_12-30-00-front.mp4', junk());
  write('SentryClips/2025-03-04_12-30-00/event.json', JSON.stringify({
    timestamp: '2025-03-04T12:30:00', city: 'Austin', street: 'Congress Ave', est_lat: '30.2672', est_lon: '-97.7431',
    reason: 'sentry_aware_object_detection', camera: '0', extra: 'not passed on', long: 'x'.repeat(500)
  }));
  write('SentryClips/2025-03-04_12-30-00/thumb.png', junk(300));
  // an event.json too big to read, and one that is not JSON
  write('SavedClips/2025-03-05_09-00-00/2025-03-05_08-59-00-front.mp4', junk());
  write('SavedClips/2025-03-05_09-00-00/event.json', JSON.stringify({ city: 'x'.repeat(70 * 1024) }));
  write('SavedClips/2025-03-05_09-00-00/event.mp4', junk());
  write('SavedClips/2025-03-06_10-00-00/2025-03-06_09-59-00-back.mp4', junk());
  write('SavedClips/2025-03-06_10-00-00/event.json', '{not json');
  // an event folder with an impossible date: its clips are loose clips
  write('SavedClips/2025-13-01_10-00-00/2025-03-06_09-00-00-front.mp4', junk());
  // a folder of no known kind: Tesla-named clips only
  write('Other/2025-03-07_07-00-00-front.mp4', junk());
  write('Other/foo.mp4', junk());
  // an "event" folder under RecentClips: its event.json is an asset of no recording
  write('RecentClips/2025-03-08_10-00-00/event.json', '{}');
  write('RecentClips/2025-03-08_10-00-00/2025-03-08_09-59-00-front.mp4', junk());

  // Ties: recordings that start at the same time keep the order the scan saw their files in
  // (an old day, so the paged queries never cut through them). Four Sentry events and a Saved
  // one whose first clip is the same minute,
  for (const ev of ['SentryClips/2025-02-20_10-05-00', 'SentryClips/2025-02-20_10-02-00', 'SentryClips/2025-02-20_10-09-00',
    'SentryClips/2025-02-20_10-01-00', 'SavedClips/2025-02-20_10-03-00']) {
    write(`${ev}/2025-02-20_10-00-00-back.mp4`, junk());
    if (ev.startsWith('Sentry')) write(`${ev}/2025-02-20_10-00-00-front.mp4`, junk());
  }
  // an event without a front clip (the first clip seen stands for it),
  for (const cam of ['right_repeater', 'left_repeater', 'back', 'right_pillar', 'left_pillar']) {
    write(`SentryClips/2025-02-21_10-00-00/2025-02-21_09-59-00-${cam}.mp4`, junk());
  }
  // drives in three folders and an event without clips, all at 10:00
  write('RecentClips/2025-02-22_10-00-00-front.mp4', junk());
  write('Other/2025-02-22_10-00-00-front.mp4', junk());
  write('RecentClips/2025-02-22/2025-02-22_10-00-00-front.mp4', junk());
  write('SavedClips/2025-02-22_10-00-00/event.json', '{"city":"Tie"}');

  // Clips the speed index's quick read gives up on and the full read does not (more than 64
  // top-level boxes): the fallback. And thumbnails made from clips: an event without thumb.png,
  // a clip under a second (no frame at one second: ffmpeg ends well and writes nothing).
  const frees = Buffer.concat(Array.from({ length: 70 }, () => Buffer.from([0, 0, 0, 12, 0x66, 0x72, 0x65, 0x65, 0, 0, 0, 0])));
  write('RecentClips/2025-03-09_08-00-00-front.mp4', Buffer.concat([real(src), frees]));
  if (fs.existsSync(h265)) write('RecentClips/2025-03-09_08-01-00-front.mp4', Buffer.concat([real(h265), frees]));
  if (fs.existsSync(av1)) write('RecentClips/2025-03-09_08-02-00-front.mp4', Buffer.concat([real(av1), frees]));
  write('SavedClips/2025-03-09_12-00-00/2025-03-09_11-59-00-front.mp4', real(src2));
  write('SavedClips/2025-03-09_12-00-00/2025-03-09_11-59-00-back.mp4', real(src));
  write('SavedClips/2025-03-09_12-00-00/event.json', '{"city":"No thumb"}');
  const short = path.join(cache, 'short.mp4');
  if (!fs.existsSync(short)) await teslaH264(short, { seconds: 0.5, fps: 12, pattern: drivePattern(6, { seed: 4 }) });
  write('RecentClips/2025-03-09_15-00-00-front.mp4', real(short));

  // the measurement archive: four cameras a minute, ten-minute drives with gaps
  for (let i = 0; i < many; i += 4) {
    const minute = Math.floor(i / 4);
    const day = Math.floor(minute / 120);
    const at = Date.UTC(2024, 0, 1 + day, 6 + Math.floor((minute % 120) / 10) * 1, (minute % 10) * 1, 0);
    const d = new Date(at);
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}_${p2(d.getUTCHours())}-${p2(d.getUTCMinutes())}-00`;
    const folder = minute % 50 === 49 ? `SentryClips/${stamp}` : 'RecentClips';
    for (const cam of ['front', 'back', 'left_repeater', 'right_repeater']) {
      const file = path.join(T, folder, `${stamp}-${cam}.mp4`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // sparse: a size without the bytes
      const fd = fs.openSync(file, 'w');
      fs.ftruncateSync(fd, 30 * 1024 * 1024 + (i % 977) * 1024);
      fs.closeSync(fd);
      fs.utimesSync(file, at / 1000 + 60, at / 1000 + 60);
    }
    if (folder.startsWith('Sentry')) fs.writeFileSync(path.join(T, folder, 'event.json'), JSON.stringify({ city: 'Here', reason: 'sentry' }));
  }
  console.log(`archive in ${root}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
