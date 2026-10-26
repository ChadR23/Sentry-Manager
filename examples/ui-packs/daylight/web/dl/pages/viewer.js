// Viewer: all six cameras of a recording, played together. Tap a camera to
// make it big, tap it again for the grid. Big, simple play controls, the
// driving data under the picture, and keyboard shortcuts.

import { api, esc, enc, icon, bytes, plural, dayTitle, dayShort, niceTime, CATEGORY, chip, emptyState, store, toast, fail, details, clockOf } from '../core.js';
import { state, vehicle, setVehicle, vehiclePicker, vehicleById } from '../state.js';
import { go } from '../app.js';
import { thumbUrl, moveToBin, setProtected } from './footage.js';
import { decodeTelemetry, at } from '../telemetry.js';

// laid out like the car: pillars and front on top, repeaters and back below
const CAMS = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
const CAM_WORD = { front: 'Front', back: 'Rear', left_repeater: 'Left side', right_repeater: 'Right side', left_pillar: 'Left pillar', right_pillar: 'Right pillar' };
const KEY_CAM = { 1: 'front', 2: 'back', 3: 'left_repeater', 4: 'right_repeater', 5: 'left_pillar', 6: 'right_pillar' };
const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];
const CLIP_RE = /(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})-([a-z0-9_]+)\.mp4$/i;
const mediaUrl = (p) => `/api/media?path=${enc(p)}`;

