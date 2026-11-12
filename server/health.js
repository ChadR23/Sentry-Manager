'use strict';

// Health checks: what the app needs to work, each with what to do when it
// does not. Settings → Health runs them on request; at every start they run
// once by themselves (the startup self-check) a minute after the app is up,
// and what fails becomes a notification and the amber bar at the top of
// every page (web/critical.js), so a broken update or a lost GPU does not
// fail silently.
//
// A check: { id, group, label, status: 'ok' | 'warn' | 'bad' | 'skip', detail, hint }

const fs = require('fs');
const path = require('path');
const { spawn: realSpawn } = require('child_process');
const { usableGpus } = require('./gpu');

const GB = 1024 ** 3;

function firstLine(cmd, args, { spawn = realSpawn, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < 4096) out += d; });
    child.once('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
    child.once('close', (code) => { clearTimeout(timer); resolve(code === 0 ? { ok: true, line: out.split('\n')[0].trim() } : { ok: false, error: `exit ${code}` }); });
  });
}

async function writable(dir) {
  const probe = path.join(dir, `.health-${process.pid}-${Date.now()}`);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(probe, 'ok');
    await fs.promises.unlink(probe);
    return null;
  } catch (err) {
    return err.code || err.message;
  }
}

const size = (b) => (b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);

