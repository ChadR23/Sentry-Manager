#!/usr/bin/env node
// Sentry Six Manager speed benchmark: real numbers from your own machine and
// footage. Measures, and writes a Markdown report (plus the raw JSON):
//
//   install    pulling the image (--docker; --cold removes it first)
//   boot       a fresh container: until it answers, its first page, footage indexed
//   api        sign-in and the server's answers (median of 15)
//   pages      every page of the interface in use: first load and each page, desktop and phone
//   viewer     open a day (first picture, all cameras), seek, drag the timeline,
//              the next clip, camera sync
//   export     a one-minute video of all cameras (--export)
//   resources  the app's memory and CPU, idle
//
// It reads; it changes nothing on your server, except --export (one export,
// removed after a day like any other) and --all-packs (switches the interface
// for everyone while it measures, then puts yours back).
//
//   npm install && npx playwright install chromium
//   node benchmark.mjs --url https://192.168.1.57:9000 --user admin --password '...'
//   node benchmark.mjs --docker --footage D:\TeslaUSB ...   (also install and boot)
//
// Options: --url --user --password --vehicle <id> --day YYYY-MM-DD --docker
// --cold --image <ref> --footage <folder with TeslaCam, for the boot test>
// --export --all-packs --no-phone --out <report.md>

import { chromium, devices } from 'playwright';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';

// ---------- options ----------
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback; };
const flag = (name) => argv.includes(`--${name}`);
const A = {
  url: (opt('url') || '').replace(/\/$/, ''), user: opt('user', 'admin'), password: opt('password'),
  vehicle: opt('vehicle'), day: opt('day'), docker: flag('docker'), cold: flag('cold'),
  image: opt('image', 'ghcr.io/skittles-fivem/sentry-manager:latest'), footage: opt('footage'),
  export: flag('export'), allPacks: flag('all-packs'), phone: !flag('no-phone'),
  out: opt('out', `sentry-benchmark-${new Date().toISOString().slice(0, 10)}.md`)
};
if (!A.url && !A.docker) {
  console.error('Give --url https://<server>:9000 --user <name> --password <password> (and/or --docker).');
  process.exit(2);
}
// the server's own certificate (not one a browser knows): accepted for this run only
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.removeAllListeners('warning');

