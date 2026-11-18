#!/usr/bin/env node
'use strict';

// A local Sentry Six Manager on a small, made-up TeslaCam archive, for
// recording and comparing the API contract without a real car:
//
//   node tools/contract/fixture.js --dir /tmp/sm-contract [--port 8443] [--settle 75] [--build-only]
//
// Builds <dir>/footage (the same files every time: real H.264 clips made by
// ffmpeg with Tesla telemetry, GPS and speed, plus Sentry and Saved events),
// then starts server/index.js with its own HTTPS (a self-signed certificate)
// waits --settle seconds (75: the jobs a server runs a minute after it starts)
// and prints one JSON line: { base, dir, pid, user, passwordEnv }. The
// password is SM_CONTRACT_PASSWORD (default "contract fixture password"); the
// server is stopped with Ctrl+C or SIGTERM.
//
// Nothing outside <dir> is written; nothing is sent anywhere.

const fs = require('fs');
const fsp = require('fs/promises');
const https = require('https');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..', '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? def : process.argv[i + 1];
}

/** One frame's Tesla telemetry: gear Drive, frame number, speed (m/s), GPS, heading. */
function seiRecord(frame, speed, lat, lon, heading) {
  const f32 = (n) => { const b = Buffer.alloc(4); b.writeFloatLE(n); return b; };
  const f64 = (n) => { const b = Buffer.alloc(8); b.writeDoubleLE(n); return b; };
  const varint = (n) => { const out = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); };
  return Buffer.concat([
    Buffer.from([0x08, 0x01]), // version 1
    Buffer.from([0x10, 0x01]), // gear Drive
    Buffer.from([0x18]), varint(frame),
    Buffer.from([0x25]), f32(speed),
    Buffer.from([0x59]), f64(lat),
    Buffer.from([0x61]), f64(lon),
    Buffer.from([0x69]), f64(heading)
  ]);
}

const CAMERAS = ['front', 'back', 'left_repeater', 'right_repeater'];
// [folder, event folder or null, clip start, seconds, start speed m/s, lat, lon]
const CLIPS = [
  ['RecentClips', null, '2024-05-01_08-00-00', 3, 10, 30.2672, -97.7431],
  ['RecentClips', null, '2024-05-01_08-01-00', 3, 14, 30.2690, -97.7410],
  ['RecentClips', null, '2024-05-01_17-30-00', 2, 0, 30.4000, -97.7000],
  ['SentryClips', '2024-05-02_12-30-00', '2024-05-02_12-29-00', 2, 0, 30.2500, -97.7500],
  ['SavedClips', '2024-05-03_10-00-00', '2024-05-03_09-59-00', 2, 20, 30.3000, -97.8000]
];

async function buildFootage(root) {
  const { createTeslaH264Fixture } = require(path.join(REPO, 'test/fixtures/ffmpegFixtures'));
  const T = path.join(root, 'TeslaCam');
  const fps = 12;
  for (const [folder, event, start, secs, speed, lat, lon] of CLIPS) {
    const dir = path.join(T, folder, ...(event ? [event] : []));
    await fsp.mkdir(dir, { recursive: true });
    for (const cam of CAMERAS) {
      const file = path.join(dir, `${start}-${cam}.mp4`);
      if (fs.existsSync(file)) continue;
      const pattern = Array.from({ length: secs * fps }, (_, i) => seiRecord(i, speed + i / fps, lat + i * 1e-5, lon + i * 1e-5, 90));
      await createTeslaH264Fixture({ ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg', outputPath: file, durationSeconds: secs, frameRate: fps, size: '320x240', telemetryPattern: pattern });
      // the same time on every run (the catalog shows file times)
      const t = new Date(`${start.slice(0, 10)}T${start.slice(11).replace(/-/g, ':')}Z`);
      await fsp.utimes(file, t, t);
    }
    if (event) {
      const json = path.join(dir, 'event.json');
      await fsp.writeFile(json, JSON.stringify({ timestamp: `${event.slice(0, 10)}T${event.slice(11).replace(/-/g, ':')}`, city: 'Austin', est_lat: String(lat), est_lon: String(lon), reason: folder === 'SentryClips' ? 'sentry_aware_object_detection' : 'user_interaction_honk', camera: '0' }));
    }
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// the fixture's own certificate, made by the server a moment ago: this
// health check alone skips verification (it sends no password)
const up = (base) => new Promise((resolve) => {
  const req = https.get(`${base}/healthz`, { rejectUnauthorized: false }, (res) => { res.resume(); resolve(res.statusCode === 200); });
  req.on('error', () => resolve(false));
  req.setTimeout(1000, () => { req.destroy(); resolve(false); });
});

async function start({ dir, port, env = {}, settleMs = 0 }) {
  await buildFootage(path.join(dir, 'footage'));
  port = port || await freePort();
  const password = process.env.SM_CONTRACT_PASSWORD || 'contract fixture password';
  const helper = path.join(REPO, 'build', 'noreplace-rename');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(REPO, 'server', 'index.js')], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_PATH: path.join(dir, 'data'), FOOTAGE_PATH: path.join(dir, 'footage'),
      VEHICLE_NAME: 'Contract Car', RUN_DIR: path.join(dir, 'run'), UI_PASSWORD: password, TZ: 'UTC', LOG_LEVEL: 'warn', TLS_MODE: 'auto',
      ...(fs.existsSync(helper) ? { SENTRY_NOREPLACE_RENAME: helper } : {}), ...env
    },
    stdio: ['ignore', 'inherit', 'inherit']
  });
  const base = `https://127.0.0.1:${port}`;
  for (let i = 0; i < 300 && !(await up(base)); i++) {
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode})`);
    await new Promise((r) => setTimeout(r, 100));
  }
  // what a server does by itself a minute after it starts (the health
  // self-check, the first database snapshot, the CAN index pass) is done
  // before anything is recorded or compared, so a new and an old server agree
  if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
  return { base, dir, pid: child.pid, child, user: 'admin', passwordEnv: 'SM_CONTRACT_PASSWORD', ca: path.join(dir, 'data', 'tls') };
}

if (require.main === module) {
  (async () => {
    const dir = path.resolve(arg('dir', path.join(require('os').tmpdir(), 'sm-contract')));
    await fsp.mkdir(dir, { recursive: true });
    if (process.argv.includes('--build-only')) {
      await buildFootage(path.join(dir, 'footage'));
      console.log(JSON.stringify({ footage: path.join(dir, 'footage') }));
      return;
    }
    const s = await start({ dir, port: Number(arg('port', 0)) || 0, settleMs: Number(arg('settle', 75)) * 1000 });
    console.log(JSON.stringify({ base: s.base, dir: s.dir, pid: s.pid, user: s.user, passwordEnv: s.passwordEnv }));
    const stop = () => s.child.kill('SIGTERM');
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    s.child.on('exit', (code) => process.exit(code || 0));
  })().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { start, buildFootage, seiRecord, CLIPS };