function createHealth({
  db, dataDir, vehicles, ffmpegPath, ffprobePath, spawn = realSpawn, diskSpace,
  runtime = () => null, detectGpus = async () => [], snapshots = null, tls = () => null, log
}) {
  let last = null; // the newest results: { at, checks, startup }
  let running = null;

  async function checks() {
    const out = [];
    const add = (c) => out.push({ detail: '', hint: '', ...c });

    // ---- the data folder and what lives in it
    const dataErr = await writable(dataDir);
    add({
      id: 'data-writable', group: 'Data folder', label: 'The data folder can be written',
      status: dataErr ? 'bad' : 'ok', detail: dataErr ? `Writing failed: ${dataErr}` : '',
      hint: dataErr ? 'Check that the data volume is mounted and owned by the PUID/PGID the app runs as.' : ''
    });
    const free = await diskSpace(dataDir).then((s) => s.free).catch(() => null);
    add({
      id: 'data-space', group: 'Data folder', label: 'Free space for the data folder',
      status: free === null ? 'skip' : free < 0.5 * GB ? 'bad' : free < 2 * GB ? 'warn' : 'ok',
      detail: free === null ? 'Could not be read.' : `${size(free)} free`,
      hint: free !== null && free < 2 * GB ? 'Previews, thumbnails and conversions need room here; free some space on the disk the data folder is on.' : ''
    });
    for (const sub of ['scrub', 'thumbnails', 'speeds', 'converter-temp']) {
      const err = dataErr ? null : await writable(path.join(dataDir, sub));
      if (err) add({ id: `cache-${sub}`, group: 'Data folder', label: `data/${sub} can be written`, status: 'bad', detail: err, hint: 'A folder made by another user (root) cannot be written: fix its owner to the PUID/PGID.' });
    }
    if (!out.some((c) => c.id.startsWith('cache-'))) add({ id: 'caches', group: 'Data folder', label: 'Cache folders can be written', status: dataErr ? 'skip' : 'ok' });
    try {
      const row = db.db.prepare('PRAGMA quick_check').get();
      const ok = Object.values(row || {})[0] === 'ok';
      add({ id: 'database', group: 'Data folder', label: 'Database is intact', status: ok ? 'ok' : 'bad', detail: ok ? '' : String(Object.values(row || {})[0] || 'quick_check failed'), hint: ok ? '' : 'Restore yesterday\'s snapshot below.' });
    } catch (err) {
      add({ id: 'database', group: 'Data folder', label: 'Database is intact', status: 'bad', detail: err.message, hint: 'Restore a snapshot below.' });
    }
    if (snapshots) {
      const newest = snapshots.list()[0];
      const age = newest?.at ? (Date.now() - newest.at) / 86400000 : null;
      add({
        id: 'snapshots', group: 'Data folder', label: 'Daily database snapshot',
        status: !newest ? 'warn' : age > 2 ? 'warn' : 'ok',
        detail: newest ? `Newest: ${newest.day}` : 'None yet: the first is made a minute after the app starts.',
        hint: newest && age > 2 ? 'Snapshots are not being made: check that the data folder can be written.' : ''
      });
    }

    // ---- footage shares
    for (const v of vehicles.list()) {
      const st = vehicles.share(v.id)?.status?.() || null;
      const group = `Vehicle: ${v.name}`;
      if (!st) { add({ id: `share-${v.id}`, group, label: 'Footage share', status: 'skip' }); continue; }
      add({
        id: `share-${v.id}`, group, label: 'Footage can be read', status: st.healthy ? 'ok' : 'bad',
        detail: st.healthy ? '' : (st.lastError || 'The share cannot be read.'),
        hint: st.healthy ? '' : (st.hint || 'Check that the NAS or PC sharing the footage is on, and the share name, user and password in Vehicles.')
      });
      if (st.healthy) {
        add({
          id: `write-${v.id}`, group, label: 'Footage share can be written', status: st.writable === false ? 'warn' : st.writable ? 'ok' : 'skip',
          detail: st.writable === false ? (st.lastError || 'Read-only.') : '',
          hint: st.writable === false ? 'Conversions, the Recycle Bin and restoring need write access: give the share user write permission.' : ''
        });
        const ratio = st.totalBytes ? st.freeBytes / st.totalBytes : null;
        add({
          id: `space-${v.id}`, group, label: 'Free space on the share', status: ratio === null ? 'skip' : ratio < 0.05 ? 'bad' : ratio < 0.1 ? 'warn' : 'ok',
          detail: ratio === null ? '' : `${size(st.freeBytes)} free of ${size(st.totalBytes)}`,
          hint: ratio !== null && ratio < 0.1 ? 'Empty the Recycle Bin, convert footage, or set a policy to move old footage out.' : ''
        });
        if (st.warning) add({ id: `warning-${v.id}`, group, label: 'Share set-up', status: 'warn', detail: st.warning });
      }
    }

    // ---- video tools
    const ff = await firstLine(ffmpegPath, ['-hide_banner', '-version'], { spawn });
    add({ id: 'ffmpeg', group: 'Video', label: 'ffmpeg runs', status: ff.ok ? 'ok' : 'bad', detail: ff.ok ? ff.line.replace(/ Copyright.*/, '') : ff.error, hint: ff.ok ? '' : 'The image is damaged: pull it again (docker compose pull && docker compose up -d).' });
    const fp = await firstLine(ffprobePath, ['-hide_banner', '-version'], { spawn });
    add({ id: 'ffprobe', group: 'Video', label: 'ffprobe runs', status: fp.ok ? 'ok' : 'bad', detail: fp.ok ? '' : fp.error, hint: fp.ok ? '' : 'The image is damaged: pull it again.' });
    // detectGpus() gives { gpus, nvidia, hints }: the GPUs this container can
    // use are the passed-in /dev/dri ones (not virtual) and NVIDIA in the container
    const gpus = usableGpus(await detectGpus().catch(() => null));
    const rt = runtime();
    if (!rt) {
      add({ id: 'encoder', group: 'Video', label: 'Converter', status: 'warn', detail: 'The converter has not started.', hint: 'See the logs below for why.' });
    } else if (rt.encodingNow?.()) {
      add({ id: 'encoder', group: 'Video', label: 'GPU encoder', status: 'skip', detail: 'Not tested while something converts (a busy GPU would fail the test).' });
    } else {
      let chosen = null;
      try {
        chosen = await Promise.race([rt.selectEncoder('h265'), new Promise((r) => setTimeout(() => r(null), 90_000))]);
      } catch { chosen = null; }
      const hw = chosen && chosen.hardware === true;
      add({
        id: 'encoder', group: 'Video', label: gpus.length ? 'GPU encoder works' : 'Encoder',
        status: hw ? 'ok' : gpus.length ? 'warn' : chosen ? 'ok' : 'bad',
        detail: chosen ? `${hw ? 'Converting with' : 'Converting on the CPU with'} ${chosen.codec}${gpus.length && !hw ? ` (${gpus.length} GPU${gpus.length === 1 ? '' : 's'} visible)` : ''}` : 'No encoder passed its test.',
        hint: gpus.length && !hw ? 'The GPU is visible but its encoder failed a test encode: check the /dev/dri (AMD, Intel) or NVIDIA lines in docker-compose.yml and the host\'s GPU driver.' : !chosen ? 'See the logs below.' : ''
      });
    }

    // ---- access
    const t = tls();
    if (t) add({ id: 'https', group: 'Access', label: 'HTTPS', status: t.mode === 'off' ? (t.trustProxy ? 'ok' : 'warn') : t.error ? 'bad' : 'ok', detail: t.detail || '', hint: t.mode === 'off' && !t.trustProxy ? 'Plain HTTP: only use it behind a reverse proxy that does HTTPS.' : '' });
    return out;
  }

  /** Run every check (one run at a time). */
  async function run({ startup = false } = {}) {
    if (running) return running;
    running = checks().then((list) => {
      last = { at: Date.now(), checks: list, startup };
      return last;
    }).finally(() => { running = null; });
    return running;
  }

  return { run, last: () => last };
}

module.exports = { createHealth };