const R = { when: new Date().toISOString(), client: {}, server: {}, install: {}, boot: {}, api: {}, pages: {}, viewer: {}, export: {}, resources: {}, notes: [] };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const med = (a) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const pct = (a, p) => { const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const ms = (x) => (x == null ? '—' : x >= 10000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
const mb = (b) => (b == null ? '—' : `${Math.round(b / 1048576)} MB`);
const say = (...x) => console.log('·', ...x);
const sh = (cmd, args, timeout = 30 * 60 * 1000) => new Promise((res) => execFile(cmd, args, { timeout, maxBuffer: 64 << 20, windowsHide: true }, (err, stdout, stderr) => res({ ok: !err, out: String(stdout).trim(), err: String(stderr).trim() })));
const timed = async (fn) => { const t = performance.now(); const v = await fn(); return [performance.now() - t, v]; };

R.client = { os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model, threads: os.cpus().length, ramB: os.totalmem(), node: process.version };

// ---------- HTTP (API) ----------
function client(base) {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { 'X-Requested-With': 'sentry-six-manager', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
  const json = async (path, body, method) => { const r = await call(method || (body === undefined ? 'GET' : 'POST'), path, body); const t = await r.text(); try { return JSON.parse(t); } catch { return { status: r.status, text: t.slice(0, 200) }; } };
  return { call, json, cookie: () => cookie };
}

// ---------- A. install and boot (Docker on this machine) ----------
async function dockerPart() {
  const v = await sh('docker', ['version', '--format', '{{.Server.Version}}']);
  if (!v.ok) { R.notes.push(`Docker not reachable here (${v.err.slice(0, 120)}): install and boot not measured.`); return; }
  R.install.docker = v.out;
  if (A.cold) { await sh('docker', ['rmi', '-f', A.image]); say('removed the image for a cold pull'); }
  say('pulling', A.image, '…');
  const [pullMs, pull] = await timed(() => sh('docker', ['pull', A.image]));
  if (!pull.ok) { R.notes.push(`docker pull failed: ${pull.err.slice(0, 200)}`); return; }
  R.install.pullMs = pullMs;
  R.install.cold = A.cold;
  const size = await sh('docker', ['image', 'inspect', '-f', '{{.Size}}', A.image]);
  R.install.imageB = Number(size.out) || null;
  say('pull', ms(pullMs), mb(R.install.imageB));

  const name = `sentry-bench-${process.pid}`;
  const port = 9180;
  const pass = 'bench-only-password';
  const args = ['run', '-d', '--name', name, '-p', `${port}:9000`, '-v', `${name}:/data`,
    '-e', 'UI_USERNAME=admin', '-e', `UI_PASSWORD=${pass}`, '-e', 'UPDATE_CHECK=off', '-e', 'VEHICLE_NAME=Bench car'];
  if (A.footage) args.push('-v', `${A.footage}:/footage:ro`);
  args.push(A.image);
  const t0 = performance.now();
  const run = await sh('docker', args);
  if (!run.ok) { R.notes.push(`docker run failed: ${run.err.slice(0, 200)}`); return; }
  try {
    // until it answers (plain HTTP /healthz), then its sign-in page over HTTPS
    for (;;) {
      try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch { /* starting */ }
      if (performance.now() - t0 > 180000) throw new Error('did not answer within 3 minutes');
      await wait(100);
    }
    R.boot.healthyMs = performance.now() - t0;
    const login = await fetch(`https://127.0.0.1:${port}/login`).catch(() => null);
    R.boot.firstPageMs = login?.ok ? performance.now() - t0 : null;
    if (A.footage) {
      const c = client(`https://127.0.0.1:${port}`);
      for (let i = 0; i < 100; i++) { const r = await c.call('POST', '/api/auth/login', { username: 'admin', password: pass }); if (r.ok) break; await wait(300); }
      const t1 = performance.now();
      for (;;) {
        const vs = await c.json('/api/vehicles');
        const v0 = vs.vehicles?.[0];
        if (v0?.inventory?.recordings > 0 && !v0.scanning) { R.boot.indexMs = performance.now() - t0; R.boot.indexOnlyMs = performance.now() - t1; R.boot.recordings = v0.inventory.recordings; break; }
        if (performance.now() - t1 > 15 * 60000) { R.notes.push('Boot test: the footage was not indexed within 15 minutes.'); break; }
        await wait(500);
      }
    }
    say('boot', ms(R.boot.healthyMs), 'first page', ms(R.boot.firstPageMs), A.footage ? `indexed ${ms(R.boot.indexMs)}` : '');
    await wait(30000);
    const st = await sh('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}|{{.CPUPerc}}', name]);
    const [memTxt, cpuTxt] = st.out.split('|');
    R.boot.idleMemory = memTxt?.split('/')[0]?.trim() || null;
    R.boot.idleCpu = cpuTxt?.trim() || null;
  } catch (e) {
    R.notes.push(`Boot test: ${e.message}`);
  } finally {
    await sh('docker', ['rm', '-f', name]);
    await sh('docker', ['volume', 'rm', name]);
  }
}

// ---------- B. the server, its footage ----------
async function serverPart() {
  const c = client(A.url);
  const [loginMs, r] = await timed(() => c.call('POST', '/api/auth/login', { username: A.user, password: A.password }));
  if (!r.ok) throw new Error(`Sign-in failed (${r.status}): check --user and --password.`);
  R.api['Sign in'] = { median: loginMs };

  const stats = await c.json('/api/stats');
  R.server = {
    version: stats.host?.version, os: `${stats.host?.os || ''} ${stats.host?.kernel || ''}`.trim(), cpu: stats.cpu?.model, threads: stats.cpu?.threads ?? stats.cpu?.cores,
    ramB: stats.memory?.totalB, gpus: (stats.gpus || []).map((g) => g.name || g.model).filter(Boolean), ffmpeg: stats.host?.ffmpeg
  };
  const { vehicles = [] } = await c.json('/api/vehicles');
  const v = vehicles.find((x) => x.id === A.vehicle) || vehicles.filter((x) => x.inventory?.recordings).sort((a, b) => (b.inventory?.recordings || 0) - (a.inventory?.recordings || 0))[0];
  if (!v) throw new Error('No vehicle with footage on this server.');
  R.server.vehicles = vehicles.length;
  R.server.footage = vehicles.map((x) => ({ name: x.name, recordings: x.inventory?.recordings, bytes: x.inventory?.bytes, days: x.inventory?.days }));
  const daysRes = await c.json(`/api/vehicles/${encodeURIComponent(v.id)}/days?limit=60`);
  const day = A.day || (daysRes.days || []).filter((d) => d.minutes >= 3).sort((a, b) => (b.cameras - a.cameras) || (b.day < a.day ? -1 : 1))[0]?.day || daysRes.days?.[0]?.day;
  R.viewer.vehicle = v.name;
  R.viewer.day = day;
  const recs = (await c.json(`/api/vehicles/${encodeURIComponent(v.id)}/recordings?date=${day}&limit=500`)).recordings || [];
  const detail = recs[0] ? await c.json(`/api/vehicles/${encodeURIComponent(v.id)}/recordings/${encodeURIComponent(recs[0].id)}`) : null;
  const front = detail?.root && detail.frontRel ? `${detail.root}/${detail.frontRel}` : null;

  // the server's answers, median of 15 (the first one is not counted)
  const api = {
    'Vehicles': '/api/vehicles',
    'Days of footage': `/api/vehicles/${encodeURIComponent(v.id)}/days`,
    'One day\'s recordings': `/api/vehicles/${encodeURIComponent(v.id)}/recordings?date=${day}&limit=500`,
    'Server stats': '/api/stats',
    ...(front ? { 'A clip\'s telemetry': `/api/telemetry?path=${encodeURIComponent(front)}` } : {})
  };
  for (const [name, path] of Object.entries(api)) {
    const t = [];
    for (let i = 0; i < 16; i++) { const [d, res] = await timed(async () => { const x = await c.call('GET', path); await x.arrayBuffer(); return x; }); if (i && res.ok) t.push(d); }
    R.api[name] = { median: med(t), p95: pct(t, 0.95) };
  }
  if (front) {
    const t = [];
    for (let i = 0; i < 10; i++) { const [d] = await timed(async () => { const x = await c.call('GET', `/api/media?path=${encodeURIComponent(front)}&n=${i}`, undefined, { Range: `bytes=${i * 4000000}-${i * 4000000 + 1048575}` }); await x.arrayBuffer(); }); t.push(d); }
    R.api['First MB of a clip (from the footage)'] = { median: med(t), p95: pct(t, 0.95) };
    const [first, g] = await timed(async () => { const x = await c.call('GET', `/api/scrub?path=${encodeURIComponent(front)}`); await x.arrayBuffer(); return x; });
    const [again] = await timed(async () => { const x = await c.call('GET', `/api/scrub?path=${encodeURIComponent(front)}`); await x.arrayBuffer(); });
    if (g.ok) R.api['Timeline previews of a clip (one camera)'] = { median: again, first };
  }

  // export: one minute, all cameras
  if (A.export && detail) {
    const files = {};
    const key = detail.startKey;
    for (const rel of detail.files || []) {
      const m = String(rel).match(/(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-([a-z_]+)\.mp4$/i);
      if (m && m[1] === key) files[m[2]] = `${detail.root}/${rel}`;
    }
    if (!Object.keys(files).length && front) files.front = front;
    const [startMs, x] = await timed(() => c.json(`/api/vehicles/${encodeURIComponent(v.id)}/exports`, { clips: [{ key, files, from: 0, to: 60 }], camera: 'grid' }));
    if (x?.id) {
      const t0 = performance.now();
      let s = x;
      while (['waiting', 'running'].includes(s.state) && performance.now() - t0 < 30 * 60000) { await wait(1000); s = await c.json(`/api/exports/${x.id}`); }
      R.export = { cameras: Object.keys(files).length, state: s.state, seconds: 60, totalMs: performance.now() - t0 + startMs, error: s.error || null };
      say('export', s.state, ms(R.export.totalMs));
    } else R.notes.push(`Export not started: ${JSON.stringify(x).slice(0, 160)}`);
  }

  const st2 = await c.json('/api/stats');
  R.resources = { appB: st2.memory?.appB, cpu: st2.cpu?.app?.usage ?? null, hostUsedB: st2.memory?.usedB, hostTotalB: st2.memory?.totalB };
  const packs = await c.json('/api/ui-packs');
  return { c, v, day, active: packs.active?.id || packs.active || null, packs: (packs.packs || []).map((p) => p.id) };
}

// ---------- C. in a browser ----------
const VIEW = {
  builtin: { url: (v, day) => `/studio/index.html?${new URLSearchParams({ embed: 'viewer', root: v.studioRoot || v.root, vehicle: v.id, date: day })}`, tl: '#progressBar', play: '#playBtn' },
  horizon: { url: (v, day) => `/#/viewer?day=${day}&autoplay=0`, tl: '#vw-tl', play: '#vw-play' },
  flux: { url: (v, day) => `/#/viewer?day=${day}&autoplay=0`, tl: '#vw-tl', play: '#vw-play' },
  aurora: { url: (v, day) => `/#/viewer/${encodeURIComponent(v.id)}/day/${day}`, tl: '#scrub', play: '#c-play' },
  daylight: { url: (v, day) => `/#/viewer?day=${day}`, tl: '#scrub', play: '#play' }
};

async function signIn(page) {
  await page.goto(`${A.url}/login`);
  await page.fill('[name=username]', A.user);
  await page.fill('[name=password]', A.password);
  await Promise.all([page.waitForURL((u) => !String(u).includes('/login'), { timeout: 30000 }).catch(() => {}), page.press('[name=password]', 'Enter')]);
}

// until the page's own requests have finished (live streams and video left out)
function quiet(page) {
  const inflight = new Set();
  const skip = (r) => /\/api\/(events|converter\/events|media)|\.mp4/.test(r.url()) || r.resourceType() === 'media' || r.resourceType() === 'eventsource';
  page.on('request', (r) => { if (!skip(r)) inflight.add(r); });
  const done = (r) => inflight.delete(r);
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return async (t0, max = 20000) => {
    let idleSince = null;
    for (;;) {
      await wait(25);
      const now = performance.now();
      if (inflight.size === 0) { if (idleSince === null) idleSince = now; if (now - idleSince >= 300) return idleSince - t0; } else idleSince = null;
      if (now - t0 > max) return null;
    }
  };
}

async function pagesFor(browser, label, ctxOpts, pack) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...ctxOpts });
  const page = await ctx.newPage();
  const settle = quiet(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);
  // a cold first load: a new tab, nothing cached
  const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true, ...ctxOpts, storageState: await ctx.storageState() });
  const p2 = await ctx2.newPage();
  const settle2 = quiet(p2);
  const t0 = performance.now();
  await p2.goto(`${A.url}/`, { waitUntil: 'domcontentloaded' });
  const nav = await p2.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { ttfb: n.responseStart, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd } : null; });
  const ready = await settle2(t0);
  await ctx2.close();
  const out = { firstLoad: { ttfbMs: nav?.ttfb, domReadyMs: nav?.dcl, readyMs: ready }, pages: {} };
  // every page of its menu, as a click would open it
  await page.goto(`${A.url}/`);
  await settle(performance.now());
  const links = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href^="#/"]')].map((a) => a.getAttribute('href').split('?')[0]))].filter((h) => h.split('/').length <= 3).slice(0, 16));
  for (const href of links) {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => { location.hash = '#/__bench'; });
      await wait(150);
      const t = performance.now();
      await page.evaluate((h) => { location.hash = h; }, href);
      const d = await settle(t);
      runs.push(d);
    }
    out.pages[href] = med(runs);
  }
  out.errors = errors.slice(0, 5);
  await ctx.close();
  R.pages[`${pack} · ${label}`] = out;
  say('pages', pack, label, `first load ${ms(ready)}`, `${links.length} pages`);
}

