// Viewer: a six-camera synced player with frame stepping, speed, a playlist
// timeline, camera layouts and a live telemetry readout.
import { esc, api, current, icon, toast, store, fin, clock, wall, wallDay, dayTitle, CAMERAS, CAMERA_LABEL, CAMERA_SHORT, humanize, reducedMotion } from '../core.js';
import { telemetryFor, recordAt, fpsOf } from '../telemetry.js';
import { createViewerMap } from '/web/viewerMap.js';
import { createExportPanel } from '/web/exportPanel.js';
import { createScrubber } from '/web/scrub.js';
import { syncTo } from '/web/camSync.js';
import { TimeChart, C } from '../charts.js';
import { split, seg, wireSeg, empty } from '../ui.js';

const CLIP_RE = /(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-([a-z0-9_]+)\.mp4$/i;
const LAYOUTS = [['grid', 'Grid'], ['focus', 'Focus'], ['duo', 'Front + Back'], ['single', 'Single']];
// grid order: pillars beside the front camera, repeaters beside the rear one
const GRID_ORDER = ['left_pillar', 'front', 'right_pillar', 'left_repeater', 'back', 'right_repeater'];
const SPEEDS = [0.1, 0.25, 0.5, 1, 1.5, 2, 4, 8];
const DEFAULT_DUR = 60;

const keyTime = (k) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(k || '');
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
};
const textTime = (t) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(t || '');
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
};