/** The recording's clips grouped by start time: [{ ts, cams: { camera: path } }]. */
function segmentsOf(files) {
  const map = new Map();
  for (const f of files) {
    const m = CLIP_RE.exec(f.rel);
    if (!m) continue;
    const ts = `${m[1]} ${m[2]}:${m[3]}:${m[4]}`;
    if (!map.has(ts)) map.set(ts, { ts, cams: {} });
    map.get(ts).cams[m[5].toLowerCase()] = f.path;
  }
  return [...map.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

function clockAt(ts, seconds) {
  const [d, t] = ts.split(' ');
  const [h, m, s] = t.split(':').map(Number);
  const date = new Date(`${d}T00:00:00`);
  date.setHours(h, m, s + Math.floor(seconds));
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export async function render(ctx) {
  const { view, params, query } = ctx;
  const vid = params[0];
  if (vid && vehicleById(vid)) setVehicle(vid);
  const v = vid ? vehicleById(vid) : vehicle();
  if (!v) {
    view.innerHTML = `<div class="page"><div class="page-head"><div><h1>Viewer</h1></div></div>${emptyState({ art: 'car', title: 'No vehicle yet', text: 'Add your Tesla first, then watch its footage here.', action: '<a class="btn btn-primary" href="#/settings/add-vehicle">Add my vehicle</a>' })}</div>`;
    return;
  }
  const day = query.get('day');
  const recId = params[1];
  if (!recId && !day) return chooser(ctx, v);
  return player(ctx, v, day, recId);
}

// ---------- pick something to watch ----------
async function chooser(ctx, v) {
  const { view } = ctx;
  const data = await api(`/api/vehicles/${enc(v.id)}/recordings?limit=60`);
  if (!ctx.alive()) return;
  const byDay = new Map();
  for (const r of data.recordings) {
    if (!byDay.has(r.day)) byDay.set(r.day, []);
    byDay.get(r.day).push(r);
  }
  const last = store.get('lastWatched', null);
  const resume = last && last.vehicle === v.id && data.recordings.find((r) => r.id === last.rec);
  view.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Viewer</h1><p class="lede">Choose something to watch. All cameras play together.</p></div>
      <div class="head-actions">${vehiclePicker()}</div></div>
    ${resume ? `<div class="card row-between" style="margin-bottom:22px"><div><p class="eyebrow">Pick up where you left off</p><h3>${esc((CATEGORY[resume.category] || CATEGORY.Other).word)} · ${esc(dayShort(resume.day))}, ${esc(niceTime(resume.start))}</h3></div>
      <a class="btn btn-primary" href="#/viewer/${enc(v.id)}/${enc(resume.id)}?day=${enc(resume.day)}">${icon('play')} Continue</a></div>` : ''}
    ${data.recordings.length ? [...byDay].map(([d, list]) => `<section class="section" style="margin-top:20px"><div class="section-head"><h2>${esc(dayTitle(d))}</h2>
        <a class="btn btn-ghost btn-sm" href="#/viewer/${enc(v.id)}?day=${enc(d)}">${icon('play')} Play the whole day</a></div>
        <div class="pick-list">${[...list].sort((a, b) => String(a.startKey).localeCompare(String(b.startKey))).map((r) => {
          const cat = CATEGORY[r.category] || CATEGORY.Other;
          return `<a class="card pick" href="#/viewer/${enc(v.id)}/${enc(r.id)}?day=${enc(d)}">
            <span class="thumb">${r.thumbRel || r.frontRel ? `<img class="thumb-img" loading="lazy" alt="" src="${thumbUrl(v.id, r.id)}">` : icon('film')}</span>
            <span><b>${esc(niceTime(r.start))}</b><br>${chip(cat.word, cat.tone)} <span class="muted small">${r.minutes} min</span></span></a>`;
        }).join('')}</div></section>`).join('')
      : emptyState({ art: 'film', title: 'Nothing to watch yet', text: `Once ${esc(v.name)} records something, you can watch it here.`, action: '<a class="btn btn-soft" href="#/footage">Go to Footage</a>' })}
  </div>`;
  view.querySelector('#vehicle-pick')?.addEventListener('change', (e) => { setVehicle(e.target.value); go(`#/viewer/${enc(e.target.value)}`); });
}

// ---------- the player ----------
async function player(ctx, v, day, recId) {
  const { view } = ctx;
  // the playlist: the day's recordings, in time order
  let playlist = [];
  if (day) {
    const q = new URLSearchParams({ date: day, limit: '500' });
    playlist = (await api(`/api/vehicles/${enc(v.id)}/recordings?${q}`)).recordings
      .sort((a, b) => String(a.startKey).localeCompare(String(b.startKey)));
  }
  let rid = recId || playlist[0]?.id;
  if (!rid) {
    view.innerHTML = `<div class="page">${emptyState({ art: 'film', title: 'Nothing recorded that day', action: `<a class="btn btn-soft" href="#/viewer/${enc(v.id)}">Choose something else</a>` })}</div>`;
    return;
  }
  const rec = await api(`/api/vehicles/${enc(v.id)}/recordings/${enc(rid)}`);
  if (!ctx.alive()) return;
  if (!playlist.length) playlist = [rec];
  const pos = playlist.findIndex((r) => r.id === rec.id);
  store.set('lastWatched', { vehicle: v.id, rec: rec.id });
  const segs = segmentsOf(rec.files);
  const present = CAMS.filter((c) => segs.some((s) => s.cams[c]));
  const cat = CATEGORY[rec.category] || CATEGORY.Other;
  const st = {
    seg: 0, focus: null, rate: store.get('rate', 1), playing: false,
    units: store.get('units', /^en-US/.test(navigator.language) ? 'mph' : 'kmh'), tele: [], teleFor: null, wantPlay: false, scrubbing: false
  };
  if (!SPEEDS.includes(st.rate)) st.rate = 1;
  const startAt = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('seg'));
  if (Number.isInteger(startAt) && startAt > 0 && startAt < segs.length) st.seg = startAt;

  const prevRec = playlist[pos - 1];
  const nextRec = playlist[pos + 1];
  view.innerHTML = `<div class="page viewer-page">
    <div class="row-between" style="margin-bottom:14px">
      <a class="back-link" style="margin:0" href="#/footage/${enc(rec.day)}?vehicle=${enc(v.id)}">${icon('back')} ${esc(dayShort(rec.day))}</a>
      <div class="row">
        <a class="btn btn-sm${prevRec ? '' : ' hide-off'}" ${prevRec ? `href="#/viewer/${enc(v.id)}/${enc(prevRec.id)}?day=${enc(rec.day)}"` : 'aria-disabled="true"'} id="prev-rec">${icon('back')} <span class="hide-phone">Earlier</span><span class="sr-only">Earlier recording</span></a>
        <a class="btn btn-sm" ${nextRec ? `href="#/viewer/${enc(v.id)}/${enc(nextRec.id)}?day=${enc(rec.day)}"` : 'aria-disabled="true"'} id="next-rec"><span class="hide-phone">Later</span><span class="sr-only">Later recording</span> ${icon('next')}</a>
      </div></div>
    <div class="viewer-title"><h1 style="font-size:clamp(22px,3vw,30px)">${esc(cat.word)} · ${esc(niceTime(rec.start))}</h1>
      <p class="muted">${esc(dayTitle(rec.day))} · ${esc(v.name)}${playlist.length > 1 ? ` · ${pos + 1} of ${playlist.length} that day` : ''}</p></div>
    <section class="player" id="player" aria-label="Video player">
      <div class="cams" id="cams">${present.map((c) => `<button type="button" class="cam" data-cam="${c}" aria-label="${CAM_WORD[c]} camera. Tap to make it big" aria-pressed="false">
          <video muted playsinline preload="auto" disablepictureinpicture></video><span class="cam-label">${CAM_WORD[c]}</span><span class="cam-note" hidden></span></button>`).join('')}
        ${present.length ? '' : '<div class="cam missing">This recording has no video clips.</div>'}</div>
      <div class="controls">
        <input type="range" class="scrub" id="scrub" min="0" max="60" step="0.05" value="0" aria-label="Position in this clip">
        <div class="ctl-row">
          <button type="button" class="ctl-btn" id="prev-seg" aria-label="Previous clip">${icon('prevClip')}</button>
          <button type="button" class="ctl-btn play" id="play" aria-label="Play">${icon('play')}</button>
          <button type="button" class="ctl-btn" id="next-seg" aria-label="Next clip">${icon('nextClip')}</button>
          <span class="ctl-time" id="time" aria-live="off"><b>—</b><br>0:00 / 0:00</span>
          <span class="spacer"></span>
          <label class="sr-only" for="rate">Speed</label>
          <select class="ctl-speed" id="rate">${SPEEDS.map((s) => `<option value="${s}"${s === st.rate ? ' selected' : ''}>${s}×</option>`).join('')}</select>
          <button type="button" class="ctl-btn" id="grid" aria-label="Show all cameras">${icon('grid')}</button>
          <button type="button" class="ctl-btn" id="full" aria-label="Full screen">${icon('expand')}</button>
        </div>
        ${segs.length > 1 ? `<div class="clip-dots" role="group" aria-label="Clips in this recording">${segs.map((s, i) => `<button type="button" class="clip-dot" data-seg="${i}" aria-label="Clip ${i + 1}, ${esc(niceTime(s.ts))}">${esc(s.ts.slice(11, 16))}</button>`).join('')}</div>` : ''}
      </div>
    </section>
    <div class="dash" id="dash" aria-label="Driving data"></div>
    <div class="actions">
      <button class="btn btn-sm" type="button" id="protect">${icon(rec.protected ? 'unlock' : 'lock')} ${rec.protected ? 'Unprotect' : 'Protect'}</button>
      ${rec.protected ? '' : `<button class="btn btn-ghost btn-sm" type="button" id="trash">${icon('trash')} Move to Recycle Bin</button>`}
      <button class="btn btn-ghost btn-sm" type="button" id="units">Show speed in ${st.units === 'mph' ? 'km/h' : 'mph'}</button>
    </div>
    ${details('Keyboard shortcuts', `<div class="shortcuts">
      <span><span class="kbd">Space</span> or <span class="kbd">K</span> play / pause</span>
      <span><span class="kbd">←</span> <span class="kbd">→</span> back / forward 5 s</span>
      <span><span class="kbd">J</span> <span class="kbd">L</span> back / forward 10 s</span>
      <span><span class="kbd">,</span> <span class="kbd">.</span> one frame (paused)</span>
      <span><span class="kbd">[</span> <span class="kbd">]</span> previous / next clip</span>
      <span><span class="kbd">P</span> <span class="kbd">N</span> earlier / later recording</span>
      <span><span class="kbd">1</span>–<span class="kbd">6</span> make a camera big</span>
      <span><span class="kbd">0</span> or <span class="kbd">G</span> all cameras</span>
      <span><span class="kbd">−</span> <span class="kbd">+</span> slower / faster</span>
      <span><span class="kbd">F</span> full screen</span></div>`)}
    ${details('More details', `<p class="small muted">Folder <span class="mono">${esc(rec.folder)}</span> · ${plural(rec.fileCount, 'file')} · ${bytes(rec.bytes)}${rec.event ? ` · ${esc([rec.event.reason, rec.event.street, rec.event.city].filter(Boolean).join(' · '))}` : ''}</p>`)}
  </div>`;

  const $ = (sel) => view.querySelector(sel);
  // phones turned sideways give the player the whole screen (app.css)
  document.body.dataset.player = '1';
  ctx.cleanup(() => { delete document.body.dataset.player; });
  const tiles = new Map(present.map((c) => [c, view.querySelector(`.cam[data-cam="${c}"]`)]));
  const videos = new Map(present.map((c) => [c, tiles.get(c).querySelector('video')]));
  const seg = () => segs[st.seg];
  const masterCam = () => (seg()?.cams.front && videos.has('front') ? 'front' : present.find((c) => seg()?.cams[c]));
  const master = () => videos.get(masterCam());

  function load(index, autoplay) {
    st.seg = Math.max(0, Math.min(segs.length - 1, index));
    st.wantPlay = autoplay;
    for (const [c, vid] of videos) {
      const p = seg().cams[c];
      const note = tiles.get(c).querySelector('.cam-note');
      note.hidden = Boolean(p);
      note.textContent = p ? '' : 'No video from this camera here';
      if (p) {
        vid.hidden = false;
        if (vid.dataset.path !== p) {
          vid.dataset.path = p;
          vid.src = mediaUrl(p);
        }
        vid.playbackRate = st.rate;
      } else {
        vid.pause();
        vid.removeAttribute('src');
        vid.dataset.path = '';
        vid.hidden = true;
        vid.load();
      }
    }
    view.querySelectorAll('.clip-dot').forEach((b, i) => { b.classList.toggle('on', i === st.seg); b.setAttribute('aria-pressed', String(i === st.seg)); });
    $('#prev-seg').disabled = st.seg === 0 && !prevRec;
    $('#next-seg').disabled = st.seg === segs.length - 1 && !nextRec;
    loadTelemetry();
    const m = master();
    if (m && autoplay) {
      const go2 = () => playAll();
      if (m.readyState >= 2) go2();
      else m.addEventListener('loadeddata', go2, { once: true });
    }
    updateTime();
  }

  async function loadTelemetry() {
    const p = seg()?.cams.front || seg()?.cams[present[0]];
    st.tele = [];
    st.teleFor = p;
    drawDash(null, 'loading');
    if (!p) return drawDash(null, 'none');
    try {
      const res = await fetch(`/api/telemetry?path=${enc(p)}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      const data = decodeTelemetry(await res.json());
      if (st.teleFor !== p || !ctx.alive()) return undefined;
      st.tele = data;
      drawDash(at(data, (master()?.currentTime || 0) * 1000), data.length ? '' : 'none');
    } catch {
      if (st.teleFor === p) drawDash(null, 'none');
    }
    return undefined;
  }

  function drawDash(r, mode = '') {
    const el = $('#dash');
    if (!el) return;
    if (mode === 'loading') { el.innerHTML = '<div class="gauge"><span>Driving data</span><b class="muted" style="font-size:16px">Loading…</b></div>'; return; }
    if (mode === 'none' || !r) { el.innerHTML = '<div class="gauge" style="grid-column:1/-1"><span>Driving data</span><b style="font-size:16px;font-weight:500" class="muted">This clip has no driving data (speed, gear, Autopilot).</b></div>'; return; }
    const speed = st.units === 'mph' ? r.speedMps * 2.23694 : r.speedMps * 3.6;
    el.innerHTML = `
      <div class="gauge"><span>Speed</span><b>${Math.round(Math.abs(speed))}</b><small>${st.units === 'mph' ? 'mph' : 'km/h'}</small></div>
      <div class="gauge"><span>Gear</span><b class="gear">${['P', 'R', 'N', 'D'].map((g) => `<i class="${r.gear === g ? 'on' : ''}">${g}</i>`).join('')}</b></div>
      <div class="gauge${r.autopilot ? ' on' : ''}"><span>Autopilot</span><b style="font-size:18px">${esc(r.autopilot || 'Off')}</b></div>
      <div class="gauge${r.brake ? ' on' : ''}"><span>Brake</span><b style="font-size:18px">${r.brake ? 'Pressed' : '—'}</b></div>
      <div class="gauge"><span>Accelerator</span><b>${Math.round((r.accelerator || 0) * (r.accelerator > 1 ? 1 : 100))}</b><small>%</small></div>
      <div class="gauge"><span>Steering</span><b>${Math.round(r.steering || 0)}</b><small>°</small></div>
      <div class="gauge${r.blinkLeft || r.blinkRight ? ' on' : ''}"><span>Turn signal</span><b style="font-size:18px">${r.blinkLeft ? '← Left' : r.blinkRight ? 'Right →' : '—'}</b></div>`;
  }

  function playAll() {
    const m = master();
    if (!m) return;
    st.playing = true;
    for (const vid of videos.values()) {
      if (vid.hidden || !vid.src) continue;
      if (vid !== m) vid.currentTime = m.currentTime;
      vid.playbackRate = st.rate;
      vid.play().catch(() => {});
    }
    drawPlay();
  }
  function pauseAll() {
    st.playing = false;
    for (const vid of videos.values()) vid.pause();
    drawPlay();
  }
  const toggle = () => (st.playing ? pauseAll() : playAll());
  function drawPlay() {
    const b = $('#play');
    if (!b) return;
    b.innerHTML = icon(st.playing ? 'pause' : 'play');
    b.setAttribute('aria-label', st.playing ? 'Pause' : 'Play');
  }
  function seek(t) {
    const m = master();
    if (!m) return;
    const d = Number.isFinite(m.duration) ? m.duration : 0;
    const to = Math.max(0, Math.min(d ? d - 0.05 : t, t));
    for (const vid of videos.values()) if (!vid.hidden && vid.src) vid.currentTime = to;
    updateTime();
  }
  function step(dir) {
    // across clips: past the end goes to the next one, before the start to the previous
    const m = master();
    if (!m) return;
    const t = m.currentTime + dir;
    if (t < 0 && st.seg > 0) {
      load(st.seg - 1, st.playing);
      const prev = master();
      const jump = () => seek(Math.max(0, prev.duration + t));
      if (prev.readyState >= 1) jump(); else prev.addEventListener('loadedmetadata', jump, { once: true });
    } else if (Number.isFinite(m.duration) && t > m.duration && st.seg < segs.length - 1) load(st.seg + 1, st.playing);
    else seek(t);
  }
  function changeSeg(dir) {
    const next = st.seg + dir;
    if (next < 0) { if (prevRec) go(`#/viewer/${enc(v.id)}/${enc(prevRec.id)}?day=${enc(rec.day)}`); return; }
    if (next >= segs.length) { if (nextRec) go(`#/viewer/${enc(v.id)}/${enc(nextRec.id)}?day=${enc(rec.day)}`); return; }
    load(next, st.playing);
  }
  function setRate(r) {
    st.rate = r;
    store.set('rate', r);
    for (const vid of videos.values()) vid.playbackRate = r;
    $('#rate').value = String(r);
  }
  function setFocus(cam) {
    st.focus = cam && st.focus !== cam ? cam : null;
    $('#cams').classList.toggle('focus', Boolean(st.focus));
    for (const [c, t] of tiles) {
      const big = c === st.focus;
      t.classList.toggle('big', big);
      t.setAttribute('aria-pressed', String(big));
      t.setAttribute('aria-label', `${CAM_WORD[c]} camera. ${big ? 'Tap to show all cameras' : 'Tap to make it big'}`);
    }
  }
  function updateTime() {
    const m = master();
    const t = m?.currentTime || 0;
    const d = m && Number.isFinite(m.duration) ? m.duration : 0;
    const scrub = $('#scrub');
    if (!scrub) return;
    if (!st.scrubbing) {
      scrub.max = String(d || 60);
      scrub.value = String(t);
    }
    scrub.setAttribute('aria-valuetext', `${clockOf(t * 1000)} of ${clockOf(d * 1000)}`);
    $('#time').innerHTML = `<b>${esc(seg() ? clockAt(seg().ts, t) : '—')}</b><br>${clockOf(t * 1000)} / ${clockOf(d * 1000)}${segs.length > 1 ? ` · clip ${st.seg + 1} of ${segs.length}` : ''}`;
    if (st.tele.length) drawDash(at(st.tele, t * 1000));
  }

  // keep the cameras together: the front camera leads, the others follow
  let raf = 0;
  let lastSync = 0;
  const tick = (now) => {
    raf = requestAnimationFrame(tick);
    if (now - lastSync < 200) return;
    lastSync = now;
    const m = master();
    if (!m) return;
    if (st.playing) {
      for (const vid of videos.values()) {
        if (vid === m || vid.hidden || !vid.src || vid.readyState < 1) continue;
        if (Math.abs(vid.currentTime - m.currentTime) > 0.25 && !vid.seeking) vid.currentTime = m.currentTime;
        if (vid.paused && !m.paused && !vid.ended) vid.play().catch(() => {});
      }
    }
    updateTime();
  };
  raf = requestAnimationFrame(tick);
  ctx.cleanup(() => cancelAnimationFrame(raf));

  for (const [c, vid] of videos) {
    vid.addEventListener('ended', () => {
      if (c !== masterCam()) return;
      if (st.seg < segs.length - 1) load(st.seg + 1, true);
      else if (nextRec) {
        toast('Playing the next recording of the day.');
        go(`#/viewer/${enc(v.id)}/${enc(nextRec.id)}?day=${enc(rec.day)}&autoplay=1`);
      } else pauseAll();
    });
    vid.addEventListener('error', () => {
      if (!vid.getAttribute('src')) return;
      const note = tiles.get(c).querySelector('.cam-note');
      note.textContent = 'This browser can’t play this video. Try another browser, or convert it to H.265.';
      note.hidden = false;
    });
    vid.addEventListener('loadeddata', () => { tiles.get(c).querySelector('.cam-note').hidden = true; });
  }

  // controls
  $('#play').onclick = toggle;
  $('#prev-seg').onclick = () => changeSeg(-1);
  $('#next-seg').onclick = () => changeSeg(1);
  $('#grid').onclick = () => setFocus(null);
  $('#rate').onchange = (e) => setRate(Number(e.target.value));
  const scrub = $('#scrub');
  scrub.addEventListener('input', () => { st.scrubbing = true; seek(Number(scrub.value)); });
  scrub.addEventListener('change', () => { st.scrubbing = false; seek(Number(scrub.value)); });
  scrub.addEventListener('pointerup', () => { st.scrubbing = false; });
  view.querySelectorAll('.clip-dot').forEach((b) => { b.onclick = () => load(Number(b.dataset.seg), st.playing); });
  for (const [c, t] of tiles) t.addEventListener('click', () => setFocus(c));
  $('#full').onclick = () => {
    const p = $('#player');
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else if (p.requestFullscreen) p.requestFullscreen().catch(() => toast('Full screen isn’t available here.'));
    else {
      // iPhone Safari: only a video can go full screen
      const m = videos.get(st.focus || masterCam());
      if (m?.webkitEnterFullscreen) m.webkitEnterFullscreen();
    }
  };
  $('#units').onclick = (e) => {
    st.units = st.units === 'mph' ? 'kmh' : 'mph';
    store.set('units', st.units);
    e.currentTarget.textContent = `Show speed in ${st.units === 'mph' ? 'km/h' : 'mph'}`;
    updateTime();
  };
  $('#protect').onclick = async (e) => {
    if (await setProtected(v, [rec.id], !rec.protected)) ctx.rerender();
    e.currentTarget.blur();
  };
  $('#trash')?.addEventListener('click', async () => {
    pauseAll();
    if (await moveToBin(v, [rec])) {
      if (nextRec) go(`#/viewer/${enc(v.id)}/${enc(nextRec.id)}?day=${enc(rec.day)}`);
      else go(`#/footage/${enc(rec.day)}?vehicle=${enc(v.id)}`);
    }
  });

  const onKey = (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    const tag = e.target?.tagName;
    if ((tag === 'INPUT' && e.target.type !== 'range') || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const k = e.key;
    let handled = true;
    if (k === ' ' || k === 'k' || k === 'K') {
      if (tag === 'BUTTON' && k === ' ') { handled = false; } else toggle();
    } else if (k === 'ArrowLeft') step(-5);
    else if (k === 'ArrowRight') step(5);
    else if (k === 'j' || k === 'J') step(-10);
    else if (k === 'l' || k === 'L') step(10);
    else if (k === ',') { pauseAll(); step(-1 / 30); }
    else if (k === '.') { pauseAll(); step(1 / 30); }
    else if (k === '[') changeSeg(-1);
    else if (k === ']') changeSeg(1);
    else if (k === 'p' || k === 'P') { if (prevRec) go(`#/viewer/${enc(v.id)}/${enc(prevRec.id)}?day=${enc(rec.day)}`); }
    else if (k === 'n' || k === 'N') { if (nextRec) go(`#/viewer/${enc(v.id)}/${enc(nextRec.id)}?day=${enc(rec.day)}`); }
    else if (KEY_CAM[k] && tiles.has(KEY_CAM[k])) setFocus(st.focus === KEY_CAM[k] ? null : KEY_CAM[k]);
    else if (k === '0' || k === 'g' || k === 'G' || (k === 'Escape' && st.focus)) setFocus(null);
    else if (k === '+' || k === '=') setRate(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(st.rate) + 1)]);
    else if (k === '-' || k === '_') setRate(SPEEDS[Math.max(0, SPEEDS.indexOf(st.rate) - 1)]);
    else if (k === 'f' || k === 'F') $('#full').click();
    else handled = false;
    if (handled) e.preventDefault();
  };
  document.addEventListener('keydown', onKey);
  ctx.cleanup(() => {
    document.removeEventListener('keydown', onKey);
    for (const vid of videos.values()) { vid.pause(); vid.removeAttribute('src'); vid.load(); }
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  });
  // a hidden tab stops playing (battery on phones)
  const onHide = () => { if (document.hidden && st.playing) pauseAll(); };
  document.addEventListener('visibilitychange', onHide);
  ctx.cleanup(() => document.removeEventListener('visibilitychange', onHide));

  load(st.seg, new URLSearchParams(location.hash.split('?')[1] || '').get('autoplay') === '1');
  if (!present.length) drawDash(null, 'none');
}