async function viewerFor(browser, label, ctxOpts, pack, v, day) {
  const def = VIEW[pack] || VIEW.horizon;
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, ...ctxOpts });
  const page = await ctx.newPage();
  await signIn(page);
  const out = {};
  // open the day: first picture on every camera (a preview or the video), and the videos
  const home = pack === 'builtin' ? `${A.url}/#/overview` : `${A.url}/`;
  const opens = [];
  for (let i = 0; i < 3; i++) {
    await page.goto(home);
    await wait(2000);
    const url = def.url(v, day);
    const t0 = Date.now();
    if (url.startsWith('/#')) await page.evaluate((h) => { location.hash = h; }, url.slice(1)); else await page.goto(`${A.url}${url}`);
    const r = await page.evaluate(async (t0) => {
      let pic = null;
      for (;;) {
        await new Promise((r) => requestAnimationFrame(r));
        const vids = [...document.querySelectorAll('video')].filter((x) => x.offsetWidth > 40 && x.currentSrc);
        const shows = (x) => (x.readyState >= 2) || (x.nextElementSibling?.classList?.contains('sentry-scrub') && x.nextElementSibling.style.display === 'block');
        if (vids.length >= 4 && pic === null && vids.every(shows)) pic = Date.now() - t0;
        if (vids.length >= 4 && vids.every((x) => x.readyState >= 2)) return { pic, video: Date.now() - t0, cameras: vids.length };
        if (Date.now() - t0 > 30000) return { pic, video: null, cameras: vids.length };
      }
    }, t0);
    opens.push(r);
  }
  out.cameras = opens[0]?.cameras;
  out.openPicture = med(opens.map((o) => o.pic));
  out.openVideo = med(opens.map((o) => o.video));
  // pause, and follow the frames each video really paints
  await page.evaluate(() => {
    for (const x of document.querySelectorAll('video')) {
      x.pause();
      const loop = () => x.requestVideoFrameCallback?.((now, meta) => { x._shown = meta.mediaTime; x._shownSrc = x.currentSrc; loop(); });
      loop();
    }
  });
  // seeks: every camera to the same second, until each shows it
  out.seeks = [];
  for (const to of [30, 8, 47, 21, 55]) {
    out.seeks.push(await page.evaluate(async (to) => {
      const vids = [...document.querySelectorAll('video')].filter((x) => x.offsetWidth > 40 && x.currentSrc);
      const t0 = performance.now();
      vids.forEach((x) => { x.currentTime = Math.min(to, (x.duration || 60) - 1); });
      for (;;) {
        await new Promise((r) => requestAnimationFrame(r));
        if (vids.every((x) => !x.seeking && x.readyState >= 2)) return performance.now() - t0;
        if (performance.now() - t0 > 20000) return null;
      }
    }, to));
  }
  // dragging the timeline: does each camera show the second under the pointer?
  await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), def.tl);
  await wait(300);
  const box = await page.locator(def.tl).boundingBox().catch(() => null);
  if (box) {
    const y = box.y + box.height / 2;
    let right = 0; let n = 0;
    await page.mouse.move(box.x + box.width * 0.05, y);
    await page.mouse.down();
    for (let k = 0; k <= 30; k++) {
      await page.mouse.move(box.x + box.width * (0.05 + 0.9 * k / 30), y);
      await wait(50);
      const r = await page.evaluate(() => [...document.querySelectorAll('video')].filter((x) => x.offsetWidth > 40 && x.currentSrc).map((x) => {
        const l = x.nextElementSibling?.classList?.contains('sentry-scrub') ? x.nextElementSibling : null;
        return l && l.style.display === 'block' ? 'preview' : x._shown !== undefined && !x.seeking && x.readyState >= 2 ? 'video' : 'stale';
      }));
      for (const s of r) { n++; if (s !== 'stale') right++; }
    }
    await page.mouse.up();
    const t0 = performance.now();
    for (;;) {
      const settled = await page.evaluate(() => [...document.querySelectorAll('video')].filter((x) => x.offsetWidth > 40 && x.currentSrc).every((x) => {
        const l = x.nextElementSibling?.classList?.contains('sentry-scrub') ? x.nextElementSibling : null;
        return (!l || l.style.display !== 'block') && !x.seeking && x.readyState >= 2;
      }));
      if (settled || performance.now() - t0 > 15000) break;
      await wait(16);
    }
    out.dragShowing = n ? right / n : null;
    out.dragSettleMs = performance.now() - t0;
  }
  // playing: camera sync, and the next clip
  await page.locator(def.play).click({ timeout: 5000 }).catch(() => page.keyboard.press('Space'));
  await wait(2000);
  out.sync = await page.evaluate(async () => {
    const vids = [...document.querySelectorAll('video')].filter((x) => x.offsetWidth > 40 && x.currentSrc);
    const f = vids.find((x) => /front/.test(x.currentSrc)) || vids[0];
    const d = [];
    const t0v = f.currentTime;
    const end = performance.now() + 8000;
    while (performance.now() < end) {
      await new Promise((r) => requestAnimationFrame(r));
      if (f.paused) continue;
      let worst = 0;
      for (const x of vids) if (x !== f && x.readyState >= 2) worst = Math.max(worst, Math.abs(x.currentTime - f.currentTime) * 1000);
      d.push(worst);
    }
    d.sort((a, b) => a - b);
    return { median: d[Math.floor(d.length / 2)] ?? null, p95: d[Math.floor(d.length * 0.95)] ?? null, rate: (f.currentTime - t0v) / 8 };
  });
  out.nextClipMs = await page.evaluate(async () => {
    const front = () => [...document.querySelectorAll('video')].find((x) => x.offsetWidth > 40 && /front/.test(x.currentSrc)) || [...document.querySelectorAll('video')].find((x) => x.offsetWidth > 40);
    const f0 = front();
    const first = f0.currentSrc;
    [...document.querySelectorAll('video')].filter((x) => x.offsetWidth > 40 && x.currentSrc).forEach((x) => { x.currentTime = Math.max(0, (x.duration || 60) - 1.5); });
    const tEnd = await new Promise((res) => { f0.addEventListener('ended', () => res(performance.now()), { once: true }); setTimeout(() => res(null), 15000); });
    if (tEnd === null) return null;
    for (;;) {
      await new Promise((r) => requestAnimationFrame(r));
      const f = front();
      if (f && f.currentSrc !== first && f.currentTime > 0 && !f.paused) return performance.now() - tEnd;
      if (performance.now() - tEnd > 20000) return null;
    }
  });
  await ctx.close();
  R.viewer[`${pack} · ${label}`] = out;
  say('viewer', pack, label, `picture ${ms(out.openPicture)}`, `seek ${ms(med(out.seeks))}`);
}

