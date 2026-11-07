'use strict';

// Export: a stretch of footage (from a start in one clip to an end in the
// same or a later one) rendered on the server into one MP4: the cameras in a
// grid, or one camera, with the date, time and speed burned in. It runs as a
// job (one at a time, others wait), the file is kept in <data>/exports for a
// day, and the page downloads it from there.
//
// Each clip's part is rendered on its own (inputs seeked to the part, the
// cameras scaled into their tiles, the overlay from an ASS file), then the
// parts are joined without encoding again. H.264 with libx264, the format
// every phone, browser and editor plays.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn: realSpawn } = require('child_process');

const CAMS = ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar'];
const CAM_NAME = { front: 'Front', back: 'Rear', left_repeater: 'Left repeater', right_repeater: 'Right repeater', left_pillar: 'Left pillar', right_pillar: 'Right pillar' };
// the grid as the cameras sit on the car: pillars beside the front, the
// repeaters beside the rear (HW3 cars have no pillars: two by two)
const GRID6 = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
const GRID4 = ['front', 'back', 'left_repeater', 'right_repeater'];
const TILE_W = 640;
const TILE_H = 480;
const FPS = 30;
const MAX_SECONDS = 60 * 60;
const MAX_CLIPS = 120;
const KEEP_MS = 24 * 3600 * 1000;
const KEEP_FILES = 10;
const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/;
const MPS = { mph: 2.23694, kmh: 3.6 };

class ExportError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.expose = true;
  }
}

/** The clip's start as wall-clock parts (the car's own local time). */
function keyParts(key) {
  const m = KEY_RE.exec(String(key || ''));
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] };
}

/** "2026-11-03 10:00:05 AM" (or 24-hour) for a clip key plus seconds. */
function wallAt(key, seconds, clock24 = false) {
  const p = keyParts(key);
  if (!p) return '';
  const t = new Date(Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) + Math.floor(seconds) * 1000);
  const two = (n) => String(n).padStart(2, '0');
  const date = `${t.getUTCFullYear()}-${two(t.getUTCMonth() + 1)}-${two(t.getUTCDate())}`;
  const h = t.getUTCHours();
  const clock = clock24
    ? `${two(h)}:${two(t.getUTCMinutes())}:${two(t.getUTCSeconds())}`
    : `${h % 12 || 12}:${two(t.getUTCMinutes())}:${two(t.getUTCSeconds())} ${h < 12 ? 'AM' : 'PM'}`;
  return `${date} ${clock}`;
}

/**
 * Check a request and put it in order. clips: [{ key, files: { camera: path },
 * from, to }] in playing order, from/to in seconds into each clip.
 */
function normalize(body) {
  const clips = Array.isArray(body?.clips) ? body.clips : [];
  if (!clips.length) throw new ExportError('Choose a start and an end first.');
  if (clips.length > MAX_CLIPS) throw new ExportError(`An export can cover up to ${MAX_CLIPS} clips (two hours of footage); choose a shorter stretch.`);
  const out = clips.map((c, i) => {
    if (!keyParts(c?.key)) throw new ExportError(`Clip ${i + 1} has no valid time.`);
    const files = {};
    for (const [cam, p] of Object.entries(c.files || {})) {
      if (CAMS.includes(cam) && typeof p === 'string' && p) files[cam] = p;
    }
    if (!Object.keys(files).length) throw new ExportError(`The clip at ${wallAt(c.key, 0)} has no video.`);
    const from = Number(c.from);
    const to = Number(c.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > 600 || to - from < 0.5) {
      throw new ExportError(`The clip at ${wallAt(c.key, 0)} has no time to export.`);
    }
    return { key: c.key, files, from, to };
  });
  const seconds = out.reduce((n, c) => n + (c.to - c.from), 0);
  if (seconds > MAX_SECONDS) throw new ExportError('An export can be up to 60 minutes long; choose a shorter stretch.');
  const camera = body?.camera === 'grid' || body?.camera === undefined ? 'grid' : String(body.camera);
  if (camera !== 'grid' && !CAMS.includes(camera)) throw new ExportError('Choose all cameras or one camera.');
  if (camera !== 'grid' && !out.some((c) => c.files[camera])) throw new ExportError(`None of these clips has the ${CAM_NAME[camera]} camera.`);
  const units = body?.units === 'kmh' ? 'kmh' : 'mph';
  return { clips: out, camera, units, seconds };
}

