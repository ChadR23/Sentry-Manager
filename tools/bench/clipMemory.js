#!/usr/bin/env node
'use strict';

// In-process memory of reading one clip, without Docker: the peak rss,
// arrayBuffers and heapUsed while server/speedReader.js readSamples (the
// speed index's quick read) and server/telemetry.js (the full read, in a
// worker thread) read synthetic Tesla-like clips of about 10, 30 and 60 MB,
// one at a time and four at once.
//
//   node tools/bench/clipMemory.js [--dir <clip folder>] [--sizes 10,30,60]
//        [--concurrency 1,4] [--rounds 2] [--readers speedReader,telemetry] [--json <file>]
//
// The clips are made once with ffmpeg (libx264) into --dir (default: the
// system temp folder, sentry-bench-clips) and kept for the next run: 60 s
// at 36 frames a second, 1280x960 like a Tesla front camera, a constant
// bitrate picked for the size, and a Tesla telemetry record (speed,
// position, acceleration) in an SEI ahead of every frame.
//
// Each case runs in its own `node --expose-gc` process so one case's peak
// cannot hide in another's: rss / arrayBuffers / heapUsed / external are the
// highest seen by polling process.memoryUsage() every 2 ms (the "+" columns
// are over the process's own level just before the first read); maxRSS is
// the kernel's peak for the whole process (resourceUsage), before the first
// read and at the end, so a peak between two polls still shows. A zero-filled
// Buffer.alloc is counted in arrayBuffers at once but only becomes rss as its
// pages are written, so arrayBuffers is the figure that follows the clip size. The telemetry read happens
// in a worker thread, whose memory is not in the main thread's
// process.memoryUsage(): its heap and external memory are polled with
// worker.getHeapStatistics() and shown as "worker". rss covers both.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function parseArgs(argv) {
  const out = { dir: path.join(os.tmpdir(), 'sentry-bench-clips'), sizes: [10, 30, 60], concurrency: [1, 4], rounds: 2, readers: ['speedReader', 'telemetry'], json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    const list = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);
    if (a === '--dir') out.dir = path.resolve(val());
    else if (a === '--sizes') out.sizes = list(val()).map(Number);
    else if (a === '--concurrency') out.concurrency = list(val()).map(Number);
    else if (a === '--rounds') out.rounds = Number(val());
    else if (a === '--readers') out.readers = list(val());
    else if (a === '--json') out.json = path.resolve(val());
    else if (a === '--child') out.child = JSON.parse(val());
    else throw new Error(`Unknown option ${a}`);
  }
  return out;
}

// ---- the clips

const FPS = 36;
const SECONDS = 60;

/** Frame n's Tesla record: gear, frame, speed (float), lat/lon/ax/ay (double), no 00 00 run in it. */
function teslaRecord(n) {
  for (let jitter = 0; jitter < 1000; jitter++) {
    const f = Buffer.alloc(4);
    f.writeFloatLE(8 + (n % 900) / 30 + jitter * 1e-3);
    const d = (v) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b; };
    const t = n / FPS;
    const rec = Buffer.concat([
      Buffer.from([0x10, 0x04]), // gear (2): drive
      Buffer.from([0x18, 0x80 | (n & 0x7f) | 0x01, Math.max(1, (n >> 7) & 0x7f)]), // frame number (3)
      Buffer.from([0x25]), f, // speed (4), m/s
      Buffer.from([0x59]), d(37.4 + t * 1.1e-4 + jitter * 1e-9), // latitude (11)
      Buffer.from([0x61]), d(-122.1 - t * 0.9e-4 - jitter * 1e-9), // longitude (12)
      Buffer.from([0x71]), d(0.3 + Math.sin(t) * 0.2 + jitter * 1e-9), // acceleration along (14)
      Buffer.from([0x79]), d(0.1 + Math.cos(t) * 0.1 + jitter * 1e-9) // across (15)
    ]);
    let ok = true;
    for (let i = 1; i < rec.length; i++) if (rec[i] === 0 && rec[i - 1] === 0) { ok = false; break; }
    if (ok) return rec;
  }
  throw new Error(`no record without a 00 00 run for frame ${n}`);
}