async function browserPart(info) {
  const browser = await chromium.launch();
  const packsToRun = A.allPacks ? ['builtin', ...['horizon', 'flux', 'aurora', 'daylight'].filter((p) => info.packs.includes(p))] : [info.active || 'builtin'];
  const setPack = async (id) => {
    await info.c.call('POST', '/api/auth/confirm', { password: A.password });
    await info.c.call('PUT', '/api/ui-packs/active', { id: id === 'builtin' ? null : id });
  };
  const profiles = [['desktop', { viewport: { width: 1440, height: 900 } }], ...(A.phone ? [['phone', { ...devices['iPhone 14'] }]] : [])];
  try {
    for (const pack of packsToRun) {
      if (A.allPacks) await setPack(pack);
      for (const [label, o] of profiles) {
        await pagesFor(browser, label, o, pack).catch((e) => R.notes.push(`Pages ${pack} ${label}: ${e.message}`));
        await viewerFor(browser, label, label === 'phone' && pack === 'builtin' ? { ...devices['iPhone 14 landscape'] } : o, pack, info.v, info.day).catch((e) => R.notes.push(`Viewer ${pack} ${label}: ${e.message}`));
      }
    }
  } finally {
    if (A.allPacks) await setPack(info.active || 'builtin').catch(() => R.notes.push('Could not put your interface back: set it again in Settings.'));
    await browser.close();
  }
}

