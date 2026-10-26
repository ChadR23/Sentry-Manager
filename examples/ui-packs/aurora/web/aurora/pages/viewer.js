// Viewer: the six cameras in a cockpit. Front large in the middle, the pillars
// and repeaters angled around it like side windows, the back camera as a
// rear-view mirror strip on top, and a glass control bar over the video.
// All cameras play in sync from /api/media (any subset), clip after clip;
// the driving data from /api/telemetry shows as a heads-up display.

import { $, $$, esc, icon, api, state, current, setVehicle, vehiclePicker, plural, clock, dayTitle, timeOf, humanize, store, empty, toast, fin } from '../core.js';
import * as tele from '../telemetry.js';

const CAMS = ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar'];
// on small tiles the labels shrink to these codes (one line, never wrapping)
const SHORT = { front: 'F', back: 'R', left_repeater: 'LR', right_repeater: 'RR', left_pillar: 'LP', right_pillar: 'RP' };
const NAMES = { front: 'Front', back: 'Rear', left_repeater: 'Left repeater', right_repeater: 'Right repeater', left_pillar: 'Left pillar', right_pillar: 'Right pillar' };
const FILE = /(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-(front|back|left_repeater|right_repeater|left_pillar|right_pillar)\.mp4$/i;
const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];
const CODEC = { h265: 'H.265 (HEVC)', av1: 'AV1', h264: 'H.264' };
const media = (p) => `/api/media?path=${encodeURIComponent(p)}`;
const stampMs = (s) => {
  // "2026-10-25_09-05-00" or "2026-10-25 09:05:00" (vehicle time, compared only with each other)
  const m = /(\d{4})-(\d{2})-(\d{2})[_ T](\d{2})[-:](\d{2})[-:](\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN;
};

/** Clips of one recording detail: [{ key, at, cams: {cam: path}, codecs: {cam: codec}, rec }]. */
function clipsOf(detail) {
  const by = new Map();
  for (const f of detail.files || []) {
    const m = FILE.exec(f.rel || f.path || '');
    if (!m) continue;
    const key = m[1];
    if (!by.has(key)) by.set(key, { key, at: stampMs(key), cams: {}, codecs: {}, rec: detail });
    const c = by.get(key);
    c.cams[m[2].toLowerCase()] = f.path;
    c.codecs[m[2].toLowerCase()] = f.codec || null;
  }
  return [...by.values()].sort((a, b) => a.at - b.at);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]).catch(() => null);
    }
  }));
  return out;
}