/** The picture: one camera, or a grid of the cameras these clips have. */
function layoutFor(clips, camera) {
  if (camera !== 'grid') return { cams: [camera], cols: 1, rows: 1, w: null, h: null };
  const pillars = clips.some((c) => c.files.left_pillar || c.files.right_pillar);
  const cams = pillars ? GRID6 : GRID4;
  const cols = pillars ? 3 : 2;
  return { cams, cols, rows: 2, w: cols * TILE_W, h: 2 * TILE_H };
}

// ASS subtitles: the date, time and speed bar (bottom left), and in a grid
// each tile's camera name (top left of its tile).
function assEscape(s) {
  return String(s).replace(/[{}\\]/g, '');
}
function assTime(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/**
 * The overlay for one clip's part. speeds: m/s for each second of the clip
 * (the speed index), or null; width/height: the picture's size.
 */
function overlayAss({ clip, speeds, units, clock24, width, height, layout }) {
  const size = Math.max(16, Math.round(height * 0.035));
  const small = Math.max(13, Math.round(size * 0.7));
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Bar,DejaVu Sans,${size},&H00FFFFFF,&H00FFFFFF,&H99000000,&H99000000,1,0,0,0,100,100,0,0,3,${Math.round(size * 0.35)},0,1,${Math.round(size * 0.6)},0,${Math.round(size * 0.6)},1`,
    `Style: Cam,DejaVu Sans,${small},&H00FFFFFF,&H00FFFFFF,&H99000000,&H99000000,1,0,0,0,100,100,0,0,3,${Math.round(small * 0.3)},0,7,0,0,0,1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];
  const dur = clip.to - clip.from;
  // one line a second, on the second of the clip it shows
  const first = Math.floor(clip.from);
  for (let sec = first; sec < clip.to; sec++) {
    const a = Math.max(0, sec - clip.from);
    const b = Math.min(dur, sec + 1 - clip.from);
    if (b <= a) continue;
    const v = Array.isArray(speeds) ? speeds[sec] : null;
    const speed = typeof v === 'number' && Number.isFinite(v) ? `   ${Math.round(Math.abs(v) * MPS[units])} ${units === 'mph' ? 'mph' : 'km/h'}` : '';
    lines.push(`Dialogue: 0,${assTime(a)},${assTime(b)},Bar,,0,0,0,,${assEscape(wallAt(clip.key, sec, clock24))}${assEscape(speed)}`);
  }
  if (layout.cols > 1 || layout.rows > 1) {
    layout.cams.forEach((cam, i) => {
      const x = (i % layout.cols) * TILE_W + 8;
      const y = Math.floor(i / layout.cols) * TILE_H + 8;
      lines.push(`Dialogue: 0,${assTime(0)},${assTime(dur)},Cam,,0,0,0,,{\\pos(${x},${y})}${assEscape(CAM_NAME[cam])}`);
    });
  }
  return `${lines.join('\n')}\n`;
}

/** ffmpeg's arguments for one clip's part (run in the work folder). */
// How each H.264 encoder is run: global options (before the inputs), the end
// of the filter chain (the frame format it takes; VA-API uploads to the GPU)
// and its own settings, at about the CPU's quality (CRF 23).
const VAAPI_DEVICE = '/dev/dri/renderD128';
const ENCODERS = {
  libx264: { pre: [], tail: 'format=yuv420p', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'] },
  h264_nvenc: { pre: [], tail: 'format=yuv420p', args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0'] },
  h264_qsv: { pre: [], tail: 'format=nv12', args: ['-c:v', 'h264_qsv', '-global_quality', '23'] },
  h264_vaapi: { pre: ['-vaapi_device', VAAPI_DEVICE], tail: 'format=nv12,hwupload', args: ['-c:v', 'h264_vaapi', '-rc_mode', 'CQP', '-qp', '23'] }
};
// tried in this order on the first export; the first that works is used
const GPU_ENCODERS = ['h264_nvenc', 'h264_qsv', 'h264_vaapi'];

function partArgs({ clip, layout, assName, outName, encoder = 'libx264' }) {
  const dur = clip.to - clip.from;
  const enc = ENCODERS[encoder] || ENCODERS.libx264;
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...enc.pre];
  const filters = [];
  const tiles = [];
  layout.cams.forEach((cam, i) => {
    const file = clip.files[cam];
    if (file) {
      args.push('-ss', clip.from.toFixed(3), '-t', dur.toFixed(3), '-i', file);
    } else {
      // a camera this clip lacks: a black tile
      args.push('-f', 'lavfi', '-t', dur.toFixed(3), '-i', `color=c=black:s=${TILE_W}x${TILE_H}:r=${FPS}`);
    }
    if (layout.cols === 1 && layout.rows === 1) {
      filters.push(`[${i}:v]scale=w='min(iw,1920)':h=-2,setsar=1,fps=${FPS}[v${i}]`);
    } else {
      filters.push(`[${i}:v]scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=decrease,pad=${TILE_W}:${TILE_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}[v${i}]`);
    }
    tiles.push(`[v${i}]`);
  });
  let last = 'v0';
  if (tiles.length > 1) {
    const pos = layout.cams.map((_, i) => `${(i % layout.cols) * TILE_W}_${Math.floor(i / layout.cols) * TILE_H}`).join('|');
    filters.push(`${tiles.join('')}xstack=inputs=${tiles.length}:layout=${pos}:fill=black[grid]`);
    last = 'grid';
  }
  filters.push(`[${last}]subtitles=${assName},${enc.tail}[out]`);
  args.push('-filter_complex', filters.join(';'), '-map', '[out]', '-t', dur.toFixed(3), '-an',
    ...enc.args, '-r', String(FPS), '-movflags', '+faststart', outName);
  return args;
}

/** The size of one camera's picture (the single-camera output follows it). */
function probeSize(ffprobe, file, spawn = realSpawn) {
  return new Promise((resolve) => {
    const p = spawn(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const m = /^(\d+)x(\d+)/.exec(out.trim());
      resolve(m ? { w: +m[1], h: +m[2] } : null);
    });
  });
}