async function makeClip(file, megabytes) {
  const { runProcess } = require(path.join(ROOT, 'test/fixtures/ffmpegFixtures'));
  const { injectTeslaTelemetryIntoH264Mp4 } = require(path.join(ROOT, 'test/fixtures/fixtureBuilders'));
  const frames = FPS * SECONDS;
  const bitrate = Math.round((megabytes * 1e6 * 8) / SECONDS);
  const base = `${file}.base.mp4`;
  const r = await runProcess('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=duration=${SECONDS}:size=1280x960:rate=${FPS},noise=alls=12:allf=t`,
    '-frames:v', String(frames), '-an',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', String(bitrate), '-minrate', String(bitrate), '-maxrate', String(bitrate),
    '-bufsize', String(bitrate), '-x264-params', 'nal-hrd=cbr:force-cfr=1',
    '-g', String(FPS), '-bf', '0', '-pix_fmt', 'yuv420p', '-tag:v', 'avc1', '-movflags', '+faststart', '-use_editlist', '0', base
  ], { timeoutMs: 600_000 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  const bytes = await fs.promises.readFile(base);
  const out = injectTeslaTelemetryIntoH264Mp4(bytes, Array.from({ length: frames }, (_, n) => teslaRecord(n)));
  await fs.promises.writeFile(file, out);
  await fs.promises.unlink(base);
}

async function ensureClips(dir, sizes) {
  fs.mkdirSync(dir, { recursive: true });
  const clips = [];
  for (const mb of sizes) {
    const file = path.join(dir, `tesla-${mb}mb-front.mp4`);
    if (!fs.existsSync(file)) {
      process.stderr.write(`making ${path.basename(file)} ...\n`);
      await makeClip(file, mb);
    }
    clips.push({ mb, file, bytes: fs.statSync(file).size });
  }
  return clips;
}

// ---- one case, in its own process

async function child({ reader, file, concurrency, rounds }) {
  const workers = new Set();
  if (reader === 'telemetry') {
    // see the telemetry reader's worker threads (it takes Worker when it loads)
    const wt = require('worker_threads');
    const Base = wt.Worker;
    wt.Worker = class extends Base {
      constructor(...a) {
        super(...a);
        workers.add(this);
        this.once('exit', () => workers.delete(this));
      }
    };
  }
  const size = fs.statSync(file).size;
  let read;
  if (reader === 'speedReader') {
    const { readSamples } = require(path.join(ROOT, 'server/speedReader'));
    read = async () => {
      const s = await readSamples(file);
      if (!s || !s.length) throw new Error('no samples');
      return s.length;
    };
  } else if (reader === 'telemetry') {
    const { Telemetry } = require(path.join(ROOT, 'server/telemetry'));
    const t = new Telemetry({ srcRoot: path.join(ROOT, 'src'), cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'clipmem-')) });
    read = async () => {
      const body = await t.read(file, size);
      const n = JSON.parse(body).frames.length;
      if (!n) throw new Error('no records');
      return n;
    };
  } else throw new Error(`unknown reader ${reader}`);

  global.gc();
  await new Promise((r) => setTimeout(r, 50));
  global.gc();
  const before = process.memoryUsage();
  const maxRssBefore = process.resourceUsage().maxRSS * 1024;
  const peak = { rss: before.rss, heapUsed: before.heapUsed, arrayBuffers: before.arrayBuffers, external: before.external, worker: 0, workerHeap: 0 };
  const poll = () => {
    const m = process.memoryUsage();
    for (const k of ['rss', 'heapUsed', 'arrayBuffers', 'external']) if (m[k] > peak[k]) peak[k] = m[k];
  };
  const timer = setInterval(poll, 2);
  let polling = true;
  const workerPoll = (async () => {
    while (polling) {
      const stats = await Promise.all([...workers].map((w) => w.getHeapStatistics?.().catch(() => null)));
      const heap = stats.reduce((s, x) => s + (x?.used_heap_size || 0), 0);
      const total = stats.reduce((s, x) => s + (x?.used_heap_size || 0) + (x?.external_memory || 0), 0);
      if (total > peak.worker) peak.worker = total;
      if (heap > peak.workerHeap) peak.workerHeap = heap;
      await new Promise((r) => setTimeout(r, 5));
    }
  })();
  const started = process.hrtime.bigint();
  let items = 0;
  for (let round = 0; round < rounds; round++) {
    const got = await Promise.all(Array.from({ length: concurrency }, () => read().then((n) => { poll(); return n; })));
    items = got[0];
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  polling = false;
  clearInterval(timer);
  await workerPoll;
  poll();
  const maxRss = process.resourceUsage().maxRSS * 1024;
  return {
    reader, bytes: size, concurrency, rounds, items, msPerRound: Math.round(ms / rounds),
    base: { rss: before.rss, heapUsed: before.heapUsed, arrayBuffers: before.arrayBuffers, external: before.external },
    peak, maxRss, maxRssBefore
  };
}