/** Segments (one timestamp, up to six cameras) of a recording detail. */
function segmentsOf(detail) {
  const by = new Map();
  for (const f of detail.files || []) {
    const m = CLIP_RE.exec(f.rel);
    if (!m) continue;
    const key = m[1];
    if (!by.has(key)) by.set(key, { key, at: keyTime(key), files: {}, rec: detail.id, recLabel: detail.start, category: detail.category, eventAt: textTime(detail.eventAt), dur: null });
    by.get(key).files[m[2].toLowerCase()] = f.path;
  }
  return [...by.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export default {
  async mount(el, { params, go }) {
    const v = current();
    if (!v) {
      el.innerHTML = `<div class="phead"><div><h1>Viewer</h1></div></div>${empty('Add a vehicle in Settings to play its footage.', '<a class="btn primary" href="#/settings/vehicles?add=1">Add a vehicle</a>')}`;
      return {};
    }
    const st = {
      layout: store.get('vw:layout', 'grid'),
      focus: store.get('vw:focus', 'front'),
      speed: store.get('vw:speed', 1),
      units: store.get('vw:units', 'mph'),
      tele: store.get('vw:tele', true),
      segs: [],
      idx: 0,
      playing: false,
      tel: null,
      fps: 36,
      title: ''
    };
    let alive = true;
    let raf = 0;
    let loadSeq = 0;
    let scrubbing = false;
    // while the timeline is dragged: the clip and time under the pointer
    // (previews show it; another clip only loads when the drag ends)
    let scrubTo = null;
    const scrubber = createScrubber();

    el.innerHTML = `
      <div class="phead vw-head">
        <div><h1>Viewer <span class="muted h-sub" id="vw-title">loading…</span></h1><p class="muted small" id="vw-sub"></p></div>
        <div class="phead-actions">
          <label class="field inline"><span class="sr-only">Recording</span><select class="input" id="vw-pick" aria-label="Recording"></select></label>
          ${seg('layout', LAYOUTS, st.layout, 'Camera layout')}
          <button class="btn" type="button" id="vw-tele-btn" aria-pressed="${st.tele}">${icon('gauge')}Telemetry</button>
        </div>
      </div>
      <div id="vw-split" class="${st.tele ? '' : 'no-tele'}">
        <section class="vw-main" aria-label="Player">
          <div class="stage lay-${st.layout}" id="vw-stage" data-focus="${esc(st.focus)}">
            ${GRID_ORDER.map((c) => `<figure class="cam" data-cam="${c}" style="--o:${GRID_ORDER.indexOf(c)}">
              <video muted playsinline preload="auto" disablepictureinpicture aria-label="${esc(CAMERA_LABEL[c])} camera"></video>
              <figcaption><b>${CAMERA_SHORT[c]}</b> ${esc(CAMERA_LABEL[c])}</figcaption>
              <span class="cam-none" hidden>no ${esc(CAMERA_LABEL[c])} video</span>
              <button class="cam-hit" type="button" aria-label="Focus the ${esc(CAMERA_LABEL[c])} camera"></button>
            </figure>`).join('')}
            <div class="stage-msg" id="vw-msg" hidden></div>
          </div>
          <div class="timeline" id="vw-tl" role="slider" tabindex="0" aria-label="Position in the playlist" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <div class="tl-segs" id="vw-tl-segs"></div><div class="tl-head" id="vw-tl-head"></div><div class="tl-hover" id="vw-tl-hover" hidden></div>
          </div>
          <div class="transport">
            <div class="tr-left">
              <button class="btn icon" type="button" id="vw-prev" aria-label="Previous clip (p)" title="Previous clip (p)">${icon('prev')}</button>
              <button class="btn icon" type="button" id="vw-back" aria-label="One frame back (,)" title="One frame back (,)">${icon('step-back')}</button>
              <button class="btn icon primary play" type="button" id="vw-play" aria-label="Play (Space)" title="Play / pause (Space)">${icon('play')}</button>
              <button class="btn icon" type="button" id="vw-fwd" aria-label="One frame forward (.)" title="One frame forward (.)">${icon('step-fwd')}</button>
              <button class="btn icon" type="button" id="vw-next" aria-label="Next clip (n)" title="Next clip (n)">${icon('next')}</button>
            </div>
            <div class="tr-time num" id="vw-time">0:00.0 / 0:00.0</div>
            <div class="tr-right">
              <label class="speed"><span class="sr-only">Speed</span><select class="input" id="vw-speed" aria-label="Playback speed">${SPEEDS.map((s) => `<option value="${s}"${s === st.speed ? ' selected' : ''}>${s}×</option>`).join('')}</select></label>
              <button class="btn" type="button" id="vw-export" aria-label="Export a video (e)" title="Export a video (e)">${icon('download')}Export</button>
              <button class="btn icon" type="button" id="vw-full" aria-label="Fullscreen (f)" title="Fullscreen (f)">${icon('maximize')}</button>
            </div>
          </div>
          <div class="camchips" id="vw-camchips" role="group" aria-label="Focus a camera">
            <button type="button" class="btn sm" data-cam-pick="all">All <kbd>0</kbd></button>
            ${CAMERAS.map((c, i) => `<button type="button" class="btn sm" data-cam-pick="${c}">${esc(CAMERA_LABEL[c])} <kbd>${i + 1}</kbd></button>`).join('')}
          </div>
        </section>
        <aside class="vw-side" aria-label="Telemetry">
          <section class="card tele" id="vw-tele">
            <header class="card-h"><h2>Telemetry</h2>${seg('units', [['mph', 'mph'], ['kmh', 'km/h']], st.units, 'Speed units')}</header>
            <div class="tele-grid">
              <div class="speedo"><b class="num" id="t-speed">—</b><span id="t-unit">${st.units === 'mph' ? 'mph' : 'km/h'}</span></div>
              <div class="gears" id="t-gear">${['P', 'R', 'N', 'D'].map((g) => `<span data-g="${g}">${g}</span>`).join('')}</div>
              <div class="wheel"><svg viewBox="0 0 60 60" id="t-wheel" aria-hidden="true"><circle cx="30" cy="30" r="25" fill="none" stroke="currentColor" stroke-width="4"/><path d="M8 32h16l6 6 6-6h16M30 38v14" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg><span class="num small" id="t-steer">—</span></div>
              <div class="ap" id="t-ap"><span class="faint small">Autopilot</span><b id="t-apv">—</b></div>
            </div>
            <div class="pedals">
              <div><span class="small muted">Accelerator</span><div class="meter green"><span id="t-acc" style="width:0%"></span></div></div>
              <div class="flags"><span id="t-blinkL" class="blink">◀</span><span id="t-brake" class="brake">BRAKE</span><span id="t-blinkR" class="blink">▶</span></div>
            </div>
            <dl class="kv tight" id="t-kv"></dl>
            <div id="t-chart"></div>
            <p class="small faint" id="t-note"></p>
          </section>
          <section class="card vw-mapcard">
            <header class="card-h"><h2>Map</h2></header>
            <div class="vw-map" id="vw-map" role="region" aria-label="Map of the drive"></div>
          </section>
          <section class="card">
            <header class="card-h"><h2>Clips</h2><span class="faint small" id="vw-count"></span></header>
            <ol class="seglist" id="vw-segs"></ol>
          </section>
        </aside>
      </div>`;
    const $ = (s) => el.querySelector(s);
    split($('#vw-split'), { id: 'viewer', initial: Math.max(600, (el.clientWidth || 1200) - 360), min: 420, max: 2400 });
    const stage = $('#vw-stage');
    const tiles = Object.fromEntries([...stage.querySelectorAll('.cam')].map((f) => [f.dataset.cam, { fig: f, video: f.querySelector('video') }]));
    // the drive on a map: Flux's violet for driving yourself, its cyan for Autopilot
    const map = createViewerMap($('#vw-map'), { dark: true, colors: { manual: '#a78bfa', autopilot: '#4fd8f0' } });
    // Export: mark a start and an end, see the clips, render one video on the server
    const xp = createExportPanel({
      vehicleId: () => v.id,
      clips: () => st.segs.map((s) => ({ key: s.key, files: s.files, len: durOf(s), cat: s.category })),
      position: () => ({ index: st.idx, t: master()?.currentTime || 0 }),
      units: () => (st.units === 'mph' ? 'mph' : 'kmh'),
      toast
    });
    $('#vw-export').onclick = () => xp.toggle();
    const chart = new TimeChart($('#t-chart'), {
      height: 96, floor: 10, format: (x) => `${Math.round(x)}`, legend: true,
      timeFormat: (t) => `${(t / 1000).toFixed(0)}s`,
      series: [{ key: 'speed', label: 'speed', color: C.cyan }, { key: 'steer', label: '|steering|°', color: C.violet, fill: false }]
    });

    // ---------- playlist ----------
    async function detailOf(id) {
      return api(`/api/vehicles/${encodeURIComponent(v.id)}/recordings/${encodeURIComponent(id)}`);
    }
    async function buildPlaylist() {
      const recId = params.get('rec');
      const day = params.get('day');
      let recs = [];
      let pickList = [];
      if (recId) {
        const d = await detailOf(recId);
        const all = await api(`/api/vehicles/${encodeURIComponent(v.id)}/recordings?date=${encodeURIComponent(d.day)}&limit=500`);
        pickList = all.recordings;
        recs = [d];
        st.title = `${d.category} · ${wallDay(d.start)}`;
        $('#vw-sub').textContent = `${d.folder}${d.event ? ` · ${[humanize(d.event.reason), d.event.city, d.event.street].filter(Boolean).join(' · ')}` : ''}`;
      } else {
        let date = day;
        if (!date) {
          const latest = await api(`/api/vehicles/${encodeURIComponent(v.id)}/recordings?limit=1`);
          date = latest.recordings[0]?.day || latest.dates?.[0];
        }
        if (!date) return { pickList: [] };
        const all = await api(`/api/vehicles/${encodeURIComponent(v.id)}/recordings?date=${encodeURIComponent(date)}&limit=500`);
        pickList = all.recordings;
        const sorted = all.recordings.slice().sort((a, b) => String(a.startKey).localeCompare(String(b.startKey)));
        recs = await Promise.all(sorted.map((r) => detailOf(r.id).catch(() => null)));
        recs = recs.filter(Boolean);
        st.title = `${dayTitle(date)} · whole day`;
        $('#vw-sub').textContent = `${recs.length} recordings played in order`;
      }
      st.segs = recs.flatMap(segmentsOf);
      return { pickList, recId, day };
    }

    function drawPick({ pickList, recId }) {
      const sel = $('#vw-pick');
      const day = pickList[0]?.day;
      sel.innerHTML = `${day ? `<option value="day:${esc(day)}"${recId ? '' : ' selected'}>Whole day ${esc(day)}</option>` : ''}${pickList.slice().sort((a, b) => String(a.startKey).localeCompare(String(b.startKey))).map((r) => `<option value="${esc(r.id)}"${r.id === recId ? ' selected' : ''}>${esc(wall(r.start))} · ${esc(r.category)}${r.eventAt ? ' ★' : ''}</option>`).join('')}`;
      sel.onchange = () => {
        const val = sel.value;
        go(val.startsWith('day:') ? `#/viewer?day=${encodeURIComponent(val.slice(4))}` : `#/viewer?rec=${encodeURIComponent(val)}`);
      };
    }

    // ---------- timeline ----------
    // a clip's length: its video's once played, else the speed index's (one
    // reading a second), else a minute; never one clip's length for all
    // (a short first clip made every block short until each was played)
    const durOf = (s) => (fin(s.dur) && s.dur > 0 ? s.dur : fin(s.idxLen) && s.idxLen > 0 ? s.idxLen : DEFAULT_DUR);
    const total = () => st.segs.reduce((n, s) => n + durOf(s), 0);
    const offsetOf = (i) => st.segs.slice(0, i).reduce((n, s) => n + durOf(s), 0);
    // A whole day can hold hundreds of clips: with a gap between each, the
    // gaps alone outgrow the bar and every clip shrinks to nothing. Below
    // 6 px a clip the bar is drawn solid, without gaps.
    function denseBar() {
      const bar = $('#vw-tl-segs');
      bar.classList.toggle('dense', st.segs.length > (bar.clientWidth || 800) / 6);
    }
    function drawTimeline() {
      const T = total() || 1;
      denseBar();
      $('#vw-tl-segs').innerHTML = st.segs.map((s, i) => {
        let mark = '';
        if (s.eventAt && s.at && s.eventAt >= s.at && s.eventAt < s.at + durOf(s) * 1000 + 30000) {
          const p = Math.min(100, ((s.eventAt - s.at) / 1000 / durOf(s)) * 100);
          mark = `<i class="tl-event" style="left:${p.toFixed(1)}%" title="Event"></i>`;
        }
        return `<span class="tl-seg cat-${esc(s.category)}${i === st.idx ? ' on' : ''}" style="width:${((durOf(s) / T) * 100).toFixed(3)}%" title="${esc(s.key)}">${mark}</span>`;
      }).join('');
      $('#vw-segs').innerHTML = st.segs.map((s, i) => `<li><button type="button" class="${i === st.idx ? 'on' : ''}" data-seg="${i}"><span class="num">${String(i + 1).padStart(2, '0')}</span><span class="mono">${esc(wall(s.key))}</span><span class="cat ${esc(s.category)}">${esc(s.category)}</span><span class="faint small num">${fin(s.dur) ? clock(s.dur) : ''} · ${Object.keys(s.files).length} cams</span></button></li>`).join('');
      $('#vw-count').textContent = `${st.segs.length} clips · ${clock(total())}`;
    }
    $('#vw-segs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-seg]');
      if (b) loadSeg(Number(b.dataset.seg), 0, st.playing);
    });
    function drawHead() {
      const m = master();
      const idx = scrubTo ? scrubTo.i : st.idx;
      const t = scrubTo ? scrubTo.off : m ? m.currentTime : 0;
      const T = total() || 1;
      const pos = offsetOf(idx) + t;
      $('#vw-tl-head').style.left = `${Math.min(100, (pos / T) * 100).toFixed(3)}%`;
      $('#vw-tl').setAttribute('aria-valuenow', String(Math.round((pos / T) * 100)));
      $('#vw-tl').setAttribute('aria-valuetext', `${clock(pos)} of ${clock(T)}`);
      $('#vw-time').textContent = `${clock(t)} / ${clock(durOf(st.segs[idx] || {}))}  ·  clip ${idx + 1}/${st.segs.length}`;
    }
    function seekGlobal(sec) {
      let acc = 0;
      for (let i = 0; i < st.segs.length; i++) {
        const d = durOf(st.segs[i]);
        if (sec < acc + d || i === st.segs.length - 1) {
          const off = Math.max(0, Math.min(d - 0.05, sec - acc));
          if (i === st.idx) seekLocal(off);
          else loadSeg(i, off, st.playing);
          return;
        }
        acc += d;
      }
    }
    const tl = $('#vw-tl');
    const posAt = (e) => {
      const r = tl.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * total();
    };
    // dragging: previews of the second under the pointer at once, the real
    // seek one at a time within the loaded clip, another clip on letting go
    function scrubAt(sec) {
      let acc = 0;
      let i = st.segs.length - 1;
      for (let k = 0; k < st.segs.length; k++) {
        if (sec < acc + durOf(st.segs[k]) || k === st.segs.length - 1) { i = k; break; }
        acc += durOf(st.segs[k]);
      }
      const off = Math.max(0, Math.min(durOf(st.segs[i]) - 0.05, sec - acc));
      scrubTo = { i, off };
      const s = st.segs[i];
      scrubber.show(GRID_ORDER.map((c) => ({ video: tiles[c].video, src: s.files[c] })), off);
      if (i === st.idx) scrubber.seek(activeVideos(), off);
      drawHead();
    }
    function scrubEnd() {
      if (!scrubbing) return;
      scrubbing = false;
      const to = scrubTo;
      scrubTo = null;
      if (to && to.i === st.idx) seekLocal(to.off); else if (to) loadSeg(to.i, to.off, st.playing);
      scrubber.release(GRID_ORDER.map((c) => tiles[c].video));
    }
    tl.addEventListener('pointerdown', (e) => {
      scrubbing = true;
      tl.setPointerCapture(e.pointerId);
      scrubAt(posAt(e));
    });
    tl.addEventListener('pointermove', (e) => {
      const sec = posAt(e);
      const hover = $('#vw-tl-hover');
      hover.hidden = false;
      hover.textContent = clock(sec);
      hover.style.left = `${(sec / (total() || 1)) * 100}%`;
      if (scrubbing) scrubAt(sec);
    });
    tl.addEventListener('pointerup', scrubEnd);
    tl.addEventListener('pointercancel', scrubEnd);
    tl.addEventListener('pointerleave', () => { $('#vw-tl-hover').hidden = true; });
    tl.addEventListener('keydown', (e) => {
      const m = master();
      if (!m) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        seekGlobal(offsetOf(st.idx) + m.currentTime + (e.key === 'ArrowLeft' ? -5 : 5));
      }
    });

    // ---------- videos ----------
    const camsIn = (s) => GRID_ORDER.filter((c) => s?.files[c]);
    function master() {
      const s = st.segs[st.idx];
      if (!s) return null;
      const c = s.files.front ? 'front' : camsIn(s)[0];
      return c ? tiles[c].video : null;
    }
    const activeVideos = () => {
      const s = st.segs[st.idx];
      return s ? camsIn(s).map((c) => tiles[c].video) : [];
    };
    function msg(text) {
      $('#vw-msg').hidden = !text;
      $('#vw-msg').textContent = text || '';
    }

    // A clip that cannot be opened while the playlist plays is skipped (a
    // damaged file: Tesla leaves one when the car powers down mid-clip), so
    // a whole day plays on. Three in a row stop it: then it is the browser
    // that cannot play the format, and the message says so.
    const MAX_SKIPS = 3;
    let skipped = 0;
    function skip(s, why) {
      if (st.idx >= st.segs.length - 1 || skipped >= MAX_SKIPS) return false;
      skipped++;
      toast(`Skipped the clip at ${wall(s.key)}: ${why}`, 'bad');
      loadSeg(st.idx + 1, 0, true);
      return true;
    }
    async function loadSeg(i, offset = 0, autoplay = false) {
      if (i < 0 || i >= st.segs.length) return;
      const seq = ++loadSeq;
      st.idx = i;
      const s = st.segs[i];
      for (const c of GRID_ORDER) {
        const { fig, video } = tiles[c];
        const path = s.files[c];
        fig.classList.toggle('missing', !path);
        fig.querySelector('.cam-none').hidden = Boolean(path);
        if (path) {
          const src = `/api/media?path=${encodeURIComponent(path)}`;
          if (video.dataset.src !== src) {
            video.dataset.src = src;
            video.src = src;
          }
          video.playbackRate = st.speed;
        } else {
          video.removeAttribute('src');
          delete video.dataset.src;
          video.load();
        }
      }
      drawTimeline();
      // scrub previews of this clip and its neighbours, ready before a drag
      scrubber.warm([s, st.segs[i + 1], st.segs[i - 1]].flatMap((x) => (x ? Object.values(x.files) : [])));
      // a picture at once: the preview of this second until the videos show theirs
      scrubber.show(GRID_ORDER.map((c) => ({ video: tiles[c].video, src: s.files[c] })), offset);
      msg('loading…');
      const m = master();
      if (!m) {
        if (autoplay && skip(s, 'it has no video.')) return;
        msg('This clip has no video.');
        return;
      }
      await new Promise((res) => {
        if (m.readyState >= 1) return res();
        const done = () => { m.removeEventListener('loadedmetadata', done); m.removeEventListener('error', done); res(); };
        m.addEventListener('loadedmetadata', done);
        m.addEventListener('error', done);
        setTimeout(done, 8000);
      });
      if (seq !== loadSeq || !alive) return;
      if (m.error) {
        if (autoplay && skip(s, 'the file is damaged or this browser cannot play it.')) return;
        setPlaying(false);
        msg(`This clip can't be played: the file may be damaged, or this browser has no decoder for it (${m.error.message || m.error.code}). Telemetry still shows.`);
        loadTelemetry(s);
        return;
      }
      if (autoplay) skipped = 0;
      msg('');
      if (fin(m.duration)) { s.dur = m.duration; drawTimeline(); }
      // (a camera already there is not sent a seek: even one to where it is
      // throws its decoded frames away, about half a second for six)
      for (const vid of activeVideos()) {
        try { if (Math.abs(vid.currentTime - offset) > 0.01) vid.currentTime = offset; } catch { /* not seekable yet */ }
      }
      scrubber.release(GRID_ORDER.map((c) => tiles[c].video));
      loadTelemetry(s);
      drawHead();
      if (autoplay) play(); else setPlaying(false);
    }

    function setPlaying(on) {
      st.playing = on;
      $('#vw-play').innerHTML = icon(on ? 'pause' : 'play');
      $('#vw-play').setAttribute('aria-label', on ? 'Pause (Space)' : 'Play (Space)');
      stage.classList.toggle('playing', on);
      cancelAnimationFrame(raf);
      if (on) raf = requestAnimationFrame(tick);
      else drawFrame();
    }
    async function play() {
      const vids = activeVideos();
      if (!vids.length) return;
      const m = master();
      if (m && fin(m.duration) && m.currentTime >= m.duration - 0.05) {
        if (st.idx < st.segs.length - 1) { loadSeg(st.idx + 1, 0, true); return; }
        vids.forEach((x) => { x.currentTime = 0; });
      }
      setPlaying(true);
      await Promise.all(vids.map((x) => x.play().catch(() => null)));
    }
    function pause() {
      activeVideos().forEach((x) => x.pause());
      // line every camera up on the master's frame
      const m = master();
      if (m) for (const x of activeVideos()) if (x !== m && Math.abs(x.currentTime - m.currentTime) > 0.02) x.currentTime = m.currentTime;
      setPlaying(false);
    }
    const toggle = () => (st.playing ? pause() : play());
    function seekLocal(t) {
      const m = master();
      if (!m) return;
      const d = fin(m.duration) ? m.duration : durOf(st.segs[st.idx]);
      const target = Math.max(0, Math.min(d - 0.01, t));
      for (const x of activeVideos()) {
        try { x.currentTime = target; } catch { /* not seekable */ }
      }
      drawFrame();
    }
    function step(dir) {
      pause();
      const m = master();
      if (!m) return;
      seekLocal(m.currentTime + dir / (st.fps || 30));
    }
    function setSpeed(s) {
      st.speed = s;
      store.set('vw:speed', s);
      activeVideos().forEach((x) => { x.playbackRate = s; });
      $('#vw-speed').value = String(s);
    }
    function tick() {
      if (!alive) return;
      const m = master();
      if (m && st.playing) {
        // keep the other cameras within a frame or two of the master
        for (const x of activeVideos()) {
          if (x === m || x.seeking || x.readyState < 2) continue;
          syncTo(m, x, st.speed);
          if (x.paused && !m.paused) x.play().catch(() => {});
        }
        if (m.ended || (fin(m.duration) && m.currentTime >= m.duration - 0.03 && m.paused)) {
          if (st.idx < st.segs.length - 1) { loadSeg(st.idx + 1, 0, true); return; }
          setPlaying(false);
        }
      }
      drawFrame();
      if (st.playing) raf = requestAnimationFrame(tick);
    }
    function drawFrame() {
      drawHead();
      drawTelemetry();
    }

    // ---------- telemetry ----------
    async function loadTelemetry(s) {
      const path = s.files.front || Object.values(s.files)[0];
      st.tel = null;
      $('#t-note').textContent = 'reading telemetry…';
      const tel = await telemetryFor(path);
      if (st.segs[st.idx] !== s) return;
      st.tel = tel;
      st.fps = fpsOf(tel) || 36;
      map.addRoute(s.key, tel?.recs);
      if (!tel) {
        $('#t-note').textContent = 'This clip has no telemetry (older firmware, parked, or not a Tesla clip).';
        chart.set([], {});
      } else {
        $('#t-note').textContent = `${tel.recs.length} telemetry records · ${st.fps.toFixed(1)} fps · tap or drag the chart for a readout`;
        const f = st.units === 'mph' ? 2.23694 : 3.6;
        chart.set(tel.times, { speed: tel.recs.map((r) => (fin(r.speed) ? r.speed * f : null)), steer: tel.recs.map((r) => (fin(r.steering) ? Math.abs(r.steering) : null)) });
      }
      drawTelemetry();
    }
    function drawTelemetry() {
      const m = master();
      const r = st.tel && m ? recordAt(st.tel, m.currentTime * 1000) : null;
      map.setPosition(r);
      const f = st.units === 'mph' ? 2.23694 : 3.6;
      $('#t-speed').textContent = r && fin(r.speed) ? Math.round(r.speed * f) : '—';
      el.querySelectorAll('#t-gear [data-g]').forEach((g) => g.classList.toggle('on', Boolean(r) && g.dataset.g === r.gear));
      const ang = r && fin(r.steering) ? r.steering : 0;
      $('#t-wheel').style.transform = `rotate(${ang.toFixed(1)}deg)`;
      $('#t-steer').textContent = r && fin(r.steering) ? `${ang.toFixed(0)}°` : '—';
      $('#t-apv').textContent = r ? r.autopilot : '—';
      $('#t-ap').classList.toggle('on', Boolean(r) && r.autopilot !== 'Off');
      const acc = r && fin(r.accel) ? (r.accel <= 1 ? r.accel * 100 : r.accel) : 0;
      $('#t-acc').style.width = `${Math.max(0, Math.min(100, acc)).toFixed(0)}%`;
      $('#t-brake').classList.toggle('on', Boolean(r?.brake));
      $('#t-blinkL').classList.toggle('on', Boolean(r?.blinkL));
      $('#t-blinkR').classList.toggle('on', Boolean(r?.blinkR));
      $('#t-kv').innerHTML = r ? [
        ['lat, lon', fin(r.lat) && (r.lat || r.lon) ? `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}` : '—'],
        ['heading', fin(r.heading) ? `${r.heading.toFixed(0)}°` : '—'],
        ['accel x/y/z', [r.ax, r.ay, r.az].some(fin) ? [r.ax, r.ay, r.az].map((x) => (fin(x) ? x.toFixed(2) : '—')).join(' / ') : '—'],
        ['frame', fin(r.frame) ? String(r.frame) : '—']
      ].map(([k, x]) => `<dt>${esc(k)}</dt><dd class="num">${esc(x)}</dd>`).join('') : '';
    }
    wireSeg(el, 'units', (u) => {
      st.units = u;
      store.set('vw:units', u);
      $('#t-unit').textContent = u === 'mph' ? 'mph' : 'km/h';
      const s = st.segs[st.idx];
      if (s) loadTelemetry(s);
    });

    // ---------- layout ----------
    function setLayout(l) {
      st.layout = l;
      store.set('vw:layout', l);
      stage.className = `stage lay-${l}${st.hw3 ? ' hw3' : ''}${st.playing ? ' playing' : ''}`;
      el.querySelectorAll('[data-seg="layout"] button').forEach((b) => { b.classList.toggle('on', b.dataset.v === l); b.setAttribute('aria-checked', String(b.dataset.v === l)); });
      drawCamChips();
    }
    function setFocus(c) {
      st.focus = c;
      store.set('vw:focus', c);
      stage.dataset.focus = c;
      GRID_ORDER.forEach((x) => tiles[x].fig.classList.toggle('focused', x === c));
      if (st.layout === 'grid' || st.layout === 'duo') setLayout('focus');
      drawCamChips();
    }
    function drawCamChips() {
      el.querySelectorAll('[data-cam-pick]').forEach((b) => {
        const on = b.dataset.camPick === 'all' ? st.layout === 'grid' : st.layout !== 'grid' && st.focus === b.dataset.camPick;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      });
    }
    wireSeg(el, 'layout', setLayout);
    stage.addEventListener('click', (e) => {
      const hit = e.target.closest('.cam-hit');
      if (!hit) return;
      const c = hit.closest('.cam').dataset.cam;
      if (st.layout !== 'grid' && st.focus === c) setLayout(st.layout === 'single' ? 'focus' : 'single');
      else setFocus(c);
    });
    stage.addEventListener('dblclick', (e) => {
      const fig = e.target.closest('.cam');
      if (!fig) return;
      st.focus = fig.dataset.cam;
      stage.dataset.focus = st.focus;
      GRID_ORDER.forEach((x) => tiles[x].fig.classList.toggle('focused', x === st.focus));
      setLayout(st.layout === 'single' ? 'grid' : 'single');
    });
    $('#vw-camchips').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cam-pick]');
      if (!b) return;
      if (b.dataset.camPick === 'all') setLayout('grid'); else setFocus(b.dataset.camPick);
    });
    GRID_ORDER.forEach((x) => tiles[x].fig.classList.toggle('focused', x === st.focus));
    drawCamChips();

    // ---------- controls ----------
    $('#vw-play').onclick = toggle;
    $('#vw-back').onclick = () => step(-1);
    $('#vw-fwd').onclick = () => step(1);
    $('#vw-prev').onclick = () => loadSeg(Math.max(0, st.idx - 1), 0, st.playing);
    $('#vw-next').onclick = () => loadSeg(Math.min(st.segs.length - 1, st.idx + 1), 0, st.playing);
    $('#vw-speed').onchange = (e) => setSpeed(Number(e.target.value));
    $('#vw-full').onclick = () => {
      const box = $('.vw-main');
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      else if (box.requestFullscreen) box.requestFullscreen().catch(() => toast('Fullscreen is not available here.', 'bad'));
      else toast('Fullscreen is not available here.', 'bad');
    };
    $('#vw-tele-btn').onclick = () => {
      st.tele = !st.tele;
      store.set('vw:tele', st.tele);
      $('#vw-split').classList.toggle('no-tele', !st.tele);
      $('#vw-tele-btn').setAttribute('aria-pressed', String(st.tele));
      window.dispatchEvent(new Event('resize'));
    };
    // master errors and stalls
    for (const c of GRID_ORDER) {
      tiles[c].video.addEventListener('error', () => {
        if (tiles[c].video.getAttribute('src')) tiles[c].fig.classList.add('err');
      });
      tiles[c].video.addEventListener('loadeddata', () => tiles[c].fig.classList.remove('err'));
    }

    // ---------- start ----------
    let info;
    try {
      info = await buildPlaylist();
    } catch (err) {
      el.querySelector('.vw-main').innerHTML = empty(esc(err.message));
      map.destroy();
      xp.destroy();
      return {};
    }
    $('#vw-title').textContent = st.title || 'no footage';
    drawPick(info);
    // HW3 or HW4 from the footage itself, as the built-in Viewer does: only
    // HW4 cars record the pillar cameras, so without them there are no
    // pillar tiles or buttons and the grid is 2 x 2
    st.hw3 = !st.segs.some((s) => s.files.left_pillar || s.files.right_pillar);
    stage.classList.toggle('hw3', st.hw3);
    for (const c of GRID_ORDER) tiles[c].fig.hidden = st.hw3 && c.endsWith('_pillar');
    el.querySelectorAll('[data-cam-pick]').forEach((b) => { b.hidden = st.hw3 && b.dataset.camPick.endsWith('_pillar'); });
    if (st.hw3 && String(st.focus).endsWith('_pillar')) {
      // a pillar was the focused camera: the front instead, layout unchanged
      st.focus = 'front';
      stage.dataset.focus = 'front';
      GRID_ORDER.forEach((x) => tiles[x].fig.classList.toggle('focused', x === 'front'));
      drawCamChips();
    }
    if (!st.segs.length) {
      msg('No clips to play yet. Footage appears here once the car has recorded some.');
      drawTimeline();
    } else {
      // an event: start a little before the event moment
      let start = 0;
      let off = 0;
      const ev = st.segs.find((s) => s.eventAt);
      if (info.recId && ev) {
        const i = st.segs.findIndex((s) => s.at && ev.eventAt >= s.at && ev.eventAt < s.at + 60000);
        if (i >= 0) { start = i; off = Math.max(0, (ev.eventAt - st.segs[i].at) / 1000 - 5); }
      }
      await loadSeg(start, off, !reducedMotion() && params.get('autoplay') !== '0');
      loadLengths();
      loadRoute();
    }

    // every clip's length from the server's speed index, so the timeline's
    // blocks are their true size before each clip is played
    async function loadLengths() {
      for (const day of new Set(st.segs.map((s) => String(s.key).slice(0, 10)))) {
        try {
          const { speeds } = await api(`/api/vehicles/${encodeURIComponent(v.id)}/speeds?date=${encodeURIComponent(day)}`);
          for (const s of st.segs) {
            const sp = s.files.front && speeds?.[s.files.front];
            if (Array.isArray(sp) && sp.length) s.idxLen = sp.length;
          }
        } catch { /* a minute each until played */ }
        if (!alive) return;
      }
      drawTimeline();
      drawHead();
    }

    // the rest of the playlist's route, a few clips at a time, nearest first
    async function loadRoute() {
      const order = st.segs.map((s, k) => [Math.abs(k - st.idx), s]).sort((a, b) => a[0] - b[0]).map(([, s]) => s).slice(0, 40);
      for (let k = 0; k < order.length && alive; k += 4) {
        await Promise.all(order.slice(k, k + 4).map(async (s) => {
          const tel = await telemetryFor(s.files.front || Object.values(s.files)[0]);
          if (alive && tel) map.addRoute(s.key, tel.recs);
        }));
      }
    }

    return {
      unmount() {
        alive = false;
        cancelAnimationFrame(raf);
        chart.destroy();
        map.destroy();
        xp.destroy();
        for (const c of GRID_ORDER) {
          const vid = tiles[c].video;
          vid.pause();
          vid.removeAttribute('src');
          vid.load();
        }
      },
      onVehicle() { go('#/viewer'); },
      onKey(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return false;
        const m = master();
        switch (e.key) {
          case ' ': case 'k': toggle(); return true;
          case ',': step(-1); return true;
          case '.': step(1); return true;
          case 'ArrowLeft': if (m) seekGlobal(offsetOf(st.idx) + m.currentTime - (e.shiftKey ? 1 : 5)); return true;
          case 'ArrowRight': if (m) seekGlobal(offsetOf(st.idx) + m.currentTime + (e.shiftKey ? 1 : 5)); return true;
          case '[': setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(st.speed) - 1)] ?? 1); toast(`Speed ${st.speed}×`); return true;
          case ']': setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(st.speed) + 1)] ?? 1); toast(`Speed ${st.speed}×`); return true;
          case 'n': $('#vw-next').click(); return true;
          case 'p': $('#vw-prev').click(); return true;
          case '0': setLayout('grid'); return true;
          case 'l': setLayout(LAYOUTS[(LAYOUTS.findIndex(([x]) => x === st.layout) + 1) % LAYOUTS.length][0]); return true;
          case 't': $('#vw-tele-btn').click(); return true;
          case 'f': $('#vw-full').click(); return true;
          case 'e': xp.toggle(); return true;
          default:
            if (/^[1-6]$/.test(e.key)) { const c = CAMERAS[Number(e.key) - 1]; if (!tiles[c].fig.hidden) setFocus(c); return true; }
            return false;
        }
      },
      commands: () => [
        { group: 'Viewer', label: st.playing ? 'Pause' : 'Play', hint: 'Space', icon: st.playing ? 'pause' : 'play', run: toggle },
        { group: 'Viewer', label: 'Next clip', hint: 'n', icon: 'next', run: () => $('#vw-next').click() },
        { group: 'Viewer', label: 'Export a video', hint: 'e', icon: 'download', run: () => xp.open() },
        { group: 'Viewer', label: 'Previous clip', hint: 'p', icon: 'prev', run: () => $('#vw-prev').click() },
        ...LAYOUTS.map(([l, label]) => ({ group: 'Viewer layout', label: `Layout: ${label}`, icon: 'grid', run: () => setLayout(l) })),
        ...CAMERAS.map((c, i) => ({ group: 'Viewer camera', label: `Focus ${CAMERA_LABEL[c]}`, hint: String(i + 1), icon: 'viewer', run: () => setFocus(c) })),
        ...SPEEDS.map((s) => ({ group: 'Viewer speed', label: `Speed ${s}×`, icon: 'gauge', run: () => setSpeed(s) }))
      ]
    };
  }
};
