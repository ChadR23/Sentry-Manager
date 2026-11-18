'use strict';

// A larger, realistic archive for the whole-API comparison on many clips
// (bigCompare.js): six cameras a minute (front, back, both repeaters, both
// pillars), RecentClips drives over the last two weeks (some cut off while
// moving, some minutes short a camera, some clips arriving late), SentryClips
// and SavedClips events with event.json and thumb.png, an event without its
// thumbnail, a few non-Tesla files. Front clips of every third drive are real
// H.264 clips with Tesla telemetry (speeds, GPS), the rest small stand-ins.
//
//   node lean/parity/bigArchive.js <dir> [--clips 3000] [--now <ms>]
//
// Times are fixed from --now (default: today's 12:00 UTC), so two runs make the
// same archive.

const fs = require('fs');
const path = require('path');
const { teslaH264, drivePattern } = require('./clips');

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? def : process.argv[i + 1]; };
const root = path.resolve(process.argv[2] || '');
if (!process.argv[2] || process.argv[2].startsWith('--')) {
  console.error('usage: node lean/parity/bigArchive.js <dir> [--clips N] [--now ms]');
  process.exit(2);
}
const CLIPS = Number(arg('clips', 3000));
const NOW = Number(arg('now', 0)) || (() => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0); })();
const CAMS = ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar'];
const T = path.join(root, 'TeslaCam');
const p2 = (n) => String(n).padStart(2, '0');
const stampOf = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}_${p2(d.getUTCHours())}-${p2(d.getUTCMinutes())}-${p2(d.getUTCSeconds())}`; };

// a small deterministic random
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

function write(rel, data, mtimeMs) {
  const file = path.join(T, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}
const junk = (n) => Buffer.alloc(n, 0x5a);

async function main() {
  fs.mkdirSync(T, { recursive: true });
  const cache = path.join(root, '..', '.big-clip-cache');
  fs.mkdirSync(cache, { recursive: true });
  // a few real clips: a steady drive, one that ends at speed, one parked (no telemetry)
  const real = [];
  for (const [name, opts] of [['drive-a', { pattern: drivePattern(48, { seed: 0.3 }) }], ['drive-b', { seconds: 3, pattern: drivePattern(36, { seed: 2 }) }], ['drive-c', { pattern: drivePattern(48, { seed: 5.5 }) }]]) {
    const f = path.join(cache, `${name}.mp4`);
    if (!fs.existsSync(f)) await teslaH264(f, opts);
    real.push(fs.readFileSync(f));
  }
  let made = 0;
  let minute = 0;
  let drive = 0;
  // drives of 5 to 25 minutes, two to five a day, newest day first, back over 14 days
  for (let day = 0; made < CLIPS && day < 60; day++) {
    const dayStart = NOW - day * 86400_000 - 12 * 3600_000;
    const drives = 2 + Math.floor(rnd() * 4);
    for (let k = 0; k < drives && made < CLIPS; k++) {
      const start = dayStart + (6 + k * 4) * 3600_000 + Math.floor(rnd() * 60) * 60_000;
      if (start > NOW - 3 * 3600_000 && day === 0 && k > 0) break;
      const len = 5 + Math.floor(rnd() * 20);
      const withReal = drive % 3 === 0;
      for (let m = 0; m < len && made < CLIPS; m++) {
        const t = start + m * 60_000;
        const stamp = stampOf(t);
        const short = drive % 7 === 3 && m === Math.floor(len / 2); // a minute short a camera
        const late = drive % 11 === 5 ? 5 * 3600_000 : 0; // arrived hours later
        for (const cam of CAMS) {
          if (short && cam === 'left_pillar') continue;
          const body = cam === 'front' && withReal ? real[(drive + m) % real.length] : junk(2048 + ((minute * 37 + cam.length * 101) % 4096));
          write(`RecentClips/${stamp.slice(0, 10)}/${stamp}-${cam}.mp4`, body, t + 60_000 + late);
          made++;
        }
        minute++;
      }
      drive++;
      // a Sentry event most days, a Saved one now and then
      if (k === 0 && made < CLIPS) {
        const ev = start - 2 * 3600_000;
        const saved = day % 3 === 1;
        const folder = `${saved ? 'SavedClips' : 'SentryClips'}/${stampOf(ev)}`;
        for (let m = -9; m <= 0 && made < CLIPS; m++) {
          const stamp = stampOf(ev + m * 60_000);
          for (const cam of CAMS) {
            write(`${folder}/${stamp}-${cam}.mp4`, cam === 'front' && m === 0 ? real[day % real.length] : junk(1024 + (made % 2048)), ev + (m + 1) * 60_000);
            made++;
          }
        }
        write(`${folder}/event.json`, JSON.stringify({
          timestamp: stampOf(ev).replace('_', 'T').replace(/-(\d\d)-(\d\d)$/, ':$1:$2'), city: ['Austin', 'Berlin', 'Oslo'][day % 3], street: 'Main St',
          est_lat: String(30.2672 + day * 0.01), est_lon: String(-97.7431 + day * 0.01), reason: saved ? 'user_interaction_honk' : 'sentry_aware_object_detection', camera: String(day % 6)
        }), ev + 60_000);
        if (day % 4 !== 2) write(`${folder}/thumb.png`, junk(400 + day), ev + 60_000);
      }
    }
  }
  // not footage, and left out
  write('notes.txt', 'not footage', NOW - 86400_000);
  write('RecentClips/TEMP-H265-x-front.mp4', junk(10), NOW - 86400_000);
  write('RecentClips/.hidden-front.mp4', junk(10), NOW - 86400_000);
  console.log(JSON.stringify({ root, files: made, now: NOW }));
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
