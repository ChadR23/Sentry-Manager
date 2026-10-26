// Viewer: a full-bleed heads-up display. The main camera fills the stage with the
// car's telemetry drawn over it (speed, gear, blinkers, Autopilot, brake, wheel);
// the other cameras ride along as picture-in-picture tiles you tap to swap in.
import { h, ico, api, car, toast, local, ok, dayName, words, mmss, CAMS, CAM_NAME, CAM_TAG } from '../core.js';
import { load as loadTel, at as telAt, rate as telRate } from '../telemetry.js';

const FILE_RE = /(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-([a-z0-9_]+)\.mp4$/i;
const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];
const NOMINAL = 60;
const PIP_ORDER = ['left_pillar', 'right_pillar', 'left_repeater', 'right_repeater', 'back', 'front'];
const utc = (k) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[_ T](\d{2})[-:](\d{2})[-:](\d{2})/.exec(k || '');
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
};

function clipsOf(d) {
  const by = new Map();
  for (const f of d.files || []) {
    const m = FILE_RE.exec(f.rel);
    if (!m) continue;
    if (!by.has(m[1])) by.set(m[1], { key: m[1], at: utc(m[1]), files: {}, rec: d.id, cat: d.category, eventAt: utc(d.eventAt), len: null });
    by.get(m[1]).files[m[2].toLowerCase()] = f.path;
  }
  return [...by.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export default {
  async mount(el, { params, go, status }) {
    const v = car();
    if (!v) {
      el.innerHTML = `<section class="panel hud"><div class="blank">${ico('viewer', 'i big')}<p>Add a vehicle to play its footage.</p><a class="btn go" href="#/settings/vehicles?add=1">${ico('plus')}Add a vehicle</a></div></section>`;
      return {};
    }
    const st = {
      main: local.get('vw.main', 'front'),
      grid: local.get('vw.grid', false),
      hud: local.get('vw.hud', true),
      units: local.get('vw.units', 'mph'),
      speed: local.get('vw.speed', 1),
      clips: [],
      i: 0,
      playing: false,
      tel: null,
      fps: 36,
      knownLen: null
    };
    let alive = true;
    let raf = 0;
    let loadSeq = 0;
    let scrub = false;

    el.innerHTML = `
      <section class="vw" id="vw">
        <div class="vw-stage${st.grid ? ' all' : ''}${st.hud ? '' : ' nohud'}" id="vw-stage" data-main="${h(st.main)}">
          ${CAMS.map((c) => `<figure class="cam${c === st.main ? ' main' : ''}" data-cam="${c}" style="--o:${PIP_ORDER.indexOf(c)}">
            <video muted playsinline webkit-playsinline preload="auto" disablepictureinpicture disableremoteplayback aria-label="${h(CAM_NAME[c])} camera"></video>
            <figcaption><b>${CAM_TAG[c]}</b><span>${h(CAM_NAME[c])}</span></figcaption>
            <span class="cam-none" hidden>No ${h(CAM_NAME[c])} video</span>
            <button class="cam-swap" type="button" aria-label="Show the ${h(CAM_NAME[c])} camera large"><span class="sr-only">Swap</span></button>
          </figure>`).join('')}
          <div class="hud-layer" id="vw-hud" aria-hidden="true">
            <div class="hud-tl"><span class="hud-clock num" id="h-clock">--:--:--</span><span class="hud-tag" id="h-tag"></span></div>
            <div class="hud-tr"><span class="hud-cam" id="h-cam"></span><span class="hud-gps num" id="h-gps"></span></div>
            <div class="hud-center">
              <span class="blink l" id="h-bl">${ico('arrow-l')}</span>
              <div class="speed"><b class="num" id="h-speed">--</b><span id="h-unit">${st.units === 'mph' ? 'MPH' : 'KM/H'}</span></div>
              <span class="blink r" id="h-br">${ico('arrow-r')}</span>
            </div>
            <div class="hud-low">
              <div class="gears" id="h-gear">${['P', 'R', 'N', 'D'].map((g) => `<i data-g="${g}">${g}</i>`).join('')}</div>
              <span class="ap" id="h-ap">${ico('wheel')}<em id="h-apt">AP off</em></span>
              <span class="brake" id="h-brake">BRAKE</span>
              <span class="steer" id="h-steer">${ico('wheel')}<em class="num" id="h-steert">0°</em></span>
              <span class="pedal"><i id="h-pedal"></i></span>
            </div>
          </div>
          <div class="vw-msg" id="vw-msg" role="status" hidden></div>
        </div>
        <div class="vw-bar hud cyan">
          <div class="tl" id="vw-tl" role="slider" tabindex="0" aria-label="Position in the playlist" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <div class="tl-clips" id="vw-tlc"></div><div class="tl-head" id="vw-tlh"></div>
          </div>
          <div class="transport">
            <div class="tp-l">
              <button class="btn icon" type="button" id="vw-prev" aria-label="Previous clip (p)">${ico('prev')}</button>
              <button class="btn icon" type="button" id="vw-back" aria-label="One frame back ( , )">${ico('step-b')}</button>
              <button class="btn icon play" type="button" id="vw-play" aria-label="Play (Space)">${ico('play')}</button>
              <button class="btn icon" type="button" id="vw-fwd" aria-label="One frame forward ( . )">${ico('step-f')}</button>
              <button class="btn icon" type="button" id="vw-next" aria-label="Next clip (n)">${ico('next')}</button>
            </div>
            <div class="tp-time num" id="vw-time">0:00 / 0:00</div>
            <div class="tp-r">
              <label class="sr-only" for="vw-speed">Playback speed</label>
              <select class="in" id="vw-speed">${SPEEDS.map((s) => `<option value="${s}"${s === st.speed ? ' selected' : ''}>${s}×</option>`).join('')}</select>
              <button class="btn sm" type="button" id="vw-units" aria-label="Speed units (u)">${st.units === 'mph' ? 'mph' : 'km/h'}</button>
              <button class="btn icon" type="button" id="vw-hudb" aria-pressed="${st.hud}" aria-label="Heads-up display (h)">${ico('hud')}</button>
              <button class="btn icon" type="button" id="vw-gridb" aria-pressed="${st.grid}" aria-label="All six cameras (0)">${ico('grid')}</button>
              <button class="btn icon" type="button" id="vw-full" aria-label="Fullscreen (f)">${ico('full')}</button>
            </div>
          </div>
          <div class="camrow" role="group" aria-label="Main camera">${CAMS.map((c, k) => `<button class="btn sm" type="button" data-pick="${c}" aria-pressed="${c === st.main}">${h(CAM_NAME[c])} <kbd>${k + 1}</kbd></button>`).join('')}</div>
        </div>
        <aside class="vw-side">
          <section class="panel hud"><div class="ph"><h2>${ico('film')}Now playing</h2></div>
            <p class="chrome vw-title" id="vw-title">Loading…</p><p class="small dim" id="vw-sub"></p>
            <label class="fld">Recording<select class="in" id="vw-pick"></select></label>
            <ol class="cliplist" id="vw-clips" aria-label="Clips"></ol>
          </section>
          <section class="panel hud"><div class="ph"><h2>${ico('hud')}Telemetry</h2></div><dl class="kv" id="vw-kv"></dl><p class="small faint" id="vw-tnote"></p></section>
        </aside>
      </section>`;
    const $ = (s) => el.querySelector(s);
    const stage = $('#vw-stage');
    const tiles = Object.fromEntries([...stage.querySelectorAll('.cam')].map((f) => [f.dataset.cam, { fig: f, video: f.querySelector('video') }]));

    // ---------- playlist ----------
    const detail = (id) => api(`/api/vehicles/${encodeURIComponent(v.id)}/recordings/${encodeURIComponent(id)}`);
    async function build() {
      const recId = params.get('rec');
      let day = params.get('day');
      let list = [];
      let recs = [];
      if (recId) {
        const d = await detail(recId);
        day = d.day;
        list = (await api(`/api/vehicles/${encodeURIComponent(v.id)}/recordings?date=${encodeURIComponent(d.day)}&limit=500`)).recordings;
        recs = [d];
        $('#vw-title').textContent = `${d.category} · ${d.start.slice(11)}`;
        $('#vw-sub').textContent = `${dayName(d.day, true)}${d.event ? ` · ${[words(d.event.reason), d.event.city, d.event.street].filter(Boolean).join(' · ')}` : ''}`;
      } else {
        if (!day) {
          const latest = await api(`/api/vehicles/${encodeURIComponent(v.id)}/recordings?limit=1`);
          day = latest.recordings[0]?.day || latest.dates?.[0];
        }
        if (!day) return { list: [], recId: null, day: null };
        list = (await api(`/api/vehicles/${encodeURIComponent(v.id)}/recordings?date=${encodeURIComponent(day)}&limit=500`)).recordings;
        const order = list.slice().sort((a, b) => String(a.startKey).localeCompare(String(b.startKey)));
        recs = (await Promise.all(order.map((r) => detail(r.id).catch(() => null)))).filter(Boolean);
        $('#vw-title').textContent = 'Whole day';
        $('#vw-sub').textContent = `${dayName(day, true)} · ${recs.length} recordings in order`;
      }
      st.clips = recs.flatMap(clipsOf);
      return { list, recId, day };
    }
    function drawPick({ list, recId, day }) {
      const sel = $('#vw-pick');
      sel.innerHTML = `${day ? `<option value="day:${h(day)}"${recId ? '' : ' selected'}>Whole day · ${h(dayName(day))}</option>` : ''}${list.slice().sort((a, b) => String(a.startKey).localeCompare(String(b.startKey))).map((r) => `<option value="${h(r.id)}"${r.id === recId ? ' selected' : ''}>${h(r.start.slice(11))} · ${h(r.category)}${r.eventAt ? ' · event' : ''}</option>`).join('')}`;
      sel.onchange = () => go(sel.value.startsWith('day:') ? `#/viewer?day=${encodeURIComponent(sel.value.slice(4))}` : `#/viewer?rec=${encodeURIComponent(sel.value)}`);
    }

    // ---------- timeline ----------
    const lenOf = (c) => (ok(c?.len) && c.len > 0 ? c.len : st.knownLen || NOMINAL);
    const total = () => st.clips.reduce((n, c) => n + lenOf(c), 0);
    const offset = (i) => st.clips.slice(0, i).reduce((n, c) => n + lenOf(c), 0);
    function drawClips() {
      const T = total() || 1;
      $('#vw-tlc').innerHTML = st.clips.map((c, i) => {
        let mark = '';
        if (c.eventAt && c.at && c.eventAt >= c.at && c.eventAt < c.at + lenOf(c) * 1000 + 30000) mark = `<i class="tl-ev" style="left:${Math.min(100, ((c.eventAt - c.at) / 1000 / lenOf(c)) * 100).toFixed(1)}%"></i>`;
        return `<span class="tl-c c-${h(c.cat)}${i === st.i ? ' on' : ''}" style="width:${((lenOf(c) / T) * 100).toFixed(3)}%">${mark}</span>`;
      }).join('');
      $('#vw-clips').innerHTML = st.clips.map((c, i) => `<li><button type="button" class="clipbtn${i === st.i ? ' on' : ''}" data-clip="${i}"${i === st.i ? ' aria-current="true"' : ''}><span class="num faint">${String(i + 1).padStart(2, '0')}</span><b class="num">${h(c.key.slice(11).replace(/-/g, ':'))}</b><span class="pill ${c.cat === 'Sentry' ? 'org' : c.cat === 'Saved' ? 'grn' : 'cyan'}">${h(c.cat)}</span><span class="num faint small">${ok(c.len) ? mmss(c.len) : ''} · ${Object.keys(c.files).length} cams</span></button></li>`).join('');
    }
    $('#vw-clips').addEventListener('click', (e) => {
      const b = e.target.closest('[data-clip]');
      if (b) open(Number(b.dataset.clip), 0, st.playing);
    });
    function drawTime() {
      const m = master();
      const t = m ? m.currentTime : 0;
      const T = total() || 1;
      const pos = offset(st.i) + t;
      $('#vw-tlh').style.transform = `translateX(${(Math.min(1, pos / T) * $('#vw-tl').clientWidth).toFixed(1)}px)`;
      $('#vw-tl').setAttribute('aria-valuenow', String(Math.round((pos / T) * 100)));
      $('#vw-tl').setAttribute('aria-valuetext', `${mmss(pos)} of ${mmss(T)}`);
      $('#vw-time').textContent = `${mmss(t)} / ${mmss(lenOf(st.clips[st.i]))} · clip ${st.i + 1}/${st.clips.length}`;
      const c = st.clips[st.i];
      if (c?.at) {
        const d = new Date(c.at + t * 1000);
        $('#h-clock').textContent = d.toISOString().slice(11, 19);
      }
    }
    function seekAll(sec) {
      let acc = 0;
      for (let i = 0; i < st.clips.length; i++) {
        const d = lenOf(st.clips[i]);
        if (sec < acc + d || i === st.clips.length - 1) {
          const off = Math.max(0, Math.min(d - 0.05, sec - acc));
          if (i === st.i) seek(off); else open(i, off, st.playing);
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
    tl.addEventListener('pointerdown', (e) => { scrub = true; tl.setPointerCapture(e.pointerId); seekAll(posAt(e)); });
    tl.addEventListener('pointermove', (e) => { if (scrub) seekAll(posAt(e)); });
    tl.addEventListener('pointerup', () => { scrub = false; });
    tl.addEventListener('pointercancel', () => { scrub = false; });
    tl.addEventListener('keydown', (e) => {
      const m = master();
      if (!m || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      seekAll(offset(st.i) + m.currentTime + (e.key === 'ArrowLeft' ? -5 : 5));
    });

    // ---------- video ----------
    const camsIn = (c) => CAMS.filter((x) => c?.files[x]);
    function master() {
      const c = st.clips[st.i];
      if (!c) return null;
      const k = c.files[st.main] ? st.main : c.files.front ? 'front' : camsIn(c)[0];
      return k ? tiles[k].video : null;
    }
    const active = () => camsIn(st.clips[st.i]).map((c) => tiles[c].video);
    function say(text) {
      $('#vw-msg').hidden = !text;
      $('#vw-msg').innerHTML = text || '';
    }
    const cantPlay = (err) => `<b>This browser can't play this video.</b><span>The clip is probably H.264 or H.265 and this browser has no decoder for it<small class="tech"> (${h(err?.message || `code ${err?.code ?? '?'}`)})</small>. Convert it to AV1 on the Encoder page, or open it in Safari or Chrome on a device with that codec. Telemetry still shows.</span>`;

    async function open(i, at = 0, autoplay = false) {
      if (i < 0 || i >= st.clips.length) return;
      const mine = ++loadSeq;
      st.i = i;
      const c = st.clips[i];
      for (const k of CAMS) {
        const { fig, video } = tiles[k];
        const path = c.files[k];
        fig.classList.toggle('missing', !path);
        fig.classList.remove('err');
        fig.querySelector('.cam-none').hidden = Boolean(path);
        if (path) {
          const src = `/api/media?path=${encodeURIComponent(path)}`;
          if (video.dataset.src !== src) { video.dataset.src = src; video.src = src; }
          video.playbackRate = st.speed;
        } else {
          video.removeAttribute('src');
          delete video.dataset.src;
          video.load();
        }
      }
      drawClips();
      say('<span class="spin" aria-hidden="true"></span><span>Loading the clip…</span>');
      const m = master();
      if (!m) { say('<b>This clip has no video.</b>'); return; }
      await new Promise((res) => {
        if (m.readyState >= 1 || m.error) { res(); return; }
        const done = () => { m.removeEventListener('loadedmetadata', done); m.removeEventListener('error', done); res(); };
        m.addEventListener('loadedmetadata', done);
        m.addEventListener('error', done);
        setTimeout(done, 10000);
      });
      if (mine !== loadSeq || !alive) return;
      loadTelemetry(c);
      if (m.error) {
        say(cantPlay(m.error));
        setPlaying(false);
        return;
      }
      say('');
      if (ok(m.duration)) { c.len = m.duration; st.knownLen = st.knownLen || m.duration; drawClips(); }
      for (const x of active()) {
        try { x.currentTime = at; } catch { /* not seekable yet */ }
      }
      drawTime();
      if (autoplay) play(); else setPlaying(false);
    }

    function setPlaying(on) {
      st.playing = on;
      $('#vw-play').innerHTML = ico(on ? 'pause' : 'play');
      $('#vw-play').setAttribute('aria-label', on ? 'Pause (Space)' : 'Play (Space)');
      stage.classList.toggle('playing', on);
      window.HorizonSky?.hold('video', on);
      cancelAnimationFrame(raf);
      if (on) raf = requestAnimationFrame(tick); else frame();
      status(`${on ? '▶' : 'Ⅱ'} clip ${st.i + 1}/${st.clips.length}`);
    }
    async function play() {
      const vids = active();
      const m = master();
      if (!vids.length || !m) return;
      if (m.error) { say(cantPlay(m.error)); return; }
      if (ok(m.duration) && m.currentTime >= m.duration - 0.05) {
        if (st.i < st.clips.length - 1) { open(st.i + 1, 0, true); return; }
        vids.forEach((x) => { x.currentTime = 0; });
      }
      setPlaying(true);
      await Promise.all(vids.map((x) => x.play().catch(() => null)));
      if (m.paused && m.error) { setPlaying(false); say(cantPlay(m.error)); }
    }
    function pause() {
      active().forEach((x) => x.pause());
      const m = master();
      if (m) for (const x of active()) if (x !== m && Math.abs(x.currentTime - m.currentTime) > 0.02) x.currentTime = m.currentTime;
      setPlaying(false);
    }
    const toggle = () => (st.playing ? pause() : play());
    function seek(t) {
      const m = master();
      if (!m) return;
      const d = ok(m.duration) ? m.duration : lenOf(st.clips[st.i]);
      const target = Math.max(0, Math.min(d - 0.01, t));
      for (const x of active()) {
        try { x.currentTime = target; } catch { /* not seekable */ }
      }
      frame();
    }
    function step(dir) {
      pause();
      const m = master();
      if (m) seek(m.currentTime + dir / (st.fps || 30));
    }
    function setSpeed(s) {
      st.speed = s;
      local.set('vw.speed', s);
      active().forEach((x) => { x.playbackRate = s; });
      $('#vw-speed').value = String(s);
    }
    function tick() {
      if (!alive) return;
      const m = master();
      if (m && st.playing) {
        for (const x of active()) {
          if (x === m || x.seeking || x.readyState < 2 || x.error) continue;
          if (Math.abs(x.currentTime - m.currentTime) > 0.15) x.currentTime = m.currentTime;
          if (x.paused && !m.paused) x.play().catch(() => {});
        }
        if (m.ended || (ok(m.duration) && m.currentTime >= m.duration - 0.03 && m.paused)) {
          if (st.i < st.clips.length - 1) { open(st.i + 1, 0, true); return; }
          setPlaying(false);
          return;
        }
      }
      frame();
      if (st.playing) raf = requestAnimationFrame(tick);
    }
    function frame() {
      drawTime();
      drawHud();
    }

    // ---------- the heads-up display ----------
    async function loadTelemetry(c) {
      const path = c.files.front || Object.values(c.files)[0];
      st.tel = null;
      $('#vw-tnote').textContent = 'Reading telemetry…';
      const tel = await loadTel(path);
      if (st.clips[st.i] !== c || !alive) return;
      st.tel = tel;
      st.fps = telRate(tel) || 36;
      $('#vw-tnote').textContent = tel ? `${tel.r.length} telemetry records · ${st.fps.toFixed(1)} per second` : 'This clip carries no telemetry (older firmware, parked, or not a Tesla clip).';
      stage.classList.toggle('notel', !tel);
      drawHud();
    }
    function drawHud() {
      const m = master();
      const r = st.tel && m ? telAt(st.tel, m.currentTime * 1000) : null;
      const f = st.units === 'mph' ? 2.23694 : 3.6;
      $('#h-speed').textContent = r && ok(r.speed) ? String(Math.round(Math.abs(r.speed) * f)) : '--';
      el.querySelectorAll('#h-gear [data-g]').forEach((g) => g.classList.toggle('on', Boolean(r) && g.dataset.g === r.gear));
      $('#h-bl').classList.toggle('on', Boolean(r?.left));
      $('#h-br').classList.toggle('on', Boolean(r?.right));
      $('#h-brake').classList.toggle('on', Boolean(r?.brake));
      const ap = r && r.pilot !== 'off';
      $('#h-ap').classList.toggle('on', Boolean(ap));
      $('#h-apt').textContent = r ? (ap ? r.pilot : 'AP off') : 'AP —';
      const ang = r && ok(r.steer) ? r.steer : 0;
      $('#h-steer').querySelector('.i').style.transform = `rotate(${ang.toFixed(0)}deg)`;
      $('#h-steert').textContent = `${ang.toFixed(0)}°`;
      const ped = r && ok(r.pedal) ? (r.pedal <= 1 ? r.pedal * 100 : r.pedal) : 0;
      $('#h-pedal').style.transform = `scaleX(${Math.max(0, Math.min(100, ped)) / 100})`;
      $('#h-gps').textContent = r && ok(r.lat) && (r.lat || r.lon) ? `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}${ok(r.heading) ? ` · ${Math.round(r.heading)}°` : ''}` : '';
      $('#vw-kv').innerHTML = r ? [
        ['Speed', ok(r.speed) ? `${(Math.abs(r.speed) * f).toFixed(1)} ${st.units === 'mph' ? 'mph' : 'km/h'}` : '—'],
        ['Gear', r.gear], ['Autopilot', r.pilot], ['Steering', `${ang.toFixed(1)}°`], ['Accelerator', `${Math.round(ped)}%`], ['Brake', r.brake ? 'on' : 'off'],
        ['Blinkers', [r.left && 'left', r.right && 'right'].filter(Boolean).join(' + ') || 'off'],
        ['Position', ok(r.lat) && (r.lat || r.lon) ? `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}` : '—'],
        ['Heading', ok(r.heading) ? `${r.heading.toFixed(0)}°` : '—'],
        ['Accel x/y/z', [r.ax, r.ay, r.az].some(ok) ? [r.ax, r.ay, r.az].map((x) => (ok(x) ? x.toFixed(2) : '—')).join(' / ') : '—'],
        ['Frame', ok(r.frame) ? String(r.frame) : '—']
      ].map(([k, x]) => `<dt>${h(k)}</dt><dd class="num">${h(x)}</dd>`).join('') : '<dt>Telemetry</dt><dd>—</dd>';
    }

    // ---------- cameras ----------
    function setMain(c) {
      st.main = c;
      local.set('vw.main', c);
      stage.dataset.main = c;
      CAMS.forEach((k) => tiles[k].fig.classList.toggle('main', k === c));
      el.querySelectorAll('[data-pick]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pick === c)));
      $('#h-cam').textContent = CAM_NAME[c];
      if (st.grid) setGrid(false);
      // the clock follows the new main camera
      const m = master();
      if (m) for (const x of active()) if (x !== m && Math.abs(x.currentTime - m.currentTime) > 0.1) x.currentTime = m.currentTime;
      frame();
    }
    function setGrid(on) {
      st.grid = on;
      local.set('vw.grid', on);
      stage.classList.toggle('all', on);
      $('#vw-gridb').setAttribute('aria-pressed', String(on));
    }
    function setHud(on) {
      st.hud = on;
      local.set('vw.hud', on);
      stage.classList.toggle('nohud', !on);
      $('#vw-hudb').setAttribute('aria-pressed', String(on));
    }
    function setUnits(u) {
      st.units = u;
      local.set('vw.units', u);
      $('#vw-units').textContent = u === 'mph' ? 'mph' : 'km/h';
      $('#h-unit').textContent = u === 'mph' ? 'MPH' : 'KM/H';
      drawHud();
    }
    stage.addEventListener('click', (e) => {
      const b = e.target.closest('.cam-swap');
      if (!b) return;
      const c = b.closest('.cam').dataset.cam;
      if (c === st.main && !st.grid) toggle(); else setMain(c);
    });
    el.querySelector('.camrow').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (b) setMain(b.dataset.pick);
    });
    for (const k of CAMS) {
      tiles[k].video.addEventListener('error', () => { if (tiles[k].video.getAttribute('src')) tiles[k].fig.classList.add('err'); });
      tiles[k].video.addEventListener('loadeddata', () => tiles[k].fig.classList.remove('err'));
    }

    // ---------- controls ----------
    $('#vw-play').onclick = toggle;
    $('#vw-back').onclick = () => step(-1);
    $('#vw-fwd').onclick = () => step(1);
    $('#vw-prev').onclick = () => open(Math.max(0, st.i - 1), 0, st.playing);
    $('#vw-next').onclick = () => open(Math.min(st.clips.length - 1, st.i + 1), 0, st.playing);
    $('#vw-speed').onchange = (e) => setSpeed(Number(e.target.value));
    $('#vw-units').onclick = () => setUnits(st.units === 'mph' ? 'kmh' : 'mph');
    $('#vw-hudb').onclick = () => setHud(!st.hud);
    $('#vw-gridb').onclick = () => setGrid(!st.grid);
    const box = $('#vw');
    $('#vw-full').onclick = () => {
      if (document.fullscreenElement) { document.exitFullscreen?.().catch(() => {}); return; }
      if (box.classList.contains('theater')) { box.classList.remove('theater'); document.body.classList.remove('theater-on'); return; }
      if (box.requestFullscreen && document.fullscreenEnabled !== false) box.requestFullscreen().catch(() => { box.classList.add('theater'); document.body.classList.add('theater-on'); });
      else { box.classList.add('theater'); document.body.classList.add('theater-on'); }
    };
    const onVis = () => { if (document.hidden && st.playing) pause(); };
    document.addEventListener('visibilitychange', onVis);

    // ---------- start ----------
    $('#h-cam').textContent = CAM_NAME[st.main];
    let info;
    try {
      info = await build();
    } catch (err) {
      say(`<b>${h(err.message)}</b>`);
      return { unmount() { alive = false; document.removeEventListener('visibilitychange', onVis); } };
    }
    drawPick(info);
    $('#h-tag').textContent = info.recId ? $('#vw-title').textContent : (info.day ? dayName(info.day) : '');
    if (!st.clips.length) {
      say('<b>No clips to play yet.</b><span>Footage shows up here once the car has recorded some.</span>');
      drawClips();
    } else {
      let start = 0;
      let off = 0;
      const ev = st.clips.find((c) => c.eventAt);
      if (info.recId && ev) {
        const k = st.clips.findIndex((c) => c.at && ev.eventAt >= c.at && ev.eventAt < c.at + 60000);
        if (k >= 0) { start = k; off = Math.max(0, (ev.eventAt - st.clips[k].at) / 1000 - 5); }
      }
      await open(start, off, params.get('autoplay') !== '0');
    }

    return {
      unmount() {
        alive = false;
        cancelAnimationFrame(raf);
        document.removeEventListener('visibilitychange', onVis);
        document.body.classList.remove('theater-on');
        window.HorizonSky?.hold('video', false);
        for (const k of CAMS) {
          const x = tiles[k].video;
          x.pause();
          x.removeAttribute('src');
          x.load();
        }
      },
      onCar() { go('#/viewer'); },
      keys: [['Space or k', 'Play / pause'], ['← / →', 'Seek 5 s (Shift: 1 s)'], [', / .', 'One frame back / forward'], ['n / p', 'Next / previous clip'], ['1 … 6', 'Camera large: front, rear, repeaters, pillars'], ['0', 'All six cameras'], ['h', 'Heads-up display on / off'], ['u', 'mph / km/h'], ['- / +', 'Slower / faster'], ['f', 'Fullscreen']],
      onKey(e) {
        const m = master();
        switch (e.key) {
          case ' ': case 'k': toggle(); return true;
          case ',': step(-1); return true;
          case '.': step(1); return true;
          case 'ArrowLeft': if (m) seekAll(offset(st.i) + m.currentTime - (e.shiftKey ? 1 : 5)); return true;
          case 'ArrowRight': if (m) seekAll(offset(st.i) + m.currentTime + (e.shiftKey ? 1 : 5)); return true;
          case 'n': $('#vw-next').click(); return true;
          case 'p': $('#vw-prev').click(); return true;
          case '0': setGrid(!st.grid); return true;
          case 'h': setHud(!st.hud); return true;
          case 'u': setUnits(st.units === 'mph' ? 'kmh' : 'mph'); return true;
          case 'f': $('#vw-full').click(); return true;
          case '-': case '_': setSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(st.speed) - 1)] ?? 1); toast(`Speed ${st.speed}×`); return true;
          case '+': case '=': setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(st.speed) + 1)] ?? 1); toast(`Speed ${st.speed}×`); return true;
          case 'Escape': if (box.classList.contains('theater')) { box.classList.remove('theater'); document.body.classList.remove('theater-on'); return true; } return false;
          default:
            if (/^[1-6]$/.test(e.key)) { setMain(CAMS[Number(e.key) - 1]); return true; }
            return false;
        }
      }
    };
  }
};