function createExporter({ dir, ffmpegPath = 'ffmpeg', ffprobePath = null, jobs, log = console, resolve, speedsFor = async () => null, clock24 = () => false, spawn = realSpawn, now = Date.now,
  gpu = process.env.EXPORT_ENCODER !== 'cpu', gpuEncoders = GPU_ENCODERS }) {
  const ffprobe = ffprobePath || (ffmpegPath.endsWith('ffmpeg') ? `${ffmpegPath.slice(0, -6)}ffprobe` : 'ffprobe');

  // The GPU's H.264 encoder, found once: each is tried on a few frames of a
  // still picture, and the first that works renders exports (several times
  // faster than the CPU, which then stays free for playback and
  // conversions). None, or EXPORT_ENCODER=cpu: libx264, as before.
  let chosen = null;
  function tryEncoder(name) {
    const enc = ENCODERS[name];
    if (!enc) return Promise.resolve(false);
    return new Promise((ok) => {
      let p;
      try {
        p = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...enc.pre, '-f', 'lavfi', '-i', `color=c=black:s=320x240:r=${FPS}`,
          '-frames:v', '5', '-vf', enc.tail, ...enc.args, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'ignore'] });
      } catch {
        ok(false);
        return;
      }
      const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 15000);
      p.on('error', () => { clearTimeout(timer); ok(false); });
      p.on('close', (code) => { clearTimeout(timer); ok(code === 0); });
    });
  }
  function encoderFor() {
    if (!chosen) {
      chosen = (async () => {
        if (!gpu) return 'libx264';
        for (const name of gpuEncoders) if (await tryEncoder(name)) { log.info?.(`Exports render on the GPU (${name})`); return name; }
        return 'libx264';
      })();
    }
    return chosen;
  }
  const all = new Map(); // id -> export
  const queue = [];
  let running = null;

  function pub(x) {
    return {
      id: x.id, vehicleId: x.vehicleId, state: x.state, seconds: x.seconds, done: Math.min(x.seconds, x.doneSeconds),
      progress: x.seconds ? Math.min(1, x.doneSeconds / x.seconds) : 0, bytes: x.bytes || 0, error: x.error || null,
      name: x.name, title: x.title, notes: x.notes || [], createdAt: x.createdAt, finishedAt: x.finishedAt || null, jobId: x.jobId
    };
  }

  async function tidy() {
    await fsp.mkdir(dir, { recursive: true });
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const st = await fsp.stat(p).catch(() => null);
      const known = all.get(e.name.replace(/\.mp4$/, ''));
      if (known && ['waiting', 'running'].includes(known.state)) continue;
      if (!st || now() - st.mtimeMs > KEEP_MS || (!known && e.isDirectory())) await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
    }
    // only the newest few finished files stay
    const done = [...all.values()].filter((x) => x.state === 'done').sort((a, b) => b.finishedAt - a.finishedAt);
    for (const x of done.slice(KEEP_FILES)) {
      await fsp.rm(x.file, { force: true }).catch(() => {});
      x.state = 'expired';
    }
    for (const x of all.values()) {
      if (x.state === 'done' && now() - x.finishedAt > KEEP_MS) {
        await fsp.rm(x.file, { force: true }).catch(() => {});
        x.state = 'expired';
      }
    }
  }

  // Each clip as one part (renamed part-<n>.mp4), with the given encoder.
  async function renderParts(x, layout, work, encoder, notes) {
    const parts = [];
    for (let i = 0; i < x.clips.length; i++) {
      if (x.cancel) throw new Error('cancelled');
      const clip = x.clips[i];
      // a damaged camera file (Tesla leaves one when the car powers down
      // mid-clip) shows as a black tile; a clip with none that opens is
      // left out, so one bad file never sinks the whole export
      for (const cam of Object.keys(clip.files)) {
        if (!layout.cams.includes(cam)) { delete clip.files[cam]; continue; }
        if (!(await probeSize(ffprobe, clip.files[cam], spawn))) {
          delete clip.files[cam];
          notes.push(`${CAM_NAME[cam]} at ${wallAt(clip.key, 0, clock24()).slice(11)} could not be read (black)`);
        }
      }
      if (!layout.cams.some((c) => clip.files[c])) {
        notes.push(`the clip at ${wallAt(clip.key, 0, clock24()).slice(11)} could not be read (left out)`);
        x.doneSeconds += clip.to - clip.from;
        continue;
      }
      const front = clip.files.front || clip.files[layout.cams.find((c) => clip.files[c])] || Object.values(clip.files)[0];
      const speeds = await speedsFor(front).catch(() => null);
      const assName = `part-${i}.ass`;
      const outName = `part-${i}.mp4`;
      await fsp.writeFile(path.join(work, assName), overlayAss({ clip, speeds, units: x.units, clock24: clock24(), width: layout.w, height: layout.h, layout }));
      await ffmpeg(x, partArgs({ clip, layout, assName, outName, encoder }), work, clip.to - clip.from);
      parts.push(outName);
    }
    return parts;
  }

  async function run(x) {
    running = x;
    x.state = 'running';
    jobs.update(x.jobId, { status: 'running', detail: 'Starting…' });
    const work = path.join(dir, `${x.id}.work`);
    await fsp.mkdir(work, { recursive: true });
    try {
      const layout = layoutFor(x.clips, x.camera);
      if (x.camera !== 'grid') {
        const sample = x.clips.find((c) => c.files[x.camera]).files[x.camera];
        const s = await probeSize(ffprobe, sample, spawn);
        const w = Math.min(1920, s?.w || 1280);
        layout.w = w - (w % 2);
        const h = s ? Math.round((s.h * layout.w) / s.w) : 960;
        layout.h = h - (h % 2);
      }
      // on the GPU when there is one; a GPU that fails part way renders the
      // whole export again on the CPU (parts of both could not be joined)
      let encoder = await encoderFor();
      let parts;
      const notes = [];
      try {
        parts = await renderParts(x, layout, work, encoder, notes);
      } catch (err) {
        if (x.cancel || encoder === 'libx264') throw err;
        log.warn(`Export ${x.id}: the GPU encoder (${encoder}) failed (${err.message}); rendering on the CPU`);
        chosen = Promise.resolve('libx264');
        encoder = 'libx264';
        x.doneSeconds = 0;
        parts = await renderParts(x, layout, work, encoder, notes);
      }
      x.encoder = encoder;
      if (x.cancel) throw new Error('cancelled');
      if (!parts.length) throw new Error('none of these clips could be read');
      await fsp.writeFile(path.join(work, 'parts.txt'), parts.map((p) => `file '${p}'`).join('\n'));
      jobs.update(x.jobId, { detail: 'Joining the clips…' });
      await ffmpeg(x, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'parts.txt', '-c', 'copy', '-movflags', '+faststart', 'export.mp4'], work, 0);
      await fsp.rename(path.join(work, 'export.mp4'), x.file);
      x.bytes = (await fsp.stat(x.file)).size;
      x.state = 'done';
      x.finishedAt = now();
      x.doneSeconds = x.seconds;
      x.notes = notes;
      jobs.finish(x.jobId, { detail: `Ready to download: ${clockLen(x.seconds)}, ${mb(x.bytes)}${x.encoder && x.encoder !== 'libx264' ? ', made on the GPU' : ''}. Kept for a day.${notes.length ? ` Note: ${notes.slice(0, 5).join('; ')}${notes.length > 5 ? `, and ${notes.length - 5} more` : ''}.` : ''}`, result: { export: x.id } });
    } catch (err) {
      x.finishedAt = now();
      if (x.cancel) {
        x.state = 'cancelled';
        jobs.finish(x.jobId, { status: 'cancelled', detail: 'Cancelled.' });
      } else {
        x.state = 'failed';
        x.error = err.message;
        log.warn(`Export ${x.id} failed: ${err.message}`);
        jobs.finish(x.jobId, { status: 'failed', detail: `The export failed: ${err.message}` });
      }
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
      running = null;
      const next = queue.shift();
      if (next) run(next);
    }
  }

  function ffmpeg(x, args, cwd, partSeconds) {
    return new Promise((ok, fail) => {
      const p = spawn(ffmpegPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      x.proc = p;
      try { os.setPriority(p.pid, 10); } catch { /* not allowed: normal priority */ }
      const base = x.doneSeconds;
      let err = '';
      let lastUpdate = 0;
      p.stdout.on('data', (d) => {
        const m = /out_time_us=(\d+)/.exec(String(d).split('\n').filter((l) => l.startsWith('out_time_us=')).pop() || '');
        if (!m || !partSeconds) return;
        x.doneSeconds = base + Math.min(partSeconds, Number(m[1]) / 1e6);
        if (now() - lastUpdate > 1000) {
          lastUpdate = now();
          jobs.update(x.jobId, { detail: `Rendering ${clockLen(x.doneSeconds)} of ${clockLen(x.seconds)} (${Math.round((x.doneSeconds / x.seconds) * 100)}%)` });
        }
      });
      p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
      p.on('error', (e) => fail(e));
      p.on('close', (code) => {
        x.proc = null;
        if (code === 0) {
          x.doneSeconds = base + partSeconds;
          ok();
        } else fail(new Error(x.cancel ? 'cancelled' : (err.trim().split('\n').pop() || `ffmpeg exited with ${code}`)));
      });
    });
  }

  return {
    /** Check a request, queue the export and return it (its job shows the progress). */
    async start({ vehicle, body }) {
      const req = normalize(body);
      // every file must be a real file of this vehicle's footage
      for (const clip of req.clips) {
        for (const [cam, p] of Object.entries(clip.files)) {
          const real = await resolve(p, vehicle);
          if (!real) throw new ExportError(`The ${CAM_NAME[cam]} file of the clip at ${wallAt(clip.key, 0)} is not in ${vehicle.name}'s footage.`);
          clip.files[cam] = real;
        }
      }
      const id = crypto.randomBytes(8).toString('hex');
      const first = req.clips[0];
      const last = req.clips[req.clips.length - 1];
      const from = wallAt(first.key, first.from, clock24());
      const to = wallAt(last.key, last.to, clock24()).slice(11);
      const name = `Sentry ${vehicle.name} ${from.replace(/:/g, '-')}.mp4`.replace(/[\\/"<>|?*]/g, '');
      const title = `Export ${vehicle.name}: ${from} to ${to}${req.camera === 'grid' ? '' : ` (${CAM_NAME[req.camera]})`}`;
      const x = {
        id, vehicleId: vehicle.id, ...req, state: 'waiting', doneSeconds: 0, name, title,
        file: path.join(dir, `${id}.mp4`), createdAt: now(), proc: null, cancel: false
      };
      x.jobId = jobs.start({ type: 'export', vehicleId: vehicle.id, title, detail: running ? 'Waiting for the export before it…' : 'Starting…' });
      all.set(id, x);
      await fsp.mkdir(dir, { recursive: true });
      if (running) queue.push(x);
      else run(x);
      return pub(x);
    },
    get(id) {
      const x = all.get(id);
      return x ? pub(x) : null;
    },
    list(vehicleId = null) {
      return [...all.values()].filter((x) => !vehicleId || x.vehicleId === vehicleId).map(pub).reverse();
    },
    /** The finished file and its download name, or null. */
    file(id) {
      const x = all.get(id);
      if (!x || x.state !== 'done' || !fs.existsSync(x.file)) return null;
      return { file: x.file, name: x.name };
    },
    cancel(id) {
      const x = all.get(id);
      if (!x || !['waiting', 'running'].includes(x.state)) return false;
      x.cancel = true;
      const q = queue.indexOf(x);
      if (q >= 0) {
        queue.splice(q, 1);
        x.state = 'cancelled';
        jobs.finish(x.jobId, { status: 'cancelled', detail: 'Cancelled.' });
      } else if (x.proc) x.proc.kill('SIGKILL');
      return true;
    },
    tidy,
    stop() {
      for (const x of all.values()) if (x.proc) { x.cancel = true; x.proc.kill('SIGKILL'); }
    }
  };
}

function clockLen(s) {
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
function mb(b) {
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`;
}

module.exports = { createExporter, normalize, layoutFor, overlayAss, partArgs, wallAt, ExportError, MAX_SECONDS, MAX_CLIPS, CAM_NAME, GPU_ENCODERS };