// ---------- report ----------
function report() {
  const L = [];
  const s = R.server;
  L.push(`# Sentry Six Manager — speed test`, '', `Measured ${R.when.slice(0, 16).replace('T', ' ')} UTC on real hardware and real footage.`, '');
  L.push('## The machines', '', '| | |', '| --- | --- |');
  if (s.version) L.push(`| Server | ${s.cpu || '?'} (${s.threads || '?'} threads), ${mb(s.ramB)} RAM${s.gpus?.length ? `, ${s.gpus.join(', ')}` : ''} · ${s.os} |`, `| App version | ${s.version} |`);
  L.push(`| Browser machine | ${R.client.cpu} (${R.client.threads} threads), ${mb(R.client.ramB)} RAM · ${R.client.os} |`);
  if (s.footage) L.push(`| Footage | ${s.footage.map((f) => `${f.name}: ${f.recordings ?? '?'} recordings${f.bytes ? `, ${(f.bytes / 1e12).toFixed(2)} TB` : ''}`).join(' · ')} |`);
  L.push('');
  if (R.install.pullMs || R.boot.healthyMs) {
    L.push('## Install and start', '', '| | |', '| --- | --- |');
    if (R.install.pullMs) L.push(`| ${R.install.cold ? 'Download and install (nothing cached)' : 'Pull the image'} | ${ms(R.install.pullMs)} (${mb(R.install.imageB)} unpacked) |`);
    if (R.boot.healthyMs) L.push(`| Start to answering | ${ms(R.boot.healthyMs)} |`, `| Start to sign-in page | ${ms(R.boot.firstPageMs)} |`);
    if (R.boot.indexMs) L.push(`| Start to footage indexed (${R.boot.recordings} recordings) | ${ms(R.boot.indexMs)} |`);
    if (R.boot.idleMemory) L.push(`| Idle memory / CPU | ${R.boot.idleMemory} / ${R.boot.idleCpu} |`);
    L.push('');
  }
  if (Object.keys(R.api).length) {
    L.push('## Server answers', '', '| | Median | 95% |', '| --- | --- | --- |');
    for (const [k, x] of Object.entries(R.api)) L.push(`| ${k} | ${ms(x.median)} | ${x.first != null ? `first time ${ms(x.first)}` : ms(x.p95)} |`);
    L.push('');
  }
  for (const [k, p] of Object.entries(R.pages)) {
    L.push(`## Pages — ${k}`, '', '| | |', '| --- | --- |', `| First load (new tab) | ${ms(p.firstLoad.readyMs)} (first byte ${ms(p.firstLoad.ttfbMs)}) |`);
    for (const [h, d] of Object.entries(p.pages)) L.push(`| ${h.replace('#/', '') || 'home'} | ${ms(d)} |`);
    L.push('');
  }
  for (const [k, v] of Object.entries(R.viewer)) {
    if (typeof v !== 'object' || v === null) continue;
    L.push(`## Viewer — ${k}`, '', `${v.cameras || '?'} cameras, ${R.viewer.vehicle} on ${R.viewer.day}.`, '', '| | |', '| --- | --- |');
    L.push(`| Open a day: a picture on every camera | ${ms(v.openPicture)} |`, `| Open a day: every video ready | ${ms(v.openVideo)} |`);
    L.push(`| Seek, all cameras (median / worst) | ${ms(med(v.seeks))} / ${ms(Math.max(...v.seeks.filter(Number.isFinite)))} |`);
    if (v.dragShowing != null) L.push(`| Dragging the timeline: cameras showing the spot | ${Math.round(v.dragShowing * 100)}% |`, `| Full video back after letting go | ${ms(v.dragSettleMs)} |`);
    if (v.nextClipMs != null) L.push(`| Next clip playing after one ends | ${ms(v.nextClipMs)} |`);
    if (v.sync) L.push(`| Cameras in step while playing (median / 95%) | ${ms(v.sync.median)} / ${ms(v.sync.p95)} apart |`, `| Playback speed | ${v.sync.rate?.toFixed(2)}× real time |`);
    L.push('');
  }
  if (R.export.totalMs) L.push('## Export', '', `One minute of ${R.export.cameras} cameras as one video: **${ms(R.export.totalMs)}** (${R.export.state}${R.export.error ? `: ${R.export.error}` : ''}).`, '');
  if (R.resources.appB) L.push('## Resources', '', `App memory after the test: ${mb(R.resources.appB)}${R.resources.cpu != null ? `, CPU ${R.resources.cpu}%` : ''}.`, '');
  if (R.notes.length) L.push('## Notes', '', ...R.notes.map((n) => `- ${n}`), '');
  return L.join('\n');
}

// ---------- run ----------
try {
  if (A.docker) await dockerPart();
  if (A.url) {
    const info = await serverPart();
    say('server', R.server.version, R.server.cpu);
    await browserPart(info);
  }
} catch (e) {
  R.notes.push(`Stopped: ${e.message}`);
  console.error(e);
}
writeFileSync(A.out, report());
writeFileSync(A.out.replace(/\.md$/, '') + '.json', JSON.stringify(R, null, 2));
console.log(`\nReport: ${A.out}`);
