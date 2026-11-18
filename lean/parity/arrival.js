'use strict';

// Node's arrival checksums (server/arrivalChecksums.js) and checksum record
// (server/originalChecksums.js) for the Rust port's parity test
// (lean/tests/arrival_parity.rs, needs node):
//
//   node lean/parity/arrival.js make <dir>                a car's share in <dir>/car (TeslaCam/, .sentryusb/)
//   node lean/parity/arrival.js mutate <dir>              phase 2: a clip gone, a re-upload, a new clip
//   node lean/parity/arrival.js run <dir> <data> <phase>  one pass of Node's hasher on it:
//        writes the record on the share, the index in <data>, and
//        <data>/inventory-<phase>.json (what it was given) and
//        <data>/answers-<phase>.json (view, and the record's lines)
//   node lean/parity/arrival.js records <share>           a 60-day sequence of record() calls (pruning)
//
// The Rust test runs its own hasher with the same inventory, clock and
// options on the same files, and compares the files written byte for byte
// and the answers field for field.

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const { createArrivalChecksums } = require(path.join(REPO, 'server/arrivalChecksums'));
const { createOriginalChecksums } = require(path.join(REPO, 'server/originalChecksums'));
const { scanFootage } = require(path.join(REPO, 'server/scanner'));

const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`; };

/** A seeded stream of bytes (the same archive every time for a seed). */
function bytes(seed, n) {
  const out = Buffer.alloc(n);
  let at = 0;
  let i = 0;
  while (at < n) {
    const h = crypto.createHash('sha256').update(`${seed}:${i++}`).digest();
    at += h.copy(out, at);
  }
  return out;
}

const box = (type, ...payload) => {
  const body = Buffer.concat(payload);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
/** A small MP4 whose video track is `entry` (hvc1, avc1, ...): what videoCodec reads. */
function mp4(entry, seed) {
  const hdlr = box('hdlr', Buffer.alloc(8), Buffer.from('vide'), Buffer.alloc(12));
  const stsd = box('stsd', Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]), box(entry, Buffer.alloc(8)));
  const moov = box('moov', box('trak', box('mdia', hdlr, box('minf', box('stbl', stsd)))));
  return Buffer.concat([box('ftyp', Buffer.from('isom')), box('mdat', bytes(seed, 3000)), moov]);
}

const nowOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'now.json'), 'utf8')).now;

async function write(abs, data, mtimeMs = null) {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(`${abs}.part`, data);
  await fsp.rename(`${abs}.part`, abs);
  if (mtimeMs !== null) await fsp.utimes(abs, new Date(mtimeMs), new Date(mtimeMs));
}

const clipRel = (ms, cam, group = 'RecentClips') => {
  const n = `${stamp(ms)}-${cam}.mp4`;
  return group === 'RecentClips' ? `RecentClips/${n.slice(0, 10)}/${n}` : group === 'TeslaTrackMode' ? `TeslaTrackMode/${n}` : `${group}/${stamp(ms + 60_000)}/${n}`;
};

async function make(dir) {
  const now = Math.floor(Date.now() / 1000) * 1000 + 3600_000;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'now.json'), JSON.stringify({ now }));
  const share = path.join(dir, 'car', 'TeslaCam');
  await fsp.mkdir(path.join(share, '.sentryusb'), { recursive: true });
  const cams = ['front', 'back', 'left_repeater', 'right_repeater'];
  let k = 0;
  // the recent window: 12 clips of the last two hours, in every group
  for (let i = 0; i < 12; i++) {
    const group = ['RecentClips', 'SentryClips', 'SavedClips', 'TeslaTrackMode'][i % 4];
    await write(path.join(share, clipRel(now - 7200_000 + i * 60_000, cams[i % 4], group)), bytes(`r${k++}`, 2000 + i * 17));
  }
  // older ones, the backlog (ages 3 days .. 3 years), mtime the clip's own time
  for (const [i, age] of [3, 9, 20, 45, 200, 1100].entries()) {
    const t = now - age * DAY - i * 61_000;
    await write(path.join(share, clipRel(t, cams[i % 4], i % 2 ? 'SentryClips' : 'RecentClips')), bytes(`o${k++}`, 1500 + i), t);
  }
  // encoded ones: an H.265 we did not convert (skipped), one we did (converted()), an AV1 the inventory knows
  await write(path.join(share, clipRel(now - 5400_000, 'front')), mp4('hvc1', 'h1'));
  await write(path.join(share, clipRel(now - 5340_000, 'front')), mp4('hvc1', 'h2'));
  await write(path.join(share, clipRel(now - 5280_000, 'back')), mp4('av01', 'a1'));
  await write(path.join(share, clipRel(now - 5220_000, 'back')), mp4('avc1', 'k1'));
  // what is never read
  const n = `${stamp(now - 3000_000)}-front.mp4`;
  const day = `RecentClips/${n.slice(0, 10)}`;
  for (const rel of [`${day}/${n}.mismatch-1762646400`, `${day}/.sentryusb-partial/${n}`, `${day}/TEMP-H265-${n}`, `${day}/BACKUP-${n}`, `${day}/.${n}`, `Other/${n}`, `${day}/notes.mp4`, `${day}/event.json`]) {
    await write(path.join(share, rel), bytes(rel, 300));
  }
  // a clip Sentry USB is still copying (held in phase 1)
  await write(path.join(share, clipRel(now - 600_000, 'front')), bytes('held', 900));
}

async function mutate(dir) {
  const now = nowOf(dir);
  const share = path.join(dir, 'car', 'TeslaCam');
  await fsp.unlink(path.join(share, clipRel(now - 7200_000 + 60_000, 'back', 'SentryClips')));
  await write(path.join(share, clipRel(now - 7200_000, 'front')), bytes('reupload', 2100));
  await write(path.join(share, clipRel(now - 300_000, 'front')), bytes('new', 1200));
}

function heldName(dir) {
  return path.basename(clipRel(nowOf(dir) - 600_000, 'front'));
}

async function run(dir, data, phase) {
  const now = nowOf(dir) + (phase - 1) * 3600_000;
  const base = path.join(dir, 'car');
  const share = path.join(base, 'TeslaCam');
  const v = { id: 'car 1', name: 'Car', timezone: 'America/Los_Angeles' };
  const vehicles = {
    list: () => [v], get: (id) => (id === v.id ? v : null), rootOf: () => base,
    vehicleForPath: (p) => { const a = path.resolve(p); return a === base || a.startsWith(base + path.sep) ? v : null; }
  };
  const files = (await scanFootage(base)).files;
  // the clips older than the window arrived long ago (birth and change time as their mtime)
  for (const f of files.values()) {
    if (f.mtimeMs < nowOf(dir) - 2 * DAY) { f.birthtimeMs = f.mtimeMs; f.ctimeMs = f.mtimeMs; }
  }
  const codecs = new Map();
  const av1 = [...files.values()].find((f) => f.rel.endsWith('-back.mp4') && f.size > 3000 && f.size < 3200 && fs.readFileSync(path.join(base, f.rel)).includes('av01'));
  if (av1) codecs.set(av1.rel, { size: av1.size, mtimeMs: av1.mtimeMs, codec: 'av1' });
  const inventory = { get: () => ({ files, scanning: false }), codecs: () => codecs };
  const record = createOriginalChecksums({ now: () => now, allowedRoot: (d) => Boolean(vehicles.vehicleForPath(d)) });
  const held = phase === 1 ? new Set([heldName(dir)]) : new Set();
  const arrival = createArrivalChecksums({
    dir: data, vehicles, inventory, record: (r) => record.record(r), holds: (abs) => held.has(path.basename(abs)),
    now: () => now, settleMs: 0, rate: 0, saveEvery: 4, compactMin: 6, nextCycleMs: 60_000, perCycle: phase === 1 ? 14 : 300
  });
  if (phase === 1) await arrival.converted(path.join(share, clipRel(nowOf(dir) - 5340_000, 'front')));
  await arrival.kick();
  await arrival.settled();
  await arrival.stop();
  fs.writeFileSync(path.join(data, `inventory-${phase}.json`), JSON.stringify({
    now, held: [...held],
    files: [...files.values()].map((f) => ({ rel: f.rel, kind: f.kind, size: f.size, mtimeMs: f.mtimeMs, ctimeMs: f.ctimeMs, birthtimeMs: f.birthtimeMs })),
    codecs: [...codecs].map(([rel, c]) => ({ rel, ...c }))
  }));
  fs.writeFileSync(path.join(data, `answers-${phase}.json`), JSON.stringify({ view: arrival.view('car 1'), bytes: arrival.stats().bytes }));
}

async function records(share) {
  fs.mkdirSync(path.join(share, 'RecentClips'), { recursive: true });
  let clock = Date.UTC(2026, 0, 1, 12);
  const rec = createOriginalChecksums({ now: () => clock });
  const add = (name, h) => rec.record({ source: path.join(share, 'RecentClips', name), sourceRoot: share, sha256: h });
  await add('2020-05-05_10-00-00-front.mp4', '1'.repeat(64));
  await add('2026-01-01_10-00-00-front.mp4', '2'.repeat(64));
  for (let day = 1; day <= 60; day++) {
    clock = Date.UTC(2026, 0, 1, 12) + day * DAY;
    await add(`2026-01-${String(1 + (day % 28)).padStart(2, '0')}_11-00-00-front.mp4`, crypto.createHash('sha256').update(String(day)).digest('hex'));
    if (day % 3 === 0) await add(`2026-02-${String(1 + (day % 28)).padStart(2, '0')}_11-00-00-back.mp4`, 'A'.repeat(63) + String(day % 10));
  }
}

(async () => {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === 'make') await make(a);
  else if (cmd === 'mutate') await mutate(a);
  else if (cmd === 'run') await run(a, b, Number(c));
  else if (cmd === 'records') await records(a);
  else throw new Error(`unknown command ${cmd}`);
})().catch((err) => { console.error(err); process.exit(1); });