function runChild(spec) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--expose-gc', '--disable-warning=ExperimentalWarning', __filename, '--child', JSON.stringify(spec)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${spec.reader} ${path.basename(spec.file)} x${spec.concurrency}: exit ${code}`));
      try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch (err) { reject(err); }
    });
  });
}

const MiB = (n) => (n / 1024 / 1024).toFixed(1);

function table(results) {
  const head = '| reader | clip | at once | peak rss | rss + | maxRSS (before → after) | peak arrayBuffers | arrayBuffers + | peak heapUsed | heapUsed + | worker heap+external | ms / round |';
  const sep = `|${head.split('|').slice(1, -1).map(() => '---').join('|')}|`;
  const rows = results.map((r) => `| ${r.reader} | ${MiB(r.bytes)} MiB | ${r.concurrency} | ${MiB(r.peak.rss)} MiB | ${MiB(r.peak.rss - r.base.rss)} MiB | ${MiB(r.maxRssBefore)} → ${MiB(r.maxRss)} MiB | ${MiB(r.peak.arrayBuffers)} MiB | ${MiB(r.peak.arrayBuffers - r.base.arrayBuffers)} MiB | ${MiB(r.peak.heapUsed)} MiB | ${MiB(r.peak.heapUsed - r.base.heapUsed)} MiB | ${r.reader === 'telemetry' ? `${MiB(r.peak.worker)} MiB` : '–'} | ${r.msPerRound} |`);
  return [head, sep, ...rows].join('\n');
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.child) {
    process.stdout.write(`${JSON.stringify(await child(opt.child))}\n`);
    return;
  }
  const clips = await ensureClips(opt.dir, opt.sizes);
  const results = [];
  for (const reader of opt.readers) {
    for (const clip of clips) {
      for (const concurrency of opt.concurrency) {
        const r = await runChild({ reader, file: clip.file, concurrency, rounds: opt.rounds });
        results.push(r);
        process.stderr.write(`${reader} ${MiB(clip.bytes)} MiB x${concurrency}: rss ${MiB(r.peak.rss)} MiB, arrayBuffers ${MiB(r.peak.arrayBuffers)} MiB\n`);
      }
    }
  }
  const text = `${table(results)}\n\nNode ${process.version}, ${os.cpus().length} CPUs; clips in ${opt.dir}; ${opt.rounds} round(s) per case.\n`;
  process.stdout.write(text);
  if (opt.json) fs.writeFileSync(opt.json, `${JSON.stringify({ node: process.version, at: new Date().toISOString(), results }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`clipMemory.js: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { teslaRecord, table };