export default {
  title: 'Viewer',
  kicker: 'Cockpit',
  icon: 'cockpit',
  vehicle: true,
  wide: true,
  topics: [],
  async mount(ctx) {
    const { body, actions, params } = ctx;
    const sky = window.auroraSky;
    if (params[0] && state.vehicles.some((x) => x.id === params[0]) && params[0] !== state.vehicleId) {
      // a link to another vehicle's recording: that vehicle, without a re-render
      state.vehicleId = params[0];
      store.set('vehicle', params[0]);
    }
    const v = current();
    actions.innerHTML = vehiclePicker();
    if (!v) {
      body.innerHTML = empty('No vehicle yet', 'Add one in Settings to watch its footage.', `<a class="btn primary" href="#/settings/vehicles/new">${icon('plus')} Add a vehicle</a>`);
      return {};
    }
    const opts = { tele: store.get('hud', true), unit: store.get('unit', 'kmh'), mirror: store.get('mirror', false), speed: 1 };
    let dead = false;
    let clips = [];
    let index = 0;
    let focus = null;
    let playing = false;
    let durations = [];
    let telem = null;
    let telemFor = null;
    let syncTimer = 0;
    let day = null;
    let dayRecs = [];
    let recId = null;
    let events = []; // [{ clip, offset }]
    let master = null;

    const q = (sel) => body.querySelector(sel) || document.querySelector(`.ctrl[data-owner="viewer"] ${sel}`);
    body.innerHTML = `<div class="vw-top"><div class="vw-title" id="vw-title"><span class="muted">Loading…</span></div>
        <div class="row vw-days"><button class="btn sm" type="button" id="day-prev" aria-label="Previous day">${icon('left')}<span class="lbl">Day</span></button><button class="btn sm" type="button" id="day-next" aria-label="Next day"><span class="lbl">Day</span>${icon('right')}</button></div></div>
      <div class="vw-stage" id="vw-stage">
        <div class="cockpit" id="cockpit">
          ${CAMS.map((c) => `<div class="cam${c === 'back' && opts.mirror ? ' mirror' : ''}" data-cam="${c}" role="button" tabindex="0" aria-label="${NAMES[c]} camera: focus">
            <video muted playsinline preload="auto" disablepictureinpicture></video><span class="cam-label"><span class="lbl-full">${NAMES[c]}</span><span class="lbl-short" aria-hidden="true">${SHORT[c]}</span></span>
            ${c === 'front' ? '<div class="hud" id="hud" aria-live="off"></div>' : ''}
            <div class="cam-note" hidden></div></div>`).join('')}
        </div>
        <div class="ctrl glass" id="ctrl" role="group" aria-label="Playback">
          <div class="ctrl-row">
            <button class="btn icon" type="button" id="c-prev" aria-label="Previous clip ([)">${icon('prev')}</button>
            <button class="btn icon c-seek" type="button" id="c-back" aria-label="Back 5 seconds (←)">${icon('back5')}</button>
            <button class="btn icon play-btn" type="button" id="c-play" aria-label="Play (Space)">${icon('play')}</button>
            <button class="btn icon c-seek" type="button" id="c-fwd" aria-label="Forward 5 seconds (→)">${icon('fwd5')}</button>
            <button class="btn icon" type="button" id="c-next" aria-label="Next clip (])">${icon('next')}</button>
            <div class="scrub" id="scrub" role="slider" tabindex="0" aria-label="Position" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"><div class="scrub-track" id="track"><div class="scrub-fill" id="fill"></div><div class="scrub-knob" id="knob"></div></div></div>
            <span class="time" id="time">0:00 / 0:00</span>
            <label class="sr-only" for="c-speed">Speed</label>
            <select class="input speed-sel c-tune" id="c-speed">${SPEEDS.map((x) => `<option value="${x}"${x === 1 ? ' selected' : ''}>${x}×</option>`).join('')}</select>
            <button class="btn sm c-tune" type="button" id="c-hud" aria-pressed="${opts.tele}" aria-label="HUD: driving data on the front camera (t)">${icon('speed')}<span class="hud-lbl"> HUD</span></button>
            <span class="ctrl-extra" id="ctrl-extra">
              <button class="btn sm" type="button" id="c-unit">${opts.unit === 'mph' ? 'mph' : 'km/h'}</button>
              <button class="btn sm" type="button" id="c-mirror" aria-pressed="${opts.mirror}">Mirror</button>
            </span>
            <button class="btn sm" type="button" id="c-all" hidden>All cameras</button>
            <button class="btn icon" type="button" id="c-more" aria-expanded="false" aria-controls="ctrl-extra" aria-label="More controls">⋯</button>
            <button class="btn icon" type="button" id="c-full" aria-label="Full screen (f)">${icon('expand')}</button>
          </div>
        </div>
      </div>
      <p class="vw-meta" id="vw-meta"><span id="vw-why"></span><span class="clipline" id="clipline"></span></p>
      <section class="vw-side panel"><div class="panel-head"><h3 id="list-title">Recordings that day</h3></div><div class="vw-list" id="vw-list"></div></section>`;

    const cockpit = q('#cockpit');
    const ctrlEl = q('#ctrl');
    const stageEl = q('#vw-stage');
    const root = document.documentElement;
    // the bar floats over the page above the dock while the Viewer is open
    ctrlEl.dataset.owner = 'viewer';
    document.body.append(ctrlEl);

    // ---------- fitting the cockpit above the bar ----------
    // Every camera must sit above where the bar and the dock rest, so the
    // cameras are sized from the room between the title row and the bar.
    const GAP = 10;
    let fitRaf = 0;
    function fit() {
      cancelAnimationFrame(fitRaf);
      fitRaf = requestAnimationFrame(doFit);
    }
    function doFit() {
      if (dead || !cockpit.isConnected) return;
      const fs = document.fullscreenElement === stageEl;
      const dockEl = document.getElementById('dock');
      const bottom = fs ? 12 : Math.round(innerHeight - dockEl.offsetTop + 10);
      root.style.setProperty('--ctrl-bottom', `${bottom}px`);
      const ctrlTop = innerHeight - bottom - ctrlEl.offsetHeight;
      const r = cockpit.getBoundingClientRect();
      const top = fs ? r.top : r.top + scrollY;
      // a little room for the angled side windows' perspective
      const availH = (ctrlTop - top - 8) * 0.97;
      const availW = stageEl.clientWidth * 0.98;
      const g = GAP;
      // every camera stays a 44 px tap target: the mirror strip and small side
      // cameras never get shorter than that
      const T = 44;
      const hWide = (f) => Math.max(0.165 * f, T) + g + Math.max(0.75 * f, 2 * Math.max(0.315 * f, T) + g);
      const wWide = (f) => f + 2 * Math.max(0.42 * f, T) + 2 * g;
      const hTall = (f) => Math.max(0.18 * f, T) + 0.75 * f + Math.max(0.1875 * (f - 3 * g), T) + 2 * g;
      const biggest = (fitsH, fitsW) => {
        let lo = 60;
        let hi = 4000;
        for (let i = 0; i < 30; i++) {
          const mid = (lo + hi) / 2;
          if (fitsH(mid) && fitsW(mid)) lo = mid;
          else hi = mid;
        }
        return lo;
      };
      let lay;
      let F;
      let FH = null;
      let M = null;
      // phones held sideways: the Viewer takes the screen. The cockpit fills the
      // height between the safe areas (down to the bar while it shows), the front
      // camera gets most of the width, the pillars and repeaters stand at its
      // sides and the rear camera hangs over it like a rear-view mirror.
      const theatre = !fs && innerHeight < 500 && innerWidth > innerHeight;
      const idle = root.classList.contains('vw-idle');
      const safeB = safeProbe.offsetHeight;
      const Ht = Math.floor((theatre && idle ? innerHeight - safeB - 6 : ctrlTop - 6) - top);
      if (focus) {
        lay = 'lay-focus';
        F = Math.min(availW, ((theatre ? Ht : availH) * 4) / 3);
      } else if (theatre) {
        lay = 'lay-theatre';
        F = Math.min((Ht * 4) / 3, availW * 0.64);
        FH = F * 0.75;
        // very wide, very short screens (a folded Fold): the front tile may trim
        // a little of the sky and the bonnet to keep at least 55% of the width
        if (idle && F < 0.55 * innerWidth) {
          F = Math.min(0.56 * innerWidth, Ht * 1.6, availW * 0.64);
          FH = Ht;
        }
        F = Math.floor(F);
        FH = Math.floor(FH);
        // the mirror stays a 44 px tall tap target; on a small front it is narrower (cropped)
        M = Math.min(300, Math.max(120, Math.floor(F * 0.42)));
      } else {
        const fw = biggest((f) => hWide(f) <= availH, (f) => wWide(f) <= availW);
        const ft = biggest((f) => hTall(f) <= availH, (f) => f <= availW && (f - 3 * g) / 4 >= T);
        lay = ft > fw * 1.15 ? 'lay-tall' : 'lay-wide';
        F = lay === 'lay-tall' ? ft : fw;
      }
      F = Math.max(100, Math.floor(F));
      const S = lay === 'lay-wide' ? Math.max(T, Math.floor(F * 0.42))
        : lay === 'lay-tall' ? Math.floor((F - 3 * g) / 4)
        : lay === 'lay-theatre' ? Math.max(T, Math.floor(Math.min((availW - F - 2 * g) / 2, ((FH - g) / 2) * 4 / 3)))
        : F;
      cockpit.classList.remove('lay-wide', 'lay-tall', 'lay-focus', 'lay-theatre');
      cockpit.classList.add(lay);
      cockpit.classList.toggle('compact', lay === 'lay-theatre' && FH < 300);
      const wasTheatre = root.classList.contains('vw-theatre');
      root.classList.toggle('vw-theatre', theatre);
      // the page's own padding changes with it: measure again
      if (wasTheatre !== theatre) fit();
      cockpit.style.setProperty('--F', `${F}px`);
      cockpit.style.setProperty('--S', `${S}px`);
      cockpit.style.setProperty('--g', `${g}px`);
      cockpit.style.setProperty('--FH', `${FH ?? Math.round(F * 0.75)}px`);
      cockpit.style.setProperty('--M', `${M ?? Math.round(F * 0.66)}px`);
      // small tiles get the short codes
      for (const k of CAMS) camEl(k).classList.toggle('small', camEl(k).offsetWidth < 180);
    }
    // the bottom safe area, measured once by a probe
    const safeProbe = document.createElement('div');
    safeProbe.className = 'safe-probe';
    document.body.append(safeProbe);
    const sizes = new ResizeObserver(() => fit());
    sizes.observe(ctrlEl);
    sizes.observe(stageEl);
    sizes.observe(q('.vw-top'));
    addEventListener('resize', fit);

    // ---------- the bar and the dock hide while playing ----------
    let idleTimer = 0;
    let hover = false;
    let wokeAt = 0;
    const dockEl = document.getElementById('dock');
    function arm() {
      clearTimeout(idleTimer);
      if (playing && !dead) idleTimer = setTimeout(sleep, 2500);
    }
    function showBars() {
      clearTimeout(idleTimer);
      if (root.classList.contains('vw-idle')) {
        root.classList.remove('vw-idle');
        fit();
      }
    }
    function sleep() {
      if (dead || !playing) return;
      const a = document.activeElement;
      const keyFocus = a && (ctrlEl.contains(a) || dockEl.contains(a)) && a.matches(':focus-visible');
      if (hover || keyFocus || ctrlEl.classList.contains('more-open') || document.querySelector('dialog[open]') || !more.hidden) {
        arm();
        return;
      }
      root.classList.add('vw-idle');
      fit();
    }
    const more = document.getElementById('more');
    const wake = (e) => {
      if (dead) return;
      // a mouse over the bar or the dock keeps them (judged on every move:
      // leave events are not always sent when the pointer jumps)
      if (e?.type === 'pointermove' && e.pointerType === 'mouse') hover = ctrlEl.contains(e.target) || dockEl.contains(e.target);
      if (root.classList.contains('vw-idle')) {
        root.classList.remove('vw-idle');
        fit();
        if (e?.type === 'pointerdown' || e?.type === 'touchstart') wokeAt = Date.now();
      }
      arm();
    };
    // the tap that brings the bar back does only that
    const swallow = (e) => {
      if (Date.now() - wokeAt < 600 && e.target.closest?.('.cockpit')) {
        e.stopPropagation();
        e.preventDefault();
      }
      wokeAt = 0;
    };
    const ACTIVITY = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'];
    for (const t of ACTIVITY) document.addEventListener(t, wake, { capture: true, passive: true });
    document.addEventListener('click', swallow, true);
    const vids = Object.fromEntries(CAMS.map((c) => [c, $(`.cam[data-cam="${c}"] video`, cockpit)]));
    const camEl = (c) => $(`.cam[data-cam="${c}"]`, cockpit);
    const note = (c, html) => {
      const n = $('.cam-note', camEl(c));
      n.hidden = !html;
      n.innerHTML = html || '';
    };

    // ---------- loading what to play ----------
    async function detail(id) {
      return api(`/api/vehicles/${encodeURIComponent(v.id)}/recordings/${encodeURIComponent(id)}`);
    }
    async function loadDayList(d) {
      try {
        const out = await api(`/api/vehicles/${encodeURIComponent(v.id)}/recordings?date=${encodeURIComponent(d)}&limit=500`);
        dayRecs = out.recordings.sort((a, b) => String(a.start).localeCompare(String(b.start)));
        state.viewerDates = out.dates || [];
      } catch {
        dayRecs = [];
      }
    }
    function drawList() {
      q('#list-title').textContent = day ? `${dayTitle(day)}` : 'Recordings';
      q('#vw-list').innerHTML = dayRecs.length ? dayRecs.map((r) => `<button class="vw-item${r.id === recId ? ' on' : ''}" type="button" data-rec="${esc(r.id)}" aria-pressed="${r.id === recId}">
        <img class="thumb-img" loading="lazy" alt="" src="/api/vehicles/${encodeURIComponent(v.id)}/recordings/${encodeURIComponent(r.id)}/thumbnail">
        <span>${esc(timeOf(r.start))}${r.end !== r.start ? `–${esc(timeOf(r.end))}` : ''}<small>${esc(r.category)} · ${r.minutes} min${r.protected ? ' · protected' : ''}</small></span></button>`).join('')
        + `<a class="vw-item${recId ? '' : ' on'}" href="#/viewer/${encodeURIComponent(v.id)}/day/${encodeURIComponent(day || '')}">${icon('film')}<span>The whole day<small>every recording in order</small></span></a>` : '<p class="muted">No recordings.</p>';
      const dates = state.viewerDates || [];
      const i = dates.indexOf(day);
      q('#day-prev').disabled = i < 0 || i >= dates.length - 1;
      q('#day-next').disabled = i <= 0;
    }

    async function setup() {
      let target = params[1] || null;
      if (!params[0] || params[0] !== v.id) target = null;
      if (target === 'day') {
        day = params[2];
        recId = null;
        await loadDayList(day);
        const details = await pool(dayRecs, 6, (r) => detail(r.id));
        clips = details.filter(Boolean).flatMap(clipsOf).sort((a, b) => a.at - b.at);
      } else {
        if (!target) {
          // the newest recording
          const out = await api(`/api/vehicles/${encodeURIComponent(v.id)}/recordings?limit=1`);
          target = out.recordings[0]?.id || null;
          if (!target) return false;
        }
        const d = await detail(target);
        recId = d.id;
        day = d.day;
        clips = clipsOf(d);
        await loadDayList(day);
      }
      events = [];
      for (const rec of new Set(clips.map((c) => c.rec))) {
        const at = stampMs(rec.eventAt);
        if (!fin(at)) continue;
        let ci = -1;
        clips.forEach((c, k) => { if (c.rec === rec && c.at <= at) ci = k; });
        if (ci >= 0) events.push({ clip: ci, offset: (at - clips[ci].at) / 1000, why: rec.event?.reason || '' });
      }
      durations = clips.map((c, k) => (clips[k + 1] ? Math.min(60, Math.max(1, (clips[k + 1].at - c.at) / 1000)) : 60));
      return clips.length > 0;
    }

    function title() {
      const c = clips[index];
      const rec = c?.rec;
      q('#vw-title').innerHTML = rec
        ? `<span class="chip ${rec.category === 'Sentry' ? 'magenta' : rec.category === 'Saved' ? 'green' : 'teal'}">${esc(rec.category)}</span><span class="vw-date">${esc(dayTitle(rec.day))}</span><span class="muted">${esc(timeOf(rec.start))}${recId ? '' : ' · whole day'}</span>`
        : '';
      q('#vw-why').innerHTML = rec ? `${rec.event?.reason ? `<span class="chip">${esc(humanize(rec.event.reason))}</span>` : ''}${rec.event?.city ? `<span class="muted small">${icon('pin', 'ico-sm')} ${esc([rec.event.street, rec.event.city].filter(Boolean).join(', '))}</span>` : ''}` : '';
    }

    // ---------- playback ----------
    function pickMaster() {
      const c = clips[index];
      master = CAMS.find((k) => c?.cams[k] && !vids[k].dataset.bad) || null;
      return master;
    }
    function camsHere() { return CAMS.filter((k) => clips[index]?.cams[k]); }

    function loadClip(i, at = 0, autoplay = playing) {
      index = Math.max(0, Math.min(clips.length - 1, i));
      const c = clips[index];
      for (const k of CAMS) {
        const el = vids[k];
        delete el.dataset.bad;
        const cam = camEl(k);
        if (c.cams[k]) {
          cam.classList.remove('missing');
          note(k, '');
          el.src = media(c.cams[k]);
          el.playbackRate = opts.speed;
        } else {
          el.removeAttribute('src');
          el.load();
          cam.classList.add('missing');
          note(k, `<b>${NAMES[k]}</b><span>not recorded in this clip</span>`);
        }
      }
      pickMaster();
      const start = () => {
        for (const k of camsHere()) {
          try { vids[k].currentTime = Math.max(0, at); } catch { /* not ready */ }
        }
        if (autoplay) play();
        else paint();
      };
      if (master && vids[master].readyState >= 1) start();
      else if (master) vids[master].addEventListener('loadedmetadata', start, { once: true });
      title();
      loadTelemetry();
      paint();
    }

    function play() {
      if (!clips.length) return;
      playing = true;
      sky?.hold('video', true);
      for (const k of camsHere()) {
        if (vids[k].dataset.bad) continue;
        vids[k].playbackRate = opts.speed;
        vids[k].play().catch(() => {});
      }
      sync();
      paintPlay();
      root.classList.add('vw-playing');
      arm();
    }
    function pause() {
      playing = false;
      sky?.hold('video', false);
      for (const k of CAMS) vids[k].pause();
      clearTimeout(syncTimer);
      paintPlay();
      root.classList.remove('vw-playing');
      showBars();
    }
    function toggle() { if (playing) pause(); else play(); }

    function sync() {
      clearTimeout(syncTimer);
      if (!playing || dead) return;
      const m = master && vids[master];
      if (m) {
        for (const k of camsHere()) {
          const el = vids[k];
          if (k === master || el.dataset.bad || el.readyState < 1) continue;
          if (Math.abs(el.currentTime - m.currentTime) > 0.18 && !el.seeking) {
            try { el.currentTime = m.currentTime; } catch { /* later */ }
          }
          if (el.paused && !m.paused) el.play().catch(() => {});
        }
      }
      syncTimer = setTimeout(sync, 300);
    }

    const offsetOf = (i) => durations.slice(0, i).reduce((a, b) => a + b, 0);
    const totalDur = () => durations.reduce((a, b) => a + b, 0);
    function now() { return master ? vids[master].currentTime || 0 : 0; }

    function seekGlobal(t) {
      const tot = totalDur();
      t = Math.max(0, Math.min(tot - 0.05, t));
      let i = 0;
      while (i < clips.length - 1 && t >= offsetOf(i + 1)) i++;
      const local = t - offsetOf(i);
      if (i !== index) loadClip(i, local, playing);
      else for (const k of camsHere()) { try { vids[k].currentTime = local; } catch { /* not ready */ } }
      paint();
    }
    function step(frames) {
      pause();
      const f = tele.fps(telem) || 36;
      seekGlobal(offsetOf(index) + now() + frames / f);
    }
    function nextClip(dir) {
      if (index + dir < 0 || index + dir >= clips.length) return;
      loadClip(index + dir, 0, playing);
    }

    // ---------- painting ----------
    function paintPlay() {
      const b = q('#c-play');
      b.innerHTML = icon(playing ? 'pause' : 'play');
      b.setAttribute('aria-label', playing ? 'Pause (Space)' : 'Play (Space)');
    }
    let drawnMarks = '';
    function paint() {
      if (dead) return;
      const tot = totalDur();
      const pos = offsetOf(index) + now();
      const f = tot ? Math.min(1, pos / tot) : 0;
      q('#fill').style.width = `${(f * 100).toFixed(3)}%`;
      q('#knob').style.left = `${(f * 100).toFixed(3)}%`;
      q('#time').textContent = `${clock(pos)} / ${clock(tot)}`;
      const s = q('#scrub');
      s.setAttribute('aria-valuemax', String(Math.round(tot)));
      s.setAttribute('aria-valuenow', String(Math.round(pos)));
      s.setAttribute('aria-valuetext', `${clock(pos)} of ${clock(tot)}`);
      const marks = clips.length > 1 || events.length ? `${clips.slice(1).map((c, i) => `<span class="scrub-clip" style="left:${((offsetOf(i + 1) / tot) * 100).toFixed(2)}%"></span>`).join('')}${events.map((e) => `<span class="scrub-event" title="Event" style="left:${(((offsetOf(e.clip) + e.offset) / tot) * 100).toFixed(2)}%"></span>`).join('')}` : '';
      if (marks !== drawnMarks) {
        $$('.scrub-clip, .scrub-event', ctrlEl).forEach((x) => x.remove());
        q('#track').insertAdjacentHTML('beforeend', marks);
        drawnMarks = marks;
      }
      const c = clips[index];
      q('#clipline').textContent = c ? `Clip ${index + 1} of ${clips.length} · ${c.key.slice(11).replace(/-/g, ':')} · ${plural(camsHere().length, 'camera')}` : '';
      q('#c-prev').disabled = index <= 0;
      q('#c-next').disabled = index >= clips.length - 1;
      paintHud();
    }

    async function loadTelemetry() {
      const c = clips[index];
      const path = c?.cams.front || Object.values(c?.cams || {})[0];
      telem = null;
      telemFor = path;
      paintHud();
      if (!path) return;
      const t = await tele.load(path);
      if (dead || telemFor !== path) return;
      telem = t;
      paintHud();
    }
    function paintHud() {
      const hud = q('#hud');
      if (!opts.tele || !telem) {
        hud.hidden = true;
        return;
      }
      const r = tele.at(telem, now() * 1000);
      if (!r) { hud.hidden = true; return; }
      hud.hidden = false;
      const sp = fin(r.speed) ? (opts.unit === 'mph' ? r.speed * 2.23694 : r.speed * 3.6) : null;
      hud.innerHTML = `<div class="hud-speed"><b>${sp === null ? '—' : Math.round(sp)}</b><span>${opts.unit === 'mph' ? 'mph' : 'km/h'}</span></div>
        <div class="hud-row"><span class="hud-tag on">${esc(r.gear)}</span><span class="hud-tag${r.pilot !== 'Off' ? ' on' : ''}">${esc(r.pilot === 'Off' ? 'Manual' : r.pilot)}</span></div>
        <div class="hud-row"><span class="hud-tag blink${r.left ? ' on' : ''}" aria-label="Left blinker">◀</span><span class="hud-tag"><svg class="ico hud-wheel" style="transform:rotate(${fin(r.steer) ? Math.max(-540, Math.min(540, r.steer)).toFixed(0) : 0}deg)" aria-hidden="true"><use href="#i-wheel"/></svg>${fin(r.steer) ? `${Math.round(r.steer)}°` : ''}</span><span class="hud-tag blink${r.right ? ' on' : ''}" aria-label="Right blinker">▶</span></div>
        <div class="hud-row"><span class="hud-tag${r.brake ? ' brake' : ''}">${r.brake ? 'Brake' : 'No brake'}</span><span class="hud-tag">Pedal ${fin(r.accel) ? Math.round(r.accel * (r.accel <= 1 ? 100 : 1)) : 0}%</span></div>
        ${fin(r.lat) && fin(r.lon) && (r.lat || r.lon) ? `<div class="hud-row"><span class="hud-tag">${icon('pin')}${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}${fin(r.heading) ? ` · ${Math.round(r.heading)}°` : ''}</span></div>` : ''}`;
    }

    function setFocus(cam) {
      focus = cam && focus !== cam ? cam : null;
      CAMS.forEach((k) => {
        const el = camEl(k);
        el.classList.toggle('focused', k === focus);
        el.setAttribute('aria-label', `${NAMES[k]} camera: ${k === focus ? 'show all cameras' : 'focus'}`);
      });
      q('#c-all').hidden = !focus;
      fit();
    }

    // ---------- video events ----------
    for (const k of CAMS) {
      const el = vids[k];
      el.addEventListener('error', () => {
        if (!el.getAttribute('src')) return;
        el.dataset.bad = '1';
        const codec = clips[index]?.codecs[k];
        note(k, `<b>This browser can’t play this video</b><span>${codec ? `${esc(CODEC[codec] || codec)} isn’t supported here.` : 'The format isn’t supported here.'} Try another browser, or convert it in the Encoder.</span><a class="btn sm" href="${esc(el.getAttribute('src'))}" download>${icon('download')} Download</a>`);
        if (k === master) {
          const was = master;
          pickMaster();
          if (master && master !== was && playing) play();
        }
        if (camsHere().every((c) => vids[c].dataset.bad)) {
          pause();
          q('#clipline').textContent = 'None of these cameras can play in this browser.';
        }
      });
      el.addEventListener('timeupdate', () => { if (k === master) paint(); });
      el.addEventListener('loadedmetadata', () => {
        if (k === master && fin(el.duration) && el.duration > 0) {
          durations[index] = el.duration;
          paint();
        }
      });
      el.addEventListener('ended', () => {
        if (k !== master) return;
        if (index < clips.length - 1) loadClip(index + 1, 0, true);
        else pause();
      });
      // a smooth HUD while playing
      if (el.requestVideoFrameCallback) {
        const frame = () => {
          if (dead) return;
          if (k === master && opts.tele && telem) paintHud();
          el.requestVideoFrameCallback(frame);
        };
        el.requestVideoFrameCallback(frame);
      }
    }

    // ---------- controls ----------
    const scrub = q('#scrub');
    let dragging = false;
    const scrubTo = (e) => {
      const r = q('#track').getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      seekGlobal(f * totalDur());
    };
    scrub.addEventListener('pointerdown', (e) => { dragging = true; scrub.setPointerCapture(e.pointerId); scrubTo(e); });
    scrub.addEventListener('pointermove', (e) => { if (dragging) scrubTo(e); });
    scrub.addEventListener('pointerup', () => { dragging = false; });
    scrub.addEventListener('pointercancel', () => { dragging = false; });
    scrub.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        seekGlobal(offsetOf(index) + now() + (e.key === 'ArrowLeft' ? -5 : 5));
      }
    });

    const speedSel = q('#c-speed');
    const setSpeed = (s) => {
      opts.speed = s;
      speedSel.value = String(s);
      for (const k of CAMS) vids[k].playbackRate = s;
    };
    speedSel.addEventListener('change', () => setSpeed(Number(speedSel.value)));

    const onFull = () => {
      if (dead) return;
      if (document.fullscreenElement === stageEl) stageEl.append(ctrlEl);
      else document.body.append(ctrlEl);
      fit();
    };
    document.addEventListener('fullscreenchange', onFull);
    const full = async () => {
      const stage = stageEl;
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else if (stage.requestFullscreen) await stage.requestFullscreen();
        else {
          const el = vids[focus || master || 'front'];
          el.webkitEnterFullscreen?.();
        }
      } catch { toast('Full screen isn’t available here.', 'bad'); }
    };

    const onClick = async (e) => {
      const t = e.target;
      if (t.closest('#c-play')) return toggle();
      if (t.closest('#c-back')) return seekGlobal(offsetOf(index) + now() - 5);
      if (t.closest('#c-fwd')) return seekGlobal(offsetOf(index) + now() + 5);
      if (t.closest('#c-prev')) return nextClip(-1);
      if (t.closest('#c-next')) return nextClip(1);
      if (t.closest('#c-full')) return full();
      if (t.closest('#c-more')) {
        const open = ctrlEl.classList.toggle('more-open');
        q('#c-more').setAttribute('aria-expanded', String(open));
        return fit();
      }
      if (t.closest('#c-all')) return setFocus(null);
      if (t.closest('#c-hud')) {
        opts.tele = !opts.tele;
        store.set('hud', opts.tele);
        t.closest('#c-hud').setAttribute('aria-pressed', String(opts.tele));
        return paintHud();
      }
      if (t.closest('#c-unit')) {
        opts.unit = opts.unit === 'mph' ? 'kmh' : 'mph';
        store.set('unit', opts.unit);
        t.closest('#c-unit').textContent = opts.unit === 'mph' ? 'mph' : 'km/h';
        return paintHud();
      }
      if (t.closest('#c-mirror')) {
        opts.mirror = !opts.mirror;
        store.set('mirror', opts.mirror);
        camEl('back').classList.toggle('mirror', opts.mirror);
        t.closest('#c-mirror').setAttribute('aria-pressed', String(opts.mirror));
        return undefined;
      }
      const rec = t.closest('[data-rec]');
      if (rec) return ctx.go(`#/viewer/${encodeURIComponent(v.id)}/${encodeURIComponent(rec.dataset.rec)}`);
      const dp = t.closest('#day-prev, #day-next');
      if (dp) {
        const dates = state.viewerDates || [];
        const i = dates.indexOf(day);
        const d = dates[i + (dp.id === 'day-prev' ? 1 : -1)];
        if (d) ctx.go(`#/viewer/${encodeURIComponent(v.id)}/day/${encodeURIComponent(d)}`);
        return undefined;
      }
      if (t.closest('.cam-note a')) return undefined;
      const cam = t.closest('.cam[data-cam]');
      if (cam && !cam.classList.contains('missing')) setFocus(cam.dataset.cam);
      return undefined;
    };
    body.addEventListener('click', onClick);
    ctrlEl.addEventListener('click', onClick);
    cockpit.addEventListener('keydown', (e) => {
      const cam = e.target.closest('.cam[data-cam]');
      if (cam && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        e.stopPropagation();
        if (!cam.classList.contains('missing')) setFocus(cam.dataset.cam);
      }
    });

    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
      if (e.target.closest?.('input, select, textarea')) return;
      const k = e.key;
      let hit = true;
      if (k === ' ' || k === 'k') { if (e.target.closest?.('button, a')) return; toggle(); }
      else if (k === 'ArrowLeft') seekGlobal(offsetOf(index) + now() - (e.shiftKey ? 1 : 5));
      else if (k === 'ArrowRight') seekGlobal(offsetOf(index) + now() + (e.shiftKey ? 1 : 5));
      else if (k === ',') step(-1);
      else if (k === '.') step(1);
      else if (k === '[') nextClip(-1);
      else if (k === ']') nextClip(1);
      else if (k === '-' || k === '_') setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(opts.speed) - 1)]);
      else if (k === '+' || k === '=') setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(opts.speed) + 1)]);
      else if (/^[1-6]$/.test(k)) { const c = CAMS[Number(k) - 1]; if (clips[index]?.cams[c]) { focus = null; setFocus(c); } }
      else if (k === '0' || (k === 'Escape' && focus)) setFocus(null);
      else if (k === 't') q('#c-hud').click();
      else if (k === 'm') q('#c-mirror').click();
      else if (k === 'f') full();
      else hit = false;
      if (hit) e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    const onHidden = () => { if (document.hidden && playing) pause(); };
    document.addEventListener('visibilitychange', onHidden);

    // ---------- go ----------
    let ok = false;
    try {
      ok = await setup();
    } catch (err) {
      q('#vw-title').innerHTML = `<span class="note bad">${esc(err.message)}</span>`;
    }
    if (dead) return {};
    drawList();
    if (!ok) {
      ctrlEl.remove();
      q('#vw-stage').innerHTML = empty('Nothing to play yet', 'This vehicle has no recordings with camera clips here.', `<a class="btn" href="#/footage">${icon('film')} Footage</a>`);
    } else {
      // an event: start a little before it
      const ev = events[0];
      if (ev && recId) loadClip(ev.clip, Math.max(0, ev.offset - 8), false);
      else loadClip(0, 0, false);
      paintPlay();
      fit();
    }

    return {
      destroy() {
        dead = true;
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('visibilitychange', onHidden);
        clearTimeout(syncTimer);
        for (const k of CAMS) {
          vids[k].pause();
          vids[k].removeAttribute('src');
          vids[k].load();
        }
        sky?.hold('video', false);
        clearTimeout(idleTimer);
        cancelAnimationFrame(fitRaf);
        root.classList.remove('vw-idle', 'vw-theatre', 'vw-playing');
        root.style.removeProperty('--ctrl-bottom');
        safeProbe.remove();
        sizes.disconnect();
        removeEventListener('resize', fit);
        for (const t of ACTIVITY) document.removeEventListener(t, wake, { capture: true });
        document.removeEventListener('click', swallow, true);
        document.removeEventListener('fullscreenchange', onFull);
        ctrlEl.remove();
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      }
    };
  }
};
